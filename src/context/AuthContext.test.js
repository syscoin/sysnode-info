import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

function flush() {
  // Let any pending microtasks (the refresh() promise) settle before we
  // assert on rendered state.
  return act(async () => {
    await Promise.resolve();
  });
}

function HookProbe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <span data-testid="email">{auth.user ? auth.user.email : 'none'}</span>
      <button
        type="button"
        onClick={() => auth.login({ email: 'a@b.com', password: 'pw' })}
      >
        login
      </button>
      <button type="button" onClick={() => auth.logout()}>logout</button>
    </div>
  );
}

function makeService(overrides = {}) {
  return {
    me: jest.fn().mockRejectedValue(
      Object.assign(new Error('unauthorized'), { status: 401 })
    ),
    login: jest.fn(),
    logout: jest.fn().mockResolvedValue({ status: 'ok' }),
    register: jest.fn(),
    verifyEmail: jest.fn(),
    ...overrides,
  };
}

test('starts in booting, transitions to anonymous when /me returns 401', async () => {
  const service = makeService();
  render(
    <AuthProvider authService={service}>
      <HookProbe />
    </AuthProvider>
  );
  expect(screen.getByTestId('status')).toHaveTextContent('booting');
  await waitFor(() =>
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous')
  );
  expect(service.me).toHaveBeenCalledTimes(1);
});

test('restores authenticated session when /me returns a user', async () => {
  const service = makeService({
    me: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'user@example.com', emailVerified: true },
    }),
  });
  render(
    <AuthProvider authService={service}>
      <HookProbe />
    </AuthProvider>
  );
  await waitFor(() =>
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
  );
  expect(screen.getByTestId('email')).toHaveTextContent('user@example.com');
});

test('login transitions anonymous -> authenticated', async () => {
  const service = makeService({
    login: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'user@example.com' },
      expiresAt: 1,
    }),
    me: jest
      .fn()
      // Boot: no session
      .mockRejectedValueOnce(
        Object.assign(new Error('unauthorized'), { status: 401 })
      )
      // After login: session materialised, full profile returned
      .mockResolvedValueOnce({
        user: { id: 1, email: 'user@example.com', emailVerified: true },
      }),
  });
  render(
    <AuthProvider authService={service}>
      <HookProbe />
    </AuthProvider>
  );
  await waitFor(() =>
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous')
  );

  await act(async () => {
    screen.getByText('login').click();
    await flush();
  });

  await waitFor(() =>
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
  );
  expect(service.login).toHaveBeenCalledWith('a@b.com', 'pw');
});

test('logout transitions authenticated -> anonymous even if network fails', async () => {
  const service = makeService({
    me: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'user@example.com', emailVerified: true },
    }),
    logout: jest.fn().mockRejectedValue(new Error('boom')),
  });
  render(
    <AuthProvider authService={service}>
      <HookProbe />
    </AuthProvider>
  );
  await waitFor(() =>
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
  );

  await act(async () => {
    screen.getByText('logout').click();
    await flush();
  });

  await waitFor(() =>
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous')
  );
});

test('stale mount-time /auth/me 401 cannot overwrite a newer successful login (Codex round 1 P1)', async () => {
  // Reproduce the slow-network race: /auth/me on mount lags behind the
  // user's login click. The mount's 401 arrives LATER than the login
  // success and must not demote us back to anonymous.
  let rejectMe;
  const mePending = new Promise((_resolve, reject) => {
    rejectMe = reject;
  });
  const service = makeService({
    // First call: the slow mount-time probe. Leave it pending — we'll
    // reject it manually mid-test.
    me: jest
      .fn()
      .mockReturnValueOnce(mePending)
      // Second call: the login-driven me() lookup. Resolves immediately.
      .mockResolvedValueOnce({
        user: { id: 1, email: 'user@example.com', emailVerified: true },
      }),
    login: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'user@example.com' },
      expiresAt: 1,
    }),
  });

  render(
    <AuthProvider authService={service}>
      <HookProbe />
    </AuthProvider>
  );

  // We're still booting — the mount /auth/me has not resolved yet.
  expect(screen.getByTestId('status')).toHaveTextContent('booting');

  // User clicks login. It completes quickly (both authService.login and
  // the login-scoped authService.me()).
  await act(async () => {
    screen.getByText('login').click();
    await flush();
  });
  await waitFor(() =>
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
  );

  // NOW the slow mount-time /auth/me finally rejects with 401. The old
  // refresh() MUST NOT flip us back to anonymous — a newer operation
  // (login) has already claimed the generation counter.
  await act(async () => {
    rejectMe(Object.assign(new Error('unauth'), { status: 401 }));
    await flush();
  });

  // Give any spurious writes a chance to land before we assert.
  await flush();
  expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
  expect(screen.getByTestId('email')).toHaveTextContent('user@example.com');
});

test('useAuth throws outside provider', () => {
  function Bare() {
    useAuth();
    return null;
  }
  const previousError = console.error;
  // eslint-disable-next-line no-console
  console.error = jest.fn(); // suppress React's boundary noise in this negative test
  expect(() => render(<Bare />)).toThrow(/must be used inside <AuthProvider>/);
  // eslint-disable-next-line no-console
  console.error = previousError;
});
