import React from 'react';
import { Link } from 'react-router-dom';

import PageMeta from '../components/PageMeta';

export default function ErrorPage() {
  return (
    <main className="page-main">
      <PageMeta
        title="Page not found"
        description="This Sysnode page could not be found. Return to the overview, network dashboard, governance, learn, or setup pages."
      />

      <section className="page-hero">
        <div className="site-wrap">
          <div className="panel error-panel">
            <p className="eyebrow">404</p>
            <h1>That page is not here.</h1>
            <p className="page-hero__copy">
              The route you tried does not exist in the refreshed Sysnode experience.
              Use one of the links below to get back on track.
            </p>

            <div className="hero__actions">
              <Link className="button button--primary" to="/">
                Go to overview
              </Link>
              <Link className="button button--ghost" to="/network">
                Open dashboard
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
