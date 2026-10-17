import { NODE_IMPORT_LIMIT, nodeImportError, parseNodeImport, publicVotingNodes, verifiedNodePreview } from './nodeImport';

const hash = 'a'.repeat(64);
const other = 'b'.repeat(64);
test('public import normalizes hashes, preserves labels and identifies invalid, duplicate and watched lines', () => {
  const { rows } = parseNodeImport(`\n${hash.toUpperCase()}, First node\r\nnot-a-public-id\n${hash},duplicate\n${other}, Do not overwrite\n`, 'testnet', [{ network: 'testnet', proTxHash: other, label: 'Existing label' }]);
  expect(rows.map((row) => row.status)).toEqual(['valid', 'invalid', 'duplicate', 'existing']);
  expect(rows[0]).toMatchObject({ lineNo: 2, proTxHash: hash, label: 'First node' });
  expect(rows[1]).not.toHaveProperty('proTxHash');
  expect(rows[3].message).toMatch(/existing label will be kept/);
  expect(parseNodeImport(other, 'mainnet', [{ network: 'testnet', proTxHash: other }]).rows[0].status).toBe('valid');
});
test('all excess rows are reported rather than silently dropped', () => {
  const input = Array.from({ length: NODE_IMPORT_LIMIT + 3 }, (_, i) => i.toString(16).padStart(64, '0')).join('\n');
  const result = parseNodeImport(input, 'testnet');
  expect(result.overLimit).toBe(true);
  expect(result.rows).toHaveLength(23);
  expect(result.rows.slice(20).every((row) => row.status === 'limit')).toBe(true);
});
test('private-like malformed input and invalid labels never enter request projections', () => {
  const result = parseNodeImport(`wpkh(private-secret)\n${hash},${'x'.repeat(81)}\n${other},bad\u0001label`, 'testnet');
  expect(result.rows.every((row) => row.status === 'invalid')).toBe(true);
  expect(JSON.stringify(result.rows)).not.toContain('private-secret');
});
test('voting discovery exports only public node ids and labels, never custody material', () => {
  expect(publicVotingNodes([{ proTxHash: hash, label: 'My node', wif: 'secret', keyId: 'secret-id', address: 'address' }, { proTxHash: hash }, { proTxHash: 'invalid', wif: 'secret' }])).toEqual([{ proTxHash: hash, label: 'My node' }]);
});
test('private-key-shaped labels are never previewed or exported as public metadata', () => {
  const wif = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn';
  for (const secret of [wif, '12'.repeat(32), `0x${'ab'.repeat(32)}`]) {
    const rows = parseNodeImport(`${hash}, Node ${secret}`, 'testnet').rows;
    expect(rows[0].status).toBe('invalid');
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(publicVotingNodes([{ proTxHash: hash, label: secret, wif: secret }])).toEqual([{ proTxHash: hash, label: '' }]);
    expect(publicVotingNodes([{ proTxHash: hash, label: `${'Node '.repeat(12)}${secret}`, wif: secret }])).toEqual([{ proTxHash: hash, label: '' }]);
  }
});
test('verified context binds exact node, network and protocol', () => {
  const capabilities = { chain: { genesisHash: other, era: 'legacy-v3' } };
  const context = { chain: capabilities.chain, node: { proTxHash: hash, service: '1.2.3.4:18369', nevmAddress: '', wif: 'secret' } };
  expect(verifiedNodePreview(context, capabilities, hash)).toEqual({ service: '1.2.3.4:18369', nevmAddress: '' });
  for (const changed of [{ ...context, chain: { ...context.chain, genesisHash: hash } }, { ...context, node: { ...context.node, proTxHash: other } }, { ...context, chain: { ...context.chain, era: 'pq-v4' } }]) {
    expect(() => verifiedNodePreview(changed, capabilities, hash)).toThrow(/network/);
  }
  expect(nodeImportError({ status: 429 })).toMatch(/only the failed rows/);
});
