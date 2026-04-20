import { encryptVault, decryptVault, __internals } from './vault';
import { deriveVaultKey } from './kdf';

async function makeKey(fillByte = 1, saltByte = 2) {
  const master = new Uint8Array(32).fill(fillByte);
  const saltV = saltByte.toString(16).padStart(2, '0').repeat(32);
  return deriveVaultKey(master, saltV);
}

describe('vault encryption', () => {
  test('round-trips an object through encrypt + decrypt', async () => {
    const key = await makeKey();
    const data = {
      version: 1,
      keys: [{ label: 'Node 1', wif: 'abc' }],
    };
    const blob = await encryptVault(data, key);

    expect(typeof blob).toBe('string');
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);

    const decoded = await decryptVault(blob, key);
    expect(decoded).toEqual(data);
  });

  test('each encryption produces a different ciphertext (fresh IV)', async () => {
    const key = await makeKey();
    const data = { foo: 'bar' };
    const a = await encryptVault(data, key);
    const b = await encryptVault(data, key);
    expect(a).not.toBe(b);
  });

  test('blob carries the SYSV1 magic prefix', async () => {
    const key = await makeKey();
    const blob = await encryptVault({ x: 1 }, key);
    const bytes = __internals.fromBase64Url(blob);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('SYSV1');
  });

  test('decrypt fails with the wrong key', async () => {
    const keyA = await makeKey(1, 1);
    const keyB = await makeKey(2, 2);
    const blob = await encryptVault({ x: 1 }, keyA);
    await expect(decryptVault(blob, keyB)).rejects.toMatchObject({
      code: 'vault_decrypt_failed',
    });
  });

  test('decrypt rejects a tampered blob', async () => {
    const key = await makeKey();
    const blob = await encryptVault({ hello: 'world' }, key);
    const bytes = __internals.fromBase64Url(blob);
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = __internals.toBase64Url(bytes);
    await expect(decryptVault(tampered, key)).rejects.toMatchObject({
      code: 'vault_decrypt_failed',
    });
  });

  test('decrypt rejects a blob without the magic prefix', async () => {
    const key = await makeKey();
    const junk = __internals.toBase64Url(new Uint8Array([9, 9, 9, 9, 9, 1, 2, 3]));
    await expect(decryptVault(junk, key)).rejects.toMatchObject({
      code: 'invalid_vault_magic',
    });
  });

  test('decrypt rejects a truncated blob', async () => {
    const key = await makeKey();
    const blob = await encryptVault({ x: 1 }, key);
    const truncated = blob.slice(0, 10);
    await expect(decryptVault(truncated, key)).rejects.toMatchObject({
      code: expect.stringMatching(/invalid_vault_magic|vault_truncated/),
    });
  });
});
