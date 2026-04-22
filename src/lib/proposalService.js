import { apiClient as defaultClient } from './apiClient';

// Thin transport layer for the `/gov/proposals/*` endpoints — the
// authenticated governance-proposal creation surface introduced in
// PR 8. Pairs with sysnode-backend/routes/govProposals.js.
//
// Backend contract (abbreviated — see backend route file for full shape):
//
//   POST   /gov/proposals/drafts                  auth+csrf   -> { draft }
//   GET    /gov/proposals/drafts                  auth        -> { drafts }
//   GET    /gov/proposals/drafts/:id              auth        -> { draft }
//   PATCH  /gov/proposals/drafts/:id              auth+csrf   -> { draft }
//   DELETE /gov/proposals/drafts/:id              auth+csrf   -> 204
//
//   POST   /gov/proposals/prepare                 auth+csrf   ->
//     { submission, opReturnHex, canonicalJson, payloadBytes,
//       collateralFeeSats, requiredConfirmations }
//     Idempotent on (userId, proposalHash) — a duplicate prepare
//     returns the original `submission` with 200 (not 201).
//
//   GET    /gov/proposals/submissions             auth        -> { submissions }
//   GET    /gov/proposals/submissions/:id         auth        -> { submission }
//   POST   /gov/proposals/submissions/:id/attach-collateral
//                                                  auth+csrf  -> { submission }
//   DELETE /gov/proposals/submissions/:id         auth+csrf   -> 204
//
// All endpoints return backend-normalised `{ error: <code> }` on 4xx.
// apiClient already unwraps those into a typed Error; we layer a
// narrow validate step on top so handwritten backend-response drift
// (e.g. forgetting to wrap in { submission: ... }) fails loudly in
// tests rather than silently rendering `undefined` fields.

const BASE = '/gov/proposals';

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

// Stable error code so UI can switch on it without regex-matching the
// thrown Error's message across languages. Backend codes (e.g.
// `validation_failed`, `submission_exists`, `draft_not_found`) pass
// through unchanged.
function proposalError(code, status, cause) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  if (cause) {
    e.cause = cause;
    // Preserve rate-limit / Retry-After hints the apiClient attached.
    if (typeof cause.retryAfterMs === 'number') {
      e.retryAfterMs = cause.retryAfterMs;
    }
    // Preserve server-side validation details when present — the
    // wizard surfaces per-field errors from `details`.
    if (cause.details) e.details = cause.details;
  }
  return e;
}

function assertShape(name, obj) {
  if (!obj || typeof obj !== 'object') {
    throw proposalError('invalid_response', 0, {
      message: `${name}: backend returned ${typeof obj}`,
    });
  }
  return obj;
}

// --- Public API ----------------------------------------------------------

export function createProposalService({ client = defaultClient } = {}) {
  async function createDraft(body) {
    try {
      const res = await client.post(`${BASE}/drafts`, body || {});
      return assertShape('createDraft', res.data).draft;
    } catch (err) {
      throw proposalError(err.code || 'create_draft_failed', err.status, err);
    }
  }

  async function listDrafts() {
    try {
      const res = await client.get(`${BASE}/drafts`);
      return assertShape('listDrafts', res.data).drafts || [];
    } catch (err) {
      throw proposalError(err.code || 'list_drafts_failed', err.status, err);
    }
  }

  async function getDraft(id) {
    if (!Number.isInteger(id) || id <= 0) {
      throw proposalError('invalid_id', 0);
    }
    try {
      const res = await client.get(`${BASE}/drafts/${id}`);
      return assertShape('getDraft', res.data).draft;
    } catch (err) {
      throw proposalError(err.code || 'get_draft_failed', err.status, err);
    }
  }

  async function updateDraft(id, patch) {
    if (!Number.isInteger(id) || id <= 0) {
      throw proposalError('invalid_id', 0);
    }
    try {
      const res = await client.patch(`${BASE}/drafts/${id}`, patch || {});
      return assertShape('updateDraft', res.data).draft;
    } catch (err) {
      throw proposalError(err.code || 'update_draft_failed', err.status, err);
    }
  }

  async function deleteDraft(id) {
    if (!Number.isInteger(id) || id <= 0) {
      throw proposalError('invalid_id', 0);
    }
    try {
      await client.delete(`${BASE}/drafts/${id}`);
    } catch (err) {
      throw proposalError(err.code || 'delete_draft_failed', err.status, err);
    }
  }

  // `body` mirrors the draft shape + an optional `draftId` which, when
  // supplied, atomically deletes that draft after the submission is
  // persisted. Returns the full prepare envelope — the caller needs
  // `opReturnHex` for the OP_RETURN output and `collateralFeeSats` +
  // `requiredConfirmations` for the UI copy.
  async function prepare(body) {
    try {
      const res = await client.post(`${BASE}/prepare`, body || {});
      const data = assertShape('prepare', res.data);
      if (!data.submission) {
        throw proposalError('invalid_response', res.status || 0, {
          message: 'prepare: missing submission in response',
        });
      }
      if (typeof data.opReturnHex !== 'string' || !/^[0-9a-f]+$/i.test(data.opReturnHex)) {
        throw proposalError('invalid_response', res.status || 0, {
          message: 'prepare: opReturnHex missing or not hex',
        });
      }
      return data;
    } catch (err) {
      // Already-typed errors from above pass through.
      if (err.code && err.code !== 'http_error') throw err;
      throw proposalError(err.code || 'prepare_failed', err.status, err);
    }
  }

  async function listSubmissions() {
    try {
      const res = await client.get(`${BASE}/submissions`);
      return assertShape('listSubmissions', res.data).submissions || [];
    } catch (err) {
      throw proposalError(
        err.code || 'list_submissions_failed',
        err.status,
        err
      );
    }
  }

  async function getSubmission(id) {
    if (!Number.isInteger(id) || id <= 0) {
      throw proposalError('invalid_id', 0);
    }
    try {
      const res = await client.get(`${BASE}/submissions/${id}`);
      return assertShape('getSubmission', res.data).submission;
    } catch (err) {
      throw proposalError(err.code || 'get_submission_failed', err.status, err);
    }
  }

  // Build an unsigned collateral PSBT for Pali to sign. The caller
  // (paliProvider.payProposalCollateralWithPali) harvested `xpub` and
  // `changeAddress` from the injected provider; we pass them straight
  // through. `feeRate` is a sat/vByte integer or omitted (server
  // defaults to 10 and clamps to 1..1000).
  //
  // Returns `{ psbt: { psbt, assets }, feeSats, opReturnHex,
  // collateralFeeSats, networkKey }`. The `psbt` sub-object is the
  // envelope Pali's `sys_signAndSend` consumes verbatim.
  async function buildCollateralPsbt(id, { xpub, changeAddress, feeRate } = {}) {
    if (!Number.isInteger(id) || id <= 0) {
      throw proposalError('invalid_id', 0);
    }
    if (typeof xpub !== 'string' || !xpub) {
      throw proposalError('bad_xpub', 0);
    }
    if (typeof changeAddress !== 'string' || !changeAddress) {
      throw proposalError('bad_change_address', 0);
    }
    try {
      const res = await client.post(
        `${BASE}/submissions/${id}/collateral/psbt`,
        {
          xpub,
          changeAddress,
          ...(feeRate != null ? { feeRate } : {}),
        }
      );
      const data = assertShape('buildCollateralPsbt', res.data);
      if (
        !data.psbt ||
        typeof data.psbt.psbt !== 'string' ||
        !data.psbt.psbt
      ) {
        throw proposalError('invalid_response', res.status || 0, {
          message: 'buildCollateralPsbt: missing psbt.psbt in response',
        });
      }
      return data;
    } catch (err) {
      if (err && err.code && err.code !== 'http_error') throw err;
      throw proposalError(
        err.code || 'build_collateral_psbt_failed',
        err.status,
        err
      );
    }
  }

  // Describe the chain this backend is pinned to. FE uses this to
  // feature-detect the Pali path (paliPathEnabled=false → hide
  // button) and to pick the "Switch Pali to Syscoin mainnet / testnet"
  // copy when Pali is on the wrong chain.
  async function getGovernanceNetwork() {
    try {
      const res = await client.get(`${BASE}/network`);
      const data = assertShape('getGovernanceNetwork', res.data);
      // `paliPathReason` only appears when the path is disabled;
      // passed through untouched so the UI can pick specific copy
      // for pali_path_rpc_down vs pali_path_chain_mismatch vs the
      // default "not configured" fallback.
      const paliPathReason =
        !data.paliPathEnabled && typeof data.paliPathReason === 'string'
          ? data.paliPathReason
          : null;
      return {
        chain: typeof data.chain === 'string' ? data.chain : 'unknown',
        slip44: Number.isInteger(data.slip44) ? data.slip44 : null,
        networkKey:
          data.networkKey === 'mainnet' || data.networkKey === 'testnet'
            ? data.networkKey
            : null,
        paliPathEnabled: !!data.paliPathEnabled,
        paliPathReason,
      };
    } catch (err) {
      throw proposalError(
        err.code || 'get_network_failed',
        err.status,
        err
      );
    }
  }

  async function attachCollateral(id, collateralTxid) {
    if (!Number.isInteger(id) || id <= 0) {
      throw proposalError('invalid_id', 0);
    }
    if (typeof collateralTxid !== 'string' || !HEX64_RE.test(collateralTxid)) {
      // Short-circuit: don't round-trip an obviously-malformed txid.
      // 64-hex is the only shape Core produces; anything else is a
      // user copy-paste mistake we catch earlier and louder here.
      throw proposalError('malformed_txid', 0);
    }
    try {
      const res = await client.post(
        `${BASE}/submissions/${id}/attach-collateral`,
        { collateralTxid }
      );
      return assertShape('attachCollateral', res.data).submission;
    } catch (err) {
      throw proposalError(
        err.code || 'attach_collateral_failed',
        err.status,
        err
      );
    }
  }

  async function deleteSubmission(id) {
    if (!Number.isInteger(id) || id <= 0) {
      throw proposalError('invalid_id', 0);
    }
    try {
      await client.delete(`${BASE}/submissions/${id}`);
    } catch (err) {
      throw proposalError(
        err.code || 'delete_submission_failed',
        err.status,
        err
      );
    }
  }

  return {
    createDraft,
    listDrafts,
    getDraft,
    updateDraft,
    deleteDraft,
    prepare,
    listSubmissions,
    getSubmission,
    attachCollateral,
    deleteSubmission,
    buildCollateralPsbt,
    getGovernanceNetwork,
  };
}

export const proposalService = createProposalService();

// Exported for tests. Keeping the helpers off the default export
// reduces the component-facing surface; only the service factory is
// meant to be consumed by pages.
export { HEX64_RE, proposalError };
