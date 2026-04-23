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
import { useGovernanceReceipts } from './useGovernanceReceipts';
// eslint-disable-next-line import/first
import { useAuth } from '../context/AuthContext';
// eslint-disable-next-line import/first
import { useOwnedMasternodes } from './useOwnedMasternodes';

function Probe({ service, capture, enabled = true }) {
  capture(useGovernanceReceipts({ governanceService: service, enabled }));
  return null;
}

function makeService({ summary = [], reject = null } = {}) {
  return {
    fetchReceiptsSummary: jest.fn(
      reject ? () => Promise.reject(reject) : () => Promise.resolve({ summary })
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
});
