import React from 'react';
import { render, waitFor, act } from '@testing-library/react';

// Same mocking rationale as the other hook tests — the real contexts
// drag PBKDF2 through jsdom which is slow and irrelevant. useOwnedMasternodes
// is a separate unit we've already test-covered; here we just need to
// observe the composed hook surface.
jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('./useOwnedMasternodes', () => ({
  useOwnedMasternodes: jest.fn(),
}));

// eslint-disable-next-line import/first
import { useGovernanceReceipts, SUMMARY_POLL_MS } from './useGovernanceReceipts';
// eslint-disable-next-line import/first
import { useAuth } from '../context/AuthContext';
// eslint-disable-next-line import/first
import { useOwnedMasternodes } from './useOwnedMasternodes';

function Probe({ service, capture, enabled = true }) {
  capture(useGovernanceReceipts({ governanceService: service, enabled }));
  return null;
}

function makeService({
  summary = [],
  reject = null,
  reconcile = null,
} = {}) {
  return {
    fetchReceiptsSummary: jest.fn(
      reject ? () => Promise.reject(reject) : () => Promise.resolve({ summary })
    ),
    // Always provide a reconcileReceipts stub: the hook calls it on
    // every background tick when any row reports relayed > 0. Tests
    // that don't care about reconcile behaviour just get the default
    // no-op; tests that do care pass `reconcile` explicitly.
    reconcileReceipts: jest.fn(
      reconcile ||
        (() =>
          Promise.resolve({
            receipts: [],
            reconciled: false,
            reconcileError: null,
            updated: 0,
          }))
    ),
  };
}

function row(partial) {
  return {
    proposalHash: 'a'.repeat(64),
    total: 1,
    relayed: 0,
    confirmed: 1,
    stale: 0,
    failed: 0,
    confirmedYes: 1,
    confirmedNo: 0,
    confirmedAbstain: 0,
    latestSubmittedAt: 1700000000,
    latestVerifiedAt: 1700000001,
    ...partial,
  };
}

function makeOwnedHook({
  isReady = true,
  isLoading = false,
  isVaultEmpty = false,
  isVaultLocked = false,
  owned = [],
  error = null,
  refresh = jest.fn(),
} = {}) {
  return {
    isReady,
    isLoading,
    isVaultEmpty,
    isVaultLocked,
    owned,
    error,
    refresh,
  };
}

describe('useGovernanceReceipts', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('does nothing while unauthenticated', async () => {
    useAuth.mockReturnValue({ isAuthenticated: false });
    useOwnedMasternodes.mockReturnValue(makeOwnedHook({ isReady: false }));

    const service = makeService({ summary: [row({})] });
    let snapshot;
    render(<Probe service={service} capture={(s) => (snapshot = s)} />);

    // Let the effect run and any microtasks flush.
    await waitFor(() => expect(snapshot).toBeDefined());
    expect(service.fetchReceiptsSummary).not.toHaveBeenCalled();
    expect(snapshot.summary).toEqual([]);
    expect(snapshot.summaryMap.size).toBe(0);
    expect(snapshot.ownedCount).toBeNull();
    expect(snapshot.summaryLoading).toBe(false);
  });

  test('fetches the summary when authenticated and exposes an O(1) map', async () => {
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(
      makeOwnedHook({ owned: [{ keyId: 'k1' }, { keyId: 'k2' }] })
    );
    const first = row({ proposalHash: 'a'.repeat(64), confirmed: 1 });
    const second = row({ proposalHash: 'b'.repeat(64), failed: 1, confirmed: 0, confirmedYes: 0 });
    const service = makeService({ summary: [first, second] });

    let snapshot;
    render(<Probe service={service} capture={(s) => (snapshot = s)} />);
    await waitFor(() => expect(service.fetchReceiptsSummary).toHaveBeenCalled());
    await waitFor(() => expect(snapshot.summary.length).toBe(2));

    expect(snapshot.summaryMap.get('a'.repeat(64))).toBe(first);
    expect(snapshot.summaryMap.get('b'.repeat(64))).toBe(second);
    // ownedCount reflects the READY state of the composed hook.
    expect(snapshot.ownedCount).toBe(2);
    expect(snapshot.summaryError).toBeNull();
  });

  test('map key is case-insensitive on the proposal hash', async () => {
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(makeOwnedHook({ owned: [] }));
    const upper = 'A'.repeat(64);
    const service = makeService({ summary: [row({ proposalHash: upper })] });

    let snapshot;
    render(<Probe service={service} capture={(s) => (snapshot = s)} />);
    await waitFor(() => expect(snapshot.summary.length).toBe(1));
    expect(snapshot.summaryMap.get(upper.toLowerCase())).toBeDefined();
  });

  test('soft-fails a summary error so the page can still render', async () => {
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(makeOwnedHook({ owned: [] }));
    const err = Object.assign(new Error('boom'), { code: 'network_error' });
    const service = makeService({ reject: err });

    let snapshot;
    render(<Probe service={service} capture={(s) => (snapshot = s)} />);
    await waitFor(() => expect(snapshot.summaryError).toBe('network_error'));
    expect(snapshot.summary).toEqual([]);
    expect(snapshot.summaryMap.size).toBe(0);
  });

  test('preserves the last successful summary snapshot when a background refresh fails — a transient blip must not wipe cohort chips back to "Not voted"', async () => {
    // Regression guard: before this behaviour the catch branch in
    // load() unconditionally set `summary` to []. Once background
    // polling landed (useBackgroundPoll in this hook + the activity
    // card), every transient /gov/receipts/summary failure flashed
    // the hero's "Voted N of M" counter to zero and flipped every
    // cohort chip on the table from "Voted" back to "Not voted"
    // until the next successful tick. For a user who just voted,
    // that reads as "my vote disappeared" — the opposite of the
    // auto-refresh UX goal. We now keep the last-good snapshot on
    // error and only surface the error code; the gated-off auth
    // path still clears on sign-out (covered by the first test).
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(makeOwnedHook({ owned: [] }));
    const good = row({ proposalHash: 'a'.repeat(64), confirmed: 1 });
    const err = Object.assign(new Error('blip'), { code: 'network_error' });
    const service = {
      fetchReceiptsSummary: jest
        .fn()
        .mockResolvedValueOnce({ summary: [good] })
        .mockRejectedValueOnce(err),
    };

    let snapshot;
    render(<Probe service={service} capture={(s) => (snapshot = s)} />);

    // First load succeeds.
    await waitFor(() => expect(snapshot.summary.length).toBe(1));
    expect(snapshot.summaryError).toBeNull();

    // Trigger a manual refresh — the second call rejects.
    await act(async () => {
      await snapshot.refresh();
    });
    expect(service.fetchReceiptsSummary).toHaveBeenCalledTimes(2);
    // Error surfaced, but the good snapshot is preserved.
    expect(snapshot.summaryError).toBe('network_error');
    expect(snapshot.summary).toEqual([good]);
    expect(snapshot.summaryMap.get('a'.repeat(64))).toBe(good);
  });

  test('ownedCount is null until useOwnedMasternodes reaches READY', async () => {
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(
      makeOwnedHook({ isReady: false, isLoading: true })
    );
    const service = makeService({ summary: [] });
    let snapshot;
    render(<Probe service={service} capture={(s) => (snapshot = s)} />);
    await waitFor(() => expect(snapshot).toBeDefined());
    expect(snapshot.ownedCount).toBeNull();
    expect(snapshot.isLoading).toBe(true);
  });

  test('ownedCount is 0 (not null) when the vault is empty — lets the ops-hero render its empty-state CTA instead of a perpetual skeleton', async () => {
    // Regression: useOwnedMasternodes transitions to EMPTY_VAULT for
    // signed-in users who have NOT imported voting keys yet. Because
    // that is a terminal non-error state (the hook does not progress
    // to `isReady`), leaving `ownedCount` at null pins
    // GovernanceOpsHero on its loading skeleton forever. Map empty-
    // vault to count=0 so the hero's dedicated `isVaultEmpty` branch
    // (ownedCount === 0) lights up instead, nudging the user to
    // Import your masternode voting keys.
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(
      makeOwnedHook({
        isReady: false,
        isLoading: false,
        isVaultEmpty: true,
        owned: [],
      })
    );
    const service = makeService({ summary: [] });
    let snapshot;
    render(<Probe service={service} capture={(s) => (snapshot = s)} />);
    await waitFor(() => expect(snapshot).toBeDefined());
    expect(snapshot.ownedCount).toBe(0);
  });

  test('surfaces isVaultLocked=true when the vault is locked so the ops-hero can render an unlock CTA instead of a perpetual skeleton', async () => {
    // Regression: useOwnedMasternodes transitions to VAULT_LOCKED
    // after every page refresh (the vault master key lives only in
    // memory, so a reload always lands the user on LOCKED). Without
    // a dedicated signal, ownedCount stayed null and
    // GovernanceOpsHero sat on "Loading your personalised summary…"
    // forever with no prompt to unlock. Expose the locked state so
    // the hero can swap the skeleton for an inline unlock form.
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(
      makeOwnedHook({
        isReady: false,
        isLoading: false,
        isVaultLocked: true,
        owned: [],
      })
    );
    const service = makeService({ summary: [] });
    let snapshot;
    render(<Probe service={service} capture={(s) => (snapshot = s)} />);
    await waitFor(() => expect(snapshot).toBeDefined());
    expect(snapshot.isVaultLocked).toBe(true);
    // ownedCount semantics are preserved — null so cohort chips and
    // ops stats still treat the denominator as unknown.
    expect(snapshot.ownedCount).toBeNull();
  });

  test('isVaultLocked is false in the ordinary ready path', async () => {
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(
      makeOwnedHook({ owned: [{ keyId: 'k1' }] })
    );
    const service = makeService({ summary: [] });
    let snapshot;
    render(<Probe service={service} capture={(s) => (snapshot = s)} />);
    await waitFor(() => expect(snapshot).toBeDefined());
    expect(snapshot.isVaultLocked).toBe(false);
  });

  test('enabled=false keeps the hook dormant even when authenticated', async () => {
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(makeOwnedHook({ owned: [] }));
    const service = makeService({ summary: [row({})] });

    let snapshot;
    render(
      <Probe service={service} capture={(s) => (snapshot = s)} enabled={false} />
    );
    await waitFor(() => expect(snapshot).toBeDefined());
    // Intentionally flush microtasks once more to catch a latent fire.
    await act(async () => {
      await Promise.resolve();
    });
    expect(service.fetchReceiptsSummary).not.toHaveBeenCalled();
    expect(snapshot.summary).toEqual([]);
  });

  test('refresh({ refreshOwned: true }) re-fires both sources', async () => {
    const ownedRefresh = jest.fn().mockResolvedValue();
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(
      makeOwnedHook({ owned: [], refresh: ownedRefresh })
    );
    const service = makeService({ summary: [] });

    let snapshot;
    render(<Probe service={service} capture={(s) => (snapshot = s)} />);
    await waitFor(() =>
      expect(service.fetchReceiptsSummary).toHaveBeenCalledTimes(1)
    );

    await act(async () => {
      await snapshot.refresh({ refreshOwned: true });
    });
    expect(service.fetchReceiptsSummary).toHaveBeenCalledTimes(2);
    expect(ownedRefresh).toHaveBeenCalledTimes(1);
  });

  test('manual refresh() does NOT fire reconcile — reconciliation belongs only to the background cadence so modal-close does not double up on the RPC the vote modal already issued', async () => {
    // Contract guard: useOwnedMasternodes already POSTs /receipts/reconcile
    // for the proposal whose vote modal is open. Governance.closeVoteModal
    // then calls refreshReceipts() to pick up the resulting summary
    // change. If refresh() also ran reconcile across every pending
    // proposal, every modal close would fan out extra per-proposal
    // reconciles for work the chain has not yet had time to confirm —
    // inflating RPC traffic without any UX win because the reconcile
    // would short-circuit against currentVotesCache or return unchanged
    // rows. Keep refresh() pure: only the background poll reconciles.
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(makeOwnedHook({ owned: [] }));
    const pending = row({
      proposalHash: 'c'.repeat(64),
      total: 1,
      relayed: 1,
      confirmed: 0,
      confirmedYes: 0,
    });
    const service = makeService({ summary: [pending] });

    let snapshot;
    render(<Probe service={service} capture={(s) => (snapshot = s)} />);
    await waitFor(() =>
      expect(service.fetchReceiptsSummary).toHaveBeenCalledTimes(1)
    );

    await act(async () => {
      await snapshot.refresh();
    });
    expect(service.fetchReceiptsSummary).toHaveBeenCalledTimes(2);
    expect(service.reconcileReceipts).not.toHaveBeenCalled();
  });
});

describe('useGovernanceReceipts — background reconcile sweep', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // Helper to flush the pending-promise microtask queue after advancing
  // timers. A single `await Promise.resolve()` is not enough because
  // the tick handler awaits both the reconcile fan-out and the
  // follow-up summary load — distinct microtask hops per promise.
  async function flushMicrotasks() {
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  }

  test('a background tick fires reconcile for every proposal with relayed > 0 and then re-loads /summary so relayed→confirmed transitions surface without user action', async () => {
    // Regression guard for the UX gap operators hit after voting:
    // `/gov/receipts/summary` is a pure SELECT so a freshly relayed
    // receipt stayed at status=relayed indefinitely until some other
    // path (the vote modal reopening, typically) triggered
    // /receipts/reconcile. The hook now drives that reconcile itself
    // on every poll tick for any proposal with at least one relayed
    // receipt, then re-fetches /summary to pick up whatever flipped.
    jest.useFakeTimers();
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(makeOwnedHook({ owned: [] }));

    const pendingHashA = 'a'.repeat(64);
    const pendingHashB = 'b'.repeat(64);
    // Before reconcile: both proposals have relayed > 0.
    const preA = row({
      proposalHash: pendingHashA,
      total: 1,
      relayed: 1,
      confirmed: 0,
      confirmedYes: 0,
    });
    const preB = row({
      proposalHash: pendingHashB,
      total: 1,
      relayed: 1,
      confirmed: 0,
      confirmedYes: 0,
    });
    // After reconcile: chain confirmed both, flipping relayed→confirmed.
    const postA = row({ proposalHash: pendingHashA, confirmed: 1 });
    const postB = row({ proposalHash: pendingHashB, confirmed: 1 });

    const service = {
      fetchReceiptsSummary: jest
        .fn()
        .mockResolvedValueOnce({ summary: [preA, preB] })
        .mockResolvedValue({ summary: [postA, postB] }),
      reconcileReceipts: jest.fn().mockResolvedValue({
        receipts: [],
        reconciled: true,
        reconcileError: null,
        updated: 1,
      }),
    };

    let snapshot;
    render(<Probe service={service} capture={(s) => (snapshot = s)} />);
    // Flush the initial load so summaryRef lands the pre-reconcile
    // snapshot before we advance timers. A bare waitFor on the call
    // count would race the state commit under fake timers — the
    // fetch promise resolves asynchronously even though the mock
    // is synchronous, so the tick can fire with summaryRef still
    // pointing at the initial [] and skip the reconcile fan-out.
    await act(async () => {
      await flushMicrotasks();
    });
    expect(service.fetchReceiptsSummary).toHaveBeenCalledTimes(1);
    expect(snapshot.summary).toEqual([preA, preB]);
    expect(service.reconcileReceipts).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(SUMMARY_POLL_MS);
      await flushMicrotasks();
    });

    // Both relayed proposals got reconciled, in any order.
    expect(service.reconcileReceipts).toHaveBeenCalledTimes(2);
    const hashesReconciled = service.reconcileReceipts.mock.calls.map((c) => c[0]);
    expect(hashesReconciled).toEqual(
      expect.arrayContaining([pendingHashA, pendingHashB])
    );
    // And the follow-up summary fetch picked up the confirmed rows.
    expect(service.fetchReceiptsSummary).toHaveBeenCalledTimes(2);
    expect(snapshot.summary).toEqual([postA, postB]);
  });

  test('a background tick with no relayed rows only re-loads /summary and skips reconcile entirely — prevents fan-out RPC traffic for users whose receipts are already settled', async () => {
    jest.useFakeTimers();
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(makeOwnedHook({ owned: [] }));

    const settled = row({
      proposalHash: 'd'.repeat(64),
      total: 1,
      relayed: 0,
      confirmed: 1,
    });
    const service = makeService({ summary: [settled] });

    render(<Probe service={service} capture={() => {}} />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(service.fetchReceiptsSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(SUMMARY_POLL_MS);
      await flushMicrotasks();
    });

    expect(service.reconcileReceipts).not.toHaveBeenCalled();
    // The load still ran — reconcile being a no-op must not block
    // the poll's freshness contract.
    expect(service.fetchReceiptsSummary).toHaveBeenCalledTimes(2);
  });

  test('a reconcile failure on one proposal does not stop the remaining reconciles OR the follow-up load — one flaky proposal cannot freeze the rest of the sweep', async () => {
    jest.useFakeTimers();
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(makeOwnedHook({ owned: [] }));

    const hashA = 'e'.repeat(64);
    const hashB = 'f'.repeat(64);
    const preA = row({
      proposalHash: hashA,
      total: 1,
      relayed: 1,
      confirmed: 0,
      confirmedYes: 0,
    });
    const preB = row({
      proposalHash: hashB,
      total: 1,
      relayed: 1,
      confirmed: 0,
      confirmedYes: 0,
    });

    const rpcErr = Object.assign(new Error('boom'), { code: 'rpc_failed' });
    const service = {
      fetchReceiptsSummary: jest.fn().mockResolvedValue({ summary: [preA, preB] }),
      reconcileReceipts: jest.fn((hash) => {
        if (hash === hashA) return Promise.reject(rpcErr);
        return Promise.resolve({
          receipts: [],
          reconciled: true,
          reconcileError: null,
          updated: 0,
        });
      }),
    };

    render(<Probe service={service} capture={() => {}} />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(service.fetchReceiptsSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(SUMMARY_POLL_MS);
      await flushMicrotasks();
    });

    // Both reconciles were attempted despite hashA's rejection.
    expect(service.reconcileReceipts).toHaveBeenCalledTimes(2);
    // And the follow-up load still ran — the sweep's failure mode is
    // "skip the write, keep the read" so cohort chips stay fresh.
    expect(service.fetchReceiptsSummary).toHaveBeenCalledTimes(2);
  });

  test('enabled=false suppresses the background reconcile sweep so anonymous / gated-off sessions never issue reconcile RPC', async () => {
    jest.useFakeTimers();
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(makeOwnedHook({ owned: [] }));
    const service = makeService({
      summary: [
        row({
          proposalHash: 'a'.repeat(64),
          total: 1,
          relayed: 1,
          confirmed: 0,
          confirmedYes: 0,
        }),
      ],
    });

    render(
      <Probe service={service} capture={() => {}} enabled={false} />
    );

    await act(async () => {
      jest.advanceTimersByTime(SUMMARY_POLL_MS * 3);
      await flushMicrotasks();
    });

    expect(service.fetchReceiptsSummary).not.toHaveBeenCalled();
    expect(service.reconcileReceipts).not.toHaveBeenCalled();
  });

  test('a service stub without reconcileReceipts (older mocks) still polls /summary cleanly — the sweep must degrade gracefully', async () => {
    // Back-compat guard: third-party test suites and historical fixtures
    // may pass a governanceService shaped around just the read endpoints.
    // Requiring reconcileReceipts would break those suites even when
    // they never exercise the vote path. The hook instead feature-detects
    // the method before fanning out.
    jest.useFakeTimers();
    useAuth.mockReturnValue({ isAuthenticated: true });
    useOwnedMasternodes.mockReturnValue(makeOwnedHook({ owned: [] }));

    const pending = row({
      proposalHash: 'a'.repeat(64),
      total: 1,
      relayed: 1,
      confirmed: 0,
      confirmedYes: 0,
    });
    const legacyService = {
      fetchReceiptsSummary: jest
        .fn()
        .mockResolvedValue({ summary: [pending] }),
      // No reconcileReceipts on purpose.
    };

    render(<Probe service={legacyService} capture={() => {}} />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(legacyService.fetchReceiptsSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(SUMMARY_POLL_MS);
      await flushMicrotasks();
    });

    // Poll still ticks /summary even though reconcile is unavailable.
    expect(legacyService.fetchReceiptsSummary).toHaveBeenCalledTimes(2);
  });
});
