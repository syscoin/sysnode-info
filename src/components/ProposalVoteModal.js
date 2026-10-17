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
import { isUnknownVote, reconciledVoteStatus } from '../lib/voteSubmissionStatus';
import {
  describeError,
  isBenignDup,
  SEVERITY,
} from '../lib/governanceErrors';
import {
  computeSupportShift,
  describeSupportShift,
} from '../lib/governanceSupportShift';
import {
  drain as drainOfflineVote,
  peek as peekOfflineVote,
} from '../lib/voteOfflineQueue';

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
// Lock, logout, identity/key changes and navigation invalidate all async work.
// A failed transport may follow a successful Core relay. Retain only public
// submission data for status checks; never re-sign automatically after failure.

const PHASE = Object.freeze({
  PICK: 'pick',
  // Intermediate confirmation step shown only when the user's Sign &
  // Submit selection includes at least one masternode whose confirmed
  // receipt has a DIFFERENT outcome than the one they've chosen —
  // i.e. the submission will overwrite an existing on-chain vote.
  // Guard-railing this behind an explicit confirm avoids a whole
  // class of "I flipped the radio button and lost my old vote"
  // support tickets.
  CONFIRM_CHANGE: 'confirm-change',
  SIGNING: 'signing',
  SUBMITTING: 'submitting',
  DONE: 'done',
  ERROR: 'error',
});

// Short, human-readable label for a per-row status shown in the
// live progress view (SIGNING / SUBMITTING phases). These are
// intentionally terse so that the live view can render many rows
// without wrapping; the DONE view takes over with longer-form
// copy once every row's fate is known.
function progressLabel(status) {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'signing':
      return 'Signing…';
    case 'signed':
      return 'Signed';
    case 'sign-failed':
      return 'Signing failed';
    case 'submitting':
      return 'Submitting…';
    default:
      return '';
  }
}

// Classify an owned-masternode row against the currently-selected
// outcome. Used by the picker to group rows into sections and by
// startVoting to detect vote-change intents.
//
// Kinds (string constants — not exported, consumed only within this
// file):
//
//   'unseen'              — no receipt on file for this MN.
//   'failed'              — last relay attempt errored; user should
//                           retry. Groups with "Action needed".
//   'stale'               — was on chain once but has since dropped
//                           out of the tally window; user should
//                           re-submit. Groups with "Needs vote".
//   'relayed'             — submitted to the backend, not yet
//                           reconciled against the chain. Groups
//                           with "Needs vote" so the user can
//                           continue to vote with it if they're
//                           impatient for confirmation; short
//                           circuiting on the server side makes
//                           re-submission safe.
//   'confirmed-match'     — confirmed on chain at the current
//                           outcome. Groups with "Already voted"
//                           and is unchecked by default.
//   'confirmed-different' — confirmed on chain at a DIFFERENT
//                           outcome than the user has selected; a
//                           submission from here is a vote change.
//                           Groups with "Action needed" so it's
//                           visible and guarded by CONFIRM_CHANGE.
function classifyOwned(m, currentOutcome) {
  const r = m && m.receipt;
  if (!r) return 'unseen';
  if (r.status === 'submission_unknown') return 'unknown';
  if (r.status === 'failed') return 'failed';
  if (r.status === 'stale') return 'stale';
  if (r.status === 'relayed') return 'relayed';
  if (r.status === 'confirmed') {
    return r.voteOutcome === currentOutcome
      ? 'confirmed-match'
      : 'confirmed-different';
  }
  return 'unseen';
}

// Group the owned list into the three picker sections. Order within
// each section is preserved from `owned` so alphabetical / label
// ordering from the vault carries through.
function groupOwnedForPicker(owned, currentOutcome) {
  const actionNeeded = [];
  const needsVote = [];
  const alreadyVoted = [];
  for (const m of owned) {
    const kind = classifyOwned(m, currentOutcome);
    if (kind === 'failed' || kind === 'confirmed-different') {
      actionNeeded.push({ m, kind });
    } else if (kind === 'confirmed-match') {
      alreadyVoted.push({ m, kind });
    } else {
      needsVote.push({ m, kind });
    }
  }
  return { actionNeeded, needsVote, alreadyVoted };
}

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
// Normalize to lowercase so the key is stable across backend
// endpoints that historically disagreed on hash casing (`/gov/vote`
// and `/gov/mns/lookup` both accept mixed-case hashes and are
// consistent at the moment, but receipts / future producers may
// return upper-case hex). Anything that builds outpoint keys from
// arbitrary producers MUST go through this helper or `outpointKey`
// below so that Set lookups never miss on a case mismatch.
function mnId(m) {
  const h = typeof m.collateralHash === 'string'
    ? m.collateralHash.toLowerCase()
    : m.collateralHash;
  return `${h}:${m.collateralIndex}`;
}

function outpointKey(collateralHash, collateralIndex) {
  return mnId({ collateralHash, collateralIndex });
}

// Short-form error label for per-row rendering. Thin wrapper over
// `describeError` so the cell-level copy stays terse while the
// descriptor drives colour / CTA. Retained as a function (rather than
// inlining `describeError(code).short`) so future cell-specific
// overrides — "vote too often (auto-retry in 42s)" etc — have a
// single place to grow into.
function rowErrorCopy(code) {
  return describeError(code).short;
}

// Default retry-after for rate-limited errors when the transport
// didn't surface an explicit `retryAfterMs`. Matches the backend's
// current voteLimiter window-aware behaviour reasonably well without
// pretending to be authoritative — the server's Retry-After header
// always takes precedence.
const DEFAULT_RATE_LIMIT_RETRY_MS = 60 * 1000;

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
  if (receipt.status === 'submission_unknown') return 'Check submission status';
  return null;
}

export default function ProposalVoteModal({
  open,
  onClose,
  proposal,
  governanceService = defaultService,
  // Optional callback to refetch the governance feed — wired by
  // the Governance page so the `proposal_not_found` descriptor's
  // "Reload proposals" CTA repulls the feed instead of refreshing
  // only the per-user MN lookup (which does nothing for a stale
  // proposal list and would leave the user stuck in the error
  // state). When omitted the CTA falls back to the owned-MN
  // refresh so the button is never dead.
  onReloadProposals,
}) {
  const { isAuthenticated, user } = useAuth();
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
    // POST /gov/receipts/reconcile and join per-MN receipt rows
    // onto `owned`. When the modal is closed we pass null so no
    // receipts request fires — same rationale as `enabled` above.
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
  // Progressive disclosure for the "Already voted" section. Starts
  // collapsed so the picker reads as a compact "what still needs
  // attention" view. Expanding is cheap (all data already in
  // memory), so the UX cost of hiding it by default is zero.
  const [showAlreadyVoted, setShowAlreadyVoted] = useState(false);
  // Frozen snapshot of the MNs participating in the current run —
  // the live SIGNING / SUBMITTING progress view reads this to
  // render per-row status. Freezing avoids the live view flickering
  // if `owned` changes mid-run (e.g. a reconcile fetch lands),
  // which would otherwise reorder rows under the user's eye.
  const [chosenForRun, setChosenForRun] = useState([]);
  // Per-row signing failures captured during the loop. Keyed by
  // outpoint so the live view can cross-reference against
  // chosenForRun without caring about order. Cleared on every new
  // run by runVotePass.
  const [signFailures, setSignFailures] = useState(() => new Map());
  // Stashed chosen list for the CONFIRM_CHANGE phase. A ref because
  // the confirm button only needs the value at click-time, and we'd
  // rather not trigger a re-render when stashing.
  const pendingChosenRef = useRef(null);
  const submittedRef = useRef(null); // Public payload only; never vault WIFs.
  const submittedBaseRef = useRef([]);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [statusChecked, setStatusChecked] = useState(false);
  const [reviewingNewVote, setReviewingNewVote] = useState(false);

  // Countdown timestamp (Date.now()) at which a rate-limited batch
  // becomes retryable. Null when no countdown is active. Driven by
  // `retryAfterMs` propagated from the apiClient / governance
  // service on 429s; falls back to DEFAULT_RATE_LIMIT_RETRY_MS when
  // the server didn't supply a header.
  const [retryReadyAt, setRetryReadyAt] = useState(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // When navigator is offline and a network_error happens, we
  // stash the vote intent in sessionStorage via voteOfflineQueue
  // and surface a "queued while offline" state. Tracked here so
  // the render path can switch on it independently of submitError
  // (submitError stays `network_error` for the underlying cause).
  const [offlineQueued, setOfflineQueued] = useState(false);

  // Cross-session snapshot of the queued offline intent. Populated
  // by the peek-on-open effect when a sessionStorage entry survives
  // from a prior modal session (close/reopen or full page reload).
  // Null in the in-session flow — there the live `chosenForRun`
  // state is still populated and Resume/rerun can go straight
  // through `rerunLastBatch`. Stored in a ref because its only
  // readers are event handlers (Resume / Discard click paths),
  // and we don't want writes to trigger re-renders.
  const queuedSnapshotRef = useRef(null);

  // Cancellation generation. Every voting run captures the current
  // value; after every async boundary (sign loop yield, submitVote
  // await) we compare it to the live counter and bail if it's moved.
  // The counter advances whenever the modal closes, unmounts, or
  // switches to a different proposal — so a user closing mid-flight
  // cannot cause a late submitVote() relay, and late state updates
  // from the previous run cannot race with a newly-opened modal.
  const runGenRef = useRef(0);
  const proposalKey = proposal && proposal.Key;
  const currentVaultData = useRef(vault.data);
  const vaultRevision = useRef(0);
  if (currentVaultData.current !== vault.data) {
    currentVaultData.current = vault.data;
    vaultRevision.current += 1;
  }
  const dataRevision = vaultRevision.current;
  // Every asynchronous continuation reads the current custody context, not
  // the unlocked/key snapshot captured before a lock or identity switch.
  const votingScope = useMemo(() => ({
    eligible: open && isAuthenticated && user?.id != null && vault.isUnlocked,
    userId: user?.id,
    userSalt: user?.saltV,
    dataRevision,
    service: governanceService,
    proposalKey,
  }), [open, isAuthenticated, user?.id, user?.saltV, vault.isUnlocked, dataRevision, governanceService, proposalKey]);
  const votingScopeRef = useRef(votingScope);
  votingScopeRef.current = votingScope;
  useEffect(() => {
    return () => {
      // Backstop for every custody-context change and unmount. The render-
      // updated ref also rejects stale work before this effect cleanup runs.
      runGenRef.current += 1;
    };
  }, [votingScope]);

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
        if (!alreadyVotedSameOutcome && (reviewingNewVote || m.receipt?.status !== 'submission_unknown')) set.add(mnId(m));
      }
      return set;
    },
    [reviewingNewVote]
  );

  const effectiveSelected = useMemo(() => {
    if (selected !== null) {
      const allowed = new Set(owned.filter((m) => reviewingNewVote || m.receipt?.status !== 'submission_unknown').map(mnId));
      return new Set([...selected].filter((id) => allowed.has(id)));
    }
    return computeDefault(owned, outcome);
  }, [selected, owned, outcome, computeDefault, reviewingNewVote]);

  // Pre-submit preview of how the current selection would move the
  // proposal's net on-chain support. Drives an informational banner
  // in the picker so a vote change never happens silently — e.g. a
  // user who previously voted yes on 3 MNs and now has "no"
  // selected for all 3 sees "Net support −6 · 3 prior confirmed
  // votes will change" before clicking Sign & submit.
  const supportShift = useMemo(() => {
    if (effectiveSelected.size === 0) return null;
    const entries = owned
      .filter((m) => effectiveSelected.has(mnId(m)))
      .map((m) => ({
        currentOutcome: outcome,
        previousOutcome: m.receipt ? m.receipt.voteOutcome : null,
        previousStatus: m.receipt ? m.receipt.status : '',
      }));
    const shift = computeSupportShift(entries);
    return describeSupportShift(shift, entries.length);
  }, [owned, effectiveSelected, outcome]);

  // Never carry a prior account's selection or private-key work across scope.
  useEffect(() => {
    setSelected(null);
    setOutcome('yes');
    setPhase(PHASE.PICK);
    setSignProgress({ done: 0, total: 0 });
    setSubmitError(null);
    setResults(null);
    setShowAlreadyVoted(false);
    setChosenForRun([]);
    setSignFailures(new Map());
    setRetryReadyAt(null);
    setOfflineQueued(false);
    pendingChosenRef.current = null;
    submittedRef.current = null;
    submittedBaseRef.current = [];
    setCheckingStatus(false);
    setStatusChecked(false);
    setReviewingNewVote(false);
    queuedSnapshotRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [votingScope]);

  // A definite pre-submission rate limit can show a passive countdown.
  useEffect(() => {
    const armed = open && retryReadyAt != null;
    if (!armed) return undefined;
    const id = setInterval(() => setNowTick(Date.now()), 250);
    return () => clearInterval(id);
  }, [open, retryReadyAt]);

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
    setSelected(new Set(owned.filter((m) => reviewingNewVote || m.receipt?.status !== 'submission_unknown').map(mnId)));
  }, [owned, reviewingNewVote]);

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
      const custodyScope = votingScopeRef.current;
      if (!custodyScope.eligible) return;
      if (!proposal || typeof proposal.Key !== 'string') {
        setPhase(PHASE.ERROR);
        setSubmitError('missing_proposal');
        return;
      }
      if (!Array.isArray(chosen) || chosen.length === 0) return;
      if (!reviewingNewVote && chosen.some((m) => m.receipt?.status === 'submission_unknown')) return;

      // Pin the cancellation generation for this run. The cleanup
      // effect on [open, proposal.Key] bumps runGenRef whenever the
      // modal closes or switches proposals. Any post-await
      // checkpoint that sees a mismatch aborts before side-effects
      // (submitVote relay, setPhase/setResults on a stale view) can
      // fire.
      const myGen = runGenRef.current;
      const isCancelled = () => runGenRef.current !== myGen ||
        votingScopeRef.current !== custodyScope || !votingScopeRef.current.eligible;

      setPhase(PHASE.SIGNING);
      setSignProgress({ done: 0, total: chosen.length });
      setSubmitError(null);
      setResults(null);
      // Seed the live-progress view for this run. We only set the
      // chosen-for-run state when the run is the "primary" one (no
      // mergeBase) or when the caller explicitly passes a retry
      // list — either way it's what the user expects to see while
      // signing. Clear sign-failures at the same time so a prior
      // run's error markers don't bleed into the new view.
      setChosenForRun(chosen.map(({ wif: _secret, ...row }) => row));
      setSignFailures(new Map());

      const priorAccepted = Array.isArray(mergeBase)
        ? mergeBase.filter((e) => e.ok).length
        : 0;
      // mergeBase may carry forward *failed* rows the caller opted
      // to preserve (e.g. Retry failed can't re-sign a row whose
      // masternode dropped off the owned list — it remains as an
      // unresolved failure so the user still sees and counts it).
      // Fold them into the rejected tally so the DONE summary
      // reflects reality rather than hiding the unresolved work.
      const priorRejected = Array.isArray(mergeBase)
        ? mergeBase.filter((e) => !e.ok).length
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
          if (isCancelled()) return;
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
          const code = (err && err.code) || 'sign_failed';
          signingErrors.push({
            keyId: mn.keyId,
            label: mn.label,
            address: mn.address,
            collateralHash: mn.collateralHash,
            collateralIndex: mn.collateralIndex,
            code,
          });
          // Surface the failure on the live-progress view
          // immediately rather than waiting for the whole loop to
          // finish. Using a functional setter so we don't race
          // with any other state update that might happen between
          // the setSignProgress call below and this one.
          const failedKey = outpointKey(
            mn.collateralHash,
            mn.collateralIndex
          );
          setSignFailures((prev) => {
            const m = new Map(prev);
            m.set(failedKey, code);
            return m;
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
          rejected: signingErrors.length + priorRejected,
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
        const submission = {
          proposalHash: proposal.Key,
          voteOutcome: outcome,
          voteSignal: 'funding',
          time,
          entries: payload,
        };
        submittedRef.current = submission;
        submittedBaseRef.current = baseEntries;
        const resp = await governanceService.submitVote(submission);
        if (isCancelled()) return;
        const byOutpoint = new Map();
        for (const e of entries) {
          byOutpoint.set(outpointKey(e.collateralHash, e.collateralIndex), e);
        }
        const byEntry = (Array.isArray(resp.results) ? resp.results : []).map(
          (r) => {
            const k = byOutpoint.get(
              outpointKey(r.collateralHash, r.collateralIndex)
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
              uncertain: isUnknownVote(r),
              notSubmitted: r.notSubmitted === true,
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
          rejected:
            (resp.rejected || 0) + signingErrors.length + priorRejected,
          byEntry: [...baseEntries, ...byEntry],
        });
        setPhase(PHASE.DONE);
      } catch (err) {
        if (isCancelled()) return;
        const code = err?.uncertain === true || (!err?.notSubmitted &&
          ['network_error', 'server_error', 'submit_failed'].includes(err?.code || 'submit_failed'))
          ? 'submission_unknown' : (err && err.code) || 'submit_failed';
        setSubmitError(code);
        // Rate-limit countdown: prefer the server's explicit
        // Retry-After (propagated via apiClient → govError). Fall
        // back to a one-minute floor so the UI always has a
        // countdown to show rather than an open-ended "wait".
        if (code === 'rate_limited') {
          const hint =
            err && Number.isFinite(err.retryAfterMs)
              ? err.retryAfterMs
              : DEFAULT_RATE_LIMIT_RETRY_MS;
          setRetryReadyAt(Date.now() + Math.max(hint, 0));
        } else {
          setRetryReadyAt(null);
        }
        // Once the request began, going offline does not establish that no
        // vote reached Core. Keep its public payload for explicit status checks.
        setOfflineQueued(false);
        setPhase(PHASE.ERROR);
      }
    },
    [proposal, outcome, governanceService, reviewingNewVote]
  );

  // Explicit retry of a definite pre-submission failure uses current keys.
  const rerunLastBatch = useCallback(() => {
    if (!Array.isArray(chosenForRun) || chosenForRun.length === 0) {
      setPhase(PHASE.PICK);
      setSubmitError(null);
      setRetryReadyAt(null);
      return undefined;
    }
    setSubmitError(null);
    setRetryReadyAt(null);
    const ids = new Set(chosenForRun.map(mnId));
    return runVotePass(owned.filter((row) => ids.has(mnId(row))));
  }, [chosenForRun, owned, runVotePass]);

  // Old saved intents are readable only for explicit discard, never replayed.
  useEffect(() => {
    if (!open || !proposal || typeof proposal.Key !== 'string') return;
    const queued = peekOfflineVote(proposal.Key);
    if (!queued) return;
    queuedSnapshotRef.current = queued;
    setOfflineQueued(true);
    // Restore the outcome the user chose before going offline so
    // the picker / confirmation copy stays consistent if they back
    // out to PICK; resume uses the same value out of the queue.
    if (queued.voteOutcome === 'yes' || queued.voteOutcome === 'no' ||
        queued.voteOutcome === 'abstain') {
      setOutcome(queued.voteOutcome);
    }
    setSubmitError('network_error');
    setPhase(PHASE.ERROR);
  }, [open, proposal]);

  const discardOfflineQueue = useCallback(() => {
    if (!proposal || typeof proposal.Key !== 'string') return;
    drainOfflineVote(proposal.Key);
    queuedSnapshotRef.current = null;
    setOfflineQueued(false);
    // Discard abandons the old intent without signing or relaying it.
    setPhase(PHASE.PICK);
    setSubmitError(null);
    setRetryReadyAt(null);
  }, [proposal]);

  // Grouping for the picker render. Memoised so the sections don't
  // recompute on unrelated state transitions (selection changes,
  // outcome flips are the only relevant triggers).
  const groups = useMemo(
    () => groupOwnedForPicker(owned, outcome),
    [owned, outcome]
  );

  const startVoting = useCallback(() => {
    const chosen = owned.filter((m) => effectiveSelected.has(mnId(m)));
    if (chosen.length === 0) return;
    // Detect vote-changes: chosen rows whose confirmed receipt has a
    // different outcome than the user is about to submit. If any
    // exist, gate the run behind an explicit confirmation — we don't
    // want a misplaced radio click to silently overwrite an existing
    // on-chain vote on dozens of MNs.
    const voteChanges = chosen.filter(
      (m) => classifyOwned(m, outcome) === 'confirmed-different'
    );
    if (voteChanges.length > 0) {
      pendingChosenRef.current = chosen.map(({ wif: _secret, ...row }) => row);
      setPhase(PHASE.CONFIRM_CHANGE);
      return;
    }
    return runVotePass(chosen);
  }, [owned, effectiveSelected, outcome, runVotePass]);

  const confirmVoteChange = useCallback(() => {
    const chosen = pendingChosenRef.current;
    pendingChosenRef.current = null;
    if (!Array.isArray(chosen) || chosen.length === 0) {
      setPhase(PHASE.PICK);
      return;
    }
    const ids = new Set(chosen.map(mnId));
    return runVotePass(owned.filter((row) => ids.has(mnId(row))));
  }, [owned, runVotePass]);

  const cancelVoteChange = useCallback(() => {
    pendingChosenRef.current = null;
    setPhase(PHASE.PICK);
  }, []);

  // Retry only the failed rows from the current DONE view.
  //
  // Intentionally keeps the same outcome: changing outcome is a
  // destructive operation (different signatures, different relay
  // intent) and belongs in the picker, not a retry button. A user
  // who wants to change their vote should close the modal and
  // re-open it, or clear the selection and start over.
  //
  // mergeBase composition:
  //   * Every prior SUCCESS is carried forward verbatim (we don't
  //     want the successful rows to vanish on retry).
  //   * Prior FAILURES whose MN is still in `owned` are being
  //     retried — they DROP from mergeBase so the new attempt's
  //     row replaces the old one instead of duplicating it.
  //   * Prior FAILURES whose MN is no longer in `owned` (or whose
  //     row is missing collateral info we can't map back) are
  //     *also* carried forward. These are "unretryable" — the
  //     user still deserves to see and count the unresolved
  //     failure in the DONE summary, otherwise the rejected count
  //     silently under-reports after retry.
  const retryFailed = useCallback(() => {
    if (!results || !Array.isArray(results.byEntry)) return;
    // Outpoints of failed rows whose MN is still retryable (present
    // in the current `owned` list). These are the ones we'll
    // re-sign; everything else is preserved verbatim.
    const ownedIds = new Set(owned.map(mnId));
    // Benign dedup rows (already_voted) must be excluded from the
    // retry set — they are logical successes that the backend has
    // already observed on-chain. Re-submitting them would just
    // produce another dedup (or, with a cooldown still active,
    // trigger vote_too_often and surface a confusing "error" for a
    // state the user has already achieved). Keep the same guard in
    // lockstep with the `hasFailures` / `retryable` checks used to
    // show the Retry failed button in the DONE view.
    const retriedKeys = new Set(
      results.byEntry
        .filter(
          (e) =>
            !e.ok &&
            !isUnknownVote(e) &&
            !e.superseded &&
            !isBenignDup(e.error) &&
            e.collateralHash &&
            e.collateralIndex != null &&
            ownedIds.has(outpointKey(e.collateralHash, e.collateralIndex))
        )
        .map((e) => outpointKey(e.collateralHash, e.collateralIndex))
    );
    if (retriedKeys.size === 0) return;
    const chosen = owned.filter((m) => retriedKeys.has(mnId(m)));
    const mergeBase = results.byEntry.filter((e) => {
      if (e.ok) return true;
      // Failures carried forward: (a) rows missing outpoint info
      // we can't map, (b) rows whose MN is no longer retryable.
      // In both cases dropping them would silently under-report
      // the rejected count after retry.
      if (!(e.collateralHash && e.collateralIndex != null)) return true;
      return !retriedKeys.has(outpointKey(e.collateralHash, e.collateralIndex));
    });
    return runVotePass(chosen, { mergeBase });
  }, [owned, results, runVotePass]);

  const checkSubmissionStatus = async () => {
    const batch = submittedRef.current;
    const scope = votingScopeRef.current;
    if (!scope.eligible || !batch || checkingStatus) return;
    const generation = runGenRef.current;
    const current = () => scope === votingScopeRef.current && scope.eligible &&
      generation === runGenRef.current;
    setCheckingStatus(true);
    try {
      const status = await governanceService.reconcileReceipts(batch.proposalHash, { refresh: true });
      if (!current()) return;
      setStatusChecked(true);
      const prior = new Map([...submittedBaseRef.current, ...(results?.byEntry || [])].map((row) => [outpointKey(row.collateralHash, row.collateralIndex), row]));
      for (const entry of batch.entries) {
        const key = outpointKey(entry.collateralHash, entry.collateralIndex);
        prior.set(key, reconciledVoteStatus(prior.get(key) || { ...entry, ok: false, uncertain: true }, batch, status));
      }
      const byEntry = Array.from(prior.values());
      setResults({ byEntry, accepted: byEntry.filter((entry) => entry.ok).length,
        rejected: byEntry.filter((entry) => !entry.ok).length });
      setSubmitError(null);
      setPhase(PHASE.DONE);
    } catch (_) {
      if (current()) setSubmitError('submission_unknown');
    } finally { if (current()) setCheckingStatus(false); }
  };

  const reviewNewVote = () => {
    if (!votingScopeRef.current.eligible || !statusChecked) return;
    submittedRef.current = null;
    submittedBaseRef.current = [];
    setChosenForRun([]);
    pendingChosenRef.current = null;
    setSelected(null);
    setResults(null);
    setSubmitError(null);
    setReviewingNewVote(true);
    setPhase(PHASE.PICK);
  };

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
          sentry node voting keys.
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
        <p>Looking up your sentry nodes...</p>
      </div>
    );
  } else if (
    isError &&
    !(phase === PHASE.ERROR && offlineQueued)
  ) {
    // Same preemption story as `owned.length === 0`: the lookup
    // error body has no path to drain a queued offline intent,
    // so a user whose /gov/mns/lookup fails after reopening the
    // modal would be stuck with the stale entry re-surfacing on
    // every reopen. Yield to the ERROR branch whenever
    // offlineQueued is set so Resume/Discard stay reachable;
    // the ERROR body tolerates an empty `owned` list.
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-lookup-error">
        <p>Couldn't load your sentry node list ({error || 'error'}).</p>
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
          Your vault is empty. Import your sentry node voting keys on the
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
  } else if (
    owned.length === 0 &&
    !(phase === PHASE.ERROR && offlineQueued)
  ) {
    // "No owned masternodes" is a guard state — but it must NOT
    // preempt the queued-offline recovery UI. If a prior session
    // persisted a vote intent in sessionStorage and the vault
    // currently resolves to zero owned MNs (e.g., lookup came
    // back empty, or the MNs referenced by the queued entry have
    // since rotated off the list), the user still needs a path
    // to Discard the stale queue — otherwise the entry sits in
    // sessionStorage forever, re-surfacing on every reopen. The
    // ERROR branch below handles both Resume (which falls back
    // to PICK when chosen.length === 0) and Discard, so let that
    // branch take precedence whenever offlineQueued is true.
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-no-owned">
        <p>
          None of the voting keys in your vault match a live sentry node
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
    // Prior-vote errors do not establish this requested outcome. Keep them
    // out of automatic retries and offer an explicit status check.
    const ownedIds = new Set(owned.map(mnId));
    let failedCount = 0;
    let retryableCount = 0;
    let dedupCount = 0;
    for (const r of results.byEntry) {
      if (r.ok) continue;
      if (r.superseded) continue;
      if (isUnknownVote(r)) continue;
      if (isBenignDup(r.error)) {
        dedupCount += 1;
        continue;
      }
      failedCount += 1;
      if (
        !isUnknownVote(r) &&
        !r.superseded &&
        r.collateralHash &&
        r.collateralIndex != null &&
        ownedIds.has(outpointKey(r.collateralHash, r.collateralIndex))
      ) {
        retryableCount += 1;
      }
    }
    const hasFailures = failedCount > 0;
    const retryable = retryableCount > 0;
    const unknownCount = results.byEntry.filter(isUnknownVote).length;
    const supersededCount = results.byEntry.filter((row) => row.superseded).length;
    const notSubmittedCount = results.byEntry.filter((row) => row.notSubmitted).length;
    const hasUnknown = unknownCount > 0;
    const unretryableCount = failedCount - retryableCount;
    const retryButtonLabel =
      unretryableCount > 0
        ? `Retry ${retryableCount} of ${failedCount} failed`
        : `Retry ${retryableCount} failed`;
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-done">
        {(hasUnknown || dedupCount > 0) && <div role="status"><p>Some vote submissions need checking. Check status before retrying; no votes will be automatically resubmitted.</p>
          <button type="button" className="button button--primary button--small" disabled={checkingStatus} onClick={checkSubmissionStatus}>Check status</button>
          {statusChecked && <button type="button" className="button button--ghost button--small" onClick={reviewNewVote}>Review a new vote</button>}</div>}
        <p data-testid="vote-modal-summary">
          <strong>{results.accepted}</strong> accepted,{' '}
          <strong>{results.byEntry.filter((row) => !row.ok && !isUnknownVote(row) && !row.notSubmitted && !row.superseded).length}</strong> rejected.
          {unknownCount > 0 && <> <strong>{unknownCount}</strong> uncertain.</>}
          {notSubmittedCount > 0 && <> <strong>{notSubmittedCount}</strong> not submitted.</>}
          {supersededCount > 0 && <> <strong>{supersededCount}</strong> superseded by on-chain votes.</>}
        </p>
        {results.byEntry.some((row) => row.superseded) && statusChecked && <button type="button" className="button button--ghost button--small" onClick={reviewNewVote}>Review a new vote</button>}
        {dedupCount > 0 ? (
          <p
            className="vote-modal__hint"
            data-testid="vote-modal-dedup-note"
          >
            {dedupCount} rejected {dedupCount === 1 ? 'row reports' : 'rows report'}{' '}
            a prior vote. This does not confirm the newly requested outcome; check the current vote before trying again.
          </p>
        ) : null}
        <ul className="vote-result-list">
          {results.byEntry.map((r, idx) => {
            // A prior vote may have a different outcome; never show success.
            const benign = !r.ok && isBenignDup(r.error);
            const rowDescriptor =
              !r.ok && !benign ? describeError(r.error) : null;
            let statusText;
            if (r.ok) {
              statusText = successCopy({ outcome, skipped: r.skipped });
            } else if (benign) {
              statusText = 'Prior vote exists; requested outcome not confirmed';
            } else {
              statusText = rowErrorCopy(r.error);
            }
            const rowClass = r.ok
              ? 'vote-result is-ok'
              : benign
              ? 'vote-result is-warn vote-result--dedup'
              : rowDescriptor && rowDescriptor.severity === SEVERITY.WARN
              ? 'vote-result is-warn'
              : 'vote-result is-error';
            // Per-row CTA — same semantics as the PHASE.ERROR
            // CTA but rendered inline at the end of the row.
            // Only `link`-kind CTAs make sense here (no "reload"
            // button per row).
            let rowCta = null;
            if (
              rowDescriptor &&
              rowDescriptor.cta &&
              rowDescriptor.cta.kind === 'link' &&
              rowDescriptor.cta.href
            ) {
              rowCta = (
                <Link
                  to={rowDescriptor.cta.href}
                  className="vote-result__cta"
                  data-testid="vote-result-row-cta"
                >
                  {rowDescriptor.cta.label}
                </Link>
              );
            }
            return (
              <li
                key={`${r.keyId || 'err'}-${idx}`}
                className={rowClass}
                data-testid="vote-result-row"
                data-ok={r.ok ? 'true' : 'false'}
                data-skipped={r.skipped || ''}
                data-benign-dup={benign ? 'true' : 'false'}
                data-error-code={!r.ok ? r.error || '' : ''}
              >
                <code>{r.address}</code>
                <span className="vote-result__label">{r.label || ''}</span>
                <span className="vote-result__status">{statusText}</span>
                {rowCta}
              </li>
            );
          })}
        </ul>
        {hasFailures && unretryableCount > 0 ? (
          <p
            className="vote-modal__hint vote-modal__hint--warn"
            data-testid="vote-modal-unretryable-note"
          >
            {unretryableCount === failedCount ? (
              <>
                Retry isn't available for these {unretryableCount}{' '}
                {unretryableCount === 1 ? 'failure' : 'failures'} — the
                affected sentry nodes are no longer in your owned list
                (deregistered, transferred, or missing collateral
                metadata). Resolve from the Account page and vote
                again from the proposal row.
              </>
            ) : (
              <>
                {unretryableCount} of {failedCount}{' '}
                {unretryableCount === 1 ? 'failure is' : 'failures are'}{' '}
                not retryable here — those sentry nodes are no longer in
                your owned list, so they'll stay in the "not voted"
                column until you fix ownership and run the vote again.
              </>
            )}
          </p>
        ) : null}
        <div className="vote-modal__actions">
          {hasFailures && retryable ? (
            <button
              type="button"
              className="button button--primary button--small"
              onClick={retryFailed}
              data-testid="vote-modal-retry-failed"
              data-retryable-count={retryableCount}
              data-failed-count={failedCount}
            >
              {retryButtonLabel}
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
    const descriptor = describeError(submitError);
    // Rate-limit countdown. Only show while the remaining time is
    // actually positive; zero- or negative-remaining means the
    // window elapsed and the button should simply be enabled.
    const rateLimitRemainingMs =
      descriptor.respectsRetryAfter && retryReadyAt != null
        ? Math.max(0, retryReadyAt - nowTick)
        : 0;
    const showRateLimitCountdown =
      descriptor.respectsRetryAfter &&
      retryReadyAt != null &&
      rateLimitRemainingMs > 0;
    const rateLimitRemainingSec = Math.ceil(rateLimitRemainingMs / 1000);
    // Try-again button enable/disable.
    const canRerun =
      Array.isArray(chosenForRun) && chosenForRun.length > 0;
    const tryAgainDisabled = showRateLimitCountdown;
    // CTA rendering. `link`-kind CTAs navigate the user somewhere
    // to self-serve the fix (Account page for key/MN issues);
    // `refresh`-kind CTAs reload data in-place (proposal list).
    let ctaEl = null;
    if (descriptor.cta) {
      if (descriptor.cta.kind === 'link' && descriptor.cta.href) {
        ctaEl = (
          <Link
            className="button button--ghost button--small"
            to={descriptor.cta.href}
            data-testid="vote-modal-error-cta-link"
          >
            {descriptor.cta.label}
          </Link>
        );
      } else if (descriptor.cta.kind === 'refresh') {
        // Prefer the governance-feed refresher (reloads the
        // proposal list) when the parent supplied one — this is
        // the only refresher that actually resolves
        // `proposal_not_found`. Fall back to the MN-lookup
        // refresh (the original behaviour) so the CTA stays
        // functional for any future descriptor that reuses the
        // `refresh` kind for an MN-scoped recovery.
        const onClickRefresh =
          typeof onReloadProposals === 'function'
            ? onReloadProposals
            : refresh;
        ctaEl = (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onClickRefresh}
            data-testid="vote-modal-error-cta-refresh"
          >
            {descriptor.cta.label}
          </button>
        );
      }
    }
    // When the user is offline and we stashed the intent, the
    // copy shifts from "network error" to "queued for later".
    // Severity class is derived from the descriptor we actually
    // render (effectiveDescriptor) — not the raw submitError
    // descriptor — so the offline-queued state reads as WARN
    // (its own severity) instead of ERROR (network_error's
    // severity), matching the message shown to the user.
    const headlineCode = offlineQueued ? 'offline' : submitError;
    const effectiveDescriptor = offlineQueued
      ? describeError('offline')
      : descriptor;
    const severityClass =
      effectiveDescriptor.severity === SEVERITY.WARN
        ? 'vote-modal__error--warn'
        : effectiveDescriptor.severity === SEVERITY.INFO
        ? 'vote-modal__error--info'
        : 'vote-modal__error--error';
    body = (
      <div
        className={`vote-modal__state vote-modal__error ${severityClass}`}
        data-testid="vote-modal-error"
        data-error-code={headlineCode || ''}
      >
        <p className="vote-modal__error-short">
          <strong>{effectiveDescriptor.short}</strong>
        </p>
        <p className="vote-modal__error-long">{effectiveDescriptor.long}</p>
        {showRateLimitCountdown ? (
          <p
            className="vote-modal__error-countdown"
            data-testid="vote-modal-rate-limit-countdown"
            aria-live="polite"
          >
            You can try again in{' '}
            <strong>
              {rateLimitRemainingSec}s
            </strong>
            .
          </p>
        ) : null}
        <div className="vote-modal__actions">
          {submitError === 'submission_unknown' ? (
            <button type="button" className="button button--primary button--small" disabled={checkingStatus} onClick={checkSubmissionStatus}>Check status</button>
          ) : offlineQueued ? (
            <>
              <p>A saved request is not proof of submission. Discard it and review current on-chain votes before starting another vote.</p>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={discardOfflineQueue}
                data-testid="vote-modal-offline-discard"
              >
                Discard
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button button--primary button--small"
                onClick={() => {
                  if (canRerun) {
                    // Only definite pre-submission errors reach this retry.
                    rerunLastBatch();
                  } else {
                    setPhase(PHASE.PICK);
                    setSubmitError(null);
                    setRetryReadyAt(null);
                  }
                }}
                disabled={tryAgainDisabled}
                data-testid="vote-modal-error-try-again"
              >
                {showRateLimitCountdown
                  ? `Try again (${rateLimitRemainingSec}s)`
                  : 'Try again'}
              </button>
              {/* Always offer an escape back to the picker — even
                  during a countdown the user should be able to
                  reconsider selection (e.g. "oh, I meant abstain,
                  not yes"). Distinct testid + label so it never
                  competes with the primary retry button. */}
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => {
                  setPhase(PHASE.PICK);
                  setSubmitError(null);
                  setRetryReadyAt(null);
                }}
                data-testid="vote-modal-error-back-to-picker"
              >
                Edit selection
              </button>
              {ctaEl}
            </>
          )}
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
    // Live per-row progress. Each row's status is derived from the
    // frozen run list + signProgress cursor + signFailures map; no
    // extra state is needed because the per-row status is always
    // a pure function of those three signals.
    const rowFor = (mn, i) => {
      const key = outpointKey(mn.collateralHash, mn.collateralIndex);
      let status;
      if (signFailures.has(key)) {
        // Sign failure is sticky: even during submit it stays
        // visible so the user knows which rows silently dropped
        // out of the batch.
        status = 'sign-failed';
      } else if (phase === PHASE.SUBMITTING) {
        status = 'submitting';
      } else if (i < signProgress.done) {
        status = 'signed';
      } else if (i === signProgress.done) {
        status = 'signing';
      } else {
        status = 'queued';
      }
      return { key, status };
    };
    body = (
      <div className="vote-modal__state" data-testid="vote-modal-progress">
        <p className="vote-modal__progress-header">
          {phase === PHASE.SIGNING
            ? `Signing ${signProgress.done}/${signProgress.total}…`
            : 'Submitting signed votes…'}
        </p>
        <ul
          className="vote-modal__progress-list"
          data-testid="vote-modal-progress-list"
        >
          {chosenForRun.map((mn, i) => {
            const { key, status } = rowFor(mn, i);
            return (
              <li
                key={key}
                className={`vote-modal__progress-row vote-modal__progress-row--${status}`}
                data-testid="vote-modal-progress-row"
                data-mn-id={key}
                data-row-status={status}
              >
                <code className="vote-modal__row-address">{mn.address}</code>
                {mn.label ? (
                  <span className="vote-modal__row-label">{mn.label}</span>
                ) : null}
                <span className="vote-modal__progress-status">
                  {progressLabel(status)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  } else if (phase === PHASE.CONFIRM_CHANGE) {
    // Only the vote-change rows are shown in the confirmation body —
    // the rest of the selection is irrelevant to the question being
    // asked ("are you sure you want to overwrite these on-chain
    // votes?"). Pulling them from pendingChosenRef because
    // effectiveSelected / owned can mutate if, say, a reconcile
    // request lands mid-confirmation; the ref pins the set to what
    // the user was looking at when they clicked Sign & Submit.
    const pending = pendingChosenRef.current || [];
    const changing = pending.filter(
      (m) => classifyOwned(m, outcome) === 'confirmed-different'
    );
    const newLabel = outcomeLabel(outcome);
    body = (
      <div
        className="vote-modal__state vote-modal__confirm-change"
        data-testid="vote-modal-confirm-change"
      >
        <p>
          <strong>Heads up:</strong> {changing.length} sentry node
          {changing.length === 1 ? '' : 's'} already voted on this
          proposal with a different outcome. Submitting will
          <strong> overwrite</strong> those votes on-chain with{' '}
          <strong>{newLabel}</strong>.
        </p>
        <ul
          className="vote-modal__change-list"
          data-testid="vote-modal-change-list"
        >
          {changing.map((m) => {
            const previousLabel = m.receipt
              ? outcomeLabel(m.receipt.voteOutcome).toLowerCase()
              : '';
            return (
              <li key={mnId(m)} className="vote-modal__change-row">
                <code className="vote-modal__row-address">
                  {m.address}
                </code>
                {m.label ? (
                  <span className="vote-modal__row-label">{m.label}</span>
                ) : null}
                <span className="vote-modal__change-outcome">
                  {previousLabel} → {newLabel.toLowerCase()}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="vote-modal__actions">
          <button
            type="button"
            className="button button--primary button--small"
            onClick={confirmVoteChange}
            data-testid="vote-modal-confirm-change-submit"
          >
            Change {changing.length === 1 ? 'vote' : 'votes'} to {newLabel}
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={cancelVoteChange}
            data-testid="vote-modal-confirm-change-cancel"
          >
            Back
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        {reviewingNewVote && <p role="alert">An earlier vote may still reach the network. This is a new vote, not proof that the previous request failed. Review the outcome and nodes before signing again.</p>}
        {!reviewingNewVote && owned.some((m) => m.receipt?.status === 'submission_unknown') && <div role="status">
          <p>A previous submission is uncertain. Check status before reviewing another vote.</p>
          <button type="button" className="button button--ghost button--small" disabled={checkingStatus} onClick={async () => {
            const scope = votingScopeRef.current;
            if (!scope.eligible) return;
            setCheckingStatus(true);
            try { await refresh({ refreshReceipts: true }); if (scope === votingScopeRef.current) setStatusChecked(true); }
            finally { if (scope === votingScopeRef.current) setCheckingStatus(false); }
          }}>Check status</button>
          {statusChecked && <button type="button" className="button button--ghost button--small" onClick={reviewNewVote}>Review a new vote</button>}
        </div>}
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
            {effectiveSelected.size} of {owned.length} sentry node
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

        {supportShift ? (
          <div
            className={`vote-modal__shift vote-modal__shift--${supportShift.tone}`}
            data-testid="vote-modal-shift"
            data-shift-tone={supportShift.tone}
            data-shift-delta={supportShift.netDelta}
          >
            <span className="vote-modal__shift-headline">
              {supportShift.headline}
            </span>
            {supportShift.detail ? (
              <span className="vote-modal__shift-detail">
                {supportShift.detail}
              </span>
            ) : null}
          </div>
        ) : null}

        {(() => {
          // Grouped picker render. The outer wrapper retains
          // `data-testid="vote-modal-list"` so legacy queries that
          // count rows across the whole picker still work; each
          // section adds its own `data-testid="vote-modal-group-*"`
          // for targeted assertions (and for CSS hooks per bucket).
          const renderRow = ({ m, kind }) => {
            const id = mnId(m);
            const badge = receiptBadge(m.receipt, outcome);
            const receiptStatus = m.receipt ? m.receipt.status : '';
            return (
              <li
                key={id}
                className={`vote-modal__row vote-modal__row--${kind}`}
                data-testid="vote-modal-row"
                data-mn-id={id}
                data-key-id={m.keyId}
                data-receipt-status={receiptStatus}
                data-row-kind={kind}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={effectiveSelected.has(id)}
                    disabled={kind === 'unknown' && !reviewingNewVote}
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
          };

          return (
            <div className="vote-modal__list" data-testid="vote-modal-list">
              {groups.actionNeeded.length > 0 ? (
                <section
                  className="vote-modal__group vote-modal__group--action"
                  data-testid="vote-modal-group-action-needed"
                >
                  <header className="vote-modal__group-header">
                    <h3 className="vote-modal__group-title">
                      Action needed
                    </h3>
                    <p className="vote-modal__group-sub">
                      {/* Subtle disambiguation between the two
                          constituents of this bucket: a failed
                          relay vs a vote-change candidate. Both
                          belong here because both require the
                          user to notice before signing. Pick the
                          copy honestly — the old logic mentioned
                          "retry failed submissions" whenever there
                          was ANY vote-change row, even with zero
                          failures, which confused users who had
                          only voted successfully before and were
                          now just changing their outcome. */}
                      {(function actionNeededSubtitle() {
                        const hasFailed = groups.actionNeeded.some(
                          (g) => g.kind === 'failed'
                        );
                        const hasChange = groups.actionNeeded.some(
                          (g) => g.kind === 'confirmed-different'
                        );
                        if (hasFailed && hasChange) {
                          return 'Retry failed submissions and confirm vote changes.';
                        }
                        if (hasChange) {
                          return 'Confirm these vote changes before submitting.';
                        }
                        return 'Retry failed submissions from a previous attempt.';
                      })()}
                    </p>
                  </header>
                  <ul className="vote-modal__group-list">
                    {groups.actionNeeded.map(renderRow)}
                  </ul>
                </section>
              ) : null}

              {groups.needsVote.length > 0 ? (
                <section
                  className="vote-modal__group vote-modal__group--needs-vote"
                  data-testid="vote-modal-group-needs-vote"
                >
                  <header className="vote-modal__group-header">
                    <h3 className="vote-modal__group-title">Needs vote</h3>
                  </header>
                  <ul className="vote-modal__group-list">
                    {groups.needsVote.map(renderRow)}
                  </ul>
                </section>
              ) : null}

              {groups.alreadyVoted.length > 0 ? (
                <section
                  className="vote-modal__group vote-modal__group--already-voted"
                  data-testid="vote-modal-group-already-voted"
                  data-collapsed={showAlreadyVoted ? 'false' : 'true'}
                >
                  <header className="vote-modal__group-header">
                    <h3 className="vote-modal__group-title">
                      Already voted{' '}
                      <span className="vote-modal__group-count">
                        ({groups.alreadyVoted.length})
                      </span>
                    </h3>
                    <button
                      type="button"
                      className="auth-card__disclosure-toggle"
                      onClick={() =>
                        setShowAlreadyVoted((prev) => !prev)
                      }
                      data-testid="vote-modal-toggle-already-voted"
                      aria-expanded={showAlreadyVoted ? 'true' : 'false'}
                      aria-label={
                        showAlreadyVoted
                          ? 'Collapse already-voted sentry nodes'
                          : 'Expand already-voted sentry nodes'
                      }
                    >
                      {/* Reuse the `auth-card__disclosure-toggle`
                          pattern (NotificationPreferencesCard,
                          ChangePasswordCard) rather than minting a
                          third disclosure affordance. The glyph
                          stays `▸` in markup; the CSS flips it to
                          `▾` via `rotate(90deg)` on the
                          `aria-expanded='true'` selector, so the
                          DOM stays stable across toggles and the
                          visual matches the accounts screen 1:1.
                          The class name is historical (born in
                          AuthCard) but is already the codebase's
                          shared disclosure pattern. */}
                      <span className="auth-card__chevron" aria-hidden="true">
                        ▸
                      </span>
                    </button>
                  </header>
                  {/* Always render the list so its checkboxes keep
                      a stable identity across toggle clicks, then
                      hide via the HTML `hidden` attribute. `hidden`
                      sets display:none by default AND flags the
                      subtree as inaccessible to AT/tab order —
                      exactly the semantics we want for a
                      progressive-disclosure region. Tests that
                      inspect internal state via data-testid still
                      find the checkboxes (testing-library does not
                      filter by visibility for testid queries),
                      which keeps unit coverage of the selection
                      logic intact. */}
                  <ul
                    className="vote-modal__group-list"
                    hidden={!showAlreadyVoted}
                  >
                    {groups.alreadyVoted.map(renderRow)}
                  </ul>
                </section>
              ) : null}
            </div>
          );
        })()}

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
