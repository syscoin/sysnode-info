import React from 'react';
import { Redirect, Route } from 'react-router-dom';

import { useAuth } from '../context/AuthContext';

// Route guard for pages that require a live session. While the initial
// /auth/me call is in flight (`isBooting`) we render a minimal placeholder
// instead of snapping to the login page, which would flicker on reload
// for users who are in fact signed in.
export default function PrivateRoute({
  children,
  component: Component,
  render,
  ...rest
}) {
  const { isAuthenticated, isBooting } = useAuth();

  return (
    <Route
      {...rest}
      render={function renderGuarded(routeProps) {
        if (isBooting) {
          return (
            <section className="page-section page-section--tight">
              <div className="site-wrap auth-wrap">
                <div className="auth-card auth-card--info" aria-busy="true">
                  <p className="auth-foot">Checking your session...</p>
                </div>
              </div>
            </section>
          );
        }
        if (!isAuthenticated) {
          return (
            <Redirect
              to={{
                pathname: '/login',
                state: { from: routeProps.location.pathname },
              }}
            />
          );
        }
        if (Component) return <Component {...routeProps} />;
        if (typeof render === 'function') return render(routeProps);
        return children;
      }}
    />
  );
}
