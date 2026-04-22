// Pure helpers for the governance-proposal wizard.
//
// This module intentionally owns:
//   - the client-side validation rules that mirror what the backend
//     enforces at /gov/proposals/prepare time (so the wizard "Next"
//     button never rubber-stamps something we'd then throw 400 on)
//   - normalisation of the loose form input (strings from <input>)
//     into the richer shape the API expects
//   - a diff helper the unsaved-changes modal uses to decide whether
//     to bother prompting
//
// It does NOT touch the network or React. All exports are synchronous
// and pure so they're easy to test in isolation.

// Consensus constants — must match lib/proposalValidate.js on the
// backend. Duplicated rather than imported because the frontend is a
// separate package and we don't share code across the repo boundary.
export const MAX_NAME_SIZE = 40;
export const MIN_URL_SIZE = 4;
export const MAX_DATA_SIZE = 512;
// 150 SYS displayed as satoshis, for the burn-fee copy.
export const COLLATERAL_FEE_SATS = 15_000_000_000n;
// Soft UX bound (route layer enforces 1..60). Sixty payments ≈ 5 years
// of monthly superblocks, which is already an absurd ask; we clamp
// higher so the user hits backend validation rather than our client
// bound if the ceiling is ever raised.
export const MAX_PAYMENT_COUNT = 60;

const NAME_ALLOWED = /^[A-Za-z0-9_-]+$/;
const SYS_ADDRESS_RE = /^(sys1|tsys1|[LS3])[A-Za-z0-9]{10,}$/;
// Amount format mirrors buildCanonicalJSON's emitter: up to 8 decimal
// places, no leading '+', optional single '.'. The emitter uses
// `Math.trunc(sats/1e8)` + remainder padding, so pre-parsing here
// needs to accept exactly what the user can type.
const AMOUNT_RE = /^(0|[1-9]\d*)(\.\d{1,8})?$/;

const EMPTY = () => ({
  name: '',
  url: '',
  paymentAddress: '',
  paymentAmount: '',
  paymentCount: '1',
  startEpoch: '',
  endEpoch: '',
});

// Build a blank form. Exported so tests + the wizard can start from a
// consistent baseline and so the diff helper can compare "is this
// truly unchanged?" without inventing its own zero-shape.
export function emptyForm() {
  return EMPTY();
}

// Normalise a draft fetched from the backend (keys are the storage
// shape: paymentAmountSats as a string, etc.) into the form shape
// the wizard renders. Amounts come back as decimal strings via
// formatSysAmount on the backend, so we can surface them directly.
export function fromDraft(draft) {
  if (!draft || typeof draft !== 'object') return EMPTY();
  return {
    name: draft.name || '',
    url: draft.url || '',
    paymentAddress: draft.paymentAddress || '',
    paymentAmount:
      typeof draft.paymentAmount === 'string'
        ? draft.paymentAmount
        : draft.paymentAmountSats
        ? satsStringToSys(String(draft.paymentAmountSats))
        : '',
    paymentCount:
      typeof draft.paymentCount === 'number'
        ? String(draft.paymentCount)
        : draft.paymentCount || '1',
    startEpoch:
      draft.startEpoch != null && Number.isFinite(Number(draft.startEpoch))
        ? String(Math.trunc(Number(draft.startEpoch)))
        : '',
    endEpoch:
      draft.endEpoch != null && Number.isFinite(Number(draft.endEpoch))
        ? String(Math.trunc(Number(draft.endEpoch)))
        : '',
  };
}

// Convert a sats integer string to a decimal SYS string with at most 8
// decimal places and no trailing zeros. Keeps display deterministic
// across locales (no thousands separators, no Intl).
export function satsStringToSys(s) {
  if (typeof s !== 'string' || !/^\d+$/.test(s)) return '';
  try {
    const sats = BigInt(s);
    const whole = sats / 100000000n;
    const frac = sats % 100000000n;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fracStr}`;
  } catch (_err) {
    return '';
  }
}

// Convert a user-entered SYS amount into a BigInt-sats string. Returns
// null on malformed input. Kept as a string so BigInt flows through
// JSON to the backend without loss, which matters for amounts > 2^53
// (ridiculous but possible — governance can propose very large
// figures; don't want the frontend silently narrowing).
export function sysToSatsString(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!AMOUNT_RE.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  const fracPadded = (frac + '00000000').slice(0, 8);
  try {
    const total = BigInt(whole) * 100000000n + BigInt(fracPadded);
    return total.toString();
  } catch (_err) {
    return null;
  }
}

// Validation step #1 — Basics (name + url).
// Returns an object keyed by field name. Missing keys == no error.
export function validateBasics(form) {
  const errors = {};
  const name = (form.name || '').trim();
  if (!name) {
    errors.name = 'Name is required.';
  } else if (name.length > MAX_NAME_SIZE) {
    errors.name = `Name must be ${MAX_NAME_SIZE} characters or fewer.`;
  } else if (!NAME_ALLOWED.test(name)) {
    errors.name =
      'Name can only contain letters, numbers, hyphens and underscores.';
  }
  const url = (form.url || '').trim();
  if (!url) {
    errors.url = 'URL is required.';
  } else if (url.length < MIN_URL_SIZE) {
    errors.url = `URL must be at least ${MIN_URL_SIZE} characters.`;
  } else if (!/^https?:\/\//i.test(url)) {
    errors.url = 'URL must start with http:// or https://';
  } else if (/\s/.test(url)) {
    errors.url = 'URL cannot contain spaces.';
  }
  return errors;
}

// Validation step #2 — Payment details.
export function validatePayment(form, { nowSec } = {}) {
  const errors = {};
  const addr = (form.paymentAddress || '').trim();
  if (!addr) {
    errors.paymentAddress = 'Payment address is required.';
  } else if (!SYS_ADDRESS_RE.test(addr)) {
    // Best-effort shape check — covers bech32 (sys1/tsys1) + legacy
    // P2PKH/P2SH prefixes. The backend re-validates with the full
    // bitcoinjs-lib rules; this is purely so obviously-broken input
    // doesn't cost the user a server round trip.
    errors.paymentAddress =
      "That doesn't look like a Syscoin address. Double-check the format.";
  }
  const amt = (form.paymentAmount || '').trim();
  const sats = sysToSatsString(amt);
  if (!amt) {
    errors.paymentAmount = 'Payment amount is required.';
  } else if (sats === null) {
    errors.paymentAmount =
      'Amount must be a positive number with up to 8 decimal places.';
  } else {
    try {
      if (BigInt(sats) <= 0n) {
        errors.paymentAmount = 'Amount must be greater than zero.';
      }
    } catch (_err) {
      errors.paymentAmount = 'Amount is not valid.';
    }
  }
  const count = Number(form.paymentCount);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PAYMENT_COUNT) {
    errors.paymentCount = `Number of payments must be between 1 and ${MAX_PAYMENT_COUNT}.`;
  }
  const start = Number(form.startEpoch);
  const end = Number(form.endEpoch);
  if (!Number.isInteger(start) || start <= 0) {
    errors.startEpoch = 'Start time is required.';
  }
  if (!Number.isInteger(end) || end <= 0) {
    errors.endEpoch = 'End time is required.';
  }
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start > 0 &&
    end > 0 &&
    end <= start
  ) {
    errors.endEpoch = 'End time must be after start time.';
  }
  // Consensus-ish: start cannot be in the past. Core rejects end in
  // the past outright; start in the past is rarely useful so we
  // flag it as a warning-level error to catch Date picker typos.
  const floor = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  if (Number.isInteger(start) && start > 0 && start < floor - 60) {
    errors.startEpoch = 'Start time is in the past.';
  }
  return errors;
}

// Final step: make sure the fully-formed draft would pass the backend
// `validateStructural` 512-byte rule. We can't perfectly predict the
// canonical JSON here (the backend owns the exact serialisation) but
// a JSON.stringify() of the same payload is an *upper bound* — if we
// fit in 512 with naive stringify, we fit once the canonical emitter
// (which is tighter) gets done with it.
export function estimatePayloadBytes(form) {
  const sats = sysToSatsString((form.paymentAmount || '').trim());
  // Codex PR8 round 3 P2: the prior implementation used
  //   Number(form.paymentAmount).toString()
  // which silently rewrites large decimal inputs into scientific
  // notation (e.g. "1234567890123.12345678" -> "1.234567890123123e+21").
  // That undercounted payload bytes by hundreds of characters, so a
  // proposal the backend's canonical JSON emitter would reject as
  // oversized could pass the client-side gate here.
  //
  // The backend's canonical emitter (lib/proposalValidate.js ::
  // formatSysAmount) formats the amount by dividing the sats BigInt
  // by 10^8 and padding/trimming the fractional part. Our
  // satsStringToSys() mirrors that exactly, so using it here makes
  // this size estimate faithful to what the backend will actually
  // serialize.
  const payload = {
    type: 1,
    name: (form.name || '').trim(),
    start_epoch: Math.trunc(Number(form.startEpoch) || 0),
    end_epoch: Math.trunc(Number(form.endEpoch) || 0),
    payment_address: (form.paymentAddress || '').trim(),
    payment_amount: sats ? satsStringToSys(sats) : '0',
    url: (form.url || '').trim(),
  };
  const json = JSON.stringify(payload);
  return new TextEncoder().encode(json).length;
}

// Dirty-check that drives the "Save to drafts / Discard / Cancel"
// modal. We compare normalised strings so e.g. an untouched epoch
// input doesn't look different just because the user focused/blurred
// it.
export function formsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = [
    'name',
    'url',
    'paymentAddress',
    'paymentAmount',
    'paymentCount',
    'startEpoch',
    'endEpoch',
  ];
  for (const k of keys) {
    if ((a[k] || '').trim() !== (b[k] || '').trim()) return false;
  }
  return true;
}

// Body builder shared by the "save draft" and "update draft" flows.
// Amounts are converted to sats-strings here rather than in the
// component so the tests can pin the conversion matrix.
export function draftBodyFromForm(form) {
  const out = {};
  const name = (form.name || '').trim();
  if (name) out.name = name;
  const url = (form.url || '').trim();
  if (url) out.url = url;
  const addr = (form.paymentAddress || '').trim();
  if (addr) out.paymentAddress = addr;
  const sats = sysToSatsString((form.paymentAmount || '').trim());
  if (sats !== null) out.paymentAmountSats = sats;
  const count = Number(form.paymentCount);
  if (Number.isInteger(count) && count >= 1) out.paymentCount = count;
  const start = Number(form.startEpoch);
  if (Number.isInteger(start) && start > 0) out.startEpoch = start;
  const end = Number(form.endEpoch);
  if (Number.isInteger(end) && end > 0) out.endEpoch = end;
  return out;
}

// Body builder for /prepare. Unlike the draft body, this MUST include
// every field because the backend canonicalises and hashes the whole
// record — missing fields become hash-busting validation errors, not
// "use the default" helpers.
export function prepareBodyFromForm(form, { draftId, consumeDraft } = {}) {
  const body = draftBodyFromForm(form);
  if (Number.isInteger(draftId) && draftId > 0) {
    body.draftId = draftId;
    body.consumeDraft = consumeDraft !== false;
  }
  return body;
}
