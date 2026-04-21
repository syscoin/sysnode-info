import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import DataState from '../components/DataState';
import PageMeta from '../components/PageMeta';
import ProposalVoteModal from '../components/ProposalVoteModal';
import { useAuth } from '../context/AuthContext';
import useGovernanceData from '../hooks/useGovernanceData';
import {
  formatCompactNumber,
  formatDayMonth,
  formatDateFromEpoch,
  formatNumber,
  formatPercent,
  formatShortDate,
  formatUtcTime,
  getProposalDurationMonths,
  parseNumber,
} from '../lib/formatters';

// Governance page.
//
// Two voter cohorts get different action affordances on each row:
//
//   Anonymous  → "Yes" / "No" buttons copy a `gobject_vote_many` CLI
//                command to the clipboard. That's the legacy flow;
//                preserved so operators without a sysnode account can
//                still use the page as a quick CLI helper.
//
//   Authenticated → Single "Vote" button opens a modal that signs
//                votes locally against the user's vault and relays
//                them to the backend. No CLI required; abstain is an
//                option; per-MN selection lets operators split votes
//                across multiple proposals without copy-pasting.
//
// Logged-out users also get a CTA banner above the list inviting
// them to log in for one-click voting. We intentionally don't hide
// the CLI fallback for them — preserving muscle memory is a feature,
// not a bug. (See the syshub UX issues the user flagged — deleting
// legacy paths without an equivalent replacement was a repeat
// complaint.)

function ProposalRow({
  proposal,
  enabledCount,
  isAuthenticated,
  onVote,
}) {
  const [feedback, setFeedback] = useState('');
  const supportPercent = enabledCount
    ? (Number(proposal.AbsoluteYesCount || 0) / enabledCount) * 100
    : 0;
  const yesVotes = Number(proposal.YesCount || 0);
  const noVotes = Number(proposal.NoCount || 0);
  const passing = supportPercent > 10;
  const paymentAmount = parseNumber(proposal.payment_amount);
  const durationMonths = getProposalDurationMonths(
    proposal.start_epoch,
    proposal.end_epoch
  );

  useEffect(
    function clearFeedback() {
      if (!feedback) {
        return undefined;
      }

      const timer = window.setTimeout(function hideMessage() {
        setFeedback('');
      }, 1600);

      return function cleanup() {
        window.clearTimeout(timer);
      };
    },
    [feedback]
  );

  const proposalTitle = proposal.title || proposal.name;
  const statusLabel = passing ? 'Passing' : 'Not enough votes';

  async function copyCommand(direction) {
    try {
      await navigator.clipboard.writeText(
        `gobject_vote_many ${proposal.Key} funding ${direction}`
      );
      setFeedback(`${direction === 'yes' ? 'Yes' : 'No'} vote command copied.`);
    } catch (error) {
      setFeedback('Clipboard access is unavailable in this browser.');
    }
  }

  return (
    <article className={passing ? 'proposal-row is-passing' : 'proposal-row is-watch'}>
      <div className="proposal-row__status">
        <span className={passing ? 'status-chip is-positive' : 'status-chip is-warning'}>
          {statusLabel}
        </span>
      </div>

      <div className="proposal-row__main">
        <h3>{proposalTitle}</h3>
        <div className="proposal-row__meta-line">
          <span className="proposal-row__sponsor">{proposal.name}</span>
          <span className="proposal-row__meta-separator" aria-hidden="true">
            •
          </span>
          <span>Created {formatDateFromEpoch(proposal.CreationTime)}</span>
        </div>
      </div>

      <div className="proposal-row__metric">
        <span className="proposal-row__metric-label">Budget</span>
        <strong>{`${formatCompactNumber(paymentAmount)} SYS/month`}</strong>
      </div>

      <div className="proposal-row__metric">
        <span className="proposal-row__metric-label">Duration</span>
        <strong>{`${durationMonths} ${durationMonths === 1 ? 'month' : 'months'}`}</strong>
      </div>

      <div className="proposal-row__metric">
        <span className="proposal-row__metric-label">Support</span>
        <strong>{formatPercent(supportPercent, 2)}</strong>
      </div>

      <div className="proposal-row__metric">
        <span className="proposal-row__metric-label">Votes</span>
        <strong>{`${formatNumber(yesVotes)} / ${formatNumber(noVotes)}`}</strong>
      </div>

      <div className="proposal-row__actions">
        {proposal.url ? (
          <a
            className="button button--ghost button--small proposal-row__action proposal-row__action--proposal"
            href={proposal.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open proposal"
          >
            Proposal
          </a>
        ) : null}

        {isAuthenticated ? (
          <button
            type="button"
            className="button button--primary button--small proposal-row__action proposal-row__action--vote"
            aria-label="Vote on proposal"
            onClick={function handleVoteClick() {
              onVote(proposal);
            }}
            data-testid="proposal-row-vote"
          >
            Vote
          </button>
        ) : (
          <>
            <button
              type="button"
              className="button button--ghost button--small proposal-row__action proposal-row__action--yes"
              aria-label="Copy yes vote command"
              onClick={function handleYesCopy() {
                copyCommand('yes');
              }}
            >
              Yes
            </button>
            <button
              type="button"
              className="button button--ghost button--small proposal-row__action proposal-row__action--no"
              aria-label="Copy no vote command"
              onClick={function handleNoCopy() {
                copyCommand('no');
              }}
            >
              No
            </button>
          </>
        )}
      </div>

      {feedback ? <p className="inline-feedback">{feedback}</p> : null}
    </article>
  );
}

export default function Governance() {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [voteProposal, setVoteProposal] = useState(null);
  const { error, loading, proposals, stats } = useGovernanceData();
  const { isAuthenticated } = useAuth();

  const networkStats = stats && stats.stats ? stats.stats.mn_stats : null;
  const superblockStats = stats && stats.stats ? stats.stats.superblock_stats : null;
  const enabledCount = parseNumber(networkStats && networkStats.enabled);
  const requestedBudget = proposals.reduce(function sumBudget(total, proposal) {
    return total + Number(proposal.payment_amount || 0);
  }, 0);
  const visibleProposals = proposals.filter(function filterProposal(proposal) {
    const supportPercent = enabledCount
      ? (Number(proposal.AbsoluteYesCount || 0) / enabledCount) * 100
      : 0;
    const matchesQuery = !query
      ? true
      : `${proposal.name} ${proposal.title || ''}`
          .toLowerCase()
          .includes(query.trim().toLowerCase());

    if (!matchesQuery) {
      return false;
    }

    if (filter === 'passing') {
      return supportPercent > 10;
    }

    if (filter === 'watch') {
      return supportPercent <= 10;
    }

    return true;
  });

  const openVoteModal = useCallback((proposal) => {
    setVoteProposal(proposal);
  }, []);

  const closeVoteModal = useCallback(() => {
    setVoteProposal(null);
  }, []);

  return (
    <main className="page-main">
      <PageMeta
        title="Governance"
        description="Track active Syscoin governance proposals, requested budgets, voting deadlines, superblocks, and vote directly from your vault or via copy-ready CLI commands."
      />

      <section className="page-hero">
        <div className="site-wrap page-hero__layout page-hero__layout--governance">
          <div>
            <p className="eyebrow">Syscoin Governance</p>
            <h1>Keep up with governance.</h1>
            <p className="page-hero__copy">
              See what is up for vote, how much has been requested, when voting closes, and when the next superblock lands.
            </p>
          </div>

          <div className="panel governance-summary governance-summary--hero">
            <div className="governance-summary__item">
              <span>Current Proposals</span>
              <strong>{formatNumber(proposals.length)}</strong>
              <small>Vote Today!</small>
            </div>
            <div className="governance-summary__item">
              <span>Monthly Budget</span>
              <strong>
                {superblockStats ? `${formatCompactNumber(superblockStats.budget)} SYS` : 'Loading...'}
              </strong>
              <small>Current Monthly Ceiling</small>
            </div>
            <div className="governance-summary__item">
              <span>Requested Budget</span>
              <strong>{`${formatCompactNumber(requestedBudget)} SYS`}</strong>
              <small>Total Proposal Budget Ask</small>
            </div>
            <div className="governance-summary__item">
              <span>Voting Deadline</span>
              <strong>
                {superblockStats ? formatShortDate(superblockStats.voting_deadline) : 'Loading...'}
              </strong>
              <small>
                {superblockStats
                  ? `${formatUtcTime(superblockStats.voting_deadline)} (UTC)`
                  : 'Pending feed'}
              </small>
            </div>
            <div className="governance-summary__item">
              <span>Next Superblock</span>
              <strong>
                {superblockStats ? formatDayMonth(superblockStats.superblock_date) : 'Loading...'}
              </strong>
              <small>
                {superblockStats
                  ? `${formatUtcTime(superblockStats.superblock_date)} (UTC)`
                  : 'Pending feed'}
              </small>
            </div>
          </div>
        </div>
      </section>

      <section className="page-section page-section--tight">
        <div className="site-wrap">
          <DataState
            error={error}
            loading={loading && !stats}
            loadingMessage="Loading the live governance feed..."
          />
          {!isAuthenticated && stats ? (
            <div
              className="panel governance-cta"
              data-testid="governance-login-cta"
            >
              <p>
                <strong>Vote in one click.</strong>{' '}
                <Link to="/login">Log in</Link> and import your
                masternode voting keys on the{' '}
                <Link to="/account">Account page</Link> to vote
                without leaving the browser — no CLI needed.
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {stats ? (
        <section className="page-section page-section--last">
          <div className="site-wrap panel panel--table">
            <div className="panel__header panel__header--table">
              <div>
                <p className="eyebrow">Syscoin Proposal Watchlist</p>
              </div>
            </div>
            <div className="proposal-toolbar">
              <input
                type="search"
                className="search-input"
                value={query}
                placeholder="Search for proposal"
                onChange={function handleQueryChange(event) {
                  setQuery(event.target.value);
                }}
              />
              <div className="proposal-controls">
                <div className="filter-switcher" aria-label="Proposal filters">
                  <button
                    type="button"
                    className={filter === 'all' ? 'filter-switcher__button is-active' : 'filter-switcher__button'}
                    onClick={function showAll() {
                      setFilter('all');
                    }}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={
                      filter === 'passing'
                        ? 'filter-switcher__button is-active'
                        : 'filter-switcher__button'
                    }
                    onClick={function showPassing() {
                      setFilter('passing');
                    }}
                  >
                    Passing
                  </button>
                  <button
                    type="button"
                    className={
                      filter === 'watch'
                        ? 'filter-switcher__button is-active'
                        : 'filter-switcher__button'
                    }
                    onClick={function showWatch() {
                      setFilter('watch');
                    }}
                  >
                    Not Passing
                  </button>
                </div>
              </div>
            </div>

            {visibleProposals.length ? (
              <div className="proposal-table">
                <div className="proposal-table__head" aria-hidden="true">
                  <span>Status</span>
                  <span>Proposal</span>
                  <span>Budget</span>
                  <span>Duration</span>
                  <span>Support</span>
                  <span>Yes/No</span>
                  <span>Actions</span>
                </div>
                <div className="proposal-table__body">
                  {visibleProposals.map(function renderProposal(proposal) {
                    return (
                      <ProposalRow
                        key={proposal.Key}
                        proposal={proposal}
                        enabledCount={enabledCount}
                        isAuthenticated={isAuthenticated}
                        onVote={openVoteModal}
                      />
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="state-block">
                No proposals matched the current filter. Try switching back to “All” or
                clearing the search field.
              </div>
            )}
          </div>
        </section>
      ) : null}

      {/*
        Mount the vote modal only when the user has actually picked
        a proposal. Keeping it mounted unconditionally would fire
        its hooks (useAuth / useVault / useOwnedMasternodes) on
        every Governance page view — and even with the hook's
        `enabled: open` gate in place as defense-in-depth, the
        idiomatic React pattern is to not keep dormant dialogs in
        the tree. Unmount on close means a fresh, clean state
        next time the user clicks Vote.
      */}
      {voteProposal !== null ? (
        <ProposalVoteModal
          open
          proposal={voteProposal}
          onClose={closeVoteModal}
        />
      ) : null}
    </main>
  );
}
