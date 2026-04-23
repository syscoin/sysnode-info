import { useEffect } from 'react';

// useBackgroundPoll(load, { enabled, intervalMs })
// -----------------------------------------------------------------------
// Small primitive that runs `load()` on a fixed cadence while the tab
// is visible. Paused while `document.hidden`; fires an immediate
// catch-up fetch when the tab becomes visible again — otherwise a
// user who alt-tabs back finds stale data and assumes the page is
// broken.
//
// Scope on purpose:
//
//   * This hook does NOT own the initial fetch. Consumers already
//     have their own on-mount effect that loads data; adding a race
//     by firing a second load here would require cross-effect
//     coordination. Keeping ownership separate lets each caller use
//     its own generation guard pattern (same one Auth/receipt/owned
//     hooks use) without change.
//   * It does NOT expose any return value. The side effect is the
//     entire contract: when the cadence ticks, `load()` runs. The
//     state it produces belongs to the caller.
//   * It does NOT de-duplicate overlapping invocations. Callers
//     should wrap `load` in `useCallback` with the same generation-
//     guard idiom they use for manual refreshes, so a poll tick
//     that lands alongside a user-triggered refresh still commits
//     only the latest response.
//
// Why a factored hook instead of duplicating the effect body:
//
//   Two places want identical visibility-aware cadence: the per-
//   proposal receipt summary in useGovernanceReceipts, and the
//   "Last N votes" activity card. Copying the ~40 lines of scaffold
//   into both risked the two drifting (one fixes a bug, the other
//   doesn't). Factoring keeps them truly identical.
//
// Arguments
//
//   load        — () => Promise<unknown> | unknown. Must be stable
//                 across renders (wrap in useCallback); the effect
//                 re-subscribes when its identity changes, which
//                 would reset the cadence mid-cycle otherwise.
//   enabled     — boolean. When false the hook is fully dormant:
//                 no timer, no listener. Callers pass their own
//                 auth/ready gates through this one flag.
//   intervalMs  — positive finite number. Cadence between ticks
//                 measured from the end of the previous load (so
//                 a slow load can't stack ticks behind itself).
//
// SSR / test environments without `document` or `window` are a
// no-op — this keeps the primitive usable from modules that may
// be imported during server-side prerender pathways.

export function useBackgroundPoll(load, options) {
  const enabled = Boolean(options && options.enabled);
  const intervalMs = options && options.intervalMs;

  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof load !== 'function') return undefined;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return undefined;
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return undefined;
    }

    let cancelled = false;
    let timer = null;
    // Single in-flight guard: ensures at most one load() is active
    // at any time across every entry point (timer tick, visibility
    // catch-up, or any future caller). Without this, a rapid
    // hidden→visible toggle while a poll is already in flight
    // spawns a concurrent second request, breaking the "next run
    // starts after the previous load settles" cadence contract and
    // producing duplicate network traffic plus racey updates for
    // consumers that aren't defensively generation-guarded. The
    // scheduled-tick path already couldn't overlap (schedule() is
    // only armed from the load's finally), but onVisibility could
    // — hence the guard must live at the entry point, not in
    // schedule().
    let inFlight = false;

    function clearTimer() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }

    function runAndReschedule() {
      if (inFlight) {
        // A previous load is still pending; its finally branch will
        // reschedule. No-op here rather than stacking a concurrent
        // request — note this means a hidden→visible transition
        // while a tick's load is in flight won't fire an extra
        // catch-up, which is correct: the in-flight load IS the
        // catch-up, by virtue of being fresher than intervalMs old.
        return;
      }
      inFlight = true;
      // `Promise.resolve(...)` normalises the shape whether `load`
      // returned a promise, a bare value, or nothing; the primitive
      // must not break if a caller accidentally forgets `async`.
      Promise.resolve()
        .then(function invoke() {
          return load();
        })
        .finally(function afterLoad() {
          inFlight = false;
          if (cancelled) return;
          schedule();
        });
    }

    function schedule() {
      clearTimer();
      if (document.hidden) return;
      timer = window.setTimeout(function onTick() {
        timer = null;
        if (cancelled || document.hidden) return;
        runAndReschedule();
      }, intervalMs);
    }

    function onVisibility() {
      if (cancelled) return;
      if (document.hidden) {
        // Tab went to background — stop the cadence. We explicitly
        // do NOT fire one last tick here: the whole point of the
        // pause is to stop traffic from dormant tabs. The visible-
        // again branch will run a catch-up instead.
        clearTimer();
        return;
      }
      // Visible again — fire immediately so the user doesn't sit
      // on stale data for up to intervalMs after focus returns,
      // then resume the regular cadence from the end of that load.
      // The inFlight guard inside runAndReschedule() makes rapid
      // hidden/visible toggles during a pending load a no-op.
      clearTimer();
      runAndReschedule();
    }

    document.addEventListener('visibilitychange', onVisibility);
    schedule();

    return function cleanup() {
      cancelled = true;
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load, enabled, intervalMs]);
}
