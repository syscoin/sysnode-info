import MockAdapter from 'axios-mock-adapter';
import { createApiClient } from './apiClient';
import { createAuthService } from './authService';

function makeService() {
  const client = createApiClient({
    baseURL: 'http://test',
    readCsrf: () => 'tok',
  });
  const adapter = new MockAdapter(client);
  const service = createAuthService(client);
  return { service, adapter };
}

describe('authService.register', () => {
  test('derives authHash client-side and posts normalized email', async () => {
    const { service, adapter } = makeService();
    let captured;
    adapter.onPost('/auth/register').reply((config) => {
      captured = JSON.parse(config.data);
      return [202, { status: 'verification_sent' }];
    });
    const res = await service.register('  User@Example.com  ', 'hunter22a');
    expect(res).toEqual({ status: 'verification_sent' });
    expect(captured.email).toBe('User@Example.com');
    expect(captured.authHash).toMatch(/^[0-9a-f]{64}$/);
  }, 20000);
});

describe('authService.login', () => {
  test('returns user payload (with saltV) AND a master key on success', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/auth/login').reply(200, {
      user: {
        id: 1,
        email: 'user@example.com',
        emailVerified: true,
        saltV: 'ab'.repeat(32),
      },
      expiresAt: 123456,
    });
    const res = await service.login('user@example.com', 'hunter22a');
    expect(res.user).toEqual({
      id: 1,
      email: 'user@example.com',
      emailVerified: true,
      saltV: 'ab'.repeat(32),
    });
    expect(res.expiresAt).toBe(123456);
    // master MUST be surfaced to the caller so the VaultContext can
    // auto-unlock without re-running PBKDF2.
    expect(res.master).toBeInstanceOf(Uint8Array);
    expect(res.master).toHaveLength(32);
    // saltV round-trips to the caller unchanged. VaultContext needs it
    // in sync with `user` so the two auth-triggered effects agree on
    // identity.
    expect(res.user.saltV).toBe('ab'.repeat(32));
  }, 20000);

  test('master is NOT sent to the server on login', async () => {
    const { service, adapter } = makeService();
    let captured;
    adapter.onPost('/auth/login').reply((config) => {
      captured = JSON.parse(config.data);
      return [200, { user: { id: 1, email: 'x@y.com' } }];
    });
    await service.login('x@y.com', 'hunter22a');
    // Only email + authHash should travel the wire — never master or
    // password.
    expect(Object.keys(captured).sort()).toEqual(['authHash', 'email']);
    expect(captured.authHash).toMatch(/^[0-9a-f]{64}$/);
  }, 20000);

  test('surfaces invalid_credentials code on 401', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/auth/login').reply(401, { error: 'invalid_credentials' });
    await expect(service.login('x@y.com', 'bad')).rejects.toMatchObject({
      code: 'invalid_credentials',
      status: 401,
    });
  }, 20000);

  test('surfaces email_not_verified code on 403', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/auth/login').reply(403, { error: 'email_not_verified' });
    await expect(service.login('x@y.com', 'hunter22a')).rejects.toMatchObject({
      code: 'email_not_verified',
    });
  }, 20000);
});

describe('authService.verifyEmail', () => {
  test('returns status:verified', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/auth/verify-email').reply(200, { status: 'verified' });
    const res = await service.verifyEmail('a'.repeat(64));
    expect(res.status).toBe('verified');
  });

  test('maps invalid_or_expired_token error', async () => {
    const { service, adapter } = makeService();
    adapter
      .onPost('/auth/verify-email')
      .reply(400, { error: 'invalid_or_expired_token' });
    await expect(service.verifyEmail('x')).rejects.toMatchObject({
      code: 'invalid_or_expired_token',
    });
  });
});

describe('authService.me / logout', () => {
  test('me returns user with saltV on rehydration', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/auth/me').reply(200, {
      user: {
        id: 1,
        email: 'u@e.com',
        emailVerified: true,
        notificationPrefs: {},
        saltV: 'cd'.repeat(32),
      },
    });
    const res = await service.me();
    expect(res.user.email).toBe('u@e.com');
    // Rehydration path must carry saltV too — otherwise a page reload
    // on a logged-in user would silently leave the vault unusable.
    expect(res.user.saltV).toBe('cd'.repeat(32));
  });

  test('logout returns ok', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/auth/logout').reply(200, { status: 'ok' });
    const res = await service.logout();
    expect(res.status).toBe('ok');
  });
});
