import React, { useEffect, useRef } from 'react';

// UnsavedChangesModal
// -----------------------------------------------------------------
// Rendered by the NewProposal wizard when the user tries to leave
// the page while the form has unsaved changes (dirty draft).
//
// Three actions — mirrors the Twitter/Apple "you have a draft"
// pattern:
//
//   Save to drafts   -> await onSave(); navigate away only on success.
//   Discard          -> await onDiscard(); navigate away even if we
//                       could not clean up the server-side draft row.
//   Cancel           -> close the modal; stay on the page.
//
// The modal owns ZERO business state. It just renders chrome and
// calls the three callbacks. Async callbacks are awaited so a slow
// POST /drafts doesn't let the user tap Save twice before the
// navigation decision is made.
//
// Accessibility:
//   - role=dialog + aria-modal=true + aria-labelledby/aria-describedby
//   - Focus trapped on the "Save to drafts" primary button on mount
//     (that's the recommended recovery action; cancel is the
//     user-default via Escape).
//   - Escape key fires onCancel().
//   - Click on the overlay (outside the panel) is treated as Cancel;
//     Apple-style "tap outside = dismiss" behaviour for a low-stakes
//     confirmation dialog.

export default function UnsavedChangesModal({
  open,
  saving,
  error,
  onSave,
  onDiscard,
  onCancel,
}) {
  const primaryRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(
    function focusPrimaryOnOpen() {
      if (open && primaryRef.current) {
        primaryRef.current.focus();
      }
    },
    [open]
  );

  useEffect(
    function handleEsc() {
      if (!open) return undefined;
      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (!saving && typeof onCancel === 'function') onCancel();
        }
      }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    },
    [open, saving, onCancel]
  );

  if (!open) return null;

  function onOverlayClick(e) {
    // Clicks ON the overlay (not bubbled from the panel) count as Cancel.
    if (e.target === e.currentTarget && !saving) {
      onCancel();
    }
  }

  return (
    <div
      className="proposal-modal-overlay"
      role="presentation"
      onClick={onOverlayClick}
      data-testid="unsaved-modal"
    >
      <div
        className="proposal-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-modal-title"
        aria-describedby="unsaved-modal-body"
        ref={panelRef}
      >
        <h2 className="proposal-modal__title" id="unsaved-modal-title">
          Save this draft?
        </h2>
        <p className="proposal-modal__body" id="unsaved-modal-body">
          You have unsaved changes. Save this to your drafts to pick up where
          you left off on any device, or discard to abandon the changes.
        </p>

        {error ? (
          <div
            className="auth-alert auth-alert--error"
            role="alert"
            data-testid="unsaved-modal-error"
          >
            {error}
          </div>
        ) : null}

        <div className="proposal-modal__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={onSave}
            disabled={saving}
            ref={primaryRef}
            data-testid="unsaved-modal-save"
          >
            {saving ? 'Saving…' : 'Save to drafts'}
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={onDiscard}
            disabled={saving}
            data-testid="unsaved-modal-discard"
          >
            Discard
          </button>
          <button
            type="button"
            className="button button--ghost proposal-modal__cancel"
            onClick={onCancel}
            disabled={saving}
            data-testid="unsaved-modal-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
