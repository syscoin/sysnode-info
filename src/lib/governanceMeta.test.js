import {
  CLOSING_SOON_SECONDS,
  CLOSING_URGENT_SECONDS,
  MARGIN_WARNING_PERCENT,
  PASSING_SUPPORT_PERCENT,
  closingChip,
  computeOverBudgetMap,
  marginChip,
} from './governanceMeta';

describe('closingChip', () => {
  const DEADLINE_SEC = 1_700_000_000;
  const DEADLINE_MS = DEADLINE_SEC * 1000;

  test('returns null when the deadline is missing or malformed', () => {
    expect(closingChip({ votingDeadline: undefined, nowMs: DEADLINE_MS })).toBeNull();
    expect(closingChip({ votingDeadline: 0, nowMs: DEADLINE_MS })).toBeNull();
    expect(closingChip({ votingDeadline: 'soon', nowMs: DEADLINE_MS })).toBeNull();
  });

  test('returns null when the deadline has already passed', () => {
    expect(
      closingChip({
        votingDeadline: DEADLINE_SEC,
        nowMs: DEADLINE_MS + 1000,
      })
    ).toBeNull();
  });

  test('returns null when the window is wider than the "closing soon" tier', () => {
    const ahead = DEADLINE_MS - (CLOSING_SOON_SECONDS + 60) * 1000;
    expect(
      closingChip({ votingDeadline: DEADLINE_SEC, nowMs: ahead })
    ).toBeNull();
  });

  test('labels the "soon" tier when the window is under a week but not urgent', () => {
    const threeDays = 3 * 24 * 60 * 60;
    const now = DEADLINE_MS - threeDays * 1000;
    const chip = closingChip({ votingDeadline: DEADLINE_SEC, nowMs: now });
    expect(chip).not.toBeNull();
    expect(chip.kind).toBe('closing-soon');
    expect(chip.label).toMatch(/Closes in 3d/);
    expect(chip.remainingSeconds).toBe(threeDays);
  });

  test('escalates to the "urgent" tier inside the 48h window', () => {
    const oneHour = 60 * 60;
    const now = DEADLINE_MS - oneHour * 1000;
    const chip = closingChip({ votingDeadline: DEADLINE_SEC, nowMs: now });
    expect(chip).not.toBeNull();
    expect(chip.kind).toBe('closing-urgent');
    expect(chip.label).toMatch(/Closes in 1h/);
  });

  test('tier boundary: exactly CLOSING_URGENT_SECONDS away still reads as urgent', () => {
    const now = DEADLINE_MS - CLOSING_URGENT_SECONDS * 1000;
    const chip = closingChip({ votingDeadline: DEADLINE_SEC, nowMs: now });
    expect(chip.kind).toBe('closing-urgent');
  });

  test('tier boundary: one second past the urgent window reads as "soon"', () => {
    const now = DEADLINE_MS - (CLOSING_URGENT_SECONDS + 1) * 1000;
    const chip = closingChip({ votingDeadline: DEADLINE_SEC, nowMs: now });
    expect(chip.kind).toBe('closing-soon');
  });
});

describe('computeOverBudgetMap', () => {
  // A 1000-MN network with a 100 SYS superblock budget — keeps
  // the math trivial and lets the ranking cut be obvious at a glance.
  const ENABLED = 1000;
  const BUDGET = 100;

  function p(partial) {
    return {
      Key: partial.Key,
      payment_amount: partial.payment_amount,
      AbsoluteYesCount: partial.AbsoluteYesCount,
    };
  }

  test('returns an empty map when inputs are missing or degenerate', () => {
    expect(
      computeOverBudgetMap({
        proposals: [],
        enabledCount: ENABLED,
        budget: BUDGET,
      }).size
    ).toBe(0);
    expect(
      computeOverBudgetMap({
        proposals: [p({ Key: 'a'.repeat(64), payment_amount: 50, AbsoluteYesCount: 500 })],
        enabledCount: 0,
        budget: BUDGET,
      }).size
    ).toBe(0);
    expect(
      computeOverBudgetMap({
        proposals: [p({ Key: 'a'.repeat(64), payment_amount: 50, AbsoluteYesCount: 500 })],
        enabledCount: ENABLED,
        budget: 0,
      }).size
    ).toBe(0);
  });

  test('ignores failing proposals when deciding who is over budget', () => {
    // 12% support for the first (passing), 5% for the second (failing).
    // Budget is 100 SYS but the only passing row requests 50 SYS, so
    // no one is over budget.
    const map = computeOverBudgetMap({
      proposals: [
        p({ Key: 'a'.repeat(64), payment_amount: 50, AbsoluteYesCount: 120 }),
        p({ Key: 'b'.repeat(64), payment_amount: 200, AbsoluteYesCount: 50 }),
      ],
      enabledCount: ENABLED,
      budget: BUDGET,
    });
    expect(map.size).toBe(0);
  });

  test('flags the lowest-ranked passing proposal when the cumulative sum exceeds the budget', () => {
    // Three passing proposals requesting 60 + 60 + 60 = 180 SYS
    // against a 100 SYS ceiling. Ranked by AbsoluteYesCount descending:
    // rank 1 (200): running=60 (within budget, no chip)
    // rank 2 (150): running=120 (first past ceiling → chip)
    // rank 3 (120): running=180 (still past ceiling → chip)
    const map = computeOverBudgetMap({
      proposals: [
        p({ Key: 'a'.repeat(64), payment_amount: 60, AbsoluteYesCount: 150 }),
        p({ Key: 'b'.repeat(64), payment_amount: 60, AbsoluteYesCount: 200 }),
        p({ Key: 'c'.repeat(64), payment_amount: 60, AbsoluteYesCount: 120 }),
      ],
      enabledCount: ENABLED,
      budget: BUDGET,
    });
    expect(map.size).toBe(2);
    expect(map.get('a'.repeat(64))).toMatchObject({ kind: 'over-budget' });
    expect(map.get('c'.repeat(64))).toMatchObject({ kind: 'over-budget' });
    expect(map.get('b'.repeat(64))).toBeUndefined();
  });

  test('Keys are stored lowercased so callers can look up case-insensitively', () => {
    const MIXED = `${'A'.repeat(32)}${'b'.repeat(32)}`;
    const map = computeOverBudgetMap({
      proposals: [
        p({ Key: 'b'.repeat(64), payment_amount: 80, AbsoluteYesCount: 200 }),
        p({ Key: MIXED, payment_amount: 80, AbsoluteYesCount: 150 }),
      ],
      enabledCount: ENABLED,
      budget: BUDGET,
    });
    expect(map.get(MIXED.toLowerCase())).toMatchObject({ kind: 'over-budget' });
  });
});

describe('marginChip', () => {
  test('returns null when enabledCount is unknown', () => {
    expect(
      marginChip({
        proposal: { AbsoluteYesCount: 100 },
        enabledCount: 0,
      })
    ).toBeNull();
  });

  test('returns null outside the margin band', () => {
    // 15% support — well above the 10% line and outside the
    // 1.5% window.
    expect(
      marginChip({
        proposal: { AbsoluteYesCount: 150 },
        enabledCount: 1000,
      })
    ).toBeNull();
    // 8.4% support — below the line and outside the window.
    expect(
      marginChip({
        proposal: { AbsoluteYesCount: 84 },
        enabledCount: 1000,
      })
    ).toBeNull();
  });

  test('above-line, within margin → margin-thin tone', () => {
    // 11% support → 1% above the line.
    const chip = marginChip({
      proposal: { AbsoluteYesCount: 110 },
      enabledCount: 1000,
    });
    expect(chip).not.toBeNull();
    expect(chip.kind).toBe('margin-thin');
    expect(chip.label).toMatch(/slim margin/i);
  });

  test('below-line, within margin → margin-near tone', () => {
    // 9% support → 1% below the line.
    const chip = marginChip({
      proposal: { AbsoluteYesCount: 90 },
      enabledCount: 1000,
    });
    expect(chip).not.toBeNull();
    expect(chip.kind).toBe('margin-near');
    expect(chip.label).toMatch(/close to passing/i);
  });

  test('boundary: exactly MARGIN_WARNING_PERCENT away still lights the chip', () => {
    const above = marginChip({
      proposal: {
        AbsoluteYesCount: (PASSING_SUPPORT_PERCENT + MARGIN_WARNING_PERCENT) * 10,
      },
      enabledCount: 1000,
    });
    expect(above).not.toBeNull();
    expect(above.kind).toBe('margin-thin');
  });

  test('support at exactly the 10% threshold reads as "Close to passing" (matches ProposalRow\'s support > 10 pass check)', () => {
    // Core's pass logic is strict >10%, so a row at exactly 10%
    // is NOT passing. The chip must agree — otherwise the row
    // shows "not enough votes" paired with "just above the pass
    // threshold" copy, which is confusing.
    const chip = marginChip({
      proposal: { AbsoluteYesCount: 100 },
      enabledCount: 1000,
    });
    expect(chip).not.toBeNull();
    expect(chip.kind).toBe('margin-near');
    expect(chip.label).toMatch(/close to passing/i);
  });
});

describe('tier constants are sane relative to each other', () => {
  // Guard against someone accidentally reordering the closing
  // tiers — urgent must be a tighter window than "soon".
  test('urgent window is a strict subset of the closing-soon window', () => {
    expect(CLOSING_URGENT_SECONDS).toBeLessThan(CLOSING_SOON_SECONDS);
  });
});
