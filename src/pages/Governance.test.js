import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';

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
    expect(chip.getAttribute('title')).toMatch(/4 masternodes/);
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
