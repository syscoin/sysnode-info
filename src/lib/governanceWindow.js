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

// Syscoin's superblock cadence in wall-clock seconds for the
// active network. The value is nSuperblockCycle (blocks) *
// nPowTargetSpacing (sec/block) as configured in Core's
// kernel/chainparams.cpp; mainnet values are 17520 * 150 ≈ 30.4
// days, but testnet uses 60 blocks and regtest uses 10, so this
// MUST NOT be hardcoded to a single network's values — doing so
// made "1 month" on a testnet build span ~290 real superblocks
// instead of one. The active network is resolved at build time
// from REACT_APP_NETWORK (see lib/networkParams.js). Codex PR20
// round 3 P1.
import { getNetworkParams } from './networkParams';
const NETWORK = getNetworkParams();
export const SUPERBLOCK_CYCLE_SEC =
  NETWORK.superblockCycleBlocks * NETWORK.targetBlockTimeSec;

// Core's fudge tolerance (governanceobject.h GOVERNANCE_FUDGE_WINDOW).
// Included here for tests and sanity asserts; the wizard's safety
// margin is `SUPERBLOCK_CYCLE_SEC / 2` which is ~180x larger than this,
// so in practice we never need to reason about the 2-hour tolerance
// directly.
export const SUPERBLOCK_FUDGE_SEC = 2 * 60 * 60;

// Core's pre-superblock maturity window during which masternodes
// build the payment-list candidate and lock in their YES-FUNDING
// trigger vote. On mainnet this is 1728 blocks at ~2.5 min/block,
// i.e. ~3 days (see kernel/chainparams.cpp:154 and
// governance.cpp:569); testnet uses 20 blocks, regtest uses 5.
// Value is taken from the active network's params — see
// lib/networkParams.js.
//
// The important property: once a masternode has voted YES-FUNDING
// on a trigger during this window it cannot vote YES on another
// trigger for the same cycle (governance.cpp:727 hard-asserts
// this). So the effective vote cutoff for a new proposal to be
// included in the next superblock is not a cliff — it's a
// gradient spread across the ~3-day window as individual
// masternodes commit block-by-block inside `UpdatedBlockTip ->
// CreateSuperblockCandidate -> VoteGovernanceTriggers`.
//
// Any proposal that has not accumulated quorum YES votes before
// a supermajority of masternodes have committed will miss the
// upcoming superblock and pay out N-1 months instead of N (since
// our window intentionally excludes SB_{N+1}).
export const SUPERBLOCK_MATURITY_WINDOW_SEC =
  NETWORK.superblockMaturityWindowBlocks * NETWORK.targetBlockTimeSec;

// Wizard warning threshold — slightly wider than Core's maturity
// window to give masternodes headroom between proposal submission
// and the earliest MN commit. That headroom covers collateral
// confirmation (~15 min for 6 blocks), gobject relay, operator
// review, and vote propagation. Proposals submitted inside this
// window will likely miss the next superblock and pay out N-1
// months instead of N, so the wizard surfaces a prominent notice.
//
// Derivation: `MATURITY * 4/3`. On mainnet this is exactly 4 days
// (3-day maturity + 1-day headroom), matching the original UX
// copy. On testnet (50-min maturity) it becomes ~67 min and on
// regtest (12.5-min maturity) ~17 min — the "1/3 of the maturity
// window as operator headroom" ratio is preserved across networks.
// Codex PR20 round 4 P2: prior to this derivation the constant
// was hardcoded to 4 days, so `isTightVotingWindow` was a
// permanent true on testnet/regtest (cycle < 4 days) and the
// warning banner became useless noise on every non-mainnet build.
export const SUPERBLOCK_VOTE_DEADLINE_WARN_SEC = Math.floor(
  (SUPERBLOCK_MATURITY_WINDOW_SEC * 4) / 3
);

// Tolerance used by the wizard's prepare-time anchor-drift check.
// The backend recomputes `superblock_next_epoch_sec` every
// sysMain.js tick (20 s) as `now + diffBlock * avgBlockTime`, so
// the value drifts by seconds/minutes between fetches even when
// the actual next superblock hasn't rotated. A strict equality
// check treated every such drift as a rotation and popped an
// anchor_drift error — users could get stuck looping through
// re-review prompts without ever reaching `proposalService.prepare`
// (Codex PR20 round 4 P1). Any legitimate rotation advances the
// anchor by ≈ one full cycle, which is ≥ `cycle/2` regardless of
// network, so `cycle/2` cleanly separates drift from rotation.
export const ANCHOR_SAME_SB_TOLERANCE_SEC = Math.floor(
  SUPERBLOCK_CYCLE_SEC / 2
);

// True when `freshAnchor` and `cachedAnchor` refer to the same
// upcoming superblock (differences are estimate drift, not a
// rotation). Both arguments must be positive integers or the
// helper returns false (fail-closed: the caller should treat
// "can't tell" the same as "different SB" and force a re-review).
export function anchorsAreSameSuperblock(freshAnchor, cachedAnchor) {
  const fresh = Math.floor(Number(freshAnchor));
  const cached = Math.floor(Number(cachedAnchor));
  if (!Number.isFinite(fresh) || fresh <= 0) return false;
  if (!Number.isFinite(cached) || cached <= 0) return false;
  return Math.abs(fresh - cached) < ANCHOR_SAME_SB_TOLERANCE_SEC;
}

// Returns true when the next superblock is close enough that
// masternodes are unlikely to have finished voting + committing
// before the trigger locks in. Caller supplies the wall clock
// (nowSec) and the live next-superblock anchor so this stays
// pure + deterministic — same contract as the other helpers here.
// A null / zero / stale anchor returns false (the wizard already
// refuses to submit in that state via the missing-stats banner;
// overlaying a tight-window warning on top would be noise).
export function isTightVotingWindow(nowSec, nextSuperblockSec) {
  const now = Math.floor(Number(nowSec));
  const nextSb = Math.floor(Number(nextSuperblockSec));
  if (!Number.isFinite(now) || now <= 0) return false;
  if (!Number.isFinite(nextSb) || nextSb <= now) return false;
  return nextSb - now < SUPERBLOCK_VOTE_DEADLINE_WARN_SEC;
}

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
