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

export default function ProposalVoteModal({
  open,
  onClose,
  proposal,
  governanceService = defaultService,
}) {
  const { isAuthenticated } = useAuth();
  const vault = useVault();
  const {
    owned,
    isLoading,
    isError,
    error,
    refresh,
    isVaultEmpty,
  } = useOwnedMasternodes({
    governanceService,
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

  const effectiveSelected = useMemo(() => {
    if (selected !== null) return selected;
    return new Set(owned.map(mnId));
  }, [selected, owned]);

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
        const base = prev === null ? new Set(owned.map(mnId)) : prev;
        const next = new Set(base);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [owned]
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

  const startVoting = useCallback(async () => {
    if (!proposal || typeof proposal.Key !== 'string') {
      setPhase(PHASE.ERROR);
      setSubmitError('missing_proposal');
      return;
    }
    const chosen = owned.filter((m) => effectiveSelected.has(mnId(m)));
    if (chosen.length === 0) return;

    // Pin the cancellation generation for this run. The cleanup
    // effect on [open, proposal.Key] bumps runGenRef whenever the
    // modal closes or switches proposals. Any post-await checkpoint
    // that sees a mismatch aborts before side-effects (submitVote
    // relay, setPhase/setResults on a stale view) can fire.
    const myGen = runGenRef.current;
    const isCancelled = () => runGenRef.current !== myGen;

    setPhase(PHASE.SIGNING);
    setSignProgress({ done: 0, total: chosen.length });
    setSubmitError(null);
    setResults(null);

    // One timestamp for the whole batch. See file header for
    // rationale.
    const time = Math.floor(Date.now() / 1000);
    const entries = [];
    const signingErrors = [];
    for (let i = 0; i < chosen.length; i++) {
      const mn = chosen[i];
      try {
        // Yield to the event loop every few signatures so the modal
        // can repaint the progress text. 0ms setTimeout is enough —
        // secp256k1.sign is ~1ms so this is a rounding error on
        // overall latency.
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
          // Attached for per-row display only — NOT sent to the
          // backend, which cares about the outpoint and sig only.
          _keyId: mn.keyId,
          _label: mn.label,
          _address: mn.address,
        });
      } catch (err) {
        signingErrors.push({
          keyId: mn.keyId,
          label: mn.label,
          address: mn.address,
          code: (err && err.code) || 'sign_failed',
        });
      }
      if (isCancelled()) return;
      setSignProgress({ done: i + 1, total: chosen.length });
    }

    if (isCancelled()) return;

    if (entries.length === 0) {
      // Nothing to relay — all selected keys failed to sign. Show
      // errors as the final state.
      setPhase(PHASE.DONE);
      setResults({
        accepted: 0,
        rejected: signingErrors.length,
        byEntry: signingErrors.map((e) => ({
          keyId: e.keyId,
          label: e.label,
          address: e.address,
          ok: false,
          error: e.code,
        })),
      });
      return;
    }

    setPhase(PHASE.SUBMITTING);
    try {
      // Strip client-only metadata before sending.
      const payload = entries.map(({ collateralHash, collateralIndex, voteSig }) => ({
        collateralHash,
        collateralIndex,
        voteSig,
      }));
      // Last cancellation check before the network hit. If the user
      // closed the modal during signing, we must NOT relay votes
      // they intended to cancel — Core treats vote replay as a rate-
      // limit hit (vote_too_often) and the user sees confusing
      // side-effects on other devices.
      if (isCancelled()) return;
      const resp = await governanceService.submitVote({
        proposalHash: proposal.Key,
        voteOutcome: outcome,
        voteSignal: 'funding',
        time,
        entries: payload,
      });
      if (isCancelled()) return;
      // Join the backend per-entry results back to our vault rows
      // so the UI can show a friendly label / address per outcome.
      // The backend keys each result row on (collateralHash, index);
      // we match on the same tuple.
      const byOutpoint = new Map();
      for (const e of entries) {
        byOutpoint.set(
          `${e.collateralHash}:${e.collateralIndex}`,
          e
        );
      }
      const byEntry = (Array.isArray(resp.results) ? resp.results : []).map(
        (r) => {
          const k = byOutpoint.get(`${r.collateralHash}:${r.collateralIndex}`);
          return {
            keyId: k ? k._keyId : null,
            label: k ? k._label : '',
            address: k ? k._address : '',
            ok: !!r.ok,
            error: r.error || null,
          };
        }
      );
      // Append per-row signing failures so the user sees every
      // selected MN in the result list, not just the relayed ones.
      for (const e of signingErrors) {
        byEntry.push({
          keyId: e.keyId,
          label: e.label,
          address: e.address,
          ok: false,
          error: e.code,
        });
      }
      setResults({
        accepted: resp.accepted,
        rejected: resp.rejected + signingErrors.length,
        byEntry,
      });
      setPhase(PHASE.DONE);
    } catch (err) {
      if (isCancelled()) return;
      setSubmitError((err && err.code) || 'submit_failed');
      setPhase(PHASE.ERROR);
    }
  }, [proposal, owned, effectiveSelected, outcome, governanceService]);

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
            >
              <code>{r.address}</code>
              <span className="vote-result__label">{r.label || ''}</span>
              <span className="vote-result__status">
                {r.ok ? `${outcomeLabel(outcome)} accepted` : errorCopy(r.error)}
              </span>
            </li>
          ))}
        </ul>
        <div className="vote-modal__actions">
          <button
            type="button"
            className="button button--primary button--small"
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

        <ul className="vote-modal__list" data-testid="vote-modal-list">
          {owned.map((m) => {
            const id = mnId(m);
            return (
              <li
                key={id}
                className="vote-modal__row"
                data-testid="vote-modal-row"
                data-mn-id={id}
                data-key-id={m.keyId}
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
