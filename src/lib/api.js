import axios from 'axios';
import {
  getMockGovernanceFeed,
  getMockNetworkStats,
  getMockNodeHistory,
  MOCK_API_LATENCY_MS,
} from '../data/mockApi';

// Base URL for the anonymous public sysnode-backend endpoints
// (`/mnstats`, `/mncount`, `/govlist`). Kept in lockstep with the
// authenticated client in `./apiClient.js` so a single build-time
// override (`REACT_APP_API_BASE`) retargets BOTH surfaces at once.
//
// Why this matters for governance: the proposal wizard now gates
// `Prepare` on `fetchNetworkStats().superblock_stats.superblock_next_epoch_sec`,
// so a hardcoded mainnet URL here means any non-default deployment
// (local dev, self-hosted backend, testnet/regtest) either pulls
// the wrong network's superblock cadence or fails CORS entirely —
// which permanently disables Prepare because `isAnchorLive` never
// flips true. Codex PR20 round 7 P1.
//
// Priority (mirrors apiClient.js):
//   1. Production builds → same-origin relative paths. The deployment
//      reverse-proxies these anonymous endpoints next to the SPA.
//   2. Non-production REACT_APP_API_BASE override for local/bespoke testing.
//   3. Development builds → http://localhost:3001 (backend dev server)
const DEFAULT_BASE =
  (process.env.NODE_ENV === 'production'
    ? ''
    : process.env.REACT_APP_API_BASE || 'http://localhost:3001');

const USE_MOCK_DATA = /^(1|true|yes)$/i.test(
  process.env.REACT_APP_USE_MOCK_DATA || ''
);

const client = axios.create({
  baseURL: DEFAULT_BASE,
  headers: {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
  },
  timeout: 15000,
});

function respondWithMockData(factory) {
  return new Promise(function resolveMock(resolve) {
    globalThis.setTimeout(function sendMockData() {
      resolve(factory());
    }, MOCK_API_LATENCY_MS);
  });
}

export async function fetchNetworkStats() {
  if (USE_MOCK_DATA) {
    return respondWithMockData(getMockNetworkStats);
  }

  const response = await client.get('/mnstats');
  return response.data;
}

export async function fetchNodeHistory() {
  if (USE_MOCK_DATA) {
    return respondWithMockData(getMockNodeHistory);
  }

  const response = await client.get('/mncount');
  return response.data;
}

export async function fetchGovernanceFeed() {
  if (USE_MOCK_DATA) {
    return respondWithMockData(getMockGovernanceFeed);
  }

  const response = await client.post('/govlist', []);
  return response.data;
}
