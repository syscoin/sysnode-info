// Pre-submit support-shift preview for the vote modal.
//
// Given the user's current selection (which MNs, which outcome) and
// each selected MN's prior confirmed receipt, compute what submitting
// would do to the proposal's net support tally. This lets the modal
// surface "Submitting will add +2 net support" or "Submitting will
// flip your earlier 1 yes vote to abstain (net −1)" *before* the
// user clicks, so vote changes are never silently made.
//
// Terminology:
//
//   "Net support" mirrors Core's AbsoluteYesCount = YesCount − NoCount.
//   Abstain doesn't count toward net support (it's a participation
//   marker only). Abstain *does* count toward total participation,
//   but we intentionally don't surface that in the preview because
//   the proposal row's status chip ("Passing / Not passing") is
//   driven by net support, not raw turnout — the delta we show
//   has to match the chip the user sees next to the row.
//
// Input shape:
//
//   entries: Array<{ currentOutcome, previousOutcome, previousStatus }>
//
//     currentOutcome    'yes' | 'no' | 'abstain' — the user's pick in
//                       the modal for this MN. One value shared
//                       across all selected rows today, but the
//                       helper doesn't care; callers could vary it
//                       per MN in the future.
//
//     previousOutcome   Prior receipt's voteOutcome, or '' / null if
//                       there's no prior receipt.
//
//     previousStatus    Prior receipt status. Only 'confirmed' rows
//                       are credited to the chain — 'relayed', 'stale',
//                       and 'failed' don't (and might not) count in
//                       AbsoluteYesCount yet, so they shouldn't be
//                       subtracted from the delta. We treat them as
//                       "no prior contribution to net support".
//
// Return shape:
//
//   {
//     netDelta,           // signed integer; + favours the proposal
//     yesDelta,           // signed integer; YesCount delta
//     noDelta,            // signed integer; NoCount delta
//     confirmedReplaced,  // #entries whose confirmed yes/no is being
//                         // replaced by a different outcome
//     abstainBenign,      // #entries where both sides are abstain /
//                         // no prior vote / same no-op — included
//                         // for test coverage, not displayed today
//   }
//
// Business rules:
//
//   * A "confirmed → different" transition is flagged in
//     confirmedReplaced. That's the interesting case for
//     surfacing "this will change 2 prior votes".
//   * A "confirmed → same" transition contributes 0 to delta and
//     is NOT counted as replacement; the backend short-circuits
//     these via the already_on_chain path so the user never
//     actually re-spends an RPC call.
//   * A non-confirmed prior (or no prior at all) is treated as
//     "no contribution yet". Selecting yes adds +1; no adds −1;
//     abstain adds 0.
//   * Abstain→abstain and no-prior→abstain are benign no-ops for
//     net support (yesDelta = noDelta = 0).

function contributionFor(outcome) {
  if (outcome === 'yes') return { yes: 1, no: 0 };
  if (outcome === 'no') return { yes: 0, no: 1 };
  // abstain and any unknown value => no participation toward net.
  return { yes: 0, no: 0 };
}

export function computeSupportShift(entries) {
  let yesDelta = 0;
  let noDelta = 0;
  let confirmedReplaced = 0;
  let abstainBenign = 0;

  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    const current = entry && entry.currentOutcome;
    const prev = entry && entry.previousOutcome;
    const prevIsConfirmed =
      entry && entry.previousStatus === 'confirmed';

    const now = contributionFor(current);
    const before = prevIsConfirmed ? contributionFor(prev) : { yes: 0, no: 0 };

    yesDelta += now.yes - before.yes;
    noDelta += now.no - before.no;

    if (prevIsConfirmed && prev && prev !== current) {
      confirmedReplaced += 1;
    }
    if (!prev && current === 'abstain') abstainBenign += 1;
    if (prev === 'abstain' && current === 'abstain') abstainBenign += 1;
  }

  return {
    netDelta: yesDelta - noDelta,
    yesDelta,
    noDelta,
    confirmedReplaced,
    abstainBenign,
  };
}

// Render-friendly descriptor for the support-shift preview.
// Returns null when there's nothing useful to say (e.g. nothing
// selected, or the selection is a pure no-op). Callers can
// directly bind the `tone` and `headline` into their UI.
export function describeSupportShift(shift, selectedCount) {
  if (!shift || !Number.isInteger(selectedCount) || selectedCount <= 0) {
    return null;
  }
  const { netDelta, confirmedReplaced } = shift;
  const abs = Math.abs(netDelta);
  const sign = netDelta > 0 ? '+' : netDelta < 0 ? '−' : '±';
  const tone =
    netDelta > 0 ? 'positive' : netDelta < 0 ? 'negative' : 'neutral';

  let headline;
  if (netDelta === 0) {
    headline = 'No net-support change';
  } else {
    headline = `Net support ${sign}${abs}`;
  }

  const detailBits = [];
  if (confirmedReplaced > 0) {
    detailBits.push(
      `${confirmedReplaced} prior confirmed ${
        confirmedReplaced === 1 ? 'vote' : 'votes'
      } will change`
    );
  }
  if (shift.yesDelta !== 0) {
    const yAbs = Math.abs(shift.yesDelta);
    detailBits.push(
      `${shift.yesDelta > 0 ? '+' : '−'}${yAbs} yes`
    );
  }
  if (shift.noDelta !== 0) {
    const nAbs = Math.abs(shift.noDelta);
    detailBits.push(
      `${shift.noDelta > 0 ? '+' : '−'}${nAbs} no`
    );
  }

  return {
    tone,
    headline,
    detail: detailBits.join(' · '),
    netDelta,
  };
}
