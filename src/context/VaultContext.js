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
//   isAuthenticated=true, user.id new                -> reset + load()
//   isAuthenticated=true, user.id same as previous   -> noop
//   isAuthenticated=false                            -> hard-reset
//
// Identity is keyed on `user.id`, not just `isAuthenticated`, because a
// user can switch accounts without an intervening logout (navigate to
// /login while already authenticated and submit different credentials).
// Keying only on `isAuthenticated` would leave the prior user's cached
// blob in state and make every unlock attempt by the new user fail
// with envelope_decrypt_failed until a full reload.
//
// Concurrency model:
//
// The auth-triggered auto-load and Login's fire-and-forget
// `unlockWithMaster(master)` race by construction — both get scheduled
// immediately after AuthContext flips isAuthenticated=true. A naive
// implementation lets both call `vaultService.load()` and bump the gen
// counter, so the later-landing LOCKED write clobbers the earlier
// UNLOCKED write (or vice versa). We coalesce them with a single-flight
// `load()`: concurrent callers share one in-flight promise, and callers
// that find a usable snapshot already in state short-circuit without
// hitting the network at all. That also gives us offline unlock: once
// the blob is cached in state, `unlockWithMaster` decrypts from it
// instead of re-GETing.
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

function snapshotOf(s) {
  return {
    status: s.status,
    saltV: s.saltV,
    etag: s.etag,
    blob: s.blob,
    data: s.data,
    error: s.error,
  };
}

export function VaultProvider({
  children,
  vaultService = defaultVaultService,
}) {
  const { isAuthenticated, user } = useAuth();
  const userId = user && user.id != null ? user.id : null;

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
  // Session counter — bumped ONLY on reset(). genRef bumps far more
  // often (every doLoad/lock/unlock write), so an unlock that captures
  // genRef at its start will look "stale" even in the happy path.
  // unlockWithMaster therefore captures sessionGenRef instead: it's a
  // tight fingerprint of "the identity I started working for" and
  // changes iff reset() has torn down state between the unlock's
  // decrypt and its commit. Without this, a logout racing a mid-flight
  // decrypt would drop the state write (via the genRef check) but
  // still install dk into dkRef, leaving key material in memory after
  // auth loss. (Codex round 2 P2.)
  const sessionGenRef = useRef(0);
  const mountedRef = useRef(true);

  // Synchronous mirror of `state`, updated inside the setStateInner
  // callback so that async code can read the latest committed snapshot
  // before React schedules the next render. Needed for the cache
  // short-circuit in load(): after doLoad() resolves, unlockWithMaster
  // must see LOCKED, not the pre-commit LOADING.
  const stateRef = useRef(blankState());

  // Single-flight guard for doLoad(). When non-null, concurrent callers
  // of load() await this promise instead of starting a second GET.
  const inflightLoadRef = useRef(null);

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

  // commit(patch, myGen): merge `patch` over the latest committed state
  // and write it. `patch` is a plain object — NOT a function — because
  // we need a single deterministic `next` to mirror into stateRef. Any
  // "functional update" logic must read stateRef.current explicitly
  // before calling commit().
  const commit = useCallback((patch, myGen) => {
    if (!mountedRef.current) return;
    if (typeof myGen === 'number' && myGen !== genRef.current) return;
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setStateInner(next);
  }, []);

  const reset = useCallback(() => {
    bumpGen();
    sessionGenRef.current += 1;
    dkRef.current = null;
    // Abandon any in-flight load. Its late safeSet will be dropped by
    // the gen check, but clearing the ref ensures the next login's
    // load() doesn't coalesce onto a pre-logout snapshot.
    inflightLoadRef.current = null;
    const blank = blankState();
    stateRef.current = blank;
    if (mountedRef.current) setStateInner(blank);
  }, [bumpGen]);

  // -----------------------------------------------------------------------
  // doLoad() — actual GET /vault, writes LOADING -> {EMPTY|LOCKED|ERROR},
  // returns the resulting snapshot. Callers must not invoke this
  // directly; use load() so concurrent calls coalesce.
  // -----------------------------------------------------------------------
  const doLoad = useCallback(async () => {
    const myGen = bumpGen();
    commit({ status: LOADING, error: null }, myGen);
    try {
      const out = await vaultService.load();
      if (out.empty) {
        const snap = {
          status: EMPTY,
          error: null,
          saltV: null,
          etag: null,
          blob: null,
          data: null,
        };
        commit(snap, myGen);
        return snap;
      }
      const snap = {
        status: LOCKED,
        error: null,
        saltV: out.saltV,
        etag: out.etag,
        blob: out.blob,
        data: null,
      };
      commit(snap, myGen);
      return snap;
    } catch (err) {
      commit(
        {
          status: ERROR,
          error: (err && err.code) || 'vault_load_failed',
        },
        myGen
      );
      throw err;
    }
  }, [vaultService, bumpGen, commit]);

  // -----------------------------------------------------------------------
  // load() — single-flight + cache-aware wrapper around doLoad().
  //
  // Returns a snapshot {status, saltV, etag, blob, data, error}. Three
  // paths:
  //
  //  1. stateRef already holds a usable snapshot (EMPTY/LOCKED/UNLOCKED)
  //     -> return it synchronously, no network call. This is what makes
  //     post-login unlock work offline once the blob has been cached.
  //
  //  2. A prior doLoad() is still in flight -> await its promise. This
  //     is what prevents the auth-effect load and Login's
  //     unlockWithMaster from racing: both resolve to the same snapshot
  //     and only one commits intermediate LOADING/LOCKED writes.
  //
  //  3. Neither: start a new doLoad(), park the promise in
  //     inflightLoadRef, clear the ref on settle.
  // -----------------------------------------------------------------------
  const load = useCallback(() => {
    const s = stateRef.current;
    if (s.status === LOCKED || s.status === UNLOCKED || s.status === EMPTY) {
      return Promise.resolve(snapshotOf(s));
    }
    if (inflightLoadRef.current) return inflightLoadRef.current;

    const p = doLoad();
    inflightLoadRef.current = p;
    // .finally clears the slot whether doLoad resolved or rejected.
    // The identity check handles the edge case where reset() has
    // already nulled the ref during the await (post-logout): we don't
    // want to null a newer inflight promise belonging to the next
    // session.
    p.catch(() => {}).then(() => {
      if (inflightLoadRef.current === p) inflightLoadRef.current = null;
    });
    return p;
  }, [doLoad]);

  // -----------------------------------------------------------------------
  // Internal: actually perform the decrypt, once we have master + the
  // server blob in hand. Returns BOTH the plaintext and the raw DataKey
  // to the caller WITHOUT stashing dk in dkRef. The caller is
  // responsible for the gen/mount check immediately before installing
  // dk — otherwise a logout-during-unlock race would leave key material
  // in memory after state has already been reset. (Codex round 2 P2.)
  // -----------------------------------------------------------------------
  const decryptWithMaster = useCallback(async (master, snapshot) => {
    const vaultKey = await deriveVaultKey(master, snapshot.saltV);
    const { data, dk } = await decryptEnvelope(snapshot.blob, vaultKey);
    return { data, dk };
  }, []);

  // -----------------------------------------------------------------------
  // unlockWithMaster(master)
  //
  // Used by the Login flow to avoid re-running PBKDF2. Routes through
  // load() so that (a) a concurrent auth-triggered load coalesces onto
  // the same GET rather than racing, and (b) we re-use any already-
  // cached blob instead of making a round-trip we don't need.
  // -----------------------------------------------------------------------
  const unlockWithMaster = useCallback(
    async (master) => {
      if (!(master instanceof Uint8Array) || master.length !== 32) {
        const e = new Error('master_key_required');
        e.code = 'master_key_required';
        throw e;
      }

      // Capture the session fingerprint NOW, before any await. If
      // reset() fires at any point before we install dk/commit, this
      // value will disagree with sessionGenRef.current and we bail.
      const startingSession = sessionGenRef.current;

      let snapshot;
      try {
        snapshot = await load();
      } catch (err) {
        // load() has already captured the error into state; surface it
        // to the caller (Login swallows, Account re-renders with the
        // error copy).
        throw err;
      }

      if (snapshot.status === EMPTY) {
        return { status: EMPTY };
      }
      if (snapshot.status !== LOCKED && snapshot.status !== UNLOCKED) {
        const e = new Error(snapshot.error || 'vault_not_ready');
        e.code = snapshot.error || 'vault_not_ready';
        throw e;
      }

      // Re-bump gen now that load() has settled, so concurrent ops that
      // bumped during the await don't invalidate our UNLOCKED write.
      const myGen = bumpGen();

      let decrypted;
      try {
        decrypted = await decryptWithMaster(master, snapshot);
      } catch (err) {
        // Decryption itself failed. decryptWithMaster never touched
        // dkRef, so no key material to wipe. Land in LOCKED with the
        // failure code (subject to the gen check so a mid-flight
        // logout still wins).
        commit(
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

      // Gate the DK install. genRef alone isn't sufficient because our
      // own bumpGen() above advanced it past any intervening reset,
      // leaving a stale unlock looking current. sessionGenRef bumps
      // ONLY on reset(), so a mismatch there is the authoritative
      // "identity gone, don't install the key" signal. Between this
      // check and the subsequent commit there are no awaits, so no
      // window for a concurrent reset() to slip in.
      if (
        !mountedRef.current ||
        sessionGenRef.current !== startingSession ||
        myGen !== genRef.current
      ) {
        // Nothing to do — dk is dropped on function exit.
        return { status: 'stale' };
      }
      dkRef.current = decrypted.dk;
      commit(
        {
          status: UNLOCKED,
          error: null,
          saltV: snapshot.saltV,
          etag: snapshot.etag,
          blob: snapshot.blob,
          data: decrypted.data,
        },
        myGen
      );
      return { status: UNLOCKED };
    },
    [load, bumpGen, commit, decryptWithMaster]
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
    const s = stateRef.current;
    if (s.status !== UNLOCKED && s.status !== LOCKED) return;
    const myGen = bumpGen();
    commit({ status: LOCKED, data: null, error: null }, myGen);
  }, [bumpGen, commit]);

  // -----------------------------------------------------------------------
  // Auth lifecycle hooks.
  //
  // Keyed on [isAuthenticated, userId]. The memoized load/reset
  // identities are stable via useCallback, but listing them would tie
  // this effect to every state.* update and cause a re-GET on every
  // transition — React's exhaustive-deps warning is suppressed with a
  // targeted comment.
  //
  // Identity changes while still authenticated (account switch via a
  // second /login without an intervening logout) must reset the cache
  // BEFORE re-loading, otherwise the single-flight cache check inside
  // load() would happily return the previous user's LOCKED snapshot.
  //
  // The auto-load is safe alongside Login.js's fire-and-forget
  // unlockWithMaster: load() is single-flight, so whichever of the two
  // fires first kicks off the GET and the other coalesces onto it.
  // -----------------------------------------------------------------------
  const prevUserIdRef = useRef(null);
  useEffect(() => {
    if (isAuthenticated && userId != null) {
      if (
        prevUserIdRef.current !== null &&
        prevUserIdRef.current !== userId
      ) {
        // Account switch while authenticated. Drop every trace of the
        // prior user (state, DataKey, in-flight load) before we issue
        // the new user's GET.
        reset();
      }
      prevUserIdRef.current = userId;
      load().catch(() => {
        // Swallowed: load() has already captured the error into state.
      });
    } else {
      prevUserIdRef.current = null;
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, userId]);

  // Test-only accessor: returns true iff a DataKey is currently held in
  // memory. Used by VaultContext.test.js to assert wipe-on-reset and
  // wipe-on-stale-unlock invariants that aren't otherwise observable
  // through the public state machine. Prefixed to discourage accidental
  // production use; no application code reads it.
  const hasDataKeyForTest = useCallback(() => dkRef.current !== null, []);

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
      _hasDataKeyForTest: hasDataKeyForTest,
    }),
    [state, load, unlock, unlockWithMaster, lock, reset, hasDataKeyForTest]
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
