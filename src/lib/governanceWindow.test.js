import {
  SUPERBLOCK_CYCLE_SEC,
  SUPERBLOCK_FUDGE_SEC,
  computeProposalWindow,
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
  test('returns the numeric field when present', () => {
    expect(
      nextSuperblockEpochSecFromStats({
        stats: { superblock_stats: { superblock_next_epoch_sec: 1_800_000_000 } },
      })
    ).toBe(1_800_000_000);
  });

  test('handles an un-wrapped payload (stats at root)', () => {
    expect(
      nextSuperblockEpochSecFromStats({
        superblock_stats: { superblock_next_epoch_sec: 1_700_000_000 },
      })
    ).toBe(1_700_000_000);
  });

  test('returns null for missing / non-positive / malformed inputs', () => {
    expect(nextSuperblockEpochSecFromStats(null)).toBeNull();
    expect(nextSuperblockEpochSecFromStats({})).toBeNull();
    expect(nextSuperblockEpochSecFromStats({ stats: {} })).toBeNull();
    expect(
      nextSuperblockEpochSecFromStats({ stats: { superblock_stats: {} } })
    ).toBeNull();
    expect(
      nextSuperblockEpochSecFromStats({
        stats: { superblock_stats: { superblock_next_epoch_sec: 0 } },
      })
    ).toBeNull();
    expect(
      nextSuperblockEpochSecFromStats({
        stats: { superblock_stats: { superblock_next_epoch_sec: 'soon' } },
      })
    ).toBeNull();
  });
});
