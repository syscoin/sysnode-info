import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../context/AuthContext';
import { governanceService as defaultService } from '../lib/governanceService';
import { useOwnedMasternodes } from './useOwnedMasternodes';

// Data source for the authenticated Governance page: the user's
// per-proposal vote-status summary joined with their owned-MN count
// so per-row cohort chips and (in PR 6c) an ops hero can render
// accurate denominators.
//
// What this hook handles that raw service calls don't:
//
//   * Auth/vault gating: summary is fetched as soon as the user is
//     authenticated (it's just a user_id scoped query). Owned MN
//     count additionally requires the vault to be unlocked because
//     /gov/mns/lookup needs vault addresses.
//   * Generation guards + mount tracking so late-landing responses
//     from a previous auth/vault state can't clobber newer state.
//     Same pattern AuthContext and useOwnedMasternodes use.
//   * Map shape for O(1) lookup from a proposalHash to its summary
//     row. Lower-casing the key mirrors the backend's hex
//     normalisation; governance hashes are hex-insensitive.
//   * Soft-fails: a summary fetch that 5xx's doesn't prevent the
//     page from rendering. We expose the code so the page can show
//     a non-blocking note.
//
// `enabled` exists for parity with useOwnedMasternodes: callers that
// want to mount the hook without kicking off the fetches (e.g. route
// transitions that render children early) can gate it off.
//
// `ownedCount` is intentionally `null` until the owned-masternodes
// fetch reaches READY. Cohort-chip logic treats null as "unknown"
// and falls back to chips that don't depend on a denominator — this
// is important during the short gap between "vault just unlocked"
// and "lookup returned", so we don't flash partial/"Not voted"
// chips that would then immediately change.
export function useGovernanceReceipts({
  governanceService = defaultService,
  enabled = true,
} = {}) {
  const { isAuthenticated } = useAuth();

  const ownedHook = useOwnedMasternodes({
    governanceService,
    enabled: enabled && isAuthenticated,
  });

  const [summary, setSummary] = useState([]);
  const [summaryError, setSummaryError] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const genRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!enabled || !isAuthenticated) {
      // Gated off or user signed out — bump the generation counter
      // so an in-flight response from the previous auth state can't
      // land, and reset the visible state.
      genRef.current += 1;
      setSummary([]);
      setSummaryError(null);
      setSummaryLoading(false);
      return;
    }
    const myGen = ++genRef.current;
    setSummaryLoading(true);
    try {
      const r = await governanceService.fetchReceiptsSummary();
      if (!mountedRef.current || genRef.current !== myGen) return;
      const rows = Array.isArray(r.summary) ? r.summary : [];
      setSummary(rows);
      setSummaryError(null);
    } catch (err) {
      if (!mountedRef.current || genRef.current !== myGen) return;
      setSummaryError((err && err.code) || 'summary_failed');
      setSummary([]);
    } finally {
      if (mountedRef.current && genRef.current === myGen) {
        setSummaryLoading(false);
      }
    }
  }, [enabled, isAuthenticated, governanceService]);

  useEffect(() => {
    load();
  }, [load]);

  const summaryMap = useMemo(() => {
    const m = new Map();
    for (const row of summary) {
      if (row && typeof row.proposalHash === 'string') {
        m.set(row.proposalHash.toLowerCase(), row);
      }
    }
    return m;
  }, [summary]);

  // `ownedCount` drives the Governance ops-hero branching:
  //
  //   * number (incl. 0) -> hero renders a concrete personalized
  //                         summary (or the "import your keys" empty
  //                         CTA when count is exactly 0).
  //   * null             -> hero renders the loading skeleton.
  //
  // We must treat `empty_vault` as a terminal resolved state (count
  // = 0), not as "still loading". Otherwise an authenticated user
  // with no imported voting keys sits on "Loading your personalised
  // summary…" forever, because useOwnedMasternodes shortcut to
  // EMPTY_VAULT without ever becoming `isReady`. The hero already
  // has a dedicated empty-vault branch — this mapping lets it
  // trigger as intended.
  //
  // `vault_locked` and error states deliberately stay as `null` so
  // the hero's loading skeleton continues to cover them; surfacing
  // "Import your keys" copy to a user whose vault exists but is
  // locked would be misleading.
  const ownedCount = ownedHook.isReady
    ? ownedHook.owned.length
    : ownedHook.isVaultEmpty
      ? 0
      : null;

  const refresh = useCallback(
    async ({ refreshOwned = false } = {}) => {
      const tasks = [load()];
      if (refreshOwned && typeof ownedHook.refresh === 'function') {
        tasks.push(ownedHook.refresh());
      }
      await Promise.all(tasks);
    },
    [load, ownedHook]
  );

  return {
    summary,
    summaryMap,
    summaryError,
    summaryLoading,
    owned: ownedHook.owned,
    ownedCount,
    ownedError: ownedHook.error,
    isLoading: summaryLoading || ownedHook.isLoading,
    refresh,
  };
}
