import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchGovernanceFeed, fetchNetworkStats } from '../lib/api';

const EXCLUDED_HASH =
  '1b9039bd9f7b36dc43a2d8e4dea944550897414fabd981404b3d3d51741175d6';

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
    stats: null,
  });
  const mountedRef = useRef(true);
  const latestRequestIdRef = useRef(0);

  const load = useCallback(async function load() {
    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;
    // Keep the previous proposals/stats visible while the refetch
    // is in flight — toggling the list to empty mid-refresh would
    // cause jarring layout shifts. Mark `loading` so UI surfaces
    // can show a spinner overlay.
    setState(function markLoading(prev) {
      return { ...prev, loading: true, error: '' };
    });
    try {
      const response = await Promise.all([
        fetchNetworkStats(),
        fetchGovernanceFeed(),
      ]);
      if (!mountedRef.current) return;
      if (latestRequestIdRef.current !== requestId) return;
      const rawProposals = Array.isArray(response[1]) ? response[1] : [];
      const proposals = rawProposals
        .filter(function keepProposal(proposal) {
          return (
            proposal &&
            proposal.ObectType === 1 &&
            proposal.Hash !== EXCLUDED_HASH &&
            !proposal.fCachedDelete
          );
        })
        .sort(function sortBySupport(a, b) {
          return (
            Number(b.AbsoluteYesCount || 0) - Number(a.AbsoluteYesCount || 0)
          );
        });
      setState({
        error: '',
        loadedAt: new Date(),
        loading: false,
        proposals,
        stats: response[0],
      });
    } catch (err) {
      if (!mountedRef.current) return;
      if (latestRequestIdRef.current !== requestId) return;
      setState({
        error: 'Unable to load governance data right now.',
        loadedAt: new Date(),
        loading: false,
        proposals: [],
        stats: null,
      });
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

  return { ...state, refresh: load };
}
