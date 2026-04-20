import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useAuth } from './AuthContext';
import { vaultService as defaultVaultService } from '../lib/vaultService';
import { deriveVaultKey, deriveMaster } from '../lib/crypto/kdf';
import { decryptEnvelope } from '../lib/crypto/envelope';

// ---------------------------------------------------------------------------
// VaultContext
//
// Owns the client-side vault lifecycle. Deliberately a sibling of
// AuthContext (not merged into it) because vault concerns — network errors
// to /vault, wrong-password unlock attempts, ETag bookkeeping — shouldn't
// pollute the login flow.
//
// This PR covers READ-ONLY operation: load/unlock/lock. Writes (key
// import, change-password re-wrap) arrive in the next PR, which also owns
// the small backend change needed to solve saltV bootstrap on an empty
// vault. Splitting the crypto primitive + read path here lets that next
// PR focus purely on the write UX and the server-side atomicity.
//
// State machine (`status`):
//
//   idle        No /auth/me hydration yet.
//   loading     GET /vault in flight.
//   empty       Vault row does not exist on the server.
//   locked      Vault row exists; we have the server blob cached but no
//               DataKey in memory. Caller must `unlock(...)` to read it.
//   unlocked    DataKey held in a ref; `data` reflects the last-decrypted
//               payload.
//   error       Last operation failed; see `error` for a code.
//
// Transitions wired from AuthContext:
//
//   isAuthenticated=true  -> auto-run load() once
//   isAuthenticated=false -> hard-reset to idle, wipe the DataKey
// ---------------------------------------------------------------------------

const VaultContext = createContext(null);

const IDLE = 'idle';
const LOADING = 'loading';
const EMPTY = 'empty';
const LOCKED = 'locked';
const UNLOCKED = 'unlocked';
const ERROR = 'error';

function blankState() {
  return {
    status: IDLE,
    error: null,
    saltV: null,
    etag: null,
    blob: null,
    data: null,
  };
}

export function VaultProvider({
  children,
  vaultService = defaultVaultService,
}) {
  const { isAuthenticated } = useAuth();

  const [state, setStateInner] = useState(blankState);

  // DataKey bytes while unlocked. Stored in a ref rather than state so a
  // React render can't accidentally leak them into memoized props /
  // devtools diffs. Wiped on lock() and on auth loss.
  const dkRef = useRef(null);

  // Monotonic request counter. Same pattern AuthContext uses for
  // refresh/login: every async op captures the counter value at its
  // start and only writes state if it's still current. Protects against
  // a slow GET /vault landing after the user has already logged out.
  const genRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const bumpGen = useCallback(() => {
    genRef.current += 1;
    return genRef.current;
  }, []);

  const safeSet = useCallback((updater, myGen) => {
    if (!mountedRef.current) return;
    if (typeof myGen === 'number' && myGen !== genRef.current) return;
    setStateInner((prev) =>
      typeof updater === 'function' ? updater(prev) : updater
    );
  }, []);

  const reset = useCallback(() => {
    bumpGen();
    dkRef.current = null;
    safeSet(blankState(), genRef.current);
  }, [bumpGen, safeSet]);

  // -----------------------------------------------------------------------
  // load()  — GET /vault, land in empty/locked/error.
  // -----------------------------------------------------------------------
  const load = useCallback(async () => {
    const myGen = bumpGen();
    safeSet((s) => ({ ...s, status: LOADING, error: null }), myGen);
    try {
      const out = await vaultService.load();
      if (out.empty) {
        safeSet(
          {
            status: EMPTY,
            error: null,
            saltV: null,
            etag: null,
            blob: null,
            data: null,
          },
          myGen
        );
        return { status: EMPTY };
      }
      safeSet(
        (s) => ({
          ...s,
          status: LOCKED,
          error: null,
          saltV: out.saltV,
          etag: out.etag,
          blob: out.blob,
          data: null,
        }),
        myGen
      );
      return { status: LOCKED, saltV: out.saltV, etag: out.etag };
    } catch (err) {
      safeSet(
        (s) => ({
          ...s,
          status: ERROR,
          error: (err && err.code) || 'vault_load_failed',
        }),
        myGen
      );
      throw err;
    }
  }, [vaultService, bumpGen, safeSet]);

  // -----------------------------------------------------------------------
  // Internal: actually perform the decrypt, once we have master + the
  // server blob in hand. Both unlock and unlockWithMaster route through
  // here so the decryption branch is tested once.
  // -----------------------------------------------------------------------
  const decryptWithMaster = useCallback(
    async (master, snapshot) => {
      const vaultKey = await deriveVaultKey(master, snapshot.saltV);
      const { data, dk } = await decryptEnvelope(snapshot.blob, vaultKey);
      dkRef.current = dk;
      return data;
    },
    []
  );

  // -----------------------------------------------------------------------
  // unlockWithMaster(master)
  //
  // Used by the Login flow to avoid re-running PBKDF2. If the vault hasn't
  // been loaded yet, we fetch it first. If the vault is empty, this is a
  // no-op (nothing to decrypt) and we land in EMPTY.
  // -----------------------------------------------------------------------
  const unlockWithMaster = useCallback(
    async (master) => {
      if (!(master instanceof Uint8Array) || master.length !== 32) {
        const e = new Error('master_key_required');
        e.code = 'master_key_required';
        throw e;
      }

      // We need a saltV + blob. Rather than trying to read the latest
      // `state` from a stale closure, always fetch via the service and
      // work from that snapshot. It's one extra GET on the refresh path
      // but keeps the concurrency story simple (and the service is
      // trivially mockable in tests).
      const myGen = bumpGen();
      safeSet((s) => ({ ...s, status: LOADING, error: null }), myGen);
      let snapshot;
      try {
        snapshot = await vaultService.load();
      } catch (err) {
        safeSet(
          (s) => ({
            ...s,
            status: ERROR,
            error: (err && err.code) || 'vault_load_failed',
          }),
          myGen
        );
        throw err;
      }

      if (snapshot.empty) {
        safeSet(
          {
            status: EMPTY,
            error: null,
            saltV: null,
            etag: null,
            blob: null,
            data: null,
          },
          myGen
        );
        return { status: EMPTY };
      }

      try {
        const data = await decryptWithMaster(master, snapshot);
        safeSet(
          {
            status: UNLOCKED,
            error: null,
            saltV: snapshot.saltV,
            etag: snapshot.etag,
            blob: snapshot.blob,
            data,
          },
          myGen
        );
        return { status: UNLOCKED };
      } catch (err) {
        // Keep the server blob cached so a subsequent correct unlock
        // doesn't need to re-GET; land in LOCKED with the failure code.
        safeSet(
          {
            status: LOCKED,
            error: (err && err.code) || 'unlock_failed',
            saltV: snapshot.saltV,
            etag: snapshot.etag,
            blob: snapshot.blob,
            data: null,
          },
          myGen
        );
        throw err;
      }
    },
    [vaultService, bumpGen, safeSet, decryptWithMaster]
  );

  // -----------------------------------------------------------------------
  // unlock({ password, email })
  //
  // Page-reload path: live session, but master is no longer in memory, so
  // the user must re-enter their password. We derive master fresh and
  // route through unlockWithMaster.
  // -----------------------------------------------------------------------
  const unlock = useCallback(
    async ({ password, email }) => {
      if (typeof password !== 'string' || password.length === 0) {
        const e = new Error('password_required');
        e.code = 'password_required';
        throw e;
      }
      if (typeof email !== 'string' || email.length === 0) {
        const e = new Error('email_required');
        e.code = 'email_required';
        throw e;
      }
      const master = await deriveMaster(password, email);
      return unlockWithMaster(master);
    },
    [unlockWithMaster]
  );

  // -----------------------------------------------------------------------
  // lock()
  //
  // Voluntary lock: wipe the DataKey + payload. Keeps the blob pointer
  // cached so the next unlock doesn't re-GET.
  // -----------------------------------------------------------------------
  const lock = useCallback(() => {
    dkRef.current = null;
    const myGen = bumpGen();
    safeSet(
      (s) => {
        if (s.status !== UNLOCKED && s.status !== LOCKED) return s;
        return { ...s, status: LOCKED, data: null, error: null };
      },
      myGen
    );
  }, [bumpGen, safeSet]);

  // -----------------------------------------------------------------------
  // Auth lifecycle hooks.
  //
  // We deliberately depend only on `isAuthenticated` here. The memoized
  // load/reset identities are stable via useCallback, but listing them
  // would tie this effect to every state.* update and cause a re-GET on
  // every transition. React's exhaustive-deps warning is suppressed with
  // a targeted comment.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (isAuthenticated) {
      load().catch(() => {
        // Swallowed: `load()` has already captured the error into state.
      });
    } else {
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  const value = useMemo(
    () => ({
      status: state.status,
      error: state.error,
      data: state.data,
      etag: state.etag,
      saltV: state.saltV,
      isIdle: state.status === IDLE,
      isLoading: state.status === LOADING,
      isEmpty: state.status === EMPTY,
      isLocked: state.status === LOCKED,
      isUnlocked: state.status === UNLOCKED,
      isError: state.status === ERROR,
      load,
      unlock,
      unlockWithMaster,
      lock,
      reset,
    }),
    [state, load, unlock, unlockWithMaster, lock, reset]
  );

  return (
    <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
  );
}

export function useVault() {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    throw new Error('useVault() must be used inside <VaultProvider>');
  }
  return ctx;
}

export const __testing = {
  STATUS: { IDLE, LOADING, EMPTY, LOCKED, UNLOCKED, ERROR },
};
