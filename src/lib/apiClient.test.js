import MockAdapter from 'axios-mock-adapter';
import {
  apiClient,
  createApiClient,
  parseRetryAfter,
  readCsrfCookie,
  resolveDefaultApiBase,
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

describe('resolveDefaultApiBase', () => {
  test('uses explicit REACT_APP_API_BASE override', () => {
    expect(
      resolveDefaultApiBase({
        apiBase: 'https://api.example.test',
        nodeEnv: 'production',
      })
    ).toBe('https://api.example.test');
  });

  test('defaults production authenticated calls to same-origin relative paths', () => {
    expect(resolveDefaultApiBase({ apiBase: '', nodeEnv: 'production' })).toBe(
      ''
    );
  });

  test('keeps localhost backend default for development', () => {
    expect(resolveDefaultApiBase({ apiBase: '', nodeEnv: 'development' })).toBe(
      'http://localhost:3001'
    );
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

describe('createApiClient — no global Content-Type (Codex round 3 P2)', () => {
  // A global Content-Type would convert cross-origin GETs into non-
  // simple CORS preflights and break /auth/me on boot.
  test('GET requests carry no Content-Type from client defaults', async () => {
    const client = createApiClient({
      baseURL: 'http://test',
      readCsrf: () => null,
    });
    const adapter = new MockAdapter(client);
    adapter.onGet('/auth/me').reply(200, {});

    await client.get('/auth/me');
    const headers = adapter.history.get[0].headers || {};
    // Neither the per-request slot nor common should inject it.
    expect(headers['Content-Type']).toBeUndefined();
    // Axios also exposes common defaults on the instance — they must
    // not contain Content-Type either.
    expect(
      client.defaults.headers &&
        client.defaults.headers.common &&
        client.defaults.headers.common['Content-Type']
    ).toBeUndefined();
  });

  test('POST with a JSON body still gets Content-Type from axios body inference', async () => {
    const client = createApiClient({
      baseURL: 'http://test',
      readCsrf: () => null,
    });
    const adapter = new MockAdapter(client);
    adapter.onPost('/auth/login').reply(200, {});

    await client.post('/auth/login', { email: 'a@b.com', password: 'p' });
    const ct = adapter.history.post[0].headers['Content-Type'] || '';
    expect(ct.toLowerCase()).toMatch(/^application\/json/);
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

  test('invokes onAuthLost for non-credential /auth/verify-password 401s', async () => {
    const onAuthLost = jest.fn();
    const client = createApiClient({
      baseURL: 'http://test',
      readCsrf: () => null,
      onAuthLost,
    });
    const adapter = new MockAdapter(client);
    adapter
      .onPost('/auth/verify-password')
      .reply(401, { error: 'unauthorized' });

    await expect(
      client.post('/auth/verify-password', {})
    ).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  test('does NOT invoke onAuthLost for verify-password password mismatches', async () => {
    const onAuthLost = jest.fn();
    const client = createApiClient({
      baseURL: 'http://test',
      readCsrf: () => null,
      onAuthLost,
    });
    const adapter = new MockAdapter(client);
    adapter
      .onPost('/auth/verify-password')
      .reply(401, { error: 'invalid_credentials' });

    await expect(
      client.post('/auth/verify-password', {})
    ).rejects.toMatchObject({
      code: 'invalid_credentials',
      status: 401,
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

  test('surfaces Retry-After (seconds) on 429 as retryAfterMs', () => {
    const e = toApiError({
      response: {
        status: 429,
        data: { error: 'too_many_vote_requests' },
        headers: { 'retry-after': '120' },
      },
    });
    expect(e.code).toBe('too_many_vote_requests');
    expect(e.status).toBe(429);
    expect(e.retryAfterMs).toBe(120 * 1000);
  });

  test('Retry-After HTTP-date is converted to a delta from now', () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toUTCString();
    const e = toApiError({
      response: {
        status: 429,
        data: null,
        headers: { 'retry-after': future },
      },
    });
    expect(e.retryAfterMs).toBeGreaterThan(4 * 60 * 1000);
    expect(e.retryAfterMs).toBeLessThan(6 * 60 * 1000);
  });

  test('falls back to RateLimit-Reset when Retry-After is missing', () => {
    const e = toApiError({
      response: {
        status: 429,
        data: null,
        headers: { 'ratelimit-reset': '42' },
      },
    });
    expect(e.retryAfterMs).toBe(42 * 1000);
  });

  test('does not attach retryAfterMs for statuses other than 429 / 503', () => {
    const e = toApiError({
      response: {
        status: 409,
        data: null,
        headers: { 'retry-after': '30' },
      },
    });
    expect(e.retryAfterMs).toBeUndefined();
  });

  test('503 responses also surface retryAfterMs when the header is present', () => {
    const e = toApiError({
      response: {
        status: 503,
        data: { error: 'unavailable' },
        headers: { 'retry-after': '15' },
      },
    });
    expect(e.retryAfterMs).toBe(15 * 1000);
  });

  test('missing / malformed Retry-After leaves retryAfterMs unset', () => {
    const e = toApiError({
      response: {
        status: 429,
        data: null,
        headers: { 'retry-after': 'not-a-number-or-date' },
      },
    });
    expect(e.retryAfterMs).toBeUndefined();
  });
});

describe('parseRetryAfter', () => {
  test('handles numeric seconds', () => {
    expect(parseRetryAfter({ 'retry-after': '30' })).toBe(30000);
    expect(parseRetryAfter({ 'Retry-After': '0' })).toBe(0);
  });

  test('handles HTTP-date', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const result = parseRetryAfter({ 'retry-after': future });
    expect(result).toBeGreaterThan(5_000);
    expect(result).toBeLessThan(15_000);
  });

  test('clamps past HTTP-date to zero', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter({ 'retry-after': past })).toBe(0);
  });

  test('returns null for missing headers', () => {
    expect(parseRetryAfter({})).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });

  test('accepts ratelimit-reset fallback', () => {
    expect(parseRetryAfter({ 'ratelimit-reset': '7' })).toBe(7000);
  });

  test('prefers Retry-After over RateLimit-Reset when both present', () => {
    const result = parseRetryAfter({
      'retry-after': '10',
      'ratelimit-reset': '99',
    });
    expect(result).toBe(10_000);
  });

  test('handles array-valued headers by picking the first', () => {
    expect(parseRetryAfter({ 'retry-after': ['11'] })).toBe(11_000);
  });
});
