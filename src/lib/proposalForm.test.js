import {
  emptyForm,
  fromDraft,
  satsStringToSys,
  sysToSatsString,
  validateBasics,
  validatePayment,
  estimatePayloadBytes,
  formsEqual,
  draftBodyFromForm,
  prepareBodyFromForm,
  MAX_NAME_SIZE,
  MAX_PAYMENT_COUNT,
  COLLATERAL_FEE_SATS,
} from './proposalForm';

describe('COLLATERAL_FEE_SATS', () => {
  test('equals exactly 150 SYS in satoshis', () => {
    expect(COLLATERAL_FEE_SATS).toBe(15_000_000_000n);
    expect(COLLATERAL_FEE_SATS).toBe(150n * 100_000_000n);
  });
});

describe('sats <-> sys string conversions', () => {
  test('satsStringToSys: whole numbers render without a decimal point', () => {
    expect(satsStringToSys('100000000')).toBe('1');
    expect(satsStringToSys('15000000000')).toBe('150');
    expect(satsStringToSys('0')).toBe('0');
  });

  test('satsStringToSys: trailing zeros are stripped', () => {
    expect(satsStringToSys('150000000')).toBe('1.5');
    expect(satsStringToSys('125000000')).toBe('1.25');
    expect(satsStringToSys('100050000')).toBe('1.0005');
  });

  test('satsStringToSys: preserves 8-place precision for sub-satoshi-worth inputs', () => {
    expect(satsStringToSys('1')).toBe('0.00000001');
    expect(satsStringToSys('12345678')).toBe('0.12345678');
  });

  test('satsStringToSys: rejects non-digit or negative strings', () => {
    expect(satsStringToSys('-100')).toBe('');
    expect(satsStringToSys('1.5')).toBe('');
    expect(satsStringToSys('hello')).toBe('');
    expect(satsStringToSys('')).toBe('');
    expect(satsStringToSys(null)).toBe('');
  });

  test('sysToSatsString: handles common formats', () => {
    expect(sysToSatsString('1')).toBe('100000000');
    expect(sysToSatsString('1.5')).toBe('150000000');
    expect(sysToSatsString('0.00000001')).toBe('1');
    expect(sysToSatsString('150')).toBe('15000000000');
  });

  test('sysToSatsString: pads fractional part to 8 places', () => {
    expect(sysToSatsString('0.1')).toBe('10000000');
    expect(sysToSatsString('0.12')).toBe('12000000');
  });

  test('sysToSatsString: rejects malformed input', () => {
    expect(sysToSatsString('-1')).toBeNull();
    expect(sysToSatsString('+1')).toBeNull();
    expect(sysToSatsString('1.123456789')).toBeNull(); // 9 places
    expect(sysToSatsString('1e10')).toBeNull();
    expect(sysToSatsString('abc')).toBeNull();
    expect(sysToSatsString('')).toBeNull();
    expect(sysToSatsString(null)).toBeNull();
  });

  test('round-trip preserves value for 8-place amounts', () => {
    for (const v of ['0', '1', '1.5', '0.00000001', '12345.6789', '99999.99999999']) {
      const s = sysToSatsString(v);
      expect(s).not.toBeNull();
      expect(satsStringToSys(s)).toBe(v === '0' ? '0' : v.replace(/\.?0+$/, ''));
    }
  });
});

describe('fromDraft', () => {
  test('empty / null maps to the blank form', () => {
    expect(fromDraft(null)).toEqual(emptyForm());
    expect(fromDraft(undefined)).toEqual(emptyForm());
    expect(fromDraft({})).toEqual(emptyForm());
  });

  test('renders sats into a decimal SYS string for display', () => {
    const form = fromDraft({
      name: 'fund-docs',
      url: 'https://sys.org/p',
      paymentAddress: 'sys1qabc',
      paymentAmountSats: '150000000', // 1.5 SYS
      paymentCount: 12,
      startEpoch: 1800000000,
      endEpoch: 1802592000,
    });
    expect(form.paymentAmount).toBe('1.5');
    expect(form.paymentCount).toBe('12');
    expect(form.startEpoch).toBe('1800000000');
    expect(form.endEpoch).toBe('1802592000');
  });

  test('uses explicit paymentAmount string when backend already formatted it', () => {
    expect(
      fromDraft({ paymentAmount: '0.00000001' }).paymentAmount
    ).toBe('0.00000001');
  });
});

describe('validateBasics', () => {
  test('passes for a clean name+url', () => {
    expect(
      validateBasics({ name: 'fund-docs_v2', url: 'https://sys.org/p' })
    ).toEqual({});
  });

  test('flags empty name / url', () => {
    expect(validateBasics({ name: '', url: '' })).toEqual({
      name: expect.any(String),
      url: expect.any(String),
    });
  });

  test('flags name with disallowed characters', () => {
    expect(validateBasics({ name: 'fund docs', url: 'https://a.test' })).toMatchObject({
      name: expect.stringMatching(/hyphens/i),
    });
    expect(validateBasics({ name: 'x!y', url: 'https://a.test' })).toHaveProperty('name');
  });

  test('flags name over MAX_NAME_SIZE', () => {
    const name = 'a'.repeat(MAX_NAME_SIZE + 1);
    expect(validateBasics({ name, url: 'https://a.test' })).toMatchObject({
      name: expect.stringMatching(/40/),
    });
  });

  test('flags url without http(s):// scheme', () => {
    expect(validateBasics({ name: 'x', url: 'ipfs://abc' })).toMatchObject({
      url: expect.stringMatching(/http/i),
    });
    expect(validateBasics({ name: 'x', url: 'javascript:alert(1)' })).toHaveProperty('url');
  });

  test('flags url containing whitespace', () => {
    expect(
      validateBasics({ name: 'x', url: 'https://a.test /x' })
    ).toMatchObject({ url: expect.stringMatching(/space/i) });
  });
});

describe('validatePayment', () => {
  const base = {
    paymentAddress: 'sys1qabcdefghij1234567890',
    paymentAmount: '150',
    paymentCount: '1',
    startEpoch: '1900000000',
    endEpoch: '1902592000',
  };

  test('happy path', () => {
    expect(validatePayment(base, { nowSec: 1800000000 })).toEqual({});
  });

  test('flags non-address payment string', () => {
    expect(
      validatePayment({ ...base, paymentAddress: 'not-an-address' }, { nowSec: 1 })
    ).toHaveProperty('paymentAddress');
  });

  test('flags zero / negative / malformed amounts', () => {
    expect(validatePayment({ ...base, paymentAmount: '0' }, { nowSec: 1 }))
      .toMatchObject({ paymentAmount: expect.stringMatching(/greater than zero/i) });
    expect(validatePayment({ ...base, paymentAmount: '-5' }, { nowSec: 1 }))
      .toHaveProperty('paymentAmount');
    expect(validatePayment({ ...base, paymentAmount: 'foo' }, { nowSec: 1 }))
      .toHaveProperty('paymentAmount');
  });

  test('flags payment count outside [1, MAX]', () => {
    expect(validatePayment({ ...base, paymentCount: '0' }, { nowSec: 1 }))
      .toHaveProperty('paymentCount');
    expect(validatePayment({ ...base, paymentCount: String(MAX_PAYMENT_COUNT + 1) }, { nowSec: 1 }))
      .toHaveProperty('paymentCount');
    expect(validatePayment({ ...base, paymentCount: '1.5' }, { nowSec: 1 }))
      .toHaveProperty('paymentCount');
  });

  test('flags missing epochs and end <= start', () => {
    expect(validatePayment({ ...base, startEpoch: '', endEpoch: '' }, { nowSec: 1 }))
      .toMatchObject({
        startEpoch: expect.any(String),
        endEpoch: expect.any(String),
      });
    expect(
      validatePayment(
        { ...base, startEpoch: '1800000000', endEpoch: '1800000000' },
        { nowSec: 1 }
      )
    ).toHaveProperty('endEpoch');
    expect(
      validatePayment(
        { ...base, startEpoch: '1800000000', endEpoch: '1700000000' },
        { nowSec: 1 }
      )
    ).toHaveProperty('endEpoch');
  });

  test('flags start in the past (beyond a 60s grace)', () => {
    const nowSec = 1_800_000_000;
    expect(
      validatePayment(
        { ...base, startEpoch: String(nowSec - 3600), endEpoch: String(nowSec + 3600) },
        { nowSec }
      )
    ).toHaveProperty('startEpoch');
    // Within grace → ok
    expect(
      validatePayment(
        { ...base, startEpoch: String(nowSec - 30), endEpoch: String(nowSec + 3600) },
        { nowSec }
      )
    ).not.toHaveProperty('startEpoch');
  });
});

describe('estimatePayloadBytes', () => {
  test('fits comfortably for a realistic proposal', () => {
    const bytes = estimatePayloadBytes({
      name: 'fund-docs',
      url: 'https://syscoin.org/proposals/2026-01/fund-docs.md',
      paymentAddress: 'sys1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      paymentAmount: '150',
      startEpoch: '1900000000',
      endEpoch: '1902592000',
    });
    expect(bytes).toBeLessThan(512);
    expect(bytes).toBeGreaterThan(100);
  });

  test('grows with URL length', () => {
    const small = estimatePayloadBytes({
      name: 'x',
      url: 'https://a.test',
      paymentAddress: 'sys1abc',
      paymentAmount: '1',
      startEpoch: '1',
      endEpoch: '2',
    });
    const large = estimatePayloadBytes({
      name: 'x',
      url: 'https://a.test/' + 'a'.repeat(200),
      paymentAddress: 'sys1abc',
      paymentAmount: '1',
      startEpoch: '1',
      endEpoch: '2',
    });
    expect(large).toBeGreaterThan(small + 150);
  });
});

describe('formsEqual', () => {
  test('two empty forms are equal', () => {
    expect(formsEqual(emptyForm(), emptyForm())).toBe(true);
  });

  test('trailing whitespace does not flag a diff', () => {
    const a = { ...emptyForm(), name: 'foo' };
    const b = { ...emptyForm(), name: 'foo   ' };
    expect(formsEqual(a, b)).toBe(true);
  });

  test('value change flags a diff', () => {
    const a = { ...emptyForm(), name: 'foo' };
    const b = { ...emptyForm(), name: 'bar' };
    expect(formsEqual(a, b)).toBe(false);
  });

  test('handles null / undefined safely', () => {
    expect(formsEqual(null, emptyForm())).toBe(false);
    expect(formsEqual(emptyForm(), undefined)).toBe(false);
    // Two nullish values ARE trivially equal — they represent "no
    // form yet" and the wizard treats that as "nothing to save".
    expect(formsEqual(null, null)).toBe(true);
  });
});

describe('draftBodyFromForm + prepareBodyFromForm', () => {
  test('drops blank fields from the draft body', () => {
    const body = draftBodyFromForm({ ...emptyForm(), name: 'x' });
    expect(body).toEqual({ name: 'x', paymentCount: 1 });
  });

  test('converts paymentAmount to sats string', () => {
    const body = draftBodyFromForm({ ...emptyForm(), paymentAmount: '1.5' });
    expect(body.paymentAmountSats).toBe('150000000');
  });

  test('prepareBodyFromForm attaches draftId when provided', () => {
    const body = prepareBodyFromForm(
      { ...emptyForm(), name: 'x' },
      { draftId: 7 }
    );
    expect(body).toMatchObject({ draftId: 7, consumeDraft: true });
  });

  test('prepareBodyFromForm respects consumeDraft=false', () => {
    const body = prepareBodyFromForm(
      { ...emptyForm(), name: 'x' },
      { draftId: 7, consumeDraft: false }
    );
    expect(body).toMatchObject({ draftId: 7, consumeDraft: false });
  });

  test('prepareBodyFromForm skips draftId when non-positive', () => {
    const body = prepareBodyFromForm(emptyForm(), { draftId: 0 });
    expect(body).not.toHaveProperty('draftId');
    expect(body).not.toHaveProperty('consumeDraft');
  });
});
