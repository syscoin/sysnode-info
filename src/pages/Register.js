import React, { useState } from 'react';
import { Link } from 'react-router-dom';

import PageMeta from '../components/PageMeta';
import { useAuth } from '../context/AuthContext';
import { isValidEmailSyntax, normalizeEmail } from '../lib/crypto/normalize';

const ERROR_COPY = {
  invalid_email: 'That email address doesn\'t look right — please check and try again.',
  password_too_short: 'Password must be at least 8 characters.',
  password_mismatch: 'The passwords you entered don\'t match.',
  network_error:
    'We couldn\'t reach the sysnode server. Check your connection and try again.',
  server_misconfigured:
    'The sysnode server is temporarily unavailable. Please try again in a moment.',
  invalid_body: 'Please enter a valid email and a password of at least 8 characters.',
  // Thrown client-side from kdf.js:subtleCrypto when window.crypto.subtle
  // is missing — which in practice means the SPA is being served over
  // plain HTTP from a non-localhost origin. Give the user the actionable
  // fix rather than a generic "something went wrong".
  webcrypto_unavailable:
    "Your browser can't derive encryption keys on this address. Sysnode needs HTTPS, or a localhost URL (http://localhost or http://127.0.0.1), for your password to stay on your device.",
};

// Which input(s) to outline red for a given error code. Inputs not listed
// stay neutral so we don't falsely accuse a field the user got right.
const FIELDS_BY_CODE = {
  invalid_email: ['email'],
  password_too_short: ['password'],
  password_mismatch: ['password', 'confirm'],
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

// We intentionally enforce only a length floor on the client. The server
// never sees the password directly — it only receives the PBKDF2+HKDF
// output — so enforcing arbitrary character-class rules would add friction
// without buying anything. Users who want stronger passwords are welcome
// to use longer ones; the KDF work factor cushions the rest.
const MIN_PASSWORD_LEN = 8;

export default function Register() {
  const { register } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [submittedTo, setSubmittedTo] = useState(null);

  function onSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const normalized = normalizeEmail(email);
    if (!isValidEmailSyntax(normalized)) {
      setError({
        code: 'invalid_email',
        message: errorToCopy('invalid_email'),
      });
      return;
    }
    if (password.length < MIN_PASSWORD_LEN) {
      setError({
        code: 'password_too_short',
        message: errorToCopy('password_too_short'),
      });
      return;
    }
    if (password !== confirm) {
      setError({
        code: 'password_mismatch',
        message: errorToCopy('password_mismatch'),
      });
      return;
    }

    setSubmitting(true);
    setError(null);

    register({ email: normalized, password })
      .then(function onRegistered() {
        setSubmittedTo(normalized);
      })
      .catch(function onRegistrationError(err) {
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

  const errorFields = error ? fieldsForCode(error.code) : [];

  if (submittedTo) {
    return (
      <>
        <PageMeta
          title="Check your email"
          description="Finish creating your Sysnode account."
        />
        <section className="page-hero auth-hero">
          <div className="site-wrap">
            <span className="eyebrow">Almost there</span>
            <h1>Check your inbox</h1>
            <p className="page-hero__copy">
              If the address you entered is valid, we've sent a verification
              link to <strong>{submittedTo}</strong>. Click the link within
              30 minutes to finish creating your Sysnode account.
            </p>
          </div>
        </section>
        <section className="page-section page-section--tight page-section--last">
          <div className="site-wrap auth-wrap">
            <div className="auth-card auth-card--info">
              <p className="auth-foot">
                Didn't get the email? Check your spam folder, then{' '}
                <button
                  type="button"
                  className="auth-linklike"
                  onClick={function onResend() {
                    setSubmittedTo(null);
                  }}
                >
                  try again
                </button>
                . Each new request issues a fresh link; only the most recent
                one you click will be redeemed.
              </p>
              <p className="auth-foot">
                Already verified? <Link to="/login">Sign in</Link>
              </p>
            </div>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <PageMeta
        title="Create an account"
        description="Create a Sysnode account to manage Sentry Node voting keys."
      />
      <section className="page-hero auth-hero">
        <div className="site-wrap">
          <span className="eyebrow">Account</span>
          <h1>Create your account</h1>
          <p className="page-hero__copy">
            Your password derives a key in your browser — Sysnode never sees
            or stores it. Choose something you'll remember, because a lost
            password means a lost voting vault.
          </p>
        </div>
      </section>

      <section className="page-section page-section--tight">
        <div className="site-wrap auth-wrap">
          <form className="auth-card" onSubmit={onSubmit} noValidate>
            <div className="auth-field">
              <label className="auth-label" htmlFor="register-email">
                Email
              </label>
              <input
                id="register-email"
                className={inputClass(errorFields, 'email')}
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={function onEmailChange(e) {
                  setEmail(e.target.value);
                }}
                aria-invalid={errorFields.includes('email') || undefined}
                aria-describedby={
                  errorFields.includes('email') ? 'register-alert' : undefined
                }
                required
              />
            </div>

            <div className="auth-field">
              <label className="auth-label" htmlFor="register-password">
                Password
              </label>
              <input
                id="register-password"
                className={inputClass(errorFields, 'password')}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={function onPasswordChange(e) {
                  setPassword(e.target.value);
                }}
                aria-invalid={errorFields.includes('password') || undefined}
                aria-describedby={
                  errorFields.includes('password') ? 'register-alert' : undefined
                }
                required
              />
              <span className="auth-hint">At least 8 characters.</span>
            </div>

            <div className="auth-field">
              <label className="auth-label" htmlFor="register-confirm">
                Confirm password
              </label>
              <input
                id="register-confirm"
                className={inputClass(errorFields, 'confirm')}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={function onConfirmChange(e) {
                  setConfirm(e.target.value);
                }}
                aria-invalid={errorFields.includes('confirm') || undefined}
                aria-describedby={
                  errorFields.includes('confirm') ? 'register-alert' : undefined
                }
                required
              />
            </div>

            {error ? (
              <div className="auth-alert" role="alert" id="register-alert">
                {error.message}
              </div>
            ) : null}

            <button
              type="submit"
              className="button button--primary button--full"
              disabled={submitting}
            >
              {submitting ? 'Sending verification...' : 'Create account'}
            </button>

            <p className="auth-foot">
              Already have an account? <Link to="/login">Sign in</Link>
            </p>
          </form>
        </div>
      </section>
    </>
  );
}
