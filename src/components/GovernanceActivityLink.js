import React from 'react';
import { Link } from 'react-router-dom';

// GovernanceActivityLink
// ----------------------
// Compact Account-page card that points the user at their recent
// governance vote history. The actual history lives in
// `GovernanceActivity` on the /governance page — that's the
// natural home because receipts are most useful next to the
// proposal feed they reference.
//
// Why the card exists here at all:
//
//   The QA audit flagged that a user who opens "Account" to ask
//   "how / where do I see my votes?" found no obvious path — the
//   list lived two clicks away on Governance without any
//   signpost from the Account screen. Surfacing a single
//   deep-link card on Account closes that gap without
//   duplicating the receipts widget (which would then have to
//   refetch and potentially diverge from the canonical one).
//
// Keep this intentionally small — one heading, one CTA. No
// data fetch, no counts, no inline list. If we ever want those,
// move the full `<GovernanceActivity />` here behind a feature
// flag instead of sprouting a second implementation that can
// drift from the Governance-page one.
export default function GovernanceActivityLink() {
  return (
    <section
      className="auth-card auth-card--info"
      data-testid="account-gov-activity-link"
      aria-labelledby="account-gov-activity-heading"
    >
      <h2
        id="account-gov-activity-heading"
        className="auth-card__title"
      >
        Your governance activity
      </h2>
      <p className="auth-card__hint">
        Review every proposal you've voted on, with timestamps and a
        jump link back to the proposal. Lives on the Governance page
        right next to the feed — this is just a shortcut.
      </p>
      <Link
        to="/governance"
        className="button button--ghost"
        data-testid="account-gov-activity-cta"
      >
        Open my governance activity
      </Link>
    </section>
  );
}
