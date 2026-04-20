import { useEffect, useState } from 'react';

import { fetchNetworkStats, fetchNodeHistory } from '../lib/api';

export default function useNetworkData() {
  const [state, setState] = useState({
    loading: true,
    error: '',
    history: [],
    loadedAt: null,
    stats: null,
  });

  useEffect(function loadNetworkData() {
    let cancelled = false;

    async function load() {
      try {
        const response = await Promise.all([fetchNetworkStats(), fetchNodeHistory()]);

        if (cancelled) {
          return;
        }

        setState({
          loading: false,
          error: '',
          history: Array.isArray(response[1]) ? response[1] : [],
          loadedAt: new Date(),
          stats: response[0],
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setState({
          loading: false,
          error: 'Unable to load the latest network metrics right now.',
          history: [],
          loadedAt: new Date(),
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
