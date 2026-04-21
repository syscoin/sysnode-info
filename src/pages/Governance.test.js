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
jest.mock('../components/ProposalVoteModal', () => (props) => (
  <div
    data-testid="modal-stub"
    data-open={String(!!props.open)}
    data-proposal={props.proposal ? props.proposal.Key : ''}
  />
));

// eslint-disable-next-line import/first
import Governance from './Governance';
// eslint-disable-next-line import/first
import useGovernanceData from '../hooks/useGovernanceData';
// eslint-disable-next-line import/first
import { useAuth } from '../context/AuthContext';

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

function renderPage() {
  return render(
    <MemoryRouter>
      <Governance />
    </MemoryRouter>
  );
}

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
