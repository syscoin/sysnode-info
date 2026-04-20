import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('./pages/Home', () => function MockHome() {
  return <div>Overview page</div>;
});

jest.mock('./pages/Learn', () => function MockLearn() {
  return <div>Learn page</div>;
});

jest.mock('./pages/Setup', () => function MockSetup() {
  return <div>Setup page</div>;
});

jest.mock('./pages/Network', () => function MockNetwork() {
  return <div>Network page</div>;
});

jest.mock('./pages/Governance', () => function MockGovernance() {
  return <div>Governance page</div>;
});

jest.mock('./pages/Error', () => function MockError() {
  return <div>Not found page</div>;
});

jest.mock('./pages/Login', () => function MockLogin() {
  return <div>Login page</div>;
});

jest.mock('./pages/Register', () => function MockRegister() {
  return <div>Register page</div>;
});

jest.mock('./pages/VerifyEmail', () => function MockVerify() {
  return <div>Verify email page</div>;
});

jest.mock('./pages/Account', () => function MockAccount() {
  return <div>Account page</div>;
});

jest.mock('./lib/authService', () => ({
  authService: {
    me: () =>
      Promise.reject(Object.assign(new Error('unauth'), { status: 401 })),
    login: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    verifyEmail: jest.fn(),
  },
  createAuthService: jest.fn(),
}));

import App from './App';

beforeEach(() => {
  window.scrollTo = jest.fn();
});

test('renders the overview route by default', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>
  );

  expect(screen.getByText(/overview page/i)).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument();
});

test('renders the error route for unknown pages', () => {
  render(
    <MemoryRouter initialEntries={['/missing']}>
      <App />
    </MemoryRouter>
  );

  expect(screen.getByText(/not found page/i)).toBeInTheDocument();
});

test('redirects the legacy stats route to network', () => {
  render(
    <MemoryRouter initialEntries={['/stats']}>
      <App />
    </MemoryRouter>
  );

  expect(screen.getByText(/network page/i)).toBeInTheDocument();
});

test('redirects the legacy about route to learn', () => {
  render(
    <MemoryRouter initialEntries={['/about']}>
      <App />
    </MemoryRouter>
  );

  expect(screen.getByText(/learn page/i)).toBeInTheDocument();
});
