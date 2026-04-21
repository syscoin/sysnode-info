import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import DataState from '../components/DataState';
import GovernanceActivity from '../components/GovernanceActivity';
import GovernanceOpsHero from '../components/GovernanceOpsHero';
import PageMeta from '../components/PageMeta';
import ProposalVoteModal from '../components/ProposalVoteModal';
import { useAuth } from '../context/AuthContext';
import useGovernanceData from '../hooks/useGovernanceData';
import { useGovernanceReceipts } from '../hooks/useGovernanceReceipts';
import { cohortChip } from '../lib/governanceCohort';
import {
  closingChip,
  computeOverBudgetMap,
  marginChip,
} from '../lib/governanceMeta';
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

// DOM id format used to let the ops hero jump-link scroll to a
// specific proposal row. Governance hashes are case-insensitive
// hex; lowercasing matches the normalisation used by the summary
// map and keeps the id stable across re-renders.
export function proposalRowDomId(key) {
  if (typeof key !== 'string' || !key) return '';
  return `proposal-row-${key.toLowerCase()}`;
}

// How fresh a `latestVerifiedAt` must be for the row to render the
// "Verified on-chain" pill. Matches the backend's
// DEFAULT_RECEIPTS_FRESHNESS_MS window (2 minutes) relaxed slightly
// to cover UI-side drift — anything older than ~5 minutes we treat
// as "probably still correct but not a confident live read" and
// fall back to the plain cohort chip.
const VERIFIED_FRESHNESS_MS = 5 * 60 * 1000;

// Small relative time helper scoped to the row. Purposely narrow:
// we only need to distinguish "just now" / "N minutes ago" for
// tooltip copy. A broader formatter lives locally in
// GovernanceActivity for its own use; if a third consumer arrives
// we should hoist a shared one into lib/formatters.
function verifiedAgo(verifiedAt, nowMs) {
  const ts = Number(verifiedAt);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const diffSec = Math.max(0, Math.round((now - ts) / 1000));
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const mins = Math.round(diffSec / 60);
  return `${mins}m ago`;
}

function ProposalRow({
  proposal,
  enabledCount,
  isAuthenticated,
  onVote,
  cohort,
  isHighlighted,
  summaryRow,
  metaChips,
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

  const rowClasses = [
    'proposal-row',
    passing ? 'is-passing' : 'is-watch',
    isHighlighted ? 'is-highlighted' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      className={rowClasses}
      id={proposalRowDomId(proposal.Key)}
      data-testid={isHighlighted ? 'proposal-row-highlighted' : undefined}
    >
      <div className="proposal-row__status">
        <span className={passing ? 'status-chip is-positive' : 'status-chip is-warning'}>
          {statusLabel}
        </span>
        {cohort ? (
          <span
            className={`status-chip cohort-chip cohort-chip--${cohort.kind}`}
            title={cohort.detail}
            data-testid="proposal-row-cohort"
            data-cohort-kind={cohort.kind}
          >
            {cohort.label}
          </span>
        ) : null}
        {(() => {
          // On-chain verified pill: a quiet "your vote is observed
          // on-chain and was last checked <X> ago" indicator. We
          // deliberately only show it when (a) the user has at
          // least one confirmed receipt for this proposal (i.e. the
          // cohort chip already reads "Voted"), and (b) the last
          // verification happened recently enough that it's still
          // a meaningful confidence signal. Otherwise the row
          // would shout "verified!" for rows the reconciler hasn't
          // actually touched in an hour.
          if (!summaryRow) return null;
          const confirmed = Number(summaryRow.confirmed);
          if (!(Number.isFinite(confirmed) && confirmed > 0)) return null;
          const latestVerifiedAt = Number(summaryRow.latestVerifiedAt);
          if (!Number.isFinite(latestVerifiedAt) || latestVerifiedAt <= 0) {
            return null;
          }
          const age = Date.now() - latestVerifiedAt;
          if (!(age >= 0 && age < VERIFIED_FRESHNESS_MS)) return null;
          const ago = verifiedAgo(latestVerifiedAt);
          const verifiedWhen = new Date(latestVerifiedAt).toUTCString();
          const tooltip =
            `${confirmed} of your ${
              confirmed === 1 ? 'vote' : 'votes'
            } were last observed on-chain ${ago} (${verifiedWhen}).`;
          return (
            <span
              className="status-chip verified-chip"
              title={tooltip}
              data-testid="proposal-row-verified"
              aria-label="Verified on-chain"
            >
              <span aria-hidden="true" className="verified-chip__mark">
                ✓
              </span>
              <span className="verified-chip__label">
                Verified {ago}
              </span>
            </span>
          );
        })()}
        {Array.isArray(metaChips) && metaChips.length > 0
          ? metaChips.map((chip) => (
              <span
                key={chip.kind}
                className={`status-chip meta-chip meta-chip--${chip.kind}`}
                title={chip.detail}
                data-testid="proposal-row-meta-chip"
                data-meta-kind={chip.kind}
              >
                {chip.label}
              </span>
            ))
          : null}
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

// How long the ops-hero "Jump to next" highlight stays visible on
// the target row before fading out. Long enough for the user's
// eye to land on it post-scroll; short enough that it doesn't
// stick around competing for attention if they then start
// interacting with the row.
const JUMP_HIGHLIGHT_MS = 2400;

export default function Governance() {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [voteProposal, setVoteProposal] = useState(null);
  const [highlightKey, setHighlightKey] = useState(null);
  // Bumping this token re-runs the "Your activity" fetch. We bump
  // it when the vote modal closes so a freshly-submitted vote shows
  // up in the activity list without forcing a full page reload.
  const [activityRefreshToken, setActivityRefreshToken] = useState(0);
  const highlightTimerRef = useRef(null);
  const {
    error,
    loading,
    proposals,
    stats,
    refresh: refreshGovernanceFeed,
  } = useGovernanceData();
  const { isAuthenticated } = useAuth();
  // Cohort-aware data — only meaningful for authenticated users.
  // When anonymous, the hook returns dormant empties and does not
  // hit /gov/receipts/summary or /gov/mns/lookup.
  const { summaryMap, ownedCount, refresh: refreshReceipts } =
    useGovernanceReceipts({ enabled: isAuthenticated });

  // Hash → proposal lookup for the activity card so receipts can
  // render titles and the jump-link can route the user to an
  // existing row. Built once per feed load; the activity card
  // handles missing entries gracefully (receipt lands without a
  // jump button).
  const proposalsByHash = useMemo(() => {
    const m = new Map();
    for (const p of proposals) {
      if (p && typeof p.Key === 'string') {
        m.set(p.Key.toLowerCase(), p);
      }
    }
    return m;
  }, [proposals]);

  const networkStats = stats && stats.stats ? stats.stats.mn_stats : null;
  const superblockStats = stats && stats.stats ? stats.stats.superblock_stats : null;
  const enabledCount = parseNumber(networkStats && networkStats.enabled);
  const requestedBudget = proposals.reduce(function sumBudget(total, proposal) {
    return total + Number(proposal.payment_amount || 0);
  }, 0);

  // Feed-wide over-budget computation: precomputed once per render
  // so each ProposalRow can look its chip up by hash in O(1)
  // without reiterating the whole feed. Rebuilds on any change to
  // proposals / enabledCount / budget; all three are referentially
  // stable between fetches so the memo hit rate is high.
  const overBudgetMap = useMemo(
    () =>
      computeOverBudgetMap({
        proposals,
        enabledCount,
        budget: superblockStats ? superblockStats.budget : 0,
      }),
    [proposals, enabledCount, superblockStats]
  );

  // Per-row closing chip depends only on the superblock deadline,
  // so we derive it once per render and reuse the single object
  // for every row. (Using Date.now() here is fine: the chip's
  // rounding makes sub-minute drift invisible and any hard-timed
  // behaviour — e.g. disabling the vote button at the deadline —
  // lives server-side, not in this label.)
  const closing = useMemo(
    () =>
      closingChip({
        votingDeadline: superblockStats ? superblockStats.voting_deadline : 0,
      }),
    [superblockStats]
  );
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

  // Smoothly scroll to a proposal by hash and briefly highlight
  // it so the user's eye lands on the right row.
  //
  // Filter-aware: the activity card can surface jumps to proposals
  // that are currently hidden by the search/filter switcher (e.g.
  // the user filtered to "Passing" and then clicks a jump for a
  // receipt on a watch-list proposal). Clicking a jump CTA that
  // scrolls to nothing is a silent dead-end, which is the worst
  // possible UX here — so before we look up the DOM id we clear
  // any filter state that would be suppressing the target row,
  // *only when* we can confirm the target exists in the full
  // proposals list (we don't want to clobber the user's filter
  // for a hash we wouldn't be able to show anyway).
  //
  // Scrolling happens inside a requestAnimationFrame so React has
  // a chance to re-render the filtered list after the setState
  // calls; otherwise the target row might not yet be in the DOM.
  const jumpToProposal = useCallback((key) => {
    if (typeof key !== 'string' || !key) return;
    const normalizedKey = key.toLowerCase();
    const domId = proposalRowDomId(key);
    if (!domId) return;

    const existsInFeed = proposals.some(
      (p) => p && typeof p.Key === 'string' && p.Key.toLowerCase() === normalizedKey
    );
    if (existsInFeed) {
      // Only touch filter state if the target would otherwise be
      // hidden. Keeps the user's current filter intact when they
      // click a jump CTA on an already-visible row.
      const visibleInFeed = visibleProposals.some(
        (p) =>
          p && typeof p.Key === 'string' && p.Key.toLowerCase() === normalizedKey
      );
      if (!visibleInFeed) {
        setFilter('all');
        setQuery('');
      }
    }

    const doScroll = () => {
      if (typeof document === 'undefined') return;
      const el = document.getElementById(domId);
      if (!el || typeof el.scrollIntoView !== 'function') return;
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (_e) {
        // Older test environments / JSDOM may not accept the
        // options object. Fall back to the plain scrollIntoView
        // rather than throwing in a user-facing path.
        try {
          el.scrollIntoView();
        } catch (_e2) {
          // Nothing else we can do; the highlight alone will
          // still hint to the user that we jumped.
        }
      }
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(doScroll);
    } else {
      doScroll();
    }

    setHighlightKey(key);
    if (highlightTimerRef.current) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightKey(null);
      highlightTimerRef.current = null;
    }, JUMP_HIGHLIGHT_MS);
  }, [proposals, visibleProposals]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
    };
  }, []);

  const closeVoteModal = useCallback(() => {
    setVoteProposal(null);
    // Re-fetch the summary so the cohort chip reflects whatever
    // the user just did in the modal (new votes, retried votes,
    // etc.). Cheap enough — it's one SQL query on the backend, no
    // RPC. `refreshOwned` stays false because the vault key set
    // can't change from inside the vote modal.
    if (isAuthenticated && typeof refreshReceipts === 'function') {
      refreshReceipts().catch(() => {
        // Swallow — non-critical UI freshness, no banner.
      });
    }
    // Same rationale for the activity card — a vote just closed so
    // the "last 10" almost certainly changed.
    setActivityRefreshToken((v) => v + 1);
  }, [isAuthenticated, refreshReceipts]);

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
          {isAuthenticated && stats ? (
            <div className="gov-auth-rail">
              <GovernanceOpsHero
                proposals={visibleProposals}
                summaryMap={summaryMap}
                ownedCount={ownedCount}
                enabledCount={enabledCount}
                onJumpToProposal={jumpToProposal}
              />
              <GovernanceActivity
                proposalsByHash={proposalsByHash}
                refreshToken={activityRefreshToken}
                onJumpToProposal={jumpToProposal}
              />
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
                    const hashKey =
                      typeof proposal.Key === 'string'
                        ? proposal.Key.toLowerCase()
                        : '';
                    const summaryRow = hashKey
                      ? summaryMap.get(hashKey) || null
                      : null;
                    // Only compute a cohort chip for authenticated
                    // users — anonymous visitors don't have a
                    // receipt trail to show, so forcing a chip
                    // would just clutter the row.
                    const cohort = isAuthenticated
                      ? cohortChip(summaryRow, ownedCount)
                      : null;
                    // Metadata chips are built per-row but derived
                    // from feed-wide state (closing deadline, budget
                    // ranking). Order matters: urgency first, budget
                    // pressure second, margin last — that's the
                    // order in which a scanning user needs to decide
                    // "do I care enough to click in?"
                    const rowMetaChips = [];
                    if (closing) rowMetaChips.push(closing);
                    const overBudget = hashKey
                      ? overBudgetMap.get(hashKey)
                      : null;
                    if (overBudget) rowMetaChips.push(overBudget);
                    const margin = marginChip({ proposal, enabledCount });
                    if (margin) rowMetaChips.push(margin);
                    return (
                      <ProposalRow
                        key={proposal.Key}
                        proposal={proposal}
                        enabledCount={enabledCount}
                        isAuthenticated={isAuthenticated}
                        onVote={openVoteModal}
                        cohort={cohort}
                        summaryRow={isAuthenticated ? summaryRow : null}
                        metaChips={rowMetaChips}
                        isHighlighted={
                          typeof highlightKey === 'string' &&
                          highlightKey.toLowerCase() === hashKey
                        }
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
          // Wired so the `proposal_not_found` descriptor's
          // "Reload proposals" CTA can refetch the feed instead
          // of only refreshing the per-user MN lookup (which
          // does nothing for a stale proposal list).
          onReloadProposals={refreshGovernanceFeed}
        />
      ) : null}
    </main>
  );
}
