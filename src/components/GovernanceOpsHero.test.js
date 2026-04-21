import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import GovernanceOpsHero from './GovernanceOpsHero';

function mkProposal({ key, yes = 0 }) {
  return { Key: key, AbsoluteYesCount: yes };
}

function baseRow(o) {
  return {
    proposalHash: '',
    total: 0,
    relayed: 0,
    confirmed: 0,
    stale: 0,
    failed: 0,
    confirmedYes: 0,
    confirmedNo: 0,
    confirmedAbstain: 0,
    latestSubmittedAt: null,
    latestVerifiedAt: null,
    ...o,
  };
}

function mapFromRows(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.proposalHash.toLowerCase(), r);
  return m;
}

function renderHero(props) {
  return render(
    <MemoryRouter>
      <GovernanceOpsHero {...props} />
    </MemoryRouter>
  );
}

describe('GovernanceOpsHero', () => {
  const p1 = mkProposal({ key: 'a'.repeat(64), yes: 200 });
  const p2 = mkProposal({ key: 'b'.repeat(64), yes: 50 });
  const p3 = mkProposal({ key: 'c'.repeat(64), yes: 300 });

  test('renders the empty-state CTA when the vault has no voting keys', () => {
    renderHero({
      proposals: [p1, p2],
      summaryMap: new Map(),
      ownedCount: 0,
      enabledCount: 1000,
    });
    expect(screen.getByTestId('gov-ops-hero-empty')).toBeInTheDocument();
    const link = screen.getByTestId('gov-ops-hero-account-link');
    expect(link).toHaveAttribute('href', '/account');
  });

  test('renders a skeleton while the owned-MN lookup is loading', () => {
    renderHero({
      proposals: [p1, p2],
      summaryMap: new Map(),
      ownedCount: null,
      enabledCount: 1000,
    });
    expect(screen.getByTestId('gov-ops-hero-loading')).toBeInTheDocument();
  });

  test('summarises counts and exposes a jump-to-next button', () => {
    const map = mapFromRows([
      baseRow({
        proposalHash: p1.Key,
        total: 2,
        confirmed: 2,
        confirmedYes: 2,
      }),
      // p2 missing from summary → needs-vote.
      baseRow({
        proposalHash: p3.Key,
        total: 2,
        confirmed: 1,
        confirmedYes: 1,
        failed: 1,
      }),
    ]);
    const onJumpToProposal = jest.fn();
    renderHero({
      proposals: [p1, p2, p3],
      summaryMap: map,
      ownedCount: 2,
      enabledCount: 1000,
      onJumpToProposal,
    });
    // Primary headline reflects the needs-vote count.
    const headline = screen.getByTestId('gov-ops-hero-headline');
    expect(headline.textContent).toMatch(/2\s+proposals?\s+need your vote/i);
    // Stats cards — read the `<strong>` number explicitly rather
    // than relying on word-boundary regexes, which don't treat
    // "vote2" as a boundary because both sides are word chars.
    expect(
      screen.getByTestId('gov-ops-hero-needs-vote').querySelector('strong')
        .textContent
    ).toBe('2');
    expect(
      screen.getByTestId('gov-ops-hero-voted').querySelector('strong')
        .textContent
    ).toBe('1');
    expect(
      screen.getByTestId('gov-ops-hero-passing').querySelector('strong')
        .textContent
    ).toBe('2');
    // Jump link goes to the first display-order proposal needing a vote (p2).
    fireEvent.click(screen.getByTestId('gov-ops-hero-jump'));
    expect(onJumpToProposal).toHaveBeenCalledWith(p2.Key);
  });

  test('progress bar renders with the right value', () => {
    const map = mapFromRows([
      baseRow({
        proposalHash: p1.Key,
        total: 2,
        confirmed: 2,
        confirmedYes: 2,
      }),
    ]);
    renderHero({
      proposals: [p1, p2, p3],
      summaryMap: map,
      ownedCount: 2,
      enabledCount: 1000,
    });
    const progress = screen.getByTestId('gov-ops-hero-progress');
    // 1 voted / 3 applicable = 33%
    expect(progress.textContent).toMatch(/Voted\s+1\s+of\s+3/);
    expect(progress.textContent).toMatch(/33%/);
    const bar = progress.querySelector('[role="progressbar"]');
    expect(bar).toHaveAttribute('aria-valuenow', '33');
  });

  test('shows a celebratory "all done" state when nothing is pending', () => {
    const map = mapFromRows([
      baseRow({
        proposalHash: p1.Key,
        total: 2,
        confirmed: 2,
        confirmedYes: 2,
      }),
      baseRow({
        proposalHash: p2.Key,
        total: 2,
        confirmed: 2,
        confirmedYes: 2,
      }),
    ]);
    renderHero({
      proposals: [p1, p2],
      summaryMap: map,
      ownedCount: 2,
      enabledCount: 1000,
    });
    expect(screen.queryByTestId('gov-ops-hero-jump')).not.toBeInTheDocument();
    expect(screen.getByTestId('gov-ops-hero-done')).toBeInTheDocument();
    const hero = screen.getByTestId('gov-ops-hero');
    expect(hero).toHaveAttribute('data-all-done', 'true');
  });

  test('jump button is suppressed when there is nothing to jump to', () => {
    // Zero proposals visible — "applicable" is 0 and we have no
    // next key. The jump button must not render or it would send
    // the user nowhere.
    renderHero({
      proposals: [],
      summaryMap: new Map(),
      ownedCount: 2,
      enabledCount: 1000,
    });
    expect(screen.queryByTestId('gov-ops-hero-jump')).not.toBeInTheDocument();
  });
});
