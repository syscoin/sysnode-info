import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toString as qrToString } from 'qrcode';

import TwoFactorCard from './TwoFactorCard';
import { AuthProvider } from '../context/AuthContext';

jest.mock('qrcode', () => ({
  toString: jest.fn((_uri, _opts, cb) =>
    cb(null, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  ),
}));

function service(overrides = {}) {
  return {
    me: jest.fn().mockResolvedValue({
      user: {
        id: 1,
        email: 'user@example.com',
        emailVerified: true,
        totpEnabled: false,
      },
    }),
    login: jest.fn(),
    completeTotpLogin: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    verifyEmail: jest.fn(),
    deriveStepUpAuthHash: jest.fn().mockResolvedValue('a'.repeat(64)),
    getTotpStatus: jest.fn().mockResolvedValue({
      enabled: false,
      pending: false,
      recoveryCodesRemaining: 0,
    }),
    beginTotpSetup: jest.fn().mockResolvedValue({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUrl:
        'otpauth://totp/Sysnode:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Sysnode',
    }),
    enableTotp: jest.fn(),
    disableTotp: jest.fn(),
    ...overrides,
  };
}

function renderCard(authService = service()) {
  render(
    <AuthProvider authService={authService}>
      <TwoFactorCard authService={authService} defaultOpen />
    </AuthProvider>
  );
  return authService;
}

test('renders a QR code for TOTP setup with manual secret fallback', async () => {
  const authService = renderCard();

  await waitFor(() => expect(authService.me).toHaveBeenCalled());
  await waitFor(() => expect(authService.getTotpStatus).toHaveBeenCalled());
  await userEvent.type(screen.getByLabelText(/current password/i), 'Correct1!');
  await userEvent.click(
    screen.getByRole('button', { name: /set up two-factor authentication/i })
  );
  await waitFor(() =>
    expect(authService.beginTotpSetup).toHaveBeenCalledWith('a'.repeat(64))
  );

  await waitFor(() =>
    expect(qrToString).toHaveBeenCalledWith(
      expect.stringMatching(/^otpauth:\/\/totp\//),
      expect.objectContaining({ type: 'svg', width: 220 }),
      expect.any(Function)
    )
  );
  expect(screen.getByLabelText(/manual setup secret fallback/i)).toHaveValue(
    'JBSWY3DPEHPK3PXP'
  );
});

test('allows restarting setup after the pending TOTP setup expires', async () => {
  const authService = service({
    enableTotp: jest.fn().mockRejectedValue(
      Object.assign(new Error('totp_setup_not_started'), {
        code: 'totp_setup_not_started',
      })
    ),
  });
  renderCard(authService);

  await waitFor(() => expect(authService.me).toHaveBeenCalled());
  await waitFor(() => expect(authService.getTotpStatus).toHaveBeenCalled());
  await userEvent.type(screen.getByLabelText(/current password/i), 'Correct1!');
  await userEvent.click(
    screen.getByRole('button', { name: /set up two-factor authentication/i })
  );
  await screen.findByLabelText(/manual setup secret fallback/i);
  await userEvent.type(screen.getByLabelText(/authenticator code/i), '123456');
  await userEvent.click(screen.getByRole('button', { name: /verify and enable/i }));

  await waitFor(() =>
    expect(authService.enableTotp).toHaveBeenCalledWith({
      code: '123456',
      oldAuthHash: 'a'.repeat(64),
    })
  );

  expect(await screen.findByRole('alert')).toHaveTextContent(/start setup again/i);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: /set up two-factor authentication/i })
    ).toBeInTheDocument()
  );
});
