// Per-network Syscoin consensus params the governance wizard needs.
//
// Prior versions hardcoded mainnet values (17520 / 1728 blocks,
// 150 s spacing) directly in governanceWindow.js. That broke every
// non-mainnet deployment — testnet's superblock cycle is 60 blocks
// (not 17520), so "1 month" on a testnet build meant
// 17520 * 150 = 2,628,000 s = ~30.4 days, which spans roughly 290
// testnet superblocks rather than one. A UI that claims "1 month"
// but pays out 290 times is a P1 correctness regression for anyone
// running a fork or private / testnet build. See Codex PR20 round
// 3 P1 ("Derive cadence from active network, not mainnet
// constant").
//
// Values mirror Syscoin Core's kernel/chainparams.cpp:
//
//   mainnet  : nSuperblockCycle = 17520, nSuperblockMaturityWindow = 1728,
//              nPowTargetSpacing = 150 s
//   testnet  : nSuperblockCycle = 60,    nSuperblockMaturityWindow = 20,
//              nPowTargetSpacing = 150 s
//   regtest  : nSuperblockCycle = 10,    nSuperblockMaturityWindow = 5,
//              nPowTargetSpacing = 150 s
//
// Any change to Core's chainparams must be mirrored here or the
// wizard's payout-window math will silently drift from what
// consensus enforces.
//
// The active network is selected by the build-time env var
// `REACT_APP_NETWORK`. Create-React-App substitutes REACT_APP_*
// vars into the bundle at build time, so setting this when
// producing a testnet/regtest build is symmetric with the existing
// REACT_APP_API_BASE override documented in the repo README.
// Missing / unrecognised values fall back to mainnet (the
// production default at https://sysnode.info).

const NETWORK_PARAMS = Object.freeze({
  mainnet: Object.freeze({
    id: 'mainnet',
    superblockCycleBlocks: 17520,
    superblockMaturityWindowBlocks: 1728,
    targetBlockTimeSec: 150,
  }),
  testnet: Object.freeze({
    id: 'testnet',
    superblockCycleBlocks: 60,
    superblockMaturityWindowBlocks: 20,
    targetBlockTimeSec: 150,
  }),
  regtest: Object.freeze({
    id: 'regtest',
    superblockCycleBlocks: 10,
    superblockMaturityWindowBlocks: 5,
    targetBlockTimeSec: 150,
  }),
});

// Normalise a raw env-var value to one of the supported network
// ids. Empty / unknown values return 'mainnet' (production
// default). Exported for test coverage of the resolution rules.
export function resolveNetworkId(raw) {
  if (raw == null) return 'mainnet';
  const s = String(raw).trim().toLowerCase();
  if (s === '') return 'mainnet';
  if (s === 'main' || s === 'mainnet') return 'mainnet';
  if (s === 'test' || s === 'testnet') return 'testnet';
  if (s === 'reg' || s === 'regtest') return 'regtest';
  // Unknown label: fall back to mainnet so a misspelled env var
  // doesn't silently break the window math with zero-filled
  // defaults. A warning here would be noisy in tests and CRA
  // stripes the console, so callers that care can inspect
  // getNetworkParams().id and compare to their build target.
  return 'mainnet';
}

// Returns a frozen params record for the active network. Safe to
// call repeatedly — the resolution is purely a lookup.
export function getNetworkParams() {
  const id = resolveNetworkId(
    typeof process !== 'undefined' && process.env
      ? process.env.REACT_APP_NETWORK
      : undefined
  );
  return NETWORK_PARAMS[id];
}

// Map of supported ids → params, exported for tests that want to
// spot-check every network in one pass rather than re-importing
// with different env vars.
export const SUPPORTED_NETWORKS = NETWORK_PARAMS;
