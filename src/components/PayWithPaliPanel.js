import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  isPaliAvailable,
  payProposalCollateralWithPali,
} from '../lib/paliProvider';

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
//                                  |-> failed (any step) -> idle via Retry
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
  const [networkProbe, setNetworkProbe] = useState({
    loading: true,
    enabled: false,
    chain: null,
    networkKey: null,
  });
  const mountedRef = useRef(true);
  const paliInstalled = useMemo(() => {
    try {
      return isPaliAvailable();
    } catch (_e) {
      return false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!paliInstalled || !proposalServiceImpl) {
      setNetworkProbe({
        loading: false,
        enabled: false,
        chain: null,
        networkKey: null,
      });
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const net = await proposalServiceImpl.getGovernanceNetwork();
        if (cancelled) return;
        setNetworkProbe({
          loading: false,
          enabled: !!net.paliPathEnabled,
          chain: net.chain || null,
          networkKey: net.networkKey || null,
        });
      } catch (_e) {
        if (cancelled) return;
        setNetworkProbe({
          loading: false,
          enabled: false,
          chain: null,
          networkKey: null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paliInstalled, proposalServiceImpl]);

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
    phase === 'attached';

  async function onClick() {
    if (!submission) return;
    setError(null);
    setPhase('connecting');
    try {
      const { txid } = await payProposalCollateralWithPali(
        submission.id,
        proposalServiceImpl,
        {
          onProgress: (nextPhase) => {
            if (!mountedRef.current) return;
            setPhase(nextPhase);
          },
        }
      );
      if (!mountedRef.current) return;
      setPhase('attaching');
      await proposalServiceImpl.attachCollateral(submission.id, txid);
      if (!mountedRef.current) return;
      setPhase('attached');
      if (typeof onAttached === 'function') onAttached(txid);
    } catch (err) {
      if (!mountedRef.current) return;
      setPhase('failed');
      setError(err);
    }
  }

  function onRetry() {
    setError(null);
    setPhase('idle');
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

  let hint = null;
  if (networkProbe.loading) {
    hint = 'Checking Pali availability…';
  } else if (!networkProbe.enabled) {
    hint = fallbackHint;
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
        className="button button--primary"
        onClick={onClick}
        disabled={disabled}
        data-testid="pali-pay-button"
      >
        {phase === 'attached'
          ? 'Paid'
          : pending
          ? 'Working…'
          : 'Pay with Pali'}
      </button>
      {hint ? (
        <p
          className="proposal-wizard__pali-hint"
          data-testid="pali-pay-hint"
        >
          {hint}
        </p>
      ) : null}
      {statusLine}
      {error ? (
        <PaliErrorBlock error={error} onRetry={onRetry} />
      ) : null}
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
