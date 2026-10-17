import { apiClient } from './apiClient';
import { paliRequest } from './paliProvider';

const BASE = '/api/sentry/v1';
const HASH = /^[0-9a-f]{64}$/;
export const SENTRY_OPERATIONS = [
  { id: 'register', label: 'Register a node', role: 'Owner and collateral' },
  { id: 'updateService', label: 'Service, payout and NEVM address', role: 'Operator' },
  { id: 'updateRegistrar', label: 'Rotate operator or voting keys', role: 'Owner' },
  { id: 'revoke', label: 'Revoke operator', role: 'Operator' },
  { id: 'registerOperator', label: 'Enroll or recover PQ operator', role: 'Owner and new operator' },
  { id: 'rotateOperator', label: 'Rotate PQ operator', role: 'Current operator' },
];

function response(data) { return data.data; }
export function createSentryService(client = apiClient, walletRequest = paliRequest) {
  return {
    capabilities: () => client.get(`${BASE}/capabilities`).then(response),
    nodes: () => client.get(`${BASE}/nodes`).then(response),
    operations: () => client.get(`${BASE}/operations`).then(response),
    context: (network, proTxHash) => client.get(`${BASE}/context`, { params: { network, proTxHash } }).then(response),
    votingContext: (network, proposalHash, proTxHashes) => client.get(`${BASE}/voting-context`, { params: { network, proposalHash, proTxHashes: proTxHashes.join(',') } }).then(response),
    watch: (node) => client.post(`${BASE}/nodes`, node).then(response),
    unwatch: (node) => client.delete(`${BASE}/nodes/${node.network}/${node.proTxHash}`).then(response),
    prepare: (body) => client.post(`${BASE}/operations`, body).then(response),
    authorize: (id, authorization) => client.post(`${BASE}/operations/${id}/authorize`, { authorization }).then(response),
    submit: (id, signedPsbt) => client.post(`${BASE}/operations/${id}/submit`, { signedPsbt }).then(response),
    retry: (id) => client.post(`${BASE}/operations/${id}/retry`, {}).then(response),
    reconcile: (id) => client.get(`${BASE}/operations/${id}`).then(response),
    async fundingIdentity() {
      await walletRequest('sys_requestAccounts');
      const [xpub, changeAddress] = await Promise.all([
        walletRequest('sys_getPublicKey'), walletRequest('sys_getChangeAddress'),
      ]);
      if (typeof xpub !== 'string' || typeof changeAddress !== 'string') throw new Error('Invalid wallet funding identity');
      return { xpub, changeAddress };
    },
    walletCapabilities: () => walletRequest('sys_getSentryCapabilities'),
    connectWallet: () => walletRequest('sys_requestAccounts'),
    signVote: (request) => walletRequest('sys_signSentryVote', [request]),
    signOperation: (request) => walletRequest('sys_signSentryOperation', [request]),
    async linkNode(proTxHash, genesisHash) {
      await walletRequest('sys_requestAccounts');
      return walletRequest('sys_linkSentryNode', [{ version: 1, proTxHash: normalizeProTxHash(proTxHash), genesisHash }]);
    },
    async signFees(psbt) {
      const result = await walletRequest('sys_sign', [psbt]);
      const signed = typeof result === 'string' ? result : result?.psbt;
      if (typeof signed !== 'string' || !signed.length) throw new Error('Pali returned no signed PSBT');
      return signed;
    },
  };
}
export const sentryService = createSentryService();
export function normalizeProTxHash(value) {
  const result = String(value || '').trim().toLowerCase();
  if (!HASH.test(result)) throw new Error('Enter the 64-character on-chain ProTx hash.');
  return result;
}
export function serviceChanges({ nevmMode, nevmAddress, serviceMode, service, payoutMode, payout }) {
  const changes = {};
  if (nevmMode === 'set') {
    const address = nevmAddress.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('NEVM address must be 0x followed by 40 hexadecimal characters.');
    if (/^0x0{40}$/i.test(address)) throw new Error('Use Remove registration instead of the zero address.');
    changes.nevmAddress = address.toLowerCase();
  } else if (nevmMode === 'remove') changes.nevmAddress = '';
  if (serviceMode === 'set') {
    if (!service.trim()) throw new Error('Enter the public IP and port.');
    changes.service = service.trim();
  }
  if (payoutMode === 'set') {
    if (!payout.trim()) throw new Error('Enter the operator payout address.');
    changes.operatorPayoutAddress = payout.trim();
  } else if (payoutMode === 'remove') changes.operatorPayoutAddress = '';
  if (!Object.keys(changes).length) throw new Error('Choose at least one field to update. Unchanged fields are preserved.');
  return changes;
}
