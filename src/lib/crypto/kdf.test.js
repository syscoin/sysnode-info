import {
  deriveMaster,
  deriveAuthHash,
  deriveVaultKey,
  deriveLoginKeys,
  __internals,
} from './kdf';

const nodeCrypto = require('crypto');

// Reference implementations using Node's crypto, independent of WebCrypto.
// If our WebCrypto path drifts from this, tests fail — catching a contract
// break before it ever ships.

function nodePbkdf2(password, email, iterations = __internals.PBKDF2_ITERATIONS) {
  return new Promise((resolve, reject) => {
    nodeCrypto.pbkdf2(
      password,
      email.normalize('NFKC').trim().toLowerCase(),
      iterations,
      32,
      'sha512',
      (err, out) => (err ? reject(err) : resolve(new Uint8Array(out)))
    );
  });
}

function nodeHkdfSha256(master, info, salt = Buffer.alloc(0), length = 32) {
  const ikm = Buffer.from(master);
  // RFC 5869 HKDF: Extract + Expand.
  const prk = nodeCrypto.createHmac('sha256', salt).update(ikm).digest();
  let t = Buffer.alloc(0);
  let okm = Buffer.alloc(0);
  let i = 1;
  while (okm.length < length) {
    t = nodeCrypto
      .createHmac('sha256', prk)
      .update(Buffer.concat([t, Buffer.from(info, 'utf8'), Buffer.from([i])]))
      .digest();
    okm = Buffer.concat([okm, t]);
    i += 1;
  }
  return new Uint8Array(okm.subarray(0, length));
}

describe('kdf.deriveMaster / deriveAuthHash — cross-check vs Node crypto', () => {
  const password = 'correct horse battery staple';
  const email = 'User@Example.com';

  test('deriveMaster matches Node PBKDF2-SHA512 over NFKC+trim+lowercase email', async () => {
    const [webMaster, nodeMaster] = await Promise.all([
      deriveMaster(password, email),
      nodePbkdf2(password, email),
    ]);
    expect(webMaster).toHaveLength(32);
    expect(Array.from(webMaster)).toEqual(Array.from(nodeMaster));
  }, 20000);

  test('deriveAuthHash matches Node HKDF-SHA256 with info="sysnode-auth-v1"', async () => {
    const master = await nodePbkdf2(password, email);
    const authHash = await deriveAuthHash(master);

    const expected = nodeHkdfSha256(master, __internals.AUTH_INFO);
    const expectedHex = Buffer.from(expected).toString('hex');

    expect(authHash).toBe(expectedHex);
    expect(authHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('deriveLoginKeys returns both master and authHash for a single call', async () => {
    const { master, authHash } = await deriveLoginKeys(password, email);
    expect(master).toHaveLength(32);
    expect(authHash).toMatch(/^[0-9a-f]{64}$/);
    const direct = await deriveAuthHash(master);
    expect(authHash).toBe(direct);
  }, 20000);

  test('email case and padding do not affect the derived master (normalization)', async () => {
    const a = await nodePbkdf2(password, '  USER@example.COM  ');
    const b = await nodePbkdf2(password, 'user@example.com');
    expect(Array.from(a)).toEqual(Array.from(b));
  }, 20000);

  test('empty password is rejected', async () => {
    await expect(deriveMaster('', email)).rejects.toThrow(/password/i);
  });

  test('empty email is rejected', async () => {
    await expect(deriveMaster(password, '')).rejects.toThrow(/email/i);
  });

  // When the browser doesn't expose window.crypto.subtle — the most common
  // cause is the SPA being served over plain HTTP on a non-localhost origin,
  // where WebCrypto is gated behind the Secure Contexts policy — we must
  // surface a stable, machine-readable code so the Login / Register pages
  // can render a dedicated message rather than the generic "something went
  // wrong" fallback. (See Login.js + Register.js ERROR_COPY.)
  test('throws a code="webcrypto_unavailable" error when subtle is missing', async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {},
    });
    try {
      await expect(deriveMaster('pw', 'user@example.com')).rejects.toMatchObject({
        code: 'webcrypto_unavailable',
      });
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });
});

describe('kdf.deriveVaultKey', () => {
  test('produces a non-extractable AES-GCM key that round-trips', async () => {
    const master = new Uint8Array(32).fill(7);
    const saltV = 'a'.repeat(64);
    const key = await deriveVaultKey(master, saltV);
    expect(key.algorithm.name).toBe('AES-GCM');
    expect(key.extractable).toBe(false);

    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode('hello vault');
    const ct = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext
    );
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ct
    );
    expect(new TextDecoder().decode(pt)).toBe('hello vault');
  });

  test('rejects non-hex saltV instead of silently coercing partial parses (Codex round 2 P2)', async () => {
    const master = new Uint8Array(32).fill(1);
    // `Ax...` would parseInt to 10 (0xA) on the first two chars; the strict
    // regex pre-check in fromHex must throw instead.
    await expect(
      deriveVaultKey(master, 'A'.repeat(62) + 'xx')
    ).rejects.toThrow(/invalid hex/i);
    // Odd-length hex: structurally malformed length.
    await expect(deriveVaultKey(master, 'abc')).rejects.toThrow(/invalid hex/i);
    // Trailing non-hex char inside a 2-char byte window (the exact case
    // parseInt would otherwise silently coerce to 0xA).
    await expect(deriveVaultKey(master, 'A0'.repeat(31) + 'AZ')).rejects.toThrow(
      /invalid hex/i
    );
  });

  test('different saltV values yield different keys (sanity)', async () => {
    const master = new Uint8Array(32).fill(5);
    const saltA = '11'.repeat(32);
    const saltB = '22'.repeat(32);
    const keyA = await deriveVaultKey(master, saltA);
    const keyB = await deriveVaultKey(master, saltB);
    // Keys are non-extractable, so we prove divergence by encrypting the
    // same plaintext with a fixed IV and checking ciphertexts differ.
    const iv = new Uint8Array(12);
    const pt = new TextEncoder().encode('probe');
    const ctA = new Uint8Array(
      await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyA, pt)
    );
    const ctB = new Uint8Array(
      await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyB, pt)
    );
    expect(Array.from(ctA)).not.toEqual(Array.from(ctB));
  });
});
