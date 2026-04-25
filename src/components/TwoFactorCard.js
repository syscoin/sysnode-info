import React, { useCallback, useEffect, useState } from 'react';
import { toString as qrToString } from 'qrcode';

import { authService as defaultAuthService } from '../lib/authService';
import { useAuth } from '../context/AuthContext';

const ERROR_COPY = {
  invalid_totp_code: "That authenticator code didn't work. Check the current code and try again.",
  totp_setup_not_started: 'Start setup again, then enter the new code.',
  totp_not_enabled: 'Two-factor authentication is not enabled for this account.',
  invalid_credentials: 'Your current password is incorrect.',
  password_required: 'Enter your current password before changing two-factor settings.',
  missing_email: 'Your account email is missing. Refresh and try again.',
  recovery_codes_missing:
    'Two-factor authentication changed, but recovery codes were not returned. Refresh before continuing.',
  unauthorized: 'Your session expired. Please sign in again.',
  network_error:
    "We couldn't reach the sysnode server. Check your connection and try again.",
};

function errorCopy(code) {
  return ERROR_COPY[code] || 'Two-factor update failed. Please try again.';
}

export default function TwoFactorCard({
  authService = defaultAuthService,
  defaultOpen = false,
}) {
  const { user, handleAuthLost } = useAuth();
  const [open, setOpen] = useState(defaultOpen);
  const [status, setStatus] = useState({
    enabled: !!(user && user.totpEnabled),
    pending: false,
    recoveryCodesRemaining: 0,
  });
  const [setup, setSetup] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [errCode, setErrCode] = useState(null);
  const [success, setSuccess] = useState(null);

  const loadStatus = useCallback(async () => {
    try {
      const next = await authService.getTotpStatus();
      setStatus(next);
      setErrCode(null);
    } catch (err) {
      if (err && err.code === 'unauthorized') {
        handleAuthLost();
        return;
      }
      setErrCode((err && err.code) || 'network_error');
    }
  }, [authService, handleAuthLost]);

  useEffect(() => {
    if (!open) return;
    loadStatus();
  }, [loadStatus, open]);

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl(null);
    if (!setup || !setup.otpauthUrl) return () => {
      cancelled = true;
    };
    qrToString(
      setup.otpauthUrl,
      {
        errorCorrectionLevel: 'M',
        margin: 2,
        type: 'svg',
        width: 220,
      },
      (err, svg) => {
        if (cancelled) return;
        setQrDataUrl(
          err ? null : `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
        );
      }
    );
    return () => {
      cancelled = true;
    };
  }, [setup]);

  async function deriveStepUpAuthHash() {
    let email = user && user.email;
    if (!email) {
      const me = await authService.me();
      email = me && me.user && me.user.email;
    }
    if (!email) {
      const e = new Error('missing_email');
      e.code = 'missing_email';
      throw e;
    }
    if (currentPassword.length === 0) {
      const e = new Error('password_required');
      e.code = 'password_required';
      throw e;
    }
    return authService.deriveStepUpAuthHash(currentPassword, email);
  }

  async function startSetup() {
    setBusy(true);
    setErrCode(null);
    setSuccess(null);
    setRecoveryCodes(null);
    try {
      const oldAuthHash = await deriveStepUpAuthHash();
      const nextSetup = await authService.beginTotpSetup(oldAuthHash);
      setSetup(nextSetup);
      setStatus((s) => ({ ...s, pending: true }));
    } catch (err) {
      if (err && err.code === 'unauthorized') {
        handleAuthLost();
        return;
      }
      if (err && err.code === 'totp_setup_not_started') {
        setSetup(null);
        setQrDataUrl(null);
        setCode('');
        setStatus((s) => ({ ...s, pending: false }));
      }
      setErrCode((err && err.code) || 'network_error');
    } finally {
      setBusy(false);
    }
  }

  async function enable() {
    setBusy(true);
    setErrCode(null);
    setSuccess(null);
    try {
      const oldAuthHash = await deriveStepUpAuthHash();
      const out = await authService.enableTotp({ code, oldAuthHash });
      const issuedRecoveryCodes = Array.isArray(out.recoveryCodes)
        ? out.recoveryCodes
        : [];
      if (issuedRecoveryCodes.length === 0) {
        await loadStatus();
        setErrCode('recovery_codes_missing');
        return;
      }
      setRecoveryCodes(issuedRecoveryCodes);
      setSetup(null);
      setCode('');
      setCurrentPassword('');
      setStatus({
        enabled: true,
        pending: false,
        recoveryCodesRemaining: issuedRecoveryCodes.length,
      });
    } catch (err) {
      if (err && err.code === 'unauthorized') {
        handleAuthLost();
        return;
      }
      if (err && err.code === 'totp_setup_not_started') {
        setSetup(null);
        setQrDataUrl(null);
        setCode('');
        setStatus((s) => ({ ...s, pending: false }));
      }
      setErrCode((err && err.code) || 'network_error');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setErrCode(null);
    setSuccess(null);
    try {
      const oldAuthHash = await deriveStepUpAuthHash();
      await authService.disableTotp({ code, oldAuthHash });
      setSetup(null);
      setCode('');
      setCurrentPassword('');
      setRecoveryCodes(null);
      setStatus({ enabled: false, pending: false, recoveryCodesRemaining: 0 });
      setSuccess('Two-factor authentication is disabled.');
    } catch (err) {
      if (err && err.code === 'unauthorized') {
        handleAuthLost();
        return;
      }
      setErrCode((err && err.code) || 'network_error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="auth-card auth-card--info auth-card--collapsible"
      data-open={open ? 'true' : 'false'}
    >
      <div className="auth-card__header">
        <div className="auth-card__header-text">
          <h2 className="auth-card__title">Two-factor authentication</h2>
          <p className="auth-card__hint">
            Add a TOTP authenticator app as a second step after your password.
          </p>
        </div>
        <button
          type="button"
          className="auth-card__disclosure-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={
            open
              ? 'Collapse two-factor authentication settings'
              : 'Expand two-factor authentication settings'
          }
        >
          <span className="auth-card__chevron" aria-hidden="true">
            ▸
          </span>
        </button>
      </div>

      {open ? (
        <div className="auth-card__body">
          <p className="auth-card__hint">
            Status:{' '}
            {status.enabled ? (
              <span className="status-chip is-positive">Enabled</span>
            ) : (
              <span className="status-chip is-warning">Disabled</span>
            )}
          </p>

          {setup ? (
            <div className="auth-field">
              <p className="auth-card__hint">
                Scan this QR code from Google Authenticator, Authy, 1Password,
                or another TOTP app, then enter the current 6-digit code.
              </p>
              <div className="totp-qr" aria-label="TOTP setup QR code">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="Scan this QR code with your authenticator app"
                  />
                ) : (
                  <span>Preparing QR code...</span>
                )}
              </div>
              <label className="auth-label" htmlFor="totp-secret">
                Manual setup secret fallback
              </label>
              <input
                id="totp-secret"
                className="auth-input"
                type="text"
                value={setup.secret}
                readOnly
              />
              <p className="auth-foot">
                URI:{' '}
                <a href={setup.otpauthUrl}>
                  Open in authenticator app
                </a>
              </p>
            </div>
          ) : null}

          {recoveryCodes ? (
            <div className="auth-alert" role="status">
              Save these recovery codes now. Each code works once:
              <pre>{recoveryCodes.join('\n')}</pre>
            </div>
          ) : null}

          {errCode ? (
            <div className="auth-alert auth-alert--error" role="alert">
              {errorCopy(errCode)}
            </div>
          ) : null}
          {success ? (
            <div className="auth-alert auth-alert--success" role="status">
              {success}
            </div>
          ) : null}

          <div className="auth-field">
            <label className="auth-label" htmlFor="totp-current-password">
              Current password
            </label>
            <input
              id="totp-current-password"
              className="auth-input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>

          {setup || status.enabled ? (
            <div className="auth-field">
              <label className="auth-label" htmlFor="totp-code">
                Authenticator code
              </label>
              <input
                id="totp-code"
                className="auth-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
          ) : null}

          {!status.enabled && !setup ? (
            <button
              type="button"
              className="button button--primary button--full"
              onClick={startSetup}
              disabled={busy}
            >
              {busy ? 'Starting...' : 'Set up two-factor authentication'}
            </button>
          ) : null}

          {setup ? (
            <button
              type="button"
              className="button button--primary button--full"
              onClick={enable}
              disabled={busy || code.trim().length === 0}
            >
              {busy ? 'Verifying...' : 'Verify and enable'}
            </button>
          ) : null}

          {status.enabled && !setup ? (
            <>
              <p className="auth-card__hint">
                Recovery codes remaining: {status.recoveryCodesRemaining}
              </p>
              <button
                type="button"
                className="button button--ghost button--full"
                onClick={disable}
                disabled={busy || code.trim().length === 0}
              >
                {busy ? 'Disabling...' : 'Disable two-factor authentication'}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
