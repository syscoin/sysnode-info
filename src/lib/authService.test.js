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
  test('returns user payload on success', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/auth/login').reply(200, {
      user: { id: 1, email: 'user@example.com' },
      expiresAt: 123456,
    });
    const res = await service.login('user@example.com', 'hunter22a');
    expect(res.user).toEqual({ id: 1, email: 'user@example.com' });
    expect(res.expiresAt).toBe(123456);
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
  test('me returns user when authed', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/auth/me').reply(200, {
      user: { id: 1, email: 'u@e.com', emailVerified: true, notificationPrefs: {} },
    });
    const res = await service.me();
    expect(res.user.email).toBe('u@e.com');
  });

  test('logout returns ok', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/auth/logout').reply(200, { status: 'ok' });
    const res = await service.logout();
    expect(res.status).toBe('ok');
  });
});
