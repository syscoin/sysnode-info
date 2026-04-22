// Syscoin governance vote — client-side signer.
//
// Produces the 65-byte recoverable-ECDSA "vchSig" that Syscoin Core's
// `voteraw` RPC expects (base64-encoded). The signing inputs are:
//
//   * the masternode's collateral outpoint (hash + index)
//   * the governance proposal hash (parentHash)
//   * voteOutcome  ("yes" | "no" | "abstain")
//   * voteSignal   ("funding" — this is all the vault scope supports)
//   * time (seconds since epoch, Core rejects > now + 3600)
//   * the compressed secp256k1 private key
//
// It returns:
//   { voteSig: base64(65 bytes),  sigHash: hex(32 bytes) }
//
// Reference (Syscoin Core):
//   src/governance/governancevote.cpp CGovernanceVote::GetSignatureHash
//      => SerializeHash(*this)  under SER_GETHASH
//      which writes [masternodeOutpoint][nParentHash][nVoteOutcome]
//                   [nVoteSignal][nTime] and hashes with double-SHA256.
//   src/governance/governancevote.h   SERIALIZE_METHODS
//      confirms field order + the SER_GETHASH path omits vchSig.
//   src/governance/governancevote.h   nVoteOutcome / nVoteSignal are
//      `int` (NOT uint8_t) → each serialises as 4 bytes little-endian.
//   src/messagesigner.cpp             CHashSigner::SignHash calls
//      CKey::SignCompact.
//   src/key.cpp CKey::SignCompact:
//      vchSig[0] = 27 + recid + (compressed ? 4 : 0)
//      vchSig[1..65] = secp256k1_ecdsa_recoverable_signature
//                      _serialize_compact(r || s)
//      uses deterministic RFC6979 nonce (no extra entropy)
//      secp256k1_ecdsa_sign_recoverable normalises s → low-s
//
// Preimage layout (84 bytes little-endian throughout):
//
//   offset  size  field
//   0       32    masternodeOutpoint.hash   (uint256 LE — reverse of display hex)
//   32      4     masternodeOutpoint.n      (uint32 LE)
//   36      32    nParentHash                (uint256 LE — reverse of display hex)
//   68      4     nVoteOutcome              (int32 LE: yes=1, no=2, abstain=3)
//   72      4     nVoteSignal               (int32 LE: funding=1)
//   76      8     nTime                      (int64 LE)
//
// This module signs with the WEB CRYPTO-free sync path: we wire
// @noble/hashes' hmac(sha256, ...) into @noble/secp256k1's
// `etc.hmacSha256Sync`, which lets `secp.sign()` run synchronously.
// Wiring is idempotent and set once at module load.

const { sha256 } = require('@noble/hashes/sha2');
const { hmac } = require('@noble/hashes/hmac');
const { concatBytes } = require('@noble/hashes/utils');
const secp = require('@noble/secp256k1');
const { base64 } = require('@scure/base');

const { parseWif } = require('./wif');

// One-time wire-up so secp.sign() works synchronously. The upstream
// API explicitly requires callers to set this — see the @noble/secp256k1
// v2 README "Synchronous HMAC-SHA256 must be provided" section.
//
// Guarded so reloading the module in dev (webpack HMR) doesn't
// overwrite an already-wired reference.
if (!secp.etc.hmacSha256Sync) {
  secp.etc.hmacSha256Sync = (key, ...msgs) =>
    hmac(sha256, key, concatBytes(...msgs));
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

// Core enum values — see src/governance/governancevote.h. These are
// the integer encodings actually written into the preimage; the
// string keys on the wire are a stable public API.
const OUTCOMES = Object.freeze({ yes: 1, no: 2, abstain: 3 });
// Intentionally scoped to "funding": other signals require the
// masternode operator's BLS key, which this vault does not hold.
// Kept as a map (not a single constant) so we can extend later
// without changing call sites.
const SIGNALS = Object.freeze({ funding: 1 });

function err(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  return e;
}

function hexToBytes(hex) {
  // Plain hex → big-endian bytes. Caller handles LE reversal for uint256.
  const out = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i++) {
    s += buf[i].toString(16).padStart(2, '0');
  }
  return s;
}

// Core stores uint256 in native (little-endian) byte order but
// DISPLAYS it in reversed hex, matching Bitcoin convention. So the
// bytes-on-wire for a 64-char hash string are the reverse of the
// input hex bytes.
function hashHexToLEBytes(hex) {
  if (typeof hex !== 'string' || !HEX64.test(hex)) {
    throw err('invalid_hash_hex', `expected 64-char hex, got ${hex}`);
  }
  const be = hexToBytes(hex);
  const le = new Uint8Array(32);
  for (let i = 0; i < 32; i++) le[i] = be[31 - i];
  return le;
}

function writeUint32LE(buf, offset, v) {
  // Core's `int` is 32-bit on every supported platform; negative enum
  // values aren't produced here (validators reject them) so the
  // unsigned-write is equivalent to int32-LE for our inputs.
  buf[offset] = v & 0xff;
  buf[offset + 1] = (v >>> 8) & 0xff;
  buf[offset + 2] = (v >>> 16) & 0xff;
  buf[offset + 3] = (v >>> 24) & 0xff;
}

function writeInt64LE(buf, offset, v) {
  // `time` is unix-seconds: easily fits in Number.MAX_SAFE_INTEGER
  // (2^53-1 ≈ year 285_427_971 CE). Using BigInt here only to keep
  // the byte-shifting arithmetic obviously correct.
  const bv = BigInt(v);
  const mask = 0xffn;
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((bv >> BigInt(i * 8)) & mask);
  }
}

// Build the 84-byte preimage that Core double-SHA256s to produce
// `CGovernanceVote::GetSignatureHash`. Pure: no crypto, no keys —
// unit-testable against hand-computed vectors.
function buildVotePreimage({
  collateralHash,
  collateralIndex,
  proposalHash,
  voteOutcome,
  voteSignal,
  time,
}) {
  if (typeof collateralHash !== 'string' || !HEX64.test(collateralHash)) {
    throw err('invalid_collateral_hash');
  }
  if (
    !Number.isInteger(collateralIndex) ||
    collateralIndex < 0 ||
    collateralIndex > 0xffffffff
  ) {
    throw err('invalid_collateral_index');
  }
  if (typeof proposalHash !== 'string' || !HEX64.test(proposalHash)) {
    throw err('invalid_proposal_hash');
  }
  if (typeof voteOutcome !== 'string' || !(voteOutcome in OUTCOMES)) {
    throw err('invalid_vote_outcome');
  }
  if (typeof voteSignal !== 'string' || !(voteSignal in SIGNALS)) {
    // The frontend should only ever pass "funding"; if we receive
    // anything else it's a programmer error and we want a loud fail
    // rather than silently producing a signature Core will reject.
    throw err('unsupported_vote_signal');
  }
  if (!Number.isInteger(time) || time < 0) {
    throw err('invalid_time');
  }

  const buf = new Uint8Array(84);
  buf.set(hashHexToLEBytes(collateralHash), 0);
  writeUint32LE(buf, 32, collateralIndex);
  buf.set(hashHexToLEBytes(proposalHash), 36);
  writeUint32LE(buf, 68, OUTCOMES[voteOutcome]);
  writeUint32LE(buf, 72, SIGNALS[voteSignal]);
  writeInt64LE(buf, 76, time);
  return buf;
}

function doubleSha256(bytes) {
  return sha256(sha256(bytes));
}

function signatureHash(fields) {
  return doubleSha256(buildVotePreimage(fields));
}

// Produce the 65-byte vchSig and return it base64-encoded. Matches
// CKey::SignCompact byte layout exactly:
//   vchSig[0]       = 27 + recid + 4    (compressed)
//   vchSig[1..=64]  = r (32 LE-padded) || s (32 LE-padded), low-s
// `privateKey` is expected as a 32-byte Uint8Array. WIF decoding
// lives in `./wif` and callers should use signVoteFromWif() unless
// they already hold a parsed scalar.
function signVote({ privateKey, ...fields }) {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw err('invalid_private_key', 'expected 32-byte Uint8Array');
  }
  const hash = signatureHash(fields);
  // `sign()` is sync because we wired hmacSha256Sync above. lowS is
  // default-true in noble v2 and matches libsecp256k1's post-sign
  // normalisation inside secp256k1_ecdsa_sign_recoverable.
  const sig = secp.sign(hash, privateKey);
  if (typeof sig.recovery !== 'number' || sig.recovery < 0 || sig.recovery > 3) {
    throw err('sign_no_recovery', 'secp256k1 did not return a recovery id');
  }
  const compact = sig.toBytes(); // 64 bytes: r || s, low-s, big-endian 32-byte each
  if (compact.length !== 64) {
    throw err('sign_bad_length', `compact sig must be 64 bytes, got ${compact.length}`);
  }
  const vchSig = new Uint8Array(65);
  // Always compressed: voting keys are compressed (BIP141/segwit
  // display, see wif.js rationale). Core's CKey::SignCompact uses
  // 27 + recid + (compressed ? 4 : 0); we only support compressed.
  vchSig[0] = 27 + sig.recovery + 4;
  vchSig.set(compact, 1);
  return {
    voteSig: base64.encode(vchSig),
    sigHash: bytesToHex(hash),
    recovery: sig.recovery,
  };
}

// Ergonomic wrapper: decode a WIF (via ./wif) and sign. Throws the
// same typed errors as parseWif for WIF problems, plus
// `wif_uncompressed_unsupported` if the WIF is uncompressed (Syscoin
// voting keys are always compressed — see wif.js).
function signVoteFromWif({ wif, expectedNetwork, ...fields }) {
  const { privateKey, compressed } = parseWif(wif, expectedNetwork);
  if (!compressed) {
    throw err(
      'wif_uncompressed_unsupported',
      'Uncompressed WIFs cannot be used as masternode voting keys ' +
        '(BIP141 segwit requires a compressed public key).'
    );
  }
  return signVote({ privateKey, ...fields });
}

module.exports = {
  OUTCOMES,
  SIGNALS,
  buildVotePreimage,
  signatureHash,
  signVote,
  signVoteFromWif,
  // Exported for unit tests; not part of the public API.
  _internals: { hashHexToLEBytes, writeUint32LE, writeInt64LE, bytesToHex },
};
