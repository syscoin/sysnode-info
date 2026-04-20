// Vault envelope — SYSV2.
//
// ---------------------------------------------------------------------------
// Why an envelope?
// ---------------------------------------------------------------------------
//
// The simplest design ("SYSV1") encrypts the whole payload directly under
// `vaultKey = HKDF(master, saltV)`. Two problems:
//
//   1. Password change then requires re-encrypting the ENTIRE payload under
//      a new vaultKey. If the user has many keys (tens of KB of JSON), that
//      round-trip is unnecessarily large.
//
//   2. Worse, the change-password path then has a lockout window: between
//      the "server updates stored_auth" write and the "client PUTs new
//      ciphertext" write, one side or the other may fail, leaving the user
//      with a password that no longer matches the ciphertext. PR 5 will
//      close this window with a server-side atomic change — but that
//      atomic change becomes trivial only once the blob we need to swap
//      is tiny and constant-size.
//
// The envelope solves both: a random 32-byte Data Key (DK) encrypts the
// payload; `vaultKey` only encrypts (wraps) the DK. Password change
// re-wraps the DK, leaving the payload untouched. The DK is stable for
// the lifetime of the vault, so the payload's ciphertext need only
// change when the user actually edits their keys.
//
// ---------------------------------------------------------------------------
// Binary layout (pre-base64url)
// ---------------------------------------------------------------------------
//
//   offset  bytes  field
//   ------  -----  -----
//        0      5  magic = "SYSV2"
//        5      1  version = 0x02
//        6     12  iv_dk       (nonce for wrap)
//       18     48  wrapped_dk  = AES-GCM(dk=32B, vaultKey, iv_dk, aad=magic+version) = 32 + 16 tag
//       66     12  iv_payload  (nonce for payload)
//       78    ...  ciphertext  = AES-GCM(json_utf8, dk, iv_payload, aad=magic+version)  (|pt| + 16 tag)
//
// Total fixed overhead: 78 bytes. At the backend's 256 KiB PUT limit
// (262144 bytes after base64url), this leaves ~196 KB of plaintext
// headroom — enough for many thousands of MN voting keys.
//
// AAD = magic||version in BOTH inner and outer AES-GCM binds each
// ciphertext to the envelope version. An attacker cannot splice an
// SYSV1 blob's ciphertext under an SYSV2 header (or vice-versa) without
// the tag verification failing.

const MAGIC = new TextEncoder().encode('SYSV2');
const VERSION = 0x02;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DK_BYTES = 32;

const HEADER_BYTES = MAGIC.length + 1; // magic + version
const IV_DK_OFFSET = HEADER_BYTES;
const WRAPPED_DK_OFFSET = IV_DK_OFFSET + IV_BYTES;
const WRAPPED_DK_BYTES = DK_BYTES + TAG_BYTES;
const IV_PAYLOAD_OFFSET = WRAPPED_DK_OFFSET + WRAPPED_DK_BYTES;
const PAYLOAD_OFFSET = IV_PAYLOAD_OFFSET + IV_BYTES;

function subtleCrypto() {
  const c =
    (typeof globalThis !== 'undefined' && globalThis.crypto) ||
    (typeof window !== 'undefined' && window.crypto);
  if (!c || !c.subtle) {
    throw new Error('WebCrypto is unavailable.');
  }
  return c;
}

function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function aad() {
  const out = new Uint8Array(HEADER_BYTES);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  return out;
}

function matchesMagic(bytes) {
  if (bytes.length < HEADER_BYTES) return false;
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) return false;
  }
  return bytes[MAGIC.length] === VERSION;
}

// base64url (no padding) encode/decode. Kept local to this module so the
// envelope format is self-contained.
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
  if (typeof str !== 'string') throw envelopeError('invalid_envelope_format');
  const padLen = (4 - (str.length % 4)) % 4;
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  if (typeof atob === 'function') {
    let bin;
    try {
      bin = atob(b64);
    } catch (_) {
      throw envelopeError('invalid_envelope_format');
    }
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  try {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  } catch (_) {
    throw envelopeError('invalid_envelope_format');
  }
}

function envelopeError(code, cause) {
  const err = new Error(code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

// ---------------------------------------------------------------------------
// AES-GCM raw-key helpers
//
// The DK is 32 random bytes, not a CryptoKey. We import it as a non-
// extractable AES-GCM key only for the duration of a single encrypt or
// decrypt call — passing a CryptoKey reference up to a caller would make
// the DK hard to zeroize later.
// ---------------------------------------------------------------------------

async function importDkForGcm(dkBytes) {
  const c = subtleCrypto();
  return c.subtle.importKey(
    'raw',
    dkBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Generate a fresh 32-byte Data Key. Caller typically creates this ONCE
// per vault (on the first save) and re-uses it for subsequent saves; the
// DK only rotates if the user explicitly asks to re-key.
export function generateDataKey() {
  const c = subtleCrypto();
  return c.getRandomValues(new Uint8Array(DK_BYTES));
}

// Encrypt a JSON-serializable payload under `dk`, wrap `dk` under
// `vaultKey`, and return the base64url blob to store on the server.
//
//   plaintext  : any JSON-stringifiable value
//   dk         : Uint8Array(32)    — Data Key (from `generateDataKey`)
//   vaultKey   : CryptoKey         — AES-GCM wrap key from `deriveVaultKey`
export async function encryptEnvelope(plaintext, dk, vaultKey) {
  if (!(dk instanceof Uint8Array) || dk.length !== DK_BYTES) {
    throw envelopeError('invalid_data_key');
  }
  const c = subtleCrypto();
  const ivDk = c.getRandomValues(new Uint8Array(IV_BYTES));
  const ivPayload = c.getRandomValues(new Uint8Array(IV_BYTES));
  const additionalData = aad();

  const wrappedDk = new Uint8Array(
    await c.subtle.encrypt(
      { name: 'AES-GCM', iv: ivDk, additionalData },
      vaultKey,
      dk
    )
  );

  const dkGcmKey = await importDkForGcm(dk);
  const ptBytes = new TextEncoder().encode(JSON.stringify(plaintext));
  const payload = new Uint8Array(
    await c.subtle.encrypt(
      { name: 'AES-GCM', iv: ivPayload, additionalData },
      dkGcmKey,
      ptBytes
    )
  );

  return toBase64Url(
    concatBytes(additionalData, ivDk, wrappedDk, ivPayload, payload)
  );
}

// Decrypt a blob produced by `encryptEnvelope`. Returns BOTH the parsed
// plaintext and the Data Key bytes — the caller typically stashes the DK
// to encrypt subsequent edits without re-deriving anything.
//
// Throws with `.code` in:
//   invalid_envelope_format   — bad base64url / too short / bad magic
//   envelope_decrypt_failed   — AES-GCM auth failure (wrong key or tamper)
//   envelope_invalid_json     — DK verified but plaintext is not JSON
export async function decryptEnvelope(blob, vaultKey) {
  const all = fromBase64Url(blob);
  if (all.length < PAYLOAD_OFFSET + TAG_BYTES) {
    throw envelopeError('invalid_envelope_format');
  }
  if (!matchesMagic(all)) {
    throw envelopeError('invalid_envelope_format');
  }

  const additionalData = aad();
  const ivDk = all.slice(IV_DK_OFFSET, IV_DK_OFFSET + IV_BYTES);
  const wrappedDk = all.slice(WRAPPED_DK_OFFSET, WRAPPED_DK_OFFSET + WRAPPED_DK_BYTES);
  const ivPayload = all.slice(IV_PAYLOAD_OFFSET, IV_PAYLOAD_OFFSET + IV_BYTES);
  const payload = all.slice(PAYLOAD_OFFSET);

  const c = subtleCrypto();
  let dkBytes;
  try {
    dkBytes = new Uint8Array(
      await c.subtle.decrypt(
        { name: 'AES-GCM', iv: ivDk, additionalData },
        vaultKey,
        wrappedDk
      )
    );
  } catch (e) {
    throw envelopeError('envelope_decrypt_failed', e);
  }

  let ptBytes;
  try {
    const dkGcmKey = await importDkForGcm(dkBytes);
    ptBytes = new Uint8Array(
      await c.subtle.decrypt(
        { name: 'AES-GCM', iv: ivPayload, additionalData },
        dkGcmKey,
        payload
      )
    );
  } catch (e) {
    throw envelopeError('envelope_decrypt_failed', e);
  }

  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(ptBytes));
  } catch (e) {
    throw envelopeError('envelope_invalid_json', e);
  }

  return { data, dk: dkBytes };
}

// Re-wrap an existing Data Key under a new vaultKey, keeping the encrypted
// payload BYTE-IDENTICAL. Used by change-password: we swap the outer wrap
// without rewriting the (potentially large) payload ciphertext.
//
// Returns the new base64url blob.
export async function rewrapEnvelope(blob, oldVaultKey, newVaultKey) {
  const { dk } = await decryptEnvelope(blob, oldVaultKey);
  // Re-read the original payload + iv_payload so we preserve them
  // verbatim — we only re-create the wrap half.
  const all = fromBase64Url(blob);
  const ivPayload = all.slice(IV_PAYLOAD_OFFSET, IV_PAYLOAD_OFFSET + IV_BYTES);
  const payload = all.slice(PAYLOAD_OFFSET);

  const c = subtleCrypto();
  const additionalData = aad();
  const ivDk = c.getRandomValues(new Uint8Array(IV_BYTES));
  const wrappedDk = new Uint8Array(
    await c.subtle.encrypt(
      { name: 'AES-GCM', iv: ivDk, additionalData },
      newVaultKey,
      dk
    )
  );

  return toBase64Url(
    concatBytes(additionalData, ivDk, wrappedDk, ivPayload, payload)
  );
}

export const __internals = {
  MAGIC,
  VERSION,
  IV_BYTES,
  TAG_BYTES,
  DK_BYTES,
  HEADER_BYTES,
  IV_DK_OFFSET,
  WRAPPED_DK_OFFSET,
  WRAPPED_DK_BYTES,
  IV_PAYLOAD_OFFSET,
  PAYLOAD_OFFSET,
  toBase64Url,
  fromBase64Url,
  aad,
};
