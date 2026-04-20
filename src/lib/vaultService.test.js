import MockAdapter from 'axios-mock-adapter';
import { createApiClient } from './apiClient';
import { createVaultService } from './vaultService';

function makeService() {
  const client = createApiClient({
    baseURL: 'http://test',
    readCsrf: () => 'tok',
  });
  const adapter = new MockAdapter(client);
  const service = createVaultService(client);
  return { service, adapter };
}

describe('vaultService.load', () => {
  test('returns {empty: true} when backend reports no vault', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/vault').reply(200, { empty: true });
    const out = await service.load();
    expect(out).toEqual({ empty: true });
  });

  test('returns blob/etag/updatedAt when present (saltV no longer carried here)', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/vault').reply(200, {
      blob: 'AAAA',
      etag: 'abc',
      updatedAt: 1700000000,
    });
    const out = await service.load();
    expect(out.empty).toBe(false);
    expect(out.blob).toBe('AAAA');
    expect(out.etag).toBe('abc');
    expect(out.updatedAt).toBe(1700000000);
    // saltV belongs to the user identity, not the vault row (migration
    // 004). Making sure it doesn't accidentally leak from the legacy
    // GET response into the service output.
    expect(out.saltV).toBeUndefined();
  });

  test('tolerates legacy servers that still echo saltV', async () => {
    // Belt-and-suspenders: a pre-004 backend could still return saltV
    // in the body. The client ignores it (saltV is now sourced from
    // /auth/me), but MUST NOT break if the field is present.
    const { service, adapter } = makeService();
    adapter.onGet('/vault').reply(200, {
      saltV: 'aa'.repeat(32),
      blob: 'AAAA',
      etag: 'abc',
      updatedAt: 1700000000,
    });
    const out = await service.load();
    expect(out.empty).toBe(false);
    expect(out.blob).toBe('AAAA');
    expect(out.etag).toBe('abc');
  });

  test('raises invalid_vault_response when server shape is broken', async () => {
    const { service, adapter } = makeService();
    // No blob at all — load() must refuse rather than return a shape
    // the caller will crash on later.
    adapter.onGet('/vault').reply(200, { etag: 'e' });
    await expect(service.load()).rejects.toMatchObject({
      code: 'invalid_vault_response',
    });
  });

  test('propagates 401 with the apiClient error shape', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/vault').reply(401, { error: 'unauthorized' });
    await expect(service.load()).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
  });
});

describe('vaultService.save', () => {
  test('sends the blob + If-Match: <etag> on updates, returns new etag', async () => {
    const { service, adapter } = makeService();
    let captured;
    adapter.onPut('/vault').reply((config) => {
      captured = {
        body: JSON.parse(config.data),
        headers: config.headers,
      };
      return [200, { etag: 'newEtag' }];
    });

    const out = await service.save({ blob: 'CIPHERTEXT', ifMatch: 'oldEtag' });
    expect(out).toEqual({ etag: 'newEtag' });
    expect(captured.body).toEqual({ blob: 'CIPHERTEXT' });
    // saltV must never appear in the PUT body — it's server-owned and
    // is not accepted as input on this endpoint.
    expect(captured.body.saltV).toBeUndefined();
    expect(captured.headers['If-Match']).toBe('oldEtag');
    expect(captured.headers['X-CSRF-Token']).toBe('tok');
  });

  test('omits If-Match on first-write path', async () => {
    const { service, adapter } = makeService();
    let captured;
    adapter.onPut('/vault').reply((config) => {
      captured = config;
      return [200, { etag: 'firstEtag' }];
    });
    await service.save({ blob: 'CIPHERTEXT' });
    expect(captured.headers['If-Match']).toBeUndefined();
  });

  test('maps 412 -> vault_stale', async () => {
    const { service, adapter } = makeService();
    adapter.onPut('/vault').reply(412, { error: 'precondition_failed' });
    await expect(
      service.save({ blob: 'x', ifMatch: 'stale' })
    ).rejects.toMatchObject({ code: 'vault_stale', status: 412 });
  });

  test('maps 428 -> vault_if_match_required', async () => {
    const { service, adapter } = makeService();
    adapter.onPut('/vault').reply(428, { error: 'if_match_required' });
    await expect(
      service.save({ blob: 'x' })
    ).rejects.toMatchObject({ code: 'vault_if_match_required', status: 428 });
  });

  test('maps 413 -> vault_too_large', async () => {
    const { service, adapter } = makeService();
    adapter.onPut('/vault').reply(413, { error: 'payload_too_large' });
    await expect(
      service.save({ blob: 'x'.repeat(10), ifMatch: '*' })
    ).rejects.toMatchObject({ code: 'vault_too_large', status: 413 });
  });

  test('server response missing etag is treated as invalid (no silent success)', async () => {
    // If a server ever returned 200 without an etag, the client would
    // have nothing to send as If-Match on its next write and would be
    // stuck in a perpetual 428 loop. Reject at the service boundary
    // so the caller sees a precise cause.
    const { service, adapter } = makeService();
    adapter.onPut('/vault').reply(200, {});
    await expect(
      service.save({ blob: 'x', ifMatch: '*' })
    ).rejects.toMatchObject({ code: 'invalid_vault_response' });
  });

  test('rejects empty-string blobs client-side before any HTTP call', async () => {
    const { service, adapter } = makeService();
    let hit = false;
    adapter.onPut('/vault').reply(() => {
      hit = true;
      return [200, {}];
    });
    await expect(service.save({ blob: '' })).rejects.toMatchObject({
      code: 'invalid_blob',
    });
    expect(hit).toBe(false);
  });
});
