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

// AuthContext shape:
//
//   status: 'booting' | 'anonymous' | 'authenticated'
//   user:   null | { id, email, emailVerified, notificationPrefs }
//   login({ email, password })       -> resolves to { user } on success
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

  // Guards against setting state after unmount, for pages that call
  // auth methods from effects during navigation.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const safeSet = useCallback((fn) => {
    if (mountedRef.current) fn();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { user: u } = await authService.me();
      safeSet(() => {
        setUser(u);
        setStatus(AUTHENTICATED);
      });
      return u;
    } catch (err) {
      safeSet(() => {
        setUser(null);
        setStatus(ANONYMOUS);
      });
      // 401 is expected (no session) — don't re-throw that.
      if (err.status === 401) return null;
      throw err;
    }
  }, [authService, safeSet]);

  useEffect(() => {
    refresh().catch(() => {
      // Swallowed: refresh() already set ANONYMOUS on failure.
    });
  }, [refresh]);

  const login = useCallback(
    async ({ email, password }) => {
      const res = await authService.login(email, password);
      // /auth/login returns the shallow user; hit /auth/me to pick up
      // emailVerified + notificationPrefs in one canonical shape.
      try {
        const me = await authService.me();
        safeSet(() => {
          setUser(me.user);
          setStatus(AUTHENTICATED);
        });
        return me;
      } catch (_) {
        safeSet(() => {
          setUser(res.user);
          setStatus(AUTHENTICATED);
        });
        return { user: res.user };
      }
    },
    [authService, safeSet]
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
    try {
      await authService.logout();
    } catch (err) {
      // The server call failed, but locally we're definitively signed out
      // (cookies will be dropped by the redirect anyway). Swallow and log
      // rather than surface a misleading "logout failed" to the user.
      // eslint-disable-next-line no-console
      console.warn('[AuthContext] logout request failed', err && err.message);
    } finally {
      safeSet(() => {
        setUser(null);
        setStatus(ANONYMOUS);
      });
    }
  }, [authService, safeSet]);

  // Called from the apiClient's 401 interceptor when a non-auth request
  // comes back unauthorized — the cookie has almost certainly expired.
  // Pages react by showing "session expired, please log in".
  const handleAuthLost = useCallback(() => {
    safeSet(() => {
      setUser(null);
      setStatus(ANONYMOUS);
    });
  }, [safeSet]);

  const value = useMemo(
    () => ({
      status,
      user,
      isBooting: status === BOOTING,
      isAuthenticated: status === AUTHENTICATED,
      login,
      register,
      verifyEmail,
      logout,
      refresh,
      handleAuthLost,
    }),
    [status, user, login, register, verifyEmail, logout, refresh, handleAuthLost]
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
