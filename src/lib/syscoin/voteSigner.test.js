/* global BigInt */
// Vote-signer KATs.
//
// Why these tests look the way they do:
//
// We don't have a Syscoin Core instance to cross-sign against in CI,
// so we can't hardcode a reference (hash, vchSig) tuple computed on
// Core itself. Instead we verify correctness *structurally*:
//
// 1. Preimage layout: a hand-computed 84-byte vector matching the
//    byte-by-byte layout documented in voteSigner.js. If anyone ever
//    reshuffles the field order or flips endianness, this vector
//    breaks.
// 2. Signature shape: every vchSig is exactly 65 bytes base64-encoded;
//    the leading header byte is 27 + recovery + 4 (compressed flag);
//    the trailing 64 bytes decode back to a compact signature that
//    @noble/secp256k1 will VERIFY against the public key derived from
//    the same private key over the same signature hash.
// 3. Recovery: recovering the public key from the compact sig + sigHash
//    + recovery id must yield the ORIGINAL public key. This is exactly
//    what Syscoin Core does in `CPubKey::RecoverCompact` to validate
//    votes — if our recovery id is wrong, Core will reject the vote
//    even though everything else looks fine.
// 4. Determinism: RFC6979 → identical inputs must produce an identical
//    vchSig across runs.
// 5. WIF entry point: signVoteFromWif decodes a known Syscoin mainnet
//    WIF (pk=1) and the signature it produces must recover to the
//    public key derived from pk=1.

const {
  buildVotePreimage,
  signatureHash,
  signVote,
  signVoteFromWif,
  OUTCOMES,
  SIGNALS,
  _internals,
} = require('./voteSigner');

const secp = require('@noble/secp256k1');
const { sha256 } = require('@noble/hashes/sha2');
const { base64 } = require('@scure/base');

const PRIVATE_KEY_1_MAINNET_WIF_COMPRESSED =
  'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn';
const PRIVATE_KEY_1_MAINNET_WIF_UNCOMPRESSED =
  '5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf';

// Helper: pk = 0x00..0001 (the simplest valid scalar).
function pk1() {
  const pk = new Uint8Array(32);
  pk[31] = 1;
  return pk;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function toHex(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, '0');
  return s;
}

function doubleSha256(bytes) {
  return sha256(sha256(bytes));
}

describe('buildVotePreimage', () => {
  test('produces the 84-byte layout documented in voteSigner.js', () => {
    // Display hex (big-endian). hashHexToLEBytes reverses each to LE
    // bytes before writing, so:
    //   collateralHash 00..00ab -> LE: ab 00 00 .. 00
    //   proposalHash   00..00cd -> LE: cd 00 00 .. 00
    const collateralHash =
      '00000000000000000000000000000000000000000000000000000000000000ab';
    const proposalHash =
      '00000000000000000000000000000000000000000000000000000000000000cd';
    const collateralIndex = 1; // LE: 01 00 00 00
    const voteOutcome = 'yes'; // 1 -> 01 00 00 00
    const voteSignal = 'funding'; // 1 -> 01 00 00 00
    // Pick a time whose bytes are unambiguously multi-byte so an
    // accidental 32-bit write shows up as a visible diff.
    const time = 0x1122334455; // int64 LE: 55 44 33 22 11 00 00 00

    const expected =
      'ab' +
      '00'.repeat(31) +
      '01000000' +
      'cd' +
      '00'.repeat(31) +
      '01000000' +
      '01000000' +
      '5544332211000000';

    const pre = buildVotePreimage({
      collateralHash,
      collateralIndex,
      proposalHash,
      voteOutcome,
      voteSignal,
      time,
    });
    expect(pre).toBeInstanceOf(Uint8Array);
    expect(pre).toHaveLength(84);
    expect(toHex(pre)).toBe(expected);
  });

  test('distinct outcomes produce distinct preimages', () => {
    // Defense against an off-by-one in enum encoding.
    const base = {
      collateralHash: 'aa'.repeat(32),
      collateralIndex: 0,
      proposalHash: 'bb'.repeat(32),
      voteSignal: 'funding',
      time: 1700000000,
    };
    const yes = buildVotePreimage({ ...base, voteOutcome: 'yes' });
    const no = buildVotePreimage({ ...base, voteOutcome: 'no' });
    const ab = buildVotePreimage({ ...base, voteOutcome: 'abstain' });
    expect(toHex(yes)).not.toBe(toHex(no));
    expect(toHex(no)).not.toBe(toHex(ab));
    expect(toHex(yes)).not.toBe(toHex(ab));
    // And their encoded byte should be exactly at offset 68.
    expect(yes[68]).toBe(OUTCOMES.yes);
    expect(no[68]).toBe(OUTCOMES.no);
    expect(ab[68]).toBe(OUTCOMES.abstain);
    // voteSignal byte is at offset 72.
    expect(yes[72]).toBe(SIGNALS.funding);
  });

  test('rejects malformed hex hashes', () => {
    const base = {
      collateralIndex: 0,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      time: 1,
    };
    expect(() =>
      buildVotePreimage({
        ...base,
        collateralHash: 'short',
        proposalHash: 'aa'.repeat(32),
      })
    ).toThrow(/invalid_collateral_hash/);
    expect(() =>
      buildVotePreimage({
        ...base,
        collateralHash: 'aa'.repeat(32),
        proposalHash: 'not-hex-not-hex' + 'a'.repeat(48),
      })
    ).toThrow(/invalid_proposal_hash/);
  });

  test('rejects out-of-range collateralIndex', () => {
    const base = {
      collateralHash: 'aa'.repeat(32),
      proposalHash: 'bb'.repeat(32),
      voteOutcome: 'yes',
      voteSignal: 'funding',
      time: 1,
    };
    expect(() => buildVotePreimage({ ...base, collateralIndex: -1 })).toThrow(
      /invalid_collateral_index/
    );
    expect(() =>
      buildVotePreimage({ ...base, collateralIndex: 0x1_0000_0000 })
    ).toThrow(/invalid_collateral_index/);
    expect(() => buildVotePreimage({ ...base, collateralIndex: 1.5 })).toThrow(
      /invalid_collateral_index/
    );
  });

  test('rejects unknown vote outcome / signal', () => {
    const base = {
      collateralHash: 'aa'.repeat(32),
      collateralIndex: 0,
      proposalHash: 'bb'.repeat(32),
      time: 1,
    };
    expect(() =>
      buildVotePreimage({ ...base, voteOutcome: 'maybe', voteSignal: 'funding' })
    ).toThrow(/invalid_vote_outcome/);
    expect(() =>
      buildVotePreimage({ ...base, voteOutcome: 'yes', voteSignal: 'valid' })
    ).toThrow(/unsupported_vote_signal/);
  });

  test('rejects invalid time', () => {
    const base = {
      collateralHash: 'aa'.repeat(32),
      collateralIndex: 0,
      proposalHash: 'bb'.repeat(32),
      voteOutcome: 'yes',
      voteSignal: 'funding',
    };
    expect(() => buildVotePreimage({ ...base, time: -1 })).toThrow(
      /invalid_time/
    );
    expect(() => buildVotePreimage({ ...base, time: 1.5 })).toThrow(
      /invalid_time/
    );
  });

  test('signatureHash double-SHA256s the preimage', () => {
    const fields = {
      collateralHash: 'aa'.repeat(32),
      collateralIndex: 0,
      proposalHash: 'bb'.repeat(32),
      voteOutcome: 'yes',
      voteSignal: 'funding',
      time: 1700000000,
    };
    const pre = buildVotePreimage(fields);
    expect(toHex(signatureHash(fields))).toBe(toHex(doubleSha256(pre)));
  });
});

describe('_internals', () => {
  test('hashHexToLEBytes reverses byte order (Bitcoin-style uint256)', () => {
    const le = _internals.hashHexToLEBytes(
      '00112233445566778899aabbccddeeff' +
        '00112233445566778899aabbccddeeff'
    );
    // First byte of the LE output is the LAST hex pair (0xff).
    expect(le[0]).toBe(0xff);
    expect(le[31]).toBe(0x00);
  });

  test('hashHexToLEBytes rejects non-hex input', () => {
    expect(() => _internals.hashHexToLEBytes('zz'.repeat(32))).toThrow(
      /invalid_hash_hex/
    );
    expect(() => _internals.hashHexToLEBytes('abc')).toThrow(
      /invalid_hash_hex/
    );
  });
});

describe('signVote', () => {
  const baseFields = {
    collateralHash:
      '0000000000000000000000000000000000000000000000000000000000000001',
    collateralIndex: 0,
    proposalHash:
      '0000000000000000000000000000000000000000000000000000000000000002',
    voteOutcome: 'yes',
    voteSignal: 'funding',
    time: 1700000000,
  };

  test('rejects non-Uint8Array or wrong-length private keys', () => {
    expect(() =>
      signVote({ privateKey: 'hex-string-not-bytes', ...baseFields })
    ).toThrow(/invalid_private_key/);
    expect(() =>
      signVote({ privateKey: new Uint8Array(31), ...baseFields })
    ).toThrow(/invalid_private_key/);
  });

  test('returns base64 vchSig of exactly 65 bytes with a compressed header', () => {
    const { voteSig, sigHash, recovery } = signVote({
      privateKey: pk1(),
      ...baseFields,
    });
    expect(typeof voteSig).toBe('string');
    expect(sigHash).toMatch(/^[0-9a-f]{64}$/);
    expect([0, 1, 2, 3]).toContain(recovery);

    const bytes = base64.decode(voteSig);
    expect(bytes).toHaveLength(65);
    // Compressed WIF => header = 27 + recid + 4 ∈ {31, 32, 33, 34}.
    expect(bytes[0]).toBe(27 + recovery + 4);
    expect([31, 32, 33, 34]).toContain(bytes[0]);
  });

  test('compact signature verifies against the signer public key (secp256k1 correctness)', () => {
    const pk = pk1();
    const pub = secp.getPublicKey(pk, true);
    const { voteSig, sigHash } = signVote({ privateKey: pk, ...baseFields });
    const compact = base64.decode(voteSig).slice(1); // strip header byte
    const hash = hexToBytes(sigHash);
    // lowS is default-true both at sign and verify; verifier passes
    // only when the sig is truly over `hash` with `pub`.
    expect(secp.verify(compact, hash, pub)).toBe(true);
  });

  test('recovery id recovers the ORIGINAL public key (matches Core verify path)', () => {
    // This is the property Syscoin Core actually checks: it calls
    // CPubKey::RecoverCompact(hash, vchSig) and then compares the
    // recovered keyID to the MN's keyIDVoting. If our recovery byte
    // is wrong by one, this test fails even though verify() still
    // passes (because verify() ignores the header).
    const pk = pk1();
    const expectedPub = secp.getPublicKey(pk, true);
    const { voteSig, sigHash, recovery } = signVote({
      privateKey: pk,
      ...baseFields,
    });
    const compact = base64.decode(voteSig).slice(1);
    const hash = hexToBytes(sigHash);

    const sigObj = secp.Signature.fromCompact(compact).addRecoveryBit(recovery);
    const recoveredPub = sigObj.recoverPublicKey(hash).toBytes(true);
    expect(toHex(recoveredPub)).toBe(toHex(expectedPub));
  });

  test('deterministic: same inputs yield an identical vchSig (RFC6979)', () => {
    const a = signVote({ privateKey: pk1(), ...baseFields });
    const b = signVote({ privateKey: pk1(), ...baseFields });
    expect(a.voteSig).toBe(b.voteSig);
    expect(a.sigHash).toBe(b.sigHash);
    expect(a.recovery).toBe(b.recovery);
  });

  test('changing ANY input flips the signature (avalanche guard)', () => {
    const baseline = signVote({ privateKey: pk1(), ...baseFields });
    const mutations = [
      { collateralIndex: 1 },
      {
        proposalHash:
          '0000000000000000000000000000000000000000000000000000000000000003',
      },
      { voteOutcome: 'no' },
      { time: baseFields.time + 1 },
    ];
    for (const m of mutations) {
      const { voteSig } = signVote({ privateKey: pk1(), ...baseFields, ...m });
      expect(voteSig).not.toBe(baseline.voteSig);
    }
  });
});

describe('signVoteFromWif', () => {
  const baseFields = {
    collateralHash:
      '0000000000000000000000000000000000000000000000000000000000000001',
    collateralIndex: 0,
    proposalHash:
      '0000000000000000000000000000000000000000000000000000000000000002',
    voteOutcome: 'yes',
    voteSignal: 'funding',
    time: 1700000000,
  };

  test('signs with a compressed mainnet WIF; signature recovers to the WIF pubkey', () => {
    const { voteSig, sigHash, recovery } = signVoteFromWif({
      wif: PRIVATE_KEY_1_MAINNET_WIF_COMPRESSED,
      ...baseFields,
    });
    // pk = 1 -> public key is just the generator G. We recover from
    // the sig to confirm the full pipeline: WIF decode → preimage →
    // hash → sign → base64 → recover.
    const compact = base64.decode(voteSig).slice(1);
    const hash = hexToBytes(sigHash);
    const sigObj = secp.Signature.fromCompact(compact).addRecoveryBit(
      recovery
    );
    const recoveredPub = sigObj.recoverPublicKey(hash).toBytes(true);
    const expected = secp.getPublicKey(pk1(), true);
    expect(toHex(recoveredPub)).toBe(toHex(expected));
  });

  test('rejects an uncompressed WIF with wif_uncompressed_unsupported', () => {
    // BIP141 forbids uncompressed pubkeys in segwit, and Core's
    // voting-address display assumes compressed — an uncompressed WIF
    // cannot produce a signature whose recovered keyID matches any
    // live voting address. Block it at the signer boundary so the UI
    // doesn't spend rate limit tokens on a guaranteed-rejected vote.
    expect(() =>
      signVoteFromWif({
        wif: PRIVATE_KEY_1_MAINNET_WIF_UNCOMPRESSED,
        ...baseFields,
      })
    ).toThrow(/wif_uncompressed_unsupported/);
  });

  test('propagates typed WIF errors for nonsense input', () => {
    expect(() =>
      signVoteFromWif({ wif: 'not-a-wif', ...baseFields })
    ).toThrow(/wif_invalid_base58|wif_invalid_length|wif_network_mismatch/);
  });
});
