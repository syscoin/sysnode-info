import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { EXTERNAL_LINKS, NAV_LINKS } from '../data/navigation';
import { useAuth } from '../context/AuthContext';

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const { isAuthenticated, isBooting } = useAuth();

  useEffect(
    function closeMenuOnRouteChange() {
      setMenuOpen(false);
    },
    [location.pathname]
  );

  return (
    <header className="site-header">
      <div className="site-wrap site-header__inner">
        <NavLink exact to="/" className="site-brand" aria-label="Sysnode home">
          <span className="site-brand__text">SYSNODE</span>
        </NavLink>

        <button
          type="button"
          className="site-header__toggle"
          aria-expanded={menuOpen}
          aria-controls="primary-navigation"
          onClick={function toggleMenu() {
            setMenuOpen(!menuOpen);
          }}
        >
          <span className="visually-hidden">Toggle navigation</span>
          <span />
          <span />
        </button>

        <div
          id="primary-navigation"
          className={menuOpen ? 'site-header__nav is-open' : 'site-header__nav'}
        >
          <nav className="site-nav" aria-label="Primary">
            {NAV_LINKS.map(function renderLink(link) {
              return (
                <NavLink
                  key={link.to}
                  exact={link.exact}
                  to={link.to}
                  className="site-nav__link"
                  activeClassName="is-active"
                >
                  {link.label}
                </NavLink>
              );
            })}
          </nav>

          <div className="site-header__actions">
            <a
              className="button button--ghost"
              href={EXTERNAL_LINKS.docs}
              target="_blank"
              rel="noopener noreferrer"
            >
              Official Docs
            </a>
            {/* Auth chip: render nothing while the initial /auth/me call
                is in flight so the button doesn't flash "Sign in" for a
                split second on reload when the user is in fact signed
                in. Covered by Header.test.js. */}
            {isBooting ? null : isAuthenticated ? (
              <NavLink
                to="/account"
                className="button button--primary"
                activeClassName="is-active"
              >
                Account
              </NavLink>
            ) : (
              <NavLink to="/login" className="button button--primary">
                Sign in
              </NavLink>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
