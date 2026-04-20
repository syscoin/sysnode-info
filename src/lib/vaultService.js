import { apiClient as defaultClient } from './apiClient';

// Thin transport layer for the `/vault` endpoints. Keeps callers ignorant
// of axios / ETag bookkeeping. Envelope encode/decode lives in
// `./crypto/envelope` — this file only handles the HTTP round-trip and the
// "turn the backend's error codes into usable client-side errors" mapping.
//
// Backend contract (from sysnode-backend/routes/vault.js):
//
//   GET  /vault                    -> 200 { saltV, blob, etag, updatedAt }
//                                     200 { empty: true }
//   PUT  /vault  If-Match: <etag>  -> 200 { saltV, etag }            // update
//   PUT  /vault  If-Match: *       -> 200 { saltV, etag }            // first write
//
// PUT error responses (all with { error: <code> }):
//
//   400 invalid_body        | invalid_blob
//   412 precondition_failed (ETag mismatch — someone else wrote first)
//   413 payload_too_large   (blob > 256 KiB)
//   428 if_match_required   (attempted update without a header)
//
// The service normalises all of those to a thrown Error with the
// `code` field, so the VaultContext state machine can switch on strings
// instead of HTTP statuses.

const VAULT_PATH = '/vault';

function vaultError(code, status, cause) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  if (cause) e.cause = cause;
  return e;
}

export function createVaultService(client = defaultClient) {
  async function load() {
    try {
      const res = await client.get(VAULT_PATH);
      if (res.data && res.data.empty) {
        return { empty: true };
      }
      // Defensive parse — any missing field means the server responded
      // with something other than the documented shape.
      const { saltV, blob, etag, updatedAt } = res.data || {};
      if (typeof saltV !== 'string' || !saltV) {
        throw vaultError('invalid_vault_response', 0);
      }
      if (typeof blob !== 'string' || !blob) {
        throw vaultError('invalid_vault_response', 0);
      }
      if (typeof etag !== 'string' || !etag) {
        throw vaultError('invalid_vault_response', 0);
      }
      return { empty: false, saltV, blob, etag, updatedAt: updatedAt || 0 };
    } catch (err) {
      // apiClient has already normalised into { code, status }; re-raise.
      if (err && err.code) throw err;
      throw vaultError('network_error', 0, err);
    }
  }

  // PUT the vault. `ifMatch` MUST be either:
  //   - a valid ETag string (update path)
  //   - '*' or undefined (first write; the backend treats missing If-Match
  //     as "ok, this is the first write" iff no row exists).
  async function save({ blob, ifMatch }) {
    if (typeof blob !== 'string' || blob.length === 0) {
      throw vaultError('invalid_blob', 0);
    }
    const headers = {};
    if (ifMatch) headers['If-Match'] = ifMatch;
    try {
      const res = await client.put(VAULT_PATH, { blob }, { headers });
      return res.data; // { saltV, etag }
    } catch (err) {
      if (!err || !err.code) {
        throw vaultError('network_error', 0, err);
      }
      // Map backend codes to stable client codes. The names are kept
      // symmetric with the backend so logs / support escalations share
      // vocabulary.
      switch (err.code) {
        case 'precondition_failed':
          throw vaultError('vault_stale', err.status, err);
        case 'if_match_required':
          throw vaultError('vault_if_match_required', err.status, err);
        case 'payload_too_large':
          throw vaultError('vault_too_large', err.status, err);
        case 'invalid_blob':
        case 'invalid_body':
          throw vaultError('invalid_blob', err.status, err);
        default:
          throw err; // pass-through (401 → apiClient handles, etc.)
      }
    }
  }

  return { load, save };
}

export const vaultService = createVaultService();
