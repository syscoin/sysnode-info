import React from 'react';
import { act, render } from '@testing-library/react';

import { useBackgroundPoll } from './useBackgroundPoll';

// Thin probe so we can exercise the hook without pulling a real
// consumer into these tests. The load callback is the only side
// effect we assert on, matching the hook's contract (the side
// effect IS the contract).
function Probe({ load, enabled, intervalMs }) {
  useBackgroundPoll(load, { enabled, intervalMs });
  return null;
}

// Drive visibility transitions the way the browser does: change
// `document.hidden` + `document.visibilityState`, then dispatch the
// `visibilitychange` event. jsdom exposes both as plain getters that
// we can override with a redefined property for the life of the
// test, so this mirrors real-browser behaviour without mocking the
// DOM event dispatcher.
function setDocumentHidden(hidden) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get() {
      return hidden;
    },
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get() {
      return hidden ? 'hidden' : 'visible';
    },
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function flushMicrotasks() {
  // Each awaited promise lets the finally() chains inside the hook
  // settle so the next scheduled tick is armed before we advance
  // the fake clock again. Two awaits is enough for the
  // Promise.resolve().then().finally() structure in the hook.
  await Promise.resolve();
  await Promise.resolve();
}

describe('useBackgroundPoll', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setDocumentHidden(false);
  });

  afterEach(() => {
    jest.useRealTimers();
    setDocumentHidden(false);
  });

  test('fires load on each interval while the tab is visible', async () => {
    const load = jest.fn().mockResolvedValue(undefined);
    render(<Probe load={load} enabled={true} intervalMs={1000} />);

    // No synchronous initial fire — the hook is cadence-only by
    // contract; the first fetch is the consumer's responsibility.
    expect(load).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(3);
  });

  test('does not fire when disabled', async () => {
    const load = jest.fn().mockResolvedValue(undefined);
    render(<Probe load={load} enabled={false} intervalMs={1000} />);

    await act(async () => {
      jest.advanceTimersByTime(5000);
      await flushMicrotasks();
    });
    expect(load).not.toHaveBeenCalled();
  });

  test('pauses ticks when the tab goes hidden', async () => {
    const load = jest.fn().mockResolvedValue(undefined);
    render(<Probe load={load} enabled={true} intervalMs={1000} />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      setDocumentHidden(true);
    });

    // Advance well past multiple interval periods — nothing should
    // fire while hidden. This is the whole point of the pause:
    // dormant tabs contribute zero traffic.
    await act(async () => {
      jest.advanceTimersByTime(10 * 1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('fires an immediate catch-up load when the tab becomes visible again', async () => {
    const load = jest.fn().mockResolvedValue(undefined);
    render(<Probe load={load} enabled={true} intervalMs={1000} />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      setDocumentHidden(true);
      jest.advanceTimersByTime(10 * 1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(1);

    // Return to visible — hook should catch up immediately rather
    // than making the user wait another full interval.
    await act(async () => {
      setDocumentHidden(false);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(2);

    // And the regular cadence resumes from the end of that catch-
    // up call (next tick lands one full interval later).
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(3);
  });

  test('cleanup clears the timer and removes the visibility listener on unmount', async () => {
    const load = jest.fn().mockResolvedValue(undefined);
    const { unmount } = render(
      <Probe load={load} enabled={true} intervalMs={1000} />
    );

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(1);

    unmount();

    // After unmount, neither a tick nor a visibility transition
    // should trigger further loads. If the listener leaked the
    // toggle below would call load() again.
    await act(async () => {
      jest.advanceTimersByTime(10 * 1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      setDocumentHidden(true);
      setDocumentHidden(false);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('tolerates a non-positive intervalMs by being dormant', async () => {
    // Defensive check — a caller that miscomputes an interval
    // (e.g. reads from a missing config value) shouldn't hang the
    // event loop or spin tight. The hook opts out entirely.
    const load = jest.fn().mockResolvedValue(undefined);

    render(<Probe load={load} enabled={true} intervalMs={0} />);
    await act(async () => {
      jest.advanceTimersByTime(5000);
      await flushMicrotasks();
    });
    expect(load).not.toHaveBeenCalled();
  });

  test('rapid hidden→visible toggles during an in-flight load do not spawn a concurrent request', async () => {
    // Regression guard for a racey edge case: with the scheduled-
    // tick path alone, overlap was already impossible because
    // schedule() is only armed from the load's finally. But the
    // visibility catch-up path was a second entry point — if a
    // tick fired, the user quickly tabbed away and back while the
    // fetch was still pending, onVisibility would call the fetch a
    // second time, producing duplicate traffic and racey commits
    // for consumers that aren't generation-guarded. The inFlight
    // gate at the runAndReschedule() entry-point now enforces
    // "at most one load active at any time" across all entry
    // points (tick OR visibility OR future callers).
    let resolveFirst;
    const firstLoad = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const load = jest
      .fn()
      .mockImplementationOnce(() => firstLoad)
      .mockResolvedValue(undefined);

    render(<Probe load={load} enabled={true} intervalMs={1000} />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(1);

    // Toggle hidden then visible while the first load is still
    // pending. The visible transition must NOT start a second
    // fetch — the pending one already covers "catch up after
    // focus" by virtue of being in flight.
    await act(async () => {
      setDocumentHidden(true);
      setDocumentHidden(false);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(1);

    // Once the first load settles, the regular cadence resumes.
    await act(async () => {
      resolveFirst();
      await flushMicrotasks();
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('serialises overlapping load calls — next tick only schedules after the previous load settles', async () => {
    // Prevents a slow load from stacking ticks behind itself: if
    // load takes > intervalMs, we don't want a queue of 3 pending
    // fetches when it finally returns.
    let resolveFirst;
    const firstLoad = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const load = jest
      .fn()
      .mockImplementationOnce(() => firstLoad)
      .mockResolvedValue(undefined);

    render(<Probe load={load} enabled={true} intervalMs={1000} />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(1);

    // While the first load is still in flight, advancing past
    // another full interval must NOT fire a second call.
    await act(async () => {
      jest.advanceTimersByTime(5 * 1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(1);

    // Settle the first load, then advance one more interval — now
    // the second call can fire.
    await act(async () => {
      resolveFirst();
      await flushMicrotasks();
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
