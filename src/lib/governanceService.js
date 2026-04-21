import { apiClient as defaultClient } from './apiClient';

// Thin transport layer for the `/gov/*` endpoints — the authenticated
// governance surface that pairs with the client-side voteSigner.
//
// Backend contract (from sysnode-backend/routes/gov.js):
//
//   POST /gov/mns/lookup   auth+csrf
//     body : { votingAddresses: string[] }
//     200  : { matches: [{
//               votingaddress, proTxHash,
//               collateralHash, collateralIndex,
//               status, address, payee,
//             }, ...] }
//
//   POST /gov/vote          auth+csrf+rate-limit
//     body : {
//       proposalHash: 64-hex,
//       voteOutcome:  "yes" | "no" | "abstain",
//       voteSignal:   "funding",
//       time:         unix-seconds,
//       entries: [{ collateralHash, collateralIndex, voteSig }]
//     }
//     200  : { accepted, rejected, results: [{
//               collateralHash, collateralIndex, ok, error?, skipped?
//             }] }
//
//   GET /gov/receipts       auth
//     query: ?proposalHash=<64-hex>
//     PURE READ — no RPC, no DB writes, no reconciliation.
//     200  : { receipts: [{
//               collateralHash, collateralIndex,
//               proposalHash, voteOutcome, voteSignal, voteTime,
//               status, lastError, submittedAt, verifiedAt,
//             }, ...],
//             reconciled: false,  // always false on GET
//           }
//
//   POST /gov/receipts/reconcile   auth+csrf
//     body : { proposalHash: 64-hex, refresh?: boolean }
//     State-changing: may update receipt status + verified_at and
//     may issue `gobject_getcurrentvotes`. Split off GET so the
//     read path stays side-effect-free (CSRF-exempt).
//     200  : { receipts: [...],
//             reconciled: boolean,
//             reconcileError?: 'rpc_failed' | 'reconcile_failed',
//             updated?: number,
//           }
//
//   GET /gov/receipts/summary   auth
//     200 : { summary: [{
//              proposalHash, total,
//              relayed, confirmed, stale, failed,
//              confirmedYes, confirmedNo, confirmedAbstain,
//              latestSubmittedAt, latestVerifiedAt,
//            }, ...] }
//
// All endpoints return backend-normalised `{ error: <code> }` on 4xx.
// We re-throw a typed Error(code) so UI components can switch on a
// stable vocabulary without inspecting HTTP statuses.

const LOOKUP_PATH = '/gov/mns/lookup';
const VOTE_PATH = '/gov/vote';
const RECEIPTS_PATH = '/gov/receipts';
const RECEIPTS_RECONCILE_PATH = '/gov/receipts/reconcile';
const RECEIPTS_SUMMARY_PATH = '/gov/receipts/summary';
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

function govError(code, status, cause) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  if (cause) e.cause = cause;
  return e;
}

export function createGovernanceService(client = defaultClient) {
  async function lookupOwnedMasternodes(votingAddresses) {
    if (!Array.isArray(votingAddresses)) {
      throw govError('invalid_request', 0);
    }
    // The server caps this at 512 addresses; surface early so we
    // don't waste a round-trip when the vault holds more keys than
    // the backend will accept in one lookup.
    if (votingAddresses.length > 512) {
      throw govError('too_many_addresses', 0);
    }
    try {
      const res = await client.post(LOOKUP_PATH, { votingAddresses });
      const matches = Array.isArray(res.data && res.data.matches)
        ? res.data.matches
        : [];
      return matches;
    } catch (err) {
      if (err && err.code) throw err;
      throw govError('network_error', 0, err);
    }
  }

  // Submit a batch of per-MN signed votes for one proposal. The
  // backend validates request shape, then fans out `voteraw` RPC
  // calls with bounded concurrency. A per-entry `ok: false` does NOT
  // fail the whole request: the promise resolves with a full
  // `results` array so the UI can render per-row success/error.
  //
  // Throws only on:
  //   - request-shape validation failures (400)
  //   - rate-limiter (429)
  //   - auth loss (401 is propagated to the shared AuthContext
  //     handler through the apiClient interceptor)
  //   - network / 5xx errors
  async function submitVote({
    proposalHash,
    voteOutcome,
    voteSignal,
    time,
    entries,
  }) {
    if (typeof proposalHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(proposalHash)) {
      throw govError('invalid_proposal_hash', 0);
    }
    if (!['yes', 'no', 'abstain'].includes(voteOutcome)) {
      throw govError('invalid_vote_outcome', 0);
    }
    // Client-side restriction mirrors the backend's PR5 funding-only
    // scope. Extending this requires operator-BLS custody, not just
    // a frontend toggle.
    if (voteSignal !== 'funding') {
      throw govError('unsupported_vote_signal', 0);
    }
    if (!Number.isInteger(time) || time < 0) {
      throw govError('invalid_time', 0);
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw govError('no_entries', 0);
    }
    try {
      const res = await client.post(VOTE_PATH, {
        proposalHash,
        voteOutcome,
        voteSignal,
        time,
        entries,
      });
      const data = res.data || {};
      return {
        accepted: Number.isInteger(data.accepted) ? data.accepted : 0,
        rejected: Number.isInteger(data.rejected) ? data.rejected : 0,
        results: Array.isArray(data.results) ? data.results : [],
      };
    } catch (err) {
      if (!err || !err.code) {
        throw govError('network_error', 0, err);
      }
      // Map a handful of common backend codes to UI-stable aliases.
      // Everything else is passed through verbatim so exhaustive
      // UI error tables don't need periodic re-syncing.
      switch (err.code) {
        case 'too_many_vote_requests':
          throw govError('rate_limited', err.status, err);
        case 'unsupported_vote_signal':
        case 'invalid_vote_outcome':
        case 'invalid_proposal_hash':
        case 'no_entries':
        case 'too_many_entries':
        case 'time_in_future':
        case 'time_too_old':
          throw err; // already canonical
        default:
          throw err;
      }
    }
  }

  // Fetch the caller's stored vote receipts for a single proposal.
  //
  // PURE READ: this hits the side-effect-free GET /gov/receipts path.
  // The backend returns the last known DB state without contacting
  // Syscoin Core and without writing receipt bookkeeping. Use this
  // for cheap cohort-aware UI (chips, summaries, prefetch) that
  // does NOT need up-to-the-moment chain confirmation.
  //
  // If you need the rows reconciled against
  // `gobject_getcurrentvotes` (e.g. immediately after a relay, or
  // when opening the vote modal), use `reconcileReceipts` below —
  // that call is CSRF-protected so the GET path can stay safe to
  // invoke from any context without amplifying RPC traffic.
  //
  // Returned shape mirrors `reconcileReceipts` for consumer
  // compatibility: `reconciled` is always false on this path and
  // `reconcileError` / `updated` default to null / 0.
  async function fetchReceipts(proposalHash) {
    if (typeof proposalHash !== 'string' || !HEX64_RE.test(proposalHash)) {
      throw govError('invalid_proposal_hash', 0);
    }
    try {
      const res = await client.get(RECEIPTS_PATH, {
        params: { proposalHash },
      });
      const data = res.data || {};
      return {
        receipts: Array.isArray(data.receipts) ? data.receipts : [],
        reconciled: Boolean(data.reconciled),
        reconcileError:
          typeof data.reconcileError === 'string'
            ? data.reconcileError
            : null,
        updated: Number.isInteger(data.updated) ? data.updated : 0,
      };
    } catch (err) {
      if (err && err.code) throw err;
      throw govError('network_error', 0, err);
    }
  }

  // Reconcile the caller's stored receipts against the chain before
  // returning them. POSTs to /gov/receipts/reconcile; the backend
  // runs `gobject_getcurrentvotes`, flips any matching receipts to
  // 'confirmed' with a fresh `verified_at`, and marks beyond-grace
  // relayed rows as 'stale'. State-changing, so this call goes
  // through the apiClient's CSRF interceptor.
  //
  // Pass `{ refresh: true }` to force a reconcile even if every
  // receipt is already confirmed within the backend freshness
  // window (default 2 min). Without `refresh`, repeated calls
  // inside that window short-circuit with the existing DB state
  // (`reconciled: false`) so polling stays cheap.
  //
  // A transient `reconcileError` ('rpc_failed' | 'reconcile_failed')
  // surfaces when reconciliation itself failed; `receipts` is the
  // pre-reconcile DB state so the UI can render what it has and
  // show a soft warning instead of blocking the user.
  async function reconcileReceipts(proposalHash, { refresh = false } = {}) {
    if (typeof proposalHash !== 'string' || !HEX64_RE.test(proposalHash)) {
      throw govError('invalid_proposal_hash', 0);
    }
    try {
      const res = await client.post(RECEIPTS_RECONCILE_PATH, {
        proposalHash,
        refresh: Boolean(refresh),
      });
      const data = res.data || {};
      return {
        receipts: Array.isArray(data.receipts) ? data.receipts : [],
        reconciled: Boolean(data.reconciled),
        reconcileError:
          typeof data.reconcileError === 'string'
            ? data.reconcileError
            : null,
        updated: Number.isInteger(data.updated) ? data.updated : 0,
      };
    } catch (err) {
      if (err && err.code) throw err;
      throw govError('network_error', 0, err);
    }
  }

  // Compact per-proposal rollup of the caller's receipts. Cheap enough
  // to call on every Governance page load — no RPC, one grouped
  // SELECT. Use this to drive cohort-aware badges without fetching
  // the full receipt list for every proposal upfront.
  async function fetchReceiptsSummary() {
    try {
      const res = await client.get(RECEIPTS_SUMMARY_PATH);
      const data = res.data || {};
      return {
        summary: Array.isArray(data.summary) ? data.summary : [],
      };
    } catch (err) {
      if (err && err.code) throw err;
      throw govError('network_error', 0, err);
    }
  }

  return {
    lookupOwnedMasternodes,
    submitVote,
    fetchReceipts,
    reconcileReceipts,
    fetchReceiptsSummary,
  };
}

export const governanceService = createGovernanceService();
