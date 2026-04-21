import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// PBKDF2 (600k SHA-512 iterations inside deriveLoginKeys) takes on the order
// of a second per call under jsdom + parallel jest workers, which blows past
// testing-library's default 1s waitFor window — the card would submit and
// eventually resolve, but the waiter gives up first. The card's crypto
// contract is already fully covered by kdf.test.js; for component-level
// tests we only need a fast, stable stub that yields a valid hex authHash.
//
// NOTE: CRA's Jest config defaults to `resetMocks: true`, which wipes
// jest.fn() implementations between every test. So we install the default
// implementation in beforeEach rather than inlining it in the factory.
jest.mock('../lib/crypto/kdf', () => ({
  __esModule: true,
  deriveLoginKeys: jest.fn(),
  deriveMaster: jest.fn(),
  deriveAuthHash: jest.fn(),
  deriveVaultKey: jest.fn(),
}));

// eslint-disable-next-line import/first
import DeleteAccountCard from './DeleteAccountCard';
// eslint-disable-next-line import/first
import { AuthProvider } from '../context/AuthContext';
// eslint-disable-next-line import/first
import { deriveLoginKeys } from '../lib/crypto/kdf';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
//
// DeleteAccountCard sits under AuthProvider + a router (useHistory()
// is called to navigate to '/' after success). We stub authService.me()
// so AuthProvider hydrates a predictable user, and pass a separate
// authService stub INTO the card so its deleteAccount call is
// observable.
//
// Why `fireEvent.submit` for submission and NOT `userEvent.click` on
// the submit button: userEvent@13 dispatches a full pointer/mouse
// click sequence which, combined with React 17 + JSDOM, can resolve
// the click before the form's queued state updates flush — the click
// then runs the handler with STALE component state. This exact
// failure mode bit NotificationPreferencesCard before and is fixed
// the same way here.

function makeAuthService() {
  return {
    me: jest.fn().mockResolvedValue({
      user: {
        id: 1,
        email: 'alice@example.com',
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

function renderCard({ authService, cardAuthService, extra } = {}) {
  return render(
    <MemoryRouter initialEntries={['/account']}>
      <AuthProvider authService={authService}>
        <DeleteAccountCard authService={cardAuthService} />
        {extra}
      </AuthProvider>
    </MemoryRouter>
  );
}

async function waitForUserHydrated() {
  // AuthProvider fires its /auth/me refresh on mount. The card should
  // render with the collapsed "Delete account…" button once the user
  // is hydrated.
  await waitFor(() =>
    expect(screen.getByTestId('delete-account-reveal')).toBeInTheDocument()
  );
}

async function expandForm() {
  // userEvent.click is fine here — the button is outside the form and
  // just flips local UI state. We still wrap in act() so React can
  // flush before subsequent assertions.
  await act(async () => {
    userEvent.click(screen.getByTestId('delete-account-reveal'));
  });
  await waitFor(() =>
    expect(
      screen.getByTestId('delete-account-submit')
    ).toBeInTheDocument()
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeleteAccountCard', () => {
  beforeEach(() => {
    // Reinstall the fast deriveLoginKeys stub after resetMocks wiped it.
    deriveLoginKeys.mockImplementation(() =>
      Promise.resolve({
        master: new Uint8Array(32),
        authHash: 'a'.repeat(64),
      })
    );
  });

  test('renders the collapsed danger entry by default', async () => {
    const authService = makeAuthService();
    const cardAuthService = {
      deleteAccount: jest.fn(),
    };
    renderCard({ authService, cardAuthService });
    await waitForUserHydrated();
    expect(
      screen.queryByTestId('delete-account-warnings')
    ).not.toBeInTheDocument();
    expect(cardAuthService.deleteAccount).not.toHaveBeenCalled();
  });

  test('clicking the reveal button expands the warning list and form', async () => {
    const authService = makeAuthService();
    const cardAuthService = { deleteAccount: jest.fn() };
    renderCard({ authService, cardAuthService });
    await waitForUserHydrated();
    await expandForm();
    expect(
      screen.getByTestId('delete-account-warnings')
    ).toBeInTheDocument();
    expect(screen.getByTestId('delete-account-email')).toBeInTheDocument();
    expect(screen.getByTestId('delete-account-password')).toBeInTheDocument();
    expect(screen.getByTestId('delete-account-cancel')).toBeInTheDocument();
  });

  test('Cancel collapses back to the entry state and clears inputs', async () => {
    const authService = makeAuthService();
    const cardAuthService = { deleteAccount: jest.fn() };
    renderCard({ authService, cardAuthService });
    await waitForUserHydrated();
    await expandForm();
    fireEvent.change(screen.getByTestId('delete-account-email'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByTestId('delete-account-password'), {
      target: { value: 'hunter22a' },
    });
    await act(async () => {
      userEvent.click(screen.getByTestId('delete-account-cancel'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('delete-account-reveal')).toBeInTheDocument()
    );
    // Re-expanding shows cleared fields — sensitive password text
    // should NOT linger across cancels.
    await expandForm();
    expect(screen.getByTestId('delete-account-email')).toHaveValue('');
    expect(screen.getByTestId('delete-account-password')).toHaveValue('');
  });

  test('rejects a mismatched email confirmation without calling the API', async () => {
    const authService = makeAuthService();
    const cardAuthService = { deleteAccount: jest.fn() };
    renderCard({ authService, cardAuthService });
    await waitForUserHydrated();
    await expandForm();
    fireEvent.change(screen.getByTestId('delete-account-email'), {
      target: { value: 'wrong@example.com' },
    });
    fireEvent.change(screen.getByTestId('delete-account-password'), {
      target: { value: 'hunter22a' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('delete-account-card'));
    });
    expect(cardAuthService.deleteAccount).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('delete-account-local-error')
    ).toHaveTextContent(/does not match/i);
  });

  test('is case-insensitive + trim-tolerant on the email confirmation', async () => {
    const authService = makeAuthService();
    const cardAuthService = {
      deleteAccount: jest.fn().mockResolvedValue(true),
    };
    renderCard({ authService, cardAuthService });
    await waitForUserHydrated();
    await expandForm();
    fireEvent.change(screen.getByTestId('delete-account-email'), {
      target: { value: '  Alice@EXAMPLE.com  ' },
    });
    fireEvent.change(screen.getByTestId('delete-account-password'), {
      target: { value: 'hunter22a' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('delete-account-card'));
    });
    await waitFor(() =>
      expect(cardAuthService.deleteAccount).toHaveBeenCalledTimes(1)
    );
    const body = cardAuthService.deleteAccount.mock.calls[0][0];
    expect(body.oldAuthHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('refuses to submit when the password field is empty', async () => {
    const authService = makeAuthService();
    const cardAuthService = { deleteAccount: jest.fn() };
    renderCard({ authService, cardAuthService });
    await waitForUserHydrated();
    await expandForm();
    fireEvent.change(screen.getByTestId('delete-account-email'), {
      target: { value: 'alice@example.com' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('delete-account-card'));
    });
    expect(cardAuthService.deleteAccount).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('delete-account-local-error')
    ).toHaveTextContent(/password/i);
  });

  test('surfaces invalid_credentials without destroying local state', async () => {
    const authService = makeAuthService();
    const err = new Error('invalid_credentials');
    err.code = 'invalid_credentials';
    err.status = 401;
    const cardAuthService = {
      deleteAccount: jest.fn().mockRejectedValue(err),
    };
    renderCard({ authService, cardAuthService });
    await waitForUserHydrated();
    await expandForm();
    fireEvent.change(screen.getByTestId('delete-account-email'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByTestId('delete-account-password'), {
      target: { value: 'wrong-password' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('delete-account-card'));
    });
    await waitFor(() =>
      expect(cardAuthService.deleteAccount).toHaveBeenCalled()
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('delete-account-error')
      ).toHaveTextContent(/password is incorrect/i)
    );
    expect(screen.getByTestId('delete-account-submit')).not.toBeDisabled();
  });

  test('on `unauthorized` clears local auth state and redirects home', async () => {
    // Regression for Codex PR 7 round 1 P2:
    //   If the session expires (or is revoked on another device)
    //   mid-submit, deleteAccount rejects with `unauthorized`. The
    //   card must not leave the user stranded on the private account
    //   page with a stale AuthContext — it must mirror the server's
    //   view of the world and bounce them home.
    const authService = makeAuthService();
    const err = new Error('unauthorized');
    err.code = 'unauthorized';
    err.status = 401;
    const cardAuthService = {
      deleteAccount: jest.fn().mockRejectedValue(err),
    };
    // eslint-disable-next-line global-require
    const { useLocation } = require('react-router-dom');
    const PathnameProbe = () => {
      const loc = useLocation();
      return <div data-testid="pathname-probe">{loc.pathname}</div>;
    };
    renderCard({
      authService,
      cardAuthService,
      extra: <PathnameProbe />,
    });
    await waitForUserHydrated();
    await expandForm();
    fireEvent.change(screen.getByTestId('delete-account-email'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByTestId('delete-account-password'), {
      target: { value: 'hunter22a' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('delete-account-card'));
    });
    await waitFor(() =>
      expect(cardAuthService.deleteAccount).toHaveBeenCalled()
    );
    // Auth state should have flipped to ANONYMOUS (the card will
    // have unmounted along with its AuthProvider-gated siblings;
    // the probe navigates to '/').
    await waitFor(() =>
      expect(screen.getByTestId('pathname-probe')).toHaveTextContent('/')
    );
    // And we did NOT surface a dismissible error — the user is
    // already gone from this page, so an inline error toast would
    // never be seen anyway. The redirect IS the feedback.
    expect(screen.queryByTestId('delete-account-error')).not.toBeInTheDocument();
  });

  test('on success navigates to "/" after the API resolves', async () => {
    const authService = makeAuthService();
    const cardAuthService = {
      deleteAccount: jest.fn().mockResolvedValue(true),
    };
    // Embed a tiny probe so the test can observe navigation state.
    // We purposefully mount it as a SIBLING of the card so the probe
    // is not unmounted when the card itself may re-render.
    // eslint-disable-next-line global-require
    const { useLocation } = require('react-router-dom');
    const PathnameProbe = () => {
      const loc = useLocation();
      return <div data-testid="pathname-probe">{loc.pathname}</div>;
    };
    renderCard({
      authService,
      cardAuthService,
      extra: <PathnameProbe />,
    });
    await waitForUserHydrated();
    await expandForm();
    fireEvent.change(screen.getByTestId('delete-account-email'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByTestId('delete-account-password'), {
      target: { value: 'hunter22a' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('delete-account-card'));
    });
    await waitFor(() =>
      expect(cardAuthService.deleteAccount).toHaveBeenCalledTimes(1)
    );
    await waitFor(() =>
      expect(screen.getByTestId('pathname-probe')).toHaveTextContent('/')
    );
  });
});
