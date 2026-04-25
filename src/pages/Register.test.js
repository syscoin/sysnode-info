import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import Register from './Register';
import { AuthProvider } from '../context/AuthContext';

jest.mock('../components/PageMeta', () => function MockPageMeta() {
  return null;
});

function renderRegister(service) {
  return render(
    <AuthProvider authService={service}>
      <MemoryRouter initialEntries={['/register']}>
        <Register />
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
    register: jest.fn().mockResolvedValue({ status: 'verification_sent' }),
    verifyEmail: jest.fn(),
    ...overrides,
  };
}

test('validates password length and mismatch client-side', async () => {
  const service = mockService();
  renderRegister(service);

  await userEvent.type(screen.getByLabelText(/^email/i), 'a@b.com');
  await userEvent.type(screen.getByLabelText(/^password/i), 'short');
  await userEvent.type(screen.getByLabelText(/confirm password/i), 'short');
  await userEvent.click(screen.getByRole('button', { name: /create account/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/at least 16/i);
  expect(service.register).not.toHaveBeenCalled();

  const pw = screen.getByLabelText(/^password/i);
  const cf = screen.getByLabelText(/confirm password/i);
  await userEvent.clear(pw);
  await userEvent.clear(cf);
  await userEvent.type(pw, 'correct horse battery staple');
  await userEvent.type(cf, 'correct horse battery mismatch');
  await userEvent.click(screen.getByRole('button', { name: /create account/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/don'?t match/i);
  expect(service.register).not.toHaveBeenCalled();
});

test('flags the offending fields aria-invalid on client-side validation errors', async () => {
  // The alert is paired with an aria-describedby on the offending inputs
  // so screen readers (and sighted users via the matching red border)
  // can tell which field the alert above refers to.
  const service = mockService();
  renderRegister(service);

  const email = screen.getByLabelText(/^email/i);
  const pw = screen.getByLabelText(/^password/i);
  const cf = screen.getByLabelText(/confirm password/i);

  // Password mismatch should flag BOTH password and confirm — we don't
  // know which one the user mistyped.
  await userEvent.type(email, 'a@b.com');
  await userEvent.type(pw, 'correct horse battery staple');
  await userEvent.type(cf, 'correct horse battery mismatch');
  await userEvent.click(screen.getByRole('button', { name: /create account/i }));
  await screen.findByRole('alert');

  expect(email).not.toHaveAttribute('aria-invalid');
  expect(pw).toHaveAttribute('aria-invalid', 'true');
  expect(cf).toHaveAttribute('aria-invalid', 'true');
  expect(pw.className).toMatch(/auth-input--error/);
  expect(cf.className).toMatch(/auth-input--error/);
});

test('renders the WebCrypto-unavailable copy with an actionable fix', async () => {
  // Simulates deriveLoginKeys throwing when window.crypto.subtle is
  // missing (plain-HTTP non-localhost origin). The UI must NOT fall
  // back to "Something went wrong" — that strands the operator with
  // no clue what's wrong or how to proceed.
  const service = mockService({
    register: jest.fn().mockRejectedValue(
      Object.assign(new Error('WebCrypto is unavailable...'), {
        code: 'webcrypto_unavailable',
      })
    ),
  });
  renderRegister(service);

  await userEvent.type(screen.getByLabelText(/^email/i), 'a@b.com');
  await userEvent.type(
    screen.getByLabelText(/^password/i),
    'correct horse battery staple'
  );
  await userEvent.type(
    screen.getByLabelText(/confirm password/i),
    'correct horse battery staple'
  );
  await userEvent.click(screen.getByRole('button', { name: /create account/i }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/https/i);
  expect(alert).toHaveTextContent(/localhost/i);
  expect(alert).not.toHaveTextContent(/something went wrong/i);
});

test('surfaces an unknown error\'s own message rather than the generic fallback', async () => {
  // Safety net: if a rejection bubbles up with no `.code` that ERROR_COPY
  // recognises but a meaningful message, prefer the message. Anything is
  // better than "Something went wrong. Please try again."
  const service = mockService({
    register: jest.fn().mockRejectedValue(
      Object.assign(new Error('Mailer refused the connection (EHOSTUNREACH).'), {
        code: 'mailer_down',
      })
    ),
  });
  renderRegister(service);

  await userEvent.type(screen.getByLabelText(/^email/i), 'a@b.com');
  await userEvent.type(
    screen.getByLabelText(/^password/i),
    'correct horse battery staple'
  );
  await userEvent.type(
    screen.getByLabelText(/confirm password/i),
    'correct horse battery staple'
  );
  await userEvent.click(screen.getByRole('button', { name: /create account/i }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/EHOSTUNREACH/);
  expect(alert).not.toHaveTextContent(/something went wrong/i);
});

test('shows the "check your inbox" screen on success', async () => {
  const service = mockService();
  renderRegister(service);

  await userEvent.type(screen.getByLabelText(/^email/i), 'a@b.com');
  await userEvent.type(
    screen.getByLabelText(/^password/i),
    'correct horse battery staple'
  );
  await userEvent.type(
    screen.getByLabelText(/confirm password/i),
    'correct horse battery staple'
  );
  await userEvent.click(screen.getByRole('button', { name: /create account/i }));

  await waitFor(() =>
    expect(screen.getByText(/check your inbox/i)).toBeInTheDocument()
  );
  expect(service.register).toHaveBeenCalledWith(
    'a@b.com',
    'correct horse battery staple'
  );
});
