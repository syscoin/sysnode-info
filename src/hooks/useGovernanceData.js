import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchGovernanceFeed, fetchNetworkStats } from '../lib/api';
import { isSupportedGovernanceProposal } from '../lib/governanceEligibility';
import { normalizeNetworkStats } from '../lib/networkStats';
import { useBackgroundPoll } from './useBackgroundPoll';

// Governance feed + network stats, loaded once on mount and refetchable
// on demand via the returned `refresh` callback.
//
// Why refresh exists:
//
//   The vote modal surfaces a `proposal_not_found` error with a
//   "Reload proposals" CTA when a proposal vanishes between page
//   load and submit time (expired, re-org, operator purge). That
//   CTA used to call the MN-lookup refresh, which does nothing
//   for the proposal feed — so the stale list stayed on screen
//   and the user was stuck. `refresh` gives the modal (and any
//   other consumer) a first-class way to repull the feed without
//   forcing a full page reload.
//
// Concurrency notes:
//
//   * Every invocation captures a monotonically-increasing request
//     id. Only the response whose id matches the latest issued id
//     commits state, so overlapping refreshes (user spams the CTA)
//     can't race each other into an older snapshot.
//   * Unmount flips a ref that both branches check before calling
//     setState, so a late-arriving promise after unmount is a
//     no-op.
//
// Shape returned:
//   { error, loadedAt, loading, proposals, stats, refresh }
//
// `refresh` returns a Promise that resolves once the state has
// been committed (or the request was superseded / unmounted).
// Callers don't need to await it, but doing so lets tests assert
// against settled state.
export default function useGovernanceData() {
  const [state, setState] = useState({
    error: '',
    loadedAt: null,
    loading: true,
    proposals: [],
    proposalsLoaded: false,
    stats: null,
    groups: {},
  });
  const mountedRef = useRef(true);
  const latestRequestIdRef = useRef(0);

  const load = useCallback(async function load() {
    if (!mountedRef.current) return;
    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;
    // Keep the previous proposals/stats visible while the refetch
    // is in flight — toggling the list to empty mid-refresh would
    // cause jarring layout shifts. Mark `loading` so UI surfaces
    // can show a spinner overlay.
    setState(function markLoading(prev) {
      if (!mountedRef.current || latestRequestIdRef.current !== requestId) return prev;
      return { ...prev, loading: true, error: '' };
    });
    try {
      const response = await Promise.allSettled([
        fetchNetworkStats(),
        fetchGovernanceFeed(),
      ]);
      if (!mountedRef.current) return;
      if (latestRequestIdRef.current !== requestId) return;
      const feedSucceeded = response[1].status === 'fulfilled' && Array.isArray(response[1].value);
      const normalized = response[0].status === 'fulfilled'
        ? normalizeNetworkStats(response[0].value) : null;
      const rawProposals = feedSucceeded ? response[1].value : [];
      const nowMs = Date.now();
      const proposals = rawProposals
        .filter(function keepProposal(proposal) {
          return isSupportedGovernanceProposal(proposal, nowMs);
        })
        .sort(function sortBySupport(a, b) {
          return (
            Number(b.AbsoluteYesCount || 0) - Number(a.AbsoluteYesCount || 0)
          );
        });
      setState((previous) => {
        if (!mountedRef.current || latestRequestIdRef.current !== requestId) return previous;
        return {
        error: [!normalized?.stats ? 'Live network statistics are unavailable right now.' : '',
          !feedSucceeded ? 'Unable to refresh the governance proposal feed.' : ''].filter(Boolean).join(' '),
        loadedAt: normalized?.stats ? normalized.loadedAt : previous.loadedAt,
        loading: false,
        proposals: feedSucceeded ? proposals : previous.proposals,
        proposalsLoaded: feedSucceeded || previous.proposalsLoaded,
        stats: normalized?.stats || previous.stats,
        groups: normalized?.stats ? normalized.groups : Object.fromEntries(
          Object.entries(previous.groups).map(([name, group]) => [name,
            group.status === 'unavailable' ? group : { ...group, status: 'stale' }]))
        };
      });
    } catch (err) {
      if (!mountedRef.current) return;
      if (latestRequestIdRef.current !== requestId) return;
      setState((previous) => !mountedRef.current || latestRequestIdRef.current !== requestId ? previous : ({
          ...previous,
          error: 'Unable to load governance data right now.',
          loading: false,
        }));
    }
  }, []);

  useEffect(
    function loadOnMount() {
      mountedRef.current = true;
      load();
      return function cleanup() {
        mountedRef.current = false;
      };
    },
    [load]
  );

  useBackgroundPoll(load, { enabled: true, intervalMs: 60000 });

  return { ...state, refresh: load };
}
