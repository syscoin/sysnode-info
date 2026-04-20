import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import VerifyEmail from './VerifyEmail';
import { AuthProvider } from '../context/AuthContext';

jest.mock('../components/PageMeta', () => function MockPageMeta() {
  return null;
});

function renderAt(search, service) {
  return render(
    <AuthProvider authService={service}>
      <MemoryRouter initialEntries={[`/verify-email${search}`]}>
        <VerifyEmail />
      </MemoryRouter>
    </AuthProvider>
  );
}

function mockService(overrides = {}) {
  return {
    me: jest.fn().mockRejectedValue(
      Object.assign(new Error('unauth'), { status: 401 })
    ),
    login: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    verifyEmail: jest.fn(),
    ...overrides,
  };
}

const TOKEN = 'a'.repeat(64);

test('shows success state when server returns verified', async () => {
  const service = mockService({
    verifyEmail: jest.fn().mockResolvedValue({ status: 'verified' }),
  });
  renderAt(`?token=${TOKEN}`, service);
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: /email verified/i })).toBeInTheDocument()
  );
  expect(service.verifyEmail).toHaveBeenCalledWith(TOKEN);
});

test('treats expired/invalid tokens distinctly from generic errors', async () => {
  const service = mockService({
    verifyEmail: jest.fn().mockRejectedValue(
      Object.assign(new Error('invalid_or_expired_token'), {
        code: 'invalid_or_expired_token',
        status: 400,
      })
    ),
  });
  renderAt(`?token=${TOKEN}`, service);
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: /link expired/i })).toBeInTheDocument()
  );
});

test('shows the already_verified branch on 409', async () => {
  const service = mockService({
    verifyEmail: jest.fn().mockRejectedValue(
      Object.assign(new Error('already_verified'), {
        code: 'already_verified',
        status: 409,
      })
    ),
  });
  renderAt(`?token=${TOKEN}`, service);
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: /already verified/i })).toBeInTheDocument()
  );
});

test('treats a malformed token as invalid without hitting the service', async () => {
  const service = mockService();
  renderAt('?token=notlongenough', service);
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: /link expired/i })).toBeInTheDocument()
  );
  expect(service.verifyEmail).not.toHaveBeenCalled();
});

test('late response from a previous token cannot overwrite the current token’s status (Codex round 4 P2)', async () => {
  const TOKEN_A = 'a'.repeat(64);
  const TOKEN_B = 'b'.repeat(64);

  // Control token A's resolution manually. Token B rejects fast.
  let resolveA;
  const aPending = new Promise((resolve) => {
    resolveA = resolve;
  });

  const service = mockService({
    verifyEmail: jest.fn((token) => {
      if (token === TOKEN_A) return aPending;
      if (token === TOKEN_B) {
        return Promise.reject(
          Object.assign(new Error('invalid_or_expired_token'), {
            code: 'invalid_or_expired_token',
            status: 400,
          })
        );
      }
      return Promise.reject(new Error('unexpected token'));
    }),
  });

  const { createMemoryHistory } = require('history');
  const history = createMemoryHistory({
    initialEntries: [`/verify-email?token=${TOKEN_A}`],
  });
  const { Router } = require('react-router-dom');
  const { render: rtlRender } = require('@testing-library/react');
  const { AuthProvider } = require('../context/AuthContext');
  const VerifyEmailComponent = require('./VerifyEmail').default;

  rtlRender(
    <AuthProvider authService={service}>
      <Router history={history}>
        <VerifyEmailComponent />
      </Router>
    </AuthProvider>
  );

  // Token A is in flight. Navigate to B before A resolves.
  await act(async () => {
    history.push(`/verify-email?token=${TOKEN_B}`);
  });

  // B's rejection lands — we should be on the invalid-token screen.
  await waitFor(() =>
    expect(
      screen.getByRole('heading', { name: /link expired/i })
    ).toBeInTheDocument()
  );

  // Now the stale A request finally resolves successfully. Its .then
  // MUST be ignored — the URL is on token B, whose status is invalid.
  await act(async () => {
    resolveA({ status: 'verified' });
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(
    screen.getByRole('heading', { name: /link expired/i })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('heading', { name: /email verified/i })
  ).not.toBeInTheDocument();
});

test('navigating from a valid token to a malformed one invalidates the in-flight request (Codex round 6 P2)', async () => {
  const TOKEN_A = 'a'.repeat(64);
  const MALFORMED = 'short';

  let resolveA;
  const aPending = new Promise((resolve) => {
    resolveA = resolve;
  });

  const service = mockService({
    verifyEmail: jest.fn((token) => {
      if (token === TOKEN_A) return aPending;
      return Promise.reject(new Error('unexpected token'));
    }),
  });

  const { createMemoryHistory } = require('history');
  const history = createMemoryHistory({
    initialEntries: [`/verify-email?token=${TOKEN_A}`],
  });
  const { Router } = require('react-router-dom');
  const { render: rtlRender } = require('@testing-library/react');
  const { AuthProvider } = require('../context/AuthContext');
  const VerifyEmailComponent = require('./VerifyEmail').default;

  rtlRender(
    <AuthProvider authService={service}>
      <Router history={history}>
        <VerifyEmailComponent />
      </Router>
    </AuthProvider>
  );

  // Token A is pending. Navigate to a malformed token — the page goes
  // straight to "invalid" without hitting the service.
  await act(async () => {
    history.push(`/verify-email?token=${MALFORMED}`);
  });

  await waitFor(() =>
    expect(
      screen.getByRole('heading', { name: /link expired/i })
    ).toBeInTheDocument()
  );
  // Service was only called for TOKEN_A.
  expect(service.verifyEmail).toHaveBeenCalledTimes(1);
  expect(service.verifyEmail).toHaveBeenLastCalledWith(TOKEN_A);

  // Now the stale A request resolves with success. Its .then MUST be
  // invalidated even though the malformed-token branch never bumped
  // the counter the old way — bumping BEFORE the early return makes
  // the pending A request stale here.
  await act(async () => {
    resolveA({ status: 'verified' });
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(
    screen.getByRole('heading', { name: /link expired/i })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('heading', { name: /email verified/i })
  ).not.toBeInTheDocument();
});

test('re-runs verification when the token query parameter changes (Codex round 1 P2)', async () => {
  // Same-tab SPA navigation from one /verify-email?token=... URL to
  // another must NOT reuse the first run's result. The dedupe key is
  // the token value, not a one-shot boolean.
  const TOKEN_A = 'a'.repeat(64);
  const TOKEN_B = 'b'.repeat(64);
  const service = mockService({
    verifyEmail: jest
      .fn()
      .mockResolvedValueOnce({ status: 'verified' })
      // Second navigation: backend says the new link is expired.
      .mockRejectedValueOnce(
        Object.assign(new Error('invalid_or_expired_token'), {
          code: 'invalid_or_expired_token',
          status: 400,
        })
      ),
  });

  // Router-driven navigation: use a shared memory history so we can push
  // a new URL while the page stays mounted.
  const { createMemoryHistory } = require('history');
  const history = createMemoryHistory({
    initialEntries: [`/verify-email?token=${TOKEN_A}`],
  });
  const { Router } = require('react-router-dom');
  const { render: rtlRender } = require('@testing-library/react');
  const { AuthProvider } = require('../context/AuthContext');
  const VerifyEmailComponent = require('./VerifyEmail').default;

  rtlRender(
    <AuthProvider authService={service}>
      <Router history={history}>
        <VerifyEmailComponent />
      </Router>
    </AuthProvider>
  );

  await waitFor(() =>
    expect(
      screen.getByRole('heading', { name: /email verified/i })
    ).toBeInTheDocument()
  );
  expect(service.verifyEmail).toHaveBeenCalledTimes(1);
  expect(service.verifyEmail).toHaveBeenLastCalledWith(TOKEN_A);

  // Same tab, different link clicked by the user.
  await act(async () => {
    history.push(`/verify-email?token=${TOKEN_B}`);
  });

  await waitFor(() => expect(service.verifyEmail).toHaveBeenCalledTimes(2));
  expect(service.verifyEmail).toHaveBeenLastCalledWith(TOKEN_B);
  await waitFor(() =>
    expect(
      screen.getByRole('heading', { name: /link expired/i })
    ).toBeInTheDocument()
  );
});
