import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';

import { computeOpsStats } from '../lib/governanceOps';
import { formatNumber } from '../lib/formatters';

// Ops-summary hero that sits above the proposal table for
// authenticated users. The goal is to give a voting operator a
// one-glance read of:
//
//   * "Am I set up?"            (represent chip: N masternodes)
//   * "What do I owe the net?"  (needs-vote count, with CTA)
//   * "How close am I to done?" (progress bar with %)
//   * "What does the room look like?" (passing / watching)
//
// We deliberately keep the hero copy *plural-aware* rather than
// branching big chunks of JSX — the information density matches
// what's already on the page above, but the framing is personal.
//
// Mount gating:
//
//   The caller (Governance page) only renders this when the user is
//   authenticated; that way the hook calls that feed it (owned MN
//   lookup, receipt summary) have already fired by the time we
//   render. The component itself is defensive — if `ownedCount` is
//   null (vault still locked, lookup still loading), the stats
//   helper reports everything as "not-applicable" and we render a
//   gentle skeleton state instead of stale numbers.

function pluralMn(n) {
  return n === 1 ? 'masternode' : 'masternodes';
}

function pluralProposal(n) {
  return n === 1 ? 'proposal' : 'proposals';
}

function formatCount(n) {
  if (!Number.isFinite(n)) return '—';
  return formatNumber(n);
}

export default function GovernanceOpsHero({
  proposals,
  summaryMap,
  ownedCount,
  enabledCount,
  onJumpToProposal,
}) {
  const stats = useMemo(
    () =>
      computeOpsStats({
        proposals,
        summaryMap,
        ownedCount,
        enabledCount,
      }),
    [proposals, summaryMap, ownedCount, enabledCount]
  );

  const isVaultEmpty = ownedCount === 0;
  const isAwaitingLookup = ownedCount === null;
  const hasApplicable = stats.applicable > 0;

  // 1) User has no voting keys imported yet — gently nudge them to
  //    the account page instead of showing zero-filled chips.
  if (isVaultEmpty) {
    return (
      <aside
        className="panel ops-hero ops-hero--empty"
        data-testid="gov-ops-hero-empty"
      >
        <div className="ops-hero__body">
          <p className="eyebrow">Your voting dashboard</p>
          <h2>Import your masternode voting keys to take part.</h2>
          <p className="ops-hero__copy">
            Once you add a voting key on your Account page, you will see a live view of what needs your vote
            and how far along you are.
          </p>
          <div className="ops-hero__actions">
            <Link
              to="/account"
              className="button button--primary button--small"
              data-testid="gov-ops-hero-account-link"
            >
              Go to Account
            </Link>
          </div>
        </div>
      </aside>
    );
  }

  // 2) Vault is unlocked but the owned-MN lookup hasn't landed yet.
  //    Render a skeleton rather than flash zeros.
  if (isAwaitingLookup) {
    return (
      <aside
        className="panel ops-hero ops-hero--loading"
        data-testid="gov-ops-hero-loading"
        aria-busy="true"
      >
        <div className="ops-hero__body">
          <p className="eyebrow">Your voting dashboard</p>
          <h2 className="ops-hero__headline-placeholder" aria-hidden="true">
            Loading your personalised summary…
          </h2>
          <div
            className="ops-hero__skeleton"
            role="presentation"
            aria-hidden="true"
          >
            <span />
            <span />
            <span />
          </div>
        </div>
      </aside>
    );
  }

  const { needsVote, voted, passing, watching, progressPercent } = stats;
  const allDone = hasApplicable && needsVote === 0;

  // Primary headline — one sentence, personal, actionable.
  let headline;
  if (!hasApplicable) {
    // Owns MNs but none of the displayed proposals apply (e.g.
    // filtered list is empty). Unusual but graceful.
    headline = (
      <>
        You represent <strong>{formatCount(ownedCount)}</strong>{' '}
        {pluralMn(ownedCount)}. No proposals match the current view.
      </>
    );
  } else if (allDone) {
    headline = (
      <>
        All caught up — <strong>{formatCount(voted)}</strong>{' '}
        {pluralProposal(voted)} voted with your{' '}
        <strong>{formatCount(ownedCount)}</strong> {pluralMn(ownedCount)}.
      </>
    );
  } else {
    headline = (
      <>
        <strong>{formatCount(needsVote)}</strong>{' '}
        {pluralProposal(needsVote)} need your vote across your{' '}
        <strong>{formatCount(ownedCount)}</strong> {pluralMn(ownedCount)}.
      </>
    );
  }

  function handleJump() {
    if (!stats.nextUnvotedKey) return;
    if (typeof onJumpToProposal === 'function') {
      onJumpToProposal(stats.nextUnvotedKey);
    }
  }

  return (
    <aside
      className="panel ops-hero"
      data-testid="gov-ops-hero"
      data-needs-vote={needsVote}
      data-voted={voted}
      data-all-done={allDone ? 'true' : 'false'}
    >
      <div className="ops-hero__body">
        <p className="eyebrow">Your voting dashboard</p>
        <h2 data-testid="gov-ops-hero-headline">{headline}</h2>

        {hasApplicable ? (
          <div
            className="ops-hero__progress"
            data-testid="gov-ops-hero-progress"
          >
            <div className="ops-hero__progress-label">
              <span>
                Voted {formatCount(voted)} of {formatCount(stats.applicable)}
              </span>
              <span className="ops-hero__progress-percent">
                {progressPercent != null ? `${progressPercent}%` : ''}
              </span>
            </div>
            <div
              className="ops-hero__progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent ?? 0}
              aria-label={`Voted on ${voted} of ${stats.applicable} proposals`}
            >
              <div
                className="ops-hero__progress-fill"
                style={{
                  width: `${progressPercent != null ? progressPercent : 0}%`,
                }}
              />
            </div>
          </div>
        ) : null}

        <div className="ops-hero__stats" role="list">
          <div
            className="ops-hero__stat ops-hero__stat--represent"
            role="listitem"
          >
            <span className="ops-hero__stat-label">Represent</span>
            <strong>{formatCount(ownedCount)}</strong>
            <small>{pluralMn(ownedCount)} ready to sign</small>
          </div>
          <div
            className="ops-hero__stat ops-hero__stat--needs-vote"
            role="listitem"
            data-testid="gov-ops-hero-needs-vote"
          >
            <span className="ops-hero__stat-label">Need vote</span>
            <strong>{formatCount(needsVote)}</strong>
            <small>
              {needsVote === 0
                ? 'Nothing on your plate'
                : `${pluralProposal(needsVote)} waiting`}
            </small>
          </div>
          <div
            className="ops-hero__stat ops-hero__stat--voted"
            role="listitem"
            data-testid="gov-ops-hero-voted"
          >
            <span className="ops-hero__stat-label">Voted</span>
            <strong>{formatCount(voted)}</strong>
            <small>
              {voted === 0
                ? 'No votes yet'
                : `on ${pluralProposal(voted)}`}
            </small>
          </div>
          <div
            className="ops-hero__stat ops-hero__stat--passing"
            role="listitem"
            data-testid="gov-ops-hero-passing"
          >
            <span className="ops-hero__stat-label">Passing</span>
            <strong>{formatCount(passing)}</strong>
            <small>
              {watching != null
                ? `${formatCount(watching)} watching`
                : 'Network tally pending'}
            </small>
          </div>
        </div>

        {stats.nextUnvotedKey ? (
          <div className="ops-hero__actions">
            <button
              type="button"
              className="button button--primary button--small"
              onClick={handleJump}
              data-testid="gov-ops-hero-jump"
            >
              Jump to next
            </button>
            <span className="ops-hero__hint">
              {needsVote > 1
                ? `${formatCount(needsVote)} ${pluralProposal(needsVote)} need your vote.`
                : 'Only one proposal left to vote on.'}
            </span>
          </div>
        ) : hasApplicable ? (
          <div className="ops-hero__actions">
            <span
              className="ops-hero__hint ops-hero__hint--ok"
              data-testid="gov-ops-hero-done"
            >
              Nothing left to sign — thanks for keeping Syscoin honest.
            </span>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
