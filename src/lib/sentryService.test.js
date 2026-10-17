import { createSentryService, serviceChanges, normalizeProTxHash } from './sentryService';
test('NEVM omission preserves registration, blank set is not implicit removal', () => {
  expect(serviceChanges({ nevmMode: 'keep', serviceMode: 'set', service: '1.2.3.4:8369' })).toEqual({ service: '1.2.3.4:8369' });
  expect(serviceChanges({ nevmMode: 'remove' })).toEqual({ nevmAddress: '' });
  expect(() => serviceChanges({ nevmMode: 'set', nevmAddress: '' })).toThrow(/NEVM/);
  expect(() => serviceChanges({ nevmMode: 'set', nevmAddress: `0x${'0'.repeat(40)}` })).toThrow(/Remove/);
});
test('normalizes only valid ProTx identities', () => {
  expect(normalizeProTxHash(` ${'AB'.repeat(32)} `)).toBe('ab'.repeat(32));
  expect(() => normalizeProTxHash('https://rpc.example')).toThrow();
});
test('wallet requests never import keys or send secret material to Sysnode', async () => {
  const wallet = jest.fn(async (method) => ({ sys_getPublicKey: 'vpub123', sys_getChangeAddress: 'tsys123', sys_requestAccounts: ['tsys123'] }[method]));
  const service = createSentryService({}, wallet);
  expect(await service.fundingIdentity()).toEqual({ xpub: 'vpub123', changeAddress: 'tsys123' });
  expect(wallet.mock.calls.map(([method]) => method)).toEqual(['sys_requestAccounts', 'sys_getPublicKey', 'sys_getChangeAddress']);
});
test('fee approval signs but never broadcasts in the wallet', async () => {
  const wallet = jest.fn().mockResolvedValueOnce({ feeSigning: 'same-origin-authorized-psbt-v1' }).mockResolvedValueOnce({ psbt: 'signed' });
  expect(await createSentryService({}, wallet).signFees({ psbt: 'unsigned' })).toBe('signed');
  expect(wallet).toHaveBeenCalledWith('sys_sign', [{ psbt: 'unsigned' }]);
  expect(wallet.mock.calls.map(([method]) => method)).toEqual(['sys_getSentryCapabilities', 'sys_sign']);
});
test.each([undefined, false, 'separate-after-operator-authorization'])('fee signing refuses an older wallet before requesting its signature: %p', async (feeSigning) => {
  const wallet = jest.fn().mockResolvedValue({ feeSigning });
  await expect(createSentryService({}, wallet).signFees({ psbt: 'unsigned' })).rejects.toThrow('Update Pali before preparing or signing a Sentry transaction');
  expect(wallet.mock.calls).toEqual([['sys_getSentryCapabilities']]);
});
test('linking a node uses the selected wallet network and never supplies secrets or a URL', async () => {
  const wallet = jest.fn().mockResolvedValue({ linked: true });
  await createSentryService({}, wallet).linkNode('aa'.repeat(32), 'bb'.repeat(32));
  expect(wallet.mock.calls).toEqual([['sys_requestAccounts'], ['sys_linkSentryNode', [{ version: 1, proTxHash: 'aa'.repeat(32), genesisHash: 'bb'.repeat(32) }]]]);
});
test('typed voting uses the fixed context endpoint and only explicit wallet methods', async () => {
  const wallet = jest.fn().mockResolvedValue({});
  const client = { get: jest.fn().mockResolvedValue({ data: { nodes: [] } }) };
  const service = createSentryService(client, wallet);
  const request = { version: 1, proposalHash: 'aa'.repeat(32), nodes: [] };
  await service.votingContext('testnet', request.proposalHash, ['bb'.repeat(32)]);
  await service.connectWallet(); await service.signVote(request);
  expect(client.get).toHaveBeenCalledWith('/api/sentry/v1/voting-context', { params: { network: 'testnet', proposalHash: request.proposalHash, proTxHashes: 'bb'.repeat(32) } });
  expect(wallet.mock.calls).toEqual([['sys_requestAccounts'], ['sys_signSentryVote', [request]]]);
});
