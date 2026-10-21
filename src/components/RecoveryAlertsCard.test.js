import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { act } from 'react';
import userEvent from '@testing-library/user-event';
import RecoveryAlertsCard from './RecoveryAlertsCard';
import { AuthProvider } from '../context/AuthContext';

const ACCOUNT = `0x${'12'.repeat(20)}`;
const CHAIN_ID = 57057;
const CHAIN = { chainId: CHAIN_ID, name: 'zkTanenbaum', testnet: true };
const SIGNATURE = `0x${'ab'.repeat(24000)}`;
const SUBSCRIPTION = {
  id: 1,
  chainId: CHAIN_ID,
  account: ACCOUNT,
  label: 'Savings',
  monitoring: { status: 'catching_up', lastCheckedAt: 1792600000000 },
  pending: [],
};

const click = (element) =>
  act(async () => {
    await userEvent.click(element);
  });
const type = (element, value) =>
  act(async () => {
    await userEvent.type(element, value);
  });

function setup({
  subscriptions = [],
  open = true,
  hasWallet = true,
  totp = false,
  service: overrides = {},
} = {}) {
  const handlers = {};
  const provider = {
    request: jest.fn(async ({ method }) =>
      method === 'eth_chainId'
        ? `0x${CHAIN_ID.toString(16)}`
        : method === 'personal_sign'
        ? SIGNATURE
        : [ACCOUNT]
    ),
    on: jest.fn((name, fn) => {
      handlers[name] = fn;
    }),
    removeListener: jest.fn(),
  };
  const discover = jest.fn((cb) => {
    cb(hasWallet ? [{ id: 'pali', name: 'Pali', provider }] : []);
    return () => {};
  });
  const service = {
    chains: jest.fn().mockResolvedValue([CHAIN]),
    subscriptions: jest.fn().mockResolvedValue(subscriptions),
    challenge: jest.fn().mockResolvedValue({
      id: 'nonce',
      message: 'Enable recovery alerts',
      account: ACCOUNT,
      chainId: CHAIN_ID,
    }),
    subscribe: jest.fn().mockResolvedValue(SUBSCRIPTION),
    remove: jest.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  const authService = {
    me: jest.fn().mockResolvedValue({
      user: {
        id: 1,
        email: 'qa@example.test',
        emailVerified: true,
        totpEnabled: totp,
      },
    }),
    deriveStepUpAuthHash: jest.fn().mockResolvedValue('auth-hash'),
  };
  const view = render(
    <AuthProvider authService={authService}>
      <RecoveryAlertsCard
        service={service}
        authService={authService}
        defaultOpen={open}
        discover={discover}
      />
    </AuthProvider>
  );
  return { ...view, service, authService, provider, handlers };
}

test('collapsed card adds no background API requests until it is opened', async () => {
  const { service } = setup({ open: false });
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Expand recovery alerts' })
    ).toBeInTheDocument()
  );
  expect(service.chains).not.toHaveBeenCalled();
  await click(screen.getByRole('button', { name: 'Expand recovery alerts' }));
  await screen.findByText(/No smart accounts linked yet/);
  expect(service.subscriptions).toHaveBeenCalledTimes(1);
});

test('enrollment requests an off-chain signature, saves only proof and refreshes monitoring', async () => {
  const { service, provider } = setup();
  await screen.findByText(/No smart accounts linked yet/);
  await click(screen.getByRole('button', { name: 'Connect wallet' }));
  await screen.findByRole('button', { name: 'Enable recovery alerts' });
  expect(
    screen.getByText(/An off-chain signature links this account address/)
  ).toBeInTheDocument();
  await type(screen.getByLabelText(/Account label/), 'Savings');
  service.subscriptions.mockResolvedValue([SUBSCRIPTION]);
  await click(screen.getByRole('button', { name: 'Enable recovery alerts' }));
  await screen.findByText('Checking chain history');
  expect(service.subscribe).toHaveBeenCalledWith('nonce', SIGNATURE, 'Savings');
  expect(
    provider.request.mock.calls.some(
      ([call]) => call.method === 'eth_sendTransaction'
    )
  ).toBe(false);
  expect(
    screen.getByText(/Account linked for recovery alerts/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Checking for recent and existing recoveries/)
  ).toBeInTheDocument();
});

test('normal accountsChanged on first wallet permission does not break connection', async () => {
  const { provider, handlers } = setup();
  await screen.findByText(/No smart accounts linked yet/);
  provider.request.mockImplementation(async ({ method }) => {
    if (method === 'eth_requestAccounts') handlers.accountsChanged([ACCOUNT]);
    return method === 'eth_chainId' ? `0x${CHAIN_ID.toString(16)}` : [ACCOUNT];
  });
  await click(screen.getByRole('button', { name: 'Connect wallet' }));
  expect(
    await screen.findByRole('button', { name: 'Enable recovery alerts' })
  ).toBeEnabled();
});

test('a rejected signature does not claim success or persist enrollment', async () => {
  const { provider, service } = setup();
  await screen.findByText(/No smart accounts linked yet/);
  await click(screen.getByRole('button', { name: 'Connect wallet' }));
  await screen.findByRole('button', { name: 'Enable recovery alerts' });
  provider.request.mockImplementation(async ({ method }) => {
    if (method === 'personal_sign')
      throw Object.assign(new Error(), { code: 4001 });
    return method === 'eth_chainId' ? `0x${CHAIN_ID.toString(16)}` : [ACCOUNT];
  });
  await click(screen.getByRole('button', { name: 'Enable recovery alerts' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /signature request was canceled/
  );
  expect(service.subscribe).not.toHaveBeenCalled();
});

test('shows degraded monitoring and accurate expiry without claiming recovery has executed', async () => {
  setup({
    subscriptions: [
      {
        ...SUBSCRIPTION,
        monitoring: { status: 'degraded', lastCheckedAt: 1792600000000 },
        pending: [
          {
            operationId: 'op',
            executableAt: 1792700000,
            expiresAt: 1792900000,
            status: 'ready',
          },
        ],
      },
    ],
  });
  await screen.findByText('Monitoring delayed');
  expect(screen.getByText(/Chain data is not current/)).toBeInTheDocument();
  expect(screen.getByText('Recovery can be executed')).toBeInTheDocument();
  expect(
    screen.getByText(/Passing the deadline does not mean it has executed/)
  ).toBeInTheDocument();
  expect(screen.getByText(/Last chain check:/)).not.toHaveTextContent('58775');
});

test.each([
  ['canceled', 'Recovery canceled or invalidated'],
  ['invalidated', 'Recovery no longer pending'],
  ['orphaned', 'Recovery observation no longer canonical'],
])(
  'labels %s without inventing an operator action or a current execution deadline',
  async (status, label) => {
    setup({
      subscriptions: [
        {
          ...SUBSCRIPTION,
          pending: [
            {
              operationId: 'op',
              executableAt: 1792700000,
              expiresAt: 1792900000,
              status,
            },
          ],
        },
      ],
    });
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.queryByText(/Can execute from/)).not.toBeInTheDocument();
    expect(screen.getByText(/Original execution time/)).toBeInTheDocument();
  }
);

test('disabling requires password and TOTP and identifies the exact account', async () => {
  const { service, authService } = setup({
    subscriptions: [SUBSCRIPTION],
    totp: true,
  });
  await screen.findByText('Savings');
  await click(screen.getByRole('button', { name: 'Disable these alerts…' }));
  expect(screen.getByText('Disable alerts for Savings?')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Disable alerts' })).toBeDisabled();
  await type(
    screen.getByLabelText('Current Sysnode password'),
    'correct-password'
  );
  await type(screen.getByLabelText('Authenticator code'), '123456');
  service.subscriptions.mockResolvedValue([]);
  await click(screen.getByRole('button', { name: 'Disable alerts' }));
  await screen.findByText(/This does not cancel any on-chain recovery/);
  expect(authService.deriveStepUpAuthHash).toHaveBeenCalledWith(
    'correct-password',
    'qa@example.test'
  );
  expect(service.remove).toHaveBeenCalledWith(1, {
    oldAuthHash: 'auth-hash',
    code: '123456',
  });
  expect(
    screen.queryByLabelText('Current Sysnode password')
  ).not.toBeInTheDocument();
});

test('stale 2FA identity responds to server step-up requirement, without losing subscription', async () => {
  const { service } = setup({
    subscriptions: [SUBSCRIPTION],
    service: { remove: jest.fn().mockRejectedValue({ code: 'totp_required' }) },
  });
  await screen.findByText('Savings');
  await click(screen.getByRole('button', { name: 'Disable these alerts…' }));
  fireEvent.change(screen.getByLabelText('Current Sysnode password'), {
    target: { value: 'password' },
  });
  await click(screen.getByRole('button', { name: 'Disable alerts' }));
  await screen.findByLabelText('Authenticator code');
  expect(screen.getByText('Savings')).toBeInTheDocument();
  expect(service.subscriptions).toHaveBeenCalledTimes(1);
});

test('a slow status refresh cannot restore a subscription after it was disabled', async () => {
  const { service } = setup({ subscriptions: [SUBSCRIPTION] });
  await screen.findByText('Savings');
  let finishOldRefresh;
  service.subscriptions.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOldRefresh = resolve;
      })
  );
  await click(screen.getByRole('button', { name: 'Refresh status' }));
  await click(screen.getByRole('button', { name: 'Disable these alerts…' }));
  fireEvent.change(screen.getByLabelText('Current Sysnode password'), {
    target: { value: 'password' },
  });
  service.subscriptions.mockResolvedValue([]);
  await click(screen.getByRole('button', { name: 'Disable alerts' }));
  await screen.findByText(/No smart accounts linked yet/);
  await act(async () => {
    finishOldRefresh([SUBSCRIPTION]);
  });
  expect(screen.queryByText('Savings')).not.toBeInTheDocument();
  expect(screen.getByText(/No smart accounts linked yet/)).toBeInTheDocument();
});

test('no wallet and load failure show retryable honest states', async () => {
  setup({
    hasWallet: false,
    service: { chains: jest.fn().mockRejectedValue({ code: 'network_error' }) },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /could not reach Sysnode/
  );
  expect(
    screen.getByText(/Open this page in a browser with Pali/)
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh status' })).toBeEnabled();
});
