import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../context/AuthContext';
import { useVault } from '../context/VaultContext';
import { useOwnedMasternodes } from '../hooks/useOwnedMasternodes';
import { governanceService as defaultService } from '../lib/governanceService';
import { signVoteFromWif } from '../lib/syscoin/voteSigner';

// ProposalVoteModal
// -----------------------------------------------------------------------
// The authenticated "vote from the vault" surface for a single proposal.
//
// Flow:
//   1. Guard: modal is a no-op if the user isn't authenticated, their
//      vault isn't unlocked, or they have zero owned masternodes. Each
//      of those cases renders a contextual CTA rather than a silent
//      empty list, because the call-site is the Governance page where
//      non-auth users see a copy-to-clipboard fallback instead.
//   2. Choose: checkbox list of owned MNs + outcome radio. By default
//      all MNs are selected; the user can deselect individuals.
//   3. Sign: for every selected MN we call signVoteFromWif() against
//      a single captured `time` (seconds since epoch, once) so every
//      vote in the batch is chained to the same preimage-time field.
//      Signing runs sequentially because secp256k1 is CPU-bound and
//      async yields let the UI breathe between rows.
//   4. Submit: POST /gov/vote with all signed entries. The server
//      fans out individual voteraw calls and returns per-entry
//      success/failure; we render that mixed result.
//
// Why we capture `time` once: Core's `voteraw` uses it as the preimage
// timestamp, and it's baked into every signature. If we captured
// `Date.now()` per-row, a long sign loop on a slow browser could land
// signatures with drifting times — harmless but inconsistent, and
// harder to reason about when debugging rejected votes.
//
// Recovery guarantees:
//   - If the vault is locked mid-session (user clicks "Lock" in
//     another tab), signVoteFromWif will fail because the WIF is
//     already wiped from the vault payload. We surface the error
//     per-row.
//   - If the network fails during /gov/vote, we stay in 'submitting'
//     → 'error' and offer a retry. No votes are lost because nothing
//     was persisted client-side; the backend is either all-or-nothing
//     on the batch endpoint (the Promise from submitVote either
//     resolves with results or rejects; partial relays inside the
//     batch are represented as ok:false rows, not rejections).

const PHASE = Object.freeze({
  PICK: 'pick',
  SIGNING: 'signing',
  SUBMITTING: 'submitting',
  DONE: 'done',
  ERROR: 'error',
});

function outcomeLabel(o) {
  if (o === 'yes') return 'Yes';
  if (o === 'no') return 'No';
  return 'Abstain';
}

// Stable per-masternode identity used for selection and React keys.
//
// Using `keyId` (the vault entry that holds the voting WIF) would be
// wrong: Syscoin lets one voting address be configured on multiple
// masternodes (an operator who reuses a key across several of their
// MNs). `lookupOwnedMasternodes` returns one row per MN keyed on the
// collateral outpoint, so a single vault key legitimately produces
// multiple `owned` rows. Keying selection on `keyId` would dedupe
// those rows into a single toggle — submitting would then cast votes
// for BOTH MNs when the user only sees one checkbox, and deselecting
// "one" would silently skip the other. The collateral outpoint is
// the only globally-unique per-MN identifier the backend provides.
function mnId(m) {
  return `${m.collateralHash}:${m.collateralIndex}`;
}

function errorCopy(code) {
  switch (code) {
    case 'rate_limited':
      return "You've submitted a lot of votes recently. Wait a minute and try again.";
    case 'network_error':
      return "We couldn't reach the sysnode server. Check your connection and retry.";
    case 'signature_invalid':
      return 'The signature was rejected by the network (wrong voting key for this masternode).';
    case 'signature_malformed':
      return 'The signature was malformed. Please try again.';
    case 'mn_not_found':
      return 'This masternode is no longer active on-chain.';
    case 'vote_too_often':
      return 'This masternode already voted recently on this proposal. Try again in a minute.';
    case 'proposal_not_found':
      return 'The proposal no longer exists on-chain.';
    case 'already_voted':
      return 'This masternode has already voted on this proposal.';
    case 'invalid_vote_signal':
    case 'invalid_vote_outcome':
      return 'The server rejected the vote shape. Please refresh and retry.';
    default:
      return code ? `Vote failed (${code}).` : 'Vote failed.';
  }
}

// Per-row success copy. `skipped` comes from the backend short-circuit
// paths (receipts.decideRelay) — surfacing the distinction in the DONE
// view is what earns the difference between "the network accepted my
// yes vote" and "the network already had my yes vote, we didn't
// bother relaying it again".
function successCopy({ outcome, skipped }) {
  const label = outcomeLabel(outcome);
  if (skipped === 'already_on_chain') return `${label} already on-chain`;
  if (skipped === 'recently_relayed') return `${label} already submitted`;
  return `${label} accepted`;
}

// Row-level receipt summary shown next to every owned MN in the
// picker. Intentionally terse: a full status chip with colour + hover
// detail is PR 6b territory. For PR 6a we just want the user to
// understand why a row is unchecked when the default-selection logic
// excluded it.
function receiptBadge(receipt, currentOutcome) {
  if (!receipt) return null;
  if (receipt.status === 'confirmed') {
    const sameOutcome = receipt.voteOutcome === currentOutcome;
    if (sameOutcome) {
      return `Already voted ${outcomeLabel(receipt.voteOutcome).toLowerCase()}`;
    }
    return `Voted ${outcomeLabel(receipt.voteOutcome).toLowerCase()} (will change)`;
  }
  if (receipt.status === 'failed') return 'Last attempt failed';
  if (receipt.status === 'stale') return 'Needs retry';
  if (receipt.status === 'relayed') return 'Awaiting confirmation';
  return null;
}

export default function ProposalVoteModal({
  open,
  onClose,
  proposal,
  governanceService = defaultService,
}) {
  const { isAuthenticated } = useAuth();
  const vault = useVault();
  // Gate the lookup on `open` so merely mounting the modal from a
  // parent page (Governance always renders <ProposalVoteModal
  // open={...} />) does NOT POST vault addresses to
  // `/gov/mns/lookup`. Without this, every authenticated user with
  // an unlocked vault would hit the backend on every Governance
  // page view even if they never click Vote — unnecessary load +
  // premature address disclosure. The hook resets itself to IDLE
  // when `enabled` flips false, and re-fetches cleanly when the
  // user opens the modal.
  const {
    owned,
    isLoading,
    isError,
    error,
    refresh,
    isVaultEmpty,
    reconcileError,
  } = useOwnedMasternodes({
    governanceService,
    enabled: open,
    // Passing the proposal hash here causes the hook to additionally
    // fetch /gov/receipts and join per-MN receipt rows onto `owned`.
    // When the modal is closed we pass null so no receipts request
    // fires — same rationale as `enabled` above.
    proposalHash: open && proposal && typeof proposal.Key === 'string' ? proposal.Key : null,
  });

  // `selected` is null while the user hasn't explicitly interacted
  // yet (select-all, select-none, or checkbox toggle). In that
  // state we treat every `owned` masternode as selected by default.
  // Once the user interacts, `selected` becomes a concrete Set and
  // we use it as-is. This avoids the timing gap that would happen
  // with a useEffect-driven bootstrap, where the modal briefly
  // renders with empty checkboxes between "owned arrived" and
  // "effect ran".
  //
  // The Set stores collateral-outpoint strings (see `mnId`), NOT
  // vault key ids — see the comment on `mnId` for why that matters.
  const [selected, setSelected] = useState(null);
  const [outcome, setOutcome] = useState('yes');
  const [phase, setPhase] = useState(PHASE.PICK);
  const [signProgress, setSignProgress] = useState({ done: 0, total: 0 });
  const [submitError, setSubmitError] = useState(null);
  const [results, setResults] = useState(null);

  // Cancellation generation. Every voting run captures the current
  // value; after every async boundary (sign loop yield, submitVote
  // await) we compare it to the live counter and bail if it's moved.
  // The counter advances whenever the modal closes, unmounts, or
  // switches to a different proposal — so a user closing mid-flight
  // cannot cause a late submitVote() relay, and late state updates
  // from the previous run cannot race with a newly-opened modal.
  const runGenRef = useRef(0);
  useEffect(() => {
    const proposalKey = proposal && proposal.Key;
    return () => {
      // Cleanup fires when `open` or `proposalKey` change AND on
      // unmount. Any in-flight run sees a generation mismatch and
      // becomes a no-op.
      runGenRef.current += 1;
      // Silence a lint warning about the unused capture — reading
      // proposalKey here pins the dep to the useEffect deps list.
      void proposalKey;
    };
  }, [open, proposal && proposal.Key]);

  // Default selection is receipt-aware: when the user hasn't
  // interacted yet, an owned MN with a confirmed on-chain receipt at
  // the currently-chosen outcome is UN-checked by default (we don't
  // want the user to burn a second voteraw on a vote the network
  // already has — Core penalises duplicate votes as vote_too_often).
  //
  // Rows whose confirmed receipt has a DIFFERENT outcome from the
  // current one remain checked: that's a legitimate vote-change,
  // which decideRelay() on the backend will re-submit.
  //
  // Rows without a receipt, or with a receipt in a non-confirmed
  // state (failed / stale / relayed), stay checked — they either
  // haven't been counted yet or need another pass to make it.
  //
  // Once the user clicks any row / select-all / clear, `selected`
  // becomes a concrete Set and we respect it verbatim even if the
  // outcome radio changes. That's intentional: explicit user intent
  // should not be overwritten by a receipt-driven recalculation.
  const computeDefault = useCallback(
    (ownedList, currentOutcome) => {
      const set = new Set();
      for (const m of ownedList) {
        const r = m.receipt;
        const alreadyVotedSameOutcome =
          r &&
          r.status === 'confirmed' &&
          r.voteOutcome === currentOutcome;
        if (!alreadyVotedSameOutcome) set.add(mnId(m));
      }
      return set;
    },
    []
  );

  const effectiveSelected = useMemo(() => {
    if (selected !== null) return selected;
    return computeDefault(owned, outcome);
  }, [selected, owned, outcome, computeDefault]);

  // Reset local state whenever the modal opens or the proposal
  // changes. `proposal.Key` is the governance hash and is unique
  // per proposal, so keying on it prevents stale selection / results
  // from leaking across proposal switches.
  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setOutcome('yes');
    setPhase(PHASE.PICK);
    setSignProgress({ done: 0, total: 0 });
    setSubmitError(null);
    setResults(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, proposal && proposal.Key]);

  const toggle = useCallback(
    (id) => {
      setSelected((prev) => {
        // First interaction: seed from the receipt-aware default so
        // the user's click only changes *this* row rather than also
        // implicitly selecting rows the default had excluded.
        const base = prev === null ? computeDefault(owned, outcome) : prev;
        const next = new Set(base);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [owned, outcome, computeDefault]
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(owned.map(mnId)));
  }, [owned]);

  const selectNone = useCallback(() => {
    setSelected(new Set());
  }, []);

  const submittable = useMemo(
    () =>
      phase === PHASE.PICK &&
      effectiveSelected.size > 0 &&
      owned.length > 0,
    [phase, effectiveSelected.size, owned.length]
  );

  // Core vote-run routine. Shared by the initial Sign & Submit click
  // and the Retry failed button on the DONE screen.
  //
  // Parameters:
  //   chosen     — concrete list of owned-masternode rows to sign and
  //                submit. Caller is responsible for whatever
  //                selection logic applies (effectiveSelected for the
  //                initial run, failed-row filter for retry).
  //   mergeBase  — optional list of prior successful per-row results
  //                to prepend to this run's byEntry. Used by Retry
  //                failed so the DONE screen keeps showing the rows
  //                that succeeded on the previous attempt; without
  //                this, a retry that only re-submits failed rows
  //                would make the prior successes disappear and
  //                undercount `accepted`.
  const runVotePass = useCallback(
    async (chosen, { mergeBase = null } = {}) => {
      if (!proposal || typeof proposal.Key !== 'string') {
        setPhase(PHASE.ERROR);
        setSubmitError('missing_proposal');
        return;
      }
      if (!Array.isArray(chosen) || chosen.length === 0) return;

      // Pin the cancellation generation for this run. The cleanup
      // effect on [open, proposal.Key] bumps runGenRef whenever the
      // modal closes or switches proposals. Any post-await
      // checkpoint that sees a mismatch aborts before side-effects
      // (submitVote relay, setPhase/setResults on a stale view) can
      // fire.
      const myGen = runGenRef.current;
      const isCancelled = () => runGenRef.current !== myGen;

      setPhase(PHASE.SIGNING);
      setSignProgress({ done: 0, total: chosen.length });
      setSubmitError(null);
      setResults(null);

      const priorAccepted = Array.isArray(mergeBase)
        ? mergeBase.filter((e) => e.ok).length
        : 0;
      const baseEntries = Array.isArray(mergeBase) ? mergeBase : [];

      // One timestamp for the whole batch. See file header for
      // rationale.
      const time = Math.floor(Date.now() / 1000);
      const entries = [];
      const signingErrors = [];
      for (let i = 0; i < chosen.length; i++) {
        const mn = chosen[i];
        try {
          if (i > 0 && i % 4 === 0) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 0));
            if (isCancelled()) return;
          }
          const { voteSig } = signVoteFromWif({
            wif: mn.wif,
            collateralHash: mn.collateralHash,
            collateralIndex: mn.collateralIndex,
            proposalHash: proposal.Key,
            voteOutcome: outcome,
            voteSignal: 'funding',
            time,
          });
          entries.push({
            collateralHash: mn.collateralHash,
            collateralIndex: mn.collateralIndex,
            voteSig,
            _keyId: mn.keyId,
            _label: mn.label,
            _address: mn.address,
          });
        } catch (err) {
          signingErrors.push({
            keyId: mn.keyId,
            label: mn.label,
            address: mn.address,
            collateralHash: mn.collateralHash,
            collateralIndex: mn.collateralIndex,
            code: (err && err.code) || 'sign_failed',
          });
        }
        if (isCancelled()) return;
        setSignProgress({ done: i + 1, total: chosen.length });
      }

      if (isCancelled()) return;

      if (entries.length === 0) {
        setPhase(PHASE.DONE);
        const signingRows = signingErrors.map((e) => ({
          keyId: e.keyId,
          label: e.label,
          address: e.address,
          collateralHash: e.collateralHash,
          collateralIndex: e.collateralIndex,
          ok: false,
          error: e.code,
          skipped: null,
        }));
        setResults({
          accepted: priorAccepted,
          rejected: signingErrors.length,
          byEntry: [...baseEntries, ...signingRows],
        });
        return;
      }

      setPhase(PHASE.SUBMITTING);
      try {
        const payload = entries.map(
          ({ collateralHash, collateralIndex, voteSig }) => ({
            collateralHash,
            collateralIndex,
            voteSig,
          })
        );
        if (isCancelled()) return;
        const resp = await governanceService.submitVote({
          proposalHash: proposal.Key,
          voteOutcome: outcome,
          voteSignal: 'funding',
          time,
          entries: payload,
        });
        if (isCancelled()) return;
        const byOutpoint = new Map();
        for (const e of entries) {
          byOutpoint.set(
            `${e.collateralHash}:${e.collateralIndex}`,
            e
          );
        }
        const byEntry = (Array.isArray(resp.results) ? resp.results : []).map(
          (r) => {
            const k = byOutpoint.get(
              `${r.collateralHash}:${r.collateralIndex}`
            );
            return {
              keyId: k ? k._keyId : null,
              label: k ? k._label : '',
              address: k ? k._address : '',
              collateralHash: r.collateralHash,
              collateralIndex: r.collateralIndex,
              ok: !!r.ok,
              error: r.error || null,
              // `skipped` is the backend decideRelay verdict: 'already_on_chain'
              // or 'recently_relayed'. Preserved so successCopy() can
              // render a distinct status string.
              skipped: r.skipped || null,
            };
          }
        );
        for (const e of signingErrors) {
          byEntry.push({
            keyId: e.keyId,
            label: e.label,
            address: e.address,
            collateralHash: e.collateralHash,
            collateralIndex: e.collateralIndex,
            ok: false,
            error: e.code,
            skipped: null,
          });
        }
        setResults({
          accepted: (resp.accepted || 0) + priorAccepted,
          rejected: (resp.rejected || 0) + signingErrors.length,
          byEntry: [...baseEntries, ...byEntry],
        });
        setPhase(PHASE.DONE);
      } catch (err) {
        if (isCancelled()) return;
        setSubmitError((err && err.code) || 'submit_failed');
        setPhase(PHASE.ERROR);
      }
    },
    [proposal, outcome, governanceService]
  );

  const startVoting = useCallback(() => {
    const chosen = owned.filter((m) => effectiveSelected.has(mnId(m)));
    return runVotePass(chosen);
  }, [owned, effectiveSelected, runVotePass]);

  // Retry only the failed rows from the current DONE view.
  //
  // Intentionally keeps the same outcome: changing outcome is a
  // destructive operation (different signatures, different relay
  // intent) and belongs in the picker, not a retry button. A user
  // who wants to change their vote should close the modal and
  // re-open it, or clear the selection and start over.
  const retryFailed = useCallback(() => {
    if (!results || !Array.isArray(results.byEntry)) return;
    const failedKeys = new Set(
      results.byEntry
        .filter((e) => !e.ok && e.collateralHash && e.collateralIndex != null)
        .map((e) => `${e.collateralHash}:${e.collateralIndex}`)
    );
    if (failedKeys.size === 0) return;
    // Re-resolve from the *current* owned list in case it refreshed
    // between attempts (e.g. masternode tracker updated while the
    // DONE screen was open). An MN that disappeared from `owned`
    // can't be retried — surface that by leaving it in the merged
    // failure list.
    const chosen = owned.filter((m) => failedKeys.has(mnId(m)));
    if (chosen.length === 0) return;
    const priorSuccesses = results.byEntry.filter((e) => e.ok);
    return runVotePass(chosen, { mergeBase: priorSuccesses });
  }, [owned, results, runVotePass]);

  if (!open) return null;

  const title = (proposal && (proposal.title || proposal.name)) || 'Proposal';

  // Guard rails that render a contextual CTA instead of the normal
  // modal body. These are NOT errors — they're expected states for
  // anyone who hasn't unlocked their vault yet.
  let body = null;
  if (!isAuthenticated) {
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-guard-anon">
        <p>Log in to vote directly from this page.</p>
        <div className="vote-modal__actions">
          <Link className="button button--primary button--small" to="/login">
            Log in
          </Link>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    );
  } else if (!vault.isUnlocked) {
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-guard-locked">
        <p>
          Unlock your vault on the Account page to sign votes with your
          masternode voting keys.
        </p>
        <div className="vote-modal__actions">
          <Link
            className="button button--primary button--small"
            to="/account"
          >
            Go to Account
          </Link>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    );
  } else if (isLoading) {
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-loading">
        <p>Looking up your masternodes...</p>
      </div>
    );
  } else if (isError) {
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-lookup-error">
        <p>Couldn't load your masternode list ({error || 'error'}).</p>
        <div className="vote-modal__actions">
          <button
            type="button"
            className="button button--primary button--small"
            onClick={refresh}
          >
            Retry
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    );
  } else if (isVaultEmpty) {
    // First-time user: vault is unlocked but no voting keys have been
    // imported yet. Keep this distinct from the "keys present but no
    // matching MNs" state below — different problem, different CTA.
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-guard-empty-vault">
        <p>
          Your vault is empty. Import your masternode voting keys on the
          Account page, then come back here to vote with them.
        </p>
        <div className="vote-modal__actions">
          <Link
            className="button button--primary button--small"
            to="/account"
          >
            Go to Account
          </Link>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    );
  } else if (owned.length === 0) {
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-no-owned">
        <p>
          None of the voting keys in your vault match a live masternode
          right now. Verify the voting addresses you've imported match
          what <code>protx_info</code> displays.
        </p>
        <div className="vote-modal__actions">
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={refresh}
          >
            Refresh
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    );
  } else if (phase === PHASE.DONE) {
    const hasFailures = results.byEntry.some((r) => !r.ok);
    // "Retry failed" is only meaningful if at least one failed row
    // maps back to a masternode we can still see in `owned` — if
    // the failures are all for MNs that dropped off the list
    // (deregistered, etc) there's nothing we could actually retry.
    const ownedIds = new Set(owned.map(mnId));
    const retryable = results.byEntry.some(
      (r) =>
        !r.ok &&
        r.collateralHash &&
        r.collateralIndex != null &&
        ownedIds.has(`${r.collateralHash}:${r.collateralIndex}`)
    );
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-done">
        <p>
          <strong>{results.accepted}</strong> accepted,{' '}
          <strong>{results.rejected}</strong> rejected.
        </p>
        <ul className="vote-result-list">
          {results.byEntry.map((r, idx) => (
            <li
              key={`${r.keyId || 'err'}-${idx}`}
              className={r.ok ? 'vote-result is-ok' : 'vote-result is-error'}
              data-testid="vote-result-row"
              data-ok={r.ok ? 'true' : 'false'}
              data-skipped={r.skipped || ''}
            >
              <code>{r.address}</code>
              <span className="vote-result__label">{r.label || ''}</span>
              <span className="vote-result__status">
                {r.ok
                  ? successCopy({ outcome, skipped: r.skipped })
                  : errorCopy(r.error)}
              </span>
            </li>
          ))}
        </ul>
        <div className="vote-modal__actions">
          {hasFailures && retryable ? (
            <button
              type="button"
              className="button button--primary button--small"
              onClick={retryFailed}
              data-testid="vote-modal-retry-failed"
            >
              Retry failed
            </button>
          ) : null}
          <button
            type="button"
            className={
              hasFailures && retryable
                ? 'button button--ghost button--small'
                : 'button button--primary button--small'
            }
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    );
  } else if (phase === PHASE.ERROR) {
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-error">
        <p>{errorCopy(submitError)}</p>
        <div className="vote-modal__actions">
          <button
            type="button"
            className="button button--primary button--small"
            onClick={() => {
              setPhase(PHASE.PICK);
              setSubmitError(null);
            }}
          >
            Try again
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    );
  } else if (phase === PHASE.SIGNING || phase === PHASE.SUBMITTING) {
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-progress">
        <p>
          {phase === PHASE.SIGNING
            ? `Signing ${signProgress.done}/${signProgress.total}...`
            : 'Submitting signed votes...'}
        </p>
      </div>
    );
  } else {
    body = (
      <>
        <fieldset
          className="vote-modal__outcome"
          aria-label="Vote outcome"
          data-testid="vote-modal-outcome"
        >
          <legend>Cast</legend>
          {['yes', 'no', 'abstain'].map((o) => (
            <label key={o} className="vote-modal__radio">
              <input
                type="radio"
                name="vote-outcome"
                value={o}
                checked={outcome === o}
                onChange={() => setOutcome(o)}
                data-testid={`vote-modal-outcome-${o}`}
              />
              {outcomeLabel(o)}
            </label>
          ))}
        </fieldset>

        <div className="vote-modal__selection-header">
          <p className="vote-modal__selection-summary">
            {effectiveSelected.size} of {owned.length} masternode
            {owned.length === 1 ? '' : 's'} selected
          </p>
          <div className="vote-modal__selection-actions">
            <button
              type="button"
              className="auth-linklike"
              onClick={selectAll}
              data-testid="vote-modal-select-all"
            >
              Select all
            </button>
            <button
              type="button"
              className="auth-linklike"
              onClick={selectNone}
              data-testid="vote-modal-select-none"
            >
              Clear
            </button>
          </div>
        </div>

        {reconcileError ? (
          <p
            className="vote-modal__reconcile-note"
            data-testid="vote-modal-reconcile-error"
          >
            We couldn't verify your past votes against the network just
            now ({reconcileError}). You can still vote — recent votes
            may be re-submitted, which is harmless.
          </p>
        ) : null}

        <ul className="vote-modal__list" data-testid="vote-modal-list">
          {owned.map((m) => {
            const id = mnId(m);
            const badge = receiptBadge(m.receipt, outcome);
            const receiptStatus = m.receipt ? m.receipt.status : '';
            return (
              <li
                key={id}
                className="vote-modal__row"
                data-testid="vote-modal-row"
                data-mn-id={id}
                data-key-id={m.keyId}
                data-receipt-status={receiptStatus}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={effectiveSelected.has(id)}
                    onChange={() => toggle(id)}
                    data-testid={`vote-modal-toggle-${id}`}
                  />
                  <span className="vote-modal__row-main">
                    <code className="vote-modal__row-address">{m.address}</code>
                    {m.label ? (
                      <span className="vote-modal__row-label">{m.label}</span>
                    ) : null}
                    {badge ? (
                      <span
                        className="vote-modal__row-receipt"
                        data-testid="vote-modal-row-receipt"
                      >
                        {badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="vote-modal__row-status">
                    {m.masternodeStatus || ''}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="vote-modal__actions">
          <button
            type="button"
            className="button button--primary button--small"
            onClick={startVoting}
            disabled={!submittable}
            data-testid="vote-modal-submit"
          >
            Sign &amp; submit {effectiveSelected.size} vote
            {effectiveSelected.size === 1 ? '' : 's'}
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </>
    );
  }

  return (
    <div
      className="vote-modal__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Vote on proposal"
      data-testid="vote-modal"
    >
      <div className="vote-modal">
        <header className="vote-modal__header">
          <h2 className="vote-modal__title" data-testid="vote-modal-title">
            {title}
          </h2>
          <button
            type="button"
            className="vote-modal__close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="vote-modal__body">{body}</div>
      </div>
    </div>
  );
}
