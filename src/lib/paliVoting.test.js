import { buildPaliVoteRequest, publicWatchedVotingNodes, requireWalletVotingCapability, validatePaliVoteResponse, validateVotingCapabilities, voteRelayResults } from './paliVoting';
import { votingFixture, hash, capabilities } from '../testUtils/paliVoting';

test.each([0, 1, 2, 3, 4, 5])('verifies exact Core compact vote vector %s including both public key encodings', (index) => {
  const { request, response, context } = votingFixture(index);
  expect(buildPaliVoteRequest(capabilities, context, request.proposalHash, request.outcome, [hash])).toEqual(request);
  expect(validatePaliVoteResponse(response, request, context)).toEqual({ proposalHash: request.proposalHash, voteOutcome: request.outcome, voteSignal: 'funding', time: request.timestamp, entries: [{ collateralHash: request.nodes[0].collateralOutpoint.txid, collateralIndex: request.nodes[0].collateralOutpoint.vout, voteSig: response.votes[0].voteSig }] });
});

test.each(['chain', 'outcome', 'timestamp', 'proposalHash', 'missing', 'extra', 'outpoint', 'signatureHash', 'voteHash', 'signature', 'votingKey'])('rejects changed %s before relay', (field) => {
  const { request, response, context } = votingFixture();
  if (field === 'chain') response.chain = { ...response.chain, genesisHash: 'd'.repeat(64) };
  if (field === 'outcome') response.outcome = 'no';
  if (field === 'timestamp') response.timestamp += 1;
  if (field === 'proposalHash') response.proposalHash = 'd'.repeat(64);
  if (field === 'missing') response.votes = [];
  if (field === 'extra') response.votes.push(response.votes[0]);
  if (field === 'outpoint') response.votes[0].collateralOutpoint = { ...response.votes[0].collateralOutpoint, vout: 42 };
  if (field === 'signatureHash') response.votes[0].signatureHash = 'd'.repeat(64);
  if (field === 'voteHash') response.votes[0].voteHash = 'd'.repeat(64);
  if (field === 'signature') response.votes[0].voteSig += '=';
  if (field === 'votingKey') context.nodes[0].votingKeyId = 'd'.repeat(40);
  expect(() => validatePaliVoteResponse(response, request, context)).toThrow('invalid_wallet_vote');
});

test('trusted-context and public-only projections reject wrong network, missing and duplicate nodes', () => {
  const { request, context } = votingFixture();
  expect(publicWatchedVotingNodes([{ network: 'testnet', proTxHash: hash, label: 'Node', wif: 'never project' }, { network: 'mainnet', proTxHash: 'b'.repeat(64) }], 'testnet')).toEqual([{ proTxHash: hash, label: 'Node' }]);
  expect(() => buildPaliVoteRequest(capabilities, { ...context, chain: { ...context.chain, era: 'pq-v4' } }, request.proposalHash, 'yes', [hash])).toThrow('network_mismatch');
  expect(() => buildPaliVoteRequest(capabilities, context, request.proposalHash, 'yes', [hash, hash])).toThrow();
  expect(() => buildPaliVoteRequest(capabilities, { ...context, nodes: [] }, request.proposalHash, 'yes', [hash])).toThrow();
  expect(() => validateVotingCapabilities({ ...capabilities, chain: { ...capabilities.chain, era: 'pq-v4' } })).toThrow('pq_voting_unavailable');
  expect(() => requireWalletVotingCapability({})).toThrow('pali_voting_unavailable');
});

test('missing relay result is unknown, never a success', () => {
  const entry = { collateralHash: hash, collateralIndex: 0, voteSig: 'signature' };
  expect(voteRelayResults({ results: [] }, [entry])).toEqual([{ ...entry, ok: false, error: 'status_unknown' }]);
});
