import React, { useState } from 'react';
import { Link } from 'react-router-dom';

import PageMeta from '../components/PageMeta';
import { useAuth } from '../context/AuthContext';
import { isValidEmailSyntax, normalizeEmail } from '../lib/crypto/normalize';

const ERROR_COPY = {
  invalid_email: 'That email address doesn\'t look right — please check and try again.',
  network_error:
    'We couldn\'t reach the sysnode server. Check your connection and try again.',
  server_misconfigured:
    'The sysnode server is temporarily unavailable. Please try again in a moment.',
  invalid_body: 'Please enter a valid email and a password of at least 8 characters.',
};

function errorToCopy(code) {
  return ERROR_COPY[code] || 'Something went wrong. Please try again.';
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
        message: 'Please enter a valid email address.',
      });
      return;
    }
    if (password.length < MIN_PASSWORD_LEN) {
      setError({
        code: 'password_too_short',
        message: `Password must be at least ${MIN_PASSWORD_LEN} characters.`,
      });
      return;
    }
    if (password !== confirm) {
      setError({
        code: 'password_mismatch',
        message: 'The passwords you entered don\'t match.',
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
        setError({ code: err.code || 'unknown', message: errorToCopy(err.code) });
      })
      .finally(function always() {
        setSubmitting(false);
      });
  }

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
                className="auth-input"
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={function onEmailChange(e) {
                  setEmail(e.target.value);
                }}
                required
              />
            </div>

            <div className="auth-field">
              <label className="auth-label" htmlFor="register-password">
                Password
              </label>
              <input
                id="register-password"
                className="auth-input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={function onPasswordChange(e) {
                  setPassword(e.target.value);
                }}
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
                className="auth-input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={function onConfirmChange(e) {
                  setConfirm(e.target.value);
                }}
                required
              />
            </div>

            {error ? (
              <div className="auth-alert" role="alert">
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
