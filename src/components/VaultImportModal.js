import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  parseImportInput,
  buildKeysFromValidRows,
  addKeys,
} from '../lib/vaultData';
import { useAuth } from '../context/AuthContext';
import { useVault } from '../context/VaultContext';

// VaultImportModal
// -----------------------------------------------------------------------
// Two-phase import UX:
//
//   1. Paste → Validate
//      User pastes one-WIF-per-line or `<wif>,<label>`. We run every
//      line through the WIF validator and render per-row status
//      (valid / invalid / duplicate). NOTHING persists in this phase;
//      no network I/O happens. The user can iterate on the paste
//      until the summary looks right.
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

function rowStatusLabel(row) {
  if (row.kind === 'valid') return 'Ready';
  if (row.kind === 'duplicate') {
    return row.reason === 'already_in_vault'
      ? 'Already in vault'
      : 'Duplicate in paste';
  }
  return row.message || 'Invalid';
}

function rowStatusClass(row) {
  if (row.kind === 'valid') return 'is-positive';
  if (row.kind === 'duplicate') return 'is-warning';
  return 'is-negative';
}

export default function VaultImportModal({ open, onClose }) {
  const vault = useVault();
  const { user } = useAuth();

  const [paste, setPaste] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const pasteRef = useRef(null);

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

  // Validation is pure / cheap (a few thousand rows takes <10ms), so
  // we derive it on every render. If the paste grows huge we can
  // memoise; for now `useMemo` is overkill.
  const { rows, summary } = useMemo(
    () => parseImportInput(paste, vault.data || undefined),
    [paste, vault.data]
  );

  const canSave =
    !saving &&
    summary.valid > 0 &&
    (!requiresPassword || password.length > 0);

  // ESC closes, focus lands in the textarea on open, state resets on
  // close. Done as a single effect keyed on `open` so the lifecycle
  // is obvious.
  useEffect(() => {
    if (!open) {
      setPaste('');
      setPassword('');
      setSaving(false);
      setError(null);
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

  const onSave = useCallback(
    async function onSave() {
      if (!canSave) return;
      setSaving(true);
      setError(null);
      try {
        const nowMs = Date.now();
        const newKeys = buildKeysFromValidRows(rows, nowMs);
        const basePayload = vault.data || { version: 1, keys: [] };
        const nextPayload = addKeys(basePayload, newKeys);
        const saveOpts = requiresPassword
          ? { password, email: user && user.email }
          : undefined;
        await vault.save(nextPayload, saveOpts);
        setPassword('');
        setPaste('');
        onClose();
      } catch (e) {
        setError((e && e.code) || 'save_failed');
      } finally {
        setSaving(false);
      }
    },
    [canSave, rows, vault, requiresPassword, password, user, onClose]
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
          Paste one voting WIF per line. You can optionally add a label
          after a comma, for example{' '}
          <code>KwDi…,MN&nbsp;1</code>. Keys are validated in your
          browser before anything is encrypted or sent — the paste
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
            onChange={(e) => setPaste(e.target.value)}
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
              {rows.map((r) => (
                <li
                  key={`${r.lineNo}:${r.wif}`}
                  className={`import-row import-row--${r.kind}`}
                  data-testid="vault-import-row"
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
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {requiresPassword ? (
          <div className="auth-field">
            <label className="auth-label" htmlFor="vault-import-password">
              Password
            </label>
            <input
              id="vault-import-password"
              type="password"
              autoComplete="current-password"
              className="auth-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="vault-import-password"
            />
            <span className="auth-hint">
              We need your account password to derive the vault key.
              It stays on this device — the server never sees it.
            </span>
          </div>
        ) : null}

        {error ? (
          <div
            className="auth-alert auth-alert--error"
            role="alert"
            data-testid="vault-import-error"
          >
            {error === 'password_required'
              ? 'Please enter your password.'
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
              : summary.valid === 0
              ? 'Paste keys to import'
              : `Import ${summary.valid} key${summary.valid === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
