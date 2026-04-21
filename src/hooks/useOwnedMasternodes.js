import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useVault } from '../context/VaultContext';
import { governanceService as defaultService } from '../lib/governanceService';

// Hook that reconciles the user's vault (imported voting WIFs + their
// P2WPKH addresses) with the live masternode set on the backend, and
// returns the subset of vault keys that correspond to a usable
// masternode (i.e. one the user can actually vote with).
//
// Shape:
//
//   {
//     status: 'idle' | 'loading' | 'ready' | 'error' | 'vault_locked'
//           | 'empty_vault',
//     error:  null | <code>,
//     owned:  [{
//       keyId, label, wif, address,          // from the vault
//       proTxHash, collateralHash,
//       collateralIndex, masternodeStatus,   // from /gov/mns/lookup
//       receipt,                             // see below (null when
//                                            // proposalHash isn't set
//                                            // or the MN has no receipt)
//     }, ...],
//     receipts:       [<raw receipt row>, ...]  // when proposalHash set
//     reconciled:     boolean  (receipts freshly reconciled with chain)
//     reconcileError: null | <code> (soft: 'rpc_failed' | 'receipts_failed')
//     refresh: (opts?: { refreshReceipts?: boolean }) => Promise<void>,
//   }
//
// `proposalHash` (optional): when provided, the hook additionally
// calls POST /gov/receipts/reconcile after the /gov/mns/lookup join
// and annotates every owned row with a `receipt` field (or null for
// rows with no stored receipt). Receipts power the modal's
// "default-exclude already-confirmed MNs" and "Retry failed"
// behaviour. The reconcile call runs in the SAME loading cycle as
// the lookup so the UI transitions IDLE → LOADING → READY in one
// step — consumers don't need to orchestrate two overlapping
// spinners.
//
// Why reconcile (POST) on open instead of fetch (GET)? Opening the
// modal is explicit user intent to see up-to-the-moment chain state,
// so we trade one extra RPC for an authoritative view. The backend
// freshness window keeps repeated opens cheap (returns stored rows
// without hitting Core). GET /gov/receipts exists for cheaper,
// side-effect-free reads — e.g. page-level cohort chips — but the
// vote modal wants the reconciled view.
//
// A failure to reconcile does not fail the hook: owned rows are
// still correct and usable for a fresh vote. We surface the failure
// as a soft `reconcileError` the modal can render as a banner
// without blocking the user.
//
// Why `empty_vault` is a distinct state: "vault unlocked but zero
// imported keys" and "vault has keys but none correspond to a live
// masternode" are UX-distinct cases (import-keys CTA vs. address-
// mismatch hint). Collapsing them into `ready + owned=[]` forces the
// page to guess which one is true. We surface the state explicitly
// so callers render the right copy and call-to-action.
//
// Semantics:
//
// * The hook does nothing useful while the vault is locked/loading —
//   the user must unlock to hand us voting addresses. We expose the
//   state explicitly (`vault_locked`) so the Governance page can
//   render a contextual CTA ("Unlock your vault to vote directly").
// * We fan the full list of vault addresses through a single POST to
//   /gov/mns/lookup. The backend silently drops unknown addresses,
//   so a vault with more keys than active MNs just produces fewer
//   rows.
// * Matches are projected back into vault-key-joined rows so callers
//   can sign without a second lookup. If an address is in the vault
//   but NOT in the backend's MN list (e.g. the node was banned or
//   removed), the row is simply absent from `owned`.
// * `refresh()` is exposed so the user can retry after fixing a
//   problem (e.g. tracker hadn't refreshed yet when they unlocked).

const IDLE = 'idle';
const LOADING = 'loading';
const READY = 'ready';
const ERROR = 'error';
const VAULT_LOCKED = 'vault_locked';
const EMPTY_VAULT = 'empty_vault';

// `enabled`:
//   Opt-out flag for callers that mount the hook before they actually
//   need the data (e.g. a modal that is always present in the tree
//   but only visible when a user clicks Vote). When false, the hook
//   skips the POST to `/gov/mns/lookup` entirely — no background
//   load, no early address-set leakage to the server. Defaults to
//   true to preserve the historical no-arg contract; callers that
//   want gating pass `enabled: open`. Transitions true → false
//   cancel any in-flight fetch by bumping the generation counter
//   and return the hook to IDLE so a later true transition re-fires
//   the fetch cleanly.
export function useOwnedMasternodes({
  governanceService = defaultService,
  enabled = true,
  proposalHash = null,
} = {}) {
  const vault = useVault();
  const [status, setStatus] = useState(IDLE);
  const [error, setError] = useState(null);
  const [matches, setMatches] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [reconciled, setReconciled] = useState(false);
  const [reconcileError, setReconcileError] = useState(null);

  // Ensure late-landing responses don't overwrite state that a
  // newer request has already committed. Every fetch captures the
  // current counter; only the matching response is allowed to write
  // state. Same pattern AuthContext/VaultContext use.
  const genRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  // Stable "list of (keyId, address, label, wif) tuples" derived from
  // vault.data. Memoised on the vault data identity so React doesn't
  // re-fetch on unrelated vault state transitions (saving flag, etc.).
  const vaultKeys = useMemo(() => {
    if (!vault.isUnlocked || !vault.data || !Array.isArray(vault.data.keys)) {
      return [];
    }
    return vault.data.keys
      .filter((k) => k && typeof k.address === 'string' && k.address)
      .map((k) => ({
        id: k.id,
        label: k.label || '',
        wif: k.wif,
        address: k.address,
      }));
  }, [vault.isUnlocked, vault.data]);

  // `addressFingerprint` is a stable hash-equivalent over the set of
  // addresses we'd send. Using vaultKeys as the effect dep re-fires
  // even when just labels change; the fingerprint lets us do the
  // right thing (only re-fetch when the address set truly changes).
  const addressFingerprint = useMemo(
    () => vaultKeys.map((k) => k.address).sort().join('|'),
    [vaultKeys]
  );

  const doFetch = useCallback(
    async (keys, propHash, { refreshReceipts = false } = {}) => {
      if (!mountedRef.current) return;
      const myGen = ++genRef.current;
      setStatus(LOADING);
      setError(null);
      try {
        const addresses = keys.map((k) => k.address);
        const rows = await governanceService.lookupOwnedMasternodes(addresses);
        if (!mountedRef.current || genRef.current !== myGen) return;
        // Join the backend response to our vault entries so the UI
        // can display label / wif alongside protx/collateral. Keyed
        // on the voting address (case-insensitive to match the
        // backend's own comparison).
        const byAddr = new Map();
        for (const k of keys) byAddr.set(k.address.toLowerCase(), k);
        const joined = [];
        for (const row of rows) {
          const k = byAddr.get(String(row.votingaddress).toLowerCase());
          if (!k) continue; // backend returned an address we didn't send
          joined.push({
            keyId: k.id,
            label: k.label,
            wif: k.wif,
            address: k.address,
            proTxHash: row.proTxHash,
            collateralHash: row.collateralHash,
            collateralIndex: row.collateralIndex,
            masternodeStatus: row.status,
            payee: row.payee,
            networkAddress: row.address, // host:port of the MN
          });
        }

        // Receipts join is opt-in by passing a proposalHash. When
        // absent we short-circuit with `receipt: null` on every row
        // so consumers can render a uniform shape regardless of
        // whether they asked for receipts.
        //
        // We POST to /gov/receipts/reconcile (not GET) because
        // opening the modal is explicit user intent to see fresh
        // on-chain state, and reconcile is the authoritative
        // source. The backend freshness window keeps repeated
        // opens cheap.
        let receiptList = [];
        let reconciledFlag = false;
        let reconcileErr = null;
        // Choose the method NAME, not a detached function reference,
        // so we can invoke it as `governanceService[methodName](...)`
        // and preserve the service as the call receiver. Class-style
        // service implementations whose methods rely on `this` (e.g.
        // `this.client.post(...)`) would otherwise blow up under ESM
        // strict-mode `this === undefined`.
        //
        // Back-compat: fall back to `fetchReceipts` when a caller
        // passes a service mock that predates the POST /reconcile
        // split. New code should provide `reconcileReceipts`.
        const receiptsMethod =
          typeof governanceService.reconcileReceipts === 'function'
            ? 'reconcileReceipts'
            : typeof governanceService.fetchReceipts === 'function'
              ? 'fetchReceipts'
              : null;
        if (propHash && receiptsMethod) {
          try {
            const r = await governanceService[receiptsMethod](propHash, {
              refresh: refreshReceipts,
            });
            if (!mountedRef.current || genRef.current !== myGen) return;
            receiptList = Array.isArray(r.receipts) ? r.receipts : [];
            reconciledFlag = Boolean(r.reconciled);
            reconcileErr =
              typeof r.reconcileError === 'string'
                ? r.reconcileError
                : null;
          } catch (err) {
            if (!mountedRef.current || genRef.current !== myGen) return;
            // Soft failure — owned rows are still correct for a
            // fresh vote. Surface the code so the modal can warn.
            reconcileErr = (err && err.code) || 'receipts_failed';
          }
        }

        // Index receipts by (collateralHash, collateralIndex) for
        // O(1) join against the owned rows. Lowercasing the hash
        // mirrors the backend's normalisation so a mixed-case row
        // from the MN lookup still matches a stored receipt.
        const byOutpoint = new Map();
        for (const rec of receiptList) {
          if (
            rec &&
            typeof rec.collateralHash === 'string' &&
            Number.isInteger(rec.collateralIndex)
          ) {
            byOutpoint.set(
              `${rec.collateralHash.toLowerCase()}:${rec.collateralIndex}`,
              rec
            );
          }
        }
        const withReceipts = joined.map((row) => ({
          ...row,
          receipt:
            (row.collateralHash &&
              byOutpoint.get(
                `${String(row.collateralHash).toLowerCase()}:${
                  row.collateralIndex
                }`
              )) ||
            null,
        }));

        setMatches(withReceipts);
        setReceipts(receiptList);
        setReconciled(reconciledFlag);
        setReconcileError(reconcileErr);
        setStatus(READY);
      } catch (err) {
        if (!mountedRef.current || genRef.current !== myGen) return;
        setMatches([]);
        setReceipts([]);
        setReconciled(false);
        setReconcileError(null);
        setStatus(ERROR);
        setError((err && err.code) || 'lookup_failed');
      }
    },
    [governanceService]
  );

  // Automatic fetch when the vault becomes unlocked (or the address
  // set changes while unlocked). When the vault isn't usable, reset
  // to a well-defined non-erroring state so the Governance page can
  // render the logged-in / vault-locked CTA without a stale error
  // banner bleeding through.
  useEffect(() => {
    if (!enabled) {
      // Caller hasn't asked us to look anything up yet (e.g. the
      // vote modal is mounted but closed). Cancel any prior in-
      // flight fetch so a response can't land while we're meant
      // to be dormant, and reset state so a later `enabled: true`
      // transition doesn't flash stale results before the new
      // fetch resolves.
      genRef.current += 1;
      setMatches([]);
      setReceipts([]);
      setReconciled(false);
      setReconcileError(null);
      setError(null);
      setStatus(IDLE);
      return;
    }
    if (!vault.isUnlocked) {
      // Any in-flight lookup is cancelled by bumping the gen counter.
      genRef.current += 1;
      setMatches([]);
      setReceipts([]);
      setReconciled(false);
      setReconcileError(null);
      setError(null);
      setStatus(vault.isIdle || vault.isLoading ? IDLE : VAULT_LOCKED);
      return;
    }
    if (vaultKeys.length === 0) {
      // Unlocked vault but no imported keys. We skip the backend
      // call and surface EMPTY_VAULT as a dedicated state so the
      // UI can render "import keys" copy rather than the "no
      // matching masternode" copy used when the user has keys
      // that simply don't map to a live MN.
      genRef.current += 1;
      setMatches([]);
      setReceipts([]);
      setReconciled(false);
      setReconcileError(null);
      setError(null);
      setStatus(EMPTY_VAULT);
      return;
    }
    doFetch(vaultKeys, proposalHash);
    // vaultKeys is captured by value; the fingerprint guarantees
    // we re-fire only when the address set actually changed. We
    // also re-fire when the proposalHash changes so moving between
    // proposals re-fetches the receipts join.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, vault.isUnlocked, vault.isIdle, vault.isLoading, addressFingerprint, proposalHash]);

  const refresh = useCallback(
    async ({ refreshReceipts = false } = {}) => {
      if (!enabled || !vault.isUnlocked) return;
      await doFetch(vaultKeys, proposalHash, { refreshReceipts });
    },
    [enabled, vault.isUnlocked, vaultKeys, proposalHash, doFetch]
  );

  return {
    status,
    error,
    owned: matches,
    receipts,
    reconciled,
    reconcileError,
    refresh,
    isIdle: status === IDLE,
    isLoading: status === LOADING,
    isReady: status === READY,
    isError: status === ERROR,
    isVaultLocked: status === VAULT_LOCKED,
    isVaultEmpty: status === EMPTY_VAULT,
  };
}
