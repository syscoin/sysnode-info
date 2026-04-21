import { cohortChip } from './governanceCohort';

// Minimal summary-row factory. All counts default to 0 and `total`
// defaults to the sum of the per-status counts so tests can just
// set the statuses they care about.
function row(partial = {}) {
  const confirmed = partial.confirmed ?? 0;
  const relayed = partial.relayed ?? 0;
  const stale = partial.stale ?? 0;
  const failed = partial.failed ?? 0;
  const confirmedYes = partial.confirmedYes ?? 0;
  const confirmedNo = partial.confirmedNo ?? 0;
  const confirmedAbstain = partial.confirmedAbstain ?? 0;
  const total =
    partial.total !== undefined
      ? partial.total
      : confirmed + relayed + stale + failed;
  return {
    proposalHash: 'a'.repeat(64),
    confirmed,
    relayed,
    stale,
    failed,
    total,
    confirmedYes,
    confirmedNo,
    confirmedAbstain,
    latestSubmittedAt: 1700000000,
    latestVerifiedAt: 1700000001,
    ...partial,
  };
}

describe('cohortChip — no summary row', () => {
  test('returns null when the user has no owned MNs', () => {
    expect(cohortChip(null, 0)).toBeNull();
    expect(cohortChip(null, null)).toBeNull();
    expect(cohortChip(undefined, null)).toBeNull();
  });

  test('returns a "Not voted" chip when the user owns MNs that have not voted yet', () => {
    const chip = cohortChip(null, 3);
    expect(chip).toMatchObject({ kind: 'not-voted', label: 'Not voted' });
    expect(chip.detail).toMatch(/3 masternodes/);
  });

  test('"Not voted" chip uses singular for a single MN', () => {
    const chip = cohortChip(null, 1);
    expect(chip.detail).toMatch(/1 masternode that/);
  });
});

describe('cohortChip — priority of states', () => {
  test('stale beats failed, pending, and voted', () => {
    const chip = cohortChip(
      row({
        confirmed: 1,
        relayed: 1,
        failed: 1,
        stale: 1,
        confirmedYes: 1,
      }),
      5
    );
    expect(chip).toMatchObject({ kind: 'changed', label: 'Changed' });
    expect(chip.detail).toMatch(/changed elsewhere/i);
  });

  test('failed beats pending and voted', () => {
    const chip = cohortChip(
      row({
        confirmed: 2,
        relayed: 1,
        failed: 1,
        confirmedYes: 2,
      }),
      5
    );
    expect(chip).toMatchObject({ kind: 'needs-retry', label: 'Needs retry' });
    expect(chip.detail).toMatch(/3 of 4 succeeded; 1 failed/);
  });

  test('failed with nothing else shows the minimal retry tooltip', () => {
    const chip = cohortChip(row({ failed: 2 }), 5);
    expect(chip.detail).toMatch(/2 votes failed/);
    expect(chip.detail).not.toMatch(/succeeded/);
  });
});

describe('cohortChip — partial cohort', () => {
  test('owns more MNs than receipts → partial chip with fraction', () => {
    const chip = cohortChip(
      row({ confirmed: 2, confirmedYes: 2 }),
      5
    );
    expect(chip).toMatchObject({ kind: 'partial', label: 'Voted 2/5' });
    expect(chip.detail).toMatch(/2 of your 5 masternodes voted/);
    expect(chip.detail).toMatch(/3 masternodes haven't voted yet/);
  });

  test('partial chip includes confirmed-outcome breakdown when the user split their vote', () => {
    const chip = cohortChip(
      row({ confirmed: 3, confirmedYes: 2, confirmedNo: 1 }),
      5
    );
    expect(chip.label).toBe('Voted 3/5');
    expect(chip.detail).toMatch(/\(2 yes, 1 no\)/);
  });

  test('partial collapses to Voted when ownedCount is unknown', () => {
    const chip = cohortChip(row({ confirmed: 2, confirmedYes: 2 }), null);
    expect(chip.kind).toBe('voted');
    expect(chip.label).toBe('Voted yes');
  });
});

describe('cohortChip — pending precedence', () => {
  test('pending beats partial when a subset of owned MNs has only relayed receipts', () => {
    // Codex P2: ownedCount=5, total=2, relayed=2, confirmed=0
    // used to render "Voted 2/5" (partial) — implying on-chain
    // settlement that hadn't happened. Unconfirmed submissions
    // must surface as pending first so the user isn't lied to
    // about settlement state.
    const chip = cohortChip(row({ relayed: 2 }), 5);
    expect(chip.kind).toBe('pending');
    expect(chip.label).toBe('Pending');
    // Detail still reflects the relay count accurately.
    expect(chip.detail).toMatch(/2 votes submitted/);
  });

  test('pending beats partial in mixed confirmed + relayed + missing-owned case', () => {
    // confirmed=1, relayed=1, ownedCount=5 → without the
    // reorder this returned "Voted 2/5". With the reorder it
    // stays honest: "1 of 2 confirmed; 1 awaiting confirmation".
    const chip = cohortChip(
      row({ confirmed: 1, relayed: 1, confirmedYes: 1 }),
      5
    );
    expect(chip.kind).toBe('pending');
    expect(chip.detail).toMatch(/1 of 2 confirmed/);
    expect(chip.detail).toMatch(/1 awaiting/);
  });
});

describe('cohortChip — pending', () => {
  test('only relayed rows → pending chip', () => {
    const chip = cohortChip(row({ relayed: 2 }), 2);
    expect(chip).toMatchObject({ kind: 'pending', label: 'Pending' });
    expect(chip.detail).toMatch(/2 votes submitted/);
  });

  test('mix of relayed + confirmed → pending chip with breakdown', () => {
    const chip = cohortChip(
      row({ confirmed: 1, relayed: 2, confirmedYes: 1 }),
      3
    );
    expect(chip.kind).toBe('pending');
    expect(chip.detail).toMatch(/1 of 3 confirmed/);
    expect(chip.detail).toMatch(/2 awaiting/);
  });
});

describe('cohortChip — voted happy path', () => {
  test('all confirmed yes → Voted yes label', () => {
    const chip = cohortChip(
      row({ confirmed: 3, confirmedYes: 3 }),
      3
    );
    expect(chip).toMatchObject({ kind: 'voted', label: 'Voted yes' });
    expect(chip.detail).toMatch(/3 votes confirmed/);
    expect(chip.detail).toMatch(/all 3 masternodes/);
  });

  test('all confirmed no → Voted no label', () => {
    const chip = cohortChip(row({ confirmed: 2, confirmedNo: 2 }), 2);
    expect(chip.label).toBe('Voted no');
  });

  test('all confirmed abstain → Voted abstain label', () => {
    const chip = cohortChip(
      row({ confirmed: 1, confirmedAbstain: 1 }),
      1
    );
    expect(chip.label).toBe('Voted abstain');
  });

  test('mixed confirmed outcomes with yes majority → dominant outcome in the label', () => {
    const chip = cohortChip(
      row({ confirmed: 3, confirmedYes: 2, confirmedNo: 1 }),
      3
    );
    expect(chip.label).toBe('Voted yes');
    expect(chip.detail).toMatch(/\(2 yes, 1 no\)/);
  });

  test('tie between yes and no favours yes (stable ordering)', () => {
    const chip = cohortChip(
      row({ confirmed: 2, confirmedYes: 1, confirmedNo: 1 }),
      2
    );
    expect(chip.label).toBe('Voted yes');
  });

  test('ownedCount === total shows the "all N MNs" suffix', () => {
    const chip = cohortChip(
      row({ confirmed: 5, confirmedYes: 5 }),
      5
    );
    expect(chip.detail).toMatch(/all 5 masternodes/);
  });

  test('ownedCount unknown omits the suffix', () => {
    const chip = cohortChip(
      row({ confirmed: 2, confirmedYes: 2 }),
      null
    );
    expect(chip.detail).not.toMatch(/all \d/);
  });
});

describe('cohortChip — defensive inputs', () => {
  test('null/undefined count fields coerce to 0', () => {
    const chip = cohortChip(
      {
        proposalHash: 'x',
        confirmed: null,
        relayed: undefined,
        stale: null,
        failed: null,
        total: 2,
        confirmedYes: null,
        confirmedNo: null,
        confirmedAbstain: null,
      },
      null
    );
    // total=2, all statuses=0 → falls through to the terminal null.
    expect(chip).toBeNull();
  });

  test('negative or NaN counts are clamped to 0 and do not throw', () => {
    const chip = cohortChip(
      { ...row({}), confirmed: -1, relayed: Number.NaN, confirmedYes: -3, total: -5 },
      5
    );
    // All statuses clamped to 0 → degenerate row guard kicks in and
    // falls through to the "no summary row" branch, which with
    // ownedCount=5 emits a Not voted chip.
    expect(chip).toMatchObject({ kind: 'not-voted' });
  });

  test('degenerate row (no statuses) with no ownedCount returns null', () => {
    const chip = cohortChip(
      { ...row({}), confirmed: 0, relayed: 0, stale: 0, failed: 0, total: 0 },
      null
    );
    expect(chip).toBeNull();
  });
});
