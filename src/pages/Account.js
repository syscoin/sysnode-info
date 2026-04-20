import React, { useState } from 'react';
import { useHistory } from 'react-router-dom';

import PageMeta from '../components/PageMeta';
import { useAuth } from '../context/AuthContext';
import { useVault } from '../context/VaultContext';

const UNLOCK_ERROR_COPY = {
  envelope_decrypt_failed:
    "That password doesn't match this vault. Try again — the keys stay safe locally until the correct password decrypts them.",
  password_required: 'Please enter your password.',
  email_required: 'Your account email is missing. Try refreshing the page.',
  invalid_envelope_format:
    "Your vault blob looks corrupted. If this keeps happening, contact support — we haven't decrypted anything.",
  network_error:
    "We couldn't reach the sysnode server. Check your connection and try again.",
  unauthorized: 'Your session expired. Please sign in again.',
};

function unlockErrorCopy(code) {
  return UNLOCK_ERROR_COPY[code] || 'Unlock failed. Please try again.';
}

// Sub-view: render the vault state card. Broken out so the Account page's
// top-level JSX stays readable and tests can target the sub-view with a
// stable testid.
function VaultStatusCard({ user }) {
  const vault = useVault();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [unlockErr, setUnlockErr] = useState(null);

  function onUnlock(event) {
    event.preventDefault();
    if (submitting) return;
    if (!user || !user.email) {
      setUnlockErr('email_required');
      return;
    }
    if (password.length === 0) {
      setUnlockErr('password_required');
      return;
    }
    setSubmitting(true);
    setUnlockErr(null);
    vault
      .unlock({ password, email: user.email })
      .then(function onUnlocked() {
        setPassword('');
      })
      .catch(function onUnlockError(err) {
        setUnlockErr((err && err.code) || 'unlock_failed');
      })
      .finally(function always() {
        setSubmitting(false);
      });
  }

  if (vault.isIdle || vault.isLoading) {
    return (
      <div
        className="auth-card auth-card--info"
        data-testid="vault-status-card"
        data-vault-status={vault.status}
      >
        <h2 className="auth-card__title">Voting vault</h2>
        <p className="auth-card__hint">Checking your vault…</p>
      </div>
    );
  }

  if (vault.isEmpty) {
    return (
      <div
        className="auth-card auth-card--info"
        data-testid="vault-status-card"
        data-vault-status={vault.status}
      >
        <h2 className="auth-card__title">Voting vault</h2>
        <p className="auth-card__hint">
          You haven't imported any Sentry Node voting keys yet. Key import
          and per-key status is landing in the next release — once it ships
          you'll be able to vote on governance proposals from any device.
        </p>
      </div>
    );
  }

  if (vault.isError) {
    return (
      <div
        className="auth-card auth-card--info"
        data-testid="vault-status-card"
        data-vault-status={vault.status}
      >
        <h2 className="auth-card__title">Voting vault</h2>
        <div className="auth-alert auth-alert--error" role="alert">
          We couldn't load your vault ({vault.error}). Try refreshing the
          page — your data is still safe on the server.
        </div>
      </div>
    );
  }

  if (vault.isUnlocked) {
    return (
      <div
        className="auth-card auth-card--info"
        data-testid="vault-status-card"
        data-vault-status={vault.status}
      >
        <h2 className="auth-card__title">Voting vault</h2>
        <p className="auth-card__hint">
          <span className="status-chip is-positive">Unlocked</span>
          {' '}
          Your keys are decrypted in this browser tab only. They never
          leave your device in the clear.
        </p>
        <button
          type="button"
          className="button button--ghost"
          onClick={vault.lock}
          data-testid="vault-lock"
        >
          Lock vault
        </button>
      </div>
    );
  }

  // LOCKED — render the unlock form.
  return (
    <form
      className="auth-card auth-card--info"
      onSubmit={onUnlock}
      data-testid="vault-status-card"
      data-vault-status={vault.status}
      noValidate
    >
      <h2 className="auth-card__title">Voting vault</h2>
      <p className="auth-card__hint">
        <span className="status-chip is-warning">Locked</span>
        {' '}
        Enter your password to decrypt your Sentry Node voting keys in this
        browser tab. The password is never sent to the server.
      </p>

      <div className="auth-field">
        <label className="auth-label" htmlFor="vault-password">
          Password
        </label>
        <input
          id="vault-password"
          className="auth-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={function onChange(e) {
            setPassword(e.target.value);
          }}
          required
        />
      </div>

      {unlockErr ? (
        <div
          className="auth-alert auth-alert--error"
          role="alert"
          data-testid="vault-unlock-error"
        >
          {unlockErrorCopy(unlockErr)}
        </div>
      ) : null}

      <button
        type="submit"
        className="button button--primary"
        disabled={submitting}
        data-testid="vault-unlock"
      >
        {submitting ? 'Unlocking…' : 'Unlock vault'}
      </button>
    </form>
  );
}

export default function Account() {
  const { user, logout } = useAuth();
  const history = useHistory();
  const [signOutError, setSignOutError] = useState(null);
  const [signingOut, setSigningOut] = useState(false);

  async function onSignOut() {
    // The AuthContext surfaces `logout_failed` when the server call
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
        <div className="site-wrap auth-wrap auth-wrap--stack">
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

          <VaultStatusCard user={user} />
        </div>
      </section>
    </>
  );
}
