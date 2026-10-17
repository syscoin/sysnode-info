import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SentryManagement from './SentryManagement';
import { MemoryRouter } from 'react-router-dom';

const HASH = 'a'.repeat(64);
const node = { network: 'testnet', proTxHash: HASH, label: 'My test node' };
const current = { chain: { genesisHash: 'c'.repeat(64), era: 'legacy-v3' }, node: { proTxHash: HASH, operatorPublicKey: 'b'.repeat(96), service: '1.2.3.4:18369', nevmAddress: '' } };
function makeService() {
  const request = { version: 1, operation: 'updateService', chain: current.chain, transactionHex: 'abcd' };
  return {
    capabilities: jest.fn().mockResolvedValue({ version: 1, network: 'testnet', chain: current.chain, operations: ['updateService'] }),
    nodes: jest.fn().mockResolvedValue([node]), operations: jest.fn().mockResolvedValue([]),
    context: jest.fn().mockResolvedValue(current), watch: jest.fn().mockResolvedValue([node]),
    walletCapabilities: jest.fn().mockResolvedValue({ operations: ['updateService'] }),
    fundingIdentity: jest.fn().mockResolvedValue({ xpub: 'vpub', changeAddress: 'tsys' }),
    prepare: jest.fn().mockResolvedValue({ id: 'op1', prepared: { request, review: { changes: { nevmAddress: { previous: '', next: `0x${'12'.repeat(20)}` } }, feeSatoshis: '1000' } } }),
    signOperation: jest.fn().mockResolvedValue({ transactionHex: 'authorized' }),
    authorize: jest.fn().mockResolvedValue({ psbt: { psbt: 'unsigned' } }),
    signFees: jest.fn().mockResolvedValue('signed'),
    submit: jest.fn().mockResolvedValue({ id: 'op1', status: 'submitted', txid: 'f'.repeat(64) }),
    reconcile: jest.fn().mockResolvedValue({ id: 'op1', status: 'confirmed', txid: 'f'.repeat(64) }),
    retry: jest.fn().mockResolvedValue({ id: 'old', status: 'submitted', txid: 'f'.repeat(64) }),
    linkNode: jest.fn().mockResolvedValue({ version: 1, linked: true, genesisHash: current.chain.genesisHash, proTxHash: HASH }),
  };
}
async function editNEVM(service) {
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /My test node/ }));
  await screen.findByLabelText('NEVM address');
  fireEvent.change(screen.getByLabelText('NEVM address'), { target: { value: 'set' } });
  fireEvent.change(screen.getByLabelText('New NEVM address'), { target: { value: `0x${'12'.repeat(20)}` } });
}
test('two local approvals precede exactly one backend publication', async () => {
  const service = makeService(); await editNEVM(service);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare update' }));
  const sign = await screen.findByRole('button', { name: 'Review and sign in Pali' });
  expect(service.prepare).toHaveBeenCalledWith(expect.objectContaining({ changes: { nevmAddress: `0x${'12'.repeat(20)}` } }));
  fireEvent.click(sign); fireEvent.click(sign);
  await waitFor(() => expect(service.submit).toHaveBeenCalledTimes(1));
  expect(service.signOperation).toHaveBeenCalledTimes(1);
  expect(service.authorize).toHaveBeenCalledWith('op1', { transactionHex: 'authorized' });
  expect(service.signFees).toHaveBeenCalledWith({ psbt: 'unsigned' });
});
test('rejected operator approval never signs fees or broadcasts', async () => {
  const service = makeService(); service.signOperation.mockRejectedValue(new Error('User rejected'));
  await editNEVM(service); fireEvent.click(screen.getByRole('button', { name: 'Prepare update' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review and sign in Pali' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('User rejected');
  expect(service.signFees).not.toHaveBeenCalled(); expect(service.submit).not.toHaveBeenCalled();
});
test('operator-reset nodes explain service recovery before NEVM changes', async () => {
  const service = makeService();
  service.context.mockResolvedValue({ ...current, node: { ...current.node, service: '[::]:0', poseBanHeight: 10 } });
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /My test node/ }));
  expect(await screen.findByText('Not configured')).toBeVisible();
  expect(screen.getByText(/This node requires service recovery/)).toBeVisible();
});
test('linking uses exact node and genesis and does not sign or broadcast', async () => {
  const service = makeService(); await editNEVM(service);
  fireEvent.click(screen.getByRole('button', { name: 'Link node to Pali' }));
  await screen.findByText('Node linked in Pali. This did not sign or broadcast a transaction.');
  expect(service.linkNode).toHaveBeenCalledWith(HASH, current.chain.genesisHash);
  expect(service.prepare).not.toHaveBeenCalled(); expect(service.signOperation).not.toHaveBeenCalled(); expect(service.submit).not.toHaveBeenCalled();
});
test('wallet context change during operator approval invalidates preparation', async () => {
  const handlers = {};
  window.pali = { request: jest.fn(), on: (event, callback) => { handlers[event] = callback; }, removeListener: jest.fn() };
  const service = makeService(); let resolve;
  service.signOperation.mockImplementation(() => new Promise((done) => { resolve = done; }));
  await editNEVM(service); fireEvent.click(screen.getByRole('button', { name: 'Prepare update' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review and sign in Pali' }));
  await act(async () => { handlers.accountsChanged([]); resolve({ transactionHex: 'authorized' }); });
  expect(service.authorize).not.toHaveBeenCalled(); expect(service.submit).not.toHaveBeenCalled();
  delete window.pali;
});
test('unknown submission is reconciled from history without a second publication', async () => {
  const service = makeService();
  service.operations.mockResolvedValue([{ id: 'old', status: 'submission_unknown', network: 'testnet', txid: 'f'.repeat(64) }]);
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Check status' }));
  await waitFor(() => expect(service.reconcile).toHaveBeenCalledWith('old'));
  expect(service.submit).not.toHaveBeenCalled(); expect(service.signOperation).not.toHaveBeenCalled();
});
test('manual retry uses the original journal without a new wallet signature', async () => {
  const service = makeService();
  service.operations.mockResolvedValue([{ id: 'old', status: 'submission_unknown', network: 'testnet', txid: 'f'.repeat(64) }]);
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry identical transaction' }));
  await screen.findByText('The original transaction was found or republished. No new transaction or wallet signature was created.');
  expect(service.retry).toHaveBeenCalledWith('old');
  expect(service.submit).not.toHaveBeenCalled();
  expect(service.signOperation).not.toHaveBeenCalled();
  expect(service.signFees).not.toHaveBeenCalled();
});
test('registration collects public fields only and completes multiple approvals before fees', async () => {
  const service = makeService();
  service.capabilities.mockResolvedValue({ version: 1, network: 'testnet', chain: current.chain, operations: ['register', 'updateService'] });
  service.walletCapabilities.mockResolvedValue({ operations: ['register'] });
  service.prepare.mockResolvedValue({ id: 'registration', network: 'testnet', prepared: { request: { version: 1, operation: 'register', transactionHex: 'unsigned' }, review: { fields: { service: '1.2.3.4:18369' }, feeSatoshis: '10', authorizations: [{ id: 'collateral', role: 'collateral', scheme: 'secp256k1' }, { id: 'newOwner', role: 'owner', scheme: 'slh-dsa-shake-128s' }] } } });
  service.signOperation.mockResolvedValueOnce({ complete: false, transactionHex: 'partly-signed' }).mockResolvedValueOnce({ complete: true, transactionHex: 'fully-authorized' });
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  await screen.findByRole('button', { name: /My test node/ });
  fireEvent.click(screen.getByText('Registration and authority management'));
  for (const [labelText, value] of [['Collateral transaction ID', HASH], ['Collateral output index', '0'], ['Public service IP and port', '1.2.3.4:18369'], ['Owner address (separate from collateral)', 'owner-address'], ['Voting address (separate from collateral)', 'voting-address'], ['Payout address', 'payout-address'], ['Operator BLS public key', 'f'.repeat(96)]]) {
    fireEvent.change(screen.getByLabelText(labelText), { target: { value } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Prepare operation' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review and sign in Pali' }));
  await waitFor(() => expect(service.submit).toHaveBeenCalledTimes(1));
  expect(service.prepare).toHaveBeenCalledWith(expect.objectContaining({ operation: 'register', collateralOutpoint: { txid: HASH, vout: 0 } }));
  expect(service.signOperation).toHaveBeenCalledTimes(2);
  expect(service.signOperation.mock.calls[1][0].transactionHex).toBe('partly-signed');
  expect(service.signFees).toHaveBeenCalledTimes(1);
});

async function editRevocation(service) {
  service.capabilities.mockResolvedValue({ version: 1, network: 'testnet', chain: current.chain, operations: ['revoke'] });
  service.walletCapabilities.mockResolvedValue({ operations: ['revoke'] });
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /My test node/ }));
  await screen.findByRole('heading', { name: 'My test node' });
  fireEvent.click(screen.getByText('Registration and authority management'));
  fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'revoke' } });
  fireEvent.change(screen.getByLabelText('Revocation reason'), { target: { value: '1' } });
}

test('changing a revocation reason invalidates its prepared review', async () => {
  const service = makeService();
  await editRevocation(service);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare operation' }));
  await screen.findByRole('button', { name: 'Review and sign in Pali' });
  expect(service.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'revoke', changes: { reason: 1 } }));
  fireEvent.change(screen.getByLabelText('Revocation reason'), { target: { value: '2' } });
  expect(screen.queryByRole('button', { name: 'Review and sign in Pali' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare operation' }));
  await screen.findByRole('button', { name: 'Review and sign in Pali' });
  expect(service.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'revoke', changes: { reason: 2 } }));
  expect(service.signOperation).not.toHaveBeenCalled();
});

test('a stale preparation response cannot restore review after a revocation edit', async () => {
  const service = makeService();
  let resolve;
  const response = await service.prepare();
  service.prepare.mockImplementation(() => new Promise((done) => { resolve = done; }));
  await editRevocation(service);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare operation' }));
  await waitFor(() => expect(resolve).toBeDefined());
  // Assert the generation guard as well as the disabled-control UX: a
  // dispatched stale edit must never make an old response approvable.
  fireEvent.change(screen.getByLabelText('Revocation reason'), { target: { value: '2' } });
  await act(async () => resolve(response));
  expect(screen.queryByRole('button', { name: 'Review and sign in Pali' })).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('operation details changed');
  expect(service.signOperation).not.toHaveBeenCalled();
});

test('a history failure preserves capabilities and watched nodes and can be retried', async () => {
  const service = makeService();
  service.operations.mockRejectedValueOnce(new Error('History temporarily unavailable'));
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: /My test node/ })).toBeEnabled();
  expect(screen.getByText('testnet · Legacy BLS')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Add node' })).toBeEnabled();
  expect(await screen.findByRole('alert')).toHaveTextContent('History temporarily unavailable');
  service.operations.mockResolvedValue([{ id: 'restored', status: 'submission_unknown', network: 'testnet' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
  expect(await screen.findByRole('button', { name: 'Check status' })).toBeEnabled();
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});

test('a watch-list failure does not hide a recoverable operation history', async () => {
  const service = makeService();
  service.nodes.mockRejectedValue(new Error('Watch list temporarily unavailable'));
  service.operations.mockResolvedValue([{ id: 'saved', status: 'submission_unknown', network: 'testnet' }]);
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: 'Retry identical transaction' })).toBeEnabled();
  expect(screen.getByText('testnet · Legacy BLS')).toBeVisible();
  expect(await screen.findByRole('alert')).toHaveTextContent('Watch list temporarily unavailable');
});

test('non-registration management uses the selected watch network, not the default network', async () => {
  const service = makeService();
  service.nodes.mockResolvedValue([{ ...node, network: 'mainnet' }]);
  await editRevocation(service);
  expect(service.context).toHaveBeenCalledWith('mainnet', HASH);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare operation' }));
  await screen.findByRole('button', { name: 'Review and sign in Pali' });
  expect(service.prepare).toHaveBeenCalledWith(expect.objectContaining({ operation: 'revoke', network: 'mainnet', proTxHash: HASH }));
});

test('slow capabilities never expose a legacy form and do not delay other resources', async () => {
  const service = makeService();
  let resolveCapabilities;
  service.capabilities.mockImplementation(() => new Promise((resolve) => { resolveCapabilities = resolve; }));
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  fireEvent.click(screen.getByText('Registration and authority management'));
  expect(screen.queryByLabelText('Operator BLS public key')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add node' })).toBeDisabled();
  expect(await screen.findByRole('button', { name: /My test node/ })).toBeEnabled();
  await act(async () => resolveCapabilities({ version: 1, network: 'testnet', chain: { ...current.chain, era: 'pq-v4' }, operations: ['register'] }));
  expect(screen.queryByLabelText('Operator BLS public key')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Owner PQ public key')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Prepare operation' })).toBeEnabled();
  expect(service.fundingIdentity).not.toHaveBeenCalled();
});

test.each([
  { version: 1, network: 'testnet', operations: ['register'] },
  { version: 1, network: 'testnet', chain: { ...current.chain, era: 'unknown-v5' }, operations: ['register'] },
])('malformed or unknown capabilities fail closed and recover on retry: %p', async (caps) => {
  const service = makeService();
  service.capabilities.mockResolvedValueOnce(caps);
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  fireEvent.click(screen.getByText('Registration and authority management'));
  expect(await screen.findByRole('alert')).toHaveTextContent('valid supported protocol');
  expect(screen.queryByLabelText('Operator BLS public key')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Prepare operation' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add node' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
  expect(await screen.findByLabelText('Operator BLS public key')).toHaveValue('');
  expect(service.fundingIdentity).not.toHaveBeenCalled();
});

test('retry clears protocol-specific draft fields and ignores an obsolete capabilities response', async () => {
  const service = makeService();
  let resolveOldCapabilities;
  service.capabilities.mockImplementationOnce(() => new Promise((resolve) => { resolveOldCapabilities = resolve; }));
  service.capabilities.mockResolvedValue({ version: 1, network: 'testnet', chain: { ...current.chain, era: 'pq-v4' }, operations: ['register'] });
  service.operations.mockRejectedValueOnce(new Error('Retry this history read'));
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  fireEvent.click(screen.getByText('Registration and authority management'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Retry this history read');
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
  expect(await screen.findByLabelText('Owner PQ public key')).toHaveValue('');
  await act(async () => resolveOldCapabilities({ version: 1, network: 'testnet', chain: current.chain, operations: ['register'] }));
  expect(screen.queryByLabelText('Operator BLS public key')).not.toBeInTheDocument();
  expect(screen.getByText('testnet · Post-quantum')).toBeVisible();
});

test('a capabilities retry never carries a legacy operator field into a PQ registration', async () => {
  const service = makeService();
  service.walletCapabilities.mockResolvedValue({ operations: ['register'] });
  service.capabilities.mockResolvedValue({ version: 1, network: 'testnet', chain: current.chain, operations: ['register'] });
  service.operations.mockRejectedValueOnce(new Error('Retry this history read'));
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  fireEvent.click(screen.getByText('Registration and authority management'));
  fireEvent.change(await screen.findByLabelText('Operator BLS public key'), { target: { value: 'b'.repeat(96) } });
  service.capabilities.mockResolvedValue({ version: 1, network: 'testnet', chain: { ...current.chain, era: 'pq-v4' }, operations: ['register'] });
  fireEvent.click(await screen.findByRole('button', { name: 'Retry loading' }));
  expect(await screen.findByLabelText('Owner PQ public key')).toHaveValue('');
  for (const [labelText, value] of [['Collateral transaction ID', HASH], ['Collateral output index', '0'], ['Public service IP and port', '1.2.3.4:18369'], ['Owner address (separate from collateral)', 'owner-address'], ['Voting address (separate from collateral)', 'voting-address'], ['Payout address', 'payout-address'], ['Owner PQ public key', 'c'.repeat(64)], ['Voting PQ public key', 'd'.repeat(64)]]) {
    fireEvent.change(screen.getByLabelText(labelText), { target: { value } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Prepare operation' }));
  await screen.findByRole('button', { name: 'Review and sign in Pali' });
  expect(service.prepare).toHaveBeenCalledWith(expect.objectContaining({ operation: 'register', changes: expect.objectContaining({ pqOwnerPublicKey: 'c'.repeat(64), pqVotingPublicKey: 'd'.repeat(64) }) }));
  expect(service.prepare.mock.calls[0][0].changes).not.toHaveProperty('operatorPublicKey');
});

test('late bootstrap history cannot overwrite a newer submitted operation', async () => {
  const service = makeService();
  let resolveHistory;
  service.operations.mockImplementationOnce(() => new Promise((resolve) => { resolveHistory = resolve; }));
  service.operations.mockResolvedValue([{ id: 'op1', status: 'submitted', network: 'testnet' }]);
  await editNEVM(service);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare update' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review and sign in Pali' }));
  await screen.findByText('submitted');
  await act(async () => resolveHistory([{ id: 'op1', status: 'prepared', network: 'testnet' }, { id: 'older', status: 'confirmed', network: 'testnet' }]));
  expect(screen.queryByRole('button', { name: 'Resume review' })).not.toBeInTheDocument();
  expect(screen.getByText('submitted')).toBeVisible();
  expect(screen.getByText('confirmed')).toBeVisible();
  expect(service.submit).toHaveBeenCalledTimes(1);
});

test('late bootstrap watches cannot erase a newly added node', async () => {
  const service = makeService();
  let resolveNodes;
  service.nodes.mockImplementationOnce(() => new Promise((resolve) => { resolveNodes = resolve; }));
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add node' })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('ProTx hash'), { target: { value: HASH } });
  fireEvent.click(screen.getByRole('button', { name: 'Add node' }));
  await screen.findByRole('button', { name: /My test node/ });
  await act(async () => resolveNodes([]));
  expect(screen.getByRole('button', { name: /My test node/ })).toBeVisible();
});

test('a saved review remains read-only when capabilities cannot be verified', async () => {
  const service = makeService();
  const saved = { id: 'saved', status: 'prepared', network: 'testnet', proTxHash: HASH, prepared: (await service.prepare()).prepared };
  service.capabilities.mockRejectedValue(new Error('Capabilities temporarily unavailable'));
  service.operations.mockResolvedValue([saved]);
  service.reconcile.mockResolvedValue(saved);
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Resume review' }));
  const sign = await screen.findByRole('button', { name: 'Review and sign in Pali' });
  expect(sign).toBeDisabled();
  fireEvent.click(sign);
  expect(service.signOperation).not.toHaveBeenCalled();
  expect(service.signFees).not.toHaveBeenCalled();
});

test.each([
  [{ code: 'history_temporarily_unavailable', status: 503 }, 'The service is temporarily unavailable. Try again.'],
  [{ code: 'network_error', status: 0 }, 'Could not connect to the service. Check your connection and try again.'],
  [{ code: 'unexpected_backend_code', status: 400 }, 'The request could not be completed. Try again.'],
])('bootstrap error copy is readable instead of exposing an API identifier: %p', async (error, copy) => {
  const service = makeService();
  service.operations.mockRejectedValue(error);
  render(<MemoryRouter><SentryManagement service={service} /></MemoryRouter>);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(copy);
  expect(alert).not.toHaveTextContent(error.code);
});
