// Descriptor helpers for Syscoin voting-key import.
//
// Scope is intentionally narrow:
//   * accept private descriptors backed by xprv/tprv
//   * derive the matching compressed leaf key
//   * convert that leaf key into the same WIF/address shape the vault
//     already persists today
//
// This lets the rest of the voting pipeline stay unchanged: once a
// descriptor is resolved, the app continues to operate on a normal
// Syscoin WIF + bech32 voting address pair.

const { HDKey } = require('@scure/bip32');
const { base58check, bech32 } = require('@scure/base');
const { sha256 } = require('@noble/hashes/sha2');
const { ripemd160 } = require('@noble/hashes/ripemd160');
const secp = require('@noble/secp256k1');

const { MAINNET, TESTNET, resolveNetwork } = require('./networks');

const b58c = base58check(sha256);
const RANGE_SCAN_LIMIT = 1000;
const RANGE_SCAN_YIELD_EVERY = 25;
const DESCRIPTOR_INPUT_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const DESCRIPTOR_CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const DESCRIPTOR_CHECKSUM_GENERATOR = Object.freeze([
  0xf5dee51989n,
  0xa9fdca3312n,
  0x1bab10e32dn,
  0x3706b1677an,
  0x644d626ffdn,
]);
const BIP32_VERSIONS = Object.freeze({
  mainnet: Object.freeze({
    private: 0x0488ade4,
    public: 0x0488b21e,
  }),
  testnet: Object.freeze({
    private: 0x04358394,
    public: 0x043587cf,
  }),
});

function err(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  return e;
}

function stripChecksum(descriptor) {
  return String(descriptor || '').split('#')[0];
}

function descriptorChecksumPolymod(symbols) {
  let chk = 1n;
  for (const value of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i += 1) {
      if (((top >> BigInt(i)) & 1n) === 1n) chk ^= DESCRIPTOR_CHECKSUM_GENERATOR[i];
    }
  }
  return chk;
}

function descriptorChecksumExpand(value) {
  const groups = [];
  const symbols = [];
  for (const ch of String(value || '')) {
    const pos = DESCRIPTOR_INPUT_CHARSET.indexOf(ch);
    if (pos === -1) return null;
    symbols.push(pos & 31);
    groups.push(pos >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
      groups.length = 0;
    }
  }
  if (groups.length === 1) {
    symbols.push(groups[0]);
  } else if (groups.length === 2) {
    symbols.push(groups[0] * 3 + groups[1]);
  }
  return symbols;
}

function addDescriptorChecksum(descriptor) {
  const bare = stripChecksum(descriptor);
  const symbols = descriptorChecksumExpand(bare);
  if (!symbols) {
    throw err(
      'descriptor_checksum_invalid',
      'Descriptor contains characters that cannot be checksummed.'
    );
  }
  const checksum =
    descriptorChecksumPolymod(symbols.concat([0, 0, 0, 0, 0, 0, 0, 0])) ^ 1n;
  let suffix = '';
  for (let i = 0; i < 8; i += 1) {
    suffix +=
      DESCRIPTOR_CHECKSUM_CHARSET[
        Number((checksum >> (5n * BigInt(7 - i))) & 31n)
      ];
  }
  return `${bare}#${suffix}`;
}

function validateDescriptorChecksum(descriptor) {
  const raw = String(descriptor || '');
  if (!raw.includes('#')) return stripChecksum(raw);
  if (!/#.{8}$/.test(raw)) {
    throw err(
      'descriptor_checksum_invalid',
      'Descriptor checksum must be exactly 8 characters after "#".'
    );
  }
  const bare = raw.slice(0, -9);
  const suffix = raw.slice(-8);
  if ([...suffix].some((ch) => !DESCRIPTOR_CHECKSUM_CHARSET.includes(ch))) {
    throw err(
      'descriptor_checksum_invalid',
      'Descriptor checksum contains invalid characters.'
    );
  }
  const symbols = descriptorChecksumExpand(bare);
  if (!symbols) {
    throw err(
      'descriptor_checksum_invalid',
      'Descriptor contains characters that cannot be checksummed.'
    );
  }
  const expanded = symbols.concat(
    [...suffix].map((ch) => DESCRIPTOR_CHECKSUM_CHARSET.indexOf(ch))
  );
  if (descriptorChecksumPolymod(expanded) !== 1n) {
    throw err(
      'descriptor_checksum_invalid',
      'Descriptor checksum does not match.'
    );
  }
  return bare;
}

function supportedWrapper(cleaned) {
  const s = String(cleaned || '').trim().toLowerCase();
  if (/^wpkh\s*\(/.test(s)) return 'wpkh';
  if (/^pkh\s*\(/.test(s)) return 'pkh';
  if (/^combo\s*\(/.test(s)) return 'combo';
  if (/^sh\s*\(\s*wpkh\s*\(/.test(s)) return 'sh-wpkh';
  return null;
}

function extractKeyExpression(cleaned, wrapper) {
  const source = String(cleaned || '').trim();
  const patterns = {
    wpkh: /^wpkh\s*\(\s*([^()]*)\s*\)\s*$/i,
    pkh: /^pkh\s*\(\s*([^()]*)\s*\)\s*$/i,
    combo: /^combo\s*\(\s*([^()]*)\s*\)\s*$/i,
    'sh-wpkh': /^sh\s*\(\s*wpkh\s*\(\s*([^()]*)\s*\)\s*\)\s*$/i,
  };
  const match = source.match(patterns[wrapper] || /^$/);
  if (!match) {
    throw err(
      'descriptor_key_expression_invalid',
      'Descriptor key expression is malformed.'
    );
  }
  return match[1].trim();
}

function isDescriptorLike(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return (
    s.length > 0 &&
    /^[a-z0-9_]+\(/i.test(s) &&
    /(?:xprv|tprv)[1-9A-HJ-NP-Za-km-z]+/.test(s)
  );
}

function descriptorNeedsAddressHint(value) {
  if (!isDescriptorLike(value)) return false;
  try {
    return parsePrivateDescriptor(String(value).trim()).ranged;
  } catch (_) {
    return false;
  }
}

function isVotingAddress(value, expectedNetwork) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const network = resolveNetwork(expectedNetwork);
    const decoded = bech32.decode(value);
    if (decoded.prefix.toLowerCase() !== network.bech32Hrp) return false;
    if (!Array.isArray(decoded.words) || decoded.words.length < 2) return false;
    if (decoded.words[0] !== 0) return false;
    const program = bech32.fromWords(decoded.words.slice(1));
    return program.length === 20;
  } catch (_) {
    return false;
  }
}

function isAnySysVotingAddress(value) {
  return isVotingAddress(value, MAINNET) || isVotingAddress(value, TESTNET);
}

function normalisePathSegments(pathSuffix) {
  if (!pathSuffix) {
    return { ranged: false, baseSegments: [] };
  }
  const rawSegments = pathSuffix.split('/').filter(Boolean);
  if (rawSegments.length === 0) {
    return { ranged: false, baseSegments: [] };
  }
  const wildcardCount = rawSegments.filter((s) => s === '*').length;
  if (wildcardCount > 1) {
    throw err(
      'descriptor_range_unsupported',
      'Descriptors with more than one wildcard are not supported.'
    );
  }
  if (wildcardCount === 1 && rawSegments[rawSegments.length - 1] !== '*') {
    throw err(
      'descriptor_range_unsupported',
      'Only descriptors that range on the final path segment are supported.'
    );
  }
  const baseSegments = rawSegments
    .filter((s) => s !== '*')
    .map((segment) => {
      if (!/^\d+(?:['hH])?$/.test(segment)) {
        throw err(
          'descriptor_path_invalid',
          'Descriptor derivation path contains an unsupported segment.'
        );
      }
      return segment.replace(/[hH]/g, "'");
    });
  return { ranged: wildcardCount === 1, baseSegments };
}

function parsePrivateDescriptor(descriptor, expectedNetwork) {
  if (typeof descriptor !== 'string' || descriptor.length === 0) {
    throw err('descriptor_empty', 'Descriptor is empty.');
  }
  if (descriptor !== descriptor.trim()) {
    throw err('descriptor_whitespace', 'Descriptor has surrounding whitespace.');
  }
  const cleaned = validateDescriptorChecksum(descriptor);
  const wrapper = supportedWrapper(cleaned);
  if (!wrapper) {
    throw err(
      'descriptor_wrapper_unsupported',
      'Only single-key pkh(...), wpkh(...), combo(...), and sh(wpkh(...)) descriptors are supported.'
    );
  }
  // Governance voting commits to HASH160(compressed_pubkey), not to an
  // output script template. These single-key wrappers all preserve the
  // same underlying compressed pubkey, so deriving the leaf private key
  // and then computing the canonical Syscoin bech32 voting address is
  // correct. Wrappers that tweak or combine keys (for example tr(...),
  // multi(...), sortedmulti(...), wsh(...)) are deliberately rejected.
  const keyExpression = extractKeyExpression(cleaned, wrapper);
  const match = keyExpression.match(
    /^(?:\[[^\]]+\])?((?:xprv|tprv)[1-9A-HJ-NP-Za-km-z]+)((?:\/(?:\*|[0-9]+(?:['hH])?))*)$/
  );
  if (!match) {
    throw err(
      'descriptor_key_expression_invalid',
      'Descriptor must contain exactly one private xprv/tprv key expression.'
    );
  }
  const xprv = match[1];
  const pathSuffix = match[2] || '';
  const keyNetwork = xprv.startsWith('tprv') ? TESTNET : MAINNET;
  const network = resolveNetwork(expectedNetwork);
  if (network.name !== keyNetwork.name) {
    throw err(
      'descriptor_network_mismatch',
      `Descriptor is for ${keyNetwork.name}, expected ${network.name}.`
    );
  }
  return {
    network,
    xprv,
    ...normalisePathSegments(pathSuffix),
  };
}

function rootFromExtendedKey(xprv) {
  return HDKey.fromExtendedKey(
    xprv,
    xprv.startsWith('tprv') ? BIP32_VERSIONS.testnet : BIP32_VERSIONS.mainnet
  );
}

function deriveLeaf(root, baseSegments, index) {
  const fullSegments = [...baseSegments];
  if (typeof index === 'number') fullSegments.push(String(index));
  const path = fullSegments.length > 0 ? `m/${fullSegments.join('/')}` : 'm';
  const node = root.derive(path);
  if (!(node.privateKey instanceof Uint8Array) || node.privateKey.length !== 32) {
    throw err(
      'descriptor_private_key_missing',
      'Descriptor leaf did not yield a private key.'
    );
  }
  return node.privateKey;
}

function addressFromPrivateKey(privateKey, network) {
  const pubkey = secp.getPublicKey(privateKey, true);
  const h160 = ripemd160(sha256(pubkey));
  const words = [0, ...bech32.toWords(h160)];
  return bech32.encode(network.bech32Hrp, words);
}

function wifFromPrivateKey(privateKey, network) {
  const payload = new Uint8Array(34);
  payload[0] = network.wif;
  payload.set(privateKey, 1);
  payload[33] = 0x01; // compressed
  return b58c.encode(payload);
}

function resolvedDescriptorResult(privateKey, network) {
  const address = addressFromPrivateKey(privateKey, network);
  return {
    valid: true,
    address,
    wif: wifFromPrivateKey(privateKey, network),
    network: network.name,
    compressed: true,
  };
}

function importFromDescriptor(descriptor, { addressHint, expectedNetwork } = {}) {
  const parsed = parsePrivateDescriptor(descriptor, expectedNetwork);
  const root = rootFromExtendedKey(parsed.xprv);
  const hint = typeof addressHint === 'string' ? addressHint.trim() : '';

  if (hint && !isVotingAddress(hint, parsed.network)) {
    throw err(
      'descriptor_address_invalid',
      'Descriptor address must be a valid Syscoin voting address.'
    );
  }

  if (!parsed.ranged) {
    const privateKey = deriveLeaf(root, parsed.baseSegments);
    const out = resolvedDescriptorResult(privateKey, parsed.network);
    if (hint && out.address.toLowerCase() !== hint.toLowerCase()) {
      throw err(
        'descriptor_address_mismatch',
        'Descriptor does not derive the supplied voting address.'
      );
    }
    return out;
  }

  if (!hint) {
    throw err(
      'descriptor_address_required',
      'Ranged descriptors need the voting address too. Paste "<descriptor>,<address>" or add a label as "<descriptor>,<address>,<label>".'
    );
  }

  for (let i = 0; i < RANGE_SCAN_LIMIT; i += 1) {
    const privateKey = deriveLeaf(root, parsed.baseSegments, i);
    const out = resolvedDescriptorResult(privateKey, parsed.network);
    if (out.address.toLowerCase() === hint.toLowerCase()) {
      return out;
    }
  }

  throw err(
    'descriptor_address_not_found',
    `Voting address was not found in the first ${RANGE_SCAN_LIMIT} derived keys.`
  );
}

function nextMacrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function importFromDescriptorAsync(
  descriptor,
  {
    addressHint,
    expectedNetwork,
    isCancelled,
    yieldEvery = RANGE_SCAN_YIELD_EVERY,
  } = {}
) {
  const parsed = parsePrivateDescriptor(descriptor, expectedNetwork);
  const root = rootFromExtendedKey(parsed.xprv);
  const hint = typeof addressHint === 'string' ? addressHint.trim() : '';
  const cancelled =
    typeof isCancelled === 'function' ? isCancelled : () => false;

  if (hint && !isVotingAddress(hint, parsed.network)) {
    throw err(
      'descriptor_address_invalid',
      'Descriptor address must be a valid Syscoin voting address.'
    );
  }

  if (!parsed.ranged) {
    const privateKey = deriveLeaf(root, parsed.baseSegments);
    const out = resolvedDescriptorResult(privateKey, parsed.network);
    if (hint && out.address.toLowerCase() !== hint.toLowerCase()) {
      throw err(
        'descriptor_address_mismatch',
        'Descriptor does not derive the supplied voting address.'
      );
    }
    return out;
  }

  if (!hint) {
    throw err(
      'descriptor_address_required',
      'Ranged descriptors need the voting address too. Paste "<descriptor>,<address>" or add a label as "<descriptor>,<address>,<label>".'
    );
  }

  for (let i = 0; i < RANGE_SCAN_LIMIT; i += 1) {
    if (i > 0 && i % yieldEvery === 0) {
      if (cancelled()) throw err('validation_cancelled');
      await nextMacrotask();
      if (cancelled()) throw err('validation_cancelled');
    }
    const privateKey = deriveLeaf(root, parsed.baseSegments, i);
    const out = resolvedDescriptorResult(privateKey, parsed.network);
    if (out.address.toLowerCase() === hint.toLowerCase()) {
      return out;
    }
  }

  throw err(
    'descriptor_address_not_found',
    `Voting address was not found in the first ${RANGE_SCAN_LIMIT} derived keys.`
  );
}

function validateDescriptor(descriptor, opts) {
  try {
    return importFromDescriptor(descriptor, opts);
  } catch (e) {
    return {
      valid: false,
      code: e.code || 'descriptor_invalid',
      message: e.message,
    };
  }
}

async function validateDescriptorAsync(descriptor, opts) {
  try {
    return await importFromDescriptorAsync(descriptor, opts);
  } catch (e) {
    return {
      valid: false,
      code: e.code || 'descriptor_invalid',
      message: e.message,
    };
  }
}

module.exports = {
  RANGE_SCAN_LIMIT,
  RANGE_SCAN_YIELD_EVERY,
  addDescriptorChecksum,
  descriptorNeedsAddressHint,
  isDescriptorLike,
  isVotingAddress,
  isAnySysVotingAddress,
  parsePrivateDescriptor,
  importFromDescriptor,
  importFromDescriptorAsync,
  validateDescriptor,
  validateDescriptorAsync,
};
