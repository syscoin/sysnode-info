import { normalizeProTxHash } from './sentryService';

export const NODE_IMPORT_LIMIT = 20;
export const NODE_IMPORT_MAX_LENGTH = 16384;
export const nodeImportId = (network, hash) => `${network}:${hash.toLowerCase()}`;

// Keep invalid input out of the preview and all requests. In particular, do
// not auto-detect private-key formats in the public node-ID input.
export function parseNodeImport(text, network, watched = []) {
  const lines = String(text || '').split(/\r?\n/);
  const existing = new Set(watched.filter((node) => typeof node?.network === 'string' && /^[0-9a-f]{64}$/i.test(node?.proTxHash || '')).map((node) => nodeImportId(node.network, node.proTxHash)));
  const seen = new Set();
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const row = { id: i + 1, lineNo: i + 1, label: '', selected: false };
    if (rows.length >= NODE_IMPORT_LIMIT) {
      rows.push({ ...row, status: 'limit', message: `Over the ${NODE_IMPORT_LIMIT}-node batch limit. Move this line to the next batch.` });
      continue;
    }
    const comma = line.indexOf(',');
    const hash = comma < 0 ? line : line.slice(0, comma).trim();
    const label = comma < 0 ? '' : line.slice(comma + 1).trim();
    let proTxHash;
    try { proTxHash = normalizeProTxHash(hash); }
    catch { rows.push({ ...row, status: 'invalid', message: 'Enter a 64-character public ProTx ID, optionally followed by a comma and label.' }); continue; }
    if (label.length > 80 || [...label].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      rows.push({ ...row, proTxHash, status: 'invalid', message: 'Use a label of at most 80 characters without control characters.' }); continue;
    }
    const id = nodeImportId(network, proTxHash);
    if (seen.has(id)) rows.push({ ...row, proTxHash, label, status: 'duplicate', message: 'Duplicate in this batch.' });
    else if (existing.has(id)) rows.push({ ...row, proTxHash, label, status: 'existing', message: 'Already watched. Its existing label will be kept.' });
    else rows.push({ ...row, proTxHash, label, status: 'valid', message: 'Ready to look up on this network.' });
    seen.add(id);
  }
  return { rows, overLimit: rows.length > NODE_IMPORT_LIMIT, tooLong: String(text || '').length > NODE_IMPORT_MAX_LENGTH };
}

export function publicVotingNodes(owned) {
  // The voting hook also contains WIFs for its signing callers. This explicit
  // projection is the only data handed to node previews or watch requests.
  const seen = new Set();
  return owned.flatMap((node) => {
    let proTxHash;
    try { proTxHash = normalizeProTxHash(node.proTxHash); } catch { return []; }
    if (seen.has(proTxHash)) return [];
    seen.add(proTxHash);
    return [{ proTxHash, label: String(node.label || '').replace(/[\r\n]/g, ' ').slice(0, 80) }];
  });
}

export function verifiedNodePreview(context, capabilities, proTxHash) {
  if (!context?.node || context.node.proTxHash?.toLowerCase() !== proTxHash ||
      context.chain?.genesisHash?.toLowerCase() !== capabilities.chain.genesisHash.toLowerCase() ||
      context.chain?.era !== capabilities.chain.era) {
    throw Object.assign(new Error('Node response does not match the selected network.'), { code: 'network_mismatch' });
  }
  return {
    service: typeof context.node.service === 'string' ? context.node.service : '',
    nevmAddress: typeof context.node.nevmAddress === 'string' ? context.node.nevmAddress : '',
  };
}

export function nodeImportError(error) {
  if (error?.status === 429 || error?.code === 'too_many_sentry_requests') return 'Request limit reached. Wait before retrying only the failed rows.';
  if (error?.status === 401 || error?.code === 'unauthorized') return 'Your session expired. Sign in again before importing nodes.';
  if (error?.code === 'network_mismatch') return 'The node response does not match this network. Nothing was imported.';
  if (error?.code === 'node_not_found' || error?.status === 404) return 'No registered node was found on this network. Check its public ProTx ID.';
  if (error?.code === 'node_not_confirmed') return 'The registration is not confirmed yet. Retry after it confirms.';
  return 'Could not verify this node. Check your connection and retry this row.';
}
