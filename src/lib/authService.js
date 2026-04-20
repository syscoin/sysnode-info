import { apiClient as defaultClient } from './apiClient';
import { deriveLoginKeys } from './crypto/kdf';

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

  async function logout() {
    const res = await client.post('/auth/logout');
    return res.data;
  }

  async function me() {
    const res = await client.get('/auth/me');
    return res.data;
  }

  return { register, verifyEmail, login, logout, me };
}

export const authService = createAuthService();
