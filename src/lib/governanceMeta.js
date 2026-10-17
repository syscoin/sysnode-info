import { parseUtcDateValue } from './formatters';

// governanceMeta — pure helpers that derive per-proposal metadata
// chips shown on the Governance feed.
//
// Why these three chips, and why this module:
//
//   1. "Selection soon" — show when next-superblock payout-trigger
//      selection may begin, so users can review proposals before
//      that process starts. This estimate is not a vote expiry.
//
//   2. "Over budget" — the ~72k SYS (roughly) per-superblock budget
//      ceiling is a hard gate: if the sum of currently-passing
//      proposals exceeds the ceiling, the lowest-support passing
//      proposals get pruned from the final payee list. Users voting
//      late need to know whether this proposal is safely funded or
//      is the one teetering on the prune line.
//
//   3. "Close vote" — proposals that sit within a narrow band of
//      the 10% approval threshold are meaningfully decidable by a
//      single voter's action. Flagging them invites engagement
//      from users whose votes actually move the needle, which is
//      the opposite of the noise-floor chip ("wouldn't matter if
//      you voted or not").
//
// All helpers are pure: tests can drive them without touching
// hooks, fetch, or the DOM, and render-time computation stays
// trivial (Math + clock reads, no iteration over feeds).
//
// Units: epoch timestamps are SECONDS (matching what Core emits
// via governance RPCs). Relative-time outputs are in seconds
// unless otherwise noted. `nowMs` arguments are explicit milliseconds
// so injectable clocks in tests remain unambiguous.

// The Syscoin governance threshold: a proposal "passes" when
// AbsoluteYesCount / enabledMNs > 10%. Matches the same constant
// used in ProposalRow for the Passing / Not-enough chip.
export const PASSING_SUPPORT_PERCENT = 10;

// A proposal within ±MARGIN_WARNING_PERCENT of the pass line is
// flagged as a close vote. We chose 1.5 deliberately: too wide and
// every proposal on the feed lights up; too narrow and we miss
// genuinely-contestable rows where rounding on the backend or a
// handful of late voters would flip the outcome. 1.5% = roughly
// ceil(0.015 * enabledCount) votes — a plausible weekend swing
// for the current ~2k–3k enabled masternode cohort.
export const MARGIN_WARNING_PERCENT = 1.5;

// Preserve the existing tier names/API. They now describe approaching
// payout selection, not a deadline after which proposal votes are invalid.
export const CLOSING_URGENT_SECONDS = 2 * 24 * 60 * 60;
export const CLOSING_SOON_SECONDS = 7 * 24 * 60 * 60;

function toSeconds(value) {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const date = typeof value === 'string' ? parseUtcDateValue(value) : null;
  return date ? Math.floor(date.getTime() / 1000) : 0;
}

// Format a positive number of seconds as a human phrase like
// "3h", "2d", "1m". Kept purposely terse because chip real estate
// is scarce; the full tooltip copy does the polite phrasing.
function formatCountdown(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 60 * 60) return `${Math.round(seconds / 60)}m`;
  if (seconds < 24 * 60 * 60) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

// Preserve the public closingChip/votingDeadline names for existing callers.
// The timestamp estimates when next-superblock payout-trigger selection can
// begin, not a hard deadline for submitting proposal votes. Returns null when:
//   * the selection estimate isn't known yet (superblock stats still
//     loading);
//   * selection may already have started — no countdown is appropriate;
//   * the window is wider than CLOSING_SOON_SECONDS — the row
//     doesn't need an urgency label.
//
// Core may retain and accept proposal votes across multiple superblocks.
// Starting trigger selection does not itself close the proposal's vote window.
export function closingChip({ votingDeadline, nowMs } = {}) {
  const deadlineSec = toSeconds(votingDeadline);
  if (deadlineSec <= 0) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const remainingSec = deadlineSec - Math.floor(now / 1000);
  if (remainingSec <= 0) return null;
  if (remainingSec > CLOSING_SOON_SECONDS) return null;
  const urgent = remainingSec <= CLOSING_URGENT_SECONDS;
  return {
    kind: urgent ? 'closing-urgent' : 'closing-soon',
    label: `Selection in ${formatCountdown(remainingSec)}`,
    detail: urgent
      ? 'Estimated payout-trigger selection may begin soon. This is not a deadline for submitting proposal votes.'
      : 'Estimated payout-trigger selection may begin within a week. This is not a deadline for submitting proposal votes.',
    remainingSeconds: remainingSec,
  };
}

// overBudgetChip — warns the user that this proposal is part of a
// set whose collective monthly payouts exceed the superblock
// budget ceiling. When that happens Core prunes the lowest-ranked
// passing proposals until the remaining set fits; rows near the
// pruning cutline should read as "vote pressure matters".
//
// Algorithm:
//   1. Consider only currently-passing proposals (support > 10%).
//   2. Sort them by AbsoluteYesCount descending — Core ranks
//      identically when building the final payee list.
//   3. Walk the sorted list, summing payment_amount. The first
//      proposal whose cumulative sum exceeds the budget marks the
//      cutline: that row (and every row ranked below it) gets the
//      over-budget chip.
//
// Returns a Map keyed by lowercase proposal hash → chip descriptor.
// Callers build the map once per render and look rows up by hash.
// A Map (rather than per-row recompute) keeps the row render
// uncoupled from the feed-wide sort.
export function computeOverBudgetMap({
  proposals,
  enabledCount,
  budget,
}) {
  const out = new Map();
  if (!Array.isArray(proposals) || proposals.length === 0) return out;
  const ceiling = Number(budget);
  if (!(Number.isFinite(ceiling) && ceiling > 0)) return out;
  const enabled = Number(enabledCount);
  if (!(Number.isFinite(enabled) && enabled > 0)) return out;

  // Snapshot of the passing cohort with whatever rank-relevant
  // fields we have. We compute support once here, since the same
  // derivation runs in ProposalRow already — no data divergence
  // risk as long as PASSING_SUPPORT_PERCENT and the denominator
  // stay in sync.
  const passing = [];
  for (const p of proposals) {
    if (!p || typeof p.Key !== 'string') continue;
    const support =
      (Number(p.AbsoluteYesCount || 0) / enabled) * 100;
    if (support <= PASSING_SUPPORT_PERCENT) continue;
    passing.push({
      key: p.Key.toLowerCase(),
      amount: Number(p.payment_amount || 0),
      yes: Number(p.AbsoluteYesCount || 0),
    });
  }
  passing.sort((a, b) => b.yes - a.yes);

  let running = 0;
  for (const row of passing) {
    // Coerce non-finite amounts (NaN / Infinity — e.g. a malformed
    // payment_amount string from the feed) to 0 before adding.
    // Without this, a single NaN contaminates `running` and every
    // subsequent `running > ceiling` comparison returns false,
    // silently dropping chips on rows that genuinely are past the
    // cutline. Clamping at 0 preserves cutline detection for the
    // rest of the list and biases toward NOT warning (vs. warning
    // spuriously on an unknowable amount).
    const amount = Number.isFinite(row.amount) ? Math.max(0, row.amount) : 0;
    running += amount;
    if (running > ceiling) {
      out.set(row.key, {
        kind: 'over-budget',
        label: 'Over budget',
        detail:
          'Currently passing proposals exceed the superblock budget. Low-support rows like this one may be pruned at payout time.',
      });
    }
  }
  return out;
}

// marginChip — flag proposals whose support sits within a narrow
// band of the 10% pass line. Returns null outside the band, or
// when enabledCount is unknown (no stable denominator).
//
// Tone is split by direction:
//   * above the line → "margin-thin": currently passing, at risk
//     of dropping out with a few no votes / a few dropped MNs.
//   * below the line → "margin-near": currently failing, a handful
//     of late yes votes would push it over.
//
// Both carry the same semantic weight; the class split is purely
// so the UI can use color to hint direction of pressure.
export function marginChip({ proposal, enabledCount } = {}) {
  if (!proposal) return null;
  const enabled = Number(enabledCount);
  if (!(Number.isFinite(enabled) && enabled > 0)) return null;
  const support =
    (Number(proposal.AbsoluteYesCount || 0) / enabled) * 100;
  const delta = support - PASSING_SUPPORT_PERCENT;
  if (Math.abs(delta) > MARGIN_WARNING_PERCENT) return null;
  // Strict > 0 so that support = exactly 10% reads as "close to
  // passing", not "slim margin". ProposalRow's pass logic is
  // `support > 10`, so a row at exactly 10% is *not* passing and
  // the chip copy must match that reality — otherwise a user sees
  // "not enough votes" paired with "just above the pass threshold".
  const above = delta > 0;
  return {
    kind: above ? 'margin-thin' : 'margin-near',
    label: above ? 'Slim margin' : 'Close to passing',
    detail: above
      ? 'Support is just above the 10% pass threshold — a handful of No votes could flip this row.'
      : 'Support is just below the 10% pass threshold — a handful of Yes votes could push this row over.',
  };
}
