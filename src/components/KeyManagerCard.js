import React, { useCallback, useState } from 'react';

import { useVault } from '../context/VaultContext';
import { removeKey, updateKeyLabel } from '../lib/vaultData';
import VaultImportModal from './VaultImportModal';

// KeyManagerCard
// -----------------------------------------------------------------------
// Rendered inside the UNLOCKED branch of VaultStatusCard. Lists the
// user's imported voting keys and provides three per-row actions
// (edit label, remove) plus a top-level "Add keys" action that opens
// VaultImportModal.
//
// All mutations route through `vault.save(nextPayload)` so the
// ETag/If-Match pipeline, session invalidation, and concurrent-save
// guards in VaultContext stay centralised. This component never
// touches vaultService directly.
//
// Address display is deliberately full-width (not truncated):
// masternode operators reconcile these against their masternode
// config file or `protx_info` output, and truncating a bech32 address
// hurts that workflow. Long lists scroll inside the card rather than
// pushing the page.

function LabelEditor({ initial, onSave, onCancel }) {
  const [value, setValue] = useState(initial || '');
  return (
    <form
      className="key-row__edit"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value);
      }}
    >
      <input
        type="text"
        className="auth-input key-row__edit-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
        maxLength={120}
        data-testid="key-row-edit-input"
      />
      <button
        type="submit"
        className="button button--primary button--small"
        data-testid="key-row-edit-save"
      >
        Save
      </button>
      <button
        type="button"
        className="button button--ghost button--small"
        onClick={onCancel}
        data-testid="key-row-edit-cancel"
      >
        Cancel
      </button>
    </form>
  );
}

export default function KeyManagerCard() {
  const vault = useVault();
  const [importOpen, setImportOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [pendingRemoveId, setPendingRemoveId] = useState(null);
  const [mutating, setMutating] = useState(false);
  const [mutationError, setMutationError] = useState(null);

  const keys = (vault.data && Array.isArray(vault.data.keys)
    ? vault.data.keys
    : []);

  const onOpenImport = useCallback(() => {
    setImportOpen(true);
    setMutationError(null);
  }, []);

  const onCloseImport = useCallback(() => {
    setImportOpen(false);
  }, []);

  const onSaveLabel = useCallback(
    async function onSaveLabel(id, label) {
      if (mutating) return;
      setMutating(true);
      setMutationError(null);
      try {
        const next = updateKeyLabel(vault.data, id, label);
        await vault.save(next);
        setEditingId(null);
      } catch (e) {
        setMutationError((e && e.code) || 'save_failed');
      } finally {
        setMutating(false);
      }
    },
    [mutating, vault]
  );

  const onConfirmRemove = useCallback(
    async function onConfirmRemove(id) {
      if (mutating) return;
      setMutating(true);
      setMutationError(null);
      try {
        const next = removeKey(vault.data, id);
        await vault.save(next);
        setPendingRemoveId(null);
      } catch (e) {
        setMutationError((e && e.code) || 'save_failed');
      } finally {
        setMutating(false);
      }
    },
    [mutating, vault]
  );

  return (
    <>
      <div className="key-manager__header">
        <div>
          <h3 className="key-manager__title">
            Your voting keys
            <span className="key-manager__count" data-testid="key-count">
              {keys.length}
            </span>
          </h3>
          <p className="auth-card__hint key-manager__hint">
            Decrypted in this browser tab only. Lock the vault when
            you're done to wipe the plaintext from memory.
          </p>
        </div>
        <div className="key-manager__actions">
          <button
            type="button"
            className="button button--primary button--small"
            onClick={onOpenImport}
            data-testid="key-manager-import"
          >
            Add keys
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={vault.lock}
            data-testid="vault-lock"
          >
            Lock vault
          </button>
        </div>
      </div>

      {mutationError ? (
        <div
          className="auth-alert auth-alert--error"
          role="alert"
          data-testid="key-manager-error"
        >
          {mutationError === 'vault_stale'
            ? 'Your vault changed in another tab. Refresh to reconcile and try again.'
            : mutationError === 'network_error'
            ? "We couldn't reach the sysnode server. Check your connection and try again."
            : `Save failed (${mutationError}). Please retry.`}
        </div>
      ) : null}

      {keys.length === 0 ? (
        <p className="auth-card__hint" data-testid="key-list-empty">
          Your vault is unlocked, but you haven't added any voting keys
          yet. Click "Add keys" to import.
        </p>
      ) : (
        <ul className="key-list" data-testid="key-list">
          {keys.map((k) => {
            const isEditing = editingId === k.id;
            const isConfirming = pendingRemoveId === k.id;
            return (
              <li
                key={k.id}
                className="key-row"
                data-testid="key-row"
                data-key-id={k.id}
              >
                <div className="key-row__meta">
                  <code className="key-row__address" data-testid="key-address">
                    {k.address}
                  </code>
                  {isEditing ? (
                    <LabelEditor
                      initial={k.label}
                      onSave={(v) => onSaveLabel(k.id, v)}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <span className="key-row__label" data-testid="key-label">
                      {k.label ? (
                        k.label
                      ) : (
                        <span className="key-row__label--empty">
                          No label
                        </span>
                      )}
                    </span>
                  )}
                </div>

                {isConfirming ? (
                  <div className="key-row__confirm">
                    <span className="key-row__confirm-copy">
                      Remove this key from your vault? The on-chain
                      key itself is unaffected.
                    </span>
                    <button
                      type="button"
                      className="button button--primary button--small"
                      onClick={() => onConfirmRemove(k.id)}
                      disabled={mutating}
                      data-testid="key-row-confirm"
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => setPendingRemoveId(null)}
                      disabled={mutating}
                      data-testid="key-row-confirm-cancel"
                    >
                      Keep
                    </button>
                  </div>
                ) : isEditing ? null : (
                  <div className="key-row__actions">
                    <button
                      type="button"
                      className="auth-linklike"
                      onClick={() => setEditingId(k.id)}
                      data-testid="key-row-edit"
                    >
                      Edit label
                    </button>
                    <button
                      type="button"
                      className="auth-linklike key-row__remove"
                      onClick={() => setPendingRemoveId(k.id)}
                      data-testid="key-row-remove"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <VaultImportModal open={importOpen} onClose={onCloseImport} />
    </>
  );
}
