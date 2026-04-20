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
// The address is a function of the wif, so keeping both in sync is a
// property of the helpers below — nothing external constructs a key
// record by hand.

const { validateWif } = require('./syscoin/wif');

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

// Split a single pasted line into (wif, label). Accepts
//   <wif>
//   <wif>,<label>
//   <wif>\t<label>
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
  // Comma-first, then tab — mirrors both "CSV exported from Excel"
  // and "copy-pasted from a spreadsheet" cases.
  let sep = -1;
  for (const s of [',', '\t']) {
    const i = trimmed.indexOf(s);
    if (i !== -1) {
      sep = i;
      break;
    }
  }
  if (sep === -1) return { wif: trimmed, label: '' };
  const wif = trimmed.slice(0, sep).trim();
  const label = trimmed.slice(sep + 1).trim();
  return { wif, label };
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
    const { wif, label } = parsed;
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
    const v = validateWif(wif);
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
    if (seenWif.has(wif) || seenAddr.has(v.address)) {
      rows.push({
        kind: 'duplicate',
        lineNo,
        wif,
        label,
        address: v.address,
        reason: 'already_in_vault',
      });
      return;
    }
    if (wifSeenThisBatch.has(wif) || addrSeenThisBatch.has(v.address)) {
      rows.push({
        kind: 'duplicate',
        lineNo,
        wif,
        label,
        address: v.address,
        reason: 'duplicate_in_paste',
      });
      return;
    }
    wifSeenThisBatch.add(wif);
    addrSeenThisBatch.add(v.address);
    rows.push({
      kind: 'valid',
      lineNo,
      wif,
      label,
      address: v.address,
      compressed: v.compressed,
    });
  });

  const summary = {
    total: rows.length,
    valid: rows.filter((r) => r.kind === 'valid').length,
    invalid: rows.filter((r) => r.kind === 'invalid').length,
    duplicate: rows.filter((r) => r.kind === 'duplicate').length,
  };

  return { rows, summary };
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
  parseImportInput,
  buildKeysFromValidRows,
  addKeys,
  removeKey,
  updateKeyLabel,
};
