import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import PageMeta from '../components/PageMeta';
import { useAuth } from '../context/AuthContext';

const STATUS_BOOTING = 'verifying';
const STATUS_OK = 'verified';
const STATUS_BAD = 'invalid';
const STATUS_ALREADY = 'already_verified';
const STATUS_ERROR = 'error';

function statusFromError(err) {
  switch (err && err.code) {
    case 'invalid_or_expired_token':
    case 'invalid_token':
      return STATUS_BAD;
    case 'already_verified':
      return STATUS_ALREADY;
    default:
      return STATUS_ERROR;
  }
}

export default function VerifyEmail() {
  const { verifyEmail } = useAuth();
  const location = useLocation();
  const [status, setStatus] = useState(STATUS_BOOTING);

  // Protect against StrictMode double-invoke in dev — each token is
  // single-use on the server, so firing twice burns the redeem path and
  // flips status into STATUS_BAD on the second run even when the first
  // one succeeded.
  const firedRef = useRef(false);

  useEffect(
    function runVerification() {
      if (firedRef.current) return;
      firedRef.current = true;

      const params = new URLSearchParams(location.search);
      const token = (params.get('token') || '').trim();
      if (!/^[0-9a-f]{64}$/.test(token)) {
        setStatus(STATUS_BAD);
        return;
      }

      verifyEmail(token)
        .then(function onVerified() {
          setStatus(STATUS_OK);
        })
        .catch(function onFailed(err) {
          setStatus(statusFromError(err));
        });
    },
    [location.search, verifyEmail]
  );

  return (
    <>
      <PageMeta
        title="Verify email"
        description="Finish creating your Sysnode account."
      />
      <section className="page-hero auth-hero">
        <div className="site-wrap">
          <span className="eyebrow">Account</span>
          {status === STATUS_BOOTING ? <h1>Verifying your email...</h1> : null}
          {status === STATUS_OK ? <h1>Email verified</h1> : null}
          {status === STATUS_BAD ? <h1>Verification link expired</h1> : null}
          {status === STATUS_ALREADY ? <h1>Already verified</h1> : null}
          {status === STATUS_ERROR ? <h1>Something went wrong</h1> : null}
        </div>
      </section>

      <section className="page-section page-section--tight page-section--last">
        <div className="site-wrap auth-wrap">
          <div className="auth-card auth-card--info">
            {status === STATUS_BOOTING ? (
              <p className="auth-foot">
                Hang tight — this should take just a moment.
              </p>
            ) : null}

            {status === STATUS_OK ? (
              <>
                <p className="auth-foot">
                  Your email is confirmed and your Sysnode account is ready.
                </p>
                <Link to="/login" className="button button--primary">
                  Continue to sign in
                </Link>
              </>
            ) : null}

            {status === STATUS_ALREADY ? (
              <>
                <p className="auth-foot">
                  This account was already verified. You can go ahead and sign in.
                </p>
                <Link to="/login" className="button button--primary">
                  Sign in
                </Link>
              </>
            ) : null}

            {status === STATUS_BAD ? (
              <>
                <p className="auth-foot">
                  This link is no longer valid. Verification links expire 30
                  minutes after they're issued, and each one can only be
                  redeemed once.
                </p>
                <Link to="/register" className="button button--primary">
                  Request a new link
                </Link>
              </>
            ) : null}

            {status === STATUS_ERROR ? (
              <>
                <p className="auth-foot">
                  We couldn't verify your email right now. Please try the link
                  again, or request a fresh one.
                </p>
                <Link to="/register" className="button button--primary">
                  Request a new link
                </Link>
              </>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}
