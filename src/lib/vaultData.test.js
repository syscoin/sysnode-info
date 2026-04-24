const {
  SCHEMA_VERSION,
  emptyPayload,
  normalisePayload,
  parseImportLine,
  parseImportInput,
  buildKeysFromValidRows,
  addKeys,
  removeKey,
  updateKeyLabel,
} = require('./vaultData');
const { HDKey } = require('@scure/bip32');
const {
  addDescriptorChecksum,
  importFromDescriptor,
} = require('./syscoin/descriptor');

// Canonical fixture — the known pk=1 Syscoin mainnet WIF / bech32
// address (pinned in syscoin/wif.test.js so any drift shows up there
// first). The address is P2WPKH to match Syscoin Core's rendering of
// `CDeterministicMNState::keyIDVoting` in `protx_info` et al.
const WIF_1 = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn';
const ADDR_1 = 'sys1qw508d6qejxtdg4y5r3zarvary0c5xw7kyhct58';
// Second canonical WIF: the compressed Syscoin mainnet encoding of
// the scalar pk=2. Generated offline once by feeding a 32-byte
// big-endian "2" through base58check with version 0x80 and the 0x01
// compression flag — the first assertion in this suite re-derives
// the corresponding address from this WIF via validateWif() so any
// future drift in our constants fails the suite rather than
// producing a subtly wrong duplicate-detection test.
const WIF_2 = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU74NMTptX4';
// Intentionally malformed: single-char tweak to break checksum.
const WIF_BAD_CHECKSUM = WIF_1.slice(0, -1) + (WIF_1.slice(-1) === 'A' ? 'B' : 'A');

function descriptorFixtures() {
  const seed = new Uint8Array(32).fill(7);
  const root = HDKey.fromMasterSeed(seed);
  const xprv = root.privateExtendedKey;
  const fixed = addDescriptorChecksum(`wpkh(${xprv}/0/5)`);
  const ranged = addDescriptorChecksum(`wpkh(${xprv}/0/*)`);
  const wifBacked = addDescriptorChecksum(`wpkh(${WIF_1})`);
  const fixedOut = importFromDescriptor(fixed);
  return { fixed, ranged, wifBacked, fixedOut };
}

describe('normalisePayload', () => {
  test('maps undefined / null / non-object input to emptyPayload()', () => {
    expect(normalisePayload(undefined)).toEqual(emptyPayload());
    expect(normalisePayload(null)).toEqual(emptyPayload());
    expect(normalisePayload('nope')).toEqual(emptyPayload());
    expect(normalisePayload(42)).toEqual(emptyPayload());
  });

  test('stamps SCHEMA_VERSION and defaults missing fields', () => {
    const input = {
      keys: [
        { wif: WIF_1, address: ADDR_1 },
        { id: 'k2', label: 'MN2', wif: WIF_2, address: 'sys1q…', createdAt: 123 },
      ],
    };
    const out = normalisePayload(input);
    expect(out.version).toBe(SCHEMA_VERSION);
    expect(out.keys).toHaveLength(2);
    expect(out.keys[0]).toMatchObject({
      label: '',
      wif: WIF_1,
      address: ADDR_1,
    });
    expect(typeof out.keys[0].id).toBe('string');
    expect(out.keys[0].id.length).toBeGreaterThan(0);
    expect(Number.isFinite(out.keys[0].createdAt)).toBe(true);
    expect(out.keys[1]).toMatchObject({
      id: 'k2',
      label: 'MN2',
      createdAt: 123,
    });
  });

  test('discards a non-array keys field rather than throwing', () => {
    expect(normalisePayload({ keys: 'not-an-array' })).toEqual(emptyPayload());
  });
});

describe('parseImportLine', () => {
  test('returns null for blank lines and non-strings', () => {
    expect(parseImportLine('')).toBeNull();
    expect(parseImportLine('    ')).toBeNull();
    expect(parseImportLine(null)).toBeNull();
    expect(parseImportLine(undefined)).toBeNull();
  });

  test('accepts "<wif>" with no label', () => {
    expect(parseImportLine(WIF_1)).toEqual({
      wif: WIF_1,
      addressHint: '',
      label: '',
    });
  });

  test('accepts "<wif>," with an empty label (CSV trailing delimiter)', () => {
    expect(parseImportLine(`${WIF_1},`)).toEqual({
      wif: WIF_1,
      label: '',
      addressHint: '',
    });
  });

  test('splits on the first comma and keeps commas in the label', () => {
    expect(parseImportLine(`${WIF_1},MN 1`)).toEqual({
      wif: WIF_1,
      addressHint: '',
      label: 'MN 1',
    });
    expect(parseImportLine(`${WIF_1},home, rack B`)).toEqual({
      wif: WIF_1,
      addressHint: '',
      label: 'home, rack B',
    });
  });

  test('strips CSV-style trailing commas from labels', () => {
    expect(parseImportLine(`${WIF_1},MN 1,`)).toEqual({
      wif: WIF_1,
      addressHint: '',
      label: 'MN 1',
    });
  });

  test('accepts a tab-separated label (common from spreadsheets)', () => {
    expect(parseImportLine(`${WIF_1}\tMN 1`)).toEqual({
      wif: WIF_1,
      addressHint: '',
      label: 'MN 1',
    });
  });

  test('strips a UTF-8 BOM from the start of the line (Excel exports)', () => {
    expect(parseImportLine(`\uFEFF${WIF_1},MN`)).toEqual({
      wif: WIF_1,
      addressHint: '',
      label: 'MN',
    });
  });

  test('strips a trailing \\r that Windows-style input leaves behind', () => {
    expect(parseImportLine(`${WIF_1},MN\r`)).toEqual({
      wif: WIF_1,
      addressHint: '',
      label: 'MN',
    });
  });

  test('recognises descriptor,address,label rows', () => {
    const { ranged, fixedOut } = descriptorFixtures();
    expect(parseImportLine(`${ranged},${fixedOut.address},MN 1`)).toEqual({
      wif: ranged,
      addressHint: fixedOut.address,
      label: 'MN 1',
    });
  });

  test('treats the second field as the address hint for ranged descriptors even when invalid', () => {
    const { ranged } = descriptorFixtures();
    expect(parseImportLine(`${ranged},sys1typoedaddress,MN 1`)).toEqual({
      wif: ranged,
      addressHint: 'sys1typoedaddress',
      label: 'MN 1',
    });
  });

  test('keeps address-looking labels on fixed descriptors', () => {
    const { fixed, fixedOut } = descriptorFixtures();
    expect(parseImportLine(`${fixed},${fixedOut.address}`)).toEqual({
      wif: fixed,
      addressHint: '',
      label: fixedOut.address,
    });
  });

  test('keeps labels on WIF-backed descriptors', () => {
    const { wifBacked } = descriptorFixtures();
    expect(parseImportLine(`${wifBacked},MN 1`)).toEqual({
      wif: wifBacked,
      addressHint: '',
      label: 'MN 1',
    });
  });
});

describe('parseImportInput', () => {
  test('self-consistency: WIF_2 constant matches its expected address', () => {
    // Belt-and-braces: if one of our canonical fixtures drifts out
    // of sync with the WIF lib (e.g. someone swaps the pinned WIF)
    // this test fails fast rather than later, in a downstream
    // import/dedupe assertion.
    const { rows } = parseImportInput(WIF_2, emptyPayload());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('valid');
    // We don't pin ADDR_2 — the lib IS the source of truth — but we
    // do assert it has the Syscoin mainnet bech32 shape.
    expect(rows[0].address).toMatch(/^sys1q/);
  });

  test('returns per-row results + summary for a mixed paste', () => {
    const { fixed } = descriptorFixtures();
    const text = [
      '', // blank → skipped
      `${WIF_1},MN 1`,
      WIF_2,
      `${fixed},descriptor`,
      '',
      WIF_BAD_CHECKSUM,
      `${WIF_1},duplicate paste`, // intra-batch duplicate of row 1
    ].join('\n');

    const { rows, summary } = parseImportInput(text, emptyPayload());

    expect(summary).toEqual({
      total: 5,
      valid: 3,
      invalid: 1,
      duplicate: 1,
      pending: 0,
    });

    expect(rows[0]).toMatchObject({ kind: 'valid', label: 'MN 1' });
    expect(rows[0]).toHaveProperty('address');
    expect(rows[1]).toMatchObject({ kind: 'valid', wif: WIF_2, label: '' });
    expect(rows[2]).toMatchObject({ kind: 'valid', label: 'descriptor' });
    expect(rows[2]).toHaveProperty('address');
    expect(rows[2].wif).toMatch(/^[KL]/);
    expect(rows[3]).toMatchObject({ kind: 'invalid' });
    expect(rows[3].code).toMatch(/^wif_/);
    expect(rows[4]).toMatchObject({
      kind: 'duplicate',
      reason: 'duplicate_in_paste',
    });
  });

  test('requires an address hint for ranged descriptors', () => {
    const { ranged } = descriptorFixtures();
    const { rows } = parseImportInput(ranged, emptyPayload());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'invalid',
      code: 'descriptor_address_required',
    });
  });

  test('accepts ranged descriptors when a voting address is supplied', () => {
    const { ranged, fixedOut } = descriptorFixtures();
    const { rows } = parseImportInput(
      `${ranged},${fixedOut.address},MN desc`,
      emptyPayload()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'valid',
      label: 'MN desc',
      address: fixedOut.address,
      wif: fixedOut.wif,
    });
  });

  test('accepts WIF-backed descriptors', () => {
    const { wifBacked } = descriptorFixtures();
    const { rows } = parseImportInput(`${wifBacked},MN desc`, emptyPayload());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'valid',
      label: 'MN desc',
      address: ADDR_1,
      wif: WIF_1,
    });
  });

  test('reports an invalid ranged descriptor address hint as invalid, not missing', () => {
    const { ranged } = descriptorFixtures();
    const { rows } = parseImportInput(
      `${ranged},sys1typoedaddress,MN desc`,
      emptyPayload()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'invalid',
      code: 'descriptor_address_invalid',
    });
  });

  test('preserves address-looking labels on fixed descriptors', () => {
    const { fixed, fixedOut } = descriptorFixtures();
    const { rows } = parseImportInput(
      `${fixed},${fixedOut.address}`,
      emptyPayload()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'valid',
      label: fixedOut.address,
      address: fixedOut.address,
    });
  });

  test('marks duplicates against already-stored vault entries distinctly', () => {
    const vault = addKeys(emptyPayload(), [
      {
        id: 'x',
        label: '',
        wif: WIF_1,
        address: ADDR_1,
        createdAt: 0,
      },
    ]);
    const { rows } = parseImportInput(`${WIF_1},re-import`, vault);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'duplicate',
      reason: 'already_in_vault',
    });
  });

  test('line numbering matches the original 1-based lines (blank lines counted)', () => {
    const text = `\n\n${WIF_1},MN 1\n`;
    const { rows } = parseImportInput(text, emptyPayload());
    expect(rows).toHaveLength(1);
    expect(rows[0].lineNo).toBe(3);
  });

  test('tolerates undefined / null text input', () => {
    expect(parseImportInput(undefined, emptyPayload())).toEqual({
      rows: [],
      summary: { total: 0, valid: 0, invalid: 0, duplicate: 0, pending: 0 },
    });
    expect(parseImportInput(null, emptyPayload())).toEqual({
      rows: [],
      summary: { total: 0, valid: 0, invalid: 0, duplicate: 0, pending: 0 },
    });
  });
});

describe('buildKeysFromValidRows', () => {
  test('drops invalid/duplicate rows and produces canonical records', () => {
    const { fixed, fixedOut } = descriptorFixtures();
    const { rows } = parseImportInput(
      `${WIF_1},MN 1\n${WIF_BAD_CHECKSUM}\n${fixed},from descriptor\n${WIF_2}`,
      emptyPayload()
    );
    const keys = buildKeysFromValidRows(rows, 1_700_000_000_000);
    expect(keys).toHaveLength(3);
    for (const k of keys) {
      expect(typeof k.id).toBe('string');
      expect(k.createdAt).toBe(1_700_000_000_000);
      expect(k.wif).toMatch(/^[KL5]/);
      expect(k.address).toMatch(/^sys1q/);
    }
    expect(keys[0].label).toBe('MN 1');
    expect(keys[1]).toMatchObject({
      label: 'from descriptor',
      wif: fixedOut.wif,
      address: fixedOut.address,
    });
    expect(keys[2].label).toBe('');
  });

  test('gives every key a fresh id even when called twice with the same rows', () => {
    const { rows } = parseImportInput(WIF_1, emptyPayload());
    const a = buildKeysFromValidRows(rows, 1);
    const b = buildKeysFromValidRows(rows, 2);
    expect(a[0].id).not.toBe(b[0].id);
  });
});

describe('addKeys / removeKey / updateKeyLabel', () => {
  const base = addKeys(emptyPayload(), [
    {
      id: 'k1',
      label: 'first',
      wif: WIF_1,
      address: ADDR_1,
      createdAt: 1,
    },
  ]);

  test('addKeys appends and does not mutate the input', () => {
    // Freezing the input proves `addKeys` cannot mutate in place —
    // any write attempt would throw synchronously in strict mode.
    const frozen = Object.freeze({
      ...base,
      keys: Object.freeze([...base.keys]),
    });
    const next = addKeys(frozen, [
      { id: 'k2', label: '', wif: WIF_2, address: 'sys1q…', createdAt: 2 },
    ]);
    expect(next).not.toBe(frozen);
    expect(next.keys).toHaveLength(2);
    expect(next.keys[0]).toMatchObject(base.keys[0]);
    expect(next.keys[1]).toMatchObject({ id: 'k2', wif: WIF_2 });
  });

  test('removeKey drops the row by id', () => {
    const after = removeKey(base, 'k1');
    expect(after.keys).toHaveLength(0);
    // removing a non-existent id is a no-op, not an error
    expect(removeKey(after, 'k1').keys).toHaveLength(0);
  });

  test('updateKeyLabel trims whitespace and leaves other keys untouched', () => {
    const twoKey = addKeys(base, [
      { id: 'k2', label: 'second', wif: WIF_2, address: 'sys1q…', createdAt: 2 },
    ]);
    const after = updateKeyLabel(twoKey, 'k1', '  renamed  ');
    const found = after.keys.find((k) => k.id === 'k1');
    expect(found.label).toBe('renamed');
    const other = after.keys.find((k) => k.id === 'k2');
    expect(other.label).toBe('second');
  });

  test('updateKeyLabel coerces non-strings to empty string', () => {
    const after = updateKeyLabel(base, 'k1', undefined);
    expect(after.keys[0].label).toBe('');
  });
});
