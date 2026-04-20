import React from 'react';
import { useHistory } from 'react-router-dom';

import PageMeta from '../components/PageMeta';
import { useAuth } from '../context/AuthContext';

export default function Account() {
  const { user, logout } = useAuth();
  const history = useHistory();

  function onSignOut() {
    logout().finally(function always() {
      history.replace('/login');
    });
  }

  return (
    <>
      <PageMeta
        title="Account"
        description="Manage your Sysnode account and Sentry Node keys."
      />
      <section className="page-hero auth-hero">
        <div className="site-wrap">
          <span className="eyebrow">Account</span>
          <h1>Your Sysnode account</h1>
          <p className="page-hero__copy">
            Your voting vault and Sentry Node tooling live here. More controls
            are landing soon — key import, vote history, and reminder
            preferences are on the way.
          </p>
        </div>
      </section>

      <section className="page-section page-section--tight page-section--last">
        <div className="site-wrap auth-wrap">
          <div className="auth-card auth-card--info">
            <dl className="auth-kv">
              <div className="auth-kv__row">
                <dt>Email</dt>
                <dd>{user ? user.email : ''}</dd>
              </div>
              <div className="auth-kv__row">
                <dt>Verified</dt>
                <dd>
                  {user && user.emailVerified ? (
                    <span className="status-chip is-positive">Confirmed</span>
                  ) : (
                    <span className="status-chip is-warning">Pending</span>
                  )}
                </dd>
              </div>
            </dl>

            <button
              type="button"
              className="button button--ghost"
              onClick={onSignOut}
            >
              Sign out
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
