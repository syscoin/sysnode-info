// Pali Wallet (Syscoin) dApp provider abstraction.
//
// Pali exposes two objects on the page after its content script
// injects:
//
//   window.pali         -> PaliInpageProviderSys  (UTXO / syscoin-js)
//   window.ethereum     -> PaliInpageProviderEth  (EVM, not used here)
//
// Both speak EIP-1193 `request({ method, params })`. For the proposal
// flow we care about:
//
//   - detection
//   - account unlock status
//   - current account / xpub (for "connected as ...")
//   - block-explorer url (so users can verify our link trust)
//   - switching the active chain to a user-selected one (mainnet
//     typically) so a draft built against mainnet doesn't get sent
//     from a testnet account by accident
//
// What this module DOES NOT do: build or sign a PSBT. Pali's
// `sys_signAndSend` needs a fully-formed PSBT in Pali's JSON shape,
// which requires `syscoinjs-lib` on the dApp side (not trivial, and
// a live interop test against the extension is mandatory before
// shipping — see the PR description for why this is a deferred
// followup). Calling `payWithOpReturn` returns a "not_supported"
// error on purpose, so the UI can fall back to the manual-collateral
// flow without ever appearing to have succeeded.
//
// All public functions are safe to call in an SSR / test environment:
// they guard against `window` being undefined.

const NOT_SUPPORTED = 'pali_psbt_builder_not_wired';

function readPali() {
  if (typeof window === 'undefined') return null;
  const p = window.pali;
  if (!p || typeof p !== 'object') return null;
  if (typeof p.request !== 'function') return null;
  return p;
}

// Public: fast boolean used by the wizard's "Pay via Pali" button
// visibility and by the Governance page entry CTA.
export function isPaliAvailable() {
  return readPali() != null;
}

// Public: a stable handle to the provider. Exposed so the wizard can
// register event listeners (chainChanged, accountsChanged) without
// reaching into window.* from multiple call sites.
export function getPali() {
  return readPali();
}

// Best-effort request wrapper. Pali throws EIP-1193-style errors with
// a `code` (e.g. 4001 = user rejection, 4100 = unauthorized, 4900 =
// disconnected). We normalize to a stable string code to match the
// rest of the codebase's `err.code` convention.
//
// Mapping:
//   no provider            -> 'pali_unavailable'
//   EIP-1193 code 4001     -> 'user_rejected'
//   EIP-1193 code 4100     -> 'unauthorized'
//   EIP-1193 code 4200     -> 'method_not_supported'
//   EIP-1193 code 4900     -> 'disconnected'
//   EIP-1193 code 4901     -> 'chain_disconnected'
//   anything else          -> original message if present, else 'pali_request_failed'
//
// We preserve the original error on `.cause` so callers can inspect
// the raw shape when debugging edge cases.
export async function paliRequest(method, params) {
  const p = readPali();
  if (!p) {
    const e = new Error('pali_unavailable');
    e.code = 'pali_unavailable';
    throw e;
  }
  try {
    return await p.request(
      params === undefined ? { method } : { method, params }
    );
  } catch (err) {
    const translated = translatePaliError(err);
    throw translated;
  }
}

function translatePaliError(err) {
  if (!err || typeof err !== 'object') {
    const e = new Error('pali_request_failed');
    e.code = 'pali_request_failed';
    e.cause = err;
    return e;
  }
  const eip1193 = typeof err.code === 'number' ? err.code : null;
  const map = {
    4001: 'user_rejected',
    4100: 'unauthorized',
    4200: 'method_not_supported',
    4900: 'disconnected',
    4901: 'chain_disconnected',
  };
  const code = (eip1193 && map[eip1193]) || err.code || 'pali_request_failed';
  const out = new Error(typeof code === 'string' ? code : String(code));
  out.code = typeof code === 'string' ? code : String(code);
  out.cause = err;
  if (eip1193 != null) out.rpcCode = eip1193;
  if (typeof err.message === 'string' && err.message) {
    out.message = err.message;
  }
  return out;
}

// Public: request account connection. Returns an array of addresses.
// On Pali this is typically a single entry — the currently active
// UTXO account — but we pass the raw array through so callers can
// handle multi-account futures without changing the interface.
export async function requestAccounts() {
  return paliRequest('sys_requestAccounts');
}

// Public: read the currently-connected chain without prompting. Used
// by the wizard to warn users who are on the wrong network ("this
// draft is mainnet, your wallet is on testnet").
export async function getChainId() {
  // Pali's Syscoin provider exposes this as a property on the object
  // rather than a method call, but the spec-y way is also supported.
  const p = readPali();
  if (!p) {
    const e = new Error('pali_unavailable');
    e.code = 'pali_unavailable';
    throw e;
  }
  if (typeof p.chainId === 'string' && p.chainId.length > 0) {
    return p.chainId;
  }
  return paliRequest('eth_chainId');
}

// Public: prompt Pali to switch to a target chain id. Syscoin mainnet
// is 0x39 (57 decimal). The method name is deliberately the same as
// the EIP-3326 EVM path so Pali's internal routing keeps working.
export async function switchChain(chainIdHex) {
  if (typeof chainIdHex !== 'string' || !/^0x[0-9a-f]+$/i.test(chainIdHex)) {
    const e = new Error('invalid_chain_id');
    e.code = 'invalid_chain_id';
    throw e;
  }
  return paliRequest('wallet_switchEthereumChain', [{ chainId: chainIdHex }]);
}

// Public (stub): pay `valueSats` to `to` with an extra OP_RETURN output
// carrying `opReturnHex` (no "6a" length prefix — caller provides the
// raw pushed bytes). Returns a txid.
//
// This is where a future PR will call `sys_signAndSend` with a fully
// constructed PSBT. For now we fail loudly with a stable error code
// the UI can switch on to render the manual-payment fallback. The
// function exists at all (rather than being absent) so the UI can
// feature-detect with a clean try/catch instead of peeking at module
// internals.
export async function payWithOpReturn(/* { to, valueSats, opReturnHex, feeRate } */) {
  const e = new Error(NOT_SUPPORTED);
  e.code = NOT_SUPPORTED;
  throw e;
}

// Exposed for tests.
export const __internal = { translatePaliError, NOT_SUPPORTED };
