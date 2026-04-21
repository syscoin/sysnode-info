import { classifyProposal, computeOpsStats } from './governanceOps';

function mkProposal({ key, absoluteYes = 0 }) {
  return { Key: key, AbsoluteYesCount: absoluteYes };
}

function mkSummaryMap(rows) {
  const m = new Map();
  for (const r of rows) {
    m.set(r.proposalHash.toLowerCase(), r);
  }
  return m;
}

function baseRow(overrides) {
  return {
    proposalHash: '',
    total: 0,
    relayed: 0,
    confirmed: 0,
    stale: 0,
    failed: 0,
    confirmedYes: 0,
    confirmedNo: 0,
    confirmedAbstain: 0,
    latestSubmittedAt: null,
    latestVerifiedAt: null,
    ...overrides,
  };
}

describe('classifyProposal', () => {
  const proposal = mkProposal({ key: 'a'.repeat(64), absoluteYes: 100 });

  test('no summary row + owned MNs → needs-vote', () => {
    const map = mkSummaryMap([]);
    expect(classifyProposal(proposal, map, 2)).toBe('needs-vote');
  });

  test('no summary row + zero owned MNs → not-applicable', () => {
    const map = mkSummaryMap([]);
    expect(classifyProposal(proposal, map, 0)).toBe('not-applicable');
  });

  test('no summary row + unknown owned count → not-applicable', () => {
    const map = mkSummaryMap([]);
    expect(classifyProposal(proposal, map, null)).toBe('not-applicable');
  });

  test('all confirmed = voted bucket', () => {
    const map = mkSummaryMap([
      baseRow({
        proposalHash: 'a'.repeat(64),
        total: 2,
        confirmed: 2,
        confirmedYes: 2,
      }),
    ]);
    expect(classifyProposal(proposal, map, 2)).toBe('voted');
  });

  test('pending (relayed only) = voted bucket', () => {
    // User's done the work; we just wait for chain echo.
    const map = mkSummaryMap([
      baseRow({
        proposalHash: 'a'.repeat(64),
        total: 2,
        relayed: 2,
      }),
    ]);
    expect(classifyProposal(proposal, map, 2)).toBe('voted');
  });

  test('partial (ownedCount > total, all confirmed) = needs-vote', () => {
    const map = mkSummaryMap([
      baseRow({
        proposalHash: 'a'.repeat(64),
        total: 1,
        confirmed: 1,
        confirmedYes: 1,
      }),
    ]);
    expect(classifyProposal(proposal, map, 3)).toBe('needs-vote');
  });

  test('any failed row = needs-vote (retry)', () => {
    const map = mkSummaryMap([
      baseRow({
        proposalHash: 'a'.repeat(64),
        total: 2,
        confirmed: 1,
        confirmedYes: 1,
        failed: 1,
      }),
    ]);
    expect(classifyProposal(proposal, map, 2)).toBe('needs-vote');
  });

  test('any stale row = needs-vote (changed)', () => {
    const map = mkSummaryMap([
      baseRow({
        proposalHash: 'a'.repeat(64),
        total: 2,
        confirmed: 1,
        confirmedYes: 1,
        stale: 1,
      }),
    ]);
    expect(classifyProposal(proposal, map, 2)).toBe('needs-vote');
  });
});

describe('computeOpsStats', () => {
  const p1 = mkProposal({ key: 'a'.repeat(64), absoluteYes: 200 });
  const p2 = mkProposal({ key: 'b'.repeat(64), absoluteYes: 50 });
  const p3 = mkProposal({ key: 'c'.repeat(64), absoluteYes: 300 });

  test('empty proposal list', () => {
    const stats = computeOpsStats({
      proposals: [],
      summaryMap: new Map(),
      ownedCount: 5,
      enabledCount: 1000,
    });
    expect(stats).toMatchObject({
      total: 0,
      applicable: 0,
      voted: 0,
      needsVote: 0,
      passing: 0,
      watching: 0,
      progressPercent: null,
      nextUnvotedKey: null,
      ownedCount: 5,
    });
  });

  test('counts voted, needs-vote, and passing buckets', () => {
    // enabledCount=1000 → 10% threshold = absoluteYes > 100 to pass.
    const map = mkSummaryMap([
      baseRow({
        proposalHash: p1.Key,
        total: 2,
        confirmed: 2,
        confirmedYes: 2,
      }),
      // p2 has no receipts → needs-vote (user owns MNs)
      baseRow({
        proposalHash: p3.Key,
        total: 2,
        confirmed: 1,
        confirmedYes: 1,
        failed: 1,
      }),
    ]);

    const stats = computeOpsStats({
      proposals: [p1, p2, p3],
      summaryMap: map,
      ownedCount: 2,
      enabledCount: 1000,
    });
    expect(stats.total).toBe(3);
    expect(stats.applicable).toBe(3);
    expect(stats.voted).toBe(1);
    expect(stats.needsVote).toBe(2);
    expect(stats.passing).toBe(2); // p1 (200/1000=20%) + p3 (300/1000=30%)
    expect(stats.watching).toBe(1); // p2 (50/1000=5%)
    // First needs-vote proposal in display order is p2.
    expect(stats.nextUnvotedKey).toBe(p2.Key);
    expect(stats.progressPercent).toBe(33);
  });

  test('jump link points to the first display-order needs-vote proposal', () => {
    // Same summary, different caller order — jump follows caller order.
    const map = mkSummaryMap([
      baseRow({
        proposalHash: p1.Key,
        total: 2,
        confirmed: 2,
        confirmedYes: 2,
      }),
    ]);
    const stats = computeOpsStats({
      proposals: [p3, p2, p1],
      summaryMap: map,
      ownedCount: 2,
      enabledCount: 1000,
    });
    expect(stats.nextUnvotedKey).toBe(p3.Key);
  });

  test('no owned MNs → everything is not-applicable, progress is null', () => {
    const stats = computeOpsStats({
      proposals: [p1, p2, p3],
      summaryMap: new Map(),
      ownedCount: 0,
      enabledCount: 1000,
    });
    expect(stats.applicable).toBe(0);
    expect(stats.voted).toBe(0);
    expect(stats.needsVote).toBe(0);
    expect(stats.progressPercent).toBeNull();
    expect(stats.nextUnvotedKey).toBeNull();
    expect(stats.passing).toBe(2);
    expect(stats.watching).toBe(1);
  });

  test('unknown enabledCount leaves passing/watching as null', () => {
    const stats = computeOpsStats({
      proposals: [p1, p2],
      summaryMap: new Map(),
      ownedCount: 2,
      enabledCount: null,
    });
    expect(stats.passing).toBeNull();
    expect(stats.watching).toBeNull();
  });

  test('all voted → nextUnvotedKey is null and progress is 100', () => {
    const map = mkSummaryMap([
      baseRow({
        proposalHash: p1.Key,
        total: 2,
        confirmed: 2,
        confirmedYes: 2,
      }),
      baseRow({
        proposalHash: p2.Key,
        total: 2,
        confirmed: 2,
        confirmedYes: 2,
      }),
    ]);
    const stats = computeOpsStats({
      proposals: [p1, p2],
      summaryMap: map,
      ownedCount: 2,
      enabledCount: 1000,
    });
    expect(stats.nextUnvotedKey).toBeNull();
    expect(stats.progressPercent).toBe(100);
  });
});
