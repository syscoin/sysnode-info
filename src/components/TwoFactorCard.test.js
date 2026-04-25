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

  await waitFor(() => expect(authService.getTotpStatus).toHaveBeenCalled());
  await userEvent.click(
    screen.getByRole('button', { name: /set up two-factor authentication/i })
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
