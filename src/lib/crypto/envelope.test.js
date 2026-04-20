import {
  encryptEnvelope,
  decryptEnvelope,
  rewrapEnvelope,
  generateDataKey,
  __internals,
} from './envelope';
import { deriveVaultKey } from './kdf';

async function makeVaultKey(fillByte = 1, saltByte = 2) {
  const master = new Uint8Array(32).fill(fillByte);
  const saltV = saltByte.toString(16).padStart(2, '0').repeat(32);
  return deriveVaultKey(master, saltV);
}

describe('envelope.generateDataKey', () => {
  test('returns 32 random bytes', () => {
    const a = generateDataKey();
    const b = generateDataKey();
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe('envelope round-trip', () => {
  test('decryptEnvelope returns the plaintext and the same DK', async () => {
    const vk = await makeVaultKey();
    const dk = generateDataKey();
    const data = {
      version: 1,
      keys: [{ label: 'Node 1', wif: 'abc' }],
    };
    const blob = await encryptEnvelope(data, dk, vk);

    const { data: got, dk: gotDk } = await decryptEnvelope(blob, vk);
    expect(got).toEqual(data);
    expect(Array.from(gotDk)).toEqual(Array.from(dk));
  });

  test('produces a different blob on every encryption (fresh IVs)', async () => {
    const vk = await makeVaultKey();
    const dk = generateDataKey();
    const a = await encryptEnvelope({ x: 1 }, dk, vk);
    const b = await encryptEnvelope({ x: 1 }, dk, vk);
    expect(a).not.toBe(b);
  });

  test('blob carries the SYSV2 magic + version in its header', async () => {
    const vk = await makeVaultKey();
    const dk = generateDataKey();
    const blob = await encryptEnvelope({ x: 1 }, dk, vk);
    const bytes = __internals.fromBase64Url(blob);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('SYSV2');
    expect(bytes[5]).toBe(__internals.VERSION);
  });

  test('rejects invalid Data Key', async () => {
    const vk = await makeVaultKey();
    await expect(
      encryptEnvelope({ x: 1 }, new Uint8Array(16), vk)
    ).rejects.toMatchObject({ code: 'invalid_data_key' });
  });
});

describe('envelope rejection paths', () => {
  test('wrong vaultKey fails at the outer wrap (decrypt failure)', async () => {
    const vkA = await makeVaultKey(1, 1);
    const vkB = await makeVaultKey(2, 2);
    const dk = generateDataKey();
    const blob = await encryptEnvelope({ x: 1 }, dk, vkA);
    await expect(decryptEnvelope(blob, vkB)).rejects.toMatchObject({
      code: 'envelope_decrypt_failed',
    });
  });

  test('rejects tampered ciphertext bytes', async () => {
    const vk = await makeVaultKey();
    const dk = generateDataKey();
    const blob = await encryptEnvelope({ hello: 'world' }, dk, vk);
    const bytes = __internals.fromBase64Url(blob);
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = __internals.toBase64Url(bytes);
    await expect(decryptEnvelope(tampered, vk)).rejects.toMatchObject({
      code: 'envelope_decrypt_failed',
    });
  });

  test('rejects tampering of the wrapped DK region', async () => {
    const vk = await makeVaultKey();
    const dk = generateDataKey();
    const blob = await encryptEnvelope({ hello: 'world' }, dk, vk);
    const bytes = __internals.fromBase64Url(blob);
    // Flip a bit inside the wrapped_dk region
    bytes[__internals.WRAPPED_DK_OFFSET + 2] ^= 0x01;
    const tampered = __internals.toBase64Url(bytes);
    await expect(decryptEnvelope(tampered, vk)).rejects.toMatchObject({
      code: 'envelope_decrypt_failed',
    });
  });

  test('rejects a blob without the SYSV2 magic/version', async () => {
    const vk = await makeVaultKey();
    // Pad with enough bytes to clear the minimum-length check so the
    // magic check is what actually rejects.
    const bogus = __internals.toBase64Url(new Uint8Array(200));
    await expect(decryptEnvelope(bogus, vk)).rejects.toMatchObject({
      code: 'invalid_envelope_format',
    });
  });

  test('rejects a truncated blob', async () => {
    const vk = await makeVaultKey();
    const dk = generateDataKey();
    const blob = await encryptEnvelope({ x: 1 }, dk, vk);
    const truncated = blob.slice(0, 32);
    await expect(decryptEnvelope(truncated, vk)).rejects.toMatchObject({
      code: 'invalid_envelope_format',
    });
  });

  test('rejects non-string blobs', async () => {
    const vk = await makeVaultKey();
    await expect(decryptEnvelope(null, vk)).rejects.toMatchObject({
      code: 'invalid_envelope_format',
    });
  });
});

describe('envelope rewrap (password change)', () => {
  test('decrypts under the NEW vaultKey and payload bytes are unchanged', async () => {
    const oldVk = await makeVaultKey(1, 1);
    const newVk = await makeVaultKey(2, 2);
    const dk = generateDataKey();
    const data = { keys: [{ label: 'a', wif: 'x' }, { label: 'b', wif: 'y' }] };

    const blob = await encryptEnvelope(data, dk, oldVk);
    const rewrapped = await rewrapEnvelope(blob, oldVk, newVk);

    // Rewrapped must decrypt under newVk and return the same data + same DK.
    const out = await decryptEnvelope(rewrapped, newVk);
    expect(out.data).toEqual(data);
    expect(Array.from(out.dk)).toEqual(Array.from(dk));

    // Rewrapped must NO LONGER decrypt under oldVk.
    await expect(decryptEnvelope(rewrapped, oldVk)).rejects.toMatchObject({
      code: 'envelope_decrypt_failed',
    });

    // The payload ciphertext region (after PAYLOAD_OFFSET) is byte-identical
    // between the original and the rewrapped blob — that is the point of
    // an envelope rewrap.
    const origBytes = __internals.fromBase64Url(blob);
    const newBytes = __internals.fromBase64Url(rewrapped);
    expect(
      Array.from(newBytes.slice(__internals.PAYLOAD_OFFSET))
    ).toEqual(Array.from(origBytes.slice(__internals.PAYLOAD_OFFSET)));

    // The iv_payload region must also be preserved (otherwise decryption
    // under DK would fail).
    expect(
      Array.from(
        newBytes.slice(
          __internals.IV_PAYLOAD_OFFSET,
          __internals.IV_PAYLOAD_OFFSET + __internals.IV_BYTES
        )
      )
    ).toEqual(
      Array.from(
        origBytes.slice(
          __internals.IV_PAYLOAD_OFFSET,
          __internals.IV_PAYLOAD_OFFSET + __internals.IV_BYTES
        )
      )
    );
  });

  test('rewrap fails if oldVaultKey does not match', async () => {
    const vkA = await makeVaultKey(1, 1);
    const vkB = await makeVaultKey(2, 2);
    const newVk = await makeVaultKey(3, 3);
    const dk = generateDataKey();
    const blob = await encryptEnvelope({ x: 1 }, dk, vkA);
    await expect(rewrapEnvelope(blob, vkB, newVk)).rejects.toMatchObject({
      code: 'envelope_decrypt_failed',
    });
  });
});
