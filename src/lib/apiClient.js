import axios from 'axios';

// Dedicated axios instance for the authenticated sysnode API surface
// (`/auth/*`, `/vault/*`). Kept separate from the legacy anonymous client
// in `./api.js` because:
//
//   1. This one MUST set `withCredentials: true` so the httpOnly session
//      cookie and the non-httpOnly csrf cookie round-trip correctly. The
//      legacy client talks to public endpoints that never see cookies.
//
//   2. It auto-attaches `X-CSRF-Token` on every state-changing request,
//      reading the value from the `csrf` cookie the backend set on login.
//      The backend's double-submit CSRF middleware rejects state-changing
//      requests that don't carry the header.
//
//   3. It routes 401 Unauthorized responses to a single `onAuthLost`
//      callback so the AuthContext can react (clear the cached user,
//      redirect to /login) without every caller having to handle the
//      case individually.

const DEFAULT_BASE =
  process.env.REACT_APP_API_BASE ||
  (typeof window !== 'undefined' && window.location && window.location.origin
    ? window.location.origin
    : 'http://localhost:3001');

const STATE_CHANGING = /^(POST|PUT|PATCH|DELETE)$/i;

function readCsrfCookie() {
  if (typeof document === 'undefined' || !document.cookie) return null;
  // Pairs like "csrf=abc; other=value" — split on "; " to handle modern
  // browsers, fall back to ";" for older serializers.
  const parts = document.cookie.split(/;\s*/);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    if (p.slice(0, eq) === 'csrf') {
      return decodeURIComponent(p.slice(eq + 1));
    }
  }
  return null;
}

// Normalise axios errors into a predictable object the UI can render
// without switching on HTTP status codes. We intentionally expose both the
// raw status and the backend's `error` code so pages can choose whichever
// they need.
function toApiError(err) {
  if (err && err.response) {
    const { status, data } = err.response;
    const code =
      (data && typeof data === 'object' && (data.error || data.code)) ||
      'http_error';
    const e = new Error(code);
    e.code = code;
    e.status = status;
    e.details = data && data.details ? data.details : null;
    e.response = err.response;
    return e;
  }
  // Network / timeout / aborted before a response.
  const e = new Error('network_error');
  e.code = 'network_error';
  e.status = 0;
  e.cause = err;
  return e;
}

export function createApiClient({
  baseURL = DEFAULT_BASE,
  readCsrf = readCsrfCookie,
  onAuthLost,
} = {}) {
  const instance = axios.create({
    baseURL,
    withCredentials: true,
    timeout: 20000,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=UTF-8',
    },
  });

  instance.interceptors.request.use(function attachCsrf(config) {
    if (STATE_CHANGING.test(config.method || '')) {
      const token = readCsrf();
      if (token) {
        config.headers = { ...(config.headers || {}), 'X-CSRF-Token': token };
      }
    }
    return config;
  });

  instance.interceptors.response.use(
    function passthrough(res) {
      return res;
    },
    function normalise(error) {
      const apiError = toApiError(error);
      if (apiError.status === 401 && typeof onAuthLost === 'function') {
        // Don't fire on the auth endpoints themselves — a 401 on /login is
        // a credential error, not a session expiry.
        const url = (error.config && error.config.url) || '';
        if (!url.startsWith('/auth/')) {
          try {
            onAuthLost(apiError);
          } catch (_) {
            // Never let the callback break the error path.
          }
        }
      }
      return Promise.reject(apiError);
    }
  );

  return instance;
}

// Mutable slot for the global auth-loss handler.
//
// The default singleton `apiClient` is created at module import time —
// long before any React component (and therefore before AuthContext)
// has mounted. If we baked `onAuthLost` into that `createApiClient()`
// call directly, the closure would capture `undefined` and every 401
// on a protected endpoint (e.g. `/vault`) would be silently dropped,
// leaving the UI in a stale "authenticated" state until the user did
// something that hit /auth/me. (Codex round 2 P2.)
//
// Instead, the singleton's onAuthLost is a thunk that reads this slot
// at error-dispatch time. AuthProvider registers its handler via
// `setAuthLostHandler` once it mounts; the slot is cleared on
// unmount so stale providers can't fire.
let globalAuthLost = null;

export function setAuthLostHandler(fn) {
  globalAuthLost = typeof fn === 'function' ? fn : null;
}

// Default module-level client, used by simple call sites. Tests and pages
// that want to inject a mock should call `createApiClient` directly.
export const apiClient = createApiClient({
  onAuthLost: function dispatchAuthLost(err) {
    if (typeof globalAuthLost === 'function') globalAuthLost(err);
  },
});

export { readCsrfCookie, toApiError };
