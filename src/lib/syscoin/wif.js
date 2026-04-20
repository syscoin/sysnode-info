/* global BigInt */
// WIF decode + P2WPKH (bech32) address derivation for Syscoin.
//
// This module is used by the key-import UI to validate pasted
// masternode voting WIFs and to display the address they control, so
// the user can reconcile what they're importing against their
// masternode registration BEFORE we encrypt it into the vault.
//
// Why bech32 and not legacy P2PKH:
//   * A Syscoin masternode's voting key is committed on-chain as a
//     20-byte keyID (hash160 of the compressed pubkey) stored in
//     `CDeterministicMNState::keyIDVoting` (see
//     src/evo/dmnstate.{h,cpp}). The signing scheme itself is a
//     recoverable ECDSA compact signature over a 256-bit hash
//     (src/messagesigner.cpp `CHashSigner::SignHash`) verified against
//     that keyID — there is no output-script semantics to it, so
//     "P2PKH vs P2WPKH" is purely a display choice.
//   * Syscoin Core's own RPC output (`protx_info`, `protx_list`, the
//     masternode list, explorers that read them) renders the voting
//     key as bech32 P2WPKH via `EncodeDestination(WitnessV0KeyHash(
//     keyIDVoting))`. Matching that here means the user's pasted WIF
//     resolves to the *same string* they see in their MN config or
//     on-chain, not a format nothing else in the ecosystem displays.
//   * Uncompressed WIFs can't produce a P2WPKH address — BIP141
//     forbids uncompressed pubkeys in segwit witnesses — and every
//     modern Syscoin/Dash voting key is compressed anyway. We reject
//     uncompressed at address-derivation time with a dedicated error
//     code so the UI can render a specific hint.
//
// Scope (intentionally small):
//   * decode a WIF to { privateKey, compressed, network }
//   * derive the corresponding P2WPKH (bech32, HRP "sys" on mainnet
//     or "tsys" on testnet) address for compressed WIFs
//   * return typed error codes for every rejection path so the UI can
//     surface a specific message and so per-row CSV import can
//     categorise failures
//
// We do NOT sign anything here — vote signing lives in
// VaultGovernanceSigner / the backend's ECDSA wrapper. This module
// only turns a user-visible string into (i) a 32-byte scalar we can
// later hand to the signer and (ii) a Core-compatible display
// address.
//
// Implementation notes:
//   * base58check and bech32 come from @scure/base. Both use the
//     standard spec checksums (double-SHA256 for base58check, BCH
//     code for bech32). Matches Syscoin Core.
//   * secp256k1 comes from @noble/secp256k1 v2. We only call
//     getPublicKey(), which is a scalar multiplication — no RNG,
//     deterministic, safe to run in a browser without sync-hmac
//     wiring.
//   * ripemd160 + sha256 come from @noble/hashes.
//
// All the inputs the UI passes in are user-provided strings, so every
// error here is structured ({code, message}) rather than a bare
// Error — callers route them straight to toasts / per-row CSV status.

const { base58check, bech32 } = require('@scure/base');
const { sha256 } = require('@noble/hashes/sha2');
const { ripemd160 } = require('@noble/hashes/ripemd160');
const secp = require('@noble/secp256k1');

const { MAINNET, resolveNetwork } = require('./networks');

const b58c = base58check(sha256);

// secp256k1 group order. A valid private key is a scalar in [1, n-1].
const SECP256K1_N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'
);

// Error helper: the thrown .message is always prefixed with the code
// so regex/text assertions can match on either the machine-readable
// code (preferred) or the human-readable detail. .code is the
// contract; .message is for logs.
function err(code, detail) {
  const msg = detail ? `${code}: ${detail}` : code;
  const e = new Error(msg);
  e.code = code;
  return e;
}

function bytesToBigInt(buf) {
  let n = 0n;
  for (let i = 0; i < buf.length; i++) {
    n = (n << 8n) | BigInt(buf[i]);
  }
  return n;
}

// Decode a WIF string into its constituent parts. Strict by design:
// trailing bytes, stray whitespace, and unknown version bytes are all
// rejected rather than coerced. The `expectedNetwork` argument (if
// supplied) additionally enforces that the WIF belongs to that
// specific network; omit it to accept mainnet only (testnet requires
// an explicit opt-in — see below).
function parseWif(wif, expectedNetwork) {
  if (typeof wif !== 'string' || wif.length === 0) {
    throw err('wif_empty', 'WIF is empty.');
  }
  // Reject leading/trailing whitespace rather than silently trimming —
  // pasted CSVs are the most common place this lib sees input and a
  // silent trim can mask a formatting problem elsewhere. Callers that
  // know the input is noisy (e.g. CSV batch import) can `.trim()`
  // before calling us.
  if (wif !== wif.trim()) {
    throw err('wif_whitespace', 'WIF has surrounding whitespace.');
  }

  let decoded;
  try {
    decoded = b58c.decode(wif);
  } catch (_) {
    // @scure/base throws on both invalid base58 alphabet and bad
    // checksum. We can't cleanly tell them apart from the exception
    // message alone, so classify by shape: a 58-alphabet error will
    // have mentioned the offending char, otherwise assume checksum.
    // The UX is the same ("looks wrong, please double-check") so this
    // distinction is best-effort.
    const msg = (_ && _.message) || '';
    if (/checksum/i.test(msg)) {
      throw err('wif_invalid_checksum', 'WIF checksum does not match.');
    }
    throw err('wif_invalid_base58', 'WIF is not valid base58check.');
  }

  // After checksum stripping we expect either 33 bytes (uncompressed:
  // version + 32-byte key) or 34 bytes (compressed: version + key +
  // 0x01 flag).
  if (decoded.length !== 33 && decoded.length !== 34) {
    throw err(
      'wif_invalid_length',
      `WIF payload has unexpected length ${decoded.length}.`
    );
  }

  const version = decoded[0];
  let network;
  if (expectedNetwork) {
    network = resolveNetwork(expectedNetwork);
    if (version !== network.wif) {
      throw err(
        'wif_network_mismatch',
        `WIF is for a different network (expected ${network.name}).`
      );
    }
  } else {
    if (version === MAINNET.wif) {
      network = MAINNET;
    } else {
      // We could also accept testnet (0xEF) transparently, but the
      // Sysnode voting flow is mainnet-only and we'd rather flag
      // testnet WIFs loudly so a user doesn't accidentally import one
      // and wonder why their vote never lands. Testnet callers must
      // opt-in explicitly via expectedNetwork: 'testnet'.
      throw err(
        'wif_network_mismatch',
        'WIF version byte does not match Syscoin mainnet.'
      );
    }
  }

  const compressed = decoded.length === 34;
  if (compressed && decoded[33] !== 0x01) {
    throw err(
      'wif_invalid_compression_flag',
      'WIF compression flag byte must be 0x01.'
    );
  }

  const privateKey = decoded.slice(1, 33);
  const scalar = bytesToBigInt(privateKey);
  if (scalar === 0n || scalar >= SECP256K1_N) {
    throw err('wif_invalid_key_range', 'WIF private key is out of range.');
  }

  return { privateKey, compressed, network };
}

// Derive the P2WPKH (bech32) address for a given WIF. The address is
// a segwit v0 witness program encoded per BIP173:
//   <hrp>1<witver=0><bech32(hash160(compressed_pubkey))>
// where `hrp` is "sys" (mainnet) or "tsys" (testnet). The hash160
// commitment matches `CDeterministicMNState::keyIDVoting` byte-for-
// byte, which is what Syscoin Core actually verifies vote signatures
// against — the bech32 wrapper here is display only.
//
// Throws `wif_uncompressed_unsupported` for uncompressed WIFs:
// BIP141 forbids uncompressed pubkeys in segwit witnesses, and in
// practice every modern masternode voting key is compressed (the
// voting address printed by `protx_info` / `protx_list` cannot be
// produced from an uncompressed key).
function addressFromWif(wif, expectedNetwork) {
  const { privateKey, compressed, network } = parseWif(wif, expectedNetwork);
  if (!compressed) {
    throw err(
      'wif_uncompressed_unsupported',
      'Uncompressed WIFs cannot be used as masternode voting keys ' +
        '(BIP141 segwit requires a compressed public key).'
    );
  }
  const pubkey = secp.getPublicKey(privateKey, true);
  const h160 = ripemd160(sha256(pubkey));
  // Segwit v0 witness program: prepend the witness version (0) to
  // the 5-bit-expanded program before bech32-encoding. This is how
  // Syscoin Core's `WitnessV0KeyHash` serialiser hands the 20-byte
  // keyID to `bech32::Encode`.
  const words = [0, ...bech32.toWords(h160)];
  return bech32.encode(network.bech32Hrp, words);
}

// Convenience wrapper that the UI uses directly: returns a
// discriminated-union result rather than throwing so that per-row CSV
// rendering doesn't have to wrap every call in try/catch.
function validateWif(wif, expectedNetwork) {
  try {
    const address = addressFromWif(wif, expectedNetwork);
    const { compressed, network } = parseWif(wif, expectedNetwork);
    return {
      valid: true,
      address,
      network: network.name,
      compressed,
    };
  } catch (e) {
    return {
      valid: false,
      code: e.code || 'wif_invalid',
      message: e.message,
    };
  }
}

module.exports = {
  parseWif,
  addressFromWif,
  validateWif,
};
