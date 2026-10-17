import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import NodeImport from './NodeImport';

let mockAuth;
let mockVault;
let mockOwned;
jest.mock('../context/AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('../context/VaultContext', () => ({ useVault: () => mockVault }));
jest.mock('../hooks/useOwnedMasternodes', () => ({ useOwnedMasternodes: () => mockOwned }));
jest.mock('./VaultImportModal', () => ({ open, onClose }) => open ? <div role="dialog" aria-label="Existing encrypted voting import"><button onClick={onClose}>Complete voting import</button></div> : null);
jest.mock('./VaultStatusCard', () => () => <p>Existing vault unlock form</p>);
const hash = 'a'.repeat(64);
const other = 'b'.repeat(64);
const third = 'd'.repeat(64);
const capabilities = { network: 'testnet', chain: { genesisHash: 'c'.repeat(64), era: 'legacy-v3' } };
const context = (proTxHash) => ({ chain: capabilities.chain, node: { proTxHash, service: '1.2.3.4:18369', nevmAddress: '' } });
function setup(overrides = {}) {
  const service = { nodes: jest.fn().mockResolvedValue([]), context: jest.fn((network, id) => Promise.resolve(context(id))), watch: jest.fn((node) => Promise.resolve([node])) };
  const props = { capabilities, watched: [], service, onImported: jest.fn(), ...overrides };
  const view = render(<NodeImport {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Import nodes' }));
  return { ...view, props, service };
}
beforeEach(() => {
  mockAuth = { user: { id: 'user', email: 'test@example.invalid' }, isAuthenticated: true };
  mockVault = { isEmpty: true };
  mockOwned = { owned: [], isReady: false, refresh: jest.fn() };
});
async function check(text) {
  fireEvent.change(screen.getByLabelText('Public ProTx IDs, one per line'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Check node IDs' }));
  await screen.findByRole('button', { name: /Watch selected nodes \([1-9]/ });
}
test('verifies valid lines independently and imports only selected public fields', async () => {
  const { service } = setup();
  await check(`${hash}, first\ninvalid-secret\n${hash}, duplicate\n${other}, second`);
  expect(service.context).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Watch selected nodes (2)' })).toBeEnabled());
  fireEvent.click(screen.getByLabelText('Select line 4'));
  fireEvent.click(screen.getByRole('button', { name: 'Watch selected nodes (1)' }));
  await screen.findByText('Imported as a watch only. No signing authority was granted.');
  expect(service.watch).toHaveBeenCalledTimes(1);
  expect(service.watch).toHaveBeenCalledWith({ network: 'testnet', proTxHash: hash, label: 'first', preserveExisting: true });
  expect(screen.queryByText('invalid-secret')).toBeNull();
});
test('fresh duplicate detection never overwrites an existing watch label', async () => {
  const { service } = setup();
  service.nodes.mockResolvedValue([{ network: 'testnet', proTxHash: hash, label: 'Original' }]);
  fireEvent.change(screen.getByLabelText('Public ProTx IDs, one per line'), { target: { value: `${hash}, Replacement` } });
  fireEvent.click(screen.getByRole('button', { name: 'Check node IDs' }));
  await screen.findByText('Already watched');
  expect(service.context).not.toHaveBeenCalled(); expect(service.watch).not.toHaveBeenCalled();
});
test('a private-key-shaped label cannot be checked or sent to the backend', () => {
  const { service } = setup();
  fireEvent.change(screen.getByLabelText('Public ProTx IDs, one per line'), { target: { value: `${hash}, ${'12'.repeat(32)}` } });
  expect(screen.getByText('Use a short human-readable label, never a private key or WIF.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check node IDs' })).toBeDisabled();
  expect(service.context).not.toHaveBeenCalled(); expect(service.watch).not.toHaveBeenCalled();
});
test('partial lookup failures preserve successes and retry only failed lookups', async () => {
  const { service } = setup();
  service.context.mockImplementation((network, id) => id === other ? Promise.reject({ status: 503 }) : Promise.resolve(context(id)));
  await check(`${hash}\n${other}`);
  await screen.findByRole('button', { name: 'Retry failed lookups' });
  service.context.mockResolvedValue(context(other));
  fireEvent.click(screen.getByRole('button', { name: 'Retry failed lookups' }));
  await waitFor(() => expect(service.context).toHaveBeenCalledTimes(3));
  expect(service.context.mock.calls[2]).toEqual(['testnet', other]);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Watch selected nodes (2)' })).toBeEnabled());
});
test('partial watch failures retry only failed writes without reimporting successes', async () => {
  const { service } = setup();
  service.watch.mockImplementation((node) => node.proTxHash === other ? Promise.reject({ status: 503 }) : Promise.resolve([node]));
  await check(`${hash}\n${other}`);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Watch selected nodes (2)' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Watch selected nodes (2)' }));
  await screen.findByRole('button', { name: 'Retry failed imports' });
  service.watch.mockResolvedValue([]);
  fireEvent.click(screen.getByRole('button', { name: 'Retry failed imports' }));
  await waitFor(() => expect(service.watch).toHaveBeenCalledTimes(3));
  expect(service.watch.mock.calls[2][0].proTxHash).toBe(other);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry failed imports' })).toBeNull());
});
test('wrong-network responses can never become approvable', async () => {
  const { service } = setup();
  service.context.mockResolvedValue({ ...context(hash), chain: { ...capabilities.chain, genesisHash: third } });
  fireEvent.change(screen.getByLabelText('Public ProTx IDs, one per line'), { target: { value: hash } });
  fireEvent.click(screen.getByRole('button', { name: 'Check node IDs' }));
  await screen.findByText('The node response does not match this network. Nothing was imported.');
  expect(screen.getByRole('button', { name: 'Watch selected nodes (0)' })).toBeDisabled();
  expect(service.watch).not.toHaveBeenCalled();
});
test.each(['account', 'network', 'close'])('%s change invalidates pending responses and remaining requests', async (change) => {
  const { service, props, rerender } = setup(); let finish;
  service.context.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  fireEvent.change(screen.getByLabelText('Public ProTx IDs, one per line'), { target: { value: `${hash}\n${other}` } });
  fireEvent.click(screen.getByRole('button', { name: 'Check node IDs' }));
  await waitFor(() => expect(finish).toBeDefined());
  if (change === 'close') fireEvent.click(screen.getByRole('button', { name: 'Close import' }));
  else if (change === 'account') {
    mockAuth = { ...mockAuth, user: { ...mockAuth.user, id: 'other-user' } };
    rerender(<NodeImport {...props} />);
  } else rerender(<NodeImport {...props} capabilities={{ ...capabilities, network: 'mainnet', chain: { ...capabilities.chain, genesisHash: third } }} />);
  await act(async () => finish(context(hash)));
  expect(screen.queryByLabelText('Public ProTx IDs, one per line')).toBeNull();
  expect(service.context).toHaveBeenCalledTimes(1); expect(service.watch).not.toHaveBeenCalled();
});
test('all excess lines remain visible and prevent network requests', () => {
  const { service } = setup();
  fireEvent.change(screen.getByLabelText('Public ProTx IDs, one per line'), { target: { value: Array.from({ length: 22 }, (_, i) => i.toString(16).padStart(64, '0')).join('\n') } });
  expect(screen.getByText('Line 22')).toBeVisible();
  expect(screen.getAllByText('Over limit')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Check node IDs' })).toBeDisabled();
  expect(service.context).not.toHaveBeenCalled();
});
test('voting discovery reuses the encrypted importer and exports only public IDs', async () => {
  mockOwned = { ...mockOwned, isReady: true, owned: [{ proTxHash: hash, label: 'Voting one', wif: 'private-secret', keyId: 'private-id' }] };
  const { service } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Voting keys' }));
  fireEvent.click(screen.getByRole('button', { name: 'Import voting keys' }));
  expect(screen.getByRole('dialog', { name: 'Existing encrypted voting import' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Complete voting import' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review discovered nodes' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Watch selected nodes (1)' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Watch selected nodes (1)' }));
  await screen.findByText('Imported as a watch only. No signing authority was granted.');
  expect(service.watch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(service.watch.mock.calls)).not.toContain('private-secret');
  expect(screen.queryByText('private-secret')).toBeNull();
});
