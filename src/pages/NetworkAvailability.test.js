import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Home from './Home';
import Network from './Network';
import { fetchNetworkStats, fetchNodeHistory } from '../lib/api';
import { coldNetworkStats, validNetworkStats } from '../testFixtures/networkStats';
jest.mock('../lib/api', () => ({ fetchNetworkStats: jest.fn(), fetchNodeHistory: jest.fn() }));
jest.mock('../components/TrendChart', () => ({ historyData }) => <div>History observations: {historyData.length}</div>);
jest.mock('../components/BreakdownChart', () => () => <div>Breakdown</div>);
jest.mock('../components/NetworkGraphic', () => () => <div />);
beforeEach(() => {
  jest.clearAllMocks();
  fetchNodeHistory.mockResolvedValue([{ date: '2026-10-21', users: 3123 }]);
});

test.each([Home, Network])('cold live fixture does not present defaults as real metrics in %p', async (Page) => {
  fetchNetworkStats.mockResolvedValue(coldNetworkStats);
  render(<MemoryRouter><Page /></MemoryRouter>);
  await screen.findByText('History observations: 1');
  expect(screen.getByText(/Live network statistics are unavailable/)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/Infinity|NaN|SB0|0\.00%/);
  expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
});

test.each([Home, Network])('market outage does not hide valid node metrics in %p', async (Page) => {
  const payload = validNetworkStats();
  payload.stats_meta.groups.market = { status: 'unavailable', updated_at: null };
  payload.stats.mn_stats.current_supply = null;
  payload.stats.mn_stats.coins_percent_locked = null;
  fetchNetworkStats.mockResolvedValue(payload);
  render(<MemoryRouter><Page /></MemoryRouter>);
  await waitFor(() => expect(screen.getAllByText('3,000').length).toBeGreaterThan(0));
  expect(screen.getByText('Market statistics are unavailable.')).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/Infinity|NaN/);
});

test('stale source is visibly marked with its original successful timestamp', async () => {
  fetchNetworkStats.mockResolvedValue(validNetworkStats(Date.now() - 300000));
  render(<MemoryRouter><Home /></MemoryRouter>);
  await screen.findByText(/Chain, Sentry node, Governance, Market statistics are stale\. Last successful update:/);
  expect(screen.getAllByText('3,000').length).toBeGreaterThan(0);
});

test.each([Home, Network])('market-only availability retains circulating supply in %p', async (Page) => {
  const payload = validNetworkStats();
  for (const name of ['chain', 'node', 'governance']) {
    payload.stats_meta.groups[name] = { status: 'unavailable', updated_at: null };
  }
  payload.stats.price_stats.price_usd = '0.00';
  payload.stats.price_stats.price_btc = '0.00000000';
  fetchNetworkStats.mockResolvedValue(payload);
  render(<MemoryRouter><Page /></MemoryRouter>);
  await screen.findByText('800,000,000 SYS');
  expect(document.body.textContent).toContain('$0.0000');
  if (Page === Network) expect(screen.getByText('0.00000000 BTC')).toBeInTheDocument();
});

test('valid core counts survive malformed optional chain display fields without a render crash', async () => {
  const payload = validNetworkStats();
  payload.stats.blockchain_stats.sub_version = { unexpected: true };
  payload.stats.blockchain_stats.protocol = Infinity;
  payload.stats.blockchain_stats.avg_block = { unexpected: true };
  payload.stats.blockchain_stats.genesis = { unexpected: true };
  payload.mapData = { USA: null, CAN: { masternodes: 'NaN' } };
  fetchNetworkStats.mockResolvedValue(payload);
  render(<MemoryRouter><Network /></MemoryRouter>);
  await waitFor(() => expect(screen.getAllByText('3,000').length).toBeGreaterThan(0));
  expect(document.body.textContent).not.toMatch(/Infinity|NaN|\[object Object\]/);
  expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(4);
});

test('technical version and protocol identifiers keep their ungrouped representation', async () => {
  fetchNetworkStats.mockResolvedValue(validNetworkStats());
  render(<MemoryRouter><Network /></MemoryRouter>);
  await screen.findByText('320000');
  expect(screen.getByText('70016')).toBeInTheDocument();
  expect(screen.queryByText('320,000')).not.toBeInTheDocument();
  expect(screen.queryByText('70,016')).not.toBeInTheDocument();
});

test('Home keeps market data and navigation without an empty exchange promotion', async () => {
  fetchNetworkStats.mockResolvedValue(validNetworkStats());
  render(<MemoryRouter><Home /></MemoryRouter>);
  await screen.findByText('800,000,000 SYS');
  expect(screen.getByText('Syscoin Market')).toBeInTheDocument();
  expect(screen.getByText('SYS Price')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View Proposals' })).toHaveAttribute('href', '/governance');
  expect(screen.queryByText(/Get your Syscoin|View all markets/)).not.toBeInTheDocument();
  expect(document.querySelector('.market-exchanges')).toBeNull();
  expect(document.querySelector('.panel--market')).toBeInTheDocument();
});
