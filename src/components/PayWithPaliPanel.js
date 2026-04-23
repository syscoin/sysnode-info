import React, { useEffect, useRef, useState } from 'react';

import {
  isPaliAvailable,
  payProposalCollateralWithPali,
} from '../lib/paliProvider';

// Pending-txid stash — post-broadcast, pre-attach recovery.
// ---------------------------------------------------------
// The moment Pali's `sys_signAndSend` resolves we have a txid that
// corresponds to a 150 SYS burn on-chain. If the user navigates,
// reloads, or closes the tab before our `attachCollateral` POST
// completes, that txid is lost and the submission stays stuck in
// `prepared` with no way for the server to reconcile — the user
// has paid but the proposal never lands. To close that window we:
//
//   1. Persist the txid to localStorage the instant we receive it
//      from Pali, keyed by submission.id.
//   2. Still fire `attachCollateral` regardless of mount state, so
//      an in-flight detach completes without the user noticing.
//   3. On clean success, clear the stash.
//   4. On next mount (same or different page) if a stash exists for
//      this submission, rehydrate straight into `attach_failed` with
//      the stashed txid so the recovery UI (Retry attach / Copy
//      TXID) is there waiting.
//
// All helpers guard against environments where localStorage is
// absent or throws (Safari private mode, SSR, quota errors). If the
// stash itself fails we still run the attach — we prefer the "burn
// but no stash" failure mode (user gets txid from Pali history) to
// a "stash but no attach" mode.
const TXID_STASH_PREFIX = 'pay-with-pali:pending-txid:';
function stashKey(submissionId) {
  return `${TXID_STASH_PREFIX}${submissionId}`;
}
function stashPendingTxidLS(submissionId, txid) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(stashKey(submissionId), txid);
    }
  } catch (_e) {
    /* quota / private mode: ignore */
  }
}
function loadPendingTxidLS(submissionId) {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(stashKey(submissionId)) || null;
    }
  } catch (_e) {
    /* private mode: ignore */
  }
  return null;
}
function clearPendingTxidLS(submissionId) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(stashKey(submissionId));
    }
  } catch (_e) {
    /* ignore */
  }
}

// usePaliAvailable — shared between this panel and its callers.
// ------------------------------------------------------------
// Pali (like MetaMask) injects `window.pali` from its content script
// after DOMContentLoaded, which can race with React mounting any
// component that wants to feature-detect. A single synchronous check
// at mount is brittle: users whose extension woke up a beat later
// would be stuck on the "not installed" layout (no Option A, manual
// lanes mis-numbered) until they hard-reloaded.
//
// This hook seeds from the synchronous check, then polls every 300ms
// for up to 10s for the provider to appear. Once detected we trust
// it for the rest of the mount (the provider doesn't disappear
// without a page reload). Both the panel itself and the wizard/
// status page use this so the Panel's visibility and the sibling
// "Option B/C" labels stay in lockstep (Codex PR14 P3 — don't show
// users Option B with no visible Option A).
export function usePaliAvailable() {
  const [available, setAvailable] = useState(() => {
    try {
      return isPaliAvailable();
    } catch (_e) {
      return false;
    }
  });
  useEffect(() => {
    if (available) return undefined;
    let cancelled = false;
    const started = Date.now();
    const WINDOW_MS = 10_000;
    const INTERVAL_MS = 300;
    const handle = setInterval(() => {
      if (cancelled) return;
      let present = false;
      try {
        present = isPaliAvailable();
      } catch (_e) {
        present = false;
      }
      if (present) {
        clearInterval(handle);
        if (!cancelled) setAvailable(true);
        return;
      }
      if (Date.now() - started >= WINDOW_MS) {
        clearInterval(handle);
      }
    }, INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [available]);
  return available;
}

// PayWithPaliPanel — the "Pay with Pali" lane.
// --------------------------------------------
// Used in two places: the NewProposal wizard's submit step (Option A)
// and the ProposalStatus page when the user arrives cold on a
// `prepared` row (e.g. continued on another device or navigated back
// from the wizard). The copy is intentionally identical in both
// entry points so users don't get a second, subtly different flow.
//
// Visibility rules (keep in this order so we don't flash the wrong
// affordance while the network probe resolves):
//   1. Pali not installed  -> render nothing. CLI/OP_RETURN lanes
//      remain the only prompt, identical to pre-PR10.
//   2. Pali installed, probe in-flight -> render the panel with the
//      button disabled and "Checking Pali…" copy.
//   3. Pali installed, server reports paliPathEnabled=false -> render
//      the panel but with the button disabled and an explanatory
//      hint, so a curious user understands why the button is grey.
//   4. Otherwise -> armed button.
//
// State machine (see plan PR10):
//   idle -> connecting -> building -> awaiting_signature -> attaching -> attached
//     \_________________________________________________________________/
//                                  |-> failed (pre-sign error) -> idle via Retry
//                                  |-> attach_failed (post-broadcast) -> attach_retry
//
// CRITICAL (Codex PR14 P1): the transition to `failed` vs
// `attach_failed` is load-bearing. Once `sys_signAndSend` returns a
// txid, the 150 SYS is ALREADY burned on-chain — retrying the full
// flow would build a second PSBT and burn a second 150 SYS for the
// same submission. When attachCollateral fails after a successful
// broadcast, we park in `attach_failed` with the txid preserved,
// and the only recovery affordance is "Retry attach" (which re-
// runs just the DB write) plus a "Copy TXID" escape hatch so the
// user can paste into the manual form if our backend stays down.
//
// `attached` is terminal — we call onAttached(txid), which the caller
// uses to either redirect to the status page (wizard) or refresh the
// submission row in-place (status page). The on-chain confirmation
// watcher lives on the status page, so we deliberately don't try to
// render progress beyond "broadcast" here.
//
// Props:
//   submission           : { id, proposalHash, ... } — must be prepared
//   proposalServiceImpl  : the proposal service API (buildCollateralPsbt,
//                          getGovernanceNetwork, attachCollateral)
//   onAttached(txid)     : called after attachCollateral resolves
//   fallbackHint         : copy shown below the "not available" hint,
//                          pointing users at the sibling option that
//                          IS available in the containing view
//                          (e.g. "Use Option B or C below" in the
//                          wizard, "Use the TXID paste form below"
//                          on the status page).
export default function PayWithPaliPanel({
  submission,
  proposalServiceImpl,
  onAttached,
  heading = 'Option A — Pay with Pali',
  fallbackHint = 'Pay with Pali is not available on this instance.',
}) {
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);
  // Txid stashed when broadcast succeeded but attach failed.
  // Consumed by onRetryAttach + rendered in attach_failed copy so
  // the user has an escape hatch to manually attach if our attach
  // endpoint is persistently down.
  const [pendingTxid, setPendingTxid] = useState(null);
  // Network-probe state. Distinguishes three terminal outcomes so we
  // can tell the user why the button is grey:
  //   * loading: true                 — probe in flight
  //   * enabled: true                 — backend ready to serve PSBTs
  //   * enabled: false, reason: <code>— server reported disabled
  //   * enabled: false, probeError    — transient failure; retryable
  // The `probeError` branch is load-bearing (Codex PR14 round 2 P2):
  // a transient /network 5xx or network blip used to collapse to
  // "permanently disabled for this mount", forcing users to reload
  // the page to recover. We now surface a retry button instead.
  const [networkProbe, setNetworkProbe] = useState({
    loading: true,
    enabled: false,
    chain: null,
    networkKey: null,
    reason: null,
    probeError: null,
  });
  // Bump to force a re-probe. The useEffect below keys on this.
  const [probeNonce, setProbeNonce] = useState(0);
  const mountedRef = useRef(true);
  const paliInstalled = usePaliAvailable();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Rehydrate from localStorage if a previous mount broadcast to
  // the chain but never completed `attachCollateral` (tab close,
  // hard nav, full reload). Keyed by submission.id so the recovery
  // applies only to THIS proposal. Only engages when we're in the
  // neutral `idle` state — we must never clobber in-flight phase
  // transitions that the same render cycle started. Codex PR14 P3.
  const submissionId = submission && submission.id;
  useEffect(() => {
    if (!submissionId) return;
    if (phase !== 'idle') return;
    const stashed = loadPendingTxidLS(submissionId);
    if (!stashed) return;
    setPendingTxid(stashed);
    setPhase('attach_failed');
    setError(
      Object.assign(new Error('pali_attach_interrupted'), {
        code: 'pali_attach_interrupted',
      })
    );
    // Intentionally NOT clearing the stash here — we only clear on
    // a successful attach (via onRetryAttach). If the user reloads
    // again before retrying, the recovery UI must still be there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId]);

  useEffect(() => {
    if (!paliInstalled || !proposalServiceImpl) {
      setNetworkProbe({
        loading: false,
        enabled: false,
        chain: null,
        networkKey: null,
        reason: null,
        probeError: null,
      });
      return undefined;
    }
    let cancelled = false;
    setNetworkProbe((prev) => ({
      ...prev,
      loading: true,
      probeError: null,
    }));
    (async () => {
      try {
        const net = await proposalServiceImpl.getGovernanceNetwork();
        if (cancelled) return;
        // `payProposalCollateralWithPali` hard-rejects with
        // `pali_path_disabled` if networkKey is absent (backend drift
        // / partial rollout), so a button armed purely on
        // paliPathEnabled would be a guaranteed dead-end click. Gate
        // on BOTH fields — any missing networkKey demotes the lane
        // to the disabled+hint state so users land on the manual
        // fallback instead. Codex PR14 P2.
        const backendEnabled = !!net.paliPathEnabled;
        const networkKey = net.networkKey || null;
        const effectiveEnabled = backendEnabled && !!networkKey;
        const reason =
          net.paliPathReason ||
          (backendEnabled && !networkKey
            ? 'pali_path_networkkey_missing'
            : null);
        setNetworkProbe({
          loading: false,
          enabled: effectiveEnabled,
          chain: net.chain || null,
          networkKey,
          reason,
          probeError: null,
        });
      } catch (err) {
        if (cancelled) return;
        setNetworkProbe({
          loading: false,
          enabled: false,
          chain: null,
          networkKey: null,
          reason: null,
          probeError: err || new Error('probe_failed'),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paliInstalled, proposalServiceImpl, probeNonce]);

  const onProbeRetry = () => setProbeNonce((n) => n + 1);

  if (!paliInstalled) return null;

  const pending =
    phase === 'connecting' ||
    phase === 'building' ||
    phase === 'awaiting_signature' ||
    phase === 'attaching';

  const busyCopy = {
    connecting: 'Connecting to Pali…',
    building: 'Building unsigned transaction…',
    awaiting_signature: 'Approve the 150 SYS burn in Pali…',
    attaching: 'Attaching TXID to your proposal…',
  };

  const disabled =
    !submission ||
    networkProbe.loading ||
    !networkProbe.enabled ||
    pending ||
    phase === 'attached' ||
    // Pay button is locked while a successful broadcast is awaiting
    // its DB attach; we do NOT want the user to press "Pay" again
    // and double-burn.
    phase === 'attach_failed';

  async function onClick() {
    if (!submission) return;
    setError(null);
    setPendingTxid(null);
    setPhase('connecting');
    // Split the flow into two explicit stages: (1) the
    // broadcast-capable steps that could burn 150 SYS on the chain,
    // and (2) the DB attach. A failure inside (1) is safe to retry
    // from scratch (no on-chain state produced). A failure inside
    // (2) means the burn happened; restarting the flow would double
    // it, so we park in attach_failed with the txid preserved.
    let txid;
    try {
      ({ txid } = await payProposalCollateralWithPali(
        submission.id,
        proposalServiceImpl,
        {
          onProgress: (nextPhase) => {
            if (!mountedRef.current) return;
            setPhase(nextPhase);
          },
        }
      ));
    } catch (err) {
      if (!mountedRef.current) return;
      setPhase('failed');
      setError(err);
      return;
    }
    // BURN IS ON-CHAIN. Everything below must survive component
    // unmount (navigation, tab switch, reload). We stash to
    // localStorage first so a reload still lets us recover, then
    // run the attach unconditionally — only the UI state updates
    // are gated on mountedRef. Codex PR14 P3.
    stashPendingTxidLS(submission.id, txid);
    if (mountedRef.current) setPhase('attaching');
    try {
      await proposalServiceImpl.attachCollateral(submission.id, txid);
    } catch (err) {
      // Attach failed (transient 5xx, network drop, auth expiry).
      // The stash above means a later remount can pick this up and
      // route the user into the recovery UI. If we're still
      // mounted, render that UI now.
      if (!mountedRef.current) return;
      setPendingTxid(txid);
      setPhase('attach_failed');
      setError(err);
      return;
    }
    clearPendingTxidLS(submission.id);
    if (!mountedRef.current) return;
    setPhase('attached');
    if (typeof onAttached === 'function') onAttached(txid);
  }

  function onRetry() {
    setError(null);
    setPendingTxid(null);
    setPhase('idle');
  }

  // Post-broadcast retry: re-runs ONLY the attach step against the
  // stashed txid. The on-chain tx already exists; we just need the
  // backend row to reflect that. No Pali roundtrip. No double-burn.
  async function onRetryAttach() {
    if (!submission || !pendingTxid) return;
    setError(null);
    setPhase('attaching');
    try {
      await proposalServiceImpl.attachCollateral(submission.id, pendingTxid);
    } catch (err) {
      if (!mountedRef.current) return;
      setPhase('attach_failed');
      setError(err);
      return;
    }
    clearPendingTxidLS(submission.id);
    if (!mountedRef.current) return;
    setPhase('attached');
    const finalTxid = pendingTxid;
    setPendingTxid(null);
    if (typeof onAttached === 'function') onAttached(finalTxid);
  }

  let statusLine = null;
  if (pending && busyCopy[phase]) {
    statusLine = (
      <p
        className="proposal-wizard__pali-status"
        data-testid="pali-status-line"
      >
        {busyCopy[phase]}
      </p>
    );
  } else if (phase === 'attached') {
    statusLine = (
      <p
        className="proposal-wizard__pali-status proposal-wizard__pali-status--success"
        data-testid="pali-status-line"
      >
        Collateral broadcast. The proposal will be submitted after 6
        confirmations.
      </p>
    );
  }

  // Hint copy picks from the probe outcome + server-supplied reason.
  // The probeError branch (transient failure) renders its own block
  // with a retry button instead of the flat hint.
  let hint = null;
  if (networkProbe.loading) {
    hint = 'Checking Pali availability…';
  } else if (networkProbe.probeError) {
    hint = null;
  } else if (!networkProbe.enabled) {
    switch (networkProbe.reason) {
      case 'pali_path_rpc_down':
        hint =
          "This backend can't reach its Syscoin RPC node yet. Try again in a moment, or use the manual form below.";
        break;
      case 'pali_path_chain_mismatch':
        hint =
          'This backend is misconfigured (SYSCOIN_NETWORK and the connected node disagree). Please contact the operator. Use the manual form below in the meantime.';
        break;
      case 'pali_path_networkkey_missing':
        hint =
          "This backend says Pay with Pali is enabled but didn't report which network it's on. That usually means a partial rollout — please use the manual form below.";
        break;
      case 'pali_not_configured':
      default:
        hint = fallbackHint;
    }
  } else if (networkProbe.networkKey === 'testnet') {
    hint = 'This backend is pinned to Syscoin testnet.';
  }

  return (
    <div
      className="proposal-wizard__pali-panel"
      data-testid="pali-pay-panel"
    >
      <h3>{heading}</h3>
      <p>
        Open your Pali extension, approve the 150 SYS burn, and we'll
        attach the TXID for you. No copy-paste, no CLI.
      </p>
      <button
        type="button"
        className="button button--primary proposal-wizard__pali-button"
        onClick={onClick}
        disabled={disabled}
        data-testid="pali-pay-button"
      >
        {/* Pali hex mark (favicon-128 from the pali-wallet repo,
            copied verbatim to keep brand fidelity). Hidden from
            assistive tech — the button text already names the
            wallet, so the logo would be duplicative noise in a
            screen reader. */}
        <img
          src={process.env.PUBLIC_URL + '/pali-logo.png'}
          alt=""
          aria-hidden="true"
          className="proposal-wizard__pali-button-logo"
          width="20"
          height="20"
        />
        <span className="proposal-wizard__pali-button-label">
          {phase === 'attached'
            ? 'Paid'
            : pending
            ? 'Working…'
            : 'Pay with Pali'}
        </span>
      </button>
      {hint ? (
        <p
          className="proposal-wizard__pali-hint"
          data-testid="pali-pay-hint"
        >
          {hint}
        </p>
      ) : null}
      {networkProbe.probeError ? (
        <div
          className="auth-alert auth-alert--warning"
          role="alert"
          data-testid="pali-probe-error"
        >
          <p>
            We couldn't check whether Pay with Pali is available on
            this server right now. This is usually a transient
            hiccup.
          </p>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onProbeRetry}
            data-testid="pali-probe-retry"
          >
            Try again
          </button>
        </div>
      ) : null}
      {statusLine}
      {phase === 'attach_failed' && pendingTxid ? (
        <PaliAttachFailedBlock
          txid={pendingTxid}
          error={error}
          onRetryAttach={onRetryAttach}
        />
      ) : error ? (
        <PaliErrorBlock error={error} onRetry={onRetry} />
      ) : null}
    </div>
  );
}

// PaliAttachFailedBlock — shown ONLY when Pali has already broadcast
// the 150 SYS burn but our /attach-collateral call failed (transient
// 5xx, network blip, etc.). The only primary affordance is "Retry
// attach" (no re-sign). A secondary affordance copies the txid so
// the user can paste it into the manual form if our backend stays
// down — critically, NOT a "Try again" that would kick off a second
// broadcast.
export function PaliAttachFailedBlock({ txid, error, onRetryAttach }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    // Only flash "Copied!" when the clipboard write actually succeeded
    // (Codex PR14 P3). In environments where the Clipboard API is
    // missing or blocked, the txid is already rendered verbatim in the
    // <code> block for manual copy — claiming we copied it when we
    // didn't is actively misleading in this burn-recovery path.
    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      return;
    }
    try {
      await navigator.clipboard.writeText(txid);
    } catch (_e) {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }
  const code = (error && (error.code || error.message)) || 'attach_failed';
  return (
    <div
      className="auth-alert auth-alert--warning"
      role="alert"
      data-testid="pali-attach-failed"
    >
      <p>
        <strong>Your 150 SYS burn broadcast successfully</strong>, but
        we couldn't record it against your proposal. Your funds are
        safe on-chain — we just need to reconcile the TXID.
      </p>
      <p className="proposal-wizard__pali-txid" data-testid="pali-attach-txid">
        <code>{txid}</code>
      </p>
      <p>
        Click <em>Retry attach</em> to try again — this will NOT
        broadcast another transaction. If the problem persists, copy
        the TXID and paste it into the manual form below.
      </p>
      <div className="proposal-wizard__pali-attach-actions">
        <button
          type="button"
          className="button button--primary button--small"
          onClick={onRetryAttach}
          data-testid="pali-attach-retry"
        >
          Retry attach
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={copy}
          data-testid="pali-attach-copy-txid"
        >
          {copied ? 'Copied!' : 'Copy TXID'}
        </button>
      </div>
      <p
        className="proposal-wizard__pali-attach-hint"
        data-testid="pali-attach-error-code"
      >
        Attach error: {code}
      </p>
    </div>
  );
}

// PaliErrorBlock — maps translated error codes to human copy so
// "user_rejected" doesn't scare anyone. Keep this list aligned with
// paliProvider.translatePaliError() and the backend-translated codes
// surfaced by buildCollateralPsbt (insufficient_funds,
// blockbook_unreachable, network_mismatch, bad_xpub, bad_change_address).
export function PaliErrorBlock({ error, onRetry }) {
  const code = (error && (error.code || error.message)) || 'unknown_error';
  const copy = {
    user_rejected:
      'Signature cancelled in Pali. When you are ready, click "Pay with Pali" again.',
    pali_unavailable:
      'Pali is no longer responding. Make sure the extension is unlocked.',
    network_mismatch:
      'Pali is on a different Syscoin network than this backend. Switch networks in Pali and try again.',
    pali_path_disabled:
      'Pay with Pali is not configured on this server.',
    insufficient_funds:
      'This Pali account does not have enough SYS to cover the 150 SYS burn plus fees.',
    blockbook_unreachable:
      'Could not reach the UTXO indexer. Please try again in a moment.',
    bad_xpub:
      'Pali returned an unexpected account key. Try disconnecting and reconnecting the extension.',
    bad_change_address:
      'Pali returned an unexpected change address. Try disconnecting and reconnecting the extension.',
    bad_signer_response:
      'Pali returned an unexpected response. Please retry, or use the manual fallback.',
  };
  const message =
    copy[code] ||
    `Pay with Pali failed (${code}). You can retry, or use the manual fallback.`;
  return (
    <div
      className="auth-alert auth-alert--error"
      role="alert"
      data-testid="pali-pay-error"
    >
      <p>{message}</p>
      <button
        type="button"
        className="button button--ghost button--small"
        onClick={onRetry}
        data-testid="pali-pay-retry"
      >
        Try again
      </button>
    </div>
  );
}
