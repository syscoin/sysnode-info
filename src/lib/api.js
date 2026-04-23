import axios from 'axios';

// Base URL for the anonymous public sysnode-backend endpoints
// (`/mnStats`, `/mnCount`, `/govlist`). Kept in lockstep with the
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
//   1. REACT_APP_API_BASE (build-time override for bespoke deployments)
//   2. Production builds → https://syscoin.dev (the default
//      hosted backend, same host the authenticated client picks up)
//   3. Development builds → http://localhost:3001 (backend dev server)
const DEFAULT_BASE =
  process.env.REACT_APP_API_BASE ||
  (process.env.NODE_ENV === 'production'
    ? 'https://syscoin.dev'
    : 'http://localhost:3001');

const client = axios.create({
  baseURL: DEFAULT_BASE,
  headers: {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
  },
  timeout: 15000,
});

export async function fetchNetworkStats() {
  const response = await client.get('/mnStats');
  return response.data;
}

export async function fetchNodeHistory() {
  const response = await client.get('/mnCount');
  return response.data;
}

export async function fetchGovernanceFeed() {
  const response = await client.post('/govlist', []);
  return response.data;
}
