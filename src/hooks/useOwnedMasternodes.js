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
//     status: 'idle' | 'loading' | 'ready' | 'error' | 'vault_locked',
//     error:  null | <code>,
//     owned:  [{
//       keyId, label, wif, address,          // from the vault
//       proTxHash, collateralHash,
//       collateralIndex, masternodeStatus,   // from /gov/mns/lookup
//     }, ...],
//     refresh: () => Promise<void>,
//   }
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

export function useOwnedMasternodes({ governanceService = defaultService } = {}) {
  const vault = useVault();
  const [status, setStatus] = useState(IDLE);
  const [error, setError] = useState(null);
  const [matches, setMatches] = useState([]);

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
    async (keys) => {
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
        setMatches(joined);
        setStatus(READY);
      } catch (err) {
        if (!mountedRef.current || genRef.current !== myGen) return;
        setMatches([]);
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
    if (!vault.isUnlocked) {
      // Any in-flight lookup is cancelled by bumping the gen counter.
      genRef.current += 1;
      setMatches([]);
      setError(null);
      setStatus(vault.isIdle || vault.isLoading ? IDLE : VAULT_LOCKED);
      return;
    }
    if (vaultKeys.length === 0) {
      // Unlocked vault but no imported keys — no need to call the
      // backend. Render as READY with an empty result; the page
      // surface distinguishes "zero keys" from "no owned MNs".
      genRef.current += 1;
      setMatches([]);
      setError(null);
      setStatus(READY);
      return;
    }
    doFetch(vaultKeys);
    // vaultKeys is captured by value; the fingerprint guarantees
    // we re-fire only when the address set actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.isUnlocked, vault.isIdle, vault.isLoading, addressFingerprint]);

  const refresh = useCallback(async () => {
    if (!vault.isUnlocked) return;
    await doFetch(vaultKeys);
  }, [vault.isUnlocked, vaultKeys, doFetch]);

  return {
    status,
    error,
    owned: matches,
    refresh,
    isIdle: status === IDLE,
    isLoading: status === LOADING,
    isReady: status === READY,
    isError: status === ERROR,
    isVaultLocked: status === VAULT_LOCKED,
  };
}
