import {
  computeSupportShift,
  describeSupportShift,
} from './governanceSupportShift';

describe('computeSupportShift', () => {
  test('empty input returns a zero delta', () => {
    expect(computeSupportShift([])).toEqual({
      netDelta: 0,
      yesDelta: 0,
      noDelta: 0,
      confirmedReplaced: 0,
      abstainBenign: 0,
    });
  });

  test('fresh yes votes move net support +N', () => {
    const out = computeSupportShift([
      { currentOutcome: 'yes', previousOutcome: null, previousStatus: '' },
      { currentOutcome: 'yes', previousOutcome: null, previousStatus: '' },
      { currentOutcome: 'yes', previousOutcome: null, previousStatus: '' },
    ]);
    expect(out.netDelta).toBe(3);
    expect(out.yesDelta).toBe(3);
    expect(out.noDelta).toBe(0);
    expect(out.confirmedReplaced).toBe(0);
  });

  test('fresh no votes move net support −N', () => {
    const out = computeSupportShift([
      { currentOutcome: 'no', previousOutcome: null, previousStatus: '' },
      { currentOutcome: 'no', previousOutcome: null, previousStatus: '' },
    ]);
    expect(out.netDelta).toBe(-2);
    expect(out.noDelta).toBe(2);
  });

  test('changing a confirmed yes to no moves net support by −2 and flags replacement', () => {
    const out = computeSupportShift([
      {
        currentOutcome: 'no',
        previousOutcome: 'yes',
        previousStatus: 'confirmed',
      },
    ]);
    expect(out.netDelta).toBe(-2);
    expect(out.yesDelta).toBe(-1);
    expect(out.noDelta).toBe(1);
    expect(out.confirmedReplaced).toBe(1);
  });

  test('confirmed yes → yes (no-op) does not move support', () => {
    const out = computeSupportShift([
      {
        currentOutcome: 'yes',
        previousOutcome: 'yes',
        previousStatus: 'confirmed',
      },
    ]);
    expect(out.netDelta).toBe(0);
    expect(out.confirmedReplaced).toBe(0);
  });

  test('relayed-but-not-confirmed prior is treated as no prior contribution', () => {
    // The vote isn't observably on chain yet. We don't subtract it
    // from the delta, or the preview would mis-report what the chain
    // sees right now.
    const out = computeSupportShift([
      {
        currentOutcome: 'no',
        previousOutcome: 'yes',
        previousStatus: 'relayed',
      },
    ]);
    expect(out.netDelta).toBe(-1);
    expect(out.confirmedReplaced).toBe(0);
  });

  test('abstain has no net-support impact', () => {
    const out = computeSupportShift([
      { currentOutcome: 'abstain', previousOutcome: null, previousStatus: '' },
      {
        currentOutcome: 'abstain',
        previousOutcome: 'abstain',
        previousStatus: 'confirmed',
      },
    ]);
    expect(out.netDelta).toBe(0);
    expect(out.yesDelta).toBe(0);
    expect(out.noDelta).toBe(0);
  });

  test('changing confirmed no → yes flips +2', () => {
    const out = computeSupportShift([
      {
        currentOutcome: 'yes',
        previousOutcome: 'no',
        previousStatus: 'confirmed',
      },
    ]);
    expect(out.netDelta).toBe(2);
    expect(out.yesDelta).toBe(1);
    expect(out.noDelta).toBe(-1);
    expect(out.confirmedReplaced).toBe(1);
  });

  test('mixing fresh and replacement entries sums correctly', () => {
    // 3 fresh yes (+3), 2 confirmed-yes-to-no (−4), 1 confirmed-abstain
    // kept as yes (+1, not counted as replacement since abstain
    // contributes 0 to net).
    const out = computeSupportShift([
      { currentOutcome: 'yes', previousOutcome: null, previousStatus: '' },
      { currentOutcome: 'yes', previousOutcome: null, previousStatus: '' },
      { currentOutcome: 'yes', previousOutcome: null, previousStatus: '' },
      {
        currentOutcome: 'no',
        previousOutcome: 'yes',
        previousStatus: 'confirmed',
      },
      {
        currentOutcome: 'no',
        previousOutcome: 'yes',
        previousStatus: 'confirmed',
      },
      {
        currentOutcome: 'yes',
        previousOutcome: 'abstain',
        previousStatus: 'confirmed',
      },
    ]);
    // yes: +3 fresh +1 abstain→yes −2 (yes→no) = +2
    // no: +2 (yes→no)
    // net = 2 − 2 = 0
    expect(out.yesDelta).toBe(2);
    expect(out.noDelta).toBe(2);
    expect(out.netDelta).toBe(0);
    // 2 yes→no + 1 abstain→yes = 3 confirmed rows being replaced.
    expect(out.confirmedReplaced).toBe(3);
  });
});

describe('describeSupportShift', () => {
  test('returns null when no entries are selected', () => {
    expect(describeSupportShift({ netDelta: 0, yesDelta: 0, noDelta: 0 }, 0))
      .toBeNull();
    expect(describeSupportShift(null, 0)).toBeNull();
  });

  test('reports a positive-tone +N headline for net gains', () => {
    const d = describeSupportShift(
      { netDelta: 3, yesDelta: 3, noDelta: 0, confirmedReplaced: 0 },
      3
    );
    expect(d.tone).toBe('positive');
    expect(d.headline).toMatch(/\+\s*3/);
    expect(d.detail).toMatch(/\+3 yes/);
  });

  test('reports a negative-tone −N headline with replacement detail', () => {
    const d = describeSupportShift(
      { netDelta: -2, yesDelta: -1, noDelta: 1, confirmedReplaced: 1 },
      1
    );
    expect(d.tone).toBe('negative');
    expect(d.headline).toMatch(/−\s*2/);
    expect(d.detail).toMatch(/1 prior confirmed vote will change/i);
    expect(d.detail).toMatch(/−1 yes/);
    expect(d.detail).toMatch(/\+1 no/);
  });

  test('reports a neutral "no net-support change" for abstain-only or replacement no-ops', () => {
    const d = describeSupportShift(
      { netDelta: 0, yesDelta: 0, noDelta: 0, confirmedReplaced: 0 },
      2
    );
    expect(d.tone).toBe('neutral');
    expect(d.headline).toMatch(/no net-support change/i);
    expect(d.detail).toBe('');
  });
});
