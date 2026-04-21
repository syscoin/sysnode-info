import { createProposalService } from './proposalService';

// Build a fake axios-like instance. Only the methods the service uses
// are stubbed, and every call records into `calls` so tests can assert
// both the URL and the body. A per-test `queue` drives the responses;
// `rejection` lets us simulate errors propagated from the real
// apiClient (which normalises axios errors via toApiError — giving
// us a { code, status, details?, retryAfterMs? } envelope).
function makeFakeClient() {
  const calls = [];
  const queue = [];
  return {
    calls,
    queue,
    enqueue(value) {
      queue.push({ kind: 'ok', value });
    },
    enqueueRejection(err) {
      queue.push({ kind: 'err', err });
    },
    client: {
      async get(url) {
        calls.push({ method: 'GET', url });
        const next = queue.shift();
        if (!next) throw new Error('fakeClient: unexpected call ' + url);
        if (next.kind === 'err') throw next.err;
        return { status: 200, data: next.value };
      },
      async post(url, body) {
        calls.push({ method: 'POST', url, body });
        const next = queue.shift();
        if (!next) throw new Error('fakeClient: unexpected call ' + url);
        if (next.kind === 'err') throw next.err;
        return { status: 201, data: next.value };
      },
      async patch(url, body) {
        calls.push({ method: 'PATCH', url, body });
        const next = queue.shift();
        if (!next) throw new Error('fakeClient: unexpected call ' + url);
        if (next.kind === 'err') throw next.err;
        return { status: 200, data: next.value };
      },
      async delete(url) {
        calls.push({ method: 'DELETE', url });
        const next = queue.shift();
        if (!next) throw new Error('fakeClient: unexpected call ' + url);
        if (next.kind === 'err') throw next.err;
        return { status: 204, data: next.value };
      },
    },
  };
}

function apiErr(code, status, extras = {}) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  Object.assign(e, extras);
  return e;
}

describe('proposalService', () => {
  describe('drafts', () => {
    test('createDraft POSTs to /gov/proposals/drafts and unwraps { draft }', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueue({ draft: { id: 1, name: 'x' } });
      const out = await svc.createDraft({ name: 'x' });
      expect(out).toEqual({ id: 1, name: 'x' });
      expect(fc.calls[0]).toEqual({
        method: 'POST',
        url: '/gov/proposals/drafts',
        body: { name: 'x' },
      });
    });

    test('listDrafts defaults to [] when backend omits the array', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueue({});
      expect(await svc.listDrafts()).toEqual([]);
    });

    test('getDraft rejects non-positive integer id before hitting the wire', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      await expect(svc.getDraft(0)).rejects.toMatchObject({ code: 'invalid_id' });
      await expect(svc.getDraft(-1)).rejects.toMatchObject({ code: 'invalid_id' });
      await expect(svc.getDraft('1')).rejects.toMatchObject({ code: 'invalid_id' });
      // No HTTP call should have been issued.
      expect(fc.calls).toHaveLength(0);
    });

    test('updateDraft PATCHes with the patch body and unwraps { draft }', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueue({ draft: { id: 7, name: 'new' } });
      const out = await svc.updateDraft(7, { name: 'new' });
      expect(out).toEqual({ id: 7, name: 'new' });
      expect(fc.calls[0]).toEqual({
        method: 'PATCH',
        url: '/gov/proposals/drafts/7',
        body: { name: 'new' },
      });
    });

    test('deleteDraft hits DELETE and swallows 204 body', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueue(undefined);
      await expect(svc.deleteDraft(7)).resolves.toBeUndefined();
      expect(fc.calls[0]).toEqual({
        method: 'DELETE',
        url: '/gov/proposals/drafts/7',
      });
    });

    test('draft-limit conflict passes through its backend code', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueueRejection(apiErr('draft_limit_exceeded', 409));
      await expect(svc.createDraft({})).rejects.toMatchObject({
        code: 'draft_limit_exceeded',
        status: 409,
      });
    });
  });

  describe('prepare', () => {
    const validEnvelope = {
      submission: {
        id: 1,
        status: 'prepared',
        proposalHash: 'a'.repeat(64),
      },
      opReturnHex: 'deadbeef',
      canonicalJson: '{"type":1}',
      payloadBytes: 10,
      collateralFeeSats: '15000000000',
      requiredConfirmations: 6,
    };

    test('returns the full envelope on success', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueue(validEnvelope);
      const out = await svc.prepare({ name: 'x' });
      expect(out).toEqual(validEnvelope);
    });

    test('throws invalid_response when submission is missing', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueue({ opReturnHex: 'deadbeef' });
      await expect(svc.prepare({})).rejects.toMatchObject({
        code: 'invalid_response',
      });
    });

    test('throws invalid_response when opReturnHex is absent or non-hex', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueue({ submission: { id: 1 }, opReturnHex: 'not hex!' });
      await expect(svc.prepare({})).rejects.toMatchObject({
        code: 'invalid_response',
      });
    });

    test('propagates structured validation errors with details', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueueRejection(
        apiErr('validation_failed', 400, {
          details: [{ field: 'name', msg: 'required' }],
        })
      );
      const p = svc.prepare({});
      await expect(p).rejects.toMatchObject({
        code: 'validation_failed',
        status: 400,
        details: [{ field: 'name', msg: 'required' }],
      });
    });

    test('propagates rate-limit retryAfterMs hint', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueueRejection(apiErr('rate_limited', 429, { retryAfterMs: 60_000 }));
      await expect(svc.prepare({})).rejects.toMatchObject({
        code: 'rate_limited',
        retryAfterMs: 60_000,
      });
    });
  });

  describe('submissions', () => {
    test('getSubmission unwraps the envelope', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueue({ submission: { id: 5, status: 'awaiting_collateral' } });
      const out = await svc.getSubmission(5);
      expect(out.status).toBe('awaiting_collateral');
      expect(fc.calls[0].url).toBe('/gov/proposals/submissions/5');
    });

    test('attachCollateral refuses a malformed txid without a round-trip', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      await expect(svc.attachCollateral(1, 'not-a-txid')).rejects.toMatchObject(
        { code: 'malformed_txid' }
      );
      await expect(svc.attachCollateral(1, 'A'.repeat(63))).rejects.toMatchObject(
        { code: 'malformed_txid' }
      );
      expect(fc.calls).toHaveLength(0);
    });

    test('attachCollateral accepts a valid 64-hex txid and POSTs', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      const txid = 'A'.repeat(64); // mixed case; service doesn't lowercase
      fc.enqueue({ submission: { id: 1, collateralTxid: txid } });
      const out = await svc.attachCollateral(1, txid);
      expect(out.collateralTxid).toBe(txid);
      expect(fc.calls[0]).toEqual({
        method: 'POST',
        url: '/gov/proposals/submissions/1/attach-collateral',
        body: { collateralTxid: txid },
      });
    });

    test('attachCollateral surfaces backend "txid_already_used" conflict', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueueRejection(apiErr('txid_already_used', 409));
      await expect(
        svc.attachCollateral(1, 'a'.repeat(64))
      ).rejects.toMatchObject({ code: 'txid_already_used', status: 409 });
    });

    test('deleteSubmission issues DELETE and resolves with no value', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      fc.enqueue(undefined);
      await expect(svc.deleteSubmission(9)).resolves.toBeUndefined();
      expect(fc.calls[0]).toEqual({
        method: 'DELETE',
        url: '/gov/proposals/submissions/9',
      });
    });
  });

  describe('error fall-through', () => {
    test('axios-like error without .code is coerced into a generic failure code', async () => {
      const fc = makeFakeClient();
      const svc = createProposalService({ client: fc.client });
      const e = new Error('boom');
      e.status = 500;
      fc.enqueueRejection(e);
      await expect(svc.listDrafts()).rejects.toMatchObject({
        code: 'list_drafts_failed',
        status: 500,
      });
    });
  });
});
