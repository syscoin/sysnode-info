import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  buildKeysFromValidRows,
  addKeys,
  normalisePayload,
  previewImportInput,
  summariseRows,
  validateImportEntryAsync,
} from '../lib/vaultData';
import { useAuth } from '../context/AuthContext';
import { useVault } from '../context/VaultContext';
import { authService as defaultAuthService } from '../lib/authService';

// VaultImportModal
// -----------------------------------------------------------------------
// Two-phase import UX:
//
//   1. Paste → Validate
//      User pastes one secret per line. Supported forms:
//        * `<wif>`
//        * `<wif>,<label>`
//        * `<descriptor>`
//        * `<descriptor>,<address>`
//        * `<descriptor>,<address>,<label>`
//      Every line is validated locally and rendered as valid / invalid /
//      duplicate. NOTHING persists in this phase; no network I/O
//      happens. The user can iterate on the paste until the summary
//      looks right.
//
//   2. Validate → Save
//      Confirmed import calls vault.save() with the new combined
//      payload. From the EMPTY state this is the *first write*, so
//      the modal also collects the password (and uses the user's
//      email from AuthContext) so VaultContext can derive the
//      vaultKey. From UNLOCKED it reuses the cached vaultKey under
//      the hood.
//
// Security-sensitive notes:
//   * The password field auto-clears on successful save AND on
//     close, via the cleanup effect below. We do NOT store the
//     password anywhere else.
//   * WIFs live in React state only for the duration of this modal;
//     closing the modal wipes the textarea. We accept that an open
//     modal leaves WIFs in the React tree — there is nowhere else
//     for them to go between paste and encrypt — and rely on the
//     page lifecycle to reclaim them.
//   * Per-row status is purely derived from the textarea content, so
//     re-typing corrects the status without the user having to
//     re-run a validate step.

const COPY_EMPTY_TITLE = 'Import voting keys';
const COPY_UNLOCKED_TITLE = 'Add more voting keys';
const VALIDATION_ROW_BATCH_SIZE = 25;

function rowStatusLabel(row) {
  if (row.kind === 'pending') return 'Validating…';
  if (row.kind === 'valid') return 'Ready';
  if (row.kind === 'duplicate') {
    return row.reason === 'already_in_vault'
      ? 'Already in vault'
      : 'Duplicate in paste';
  }
  return row.message || 'Invalid';
}

function rowStatusClass(row) {
  if (row.kind === 'pending') return 'is-warning';
  if (row.kind === 'valid') return 'is-positive';
  if (row.kind === 'duplicate') return 'is-warning';
  return 'is-negative';
}

function lineBounds(text, lineNo) {
  const lines = String(text || '').split('\n');
  if (lineNo < 1 || lineNo > lines.length) return null;
  let start = 0;
  for (let i = 0; i < lineNo - 1; i += 1) {
    start += lines[i].length + 1;
  }
  return { start, end: start + lines[lineNo - 1].length };
}

export default function VaultImportModal({
  open,
  onClose,
  authService = defaultAuthService,
}) {
  const vault = useVault();
  const { user } = useAuth();

  const [paste, setPaste] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);
  const [validating, setValidating] = useState(false);

  const pasteRef = useRef(null);
  const passwordRef = useRef(null);
  const validationGenRef = useRef(0);

  // Latest-`saving` ref. The ESC keydown handler is registered in an
  // effect keyed only on `open` so the listener isn't churned on every
  // keystroke; reading `saving` through a ref guarantees that ESC
  // observes the *current* saving state rather than whatever value was
  // captured at effect-setup time.
  const savingRef = useRef(false);
  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  const requiresPassword = vault.isEmpty;

  const summary = useMemo(() => summariseRows(rows), [rows]);

  const applyPastePreview = useCallback(
    (nextPaste) => {
      validationGenRef.current += 1;
      const { entries, rows: pendingRows } = previewImportInput(
        nextPaste,
        vault.data || undefined
      );
      setRows(pendingRows);
      setValidating(entries.some((entry) => entry.wif !== ''));
    },
    [vault.data]
  );

  const selectPasteLine = useCallback(
    (lineNo) => {
      const bounds = lineBounds(paste, lineNo);
      if (!bounds || !pasteRef.current) return;
      const textarea = pasteRef.current;
      textarea.focus();
      textarea.setSelectionRange(bounds.start, bounds.end);

      const lineHeight =
        parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
      textarea.scrollTop = Math.max(
        0,
        (lineNo - 1) * lineHeight - textarea.clientHeight / 2
      );
    },
    [paste]
  );

  const removePasteLine = useCallback(
    (lineNo) => {
      const lines = paste.split('\n');
      if (lineNo < 1 || lineNo > lines.length) return;
      lines.splice(lineNo - 1, 1);
      const nextPaste = lines.join('\n');
      applyPastePreview(nextPaste);
      setPaste(nextPaste);
      setTimeout(() => {
        if (pasteRef.current) pasteRef.current.focus();
      }, 0);
    },
    [applyPastePreview, paste]
  );

  // Save is enabled whenever there's something importable. The password
  // requirement is enforced inside onSave so the user gets an explicit
  // "please enter your password" error (with the input outlined red and
  // focused) instead of a silently-disabled button — clicking a disabled
  // button leaves the user with no signal about which field is missing.
  const canSave = !saving && !validating && summary.valid > 0;
  // Password-field failures: empty is a local pre-flight failure;
  // password_mismatch is the server-side verification result for the
  // EMPTY first-write path.
  // A mismatch is far more likely than a network blip — so we treat
  // it as a password-field error rather than a generic banner.
  const passwordError =
    error === 'password_required' || error === 'password_mismatch';

  // verifyAuthHash callback for VaultContext.save() on the EMPTY path.
  // The vault password and the account password are the same secret;
  // VaultContext derives an authHash from the typed password and asks
  // us to confirm it against the server before encrypting under the
  // matching vaultKey. authService.verifyPassword normalises a 401 to
  // `{ code: 'invalid_credentials' }`, which VaultContext re-tags to
  // `password_mismatch`. We pass it through unchanged.
  const verifyAuthHash = useCallback(
    (authHash) => authService.verifyPassword({ authHash }),
    [authService]
  );

  // ESC closes, focus lands in the textarea on open, state resets on
  // close. Done as a single effect keyed on `open` so the lifecycle
  // is obvious.
  useEffect(() => {
    if (!open) {
      validationGenRef.current += 1;
      setPaste('');
      setPassword('');
      setSaving(false);
      setError(null);
      setRows([]);
      setValidating(false);
      return undefined;
    }
    const t = setTimeout(() => {
      if (pasteRef.current) pasteRef.current.focus();
    }, 0);
    function onKey(e) {
      // Read saving via ref so the guard always sees the current value
      // even though this handler is only registered once per `open`.
      if (e.key === 'Escape' && !savingRef.current) {
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const myGen = ++validationGenRef.current;
    const { entries, rows: pendingRows } = previewImportInput(
      paste,
      vault.data || undefined
    );
    setRows(pendingRows);

    const pendingEntries = entries.filter((e) => e.wif !== '');
    if (pendingEntries.length === 0) {
      setValidating(false);
      return undefined;
    }

    const base = normalisePayload(vault.data || undefined);
    const state = {
      seenAddr: new Set(base.keys.map((k) => k.address)),
      seenWif: new Set(base.keys.map((k) => k.wif)),
      addrSeenThisBatch: new Set(),
      wifSeenThisBatch: new Set(),
    };

    let cancelled = false;
    setValidating(true);
    const isValidationCancelled = () =>
      cancelled || validationGenRef.current !== myGen;
    const rowUpdates = new Map();
    const flushRowUpdates = () => {
      if (rowUpdates.size === 0) return;
      const batch = new Map(rowUpdates);
      rowUpdates.clear();
      setRows((prev) =>
        prev.map((row) => {
          const nextRow = batch.get(row.lineNo);
          return nextRow ? { ...row, ...nextRow } : row;
        })
      );
    };

    (async () => {
      for (let i = 0; i < pendingEntries.length; i += 1) {
        const result = await validateImportEntryAsync(pendingEntries[i], state, {
          isCancelled: isValidationCancelled,
        });
        if (cancelled || validationGenRef.current !== myGen) return;
        rowUpdates.set(result.lineNo, result);
        if (
          rowUpdates.size >= VALIDATION_ROW_BATCH_SIZE ||
          i === pendingEntries.length - 1
        ) {
          flushRowUpdates();
        }
      }
      if (!cancelled && validationGenRef.current === myGen) {
        setValidating(false);
      }
    })().catch((e) => {
      if (
        !cancelled &&
        validationGenRef.current === myGen &&
        ((e && e.code) || '') !== 'validation_cancelled'
      ) {
        setValidating(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, paste, vault.data]);

  const onSave = useCallback(
    async function onSave() {
      if (!canSave) return;
      setSaving(true);
      setError(null);
      try {
        if (requiresPassword) {
          // Empty input gets the explicit "please enter your password"
          // copy. Non-empty values are checked by /auth/verify-password:
          // this is current-password re-auth, not a new-password policy
          // gate, so the server is authoritative.
          if (password === '') {
            setError('password_required');
            if (passwordRef.current) passwordRef.current.focus();
            return;
          }
        }
        const nowMs = Date.now();
        const newKeys = buildKeysFromValidRows(rows, nowMs);
        const basePayload = vault.data || { version: 1, keys: [] };
        const nextPayload = addKeys(basePayload, newKeys);
        const saveOpts = requiresPassword
          ? {
              password,
              email: user && user.email,
              verifyAuthHash,
            }
          : undefined;
        await vault.save(nextPayload, saveOpts);
        setPassword('');
        setPaste('');
        onClose();
      } catch (e) {
        const code = (e && e.code) || 'save_failed';
        setError(code);
        // For the password-field error class (empty / mismatch)
        // we pull focus straight into the input so the user's next
        // keystroke lands there rather than getting lost in the
        // banner. The empty-string check already does this for the
        // local pre-flight failure; this branch covers the asynchronous
        // server-verification result.
        if (code === 'password_mismatch' && passwordRef.current) {
          passwordRef.current.focus();
        }
      } finally {
        setSaving(false);
      }
    },
    [
      canSave,
      rows,
      vault,
      requiresPassword,
      password,
      user,
      onClose,
      verifyAuthHash,
    ]
  );

  if (!open) return null;

  return (
    <div
      className="vault-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vault-import-title"
      data-testid="vault-import-modal"
    >
      <button
        type="button"
        className="vault-modal__backdrop"
        aria-label="Close import"
        onClick={saving ? undefined : onClose}
        tabIndex={-1}
      />
      <div className="vault-modal__panel auth-card">
        <div className="vault-modal__head">
          <h2 className="auth-card__title" id="vault-import-title">
            {requiresPassword ? COPY_EMPTY_TITLE : COPY_UNLOCKED_TITLE}
          </h2>
          <button
            type="button"
            className="auth-linklike"
            onClick={saving ? undefined : onClose}
            data-testid="vault-import-close"
          >
            Close
          </button>
        </div>

        <p className="auth-card__hint">
          Paste one voting WIF or private descriptor per line. You can
          optionally add a label after a comma, for example{' '}
          <code>KwDi…,MN&nbsp;1</code>. Fixed descriptors can be pasted on
          their own; ranged descriptors ending in <code>{'/*'}</code> also
          need the voting address, for example{' '}
          <code>{'<descriptor>,sys1…,MN 1'}</code>. Keys are validated in
          your browser before anything is encrypted or sent — the paste
          never leaves this tab in the clear.
        </p>

        <div className="auth-field">
          <label className="auth-label" htmlFor="vault-import-paste">
            Voting keys
          </label>
          <textarea
            id="vault-import-paste"
            ref={pasteRef}
            className="auth-input vault-modal__textarea"
            rows={8}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={paste}
            onChange={(e) => {
              const nextPaste = e.target.value;
              applyPastePreview(nextPaste);
              setPaste(nextPaste);
            }}
            data-testid="vault-import-paste"
          />
        </div>

        {rows.length > 0 ? (
          <div
            className="import-rows"
            data-testid="vault-import-rows"
          >
            <div className="import-rows__summary">
              <span className="status-chip is-positive">
                {summary.valid} ready
              </span>{' '}
              {summary.pending > 0 ? (
                <span className="status-chip is-warning">
                  {summary.pending} validating
                </span>
              ) : null}{' '}
              {summary.duplicate > 0 ? (
                <span className="status-chip is-warning">
                  {summary.duplicate} duplicate
                </span>
              ) : null}{' '}
              {summary.invalid > 0 ? (
                <span className="status-chip is-negative">
                  {summary.invalid} invalid
                </span>
              ) : null}
            </div>
            <ul className="import-rows__list">
              {rows.map((r) => {
                const canEditSource =
                  r.kind === 'invalid' || r.kind === 'duplicate';
                return (
                  <li
                    key={`${r.lineNo}:${r.wif}`}
                    className={`import-row import-row--${r.kind}${
                      canEditSource ? ' import-row--actionable' : ''
                    }`}
                    data-testid="vault-import-row"
                    onClick={
                      canEditSource ? () => selectPasteLine(r.lineNo) : undefined
                    }
                    onKeyDown={
                      canEditSource
                        ? (e) => {
                            if (e.target !== e.currentTarget) return;
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              selectPasteLine(r.lineNo);
                            }
                          }
                        : undefined
                    }
                    role={canEditSource ? 'button' : undefined}
                    tabIndex={canEditSource ? 0 : undefined}
                  >
                    <span
                      className={`status-chip ${rowStatusClass(r)} import-row__status`}
                    >
                      {rowStatusLabel(r)}
                    </span>
                    <span className="import-row__detail">
                      {r.kind === 'valid' ? (
                        <>
                          <code className="import-row__addr">{r.address}</code>
                          {r.label ? (
                            <span className="import-row__label">
                              {r.label}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <code className="import-row__addr">
                          Line {r.lineNo}
                          {r.label ? ` — ${r.label}` : ''}
                        </code>
                      )}
                    </span>
                    {canEditSource ? (
                      <button
                        type="button"
                        className="import-row__remove"
                        aria-label={`Remove line ${r.lineNo}`}
                        title={`Remove line ${r.lineNo}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removePasteLine(r.lineNo);
                        }}
                      >
                        x
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {requiresPassword ? (
          <div className="auth-field">
            <label className="auth-label" htmlFor="vault-import-password">
              Current password
            </label>
            <input
              id="vault-import-password"
              ref={passwordRef}
              type="password"
              autoComplete="current-password"
              className={`auth-input${
                passwordError ? ' auth-input--error' : ''
              }`}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                // Drop the password-specific error as soon as the user
                // starts typing so the red outline + banner clear; we
                // leave unrelated errors (e.g. vault_stale) in place.
                if (passwordError) setError(null);
              }}
              aria-invalid={passwordError ? 'true' : undefined}
              aria-describedby={
                passwordError ? 'vault-import-error' : undefined
              }
              data-testid="vault-import-password"
            />
            <span className="auth-hint">
              Use the password you signed in with — your account password
              is also the key that encrypts your vault on this device.
              It is never sent to the server.
            </span>
          </div>
        ) : null}

        {error ? (
          <div
            id="vault-import-error"
            className="auth-alert auth-alert--error"
            role="alert"
            data-testid="vault-import-error"
          >
            {error === 'password_required'
              ? 'Please enter your current password.'
              : error === 'password_mismatch'
              ? "That doesn't match your account password. Enter the password you used to sign in."
              : error === 'vault_stale'
              ? 'Your vault changed in another tab. Close this dialog and try again.'
              : error === 'network_error'
              ? "We couldn't reach the sysnode server. Check your connection and try again."
              : `Import failed (${error}). Please retry.`}
          </div>
        ) : null}

        <div className="vault-modal__actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={onClose}
            disabled={saving}
            data-testid="vault-import-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!canSave}
            onClick={onSave}
            data-testid="vault-import-save"
          >
            {saving
              ? 'Encrypting…'
              : validating
              ? 'Validating…'
              : summary.valid === 0
              ? 'Paste keys to import'
              : `Import ${summary.valid} key${summary.valid === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
