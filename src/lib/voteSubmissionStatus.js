// Transport failure is not evidence that Core rejected a vote.
export const isUnknownVote = (entry) => entry?.uncertain === true ||
  ['submission_unknown', 'status_unknown'].includes(entry?.error);

export function reconciledVoteStatus(entry, batch, status) {
  const outcomeRank = { yes: 1, no: 2, abstain: 3 };
  const newer = status?.receipts?.find((row) => row.status === 'confirmed' &&
    row.collateralHash?.toLowerCase() === entry.collateralHash?.toLowerCase() &&
    row.collateralIndex === entry.collateralIndex &&
    row.proposalHash?.toLowerCase() === batch.proposalHash?.toLowerCase() &&
    row.voteSignal === batch.voteSignal && Number.isSafeInteger(row.voteTime) &&
    (row.voteTime > batch.time || (row.voteTime === batch.time &&
      Object.prototype.hasOwnProperty.call(outcomeRank, row.voteOutcome) &&
      outcomeRank[row.voteOutcome] > outcomeRank[batch.voteOutcome])));
  if (status?.reconciled === true && !status.reconcileError && newer)
    return { ...entry, ok: false, error: 'superseded', uncertain: false, superseded: true };
  const receipt = status?.receipts?.find((row) =>
    row.collateralHash?.toLowerCase() === entry.collateralHash?.toLowerCase() &&
    row.collateralIndex === entry.collateralIndex &&
    row.proposalHash?.toLowerCase() === batch.proposalHash?.toLowerCase() &&
    row.voteOutcome === batch.voteOutcome && row.voteSignal === batch.voteSignal &&
    row.voteTime === batch.time);
  if (receipt?.status === 'confirmed' || receipt?.status === 'relayed')
    return { ...entry, ok: true, confirmed: receipt.status === 'confirmed', error: '', uncertain: false };
  if (entry.ok) return entry; // A failed read cannot erase acknowledged success.
  if (!isUnknownVote(entry) && entry.error) return entry;
  if (status?.reconciled === true && !status.reconcileError &&
    (receipt?.status === 'stale' || receipt?.status === 'failed'))
    return { ...entry, ok: false, error: receipt.status, uncertain: false };
  if (entry.notSubmitted === true) return entry;
  return { ...entry, ok: false, error: 'submission_unknown', uncertain: true };
}
