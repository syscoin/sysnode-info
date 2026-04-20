// Vault payload format (v1):
//
//   base64url(
//     "SYSV1"        // 5-byte magic
//     | iv (12 bytes)
//     | ciphertext (|plaintext| bytes)
//     | tag (16 bytes, appended by AES-GCM)
//   )
//
// The plaintext is a UTF-8 JSON-serializable object. The server stores the
// resulting base64url string verbatim; it is never decrypted server-side.
//
// Design notes:
// - AES-GCM is used (authenticated encryption). 12-byte IV is the GCM default
//   and matches WebCrypto convention.
// - base64url (no padding) keeps the blob HTTP-cookie/URL-safe and avoids
//   needing JSON escape on the outer transport.
// - The magic prefix lets future versions (e.g. v2 with a different KDF or
//   cipher) be detected without ambiguity, and catches "someone pasted a
//   non-vault string into the PUT body" accidents.
// - The AES-GCM key comes from `deriveVaultKey` in `./kdf`; this module
//   never touches the user's password directly.

const MAGIC = new TextEncoder().encode('SYSV1');
const IV_BYTES = 12;

function subtleCrypto() {
  const c =
    (typeof globalThis !== 'undefined' && globalThis.crypto) ||
    (typeof window !== 'undefined' && window.crypto);
  if (!c || !c.subtle) {
    throw new Error('WebCrypto is unavailable.');
  }
  return c;
}

function concat(a, b, c) {
  const out = new Uint8Array(a.length + b.length + c.length);
  out.set(a, 0);
  out.set(b, a.length);
  out.set(c, a.length + b.length);
  return out;
}

// base64url without padding.
function toBase64Url(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i += 1) {
    str += String.fromCharCode(bytes[i]);
  }
  const b64 =
    typeof btoa === 'function'
      ? btoa(str)
      : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  if (typeof str !== 'string') throw new Error('blob must be a string');
  const padLen = (4 - (str.length % 4)) % 4;
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function matchesMagic(bytes) {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Encrypt the vault data (arbitrary JSON-safe object) with the caller-provided
// AES-GCM CryptoKey (produced by `deriveVaultKey`). Returns a base64url string
// suitable for the `PUT /vault` body.
export async function encryptVault(plaintextObject, aesGcmKey) {
  const c = subtleCrypto();
  const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(plaintextObject));
  const ctWithTag = new Uint8Array(
    await c.subtle.encrypt({ name: 'AES-GCM', iv }, aesGcmKey, plaintext)
  );
  return toBase64Url(concat(MAGIC, iv, ctWithTag));
}

// Decrypt a blob produced by `encryptVault`. Returns the parsed JSON value.
// Throws on magic mismatch, truncation, or AES-GCM authentication failure
// (e.g. wrong key, tampered blob).
export async function decryptVault(blob, aesGcmKey) {
  const all = fromBase64Url(blob);
  if (!matchesMagic(all)) {
    const err = new Error('invalid_vault_magic');
    err.code = 'invalid_vault_magic';
    throw err;
  }
  if (all.length < MAGIC.length + IV_BYTES + 16) {
    const err = new Error('vault_truncated');
    err.code = 'vault_truncated';
    throw err;
  }
  const iv = all.slice(MAGIC.length, MAGIC.length + IV_BYTES);
  const ctWithTag = all.slice(MAGIC.length + IV_BYTES);

  const c = subtleCrypto();
  let pt;
  try {
    pt = await c.subtle.decrypt({ name: 'AES-GCM', iv }, aesGcmKey, ctWithTag);
  } catch (e) {
    const err = new Error('vault_decrypt_failed');
    err.code = 'vault_decrypt_failed';
    throw err;
  }
  try {
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    const err = new Error('vault_invalid_json');
    err.code = 'vault_invalid_json';
    throw err;
  }
}

export const __internals = { toBase64Url, fromBase64Url, MAGIC, IV_BYTES };
