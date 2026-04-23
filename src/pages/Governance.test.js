import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

// Mock strategy (same rationale as ProposalVoteModal.test.js —
// avoids PBKDF2 / live axios). We stub the data hook and the two
// contexts the page touches, plus the ProposalVoteModal itself
// since its internals are covered in their own test file.
jest.mock('../hooks/useGovernanceData', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));
// useGovernanceReceipts composes useOwnedMasternodes + the summary
// fetch. Mocking it directly keeps these page tests focused on
// wiring (the hook itself has its own unit tests).
jest.mock('../hooks/useGovernanceReceipts', () => ({
  useGovernanceReceipts: jest.fn(),
}));
jest.mock('../components/ProposalVoteModal', () => (props) => (
  <div
    data-testid="modal-stub"
    data-open={String(!!props.open)}
    data-proposal={props.proposal ? props.proposal.Key : ''}
  >
    {/* Expose onClose to tests via a dedicated button — the real
        modal closes via its own UI, which we've deliberately mocked
        out to keep these tests focused on page wiring. */}
    <button
      type="button"
      data-testid="modal-stub-close"
      onClick={props.onClose}
    >
      close-stub
    </button>
  </div>
));

// Stub the hero / activity rail so the jump-callback tests can
// trigger jumpToProposal(key) directly via a test-only button.
// The real components are covered in their own files; we only
// need the prop wiring here.
jest.mock('../components/GovernanceOpsHero', () => (props) => (
  <div data-testid="ops-hero-stub">
    <button
      type="button"
      data-testid="ops-hero-stub-jump"
      onClick={() => {
        if (typeof props.onJumpToProposal === 'function') {
          props.onJumpToProposal(props['data-test-jump-key'] || '');
        }
      }}
    >
      hero-jump
    </button>
  </div>
));
jest.mock('../components/GovernanceActivity', () => (props) => (
  <div data-testid="activity-stub">
    <button
      type="button"
      data-testid="activity-stub-jump"
      onClick={() => {
        const key = (global && global.__ACTIVITY_STUB_JUMP_KEY__) || '';
        if (typeof props.onJumpToProposal === 'function') {
          props.onJumpToProposal(key);
        }
      }}
    >
      activity-jump
    </button>
  </div>
));

// eslint-disable-next-line import/first
import Governance from './Governance';
// eslint-disable-next-line import/first
import useGovernanceData from '../hooks/useGovernanceData';
// eslint-disable-next-line import/first
import { useAuth } from '../context/AuthContext';
// eslint-disable-next-line import/first
import { useGovernanceReceipts } from '../hooks/useGovernanceReceipts';

function makeProposal(overrides = {}) {
  return {
    Key: 'a'.repeat(64),
    name: 'Sponsor',
    title: 'Demo proposal',
    AbsoluteYesCount: 0,
    YesCount: 0,
    NoCount: 0,
    payment_amount: '100',
    start_epoch: 1700000000,
    end_epoch: 1702592000,
    CreationTime: 1699000000,
    url: 'https://example.invalid/proposal',
    ...overrides,
  };
}

function baseData(overrides = {}) {
  return {
    error: '',
    loading: false,
    proposals: [makeProposal()],
    stats: {
      stats: {
        mn_stats: { enabled: 1000 },
        superblock_stats: {
          budget: 1000000,
          voting_deadline: 1700500000,
          superblock_date: 1701000000,
        },
      },
    },
    ...overrides,
  };
}

function makeReceipts({
  summary = [],
  summaryMap,
  ownedCount = null,
  refresh = jest.fn().mockResolvedValue(),
  summaryError = null,
} = {}) {
  // summaryMap defaults to a map keyed by lowercase proposalHash
  // — mirrors the real hook.
  const m = summaryMap || new Map();
  if (!summaryMap) {
    for (const row of summary) {
      if (row && typeof row.proposalHash === 'string') {
        m.set(row.proposalHash.toLowerCase(), row);
      }
    }
  }
  return {
    summary,
    summaryMap: m,
    summaryError,
    summaryLoading: false,
    owned: [],
    ownedCount,
    ownedError: null,
    isLoading: false,
    refresh,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Governance />
    </MemoryRouter>
  );
}

beforeEach(() => {
  // Default to an empty receipts hook so pre-existing tests don't
  // need to care about cohort data. Individual tests that exercise
  // cohort behaviour override this via useGovernanceReceipts.mockReturnValue.
  useGovernanceReceipts.mockReturnValue(makeReceipts());
});

describe('Governance page — cohort affordances', () => {
  test('anonymous users see Yes/No copy buttons and a login CTA banner', () => {
    useAuth.mockReturnValue({ isAuthenticated: false, user: null });
    useGovernanceData.mockReturnValue(baseData());

    renderPage();

    expect(screen.getByTestId('governance-login-cta')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /copy yes vote command/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /copy no vote command/i })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('proposal-row-vote')).not.toBeInTheDocument();
    // The vote modal is mounted only on demand (see note in
    // Governance.js). Anonymous users never have a selected
    // proposal, so the stub must not be in the tree at all —
    // this guarantees its hooks (useOwnedMasternodes et al.)
    // never fire on a plain page view.
    expect(screen.queryByTestId('modal-stub')).not.toBeInTheDocument();
  });

  test('authenticated users see a Vote button instead of the copy buttons', () => {
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(baseData());

    renderPage();

    expect(screen.queryByTestId('governance-login-cta')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /copy yes vote command/i })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('proposal-row-vote')).toBeInTheDocument();
  });

  test('clicking Vote opens the modal for the selected proposal', () => {
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(
      baseData({
        proposals: [
          makeProposal({ Key: 'a'.repeat(64), title: 'Prop A' }),
          makeProposal({ Key: 'b'.repeat(64), title: 'Prop B' }),
        ],
      })
    );

    renderPage();

    // No proposal selected yet → modal is not mounted at all (its
    // hooks don't run, no background /gov/mns/lookup traffic).
    expect(screen.queryByTestId('modal-stub')).not.toBeInTheDocument();

    const voteButtons = screen.getAllByTestId('proposal-row-vote');
    fireEvent.click(voteButtons[1]);

    const stubAfter = screen.getByTestId('modal-stub');
    expect(stubAfter.getAttribute('data-open')).toBe('true');
    expect(stubAfter.getAttribute('data-proposal')).toBe('b'.repeat(64));
  });

  test('vote modal is not mounted for authenticated users until they click Vote', () => {
    // Complements the click test: the authenticated+unlocked case
    // must not render the modal on idle page load, otherwise
    // useOwnedMasternodes would hit /gov/mns/lookup before the
    // user expressed vote intent.
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(baseData());

    renderPage();

    expect(screen.queryByTestId('modal-stub')).not.toBeInTheDocument();
  });
});

describe('Governance page — cohort chips', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  function summaryRow(partial) {
    return {
      proposalHash: 'a'.repeat(64),
      total: 0,
      relayed: 0,
      confirmed: 0,
      stale: 0,
      failed: 0,
      confirmedYes: 0,
      confirmedNo: 0,
      confirmedAbstain: 0,
      latestSubmittedAt: 1700000000,
      latestVerifiedAt: 1700000001,
      ...partial,
    };
  }

  test('anonymous visitors never see cohort chips', () => {
    useAuth.mockReturnValue({ isAuthenticated: false, user: null });
    useGovernanceData.mockReturnValue(baseData());
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({
        // Even if the hook returned data (it shouldn't for anon),
        // the page must not render cohort chips because the user
        // doesn't have a receipt trail we can trust.
        summary: [summaryRow({ total: 1, confirmed: 1, confirmedYes: 1 })],
        ownedCount: 2,
      })
    );

    renderPage();

    expect(screen.queryByTestId('proposal-row-cohort')).not.toBeInTheDocument();
  });

  test('authenticated user with all-confirmed receipts sees a "Voted yes" chip', () => {
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(
      baseData({
        proposals: [makeProposal({ Key: 'a'.repeat(64) })],
      })
    );
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({
        summary: [
          summaryRow({
            proposalHash: 'a'.repeat(64),
            total: 3,
            confirmed: 3,
            confirmedYes: 3,
          }),
        ],
        ownedCount: 3,
      })
    );

    renderPage();

    const chip = screen.getByTestId('proposal-row-cohort');
    expect(chip).toHaveTextContent(/voted yes/i);
    expect(chip.getAttribute('data-cohort-kind')).toBe('voted');
    // Detail tooltip is exposed via the title attr for now (PR 6b
    // native tooltip; PR 6c may upgrade to a richer popover).
    expect(chip.getAttribute('title')).toMatch(/confirmed on chain/i);
  });

  test('authenticated user with failed receipts sees a "Needs retry" chip', () => {
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(
      baseData({ proposals: [makeProposal({ Key: 'a'.repeat(64) })] })
    );
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({
        summary: [
          summaryRow({
            proposalHash: 'a'.repeat(64),
            total: 3,
            confirmed: 1,
            failed: 2,
            confirmedYes: 1,
          }),
        ],
        ownedCount: 3,
      })
    );

    renderPage();

    const chip = screen.getByTestId('proposal-row-cohort');
    expect(chip).toHaveTextContent(/needs retry/i);
    expect(chip.getAttribute('data-cohort-kind')).toBe('needs-retry');
  });

  test('authenticated user with owned MNs but no receipts sees a "Not voted" chip', () => {
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(baseData());
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({
        summary: [],
        ownedCount: 4,
      })
    );

    renderPage();

    const chip = screen.getByTestId('proposal-row-cohort');
    expect(chip).toHaveTextContent(/not voted/i);
    expect(chip.getAttribute('data-cohort-kind')).toBe('not-voted');
    expect(chip.getAttribute('title')).toMatch(/4 sentry nodes/);
  });

  test('authenticated user without a known owned count sees no chip on un-voted proposals', () => {
    // During the gap between "vault unlocked" and "/gov/mns/lookup
    // resolved", ownedCount is null. Skipping the chip here avoids
    // a flash of "Not voted" that would then quickly change.
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(baseData());
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({ summary: [], ownedCount: null })
    );

    renderPage();
    expect(screen.queryByTestId('proposal-row-cohort')).not.toBeInTheDocument();
  });

  test('summary map is looked up case-insensitively on proposal hash', () => {
    // The page lowercases the proposal hash before the map lookup
    // so a proposal emitted with mixed-case Key still finds its row.
    const MIXED_KEY = `${'A'.repeat(32)}${'b'.repeat(32)}`;
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(
      baseData({ proposals: [makeProposal({ Key: MIXED_KEY })] })
    );
    const row = summaryRow({
      proposalHash: MIXED_KEY.toLowerCase(),
      total: 1,
      confirmed: 1,
      confirmedYes: 1,
    });
    const map = new Map();
    map.set(MIXED_KEY.toLowerCase(), row);
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({ summary: [row], summaryMap: map, ownedCount: 1 })
    );

    renderPage();

    const chip = screen.getByTestId('proposal-row-cohort');
    expect(chip).toHaveTextContent(/voted yes/i);
  });

  test('closing the vote modal refreshes the receipts summary', async () => {
    // After a vote attempt the cohort chip may have changed (new
    // receipts, retry succeeded, etc.). The page re-fetches on
    // modal close so the chip stays in sync without a full page
    // reload.
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(baseData());
    const refresh = jest.fn().mockResolvedValue();
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({ summary: [], ownedCount: 2, refresh })
    );

    renderPage();

    // Baseline: the effect inside the hook mock we control; no
    // refresh() calls have happened yet from the page itself.
    expect(refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('proposal-row-vote'));
    expect(screen.getByTestId('modal-stub').getAttribute('data-open')).toBe(
      'true'
    );

    fireEvent.click(screen.getByTestId('modal-stub-close'));
    // Modal is unmounted (we render it only when voteProposal !== null).
    expect(screen.queryByTestId('modal-stub')).not.toBeInTheDocument();
    // And the summary was refreshed.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('closing the vote modal as an anonymous user does not call refresh', () => {
    // The anon path can't reach the Vote button, but belt-and-
    // braces: even if a refresh is somehow triggered, the guard
    // inside closeVoteModal keeps the call gated on isAuthenticated.
    useAuth.mockReturnValue({ isAuthenticated: false, user: null });
    useGovernanceData.mockReturnValue(baseData());
    const refresh = jest.fn().mockResolvedValue();
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({ summary: [], ownedCount: null, refresh })
    );

    renderPage();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('Governance page — verified-on-chain pill', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  function summaryRow(partial) {
    return {
      proposalHash: 'a'.repeat(64),
      total: 0,
      relayed: 0,
      confirmed: 0,
      stale: 0,
      failed: 0,
      confirmedYes: 0,
      confirmedNo: 0,
      confirmedAbstain: 0,
      latestSubmittedAt: 1700000000,
      latestVerifiedAt: 1700000001,
      ...partial,
    };
  }

  test('renders the "Verified" pill when the user has a fresh confirmed receipt', () => {
    // latestVerifiedAt within the freshness window (<5 min) — the
    // reconciler has recently observed this user's on-chain votes
    // for this proposal, so we surface a quiet confidence signal.
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(
      baseData({ proposals: [makeProposal({ Key: 'a'.repeat(64) })] })
    );
    const now = Date.now();
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({
        summary: [
          summaryRow({
            total: 2,
            confirmed: 2,
            confirmedYes: 2,
            latestVerifiedAt: now - 30_000,
          }),
        ],
        ownedCount: 2,
      })
    );

    renderPage();

    const pill = screen.getByTestId('proposal-row-verified');
    expect(pill).toBeInTheDocument();
    expect(pill.textContent).toMatch(/verified/i);
    expect(pill.getAttribute('title')).toMatch(
      /were last observed on-chain/i
    );
  });

  test('does not render when the confirmation is older than the freshness window', () => {
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(
      baseData({ proposals: [makeProposal({ Key: 'a'.repeat(64) })] })
    );
    const now = Date.now();
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({
        summary: [
          summaryRow({
            total: 1,
            confirmed: 1,
            confirmedYes: 1,
            // 1 hour old — well past the 5-minute window.
            latestVerifiedAt: now - 60 * 60 * 1000,
          }),
        ],
        ownedCount: 1,
      })
    );

    renderPage();

    expect(
      screen.queryByTestId('proposal-row-verified')
    ).not.toBeInTheDocument();
  });

  test('does not render when the user has no confirmed receipts for the proposal', () => {
    // Failed-only / relayed-only receipts should NOT get the
    // verified pill — that chip claims on-chain confirmation.
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(
      baseData({ proposals: [makeProposal({ Key: 'a'.repeat(64) })] })
    );
    const now = Date.now();
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({
        summary: [
          summaryRow({
            total: 2,
            failed: 2,
            latestVerifiedAt: now - 30_000,
          }),
        ],
        ownedCount: 2,
      })
    );

    renderPage();

    expect(
      screen.queryByTestId('proposal-row-verified')
    ).not.toBeInTheDocument();
  });

  test('anonymous visitors never see the Verified pill', () => {
    useAuth.mockReturnValue({ isAuthenticated: false, user: null });
    useGovernanceData.mockReturnValue(baseData());
    const now = Date.now();
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({
        summary: [
          summaryRow({
            total: 1,
            confirmed: 1,
            confirmedYes: 1,
            latestVerifiedAt: now - 30_000,
          }),
        ],
        ownedCount: 1,
      })
    );

    renderPage();

    expect(
      screen.queryByTestId('proposal-row-verified')
    ).not.toBeInTheDocument();
  });
});

describe('Governance page — proposal metadata chips', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('closing-soon chip renders when the voting deadline is within a week', () => {
    useAuth.mockReturnValue({ isAuthenticated: false, user: null });
    const threeDaysAhead = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
    useGovernanceData.mockReturnValue(
      baseData({
        stats: {
          stats: {
            mn_stats: { enabled: 1000 },
            superblock_stats: {
              budget: 1_000_000,
              voting_deadline: threeDaysAhead,
              superblock_date: threeDaysAhead + 60 * 60,
            },
          },
        },
      })
    );

    renderPage();

    const chips = screen.getAllByTestId('proposal-row-meta-chip');
    const closing = chips.find(
      (c) => c.getAttribute('data-meta-kind') === 'closing-soon'
    );
    expect(closing).toBeDefined();
    expect(closing.textContent).toMatch(/Closes in/i);
  });

  test('closing chip escalates to urgent tone when the deadline is within 48h', () => {
    useAuth.mockReturnValue({ isAuthenticated: false, user: null });
    const oneHourAhead = Math.floor(Date.now() / 1000) + 60 * 60;
    useGovernanceData.mockReturnValue(
      baseData({
        stats: {
          stats: {
            mn_stats: { enabled: 1000 },
            superblock_stats: {
              budget: 1_000_000,
              voting_deadline: oneHourAhead,
              superblock_date: oneHourAhead + 60 * 60,
            },
          },
        },
      })
    );

    renderPage();

    const chips = screen.getAllByTestId('proposal-row-meta-chip');
    const closing = chips.find(
      (c) => c.getAttribute('data-meta-kind') === 'closing-urgent'
    );
    expect(closing).toBeDefined();
  });

  test('margin-thin chip renders when passing support is just over 10%', () => {
    useAuth.mockReturnValue({ isAuthenticated: false, user: null });
    useGovernanceData.mockReturnValue(
      baseData({
        // 10.5% support → 0.5% over the line → within the margin.
        // No closing chip: the default baseData deadline is way in
        // the past relative to now, so closingChip returns null.
        proposals: [makeProposal({ AbsoluteYesCount: 105 })],
        stats: {
          stats: {
            mn_stats: { enabled: 1000 },
            superblock_stats: {
              budget: 1_000_000,
              voting_deadline: 1, // far past → no closing chip
              superblock_date: 1,
            },
          },
        },
      })
    );

    renderPage();

    const chips = screen.getAllByTestId('proposal-row-meta-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute('data-meta-kind')).toBe('margin-thin');
    expect(chips[0].textContent).toMatch(/slim margin/i);
  });

  test('margin-near chip renders when support is just under 10%', () => {
    useAuth.mockReturnValue({ isAuthenticated: false, user: null });
    useGovernanceData.mockReturnValue(
      baseData({
        proposals: [makeProposal({ AbsoluteYesCount: 92 })],
        stats: {
          stats: {
            mn_stats: { enabled: 1000 },
            superblock_stats: {
              budget: 1_000_000,
              voting_deadline: 1,
              superblock_date: 1,
            },
          },
        },
      })
    );

    renderPage();

    const chips = screen.getAllByTestId('proposal-row-meta-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute('data-meta-kind')).toBe('margin-near');
  });

  test('over-budget chip only decorates the proposals below the ranking cutline', () => {
    useAuth.mockReturnValue({ isAuthenticated: false, user: null });
    // Two passing proposals (12% and 15% support) each requesting
    // 80 SYS against a 100 SYS ceiling. Rank 1 (15%) stays inside
    // the budget; rank 2 (12%) sits past the cutline → over-budget.
    const A = 'a'.repeat(64);
    const B = 'b'.repeat(64);
    useGovernanceData.mockReturnValue(
      baseData({
        proposals: [
          makeProposal({
            Key: A,
            title: 'Top',
            AbsoluteYesCount: 150,
            payment_amount: '80',
          }),
          makeProposal({
            Key: B,
            title: 'Tail',
            AbsoluteYesCount: 120,
            payment_amount: '80',
          }),
        ],
        stats: {
          stats: {
            mn_stats: { enabled: 1000 },
            superblock_stats: {
              budget: 100,
              voting_deadline: 1,
              superblock_date: 1,
            },
          },
        },
      })
    );

    renderPage();

    // Find every row and check its meta-chip set. The top-ranked
    // row should NOT have an over-budget chip; the tail one should.
    const allChips = screen.queryAllByTestId('proposal-row-meta-chip');
    const overBudgetKinds = allChips
      .filter((c) => c.getAttribute('data-meta-kind') === 'over-budget');
    expect(overBudgetKinds).toHaveLength(1);
  });
});

describe('Governance page — time-sensitive chips refresh on long-lived sessions', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('closing chip escalates from "soon" to "urgent" as the deadline approaches without a stats refresh', () => {
    useAuth.mockReturnValue({ isAuthenticated: false, user: null });
    // Deadline 72h out. Under soon threshold (7d) but above urgent
    // threshold (48h) → starts as closing-soon.
    const deadlineSec = Math.floor(Date.now() / 1000) + 72 * 60 * 60;
    useGovernanceData.mockReturnValue(
      baseData({
        stats: {
          stats: {
            mn_stats: { enabled: 1000 },
            superblock_stats: {
              budget: 1_000_000,
              voting_deadline: deadlineSec,
              superblock_date: deadlineSec + 60 * 60,
            },
          },
        },
      })
    );

    renderPage();
    {
      const chips = screen.getAllByTestId('proposal-row-meta-chip');
      const closing = chips.find((c) =>
        c.getAttribute('data-meta-kind').startsWith('closing-')
      );
      expect(closing.getAttribute('data-meta-kind')).toBe('closing-soon');
    }

    // Advance wall-clock past the 48h urgency line WITHOUT mutating
    // the stats object. The tick should still demote the chip.
    act(() => {
      jest.setSystemTime(Date.now() + 25 * 60 * 60 * 1000); // +25h → 47h remaining
      jest.advanceTimersByTime(60 * 1000 + 10); // one ticker interval
    });

    {
      const chips = screen.getAllByTestId('proposal-row-meta-chip');
      const closing = chips.find((c) =>
        c.getAttribute('data-meta-kind').startsWith('closing-')
      );
      expect(closing.getAttribute('data-meta-kind')).toBe('closing-urgent');
    }
  });

  test('closing chip disappears after the deadline passes even without a stats refresh', () => {
    useAuth.mockReturnValue({ isAuthenticated: false, user: null });
    const deadlineSec = Math.floor(Date.now() / 1000) + 5 * 60; // 5m away
    useGovernanceData.mockReturnValue(
      baseData({
        stats: {
          stats: {
            mn_stats: { enabled: 1000 },
            superblock_stats: {
              budget: 1_000_000,
              voting_deadline: deadlineSec,
              superblock_date: deadlineSec + 60 * 60,
            },
          },
        },
      })
    );

    renderPage();
    // Deadline not yet passed → chip present (urgent tier).
    expect(
      screen
        .getAllByTestId('proposal-row-meta-chip')
        .some((c) => c.getAttribute('data-meta-kind') === 'closing-urgent')
    ).toBe(true);

    // Jump 10 minutes ahead and tick the clock — now the deadline
    // is in the past and the chip should be gone.
    act(() => {
      jest.setSystemTime(Date.now() + 10 * 60 * 1000);
      jest.advanceTimersByTime(60 * 1000 + 10);
    });

    expect(
      screen
        .queryAllByTestId('proposal-row-meta-chip')
        .some((c) => String(c.getAttribute('data-meta-kind')).startsWith('closing-'))
    ).toBe(false);
  });
});

describe('Governance page — jumpToProposal filter-aware behaviour', () => {
  afterEach(() => {
    jest.clearAllMocks();
    if (typeof global !== 'undefined') {
      delete global.__ACTIVITY_STUB_JUMP_KEY__;
    }
  });

  test('jumping to a proposal that is hidden by the "Watch" filter clears the filter so the row becomes mountable', () => {
    // Two proposals:
    //   - "passing" (12% support) → visible under the Passing filter
    //   - "watch"   (5% support)  → hidden under the Passing filter
    // The activity card surfaces a jump to the watch-list proposal
    // while the user has "Passing" selected. Without the fix the
    // click is a silent no-op because the row isn't in the DOM.
    // With the fix, filter clears back to "All" so the row mounts
    // and the highlight attribute eventually fires.
    const PASSING = 'a'.repeat(64);
    const WATCH = 'b'.repeat(64);
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(
      baseData({
        proposals: [
          makeProposal({
            Key: PASSING,
            title: 'Passing one',
            AbsoluteYesCount: 120,
          }),
          makeProposal({
            Key: WATCH,
            title: 'Watch one',
            AbsoluteYesCount: 50,
          }),
        ],
        stats: {
          stats: {
            mn_stats: { enabled: 1000 },
            superblock_stats: {
              budget: 1_000_000,
              voting_deadline: 1,
              superblock_date: 1,
            },
          },
        },
      })
    );
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({ summary: [], ownedCount: 1 })
    );

    renderPage();

    // Switch to the Passing filter — Watch proposal is now hidden.
    fireEvent.click(screen.getByRole('button', { name: /^passing$/i }));
    expect(document.getElementById(`proposal-row-${WATCH}`)).toBeNull();
    expect(document.getElementById(`proposal-row-${PASSING}`)).not.toBeNull();

    // Simulate the activity card asking us to jump to the hidden
    // Watch proposal. The stub reads the target key from a global
    // so we can pick the hash per test.
    global.__ACTIVITY_STUB_JUMP_KEY__ = WATCH;
    fireEvent.click(screen.getByTestId('activity-stub-jump'));

    // Filter clears → the hidden row becomes mountable again.
    // We assert on the DOM id directly rather than waiting for
    // the requestAnimationFrame-scheduled scroll, because JSDOM
    // commits the setState synchronously but rAF-scheduled reads
    // would require a fake-timer dance here.
    expect(document.getElementById(`proposal-row-${WATCH}`)).not.toBeNull();
  });

  test('jumping to a proposal that is already visible leaves the filter untouched', () => {
    // Two proposals both passing; we stay on the "Passing" filter
    // and jump to one of them. The filter shouldn't reset to "All"
    // behind the user's back — the target row is already mounted.
    const A = 'a'.repeat(64);
    const B = 'b'.repeat(64);
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(
      baseData({
        proposals: [
          makeProposal({ Key: A, title: 'A', AbsoluteYesCount: 150 }),
          makeProposal({ Key: B, title: 'B', AbsoluteYesCount: 130 }),
        ],
      })
    );
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({ summary: [], ownedCount: 1 })
    );

    renderPage();

    const passingBtn = screen.getByRole('button', { name: /^passing$/i });
    fireEvent.click(passingBtn);
    expect(passingBtn.className).toMatch(/is-active/);

    global.__ACTIVITY_STUB_JUMP_KEY__ = A;
    fireEvent.click(screen.getByTestId('activity-stub-jump'));

    // Passing button is still the active filter — no silent reset.
    expect(passingBtn.className).toMatch(/is-active/);
    expect(document.getElementById(`proposal-row-${A}`)).not.toBeNull();
  });
});

describe('Governance page — PR 6d chip accessibility', () => {
  // Chips now publish their detail via three mutually-reinforcing
  // channels so touch, keyboard, mouse, and screen-reader users all
  // reach the same information:
  //   - title=           (desktop mouse, legacy fallback)
  //   - data-tip=        (CSS-driven tap/focus/hover popover)
  //   - aria-label=      (screen readers; combines label + detail)
  //   - tabIndex=0       (reachable via keyboard and tap focus)
  //
  // These tests lock that contract down so future refactors can't
  // silently regress any of those channels.

  afterEach(() => {
    jest.clearAllMocks();
  });

  function summaryRow(partial) {
    return {
      proposalHash: 'a'.repeat(64),
      total: 0,
      relayed: 0,
      confirmed: 0,
      stale: 0,
      failed: 0,
      confirmedYes: 0,
      confirmedNo: 0,
      confirmedAbstain: 0,
      latestSubmittedAt: 1700000000,
      latestVerifiedAt: 1700000001,
      ...partial,
    };
  }

  test('cohort chip exposes tap/focus tooltip + aria-label including detail', () => {
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(
      baseData({ proposals: [makeProposal({ Key: 'a'.repeat(64) })] })
    );
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({
        summary: [
          summaryRow({ total: 3, confirmed: 3, confirmedYes: 3 }),
        ],
        ownedCount: 3,
      })
    );

    renderPage();

    const chip = screen.getByTestId('proposal-row-cohort');
    expect(chip.getAttribute('tabindex')).toBe('0');
    expect(chip.getAttribute('role')).toBe('note');
    expect(chip.getAttribute('data-tip')).toBeTruthy();
    expect(chip.getAttribute('data-tip')).toEqual(chip.getAttribute('title'));
    const aria = chip.getAttribute('aria-label') || '';
    expect(aria).toMatch(/voted yes/i);
    expect(aria).toMatch(/confirmed on chain/i);
  });

  test('verified pill exposes tap/focus tooltip + aria-label including detail', () => {
    useAuth.mockReturnValue({ isAuthenticated: true, user: { id: 1 } });
    useGovernanceData.mockReturnValue(
      baseData({ proposals: [makeProposal({ Key: 'a'.repeat(64) })] })
    );
    const now = Date.now();
    useGovernanceReceipts.mockReturnValue(
      makeReceipts({
        summary: [
          summaryRow({
            total: 2,
            confirmed: 2,
            confirmedYes: 2,
            latestVerifiedAt: now - 30_000,
          }),
        ],
        ownedCount: 2,
      })
    );

    renderPage();

    const pill = screen.getByTestId('proposal-row-verified');
    expect(pill.getAttribute('tabindex')).toBe('0');
    expect(pill.getAttribute('role')).toBe('note');
    expect(pill.getAttribute('data-tip')).toBeTruthy();
    expect(pill.getAttribute('data-tip')).toEqual(pill.getAttribute('title'));
    const aria = pill.getAttribute('aria-label') || '';
    expect(aria).toMatch(/verified on-chain/i);
    expect(aria).toMatch(/were last observed on-chain/i);
  });

  test('meta chips (closing / over-budget / margin) all expose the tooltip contract', () => {
    // Give the row a chip by squeezing the superblock voting_deadline
    // so the closing-urgent chip lights up. One chip is enough to
    // assert the contract — computeOverBudgetMap / marginChip / closingChip
    // all funnel through the same JSX branch.
    useAuth.mockReturnValue({ isAuthenticated: false, user: null });
    useGovernanceData.mockReturnValue(
      baseData({
        stats: {
          stats: {
            mn_stats: { enabled: 1000 },
            superblock_stats: {
              budget: 1000000,
              // 30 minutes from now — inside the closing-urgent window.
              voting_deadline:
                Math.floor(Date.now() / 1000) + 30 * 60,
              superblock_date: Math.floor(Date.now() / 1000) + 24 * 3600,
            },
          },
        },
      })
    );

    renderPage();

    const chips = screen.getAllByTestId('proposal-row-meta-chip');
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip.getAttribute('tabindex')).toBe('0');
      expect(chip.getAttribute('role')).toBe('note');
      expect(chip.getAttribute('data-tip')).toBeTruthy();
      expect(chip.getAttribute('data-tip')).toEqual(
        chip.getAttribute('title')
      );
      const aria = chip.getAttribute('aria-label') || '';
      // aria-label should be strictly richer than the chip's
      // visible label — i.e. include the detail text too.
      expect(aria.length).toBeGreaterThan(
        (chip.textContent || '').trim().length
      );
    }
  });
});
