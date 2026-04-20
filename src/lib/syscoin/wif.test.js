const {
  parseWif,
  addressFromWif,
  validateWif,
} = require('./wif');
const { MAINNET, TESTNET } = require('./networks');

// -----------------------------------------------------------------------
// Regression vectors
// -----------------------------------------------------------------------
//
// These are the canonical outputs for the private key 0x00…01, the
// smallest valid secp256k1 scalar. The WIF encoding shares its
// version byte (0x80 mainnet, 0xEF testnet) with Bitcoin, which lets
// us lift the well-known "compressed" WIF
// `KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn` straight from
// https://en.bitcoin.it/wiki/Wallet_import_format as an independent
// cross-check — our decoder has to accept it verbatim because it IS a
// valid Syscoin mainnet WIF too.
//
// For the derived bech32 addresses we rely on two pinned facts:
//   1. hash160(compressed_pubkey(pk=1)) is the canonical value
//      `751e76e8199196d454941c45d1b3a323f1433bd6` — it's the program
//      in BIP173's well-known vector
//      `bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4`, which any BIP173
//      implementation (bitcoinjs, btcutil, Core, @scure/base …) will
//      recompute byte-for-byte.
//   2. Syscoin's bech32 HRPs are "sys" (mainnet) and "tsys" (testnet)
//      per src/kernel/chainparams.cpp. Re-encoding the same witness
//      program under those HRPs is what Core's
//      `EncodeDestination(WitnessV0KeyHash(...))` does at runtime.
// The values below are therefore cryptographically forced by the
// curve order, the key=1 scalar, the BIP173 encoding, and the
// published Syscoin chainparams — if any of them drift, the math
// (or the chainparams) is wrong.

const PRIVATE_KEY_1_MAINNET_WIF_COMPRESSED =
  'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn';
const PRIVATE_KEY_1_MAINNET_WIF_UNCOMPRESSED =
  '5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf';
const PRIVATE_KEY_1_MAINNET_ADDRESS_BECH32 =
  'sys1qw508d6qejxtdg4y5r3zarvary0c5xw7kyhct58';

const PRIVATE_KEY_1_TESTNET_WIF_COMPRESSED =
  'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA';
const PRIVATE_KEY_1_TESTNET_ADDRESS_BECH32 =
  'tsys1qw508d6qejxtdg4y5r3zarvary0c5xw7kn9mz8d';

describe('parseWif', () => {
  test('decodes a compressed Syscoin mainnet WIF (pk = 1)', () => {
    const r = parseWif(PRIVATE_KEY_1_MAINNET_WIF_COMPRESSED);
    expect(r.compressed).toBe(true);
    expect(r.network).toBe(MAINNET);
    expect(r.privateKey).toBeInstanceOf(Uint8Array);
    expect(r.privateKey).toHaveLength(32);
    // Last byte == 1, all others zero
    expect(r.privateKey[31]).toBe(1);
    expect([...r.privateKey.slice(0, 31)]).toEqual(new Array(31).fill(0));
  });

  test('decodes an uncompressed Syscoin mainnet WIF (pk = 1)', () => {
    // parseWif still accepts uncompressed WIFs — the rejection lives
    // at the address-derivation step so callers can distinguish "this
    // isn't a valid key" from "this key can't produce a segwit
    // voting address".
    const r = parseWif(PRIVATE_KEY_1_MAINNET_WIF_UNCOMPRESSED);
    expect(r.compressed).toBe(false);
    expect(r.network).toBe(MAINNET);
    expect(r.privateKey[31]).toBe(1);
  });

  test('accepts testnet WIF only when testnet is explicitly expected', () => {
    // No expectedNetwork → mainnet-only; testnet version byte is
    // rejected to prevent accidental wallet-type mixups in the UI.
    expect(() => parseWif(PRIVATE_KEY_1_TESTNET_WIF_COMPRESSED)).toThrow(
      /wif_network_mismatch/
    );
    expect(() =>
      parseWif(PRIVATE_KEY_1_TESTNET_WIF_COMPRESSED, 'mainnet')
    ).toThrow(/wif_network_mismatch/);
    const r = parseWif(PRIVATE_KEY_1_TESTNET_WIF_COMPRESSED, 'testnet');
    expect(r.network).toBe(TESTNET);
    expect(r.compressed).toBe(true);
  });

  test('rejects empty input', () => {
    expect(() => parseWif('')).toThrow(/wif_empty/);
    expect(() => parseWif(null)).toThrow(/wif_empty/);
    expect(() => parseWif(undefined)).toThrow(/wif_empty/);
  });

  test('rejects leading/trailing whitespace rather than trimming', () => {
    // Silent trimming would mask formatting bugs in the caller (CSV
    // parser, clipboard, etc.), so the decoder is strict.
    expect(() =>
      parseWif(` ${PRIVATE_KEY_1_MAINNET_WIF_COMPRESSED} `)
    ).toThrow(/wif_whitespace/);
    expect(() =>
      parseWif(`\t${PRIVATE_KEY_1_MAINNET_WIF_COMPRESSED}`)
    ).toThrow(/wif_whitespace/);
    expect(() =>
      parseWif(`${PRIVATE_KEY_1_MAINNET_WIF_COMPRESSED}\n`)
    ).toThrow(/wif_whitespace/);
  });

  test('rejects a WIF with a tampered checksum', () => {
    // Mutate the last base58 character deterministically. Because the
    // checksum is the tail of the payload, flipping the final char
    // reliably breaks exactly the checksum.
    const wif = PRIVATE_KEY_1_MAINNET_WIF_COMPRESSED;
    const last = wif[wif.length - 1];
    const swapped = last === 'A' ? 'B' : 'A';
    const tampered = wif.slice(0, -1) + swapped;
    expect(() => parseWif(tampered)).toThrow(/wif_invalid_/);
  });

  test('rejects a WIF with a non-base58 character', () => {
    // "0" is intentionally excluded from the base58 alphabet, so
    // injecting it must fail at base58 decode.
    const wif = PRIVATE_KEY_1_MAINNET_WIF_COMPRESSED;
    const tampered = wif.slice(0, 5) + '0' + wif.slice(6);
    expect(() => parseWif(tampered)).toThrow(/wif_invalid_/);
  });

  test('rejects a payload with a bogus compression flag', () => {
    // Construct a 34-byte payload whose compression byte is 0x02
    // (not 0x01) and re-encode. This should parse as base58 and pass
    // the checksum (we re-run base58check on the raw payload) but be
    // rejected by parseWif's post-decode validation.
    const { base58check } = require('@scure/base');
    const { sha256 } = require('@noble/hashes/sha2');
    const b58c = base58check(sha256);
    const payload = new Uint8Array(34);
    payload[0] = 0x80;
    payload[32] = 1;
    payload[33] = 0x02;
    const bad = b58c.encode(payload);
    expect(() => parseWif(bad)).toThrow(/wif_invalid_compression_flag/);
  });

  test('rejects a zero private key (not in [1, n-1])', () => {
    const { base58check } = require('@scure/base');
    const { sha256 } = require('@noble/hashes/sha2');
    const b58c = base58check(sha256);
    // Compressed WIF form with a 32-byte zero scalar.
    const payload = new Uint8Array(34);
    payload[0] = 0x80;
    payload[33] = 0x01;
    const zero = b58c.encode(payload);
    expect(() => parseWif(zero)).toThrow(/wif_invalid_key_range/);
  });

  test('rejects a private key >= curve order N', () => {
    const { base58check } = require('@scure/base');
    const { sha256 } = require('@noble/hashes/sha2');
    const b58c = base58check(sha256);
    // N itself written big-endian as a 32-byte scalar.
    const nBytes = new Uint8Array([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b,
      0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
    ]);
    const payload = new Uint8Array(34);
    payload[0] = 0x80;
    payload.set(nBytes, 1);
    payload[33] = 0x01;
    const bad = b58c.encode(payload);
    expect(() => parseWif(bad)).toThrow(/wif_invalid_key_range/);
  });
});

describe('addressFromWif', () => {
  test('compressed mainnet WIF (pk = 1) → known Syscoin P2WPKH bech32', () => {
    expect(addressFromWif(PRIVATE_KEY_1_MAINNET_WIF_COMPRESSED)).toBe(
      PRIVATE_KEY_1_MAINNET_ADDRESS_BECH32
    );
  });

  test('compressed testnet WIF (pk = 1) → known Syscoin testnet P2WPKH bech32', () => {
    expect(
      addressFromWif(PRIVATE_KEY_1_TESTNET_WIF_COMPRESSED, 'testnet')
    ).toBe(PRIVATE_KEY_1_TESTNET_ADDRESS_BECH32);
  });

  test('rejects uncompressed WIF with a dedicated error code', () => {
    // Uncompressed pubkeys cannot appear in a segwit witness per
    // BIP141. We could fall back to legacy P2PKH here, but Syscoin
    // Core's masternode RPC output only ever renders the voting
    // address as bech32 — showing a legacy fallback address would
    // just confuse users reconciling against `protx_info`. Reject
    // cleanly with a specific code so the UI can explain.
    expect(() =>
      addressFromWif(PRIVATE_KEY_1_MAINNET_WIF_UNCOMPRESSED)
    ).toThrow(/wif_uncompressed_unsupported/);
  });

  test('mainnet addresses start with "sys1q" as a smoke check', () => {
    // HRP "sys" + separator "1" + witness v0 ("q" in bech32's 5-bit
    // alphabet) is the invariant prefix for every P2WPKH mainnet
    // address — drifting past that means either the HRP or the
    // witness version has silently moved, both of which should loudly
    // fail here rather than in the UI later.
    const addr = addressFromWif(PRIVATE_KEY_1_MAINNET_WIF_COMPRESSED);
    expect(addr.startsWith('sys1q')).toBe(true);
  });

  test('testnet addresses start with "tsys1q" as a smoke check', () => {
    const addr = addressFromWif(
      PRIVATE_KEY_1_TESTNET_WIF_COMPRESSED,
      'testnet'
    );
    expect(addr.startsWith('tsys1q')).toBe(true);
  });
});

describe('validateWif', () => {
  test('returns a happy-path shape for a valid WIF', () => {
    expect(validateWif(PRIVATE_KEY_1_MAINNET_WIF_COMPRESSED)).toEqual({
      valid: true,
      address: PRIVATE_KEY_1_MAINNET_ADDRESS_BECH32,
      network: 'mainnet',
      compressed: true,
    });
  });

  test('returns a {valid:false, code, message} shape for an invalid WIF', () => {
    const r = validateWif('not-a-wif');
    expect(r.valid).toBe(false);
    expect(typeof r.code).toBe('string');
    expect(r.code).toMatch(/^wif_/);
    expect(typeof r.message).toBe('string');
  });

  test('categorises network mismatch distinctly from checksum failure', () => {
    // A testnet WIF against the mainnet default must be rejected
    // with the specific network_mismatch code so the UI can render
    // a helpful "this looks like a testnet key" hint instead of a
    // generic "invalid WIF" toast.
    const r = validateWif(PRIVATE_KEY_1_TESTNET_WIF_COMPRESSED);
    expect(r).toEqual(
      expect.objectContaining({
        valid: false,
        code: 'wif_network_mismatch',
      })
    );
  });

  test('categorises uncompressed WIFs distinctly so the UI can hint', () => {
    const r = validateWif(PRIVATE_KEY_1_MAINNET_WIF_UNCOMPRESSED);
    expect(r).toEqual(
      expect.objectContaining({
        valid: false,
        code: 'wif_uncompressed_unsupported',
      })
    );
  });

  test('never throws — even on garbage input', () => {
    // Per-row CSV import renders thousands of these calls; exception
    // safety matters.
    expect(() => validateWif('')).not.toThrow();
    expect(() => validateWif('1')).not.toThrow();
    expect(() => validateWif('!'.repeat(100))).not.toThrow();
    // eslint-disable-next-line no-undef
    expect(() => validateWif(null)).not.toThrow();
    expect(() => validateWif(undefined)).not.toThrow();
    expect(() => validateWif(123)).not.toThrow();
  });
});
