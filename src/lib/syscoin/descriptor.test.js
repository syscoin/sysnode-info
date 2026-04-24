const { HDKey } = require('@scure/bip32');
const { bech32 } = require('@scure/base');

const {
  addDescriptorChecksum,
  descriptorNeedsAddressHint,
  isDescriptorLike,
  isVotingAddress,
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
    fixed: addDescriptorChecksum(`wpkh(${xprv}/0/5)`),
    ranged: addDescriptorChecksum(`wpkh(${xprv}/0/*)`),
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

  test('detects when a descriptor really needs an address hint', () => {
    const { fixed, ranged } = fixtureDescriptors();
    expect(descriptorNeedsAddressHint(fixed)).toBe(false);
    expect(descriptorNeedsAddressHint(ranged)).toBe(true);
  });

  test('only accepts v0 P2WPKH voting addresses', () => {
    const p2wshLike = bech32.encode(
      'sys',
      [0, ...bech32.toWords(new Uint8Array(32))]
    );
    expect(isVotingAddress(p2wshLike, 'mainnet')).toBe(false);
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

  test('rejects ranged descriptor hints that are not P2WPKH voting addresses', () => {
    const { ranged } = fixtureDescriptors();
    const p2wshLike = bech32.encode(
      'sys',
      [0, ...bech32.toWords(new Uint8Array(32))]
    );
    const out = validateDescriptor(ranged, { addressHint: p2wshLike });
    expect(out).toMatchObject({
      valid: false,
      code: 'descriptor_address_invalid',
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
    const out = validateDescriptor(
      addDescriptorChecksum(`tr(${root.privateExtendedKey}/0/5)`)
    );
    expect(out).toMatchObject({
      valid: false,
      code: 'descriptor_wrapper_unsupported',
    });
  });

  test('rejects a descriptor with a bad checksum suffix', () => {
    const { fixed } = fixtureDescriptors();
    const out = validateDescriptor(`${fixed.slice(0, -1)}x`);
    expect(out).toMatchObject({
      valid: false,
      code: 'descriptor_checksum_invalid',
    });
  });

  test('rejects malformed key expressions instead of matching a prefix', () => {
    const seed = new Uint8Array(32).fill(7);
    const root = HDKey.fromMasterSeed(seed);
    const out = validateDescriptor(
      addDescriptorChecksum(`wpkh(${root.privateExtendedKey}/0/5abc)`)
    );
    expect(out).toMatchObject({
      valid: false,
      code: 'descriptor_key_expression_invalid',
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
