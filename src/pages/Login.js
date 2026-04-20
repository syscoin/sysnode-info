import React, { useState } from 'react';
import { Link, useHistory, useLocation } from 'react-router-dom';

import PageMeta from '../components/PageMeta';
import { useAuth } from '../context/AuthContext';
import { isValidEmailSyntax, normalizeEmail } from '../lib/crypto/normalize';

const ERROR_COPY = {
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
};

function errorToCopy(code) {
  return ERROR_COPY[code] || 'Something went wrong. Please try again.';
}

export default function Login() {
  const { login } = useAuth();
  const history = useHistory();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  function onSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const normalized = normalizeEmail(email);
    if (!isValidEmailSyntax(normalized)) {
      setError({ code: 'invalid_email', message: 'Please enter a valid email address.' });
      return;
    }
    if (password.length < 8) {
      setError({
        code: 'password_too_short',
        message: 'Passwords are at least 8 characters.',
      });
      return;
    }

    setSubmitting(true);
    setError(null);
    login({ email: normalized, password })
      .then(function onLoggedIn() {
        const next = (location.state && location.state.from) || '/account';
        history.replace(next);
      })
      .catch(function onLoginError(err) {
        setError({ code: err.code || 'unknown', message: errorToCopy(err.code) });
      })
      .finally(function always() {
        setSubmitting(false);
      });
  }

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
          <form className="auth-card" onSubmit={onSubmit} noValidate>
            <div className="auth-field">
              <label className="auth-label" htmlFor="login-email">
                Email
              </label>
              <input
                id="login-email"
                className="auth-input"
                type="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={function onEmailChange(e) {
                  setEmail(e.target.value);
                }}
                required
              />
            </div>

            <div className="auth-field">
              <label className="auth-label" htmlFor="login-password">
                Password
              </label>
              <input
                id="login-password"
                className="auth-input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={function onPasswordChange(e) {
                  setPassword(e.target.value);
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
              {submitting ? 'Signing in...' : 'Sign in'}
            </button>

            <p className="auth-foot">
              New to Sysnode? <Link to="/register">Create an account</Link>
            </p>
          </form>
        </div>
      </section>
    </>
  );
}
