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

  // We dedupe by the token value itself rather than a one-shot boolean.
  //
  // A one-shot guard protects against StrictMode's intentional effect
  // double-invoke (each token is single-use server-side, so double
  // redeem would burn a still-valid link). But it ALSO locks the page
  // to whatever token it first saw — in a same-tab SPA navigation from
  // `/verify-email?token=A` to `?token=B` the effect re-fires with
  // fresh `location.search`, and a never-reset boolean would skip the
  // new redemption silently, leaving stale status on screen until a
  // hard reload. (Codex round 1 P2.)
  //
  // Keying the guard on the token value gives us StrictMode safety
  // (second invoke with the same token is a no-op) AND correctness
  // across in-app token changes (different token, different ref value,
  // new redeem fires).
  const lastSubmittedTokenRef = useRef(null);

  useEffect(
    function runVerification() {
      const params = new URLSearchParams(location.search);
      const token = (params.get('token') || '').trim();

      if (lastSubmittedTokenRef.current === token) return;
      lastSubmittedTokenRef.current = token;

      if (!/^[0-9a-f]{64}$/.test(token)) {
        setStatus(STATUS_BAD);
        return;
      }

      setStatus(STATUS_BOOTING);
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
