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
  const wallet = jest.fn().mockResolvedValue({ psbt: 'signed' });
  expect(await createSentryService({}, wallet).signFees({ psbt: 'unsigned' })).toBe('signed');
  expect(wallet).toHaveBeenCalledWith('sys_sign', [{ psbt: 'unsigned' }]);
});
test('linking a node uses the selected wallet network and never supplies secrets or a URL', async () => {
  const wallet = jest.fn().mockResolvedValue({ linked: true });
  await createSentryService({}, wallet).linkNode('aa'.repeat(32), 'bb'.repeat(32));
  expect(wallet.mock.calls).toEqual([['sys_requestAccounts'], ['sys_linkSentryNode', [{ version: 1, proTxHash: 'aa'.repeat(32), genesisHash: 'bb'.repeat(32) }]]]);
});
