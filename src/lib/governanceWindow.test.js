import {
  SUPERBLOCK_CYCLE_SEC,
  SUPERBLOCK_FUDGE_SEC,
  SUPERBLOCK_MATURITY_WINDOW_SEC,
  SUPERBLOCK_VOTE_DEADLINE_WARN_SEC,
  computeProposalWindow,
  isTightVotingWindow,
  nextSuperblockEpochSecFromStats,
} from './governanceWindow';
import { getProposalDurationMonths } from './formatters';

describe('SUPERBLOCK_CYCLE_SEC', () => {
  test('matches Core consensus (17520 blocks * 150s)', () => {
    expect(SUPERBLOCK_CYCLE_SEC).toBe(17520 * 150);
    // Sanity: roughly 30.4 days.
    expect(SUPERBLOCK_CYCLE_SEC / 86400).toBeCloseTo(30.4166, 3);
  });
  test('SUPERBLOCK_FUDGE_SEC is 2 hours, matching GOVERNANCE_FUDGE_WINDOW', () => {
    expect(SUPERBLOCK_FUDGE_SEC).toBe(2 * 3600);
  });
  test('SUPERBLOCK_MATURITY_WINDOW_SEC matches Core (1728 blocks * 150s)', () => {
    expect(SUPERBLOCK_MATURITY_WINDOW_SEC).toBe(1728 * 150);
    // Sanity: ~3 days.
    expect(SUPERBLOCK_MATURITY_WINDOW_SEC / 86400).toBeCloseTo(3.0, 1);
  });
  test('SUPERBLOCK_VOTE_DEADLINE_WARN_SEC is 4 days (1 day wider than Core maturity)', () => {
    expect(SUPERBLOCK_VOTE_DEADLINE_WARN_SEC).toBe(4 * 86400);
    expect(SUPERBLOCK_VOTE_DEADLINE_WARN_SEC).toBeGreaterThan(
      SUPERBLOCK_MATURITY_WINDOW_SEC
    );
  });
});

describe('isTightVotingWindow', () => {
  const NOW = 1_800_000_000;

  test('false when anchor is comfortably in the future (> 4 days)', () => {
    expect(isTightVotingWindow(NOW, NOW + 5 * 86400)).toBe(false);
    expect(isTightVotingWindow(NOW, NOW + 7 * 86400)).toBe(false);
    expect(isTightVotingWindow(NOW, NOW + SUPERBLOCK_CYCLE_SEC)).toBe(false);
  });

  test('false at the 4-day boundary (strict less-than)', () => {
    // Exactly at the threshold: not tight (avoids flapping on
    // integer rounding the moment we cross the mark).
    expect(isTightVotingWindow(NOW, NOW + 4 * 86400)).toBe(false);
  });

  test('true when anchor is inside the 4-day window', () => {
    expect(isTightVotingWindow(NOW, NOW + 4 * 86400 - 1)).toBe(true);
    expect(isTightVotingWindow(NOW, NOW + 3 * 86400)).toBe(true);
    expect(isTightVotingWindow(NOW, NOW + 3600)).toBe(true);
    expect(isTightVotingWindow(NOW, NOW + 60)).toBe(true);
  });

  test('false when anchor is missing, stale, or invalid', () => {
    expect(isTightVotingWindow(NOW, NOW)).toBe(false); // equal to now: stale
    expect(isTightVotingWindow(NOW, NOW - 1)).toBe(false); // past: stale
    expect(isTightVotingWindow(NOW, 0)).toBe(false);
    expect(isTightVotingWindow(NOW, null)).toBe(false);
    expect(isTightVotingWindow(NOW, undefined)).toBe(false);
    expect(isTightVotingWindow(NOW, 'soon')).toBe(false);
  });

  test('false when nowSec is invalid (fail-closed)', () => {
    // Defensive: never claim "tight" on a bogus clock — the
    // wizard would render a scary warning for no reason.
    expect(isTightVotingWindow(0, NOW + 60)).toBe(false);
    expect(isTightVotingWindow(-1, NOW + 60)).toBe(false);
    expect(isTightVotingWindow(null, NOW + 60)).toBe(false);
    expect(isTightVotingWindow('now', NOW + 60)).toBe(false);
  });
});

describe('computeProposalWindow', () => {
  const NOW = 1_800_000_000; // arbitrary fixed epoch for determinism

  test('throws on missing / invalid durationMonths', () => {
    expect(() =>
      computeProposalWindow({ durationMonths: 0, nowSec: NOW, nextSuperblockSec: NOW + 1000 })
    ).toThrow();
    expect(() =>
      computeProposalWindow({ nowSec: NOW, nextSuperblockSec: NOW + 1000 })
    ).toThrow();
    expect(() =>
      computeProposalWindow({ durationMonths: -1, nowSec: NOW, nextSuperblockSec: NOW + 1000 })
    ).toThrow();
  });

  test('falls back to now + cycle when anchor is missing or stale', () => {
    // Fallback anchor = NOW + cycle. Start is unclamped (NOW + cycle/2
    // is in the future), end = anchor + (N-1)*cycle + cycle/2.
    const half = Math.floor(SUPERBLOCK_CYCLE_SEC / 2);
    const a = computeProposalWindow({ durationMonths: 1, nowSec: NOW });
    expect(a.startEpoch).toBe(NOW + half);
    expect(a.endEpoch).toBe(NOW + SUPERBLOCK_CYCLE_SEC + half);

    const b = computeProposalWindow({
      durationMonths: 1,
      nowSec: NOW,
      nextSuperblockSec: NOW - 100,
    });
    expect(b).toEqual(a);
  });

  test.each([1, 2, 3, 6, 12, 24, 60])(
    'N=%i: first N superblocks are inside the window, N+1 is excluded',
    (N) => {
      // Pick a mid-range anchor 10 days from now — exercises the
      // unclamped-start branch.
      const anchor = NOW + 10 * 86400;
      const { startEpoch, endEpoch } = computeProposalWindow({
        durationMonths: N,
        nowSec: NOW,
        nextSuperblockSec: anchor,
      });
      const windowStart = startEpoch - SUPERBLOCK_FUDGE_SEC;
      const windowEnd = endEpoch + SUPERBLOCK_FUDGE_SEC;

      // Core eligibility: SB_i time = anchor + (i-1)*cycle
      for (let i = 1; i <= N; i += 1) {
        const sb = anchor + (i - 1) * SUPERBLOCK_CYCLE_SEC;
        expect(sb).toBeGreaterThanOrEqual(windowStart);
        expect(sb).toBeLessThanOrEqual(windowEnd);
      }
      // SB_{N+1} must be excluded
      const sbNext = anchor + N * SUPERBLOCK_CYCLE_SEC;
      expect(sbNext).toBeGreaterThan(windowEnd);
    }
  );

  test.each([1, 2, 3, 6, 12, 60])(
    'N=%i: getProposalDurationMonths renders exactly N months for mid-range anchors',
    (N) => {
      const anchor = NOW + 10 * 86400;
      const { startEpoch, endEpoch } = computeProposalWindow({
        durationMonths: N,
        nowSec: NOW,
        nextSuperblockSec: anchor,
      });
      expect(getProposalDurationMonths(startEpoch, endEpoch)).toBe(N);
    }
  );

  test.each([1, 2, 3, 6, 12, 60])(
    'N=%i: display rounds to N when anchor is very near (start nominally in past)',
    (N) => {
      // anchor = now + 1h : startEpoch lands ~15d before now. Core
      // accepts past start_epoch, and (end - start) = N * cycle
      // exactly, so the displayed month count must still be N.
      const anchor = NOW + 3600;
      const { startEpoch, endEpoch } = computeProposalWindow({
        durationMonths: N,
        nowSec: NOW,
        nextSuperblockSec: anchor,
      });
      expect(endEpoch - startEpoch).toBe(N * SUPERBLOCK_CYCLE_SEC);
      expect(startEpoch).toBeLessThan(NOW); // nominally in the past — OK per Core
      expect(startEpoch).toBeGreaterThan(0);
      expect(getProposalDurationMonths(startEpoch, endEpoch)).toBe(N);
    }
  );

  test.each([1, 2, 3, 6, 12, 60])(
    'N=%i: display rounds to N when anchor is one full cycle away (max anchor)',
    (N) => {
      // anchor = now + cycle (first SB is a full cycle away, the
      // worst-case "just missed" scenario). Clamp inactive.
      const anchor = NOW + SUPERBLOCK_CYCLE_SEC;
      const { startEpoch, endEpoch } = computeProposalWindow({
        durationMonths: N,
        nowSec: NOW,
        nextSuperblockSec: anchor,
      });
      expect(getProposalDurationMonths(startEpoch, endEpoch)).toBe(N);
    }
  );

  test('safety slack to SB_{N+1} is ~half a cycle (>> 2h fudge)', () => {
    const N = 12;
    const anchor = NOW + 10 * 86400;
    const { endEpoch } = computeProposalWindow({
      durationMonths: N,
      nowSec: NOW,
      nextSuperblockSec: anchor,
    });
    const sbNextPlusOne = anchor + N * SUPERBLOCK_CYCLE_SEC;
    const slack = sbNextPlusOne - (endEpoch + SUPERBLOCK_FUDGE_SEC);
    // Slack ~ cycle/2 - 2h ≈ 14.92 days
    expect(slack).toBeGreaterThan(14 * 86400);
    expect(slack).toBeLessThan(16 * 86400);
  });

  test('end_epoch is always > now (so Core fCheckExpiration passes)', () => {
    for (const nextOffsetDays of [0.01, 1, 15, 29, 30]) {
      for (const N of [1, 2, 12, 60]) {
        const { endEpoch } = computeProposalWindow({
          durationMonths: N,
          nowSec: NOW,
          nextSuperblockSec: NOW + nextOffsetDays * 86400,
        });
        expect(endEpoch).toBeGreaterThan(NOW);
      }
    }
  });

  test('end_epoch > start_epoch for every valid input', () => {
    for (const nextOffsetDays of [0.01, 1, 15, 29, 30]) {
      for (const N of [1, 2, 3, 12, 60]) {
        const { startEpoch, endEpoch } = computeProposalWindow({
          durationMonths: N,
          nowSec: NOW,
          nextSuperblockSec: NOW + nextOffsetDays * 86400,
        });
        expect(endEpoch).toBeGreaterThan(startEpoch);
      }
    }
  });
});

describe('nextSuperblockEpochSecFromStats', () => {
  const NOW = 1_800_000_000;

  test('returns the numeric field when strictly in the future', () => {
    expect(
      nextSuperblockEpochSecFromStats(
        { stats: { superblock_stats: { superblock_next_epoch_sec: NOW + 60 } } },
        NOW
      )
    ).toBe(NOW + 60);
  });

  test('handles an un-wrapped payload (stats at root)', () => {
    expect(
      nextSuperblockEpochSecFromStats(
        { superblock_stats: { superblock_next_epoch_sec: NOW + 3600 } },
        NOW
      )
    ).toBe(NOW + 3600);
  });

  test('returns null for missing / non-positive / malformed inputs', () => {
    expect(nextSuperblockEpochSecFromStats(null, NOW)).toBeNull();
    expect(nextSuperblockEpochSecFromStats({}, NOW)).toBeNull();
    expect(nextSuperblockEpochSecFromStats({ stats: {} }, NOW)).toBeNull();
    expect(
      nextSuperblockEpochSecFromStats({ stats: { superblock_stats: {} } }, NOW)
    ).toBeNull();
    expect(
      nextSuperblockEpochSecFromStats(
        { stats: { superblock_stats: { superblock_next_epoch_sec: 0 } } },
        NOW
      )
    ).toBeNull();
    expect(
      nextSuperblockEpochSecFromStats(
        { stats: { superblock_stats: { superblock_next_epoch_sec: 'soon' } } },
        NOW
      )
    ).toBeNull();
  });

  // Codex PR20 P1: the backend's /mnStats feed can lag for a
  // window between the real next superblock landing and
  // sysMain.js refreshing its cache. If we were to accept that
  // stale (past) timestamp as a valid anchor, the wizard would
  // enable Prepare, render a Review schedule starting from a past
  // date, and then silently submit a different window (the
  // computeProposalWindow stale-anchor fallback). Regression
  // tests: any anchor <= nowSec must be rejected the same way a
  // missing field is.
  test('rejects an anchor equal to nowSec as stale', () => {
    expect(
      nextSuperblockEpochSecFromStats(
        { stats: { superblock_stats: { superblock_next_epoch_sec: NOW } } },
        NOW
      )
    ).toBeNull();
  });

  test('rejects an anchor in the past as stale', () => {
    expect(
      nextSuperblockEpochSecFromStats(
        { stats: { superblock_stats: { superblock_next_epoch_sec: NOW - 1 } } },
        NOW
      )
    ).toBeNull();
    expect(
      nextSuperblockEpochSecFromStats(
        { stats: { superblock_stats: { superblock_next_epoch_sec: NOW - 86400 } } },
        NOW
      )
    ).toBeNull();
  });

  test('throws when nowSec is missing or invalid', () => {
    const stats = {
      stats: { superblock_stats: { superblock_next_epoch_sec: NOW + 60 } },
    };
    expect(() => nextSuperblockEpochSecFromStats(stats)).toThrow();
    expect(() => nextSuperblockEpochSecFromStats(stats, 0)).toThrow();
    expect(() => nextSuperblockEpochSecFromStats(stats, -1)).toThrow();
    expect(() => nextSuperblockEpochSecFromStats(stats, 'now')).toThrow();
  });
});
