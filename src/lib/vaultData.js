// Vault payload schema + pure helpers.
//
// The vault blob is a JSON object with the shape
//
//   {
//     version: 1,
//     keys: [
//       {
//         id:        "uuidv4",
//         label:     "MN1",         // user-provided, may be ""
//         wif:       "Kx…",         // Syscoin mainnet WIF, compressed
//         address:   "sys1q…",      // P2WPKH bech32 derived at import time
//         createdAt: 1713600000000, // epoch ms
//       },
//       ...
//     ],
//   }
//
// `address` is stored alongside `wif` intentionally: the list view
// doesn't have to re-run secp256k1 on every render (hundreds of keys
// = dozens of ms of CPU per render), and a future "tamper check at
// unlock" can compare against a fresh derivation if we ever want it.
// The address is a function of the private key, so keeping both in sync
// is a property of the helpers below — nothing external constructs a
// key record by hand. Descriptor imports are normalised into the same
// canonical WIF + address shape before they ever reach the vault.

const { validateWif } = require('./syscoin/wif');
const {
  descriptorNeedsAddressHint,
  isDescriptorLike,
  isAnySysVotingAddress,
  validateDescriptor,
  validateDescriptorAsync,
} = require('./syscoin/descriptor');

const SCHEMA_VERSION = 1;

function emptyPayload() {
  return { version: SCHEMA_VERSION, keys: [] };
}

// Return a fresh ID for a key record. Prefers crypto.randomUUID when
// available (all browsers that matter + Node 18+), falls back to a
// 128-bit random hex string otherwise. IDs are UI-only — they don't
// need to be secret, only unique.
function newKeyId() {
  try {
    if (
      typeof globalThis !== 'undefined' &&
      globalThis.crypto &&
      typeof globalThis.crypto.randomUUID === 'function'
    ) {
      return globalThis.crypto.randomUUID();
    }
  } catch (_) {
    // fall through
  }
  const bytes = new Uint8Array(16);
  if (
    typeof globalThis !== 'undefined' &&
    globalThis.crypto &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Normalise what the payload *might* look like (missing fields, old
// schema, etc.) into the canonical shape. Called everywhere that
// accepts a vault payload as input so downstream code can assume the
// shape.
function normalisePayload(payload) {
  if (!payload || typeof payload !== 'object') return emptyPayload();
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  return {
    version: SCHEMA_VERSION,
    keys: keys.map((k) => ({
      id: typeof k.id === 'string' && k.id ? k.id : newKeyId(),
      label: typeof k.label === 'string' ? k.label : '',
      wif: typeof k.wif === 'string' ? k.wif : '',
      address: typeof k.address === 'string' ? k.address : '',
      createdAt: Number.isFinite(k.createdAt) ? k.createdAt : Date.now(),
    })),
  };
}

function cleanTrailingCsvLabel(label) {
  return String(label || '')
    .replace(/\s*,+\s*$/, '')
    .trim();
}

// Split a single pasted line into a generic import tuple. Accepts
//   <key>
//   <key>,
//   <key>,<label>
//   <key>\t<label>
//   <descriptor>,<address>
//   <descriptor>,<address>,<label>
//
// Leading/trailing whitespace on the whole line is stripped here (NOT
// inside parseWif — the library is strict for a reason), as is a
// UTF-8 BOM which Windows/Excel CSV exports sometimes prepend. Blank
// lines return null so the caller can skip them silently.
function parseImportLine(line) {
  if (typeof line !== 'string') return null;
  let trimmed = line.replace(/^\uFEFF/, '').trim();
  if (trimmed === '') return null;
  // Strip trailing CR that Windows pastes leave in; the outer
  // splitter handles \n but leaves \r on each line.
  trimmed = trimmed.replace(/\r$/, '');
  const delim = trimmed.includes('\t') ? '\t' : trimmed.includes(',') ? ',' : null;
  if (!delim) return { wif: trimmed, label: '', addressHint: '' };

  const parts = trimmed.split(delim).map((part) => part.trim());
  const wif = parts.shift() || '';
  let addressHint = '';
  if (
    isDescriptorLike(wif) &&
    descriptorNeedsAddressHint(wif) &&
    parts.length > 0 &&
    isAnySysVotingAddress(parts[0])
  ) {
    addressHint = parts.shift() || '';
  }
  const label = cleanTrailingCsvLabel(parts.join(delim === ',' ? ', ' : delim));
  return { wif, label, addressHint };
}

function summariseRows(rows) {
  return {
    total: rows.length,
    valid: rows.filter((r) => r.kind === 'valid').length,
    invalid: rows.filter((r) => r.kind === 'invalid').length,
    duplicate: rows.filter((r) => r.kind === 'duplicate').length,
    pending: rows.filter((r) => r.kind === 'pending').length,
  };
}

function previewImportInput(text) {
  const entries = [];
  const rows = [];
  const lines = String(text || '').split(/\n/);
  lines.forEach((raw, idx) => {
    const parsed = parseImportLine(raw);
    if (parsed === null) return;
    const lineNo = idx + 1;
    const entry = { ...parsed, lineNo };
    entries.push(entry);
    if (parsed.wif === '') {
      rows.push({
        kind: 'invalid',
        lineNo,
        wif: '',
        label: parsed.label,
        code: 'wif_empty',
        message: 'Missing WIF on this line.',
      });
    } else {
      rows.push({
        kind: 'pending',
        lineNo,
        wif: parsed.wif,
        label: parsed.label,
        message: 'Validating…',
      });
    }
  });
  return { entries, rows };
}

async function validateImportEntryAsync(entry, state, opts = {}) {
  const { wif, label, addressHint, lineNo } = entry;
  if (wif === '') {
    return {
      kind: 'invalid',
      lineNo,
      wif: '',
      label,
      code: 'wif_empty',
      message: 'Missing WIF on this line.',
    };
  }
  const v = isDescriptorLike(wif)
    ? await validateDescriptorAsync(wif, {
        addressHint,
        isCancelled: opts.isCancelled,
      })
    : validateWif(wif);
  if (!v.valid) {
    return {
      kind: 'invalid',
      lineNo,
      wif,
      label,
      code: v.code,
      message: v.message,
    };
  }
  const canonicalWif = v.wif || wif;
  if (state.seenWif.has(canonicalWif) || state.seenAddr.has(v.address)) {
    return {
      kind: 'duplicate',
      lineNo,
      wif: canonicalWif,
      label,
      address: v.address,
      reason: 'already_in_vault',
    };
  }
  if (
    state.wifSeenThisBatch.has(canonicalWif) ||
    state.addrSeenThisBatch.has(v.address)
  ) {
    return {
      kind: 'duplicate',
      lineNo,
      wif: canonicalWif,
      label,
      address: v.address,
      reason: 'duplicate_in_paste',
    };
  }
  state.wifSeenThisBatch.add(canonicalWif);
  state.addrSeenThisBatch.add(v.address);
  return {
    kind: 'valid',
    lineNo,
    wif: canonicalWif,
    label,
    address: v.address,
    compressed: v.compressed,
  };
}

// Turn a blob of pasted text into per-row validation results. We
// always return the same shape per row — {kind, wif, label, lineNo,
// ...} — so the UI can render a simple table regardless of whether a
// given row is valid, invalid, or a duplicate.
//
// `vault` is the current normalised payload (used for duplicate
// detection by address). Callers with an empty vault should pass
// emptyPayload().
function parseImportInput(text, vault) {
  const base = normalisePayload(vault);
  const seenAddr = new Set(base.keys.map((k) => k.address));
  const seenWif = new Set(base.keys.map((k) => k.wif));
  // Extra per-input dedupe: if the same WIF appears twice in the
  // pasted text, we accept the first occurrence and mark subsequent
  // ones as duplicates.
  const addrSeenThisBatch = new Set();
  const wifSeenThisBatch = new Set();

  const rows = [];
  const lines = String(text || '').split(/\n/);
  lines.forEach((raw, idx) => {
    const parsed = parseImportLine(raw);
    if (parsed === null) return; // blank / comment-style line
    const lineNo = idx + 1;
    const { wif, label, addressHint } = parsed;
    if (wif === '') {
      rows.push({
        kind: 'invalid',
        lineNo,
        wif: '',
        label,
        code: 'wif_empty',
        message: 'Missing WIF on this line.',
      });
      return;
    }
    const v = isDescriptorLike(wif)
      ? validateDescriptor(wif, { addressHint })
      : validateWif(wif);
    if (!v.valid) {
      rows.push({
        kind: 'invalid',
        lineNo,
        wif,
        label,
        code: v.code,
        message: v.message,
      });
      return;
    }
    // Duplicate against already-stored vault entries takes
    // precedence over intra-batch duplicates — UI copy is clearer
    // when we distinguish "already in your vault" from "appears
    // twice in your paste".
    const canonicalWif = v.wif || wif;
    if (seenWif.has(canonicalWif) || seenAddr.has(v.address)) {
      rows.push({
        kind: 'duplicate',
        lineNo,
        wif: canonicalWif,
        label,
        address: v.address,
        reason: 'already_in_vault',
      });
      return;
    }
    if (wifSeenThisBatch.has(canonicalWif) || addrSeenThisBatch.has(v.address)) {
      rows.push({
        kind: 'duplicate',
        lineNo,
        wif: canonicalWif,
        label,
        address: v.address,
        reason: 'duplicate_in_paste',
      });
      return;
    }
    wifSeenThisBatch.add(canonicalWif);
    addrSeenThisBatch.add(v.address);
    rows.push({
      kind: 'valid',
      lineNo,
      wif: canonicalWif,
      label,
      address: v.address,
      compressed: v.compressed,
    });
  });

  return { rows, summary: summariseRows(rows) };
}

// Extract the subset of rows we'd actually persist and turn them into
// canonical key records. `importedAt` is injectable so tests can pin
// timestamps; production callers omit it and take Date.now().
function buildKeysFromValidRows(rows, importedAt) {
  const ts = Number.isFinite(importedAt) ? importedAt : Date.now();
  return rows
    .filter((r) => r.kind === 'valid')
    .map((r) => ({
      id: newKeyId(),
      label: r.label || '',
      wif: r.wif,
      address: r.address,
      createdAt: ts,
    }));
}

// Append keys to a vault payload, returning a *new* payload (never
// mutated in place) so callers can pass the result straight to
// vaultService.save().
function addKeys(vault, keys) {
  const base = normalisePayload(vault);
  return {
    version: SCHEMA_VERSION,
    keys: base.keys.concat(Array.isArray(keys) ? keys : []),
  };
}

function removeKey(vault, id) {
  const base = normalisePayload(vault);
  return {
    version: SCHEMA_VERSION,
    keys: base.keys.filter((k) => k.id !== id),
  };
}

function updateKeyLabel(vault, id, label) {
  const base = normalisePayload(vault);
  const next = typeof label === 'string' ? label.trim() : '';
  return {
    version: SCHEMA_VERSION,
    keys: base.keys.map((k) => (k.id === id ? { ...k, label: next } : k)),
  };
}

module.exports = {
  SCHEMA_VERSION,
  emptyPayload,
  normalisePayload,
  newKeyId,
  parseImportLine,
  summariseRows,
  previewImportInput,
  validateImportEntryAsync,
  parseImportInput,
  buildKeysFromValidRows,
  addKeys,
  removeKey,
  updateKeyLabel,
};
