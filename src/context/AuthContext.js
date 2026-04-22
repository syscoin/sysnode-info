import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { authService as defaultAuthService } from '../lib/authService';
import { setAuthLostHandler } from '../lib/apiClient';

// AuthContext shape:
//
//   status: 'booting' | 'anonymous' | 'authenticated'
//   user:   null | { id, email, emailVerified, notificationPrefs, saltV }
//   login({ email, password })       -> resolves to { user, master } on success
//   register({ email, password })    -> { status: 'verification_sent' }
//   verifyEmail(token)               -> { status: 'verified' }
//   logout()                         -> null
//   refresh()                        -> reloads /auth/me silently
//
// `booting` is the pre-first-load state while we wait for /auth/me to tell
// us whether the user already has a live session. Guards, nav chrome, etc.
// should render a neutral skeleton while booting to avoid flicker between
// "Login" and "Account" buttons on reload.
//
// Every handler throws an Error whose `.code` matches the backend's error
// codes (e.g. 'invalid_credentials', 'email_not_verified', 'email_taken',
// 'already_verified', 'invalid_or_expired_token', 'server_misconfigured').
// Pages should prefer switching on `.code` over matching message strings.

const AuthContext = createContext(null);

const BOOTING = 'booting';
const ANONYMOUS = 'anonymous';
const AUTHENTICATED = 'authenticated';

export function AuthProvider({ children, authService = defaultAuthService }) {
  const [status, setStatus] = useState(BOOTING);
  const [user, setUser] = useState(null);
  // `sessionExpired` is true when a live signed-in session was
  // silently invalidated by the server (cookie expired, backend
  // revoked it, etc) and we detected that via the apiClient's 401
  // interceptor. Kept as a separate flag from `status` so callers
  // can distinguish three distinct transitions to ANONYMOUS:
  //
  //   * BOOTING → ANONYMOUS       : fresh visitor, no session to
  //                                 announce the loss of. NEVER
  //                                 sets sessionExpired.
  //   * AUTHENTICATED → ANONYMOUS : either user clicked "Sign out"
  //                                 (leave sessionExpired=false —
  //                                 they KNOW they signed out),
  //                                 OR an apiClient 401 forced the
  //                                 transition (set
  //                                 sessionExpired=true so the app
  //                                 can surface a "your session
  //                                 expired" banner/toast instead
  //                                 of silently logging them out).
  //   * ANONYMOUS → ANONYMOUS     : no-op, keep whatever the flag
  //                                 was (handleAuthLost firing on
  //                                 an already-anonymous probe is
  //                                 not a new signal).
  //
  // The banner / toast UI renders on the boolean; dismissing it
  // only clears the boolean (does NOT re-authenticate).
  const [sessionExpired, setSessionExpired] = useState(false);

  // Mirror `status` into a ref so `handleAuthLost` can read the
  // current value without having to list `status` as a dependency
  // (which would re-memoize the callback on every auth transition
  // and churn the apiClient's registered handler). The ref is
  // updated inside a layout-free useEffect that tracks `status`.
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Guards against setting state after unmount, for pages that call
  // auth methods from effects during navigation.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  // Request-generation counter. Every async operation that would change
  // auth state (refresh / login / logout / handleAuthLost) captures the
  // counter value at its START and only writes state if the value is
  // unchanged at its END. Any newer operation bumps the counter, which
  // atomically invalidates all in-flight older operations.
  //
  // This fixes the slow-network race originally caught in PR review
  // (Codex round 1 P1): a mount-time /auth/me that takes several seconds
  // to return 401 would otherwise kick a freshly-logged-in user back to
  // /login when its failure path unconditionally forced ANONYMOUS.
  const genRef = useRef(0);
  const nextGen = useCallback(() => {
    genRef.current += 1;
    return genRef.current;
  }, []);

  const safeSet = useCallback((fn, myGen) => {
    if (!mountedRef.current) return;
    // If `myGen` is supplied, this write is scoped to a particular async
    // operation and must no-op once a newer operation has started.
    if (typeof myGen === 'number' && myGen !== genRef.current) return;
    fn();
  }, []);

  const refresh = useCallback(async () => {
    const myGen = nextGen();
    try {
      const { user: u } = await authService.me();
      safeSet(() => {
        setUser(u);
        setStatus(AUTHENTICATED);
      }, myGen);
      return u;
    } catch (err) {
      safeSet(() => {
        setUser(null);
        setStatus(ANONYMOUS);
      }, myGen);
      // 401 is expected (no session) — don't re-throw that.
      if (err.status === 401) return null;
      throw err;
    }
  }, [authService, safeSet, nextGen]);

  useEffect(() => {
    refresh().catch(() => {
      // Swallowed: refresh() already set ANONYMOUS on failure.
    });
  }, [refresh]);

  const login = useCallback(
    async ({ email, password }) => {
      // Do NOT claim a generation before awaiting `authService.login`.
      // Bumping up-front would invalidate a still-in-flight mount-time
      // refresh even when credentials turn out to be rejected — the
      // refresh's eventual ANONYMOUS write would then be discarded as
      // stale and the app could stay stuck in `booting` on top of the
      // failed-login error. (Codex round 3 P1.)
      //
      // Only claim the gen once we know login actually succeeded;
      // anything that throws out of authService.login falls through
      // with the pre-login gen intact, so the mount refresh still
      // lands the correct (anonymous) state.
      const res = await authService.login(email, password);
      // `master` is the PBKDF2 output for password+email. We do not
      // store it in React state — it stays on the stack, flows through
      // to the caller's return value (Login page → VaultContext
      // auto-unlock), and is dropped after one tick.
      const master = res && res.master;
      const myGen = nextGen();
      // /auth/login returns the shallow user; hit /auth/me to pick up
      // emailVerified + notificationPrefs in one canonical shape.
      try {
        const me = await authService.me();
        safeSet(() => {
          setUser(me.user);
          setStatus(AUTHENTICATED);
          // Successful sign-in clears any stale session-expired
          // banner — it was true BECAUSE the user lost the previous
          // session; re-authenticating makes the banner stale.
          setSessionExpired(false);
        }, myGen);
        return { ...me, master };
      } catch (err) {
        // 401 here means the Set-Cookie from /auth/login didn't stick
        // — browser SameSite/secure policy, cross-origin third-party
        // cookie blocking, etc. Pretending we're authenticated just
        // unlocks protected routes that the very next server call
        // will 401 on. Propagate as a real auth failure instead of
        // falling back to the shallow login response. (Codex round 4
        // P1.)
        if (err && err.status === 401) {
          safeSet(() => {
            setUser(null);
            setStatus(ANONYMOUS);
          }, myGen);
          const wrapped = new Error('session_not_established');
          wrapped.code = 'session_not_established';
          wrapped.status = 401;
          wrapped.cause = err;
          throw wrapped;
        }
        // Transient failure (5xx / network blip) on the follow-up me()
        // — login definitely succeeded server-side, and the cookie is
        // in flight. Fall back to the shallow user from /auth/login so
        // the UI doesn't punish the user for a hiccup on a best-effort
        // hydration call.
        safeSet(() => {
          setUser(res.user);
          setStatus(AUTHENTICATED);
          setSessionExpired(false);
        }, myGen);
        return { user: res.user, master };
      }
    },
    [authService, safeSet, nextGen]
  );

  const register = useCallback(
    async ({ email, password }) => authService.register(email, password),
    [authService]
  );

  const verifyEmail = useCallback(
    async (token) => authService.verifyEmail(token),
    [authService]
  );

  const logout = useCallback(async () => {
    // Do NOT unconditionally claim local sign-out on server failure.
    //
    // The earlier "swallow the error and force ANONYMOUS" design meant
    // that if the /auth/logout call failed (server 500, network blip,
    // CORS hiccup) we'd tell the user they were signed out while their
    // session cookie was still valid — so a reload would silently
    // re-authenticate them. On a shared / kiosk machine that's a real
    // footgun: the user walks away believing the session is dead.
    // (Codex round 5 P2.)
    //
    // Split the cases:
    //   401 / 404           -> session is ALREADY gone server-side
    //                          (e.g. expired cookie). Clear locally.
    //   anything else       -> surface `logout_failed` so the caller
    //                          can prompt retry and the UI stays in
    //                          AUTHENTICATED until the server confirms.
    try {
      await authService.logout();
    } catch (err) {
      const alreadyGone =
        err && (err.status === 401 || err.status === 404);
      if (!alreadyGone) {
        const wrapped = new Error('logout_failed');
        wrapped.code = 'logout_failed';
        wrapped.status = (err && err.status) || 0;
        wrapped.cause = err;
        throw wrapped;
      }
      // fall through to clear locally — server confirmed there was
      // nothing to sign out of.
    }
    const myGen = nextGen();
    safeSet(() => {
      setUser(null);
      setStatus(ANONYMOUS);
    }, myGen);
  }, [authService, safeSet, nextGen]);

  // Called from the apiClient's 401 interceptor when a non-auth request
  // comes back unauthorized — the cookie has almost certainly expired.
  // Pages react by showing "session expired, please log in".
  //
  // Sets `sessionExpired=true` ONLY when the pre-transition status
  // was AUTHENTICATED. That's the only case where a user actually
  // LOST a session they were counting on. Firing the banner on
  // BOOTING→ANONYMOUS (a fresh visitor whose /auth/me probe
  // returns 401) would be a false positive — that path is the
  // normal "you are not logged in" state and showing an expiry
  // banner would be confusing UX.
  const handleAuthLost = useCallback(() => {
    const wasAuthenticated = statusRef.current === AUTHENTICATED;
    const myGen = nextGen();
    safeSet(() => {
      setUser(null);
      setStatus(ANONYMOUS);
      if (wasAuthenticated) {
        setSessionExpired(true);
      }
    }, myGen);
  }, [safeSet, nextGen]);

  const dismissSessionExpired = useCallback(() => {
    setSessionExpired(false);
  }, []);

  // Register ourselves as the default apiClient's auth-loss handler so
  // that 401s on protected endpoints (e.g. /vault) reach us even when
  // call sites use the shared singleton instead of injecting a client.
  // Clear the slot on unmount so stale providers never fire. (Codex
  // round 2 P2.)
  useEffect(() => {
    setAuthLostHandler(handleAuthLost);
    return () => setAuthLostHandler(null);
  }, [handleAuthLost]);

  const value = useMemo(
    () => ({
      status,
      user,
      isBooting: status === BOOTING,
      isAuthenticated: status === AUTHENTICATED,
      sessionExpired,
      dismissSessionExpired,
      login,
      register,
      verifyEmail,
      logout,
      refresh,
      handleAuthLost,
    }),
    [
      status,
      user,
      sessionExpired,
      dismissSessionExpired,
      login,
      register,
      verifyEmail,
      logout,
      refresh,
      handleAuthLost,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth() must be used inside <AuthProvider>');
  }
  return ctx;
}
