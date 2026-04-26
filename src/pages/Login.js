import React, { useEffect, useRef, useState } from 'react';
import { Link, useHistory, useLocation } from 'react-router-dom';

import PageMeta from '../components/PageMeta';
import PasswordInput from '../components/PasswordInput';
import { useAuth } from '../context/AuthContext';
import { useVault } from '../context/VaultContext';
import { isValidEmailSyntax, normalizeEmail } from '../lib/crypto/normalize';

const ERROR_COPY = {
  invalid_email: 'That email address doesn\'t look right — please check and try again.',
  password_too_short: 'Enter your account password.',
  invalid_credentials:
    "We couldn't sign you in with that email and password. Double-check for typos and try again.",
  email_not_verified:
    'Your email isn\'t verified yet. Check your inbox for the verification link, or register again to resend it.',
  network_error:
    'We couldn\'t reach the sysnode server. Check your connection and try again.',
  server_misconfigured:
    'The sysnode server is temporarily unavailable. Please try again in a moment.',
  invalid_body:
    'Please enter a valid email and password.',
  session_not_established:
    "Your sign-in went through, but your browser didn't keep the session cookie. If you're using strict / third-party-cookie blocking for this site, allow it for sysnode and try again.",
  invalid_totp_code:
    "That authenticator code didn't work. Check the current 6-digit code and try again.",
  mfa_challenge_invalid:
    'That two-factor sign-in expired. Enter your email and password again.',
  // Thrown client-side from kdf.js:subtleCrypto when window.crypto.subtle
  // is missing — which in practice means the SPA is being served over
  // plain HTTP from a non-localhost origin. Give the user the actionable
  // fix rather than a generic "something went wrong".
  webcrypto_unavailable:
    "Your browser can't derive encryption keys on this address. Sysnode needs HTTPS, or a localhost URL (http://localhost or http://127.0.0.1), for your password to stay on your device.",
};

// Which input(s) to outline red for a given error code. Inputs not listed
// stay neutral so we don't falsely accuse a field the user got right.
// For invalid_credentials we deliberately outline BOTH inputs: the backend
// returns the same code for "wrong email" and "wrong password" (anti-
// enumeration), and guessing one over the other would be misleading.
const FIELDS_BY_CODE = {
  invalid_email: ['email'],
  password_too_short: ['password'],
  invalid_credentials: ['email', 'password'],
  email_not_verified: ['email'],
  invalid_body: ['email', 'password'],
};

function errorToCopy(code, fallbackMessage) {
  if (code && ERROR_COPY[code]) return ERROR_COPY[code];
  // For unknown codes we'd otherwise render the generic copy below.
  // If the underlying Error carried its own message, prefer that — it
  // is nearly always more useful than "something went wrong" (e.g. a
  // WebCrypto error in a non-secure context, which phrases the fix
  // in user-facing terms directly in Error.message).
  if (typeof fallbackMessage === 'string' && fallbackMessage.length > 0) {
    return fallbackMessage;
  }
  return 'Something went wrong. Please try again.';
}

function fieldsForCode(code) {
  return FIELDS_BY_CODE[code] || [];
}

function inputClass(fields, name) {
  return fields.includes(name) ? 'auth-input auth-input--error' : 'auth-input';
}

export default function Login() {
  const { login, completeTotpLogin } = useAuth();
  const vault = useVault();
  const history = useHistory();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [pendingMfa, setPendingMfa] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const pendingMasterRef = useRef(null);

  useEffect(
    () => () => {
      if (pendingMasterRef.current instanceof Uint8Array) {
        pendingMasterRef.current.fill(0);
      }
      pendingMasterRef.current = null;
    },
    []
  );

  function clearPendingMfa() {
    if (pendingMasterRef.current instanceof Uint8Array) {
      pendingMasterRef.current.fill(0);
    }
    pendingMasterRef.current = null;
    setPendingMfa(null);
    setTotpCode('');
    setRecoveryCode('');
    setUseRecoveryCode(false);
    setError(null);
  }

  function clearPendingMfaStateOnly() {
    pendingMasterRef.current = null;
    setPendingMfa(null);
    setTotpCode('');
    setRecoveryCode('');
    setUseRecoveryCode(false);
  }

  function finishLogin(result) {
    if (result && result.master instanceof Uint8Array) {
      const master = result.master;
      vault.unlockWithMaster(master)
        .catch(function onIgnore() {
          // noop — VaultContext records the error into its state for
          // the Account page to render.
        })
        .finally(function onWipeMaster() {
          master.fill(0);
        });
    }
    const next = (location.state && location.state.from) || '/account';
    history.replace(next);
  }

  function onSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const normalized = normalizeEmail(email);
    if (!isValidEmailSyntax(normalized)) {
      setError({ code: 'invalid_email', message: errorToCopy('invalid_email') });
      return;
    }
    if (password.length < 8) {
      setError({
        code: 'password_too_short',
        message: errorToCopy('password_too_short'),
      });
      return;
    }

    setSubmitting(true);
    setError(null);
    login({ email: normalized, password })
      .then(function onLoggedIn(result) {
        if (result && result.mfaRequired) {
          pendingMasterRef.current = result.master;
          setPendingMfa({
            challengeToken: result.challengeToken,
            expiresAt: result.expiresAt,
          });
          return;
        }
        finishLogin(result);
      })
      .catch(function onLoginError(err) {
        const code = (err && err.code) || 'unknown';
        setError({
          code,
          message: errorToCopy(code, err && err.message),
        });
      })
      .finally(function always() {
        setSubmitting(false);
      });
  }

  function onTotpSubmit(event) {
    event.preventDefault();
    if (submitting || !pendingMfa) return;
    const code = totpCode.trim();
    const recovery = recoveryCode.trim();
    if (!useRecoveryCode && code.length === 0) {
      setError({ code: 'invalid_totp_code', message: errorToCopy('invalid_totp_code') });
      return;
    }
    if (useRecoveryCode && recovery.length === 0) {
      setError({
        code: 'invalid_totp_code',
        message: 'Enter one of your recovery codes.',
      });
      return;
    }

    setSubmitting(true);
    setError(null);
    completeTotpLogin({
      challengeToken: pendingMfa.challengeToken,
      code: useRecoveryCode ? undefined : code,
      recoveryCode: useRecoveryCode ? recovery : undefined,
      master: pendingMasterRef.current,
    })
      .then(function onTotpLoggedIn(result) {
        const master = pendingMasterRef.current;
        clearPendingMfaStateOnly();
        finishLogin({ ...result, master });
      })
      .catch(function onTotpError(err) {
        const codeName = (err && err.code) || 'unknown';
        if (codeName === 'mfa_challenge_invalid') clearPendingMfa();
        setError({
          code: codeName,
          message: errorToCopy(codeName, err && err.message),
        });
      })
      .finally(function always() {
        setSubmitting(false);
      });
  }

  const errorFields = error ? fieldsForCode(error.code) : [];

  return (
    <>
      <PageMeta title="Sign in" description="Sign in to your Sysnode account." />
      <section className="page-hero auth-hero">
        <div className="site-wrap">
          <span className="eyebrow">Account</span>
          <h1>Sign in</h1>
          <p className="page-hero__copy">
            Sign in to manage Sentry Node voting keys and vote on Syscoin
            governance proposals from any device.
          </p>
        </div>
      </section>

      <section className="page-section page-section--tight">
        <div className="site-wrap auth-wrap">
          <form
            className="auth-card"
            onSubmit={pendingMfa ? onTotpSubmit : onSubmit}
            noValidate
          >
            {pendingMfa ? (
              <>
                <h2 className="auth-card__title">Two-factor check</h2>
                <p className="auth-card__hint">
                  Enter the 6-digit code from your authenticator app to finish
                  signing in.
                </p>
                {!useRecoveryCode ? (
                  <div className="auth-field">
                    <label className="auth-label" htmlFor="login-totp-code">
                      Authenticator code
                    </label>
                    <input
                      id="login-totp-code"
                      className={inputClass(errorFields, 'password')}
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={totpCode}
                      onChange={function onTotpCodeChange(e) {
                        setTotpCode(e.target.value);
                      }}
                      required
                    />
                  </div>
                ) : (
                  <div className="auth-field">
                    <label className="auth-label" htmlFor="login-recovery-code">
                      Recovery code
                    </label>
                    <input
                      id="login-recovery-code"
                      className={inputClass(errorFields, 'password')}
                      type="text"
                      autoComplete="one-time-code"
                      value={recoveryCode}
                      onChange={function onRecoveryCodeChange(e) {
                        setRecoveryCode(e.target.value);
                      }}
                      required
                    />
                  </div>
                )}

                {error ? (
                  <div className="auth-alert" role="alert" id="login-alert">
                    {error.message}
                  </div>
                ) : null}

                <button
                  type="submit"
                  className="button button--primary button--full"
                  disabled={submitting}
                >
                  {submitting ? 'Verifying...' : 'Verify and sign in'}
                </button>
                <button
                  type="button"
                  className="button button--ghost button--full"
                  onClick={() => setUseRecoveryCode((v) => !v)}
                  disabled={submitting}
                >
                  {useRecoveryCode
                    ? 'Use authenticator code'
                    : 'Use recovery code'}
                </button>
                <button
                  type="button"
                  className="button button--ghost button--full"
                  onClick={clearPendingMfa}
                  disabled={submitting}
                >
                  Back to password sign in
                </button>
              </>
            ) : (
              <>
            <div className="auth-field">
              <label className="auth-label" htmlFor="login-email">
                Email
              </label>
              <input
                id="login-email"
                className={inputClass(errorFields, 'email')}
                type="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={function onEmailChange(e) {
                  setEmail(e.target.value);
                }}
                aria-invalid={errorFields.includes('email') || undefined}
                aria-describedby={
                  errorFields.includes('email') ? 'login-alert' : undefined
                }
                required
              />
            </div>

            <div className="auth-field">
              <label className="auth-label" htmlFor="login-password">
                Password
              </label>
              <PasswordInput
                id="login-password"
                className={inputClass(errorFields, 'password')}
                autoComplete="current-password"
                value={password}
                onChange={function onPasswordChange(e) {
                  setPassword(e.target.value);
                }}
                aria-invalid={errorFields.includes('password') || undefined}
                aria-describedby={
                  errorFields.includes('password') ? 'login-alert' : undefined
                }
                required
              />
            </div>

            {error ? (
              <div className="auth-alert" role="alert" id="login-alert">
                {error.message}
              </div>
            ) : null}

            <button
              type="submit"
              className="button button--primary button--full"
              disabled={submitting}
            >
              {submitting ? 'Signing in...' : 'Sign in'}
            </button>

            <p className="auth-foot">
              New to Sysnode? <Link to="/register">Create an account</Link>
            </p>
              </>
            )}
          </form>
        </div>
      </section>
    </>
  );
}
