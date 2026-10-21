import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import useNetworkData from './useNetworkData';
import { fetchNetworkStats, fetchNodeHistory } from '../lib/api';
import { coldNetworkStats, validNetworkStats } from '../testFixtures/networkStats';
jest.mock('../lib/api', () => ({ fetchNetworkStats: jest.fn(), fetchNodeHistory: jest.fn() }));
function Probe() {
  const data = useNetworkData();
  return <pre data-testid="state">{JSON.stringify(data)}</pre>;
}
const state = () => JSON.parse(screen.getByTestId('state').textContent);
beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
async function settle() {
  await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
}
function hidden(value) {
  Object.defineProperty(document, 'hidden', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}

test('history succeeds independently while current statistics fail', async () => {
  fetchNetworkStats.mockRejectedValue(new Error('503'));
  fetchNodeHistory.mockResolvedValue([{ date: '2026-10-21', users: 3123 }]);
  render(<Probe />);
  await waitFor(() => expect(state().loading).toBe(false));
  expect(state().history).toHaveLength(1);
  expect(state().stats).toBeNull();
  expect(state().error).toMatch(/unavailable/);
  expect(state().loadedAt).toBeNull();
});

test('history displays before a slow statistics response', async () => {
  let finish;
  fetchNetworkStats.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  fetchNodeHistory.mockResolvedValue([{ date: '2026-10-21', users: 3123 }]);
  render(<Probe />);
  await waitFor(() => expect(state().history).toHaveLength(1));
  expect(state().statsLoading).toBe(true);
  await act(async () => finish(validNetworkStats()));
  expect(state().loading).toBe(false);
});

test('a successful HTTP response with cold defaults is unavailable, not fresh', async () => {
  fetchNetworkStats.mockResolvedValue(coldNetworkStats);
  fetchNodeHistory.mockResolvedValue([]);
  render(<Probe />);
  await waitFor(() => expect(state().loading).toBe(false));
  expect(state().stats).toBeNull();
  expect(state().loadedAt).toBeNull();
  expect(state().error).toMatch(/unavailable/);
});

test('history failure does not discard a valid current snapshot', async () => {
  fetchNetworkStats.mockResolvedValue(validNetworkStats());
  fetchNodeHistory.mockRejectedValue(new Error('503'));
  render(<Probe />);
  await waitFor(() => expect(state().loading).toBe(false));
  expect(state().stats.stats.mn_stats.enabled).toBe('3,000');
  expect(state().error).toBe('');
  expect(state().historyError).toMatch(/unavailable/);
});

test('a later refresh failure preserves known values as stale without advancing their timestamp', async () => {
  jest.useFakeTimers();
  const now = Date.now();
  fetchNetworkStats.mockResolvedValueOnce(validNetworkStats(now)).mockRejectedValue(new Error('503'));
  fetchNodeHistory.mockResolvedValueOnce([{ date: '2026-10-21', users: 3123 }]).mockRejectedValue(new Error('503'));
  render(<Probe />);
  await settle();
  expect(state().loadedAt).toBe(new Date(now).toISOString());
  await act(async () => jest.advanceTimersByTime(60000));
  await settle();
  expect(state().stats.stats.mn_stats.enabled).toBe('3,000');
  expect(state().groups.node.status).toBe('stale');
  expect(state().loadedAt).toBe(new Date(now).toISOString());
  expect(state().history).toHaveLength(1);
  expect(state().error).toMatch(/last known/);
});

test('a long-open page ages a repeated source snapshot to stale', async () => {
  jest.useFakeTimers();
  const now = Date.now();
  fetchNetworkStats.mockResolvedValue(validNetworkStats(now));
  fetchNodeHistory.mockResolvedValue([]);
  render(<Probe />);
  await settle();
  for (let i = 0; i < 3; i += 1) {
    await act(async () => jest.advanceTimersByTime(60000));
    await settle();
  }
  expect(state().groups.node.status).toBe('stale');
  expect(state().loadedAt).toBe(new Date(now).toISOString());
});

test('hidden tabs pause polling and visibility resumes with a catch-up read', async () => {
  jest.useFakeTimers();
  fetchNetworkStats.mockResolvedValue(validNetworkStats());
  fetchNodeHistory.mockResolvedValue([]);
  render(<Probe />);
  await settle();
  act(() => hidden(true));
  await act(async () => jest.advanceTimersByTime(180000));
  expect(fetchNetworkStats).toHaveBeenCalledTimes(1);
  act(() => hidden(false));
  await settle();
  expect(fetchNetworkStats).toHaveBeenCalledTimes(2);
});

test('a superseded initial response cannot replace the newer visibility refresh', async () => {
  let oldStats;
  let oldHistory;
  fetchNetworkStats.mockReturnValueOnce(new Promise((resolve) => { oldStats = resolve; }))
    .mockResolvedValue(validNetworkStats());
  fetchNodeHistory.mockReturnValueOnce(new Promise((resolve) => { oldHistory = resolve; }))
    .mockResolvedValue([{ date: '2026-10-21', users: 3123 }]);
  render(<Probe />);
  act(() => { hidden(true); hidden(false); });
  await settle();
  await act(async () => { oldStats(coldNetworkStats); oldHistory([]); });
  expect(state().stats.stats.mn_stats.enabled).toBe('3,000');
  expect(state().history).toHaveLength(1);
});
