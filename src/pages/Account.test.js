import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Switch } from 'react-router-dom';

import Account from './Account';
import { AuthProvider } from '../context/AuthContext';
import { VaultProvider } from '../context/VaultContext';
import {
  encryptEnvelope,
  generateDataKey,
} from '../lib/crypto/envelope';
import { deriveMaster, deriveVaultKey } from '../lib/crypto/kdf';

jest.mock('../components/PageMeta', () => function MockPageMeta() {
  return null;
});

// After PR 4 the per-user vault-key salt (`saltV`) lives on the user
// identity, not on the /vault payload. Tests must surface it through
// authService.me so VaultContext can derive the vaultKey from
// master + saltV on unlock.
const TEST_SALT_V = 'aa'.repeat(32);

function authedService({
  email = 'user@example.com',
  verified = true,
  saltV = TEST_SALT_V,
} = {}) {
  return {
    me: jest.fn().mockResolvedValue({
      user: {
        id: 1,
        email,
        emailVerified: verified,
        notificationPrefs: {},
        saltV,
      },
    }),
    login: jest.fn(),
    logout: jest.fn().mockResolvedValue({ status: 'ok' }),
    register: jest.fn(),
    verifyEmail: jest.fn(),
  };
}

function renderAccount({ authService, vaultService }) {
  return render(
    <AuthProvider authService={authService}>
      <VaultProvider vaultService={vaultService}>
        <MemoryRouter initialEntries={['/account']}>
          <Switch>
            <Route path="/account" component={Account} />
            <Route path="/login" render={() => <div>LOGIN PAGE</div>} />
          </Switch>
        </MemoryRouter>
      </VaultProvider>
    </AuthProvider>
  );
}

async function makeEncryptedBlobFor({
  password = 'correct horse battery',
  email = 'user@example.com',
  saltV = TEST_SALT_V,
  data = { keys: [{ label: 'a', wif: 'KxFoo...' }] },
}) {
  const master = await deriveMaster(password, email);
  const vaultKey = await deriveVaultKey(master, saltV);
  const dk = generateDataKey();
  const blob = await encryptEnvelope(data, dk, vaultKey);
  return { master, saltV, blob, data };
}

describe('Account page — vault status card', () => {
  // The VaultStatusCard returns different root elements (a <div> in
  // EMPTY/UNLOCKED/ERROR, a <form> in LOCKED) for each status, so the
  // DOM node under the shared testid is REPLACED on transitions. We
  // therefore always re-query inside waitFor/assertions rather than
  // caching a reference.
  function getCardStatus() {
    return screen
      .getByTestId('vault-status-card')
      .getAttribute('data-vault-status');
  }

  test('renders the empty-vault hint when the backend has no vault row', async () => {
    const vaultService = {
      load: jest.fn().mockResolvedValue({ empty: true }),
      save: jest.fn(),
    };
    renderAccount({ authService: authedService(), vaultService });
    await screen.findByTestId('vault-status-card');
    await waitFor(() => expect(getCardStatus()).toBe('empty'));
    expect(screen.getByTestId('vault-status-card')).toHaveTextContent(
      /haven't imported any Sentry Node/i
    );
  });

  test('renders the unlock form when the vault is locked and refuses empty passwords', async () => {
    const { blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E1' }),
      save: jest.fn(),
    };
    renderAccount({ authService: authedService(), vaultService });
    await screen.findByTestId('vault-status-card');
    await waitFor(() => expect(getCardStatus()).toBe('locked'));
    // Empty-password submit must never reach the KDF.
    await userEvent.click(screen.getByTestId('vault-unlock'));
    const err = await screen.findByTestId('vault-unlock-error');
    expect(err).toHaveTextContent(/please enter your password/i);
    expect(vaultService.load).toHaveBeenCalledTimes(1);
  });

  // These two tests drive the real PBKDF2-600k path end-to-end, so the
  // built-in 1s waitFor timeout isn't enough on slower machines.
  const PBKDF2_TIMEOUT_MS = 20000;

  test(
    'unlocks with the correct password and then relocks cleanly',
    async () => {
      const password = 'correct horse battery';
      const email = 'user@example.com';
      const { blob, data } = await makeEncryptedBlobFor({
        password,
        email,
      });
      const vaultService = {
        load: jest
          .fn()
          .mockResolvedValue({ empty: false, blob, etag: 'E1' }),
        save: jest.fn(),
      };
      renderAccount({
        authService: authedService({ email }),
        vaultService,
      });

      await screen.findByTestId('vault-status-card');
      await waitFor(() => expect(getCardStatus()).toBe('locked'));

      await userEvent.type(screen.getByLabelText(/password/i), password);
      await act(async () => {
        await userEvent.click(screen.getByTestId('vault-unlock'));
      });

      await waitFor(
        () => expect(getCardStatus()).toBe('unlocked'),
        { timeout: PBKDF2_TIMEOUT_MS }
      );

      // Lock transitions back to LOCKED without another network round-trip.
      // We snapshot the call count AFTER the unlock resolved so that "no
      // re-GET on lock" is what we actually assert (unlockWithMaster did
      // its own internal load()).
      const callsBeforeLock = vaultService.load.mock.calls.length;
      await act(async () => {
        await userEvent.click(screen.getByTestId('vault-lock'));
      });
      await waitFor(() => expect(getCardStatus()).toBe('locked'));
      expect(vaultService.load.mock.calls.length).toBe(callsBeforeLock);
      expect(data).toEqual({ keys: [{ label: 'a', wif: 'KxFoo...' }] });
    },
    PBKDF2_TIMEOUT_MS + 5000
  );

  test(
    'shows a friendly error and stays LOCKED on a wrong password',
    async () => {
      const { blob } = await makeEncryptedBlobFor({
        password: 'right',
        email: 'user@example.com',
      });
      const vaultService = {
        load: jest
          .fn()
          .mockResolvedValue({ empty: false, blob, etag: 'E1' }),
        save: jest.fn(),
      };
      renderAccount({ authService: authedService(), vaultService });
      await screen.findByTestId('vault-status-card');
      await waitFor(() => expect(getCardStatus()).toBe('locked'));

      await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
      await act(async () => {
        await userEvent.click(screen.getByTestId('vault-unlock'));
      });

      const err = await screen.findByTestId('vault-unlock-error', undefined, {
        timeout: PBKDF2_TIMEOUT_MS,
      });
      expect(err).toHaveTextContent(/password doesn't match/i);
      expect(getCardStatus()).toBe('locked');
    },
    PBKDF2_TIMEOUT_MS + 5000
  );

  test('renders a loading state while the initial GET /vault is in flight', async () => {
    let resolveLoad;
    const loadPromise = new Promise((resolve) => {
      resolveLoad = resolve;
    });
    const vaultService = {
      load: jest.fn().mockReturnValue(loadPromise),
      save: jest.fn(),
    };
    renderAccount({ authService: authedService(), vaultService });
    const card = await screen.findByTestId('vault-status-card');
    expect(card).toHaveTextContent(/checking your vault/i);
    await act(async () => {
      resolveLoad({ empty: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(getCardStatus()).toBe('empty'));
  });

  test('renders an error state when GET /vault fails, surfacing the code', async () => {
    const vaultService = {
      load: jest.fn().mockRejectedValue(
        Object.assign(new Error('internal'), {
          code: 'internal',
          status: 500,
        })
      ),
      save: jest.fn(),
    };
    renderAccount({ authService: authedService(), vaultService });
    await screen.findByTestId('vault-status-card');
    await waitFor(() => expect(getCardStatus()).toBe('error'));
    expect(screen.getByTestId('vault-status-card')).toHaveTextContent(/internal/);
  });
});

describe('Account page — existing sign-out behavior is preserved', () => {
  test('sign out navigates to /login on success', async () => {
    const service = authedService();
    const vaultService = {
      load: jest.fn().mockResolvedValue({ empty: true }),
      save: jest.fn(),
    };
    renderAccount({ authService: service, vaultService });
    await waitFor(() =>
      expect(screen.getByText('Your Sysnode account')).toBeInTheDocument()
    );
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    });
    await waitFor(() =>
      expect(screen.getByText('LOGIN PAGE')).toBeInTheDocument()
    );
  });
});
