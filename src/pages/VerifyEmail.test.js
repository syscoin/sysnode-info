import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
