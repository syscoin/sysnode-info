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

function Probe({ service, onValue, enabled, proposalHash }) {
  const v = useOwnedMasternodes({
    governanceService: service,
    ...(enabled === undefined ? {} : { enabled }),
    ...(proposalHash === undefined ? {} : { proposalHash }),
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
      // Hook always provides `receipt`; it's null when no
      // proposalHash was passed (this test).
      receipt: null,
    });
    // Receipts state should also reflect the no-proposalHash case.
    expect(last.receipts).toEqual([]);
    expect(last.reconciled).toBe(false);
    expect(last.reconcileError).toBeNull();
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

describe('useOwnedMasternodes — receipts join', () => {
  beforeEach(() => {
    useVault.mockReset();
  });

  const PROPOSAL = 'a'.repeat(64);
  const COL1 = 'c'.repeat(64);
  const COL2 = 'd'.repeat(64);

  function mkService({ lookupRows, receipts }) {
    return {
      lookupOwnedMasternodes: jest.fn().mockResolvedValue(lookupRows),
      reconcileReceipts: jest.fn().mockResolvedValue({
        receipts,
        reconciled: true,
        reconcileError: null,
        updated: 0,
      }),
    };
  }

  test('joins receipts onto owned rows by (collateralHash, collateralIndex)', async () => {
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
    const service = mkService({
      lookupRows: [
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: COL1,
          collateralIndex: 0,
          status: 'ENABLED',
          payee: 'payee1',
          address: '1.2.3.4:18369',
        },
        {
          votingaddress: 'sys1qb',
          proTxHash: 'pro2',
          collateralHash: COL2,
          collateralIndex: 1,
          status: 'ENABLED',
          payee: 'payee2',
          address: '5.6.7.8:18369',
        },
      ],
      receipts: [
        {
          collateralHash: COL1,
          collateralIndex: 0,
          proposalHash: PROPOSAL,
          voteOutcome: 'yes',
          voteSignal: 'funding',
          voteTime: 1_700_000_000,
          status: 'confirmed',
          lastError: null,
          submittedAt: 1_700_000_123_000,
          verifiedAt: 1_700_000_456_000,
        },
      ],
    });
    const values = [];

    render(
      <Probe
        service={service}
        proposalHash={PROPOSAL}
        onValue={(v) => values.push(v)}
      />
    );

    await waitFor(() => expect(values.at(-1).status).toBe('ready'));
    expect(service.reconcileReceipts).toHaveBeenCalledWith(PROPOSAL, {
      refresh: false,
    });
    const last = values.at(-1);
    const byKey = Object.fromEntries(
      last.owned.map((r) => [r.keyId, r])
    );
    expect(byKey.k1.receipt).toMatchObject({ status: 'confirmed' });
    expect(byKey.k2.receipt).toBeNull();
    expect(last.reconciled).toBe(true);
    expect(last.reconcileError).toBeNull();
  });

  test('matches receipts case-insensitively on the collateral hash', async () => {
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    const UPPER = 'C'.repeat(64);
    const service = mkService({
      lookupRows: [
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: UPPER, // upper from /mns/lookup
          collateralIndex: 0,
          status: 'ENABLED',
        },
      ],
      receipts: [
        {
          collateralHash: UPPER.toLowerCase(), // lower from receipts
          collateralIndex: 0,
          proposalHash: PROPOSAL,
          voteOutcome: 'yes',
          voteSignal: 'funding',
          voteTime: 1_700_000_000,
          status: 'failed',
          lastError: 'signature_invalid',
          submittedAt: 1_700_000_123_000,
          verifiedAt: null,
        },
      ],
    });
    const values = [];

    render(
      <Probe
        service={service}
        proposalHash={PROPOSAL}
        onValue={(v) => values.push(v)}
      />
    );

    await waitFor(() => expect(values.at(-1).status).toBe('ready'));
    const last = values.at(-1);
    expect(last.owned[0].receipt).toMatchObject({
      status: 'failed',
      lastError: 'signature_invalid',
    });
  });

  test('surfaces reconcileError from the receipts response without failing', async () => {
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
          collateralHash: COL1,
          collateralIndex: 0,
          status: 'ENABLED',
        },
      ]),
      reconcileReceipts: jest.fn().mockResolvedValue({
        receipts: [
          {
            collateralHash: COL1,
            collateralIndex: 0,
            proposalHash: PROPOSAL,
            voteOutcome: 'yes',
            voteSignal: 'funding',
            voteTime: 1_700_000_000,
            status: 'relayed',
            lastError: null,
            submittedAt: 1_700_000_123_000,
            verifiedAt: null,
          },
        ],
        reconciled: false,
        reconcileError: 'rpc_failed',
      }),
    };
    const values = [];

    render(
      <Probe
        service={service}
        proposalHash={PROPOSAL}
        onValue={(v) => values.push(v)}
      />
    );

    await waitFor(() => expect(values.at(-1).status).toBe('ready'));
    const last = values.at(-1);
    expect(last.reconciled).toBe(false);
    expect(last.reconcileError).toBe('rpc_failed');
    expect(last.owned[0].receipt).toMatchObject({ status: 'relayed' });
  });

  test('reconcileReceipts throwing does not fail the hook — owned rows still delivered', async () => {
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    const err = new Error('network_error');
    err.code = 'network_error';
    const service = {
      lookupOwnedMasternodes: jest.fn().mockResolvedValue([
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: COL1,
          collateralIndex: 0,
          status: 'ENABLED',
        },
      ]),
      reconcileReceipts: jest.fn().mockRejectedValue(err),
    };
    const values = [];

    render(
      <Probe
        service={service}
        proposalHash={PROPOSAL}
        onValue={(v) => values.push(v)}
      />
    );

    await waitFor(() => expect(values.at(-1).status).toBe('ready'));
    const last = values.at(-1);
    expect(last.reconcileError).toBe('network_error');
    expect(last.owned).toHaveLength(1);
    expect(last.owned[0].receipt).toBeNull();
  });

  test('refresh({ refreshReceipts: true }) forwards to reconcileReceipts', async () => {
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    const service = mkService({
      lookupRows: [
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: COL1,
          collateralIndex: 0,
          status: 'ENABLED',
        },
      ],
      receipts: [],
    });
    const values = [];

    render(
      <Probe
        service={service}
        proposalHash={PROPOSAL}
        onValue={(v) => values.push(v)}
      />
    );

    await waitFor(() => expect(values.at(-1).status).toBe('ready'));
    expect(service.reconcileReceipts).toHaveBeenLastCalledWith(PROPOSAL, {
      refresh: false,
    });

    await act(async () => {
      await values.at(-1).refresh({ refreshReceipts: true });
    });
    expect(service.reconcileReceipts).toHaveBeenLastCalledWith(PROPOSAL, {
      refresh: true,
    });
  });

  test('changing proposalHash triggers a fresh lookup + receipts fetch', async () => {
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    const PROP_B = 'b'.repeat(64);
    const service = mkService({
      lookupRows: [
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: COL1,
          collateralIndex: 0,
          status: 'ENABLED',
        },
      ],
      receipts: [],
    });
    const values = [];

    const { rerender } = render(
      <Probe
        service={service}
        proposalHash={PROPOSAL}
        onValue={(v) => values.push(v)}
      />
    );
    await waitFor(() => expect(values.at(-1).status).toBe('ready'));
    expect(service.reconcileReceipts).toHaveBeenCalledWith(PROPOSAL, {
      refresh: false,
    });

    rerender(
      <Probe
        service={service}
        proposalHash={PROP_B}
        onValue={(v) => values.push(v)}
      />
    );
    await waitFor(() =>
      expect(
        service.reconcileReceipts.mock.calls.some((c) => c[0] === PROP_B)
      ).toBe(true)
    );
    expect(service.lookupOwnedMasternodes).toHaveBeenCalledTimes(2);
  });

  test('proposalHash=null means no receipts fetch', async () => {
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    const service = mkService({
      lookupRows: [
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: COL1,
          collateralIndex: 0,
          status: 'ENABLED',
        },
      ],
      receipts: [],
    });
    const values = [];

    render(
      <Probe
        service={service}
        proposalHash={null}
        onValue={(v) => values.push(v)}
      />
    );
    await waitFor(() => expect(values.at(-1).status).toBe('ready'));
    expect(service.reconcileReceipts).not.toHaveBeenCalled();
    expect(values.at(-1).owned[0].receipt).toBeNull();
  });

  test('falls back to fetchReceipts when service only exposes the legacy name', async () => {
    // Back-compat: older code paths / mocks may still expose only
    // `fetchReceipts`. The hook keeps working but the UI consumers
    // get the same shape.
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
          collateralHash: COL1,
          collateralIndex: 0,
          status: 'ENABLED',
        },
      ]),
      // No reconcileReceipts, only fetchReceipts.
      fetchReceipts: jest.fn().mockResolvedValue({
        receipts: [],
        reconciled: false,
        reconcileError: null,
        updated: 0,
      }),
    };
    const values = [];

    render(
      <Probe
        service={service}
        proposalHash={PROPOSAL}
        onValue={(v) => values.push(v)}
      />
    );
    await waitFor(() => expect(values.at(-1).status).toBe('ready'));
    expect(service.fetchReceipts).toHaveBeenCalledWith(PROPOSAL, {
      refresh: false,
    });
  });

  test('preserves the service receiver when reconcileReceipts needs `this`', async () => {
    // Regression: a class-style service whose methods read from
    // `this` (e.g. a private client reference) must see the service
    // as the call receiver. Invoking through a detached function
    // reference under ESM strict mode gives `this === undefined`
    // and blows up on the first property access.
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [{ id: 'k1', label: '', wif: 'Lwif1', address: 'sys1qa' }],
        },
      })
    );
    class ClassyGovService {
      constructor() {
        this.clientTag = 'ok';
        this.reconcileCalls = [];
      }
      lookupOwnedMasternodes() {
        return Promise.resolve([
          {
            votingaddress: 'sys1qa',
            proTxHash: 'pro1',
            collateralHash: COL1,
            collateralIndex: 0,
            status: 'ENABLED',
          },
        ]);
      }
      reconcileReceipts(hash, opts) {
        // Reads from `this` — throws if the receiver is lost.
        if (this === undefined || this.clientTag !== 'ok') {
          throw new Error('lost_receiver');
        }
        this.reconcileCalls.push([hash, opts]);
        return Promise.resolve({
          receipts: [
            {
              collateralHash: COL1,
              collateralIndex: 0,
              proposalHash: hash,
              voteOutcome: 'yes',
              voteSignal: 'funding',
              voteTime: 1_700_000_000,
              status: 'confirmed',
              lastError: null,
              submittedAt: 1_700_000_123_000,
              verifiedAt: 1_700_000_456_000,
            },
          ],
          reconciled: true,
          reconcileError: null,
          updated: 1,
        });
      }
    }
    const service = new ClassyGovService();
    const values = [];

    render(
      <Probe
        service={service}
        proposalHash={PROPOSAL}
        onValue={(v) => values.push(v)}
      />
    );
    await waitFor(() => expect(values.at(-1).status).toBe('ready'));
    const last = values.at(-1);
    expect(last.reconcileError).toBeNull();
    expect(last.reconciled).toBe(true);
    expect(last.owned[0].receipt).toMatchObject({ status: 'confirmed' });
    expect(service.reconcileCalls).toEqual([[PROPOSAL, { refresh: false }]]);
  });
});
