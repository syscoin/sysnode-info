import React from 'react';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';

import GovernanceActivity from './GovernanceActivity';

function makeService(overrides = {}) {
  return {
    fetchRecentReceipts: jest.fn().mockResolvedValue({ receipts: [] }),
    ...overrides,
  };
}

function baseReceipt(o) {
  return {
    id: 1,
    proposalHash: 'a'.repeat(64),
    collateralHash: 'b'.repeat(64),
    collateralIndex: 0,
    voteOutcome: 'yes',
    voteSignal: 'funding',
    voteTime: 1_700_000_000,
    status: 'confirmed',
    lastError: null,
    submittedAt: Date.now() - 60_000,
    verifiedAt: Date.now() - 30_000,
    ...o,
  };
}

describe('GovernanceActivity', () => {
  test('renders loading state initially', () => {
    const svc = makeService({
      fetchRecentReceipts: () => new Promise(() => {}), // never resolves
    });
    render(<GovernanceActivity governanceService={svc} proposalsByHash={{}} />);
    expect(screen.getByTestId('gov-activity-loading')).toBeInTheDocument();
  });

  test('renders empty state when the user has no receipts', async () => {
    const svc = makeService();
    render(<GovernanceActivity governanceService={svc} proposalsByHash={{}} />);
    await waitFor(() => {
      expect(screen.getByTestId('gov-activity-empty')).toBeInTheDocument();
    });
  });

  test('renders receipt list with jump buttons when proposal is in feed', async () => {
    const hash = 'a'.repeat(64);
    const svc = makeService({
      fetchRecentReceipts: jest.fn().mockResolvedValue({
        receipts: [baseReceipt({ proposalHash: hash })],
      }),
    });
    const proposalsByHash = new Map([
      [hash, { Key: hash, title: 'Fund the node infra' }],
    ]);
    const onJumpToProposal = jest.fn();
    render(
      <GovernanceActivity
        governanceService={svc}
        proposalsByHash={proposalsByHash}
        onJumpToProposal={onJumpToProposal}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('gov-activity')).toBeInTheDocument();
    });
    const jump = screen.getByTestId('gov-activity-jump');
    expect(jump).toHaveTextContent('Fund the node infra');
    fireEvent.click(jump);
    expect(onJumpToProposal).toHaveBeenCalledWith(hash);
  });

  test('renders a short-hash and "not in feed" label when proposal is missing', async () => {
    const hash = 'a'.repeat(64);
    const svc = makeService({
      fetchRecentReceipts: jest.fn().mockResolvedValue({
        receipts: [baseReceipt({ proposalHash: hash })],
      }),
    });
    render(
      <GovernanceActivity
        governanceService={svc}
        proposalsByHash={new Map()}
        onJumpToProposal={jest.fn()}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('gov-activity')).toBeInTheDocument();
    });
    // No jump button — nothing to jump to.
    expect(screen.queryByTestId('gov-activity-jump')).not.toBeInTheDocument();
    expect(screen.getByText(/not in current feed/i)).toBeInTheDocument();
  });

  test('passes limit to the service', async () => {
    const svc = makeService();
    render(
      <GovernanceActivity
        governanceService={svc}
        proposalsByHash={{}}
        limit={5}
      />
    );
    await waitFor(() => {
      expect(svc.fetchRecentReceipts).toHaveBeenCalledWith({ limit: 5 });
    });
  });

  test('refreshes when the refreshToken prop changes', async () => {
    const svc = makeService();
    const { rerender } = render(
      <GovernanceActivity
        governanceService={svc}
        proposalsByHash={{}}
        refreshToken={0}
      />
    );
    await waitFor(() => {
      expect(svc.fetchRecentReceipts).toHaveBeenCalledTimes(1);
    });
    rerender(
      <GovernanceActivity
        governanceService={svc}
        proposalsByHash={{}}
        refreshToken={1}
      />
    );
    await waitFor(() => {
      expect(svc.fetchRecentReceipts).toHaveBeenCalledTimes(2);
    });
  });

  test('shows an error state with a retry button on failure', async () => {
    const fail = Object.assign(new Error('network_error'), {
      code: 'network_error',
    });
    const svc = makeService({
      fetchRecentReceipts: jest
        .fn()
        .mockRejectedValueOnce(fail)
        .mockResolvedValueOnce({ receipts: [] }),
    });
    render(<GovernanceActivity governanceService={svc} proposalsByHash={{}} />);
    await waitFor(() => {
      expect(screen.getByTestId('gov-activity-error')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('gov-activity-retry'));
    await waitFor(() => {
      expect(screen.getByTestId('gov-activity-empty')).toBeInTheDocument();
    });
  });

  test('renders outcome + status labels for each receipt status', async () => {
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    const hashC = 'c'.repeat(64);
    const svc = makeService({
      fetchRecentReceipts: jest.fn().mockResolvedValue({
        receipts: [
          baseReceipt({
            id: 1,
            proposalHash: hashA,
            status: 'confirmed',
            voteOutcome: 'yes',
          }),
          baseReceipt({
            id: 2,
            proposalHash: hashB,
            status: 'relayed',
            voteOutcome: 'no',
          }),
          baseReceipt({
            id: 3,
            proposalHash: hashC,
            status: 'failed',
            voteOutcome: 'abstain',
            lastError: 'signature_invalid',
          }),
        ],
      }),
    });
    render(
      <GovernanceActivity
        governanceService={svc}
        proposalsByHash={{
          [hashA]: { Key: hashA, title: 'A' },
          [hashB]: { Key: hashB, title: 'B' },
          [hashC]: { Key: hashC, title: 'C' },
        }}
      />
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('gov-activity-item')).toHaveLength(3);
    });
    expect(screen.getByText('On-chain')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Voted yes')).toBeInTheDocument();
    expect(screen.getByText('Voted no')).toBeInTheDocument();
    expect(screen.getByText('Abstained')).toBeInTheDocument();
  });
});
