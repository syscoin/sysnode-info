import {
  isPaliAvailable,
  getPali,
  paliRequest,
  requestAccounts,
  getChainId,
  switchChain,
  payProposalCollateralWithPali,
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

describe('normalizeSignAndSendResult', () => {
  const { normalizeSignAndSendResult } = __internal;
  const hex = 'a'.repeat(64);

  test('accepts a bare 64-hex string', () => {
    expect(normalizeSignAndSendResult(hex)).toBe(hex);
  });

  test('lowercases the txid', () => {
    expect(normalizeSignAndSendResult('A'.repeat(64))).toBe('a'.repeat(64));
  });

  test('extracts .txid from an envelope', () => {
    expect(normalizeSignAndSendResult({ txid: hex })).toBe(hex);
  });

  test('extracts .transactionId from a legacy envelope', () => {
    expect(normalizeSignAndSendResult({ transactionId: hex })).toBe(hex);
  });

  test('rejects non-hex and truncated txids', () => {
    expect(() => normalizeSignAndSendResult('nope')).toThrow(/bad_signer_response/);
    expect(() => normalizeSignAndSendResult('a'.repeat(63))).toThrow(
      /bad_signer_response/
    );
    expect(() => normalizeSignAndSendResult({ txid: 123 })).toThrow(
      /bad_signer_response/
    );
    expect(() => normalizeSignAndSendResult(null)).toThrow(/bad_signer_response/);
  });
});

describe('chainIdMatchesServer', () => {
  const { chainIdMatchesServer } = __internal;

  test('mainnet server matches 0x39 (case insensitive)', () => {
    expect(chainIdMatchesServer('0x39', 'mainnet')).toBe(true);
    expect(chainIdMatchesServer('0X39', 'mainnet')).toBe(true);
    expect(chainIdMatchesServer('0x40', 'mainnet')).toBe(false);
  });

  test('testnet server matches 0x40', () => {
    expect(chainIdMatchesServer('0x40', 'testnet')).toBe(true);
    expect(chainIdMatchesServer('0x39', 'testnet')).toBe(false);
  });

  test('returns false for unknown server keys or missing pali chainId', () => {
    expect(chainIdMatchesServer('0x39', 'devnet')).toBe(false);
    expect(chainIdMatchesServer(null, 'mainnet')).toBe(false);
    expect(chainIdMatchesServer(undefined, 'mainnet')).toBe(false);
  });
});

describe('payProposalCollateralWithPali', () => {
  const TXID = 'a'.repeat(64);

  afterEach(uninstallPaliMock);

  function buildApi(overrides = {}) {
    return {
      getGovernanceNetwork: jest.fn().mockResolvedValue({
        paliPathEnabled: true,
        networkKey: 'mainnet',
        chain: 'main',
        slip44: 57,
      }),
      buildCollateralPsbt: jest.fn().mockResolvedValue({
        psbt: { psbt: 'base64-psbt', assets: '[]' },
        feeSats: '1234',
      }),
      ...overrides,
    };
  }

  function installHappyPali({ requestOverride } = {}) {
    const request = jest.fn(async ({ method }) => {
      switch (method) {
        case 'sys_requestAccounts':
          return ['sys1qabc'];
        case 'sys_getPublicKey':
          return 'zpub6q'.padEnd(30, 'a');
        case 'sys_getChangeAddress':
          return 'sys1qchange';
        case 'sys_signAndSend':
          return { txid: TXID };
        default:
          throw new Error(`unexpected method ${method}`);
      }
    });
    installPaliMock({ request: requestOverride || request, chainId: '0x39' });
    return requestOverride || request;
  }

  test('happy path: probe -> connect -> build -> sign -> normalized txid', async () => {
    const request = installHappyPali();
    const api = buildApi();
    const onProgress = jest.fn();
    const out = await payProposalCollateralWithPali(42, api, { onProgress });
    expect(out).toEqual({
      txid: TXID,
      feeSats: '1234',
      xpub: expect.any(String),
      changeAddress: 'sys1qchange',
    });
    expect(api.getGovernanceNetwork).toHaveBeenCalledTimes(1);
    expect(api.buildCollateralPsbt).toHaveBeenCalledWith(42, {
      xpub: expect.any(String),
      changeAddress: 'sys1qchange',
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'sys_signAndSend' })
    );
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
      'connecting',
      'building',
      'awaiting_signature',
    ]);
  });

  test('throws pali_unavailable when extension is not installed', async () => {
    const api = buildApi();
    await expect(payProposalCollateralWithPali(1, api)).rejects.toMatchObject({
      code: 'pali_unavailable',
    });
    expect(api.getGovernanceNetwork).not.toHaveBeenCalled();
  });

  test('throws pali_path_disabled when server reports the flag off', async () => {
    installHappyPali();
    const api = buildApi({
      getGovernanceNetwork: jest.fn().mockResolvedValue({
        paliPathEnabled: false,
        networkKey: 'mainnet',
      }),
    });
    await expect(payProposalCollateralWithPali(1, api)).rejects.toMatchObject({
      code: 'pali_path_disabled',
    });
    expect(api.buildCollateralPsbt).not.toHaveBeenCalled();
  });

  test('throws network_mismatch when Pali chainId does not match server', async () => {
    const request = jest.fn(async ({ method }) => {
      switch (method) {
        case 'sys_requestAccounts':
          return ['addr'];
        case 'sys_getPublicKey':
          return 'zpub6q'.padEnd(30, 'a');
        case 'sys_getChangeAddress':
          return 'sys1qchange';
        default:
          throw new Error(`unexpected method ${method}`);
      }
    });
    installPaliMock({ request, chainId: '0x40' });
    const api = buildApi();
    await expect(payProposalCollateralWithPali(1, api)).rejects.toMatchObject({
      code: 'network_mismatch',
    });
    expect(api.buildCollateralPsbt).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'sys_signAndSend' })
    );
  });

  test('bubbles user_rejected from sys_signAndSend', async () => {
    const request = jest.fn(async ({ method }) => {
      switch (method) {
        case 'sys_requestAccounts':
          return ['addr'];
        case 'sys_getPublicKey':
          return 'zpub6q'.padEnd(30, 'a');
        case 'sys_getChangeAddress':
          return 'sys1qchange';
        case 'sys_signAndSend':
          throw Object.assign(new Error('user cancelled'), { code: 4001 });
        default:
          throw new Error(`unexpected method ${method}`);
      }
    });
    installPaliMock({ request, chainId: '0x39' });
    const api = buildApi();
    await expect(payProposalCollateralWithPali(7, api)).rejects.toMatchObject({
      code: 'user_rejected',
    });
    expect(api.buildCollateralPsbt).toHaveBeenCalledTimes(1);
  });

  test('propagates server insufficient_funds error verbatim', async () => {
    installHappyPali();
    const err = Object.assign(new Error('not enough'), {
      code: 'insufficient_funds',
      shortfallSats: 1234,
    });
    const api = buildApi({
      buildCollateralPsbt: jest.fn().mockRejectedValue(err),
    });
    await expect(payProposalCollateralWithPali(9, api)).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
  });

  test('rejects malformed signer responses with bad_signer_response', async () => {
    const request = jest.fn(async ({ method }) => {
      switch (method) {
        case 'sys_requestAccounts':
          return ['addr'];
        case 'sys_getPublicKey':
          return 'zpub6q'.padEnd(30, 'a');
        case 'sys_getChangeAddress':
          return 'sys1qchange';
        case 'sys_signAndSend':
          return { not_a_txid: true };
        default:
          throw new Error(`unexpected method ${method}`);
      }
    });
    installPaliMock({ request, chainId: '0x39' });
    const api = buildApi();
    await expect(payProposalCollateralWithPali(5, api)).rejects.toMatchObject({
      code: 'bad_signer_response',
    });
  });

  test('asserts API shape: missing methods throw synchronously (as a rejection)', async () => {
    installPaliMock({ request: jest.fn(), chainId: '0x39' });
    await expect(
      payProposalCollateralWithPali(1, { buildCollateralPsbt: () => {} })
    ).rejects.toThrow(/buildCollateralPsbt \+ getGovernanceNetwork/);
  });
});
