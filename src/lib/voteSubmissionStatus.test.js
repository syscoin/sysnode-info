import { isUnknownVote, reconciledVoteStatus } from './voteSubmissionStatus';

const batch = { proposalHash: 'a'.repeat(64), voteOutcome: 'no', voteSignal: 'funding', time: 1700000000 };
const entry = { collateralHash: 'b'.repeat(64), collateralIndex: 0, ok: false, error: 'submission_unknown', uncertain: true };
const receipt = { ...entry, proposalHash: batch.proposalHash, voteOutcome: batch.voteOutcome, voteSignal: batch.voteSignal, voteTime: batch.time };

test('absence or unrelated/old receipt never proves that an unknown vote was not submitted', () => {
  for (const receipts of [[], [{ ...receipt, voteTime: batch.time - 1, status: 'confirmed' }], [{ ...receipt, voteOutcome: 'yes', status: 'confirmed' }]]) {
    expect(isUnknownVote(reconciledVoteStatus(entry, batch, { receipts, reconciled: true }))).toBe(true);
  }
});
test('requires explicit fresh stale/failed receipt before retrying an unknown vote', () => {
  expect(isUnknownVote(reconciledVoteStatus(entry, batch, { receipts: [{ ...receipt, status: 'stale' }], reconciled: false }))).toBe(true);
  expect(isUnknownVote(reconciledVoteStatus(entry, batch, { receipts: [{ ...receipt, status: 'stale' }], reconciled: true }))).toBe(false);
});
test('an uncertain read preserves positive and definite-negative outcomes', () => {
  const success = { ...entry, ok: true, error: '', uncertain: false };
  const failure = { ...entry, error: 'signature_invalid', uncertain: false };
  expect(reconciledVoteStatus(success, batch, {})).toBe(success);
  expect(reconciledVoteStatus(failure, batch, {})).toBe(failure);
});
test('a newer confirmed outcome supersedes the requested intent instead of accepting it', () => {
  const result = reconciledVoteStatus(entry, batch, { reconciled: true, receipts: [{ ...receipt, status: 'confirmed', voteTime: batch.time + 1, voteOutcome: 'yes', lastError: 'superseded_by_later_vote' }] });
  expect(result).toMatchObject({ ok: false, error: 'superseded', superseded: true, uncertain: false });
});
test('Core equal-time tie ordering supersedes only a lower outcome', () => {
  const sameTime = { ...receipt, status: 'confirmed', voteOutcome: 'abstain' };
  expect(reconciledVoteStatus(entry, batch, { reconciled: true, receipts: [sameTime] })).toMatchObject({ ok: false, superseded: true });
  expect(isUnknownVote(reconciledVoteStatus(entry, batch, { reconciled: true, receipts: [{ ...sameTime, voteOutcome: 'yes' }] }))).toBe(true);
});
