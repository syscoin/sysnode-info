import React, { useState } from 'react';
import { useHistory } from 'react-router-dom';

import PageMeta from '../components/PageMeta';
import { useAuth } from '../context/AuthContext';

export default function Account() {
  const { user, logout } = useAuth();
  const history = useHistory();
  const [signOutError, setSignOutError] = useState(null);
  const [signingOut, setSigningOut] = useState(false);

  async function onSignOut() {
    // The AuthContext now surfaces `logout_failed` when the server call
    // fails on anything other than 401/404 (session already gone). In
    // that case the session cookie is still valid server-side, so we
    // must NOT redirect to /login — doing so would tell the user they
    // were signed out while a reload would restore the session.
    setSignOutError(null);
    setSigningOut(true);
    try {
      await logout();
      history.replace('/login');
    } catch (err) {
      setSignOutError(
        err && err.code === 'logout_failed'
          ? "We couldn't end your session on the server. Please retry, or close this browser window to be safe."
          : 'Sign out failed. Please retry.'
      );
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <>
      <PageMeta
        title="Account"
        description="Manage your Sysnode account and Sentry Node keys."
      />
      <section className="page-hero auth-hero">
        <div className="site-wrap">
          <span className="eyebrow">Account</span>
          <h1>Your Sysnode account</h1>
          <p className="page-hero__copy">
            Your voting vault and Sentry Node tooling live here. More controls
            are landing soon — key import, vote history, and reminder
            preferences are on the way.
          </p>
        </div>
      </section>

      <section className="page-section page-section--tight page-section--last">
        <div className="site-wrap auth-wrap">
          <div className="auth-card auth-card--info">
            <dl className="auth-kv">
              <div className="auth-kv__row">
                <dt>Email</dt>
                <dd>{user ? user.email : ''}</dd>
              </div>
              <div className="auth-kv__row">
                <dt>Verified</dt>
                <dd>
                  {user && user.emailVerified ? (
                    <span className="status-chip is-positive">Confirmed</span>
                  ) : (
                    <span className="status-chip is-warning">Pending</span>
                  )}
                </dd>
              </div>
            </dl>

            {signOutError ? (
              <div
                className="auth-alert auth-alert--error"
                role="alert"
                data-testid="signout-error"
              >
                {signOutError}
              </div>
            ) : null}

            <button
              type="button"
              className="button button--ghost"
              onClick={onSignOut}
              disabled={signingOut}
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
