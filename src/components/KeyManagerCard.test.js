import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import KeyManagerCard from './KeyManagerCard';
import * as VaultCtx from '../context/VaultContext';
import * as AuthCtx from '../context/AuthContext';

// KeyManagerCard unit tests.
// -----------------------------------------------------------------------
// Rather than spinning up the real VaultProvider + PBKDF2 pipeline for
// every scenario, we stub out useVault() and useAuth() with small
// controllable hooks. The full end-to-end path (PBKDF2 → decrypt →
// render KeyManagerCard) is exercised in src/pages/Account.test.js and
// src/context/VaultContext.test.js; here we focus on the component's
// own state machine: list rendering, edit-label flow, remove flow,
// and error surface.

const VALID_WIF = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn';
const VALID_ADDR = 'sys1qw508d6qejxtdg4y5r3zarvary0c5xw7kyhct58';
const VALID_WIF_2 = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU74NMTptX4';

function mountWithVault(vault, user) {
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
  return render(<KeyManagerCard />);
}

afterEach(() => {
  jest.restoreAllMocks();
});

function makeVault(overrides) {
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
    load: jest.fn(),
    unlock: jest.fn(),
    unlockWithMaster: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    lock: jest.fn(),
    reset: jest.fn(),
    ...overrides,
  };
}

describe('KeyManagerCard — empty list', () => {
  test('renders the empty hint and zero count when vault has no keys', () => {
    mountWithVault(makeVault());
    expect(screen.getByTestId('key-count')).toHaveTextContent('0');
    expect(screen.getByTestId('key-list-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('key-list')).not.toBeInTheDocument();
  });

  test('Add keys opens the import modal, Close dismisses it', async () => {
    mountWithVault(makeVault());
    expect(screen.queryByTestId('vault-import-modal')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('key-manager-import'));
    expect(screen.getByTestId('vault-import-modal')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('vault-import-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('vault-import-modal')).not.toBeInTheDocument()
    );
  });

  test('Lock button invokes vault.lock', async () => {
    const vault = makeVault();
    mountWithVault(vault);
    await userEvent.click(screen.getByTestId('vault-lock'));
    expect(vault.lock).toHaveBeenCalledTimes(1);
  });
});

describe('KeyManagerCard — list with keys', () => {
  function seededVault(extra) {
    return makeVault({
      data: {
        version: 1,
        keys: [
          {
            id: 'k1',
            label: 'MN 1',
            wif: VALID_WIF,
            address: VALID_ADDR,
            createdAt: 1,
          },
          {
            id: 'k2',
            label: '',
            wif: VALID_WIF_2,
            address: 'sys1q_other_stub',
            createdAt: 2,
          },
        ],
      },
      ...extra,
    });
  }

  test('renders an accurate count and one row per key', () => {
    mountWithVault(seededVault());
    expect(screen.getByTestId('key-count')).toHaveTextContent('2');
    const rows = screen.getAllByTestId('key-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(VALID_ADDR);
    expect(rows[0]).toHaveTextContent('MN 1');
    // Empty-label row shows a placeholder rather than a bare empty span
    expect(rows[1]).toHaveTextContent(/no label/i);
  });

  test('edit-label → save persists via vault.save and exits edit mode', async () => {
    const vault = seededVault();
    mountWithVault(vault);
    // Open editor on the first row
    const editButtons = screen.getAllByTestId('key-row-edit');
    await userEvent.click(editButtons[0]);
    const input = await screen.findByTestId('key-row-edit-input');
    expect(input).toHaveValue('MN 1');
    await userEvent.clear(input);
    await userEvent.type(input, 'MN Rackspace');
    await userEvent.click(screen.getByTestId('key-row-edit-save'));
    await waitFor(() => expect(vault.save).toHaveBeenCalledTimes(1));
    const savedPayload = vault.save.mock.calls[0][0];
    expect(savedPayload.keys.find((k) => k.id === 'k1').label).toBe(
      'MN Rackspace'
    );
    // The other row is untouched
    expect(savedPayload.keys.find((k) => k.id === 'k2').label).toBe('');
    // And we're no longer in edit mode — input is gone
    await waitFor(() =>
      expect(screen.queryByTestId('key-row-edit-input')).not.toBeInTheDocument()
    );
  });

  test('edit-label Cancel aborts without calling vault.save', async () => {
    const vault = seededVault();
    mountWithVault(vault);
    await userEvent.click(screen.getAllByTestId('key-row-edit')[0]);
    await userEvent.click(screen.getByTestId('key-row-edit-cancel'));
    expect(vault.save).not.toHaveBeenCalled();
    expect(screen.queryByTestId('key-row-edit-input')).not.toBeInTheDocument();
  });

  test('remove-key requires explicit confirmation before saving', async () => {
    const vault = seededVault();
    mountWithVault(vault);
    await userEvent.click(screen.getAllByTestId('key-row-remove')[0]);
    // Confirmation is inline, not a browser confirm(); clicking Keep
    // must NOT call save.
    await userEvent.click(screen.getByTestId('key-row-confirm-cancel'));
    expect(vault.save).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId('key-row-confirm')
    ).not.toBeInTheDocument();

    // Now confirm the remove.
    await userEvent.click(screen.getAllByTestId('key-row-remove')[0]);
    await userEvent.click(screen.getByTestId('key-row-confirm'));
    await waitFor(() => expect(vault.save).toHaveBeenCalledTimes(1));
    const savedPayload = vault.save.mock.calls[0][0];
    expect(savedPayload.keys).toHaveLength(1);
    expect(savedPayload.keys[0].id).toBe('k2');
  });

  test('surfaces a mutation error and stays in the list view', async () => {
    const vault = seededVault({
      save: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('stale'), { code: 'vault_stale' })),
    });
    mountWithVault(vault);
    await userEvent.click(screen.getAllByTestId('key-row-remove')[0]);
    await userEvent.click(screen.getByTestId('key-row-confirm'));
    const banner = await screen.findByTestId('key-manager-error');
    expect(banner).toHaveTextContent(/your vault changed in another tab/i);
    // The key list is still rendered — failed save leaves UI state
    // untouched so the user can retry.
    expect(screen.getAllByTestId('key-row')).toHaveLength(2);
  });
});
