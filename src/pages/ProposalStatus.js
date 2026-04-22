import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useHistory, useParams } from 'react-router-dom';

import PageMeta from '../components/PageMeta';
import { useAuth } from '../context/AuthContext';
import { COLLATERAL_FEE_SATS } from '../lib/proposalForm';
import { proposalService, HEX64_RE } from '../lib/proposalService';

// Convert a 64-char big-endian proposal hash (the canonical display
// form, matches `gobject list` output) to the 32-byte little-endian
// hex that must be pushed inside the collateral OP_RETURN. Core
// reverses the internal hash bytes when rendering for display, so
// the on-chain payload is that reversal. Kept local — the backend
// already computes and returns this on /prepare, but we need to
// surface it again when the user reloads a prepared submission.
function proposalHashToOpReturnHex(hashBig) {
  if (typeof hashBig !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hashBig)) {
    return '';
  }
  let out = '';
  for (let i = hashBig.length - 2; i >= 0; i -= 2) {
    out += hashBig.slice(i, i + 2);
  }
  return out.toLowerCase();
}

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
  // Codex PR8 round 5 P2: delete-failure surface. The top-level
  // `error` banner only renders when `submission` is null (it's the
  // initial-fetch error channel), so a delete failure while the
  // submission panel is on screen would silently re-enable the
  // Delete button with no user-visible signal. Keep delete errors
  // in their own channel rendered *inside* the panel.
  const [deleteError, setDeleteError] = useState(null);

  // Inline attach-collateral form shown when a submission is
  // reopened in the `prepared` state (e.g. user reloaded the
  // status page or tapped "Open" from the in-flight list in a
  // separate session). Mirrors the wizard's SubmitStep UX —
  // paste a 64-hex TXID and we POST attach-collateral, which
  // flips the row to `awaiting_collateral` and the dispatcher
  // takes it from there. (Codex PR8 round 1 frontend P1.)
  const [txidInput, setTxidInput] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState(null);

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
      // Codex PR8 round 9 P2: if the submission has been deleted
      // out from under us (another session, admin action, etc.),
      // clear any cached copy so the page stops showing stale
      // status data. Transient errors (5xx, offline) keep the
      // cached submission and just raise the inline banner so
      // users aren't punished for a momentary hiccup.
      const code = err && err.code;
      if (code === 'not_found' || code === 'forbidden') {
        setSubmission(null);
      }
      return null;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Adaptive polling.
  //
  // Depending on the current status we poll at different rates, and
  // we also keep polling through transient fetch failures — a single
  // 5xx or network blip should NOT freeze the page on a non-terminal
  // submission until the user reloads. (Codex PR8 round 1 frontend P1.)
  //
  // We key the effect on both `submission` and `error` so that an
  // error transition re-runs the scheduler and queues another attempt
  // at a sensible interval. When there's an error but no submission
  // at all, we fall back to the slow cadence — we're blind to the
  // status, so don't hammer the server.
  useEffect(() => {
    const status = submission && submission.status;
    if (status === 'submitted' || status === 'failed') return undefined;
    // No submission yet AND no pending error means the initial load
    // hasn't returned — the `load` effect will bring us back here.
    if (!submission && !error) return undefined;
    const delay =
      status === 'awaiting_collateral' ? POLL_FAST_MS : POLL_SLOW_MS;
    timerRef.current = window.setTimeout(() => {
      load();
    }, delay);
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [submission, error, load]);

  const chip = useMemo(
    () => (submission ? statusChip(submission.status) : null),
    [submission]
  );

  async function onAttachCollateral() {
    if (!submission) return;
    setAttachError(null);
    const cleaned = (txidInput || '').trim().toLowerCase();
    if (!HEX64_RE.test(cleaned)) {
      setAttachError({ code: 'malformed_txid' });
      return;
    }
    setAttaching(true);
    try {
      const updated = await proposalService.attachCollateral(
        submission.id,
        cleaned
      );
      if (!mountedRef.current) return;
      setSubmission(updated);
      setTxidInput('');
    } catch (err) {
      if (!mountedRef.current) return;
      setAttachError(err);
    } finally {
      if (mountedRef.current) setAttaching(false);
    }
  }

  async function onDelete() {
    if (!submission) return;
    if (!window.confirm('Delete this submission? This cannot be undone.')) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await proposalService.deleteSubmission(submission.id);
      history.push('/governance');
    } catch (err) {
      // Route delete failures to their own state so they render
      // inline on the visible submission panel (see deleteError
      // banner below). The existing top-level `error` banner is
      // hidden whenever `submission` is set, so reusing it here
      // would silently swallow the failure. (Codex PR8 round 5 P2.)
      if (mountedRef.current) setDeleteError(err);
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
          {/* Codex PR8 round 9 P2: when a later poll fails but we
              still have cached submission data (common for
              transient 5xx / network blips), surface the failure
              so users don't keep reading stale status as if the
              server were healthy. The cached panel still renders
              below; this banner just flags that the displayed
              data may be out-of-date. Hard-failure codes
              (`not_found`, `forbidden`) clear `submission` above
              and fall through to the "Could not load" banner. */}
          {error && submission ? (
            <div
              className="auth-alert auth-alert--warning"
              role="alert"
              data-testid="proposal-status-stale-banner"
            >
              Could not refresh submission status ({error.code || 'error'}).
              The details below may be out of date; we&rsquo;ll retry
              automatically.
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

              {deleteError ? (
                <div
                  className="auth-alert auth-alert--error"
                  role="alert"
                  data-testid="proposal-status-delete-error"
                >
                  Could not delete this submission:{' '}
                  {deleteError.code || 'error'}. Please retry — if it
                  keeps failing, the submission may already be
                  in-flight and can no longer be deleted.
                </div>
              ) : null}

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
                <div
                  className="proposal-status__section"
                  data-testid="proposal-status-prepared"
                >
                  <p>
                    <strong>Prepared — awaiting your 150 SYS burn.</strong>
                    {' '}
                    Pay the collateral with an <code>OP_RETURN</code> that
                    commits to this proposal, then paste the TXID below.
                    We'll watch for <strong>6 confirmations</strong> and
                    auto-submit.
                  </p>
                  <p className="proposal-status__help">
                    This 150 SYS is a non-refundable burn required by
                    Syscoin Core for spam prevention — not a deposit.
                  </p>

                  <dl className="proposal-wizard__summary">
                    <dt>Amount to send</dt>
                    <dd>{fmtSats(COLLATERAL_FEE_SATS.toString())} SYS</dd>
                    <dt>
                      <code>OP_RETURN</code> hex (push data)
                    </dt>
                    <dd>
                      <code data-testid="proposal-status-opreturn">
                        {proposalHashToOpReturnHex(submission.proposalHash)}
                      </code>
                    </dd>
                  </dl>

                  {/* Manual-payment fallback: the canonical gobject
                      prepare CLI line. Same derivation the wizard's
                      SubmitStep used before /prepare redirected here —
                      kept so a reload (or a user arriving from the
                      Proposals Created panel) has full parity.
                      (Codex PR8 round 5 P2.) */}
                  {submission.dataHex && submission.timeUnix != null ? (
                    <details className="proposal-status__cli-block">
                      <summary>
                        Use Syscoin-Qt / syscoin-cli instead
                      </summary>
                      <p className="proposal-status__help">
                        Open Syscoin-Qt's <em>Debug console</em> (or
                        your CLI) and paste this — Core will broadcast
                        the 150 SYS burn and print the collateral TXID
                        to paste above.
                      </p>
                      <pre
                        className="proposal-wizard__cli"
                        data-testid="proposal-status-cli-command"
                      >
                        <code>
                          {`gobject prepare ${
                            submission.parentHash != null
                              ? String(submission.parentHash)
                              : '0'
                          } ${
                            submission.revision != null
                              ? String(submission.revision)
                              : '1'
                          } ${String(submission.timeUnix)} ${
                            submission.dataHex
                          }`}
                        </code>
                      </pre>
                    </details>
                  ) : null}

                  <label
                    className="proposal-wizard__field"
                    htmlFor="proposal-status-txid-input"
                  >
                    Collateral TXID
                    <input
                      id="proposal-status-txid-input"
                      type="text"
                      className="input"
                      value={txidInput}
                      onChange={(e) => setTxidInput(e.target.value)}
                      placeholder="64-hex transaction id"
                      spellCheck="false"
                      autoCapitalize="off"
                      autoCorrect="off"
                      disabled={attaching}
                      data-testid="proposal-status-txid-input"
                    />
                  </label>

                  {attachError ? (
                    <div
                      className="auth-alert auth-alert--error"
                      role="alert"
                      data-testid="proposal-status-attach-error"
                    >
                      {attachError.code === 'malformed_txid'
                        ? 'That does not look like a 64-character hex TXID.'
                        : attachError.code === 'opreturn_mismatch'
                        ? 'This transaction does not commit to this proposal (OP_RETURN mismatch). Double-check you used the OP_RETURN hex shown above.'
                        : attachError.code === 'fee_too_low'
                        ? 'The burn output is below the 150 SYS requirement.'
                        : attachError.code === 'txid_not_found'
                        ? 'We could not find that TXID on the Syscoin network yet. Wait for the broadcast to propagate and retry.'
                        : `Could not attach TXID: ${attachError.code || 'error'}`}
                    </div>
                  ) : null}

                  <div className="proposal-wizard__actions">
                    <button
                      type="button"
                      className="button button--primary"
                      onClick={onAttachCollateral}
                      disabled={attaching || !txidInput.trim()}
                      data-testid="proposal-status-attach"
                    >
                      {attaching ? 'Attaching…' : 'Attach TXID'}
                    </button>
                    <Link
                      to="/governance/new"
                      className="button button--ghost"
                    >
                      Open wizard
                    </Link>
                  </div>
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
