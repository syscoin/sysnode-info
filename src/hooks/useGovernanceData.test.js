import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

import { fetchGovernanceFeed, fetchNetworkStats } from '../lib/api';
import useGovernanceData from './useGovernanceData';

jest.mock('../lib/api', () => ({
  fetchGovernanceFeed: jest.fn(),
  fetchNetworkStats: jest.fn(),
}));

const NOW = Date.UTC(2026, 9, 17);
const EXCLUDED_BEFORE = '1b9039bd9f7b36dc43a2d8e4dea944550897414fabd981404b3d3d51741175d6';
function proposal(overrides = {}) {
  return {
    Key: 'a'.repeat(64),
    Hash: 'b'.repeat(64),
    ObectType: 1,
    fBlockchainValidity: true,
    fCachedValid: true,
    fCachedDelete: false,
    start_epoch: NOW / 1000 - 86400,
    end_epoch: NOW / 1000 + 86400 * 365 * 5,
    AbsoluteYesCount: 2,
    ...overrides,
  };
}

function Probe() {
  const state = useGovernanceData();
  return <output data-testid="proposals">{state.loading ? 'loading' : JSON.stringify(state.proposals.map((p) => p.Key))}</output>;
}

describe('governance feed eligibility', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    fetchNetworkStats.mockResolvedValue({});
  });

  afterEach(() => jest.restoreAllMocks());

  test('does not blacklist a data hash when its dates and validity are supported', async () => {
    fetchGovernanceFeed.mockResolvedValue([proposal({ Hash: EXCLUDED_BEFORE })]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('proposals').textContent).toBe(JSON.stringify(['a'.repeat(64)])));
  });

  test.each([
    ['millisecond-looking end epoch', { end_epoch: 1743371426000 }],
    ['out-of-range start epoch', { start_epoch: 253402300800, end_epoch: 253402300801 }],
    ['expired proposal', { end_epoch: NOW / 1000 }],
    ['reversed dates', { start_epoch: NOW / 1000 + 20, end_epoch: NOW / 1000 + 10 }],
    ['missing start epoch', { start_epoch: undefined }],
    ['string epoch', { end_epoch: String(NOW / 1000 + 100) }],
    ['locally invalid proposal', { fBlockchainValidity: false }],
    ['uncertain validity', { fBlockchainValidity: undefined }],
    ['cached invalid proposal', { fCachedValid: false }],
    ['deleted proposal', { fCachedDelete: true }],
    ['non-proposal object', { ObectType: 2 }],
  ])('omits %s without modifying its original on-chain fields', async (_name, changes) => {
    const invalid = proposal(changes);
    const original = { ...invalid };
    fetchGovernanceFeed.mockResolvedValue([invalid]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('proposals').textContent).toBe('[]'));
    expect(invalid).toEqual(original);
  });

  test('preserves a legitimate long current window and the maximum supported UTC year', async () => {
    fetchGovernanceFeed.mockResolvedValue([
      proposal(),
      proposal({ Key: 'c'.repeat(64), start_epoch: 0, end_epoch: 253402300799, AbsoluteYesCount: 1 }),
    ]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('proposals').textContent).toBe(JSON.stringify(['a'.repeat(64), 'c'.repeat(64)])));
  });
});
