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
  owned = [],
  error = null,
  refresh = jest.fn(),
} = {}) {
  return { isReady, isLoading, isVaultEmpty, owned, error, refresh };
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
