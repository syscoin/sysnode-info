import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Switch } from 'react-router-dom';

import PrivateRoute from './PrivateRoute';
import { AuthProvider } from '../context/AuthContext';

function mount(service, initialPath) {
  return render(
    <AuthProvider authService={service}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Switch>
          <Route path="/login" render={() => <div>LOGIN</div>} />
          <PrivateRoute path="/account" render={() => <div>ACCOUNT</div>} />
        </Switch>
      </MemoryRouter>
    </AuthProvider>
  );
}

test('renders the protected component when authenticated', async () => {
  const service = {
    me: jest
      .fn()
      .mockResolvedValue({ user: { id: 1, email: 'a@b.com', emailVerified: true } }),
    login: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    verifyEmail: jest.fn(),
  };
  mount(service, '/account');
  await waitFor(() => expect(screen.getByText('ACCOUNT')).toBeInTheDocument());
});

test('redirects to /login when anonymous', async () => {
  const service = {
    me: jest.fn().mockRejectedValue(
      Object.assign(new Error('unauth'), { status: 401 })
    ),
    login: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    verifyEmail: jest.fn(),
  };
  mount(service, '/account');
  await waitFor(() => expect(screen.getByText('LOGIN')).toBeInTheDocument());
});

test('shows a neutral placeholder while booting', () => {
  const service = {
    // Never resolves, keeps provider in BOOTING state.
    me: jest.fn().mockReturnValue(new Promise(() => {})),
    login: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    verifyEmail: jest.fn(),
  };
  mount(service, '/account');
  expect(screen.getByText(/checking your session/i)).toBeInTheDocument();
});
