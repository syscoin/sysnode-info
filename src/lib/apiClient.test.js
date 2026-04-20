import MockAdapter from 'axios-mock-adapter';
import {
  apiClient,
  createApiClient,
  readCsrfCookie,
  setAuthLostHandler,
  toApiError,
} from './apiClient';

function setCookie(value) {
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get() {
      return value;
    },
  });
}

afterEach(() => {
  setCookie('');
});

describe('readCsrfCookie', () => {
  test('extracts csrf cookie value from document.cookie', () => {
    setCookie('other=1; csrf=abcdef; trailing=x');
    expect(readCsrfCookie()).toBe('abcdef');
  });

  test('returns null when cookie is absent', () => {
    setCookie('other=1');
    expect(readCsrfCookie()).toBeNull();
  });

  test('url-decodes cookie values', () => {
    setCookie('csrf=abc%2Fdef');
    expect(readCsrfCookie()).toBe('abc/def');
  });
});

describe('createApiClient — CSRF attachment', () => {
  test('attaches X-CSRF-Token to state-changing methods', async () => {
    const client = createApiClient({
      baseURL: 'http://test',
      readCsrf: () => 'tok-123',
    });
    const adapter = new MockAdapter(client);
    adapter.onPost('/auth/login').reply(200, { ok: true });

    const res = await client.post('/auth/login', {});
    expect(res.data).toEqual({ ok: true });
    expect(adapter.history.post[0].headers['X-CSRF-Token']).toBe('tok-123');
  });

  test('does NOT attach the header on GET requests', async () => {
    const client = createApiClient({
      baseURL: 'http://test',
      readCsrf: () => 'tok-123',
    });
    const adapter = new MockAdapter(client);
    adapter.onGet('/auth/me').reply(200, {});

    await client.get('/auth/me');
    expect(adapter.history.get[0].headers['X-CSRF-Token']).toBeUndefined();
  });

  test('omits the header when no cookie is present', async () => {
    const client = createApiClient({
      baseURL: 'http://test',
      readCsrf: () => null,
    });
    const adapter = new MockAdapter(client);
    adapter.onPost('/vault').reply(200, {});
    await client.post('/vault', {});
    expect(adapter.history.post[0].headers['X-CSRF-Token']).toBeUndefined();
  });
});

describe('createApiClient — 401 handling', () => {
  test('invokes onAuthLost for non-auth 401s', async () => {
    const onAuthLost = jest.fn();
    const client = createApiClient({
      baseURL: 'http://test',
      readCsrf: () => null,
      onAuthLost,
    });
    const adapter = new MockAdapter(client);
    adapter.onGet('/vault').reply(401, { error: 'unauthorized' });

    await expect(client.get('/vault')).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  test('does NOT invoke onAuthLost for /auth/* 401s (credential errors)', async () => {
    const onAuthLost = jest.fn();
    const client = createApiClient({
      baseURL: 'http://test',
      readCsrf: () => null,
      onAuthLost,
    });
    const adapter = new MockAdapter(client);
    adapter.onPost('/auth/login').reply(401, { error: 'invalid_credentials' });

    await expect(client.post('/auth/login', {})).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  test('onAuthLost exception does not crash the error path', async () => {
    const client = createApiClient({
      baseURL: 'http://test',
      readCsrf: () => null,
      onAuthLost: () => {
        throw new Error('boom');
      },
    });
    const adapter = new MockAdapter(client);
    adapter.onGet('/vault').reply(401, { error: 'unauthorized' });
    await expect(client.get('/vault')).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('default apiClient singleton — setAuthLostHandler wiring (Codex round 2 P2)', () => {
  afterEach(() => {
    setAuthLostHandler(null);
  });

  test('routes non-auth 401s to the registered handler', async () => {
    const handler = jest.fn();
    setAuthLostHandler(handler);

    const adapter = new MockAdapter(apiClient);
    adapter.onGet('/vault').reply(401, { error: 'unauthorized' });

    await expect(apiClient.get('/vault')).rejects.toMatchObject({
      status: 401,
    });
    expect(handler).toHaveBeenCalledTimes(1);

    adapter.restore();
  });

  test('no-ops when no handler is registered (slot cleared)', async () => {
    setAuthLostHandler(null);
    const adapter = new MockAdapter(apiClient);
    adapter.onGet('/vault').reply(401, { error: 'unauthorized' });

    // Should reject cleanly without throwing from the interceptor.
    await expect(apiClient.get('/vault')).rejects.toMatchObject({
      status: 401,
    });
    adapter.restore();
  });

  test('ignores /auth/* 401s (credential errors, not session loss)', async () => {
    const handler = jest.fn();
    setAuthLostHandler(handler);
    const adapter = new MockAdapter(apiClient);
    adapter.onPost('/auth/login').reply(401, { error: 'invalid_credentials' });

    await expect(apiClient.post('/auth/login', {})).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    expect(handler).not.toHaveBeenCalled();
    adapter.restore();
  });

  test('the latest registered handler wins (AuthProvider remount semantics)', async () => {
    const first = jest.fn();
    const second = jest.fn();
    setAuthLostHandler(first);
    setAuthLostHandler(second);

    const adapter = new MockAdapter(apiClient);
    adapter.onGet('/vault').reply(401);
    await expect(apiClient.get('/vault')).rejects.toBeDefined();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    adapter.restore();
  });
});

describe('toApiError', () => {
  test('normalises response errors with backend error code', () => {
    const e = toApiError({
      response: { status: 409, data: { error: 'already_verified' } },
    });
    expect(e.code).toBe('already_verified');
    expect(e.status).toBe(409);
  });

  test('falls back to http_error when no code present', () => {
    const e = toApiError({ response: { status: 500, data: null } });
    expect(e.code).toBe('http_error');
    expect(e.status).toBe(500);
  });

  test('maps transport failures to network_error', () => {
    const e = toApiError(new Error('ECONNREFUSED'));
    expect(e.code).toBe('network_error');
    expect(e.status).toBe(0);
  });
});
