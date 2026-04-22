import React from 'react';
import { Link, useLocation } from 'react-router-dom';

import { useAuth } from '../context/AuthContext';

// SessionExpiredBanner
// --------------------
// Global, non-blocking banner that renders when AuthContext observes a
// silent session loss — i.e. an apiClient 401 on a request made while
// the user was AUTHENTICATED, most commonly because the backend cookie
// expired or was revoked.
//
// Why a banner (and not a modal / auto-redirect):
//
//   * Auto-redirecting to /login on every 401 is hostile UX on pages
//     that are mostly public: the user was in the middle of reading
//     a proposal, and a background vault hydration 401 would yank
//     them to a login form. The QA report flagged this as the single
//     most-confusing failure mode — "I clicked and my page
//     disappeared".
//   * A blocking modal forces a decision the user may not want to
//     make right now (they might just be reading the governance
//     feed — no auth needed).
//
// A persistent banner is the goldilocks fit: the user is told,
// they can act on it when ready, and nothing else is interrupted.
//
// Behavior:
//   * Renders ONLY when `sessionExpired` is true AND the user is
//     not already on `/login` (the login page itself is the
//     remedy; banner would be redundant).
//   * The "Sign in" CTA is a real router link that preserves the
//     current path as a return-to so the user lands back where
//     they were after re-authenticating.
//   * Dismiss clears the flag in context — the next 401 on a
//     protected call re-arms it naturally.
//   * The "Sign in" CTA deliberately does NOT clear the flag on
//     click. Codex review flagged that pre-clearing meant a
//     cancelled nav or failed login would leave the user on a
//     public page with no context for why protected actions had
//     just broken. AuthContext.login() already flips the flag
//     off on a successful sign-in, and the banner is suppressed
//     on `/login` anyway, so the extra onClick was redundant at
//     best and destructive at worst.
export default function SessionExpiredBanner() {
  const { sessionExpired, dismissSessionExpired } = useAuth();
  const location = useLocation();

  if (!sessionExpired) return null;
  if (location.pathname === '/login') return null;

  // Preserve the user's current path so the Login page can
  // redirect them back after re-auth. `Login.js` reads
  // `location.state.from` — match that contract directly instead
  // of inventing a parallel query-string channel.
  const loginTo = {
    pathname: '/login',
    state: { from: `${location.pathname}${location.search || ''}` },
  };

  return (
    <div
      className="session-expired-banner"
      role="status"
      aria-live="polite"
      data-testid="session-expired-banner"
    >
      <div className="site-wrap session-expired-banner__wrap">
        <div className="session-expired-banner__copy">
          <strong>Your session expired.</strong>{' '}
          <span>
            For your security we signed you out. Any unsaved work in
            protected pages (your vault, proposal drafts, vote queue)
            will require you to sign back in.
          </span>
        </div>
        <div className="session-expired-banner__actions">
          <Link
            to={loginTo}
            className="button button--primary button--small"
            data-testid="session-expired-signin"
          >
            Sign in again
          </Link>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={dismissSessionExpired}
            data-testid="session-expired-dismiss"
            aria-label="Dismiss session expiry notice"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
