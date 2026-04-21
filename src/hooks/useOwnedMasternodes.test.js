import React from 'react';
import { act, render, waitFor } from '@testing-library/react';

import { useOwnedMasternodes } from './useOwnedMasternodes';

// We mock useVault directly — reconstructing the full VaultProvider here
// would drag in PBKDF2 @ 600k iterations and make these hook tests slow
// for no reason. The hook's contract against VaultContext is narrow:
// isUnlocked / isIdle / isLoading / data.keys. We cover those inputs
// exhaustively below.
jest.mock('../context/VaultContext', () => ({
  useVault: jest.fn(),
}));

// eslint-disable-next-line import/first
const { useVault } = require('../context/VaultContext');

function Probe({ service, onValue, enabled }) {
  const v = useOwnedMasternodes({
    governanceService: service,
    ...(enabled === undefined ? {} : { enabled }),
  });
  React.useEffect(() => {
    onValue(v);
  });
  return null;
}

function makeVault(partial) {
  return {
    isIdle: false,
    isLoading: false,
    isLocked: false,
    isUnlocked: false,
    isEmpty: false,
    data: null,
    ...partial,
  };
}

describe('useOwnedMasternodes', () => {
  beforeEach(() => {
    useVault.mockReset();
  });

  test('renders as vault_locked when the vault is locked', () => {
    useVault.mockReturnValue(makeVault({ isLocked: true }));
    const service = { lookupOwnedMasternodes: jest.fn() };
    const values = [];

    render(<Probe service={service} onValue={(v) => values.push(v)} />);

    const last = values.at(-1);
    expect(last.status).toBe('vault_locked');
    expect(last.isVaultLocked).toBe(true);
    expect(last.owned).toEqual([]);
    expect(service.lookupOwnedMasternodes).not.toHaveBeenCalled();
  });

  test('renders as idle while vault is still booting', () => {
    useVault.mockReturnValue(makeVault({ isIdle: true }));
    const service = { lookupOwnedMasternodes: jest.fn() };
    const values = [];

    render(<Probe service={service} onValue={(v) => values.push(v)} />);

    expect(values.at(-1).status).toBe('idle');
    expect(service.lookupOwnedMasternodes).not.toHaveBeenCalled();
  });

  test('empty vault (unlocked, no keys) resolves to empty_vault without hitting backend', async () => {
    useVault.mockReturnValue(
      makeVault({ isUnlocked: true, data: { keys: [] } })
    );
    const service = { lookupOwnedMasternodes: jest.fn() };
    const values = [];

    render(<Probe service={service} onValue={(v) => values.push(v)} />);

    await waitFor(() => {
      expect(values.at(-1).status).toBe('empty_vault');
    });
    const last = values.at(-1);
    expect(last.isVaultEmpty).toBe(true);
    expect(last.isReady).toBe(false);
    expect(last.owned).toEqual([]);
    expect(service.lookupOwnedMasternodes).not.toHaveBeenCalled();
  });

  test('unlocked vault with keys calls the backend and joins results', async () => {
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [
            { id: 'k1', label: 'alpha', wif: 'Lwif1', address: 'sys1qa' },
            { id: 'k2', label: 'beta', wif: 'Lwif2', address: 'sys1qb' },
          ],
        },
      })
    );
    const service = {
      lookupOwnedMasternodes: jest.fn().mockResolvedValue([
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: 'col1',
          collateralIndex: 0,
          status: 'ENABLED',
          payee: 'payee1',
          address: '1.2.3.4:18369',
        },
      ]),
    };
    const values = [];

    render(<Probe service={service} onValue={(v) => values.push(v)} />);

    await waitFor(() => {
      expect(values.at(-1).status).toBe('ready');
    });

    expect(service.lookupOwnedMasternodes).toHaveBeenCalledTimes(1);
    expect(service.lookupOwnedMasternodes).toHaveBeenCalledWith([
      'sys1qa',
      'sys1qb',
    ]);

    const last = values.at(-1);
    expect(last.owned).toHaveLength(1);
    expect(last.owned[0]).toEqual({
      keyId: 'k1',
      label: 'alpha',
      wif: 'Lwif1',
      address: 'sys1qa',
      proTxHash: 'pro1',
      collateralHash: 'col1',
      collateralIndex: 0,
      masternodeStatus: 'ENABLED',
      payee: 'payee1',
      networkAddress: '1.2.3.4:18369',
    });
  });

  test('backend rows for addresses NOT in the vault are dropped', async () => {
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    const service = {
      lookupOwnedMasternodes: jest.fn().mockResolvedValue([
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: 'col1',
          collateralIndex: 0,
          status: 'ENABLED',
        },
        {
          votingaddress: 'sys1qZ',
          proTxHash: 'proZ',
          collateralHash: 'colZ',
          collateralIndex: 3,
          status: 'ENABLED',
        },
      ]),
    };
    const values = [];

    render(<Probe service={service} onValue={(v) => values.push(v)} />);

    await waitFor(() => {
      expect(values.at(-1).status).toBe('ready');
    });
    expect(values.at(-1).owned).toHaveLength(1);
    expect(values.at(-1).owned[0].keyId).toBe('k1');
  });

  test('lookup error transitions to error with code', async () => {
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    const err = new Error('rate_limited');
    err.code = 'rate_limited';
    const service = {
      lookupOwnedMasternodes: jest.fn().mockRejectedValue(err),
    };
    const values = [];

    render(<Probe service={service} onValue={(v) => values.push(v)} />);

    await waitFor(() => {
      expect(values.at(-1).status).toBe('error');
    });
    expect(values.at(-1).error).toBe('rate_limited');
    expect(values.at(-1).owned).toEqual([]);
  });

  test('lookup error without code falls back to lookup_failed', async () => {
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    const service = {
      lookupOwnedMasternodes: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const values = [];

    render(<Probe service={service} onValue={(v) => values.push(v)} />);

    await waitFor(() => {
      expect(values.at(-1).status).toBe('error');
    });
    expect(values.at(-1).error).toBe('lookup_failed');
  });

  test('enabled=false keeps hook idle and does not POST even with unlocked vault + keys', async () => {
    // Scenario: modal is mounted but not yet opened. Governance.js
    // keeps <ProposalVoteModal open={voteProposal !== null} /> in
    // the tree at all times, so a hook that fetches unconditionally
    // would leak vault addresses to /gov/mns/lookup on every page
    // view. With enabled=false the hook must stay IDLE and not
    // call the service.
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    const service = { lookupOwnedMasternodes: jest.fn() };
    const values = [];

    render(
      <Probe service={service} enabled={false} onValue={(v) => values.push(v)} />
    );

    // Give any would-be effect a chance to fire.
    await new Promise((r) => setTimeout(r, 20));

    expect(service.lookupOwnedMasternodes).not.toHaveBeenCalled();
    expect(values.at(-1).status).toBe('idle');
    expect(values.at(-1).owned).toEqual([]);
  });

  test('enabled flipping false → true triggers the lookup', async () => {
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    const service = {
      lookupOwnedMasternodes: jest.fn().mockResolvedValue([
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: 'col1',
          collateralIndex: 0,
          status: 'ENABLED',
        },
      ]),
    };
    const values = [];

    const { rerender } = render(
      <Probe service={service} enabled={false} onValue={(v) => values.push(v)} />
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(service.lookupOwnedMasternodes).not.toHaveBeenCalled();

    rerender(
      <Probe service={service} enabled={true} onValue={(v) => values.push(v)} />
    );
    await waitFor(() => expect(values.at(-1).status).toBe('ready'));
    expect(service.lookupOwnedMasternodes).toHaveBeenCalledTimes(1);
  });

  test('enabled flipping true → false cancels and resets to idle', async () => {
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    const service = {
      lookupOwnedMasternodes: jest.fn().mockResolvedValue([
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: 'col1',
          collateralIndex: 0,
          status: 'ENABLED',
        },
      ]),
    };
    const values = [];

    const { rerender } = render(
      <Probe service={service} enabled={true} onValue={(v) => values.push(v)} />
    );
    await waitFor(() => expect(values.at(-1).status).toBe('ready'));

    rerender(
      <Probe service={service} enabled={false} onValue={(v) => values.push(v)} />
    );
    await waitFor(() => expect(values.at(-1).status).toBe('idle'));
    expect(values.at(-1).owned).toEqual([]);
  });

  test('refresh() re-invokes the backend with current keys', async () => {
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    const service = {
      lookupOwnedMasternodes: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            votingaddress: 'sys1qa',
            proTxHash: 'pro1',
            collateralHash: 'col1',
            collateralIndex: 0,
            status: 'ENABLED',
          },
        ]),
    };
    const values = [];

    render(<Probe service={service} onValue={(v) => values.push(v)} />);

    await waitFor(() => {
      expect(values.at(-1).status).toBe('ready');
    });
    expect(values.at(-1).owned).toEqual([]);

    await act(async () => {
      await values.at(-1).refresh();
    });

    expect(service.lookupOwnedMasternodes).toHaveBeenCalledTimes(2);
    expect(values.at(-1).owned).toHaveLength(1);
  });
});
