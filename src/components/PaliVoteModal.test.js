import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PaliVoteModal from './PaliVoteModal';
import { votingFixture, hash } from '../testUtils/paliVoting';

let mockAuth;
jest.mock('../context/AuthContext', () => ({ useAuth: () => mockAuth }));
beforeEach(() => { mockAuth = { user: { id: 1 }, isAuthenticated: true }; delete window.pali; });
function setup(overrides = {}, configure) {
  const fixture = votingFixture();
  const service = {
    capabilities: jest.fn().mockResolvedValue(fixture.capabilities),
    nodes: jest.fn().mockResolvedValue([{ network: 'testnet', proTxHash: hash, label: 'My node' }]),
    connectWallet: jest.fn().mockResolvedValue(['tsys1fixture']),
    walletCapabilities: jest.fn().mockResolvedValue({ governanceVote: { scheme: 'secp256k1', signal: 'funding', maxNodes: 20 } }),
    votingContext: jest.fn().mockResolvedValue(fixture.context),
    signVote: jest.fn().mockResolvedValue(fixture.response),
  };
  const votesService = { submitVote: jest.fn().mockResolvedValue({ results: [{ collateralHash: fixture.vector.collateralHash, collateralIndex: fixture.vector.collateralIndex, ok: true }] }), reconcileReceipts: jest.fn().mockResolvedValue({ receipts: [], reconciled: true }) };
  configure?.(service, votesService);
  const props = { proposal: { Key: fixture.request.proposalHash, name: 'Funding' }, service, votesService, onClose: jest.fn(), onBack: jest.fn(), ...overrides };
  const view = render(<MemoryRouter><PaliVoteModal {...props} /></MemoryRouter>);
  return { ...view, props, service, votesService, fixture };
}
async function approve() {
  const button = await screen.findByRole('button', { name: 'Review 1 yes vote in Pali' });
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
}
test('reviews exactly selected public nodes and relays verified signatures without private key fields', async () => {
  const { service, votesService, fixture } = setup();
  expect(service.connectWallet).not.toHaveBeenCalled();
  await approve();
  await screen.findByText(/1 of 1 relayed/);
  expect(service.votingContext).toHaveBeenCalledWith('testnet', fixture.request.proposalHash, [hash]);
  expect(service.signVote).toHaveBeenCalledWith(fixture.request);
  expect(votesService.submitVote).toHaveBeenCalledWith({ proposalHash: fixture.request.proposalHash, voteOutcome: 'yes', voteSignal: 'funding', time: fixture.request.timestamp, entries: [{ collateralHash: fixture.vector.collateralHash, collateralIndex: 0, voteSig: fixture.vector.voteSig }] });
  expect(screen.getByText('Relayed; confirmation pending.')).toBeInTheDocument();
});
test('unknown submission requires a status check and retries identical signed bytes without another Pali approval', async () => {
  const { service, votesService } = setup(); votesService.submitVote.mockRejectedValueOnce({ code: 'network_error' });
  await approve(); await screen.findByText(/Submission status is uncertain/);
  expect(screen.queryByRole('button', { name: /Retry .*failed/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  const retry = await screen.findByRole('button', { name: 'Retry 1 failed vote' }); fireEvent.click(retry);
  await screen.findByText(/1 of 1 relayed/);
  expect(service.signVote).toHaveBeenCalledTimes(1);
  expect(votesService.submitVote).toHaveBeenCalledTimes(2);
  expect(votesService.submitVote.mock.calls[1][0]).toEqual(votesService.submitVote.mock.calls[0][0]);
});
test('status check recognizes only the matching signed timestamp and outcome', async () => {
  const { fixture, votesService } = setup(); votesService.submitVote.mockRejectedValueOnce({ code: 'network_error' });
  votesService.reconcileReceipts.mockResolvedValue({ reconciled: true, receipts: [{ collateralHash: fixture.vector.collateralHash, collateralIndex: 0, proposalHash: fixture.request.proposalHash, voteTime: fixture.request.timestamp - 1, voteOutcome: 'yes', status: 'confirmed' }] });
  await approve(); await screen.findByText(/Submission status is uncertain/); fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  await screen.findByRole('button', { name: 'Retry 1 failed vote' });
  expect(screen.getByText(/0 of 1 relayed/)).toBeInTheDocument();
});
test.each(['wrong signature', 'missing key', 'wrong network', 'unsupported wallet'])('%s never reaches the vote relay', async (reason) => {
  const { service, votesService, fixture } = setup();
  if (reason === 'wrong signature') service.signVote.mockResolvedValue({ ...fixture.response, timestamp: fixture.request.timestamp + 1 });
  if (reason === 'missing key') service.signVote.mockRejectedValue({ code: 'KEY_MISMATCH' });
  if (reason === 'wrong network') service.votingContext.mockResolvedValue({ ...fixture.context, chain: { ...fixture.context.chain, genesisHash: 'd'.repeat(64) } });
  if (reason === 'unsupported wallet') service.walletCapabilities.mockResolvedValue({});
  await approve(); await screen.findByRole('alert');
  expect(votesService.submitVote).not.toHaveBeenCalled();
  if (reason !== 'wrong signature' && reason !== 'missing key') expect(service.signVote).not.toHaveBeenCalled();
});
test.each(['account', 'provider', 'unmount'])('%s change prevents stale Pali signatures being relayed', async (change) => {
  const listeners = {}; window.pali = { request: jest.fn(), on: jest.fn((name, fn) => { listeners[name] = fn; }), removeListener: jest.fn() };
  const { service, votesService, fixture, props, rerender, unmount } = setup();
  let finish; service.signVote.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await approve(); await waitFor(() => expect(service.signVote).toHaveBeenCalled());
  if (change === 'account') { mockAuth = { user: { id: 2 }, isAuthenticated: true }; rerender(<MemoryRouter><PaliVoteModal {...props} /></MemoryRouter>); }
  if (change === 'provider') act(() => listeners.accountsChanged());
  if (change === 'unmount') unmount();
  await act(async () => { finish(fixture.response); });
  expect(votesService.submitVote).not.toHaveBeenCalled();
});
test('PQ capabilities remain gated with no legacy fallback', async () => {
  const { service } = setup({}, (s) => s.capabilities.mockResolvedValue({ version: 1, network: 'testnet', chain: { genesisHash: 'c'.repeat(64), era: 'pq-v4' } }));
  await screen.findByText(/Pali voting is not enabled for the PQ protocol/);
  expect(service.connectWallet).not.toHaveBeenCalled();
});
test('empty watch lists direct the user to public import', async () => {
  setup({}, (s) => s.nodes.mockResolvedValue([]));
  await screen.findByRole('link', { name: 'Import public node IDs' });
  expect(screen.queryByRole('button', { name: /Review .*in Pali/ })).toBeNull();
});
test('an unavailable reconciliation cannot turn missing receipts into a safe retry', async () => {
  const { votesService } = setup(); votesService.submitVote.mockRejectedValueOnce({ code: 'network_error' });
  votesService.reconcileReceipts.mockResolvedValue({ receipts: [], reconciled: false });
  await approve(); await screen.findByText(/Submission status is uncertain/);
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  await screen.findByText(/Status could not be checked yet/);
  expect(screen.queryByRole('button', { name: /Retry .*failed/ })).toBeNull();
  expect(votesService.submitVote).toHaveBeenCalledTimes(1);
});
test('confirmed receipts are labelled confirmed, not pending', async () => {
  const { fixture, votesService } = setup();
  votesService.reconcileReceipts.mockResolvedValue({ reconciled: true, receipts: [{ collateralHash: fixture.vector.collateralHash, collateralIndex: 0, proposalHash: fixture.request.proposalHash, voteTime: fixture.request.timestamp, voteOutcome: 'yes', status: 'confirmed' }] });
  await approve(); await screen.findByText(/1 of 1 relayed/);
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  await screen.findByText('Confirmed on-chain.');
  expect(screen.queryByText('Relayed; confirmation pending.')).toBeNull();
});
test('Pali missing-key sentinel explains the custody requirement without exposing key inventory', async () => {
  const { service, votesService } = setup();
  service.signVote.mockRejectedValue({ code: '-32603', message: `SENTRY_VOTING_KEY_MISSING: Import the matching voting keys for these nodes: ${hash}` });
  await approve();
  await screen.findByText(/Pali does not hold every selected node’s voting key/);
  expect(votesService.submitVote).not.toHaveBeenCalled();
});
