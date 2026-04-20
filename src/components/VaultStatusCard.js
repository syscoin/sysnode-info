import React, { useState } from 'react';

import { useVault } from '../context/VaultContext';
import KeyManagerCard from './KeyManagerCard';
import VaultImportModal from './VaultImportModal';

// VaultStatusCard
// -----------------------------------------------------------------------
// The one card on the Account page that reflects the vault lifecycle.
// Extracted from pages/Account.js so pages stay thin and tests can
// exercise the card in isolation.
//
// Status routing:
//   IDLE / LOADING -> "Checking your vault…"
//   EMPTY          -> friendly pitch + "Import voting keys" CTA
//   ERROR          -> error banner
//   LOCKED         -> inline unlock form
//   UNLOCKED       -> full KeyManagerCard (list + import + lock)
//
// We DO NOT change the existing testid / copy contract (the
// `data-testid="vault-status-card"`, `data-vault-status` attribute,
// the "haven't imported any Sentry Node" copy on EMPTY, the
// `vault-unlock` / `vault-unlock-error` / `vault-lock` testids).
// Those are exercised by src/pages/Account.test.js and cross a
// presentation/navigation seam we want stable.

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

export default function VaultStatusCard({ user }) {
  const vault = useVault();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [unlockErr, setUnlockErr] = useState(null);
  const [importOpen, setImportOpen] = useState(false);

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
          You haven't imported any Sentry Node voting keys yet. Paste
          them in below — they're validated, encrypted locally, and
          only ever travel to the server as an opaque ciphertext
          blob.
        </p>
        <div className="vault-empty__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => setImportOpen(true)}
            data-testid="vault-empty-import"
          >
            Import voting keys
          </button>
        </div>
        <VaultImportModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
        />
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
          We couldn't load your vault ({vault.error}). Try refreshing
          the page — your data is still safe on the server.
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
          Your keys are decrypted in this browser tab only. They
          never leave your device in the clear.
        </p>
        <KeyManagerCard />
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
        Enter your password to decrypt your Sentry Node voting keys in
        this browser tab. The password is never sent to the server.
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
