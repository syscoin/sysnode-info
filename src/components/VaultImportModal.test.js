import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HDKey } from '@scure/bip32';

import VaultImportModal from './VaultImportModal';
import * as VaultCtx from '../context/VaultContext';
import * as AuthCtx from '../context/AuthContext';
import {
  addDescriptorChecksum,
  importFromDescriptor,
} from '../lib/syscoin/descriptor';

// user-event v13 (pinned in this repo) is strict about `userEvent.paste`'s
// signature and throws on plain textareas in jsdom, so we stub the paste
// via a synthetic change event. This wrapper isolates the "set value by
// fiat" gesture so a later bump to user-event v14+ — which provides a
// more faithful `await user.paste(text)` — only needs fixing here.
function pasteInto(el, text) {
  fireEvent.change(el, { target: { value: text } });
}

async function waitForValidationDone() {
  await waitFor(() =>
    expect(screen.getByTestId('vault-import-save')).not.toHaveTextContent(
      /validating/i
    )
  );
}

// VaultImportModal unit tests.
// -----------------------------------------------------------------------
// Focus: paste → validate → import state machine. The underlying
// vault.save() is mocked out; VaultContext's own tests cover the
// ETag / envelope / master-derivation mechanics.

const VALID_WIF_1 = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn';
const VALID_ADDR_1 = 'sys1qw508d6qejxtdg4y5r3zarvary0c5xw7kyhct58';
const VALID_WIF_2 = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU74NMTptX4';
// A deliberately-broken WIF (flipped last character) — guaranteed
// checksum failure.
const INVALID_WIF =
  VALID_WIF_1.slice(0, -1) + (VALID_WIF_1.slice(-1) === 'A' ? 'B' : 'A');

function descriptorFixtures() {
  const seed = new Uint8Array(32).fill(7);
  const root = HDKey.fromMasterSeed(seed);
  const xprv = root.privateExtendedKey;
  const descriptor = addDescriptorChecksum(`wpkh(${xprv}/0/5)`);
  return {
    descriptor,
    imported: importFromDescriptor(descriptor),
  };
}

function mount({ vault, user, onClose = jest.fn() } = {}) {
  const auth = {
    user: user || {
      id: 1,
      email: 'user@example.com',
      emailVerified: true,
      saltV: 'a'.repeat(64),
    },
  };
  jest.spyOn(VaultCtx, 'useVault').mockReturnValue(vault);
  jest.spyOn(AuthCtx, 'useAuth').mockReturnValue(auth);
  const utils = render(<VaultImportModal open={true} onClose={onClose} />);
  return { ...utils, onClose };
}

afterEach(() => {
  jest.restoreAllMocks();
});

function unlockedVault(overrides) {
  return {
    status: 'unlocked',
    data: { version: 1, keys: [] },
    etag: 'E1',
    error: null,
    isIdle: false,
    isLoading: false,
    isEmpty: false,
    isLocked: false,
    isUnlocked: true,
    isError: false,
    isSaving: false,
    save: jest.fn().mockResolvedValue(undefined),
    lock: jest.fn(),
    load: jest.fn(),
    unlock: jest.fn(),
    unlockWithMaster: jest.fn(),
    reset: jest.fn(),
    ...overrides,
  };
}

function emptyVault(overrides) {
  return unlockedVault({
    status: 'empty',
    isEmpty: true,
    isUnlocked: false,
    data: null,
    ...overrides,
  });
}

describe('VaultImportModal — closed / empty states', () => {
  test('returns null when open is false', () => {
    jest.spyOn(VaultCtx, 'useVault').mockReturnValue(unlockedVault());
    jest.spyOn(AuthCtx, 'useAuth').mockReturnValue({
      user: { id: 1, email: 'u@e.com', saltV: 'a'.repeat(64) },
    });
    const { container } = render(
      <VaultImportModal open={false} onClose={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  test('disables Save when the paste is empty', () => {
    mount({ vault: unlockedVault() });
    expect(screen.getByTestId('vault-import-save')).toBeDisabled();
    expect(screen.getByTestId('vault-import-save')).toHaveTextContent(
      /paste keys to import/i
    );
  });
});

describe('VaultImportModal — paste → validate', () => {
  test('categorises valid, invalid, and duplicate rows with summary chips', async () => {
    const vault = unlockedVault();
    mount({ vault });

    const textarea = screen.getByTestId('vault-import-paste');
    // Paste a mix: two valid, one invalid (bad checksum), one duplicate.
    const text = [
      `${VALID_WIF_1},MN 1`,
      VALID_WIF_2,
      INVALID_WIF,
      `${VALID_WIF_1},second occurrence`,
    ].join('\n');
    pasteInto(textarea, text);

    const rowsContainer = await screen.findByTestId('vault-import-rows');
    await waitForValidationDone();
    const rows = rowsContainer.querySelectorAll('[data-testid="vault-import-row"]');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveClass('import-row--valid');
    expect(rows[0]).toHaveTextContent(VALID_ADDR_1);
    expect(rows[0]).toHaveTextContent('MN 1');
    expect(rows[1]).toHaveClass('import-row--valid');
    expect(rows[2]).toHaveClass('import-row--invalid');
    expect(rows[3]).toHaveClass('import-row--duplicate');

    // Save CTA reflects the count of *valid* rows (not total).
    expect(screen.getByTestId('vault-import-save')).toHaveTextContent(
      /import 2 keys/i
    );
    expect(screen.getByTestId('vault-import-save')).not.toBeDisabled();
  });

  test('flags duplicates against already-stored vault entries distinctly', async () => {
    const vault = unlockedVault({
      data: {
        version: 1,
        keys: [
          {
            id: 'k1',
            label: 'existing',
            wif: VALID_WIF_1,
            address: VALID_ADDR_1,
            createdAt: 1,
          },
        ],
      },
    });
    mount({ vault });
    pasteInto(screen.getByTestId('vault-import-paste'), VALID_WIF_1);
    await waitForValidationDone();
    const rows = screen.getAllByTestId('vault-import-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveClass('import-row--duplicate');
    expect(rows[0]).toHaveTextContent(/already in vault/i);
    // Nothing is importable — Save remains disabled.
    expect(screen.getByTestId('vault-import-save')).toBeDisabled();
  });

  test('clicking an invalid row selects the offending textarea line', async () => {
    const vault = unlockedVault();
    mount({ vault });
    const textarea = screen.getByTestId('vault-import-paste');
    const text = `${VALID_WIF_1},MN 1\n${INVALID_WIF},bad row`;
    pasteInto(textarea, text);
    await waitForValidationDone();

    const invalidRow = screen.getAllByTestId('vault-import-row')[1];
    await userEvent.click(invalidRow);

    const lineStart = text.indexOf(INVALID_WIF);
    expect(textarea.selectionStart).toBe(lineStart);
    expect(textarea.selectionEnd).toBe(text.length);
  });

  test('remove line action deletes the offending row from the paste', async () => {
    const vault = unlockedVault();
    mount({ vault });
    const textarea = screen.getByTestId('vault-import-paste');
    pasteInto(textarea, `${VALID_WIF_1},MN 1\n${INVALID_WIF},bad row`);
    await waitForValidationDone();

    await userEvent.click(screen.getByLabelText('Remove line 2'));

    expect(textarea).toHaveValue(`${VALID_WIF_1},MN 1`);
    await waitForValidationDone();
    expect(screen.getAllByTestId('vault-import-row')).toHaveLength(1);
    expect(screen.getByTestId('vault-import-save')).not.toBeDisabled();
  });

  test('row keyboard shortcut ignores key events from the remove button', async () => {
    const vault = unlockedVault();
    mount({ vault });
    const textarea = screen.getByTestId('vault-import-paste');
    const text = `${VALID_WIF_1},MN 1\n${INVALID_WIF},bad row`;
    pasteInto(textarea, text);
    await waitForValidationDone();

    const removeButton = screen.getByLabelText('Remove line 2');
    removeButton.focus();
    fireEvent.keyDown(removeButton, { key: ' ' });

    expect(document.activeElement).toBe(removeButton);
    expect(textarea.selectionStart).toBe(text.length);
    expect(textarea.selectionEnd).toBe(text.length);
  });
});

describe('VaultImportModal — save flow (UNLOCKED)', () => {
  test('valid paste → Save calls vault.save with appended keys and closes', async () => {
    const vault = unlockedVault();
    const { onClose } = mount({ vault });
    pasteInto(
      screen.getByTestId('vault-import-paste'),
      `${VALID_WIF_1},MN 1\n${VALID_WIF_2}`
    );
    await waitFor(() =>
      expect(screen.getByTestId('vault-import-save')).not.toBeDisabled()
    );
    await userEvent.click(screen.getByTestId('vault-import-save'));
    await waitFor(() => expect(vault.save).toHaveBeenCalledTimes(1));
    // UNLOCKED path: second arg is undefined (no password needed).
    expect(vault.save.mock.calls[0][1]).toBeUndefined();
    const nextPayload = vault.save.mock.calls[0][0];
    expect(nextPayload.keys).toHaveLength(2);
    expect(nextPayload.keys[0]).toMatchObject({
      wif: VALID_WIF_1,
      address: VALID_ADDR_1,
      label: 'MN 1',
    });
    expect(nextPayload.keys[1]).toMatchObject({
      wif: VALID_WIF_2,
      label: '',
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test('descriptor paste stores the derived WIF while preserving the label', async () => {
    const vault = unlockedVault();
    const { onClose } = mount({ vault });
    const { descriptor, imported } = descriptorFixtures();
    pasteInto(
      screen.getByTestId('vault-import-paste'),
      `${descriptor},descriptor row,`
    );
    await waitFor(() =>
      expect(screen.getByTestId('vault-import-save')).not.toBeDisabled()
    );
    await userEvent.click(screen.getByTestId('vault-import-save'));
    await waitFor(() => expect(vault.save).toHaveBeenCalledTimes(1));
    const nextPayload = vault.save.mock.calls[0][0];
    expect(nextPayload.keys).toHaveLength(1);
    expect(nextPayload.keys[0]).toMatchObject({
      label: 'descriptor row',
      wif: imported.wif,
      address: imported.address,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test('surfaces a typed save error and leaves the modal open', async () => {
    const vault = unlockedVault({
      save: jest.fn().mockRejectedValue(
        Object.assign(new Error('stale'), { code: 'vault_stale' })
      ),
    });
    const { onClose } = mount({ vault });
    pasteInto(screen.getByTestId('vault-import-paste'), VALID_WIF_1);
    await waitFor(() =>
      expect(screen.getByTestId('vault-import-save')).not.toBeDisabled()
    );
    await userEvent.click(screen.getByTestId('vault-import-save'));
    const banner = await screen.findByTestId('vault-import-error');
    expect(banner).toHaveTextContent(/changed in another tab/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('editing the paste disables Save before revalidation finishes', async () => {
    const vault = unlockedVault();
    mount({ vault });
    const textarea = screen.getByTestId('vault-import-paste');
    const saveButton = screen.getByTestId('vault-import-save');

    pasteInto(textarea, VALID_WIF_1);
    await waitFor(() => expect(saveButton).not.toBeDisabled());

    pasteInto(textarea, INVALID_WIF);
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveTextContent(/validating/i);
  });
});

describe('VaultImportModal — save flow (EMPTY, first write)', () => {
  test('requires a password field before Save is enabled', async () => {
    mount({ vault: emptyVault() });
    pasteInto(screen.getByTestId('vault-import-paste'), VALID_WIF_1);
    // Save is disabled until the password field has content, even
    // though we have a valid row.
    expect(screen.getByTestId('vault-import-save')).toBeDisabled();
    await userEvent.type(
      screen.getByTestId('vault-import-password'),
      'correct-horse-battery'
    );
    await waitFor(() =>
      expect(screen.getByTestId('vault-import-save')).not.toBeDisabled()
    );
  });

  test('rejects short first-write passwords before vault.save', async () => {
    const vault = emptyVault();
    mount({ vault });
    pasteInto(screen.getByTestId('vault-import-paste'), VALID_WIF_1);
    await userEvent.type(
      screen.getByTestId('vault-import-password'),
      'too-short'
    );
    await waitFor(() =>
      expect(screen.getByTestId('vault-import-save')).not.toBeDisabled()
    );

    await userEvent.click(screen.getByTestId('vault-import-save'));
    expect(await screen.findByTestId('vault-import-error')).toHaveTextContent(
      /at least 16/i
    );
    expect(vault.save).not.toHaveBeenCalled();
  });

  test('forwards {password, email} to vault.save on first write', async () => {
    const vault = emptyVault();
    const { onClose } = mount({ vault });
    pasteInto(screen.getByTestId('vault-import-paste'), `${VALID_WIF_1},MN 1`);
    await userEvent.type(
      screen.getByTestId('vault-import-password'),
      'my-secret-passphrase'
    );
    await waitFor(() =>
      expect(screen.getByTestId('vault-import-save')).not.toBeDisabled()
    );
    await userEvent.click(screen.getByTestId('vault-import-save'));
    await waitFor(() => expect(vault.save).toHaveBeenCalledTimes(1));
    expect(vault.save.mock.calls[0][1]).toEqual({
      password: 'my-secret-passphrase',
      email: 'user@example.com',
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('VaultImportModal — dismiss', () => {
  test('ESC triggers onClose while not saving', async () => {
    const { onClose } = mount({ vault: unlockedVault() });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test('ESC does NOT close while a save is in flight (Codex P2)', async () => {
    // Manually-released save promise so we can observe the "saving"
    // window and press ESC while it's true.
    let releaseSave;
    const vault = unlockedVault({
      save: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseSave = () => resolve();
          })
      ),
    });
    const { onClose } = mount({ vault });
    pasteInto(screen.getByTestId('vault-import-paste'), VALID_WIF_1);
    await waitFor(() =>
      expect(screen.getByTestId('vault-import-save')).not.toBeDisabled()
    );
    await userEvent.click(screen.getByTestId('vault-import-save'));
    // Wait until vault.save has been invoked — that's the modal's
    // `saving` window opening.
    await waitFor(() => expect(vault.save).toHaveBeenCalledTimes(1));

    // Press ESC mid-flight. The keydown listener was registered when
    // the modal opened (saving=false at that time); the fix ensures
    // the handler reads the *current* saving value via a ref so this
    // ESC is a no-op.
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    // Finish the save; modal closes normally.
    await waitFor(() => {}); // settle pending acts
    releaseSave();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test('Cancel button triggers onClose', async () => {
    const { onClose } = mount({ vault: unlockedVault() });
    await userEvent.click(screen.getByTestId('vault-import-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
