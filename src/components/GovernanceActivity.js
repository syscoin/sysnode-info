import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useBackgroundPoll } from '../hooks/useBackgroundPoll';
import { governanceService as defaultService } from '../lib/governanceService';

// Cadence matches `SUMMARY_POLL_MS` in useGovernanceReceipts on
// purpose: both endpoints read from the same receipt-rows state on
// the backend, so when a relayed receipt reconciles to confirmed
// the summary count AND the activity badge change at the same
// instant. Keeping the two pollers on the same tick prevents a
// user from seeing one of them update alone and wondering whether
// the UI is inconsistent. The two constants are intentionally
// independent so a future divergence (e.g. if the activity card
// picks up heavier per-row enrichment) doesn't silently drag the
// cheap summary query along.
export const ACTIVITY_POLL_MS = 30 * 1000;

// Small helper: "relative time" for a millisecond timestamp.
// Intentionally local to this component — we don't ship a relative-
// time formatter in `lib/formatters` yet, and the rules here are
// tuned for the activity card specifically (seconds→weeks; beyond
// that, surface an absolute UTC date). If another call-site needs
// this, it should move to `lib/formatters`.
function formatRelativeMs(ms, nowMs) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const diffSec = Math.round((now - ms) / 1000);
  const abs = Math.abs(diffSec);
  const future = diffSec < 0;
  if (abs < 5) return 'just now';
  if (abs < 60) return future ? `in ${abs}s` : `${abs}s ago`;
  const mins = Math.round(abs / 60);
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hrs = Math.round(abs / 3600);
  if (hrs < 24) return future ? `in ${hrs}h` : `${hrs}h ago`;
  const days = Math.round(abs / 86400);
  if (days < 7) return future ? `in ${days}d` : `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return future ? `in ${weeks}w` : `${weeks}w ago`;
  // Beyond ~5 weeks, a locale-aware absolute date reads better than
  // "12w ago". Use UTC to avoid timezone drift between server
  // submitted_at and the user's local clock.
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(ms));
  } catch (_e) {
    return '';
  }
}

function formatAbsoluteUtc(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC',
    }).format(new Date(ms));
  } catch (_e) {
    return '';
  }
}

// "Your activity" card — the N most-recent vote receipts across
// every proposal the user has acted on, with a deep-link on each
// row that jumps the proposal table back to the originating row.
//
// Why its own component (not a section of the ops hero):
//
//   * It only makes sense when the user has *already* voted on
//     something; on fresh accounts the hero gives a better read.
//   * The list can grow to 10 rows and contains its own interactive
//     elements (jump buttons). Inlining it into the hero would blur
//     the visual boundary between "summary" and "history".
//   * Loading is independent of the hero — we can show stale
//     receipts while the summary refreshes, or vice versa.
//
// Data flow:
//
//   This component owns its own fetch against
//   `governanceService.fetchRecentReceipts`. The caller passes in
//   a `proposalsByHash` map (hash→proposal feed row) so we can
//   render a title and a jump-link without round-tripping the
//   feed. If a receipt points at a proposal that's no longer in
//   the feed (archived, re-org, operator purge), we render the
//   row with the hash prefix only and an inert "not in feed"
//   label — the receipt itself stays informative.

const OUTCOME_LABEL = {
  yes: 'Voted yes',
  no: 'Voted no',
  abstain: 'Abstained',
  none: 'Vote removed',
};

const STATUS_LABEL = {
  confirmed: 'On-chain',
  relayed: 'Submitted',
  stale: 'Needs retry',
  failed: 'Failed',
};

const STATUS_CLASS = {
  confirmed: 'gov-activity__status gov-activity__status--confirmed',
  relayed: 'gov-activity__status gov-activity__status--relayed',
  stale: 'gov-activity__status gov-activity__status--stale',
  failed: 'gov-activity__status gov-activity__status--failed',
};

function shortHash(h) {
  if (typeof h !== 'string' || h.length < 10) return h || '';
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

function lastSeenMs(receipt) {
  // `verified_at` wins when present — it's the last time we
  // observed the row on-chain and is the more truthful signal of
  // "when was this actually current". `submitted_at` is the
  // fallback for rows that have never reconciled.
  const v = Number(receipt && receipt.verifiedAt);
  if (Number.isFinite(v) && v > 0) return v;
  const s = Number(receipt && receipt.submittedAt);
  if (Number.isFinite(s) && s > 0) return s;
  return null;
}

function outcomeLabel(outcome) {
  return OUTCOME_LABEL[outcome] || 'Vote';
}

function statusLabel(status) {
  return STATUS_LABEL[status] || status || '';
}

function statusClass(status) {
  return STATUS_CLASS[status] || 'gov-activity__status';
}

export default function GovernanceActivity({
  proposalsByHash,
  governanceService = defaultService,
  limit = 10,
  refreshToken = 0,
  onJumpToProposal,
}) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    receipts: [],
  });
  const mountedRef = useRef(true);
  const genRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const myGen = ++genRef.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const out = await governanceService.fetchRecentReceipts({ limit });
      if (!mountedRef.current || genRef.current !== myGen) return;
      setState({
        loading: false,
        error: null,
        receipts: Array.isArray(out.receipts) ? out.receipts : [],
      });
    } catch (err) {
      if (!mountedRef.current || genRef.current !== myGen) return;
      setState({
        loading: false,
        error: (err && err.code) || 'activity_failed',
        receipts: [],
      });
    }
  }, [governanceService, limit]);

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  // Background poll so the On-chain / Submitted / Needs retry /
  // Failed badges keep pace with backend reconciliation without the
  // user having to close the vote modal or reload the page. Same
  // visibility-aware contract as the summary poll — see
  // `useBackgroundPoll` for semantics. The component is only
  // rendered by Governance.js under `isAuthenticated`, so the
  // primitive's `enabled` flag is just `true` here; the mount-gate
  // handles the auth check.
  useBackgroundPoll(load, {
    enabled: true,
    intervalMs: ACTIVITY_POLL_MS,
  });

  const proposalLookup = useMemo(() => {
    if (proposalsByHash instanceof Map) return proposalsByHash;
    const m = new Map();
    if (proposalsByHash && typeof proposalsByHash === 'object') {
      for (const [k, v] of Object.entries(proposalsByHash)) {
        if (typeof k === 'string') m.set(k.toLowerCase(), v);
      }
    }
    return m;
  }, [proposalsByHash]);

  const { loading, error, receipts } = state;

  if (loading && receipts.length === 0) {
    return (
      <aside
        className="panel gov-activity gov-activity--loading"
        data-testid="gov-activity-loading"
        aria-busy="true"
      >
        <header className="gov-activity__header">
          <p className="eyebrow">Your activity</p>
          <h3>Loading your recent votes…</h3>
        </header>
      </aside>
    );
  }

  if (error && receipts.length === 0) {
    return (
      <aside
        className="panel gov-activity gov-activity--error"
        data-testid="gov-activity-error"
      >
        <header className="gov-activity__header">
          <p className="eyebrow">Your activity</p>
          <h3>We couldn't load your recent votes.</h3>
        </header>
        <p className="gov-activity__hint">
          This is almost always transient. Try reloading the page — your
          receipts are safe on our side.
        </p>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={load}
          data-testid="gov-activity-retry"
        >
          Try again
        </button>
      </aside>
    );
  }

  if (receipts.length === 0) {
    return (
      <aside
        className="panel gov-activity gov-activity--empty"
        data-testid="gov-activity-empty"
      >
        <header className="gov-activity__header">
          <p className="eyebrow">Your activity</p>
          <h3>No votes yet.</h3>
        </header>
        <p className="gov-activity__hint">
          Once you cast your first vote, the last {limit} will show up
          here with a link to jump straight to the proposal.
        </p>
      </aside>
    );
  }

  return (
    <aside
      className="panel gov-activity"
      data-testid="gov-activity"
      aria-label="Your recent governance votes"
    >
      <header className="gov-activity__header">
        <p className="eyebrow">Your activity</p>
        <h3>Last {receipts.length} {receipts.length === 1 ? 'vote' : 'votes'}</h3>
      </header>
      <ol className="gov-activity__list" data-testid="gov-activity-list">
        {receipts.map((r) => {
          const hashKey =
            typeof r.proposalHash === 'string' ? r.proposalHash.toLowerCase() : '';
          const proposal = hashKey ? proposalLookup.get(hashKey) : null;
          const title =
            (proposal && (proposal.title || proposal.name)) ||
            shortHash(hashKey);
          const seenMs = lastSeenMs(r);
          const relative = seenMs ? formatRelativeMs(seenMs) : '';
          const absolute = seenMs ? formatAbsoluteUtc(seenMs) : '';
          const rowKey = `${hashKey}:${r.collateralHash}:${r.collateralIndex}`;
          const canJump = Boolean(proposal) && typeof onJumpToProposal === 'function';
          return (
            <li
              className="gov-activity__item"
              key={rowKey}
              data-testid="gov-activity-item"
              data-status={r.status || ''}
              data-outcome={r.voteOutcome || ''}
            >
              <div className="gov-activity__item-main">
                <div className="gov-activity__item-title">
                  {canJump ? (
                    <button
                      type="button"
                      className="gov-activity__jump"
                      onClick={() => onJumpToProposal(r.proposalHash)}
                      data-testid="gov-activity-jump"
                    >
                      {title}
                    </button>
                  ) : (
                    <span className="gov-activity__title-inert">{title}</span>
                  )}
                </div>
                <div className="gov-activity__item-meta">
                  <span className="gov-activity__outcome">
                    {outcomeLabel(r.voteOutcome)}
                  </span>
                  {!proposal ? (
                    <span
                      className="gov-activity__warn"
                      title={`Proposal hash ${hashKey}`}
                    >
                      Not in current feed
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="gov-activity__item-side">
                <span className={statusClass(r.status)}>
                  {statusLabel(r.status)}
                </span>
                {relative ? (
                  <span
                    className="gov-activity__time"
                    title={absolute ? `${absolute} (UTC)` : ''}
                  >
                    {relative}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
