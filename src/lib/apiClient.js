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

// Default API base URL.
//
// Priority:
//   1. REACT_APP_API_BASE (build-time override for bespoke deployments)
//   2. Production builds → same-origin relative paths. Production must
//      reverse-proxy /auth, /vault, and /gov under the SPA origin so
//      host-only SameSite=Lax cookies and the readable csrf cookie work
//      without cross-site credentialed fetches.
//   3. Development builds → http://localhost:3001 (backend dev server)
export function resolveDefaultApiBase({
  apiBase = process.env.REACT_APP_API_BASE,
  nodeEnv = process.env.NODE_ENV,
} = {}) {
  if (apiBase) return apiBase;
  return nodeEnv === 'production' ? '' : 'http://localhost:3001';
}

const DEFAULT_BASE = resolveDefaultApiBase();

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

// Parse RFC 7231 Retry-After plus the draft RateLimit-Reset header that
// express-rate-limit emits under `standardHeaders: true`. Returns
// milliseconds from "now", or null if neither header is usable.
//
// Order of precedence:
//   1. Retry-After (preferred — explicit "don't retry before")
//        - integer seconds ("120")
//        - HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT")
//   2. RateLimit-Reset (fallback)
//        - seconds-until-reset for the current window
//
// Anything that parses negative or non-finite clamps to null so the UI
// can fall back to its own default delay instead of an impossible
// "retry 4 seconds ago" countdown.
function parseRetryAfter(headers) {
  if (!headers || typeof headers !== 'object') return null;
  // Build a case-insensitive lookup. axios tends to normalise to
  // lowercase on modern versions but adapters / proxies / test
  // mocks can preserve canonical casing ("Retry-After") or even
  // all-caps. Scanning once is cheap relative to the request.
  const ci = {};
  for (const k of Object.keys(headers)) {
    ci[k.toLowerCase()] = headers[k];
  }
  const getHeader = (name) => {
    const v = ci[name.toLowerCase()];
    if (Array.isArray(v)) return v[0];
    return v;
  };

  const retryAfter = getHeader('retry-after');
  if (typeof retryAfter === 'string' && retryAfter.length > 0) {
    const asNum = Number(retryAfter);
    if (Number.isFinite(asNum) && asNum >= 0) {
      return Math.floor(asNum * 1000);
    }
    // HTTP-date form.
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) {
      const delta = asDate - Date.now();
      return delta > 0 ? delta : 0;
    }
  }

  const reset = getHeader('ratelimit-reset');
  if (typeof reset === 'string' && reset.length > 0) {
    const secs = Number(reset);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.floor(secs * 1000);
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
    const { status, data, headers } = err.response;
    const code =
      (data && typeof data === 'object' && (data.error || data.code)) ||
      'http_error';
    const e = new Error(code);
    e.code = code;
    e.status = status;
    e.details = data && data.details ? data.details : null;
    e.response = err.response;
    // Only surface retryAfterMs for the statuses that semantically
    // carry a "wait before retry" hint. Avoids accidentally
    // forwarding stray Retry-After headers on non-throttled 4xx/5xx.
    if (status === 429 || status === 503) {
      const retryAfterMs = parseRetryAfter(headers);
      if (retryAfterMs != null) e.retryAfterMs = retryAfterMs;
    }
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
  // Do NOT set a global `Content-Type` here. Axios places headers from
  // `create({ headers })` into its `common` bag, which is merged into
  // EVERY request — including GETs with no body. Cross-origin deployments
  // (REACT_APP_API_BASE pointing off-origin) treat any GET with a custom
  // Content-Type as a non-simple CORS request and must first preflight
  // it, so `/auth/me` on boot would fail outright if the API's OPTIONS
  // response didn't whitelist Content-Type. Axios already sets the JSON
  // content-type for POST/PUT/PATCH automatically when the body is an
  // object, so dropping the global here loses nothing.
  //
  // (Codex round 3 P2.)
  const instance = axios.create({
    baseURL,
    withCredentials: true,
    timeout: 20000,
    headers: {
      Accept: 'application/json, text/plain, */*',
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
        // Don't fire on auth endpoints that are expected to return
        // credential errors, such as /auth/login. /auth/verify-password is
        // the one exception: invalid_credentials is a local step-up failure,
        // but any other 401 means the authenticated session is gone and the
        // global auth-loss path should run.
        const url = (error.config && error.config.url) || '';
        const isAuthEndpoint = url.startsWith('/auth/');
        const isVerifyPassword = url.startsWith('/auth/verify-password');
        const isVerifyPasswordMismatch =
          isVerifyPassword && apiError.code === 'invalid_credentials';
        if (
          !isAuthEndpoint ||
          (isVerifyPassword && !isVerifyPasswordMismatch)
        ) {
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

export { readCsrfCookie, toApiError, parseRetryAfter };
