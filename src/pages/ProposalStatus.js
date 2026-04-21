import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useHistory, useParams } from 'react-router-dom';

import PageMeta from '../components/PageMeta';
import { useAuth } from '../context/AuthContext';
import { proposalService } from '../lib/proposalService';

// ProposalStatus — /governance/proposal/:id
// ----------------------------------------
// Lifecycle view for a single proposal submission. Polls the backend
// at a rate that depends on the current status:
//
//   prepared            → no active server watcher; poll slowly (60s)
//                         so if the user pasted a TXID elsewhere we
//                         still pick up the transition.
//   awaiting_collateral → dispatcher is watching confs; poll fast
//                         (10s) so "2 of 6" ticks up close to real
//                         time.
//   submitted / failed  → terminal; stop polling.
//
// The page is also safe to reload at any time — all state is derived
// from the server's row, with zero local progression.

const POLL_FAST_MS = 10_000;
const POLL_SLOW_MS = 60_000;

function fmtSats(sats) {
  if (sats == null) return '';
  try {
    const n = BigInt(sats);
    const whole = n / 100000000n;
    const frac = n % 100000000n;
    if (frac === 0n) return whole.toString();
    const fs = frac.toString().padStart(8, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fs}`;
  } catch (_e) {
    return String(sats);
  }
}

function statusChip(status) {
  switch (status) {
    case 'prepared':
      return { label: 'Awaiting your payment', kind: 'is-warning' };
    case 'awaiting_collateral':
      return { label: 'Confirming collateral', kind: 'is-info' };
    case 'submitted':
      return { label: 'Submitted on-chain', kind: 'is-positive' };
    case 'failed':
      return { label: 'Failed', kind: 'is-negative' };
    default:
      return { label: status || 'Unknown', kind: '' };
  }
}

function failDescription(reason) {
  switch (reason) {
    case 'timeout':
      return 'The collateral transaction did not reach 6 confirmations within the watch window. If this was a network hiccup, you can re-attempt with a fresh prepare.';
    case 'core_rejected':
      return 'Syscoin Core rejected the submission. Check the detail below and try a new proposal if the error is structural.';
    case 'txid_not_found':
      return 'We could not find the collateral transaction on the Syscoin network. Double-check the TXID and the transaction was actually broadcast.';
    default:
      return null;
  }
}

export default function ProposalStatus() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const history = useHistory();
  const { isAuthenticated, isBooting } = useAuth();

  const [submission, setSubmission] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const timerRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    if (!Number.isInteger(id) || id <= 0) {
      setError({ code: 'invalid_id' });
      setLoading(false);
      return null;
    }
    try {
      const row = await proposalService.getSubmission(id);
      if (!mountedRef.current) return null;
      setSubmission(row);
      setError(null);
      return row;
    } catch (err) {
      if (!mountedRef.current) return null;
      setError(err);
      return null;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Adaptive polling.
  useEffect(() => {
    if (!submission) return undefined;
    const { status } = submission;
    if (status === 'submitted' || status === 'failed') return undefined;
    const delay = status === 'awaiting_collateral' ? POLL_FAST_MS : POLL_SLOW_MS;
    timerRef.current = window.setTimeout(() => {
      load();
    }, delay);
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [submission, load]);

  const chip = useMemo(
    () => (submission ? statusChip(submission.status) : null),
    [submission]
  );

  async function onDelete() {
    if (!submission) return;
    if (!window.confirm('Delete this submission? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await proposalService.deleteSubmission(submission.id);
      history.push('/governance');
    } catch (err) {
      setError(err);
    } finally {
      if (mountedRef.current) setDeleting(false);
    }
  }

  if (isBooting) {
    return (
      <main className="page-main">
        <section className="page-section">
          <div className="site-wrap">
            <p>Loading…</p>
          </div>
        </section>
      </main>
    );
  }
  if (!isAuthenticated) {
    return (
      <main className="page-main">
        <section className="page-section">
          <div className="site-wrap">
            <p>
              Please <Link to="/login">log in</Link> to view this proposal.
            </p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="page-main">
      <PageMeta title="Proposal status" />
      <section className="page-hero">
        <div className="site-wrap">
          <p className="eyebrow">Governance</p>
          <h1>Proposal status</h1>
          <p className="page-hero__copy">
            Live status for your governance proposal submission.
          </p>
        </div>
      </section>

      <section className="page-section page-section--tight page-section--last">
        <div className="site-wrap">
          {loading && !submission ? <p>Loading…</p> : null}
          {error && !submission ? (
            <div className="auth-alert auth-alert--error" role="alert">
              Could not load submission: {error.code || 'error'}
            </div>
          ) : null}

          {submission ? (
            <article
              className="panel proposal-status"
              data-testid="proposal-status-panel"
            >
              <header className="proposal-status__header">
                <h2>{submission.title || submission.name}</h2>
                {chip ? (
                  <span
                    className={`status-chip ${chip.kind}`}
                    data-testid="proposal-status-chip"
                  >
                    {chip.label}
                  </span>
                ) : null}
              </header>

              <dl className="proposal-wizard__summary">
                <dt>Proposal hash</dt>
                <dd>
                  <code>{submission.proposalHash}</code>
                </dd>
                <dt>Payment address</dt>
                <dd>
                  <code>{submission.paymentAddress}</code>
                </dd>
                <dt>Amount per month</dt>
                <dd>{fmtSats(submission.paymentAmountSats)} SYS</dd>
                <dt>Number of payments</dt>
                <dd>{submission.paymentCount}</dd>
                <dt>Voting window</dt>
                <dd>
                  {new Date(Number(submission.startEpoch) * 1000).toUTCString()}
                  <br />→{' '}
                  {new Date(Number(submission.endEpoch) * 1000).toUTCString()}
                </dd>
                {submission.url ? (
                  <>
                    <dt>URL</dt>
                    <dd>
                      <a href={submission.url} target="_blank" rel="noopener noreferrer">
                        {submission.url}
                      </a>
                    </dd>
                  </>
                ) : null}
              </dl>

              {submission.status === 'prepared' ? (
                <div className="proposal-status__section">
                  <p>
                    You haven't attached a collateral TXID yet. Return to
                    the wizard to pay the 150 SYS burn fee.
                  </p>
                  <Link to="/governance/new" className="button button--primary">
                    Continue
                  </Link>
                </div>
              ) : null}

              {submission.status === 'awaiting_collateral' ? (
                <div
                  className="proposal-status__section"
                  data-testid="proposal-status-awaiting"
                >
                  <p>
                    Waiting for <strong>6 confirmations</strong> on
                    your collateral transaction.
                  </p>
                  <div className="proposal-status__confs">
                    <span
                      className="proposal-status__confs-number"
                      data-testid="proposal-status-confs"
                    >
                      {Number(submission.collateralConfs || 0)} / 6
                    </span>
                    <div className="proposal-status__confs-bar">
                      <div
                        className="proposal-status__confs-bar-fill"
                        style={{
                          width: `${Math.min(
                            100,
                            ((Number(submission.collateralConfs) || 0) / 6) * 100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                  {submission.collateralTxid ? (
                    <p>
                      Collateral TXID:{' '}
                      <code data-testid="proposal-status-txid">
                        {submission.collateralTxid}
                      </code>
                    </p>
                  ) : null}
                  <p className="proposal-status__help">
                    We'll auto-submit the governance object as soon as
                    confirmations hit 6 — no action needed from you.
                  </p>
                </div>
              ) : null}

              {submission.status === 'submitted' ? (
                <div
                  className="proposal-status__section proposal-status__section--success"
                  data-testid="proposal-status-submitted"
                >
                  <p>
                    <strong>Success!</strong> Your governance object is
                    live on-chain.
                  </p>
                  {submission.governanceHash ? (
                    <p>
                      Governance hash:{' '}
                      <code>{submission.governanceHash}</code>
                    </p>
                  ) : null}
                  {submission.collateralTxid ? (
                    <p>
                      Collateral TXID: <code>{submission.collateralTxid}</code>
                    </p>
                  ) : null}
                  <Link to="/governance" className="button button--primary">
                    Back to governance
                  </Link>
                </div>
              ) : null}

              {submission.status === 'failed' ? (
                <div
                  className="proposal-status__section proposal-status__section--failed"
                  data-testid="proposal-status-failed"
                >
                  <p>
                    <strong>Submission failed.</strong>
                  </p>
                  {submission.failReason ? (
                    <p>
                      Reason:{' '}
                      <code>{submission.failReason}</code>
                    </p>
                  ) : null}
                  {failDescription(submission.failReason) ? (
                    <p>{failDescription(submission.failReason)}</p>
                  ) : null}
                  {submission.failDetail ? (
                    <pre className="proposal-wizard__cli">
                      <code>{submission.failDetail}</code>
                    </pre>
                  ) : null}
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={onDelete}
                    disabled={deleting}
                    data-testid="proposal-status-delete"
                  >
                    {deleting ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              ) : null}

              {submission.status === 'prepared' ? (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={onDelete}
                  disabled={deleting}
                  data-testid="proposal-status-delete"
                >
                  {deleting ? 'Deleting…' : 'Delete submission'}
                </button>
              ) : null}
            </article>
          ) : null}
        </div>
      </section>
    </main>
  );
}
