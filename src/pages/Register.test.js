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
  expect(await screen.findByRole('alert')).toHaveTextContent(/at least 8/i);
  expect(service.register).not.toHaveBeenCalled();

  const pw = screen.getByLabelText(/^password/i);
  const cf = screen.getByLabelText(/confirm password/i);
  await userEvent.clear(pw);
  await userEvent.clear(cf);
  await userEvent.type(pw, 'hunter22a');
  await userEvent.type(cf, 'hunter22b');
  await userEvent.click(screen.getByRole('button', { name: /create account/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/don'?t match/i);
  expect(service.register).not.toHaveBeenCalled();
});

test('shows the "check your inbox" screen on success', async () => {
  const service = mockService();
  renderRegister(service);

  await userEvent.type(screen.getByLabelText(/^email/i), 'a@b.com');
  await userEvent.type(screen.getByLabelText(/^password/i), 'hunter22a');
  await userEvent.type(screen.getByLabelText(/confirm password/i), 'hunter22a');
  await userEvent.click(screen.getByRole('button', { name: /create account/i }));

  await waitFor(() =>
    expect(screen.getByText(/check your inbox/i)).toBeInTheDocument()
  );
  expect(service.register).toHaveBeenCalledWith('a@b.com', 'hunter22a');
});
