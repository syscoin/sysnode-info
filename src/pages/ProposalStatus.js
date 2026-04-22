import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useHistory, useParams } from 'react-router-dom';

import PageMeta from '../components/PageMeta';
import PayWithPaliPanel from '../components/PayWithPaliPanel';
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

// Map a backend `fail_reason` (the STABLE machine code written by
// the dispatcher / repo at `lib/proposalDispatcher.js`) to a human
// explanation.
//
// These codes MUST stay in sync with the set of values the
// dispatcher actually writes:
//
//   `collateral_not_found`      – `rpc.getRawTransaction` returned
//                                  "No such mempool or blockchain
//                                  transaction" continuously past
//                                  `timeoutMs` (dispatcher default
//                                  ~72h). The TXID the user gave us
//                                  (or Pali gave us) is not on any
//                                  Syscoin full node we can see.
//   `submit_rejected`           – `gobject_submit` returned a
//                                  TERMINAL error from Core (see
//                                  `TERMINAL_CORE_ERRORS` in the
//                                  dispatcher). Specific subtype —
//                                  rate-limit vs structural — is
//                                  derived from `failDetail` via
//                                  `classifyCoreRejection()`.
//   `duplicate_governance_hash` – another submission row already
//                                  claimed this governance hash in
//                                  our DB. The on-chain object
//                                  exists but belongs to that other
//                                  row; ours is a redundant
//                                  duplicate with no recovery path.
//
// Earlier iterations of this switch used stale codes (`timeout`,
// `core_rejected`, `txid_not_found`) that the dispatcher never
// actually emits, so every live failure fell through to `null` and
// the user saw the bare machine code only. Keep the codes here
// word-for-word matching `proposalDispatcher.js`.
function failDescription(reason) {
  switch (reason) {
    case 'collateral_not_found':
      return (
        'The collateral transaction ID you pasted was not found on ' +
        'the Syscoin network after repeated polling. The transaction ' +
        'may never have been broadcast, may have been double-spent, ' +
        'or may have hit a deep reorg. Start a fresh proposal with a ' +
        'new collateral payment — the funds from the missing TX, if ' +
        'any, are still controlled by your wallet.'
      );
    case 'submit_rejected':
      return (
        'Syscoin Core rejected the governance object at submit time. ' +
        'Check the detail below — if it is a structural problem ' +
        '(invalid hash, invalid signature, invalid object type), the ' +
        'only path forward is a fresh proposal. The 150 SYS collateral ' +
        'cannot be reused and is already burned.'
      );
    case 'duplicate_governance_hash':
      return (
        'Another submission on your account already claimed this exact ' +
        'governance hash, so this row is a duplicate. Open the other ' +
        'submission to see its status — the on-chain object only exists ' +
        'once and belongs to whichever row got to Core first.'
      );
    default:
      return null;
  }
}

// Classify a Core-rejected `fail_detail` string into UX buckets so
// we can render distinct panels. The detail string is whatever
// Core's `gobject_submit` RPC returned verbatim and is matched
// against the SAME terminal-error phrases the dispatcher uses (see
// `TERMINAL_CORE_ERRORS` in `lib/proposalDispatcher.js`). Any
// drift between these two tables will look like a fall-through to
// the generic failed panel with no special guidance — not a
// correctness bug, but a UX regression, so keep them aligned.
//
// Buckets:
//   'rate_limited' — Core's per-cycle governance object creation
//                    rate limiter rejected the submit. The object
//                    hash is burned for this cycle; nothing the
//                    user can do except wait for the next cycle.
//                    This is the single most-common terminal
//                    failure, so it deserves its own panel with
//                    explicit "this is a protocol limit, not you"
//                    framing to avoid blame-the-user confusion.
//   'structural'   — One of the validation rejects
//                    (invalid hash / sig / type / data hex,
//                    "Governance object is not valid",
//                    "Object submission rejected"). The 150 SYS
//                    is still burned; the only recovery is a
//                    fresh proposal (or an operator investigation
//                    if the user is certain the inputs were
//                    right).
//   null           — Unknown / empty / not Core (e.g. transport
//                    error that leaked into `fail_detail`). Fall
//                    through to the generic failed panel.
function classifyCoreRejection(failDetail) {
  if (typeof failDetail !== 'string' || !failDetail) return null;
  if (/Object creation rate limit exceeded/i.test(failDetail)) {
    return 'rate_limited';
  }
  if (
    /Object submission rejected/i.test(failDetail) ||
    /Governance object is not valid/i.test(failDetail) ||
    /Invalid parent hash/i.test(failDetail) ||
    /Invalid (?:object )?signature/i.test(failDetail) ||
    /Invalid object type/i.test(failDetail) ||
    /Invalid proposal/i.test(failDetail) ||
    /Invalid data hex/i.test(failDetail) ||
    /hash mismatch/i.test(failDetail)
  ) {
    return 'structural';
  }
  return null;
}

// Render the `status === 'failed'` panel. Split out of the main
// component body because the state space here has grown past a
// simple "reason + detail + delete" block:
//
//   * Rate-limited Core rejections get a dedicated panel with
//     "try again next governance cycle" framing — the most-common
//     terminal failure and the one most likely to cause support
//     pings if we just dump the bare error.
//   * Non-rate-limit `submit_rejected` still uses the generic
//     failed card but picks up the richer copy from
//     `failDescription()`.
//   * Other reasons (`collateral_not_found`,
//     `duplicate_governance_hash`) similarly get tailored copy.
//
// Keeping this as a plain helper (not a React sub-component) is
// deliberate: it's purely a render branch over read-only data,
// has no hooks, no state, and no effects — inlining it would just
// make the already-large component body harder to read.
function renderFailedSection({ submission, deleting, onDelete }) {
  const isCoreRejection = submission.failReason === 'submit_rejected';
  const coreKind = isCoreRejection
    ? classifyCoreRejection(submission.failDetail)
    : null;

  if (coreKind === 'rate_limited') {
    return (
      <div
        className="proposal-status__section proposal-status__section--failed"
        data-testid="proposal-status-failed"
        data-core-kind="rate_limited"
      >
        <p>
          <strong>
            Governance rate-limit reached for this cycle.
          </strong>
        </p>
        <p>
          Syscoin Core enforces a per-cycle cap on how many new
          governance objects can be created network-wide. Your
          submission is valid, but the cycle's quota is full, so Core
          rejected it. This is a protocol-level safeguard, not a
          problem with your proposal.
        </p>
        <p>
          <strong>What to do:</strong> wait for the next governance
          cycle (a fresh window opens at the next superblock,
          roughly every 30 days) and submit a new proposal then.
          Unfortunately, the 150 SYS collateral from this attempt is
          already burned by consensus rules and cannot be recovered
          or reused — submitting in the next cycle will require a
          fresh 150 SYS payment.
        </p>
        {submission.failDetail ? (
          <details className="proposal-status__detail">
            <summary>Raw Core response</summary>
            <pre className="proposal-wizard__cli">
              <code>{submission.failDetail}</code>
            </pre>
          </details>
        ) : null}
        <div className="proposal-status__actions">
          <Link to="/governance" className="button button--ghost">
            Back to governance
          </Link>
          <button
            type="button"
            className="button button--ghost"
            onClick={onDelete}
            disabled={deleting}
            data-testid="proposal-status-delete"
          >
            {deleting ? 'Deleting…' : 'Delete this record'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="proposal-status__section proposal-status__section--failed"
      data-testid="proposal-status-failed"
      data-core-kind={coreKind || ''}
    >
      <p>
        <strong>Submission failed.</strong>
      </p>
      {submission.failReason ? (
        <p>
          Reason: <code>{submission.failReason}</code>
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
  );
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
  // The id of the most recently issued request. Responses that
  // complete after the user has navigated to a different proposal
  // must be dropped — otherwise an old getSubmission() that happens
  // to resolve after a newer one would overwrite the page with the
  // previous row, and action handlers bound to submission.id would
  // then target the wrong submission. A ref (not state) because
  // stale closures inside in-flight async calls need to read the
  // LIVE latest-id, not the snapshot captured when they were
  // scheduled. Kept in sync with `id` on every render.
  const latestReqIdRef = useRef(id);
  latestReqIdRef.current = id;
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
    const reqId = id;
    try {
      const row = await proposalService.getSubmission(reqId);
      if (!mountedRef.current) return null;
      // Request-token check: if the user navigated to another
      // proposal while this fetch was in flight, the response
      // belongs to a stale id. Drop it on the floor — the `[id]`
      // reset effect has already cleared `submission`, and a
      // fresh load() for the new id is already queued.
      if (reqId !== latestReqIdRef.current) return null;
      setSubmission(row);
      setError(null);
      return row;
    } catch (err) {
      if (!mountedRef.current) return null;
      if (reqId !== latestReqIdRef.current) return null;
      setError(err);
      // Hard-failure codes clear the cached submission so the page
      // stops rendering a row the user no longer has. Transient
      // same-id failures keep the cache and surface the stale-data
      // warning banner instead. Route-id changes are handled by the
      // `[id]` reset effect below, which zeroes submission BEFORE
      // the new load runs, so by the time we reach this catch
      // submission is either null or matches the current id.
      const code = err && err.code;
      if (code === 'not_found' || code === 'forbidden') {
        setSubmission(null);
      }
      return null;
    } finally {
      if (mountedRef.current && reqId === latestReqIdRef.current) {
        setLoading(false);
      }
    }
  }, [id]);

  // Codex PR8 round 11 P1: whenever the route param `id` changes,
  // drop any cached submission/error from the previous id BEFORE
  // the new fetch resolves. Without this, the page stays mounted
  // with the PREVIOUS submission in state during the fetch window;
  // any action handler bound to `submission.id` (attach-collateral,
  // delete) would then operate on the wrong row if the user acts
  // before the new load completes or if that load then fails
  // transiently. Clearing `error` too so a stale "Could not load"
  // banner from the old id doesn't carry over. `loading = true`
  // keeps the spinner up until the new load either resolves or
  // errors, which is the correct UX for a fresh navigation.
  //
  // Codex PR8 round 13 P2: extend this reset to ALL per-submission
  // UI state — `deleteError` / `attachError` / `txidInput`. A
  // failed delete or attach on submission #A sets an inline banner
  // keyed to that row; if the user then opens submission #B, the
  // banner would otherwise carry over even though it describes an
  // action against a completely different row. Worse: `txidInput`
  // holds a collateral TXID the user pasted into #A's form, and
  // leaving it set on #B's render would prefill #B's attach box
  // with the wrong txid, one "Submit" click away from an
  // accidental cross-row attach attempt. Clearing all of them is
  // the only safe default on route-id change.
  useEffect(() => {
    setSubmission(null);
    setError(null);
    setLoading(true);
    setDeleteError(null);
    setAttachError(null);
    setTxidInput('');
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
    // Codex PR8 round 10 P3: short-circuit on non-retryable
    // validation errors. `invalid_id` is produced by load() when
    // the route param is not a positive integer — no amount of
    // retrying will make the URL suddenly valid, so scheduling
    // another setTimeout here just burns CPU on state churn for
    // as long as the page stays mounted. `forbidden` is similar
    // on the hard-failure side: the user can't fix a permissions
    // refusal by retrying, and we already cleared `submission` so
    // the full-page banner is up. Any OTHER error code is assumed
    // retryable (5xx, network blip, transient SQLITE_BUSY, etc.).
    //
    // Codex PR8 round 13 P3: `not_found` is also terminal for
    // polling purposes. It surfaces when the submission row does
    // not exist (never created, or deleted). The backend will
    // never spontaneously materialise the row, so re-firing
    // `getSubmission` every 60s just churns state, emits repeated
    // log noise, and wastes a server round-trip per interval for
    // every mounted stale tab. The user's only path to a valid
    // view is to navigate to a different URL, which will retrigger
    // `load()` via the [id] effect anyway.
    const errCode = error && error.code;
    if (
      errCode === 'invalid_id' ||
      errCode === 'forbidden' ||
      errCode === 'not_found'
    ) {
      return undefined;
    }
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

                  <PayWithPaliPanel
                    submission={submission}
                    proposalServiceImpl={proposalService}
                    onAttached={async () => {
                      // The panel's internal attachCollateral call
                      // already flipped the row to
                      // `awaiting_collateral` server-side; pull a
                      // fresh snapshot so the UI jumps to the
                      // confirmation progress bar without waiting for
                      // the next 60s poll tick.
                      if (!mountedRef.current) return;
                      // Codex PR14 round 2 P1: pin the request to
                      // the submission id we started with. If the
                      // user navigates to a different proposal
                      // while this refresh is in flight, drop the
                      // stale response so we don't overwrite the
                      // new page state with the old row — same
                      // cross-id race `load()` already guards via
                      // latestReqIdRef.
                      const reqId = submission.id;
                      try {
                        const fresh = await proposalService.getSubmission(
                          reqId
                        );
                        if (!mountedRef.current) return;
                        if (reqId !== latestReqIdRef.current) return;
                        setSubmission(fresh);
                      } catch (_e) {
                        // Poll loop will catch up; swallow.
                      }
                    }}
                    fallbackHint="Pay with Pali is not available on this instance. Use the manual paste form below."
                  />

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

              {submission.status === 'failed'
                ? renderFailedSection({
                    submission,
                    deleting,
                    onDelete,
                  })
                : null}

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
