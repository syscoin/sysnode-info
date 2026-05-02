// Client-side key derivation.
//
// Contract (must match sysnode-backend/lib/kdf.js + routes/auth.js):
//
//   master   = PBKDF2-SHA512(password, NFKC(email), 600_000 iter, 32 bytes)
//   authHash = HKDF-SHA256(master, info="sysnode-auth-v1",  32 bytes)
//   vaultKey = HKDF-SHA256(master, info="sysnode-vault-v1", salt=saltV, 32 bytes)
//
// The backend never sees `master`, `password`, or `vaultKey`. It sees only
// `authHash` (hex) during register/login and the opaque AES-GCM blob during
// vault PUT/GET.
//
// Notes:
// - PBKDF2 iteration count is intentionally fixed to match the backend
//   contract. We MUST NOT change it without a coordinated migration.
// - HKDF-SHA256 with empty salt and a domain-separating `info` is a standard
//   sub-key derivation pattern (RFC 5869 §3.3).
// - `vaultKey` uses HKDF with `salt=saltV` (per-user random from the server)
//   so that two users with the same password still end up with different
//   encryption keys for their vault blobs.

import { normalizeEmail } from './normalize';

const PBKDF2_ITERATIONS = 600000;
const MASTER_BYTES = 32;
const SUBKEY_BYTES = 32;

const AUTH_INFO = 'sysnode-auth-v1';
const VAULT_INFO = 'sysnode-vault-v1';

function subtleCrypto() {
  const c =
    (typeof globalThis !== 'undefined' && globalThis.crypto) ||
    (typeof window !== 'undefined' && window.crypto);
  if (!c || !c.subtle) {
    // Tag with a stable, machine-readable code so the UI can render a
    // dedicated, actionable message (rather than fall through to the
    // generic "Something went wrong" copy). The most common cause in
    // the wild is serving the SPA over plain HTTP on a non-localhost
    // origin: `window.crypto.subtle` is only exposed in secure contexts
    // (HTTPS, or loopback addresses like http://localhost / http://127.0.0.1).
    // See https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API
    // and the "Secure Contexts" MDN reference.
    const err = new Error(
      'WebCrypto is unavailable. Serve Sysnode over HTTPS or access it via localhost/127.0.0.1 so your browser can derive your key.'
    );
    err.code = 'webcrypto_unavailable';
    throw err;
  }
  return c.subtle;
}

function encodeUtf8(text) {
  return new TextEncoder().encode(text);
}

function toHex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function zeroizeBytes(value) {
  if (value instanceof Uint8Array) {
    value.fill(0);
    return true;
  }
  return false;
}

// Strict hex-to-bytes. `parseInt(x, 16)` tolerates partial parses — e.g.
// `parseInt('Ax', 16) === 10` — which would silently coerce a malformed
// saltV into a valid byte and produce a subtly wrong vault key. We guard
// the ENTIRE input against `^[0-9a-fA-F]*$` up front so any non-hex
// character anywhere throws, rather than leaking as an opaque AES-GCM
// decrypt failure downstream. (Codex round 2 P2.)
function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new Error('invalid hex');
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Master key
// ---------------------------------------------------------------------------

export async function deriveMaster(password, email) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password is required');
  }
  const salt = encodeUtf8(normalizeEmail(email));
  if (salt.length === 0) throw new Error('email is required');

  const subtle = subtleCrypto();
  const baseKey = await subtle.importKey(
    'raw',
    encodeUtf8(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-512',
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    baseKey,
    MASTER_BYTES * 8
  );
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// HKDF subkeys
// ---------------------------------------------------------------------------

async function hkdfBytes(master, info, salt = new Uint8Array(0), length = SUBKEY_BYTES) {
  const subtle = subtleCrypto();
  const baseKey = await subtle.importKey(
    'raw',
    master,
    { name: 'HKDF' },
    false,
    ['deriveBits']
  );
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: encodeUtf8(info),
    },
    baseKey,
    length * 8
  );
  return new Uint8Array(bits);
}

export async function deriveAuthHash(master) {
  const bytes = await hkdfBytes(master, AUTH_INFO);
  try {
    return toHex(bytes);
  } finally {
    zeroizeBytes(bytes);
  }
}

// Returns a raw AES-GCM CryptoKey ready for encrypt/decrypt. The raw bytes
// are intentionally NOT exposed — once derived they live only inside the
// WebCrypto key handle for the lifetime of the session.
export async function deriveVaultKey(master, saltV) {
  const salt = typeof saltV === 'string' ? fromHex(saltV) : saltV;
  const rawKey = await hkdfBytes(master, VAULT_INFO, salt, 32);
  const subtle = subtleCrypto();
  try {
    return await subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM' },
      false, // non-extractable
      ['encrypt', 'decrypt']
    );
  } finally {
    zeroizeBytes(rawKey);
  }
}

// Convenience: register/login flow. Returns both the hex authHash and the
// master bytes (so the caller can later call deriveVaultKey(master, saltV)
// without re-running the expensive PBKDF2).
export async function deriveLoginKeys(password, email) {
  const master = await deriveMaster(password, email);
  let handoffMaster = false;
  try {
    const authHash = await deriveAuthHash(master);
    handoffMaster = true;
    return { master, authHash };
  } finally {
    if (!handoffMaster) zeroizeBytes(master);
  }
}

export const __internals = {
  PBKDF2_ITERATIONS,
  AUTH_INFO,
  VAULT_INFO,
  toHex,
  fromHex,
};
