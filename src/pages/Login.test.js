import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Switch } from 'react-router-dom';

import Login from './Login';
import { AuthProvider } from '../context/AuthContext';

jest.mock('../components/PageMeta', () => function MockPageMeta() {
  return null;
});

function renderLogin(service, { initialPath = '/login' } = {}) {
  return render(
    <AuthProvider authService={service}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Switch>
          <Route path="/login" component={Login} />
          <Route path="/account" render={() => <div>ACCOUNT PAGE</div>} />
        </Switch>
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

test('rejects an obviously invalid email before calling the service', async () => {
  const service = mockService();
  renderLogin(service);
  await waitFor(() => expect(service.me).toHaveBeenCalled());

  await userEvent.type(screen.getByLabelText(/email/i), 'not-an-email');
  await userEvent.type(screen.getByLabelText(/password/i), 'hunter22a');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    /valid email address/i
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

test('sends the user to /account on successful login', async () => {
  const service = mockService({
    login: jest.fn().mockResolvedValue({
      user: { id: 1, email: 'a@b.com' },
      expiresAt: 1,
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
