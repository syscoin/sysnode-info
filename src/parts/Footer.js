import React from 'react';

import { EXTERNAL_LINKS } from '../data/navigation';

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-wrap site-footer__inner">
        <div className="site-footer__copy">
          <p>Open-source for Syscoin Sentry Node operators.</p>
          <span>Built for clearer decisions across monitoring, rewards, governance, and setup.</span>
        </div>

        <nav className="site-footer__links" aria-label="Footer">
          <a
            href={EXTERNAL_LINKS.github}
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <a
            href={EXTERNAL_LINKS.docs}
            target="_blank"
            rel="noopener noreferrer"
          >
            Docs
          </a>
          <a
            href={EXTERNAL_LINKS.support}
            target="_blank"
            rel="noopener noreferrer"
          >
            Support
          </a>
          <a href={EXTERNAL_LINKS.discord} target="_blank" rel="noopener noreferrer">
            Discord
          </a>
        </nav>
      </div>
    </footer>
  );
}
