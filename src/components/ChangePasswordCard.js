import React, { useCallback, useState } from 'react';

import { authService as defaultAuthService } from '../lib/authService';
import PasswordStrengthMeter from './PasswordStrengthMeter';
import { useAuth } from '../context/AuthContext';
import { useVault } from '../context/VaultContext';
import {
  MIN_VAULT_PASSWORD_LENGTH,
  validateVaultPassword,
  VAULT_PASSWORD_HINT,
} from '../lib/passwordPolicy';

// ChangePasswordCard
// -----------------------------------------------------------------------
// Account-page card for rotating the user's password.
//
// Why the orchestration lives here (and not in AuthContext):
//   A password change has to atomically rotate three things:
//
//     1. The browser-derived authHash (server-facing credential).
//     2. The server-stored vault blob, rewrapped under the NEW
//        vaultKey (only if a vault exists — new users without keys
//        don't have a row).
//     3. The in-memory vaultKey + etag held by VaultContext.
//
//   We need BOTH hooks (useAuth for the rotation, useVault for the
//   rewrap + commit) at the same time. Putting the orchestration in a
//   component that already uses both hooks is the simplest place to
//   express it without passing callbacks through AuthContext.
//
// Preconditions / UX rules:
//
//   * If the user has a vault and it is LOCKED, we refuse to proceed
//     and ask them to unlock first. A rewrap requires the old
//     vaultKey, which only exists when the vault is UNLOCKED. This
//     avoids a confusing 409 or a torn state.
//
//   * The vault rewrap is prepared BEFORE the POST so that crypto
//     failures (envelope malformed, userSaltV missing, etc.) surface
//     inline without ever rotating the auth credential.
//
//   * On success, we commit the new vaultKey + etag to VaultContext
//     (rewrap.commit(newVaultEtag)) and then refresh the auth session
//     so any Set-Cookie rotations are reflected in /auth/me.
//
//   * On failure, the VaultContext state is untouched — rewrap.commit
//     is only called on success.
//
// Known backend error codes we translate:
//
//   invalid_credentials   -> "Your current password is incorrect."
//   invalid_body          -> "That password doesn't meet the requirements."
//   precondition_failed   -> "Your vault was updated elsewhere. Reload and try again."
//   vault_rewrap_required -> "Couldn't rewrap your vault. Reload and try again."
//   blob_too_large        -> "Vault too large to rewrap. Contact support."
//   server_misconfigured  -> "The server can't change passwords right now. Try again later."
//   unauthorized          -> "Your session expired. Please sign in again."
//   network_error         -> "We couldn't reach the server. Check your connection."

const ERROR_COPY = {
  invalid_credentials: 'Your current password is incorrect.',
  invalid_body: `We couldn't apply that change. ${VAULT_PASSWORD_HINT}`,
  precondition_failed:
    'Your vault was updated in another tab or device. Reload this page and try again.',
  vault_rewrap_required:
    "We couldn't rewrap your vault. Reload this page and try again.",
  if_match_required:
    "We couldn't rewrap your vault (missing etag). Reload and try again.",
  blob_too_large:
    'Your vault has grown too large to rewrap in a single request. Please contact support.',
  invalid_blob:
    'Your rewrapped vault blob was rejected as invalid. Please contact support.',
  server_misconfigured:
    "The server can't change passwords right now. Try again in a moment.",
  unauthorized: 'Your session expired. Please sign in again.',
  network_error:
    "We couldn't reach the sysnode server. Check your connection and try again.",
  vault_not_unlocked:
    'Unlock your vault first (right panel) so we can rewrap it under the new password.',
  vault_still_loading:
    'Your vault is still loading. Give it a moment and try again.',
  vault_missing_blob:
    "Your vault didn't load correctly. Refresh this page and try again.",
  vault_missing_saltv:
    'Your account is missing vault configuration. Please sign out and sign back in.',
};

function errorCopy(code) {
  return ERROR_COPY[code] || 'Password change failed. Please try again.';
}

// `defaultOpen` — whether the card's form body is revealed on mount.
// Kept as `true` by default so component-level tests (which render
// the card in isolation and interact with its inputs directly)
// continue to work without having to expand the disclosure first.
// Account.js overrides to `false` so users land on a compact
// settings stack and opt in to the form explicitly.
export default function ChangePasswordCard({
  authService = defaultAuthService,
  defaultOpen = true,
}) {
  const { user, refresh, handleAuthLost } = useAuth();
  const vault = useVault();

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errCode, setErrCode] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const userEmail = user && user.email ? user.email : '';

  const clearFeedback = useCallback(() => {
    setErrCode(null);
    setLocalError(null);
    setSuccess(false);
  }, []);

  const onSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (submitting) return;
      clearFeedback();

      if (!user || !user.email) {
        setLocalError('Your account email is missing. Try refreshing the page.');
        return;
      }
      if (oldPassword.length === 0) {
        setLocalError('Enter your current password.');
        return;
      }
      const passwordError = validateVaultPassword(newPassword, [user.email]);
      if (passwordError) {
        setLocalError(passwordError.message);
        return;
      }
      if (newPassword === oldPassword) {
        setLocalError('Your new password must be different from your current password.');
        return;
      }
      if (newPassword !== confirmPassword) {
        setLocalError("The two new passwords don't match.");
        return;
      }

      // Gate the expensive PBKDF2 path on a resolved vault state.
      //
      // The vault passes through IDLE -> LOADING -> (EMPTY | LOCKED |
      // UNLOCKED | ERROR). Submitting before we've landed in a
      // terminal state would burn ~1.2 seconds on a double PBKDF2
      // only to fail inside rewrapForPasswordChange with a misleading
      // "vault_not_unlocked" — so short-circuit here with a "still
      // loading" copy. Codex round-2 P2.
      if (vault.isIdle || vault.isLoading) {
        setErrCode('vault_still_loading');
        return;
      }
      // If the user has a vault but it isn't UNLOCKED, we can't
      // rewrap — the rewrap needs the old vaultKey in memory.
      // Surface a clear instruction instead of a cryptic 409.
      const hasVault =
        vault.isLocked || vault.isUnlocked || vault.isError;
      if (hasVault && !vault.isUnlocked) {
        setErrCode('vault_not_unlocked');
        return;
      }

      setSubmitting(true);
      try {
        // 1. Derive keys up-front. This runs PBKDF2(600k) twice
        //    (once for the old authHash, once for the new master)
        //    so it's the most expensive part of the flow — do it
        //    before touching any state.
        const { oldAuthHash, newAuthHash, newMaster } =
          await authService.deriveChangePasswordKeys(
            oldPassword,
            newPassword,
            user.email
          );

        // 2. Ask the vault to rewrap. `rewrap` is null iff the user
        //    has no vault row at all — the POST will then run as a
        //    plain auth rotation.
        let rewrap = null;
        try {
          rewrap = await vault.rewrapForPasswordChange(newMaster);
        } catch (err) {
          setErrCode((err && err.code) || 'vault_not_unlocked');
          return;
        }

        // 3. POST. On any error, the vault state is untouched
        //    (rewrap.commit is only called on success).
        let res;
        try {
          res = await authService.changePassword({
            oldAuthHash,
            newAuthHash,
            vault: rewrap
              ? { blob: rewrap.blob, ifMatch: rewrap.ifMatch }
              : null,
          });
        } catch (err) {
          const code = (err && err.code) || 'http_error';
          // `unauthorized` = server considers this client signed
          // out (session expired, or revoked in another tab). The
          // /auth/* apiClient path skips the global auth-loss
          // interceptor, so this branch must flip AuthContext to
          // ANONYMOUS explicitly — otherwise the user stays on the
          // Account page with a stale signed-in state. PrivateRoute
          // will then redirect to /login on the next render.
          if (code === 'unauthorized') {
            handleAuthLost();
            return;
          }
          setErrCode(code);
          return;
        }

        // 4. Success. Commit the new vaultKey + etag to
        //    VaultContext, then refresh /auth/me to pick up the
        //    reissued session.
        if (rewrap && res && res.newVaultEtag) {
          try {
            rewrap.commit(res.newVaultEtag);
          } catch (err) {
            // Committing to the vault shouldn't fail, but if it
            // does we still report success — the server-side
            // rotation is already complete. Log for diagnosis.
            // eslint-disable-next-line no-console
            console.error('[change-password] vault commit failed', err);
          }
        }
        try {
          await refresh();
        } catch (err) {
          // refresh() already swallows 401s into ANONYMOUS; any
          // other failure is cosmetic — the password was changed.
          // eslint-disable-next-line no-console
          console.error('[change-password] refresh failed', err);
        }

        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setSuccess(true);
      } finally {
        setSubmitting(false);
      }
    },
    [
      authService,
      clearFeedback,
      confirmPassword,
      handleAuthLost,
      newPassword,
      oldPassword,
      refresh,
      submitting,
      user,
      vault,
    ]
  );

  return (
    <form
      className="auth-card auth-card--info auth-card--collapsible"
      onSubmit={onSubmit}
      data-testid="change-password-card"
      data-open={open ? 'true' : 'false'}
      noValidate
    >
      <div className="auth-card__header">
        <div className="auth-card__header-text">
          <h2 className="auth-card__title" id="change-password-title">
            Change password
          </h2>
          <p className="auth-card__hint">
            Your new password re-encrypts your voting vault locally. Use a long
            passphrase; other signed-in devices will be signed out.
          </p>
        </div>
        <button
          type="button"
          className="auth-card__disclosure-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="change-password-body"
          aria-label={
            open
              ? 'Collapse change password form'
              : 'Expand change password form'
          }
          data-testid="change-password-toggle"
        >
          <span className="auth-card__chevron" aria-hidden="true">
            ▸
          </span>
        </button>
      </div>

      {open ? (
        <div id="change-password-body" className="auth-card__body">
          <div className="auth-field">
            <label className="auth-label" htmlFor="cp-old">
              Current password
            </label>
            <input
              id="cp-old"
              className="auth-input"
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              required
            />
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="cp-new">
              New password
            </label>
            <input
              id="cp-new"
              className="auth-input"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={MIN_VAULT_PASSWORD_LENGTH}
              aria-describedby="cp-new-strength"
              required
            />
            <span className="auth-hint">{VAULT_PASSWORD_HINT}</span>
            <PasswordStrengthMeter
              id="cp-new-strength"
              password={newPassword}
              userInputs={[userEmail]}
            />
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="cp-confirm">
              Confirm new password
            </label>
            <input
              id="cp-confirm"
              className="auth-input"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={MIN_VAULT_PASSWORD_LENGTH}
              required
            />
          </div>

          {localError ? (
            <div
              className="auth-alert auth-alert--error"
              role="alert"
              data-testid="change-password-local-error"
            >
              {localError}
            </div>
          ) : null}

          {errCode ? (
            <div
              className="auth-alert auth-alert--error"
              role="alert"
              data-testid="change-password-error"
            >
              {errorCopy(errCode)}
            </div>
          ) : null}

          {success ? (
            <div
              className="auth-alert auth-alert--success"
              role="status"
              data-testid="change-password-success"
            >
              Password changed. Other devices have been signed out.
            </div>
          ) : null}

          <button
            type="submit"
            className="button button--primary"
            disabled={submitting}
            data-testid="change-password-submit"
          >
            {submitting ? 'Updating…' : 'Change password'}
          </button>
        </div>
      ) : null}
    </form>
  );
}
