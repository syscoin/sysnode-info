import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import GovernanceActivityLink from './GovernanceActivityLink';

// The Account-page deep-link card is a pure, stateless component —
// there's no data fetch, no conditional branches. What matters is:
//
//   1. It actually renders (so the Account page import doesn't
//      turn into a ghost "blank card" if someone hollows this
//      component out by mistake).
//   2. The CTA is a real router Link pointing at /governance.
//      The QA gap being closed is "user on Account asked 'where
//      do I see my votes?'" — if the Link regresses to /# or
//      /governance?vote=... we break the exact fix.
describe('GovernanceActivityLink', () => {
  function renderLink() {
    return render(
      <MemoryRouter>
        <GovernanceActivityLink />
      </MemoryRouter>
    );
  }

  test('renders heading and hint copy', () => {
    renderLink();
    expect(
      screen.getByTestId('account-gov-activity-link')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /your governance activity/i })
    ).toBeInTheDocument();
  });

  test('CTA is a real router link targeting /governance', () => {
    renderLink();
    const cta = screen.getByTestId('account-gov-activity-cta');
    expect(cta.tagName).toBe('A');
    expect(cta.getAttribute('href')).toBe('/governance');
  });
});
