// Offline queue for pending vote submissions.
//
// Purpose: when the browser reports itself offline mid-run (or a
// `network_error` comes back with navigator.onLine=false), capture the
// user's vote intent so it survives a tab switch / modal close and can
// be re-offered when the connection returns. The queue is scoped to
// sessionStorage — not localStorage — because:
//
//   * The intent is session-bound. A queued vote three days ago is
//     almost always stale (proposal expired, user voted elsewhere,
//     etc.) and resubmitting it silently would surprise the user.
//   * sessionStorage is cleared when the tab closes, which matches
//     the "re-offer on connection recovery this session" contract.
//
// Stored shape (per entry, keyed by proposalHash):
//
//   {
//     proposalHash  : string,  // 64-hex, lowercased
//     voteOutcome   : 'yes'|'no'|'abstain',
//     voteSignal    : 'funding',
//     targets       : [{ collateralHash, collateralIndex, keyId, address, label }],
//     queuedAt      : number,  // Date.now() at enqueue
//     retryAfterMs  : number|null,  // optional hint
//   }
//
// We deliberately DO NOT persist `voteSig` or `wif` — the signature is
// re-computed at resume time against a fresh `time` stamp so offline
// time-skew can't poison the preimage, and the wif never leaves the
// in-memory vault. The queue records "what should happen when we come
// back online" not "a ready-to-relay blob".

const STORAGE_KEY = 'gov:pending:v1';

function safeStorage() {
  if (typeof window === 'undefined') return null;
  try {
    const s = window.sessionStorage;
    // Touch it to confirm availability (Safari private mode and
    // some e2e harnesses throw on access).
    const probe = '__gov_offline_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch (_) {
    return null;
  }
}

function readAll() {
  const s = safeStorage();
  if (!s) return {};
  const raw = s.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {
    // Corrupt payload — wipe so we don't trip over it forever.
    s.removeItem(STORAGE_KEY);
  }
  return {};
}

function writeAll(obj) {
  const s = safeStorage();
  if (!s) return;
  try {
    if (!obj || Object.keys(obj).length === 0) {
      s.removeItem(STORAGE_KEY);
      return;
    }
    s.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch (_) {
    // Quota or serialization failure — swallow. The queue is best
    // effort; losing it is worse UX but never a correctness
    // problem since the vote can always be re-submitted manually.
  }
}

function normaliseHash(hash) {
  return typeof hash === 'string' ? hash.toLowerCase() : hash;
}

// Enqueue (or replace) a pending vote for a proposal. The latest
// intent wins — if the user queues Yes-for-all then Abstain-for-all
// while offline, the Abstain run is what resumes.
export function enqueue(entry) {
  if (!entry || typeof entry !== 'object') return;
  const key = normaliseHash(entry.proposalHash);
  if (!key) return;
  const all = readAll();
  all[key] = {
    proposalHash: key,
    voteOutcome: entry.voteOutcome,
    voteSignal: entry.voteSignal || 'funding',
    targets: Array.isArray(entry.targets) ? entry.targets : [],
    queuedAt: Number.isFinite(entry.queuedAt) ? entry.queuedAt : Date.now(),
    retryAfterMs: Number.isFinite(entry.retryAfterMs)
      ? entry.retryAfterMs
      : null,
  };
  writeAll(all);
}

export function peek(proposalHash) {
  const key = normaliseHash(proposalHash);
  if (!key) return null;
  const all = readAll();
  const hit = all[key];
  return hit || null;
}

export function drain(proposalHash) {
  const key = normaliseHash(proposalHash);
  if (!key) return null;
  const all = readAll();
  const hit = all[key];
  if (!hit) return null;
  delete all[key];
  writeAll(all);
  return hit;
}

export function clear(proposalHash) {
  const key = normaliseHash(proposalHash);
  if (!key) return;
  const all = readAll();
  if (!(key in all)) return;
  delete all[key];
  writeAll(all);
}

export function listPending() {
  const all = readAll();
  return Object.values(all);
}

// Observe navigator online-state transitions. Returns an unsubscribe
// function. The callback fires once per offline→online edge (not on
// redundant `online` events when we were already online).
export function onOnline(callback) {
  if (
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return () => {};
  }
  const handler = () => {
    try {
      callback();
    } catch (_) {
      // Isolate subscribers from each other.
    }
  };
  window.addEventListener('online', handler);
  return () => window.removeEventListener('online', handler);
}

export function isOffline() {
  if (typeof navigator === 'undefined') return false;
  // `onLine` is false only when the UA is CERTAIN there's no
  // connectivity; a true value may be a false positive (captive
  // portal, etc.), so treating only the `false` case as offline is
  // the safer default.
  return navigator.onLine === false;
}

// Visible for tests that want to reset between cases. Not exported in
// the public bundle path.
export const __internal = { STORAGE_KEY, safeStorage, readAll, writeAll };
