// Governance "cohort" chip — describes the authenticated user's
// personal voting state for a single proposal, independent of the
// network-wide "Passing / Not enough votes" verdict.
//
// Inputs:
//
//   summaryRow   — one row of the `/gov/receipts/summary` response for
//                  this proposalHash. Undefined/null when the user
//                  has no receipts for the proposal yet.
//
//                  Shape (see lib/voteReceipts.js summaryForUser):
//                    { proposalHash, total, relayed, confirmed,
//                      stale, failed,
//                      confirmedYes, confirmedNo, confirmedAbstain,
//                      latestSubmittedAt, latestVerifiedAt }
//
//   ownedCount   — number of live masternodes the user owns (via
//                  the vault ↔ MN list join). Used as the denominator
//                  for "Voted 2 of 5" / "Not voted" chips. Pass
//                  `null` when unknown (vault locked or we haven't
//                  looked up yet) so we fall back to chips that
//                  don't require it.
//
// Output:
//
//   null          — render no chip (either user has no stake here,
//                   or we have no data to make a meaningful claim).
//
//   {             — render a chip with:
//     kind,        //  semantic category (CSS hook, stable id)
//     label,       //  short text on the chip itself
//     detail,      //  longer tooltip copy, safe for `title` attr
//   }
//
// Design notes:
//
//   * Priority order follows the UX grief hierarchy — if there's a
//     cross-device vote change (`stale`) we tell the user first
//     because it affects intent. Then failures (actionable on their
//     side), then pending confirmations, then success, then
//     "not voted" (informational only).
//
//   * Confirmed outcome is the MAJORITY of confirmed receipts for
//     the proposal. If the user split their vote across MNs (some
//     yes, some no), we surface the majority in the chip label and
//     detail the split in the tooltip. Edge case where the split is
//     exactly even uses stable tie-breaking (yes → no → abstain).
//
//   * `total` in the summary counts *receipts*, not the user's MN
//     count. If the user has 5 MNs and voted with only 2, total=2
//     and ownedCount=5 → partial cohort.
//
//   * The helper is intentionally pure. UI surfaces (ProposalRow, a
//     future cohort legend) can render it however they like; the
//     chip semantics are what need to stay consistent, not the CSS.

function toNonNegativeInt(value) {
  // better-sqlite3 returns SUM() results as Number; undefined/null
  // get coerced to NaN which we clamp to 0 so downstream arithmetic
  // can stay unguarded.
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function pluralMn(n) {
  return n === 1 ? 'masternode' : 'masternodes';
}

function pluralVote(n) {
  return n === 1 ? 'vote' : 'votes';
}

// Which confirmed outcome should headline the chip? Majority, with
// deterministic tie-break. Returns null when there are no confirmed
// receipts at all.
function dominantOutcome(confirmedYes, confirmedNo, confirmedAbstain) {
  if (confirmedYes === 0 && confirmedNo === 0 && confirmedAbstain === 0) {
    return null;
  }
  // yes > no > abstain tie-break keeps the visible label stable
  // across summary refreshes when counts sit on a boundary.
  if (confirmedYes >= confirmedNo && confirmedYes >= confirmedAbstain) {
    return 'yes';
  }
  if (confirmedNo >= confirmedAbstain) return 'no';
  return 'abstain';
}

// Assemble a human-readable breakdown of the confirmed outcomes for
// tooltips. Hidden when there is exactly one confirmed row with an
// unambiguous outcome (a simple "Voted yes" is clearer than "Voted
// yes (1 yes)").
function confirmedBreakdown({ confirmedYes, confirmedNo, confirmedAbstain }) {
  const parts = [];
  if (confirmedYes > 0) parts.push(`${confirmedYes} yes`);
  if (confirmedNo > 0) parts.push(`${confirmedNo} no`);
  if (confirmedAbstain > 0) parts.push(`${confirmedAbstain} abstain`);
  if (parts.length <= 1) return '';
  return ` (${parts.join(', ')})`;
}

export function cohortChip(summaryRow, ownedCount) {
  const ownedKnown = Number.isInteger(ownedCount) && ownedCount >= 0;

  if (!summaryRow) {
    // No receipts for this proposal. Only show a "Not voted" chip
    // if we can promise the user they actually have MNs that could
    // vote — otherwise we'd nag users who don't own any MNs with
    // "not voted" chips on every row.
    if (ownedKnown && ownedCount > 0) {
      return {
        kind: 'not-voted',
        label: 'Not voted',
        detail: `You have ${ownedCount} ${pluralMn(
          ownedCount
        )} that can vote on this proposal.`,
      };
    }
    return null;
  }

  const confirmed = toNonNegativeInt(summaryRow.confirmed);
  const relayed = toNonNegativeInt(summaryRow.relayed);
  const stale = toNonNegativeInt(summaryRow.stale);
  const failed = toNonNegativeInt(summaryRow.failed);
  const total = toNonNegativeInt(summaryRow.total);

  // Degenerate row: every status count (and total) coerced to 0.
  // Shouldn't happen against real data — the backend's GROUP BY
  // can't yield rows for proposals with zero receipts — but guard
  // against upstream bugs and corrupted payloads. Fall through to
  // the "no summary row" branch so the user still gets a sensible
  // "Not voted" chip when they own MNs.
  if (confirmed + relayed + stale + failed === 0 && total === 0) {
    return cohortChip(null, ownedCount);
  }
  const confirmedYes = toNonNegativeInt(summaryRow.confirmedYes);
  const confirmedNo = toNonNegativeInt(summaryRow.confirmedNo);
  const confirmedAbstain = toNonNegativeInt(summaryRow.confirmedAbstain);
  const outcome = dominantOutcome(confirmedYes, confirmedNo, confirmedAbstain);
  const breakdown = confirmedBreakdown({
    confirmedYes,
    confirmedNo,
    confirmedAbstain,
  });

  // Stale first — a cross-device vote change is the only state that
  // implies the user's *intent* might be out of sync. The detail
  // copy is deliberately blunt because the fix is non-obvious.
  if (stale > 0) {
    return {
      kind: 'changed',
      label: 'Changed',
      detail:
        `${stale} of your ${pluralVote(stale)} were changed elsewhere ` +
        `(another device, or removed by the network). Re-open this ` +
        `proposal to re-submit your intended vote.`,
    };
  }

  // Actionable failures dominate over pending/confirmed for the
  // same reason — the user has to do something.
  if (failed > 0) {
    const ok = confirmed + relayed;
    const detail =
      ok > 0
        ? `${ok} of ${total} succeeded; ${failed} failed. Open the ` +
          `proposal and click Retry failed.`
        : `${failed} ${pluralVote(failed)} failed. Open the proposal ` +
          `and retry.`;
    return { kind: 'needs-retry', label: 'Needs retry', detail };
  }

  // Partial: the user has receipts, but not for every MN they own.
  // We need a reliable ownedCount to make this claim — without one
  // we fall through to "Voted" with whatever we have.
  if (ownedKnown && ownedCount > total) {
    const missing = ownedCount - total;
    return {
      kind: 'partial',
      label: `Voted ${total}/${ownedCount}`,
      detail:
        `${total} of your ${ownedCount} ${pluralMn(
          ownedCount
        )} voted${breakdown}. ${missing} ${pluralMn(missing)} ` +
        `haven't voted yet.`,
    };
  }

  // Relayed but not yet on chain — Core's tally hasn't surfaced the
  // vote via gobject_getcurrentvotes. Usually resolves within a
  // minute on mainnet; surface so users aren't confused by a
  // success-but-no-green-checkmark gap.
  if (relayed > 0) {
    const detail =
      confirmed > 0
        ? `${confirmed} of ${total} confirmed on chain; ${relayed} ` +
          `awaiting confirmation${breakdown}.`
        : `${relayed} ${pluralVote(relayed)} submitted, ` +
          `awaiting confirmation on chain.`;
    return { kind: 'pending', label: 'Pending', detail };
  }

  // All confirmed — the happy path. Outcome in the label makes the
  // chip a zero-hover read for the common case.
  if (confirmed > 0) {
    const label = outcome ? `Voted ${outcome}` : 'Voted';
    const suffix =
      ownedKnown && ownedCount > 0 && ownedCount === total
        ? ` (all ${ownedCount} ${pluralMn(ownedCount)})`
        : '';
    return {
      kind: 'voted',
      label,
      detail: `${total} ${pluralVote(total)} confirmed on chain${breakdown}${suffix}.`,
    };
  }

  // Non-zero total but no confirmed / relayed / stale / failed is
  // logically unreachable (status is a closed set), but don't crash
  // if the backend ships a new status code we haven't taught this
  // helper about yet.
  return null;
}
