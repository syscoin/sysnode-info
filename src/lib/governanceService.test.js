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
  test('GETs /gov/receipts with the proposalHash query param', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts').reply((config) => {
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
          reconciled: true,
          updated: 1,
        },
      ];
    });
    const out = await service.fetchReceipts(H64('a'));
    expect(out.reconciled).toBe(true);
    expect(out.updated).toBe(1);
    expect(out.reconcileError).toBeNull();
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0].status).toBe('confirmed');
  });

  test('passes refresh=1 through when requested', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts').reply((config) => {
      expect(config.params).toEqual({ proposalHash: H64('a'), refresh: 1 });
      return [200, { receipts: [], reconciled: true }];
    });
    await service.fetchReceipts(H64('a'), { refresh: true });
  });

  test('surfaces a reconcileError when the backend reports one', async () => {
    const { service, adapter } = makeService();
    adapter.onGet('/gov/receipts').reply(200, {
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
    const out = await service.fetchReceipts(H64('a'));
    expect(out.reconciled).toBe(false);
    expect(out.reconcileError).toBe('rpc_failed');
    expect(out.receipts).toHaveLength(1);
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
