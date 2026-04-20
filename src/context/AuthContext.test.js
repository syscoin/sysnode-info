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
        onClick={() =>
          auth
            .login({ email: 'a@b.com', password: 'pw' })
            .catch(() => {
              // Swallow in the test harness — real callers surface this
              // via the Login page's form-error UI; what we care about
              // for AuthContext tests is the post-failure provider state.
            })
        }
      >
        login
      </button>
      <button
        type="button"
        onClick={() =>
          auth.logout().catch(() => {
            // Tests that care about the error branch use a dedicated
            // probe that captures the rejection; this one just swallows
            // to avoid unhandled-rejection noise from the harness.
          })
        }
      >
        logout
      </button>
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

test('logout: server success clears local state (happy path)', async () => {
  const service = makeService({
    me: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'user@example.com', emailVerified: true },
    }),
    logout: jest.fn().mockResolvedValue({ status: 'ok' }),
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

test('logout: 401/404 on server = session already gone, clear locally (Codex round 5 P2)', async () => {
  // Server says we have no session to sign out of — that's idempotent
  // with our local expectation (signed out), so clearing is correct.
  const service = makeService({
    me: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'user@example.com', emailVerified: true },
    }),
    logout: jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('no session'), { status: 401 })
      ),
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

test('logout: transient server failure keeps AUTHENTICATED and rejects with logout_failed (Codex round 5 P2)', async () => {
  // 5xx / network error — session cookie is almost certainly still
  // valid. Pretending we're anonymous while a reload would restore
  // the session is dangerous on shared machines.
  const service = makeService({
    me: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'user@example.com', emailVerified: true },
    }),
    logout: jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('boom'), { status: 503 })
      ),
  });

  let capturedError = null;

  function Probe() {
    const auth = useAuth();
    return (
      <div>
        <span data-testid="status">{auth.status}</span>
        <button
          type="button"
          onClick={() =>
            auth.logout().catch((e) => {
              capturedError = e;
            })
          }
        >
          logout
        </button>
      </div>
    );
  }

  render(
    <AuthProvider authService={service}>
      <Probe />
    </AuthProvider>
  );
  await waitFor(() =>
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
  );

  await act(async () => {
    screen.getByText('logout').click();
    await flush();
  });

  // Still authenticated — we refuse to claim local sign-out on failure.
  expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
  expect(capturedError).not.toBeNull();
  expect(capturedError.code).toBe('logout_failed');
  expect(capturedError.status).toBe(503);
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

test('failed login does not strand the UI in booting when mount refresh is still in flight (Codex round 3 P1)', async () => {
  // Setup: mount-time /auth/me is pending. User clicks login, credentials
  // are rejected. The mount refresh's eventual 401 MUST still be able to
  // land ANONYMOUS — the failed login must not invalidate it by bumping
  // the gen counter prematurely.
  let rejectMountMe;
  const mountMe = new Promise((_resolve, reject) => {
    rejectMountMe = reject;
  });
  const service = makeService({
    me: jest.fn().mockReturnValueOnce(mountMe),
    login: jest.fn().mockRejectedValue(
      Object.assign(new Error('bad creds'), {
        code: 'invalid_credentials',
        status: 401,
      })
    ),
  });

  render(
    <AuthProvider authService={service}>
      <HookProbe />
    </AuthProvider>
  );
  expect(screen.getByTestId('status')).toHaveTextContent('booting');

  // Fail the login while the mount refresh is still pending.
  await act(async () => {
    screen.getByText('login').click();
    await flush();
  });
  // Login itself surfaces an error — status must still be booting, not
  // authenticated.
  expect(screen.getByTestId('status')).toHaveTextContent('booting');

  // Now the mount /auth/me resolves 401. It MUST land ANONYMOUS — if the
  // failed login had bumped the gen counter, this write would be dropped
  // and the UI would be stuck in booting forever.
  await act(async () => {
    rejectMountMe(Object.assign(new Error('unauth'), { status: 401 }));
    await flush();
  });
  await waitFor(() =>
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous')
  );
});

test('login rejects when follow-up /auth/me returns 401 (cookie did not stick) — Codex round 4 P1', async () => {
  // authService.login succeeds — credentials were valid. But the browser
  // never persisted the Set-Cookie (cross-origin + third-party-cookie
  // block), so the very next /auth/me comes back 401. AuthContext MUST
  // treat that as a real auth failure and stay anonymous rather than
  // unlock protected routes from the shallow login response.
  const service = makeService({
    me: jest
      .fn()
      // Mount refresh: 401 (no session yet).
      .mockRejectedValueOnce(
        Object.assign(new Error('unauth'), { status: 401 })
      )
      // Post-login rehydrate: ALSO 401.
      .mockRejectedValueOnce(
        Object.assign(new Error('unauth'), { status: 401 })
      ),
    login: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'user@example.com' },
      expiresAt: 1,
    }),
  });

  let capturedError = null;

  function Probe() {
    const auth = useAuth();
    return (
      <div>
        <span data-testid="status">{auth.status}</span>
        <button
          type="button"
          onClick={() =>
            auth
              .login({ email: 'a@b.com', password: 'pw' })
              .catch((e) => {
                capturedError = e;
              })
          }
        >
          login
        </button>
      </div>
    );
  }

  render(
    <AuthProvider authService={service}>
      <Probe />
    </AuthProvider>
  );
  await waitFor(() =>
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous')
  );

  await act(async () => {
    screen.getByText('login').click();
    await flush();
  });

  expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
  expect(capturedError).not.toBeNull();
  expect(capturedError.code).toBe('session_not_established');
  expect(capturedError.status).toBe(401);
});

test('login tolerates a 5xx/network blip on follow-up /auth/me (Codex round 4 P1)', async () => {
  // Transient hiccup on the best-effort hydrate call must still land
  // AUTHENTICATED using the shallow user the server already returned.
  const service = makeService({
    me: jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('unauth'), { status: 401 })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('oops'), { status: 503 })
      ),
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
