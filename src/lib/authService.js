import { apiClient as defaultClient } from './apiClient';
import { deriveLoginKeys, deriveMaster, deriveAuthHash } from './crypto/kdf';

// High-level façade for the auth surface.
//
// The UI imports from here so it never has to know about:
//   - the fact that authHash is client-derived from password+email via
//     PBKDF2(600k)+HKDF, or
//   - the exact HTTP endpoints / error-code contract.
//
// The `client` parameter exists purely for dependency injection in tests.
// Production code should use the default export, which is bound to the
// shared apiClient (and therefore the shared 401 interceptor).

export function createAuthService(client = defaultClient) {
  async function register(email, password) {
    const { authHash } = await deriveLoginKeys(password, email);
    const res = await client.post('/auth/register', {
      email: email.trim(),
      authHash,
    });
    return res.data;
  }

  async function verifyEmail(token) {
    const res = await client.post('/auth/verify-email', { token });
    return res.data;
  }

  async function login(email, password) {
    // We surface `master` back to the caller so the Login page can hand
    // it straight to the VaultContext for auto-unlock — otherwise the
    // vault would have to re-run PBKDF2-600k after a successful login
    // just to derive the same bytes we already have in hand. `master` is
    // transient: the AuthContext does not persist it anywhere; the
    // VaultContext derives vaultKey from it inside a non-extractable
    // CryptoKey and drops the raw bytes immediately after.
    //
    // NEVER log or JSON-stringify the returned object into anything
    // persistent — it contains raw key material until it's been consumed.
    const { authHash, master } = await deriveLoginKeys(password, email);
    const res = await client.post('/auth/login', {
      email: email.trim(),
      authHash,
    });
    return { ...res.data, master };
  }

  async function completeTotpLogin({ challengeToken, code, recoveryCode }) {
    const body = { challengeToken };
    if (code) body.code = code;
    if (recoveryCode) body.recoveryCode = recoveryCode;
    const res = await client.post('/auth/login/totp', body);
    return res.data;
  }

  async function logout() {
    const res = await client.post('/auth/logout');
    return res.data;
  }

  async function me() {
    const res = await client.get('/auth/me');
    return res.data;
  }

  // ------------------------------------------------------------------
  // PR 7 — change password (with atomic vault rewrap)
  // ------------------------------------------------------------------
  //
  // The browser is responsible for all crypto. To keep the orchestration
  // in the component (which has access to BOTH useAuth() and useVault()
  // hooks), we expose two separate primitives:
  //
  //   1. deriveChangePasswordKeys(oldPassword, newPassword, email)
  //        – runs PBKDF2(600k) twice to produce:
  //            { oldAuthHash, newAuthHash, newMaster }
  //          The caller uses `newMaster` to have VaultContext rewrap
  //          the blob BEFORE the POST.
  //
  //   2. changePassword({ oldAuthHash, newAuthHash, vault? })
  //        – thin POST wrapper. Returns the server body as-is
  //          ({ status, expiresAt, newVaultEtag? }).
  //
  // Splitting it this way preserves the "authService is blind to vault
  // state" invariant: authService never touches the rewrap output
  // beyond forwarding the already-rewrapped (blob, ifMatch) pair to
  // the server.
  //
  // The API contract — what the backend expects in the POST body —
  // is documented in sysnode-backend/routes/auth.js:ChangePasswordSchema.
  async function deriveChangePasswordKeys(oldPassword, newPassword, email) {
    const oldKeys = await deriveLoginKeys(oldPassword, email);
    const newMaster = await deriveMaster(newPassword, email);
    const newAuthHash = await deriveAuthHash(newMaster);
    return {
      oldAuthHash: oldKeys.authHash,
      newAuthHash,
      newMaster,
    };
  }

  async function changePassword({ oldAuthHash, newAuthHash, vault }) {
    if (typeof oldAuthHash !== 'string' || oldAuthHash.length === 0) {
      throw new Error('changePassword: oldAuthHash required');
    }
    if (typeof newAuthHash !== 'string' || newAuthHash.length === 0) {
      throw new Error('changePassword: newAuthHash required');
    }
    const body = { oldAuthHash, newAuthHash };
    if (vault) {
      if (typeof vault.blob !== 'string' || vault.blob.length === 0) {
        throw new Error('changePassword: vault.blob required');
      }
      if (typeof vault.ifMatch !== 'string' || vault.ifMatch.length === 0) {
        throw new Error('changePassword: vault.ifMatch required');
      }
      body.vault = { blob: vault.blob, ifMatch: vault.ifMatch };
    }
    const res = await client.post('/auth/change-password', body);
    return res.data;
  }

  async function deriveStepUpAuthHash(password, email) {
    const { master, authHash } = await deriveLoginKeys(password, email);
    if (master instanceof Uint8Array) master.fill(0);
    return authHash;
  }

  // ------------------------------------------------------------------
  // PR 7 — notification preferences
  // ------------------------------------------------------------------

  async function getPrefs() {
    const res = await client.get('/auth/prefs');
    return res.data.notificationPrefs || {};
  }

  // PUT /auth/prefs is a whole-document overwrite of the whitelisted
  // namespaces (see backend comments). The server validates shape via
  // zod; anything this call sends that isn't whitelisted produces a
  // 400. We echo the server's normalized response so callers can
  // update local state without a follow-up GET.
  async function updatePrefs(prefs) {
    const res = await client.put('/auth/prefs', prefs || {});
    return res.data.notificationPrefs || {};
  }

  async function getTotpStatus() {
    const res = await client.get('/auth/totp');
    return res.data;
  }

  async function beginTotpSetup(oldAuthHash) {
    const res = await client.post('/auth/totp/setup', { oldAuthHash });
    return res.data;
  }

  async function enableTotp({ code, oldAuthHash }) {
    const res = await client.post('/auth/totp/enable', { code, oldAuthHash });
    return res.data;
  }

  async function disableTotp(code) {
    const res = await client.post('/auth/totp/disable', { code });
    return res.data;
  }

  // ------------------------------------------------------------------
  // PR 7 — account deletion (GDPR right to erasure)
  // ------------------------------------------------------------------
  //
  // The caller derives `oldAuthHash` from the user's current password
  // via deriveLoginKeys, same as /login. This re-proves possession of
  // the password (a stolen session alone is not enough to nuke an
  // account). On success the server returns 204 and clears sid+csrf
  // cookies; this facade returns `true` so the UI can `await` a
  // boolean-ish result rather than destructuring an empty body.
  //
  // The DELETE verb is important: browsers preflight it as CORS-
  // non-simple, which means misconfigured cross-origin embedders
  // can't silently fire a destructive request without the app's
  // allowlist explicitly permitting it.
  async function deleteAccount({ oldAuthHash }) {
    if (typeof oldAuthHash !== 'string' || oldAuthHash.length === 0) {
      throw new Error('deleteAccount: oldAuthHash required');
    }
    await client.delete('/auth/account', { data: { oldAuthHash } });
    return true;
  }

  return {
    register,
    verifyEmail,
    login,
    completeTotpLogin,
    logout,
    me,
    deriveChangePasswordKeys,
    deriveStepUpAuthHash,
    changePassword,
    getPrefs,
    updatePrefs,
    getTotpStatus,
    beginTotpSetup,
    enableTotp,
    disableTotp,
    deleteAccount,
  };
}

export const authService = createAuthService();
