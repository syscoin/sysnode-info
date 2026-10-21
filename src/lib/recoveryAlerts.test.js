import {
  createRecoveryAlertsService,
  discoverWallets,
  enrollRecoveryAlerts,
  parseEvmChainId,
  readWalletSelection,
} from './recoveryAlerts';

const ACCOUNT = `0x${'12'.repeat(20)}`;
const OTHER = `0x${'34'.repeat(20)}`;
const CHAIN = 57057;
const SIGNATURE = `0x${'ab'.repeat(24000)}`;

function fixture() {
  const handlers = {};
  const provider = {
    request: jest.fn(async ({ method }) => {
      if (method === 'eth_chainId') return `0x${CHAIN.toString(16)}`;
      if (method === 'personal_sign') return SIGNATURE;
      return [ACCOUNT];
    }),
    on: jest.fn((event, fn) => {
      handlers[event] = fn;
    }),
    removeListener: jest.fn(),
  };
  const service = {
    challenge: jest.fn().mockResolvedValue({
      id: 'nonce',
      message: 'Enable recovery alerts — user@example.test',
      chainId: CHAIN,
      account: ACCOUNT,
    }),
    subscribe: jest.fn().mockResolvedValue({ id: 1, account: ACCOUNT }),
  };
  return { provider, service, handlers };
}

test('uses authenticated API methods and never sends wallet keys or an RPC URL', async () => {
  const client = {
    get: jest
      .fn()
      .mockResolvedValue({ data: { chains: [], subscriptions: [] } }),
    post: jest.fn().mockResolvedValue({ data: { subscription: { id: 1 } } }),
    delete: jest.fn().mockResolvedValue({ data: { ok: true } }),
  };
  const service = createRecoveryAlertsService(client);
  await service.chains();
  await service.subscriptions();
  await service.challenge(CHAIN, ACCOUNT);
  await service.subscribe('nonce', SIGNATURE, 'Savings');
  await service.remove(1, { oldAuthHash: 'hash', code: '123456' });
  expect(client.get.mock.calls).toEqual([
    ['/recovery/chains'],
    ['/recovery/subscriptions'],
  ]);
  expect(client.post.mock.calls).toEqual([
    ['/recovery/challenges', { chainId: CHAIN, account: ACCOUNT }],
    [
      '/recovery/subscriptions',
      { challengeId: 'nonce', signature: SIGNATURE, label: 'Savings' },
    ],
  ]);
  expect(client.delete).toHaveBeenCalledWith('/recovery/subscriptions/1', {
    data: { oldAuthHash: 'hash', code: '123456' },
  });
});

test('standard personal_sign preserves a long ERC1271 signature and UTF8 bytes', async () => {
  const { provider, service } = fixture();
  await expect(
    enrollRecoveryAlerts({
      provider,
      service,
      chainId: CHAIN,
      account: ACCOUNT,
      label: 'Savings',
    })
  ).resolves.toEqual({ id: 1, account: ACCOUNT });
  const call = provider.request.mock.calls.find(
    ([arg]) => arg.method === 'personal_sign'
  )[0];
  expect(Buffer.from(call.params[0].slice(2), 'hex').toString('utf8')).toBe(
    'Enable recovery alerts — user@example.test'
  );
  expect(call.params[1]).toBe(ACCOUNT);
  expect(service.subscribe).toHaveBeenCalledWith('nonce', SIGNATURE, 'Savings');
  expect(provider.removeListener).toHaveBeenCalledTimes(3);
});

test('a user rejection never saves an enrollment', async () => {
  const { provider, service } = fixture();
  provider.request.mockImplementation(async ({ method }) => {
    if (method === 'personal_sign')
      throw Object.assign(new Error(), { code: 4001 });
    return method === 'eth_chainId' ? `0x${CHAIN.toString(16)}` : [ACCOUNT];
  });
  await expect(
    enrollRecoveryAlerts({
      provider,
      service,
      chainId: CHAIN,
      account: ACCOUNT,
    })
  ).rejects.toMatchObject({ code: 4001 });
  expect(service.subscribe).not.toHaveBeenCalled();
});

test('account changes while signing invalidate proof even if a signature arrives', async () => {
  const { provider, service, handlers } = fixture();
  provider.request.mockImplementation(async ({ method }) => {
    if (method === 'personal_sign') {
      handlers.accountsChanged([OTHER]);
      return SIGNATURE;
    }
    return method === 'eth_chainId' ? `0x${CHAIN.toString(16)}` : [ACCOUNT];
  });
  await expect(
    enrollRecoveryAlerts({
      provider,
      service,
      chainId: CHAIN,
      account: ACCOUNT,
    })
  ).rejects.toMatchObject({ code: 'wallet_changed' });
  expect(service.subscribe).not.toHaveBeenCalled();
});

test('a network change while requesting the challenge prevents any signing', async () => {
  const { provider, service, handlers } = fixture();
  service.challenge.mockImplementation(async () => {
    handlers.chainChanged('0x1');
    return { id: 'nonce', message: 'Test', chainId: CHAIN, account: ACCOUNT };
  });
  await expect(
    enrollRecoveryAlerts({
      provider,
      service,
      chainId: CHAIN,
      account: ACCOUNT,
    })
  ).rejects.toMatchObject({ code: 'wallet_changed' });
  expect(
    provider.request.mock.calls.some(([arg]) => arg.method === 'personal_sign')
  ).toBe(false);
});

test('challenge identity must match the user selected chain and smart account', async () => {
  const { provider, service } = fixture();
  service.challenge.mockResolvedValue({
    id: 'nonce',
    message: 'wrong',
    chainId: CHAIN,
    account: OTHER,
  });
  await expect(
    enrollRecoveryAlerts({
      provider,
      service,
      chainId: CHAIN,
      account: ACCOUNT,
    })
  ).rejects.toMatchObject({ code: 'invalid_challenge' });
  expect(service.subscribe).not.toHaveBeenCalled();
});

test('context switching while the save is in flight does not falsely claim no subscription was made', async () => {
  const { provider, service, handlers } = fixture();
  service.subscribe.mockImplementation(async () => {
    handlers.chainChanged('0x1');
    return { id: 1 };
  });
  await expect(
    enrollRecoveryAlerts({
      provider,
      service,
      chainId: CHAIN,
      account: ACCOUNT,
    })
  ).rejects.toMatchObject({
    code: 'wallet_changed',
    enrollmentMayHaveCompleted: true,
  });
});

test('reads only safe chain IDs and well formed accounts', async () => {
  expect(parseEvmChainId('0xde e1')).toBeNull();
  expect(parseEvmChainId('57057')).toBeNull();
  expect(parseEvmChainId('0xffffffffffffffffffff')).toBeNull();
  const { provider } = fixture();
  provider.request.mockResolvedValue(['not an address']);
  await expect(readWalletSelection(provider)).rejects.toMatchObject({
    code: 'wallet_account_missing',
  });
});

test('EIP6963 discovery deduplicates providers and never renders supplied SVG or HTML', () => {
  const provider = { request: jest.fn() };
  const target = new EventTarget();
  const changed = jest.fn();
  target.ethereum = provider;
  const stop = discoverWallets(changed, target);
  const event = new Event('eip6963:announceProvider');
  event.detail = {
    info: {
      name: '<svg onload=bad()>',
      uuid: 'uuid',
      icon: 'data:image/svg+xml,bad',
    },
    provider,
  };
  target.dispatchEvent(event);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0]).toEqual([
    { name: 'Browser wallet', id: 'wallet-0', provider },
  ]);
  stop();
});
