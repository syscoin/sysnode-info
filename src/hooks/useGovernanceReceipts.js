import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../context/AuthContext';
import { governanceService as defaultService } from '../lib/governanceService';
import { useBackgroundPoll } from './useBackgroundPoll';
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

// Cadence for the background /summary refresh. 30s is a compromise
// between "catches a pending→confirmed transition within one minute
// worst-case" and "one SQL per user per 30s is acceptable server
// load". Stored as a module-level constant so tests can reference
// it without hard-coding the number.
export const SUMMARY_POLL_MS = 30 * 1000;

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
      // Intentionally do NOT clear `summary` here. The first-load
      // case starts from the useState([]) default, so a first-time
      // failure still surfaces the empty state correctly (no data
      // to "preserve"). For background refreshes, a transient
      // /gov/receipts/summary blip would otherwise wipe out the
      // cached snapshot on every tick — flashing cohort chips
      // from "Voted" back to "Not voted" and flipping the hero's
      // voted-count to zero, only to restore on the next successful
      // poll. Keeping the last good snapshot + surfacing the error
      // code lets consumers show a non-blocking notice ("summary
      // temporarily unavailable") while the UI stays stable. The
      // gated-off branch above handles the auth/enabled transition
      // separately and DOES reset the summary, which is the only
      // case where we actually want to drop the cache.
    } finally {
      if (mountedRef.current && genRef.current === myGen) {
        setSummaryLoading(false);
      }
    }
  }, [enabled, isAuthenticated, governanceService]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the latest summary available to the background poll
  // callback without re-subscribing the poll on every state change.
  // `useBackgroundPoll` tears down its timer when the callback
  // identity changes, so if reconcilePendingAndLoad closed over
  // `summary` directly, each successful tick (which updates summary
  // via load()) would rebuild the callback, reset the timer, and
  // effectively re-anchor the 30s cadence to the last successful
  // response instead of the last tick. Reading through a ref keeps
  // the callback identity stable while still seeing fresh data.
  const summaryRef = useRef(summary);
  useEffect(() => {
    summaryRef.current = summary;
  }, [summary]);

  // Background polling for /gov/receipts/summary. Keeps per-row
  // cohort chips and the hero "Voted N of M" counts in sync with
  // backend-side reconciliation (e.g. relayed receipts flipping to
  // confirmed as Core tallies them) without forcing the user to
  // reload the page or close a modal.
  //
  // Each tick does TWO things in order:
  //
  //   1. For every proposal with at least one `relayed` receipt in
  //      the last-known summary, fire POST /gov/receipts/reconcile.
  //      That's the only call that can flip receipts from relayed
  //      to confirmed by issuing `gobject_getcurrentvotes`; without
  //      it, /summary is a pure SELECT that would keep returning
  //      stale `relayed` rows forever (until the user happened to
  //      reopen the proposal's vote modal, which is what triggers
  //      the modal-scoped reconcile in useOwnedMasternodes).
  //   2. Call load() to pick up any transitions the reconciles just
  //      wrote.
  //
  // Rate-limit / RPC cost notes:
  //
  //   * The backend's per-proposal `gobject_getcurrentvotes` cache
  //     (2 min TTL) dedupes concurrent callers across users, so a
  //     single 30s tick across many logged-in sessions still costs
  //     one RPC per proposal per TTL window at most.
  //   * /gov/receipts/reconcile also short-circuits at the route
  //     layer when every row is confirmed inside `receiptsFreshnessMs`
  //     (`reconciled: false` with no RPC), so proposals whose votes
  //     have already settled don't generate work.
  //   * `POST /gov/vote` invalidates the cache entry for the just-
  //     voted proposal, so the first reconcile after a relay does
  //     hit the chain (which is what we want — the cache was stale).
  //   * Reconcile errors are swallowed per-proposal so one flaky
  //     proposal can't stop the rest of the batch (or the follow-up
  //     load) from running.
  //
  // Deliberate scope:
  //
  //   * Only proposals the user has receipts for are polled for
  //     reconciliation — not the whole `gobject list` feed. Feed
  //     tallies live in /govlist which has its own refresh path.
  //   * The "Last N votes" activity card has its own identical-
  //     cadence poll — both read from receipt-rows state, so we
  //     want them to catch the same reconciliation tick.
  //   * Gated on `enabled && isAuthenticated`, same contract as the
  //     initial load. Anonymous sessions never poll.
  //
  // Visibility-aware pause + catch-up semantics live in the shared
  // `useBackgroundPoll` primitive; see that file for the
  // cadence/visibility contract.
  const reconcilePendingAndLoad = useCallback(async () => {
    if (!enabled || !isAuthenticated) return;
    // Pending = any summary row with at least one still-relayed
    // receipt. Built fresh per tick from the ref so we always act
    // on the latest snapshot even though the callback identity
    // never changes.
    const current = Array.isArray(summaryRef.current) ? summaryRef.current : [];
    const pending = [];
    for (const rowState of current) {
      if (!rowState || typeof rowState.proposalHash !== 'string') continue;
      const relayed = Number(rowState.relayed);
      if (Number.isFinite(relayed) && relayed > 0) {
        pending.push(rowState.proposalHash);
      }
    }
    if (pending.length > 0 && typeof governanceService.reconcileReceipts === 'function') {
      // Parallel fan-out is fine: the backend serialises per-proposal
      // reconciles internally and the currentVotes cache collapses
      // overlapping RPCs. `allSettled` keeps one failure from aborting
      // the follow-up load.
      await Promise.allSettled(
        pending.map((hash) =>
          Promise.resolve()
            .then(() => governanceService.reconcileReceipts(hash))
            .catch(() => null)
        )
      );
    }
    await load();
  }, [enabled, isAuthenticated, governanceService, load]);

  useBackgroundPoll(reconcilePendingAndLoad, {
    enabled: Boolean(enabled && isAuthenticated),
    intervalMs: SUMMARY_POLL_MS,
  });

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
  // locked would be misleading. The hero instead uses the separate
  // `isVaultLocked` signal below to swap the skeleton for a
  // dedicated "unlock your vault" CTA, which otherwise the user
  // would sit on forever after a page reload (the vault master
  // key lives only in memory so every refresh returns to LOCKED).
  const ownedCount = ownedHook.isReady
    ? ownedHook.owned.length
    : ownedHook.isVaultEmpty
      ? 0
      : null;

  // Explicit lock signal so UI can distinguish "waiting on a
  // network fetch" from "waiting on the user to enter their vault
  // password". We surface this as a boolean rather than folding it
  // into `ownedCount` so existing consumers (cohort chips, ops
  // stats) keep their null-means-unknown contract intact.
  const isVaultLocked = Boolean(ownedHook.isVaultLocked);

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
    isVaultLocked,
    refresh,
  };
}
