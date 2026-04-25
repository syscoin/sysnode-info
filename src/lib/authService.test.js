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

describe('authService.verifyPassword', () => {
  const AUTH_HASH =
    'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4';

  test('posts authHash and resolves true on 204', async () => {
    const { service, adapter } = makeService();
    let captured;
    adapter.onPost('/auth/verify-password').reply((config) => {
      captured = JSON.parse(config.data);
      return [204];
    });

    await expect(service.verifyPassword({ authHash: AUTH_HASH })).resolves.toBe(
      true
    );
    expect(captured).toEqual({ authHash: AUTH_HASH });
  });

  test('preserves explicit invalid_credentials from the backend', async () => {
    const { service, adapter } = makeService();
    adapter
      .onPost('/auth/verify-password')
      .reply(401, { error: 'invalid_credentials' });

    await expect(
      service.verifyPassword({ authHash: AUTH_HASH })
    ).rejects.toMatchObject({
      code: 'invalid_credentials',
      status: 401,
    });
  });

  test('does not rewrite session 401s into password mismatch errors', async () => {
    const { service, adapter } = makeService();
    adapter
      .onPost('/auth/verify-password')
      .reply(401, { error: 'unauthorized' });

    await expect(
      service.verifyPassword({ authHash: AUTH_HASH })
    ).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
  });
});

// ---------------------------------------------------------------------------
// PR 7 — deriveChangePasswordKeys + changePassword
// ---------------------------------------------------------------------------

describe('authService.deriveChangePasswordKeys', () => {
  test('returns hex authHashes and a 32-byte newMaster', async () => {
    const { service } = makeService();
    const keys = await service.deriveChangePasswordKeys(
      'old password',
      'new password-!',
      'user@example.com'
    );
    expect(keys.oldAuthHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.newAuthHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.newMaster).toBeInstanceOf(Uint8Array);
    expect(keys.newMaster).toHaveLength(32);
    // oldAuthHash must not equal newAuthHash — otherwise the caller
    // could silently "change" to the same password.
    expect(keys.oldAuthHash).not.toBe(keys.newAuthHash);
  }, 30000);

  test('the same inputs produce the same authHash (KDF is deterministic)', async () => {
    const { service } = makeService();
    const a = await service.deriveChangePasswordKeys(
      'alpha',
      'beta',
      'u@e.com'
    );
    const b = await service.deriveChangePasswordKeys(
      'alpha',
      'beta',
      'u@e.com'
    );
    expect(a.oldAuthHash).toBe(b.oldAuthHash);
    expect(a.newAuthHash).toBe(b.newAuthHash);
  }, 30000);
});

describe('authService.changePassword', () => {
  const OLD =
    'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4';
  const NEW =
    'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4';

  test('sends only {oldAuthHash,newAuthHash} when no vault provided', async () => {
    const { service, adapter } = makeService();
    let captured;
    adapter.onPost('/auth/change-password').reply((config) => {
      captured = JSON.parse(config.data);
      return [200, { status: 'ok', expiresAt: 999 }];
    });
    const res = await service.changePassword({
      oldAuthHash: OLD,
      newAuthHash: NEW,
    });
    expect(Object.keys(captured).sort()).toEqual(['newAuthHash', 'oldAuthHash']);
    expect(captured.oldAuthHash).toBe(OLD);
    expect(captured.newAuthHash).toBe(NEW);
    expect(res.status).toBe('ok');
    // No vault -> no newVaultEtag echoed.
    expect(res.newVaultEtag).toBeUndefined();
  });

  test('forwards the vault payload verbatim when provided', async () => {
    const { service, adapter } = makeService();
    let captured;
    adapter.onPost('/auth/change-password').reply((config) => {
      captured = JSON.parse(config.data);
      return [
        200,
        { status: 'ok', expiresAt: 999, newVaultEtag: 'aa'.repeat(32) },
      ];
    });
    const res = await service.changePassword({
      oldAuthHash: OLD,
      newAuthHash: NEW,
      vault: { blob: 'cipher', ifMatch: 'etag1' },
    });
    expect(captured.vault).toEqual({ blob: 'cipher', ifMatch: 'etag1' });
    expect(res.newVaultEtag).toBe('aa'.repeat(32));
  });

  test('rejects empty/missing authHash or vault fields client-side', async () => {
    const { service } = makeService();
    await expect(
      service.changePassword({ oldAuthHash: '', newAuthHash: NEW })
    ).rejects.toThrow(/oldAuthHash required/);
    await expect(
      service.changePassword({ oldAuthHash: OLD, newAuthHash: '' })
    ).rejects.toThrow(/newAuthHash required/);
    await expect(
      service.changePassword({
        oldAuthHash: OLD,
        newAuthHash: NEW,
        vault: { blob: '', ifMatch: 'x' },
      })
    ).rejects.toThrow(/vault\.blob required/);
    await expect(
      service.changePassword({
        oldAuthHash: OLD,
        newAuthHash: NEW,
        vault: { blob: 'x', ifMatch: '' },
      })
    ).rejects.toThrow(/vault\.ifMatch required/);
  });

  test('surfaces invalid_credentials on 401', async () => {
    const { service, adapter } = makeService();
    adapter
      .onPost('/auth/change-password')
      .reply(401, { error: 'invalid_credentials' });
    await expect(
      service.changePassword({ oldAuthHash: OLD, newAuthHash: NEW })
    ).rejects.toMatchObject({
      code: 'invalid_credentials',
      status: 401,
    });
  });

  test('surfaces precondition_failed on 412 (stale vault etag)', async () => {
    const { service, adapter } = makeService();
    adapter
      .onPost('/auth/change-password')
      .reply(412, { error: 'precondition_failed' });
    await expect(
      service.changePassword({
        oldAuthHash: OLD,
        newAuthHash: NEW,
        vault: { blob: 'x', ifMatch: 'stale' },
      })
    ).rejects.toMatchObject({ code: 'precondition_failed', status: 412 });
  });

  test('surfaces vault_rewrap_required on 409', async () => {
    const { service, adapter } = makeService();
    adapter
      .onPost('/auth/change-password')
      .reply(409, { error: 'vault_rewrap_required' });
    await expect(
      service.changePassword({ oldAuthHash: OLD, newAuthHash: NEW })
    ).rejects.toMatchObject({ code: 'vault_rewrap_required', status: 409 });
  });
});

// ---------------------------------------------------------------------------
// PR 7 — getPrefs / updatePrefs
// ---------------------------------------------------------------------------

describe('authService.getPrefs', () => {
  test('returns the server-stored notification prefs object', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/auth/prefs').reply(200, {
      notificationPrefs: { voteReminders: { enabled: false } },
    });
    const prefs = await service.getPrefs();
    expect(prefs).toEqual({ voteReminders: { enabled: false } });
  });

  test('defaults to {} when the server omits notificationPrefs', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/auth/prefs').reply(200, {});
    const prefs = await service.getPrefs();
    expect(prefs).toEqual({});
  });
});

describe('authService.updatePrefs', () => {
  test('PUTs the payload and returns the echoed server shape', async () => {
    const { service, adapter } = makeService();
    let captured;
    adapter.onPut('/auth/prefs').reply((config) => {
      captured = JSON.parse(config.data);
      return [
        200,
        { notificationPrefs: { voteReminders: { enabled: true } } },
      ];
    });
    const prefs = await service.updatePrefs({
      voteReminders: { enabled: true },
    });
    expect(captured).toEqual({ voteReminders: { enabled: true } });
    expect(prefs).toEqual({ voteReminders: { enabled: true } });
  });

  test('surfaces invalid_body on 400', async () => {
    const { service, adapter } = makeService();
    adapter.onPut('/auth/prefs').reply(400, { error: 'invalid_body' });
    await expect(
      service.updatePrefs({ unknownKey: true })
    ).rejects.toMatchObject({ code: 'invalid_body', status: 400 });
  });
});

// ---------------------------------------------------------------------------
// PR 7 — deleteAccount (GDPR right to erasure)
// ---------------------------------------------------------------------------

describe('authService.deleteAccount', () => {
  const AUTH =
    'a4f8b3c1d9e7f2a5b1c6d8e4f7a9b2c5d1e8f4a7b3c9d5e1f6a2b8c4d7e3f5a9';

  test('sends DELETE /auth/account with oldAuthHash in the body and resolves to true', async () => {
    const { service, adapter } = makeService();
    let captured;
    adapter.onDelete('/auth/account').reply((config) => {
      // axios serializes `data` on DELETE as a JSON string exactly
      // like POST/PUT. We assert on both the URL and the body to
      // pin the wire contract this service is promising the backend.
      captured = JSON.parse(config.data);
      return [204];
    });
    await expect(service.deleteAccount({ oldAuthHash: AUTH })).resolves.toBe(
      true
    );
    expect(captured).toEqual({ oldAuthHash: AUTH });
  });

  test('rejects client-side when oldAuthHash is missing (guards the wire contract)', async () => {
    const { service } = makeService();
    await expect(service.deleteAccount({})).rejects.toThrow(
      /oldAuthHash required/
    );
  });

  test('surfaces invalid_credentials on 401 (wrong password)', async () => {
    const { service, adapter } = makeService();
    adapter
      .onDelete('/auth/account')
      .reply(401, { error: 'invalid_credentials' });
    await expect(
      service.deleteAccount({ oldAuthHash: AUTH })
    ).rejects.toMatchObject({ code: 'invalid_credentials', status: 401 });
  });

  test('surfaces server_misconfigured on 503 (KDF/pepper misconfiguration)', async () => {
    const { service, adapter } = makeService();
    adapter
      .onDelete('/auth/account')
      .reply(503, { error: 'server_misconfigured' });
    await expect(
      service.deleteAccount({ oldAuthHash: AUTH })
    ).rejects.toMatchObject({ code: 'server_misconfigured', status: 503 });
  });
});
