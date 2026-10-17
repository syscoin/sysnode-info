import { base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/legacy';
import * as secp from '@noble/secp256k1';
import { buildVotePreimage, signatureHash } from './syscoin/voteSigner';

export const PALI_VOTE_LIMIT = 20;
const HASH = /^(?!0+$)[0-9a-f]{64}$/;
const KEY_ID = /^(?!0+$)[0-9a-f]{40}$/;
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const displayHash = (bytes) => hex(Uint8Array.from(bytes).reverse());
function invalid(code = 'invalid_voting_context') { const error = new Error(code); error.code = code; throw error; }
const validOutpoint = (value) => HASH.test(value?.txid || '') && Number.isSafeInteger(value?.vout) && value.vout >= 0 && value.vout <= 0x7fffffff;
const sameOutpoint = (a, b) => a?.txid === b?.txid && a?.vout === b?.vout;
const outpointId = (value) => `${value.txid}:${value.vout}`;

export function validateVotingCapabilities(value) {
  if (value?.version !== 1 || typeof value.network !== 'string' || !value.network || !HASH.test(value.chain?.genesisHash || '')) invalid();
  if (value.chain.era !== 'legacy-v3') invalid('pq_voting_unavailable');
  return value;
}

export function publicWatchedVotingNodes(value, network) {
  if (!Array.isArray(value)) invalid();
  const seen = new Set();
  return value.filter((node) => {
    if (node?.network !== network) return false;
    if (!HASH.test(node.proTxHash || '')) invalid();
    if (seen.has(node.proTxHash)) return false;
    seen.add(node.proTxHash);
    return true;
  }).map((node) => ({ proTxHash: node.proTxHash, label: typeof node.label === 'string' ? node.label.slice(0, 80) : '' }));
}

export function buildPaliVoteRequest(capabilities, context, proposalHash, outcome, selected) {
  validateVotingCapabilities(capabilities);
  if (!HASH.test(proposalHash) || !['yes', 'no', 'abstain'].includes(outcome) || !Array.isArray(selected) || !selected.length || selected.length > PALI_VOTE_LIMIT || new Set(selected).size !== selected.length) invalid();
  if (context?.chain?.genesisHash !== capabilities.chain.genesisHash || context.chain.era !== 'legacy-v3' || context.proposalHash !== proposalHash) invalid('network_mismatch');
  if (!Number.isSafeInteger(context.now) || context.now < 0 || !Array.isArray(context.nodes) || context.nodes.length !== selected.length) invalid();
  const byHash = new Map(); const outpoints = new Set();
  for (const node of context.nodes) {
    if (!HASH.test(node?.proTxHash || '') || byHash.has(node.proTxHash) || node.valid !== true || !validOutpoint(node.collateralOutpoint) || !KEY_ID.test(node.votingKeyId || '') || outpoints.has(outpointId(node.collateralOutpoint))) invalid();
    byHash.set(node.proTxHash, node); outpoints.add(outpointId(node.collateralOutpoint));
  }
  const nodes = selected.map((hash) => {
    const node = byHash.get(hash); if (!node) invalid();
    return { proTxHash: node.proTxHash, collateralOutpoint: { ...node.collateralOutpoint } };
  });
  return { version: 1, chain: { genesisHash: capabilities.chain.genesisHash, era: 'legacy-v3' }, proposalHash, signal: 'funding', outcome, timestamp: context.now, nodes };
}

export function requireWalletVotingCapability(value) {
  if (value?.governanceVote?.scheme !== 'secp256k1' || value.governanceVote.signal !== 'funding' || !Number.isSafeInteger(value.governanceVote.maxNodes) || value.governanceVote.maxNodes < PALI_VOTE_LIMIT) invalid('pali_voting_unavailable');
}

// Do not relay an opaque wallet result. Bind every returned signature to the
// reviewed batch and the independently resolved registered voting identity.
export function validatePaliVoteResponse(value, request, context) {
  if (value?.version !== 1 || value.chain?.genesisHash !== request.chain.genesisHash || value.chain.era !== request.chain.era || value.proposalHash !== request.proposalHash || value.signal !== request.signal || value.outcome !== request.outcome || value.timestamp !== request.timestamp || !Array.isArray(value.votes) || value.votes.length !== request.nodes.length) invalid('invalid_wallet_vote');
  const results = new Map();
  for (const vote of value.votes) {
    const expected = request.nodes.find((node) => node.proTxHash === vote?.proTxHash);
    const trusted = context.nodes.find((node) => node.proTxHash === vote?.proTxHash);
    if (!expected || !trusted || results.has(vote.proTxHash) || !sameOutpoint(vote.collateralOutpoint, expected.collateralOutpoint) || typeof vote.voteSig !== 'string' || vote.voteSig.length !== 88) invalid('invalid_wallet_vote');
    const fields = { proposalHash: request.proposalHash, voteOutcome: request.outcome, voteSignal: request.signal, time: request.timestamp, collateralHash: expected.collateralOutpoint.txid, collateralIndex: expected.collateralOutpoint.vout };
    try {
      const bytes = base64.decode(vote.voteSig);
      if (bytes.length !== 65 || base64.encode(bytes) !== vote.voteSig || bytes[0] < 27 || bytes[0] > 34) invalid('invalid_wallet_vote');
      const digest = signatureHash(fields);
      const signature = secp.Signature.fromCompact(bytes.slice(1)).addRecoveryBit((bytes[0] - 27) & 3);
      if (signature.hasHighS()) invalid('invalid_wallet_vote');
      const publicKey = signature.recoverPublicKey(digest).toBytes(bytes[0] >= 31);
      if (hex(ripemd160(sha256(publicKey))) !== trusted.votingKeyId || !secp.verify(signature, digest, publicKey)) invalid('invalid_wallet_vote');
      const identity = buildVotePreimage(fields);
      const view = new DataView(identity.buffer, identity.byteOffset, identity.byteLength);
      const outcome = view.getUint32(68, true);
      view.setUint32(68, 1, true); view.setUint32(72, outcome, true);
      if (vote.signatureHash !== displayHash(digest) || vote.voteHash !== displayHash(sha256(sha256(identity)))) invalid('invalid_wallet_vote');
    } catch (_) { invalid('invalid_wallet_vote'); }
    results.set(vote.proTxHash, { collateralHash: expected.collateralOutpoint.txid, collateralIndex: expected.collateralOutpoint.vout, voteSig: vote.voteSig });
  }
  return { proposalHash: request.proposalHash, voteOutcome: request.outcome, voteSignal: request.signal, time: request.timestamp, entries: request.nodes.map((node) => results.get(node.proTxHash)) };
}

export function voteRelayResults(response, entries) {
  return entries.map((entry) => {
    const result = response?.results?.find((row) => row.collateralHash?.toLowerCase() === entry.collateralHash && row.collateralIndex === entry.collateralIndex);
    return { ...entry, ok: result?.ok === true, error: result?.ok === true ? '' : result?.error || 'status_unknown', ...(result?.uncertain === true ? { uncertain: true } : {}), ...(result?.notSubmitted === true ? { notSubmitted: true } : {}) };
  });
}

export function paliVotingError(error) {
  if (typeof error?.message === 'string' && error.message.includes('SENTRY_VOTING_KEY_MISSING:')) return 'Pali does not hold every selected node’s voting key. Import the matching voting keys into Pali, or select only nodes you can vote for.';
  const code = error?.code || error?.message;
  const messages = {
    pq_voting_unavailable: 'Pali voting is not enabled for the PQ protocol. No legacy fallback was used.',
    pali_voting_unavailable: 'Update Pali to a version that supports Sentry voting.',
    method_not_supported: 'Update Pali to a version that supports Sentry voting.',
    pali_unavailable: 'Open or install Pali to vote using keys held in the wallet.',
    user_rejected: 'Approval was cancelled. No votes were submitted.',
    invalid_wallet_vote: 'Pali returned a vote that did not match this review. Nothing was submitted.',
    network_mismatch: 'The node service and wallet must use the same Syscoin network.',
    invalid_voting_context: 'The service could not verify this voting batch. Reload the nodes and try again.',
    KEY_MISMATCH: 'Pali does not hold every selected node’s registered voting key. Select only nodes whose voting keys you imported into Pali.',
    MISSING_KEY: 'A selected voting key is not imported into Pali. Import it in Pali or select fewer nodes.',
    context_changed: 'The account or network changed. Reload and review the vote again.',
  };
  if (messages[code]) return messages[code];
  if (error?.status === 429) return 'Too many requests. Wait before trying again.';
  return 'The request could not be completed. No automatic retry was sent.';
}
