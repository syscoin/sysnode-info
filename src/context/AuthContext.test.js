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
