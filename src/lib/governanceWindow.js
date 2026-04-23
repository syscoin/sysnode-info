// Governance proposal window math.
//
// Syscoin governance proposals pay out on superblocks. Core gates
// payouts by a pair of timestamps on the proposal payload:
//
//   payEligible = start_epoch - FUDGE <= SB_time <= end_epoch + FUDGE
//
// where FUDGE = 2 hours (see GOVERNANCE_FUDGE_WINDOW in
// src/governance/governanceobject.h) and SB_time is the projected
// epoch of the superblock being evaluated (computed live at validate
// time as now + (sb_height - current_height) * 150s; see
// CGovernanceManager::CreateSuperblockCandidate).
//
// `payment_count` is NOT stored on-chain. The "N months" label voters
// see in the UI is derived purely from the (end_epoch - start_epoch)
// delta; see formatters.getProposalDurationMonths.
//
// Consequence: pay cadence is controlled entirely by the window. We
// compute a canonical window from a single user-facing input — the
// number of months the proposal runs — so the wizard never asks for
// raw epoch timestamps. The math below is pure + deterministic; it
// takes an authoritative "next superblock" anchor (either from the
// backend stats feed or a conservative fallback) and produces a
// window that:
//
//   * guarantees the first N superblocks starting at `anchor` are
//     inside the [windowStart, windowEnd] range Core checks,
//   * guarantees superblock N+1 (one cycle past the Nth) is outside
//     that range, so an approved proposal never silently extends
//     past its declared duration,
//   * renders as exactly N months via getProposalDurationMonths for
//     every N in [1, MAX_PAYMENT_COUNT].
//
// Pruning note: Core deletes an expired proposal
// GOVERNANCE_DELETION_DELAY (10 min) after `end_epoch`. Our window
// therefore prunes cleanly at end_epoch + ~10 min with no extra month
// allocation.

// 17520 blocks * 150s/block = 2_628_000s ≈ 30.4166 days, the mainnet
// superblock cadence. Kept in-sync with
// Params().GetConsensus().nSuperblockCycle * PowTargetSpacing; any
// change in Core must be mirrored here.
export const SUPERBLOCK_CYCLE_SEC = 17520 * 150;

// Core's fudge tolerance (governanceobject.h GOVERNANCE_FUDGE_WINDOW).
// Included here for tests and sanity asserts; the wizard's safety
// margin is `SUPERBLOCK_CYCLE_SEC / 2` which is ~180x larger than this,
// so in practice we never need to reason about the 2-hour tolerance
// directly.
export const SUPERBLOCK_FUDGE_SEC = 2 * 60 * 60;

// Build the window for a proposal that should pay out for
// `durationMonths` consecutive superblocks starting at the next
// superblock after `nowSec`.
//
// Inputs:
//   durationMonths     : integer >= 1, the user-declared month count.
//                         Also becomes the on-chain `payment_count`
//                         display field (not stored by Core).
//   nowSec             : current wall-clock in UNIX seconds.
//   nextSuperblockSec  : the projected epoch (seconds) of the next
//                         superblock. Pulled from the backend
//                         superblock_stats feed. If stale (<= now)
//                         we fall back to (now + one full cycle)
//                         which is the worst-case conservative
//                         anchor — ensures the first real SB still
//                         lands inside [windowStart, windowEnd].
//
// Returns { startEpoch, endEpoch } as integer UNIX seconds.
//
// Formula:
//   anchor     = nextSuperblockSec      (stale-anchor fallback: now + cycle)
//   startEpoch = anchor - cycle/2
//   endEpoch   = anchor + (N - 1) * cycle + cycle/2
//
// Why cycle/2 margins:
//   * Start: symmetric around the first SB so (end - start) is
//     exactly N * cycle, which renders as precisely N months via
//     getProposalDurationMonths for every N in [1, MAX_PAYMENT_COUNT].
//   * End:   puts end_epoch halfway between SB_N and SB_{N+1}, so
//     SB_N lands comfortably inside the window and SB_{N+1} is
//     excluded with ~15 days of safety — many orders of magnitude
//     larger than the 2-hour consensus fudge, so block-time drift
//     cannot push an extra payment inside the window.
//
// Past start_epoch note:
//   When the next superblock is sooner than cycle/2 (up to ~15 days
//   away), startEpoch is nominally in the past. That is perfectly
//   fine for Core — src/governance/governancevalidators.cpp only
//   rejects `end_epoch` in the past (fCheckExpiration) and requires
//   end > start; it places no "must be in the future" constraint on
//   `start_epoch`. Backend validateStructural matches Core's rules.
//   The legacy wizard validator *did* flag "start in the past" as a
//   user error, but that guard was aimed at catching date-picker
//   typos; the wizard no longer exposes start_epoch as an input, so
//   the validator path is never invoked for a derived window.
export function computeProposalWindow({
  durationMonths,
  nowSec,
  nextSuperblockSec,
} = {}) {
  const n = Math.floor(Number(durationMonths));
  const now = Math.floor(Number(nowSec));
  const nextSb = Math.floor(Number(nextSuperblockSec));
  if (!Number.isFinite(n) || n < 1) {
    throw new Error('computeProposalWindow: durationMonths must be >= 1');
  }
  if (!Number.isFinite(now) || now <= 0) {
    throw new Error('computeProposalWindow: nowSec must be a positive integer');
  }
  // A stale/invalid anchor falls back to now + one cycle — a
  // conservative worst-case that still keeps the real first SB
  // inside the window (the real SB is always <= one cycle from
  // now, so windowStart = (now + cycle) - cycle/2 = now + cycle/2
  // is comfortably before the real SB).
  const anchor =
    Number.isFinite(nextSb) && nextSb > now ? nextSb : now + SUPERBLOCK_CYCLE_SEC;
  const halfCycle = Math.floor(SUPERBLOCK_CYCLE_SEC / 2);
  const startEpoch = anchor - halfCycle;
  const endEpoch = anchor + (n - 1) * SUPERBLOCK_CYCLE_SEC + halfCycle;
  return { startEpoch, endEpoch };
}

// Extract the next-superblock epoch (seconds) from the /mnStats
// response. The backend exposes a numeric `superblock_next_epoch_sec`
// field (see sysnode-backend services/calculations.js). We never
// parse the human-readable `superblock_date` string — it's formatted
// for display only and its shape can drift.
//
// `nowSec` is required and is compared against the extracted anchor:
// any value at or before `nowSec` is treated the same as a missing
// field (returns null). This matters because the backend's stats
// feed can lag — if the real next superblock has just passed and
// sysMain.js hasn't refreshed, `superblock_next_epoch_sec` will be
// in the past. Without this guard the wizard would cache a stale
// anchor (truthy, so the Prepare button stays enabled), and the
// two schedule sources diverge:
//
//   * buildProjectedSchedule consumes nextSuperblockSec verbatim,
//     so Review shows payouts starting in the past.
//   * computeProposalWindow's internal fallback rewrites the anchor
//     to `now + cycle`, so the window actually submitted on-chain
//     is shifted by up to a full cycle from what the user reviewed.
//
// Rejecting stale values here forces refreshStats to surface a
// "live-chain data unavailable" banner and keep the Prepare button
// disabled until a fresh anchor arrives.
export function nextSuperblockEpochSecFromStats(stats, nowSec) {
  const now = Math.floor(Number(nowSec));
  if (!Number.isFinite(now) || now <= 0) {
    throw new Error(
      'nextSuperblockEpochSecFromStats: nowSec must be a positive integer'
    );
  }
  if (!stats || typeof stats !== 'object') return null;
  const root = stats.stats && typeof stats.stats === 'object' ? stats.stats : stats;
  const sb = root.superblock_stats;
  if (!sb || typeof sb !== 'object') return null;
  const value = Number(sb.superblock_next_epoch_sec);
  if (!Number.isFinite(value) || value <= 0) return null;
  const floored = Math.floor(value);
  if (floored <= now) return null;
  return floored;
}
