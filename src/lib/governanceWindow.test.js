import {
  ANCHOR_SAME_SB_TOLERANCE_SEC,
  SUPERBLOCK_CYCLE_SEC,
  SUPERBLOCK_FUDGE_SEC,
  SUPERBLOCK_MATURITY_WINDOW_SEC,
  SUPERBLOCK_VOTE_DEADLINE_WARN_SEC,
  anchorsAreSameSuperblock,
  computeProposalWindow,
  isTightVotingWindow,
  nextSuperblockEpochSecFromStats,
} from './governanceWindow';
import { getProposalDurationMonths } from './formatters';

describe('SUPERBLOCK_CYCLE_SEC', () => {
  test('matches Core consensus (17520 blocks * 150s) on the default (mainnet) build', () => {
    expect(SUPERBLOCK_CYCLE_SEC).toBe(17520 * 150);
    // Sanity: roughly 30.4 days.
    expect(SUPERBLOCK_CYCLE_SEC / 86400).toBeCloseTo(30.4166, 3);
  });
  test('SUPERBLOCK_FUDGE_SEC is 2 hours, matching GOVERNANCE_FUDGE_WINDOW', () => {
    expect(SUPERBLOCK_FUDGE_SEC).toBe(2 * 3600);
  });
  test('SUPERBLOCK_MATURITY_WINDOW_SEC matches Core (1728 blocks * 150s) on mainnet', () => {
    expect(SUPERBLOCK_MATURITY_WINDOW_SEC).toBe(1728 * 150);
    // Sanity: ~3 days.
    expect(SUPERBLOCK_MATURITY_WINDOW_SEC / 86400).toBeCloseTo(3.0, 1);
  });
  test('SUPERBLOCK_VOTE_DEADLINE_WARN_SEC on mainnet is exactly 4 days (maturity * 4/3)', () => {
    // 3-day maturity * 4/3 = 4 days. Derived (not hardcoded) so
    // testnet/regtest builds scale the warning proportionally.
    // Codex PR20 round 4 P2.
    expect(SUPERBLOCK_VOTE_DEADLINE_WARN_SEC).toBe(4 * 86400);
    expect(SUPERBLOCK_VOTE_DEADLINE_WARN_SEC).toBe(
      Math.floor((SUPERBLOCK_MATURITY_WINDOW_SEC * 4) / 3)
    );
    expect(SUPERBLOCK_VOTE_DEADLINE_WARN_SEC).toBeGreaterThan(
      SUPERBLOCK_MATURITY_WINDOW_SEC
    );
  });

  test('ANCHOR_SAME_SB_TOLERANCE_SEC is cycle/2 on mainnet (~15 days)', () => {
    expect(ANCHOR_SAME_SB_TOLERANCE_SEC).toBe(
      Math.floor(SUPERBLOCK_CYCLE_SEC / 2)
    );
    // Sanity check: tolerance is strictly less than one full cycle
    // so a legitimate rotation (anchor jumps by ~cycle) is never
    // mis-classified as drift.
    expect(ANCHOR_SAME_SB_TOLERANCE_SEC).toBeLessThan(SUPERBLOCK_CYCLE_SEC);
  });
});

// Codex PR20 round 4 P1: the prepare-time drift check must not
// treat sub-SB /mnStats re-estimates as a superblock rotation.
describe('anchorsAreSameSuperblock', () => {
  const NOW = 1_800_000_000;
  const ANCHOR = NOW + 10 * 86400;

  test('exact equality → same SB', () => {
    expect(anchorsAreSameSuperblock(ANCHOR, ANCHOR)).toBe(true);
  });

  test('sub-cycle drift (seconds / minutes) → same SB', () => {
    // sysMain.js recomputes estimate every 20s as `now +
    // diffBlock * avgBlockTime`. Typical drift between two
    // fetches is seconds to a few minutes depending on new
    // blocks arriving. None of those should ever surface as
    // anchor_drift to the user.
    expect(anchorsAreSameSuperblock(ANCHOR + 20, ANCHOR)).toBe(true);
    expect(anchorsAreSameSuperblock(ANCHOR - 20, ANCHOR)).toBe(true);
    expect(anchorsAreSameSuperblock(ANCHOR + 300, ANCHOR)).toBe(true);
    expect(anchorsAreSameSuperblock(ANCHOR - 300, ANCHOR)).toBe(true);
    // Hours of drift — still within cycle/2 on mainnet.
    expect(anchorsAreSameSuperblock(ANCHOR + 86400, ANCHOR)).toBe(true);
  });

  test('drift approaching cycle/2 is still same SB (boundary)', () => {
    // Any value strictly < cycle/2 is same SB.
    expect(
      anchorsAreSameSuperblock(ANCHOR + ANCHOR_SAME_SB_TOLERANCE_SEC - 1, ANCHOR)
    ).toBe(true);
  });

  test('drift at cycle/2 is NOT same SB (strict less-than)', () => {
    expect(
      anchorsAreSameSuperblock(ANCHOR + ANCHOR_SAME_SB_TOLERANCE_SEC, ANCHOR)
    ).toBe(false);
  });

  test('full-cycle jump (real rotation) → different SB', () => {
    expect(
      anchorsAreSameSuperblock(ANCHOR + SUPERBLOCK_CYCLE_SEC, ANCHOR)
    ).toBe(false);
    expect(
      anchorsAreSameSuperblock(ANCHOR + 30 * 86400, ANCHOR)
    ).toBe(false);
  });

  test('fail-closed on bogus inputs (treated as different SB)', () => {
    // If we cannot tell whether the anchors refer to the same
    // SB, the caller MUST force a re-review rather than silently
    // submit — same semantics as a legitimate rotation.
    expect(anchorsAreSameSuperblock(null, ANCHOR)).toBe(false);
    expect(anchorsAreSameSuperblock(ANCHOR, null)).toBe(false);
    expect(anchorsAreSameSuperblock(undefined, ANCHOR)).toBe(false);
    expect(anchorsAreSameSuperblock(0, ANCHOR)).toBe(false);
    expect(anchorsAreSameSuperblock(ANCHOR, 0)).toBe(false);
    expect(anchorsAreSameSuperblock(-1, ANCHOR)).toBe(false);
    expect(anchorsAreSameSuperblock('soon', ANCHOR)).toBe(false);
  });
});

// Codex PR20 round 3 P1: ensure the window constants track the
// per-network consensus params, not a hardcoded mainnet value.
// Build a testnet/regtest copy of the module with REACT_APP_NETWORK
// set and verify both cycle + maturity come from the right network.
describe('per-network consensus params (Codex PR20 round 3 P1)', () => {
  // jest.isolateModules lets us re-import governanceWindow.js with
  // a different process.env.REACT_APP_NETWORK, which networkParams
  // reads at module load. We restore the original value after each
  // case so the outer describe's mainnet expectations continue to
  // hold.
  const originalNetwork = process.env.REACT_APP_NETWORK;
  afterEach(() => {
    if (originalNetwork === undefined) {
      delete process.env.REACT_APP_NETWORK;
    } else {
      process.env.REACT_APP_NETWORK = originalNetwork;
    }
  });

  function requireWithNetwork(value) {
    if (value === undefined) {
      delete process.env.REACT_APP_NETWORK;
    } else {
      process.env.REACT_APP_NETWORK = value;
    }
    let mod;
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      mod = require('./governanceWindow');
    });
    return mod;
  }

  test('testnet: cycle = 60 blocks, maturity = 20 blocks (Core chainparams.cpp:314)', () => {
    const mod = requireWithNetwork('testnet');
    expect(mod.SUPERBLOCK_CYCLE_SEC).toBe(60 * 150);
    expect(mod.SUPERBLOCK_MATURITY_WINDOW_SEC).toBe(20 * 150);
    // Sanity: testnet SB cadence is 2.5 hours, not 30 days.
    expect(mod.SUPERBLOCK_CYCLE_SEC).toBe(9000);
  });

  test('regtest: cycle = 10 blocks, maturity = 5 blocks (Core chainparams.cpp:570)', () => {
    const mod = requireWithNetwork('regtest');
    expect(mod.SUPERBLOCK_CYCLE_SEC).toBe(10 * 150);
    expect(mod.SUPERBLOCK_MATURITY_WINDOW_SEC).toBe(5 * 150);
    expect(mod.SUPERBLOCK_CYCLE_SEC).toBe(1500);
  });

  test('explicit mainnet matches the default', () => {
    const explicit = requireWithNetwork('mainnet');
    const implicit = requireWithNetwork(undefined);
    expect(explicit.SUPERBLOCK_CYCLE_SEC).toBe(implicit.SUPERBLOCK_CYCLE_SEC);
    expect(explicit.SUPERBLOCK_MATURITY_WINDOW_SEC).toBe(
      implicit.SUPERBLOCK_MATURITY_WINDOW_SEC
    );
  });

  test('unknown label falls back to mainnet so typos cannot produce 0-filled windows', () => {
    const mod = requireWithNetwork('not-a-real-network');
    expect(mod.SUPERBLOCK_CYCLE_SEC).toBe(17520 * 150);
    expect(mod.SUPERBLOCK_MATURITY_WINDOW_SEC).toBe(1728 * 150);
  });

  test.each(['testnet', 'regtest'])(
    '%s: computeProposalWindow span is exactly N * cycle for the active network',
    (netId) => {
      const mod = requireWithNetwork(netId);
      const NOW = 1_800_000_000;
      for (const N of [1, 2, 6, 12]) {
        const anchor = NOW + mod.SUPERBLOCK_CYCLE_SEC + 60; // comfortably future
        const { startEpoch, endEpoch } = mod.computeProposalWindow({
          durationMonths: N,
          nowSec: NOW,
          nextSuperblockSec: anchor,
        });
        // The full-month invariant (end - start = N*cycle) that
        // mainnet tests rely on must also hold on test/reg nets —
        // if it didn't, getProposalDurationMonths would display
        // the wrong label on non-mainnet deployments.
        expect(endEpoch - startEpoch).toBe(N * mod.SUPERBLOCK_CYCLE_SEC);
      }
    }
  );
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
