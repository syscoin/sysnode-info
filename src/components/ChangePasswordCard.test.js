import React from 'react';
import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from '@testing-library/react';

// ---------------------------------------------------------------------------
// Scope note
// ---------------------------------------------------------------------------
//
// ChangePasswordCard's crypto orchestration (PBKDF2 → rewrap → POST)
// is covered end-to-end in authService.test.js and VaultContext.test.js.
// This component-level test file targets a much narrower concern: the
// Codex PR 7 round 2 P2 regression that an `unauthorized` response on
// POST /auth/change-password must flip AuthContext to ANONYMOUS so the
// PrivateRoute guard can redirect, instead of stranding the user on
// private Account UI with a stale signed-in state.
//
// We stub `authService` entirely (both the crypto primitive and the
// network call) and mock `useVault` so the card's flow reduces to:
//   deriveChangePasswordKeys → rewrapForPasswordChange → changePassword
// where the first two are trivial stubs and only the third is under
// test.

jest.mock('../context/VaultContext', () => ({
  __esModule: true,
  useVault: jest.fn(),
}));

// eslint-disable-next-line import/first
import ChangePasswordCard from './ChangePasswordCard';
// eslint-disable-next-line import/first
import { AuthProvider, useAuth } from '../context/AuthContext';
// eslint-disable-next-line import/first
import { useVault } from '../context/VaultContext';

function AuthProbe() {
  const { isAuthenticated, isBooting } = useAuth();
  const state = isBooting
    ? 'booting'
    : isAuthenticated
    ? 'authenticated'
    : 'anonymous';
  return <div data-testid="auth-probe">{state}</div>;
}

function makeAuthService() {
  return {
    me: jest.fn().mockResolvedValue({
      user: {
        id: 1,
        email: 'u@e.com',
        emailVerified: true,
        notificationPrefs: {},
        saltV: 'ab'.repeat(32),
      },
    }),
    login: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    verifyEmail: jest.fn(),
  };
}

// A minimal authService for the card itself — overrides only what
// the card calls, with fast stubs.
function makeCardAuthService({ changePasswordImpl, newMaster } = {}) {
  return {
    deriveChangePasswordKeys: jest.fn().mockResolvedValue({
      oldAuthHash: 'a'.repeat(64),
      newAuthHash: 'b'.repeat(64),
      // `master` is only used to call vault.rewrapForPasswordChange,
      // which our mocked useVault treats as a no-op (returns null).
      newMaster: newMaster || new Uint8Array(32),
    }),
    changePassword: changePasswordImpl || jest.fn().mockResolvedValue({}),
  };
}

function renderCard({ authService, cardAuthService, vault }) {
  useVault.mockReturnValue(
    vault || {
      isEmpty: true,
      isLocked: false,
      isUnlocked: false,
      isError: false,
      rewrapForPasswordChange: jest.fn().mockResolvedValue(null),
    }
  );
  return render(
    <AuthProvider authService={authService}>
      <ChangePasswordCard authService={cardAuthService} />
      <AuthProbe />
    </AuthProvider>
  );
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/current password/i), {
    target: { value: 'current-password-xyz' },
  });
  fireEvent.change(screen.getByLabelText(/^new password$/i), {
    target: { value: 'new-password-123456' },
  });
  fireEvent.change(screen.getByLabelText(/confirm new password/i), {
    target: { value: 'new-password-123456' },
  });
  await act(async () => {
    fireEvent.submit(screen.getByTestId('change-password-card'));
  });
}

describe('ChangePasswordCard', () => {
  test('unauthorized response flips AuthContext to anonymous (Codex PR 7 round 2 P2)', async () => {
    const authService = makeAuthService();
    const err = new Error('unauthorized');
    err.code = 'unauthorized';
    err.status = 401;
    const cardAuthService = makeCardAuthService({
      changePasswordImpl: jest.fn().mockRejectedValue(err),
    });

    renderCard({ authService, cardAuthService });
    await waitFor(() =>
      expect(screen.getByTestId('auth-probe')).toHaveTextContent('authenticated')
    );

    await fillAndSubmit();

    await waitFor(() =>
      expect(cardAuthService.changePassword).toHaveBeenCalledTimes(1)
    );
    await waitFor(() =>
      expect(screen.getByTestId('auth-probe')).toHaveTextContent('anonymous')
    );
    // We don't surface an inline "session expired" alert — the
    // redirect itself is the feedback, and the Account page is
    // about to unmount. Confirm we didn't render a stale error.
    expect(
      screen.queryByTestId('change-password-error')
    ).not.toBeInTheDocument();
  });

  test('submit is refused while vault is still loading (no PBKDF2 work) (Codex PR 7 round 2 P2)', async () => {
    // The vault transitions IDLE -> LOADING -> (EMPTY|LOCKED|
    // UNLOCKED|ERROR). Before the old patch, a submit during
    // LOADING ran the double-PBKDF2 derivation (~1.2s) before
    // failing inside rewrapForPasswordChange with the misleading
    // `vault_not_unlocked` copy. The card must short-circuit
    // ahead of derivation and surface a "still loading" message.
    const authService = makeAuthService();
    const cardAuthService = makeCardAuthService();
    const loadingVault = {
      isIdle: false,
      isLoading: true,
      isEmpty: false,
      isLocked: false,
      isUnlocked: false,
      isError: false,
      rewrapForPasswordChange: jest.fn().mockResolvedValue(null),
    };

    renderCard({ authService, cardAuthService, vault: loadingVault });
    await waitFor(() =>
      expect(screen.getByTestId('auth-probe')).toHaveTextContent('authenticated')
    );
    await fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByTestId('change-password-error')).toHaveTextContent(
        /vault is still loading/i
      )
    );
    // Critically: neither derivation nor the POST should have run.
    expect(cardAuthService.deriveChangePasswordKeys).not.toHaveBeenCalled();
    expect(cardAuthService.changePassword).not.toHaveBeenCalled();
    expect(loadingVault.rewrapForPasswordChange).not.toHaveBeenCalled();
  });

  test('rejects weak new passwords before derivation', async () => {
    const authService = makeAuthService();
    const cardAuthService = makeCardAuthService();

    renderCard({ authService, cardAuthService });
    await waitFor(() =>
      expect(screen.getByTestId('auth-probe')).toHaveTextContent('authenticated')
    );

    fireEvent.change(screen.getByLabelText(/current password/i), {
      target: { value: 'current-password-xyz' },
    });
    fireEvent.change(screen.getByLabelText(/^new password$/i), {
      target: { value: 'Password1!' },
    });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), {
      target: { value: 'Password1!' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('change-password-card'));
    });

    const error = screen.getByTestId('change-password-local-error');
    expect(error).toHaveTextContent(/common|another word/i);
    expect(cardAuthService.deriveChangePasswordKeys).not.toHaveBeenCalled();
    expect(cardAuthService.changePassword).not.toHaveBeenCalled();
  });

  test('non-auth failures (e.g. invalid_credentials) still render inline error and stay signed in', async () => {
    // Companion case — proves the unauthorized handling is targeted
    // and didn't silently gate ALL failures through handleAuthLost.
    const authService = makeAuthService();
    const err = new Error('invalid_credentials');
    err.code = 'invalid_credentials';
    err.status = 401;
    const cardAuthService = makeCardAuthService({
      changePasswordImpl: jest.fn().mockRejectedValue(err),
    });

    renderCard({ authService, cardAuthService });
    await waitFor(() =>
      expect(screen.getByTestId('auth-probe')).toHaveTextContent('authenticated')
    );

    await fillAndSubmit();

    await waitFor(() =>
      expect(
        screen.getByTestId('change-password-error')
      ).toHaveTextContent(/current password is incorrect/i)
    );
    expect(screen.getByTestId('auth-probe')).toHaveTextContent(
      'authenticated'
    );
  });

  test('zeroes the derived new master after password-change orchestration', async () => {
    const authService = makeAuthService();
    const newMaster = new Uint8Array(32).fill(0x42);
    const cardAuthService = makeCardAuthService({ newMaster });

    renderCard({ authService, cardAuthService });
    await waitFor(() =>
      expect(screen.getByTestId('auth-probe')).toHaveTextContent('authenticated')
    );

    await fillAndSubmit();

    await waitFor(() =>
      expect(cardAuthService.changePassword).toHaveBeenCalledTimes(1)
    );
    expect(Array.from(newMaster)).toEqual(new Array(32).fill(0));
  });
});
