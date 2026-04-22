// Pali Wallet (Syscoin) dApp provider abstraction.
//
// Pali exposes two objects on the page after its content script
// injects:
//
//   window.pali         -> PaliInpageProviderSys  (UTXO / syscoin-js)
//   window.ethereum     -> PaliInpageProviderEth  (EVM, not used here)
//
// Both speak EIP-1193 `request({ method, params })`. For the proposal
// flow we consume four UTXO methods:
//
//   sys_requestAccounts     -> ["<address>"]  (connect prompt)
//   sys_getPublicKey        -> zpub / vpub string
//   sys_getChangeAddress    -> "<bech32 change address>"
//   sys_signAndSend         -> { txid: "<64-hex>" } or "<64-hex>"
//
// PSBT BUILDING LIVES ON THE SERVER. syscoinjs-lib has a Node-first
// require graph (bip174, bitcoinjs, buffer polyfills) that bloats a
// CRA bundle by >200KB and depends on Node globals that don't exist
// in the browser. The flow instead is:
//
//   1. We collect xpub + change address from Pali.
//   2. We POST them to the backend, which builds an unsigned PSBT
//      committing 150 SYS to an OP_RETURN output (the proposal-hash
//      push Syscoin Core requires).
//   3. We hand the PSBT envelope to Pali's `sys_signAndSend`. The
//      extension prompts the user to confirm, signs, and broadcasts.
//   4. The returned txid goes back to the backend's
//      /attach-collateral route, and the existing dispatcher takes
//      over from there.
//
// All public functions are safe to call in an SSR / test environment:
// they guard against `window` being undefined.

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

// Internal: accept whatever shape Pali's `sys_signAndSend` returns and
// distill it down to a 64-hex txid. Historically Pali has shipped:
//   - '<txid>'                                    (bare string)
//   - { txid: '<txid>' }
//   - { transactionId: '<txid>' }
//   - { hex: '<rawtx>', txid: '<txid>' }          (old versions)
// Anything we can't translate throws `bad_signer_response` so the
// caller renders an explicit error rather than persisting a truncated
// or stringified-object value as the collateral txid (which would
// land on the dispatcher as an opaque "getRawTransaction failed"
// loop).
function normalizeSignAndSendResult(result) {
  const hex64 = /^[0-9a-fA-F]{64}$/;
  const candidate =
    typeof result === 'string'
      ? result.trim()
      : result && typeof result === 'object'
      ? typeof result.txid === 'string'
        ? result.txid.trim()
        : typeof result.transactionId === 'string'
        ? result.transactionId.trim()
        : ''
      : '';
  if (!hex64.test(candidate)) {
    const e = new Error('bad_signer_response');
    e.code = 'bad_signer_response';
    e.raw = result;
    throw e;
  }
  return candidate.toLowerCase();
}

// Compare the chainId Pali reports against the network the backend is
// pinned to. Keeps the "switch Pali to Syscoin mainnet" copy in the
// wizard short, one-shot, and correct.
//
// Syscoin's canonical chainIds:
//   mainnet (UTXO) : '0x39'  (57 decimal)
//   testnet (UTXO) : '0x40'  (64 decimal)
//   mainnet (NEVM) : '0x39'  (57) — same as UTXO, but a different provider
//   testnet (NEVM) : '0xcc'  (204) — again, different provider
//
// We only care about the UTXO side because `window.pali` IS the UTXO
// provider. Any answer outside {'0x39','0x40'} means Pali is in
// EVM-provider mode or on a non-Syscoin chain; the caller surfaces
// that as `network_mismatch` with the target copy derived from the
// server's networkKey.
function chainIdMatchesServer(paliChainId, serverNetworkKey) {
  if (typeof paliChainId !== 'string') return false;
  const norm = paliChainId.toLowerCase();
  if (serverNetworkKey === 'mainnet') return norm === '0x39';
  if (serverNetworkKey === 'testnet') return norm === '0x40';
  return false;
}

// Public: run the full Pali collateral-payment flow for a submission
// that is still in `prepared` state. Returns `{ txid, feeSats }`.
//
// Parameters:
//   submissionId : number — must match a submission this session owns.
//   api          : {
//     buildCollateralPsbt(submissionId, { xpub, changeAddress, feeRate? }),
//     getGovernanceNetwork()
//   }
//   feeRate      : optional sat/vByte integer, clamped by the server
//                  to 1..1000; omit to let the backend pick 10.
//
// Error taxonomy (all thrown with `.code` set):
//   pali_unavailable       -> extension not installed / disabled
//   pali_path_disabled     -> backend hasn't set SYSCOIN_BLOCKBOOK_URL
//                             (the server returned 503 on the network
//                             probe); UI should hide the button
//   network_mismatch       -> Pali is on a chain the server doesn't
//                             serve (UI copy depends on serverNetworkKey)
//   user_rejected          -> EIP-1193 4001 from the Pali popup
//   unauthorized           -> EIP-1193 4100
//   insufficient_funds     -> server 422 (shortfall attached via .cause)
//   blockbook_unreachable  -> server 502
//   bad_signer_response    -> Pali returned something we can't parse
//                             as a 64-hex txid
//   <other server codes>   -> pass through verbatim via proposalError
// `onProgress(phase)` (optional) is called with one of:
//   'connecting'         -> just after isPaliAvailable, before any prompt
//   'building'           -> backend PSBT request dispatched
//   'awaiting_signature' -> Pali sys_signAndSend sent to the extension
// The final `attached` state is signalled by the function returning;
// we don't emit a 'broadcasting' phase because Pali's signAndSend is a
// single opaque call — broadcast completion is tied to resolution of
// that promise.
export async function payProposalCollateralWithPali(
  submissionId,
  api,
  { feeRate, onProgress } = {}
) {
  const notify = (phase) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress(phase);
      } catch (_e) {
        // never let a UI callback explode the transaction flow
      }
    }
  };
  if (!isPaliAvailable()) {
    const e = new Error('pali_unavailable');
    e.code = 'pali_unavailable';
    throw e;
  }
  if (!api || typeof api.buildCollateralPsbt !== 'function' || typeof api.getGovernanceNetwork !== 'function') {
    throw new Error('payProposalCollateralWithPali: api must expose buildCollateralPsbt + getGovernanceNetwork');
  }

  notify('connecting');

  // 1) Server network probe first. Cheap, tells us upfront whether the
  //    Pali path is enabled at all and what chain we're expecting.
  const serverNet = await api.getGovernanceNetwork();
  if (!serverNet || !serverNet.paliPathEnabled || !serverNet.networkKey) {
    const e = new Error('pali_path_disabled');
    e.code = 'pali_path_disabled';
    throw e;
  }

  // 2) Prompt for connection + pull wallet-level identifiers. These
  //    DO not cost a popup (connection is one-time), and they're
  //    idempotent — repeated calls in the same session just return
  //    the cached values from the Pali background script.
  await requestAccounts();
  const xpub = await paliRequest('sys_getPublicKey');
  if (typeof xpub !== 'string' || xpub.length < 20) {
    const e = new Error('bad_signer_response');
    e.code = 'bad_signer_response';
    e.detail = 'sys_getPublicKey returned non-string';
    throw e;
  }
  const changeAddress = await paliRequest('sys_getChangeAddress');
  if (typeof changeAddress !== 'string' || changeAddress.length < 10) {
    const e = new Error('bad_signer_response');
    e.code = 'bad_signer_response';
    e.detail = 'sys_getChangeAddress returned non-string';
    throw e;
  }

  // 3) Chain sanity check. We do this AFTER grabbing xpub/change so
  //    the error copy can name the right target network (the xpub
  //    prefix already hints at what Pali is currently on).
  let paliChainId;
  try {
    paliChainId = await getChainId();
  } catch (_err) {
    // `getChainId` resolves lazily — if Pali hasn't injected its
    // chainId yet we try once to read it via `eth_chainId` before
    // giving up. A raw throw here means we have no way to verify;
    // fall through to the server call and let the xpub-prefix check
    // on the backend surface `network_mismatch` explicitly.
    paliChainId = null;
  }
  if (paliChainId && !chainIdMatchesServer(paliChainId, serverNet.networkKey)) {
    const e = new Error('network_mismatch');
    e.code = 'network_mismatch';
    e.detail = `pali:${paliChainId} vs server:${serverNet.networkKey}`;
    throw e;
  }

  notify('building');

  // 4) Server builds the PSBT. This is where insufficient-funds /
  //    Blockbook-down / bad-xpub errors surface as typed error codes
  //    — we let them bubble up as-is so the caller can pick copy.
  const built = await api.buildCollateralPsbt(submissionId, {
    xpub,
    changeAddress,
    ...(feeRate != null ? { feeRate } : {}),
  });
  if (!built || !built.psbt || typeof built.psbt.psbt !== 'string') {
    const e = new Error('bad_server_psbt');
    e.code = 'bad_server_psbt';
    throw e;
  }

  notify('awaiting_signature');

  // 5) Pali signs + broadcasts. The extension takes `[ { psbt, assets } ]`
  //    as the params array — single-element tuple, matching the
  //    in-page provider shim.
  const signedResult = await paliRequest('sys_signAndSend', [built.psbt]);
  const txid = normalizeSignAndSendResult(signedResult);

  return {
    txid,
    feeSats: built.feeSats,
    xpub,
    changeAddress,
  };
}

// Exposed for tests.
export const __internal = {
  translatePaliError,
  normalizeSignAndSendResult,
  chainIdMatchesServer,
};
