import {
  isPaliAvailable,
  getPali,
  paliRequest,
  requestAccounts,
  getChainId,
  switchChain,
  payWithOpReturn,
  __internal,
} from './paliProvider';

function installPaliMock(implementation) {
  // jsdom / CRA test env provides a real window object. Mutating it
  // here is safe because afterEach removes our stub, leaving the
  // environment as pristine as we found it.
  Object.defineProperty(window, 'pali', {
    value: implementation,
    configurable: true,
    writable: true,
  });
}

function uninstallPaliMock() {
  delete window.pali;
}

describe('paliProvider detection', () => {
  afterEach(uninstallPaliMock);

  test('isPaliAvailable() false when window.pali missing', () => {
    expect(isPaliAvailable()).toBe(false);
    expect(getPali()).toBeNull();
  });

  test('isPaliAvailable() false when window.pali exists but has no request()', () => {
    installPaliMock({});
    expect(isPaliAvailable()).toBe(false);
  });

  test('isPaliAvailable() true when window.pali.request is a function', () => {
    installPaliMock({ request: jest.fn() });
    expect(isPaliAvailable()).toBe(true);
    expect(getPali()).toBe(window.pali);
  });
});

describe('paliRequest', () => {
  afterEach(uninstallPaliMock);

  test('throws pali_unavailable when provider missing', async () => {
    await expect(paliRequest('x')).rejects.toMatchObject({
      code: 'pali_unavailable',
    });
  });

  test('passes method + params through unchanged', async () => {
    const request = jest.fn().mockResolvedValue('ok');
    installPaliMock({ request });
    const out = await paliRequest('sys_requestAccounts', [{ a: 1 }]);
    expect(out).toBe('ok');
    expect(request).toHaveBeenCalledWith({
      method: 'sys_requestAccounts',
      params: [{ a: 1 }],
    });
  });

  test('omits params from the envelope when undefined', async () => {
    const request = jest.fn().mockResolvedValue('ok');
    installPaliMock({ request });
    await paliRequest('sys_requestAccounts');
    expect(request).toHaveBeenCalledWith({ method: 'sys_requestAccounts' });
  });

  test('translates EIP-1193 4001 to user_rejected', async () => {
    const err = Object.assign(new Error('User rejected request.'), {
      code: 4001,
    });
    const request = jest.fn().mockRejectedValue(err);
    installPaliMock({ request });
    await expect(paliRequest('x')).rejects.toMatchObject({
      code: 'user_rejected',
      rpcCode: 4001,
    });
  });

  test('translates 4100 unauthorized and 4200 method_not_supported', async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 4100 }))
      .mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 4200 }));
    installPaliMock({ request });
    await expect(paliRequest('x')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(paliRequest('y')).rejects.toMatchObject({
      code: 'method_not_supported',
    });
  });

  test('translates 4900 disconnected and 4901 chain_disconnected', async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error(''), { code: 4900 }))
      .mockRejectedValueOnce(Object.assign(new Error(''), { code: 4901 }));
    installPaliMock({ request });
    await expect(paliRequest('x')).rejects.toMatchObject({
      code: 'disconnected',
    });
    await expect(paliRequest('y')).rejects.toMatchObject({
      code: 'chain_disconnected',
    });
  });

  test('preserves string .code errors verbatim when not an EIP-1193 number', async () => {
    const err = Object.assign(new Error('denied'), { code: 'denied' });
    const request = jest.fn().mockRejectedValue(err);
    installPaliMock({ request });
    await expect(paliRequest('x')).rejects.toMatchObject({ code: 'denied' });
  });

  test('falls back to pali_request_failed on shapeless errors', async () => {
    const request = jest.fn().mockRejectedValue('bare string');
    installPaliMock({ request });
    await expect(paliRequest('x')).rejects.toMatchObject({
      code: 'pali_request_failed',
    });
  });
});

describe('requestAccounts', () => {
  afterEach(uninstallPaliMock);

  test('asks pali for sys_requestAccounts and returns the array as-is', async () => {
    const request = jest.fn().mockResolvedValue(['sys1abc', 'sys1def']);
    installPaliMock({ request });
    const out = await requestAccounts();
    expect(out).toEqual(['sys1abc', 'sys1def']);
    expect(request).toHaveBeenCalledWith({ method: 'sys_requestAccounts' });
  });
});

describe('getChainId', () => {
  afterEach(uninstallPaliMock);

  test('returns the provider property when set (no request roundtrip)', async () => {
    const request = jest.fn();
    installPaliMock({ request, chainId: '0x39' });
    await expect(getChainId()).resolves.toBe('0x39');
    expect(request).not.toHaveBeenCalled();
  });

  test('falls back to eth_chainId when the property is missing', async () => {
    const request = jest.fn().mockResolvedValue('0x39');
    installPaliMock({ request, chainId: null });
    await expect(getChainId()).resolves.toBe('0x39');
    expect(request).toHaveBeenCalledWith({ method: 'eth_chainId' });
  });

  test('throws pali_unavailable when no provider', async () => {
    await expect(getChainId()).rejects.toMatchObject({
      code: 'pali_unavailable',
    });
  });
});

describe('switchChain', () => {
  afterEach(uninstallPaliMock);

  test('rejects malformed chain ids without a round trip', async () => {
    const request = jest.fn();
    installPaliMock({ request });
    await expect(switchChain('57')).rejects.toMatchObject({
      code: 'invalid_chain_id',
    });
    await expect(switchChain('0xZZ')).rejects.toMatchObject({
      code: 'invalid_chain_id',
    });
    expect(request).not.toHaveBeenCalled();
  });

  test('forwards valid chain id via wallet_switchEthereumChain', async () => {
    const request = jest.fn().mockResolvedValue(null);
    installPaliMock({ request });
    await switchChain('0x39');
    expect(request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x39' }],
    });
  });
});

describe('payWithOpReturn (stub)', () => {
  afterEach(uninstallPaliMock);

  test('fails with the stable not-wired code regardless of provider state', async () => {
    await expect(payWithOpReturn()).rejects.toMatchObject({
      code: __internal.NOT_SUPPORTED,
    });
    installPaliMock({ request: jest.fn() });
    await expect(payWithOpReturn()).rejects.toMatchObject({
      code: __internal.NOT_SUPPORTED,
    });
  });
});
