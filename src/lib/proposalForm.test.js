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
      // Legacy draft epochs — intentionally dropped by fromDraft since
      // the wizard re-derives them at /prepare time from a live
      // next-superblock anchor. Asserted below.
      startEpoch: 1800000000,
      endEpoch: 1802592000,
    });
    expect(form.paymentAmount).toBe('1.5');
    expect(form.paymentCount).toBe('12');
    expect(form).not.toHaveProperty('startEpoch');
    expect(form).not.toHaveProperty('endEpoch');
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
  };

  test('happy path', () => {
    expect(validatePayment(base)).toEqual({});
  });

  test('flags non-address payment string', () => {
    expect(
      validatePayment({ ...base, paymentAddress: 'not-an-address' })
    ).toHaveProperty('paymentAddress');
  });

  test('flags zero / negative / malformed amounts', () => {
    expect(validatePayment({ ...base, paymentAmount: '0' }))
      .toMatchObject({ paymentAmount: expect.stringMatching(/greater than zero/i) });
    expect(validatePayment({ ...base, paymentAmount: '-5' }))
      .toHaveProperty('paymentAmount');
    expect(validatePayment({ ...base, paymentAmount: 'foo' }))
      .toHaveProperty('paymentAmount');
  });

  test('flags duration (paymentCount) outside [1, MAX]', () => {
    expect(validatePayment({ ...base, paymentCount: '0' }))
      .toHaveProperty('paymentCount');
    expect(validatePayment({ ...base, paymentCount: String(MAX_PAYMENT_COUNT + 1) }))
      .toHaveProperty('paymentCount');
    expect(validatePayment({ ...base, paymentCount: '1.5' }))
      .toHaveProperty('paymentCount');
  });
});

describe('estimatePayloadBytes', () => {
  test('fits comfortably for a realistic proposal', () => {
    const bytes = estimatePayloadBytes({
      name: 'fund-docs',
      url: 'https://syscoin.org/proposals/2026-01/fund-docs.md',
      paymentAddress: 'sys1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      paymentAmount: '150',
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
    });
    const large = estimatePayloadBytes({
      name: 'x',
      url: 'https://a.test/' + 'a'.repeat(200),
      paymentAddress: 'sys1abc',
      paymentAmount: '1',
    });
    expect(large).toBeGreaterThan(small + 150);
  });

  test(
    'large payment amounts are counted at full decimal width, not scientific notation (Codex round 3 P2)',
    () => {
      // Regression: prior impl used Number(paymentAmount).toString(),
      // which collapses "1234567890123.12345678" into
      // "1.2345678901231234e+21" — so the 512-byte gate could pass
      // a proposal the backend serializer (which emits the full
      // decimal) would then reject as oversized. Use a huge amount
      // and assert the byte estimate contains the full decimal text.
      const amountDecimal = '1234567890123.12345678';
      const bytes = estimatePayloadBytes({
        name: 'huge-ask',
        url: 'https://syscoin.org/p/huge',
        paymentAddress: 'sys1qexample',
        paymentAmount: amountDecimal,
      });
      const bytesSmallFrac = estimatePayloadBytes({
        name: 'huge-ask',
        url: 'https://syscoin.org/p/huge',
        paymentAddress: 'sys1qexample',
        paymentAmount: '1234567890123',
      });
      // Sanity bound: the fractional variant is at least as large
      // as the integer variant (more chars in payment_amount).
      expect(bytes).toBeGreaterThanOrEqual(bytesSmallFrac);

      // The critical invariant: the byte-count must reflect the
      // FULL canonical decimal. We reconstruct what the estimator
      // produces (constant 10-digit epoch placeholders; see
      // proposalForm.estimatePayloadBytes) and compare via a
      // TextEncoder byte count. Because the estimator's JSON
      // contains the literal amount string, scientific notation
      // must be absent.
      const EPOCH_PLACEHOLDER = 1_900_000_000;
      const probe = JSON.stringify({
        type: 1,
        name: 'huge-ask',
        start_epoch: EPOCH_PLACEHOLDER,
        end_epoch: EPOCH_PLACEHOLDER,
        payment_address: 'sys1qexample',
        payment_amount: amountDecimal,
        url: 'https://syscoin.org/p/huge',
      });
      expect(bytes).toBe(new TextEncoder().encode(probe).length);
      expect(probe).not.toMatch(/e\+/i); // no scientific notation anywhere
    }
  );
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
  test('drops blank fields from the draft body (create path)', () => {
    const body = draftBodyFromForm({ ...emptyForm(), name: 'x' });
    expect(body).toEqual({ name: 'x', paymentCount: 1 });
  });

  test('converts paymentAmount to sats string', () => {
    const body = draftBodyFromForm({ ...emptyForm(), paymentAmount: '1.5' });
    expect(body.paymentAmountSats).toBe('150000000');
  });

  // Codex PR8 round 13 P2: resuming an existing draft, clearing a
  // text field (e.g. url), then hitting Save must PATCH the field
  // as an explicit empty string so the backend clears the
  // previously-stored value. Prior behavior dropped empty strings
  // from the body, so the backend kept the old value while the UI
  // marked the blank snapshot as "saved" — reload brought back the
  // old text, silently discarding the user's explicit delete.
  test(
    'forUpdate=true: emits explicit empty strings for cleared text fields so PATCH clears them',
    () => {
      const body = draftBodyFromForm(
        {
          ...emptyForm(),
          name: 'still has name',
          url: '', // user cleared this
          paymentAddress: '', // and this
          paymentAmount: '1',
        },
        { forUpdate: true }
      );
      expect(body.name).toBe('still has name');
      expect(body.url).toBe('');
      expect(body.paymentAddress).toBe('');
      // Epochs are always cleared on update now — they are no longer
      // user-editable and are re-derived at /prepare time from a live
      // next-superblock anchor.
      expect(body.startEpoch).toBeNull();
      expect(body.endEpoch).toBeNull();
    }
  );

  test(
    'forUpdate=true preserves populated text fields as non-empty (no spurious clears)',
    () => {
      const body = draftBodyFromForm(
        {
          ...emptyForm(),
          name: 'proposal',
          url: 'https://example.org/p',
          paymentAddress: 'sys1qabcdef1234567890',
        },
        { forUpdate: true }
      );
      expect(body.name).toBe('proposal');
      expect(body.url).toBe('https://example.org/p');
      expect(body.paymentAddress).toBe('sys1qabcdef1234567890');
    }
  );

  test(
    'forUpdate=false (create path) still drops blank text fields',
    () => {
      const body = draftBodyFromForm(
        {
          ...emptyForm(),
          name: 'x',
          url: '',
          paymentAddress: '',
        },
        { forUpdate: false }
      );
      expect(body).not.toHaveProperty('url');
      expect(body).not.toHaveProperty('paymentAddress');
      expect(body).not.toHaveProperty('startEpoch');
      expect(body).not.toHaveProperty('endEpoch');
    }
  );

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

  test('prepareBodyFromForm injects the derived window when provided', () => {
    const body = prepareBodyFromForm(
      { ...emptyForm(), name: 'x' },
      { window: { startEpoch: 1900000000, endEpoch: 1902628000 } }
    );
    expect(body.startEpoch).toBe(1900000000);
    expect(body.endEpoch).toBe(1902628000);
  });

  test('prepareBodyFromForm omits epochs when no window is provided', () => {
    // Callers are expected to always supply `window` for the wizard
    // flow; the backend will reject /prepare without epochs. Keeping
    // the helper lenient here so tests can probe the bare body shape
    // without hand-rolling every field.
    const body = prepareBodyFromForm({ ...emptyForm(), name: 'x' });
    expect(body).not.toHaveProperty('startEpoch');
    expect(body).not.toHaveProperty('endEpoch');
  });
});
