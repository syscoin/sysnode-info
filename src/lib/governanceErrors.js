// Governance-surface error descriptors — central source of truth for
// "what does the user see when code X comes back?".
//
// Two surfaces consume this:
//
//  * PHASE.ERROR on the vote modal, when a whole-batch submit
//    throws. Typically a server-side or transport-level error
//    (rate_limited, server_error, network_error, auth, csrf).
//
//  * DONE view per-row, when individual voteraw calls rejected
//    inside an otherwise-successful batch (signature_invalid,
//    mn_not_found, vote_too_often, already_voted, ...).
//
// Both paths want the same vocabulary — the distinction between
// "batch error" and "per-row error" is purely about which side of
// the request surfaced the problem. Keeping the descriptors in one
// place means adding a new code only requires one edit.
//
// Each descriptor can carry:
//
//   short         — One-line label fit for a chip or row status.
//                   Never more than ~6 words.
//   long          — Paragraph-level explanation for the ERROR body
//                   or an expanded per-row detail. May repeat the
//                   `short` to keep copy consistent.
//   severity      — 'info' | 'warn' | 'error'. Drives tone, not
//                   behaviour. 'info' is used for dedup/no-op
//                   outcomes ('already_voted') that aren't really
//                   failures.
//   cta           — Optional { label, href?, kind? } that renders
//                   a secondary action. `href` makes it a Link;
//                   without it the consumer can wire its own
//                   onClick (e.g. refresh).
//   autoRetry     — { delayMs, maxAttempts } when the modal should
//                   attempt another submit without user input.
//                   Used for transient server errors only.
//   respectsRetryAfter — true when an explicit retry-after time
//                   from the transport (HTTP 429) should override
//                   autoRetry.delayMs. Decoupled so we can evolve
//                   the two independently.
//
// Anything a caller reads beyond these fields should be guarded
// against shape changes.

export const SEVERITY = Object.freeze({
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
});

// Canonical map. Keys are backend-emitted codes (or client-side
// analogues surfaced by governanceService.js). Order is by
// severity-then-alphabetical to keep this file scan-friendly.
const DESCRIPTORS = Object.freeze({
  // -------------------------------------------------- info ("not really a problem")
  already_voted: {
    short: 'Already submitted',
    long:
      'This masternode already voted on this proposal. No change was ' +
      'made — the on-chain record still reflects your prior vote.',
    severity: SEVERITY.INFO,
  },

  // -------------------------------------------------- warn ("actionable but not broken")
  mn_not_found: {
    short: 'Masternode no longer active',
    long:
      'This masternode is no longer active on-chain (deregistered or ' +
      'collateral moved). Update the voting key associations in ' +
      'Account to remove stale entries.',
    severity: SEVERITY.WARN,
    cta: {
      label: 'Go to Account',
      href: '/account',
      kind: 'link',
    },
  },
  signature_invalid: {
    short: 'Signature rejected',
    long:
      'The network rejected the signature — the voting key in your ' +
      'vault does not match the voting address this masternode ' +
      'expects. Re-import the correct voting key on the Account page.',
    severity: SEVERITY.WARN,
    cta: {
      label: 'Review voting keys',
      href: '/account',
      kind: 'link',
    },
  },
  signature_malformed: {
    short: 'Signature malformed',
    long:
      'The signature did not parse. This is almost always a transient ' +
      'client-side issue — retrying usually fixes it.',
    severity: SEVERITY.WARN,
  },
  vote_too_often: {
    short: 'Vote in cooldown',
    long:
      'The network recently accepted a vote from this masternode on ' +
      'this proposal and is enforcing a per-MN cooldown. Use Retry ' +
      "failed once the cooldown clears — the server won't relay " +
      'duplicates, so clicking again is safe.',
    severity: SEVERITY.WARN,
  },
  proposal_not_found: {
    short: 'Proposal not found',
    long:
      'The proposal is no longer available on-chain — it may have ' +
      'expired or been replaced. Reload the Governance page to see ' +
      'the current proposal list.',
    severity: SEVERITY.WARN,
    cta: { label: 'Reload proposals', kind: 'refresh' },
  },

  // -------------------------------------------------- error ("we could not submit")
  // CSRF family: the backend emits either `csrf_missing` (the SPA
  // forgot to echo the X-CSRF-Token header from the csrf cookie) or
  // `csrf_mismatch` (the header/cookie pair don't match — usually
  // because the session was rotated/expired behind the user's back).
  // Both resolve to the same "session expired, log in again" user
  // story; see ALIASES below for the remap. `csrf` is kept as an
  // alias target so additional legacy consumers that happen to
  // surface the bare `csrf` code render consistent copy.
  csrf: {
    short: 'Session expired',
    long:
      'Your session expired while you were voting. Log in again and ' +
      'retry — your selections will be preserved in this modal.',
    severity: SEVERITY.ERROR,
    cta: { label: 'Log in again', href: '/login', kind: 'link' },
  },
  invalid_vote_signal: {
    short: 'Vote shape rejected',
    long:
      'The server rejected the vote shape. Refresh and try again; if ' +
      'this keeps happening, the client may be out of sync with the ' +
      'backend — a browser reload picks up the fix.',
    severity: SEVERITY.ERROR,
  },
  invalid_vote_outcome: {
    short: 'Vote shape rejected',
    long:
      'The server rejected the vote shape. Refresh and try again; if ' +
      'this keeps happening, the client may be out of sync with the ' +
      'backend — a browser reload picks up the fix.',
    severity: SEVERITY.ERROR,
  },
  network_error: {
    short: "Couldn't reach the server",
    long:
      "We couldn't reach the sysnode server. Check your connection " +
      'and retry — your selections stay as you left them.',
    severity: SEVERITY.ERROR,
  },
  rate_limited: {
    short: 'Too many votes',
    long:
      "You've submitted a lot of votes recently. The server is " +
      'temporarily throttling the rate — wait for the countdown to ' +
      'finish, then click Try again.',
    severity: SEVERITY.ERROR,
    // retry-after from the server (Retry-After header) is the
    // authoritative delay; without one we fall back to a minute.
    respectsRetryAfter: true,
    autoRetry: null,
  },
  server_error: {
    short: 'Server error',
    long:
      'The sysnode server returned an error. This is almost always ' +
      'transient; we will retry automatically in a few seconds.',
    severity: SEVERITY.ERROR,
    autoRetry: { delayMs: 3 * 1000, maxAttempts: 2 },
  },
  offline: {
    short: "You're offline",
    long:
      'Your browser reports that you are offline. Your vote ' +
      'selections have been saved locally — we will resubmit them ' +
      'automatically once the connection comes back.',
    severity: SEVERITY.WARN,
  },
  submit_failed: {
    short: 'Submit failed',
    long:
      'The batch submission failed for an unexpected reason. You can ' +
      'retry safely — votes we already accepted will short-circuit ' +
      "on the server and won't double-count.",
    severity: SEVERITY.ERROR,
  },
  sign_failed: {
    short: 'Signing failed',
    long:
      "We couldn't sign this vote with the key on file. Verify the " +
      'voting key in Account matches what this masternode expects.',
    severity: SEVERITY.ERROR,
    cta: { label: 'Review voting keys', href: '/account', kind: 'link' },
  },
});

const FALLBACK = Object.freeze({
  short: 'Vote failed',
  long:
    'The vote could not be submitted. Try again — if the problem ' +
    'persists, refresh the page.',
  severity: SEVERITY.ERROR,
});

// Backend-code → descriptor-key aliases. The source codes on the
// left are emitted verbatim by the sysnode-backend middleware (see
// middleware/csrf.js); the right-hand side is the canonical
// descriptor key used by the UI. Keep this map small — we only add
// an alias when the backend legitimately emits a distinct code that
// maps to identical user-visible copy.
const ALIASES = Object.freeze({
  csrf_missing: 'csrf',
  csrf_mismatch: 'csrf',
});

// Resolve a code to its descriptor. Unknown codes fall back to a
// generic failure descriptor so UI code can always render *something*
// without a null-check.
export function describeError(code) {
  if (!code || typeof code !== 'string') return FALLBACK;
  const resolved = ALIASES[code] || code;
  const hit = DESCRIPTORS[resolved];
  if (hit) return hit;
  return { ...FALLBACK, short: `Vote failed (${code})` };
}

// Convenience: just the short label for a code. Callers that still
// speak in strings (the old errorCopy()) can drop into this without
// unpacking the descriptor.
export function errorLabel(code) {
  return describeError(code).short;
}

// True when the descriptor indicates success-in-disguise — the
// network already had the vote and the relay is a no-op. The DONE
// view uses this to render a green ticked row with deduped copy
// instead of treating it as a failure in the tally.
export function isBenignDup(code) {
  return describeError(code).severity === SEVERITY.INFO;
}
