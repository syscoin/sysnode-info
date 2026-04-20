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

  test('returns saltV/blob/etag when present', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/vault').reply(200, {
      saltV: 'aa'.repeat(32),
      blob: 'AAAA',
      etag: 'abc',
      updatedAt: 1700000000,
    });
    const out = await service.load();
    expect(out.empty).toBe(false);
    expect(out.saltV).toBe('aa'.repeat(32));
    expect(out.blob).toBe('AAAA');
    expect(out.etag).toBe('abc');
    expect(out.updatedAt).toBe(1700000000);
  });

  test('raises invalid_vault_response when server shape is broken', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/vault').reply(200, { saltV: '', blob: 'x', etag: 'e' });
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
  test('sends the blob + If-Match: <etag> on updates', async () => {
    const { service, adapter } = makeService();
    let captured;
    adapter.onPut('/vault').reply((config) => {
      captured = {
        body: JSON.parse(config.data),
        headers: config.headers,
      };
      return [
        200,
        { saltV: 'aa'.repeat(32), etag: 'newEtag' },
      ];
    });

    const out = await service.save({ blob: 'CIPHERTEXT', ifMatch: 'oldEtag' });
    expect(out.etag).toBe('newEtag');
    expect(captured.body).toEqual({ blob: 'CIPHERTEXT' });
    expect(captured.headers['If-Match']).toBe('oldEtag');
    expect(captured.headers['X-CSRF-Token']).toBe('tok');
  });

  test('omits If-Match on first-write path', async () => {
    const { service, adapter } = makeService();
    let captured;
    adapter.onPut('/vault').reply((config) => {
      captured = config;
      return [200, { saltV: 'bb'.repeat(32), etag: 'firstEtag' }];
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
