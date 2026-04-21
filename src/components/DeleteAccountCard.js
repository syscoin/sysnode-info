import React, { useCallback, useState } from 'react';
import { useHistory } from 'react-router-dom';

import { authService as defaultAuthService } from '../lib/authService';
import { deriveLoginKeys } from '../lib/crypto/kdf';
import { useAuth } from '../context/AuthContext';

// DeleteAccountCard
// -----------------------------------------------------------------------
// GDPR "right to erasure" card. Lives on the Account page, below the
// notifications panel. Deliberately gated behind a two-step UX so a
// stray click can't nuke the account:
//
//   Step 1 — "Delete account" button reveals the danger zone with a
//            full warning list of what will be lost.
//   Step 2 — User must type their email EXACTLY (to confirm the
//            target) AND their current password (to re-prove
//            possession — a stolen session alone is not enough).
//
// On success the server has already:
//   * cleared sid+csrf cookies
//   * cascaded-deleted sessions, vault, tracked masternodes,
//     vote receipts, reminder log, email verifications
//   * purged pending_registrations by email
//
// On our side we mirror that by firing AuthContext.handleAuthLost(),
// which also tears down VaultContext via its isAuthenticated watcher,
// then redirecting to the marketing page.
//
// Error mapping:
//   invalid_credentials  -> "Your password is incorrect."
//   unauthorized         -> session expired mid-flight; we still try
//                           to navigate to home because locally we
//                           don't have anything useful to keep.
//   server_misconfigured -> surface a retry message.
//   network_error        -> offer retry without destroying local
//                           state.

const ERROR_COPY = {
  invalid_credentials: 'Your password is incorrect.',
  server_misconfigured:
    "We can't process account deletions right now. Please try again in a moment.",
  unauthorized: 'Your session expired. Please sign in again.',
  network_error:
    "We couldn't reach the sysnode server. Check your connection and try again.",
  invalid_body: 'Something about your request looked off. Please try again.',
};

function errorCopy(code) {
  return ERROR_COPY[code] || 'Account deletion failed. Please try again.';
}

export default function DeleteAccountCard({
  authService = defaultAuthService,
}) {
  const { user, handleAuthLost } = useAuth();
  const history = useHistory();

  const [expanded, setExpanded] = useState(false);
  const [emailConfirm, setEmailConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errCode, setErrCode] = useState(null);
  const [localError, setLocalError] = useState(null);

  const clearFeedback = useCallback(() => {
    setErrCode(null);
    setLocalError(null);
  }, []);

  const onCancel = useCallback(() => {
    setExpanded(false);
    setEmailConfirm('');
    setPassword('');
    clearFeedback();
  }, [clearFeedback]);

  const onSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (submitting) return;
      clearFeedback();

      if (!user || !user.email) {
        setLocalError('Your account email is missing. Try refreshing the page.');
        return;
      }
      // Require an exact email match. Typo here is a feature: if the
      // user hesitates the confirmation typo refuses them. Comparison
      // is case-insensitive + whitespace-trimmed to avoid bouncing a
      // well-formed confirmation over trivial typography.
      const expected = String(user.email).trim().toLowerCase();
      const provided = String(emailConfirm).trim().toLowerCase();
      if (provided !== expected) {
        setLocalError(
          'The confirmation email does not match the account email.'
        );
        return;
      }
      if (password.length === 0) {
        setLocalError('Enter your current password to confirm.');
        return;
      }

      setSubmitting(true);
      try {
        // Re-derive authHash the same way /login does — the server
        // treats this as proof that the caller knows the password.
        // We do NOT store or surface `master`; account deletion
        // has no use for the master key (there's no vault to
        // unlock, and we're about to erase any vault state).
        const { authHash } = await deriveLoginKeys(password, user.email);

        try {
          await authService.deleteAccount({ oldAuthHash: authHash });
        } catch (err) {
          const code = (err && err.code) || 'http_error';
          // `unauthorized` means the session expired (or was
          // revoked elsewhere) mid-submit. The server reports the
          // client as unauthenticated — we must mirror that locally
          // or the user is stranded on private Account UI while
          // AuthContext still thinks they're signed in. The
          // /auth/* apiClient path deliberately does NOT drive the
          // global auth-loss interceptor, so this branch has to do
          // it explicitly.
          if (code === 'unauthorized') {
            handleAuthLost();
            history.replace('/');
            return;
          }
          setErrCode(code);
          return;
        }

        // Server erased the account and cleared cookies. Mirror
        // that locally: handleAuthLost flips AuthContext to
        // ANONYMOUS without re-calling /auth/logout (there's no
        // session left to revoke), and VaultContext's
        // isAuthenticated watcher hard-resets its own state.
        handleAuthLost();
        history.replace('/');
      } finally {
        setSubmitting(false);
      }
    },
    [
      authService,
      clearFeedback,
      emailConfirm,
      handleAuthLost,
      history,
      password,
      submitting,
      user,
    ]
  );

  if (!expanded) {
    return (
      <div
        className="auth-card auth-card--danger"
        data-testid="delete-account-card"
      >
        <h2 className="auth-card__title">Delete account</h2>
        <p className="auth-card__hint">
          Permanently erase your Sysnode account and all data we store for
          you. This cannot be undone.
        </p>
        <button
          type="button"
          className="button button--danger"
          onClick={() => setExpanded(true)}
          data-testid="delete-account-reveal"
        >
          Delete account…
        </button>
      </div>
    );
  }

  return (
    <form
      className="auth-card auth-card--danger"
      onSubmit={onSubmit}
      data-testid="delete-account-card"
      noValidate
    >
      <h2 className="auth-card__title">Delete account</h2>
      <p className="auth-card__hint">
        This will permanently erase:
      </p>
      <ul className="auth-card__danger-list" data-testid="delete-account-warnings">
        <li>Your voting vault, including every imported Sentry Node voting key.</li>
        <li>Every active session on this and all other devices.</li>
        <li>Your notification preferences and any reminder history.</li>
        <li>Your vote receipts (your past votes remain on-chain and cannot be recalled).</li>
        <li>Your email and account record. You will need to register again to use Sysnode.</li>
      </ul>

      <div className="auth-field">
        <label className="auth-label" htmlFor="del-email">
          Type your account email to confirm
        </label>
        <input
          id="del-email"
          className="auth-input"
          type="email"
          autoComplete="off"
          spellCheck={false}
          value={emailConfirm}
          onChange={(e) => setEmailConfirm(e.target.value)}
          placeholder={user ? user.email : ''}
          data-testid="delete-account-email"
          required
        />
      </div>

      <div className="auth-field">
        <label className="auth-label" htmlFor="del-password">
          Current password
        </label>
        <input
          id="del-password"
          className="auth-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="delete-account-password"
          required
        />
      </div>

      {localError ? (
        <div
          className="auth-alert auth-alert--error"
          role="alert"
          data-testid="delete-account-local-error"
        >
          {localError}
        </div>
      ) : null}

      {errCode ? (
        <div
          className="auth-alert auth-alert--error"
          role="alert"
          data-testid="delete-account-error"
        >
          {errorCopy(errCode)}
        </div>
      ) : null}

      <div className="auth-form-actions">
        <button
          type="button"
          className="button button--ghost"
          onClick={onCancel}
          disabled={submitting}
          data-testid="delete-account-cancel"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="button button--danger"
          disabled={submitting}
          data-testid="delete-account-submit"
        >
          {submitting ? 'Erasing…' : 'Permanently delete my account'}
        </button>
      </div>
    </form>
  );
}
