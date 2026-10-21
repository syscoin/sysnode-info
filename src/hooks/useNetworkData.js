import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchNetworkStats, fetchNodeHistory } from '../lib/api';
import { normalizeNetworkStats, normalizeNodeHistory } from '../lib/networkStats';
import { useBackgroundPoll } from './useBackgroundPoll';

export default function useNetworkData() {
  const [state, setState] = useState({
    loading: true,
    statsLoading: true,
    historyLoading: true,
    error: '',
    historyError: '',
    groups: {},
    history: [],
    loadedAt: null,
    stats: null,
  });
  const mounted = useRef(true);
  const generation = useRef(0);

  const load = useCallback(() => {
    const request = ++generation.current;
    function update(fields) {
      if (!mounted.current || request !== generation.current) return;
      setState((previous) => {
        if (!mounted.current || request !== generation.current) return previous;
        const next = { ...previous, ...(typeof fields === 'function' ? fields(previous) : fields) };
        return { ...next, loading: next.statsLoading || next.historyLoading };
      });
    }
    update({ statsLoading: true, historyLoading: true });
    function statsFailure(previous) {
      return {
        statsLoading: false,
        // Keep a known observation visible, explicitly stale, without changing
        // its source timestamp. An outage is never a successful zero snapshot.
        groups: Object.fromEntries(Object.entries(previous.groups).map(([key, group]) =>
          [key, group.status === 'unavailable' ? group : { ...group, status: 'stale' }])),
        error: previous.stats
          ? 'Unable to refresh live statistics. Showing the last known observations.'
          : 'Live network statistics are unavailable right now.',
      };
    }
    const statsRequest = fetchNetworkStats().then((payload) => {
      const normalized = normalizeNetworkStats(payload);
      if (!normalized.stats) update(statsFailure);
      else update({ ...normalized, statsLoading: false, error: '' });
    }).catch(() => update(statsFailure));
    const historyRequest = fetchNodeHistory().then((history) => update({ historyLoading: false,
      history: normalizeNodeHistory(history),
      historyError: Array.isArray(history) ? '' : 'Node history is unavailable right now.'
    })).catch(() => update({ historyLoading: false,
      historyError: 'Node history is unavailable right now.' }));
    return Promise.all([statsRequest, historyRequest]);
  }, []);

  useEffect(function loadNetworkData() {
    mounted.current = true;
    load();
    return function cleanup() {
      mounted.current = false;
      generation.current += 1;
    };
  }, [load]);

  useBackgroundPoll(load, { enabled: true, intervalMs: 60000 });

  return state;
}
