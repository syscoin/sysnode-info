import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { computeOpsStats } from '../lib/governanceOps';
import { formatNumber } from '../lib/formatters';
import { useAuth } from '../context/AuthContext';
import { useVault } from '../context/VaultContext';

// Error copy for the inline unlock form. Kept in sync with the same
// map in components/VaultStatusCard.js (the /account source of truth
// for unlock UX). If this diverges, update both — the hero is simply
// the governance-page on-ramp to the same `vault.unlock(...)` call.
const UNLOCK_ERROR_COPY = {
  envelope_decrypt_failed:
    "That password doesn't match this vault. Try again — the keys stay safe locally until the correct password decrypts them.",
  password_required: 'Please enter your password.',
  email_required: 'Your account email is missing. Try refreshing the page.',
  invalid_envelope_format:
    "Your vault blob looks corrupted. If this keeps happening, contact support — we haven't decrypted anything.",
  network_error:
    "We couldn't reach the sysnode server. Check your connection and try again.",
  unauthorized: 'Your session expired. Please sign in again.',
};

function unlockErrorCopy(code) {
  return UNLOCK_ERROR_COPY[code] || 'Unlock failed. Please try again.';
}

// Dashboard tooltips that explain the "voted" accounting rule. The
// hero counts a proposal as voted only when every one of the user's
// masternodes has a receipt for it — this is the same definition
// the per-row cohort chip uses (see lib/governanceCohort.js). A
// proposal the user has partially voted on (e.g. 1 of 5 masternodes
// submitted) still shows under "Need vote" here, and carries a
// "Voted X/Y" chip on its row. We expose the rule through native
// `title` tooltips so users who see a count that feels lower than
// their intuition can discover the reason without a docs trip.
const PROGRESS_TOOLTIP =
  'Counts proposals where every sentry node you own has a receipt. ' +
  "Proposals with partial coverage show a 'Voted X/Y' chip on their " +
  "row and stay under 'Need vote' until the remaining sentry nodes " +
  'have voted.';
const VOTED_TOOLTIP = PROGRESS_TOOLTIP;
const NEEDS_VOTE_TOOLTIP =
  "Includes proposals you haven't voted on yet AND proposals where " +
  'only some of your sentry nodes have voted. Check the row chip for ' +
  "the 'Voted X/Y' badge to see which need the rest of your fleet.";

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
  return n === 1 ? 'sentry node' : 'sentry nodes';
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
  isVaultLocked = false,
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
  // Awaiting-lookup is only meaningful when we aren't already blocked
  // on the user unlocking their vault. Otherwise a refresh (which
  // always returns the vault to LOCKED, since the master key lives
  // only in memory) would sit on the loading skeleton forever.
  const isAwaitingLookup = ownedCount === null && !isVaultLocked;
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
          <h2>Import your sentry node voting keys to take part.</h2>
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

  // 2) Vault is locked — the user is signed in and has a vault on
  //    the server, but the in-memory master key is gone (fresh load,
  //    page refresh, or explicit lock). The owned-MN lookup can't
  //    fire without decrypted voting addresses, so `ownedCount`
  //    stays null; without this branch the hero would render an
  //    unending loading skeleton with no hint that the user needs
  //    to act. Render the unlock form inline so the user can
  //    re-enter the dashboard without navigating away.
  if (isVaultLocked) {
    return <VaultLockedHero />;
  }

  // 3) Vault is unlocked but the owned-MN lookup hasn't landed yet.
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
            title={PROGRESS_TOOLTIP}
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
            title={NEEDS_VOTE_TOOLTIP}
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
            title={VOTED_TOOLTIP}
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

// VaultLockedHero
// -----------------------------------------------------------------------
// Locked-vault fallback for the ops hero. Self-contained (manages its
// own password / error / submitting state) so the main hero body
// stays declarative. We intentionally mirror the unlock form shape
// used by VaultStatusCard on /account so the user sees the same
// field order, autocomplete behaviour, and error copy regardless of
// where they land the unlock.
function VaultLockedHero() {
  const vault = useVault();
  const { user } = useAuth();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [unlockErr, setUnlockErr] = useState(null);

  function onUnlock(event) {
    event.preventDefault();
    if (submitting) return;
    if (!user || !user.email) {
      setUnlockErr('email_required');
      return;
    }
    if (password.length === 0) {
      setUnlockErr('password_required');
      return;
    }
    setSubmitting(true);
    setUnlockErr(null);
    vault
      .unlock({ password, email: user.email })
      .then(function onUnlocked() {
        setPassword('');
      })
      .catch(function onUnlockError(err) {
        setUnlockErr((err && err.code) || 'unlock_failed');
      })
      .finally(function always() {
        setSubmitting(false);
      });
  }

  return (
    <aside
      className="panel ops-hero ops-hero--locked"
      data-testid="gov-ops-hero-locked"
    >
      <div className="ops-hero__body">
        <p className="eyebrow">Your voting dashboard</p>
        <h2>Unlock your vault to see your voting dashboard.</h2>
        <p className="ops-hero__copy">
          Your voting keys stay encrypted locally. Enter your account
          password to decrypt them in this tab only — the password is
          never sent to the server.
        </p>
        <form className="ops-hero__unlock" onSubmit={onUnlock} noValidate>
          <div className="auth-field">
            <label className="auth-label" htmlFor="gov-hero-vault-password">
              Password
            </label>
            <input
              id="gov-hero-vault-password"
              className="auth-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={function onChange(e) {
                setPassword(e.target.value);
              }}
              required
            />
          </div>
          {unlockErr ? (
            <div
              className="auth-alert auth-alert--error"
              role="alert"
              data-testid="gov-ops-hero-unlock-error"
            >
              {unlockErrorCopy(unlockErr)}
            </div>
          ) : null}
          <div className="ops-hero__actions">
            <button
              type="submit"
              className="button button--primary button--small"
              disabled={submitting}
              data-testid="gov-ops-hero-unlock"
            >
              {submitting ? 'Unlocking…' : 'Unlock vault'}
            </button>
          </div>
        </form>
      </div>
    </aside>
  );
}
