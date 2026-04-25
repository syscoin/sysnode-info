import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Switch } from 'react-router-dom';

import Login from './Login';
import { AuthProvider } from '../context/AuthContext';
import { VaultProvider } from '../context/VaultContext';

jest.mock('../components/PageMeta', () => function MockPageMeta() {
  return null;
});

function mockVaultService() {
  // Default vault service returns empty — the Account page path the tests
  // navigate to doesn't render the vault card, and Login's fire-and-forget
  // unlockWithMaster() swallows the "no blob to decrypt" result via its
  // internal state machine. Kept trivial so we don't accidentally exercise
  // the crypto in the Login page's unit tests.
  return {
    load: jest.fn().mockResolvedValue({ empty: true }),
    save: jest.fn(),
  };
}

function renderLogin(
  service,
  { initialPath = '/login', vaultService = mockVaultService() } = {}
) {
  const result = render(
    <AuthProvider authService={service}>
      <VaultProvider vaultService={vaultService}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Switch>
            <Route path="/login" component={Login} />
            <Route path="/account" render={() => <div>ACCOUNT PAGE</div>} />
          </Switch>
        </MemoryRouter>
      </VaultProvider>
    </AuthProvider>
  );
  return { ...result, vaultService };
}

function mockService(overrides = {}) {
  return {
    me: jest.fn().mockRejectedValue(
      Object.assign(new Error('unauth'), { status: 401 })
    ),
    login: jest.fn(),
    completeTotpLogin: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    verifyEmail: jest.fn(),
    ...overrides,
  };
}

test('rejects an obviously invalid email before calling the service', async () => {
  const service = mockService();
  renderLogin(service);
  await waitFor(() => expect(service.me).toHaveBeenCalled());

  await userEvent.type(screen.getByLabelText(/email/i), 'not-an-email');
  await userEvent.type(screen.getByLabelText(/password/i), 'hunter22a');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    /email address doesn'?t look right/i
  );
  expect(service.login).not.toHaveBeenCalled();
});

test('renders a friendly message when the server returns invalid_credentials', async () => {
  const service = mockService({
    login: jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('invalid_credentials'), {
          code: 'invalid_credentials',
          status: 401,
        })
      ),
  });
  renderLogin(service);
  await waitFor(() => expect(service.me).toHaveBeenCalled());

  await userEvent.type(screen.getByLabelText(/email/i), 'a@b.com');
  await userEvent.type(screen.getByLabelText(/password/i), 'hunter22a');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    /couldn't sign you in/i
  );
});

test('flags both email and password aria-invalid on invalid_credentials (anti-enumeration)', async () => {
  // The backend returns the same invalid_credentials code for "wrong email"
  // and "wrong password" (intentional, anti-enumeration). We therefore
  // outline BOTH inputs rather than misdirect the user to a specific one.
  const service = mockService({
    login: jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('invalid_credentials'), {
          code: 'invalid_credentials',
          status: 401,
        })
      ),
  });
  renderLogin(service);
  await waitFor(() => expect(service.me).toHaveBeenCalled());

  const email = screen.getByLabelText(/email/i);
  const pw = screen.getByLabelText(/password/i);
  await userEvent.type(email, 'a@b.com');
  await userEvent.type(pw, 'hunter22a');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
  await screen.findByRole('alert');

  expect(email).toHaveAttribute('aria-invalid', 'true');
  expect(pw).toHaveAttribute('aria-invalid', 'true');
  expect(email.className).toMatch(/auth-input--error/);
  expect(pw.className).toMatch(/auth-input--error/);
});

test('renders the WebCrypto-unavailable copy with an actionable fix', async () => {
  // Same contract as Register: if deriveLoginKeys throws because
  // window.crypto.subtle isn't exposed (plain-HTTP non-localhost origin),
  // the user deserves a message that tells them how to recover — not
  // "Something went wrong".
  const service = mockService({
    login: jest.fn().mockRejectedValue(
      Object.assign(new Error('WebCrypto is unavailable...'), {
        code: 'webcrypto_unavailable',
      })
    ),
  });
  renderLogin(service);
  await waitFor(() => expect(service.me).toHaveBeenCalled());

  await userEvent.type(screen.getByLabelText(/email/i), 'a@b.com');
  await userEvent.type(screen.getByLabelText(/password/i), 'hunter22a');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/https/i);
  expect(alert).toHaveTextContent(/localhost/i);
  expect(alert).not.toHaveTextContent(/something went wrong/i);
});

test('sends the user to /account on successful login', async () => {
  const service = mockService({
    login: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'a@b.com' },
      expiresAt: 1,
      master: new Uint8Array(32),
    }),
    me: jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('unauth'), { status: 401 })
      )
      .mockResolvedValueOnce({
        user: { id: 1, email: 'a@b.com', emailVerified: true },
      }),
  });
  renderLogin(service);
  await waitFor(() => expect(service.me).toHaveBeenCalledTimes(1));

  await userEvent.type(screen.getByLabelText(/email/i), 'a@b.com');
  await userEvent.type(screen.getByLabelText(/password/i), 'hunter22a');
  await act(async () => {
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
  });

  await waitFor(() => expect(screen.getByText('ACCOUNT PAGE')).toBeInTheDocument());
  expect(service.login).toHaveBeenCalledWith('a@b.com', 'hunter22a');
});

test('completes a pending TOTP login before navigating', async () => {
  const master = new Uint8Array(32).fill(7);
  const service = mockService({
    login: jest.fn().mockResolvedValue({
      mfaRequired: true,
      challengeToken: 'a'.repeat(64),
      expiresAt: 1,
      master,
    }),
    completeTotpLogin: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'a@b.com', totpEnabled: true },
      expiresAt: 2,
    }),
    me: jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('unauth'), { status: 401 })
      )
      .mockResolvedValueOnce({
        user: { id: 1, email: 'a@b.com', emailVerified: true, totpEnabled: true },
      }),
  });
  renderLogin(service);
  await waitFor(() => expect(service.me).toHaveBeenCalledTimes(1));

  await userEvent.type(screen.getByLabelText(/email/i), 'a@b.com');
  await userEvent.type(screen.getByLabelText(/password/i), 'hunter22a');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

  expect(await screen.findByText(/two-factor check/i)).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(/authenticator code/i), '123456');
  await userEvent.click(screen.getByRole('button', { name: /verify and sign in/i }));

  await waitFor(() => expect(screen.getByText('ACCOUNT PAGE')).toBeInTheDocument());
  expect(service.completeTotpLogin).toHaveBeenCalledWith({
    challengeToken: 'a'.repeat(64),
    code: '123456',
    recoveryCode: undefined,
  });
});

test('clears MFA errors when returning to password sign in', async () => {
  const service = mockService({
    login: jest.fn().mockResolvedValue({
      mfaRequired: true,
      challengeToken: 'a'.repeat(64),
      expiresAt: 1,
      master: new Uint8Array(32),
    }),
  });
  renderLogin(service);
  await waitFor(() => expect(service.me).toHaveBeenCalled());

  await userEvent.type(screen.getByLabelText(/email/i), 'a@b.com');
  await userEvent.type(screen.getByLabelText(/password/i), 'hunter22a');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
  expect(await screen.findByText(/two-factor check/i)).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: /verify and sign in/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/authenticator code/i);

  await userEvent.click(screen.getByRole('button', { name: /back to password sign in/i }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('fires vault.unlockWithMaster with the login-returned master (fire-and-forget)', async () => {
  // Contract: a successful login hands `master` from AuthContext to the
  // VaultContext via unlockWithMaster(). The Login page does NOT await
  // the result — navigation should not block on a vault decrypt, and a
  // vault error should not be rendered as a login error.
  const master = new Uint8Array(32).fill(5);
  const service = mockService({
    login: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'a@b.com' },
      expiresAt: 1,
      master,
    }),
    me: jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('unauth'), { status: 401 })
      )
      .mockResolvedValueOnce({
        user: { id: 1, email: 'a@b.com', emailVerified: true },
      }),
  });
  const vaultService = mockVaultService();
  renderLogin(service, { vaultService });
  await waitFor(() => expect(service.me).toHaveBeenCalledTimes(1));

  await userEvent.type(screen.getByLabelText(/email/i), 'a@b.com');
  await userEvent.type(screen.getByLabelText(/password/i), 'hunter22a');
  await act(async () => {
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
  });

  // VaultContext's unlockWithMaster calls vaultService.load(). Seeing a
  // load() call (post-login, not the initial auth-loads) is our signal
  // that master reached the VaultContext.
  await waitFor(() => expect(vaultService.load).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText('ACCOUNT PAGE')).toBeInTheDocument());
});

test('a vault auto-unlock failure does not prevent navigation or surface as a login error', async () => {
  // Guarantees the fire-and-forget contract: if the vault decrypt throws
  // (corrupted blob, network flake), the Login page still routes to
  // /account and does NOT render an alert. The Account page is the only
  // place that surfaces vault issues.
  const master = new Uint8Array(32).fill(5);
  const service = mockService({
    login: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'a@b.com' },
      expiresAt: 1,
      master,
    }),
    me: jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('unauth'), { status: 401 })
      )
      .mockResolvedValueOnce({
        user: { id: 1, email: 'a@b.com', emailVerified: true },
      }),
  });
  const vaultService = {
    load: jest.fn().mockRejectedValue(
      Object.assign(new Error('boom'), { code: 'internal', status: 500 })
    ),
    save: jest.fn(),
  };
  renderLogin(service, { vaultService });
  await waitFor(() => expect(service.me).toHaveBeenCalledTimes(1));

  await userEvent.type(screen.getByLabelText(/email/i), 'a@b.com');
  await userEvent.type(screen.getByLabelText(/password/i), 'hunter22a');
  await act(async () => {
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
  });

  await waitFor(() => expect(screen.getByText('ACCOUNT PAGE')).toBeInTheDocument());
  expect(screen.queryByRole('alert')).toBeNull();
});
