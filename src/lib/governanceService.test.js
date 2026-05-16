import MockAdapter from 'axios-mock-adapter';
import { createApiClient } from './apiClient';
import { createGovernanceService } from './governanceService';

function makeService() {
  const client = createApiClient({
    baseURL: 'http://test',
    readCsrf: () => 'tok',
  });
  const adapter = new MockAdapter(client);
  const service = createGovernanceService(client);
  return { service, adapter };
}

const H64 = (c) => c.repeat(64);
const SIG = 'A'.repeat(86) + '==';

function validVoteBody(overrides = {}) {
  return {
    proposalHash: H64('a'),
    voteOutcome: 'yes',
    voteSignal: 'funding',
    time: 1_700_000_000,
    entries: [{ collateralHash: H64('b'), collateralIndex: 0, voteSig: SIG }],
    ...overrides,
  };
}

describe('governanceService.lookupOwnedMasternodes', () => {
  test('POSTs /gov/mns/lookup with an X-CSRF-Token and returns matches', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/gov/mns/lookup').reply(200, {
      matches: [
        {
          votingaddress: 'sys1qalice',
          proTxHash: H64('1'),
          collateralHash: H64('2'),
          collateralIndex: 0,
          status: 'ENABLED',
          address: '1.2.3.4:8369',
          payee: 'sys1qpayee',
        },
      ],
    });
    const out = await service.lookupOwnedMasternodes(['sys1qalice']);
    expect(out).toHaveLength(1);
    expect(out[0].collateralHash).toBe(H64('2'));

    // Double-submit CSRF: the X-CSRF-Token header must be attached.
    // This is the one place we validate that the apiClient wiring
    // still flows through this service.
    expect(adapter.history.post[0].headers['X-CSRF-Token']).toBe('tok');
  });

  test('returns [] when server returns a non-array matches field (defensive)', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/gov/mns/lookup').reply(200, { matches: null });
    const out = await service.lookupOwnedMasternodes(['sys1qalice']);
    expect(out).toEqual([]);
  });

  test('rejects non-array input locally without hitting the network', async () => {
    const { service, adapter } = makeService();
    await expect(service.lookupOwnedMasternodes('sys1qalice')).rejects.toThrow(
      /invalid_request/
    );
    expect(adapter.history.post).toHaveLength(0);
  });

  test('surfaces too_many_addresses before the request', async () => {
    const { service, adapter } = makeService();
    const big = new Array(513).fill('sys1qalice');
    await expect(service.lookupOwnedMasternodes(big)).rejects.toThrow(
      /too_many_addresses/
    );
    expect(adapter.history.post).toHaveLength(0);
  });

  test('propagates apiClient-normalised errors from 4xx', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/gov/mns/lookup').reply(400, { error: 'invalid_body' });
    await expect(service.lookupOwnedMasternodes([])).rejects.toMatchObject({
      code: 'invalid_body',
      status: 400,
    });
  });
});

describe('governanceService.submitVote', () => {
  test('POSTs /gov/vote and returns per-entry results', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/gov/vote').reply(200, {
      accepted: 1,
      rejected: 0,
      results: [
        { collateralHash: H64('b'), collateralIndex: 0, ok: true },
      ],
    });
    const out = await service.submitVote(validVoteBody());
    expect(out.accepted).toBe(1);
    expect(out.rejected).toBe(0);
    expect(out.results).toHaveLength(1);
    expect(adapter.history.post[0].headers['X-CSRF-Token']).toBe('tok');
  });

  test('splits vote submissions above the backend per-request cap and merges results', async () => {
    const { service, adapter } = makeService();
    const entries = Array.from({ length: 257 }, (_, i) => ({
      collateralHash: H64(i === 256 ? 'c' : 'b'),
      collateralIndex: i,
      voteSig: SIG,
    }));
    adapter.onPost('/gov/vote').reply((config) => {
      const body = JSON.parse(config.data);
      const results = body.entries.map((entry) => ({
        collateralHash: entry.collateralHash,
        collateralIndex: entry.collateralIndex,
        ok: entry.collateralIndex !== 256,
        error: entry.collateralIndex === 256 ? 'vote_too_often' : undefined,
      }));
      return [
        200,
        {
          accepted: results.filter((r) => r.ok).length,
          rejected: results.filter((r) => !r.ok).length,
          results,
        },
      ];
    });

    const out = await service.submitVote(validVoteBody({ entries }));

    expect(adapter.history.post).toHaveLength(2);
    const firstBody = JSON.parse(adapter.history.post[0].data);
    const secondBody = JSON.parse(adapter.history.post[1].data);
    expect(firstBody.entries).toHaveLength(256);
    expect(secondBody.entries).toHaveLength(1);
    expect(out.accepted).toBe(256);
    expect(out.rejected).toBe(1);
    expect(out.results).toHaveLength(257);
    expect(out.results[256]).toMatchObject({
      collateralHash: H64('c'),
      collateralIndex: 256,
      ok: false,
      error: 'vote_too_often',
    });
  });

  test('preserves successful chunks when a later chunk request fails', async () => {
    const { service, adapter } = makeService();
    const entries = Array.from({ length: 513 }, (_, i) => ({
      collateralHash: H64(i >= 256 ? 'c' : 'b'),
      collateralIndex: i,
      voteSig: SIG,
    }));
    let requestCount = 0;
    adapter.onPost('/gov/vote').reply((config) => {
      requestCount += 1;
      const body = JSON.parse(config.data);
      if (requestCount === 2) {
        return [429, { error: 'too_many_vote_requests' }];
      }
      const results = body.entries.map((entry) => ({
        collateralHash: entry.collateralHash,
        collateralIndex: entry.collateralIndex,
        ok: true,
      }));
      return [
        200,
        {
          accepted: results.length,
          rejected: 0,
          results,
        },
      ];
    });

    const out = await service.submitVote(validVoteBody({ entries }));

    expect(adapter.history.post).toHaveLength(2);
    expect(out.accepted).toBe(256);
    expect(out.rejected).toBe(257);
    expect(out.results).toHaveLength(513);
    expect(out.results[255]).toMatchObject({ collateralIndex: 255, ok: true });
    expect(out.results[256]).toMatchObject({
      collateralIndex: 256,
      ok: false,
      error: 'rate_limited',
    });
    expect(out.results[512]).toMatchObject({
      collateralIndex: 512,
      ok: false,
      error: 'rate_limited',
    });
  });

  test('tracks successful chunks even if a success body omits results', async () => {
    const { service, adapter } = makeService();
    const entries = Array.from({ length: 257 }, (_, i) => ({
      collateralHash: H64(i >= 256 ? 'c' : 'b'),
      collateralIndex: i,
      voteSig: SIG,
    }));
    let requestCount = 0;
    adapter.onPost('/gov/vote').reply(() => {
      requestCount += 1;
      if (requestCount === 1) {
        return [200, { accepted: 256, rejected: 0 }];
      }
      return [429, { error: 'too_many_vote_requests' }];
    });

    const out = await service.submitVote(validVoteBody({ entries }));

    expect(adapter.history.post).toHaveLength(2);
    expect(out.accepted).toBe(256);
    expect(out.rejected).toBe(1);
    expect(out.results).toEqual([
      {
        collateralHash: H64('c'),
        collateralIndex: 256,
        ok: false,
        error: 'rate_limited',
      },
    ]);
  });

  test('maps 429 too_many_vote_requests to rate_limited', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/gov/vote').reply(429, { error: 'too_many_vote_requests' });
    await expect(service.submitVote(validVoteBody())).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });

  test('rejects invalid proposalHash locally (no request sent)', async () => {
    const { service, adapter } = makeService();
    await expect(
      service.submitVote(validVoteBody({ proposalHash: 'nope' }))
    ).rejects.toThrow(/invalid_proposal_hash/);
    expect(adapter.history.post).toHaveLength(0);
  });

  test('rejects non-funding signals locally (PR5 funding-only scope)', async () => {
    const { service, adapter } = makeService();
    await expect(
      service.submitVote(validVoteBody({ voteSignal: 'valid' }))
    ).rejects.toThrow(/unsupported_vote_signal/);
    expect(adapter.history.post).toHaveLength(0);
  });

  test('rejects empty entries locally', async () => {
    const { service, adapter } = makeService();
    await expect(
      service.submitVote(validVoteBody({ entries: [] }))
    ).rejects.toThrow(/no_entries/);
    expect(adapter.history.post).toHaveLength(0);
  });

  test('passes through mixed-success 200 with per-entry errors', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/gov/vote').reply(200, {
      accepted: 1,
      rejected: 1,
      results: [
        { collateralHash: H64('b'), collateralIndex: 0, ok: true },
        {
          collateralHash: H64('c'),
          collateralIndex: 1,
          ok: false,
          error: 'vote_too_often',
        },
      ],
    });
    const out = await service.submitVote(
      validVoteBody({
        entries: [
          { collateralHash: H64('b'), collateralIndex: 0, voteSig: SIG },
          { collateralHash: H64('c'), collateralIndex: 1, voteSig: SIG },
        ],
      })
    );
    expect(out.accepted).toBe(1);
    expect(out.rejected).toBe(1);
    expect(out.results[1].error).toBe('vote_too_often');
  });
});

describe('governanceService.fetchReceipts', () => {
  test('GETs /gov/receipts with the proposalHash query param (pure read)', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts').reply((config) => {
      // No `refresh` param ever — fetchReceipts is a pure read now.
      expect(config.params).toEqual({ proposalHash: H64('a') });
      return [
        200,
        {
          receipts: [
            {
              collateralHash: H64('b'),
              collateralIndex: 0,
              proposalHash: H64('a'),
              voteOutcome: 'yes',
              voteSignal: 'funding',
              voteTime: 1_700_000_000,
              status: 'confirmed',
              lastError: null,
              submittedAt: 1_700_000_123_000,
              verifiedAt: 1_700_000_456_000,
            },
          ],
          reconciled: false,
        },
      ];
    });
    const out = await service.fetchReceipts(H64('a'));
    // GET is non-reconciling by contract — carry whatever the
    // backend reports through but expect false here.
    expect(out.reconciled).toBe(false);
    expect(out.reconcileError).toBeNull();
    expect(out.updated).toBe(0);
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0].status).toBe('confirmed');
  });

  test('defaults receipts to [] on a malformed success body', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts').reply(200, { receipts: 'oops' });
    const out = await service.fetchReceipts(H64('a'));
    expect(out.receipts).toEqual([]);
    expect(out.reconciled).toBe(false);
  });

  test('rejects an invalid proposalHash locally (no network call)', async () => {
    const { service, adapter } = makeService();
    await expect(service.fetchReceipts('nope')).rejects.toThrow(
      /invalid_proposal_hash/
    );
    expect(adapter.history.get).toHaveLength(0);
  });

  test('propagates 4xx error codes from the backend', async () => {
    const { service, adapter } = makeService();
    adapter
      .onGet('/gov/receipts')
      .reply(400, { error: 'invalid_proposal_hash' });
    await expect(service.fetchReceipts(H64('a'))).rejects.toMatchObject({
      code: 'invalid_proposal_hash',
      status: 400,
    });
  });
});

describe('governanceService.reconcileReceipts', () => {
  test('POSTs /gov/receipts/reconcile with the proposalHash body', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/gov/receipts/reconcile').reply((config) => {
      const body = JSON.parse(config.data);
      expect(body).toEqual({ proposalHash: H64('a'), refresh: false });
      return [
        200,
        {
          receipts: [
            {
              collateralHash: H64('b'),
              collateralIndex: 0,
              proposalHash: H64('a'),
              voteOutcome: 'yes',
              voteSignal: 'funding',
              voteTime: 1_700_000_000,
              status: 'confirmed',
              lastError: null,
              submittedAt: 1_700_000_123_000,
              verifiedAt: 1_700_000_456_000,
            },
          ],
          reconciled: true,
          updated: 1,
        },
      ];
    });
    const out = await service.reconcileReceipts(H64('a'));
    expect(out.reconciled).toBe(true);
    expect(out.updated).toBe(1);
    expect(out.reconcileError).toBeNull();
    expect(out.receipts).toHaveLength(1);
  });

  test('forwards refresh:true to the backend body', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/gov/receipts/reconcile').reply((config) => {
      const body = JSON.parse(config.data);
      expect(body).toEqual({ proposalHash: H64('a'), refresh: true });
      return [200, { receipts: [], reconciled: true }];
    });
    await service.reconcileReceipts(H64('a'), { refresh: true });
  });

  test('surfaces a reconcileError when the backend reports one', async () => {
    const { service, adapter } = makeService();
    adapter.onPost('/gov/receipts/reconcile').reply(200, {
      receipts: [
        {
          collateralHash: H64('b'),
          collateralIndex: 0,
          proposalHash: H64('a'),
          voteOutcome: 'yes',
          voteSignal: 'funding',
          voteTime: 1_700_000_000,
          status: 'relayed',
          lastError: null,
          submittedAt: 1_700_000_123_000,
          verifiedAt: null,
        },
      ],
      reconciled: false,
      reconcileError: 'rpc_failed',
    });
    const out = await service.reconcileReceipts(H64('a'));
    expect(out.reconciled).toBe(false);
    expect(out.reconcileError).toBe('rpc_failed');
    expect(out.receipts).toHaveLength(1);
  });

  test('rejects an invalid proposalHash locally (no network call)', async () => {
    const { service, adapter } = makeService();
    await expect(service.reconcileReceipts('nope')).rejects.toThrow(
      /invalid_proposal_hash/
    );
    expect(adapter.history.post).toHaveLength(0);
  });

  test('propagates 4xx error codes from the backend', async () => {
    const { service, adapter } = makeService();
    adapter
      .onPost('/gov/receipts/reconcile')
      .reply(400, { error: 'invalid_proposal_hash' });
    await expect(
      service.reconcileReceipts(H64('a'))
    ).rejects.toMatchObject({
      code: 'invalid_proposal_hash',
      status: 400,
    });
  });

  test('propagates 403 csrf_missing from the backend (CSRF-protected)', async () => {
    const { service, adapter } = makeService();
    adapter
      .onPost('/gov/receipts/reconcile')
      .reply(403, { error: 'csrf_missing' });
    await expect(
      service.reconcileReceipts(H64('a'))
    ).rejects.toMatchObject({
      code: 'csrf_missing',
      status: 403,
    });
  });
});

describe('governanceService.fetchReceiptsSummary', () => {
  test('GETs /gov/receipts/summary and returns the aggregated rollup', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts/summary').reply(200, {
      summary: [
        {
          proposalHash: H64('a'),
          total: 3,
          relayed: 1,
          confirmed: 2,
          stale: 0,
          failed: 0,
          confirmedYes: 2,
          confirmedNo: 0,
          confirmedAbstain: 0,
          latestSubmittedAt: 1_700_000_123_000,
          latestVerifiedAt: 1_700_000_456_000,
        },
      ],
    });
    const out = await service.fetchReceiptsSummary();
    expect(out.summary).toHaveLength(1);
    expect(out.summary[0].confirmed).toBe(2);
  });

  test('defaults summary to [] on a malformed body', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts/summary').reply(200, {});
    const out = await service.fetchReceiptsSummary();
    expect(out.summary).toEqual([]);
  });

  test('maps network failures to network_error', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts/summary').networkError();
    await expect(service.fetchReceiptsSummary()).rejects.toMatchObject({
      code: 'network_error',
    });
  });
});

describe('governanceService.fetchRecentReceipts', () => {
  test('GETs /gov/receipts/recent and returns the raw row list', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts/recent').reply(200, {
      receipts: [
        {
          id: 1,
          proposalHash: H64('a'),
          collateralHash: H64('b'),
          collateralIndex: 0,
          voteOutcome: 'yes',
          voteSignal: 'funding',
          voteTime: 1_700_000_000,
          status: 'confirmed',
          lastError: null,
          submittedAt: 1_700_000_050_000,
          verifiedAt: 1_700_000_080_000,
        },
      ],
    });
    const out = await service.fetchRecentReceipts();
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0].status).toBe('confirmed');
  });

  test('passes the limit param through to the server', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts/recent').reply((config) => {
      // Axios serialises `params` onto the query string for GETs;
      // assert the server would have seen the integer we passed.
      expect(config.params).toEqual({ limit: 5 });
      return [200, { receipts: [] }];
    });
    await service.fetchRecentReceipts({ limit: 5 });
  });

  test('omits the limit param when the caller passes nothing', async () => {
    // We want the backend's default (10) to apply rather than pinning
    // a contract from the client. Pre-sending `limit=undefined` would
    // serialise as "limit=" on the wire which would then fail the
    // server's NaN guard.
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts/recent').reply((config) => {
      expect(config.params).toEqual({});
      return [200, { receipts: [] }];
    });
    await service.fetchRecentReceipts();
  });

  test('rejects nonsense limits before making a request', async () => {
    const { service } = makeService();
    await expect(
      service.fetchRecentReceipts({ limit: 0 })
    ).rejects.toMatchObject({ code: 'invalid_limit' });
    await expect(
      service.fetchRecentReceipts({ limit: -1 })
    ).rejects.toMatchObject({ code: 'invalid_limit' });
    await expect(
      service.fetchRecentReceipts({ limit: 2.5 })
    ).rejects.toMatchObject({ code: 'invalid_limit' });
  });

  test('defaults receipts to [] on a malformed body', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts/recent').reply(200, {});
    const out = await service.fetchRecentReceipts();
    expect(out.receipts).toEqual([]);
  });

  test('maps network failures to network_error', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts/recent').networkError();
    await expect(service.fetchRecentReceipts()).rejects.toMatchObject({
      code: 'network_error',
    });
  });
});
