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
import UnsavedChangesModal from '../components/UnsavedChangesModal';
import { useAuth } from '../context/AuthContext';
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
//  - Submit step is two lanes: Pali (stubbed for this PR — the module
//    rejects payWithOpReturn with `pali_psbt_builder_not_wired`) and
//    the manual Syscoin-Qt / syscoin-cli fallback. The copy makes
//    clear that 150 SYS is BURNED (not refunded) and that 6
//    confirmations are required before the backend auto-submits.
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

  const dirty = !formsEqual(form, baseline) && prepared == null;

  // ---- Draft load -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    if (!draftIdFromUrl) return () => {};
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

  const stepValid = useMemo(() => {
    if (stepIdx === 0) return Object.keys(basicsErrors).length === 0;
    if (stepIdx === 1) return Object.keys(paymentErrors).length === 0;
    return true;
  }, [stepIdx, basicsErrors, paymentErrors]);

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
    const body = draftBodyFromForm(savedSnapshot);
    try {
      let result;
      if (draftId) {
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
      const body = prepareBodyFromForm(form, {
        draftId: draftId || undefined,
        consumeDraft: true,
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
            />
          ) : null}
          {currentStep === 'review' ? (
            <ReviewStep form={form} payloadBytes={payloadBytes} />
          ) : null}
          {currentStep === 'submit' ? (
            <SubmitStep
              prepared={prepared}
              txidInput={txidInput}
              onTxidChange={setTxidInput}
              attaching={attaching}
              attachError={attachError}
              onAttachCollateral={onAttachCollateral}
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
              {draftSavedAt && !savingDraft && !saveDraftError ? (
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
                  onClick={() => setStepIdx((i) => i + 1)}
                  disabled={!stepValid}
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
                    Object.keys(paymentErrors).length > 0
                  }
                  data-testid="wizard-prepare"
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

function PaymentStep({ form, errors, touched, onField, onBlur, payloadBytes }) {
  return (
    <div className="proposal-wizard__panel" data-testid="wizard-panel-payment">
      <h2>Payment details</h2>
      <p className="proposal-wizard__help">
        Specify the Syscoin address that will receive the monthly
        superblock payment, the amount per month, and the voting
        window. Start and end times are UTC epoch seconds.
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

        <label className="form-field">
          <span>Number of payments (months)</span>
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
            Informational only. Voters see this in the UI; not stored
            on-chain. Max {MAX_PAYMENT_COUNT}.
          </small>
        </label>
        {touched.paymentCount ? (
          <FieldError id="err-paymentCount" message={errors.paymentCount} />
        ) : null}
      </div>

      <div className="proposal-wizard__row">
        <label className="form-field">
          <span>Start (UTC epoch seconds)</span>
          <input
            type="number"
            value={form.startEpoch}
            onChange={(e) => onField('startEpoch', e.target.value)}
            onBlur={() => onBlur('startEpoch')}
            aria-invalid={touched.startEpoch && !!errors.startEpoch}
            aria-describedby={
              errors.startEpoch ? 'err-startEpoch' : undefined
            }
            data-testid="wizard-field-start"
          />
          <small>
            {form.startEpoch && Number(form.startEpoch) > 0
              ? new Date(Number(form.startEpoch) * 1000).toUTCString()
              : 'Use a future UTC time.'}
          </small>
        </label>
        {touched.startEpoch ? (
          <FieldError id="err-startEpoch" message={errors.startEpoch} />
        ) : null}

        <label className="form-field">
          <span>End (UTC epoch seconds)</span>
          <input
            type="number"
            value={form.endEpoch}
            onChange={(e) => onField('endEpoch', e.target.value)}
            onBlur={() => onBlur('endEpoch')}
            aria-invalid={touched.endEpoch && !!errors.endEpoch}
            aria-describedby={errors.endEpoch ? 'err-endEpoch' : undefined}
            data-testid="wizard-field-end"
          />
          <small>
            {form.endEpoch && Number(form.endEpoch) > 0
              ? new Date(Number(form.endEpoch) * 1000).toUTCString()
              : 'Must be after start.'}
          </small>
        </label>
        {touched.endEpoch ? (
          <FieldError id="err-endEpoch" message={errors.endEpoch} />
        ) : null}
      </div>

      <PayloadSizeMeter bytes={payloadBytes} />
    </div>
  );
}

function ReviewStep({ form, payloadBytes }) {
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
        <dt>Amount per month</dt>
        <dd data-testid="review-amount">{form.paymentAmount} SYS</dd>
        <dt>Number of payments</dt>
        <dd data-testid="review-count">{form.paymentCount}</dd>
        <dt>Voting window</dt>
        <dd>
          {new Date(Number(form.startEpoch) * 1000).toUTCString()}
          <br />→{' '}
          {new Date(Number(form.endEpoch) * 1000).toUTCString()}
        </dd>
      </dl>

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
}) {
  // IMPORTANT: every hook must run on every render regardless of
  // `prepared` — React's rules-of-hooks forbid conditional calls.
  // Compute the CLI command up-front with a safe fallback and only
  // branch the JSX below.
  const submission = prepared && prepared.submission;
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

      <h3>Option A — Pay manually from Syscoin-Qt or syscoin-cli</h3>
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

      <h3>Option B — Using a different wallet?</h3>
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
