const { HDKey } = require('@scure/bip32');

const {
  isDescriptorLike,
  importFromDescriptor,
  importFromDescriptorAsync,
  validateDescriptor,
  validateDescriptorAsync,
} = require('./descriptor');

function fixtureDescriptors() {
  const seed = new Uint8Array(32).fill(7);
  const root = HDKey.fromMasterSeed(seed);
  const xprv = root.privateExtendedKey;
  return {
    fixed: `wpkh(${xprv}/0/5)#fixture`,
    ranged: `wpkh(${xprv}/0/*)#fixture`,
  };
}

describe('descriptor helpers', () => {
  test('detects descriptor-like private keys', () => {
    const { fixed } = fixtureDescriptors();
    expect(isDescriptorLike(fixed)).toBe(true);
    expect(isDescriptorLike('KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn')).toBe(
      false
    );
  });

  test('imports a fixed private descriptor into a WIF + address pair', () => {
    const { fixed } = fixtureDescriptors();
    const out = importFromDescriptor(fixed);
    expect(out.valid).toBe(true);
    expect(out.address).toMatch(/^sys1q/);
    expect(out.wif).toMatch(/^[KL]/);
    expect(out.compressed).toBe(true);
  });

  test('requires an address hint for ranged descriptors', () => {
    const { ranged } = fixtureDescriptors();
    expect(validateDescriptor(ranged)).toEqual({
      valid: false,
      code: 'descriptor_address_required',
      message:
        'descriptor_address_required: Ranged descriptors need the voting address too. Paste "<descriptor>,<address>" or add a label as "<descriptor>,<address>,<label>".',
    });
  });

  test('resolves a ranged descriptor when the voting address is supplied', () => {
    const { fixed, ranged } = fixtureDescriptors();
    const fixedOut = importFromDescriptor(fixed);
    const rangedOut = importFromDescriptor(ranged, {
      addressHint: fixedOut.address,
    });
    expect(rangedOut).toMatchObject({
      valid: true,
      address: fixedOut.address,
      wif: fixedOut.wif,
    });
  });

  test('async import resolves the same ranged descriptor result', async () => {
    const { fixed, ranged } = fixtureDescriptors();
    const fixedOut = importFromDescriptor(fixed);
    const rangedOut = await importFromDescriptorAsync(ranged, {
      addressHint: fixedOut.address,
      yieldEvery: 1,
    });
    expect(rangedOut).toMatchObject({
      valid: true,
      address: fixedOut.address,
      wif: fixedOut.wif,
    });
  });

  test('rejects a descriptor from the wrong network', () => {
    const { fixed } = fixtureDescriptors();
    const out = validateDescriptor(fixed, { expectedNetwork: 'testnet' });
    expect(out).toMatchObject({
      valid: false,
      code: 'descriptor_network_mismatch',
    });
  });

  test('rejects unsupported wrappers like tr(...)', () => {
    const seed = new Uint8Array(32).fill(7);
    const root = HDKey.fromMasterSeed(seed);
    const out = validateDescriptor(`tr(${root.privateExtendedKey}/0/5)#fixture`);
    expect(out).toMatchObject({
      valid: false,
      code: 'descriptor_wrapper_unsupported',
    });
  });

  test('async validation can be cancelled mid-range scan', async () => {
    const { fixed, ranged } = fixtureDescriptors();
    const fixedOut = importFromDescriptor(fixed);
    const out = await validateDescriptorAsync(ranged, {
      addressHint: fixedOut.address,
      yieldEvery: 1,
      isCancelled: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls > 1;
        };
      })(),
    });
    expect(out).toMatchObject({
      valid: false,
      code: 'validation_cancelled',
    });
  });
});
