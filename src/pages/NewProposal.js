import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Link, useHistory, useLocation } from 'react-router-dom';

import PageMeta from '../components/PageMeta';
import PayWithPaliPanel, {
  usePaliAvailable,
} from '../components/PayWithPaliPanel';
import UnsavedChangesModal from '../components/UnsavedChangesModal';
import { useAuth } from '../context/AuthContext';
import { fetchNetworkStats } from '../lib/api';
import {
  SUPERBLOCK_CYCLE_SEC,
  computeProposalWindow,
  isTightVotingWindow,
  nextSuperblockEpochSecFromStats,
} from '../lib/governanceWindow';
import { proposalService } from '../lib/proposalService';
import {
  COLLATERAL_FEE_SATS,
  MAX_DATA_SIZE,
  MAX_PAYMENT_COUNT,
  draftBodyFromForm,
  emptyForm,
  estimatePayloadBytes,
  formsEqual,
  fromDraft,
  prepareBodyFromForm,
  satsStringToSys,
  sysToSatsString,
  validateBasics,
  validatePayment,
} from '../lib/proposalForm';
import { HEX64_RE } from '../lib/proposalService';

// NewProposal wizard — /governance/new[?draft=<id>]
// -------------------------------------------------
// Apple-level UX goals for this page (see the product brief):
//
//  - Four clearly-signposted steps: Basics, Payment, Review, Submit.
//    Users can freely move backwards without losing anything; forwards
//    is gated on the step's validators so we never 400 the user at
//    /prepare time for something we could have surfaced inline.
//
//  - Draft lives on the server; nothing is saved automatically. The
//    user explicitly presses "Save draft" OR confirms save on the
//    leave-guard modal. This mirrors Twitter's "you have unsent tweet
//    — save draft?" flow, which is the single most-loved draft UX in
//    the consumer web.
//
//  - Submit step is three lanes: "Pay with Pali" (when the extension
//    is installed and the backend exposes the PSBT endpoint), the
//    manual Syscoin-Qt / syscoin-cli fallback, and the generic
//    external-wallet OP_RETURN walkthrough. The copy makes clear
//    that 150 SYS is BURNED (not refunded) and that 6 confirmations
//    are required before the backend auto-submits.
//
//  - All state transitions are idempotent. Reloading the page at any
//    point picks up the draft (or the prepared submission) and lets
//    the user continue. The prepare step is safe to double-press —
//    the backend dedupes on (userId, proposalHash).

const STEPS = ['basics', 'payment', 'review', 'submit'];
const STEP_LABELS = {
  basics: 'Basics',
  payment: 'Payment',
  review: 'Review',
  submit: 'Submit',
};

// Reducer so the leave-guard's "Discard" path can reset dirty state
// atomically (setting form + baseline in lockstep) without stacking
// setStates. Keeps formsEqual(form, baseline) correct throughout.
function formReducer(state, action) {
  switch (action.type) {
    case 'set': {
      return {
        ...state,
        form: { ...state.form, [action.field]: action.value },
      };
    }
    case 'replace': {
      return {
        form: action.form,
        baseline: action.baseline != null ? action.baseline : action.form,
      };
    }
    case 'mark_saved': {
      // Codex PR8 round 7 P1: the baseline MUST be the form snapshot
      // we actually persisted, not the live `state.form`. `saveDraft`
      // captures the form at call-time for the request body, awaits
      // the server round-trip, then dispatches `mark_saved`. If the
      // user keeps typing during that round-trip, `state.form` at
      // reducer-time contains newer edits the server never saw — if
      // we read `state.form` here, those unsaved edits silently
      // become the new baseline, `dirty` flips false, and the
      // history.block guard stops prompting for data that was never
      // persisted. Callers now pass the saved snapshot explicitly
      // via `action.baseline`; we fall back to `state.form` only if
      // the caller omits it (preserves behaviour for any future call
      // site that really does want "I just synced state.form to
      // storage atomically").
      const nextBaseline =
        action.baseline != null ? action.baseline : state.form;
      return { ...state, baseline: nextBaseline };
    }
    default:
      return state;
  }
}

function useQueryParam(name) {
  const location = useLocation();
  return useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get(name);
  }, [location.search, name]);
}

// Human-readable SYS from sats. 150_00000000n → "150".
function fmtSys(sats) {
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

// Map backend error codes emitted by /gov/proposals/* into
// human-readable copy. Unknown codes render verbatim as a last resort
// — every code we actually emit server-side is listed here.
function describePrepareError(err) {
  if (!err) return 'Something went wrong. Try again.';
  switch (err.code) {
    case 'validation_failed':
      return 'Some fields are invalid. Go back and check each step.';
    case 'payload_too_large':
      return `Your proposal exceeds the ${MAX_DATA_SIZE}-byte on-chain limit. Trim the URL or name.`;
    case 'submission_exists':
      return 'You already prepared an identical proposal. Opening it now.';
    case 'draft_not_found':
      return "We couldn't find that draft. It may have been deleted on another device.";
    case 'network_error':
      return 'Network hiccup. Check your connection and try again.';
    case 'http_error':
      return 'The server returned an error. Try again in a moment.';
    case 'stats_unavailable':
    case 'anchor_drift':
      // Messages for these two are authored in onPrepare so they can
      // quote the exact recovery action inline. Codex PR20 round 2 P2.
      return err.message || 'Live superblock timing unavailable. Please retry.';
    default:
      return err.code || 'Unknown error.';
  }
}

export default function NewProposal() {
  const history = useHistory();
  const { isAuthenticated, isBooting } = useAuth();
  const draftIdParam = useQueryParam('draft');
  const draftIdFromUrl = useMemo(() => {
    const n = Number(draftIdParam);
    return Number.isInteger(n) && n > 0 ? n : null;
  }, [draftIdParam]);

  const [stepIdx, setStepIdx] = useState(0);
  const [formState, dispatch] = useReducer(formReducer, null, () => ({
    form: emptyForm(),
    baseline: emptyForm(),
  }));
  const { form, baseline } = formState;

  const [draftId, setDraftId] = useState(null);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [touched, setTouched] = useState({});

  // Preparation / submission state
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState(null); // full envelope from /prepare
  const [prepareError, setPrepareError] = useState(null);

  // Attach-collateral state
  const [txidInput, setTxidInput] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState(null);

  // Save-draft state (used both by the explicit "Save draft" button
  // and by the leave-guard modal).
  const [savingDraft, setSavingDraft] = useState(false);
  const [saveDraftError, setSaveDraftError] = useState(null);

  // Leave-guard state.
  const [leaveModal, setLeaveModal] = useState({ open: false, pending: null });

  // Track if user has clicked Save draft from toolbar (vs. modal) for
  // toast-like feedback.
  const [draftSavedAt, setDraftSavedAt] = useState(0);

  // Live next-superblock anchor. We fetch the backend /mnStats feed
  // on mount and extract `superblock_stats.superblock_next_epoch_sec`
  // so that `computeProposalWindow` can align the derived start/end
  // epochs to the real chain. Loading / error states gate the
  // "Prepare proposal" button — submitting without a live anchor
  // risks a window that doesn't cover the first superblock or
  // accidentally fits an extra one.
  const [nextSuperblockSec, setNextSuperblockSec] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const refreshStats = useCallback(() => {
    let cancelled = false;
    setStatsLoading(true);
    setStatsError(null);
    fetchNetworkStats()
      .then((stats) => {
        if (cancelled) return;
        // `nowSec` is captured at response time, not at effect
        // mount, so we reject anchors that are already in the past
        // relative to the clock the user will also see in the
        // Review schedule.
        const anchor = nextSuperblockEpochSecFromStats(
          stats,
          Math.floor(Date.now() / 1000)
        );
        if (!anchor) {
          setStatsError(new Error('missing_next_superblock_epoch'));
          setNextSuperblockSec(null);
          return;
        }
        setNextSuperblockSec(anchor);
      })
      .catch((err) => {
        if (cancelled) return;
        setStatsError(err);
        setNextSuperblockSec(null);
      })
      .finally(() => {
        if (!cancelled) setStatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const cancel = refreshStats();
    return cancel;
  }, [refreshStats]);

  const dirty = !formsEqual(form, baseline) && prepared == null;

  // ---- Draft load -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    if (!draftIdFromUrl) {
      // The URL no longer targets a specific draft. Two entry
      // paths land here:
      //   a) Fresh mount on /governance/new with no query — nothing
      //      to reset, local state is already empty.
      //   b) User navigated from /governance/new?draft=<id> to
      //      /governance/new (param removed). Without clearing we
      //      would keep `draftId` in memory tied to the previous
      //      draft, so Save Draft would PATCH /drafts/<old id>
      //      while the URL claims we're authoring a new proposal
      //      — a cross-draft overwrite the user can't see. Reset
      //      draftId and wipe the form so route state and the
      //      persisted target stay aligned: a subsequent Save
      //      Draft can only create a new draft, never update a
      //      stale one.
      if (draftId != null) {
        const blank = emptyForm();
        dispatch({ type: 'replace', form: blank, baseline: blank });
        setDraftId(null);
      }
      // Codex PR8 round 13 P2: always clear loadError on this
      // transition, even when draftId was already null. A failed
      // prior load wipes draftId to null inside the catch block
      // below but leaves loadError set (so the error banner
      // persists). If the user then drops the ?draft= query to
      // start fresh, the old "Couldn't load draft #NN" banner
      // would otherwise follow them onto the new-proposal route
      // with no draft context, making the page look broken even
      // though there is no draft being loaded. Hoisting this
      // reset outside the `draftId != null` guard keeps the
      // banner's lifecycle tied to the URL state.
      setLoadError(null);
      return () => {};
    }
    // Codex PR8 round 3 P1: skip refetch when the draft is already
    // loaded in local state. After a successful createDraft() we
    // call `setDraftId(result.id)` AND `history.replace({ ?draft=id
    // })`; without this guard the URL bump re-triggers this effect,
    // overwriting the fresh in-memory form (including any keystrokes
    // the user typed during the round trip) with the server echo.
    // Cold loads (direct URL navigation, reload) still fetch because
    // `draftId` starts as null and only matches AFTER the first
    // successful fetch's setDraftId() settles.
    if (draftId != null && draftId === draftIdFromUrl) return () => {};
    // Codex PR8 round 11 P1: clear any cached draft state tied to a
    // DIFFERENT id before the new fetch resolves. Otherwise the
    // UI keeps showing the previous draft's form and — worse —
    // `saveDraft()` keeps PATCHing the previous `draftId` while
    // the URL claims we're editing a new one. That crosses writes
    // between drafts if the user types anything (or hits Save)
    // during the fetch window, or if the new fetch then fails
    // (network, 404 because deleted, 403). Reset the form to
    // emptyForm() so the wizard renders a blank state rather than
    // silently inheriting the prior draft's fields under a new
    // URL. A subsequent successful load replaces it with the
    // fetched draft; a persistent failure keeps the UI empty and
    // surfaces `loadError`, which is the correct UX.
    if (draftId != null && draftId !== draftIdFromUrl) {
      const blank = emptyForm();
      dispatch({ type: 'replace', form: blank, baseline: blank });
      setDraftId(null);
    }
    setLoadingDraft(true);
    setLoadError(null);
    proposalService
      .getDraft(draftIdFromUrl)
      .then((d) => {
        if (cancelled) return;
        const loaded = fromDraft(d);
        dispatch({ type: 'replace', form: loaded, baseline: loaded });
        setDraftId(d.id);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err);
        // Codex PR8 round 11 P1: any prior draftId left over after
        // a successful `prepare` redirect (draftId is cleared on
        // consume) or from a prior route should already be null
        // by the time we reach this catch thanks to the reset
        // above. But be defensive: on a hard load failure, make
        // sure the wizard isn't still pointed at a draftId that
        // no longer matches the URL — clear it so subsequent
        // `saveDraft()` creates a new draft instead of PATCHing
        // a stale one the user can no longer see.
        setDraftId(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDraft(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draftIdFromUrl, draftId]);

  // ---- Before-unload guard ---------------------------------------------

  useEffect(() => {
    function beforeUnload(e) {
      if (!dirty) return undefined;
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  // In-app navigation guard using react-router. Blocks all transitions
  // while dirty and routes through the modal.
  //
  // Two refs coordinate "allow exactly one specific transition" — both
  // are needed because React 18 batches state updates, so a `dispatch`
  // followed by a `history.replace` on the next line runs with the
  // block callback still observing the old (dirty) value. (Codex PR8
  // round 2 frontend P2.)
  //
  //   allowedPathRef   used by the draft-save path to pre-authorise a
  //                    single internal replace so mark_saved + the
  //                    URL bump coexist.
  //   pendingPathRef   tracks the one path the user confirmed via the
  //                    modal so only THAT transition is allowed
  //                    through, not any subsequent back/forward
  //                    navigation while the modal is visible.
  //                    (Codex PR8 round 2 frontend P3.)
  const unblockRef = useRef(null);
  const allowedPathRef = useRef(null);
  const pendingPathRef = useRef(null);
  useEffect(() => {
    if (!dirty) {
      if (unblockRef.current) {
        unblockRef.current();
        unblockRef.current = null;
      }
      return undefined;
    }
    unblockRef.current = history.block((location) => {
      const locKey = `${location.pathname}${location.search || ''}${
        location.hash || ''
      }`;
      // 1. Internal, trusted transitions — allow and clear.
      if (allowedPathRef.current && allowedPathRef.current === locKey) {
        allowedPathRef.current = null;
        return true;
      }
      // 2. The user already resolved the modal (Save or Discard) and
      //    we are now pushing the PENDING target. Only that exact
      //    path is whitelisted — any other transition while the modal
      //    is still cleaning up must still go through the prompt.
      if (pendingPathRef.current && pendingPathRef.current === locKey) {
        pendingPathRef.current = null;
        return true;
      }
      // 3. Otherwise: record the target and pop the modal.
      setLeaveModal({ open: true, pending: locKey });
      return false;
    });
    return () => {
      if (unblockRef.current) {
        unblockRef.current();
        unblockRef.current = null;
      }
    };
  }, [dirty, history]);

  // ---- Validation -------------------------------------------------------

  const basicsErrors = useMemo(() => validateBasics(form), [form]);
  const paymentErrors = useMemo(
    () => validatePayment(form, { nowSec: Math.floor(Date.now() / 1000) }),
    [form]
  );
  const payloadBytes = useMemo(() => estimatePayloadBytes(form), [form]);

  // Derive the proposal's on-chain payment window purely from the
  // user's duration input + the live next-superblock anchor. We
  // show this to the user in both the Payment step (as a preview
  // under the duration input) and the Review step (as the
  // authoritative "Voting window" the backend will submit). The
  // same formula runs again inside onPrepare with a freshly-
  // fetched anchor, so any drift between this preview and the
  // actual submission is bounded by how much wall-clock time
  // passes between render and Prepare — essentially zero for the
  // 0-second-old cached anchor and at most one `fetchNetworkStats`
  // round-trip otherwise.
  const derivedWindow = useMemo(() => {
    const n = Math.floor(Number(form.paymentCount));
    if (!Number.isInteger(n) || n < 1) return null;
    try {
      return computeProposalWindow({
        durationMonths: n,
        nowSec: Math.floor(Date.now() / 1000),
        nextSuperblockSec,
      });
    } catch (_e) {
      return null;
    }
  }, [form.paymentCount, nextSuperblockSec]);

  // Which form fields belong to each step. Used by the "Next"
  // handler to mark every field on the current step as touched
  // when validation fails, so inline red borders + hint text
  // appear on the fields that are actually blocking progress —
  // not just the ones the user already interacted with via blur.
  // Kept in lock-step with `validateBasics` / `validatePayment` in
  // lib/proposalForm.js — any new error key added there must be
  // listed here too or the Next click will disable the button
  // silently again.
  const STEP_FIELDS = useMemo(
    () => ({
      basics: ['name', 'url'],
      payment: ['paymentAddress', 'paymentAmount', 'paymentCount'],
    }),
    []
  );

  // "Next" button handler. Historically the button was `disabled`
  // while a step had errors, which made the control a dead-end
  // for anyone who clicked it without first blurring every
  // field — the user saw a greyed-out Next with no indication of
  // why. Instead we always enable the button; on click, if the
  // step has errors, we touch every field on the step so red
  // borders + inline hints render and THEN bail without
  // advancing. On a clean step we advance normally.
  const onClickNext = useCallback(() => {
    const step = STEPS[stepIdx];
    const fields = STEP_FIELDS[step] || [];
    const errs =
      step === 'basics'
        ? basicsErrors
        : step === 'payment'
        ? paymentErrors
        : {};
    if (Object.keys(errs).length > 0) {
      // Touch every field on this step so the blur-gated error
      // UI (both the red border via aria-invalid and the inline
      // FieldError stacked under the field) shows up for ANY
      // invalid field, not only ones the user has already
      // touched by blurring.
      setTouched((t) => {
        const next = { ...t };
        for (const f of fields) next[f] = true;
        return next;
      });
      return;
    }
    setStepIdx((i) => i + 1);
  }, [stepIdx, basicsErrors, paymentErrors, STEP_FIELDS]);

  // ---- Handlers ---------------------------------------------------------

  const setField = useCallback((field, value) => {
    dispatch({ type: 'set', field, value });
  }, []);

  const markTouched = useCallback((field) => {
    setTouched((t) => ({ ...t, [field]: true }));
  }, []);

  async function saveDraft() {
    setSavingDraft(true);
    setSaveDraftError(null);
    // Codex PR8 round 7 P1: capture the form snapshot the server
    // will actually see, so the post-await `mark_saved` dispatch
    // installs *this* snapshot as the new baseline instead of
    // whatever the user has typed into state.form in the meantime.
    // Without this, post-click edits are silently absorbed into
    // baseline and the dirty-leave guard stops prompting for data
    // that was never persisted.
    const savedSnapshot = form;
    // Codex PR8 round 13 P2: when updating an existing draft, the
    // body must explicitly include cleared fields (empty-string for
    // text, null for epochs) so the backend clears them. Create
    // paths drop empties so a brand-new row isn't peppered with
    // spurious "" columns; see draftBodyFromForm for the contract.
    const isUpdate = draftId != null;
    const body = draftBodyFromForm(savedSnapshot, { forUpdate: isUpdate });
    try {
      let result;
      if (isUpdate) {
        result = await proposalService.updateDraft(draftId, body);
      } else {
        result = await proposalService.createDraft(body);
        setDraftId(result.id);
        // Codex PR8 round 2 frontend P2: React 18 batches state
        // updates, so dispatching `mark_saved` here does NOT
        // synchronously drop `dirty` — the effect that installs /
        // removes the history.block guard won't rerun until after
        // this async function yields. The `history.replace` two
        // lines down would then still be observed as a dirty-leave
        // transition by the active block, pop the unsaved-changes
        // modal on a flow that actually succeeded, and/or drop the
        // `?draft=<id>` from the URL (breaking reload-to-resume).
        //
        // Pre-authorise this one specific URL bump via
        // allowedPathRef; the block callback reads the ref and lets
        // THAT exact transition through while still prompting for
        // anything else. dispatch is still done so the NEXT render
        // tears down the block cleanly.
        const params = new URLSearchParams(history.location.search);
        params.set('draft', String(result.id));
        const nextSearch = `?${params.toString()}`;
        // Codex PR8 round 10 P3: the whitelist key MUST match the
        // shape of the URL we actually hand to history.replace. The
        // replace call below sets pathname + search ONLY, so if we
        // include the current hash in the whitelist key, a route
        // like `/governance/new#some-anchor` (any hash, even one
        // a user pasted or that was added by an anchor link) would
        // be recorded as `path?search#hash` while the location
        // react-router observes post-replace is `path?search`. The
        // block callback then compares these two different strings,
        // classifies our internal URL sync as an untrusted
        // navigation, and pops the unsaved-changes modal on a
        // successful first-save. Drop the hash here so the
        // whitelist key is exactly what history.replace produces.
        allowedPathRef.current = `${history.location.pathname}${nextSearch}`;
        dispatch({ type: 'mark_saved', baseline: savedSnapshot });
        history.replace({
          pathname: history.location.pathname,
          search: nextSearch,
        });
        setDraftSavedAt(Date.now());
        return result;
      }
      // Sync baseline — we are no longer "dirty" relative to storage.
      dispatch({ type: 'mark_saved', baseline: savedSnapshot });
      setDraftSavedAt(Date.now());
      return result;
    } catch (err) {
      setSaveDraftError(err);
      throw err;
    } finally {
      setSavingDraft(false);
    }
  }

  async function discardDraft() {
    // Codex PR8 round 8 P1: "Discard" in the unsaved-changes modal
    // means "drop the edits I made in this session", NOT "permanently
    // delete my saved draft". Previously this function unconditionally
    // called `proposalService.deleteDraft(draftId)` whenever a
    // draftId was present — so resuming an existing server-side
    // draft, tweaking a field, then clicking Discard on the leave
    // prompt would wipe the entire draft from the server. That turns
    // a "throw away my recent keystrokes" action into permanent data
    // loss and breaks the resume-on-another-device flow we explicitly
    // promised users.
    //
    // Correct semantics:
    //   - If the draft has a server-side row (draftId != null), the
    //     last persisted `baseline` IS that row's content. Reverting
    //     the local form to `baseline` reconciles the in-memory state
    //     with what's on disk, drops `dirty`, and leaves the draft
    //     intact so it's still listed/resumable.
    //   - If there is NO server-side draft (user started fresh and
    //     never saved), there is nothing to preserve; clear the local
    //     form entirely so the wizard is reset for the next use.
    if (draftId) {
      dispatch({ type: 'replace', form: baseline, baseline });
      return;
    }
    dispatch({ type: 'replace', form: emptyForm(), baseline: emptyForm() });
    setDraftId(null);
  }

  async function onModalSave() {
    try {
      await saveDraft();
      const pending = leaveModal.pending;
      setLeaveModal({ open: false, pending: null });
      if (pending) {
        // Codex PR8 round 2 frontend P3: whitelist only the exact
        // pending target through the block guard — a back/forward or
        // any other navigation that fires before this push lands
        // must still be prompted.
        pendingPathRef.current = pending;
        history.push(pending);
      }
    } catch (_err) {
      // Error already in saveDraftError — keep modal open.
    }
  }

  async function onModalDiscard() {
    await discardDraft();
    const pending = leaveModal.pending;
    setLeaveModal({ open: false, pending: null });
    if (pending) {
      pendingPathRef.current = pending;
      history.push(pending);
    }
  }

  function onModalCancel() {
    setLeaveModal({ open: false, pending: null });
  }

  async function onPrepare() {
    setPreparing(true);
    setPrepareError(null);
    try {
      // Derive the on-chain payment window at submit time from the
      // user's duration input (months). We anchor to the current
      // next-superblock epoch rather than freezing this at draft
      // time so a draft resumed days later still points at the
      // correct cycle. See lib/governanceWindow.js for the full
      // derivation.
      const durationMonths = Math.floor(Number(form.paymentCount));
      const nowSec = Math.floor(Date.now() / 1000);

      // Re-fetch the live next-SB anchor right before submission
      // and FAIL CLOSED on anything that would let the submitted
      // window diverge from what the user saw on Review:
      //
      //   (a) fetch throws (transport error, 5xx, timeout) → surface
      //       the stats-unavailable banner, clear the cached anchor
      //       so Prepare stays disabled until refreshStats() recovers.
      //   (b) fetch returns a stale or missing anchor
      //       (next_SB epoch <= now) → same as (a). The /mnStats
      //       source occasionally lags a few blocks behind the tip
      //       and we refuse to submit against a backward-pointing
      //       anchor for the same reason.
      //   (c) fetch returns a DIFFERENT future anchor than the one
      //       Review rendered from (a superblock passed while the
      //       wizard was open) → update state so the preview card
      //       rerenders with the new schedule, and surface an
      //       "anchor drift" message asking the user to re-review
      //       before clicking Prepare again. We do NOT submit the
      //       new window under the user — they reviewed the old one.
      //
      // Codex PR20 round 2 P2: the previous implementation caught
      // (a) silently, kept the cached anchor, and let
      // computeProposalWindow fall back to `now + cycle` if the
      // cached anchor had also gone stale. That path could ship a
      // window a full cycle off from the reviewed schedule and
      // burn collateral on a proposal whose effective payout
      // window had shifted. All three branches now short-circuit
      // before prepareBodyFromForm / proposalService.prepare.
      let liveAnchor = null;
      let refreshErr = null;
      try {
        const freshStats = await fetchNetworkStats();
        liveAnchor = nextSuperblockEpochSecFromStats(freshStats, nowSec);
        if (!liveAnchor) {
          refreshErr = new Error('stale_superblock_anchor');
        }
      } catch (err) {
        refreshErr = err;
      }
      if (refreshErr) {
        setStatsError(refreshErr);
        setNextSuperblockSec(null);
        setPrepareError(
          Object.assign(
            new Error(
              'Could not confirm live superblock timing from the node. ' +
                'Please wait a moment and Prepare again — the wizard will ' +
                'not submit with a potentially stale voting window.'
            ),
            { code: 'stats_unavailable' }
          )
        );
        return;
      }
      if (liveAnchor !== nextSuperblockSec) {
        // Chain advanced a cycle while the wizard was open. The
        // fresh anchor is fine, but the user reviewed a schedule
        // built from the previous anchor. Sync state so the
        // WindowPreview + schedule re-render, and force a second
        // Prepare click so they commit collateral to a window
        // they actually saw.
        setNextSuperblockSec(liveAnchor);
        setPrepareError(
          Object.assign(
            new Error(
              'Chain timing updated while this wizard was open — the ' +
                'voting window has been refreshed to match the next ' +
                'superblock. Please re-check the updated window above, ' +
                'then click Prepare again to submit.'
            ),
            { code: 'anchor_drift' }
          )
        );
        return;
      }
      const windowSpec = computeProposalWindow({
        durationMonths,
        nowSec,
        nextSuperblockSec: liveAnchor,
      });
      const body = prepareBodyFromForm(form, {
        draftId: draftId || undefined,
        consumeDraft: true,
        window: windowSpec,
      });
      const envelope = await proposalService.prepare(body);
      setPrepared(envelope);
      // The backend consumed the draft atomically on success — clear
      // our local handle. Also sync the baseline so the leave-guard
      // disengages before we navigate away.
      setDraftId(null);
      dispatch({ type: 'replace', form, baseline: form });

      // Codex PR8 round 5 P2: redirect to the dedicated status page
      // rather than parking the user on a local-state-only "Submit"
      // step. The previous flow stored the prepared envelope *only*
      // in `prepared` component state — a browser reload on the
      // Submit step would lose that state, the draft-load effect
      // would see no `?draft=` and exit early, and the user would
      // land back on an empty wizard even though the submission
      // already existed server-side. /governance/proposal/:id is
      // the canonical, reload-safe view for a prepared submission
      // (it renders the OP_RETURN hex, the CLI fallback, and the
      // inline attach-collateral form — parity with the old
      // SubmitStep) and is what the Proposals Created panel already
      // deep-links into.
      //
      // Pre-authorise this single internal navigation via
      // allowedPathRef because React 18 batches state updates:
      // `dispatch({ type: 'replace', form, baseline: form })` flips
      // dirty=false, but the block-installer effect only re-runs on
      // the next render, AFTER the history.replace below. Without
      // the whitelist, the block callback would observe dirty=true
      // and pop the unsaved-changes modal on a flow that actually
      // succeeded.
      const nextPath = `/governance/proposal/${envelope.submission.id}`;
      allowedPathRef.current = nextPath;
      history.replace(nextPath);
      return;
    } catch (err) {
      setPrepareError(err);
      // If the backend says "you already prepared this", pivot to
      // the status page for the existing submission.
      if (err && err.code === 'submission_exists' && err.details && err.details.id) {
        // Codex PR8 round 5 P2: pre-authorise this redirect too.
        // Unlike the success path above, we didn't dispatch
        // `mark_saved`/`replace baseline` here — the draft wasn't
        // consumed server-side — so the form is still dirty and
        // the block callback would otherwise pop the unsaved-
        // changes modal in front of what is a legitimate
        // "your prior prepare already took; here's its status
        // page" redirect. Whitelisting the exact path is safer
        // than flipping the dirty flag because the draft state
        // really is unsaved relative to the pristine baseline.
        const nextPath = `/governance/proposal/${err.details.id}`;
        allowedPathRef.current = nextPath;
        history.push(nextPath);
      }
    } finally {
      setPreparing(false);
    }
  }

  async function onAttachCollateral() {
    if (!prepared || !prepared.submission) return;
    setAttachError(null);
    if (!HEX64_RE.test(txidInput.trim())) {
      setAttachError({ code: 'malformed_txid' });
      return;
    }
    setAttaching(true);
    try {
      const updated = await proposalService.attachCollateral(
        prepared.submission.id,
        txidInput.trim()
      );
      history.push(`/governance/proposal/${updated.id}`);
    } catch (err) {
      setAttachError(err);
    } finally {
      setAttaching(false);
    }
  }

  // ---- Auth gate --------------------------------------------------------

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
              Please <Link to="/login">log in</Link> to create a proposal.
            </p>
          </div>
        </section>
      </main>
    );
  }

  // ---- Render -----------------------------------------------------------

  const currentStep = STEPS[stepIdx];

  return (
    <main className="page-main proposal-wizard">
      <PageMeta
        title="Create proposal"
        description="Create a Syscoin governance proposal end-to-end: draft, prepare, pay collateral, submit."
      />
      <section className="page-hero">
        <div className="site-wrap">
          {/*
           * Back nav. Dirty-leave prompting is wired via
           * `history.block` above, so clicking this Link when
           * unsaved edits exist will pop the UnsavedChangesModal
           * — no extra handler needed. Kept as a Link rather
           * than a button so right-click / middle-click "open
           * in new tab" behaves as users expect.
           */}
          <p className="page-hero__back-row">
            <Link to="/governance" className="page-hero__back">
              ← Back to governance
            </Link>
          </p>
          <p className="eyebrow">Governance</p>
          <h1>Create a proposal</h1>
          <p className="page-hero__copy">
            Draft a Syscoin governance proposal. We'll canonicalize it,
            hash it for the OP_RETURN commitment, and watch the 150 SYS
            collateral transaction until it has 6 confirmations — then
            submit it on-chain for you automatically.
          </p>
        </div>
      </section>

      <section className="page-section page-section--tight page-section--last">
        <div className="site-wrap">
          <ol
            className="proposal-wizard__steps"
            aria-label="Proposal wizard progress"
          >
            {STEPS.map((s, i) => (
              <li
                key={s}
                className={
                  i === stepIdx
                    ? 'is-active'
                    : i < stepIdx
                    ? 'is-done'
                    : 'is-future'
                }
                data-testid={`wizard-step-${s}`}
              >
                <span className="proposal-wizard__step-number">{i + 1}</span>
                <span className="proposal-wizard__step-label">
                  {STEP_LABELS[s]}
                </span>
              </li>
            ))}
          </ol>

          {loadingDraft ? <p>Loading draft…</p> : null}
          {loadError ? (
            <div className="auth-alert auth-alert--error" role="alert">
              Couldn't load draft: {loadError.code || 'unknown_error'}
            </div>
          ) : null}

          {currentStep === 'basics' ? (
            <BasicsStep
              form={form}
              errors={basicsErrors}
              touched={touched}
              onField={setField}
              onBlur={markTouched}
              payloadBytes={payloadBytes}
            />
          ) : null}
          {currentStep === 'payment' ? (
            <PaymentStep
              form={form}
              errors={paymentErrors}
              touched={touched}
              onField={setField}
              onBlur={markTouched}
              payloadBytes={payloadBytes}
              derivedWindow={derivedWindow}
              nextSuperblockSec={nextSuperblockSec}
              statsLoading={statsLoading}
              statsError={statsError}
              onRetryStats={refreshStats}
            />
          ) : null}
          {currentStep === 'review' ? (
            <ReviewStep
              form={form}
              payloadBytes={payloadBytes}
              derivedWindow={derivedWindow}
              nextSuperblockSec={nextSuperblockSec}
              statsLoading={statsLoading}
              statsError={statsError}
              onRetryStats={refreshStats}
            />
          ) : null}
          {currentStep === 'submit' ? (
            <SubmitStep
              prepared={prepared}
              txidInput={txidInput}
              onTxidChange={setTxidInput}
              attaching={attaching}
              attachError={attachError}
              onAttachCollateral={onAttachCollateral}
              proposalServiceImpl={proposalService}
              onPaliAttached={(txid) => {
                if (!prepared || !prepared.submission) return;
                history.push(`/governance/proposal/${prepared.submission.id}`);
              }}
            />
          ) : null}

          <div className="proposal-wizard__toolbar">
            <div className="proposal-wizard__toolbar-left">
              {stepIdx > 0 && currentStep !== 'submit' ? (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
                  data-testid="wizard-back"
                >
                  Back
                </button>
              ) : null}
              {currentStep !== 'submit' ? (
                <button
                  type="button"
                  className="button button--ghost"
                  // Codex PR8 round 6 P2: saveDraft() rethrows on
                  // failure so onModalSave() (which awaits it) can
                  // distinguish success from failure and keep the
                  // unsaved-changes modal open on errors. A bare
                  // `onClick={saveDraft}` binding makes this async
                  // function's rejection an unhandled promise —
                  // React does not attach a catch to event-handler
                  // returns, so transient network / 4xx errors
                  // bubble to the global `unhandledrejection`
                  // listener (and pollute test logs / trigger any
                  // error-reporting hook the host app installs).
                  // Swallow here; the error is already surfaced in
                  // `saveDraftError` state below, so user feedback
                  // is unchanged.
                  onClick={() => {
                    saveDraft().catch(() => {
                      /* already surfaced via setSaveDraftError */
                    });
                  }}
                  disabled={savingDraft}
                  data-testid="wizard-save-draft"
                >
                  {savingDraft ? 'Saving…' : 'Save draft'}
                </button>
              ) : null}
              {/* Codex PR8 round 14 P2: the "Saved" badge is a
                  claim about the *current* form state, not about
                  history. Gate it on `!dirty` so that as soon as
                  the user types anything after a successful save,
                  the badge disappears — otherwise it would linger
                  until the next save attempt and trick the user
                  into believing unsaved edits are persisted. The
                  badge reappears automatically on the next
                  successful save (`draftSavedAt` is bumped and
                  `dirty` flips back to false via mark_saved's new
                  baseline). */}
              {draftSavedAt && !savingDraft && !saveDraftError && !dirty ? (
                <span
                  className="proposal-wizard__saved-indicator"
                  role="status"
                  data-testid="wizard-saved-indicator"
                >
                  Saved
                </span>
              ) : null}
              {saveDraftError ? (
                <span
                  className="proposal-wizard__saved-indicator proposal-wizard__saved-indicator--error"
                  role="alert"
                >
                  Save failed: {saveDraftError.code || 'error'}
                </span>
              ) : null}
            </div>

            <div className="proposal-wizard__toolbar-right">
              {currentStep === 'basics' || currentStep === 'payment' ? (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={onClickNext}
                  data-testid="wizard-next"
                >
                  Next
                </button>
              ) : null}
              {currentStep === 'review' ? (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={onPrepare}
                  disabled={
                    preparing ||
                    payloadBytes > MAX_DATA_SIZE ||
                    Object.keys(basicsErrors).length > 0 ||
                    Object.keys(paymentErrors).length > 0 ||
                    // Gate Prepare on having a live next-superblock
                    // anchor. Without one we would fall back to the
                    // "now + cycle" worst-case branch of
                    // computeProposalWindow, which is safe for Core
                    // (window is still long enough) but can mis-align
                    // the displayed voting dates by up to a cycle. Ask
                    // the user to retry rather than submit an
                    // unanchored window silently.
                    !derivedWindow ||
                    !nextSuperblockSec
                  }
                  data-testid="wizard-prepare"
                  title={
                    !nextSuperblockSec
                      ? 'Waiting for live superblock timing…'
                      : undefined
                  }
                >
                  {preparing ? 'Preparing…' : 'Prepare proposal'}
                </button>
              ) : null}
            </div>
          </div>

          {prepareError ? (
            <div className="auth-alert auth-alert--error" role="alert">
              {describePrepareError(prepareError)}
            </div>
          ) : null}
        </div>
      </section>

      <UnsavedChangesModal
        open={leaveModal.open}
        saving={savingDraft}
        error={saveDraftError ? `Save failed: ${saveDraftError.code || 'error'}` : null}
        onSave={onModalSave}
        onDiscard={onModalDiscard}
        onCancel={onModalCancel}
      />
    </main>
  );
}

// ---- Step components --------------------------------------------------

function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p className="form-error" id={id} role="alert">
      {message}
    </p>
  );
}

function BasicsStep({ form, errors, touched, onField, onBlur, payloadBytes }) {
  return (
    <div className="proposal-wizard__panel" data-testid="wizard-panel-basics">
      <h2>Basics</h2>
      <p className="proposal-wizard__help">
        Give your proposal a short, slug-friendly name and a public URL
        where voters can read the full write-up. Both are committed
        on-chain and cannot be changed after submission.
      </p>

      <label className="form-field">
        <span>Proposal name</span>
        <input
          type="text"
          value={form.name}
          onChange={(e) => onField('name', e.target.value)}
          onBlur={() => onBlur('name')}
          maxLength={40}
          placeholder="my-community-grant"
          aria-invalid={touched.name && !!errors.name}
          aria-describedby={errors.name ? 'err-name' : undefined}
          data-testid="wizard-field-name"
        />
        <small>Letters, numbers, hyphens, underscores. Max 40 characters.</small>
      </label>
      {touched.name ? <FieldError id="err-name" message={errors.name} /> : null}

      <label className="form-field">
        <span>Proposal URL</span>
        <input
          type="url"
          value={form.url}
          onChange={(e) => onField('url', e.target.value)}
          onBlur={() => onBlur('url')}
          placeholder="https://forum.syscoin.org/..."
          aria-invalid={touched.url && !!errors.url}
          aria-describedby={errors.url ? 'err-url' : undefined}
          data-testid="wizard-field-url"
        />
        <small>
          Must be a permanent link to your full proposal write-up (forum
          thread, GitHub, etc.).
        </small>
      </label>
      {touched.url ? <FieldError id="err-url" message={errors.url} /> : null}

      <PayloadSizeMeter bytes={payloadBytes} />
    </div>
  );
}

function PaymentStep({
  form,
  errors,
  touched,
  onField,
  onBlur,
  payloadBytes,
  derivedWindow,
  nextSuperblockSec,
  statsLoading,
  statsError,
  onRetryStats,
}) {
  return (
    <div className="proposal-wizard__panel" data-testid="wizard-panel-payment">
      <h2>Payment details</h2>
      <p className="proposal-wizard__help">
        Specify the Syscoin address that will receive the monthly
        superblock payment, the amount per month, and how many
        months the proposal should run. The on-chain voting window
        is derived automatically from the duration so it aligns
        with the next superblock and prunes cleanly.
      </p>

      <label className="form-field">
        <span>Payment address</span>
        <input
          type="text"
          value={form.paymentAddress}
          onChange={(e) => onField('paymentAddress', e.target.value)}
          onBlur={() => onBlur('paymentAddress')}
          placeholder="sys1q…"
          aria-invalid={touched.paymentAddress && !!errors.paymentAddress}
          aria-describedby={
            errors.paymentAddress ? 'err-paymentAddress' : undefined
          }
          data-testid="wizard-field-address"
        />
        <small>Syscoin mainnet address (bech32 or legacy).</small>
      </label>
      {touched.paymentAddress ? (
        <FieldError id="err-paymentAddress" message={errors.paymentAddress} />
      ) : null}

      <div className="proposal-wizard__row">
        {/*
         * Each grid-cell wraps ONE input group (label + inline error)
         * so the row's 2-column grid always sees exactly 2 children.
         *
         * Before this wrapper, the `<FieldError>` siblings each
         * consumed their own grid cell. When one field validated and
         * the other didn't, the next label wrapped onto a new row and
         * the error appeared in the adjacent column instead of below
         * the input. The wrapping div keeps the error stacked under
         * its input and keeps the row layout stable.
         */}
        <div className="proposal-wizard__cell">
          <label className="form-field">
            <span>Amount per payment (SYS)</span>
            <input
              type="text"
              inputMode="decimal"
              value={form.paymentAmount}
              onChange={(e) => onField('paymentAmount', e.target.value)}
              onBlur={() => onBlur('paymentAmount')}
              placeholder="1000"
              aria-invalid={touched.paymentAmount && !!errors.paymentAmount}
              aria-describedby={
                errors.paymentAmount ? 'err-paymentAmount' : undefined
              }
              data-testid="wizard-field-amount"
            />
            <small>Positive number, up to 8 decimals.</small>
          </label>
          {touched.paymentAmount ? (
            <FieldError id="err-paymentAmount" message={errors.paymentAmount} />
          ) : null}
        </div>

        <div className="proposal-wizard__cell">
          <label className="form-field">
            <span>Duration (months)</span>
            <input
              type="number"
              min={1}
              max={MAX_PAYMENT_COUNT}
              value={form.paymentCount}
              onChange={(e) => onField('paymentCount', e.target.value)}
              onBlur={() => onBlur('paymentCount')}
              aria-invalid={touched.paymentCount && !!errors.paymentCount}
              aria-describedby={
                errors.paymentCount ? 'err-paymentCount' : undefined
              }
              data-testid="wizard-field-count"
            />
            <small>
              One payment per month for this many months. Max{' '}
              {MAX_PAYMENT_COUNT}.
            </small>
          </label>
          {touched.paymentCount ? (
            <FieldError id="err-paymentCount" message={errors.paymentCount} />
          ) : null}
        </div>
      </div>

      <TightVotingWindowNotice
        nextSuperblockSec={nextSuperblockSec}
        paymentCount={form.paymentCount}
      />

      <WindowPreview
        derivedWindow={derivedWindow}
        nextSuperblockSec={nextSuperblockSec}
        statsLoading={statsLoading}
        statsError={statsError}
        onRetryStats={onRetryStats}
      />

      <PayloadSizeMeter bytes={payloadBytes} />
    </div>
  );
}

// Compact "Xd Yh Zm" formatter for how-long-until-next-superblock
// copy in the tight-voting-window notice. Sub-minute granularity
// would imply precision we don't have (the backend's anchor is
// itself a projection of `(nNextSuperblock - nHeight) * 150s`),
// so we stop at whole minutes. Null guard returns an empty string
// so the caller can concatenate safely.
function humanizeDurationShort(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '';
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (days === 0 && mins > 0) parts.push(`${mins}m`);
  if (parts.length === 0) parts.push('< 1m');
  return parts.join(' ');
}

// Prominent banner shown on Payment + Review whenever the next
// superblock is inside the wizard's warning buffer
// (SUPERBLOCK_VOTE_DEADLINE_WARN_SEC, currently 4 days).
//
// Why it matters: Core forms the superblock payment-list
// candidate in the last ~3 days before the superblock
// (`nSuperblockMaturityWindow` = 1728 blocks). Each masternode
// independently picks a candidate, votes YES-FUNDING on it,
// and is then locked out of voting YES on any other trigger for
// this cycle (governance.cpp:727 asserts this). So a proposal
// submitted inside that 3-day window is racing masternode
// commits, and any MN that has already committed cannot
// retroactively include it. Our window intentionally excludes
// SB_{N+1} to prevent silent over-payment, so missing SB_1
// means the proposal pays out N-1 months instead of N.
//
// We fire the warning a day earlier than Core's 3-day maturity
// threshold to give MN operators at least ~24h of headroom
// between proposal submission and the earliest MN commit
// (covers collateral confirmation, relay, operator review,
// and vote propagation).
//
// Non-blocking by design: Prepare stays enabled. Some proposers
// are fine with N-1 (e.g. emergency funding), and we don't want
// to override their intent — we just make sure they see the
// trade-off before submitting.
function TightVotingWindowNotice({ nextSuperblockSec, paymentCount }) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (!isTightVotingWindow(nowSec, nextSuperblockSec)) return null;
  const secondsToSb = nextSuperblockSec - nowSec;
  const n = Math.floor(Number(paymentCount));
  const hasValidCount = Number.isInteger(n) && n >= 1;
  // If the user only asked for 1 month, there's nothing to
  // demote to (N-1 = 0), so the honest message is just "will
  // likely miss that superblock".
  const willLoseOnePayment = hasValidCount && n >= 2;
  return (
    <div
      className="proposal-wizard__tight-warning"
      role="alert"
      data-testid="tight-voting-window-warning"
    >
      <strong className="proposal-wizard__tight-warning-title">
        Tight voting window — masternodes may not have time to vote
      </strong>
      <p>
        The next superblock is in{' '}
        <strong>{humanizeDurationShort(secondsToSb)}</strong>. Syscoin
        Core forms the superblock payment list during the last{' '}
        ~3&nbsp;days before each superblock, and once a masternode
        has voted on that payment list it cannot change its vote
        for this cycle. Submitting now means your proposal{' '}
        <strong>will likely miss that superblock</strong>
        {willLoseOnePayment ? (
          <>
            {' '}
            and pay out{' '}
            <strong data-testid="tight-voting-window-warning-paid">
              {n - 1} month{n - 1 === 1 ? '' : 's'}
            </strong>{' '}
            instead of <strong>{n}</strong>
          </>
        ) : null}
        .
      </p>
      <p>
        If you need the full duration you requested, consider
        waiting for the next superblock cycle (~30&nbsp;days) so
        masternodes have time to see and vote on the proposal
        before the next payment list locks in. You can also
        proceed anyway — Prepare is still enabled — if you've
        coordinated with operators or are OK with one fewer
        payment.
      </p>
    </div>
  );
}

// Shared renderer for the derived voting window. Used under the
// duration input on the Payment step AND as the authoritative
// "Voting window" entry on the Review step. Keeping both call
// sites on the same component guarantees they render identical
// dates — which is exactly what the user will see on the live
// chain once the proposal goes through.
function WindowPreview({
  derivedWindow,
  nextSuperblockSec,
  statsLoading,
  statsError,
  onRetryStats,
}) {
  if (statsLoading && !nextSuperblockSec) {
    return (
      <div className="proposal-wizard__window-preview" aria-busy="true">
        <strong>Voting window</strong>
        <p className="proposal-wizard__help">
          Loading live superblock timing…
        </p>
      </div>
    );
  }
  if (statsError || !nextSuperblockSec) {
    return (
      <div
        className="proposal-wizard__window-preview proposal-wizard__window-preview--error"
        role="alert"
      >
        <strong>Voting window</strong>
        <p className="proposal-wizard__help">
          Couldn't fetch the next-superblock time from the backend.
          We need it to anchor the proposal's payment window.{' '}
          {onRetryStats ? (
            <button
              type="button"
              className="button button--ghost"
              onClick={onRetryStats}
            >
              Retry
            </button>
          ) : null}
        </p>
      </div>
    );
  }
  if (!derivedWindow) {
    return (
      <div className="proposal-wizard__window-preview">
        <strong>Voting window</strong>
        <p className="proposal-wizard__help">
          Enter a valid duration to see the derived voting window.
        </p>
      </div>
    );
  }
  return (
    <div
      className="proposal-wizard__window-preview"
      data-testid="window-preview"
    >
      <strong>Voting window (auto)</strong>
      <p className="proposal-wizard__help">
        Start:{' '}
        <time dateTime={new Date(derivedWindow.startEpoch * 1000).toISOString()}>
          {new Date(derivedWindow.startEpoch * 1000).toUTCString()}
        </time>
        <br />
        End:{' '}
        <time dateTime={new Date(derivedWindow.endEpoch * 1000).toISOString()}>
          {new Date(derivedWindow.endEpoch * 1000).toUTCString()}
        </time>
      </p>
      <p className="proposal-wizard__help">
        Anchored to the next superblock (
        {new Date(nextSuperblockSec * 1000).toUTCString()}). The start
        is placed ~15 days before the first payout and the end ~15 days
        after the last so each payment lands safely inside the window
        and the proposal prunes cleanly afterwards.
      </p>
    </div>
  );
}

// Format a UNIX-seconds timestamp as a short UTC calendar date. We
// intentionally drop the time portion in the schedule breakdown
// because the superblock-to-wall-clock projection drifts by a few
// hours and the clock portion would imply false precision.
function formatUtcDate(epochSec) {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(epochSec * 1000));
  } catch (_e) {
    return new Date(epochSec * 1000).toUTCString();
  }
}

// Build the projected payment schedule for the Review step.
//
// The schedule is derived from the same `derivedWindow` the user
// sees in the WindowPreview card (and that onPrepare submits on-
// chain), not from the raw `nextSuperblockSec` state. This matters:
// computeProposalWindow has an internal fallback to `now + cycle`
// when the anchor is missing / stale, while a raw-anchor projection
// would happily run off a stale timestamp. Sourcing both UI
// elements from the same canonical window means the Review
// schedule can never diverge from the submitted window, even if
// state were to drift stale between renders.
//
// The anchor for the first payment is reconstructed as
// `startEpoch + cycle/2`, mirroring computeProposalWindow's
// `startEpoch = anchor - cycle/2` invariant; the loop then walks
// forward by whole cycles for superblocks #1..#N. Unlike the
// legacy approximator this never needs a truncation warning —
// if derivedWindow is truthy the window fits N payments by
// construction (see lib/governanceWindow.js).
function buildProjectedSchedule({ derivedWindow, paymentCount }) {
  if (!derivedWindow) return [];
  const halfCycle = Math.floor(SUPERBLOCK_CYCLE_SEC / 2);
  const anchor = Number(derivedWindow.startEpoch) + halfCycle;
  const count = Math.floor(Number(paymentCount));
  if (!Number.isFinite(anchor) || anchor <= 0) return [];
  if (!Number.isFinite(count) || count <= 0) return [];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ index: i + 1, epochSec: anchor + i * SUPERBLOCK_CYCLE_SEC });
  }
  return out;
}

// Compute the total budget (SYS) for the review panel using exact
// BigInt sats arithmetic. We deliberately do NOT use
// `Number(amount) * Number(count)` here — governance proposals can
// carry very large amounts, and once amount_sats * count crosses
// 2^53 the IEEE-754 double collapses to a rounded neighbor. Since
// this block is the user's final confirmation before burning
// 150 SYS on collateral, showing a rounded total would be a
// silent correctness regression flagged by Codex review P2.
//
// The backend already canonicalizes amounts as sats strings
// (`sysToSatsString`) and renders them back with
// `satsStringToSys`; reusing those helpers keeps the UI display
// pipeline identical to the on-wire representation.
function computeTotalBudgetSys(amount, count) {
  const sats = sysToSatsString(typeof amount === 'string' ? amount : '');
  if (sats === null) return null;
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0) return null;
  try {
    const total = BigInt(sats) * BigInt(n);
    if (total <= 0n) return null;
    return satsStringToSys(total.toString());
  } catch (_err) {
    return null;
  }
}

function ReviewStep({
  form,
  payloadBytes,
  derivedWindow,
  nextSuperblockSec,
  statsLoading,
  statsError,
  onRetryStats,
}) {
  const paymentCountNum = Number(form.paymentCount);
  const totalBudgetSys = computeTotalBudgetSys(
    form.paymentAmount,
    form.paymentCount
  );
  const schedule =
    paymentCountNum >= 2 && derivedWindow
      ? buildProjectedSchedule({
          derivedWindow,
          paymentCount: paymentCountNum,
        })
      : [];

  return (
    <div className="proposal-wizard__panel" data-testid="wizard-panel-review">
      <h2>Review your proposal</h2>
      <p className="proposal-wizard__help">
        Double-check every field. Once prepared and the collateral
        transaction is sent, the on-chain record is immutable.
      </p>
      <dl className="proposal-wizard__summary">
        <dt>Name</dt>
        <dd data-testid="review-name">{form.name}</dd>
        <dt>URL</dt>
        <dd data-testid="review-url">
          <a href={form.url} target="_blank" rel="noopener noreferrer">
            {form.url}
          </a>
        </dd>
        <dt>Payment address</dt>
        <dd data-testid="review-address">{form.paymentAddress}</dd>
        <dt>Amount per payment</dt>
        <dd data-testid="review-amount">{form.paymentAmount} SYS</dd>
        <dt>Duration</dt>
        <dd data-testid="review-count">
          {form.paymentCount} month
          {Number(form.paymentCount) === 1 ? '' : 's'}
        </dd>
        {totalBudgetSys ? (
          <>
            <dt>Total budget</dt>
            <dd data-testid="review-total">{totalBudgetSys} SYS</dd>
          </>
        ) : null}
      </dl>

      <TightVotingWindowNotice
        nextSuperblockSec={nextSuperblockSec}
        paymentCount={form.paymentCount}
      />

      <WindowPreview
        derivedWindow={derivedWindow}
        nextSuperblockSec={nextSuperblockSec}
        statsLoading={statsLoading}
        statsError={statsError}
        onRetryStats={onRetryStats}
      />

      {schedule.length > 0 ? (
        <div
          className="proposal-wizard__schedule"
          data-testid="review-schedule"
        >
          <h3 className="proposal-wizard__schedule-heading">
            Projected payment schedule
          </h3>
          <p className="proposal-wizard__help">
            One payment per Syscoin superblock, starting at the
            next superblock. Actual payout timing drifts a few hours
            either way depending on network hash-rate; the voting
            window leaves ~15 days of margin on each side.
          </p>
          <ol
            className="proposal-wizard__schedule-list"
            data-testid="review-schedule-list"
          >
            {schedule.map((p) => (
              <li
                key={p.index}
                data-testid="review-schedule-row"
                data-payment-index={p.index}
              >
                <span className="proposal-wizard__schedule-idx">
                  #{p.index}
                </span>
                <span className="proposal-wizard__schedule-date">
                  ~ {formatUtcDate(p.epochSec)}
                </span>
                <span className="proposal-wizard__schedule-amount">
                  {form.paymentAmount} SYS
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="proposal-wizard__burn-warning" role="note">
        <strong>Heads up — 150 SYS will be burned.</strong>
        <p>
          When you press <em>Prepare proposal</em> the next step will
          ask you to send a <strong>150 SYS</strong> collateral
          transaction. This amount is <strong>not refundable</strong>
          — it is burned to the network by consensus design. You'll
          also pay standard transaction fees.
        </p>
      </div>

      <PayloadSizeMeter bytes={payloadBytes} />
    </div>
  );
}

function SubmitStep({
  prepared,
  txidInput,
  onTxidChange,
  attaching,
  attachError,
  onAttachCollateral,
  proposalServiceImpl,
  onPaliAttached,
}) {
  // IMPORTANT: every hook must run on every render regardless of
  // `prepared` — React's rules-of-hooks forbid conditional calls.
  // Compute the CLI command up-front with a safe fallback and only
  // branch the JSX below.
  const submission = prepared && prepared.submission;
  // Track Pali visibility at the wizard level too so the sibling
  // "Option B/C" manual-lane headings stay numbered correctly even
  // when PayWithPaliPanel renders nothing (no A). Uses the same
  // installed-now / installed-later poll as the panel, so labels
  // flip in lockstep with panel appearance. Codex PR14 P3.
  const paliPresent = usePaliAvailable();
  const manualOptionLabel = paliPresent ? 'Option B' : 'Option A';
  const walletOptionLabel = paliPresent ? 'Option C' : 'Option B';
  const cliCommand = useMemo(() => {
    if (!submission) return '';
    // Exactly matches the backend's hash inputs:
    //   parent_hash = "0", revision = 1, time = timeUnix
    // so pasting this into Syscoin-Qt produces the same proposal_hash
    // we already committed to in submission.proposalHash.
    const parent =
      submission.parentHash != null ? String(submission.parentHash) : '0';
    const revision =
      submission.revision != null ? String(submission.revision) : '1';
    const time =
      submission.timeUnix != null
        ? String(submission.timeUnix)
        : String(Math.floor(Date.now() / 1000));
    const dataHex = submission.dataHex || '';
    return `gobject prepare ${parent} ${revision} ${time} ${dataHex}`;
  }, [submission]);

  if (!prepared) {
    return (
      <div className="proposal-wizard__panel" data-testid="wizard-panel-submit">
        <p>
          No prepared submission yet. Go back to Review and prepare
          the proposal.
        </p>
      </div>
    );
  }

  const { opReturnHex, collateralFeeSats, requiredConfirmations } = prepared;

  async function copy(str) {
    try {
      await navigator.clipboard.writeText(str);
    } catch (_e) {
      /* best effort */
    }
  }

  return (
    <div className="proposal-wizard__panel" data-testid="wizard-panel-submit">
      <h2>Pay the 150 SYS collateral</h2>

      <div className="proposal-wizard__burn-warning" role="note">
        <strong>The 150 SYS collateral is burned, not refunded.</strong>
        <p>
          Syscoin consensus requires a 150 SYS burn fee to create a
          governance object. You will not get this back. Plan
          accordingly.
        </p>
      </div>

      <p>
        We committed your proposal to{' '}
        <code data-testid="submit-gov-hash">{submission.proposalHash}</code>.
        When the collateral transaction has{' '}
        <strong>{requiredConfirmations} confirmations</strong>, we'll
        automatically submit your governance object on-chain — nothing
        more to do on your end.
      </p>

      <PayWithPaliPanel
        submission={submission}
        proposalServiceImpl={proposalServiceImpl}
        onAttached={onPaliAttached}
      />

      <h3>{manualOptionLabel} — Pay manually from Syscoin-Qt or syscoin-cli</h3>
      <ol className="proposal-wizard__steps-list">
        <li>
          Open Syscoin-Qt's <em>Debug console</em> (or your CLI) and
          paste:
          <pre
            className="proposal-wizard__cli"
            data-testid="submit-cli-command"
          >
            <code>{cliCommand}</code>
          </pre>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => copy(cliCommand)}
            data-testid="submit-copy-cli"
          >
            Copy command
          </button>
        </li>
        <li>
          Core will broadcast the 150 SYS burn transaction and print
          the <strong>collateral TXID</strong>. Paste it below.
        </li>
      </ol>

      <h3>{walletOptionLabel} — Using a different wallet?</h3>
      <p>
        Any wallet that can send to an address with an extra{' '}
        <code>OP_RETURN</code> output works. Send{' '}
        <strong>{fmtSys(collateralFeeSats || COLLATERAL_FEE_SATS)} SYS</strong>{' '}
        to an unspendable burn output alongside an <code>OP_RETURN</code>{' '}
        carrying the following bytes:
      </p>
      <pre
        className="proposal-wizard__cli proposal-wizard__cli--mono"
        data-testid="submit-op-return"
      >
        <code>{opReturnHex}</code>
      </pre>
      <button
        type="button"
        className="button button--ghost button--small"
        onClick={() => copy(opReturnHex)}
      >
        Copy OP_RETURN bytes
      </button>

      <h3>Paste the collateral TXID</h3>
      <label className="form-field">
        <span>Collateral TXID</span>
        <input
          type="text"
          value={txidInput}
          onChange={(e) => onTxidChange(e.target.value)}
          placeholder="64-character hex txid"
          aria-invalid={!!attachError}
          data-testid="submit-txid-input"
        />
        <small>
          We'll watch it and auto-submit once it has{' '}
          {requiredConfirmations} confirmations.
        </small>
      </label>
      {attachError ? (
        <div className="auth-alert auth-alert--error" role="alert">
          {attachError.code === 'malformed_txid'
            ? 'That does not look like a 64-character hex TXID.'
            : `Could not attach TXID: ${attachError.code || 'unknown_error'}`}
        </div>
      ) : null}

      <button
        type="button"
        className="button button--primary"
        onClick={onAttachCollateral}
        disabled={attaching || !txidInput}
        data-testid="submit-attach-btn"
      >
        {attaching ? 'Submitting…' : 'Attach TXID & watch'}
      </button>
    </div>
  );
}


function PayloadSizeMeter({ bytes }) {
  const pct = Math.min(100, Math.round((bytes / MAX_DATA_SIZE) * 100));
  const over = bytes > MAX_DATA_SIZE;
  return (
    <div
      className={
        'proposal-wizard__meter' +
        (over ? ' proposal-wizard__meter--over' : '')
      }
      data-testid="wizard-payload-meter"
    >
      <div
        className="proposal-wizard__meter-bar"
        style={{ width: `${pct}%` }}
        aria-hidden="true"
      />
      <span>
        {bytes} / {MAX_DATA_SIZE} bytes
        {over ? ' — over the on-chain limit' : ''}
      </span>
    </div>
  );
}
