import { useEffect, useState } from 'react';

import { fetchGovernanceFeed, fetchNetworkStats } from '../lib/api';

const EXCLUDED_HASH =
  '1b9039bd9f7b36dc43a2d8e4dea944550897414fabd981404b3d3d51741175d6';

export default function useGovernanceData() {
  const [state, setState] = useState({
    error: '',
    loadedAt: null,
    loading: true,
    proposals: [],
    stats: null,
  });

  useEffect(function loadGovernanceData() {
    let cancelled = false;

    async function load() {
      try {
        const response = await Promise.all([fetchNetworkStats(), fetchGovernanceFeed()]);
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
            return Number(b.AbsoluteYesCount || 0) - Number(a.AbsoluteYesCount || 0);
          });

        if (cancelled) {
          return;
        }

        setState({
          error: '',
          loadedAt: new Date(),
          loading: false,
          proposals: proposals,
          stats: response[0],
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setState({
          error: 'Unable to load governance data right now.',
          loadedAt: new Date(),
          loading: false,
          proposals: [],
          stats: null,
        });
      }
    }

    load();

    return function cleanup() {
      cancelled = true;
    };
  }, []);

  return state;
}
