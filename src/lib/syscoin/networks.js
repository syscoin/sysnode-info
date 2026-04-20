// Syscoin network parameters.
//
// Values come straight from src/kernel/chainparams.cpp in the Syscoin
// Core source:
//   mainnet PUBKEY_ADDRESS=63, SCRIPT_ADDRESS=5,   SECRET_KEY=128, bech32_hrp="sys"
//   testnet PUBKEY_ADDRESS=65, SCRIPT_ADDRESS=196, SECRET_KEY=239, bech32_hrp="tsys"
//
// `pubKeyHash` / `scriptHash` are the base58check version bytes for
// legacy P2PKH / P2SH. `wif` is the base58check version byte for WIF
// private keys. `bech32Hrp` is the human-readable prefix used by
// BIP173 segwit v0 (P2WPKH) and BIP350 segwit v1 (P2TR) addresses.
//
// Relevant to this module: masternode voting keys are committed on-
// chain as a 20-byte keyID (hash160 of the compressed pubkey) via
// `CDeterministicMNState::keyIDVoting`. Syscoin Core itself renders
// that keyID as a P2WPKH (bech32) address via
// `EncodeDestination(WitnessV0KeyHash(keyIDVoting))` in RPC output
// (see src/evo/dmnstate.cpp), so every `votingAddress` surfaced by
// `protx_info`, `protx_list`, explorers, etc. is bech32. We match
// that format on import so users can reconcile what they're importing
// against their MN registration directly.

const MAINNET = Object.freeze({
  name: 'mainnet',
  pubKeyHash: 0x3f,
  scriptHash: 0x05,
  wif: 0x80,
  bech32Hrp: 'sys',
});

const TESTNET = Object.freeze({
  name: 'testnet',
  pubKeyHash: 0x41,
  scriptHash: 0xc4,
  wif: 0xef,
  bech32Hrp: 'tsys',
});

const NETWORKS = Object.freeze({ mainnet: MAINNET, testnet: TESTNET });

function resolveNetwork(arg) {
  if (!arg) return MAINNET;
  if (typeof arg === 'string') {
    const n = NETWORKS[arg];
    if (!n) {
      const e = new Error(`unknown_network:${arg}`);
      e.code = 'unknown_network';
      throw e;
    }
    return n;
  }
  // Caller passed a network object directly.
  return arg;
}

module.exports = {
  MAINNET,
  TESTNET,
  NETWORKS,
  resolveNetwork,
};
