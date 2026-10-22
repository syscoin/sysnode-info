import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { act } from 'react';
import userEvent from '@testing-library/user-event';
import RecoveryAlertsCard from './RecoveryAlertsCard';
import { AuthProvider } from '../context/AuthContext';

const ACCOUNT = `0x${'12'.repeat(20)}`;
const CHAIN_ID = 57057;
const CHAIN = {
  chainId: CHAIN_ID,
  name: 'zkTanenbaum',
  testnet: true,
  recoveryModule: `0x${'45'.repeat(20)}`,
};
const SIGNATURE = `0x${'ab'.repeat(24000)}`;
const SUBSCRIPTION = {
  id: 1,
  chainId: CHAIN_ID,
  recoveryModule: CHAIN.recoveryModule,
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
  emailVerified = true,
  accounts = [ACCOUNT],
  walletNames = ['Pali'],
  service: overrides = {},
} = {}) {
  const handlers = {};
  const provider = {
    request: jest.fn(async ({ method }) =>
      method === 'eth_chainId'
        ? `0x${CHAIN_ID.toString(16)}`
        : method === 'personal_sign'
        ? SIGNATURE
        : accounts
    ),
    on: jest.fn((name, fn) => {
      handlers[name] = fn;
    }),
    removeListener: jest.fn(),
  };
  const discover = jest.fn((cb) => {
    cb(
      hasWallet
        ? walletNames.map((name, index) => ({
            id: `wallet-${index}`,
            name,
            provider: index === 0 ? provider : { ...provider },
          }))
        : []
    );
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
        emailVerified,
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

test('a successful disable removes the active card even when refresh fails', async () => {
  const { service } = setup({ subscriptions: [SUBSCRIPTION] });
  await screen.findByText('Savings');
  await click(screen.getByRole('button', { name: 'Disable these alerts…' }));
  fireEvent.change(screen.getByLabelText('Current Sysnode password'), {
    target: { value: 'password' },
  });
  service.subscriptions.mockRejectedValue({ code: 'network_error' });
  await click(screen.getByRole('button', { name: 'Disable alerts' }));
  await screen.findByText(/This does not cancel any on-chain recovery/);
  expect(screen.queryByText('Savings')).not.toBeInTheDocument();
  expect(screen.queryByText('Monitoring active')).not.toBeInTheDocument();
  expect(screen.getByText(/No smart accounts linked yet/)).toBeInTheDocument();
});

test('a failed status refresh preserves history but no longer claims active monitoring', async () => {
  const { service } = setup({
    subscriptions: [
      {
        ...SUBSCRIPTION,
        monitoring: { status: 'active', lastCheckedAt: Date.now() },
      },
    ],
  });
  await screen.findByText('Monitoring active');
  service.subscriptions.mockRejectedValue({ code: 'network_error' });
  await click(screen.getByRole('button', { name: 'Refresh status' }));
  await screen.findByText('Monitoring delayed');
  expect(screen.queryByText('Monitoring active')).not.toBeInTheDocument();
  expect(screen.getByText('Savings')).toBeInTheDocument();
});

test('an old module subscription does not block enrolling the current module', async () => {
  setup({
    subscriptions: [
      { ...SUBSCRIPTION, recoveryModule: `0x${'67'.repeat(20)}` },
    ],
  });
  await screen.findByText('Savings');
  await click(screen.getByRole('button', { name: 'Connect wallet' }));
  expect(
    await screen.findByRole('button', { name: 'Enable recovery alerts' })
  ).toBeEnabled();
});

test('an old active snapshot is not displayed as current monitoring', async () => {
  setup({
    subscriptions: [
      {
        ...SUBSCRIPTION,
        monitoring: { status: 'active', lastCheckedAt: Date.now() - 120000 },
      },
    ],
  });
  expect(await screen.findByText('Monitoring delayed')).toBeInTheDocument();
  expect(screen.queryByText('Monitoring active')).not.toBeInTheDocument();
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

test('a single wallet and account keep identity visible without redundant pickers', async () => {
  setup();
  await screen.findByText(/No smart accounts linked yet/);
  await screen.findByText('Wallet: Pali');
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  await click(screen.getByRole('button', { name: 'Connect wallet' }));
  await screen.findByText('Smart account');
  expect(screen.getByText(ACCOUNT)).toBeVisible();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});

test('multiple wallets and accounts remain explicitly selectable', async () => {
  const second = `0x${'34'.repeat(20)}`;
  setup({ walletNames: ['Pali', 'Other wallet'], accounts: [ACCOUNT, second] });
  await screen.findByText(/No smart accounts linked yet/);
  expect(await screen.findByLabelText('Wallet')).toBeEnabled();
  await click(screen.getByRole('button', { name: 'Connect wallet' }));
  const account = await screen.findByLabelText('Smart account');
  fireEvent.change(account, { target: { value: second } });
  expect(account).toHaveValue(second);
  expect(
    screen.getByRole('button', { name: `Copy account address ${second}` })
  ).toBeInTheDocument();
});

test('unverified email explains the gate and checks the existing account without signing', async () => {
  const { authService, provider, service } = setup({ emailVerified: false });
  await screen.findByText(/Verify your email before linking/);
  expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeDisabled();
  authService.me.mockResolvedValue({
    user: { id: 1, email: 'qa@example.test', emailVerified: true },
  });
  await click(
    screen.getByRole('button', { name: 'Check verification status' })
  );
  expect(
    await screen.findByRole('button', { name: 'Connect wallet' })
  ).toBeEnabled();
  expect(screen.getByText(/Email verified. You can now link/)).toBeVisible();
  expect(provider.request).not.toHaveBeenCalled();
  expect(service.challenge).not.toHaveBeenCalled();
});

test('an unverified recheck keeps the explanation and does not claim verification', async () => {
  setup({ emailVerified: false });
  await click(
    await screen.findByRole('button', { name: 'Check verification status' })
  );
  expect(
    await screen.findByText(/Your email is not verified yet/)
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeDisabled();
});

test.each([
  { status: 503, code: 'http_error' },
  { status: 0, code: 'network_error' },
])(
  'verification $status failure keeps the real authenticated card with focused retryable error',
  async (failure) => {
    const { authService, provider } = setup({ emailVerified: false });
    await screen.findByRole('button', { name: 'Check verification status' });
    authService.me.mockRejectedValueOnce(failure);
    await click(
      screen.getByRole('button', { name: 'Check verification status' })
    );
    const error = await screen.findByRole('alert');
    expect(error).toHaveFocus();
    expect(error).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Check verification status' })
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Connect wallet' })
    ).toBeDisabled();
    authService.me.mockResolvedValueOnce({
      user: { id: 1, email: 'qa@example.test', emailVerified: true },
    });
    await click(
      screen.getByRole('button', { name: 'Check verification status' })
    );
    expect(
      screen.getByRole('button', { name: 'Connect wallet' })
    ).toBeEnabled();
    expect(provider.request).not.toHaveBeenCalled();
  }
);

test('only nonurgent terminal history collapses, while pending deadlines and unknown states remain visible', async () => {
  setup({
    subscriptions: [
      {
        ...SUBSCRIPTION,
        pending: [
          {
            operationId: 'pending',
            status: 'pending',
            executableAt: 1792700000,
          },
          {
            operationId: 'canceled',
            status: 'canceled',
            executableAt: 1792600000,
          },
          {
            operationId: 'unknown',
            status: 'unknown',
            executableAt: 1792500000,
          },
        ],
      },
    ],
  });
  expect(await screen.findByText('Recovery pending')).toBeVisible();
  expect(screen.getByText(/Can execute from/)).toBeVisible();
  expect(screen.getByText('Recovery status unavailable')).toBeVisible();
  const past = screen.getByText('Recovery canceled or invalidated');
  expect(past).not.toBeVisible();
  await click(screen.getByText('Past recovery activity (1)'));
  expect(past).toBeVisible();
  await click(screen.getByText('How to review in Pali'));
  expect(screen.getByText('Disable guardian recovery')).toBeVisible();
  expect(
    screen.getByRole('link', { name: 'Read the recovery guide' })
  ).toHaveAttribute(
    'href',
    'https://docs.paliwallet.com/docs/users/recovery-and-backups'
  );
});

test('executed recovery stays visible and never offers pending-recovery cancellation instructions', async () => {
  setup({
    subscriptions: [
      {
        ...SUBSCRIPTION,
        pending: [
          {
            operationId: 'executed',
            status: 'executed',
            executableAt: 1792700000,
          },
          {
            operationId: 'canceled',
            status: 'canceled',
            executableAt: 1792600000,
          },
        ],
      },
    ],
  });
  expect(await screen.findByText('Recovery executed')).toBeVisible();
  expect(
    screen.getByText(/Recovery has executed. Review this account/)
  ).toBeVisible();
  expect(
    screen.getByText('Recovery canceled or invalidated')
  ).not.toBeVisible();
  await click(screen.getByText('How to review in Pali'));
  expect(
    screen.queryByText('Disable guardian recovery')
  ).not.toBeInTheDocument();
  expect(screen.getByText(/Disabling emails cannot undo it/)).toBeVisible();
});

test.each(['enroll', 'remove'])(
  'a failed %s action focuses its local error without animated scrolling',
  async (operation) => {
    const original = HTMLElement.prototype.scrollIntoView;
    const scroll = jest.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const { provider } = setup({
        subscriptions: operation === 'remove' ? [SUBSCRIPTION] : [],
        service: {
          remove: jest.fn().mockRejectedValue({ code: 'invalid_credentials' }),
        },
      });
      await screen.findByRole('button', { name: 'Refresh status' });
      if (operation === 'remove') {
        await click(
          await screen.findByRole('button', { name: 'Disable these alerts…' })
        );
        await type(
          screen.getByLabelText('Current Sysnode password'),
          'wrong-password'
        );
        scroll.mockClear();
        await click(
          screen.getByRole('button', { name: 'Disable alerts', exact: true })
        );
      } else {
        await screen.findByText(/No smart accounts linked yet/);
        await click(
          await screen.findByRole('button', { name: 'Connect wallet' })
        );
        provider.request.mockImplementation(async ({ method }) => {
          if (method === 'personal_sign') throw { code: 4001 };
          return method === 'eth_chainId'
            ? `0x${CHAIN_ID.toString(16)}`
            : [ACCOUNT];
        });
        await click(
          await screen.findByRole('button', { name: 'Enable recovery alerts' })
        );
      }
      const error = await screen.findByRole('alert');
      expect(error).toHaveFocus();
      expect(error.closest('form')).toHaveClass(
        operation === 'remove' ? 'recovery-remove' : 'recovery-enroll'
      );
      expect(scroll).toHaveBeenLastCalledWith({
        block: 'nearest',
        behavior: 'instant',
      });
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  }
);

test('background status failure and typing never steal focus or scroll', async () => {
  const original = HTMLElement.prototype.scrollIntoView;
  const scroll = jest.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    const { service } = setup();
    await screen.findByText(/No smart accounts linked yet/);
    await click(await screen.findByRole('button', { name: 'Connect wallet' }));
    const label = screen.getByLabelText('Account label (optional)');
    label.focus();
    await type(label, 'My savings');
    service.subscriptions.mockRejectedValue({ code: 'network_error' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not reach Sysnode/
    );
    expect(label).toHaveFocus();
    expect(scroll).not.toHaveBeenCalled();
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});

test('a rejected pending signature reopens enrollment details before focusing its error', async () => {
  const { provider, service } = setup();
  await screen.findByText(/No smart accounts linked yet/);
  await click(screen.getByRole('button', { name: 'Connect wallet' }));
  let rejectSignature;
  provider.request.mockImplementation(async ({ method }) => {
    if (method === 'personal_sign')
      return new Promise((_resolve, reject) => {
        rejectSignature = reject;
      });
    return method === 'eth_chainId' ? `0x${CHAIN_ID.toString(16)}` : [ACCOUNT];
  });
  await click(screen.getByRole('button', { name: 'Enable recovery alerts' }));
  await waitFor(() => expect(rejectSignature).toBeDefined());
  expect(
    screen.getByRole('button', { name: 'Collapse recovery alerts' })
  ).toBeDisabled();
  const disclosure = screen
    .getByText('Link a smart account')
    .closest('details');
  disclosure.open = false;
  await act(async () => {
    rejectSignature({ code: 4001 });
  });
  const error = await screen.findByRole('alert');
  expect(error).toBeVisible();
  expect(error).toHaveFocus();
  expect(service.subscribe).not.toHaveBeenCalled();
});
