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
