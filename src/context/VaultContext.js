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
import {
  decryptEnvelope,
  encryptEnvelope,
  generateDataKey,
} from '../lib/crypto/envelope';

// ---------------------------------------------------------------------------
// VaultContext
//
// Owns the client-side vault lifecycle. Deliberately a sibling of
// AuthContext (not merged into it) because vault concerns — network errors
// to /vault, wrong-password unlock attempts, ETag bookkeeping — shouldn't
// pollute the login flow.
//
// This context covers: load / unlock / lock / save (both the empty→first
// bootstrap and the unlocked→update path). The saltV used to derive
// vaultKey comes from AuthContext.user.saltV — a per-user property
// delivered by /auth/login and /auth/me (migration 004).
//
// State machine (`status`):
//
//   idle        No /auth/me hydration yet.
//   loading     GET /vault in flight.
//   empty       No vault row server-side. The Account page's import
//               flow transitions this → unlocked by collecting a
//               password and calling save({ password, email }).
//   locked      Vault row exists; we have the blob cached but no
//               DataKey/vaultKey in memory. Caller must unlock(...).
//   unlocked    DataKey AND vaultKey held in refs; `data` reflects the
//               last-decrypted / last-saved payload.
//   saving     *sub-state of unlocked/empty*: save() in flight.
//               We expose it as `isSaving` rather than a top-level
//               status so callers don't need to snapshot-then-restore
//               the previous state; save() errors leave status where
//               it was.
//   error       Last operation failed; see `error` for a code.
//
// Transitions wired from AuthContext:
//
//   isAuthenticated=true, user.id new                -> reset + load()
//   isAuthenticated=true, user.id same as previous   -> noop
//   isAuthenticated=false                            -> hard-reset
//
// Identity is keyed on `user.id`, not just `isAuthenticated`, because a
// user can switch accounts without an intervening logout. Keying only on
// `isAuthenticated` would leave the prior user's cached blob in state
// and make every unlock attempt by the new user fail with
// envelope_decrypt_failed until a full reload.
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
//
// Key material in memory
// ----------------------
// When UNLOCKED we hold TWO secrets in refs (not state):
//
//   dkRef         Uint8Array(32)  — the Data Key bytes. Used to encrypt /
//                                   decrypt the payload portion of the
//                                   SYSV2 envelope.
//   vaultKeyRef   CryptoKey       — non-extractable AES-GCM key derived
//                                   from HKDF(master, saltV). Used to
//                                   re-wrap the DK on every save.
//
// Both are wiped together on lock() / reset(). The invariant we enforce
// is: `vaultKeyRef !== null  ⇔  dkRef !== null  ⇔  status === UNLOCKED`.
// (Violating this means either a locked-but-keys-in-memory state or
// an unlocked-but-cannot-save state, both of which are bugs.)
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
    etag: null,
    blob: null,
    data: null,
    saving: false,
  };
}

function snapshotOf(s) {
  return {
    status: s.status,
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
  // saltV is a per-user property sourced from AuthContext; VaultContext
  // does NOT hold its own copy because it must always match the
  // authenticated user's identity. Reading via useAuth() inside each
  // callback guarantees that an account-switch picks up the new saltV.
  const userSaltV = user && typeof user.saltV === 'string' ? user.saltV : null;
  const userEmail = user && typeof user.email === 'string' ? user.email : null;

  const [state, setStateInner] = useState(blankState);

  // DataKey bytes while unlocked. Stored in refs rather than state so a
  // React render can't accidentally leak them into memoized props /
  // devtools diffs.
  const dkRef = useRef(null);
  // AES-GCM CryptoKey (non-extractable) derived from master+saltV at
  // unlock / first-save time. Cached so save() can re-wrap the DK
  // without re-running HKDF on each edit.
  const vaultKeyRef = useRef(null);

  // Monotonic request counter. Same pattern AuthContext uses for
  // refresh/login: every async op captures the counter value at its
  // start and only writes state if it's still current. Protects
  // against a slow GET /vault landing after the user has already
  // logged out.
  const genRef = useRef(0);
  // Session counter — bumped ONLY on reset(). genRef bumps far more
  // often, so an unlock that captures genRef at its start will look
  // "stale" even in the happy path. unlockWithMaster therefore
  // captures sessionGenRef instead: it's a tight fingerprint of "the
  // identity I started working for" and changes iff reset() has torn
  // down state between the unlock's decrypt and its commit. Without
  // this, a logout racing a mid-flight decrypt would drop the state
  // write (via the genRef check) but still install dk into dkRef,
  // leaving key material in memory after auth loss. (Codex round 2
  // P2, PR 3.)
  const sessionGenRef = useRef(0);
  const mountedRef = useRef(true);

  // Synchronous mirror of `state`, updated inside the commit() callback
  // so async code can read the latest committed snapshot before React
  // schedules the next render. Needed for the cache short-circuit in
  // load(): after doLoad() resolves, unlockWithMaster must see LOCKED,
  // not the pre-commit LOADING.
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

  const commit = useCallback((patch, myGen) => {
    if (!mountedRef.current) return;
    if (typeof myGen === 'number' && myGen !== genRef.current) return;
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setStateInner(next);
  }, []);

  const wipeKeys = useCallback(() => {
    // Clearing dkRef.current doesn't zero the Uint8Array's backing
    // buffer — JS has no reliable way to do that, and the garbage
    // collector will eventually reclaim it. What we CAN guarantee is
    // that no code path inside VaultContext can reach the bytes once
    // the ref is null: every consumer reads them through the ref.
    dkRef.current = null;
    vaultKeyRef.current = null;
  }, []);

  const reset = useCallback(() => {
    bumpGen();
    sessionGenRef.current += 1;
    wipeKeys();
    inflightLoadRef.current = null;
    const blank = blankState();
    stateRef.current = blank;
    if (mountedRef.current) setStateInner(blank);
  }, [bumpGen, wipeKeys]);

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
  // -----------------------------------------------------------------------
  const load = useCallback(() => {
    const s = stateRef.current;
    if (s.status === LOCKED || s.status === UNLOCKED || s.status === EMPTY) {
      return Promise.resolve(snapshotOf(s));
    }
    if (inflightLoadRef.current) return inflightLoadRef.current;

    const p = doLoad();
    inflightLoadRef.current = p;
    p.catch(() => {}).then(() => {
      if (inflightLoadRef.current === p) inflightLoadRef.current = null;
    });
    return p;
  }, [doLoad]);

  // -----------------------------------------------------------------------
  // Internal: actually perform the decrypt. Returns {data, dk, vaultKey}
  // WITHOUT stashing anything in refs. The caller must do the gen /
  // session check immediately before installing the keys — otherwise a
  // logout-during-unlock race would leave key material in memory after
  // state has already been reset. (Codex round 2 P2.)
  // -----------------------------------------------------------------------
  const decryptWithMaster = useCallback(async (master, snapshot, saltV) => {
    const vaultKey = await deriveVaultKey(master, saltV);
    const { data, dk } = await decryptEnvelope(snapshot.blob, vaultKey);
    return { data, dk, vaultKey };
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
      if (!userSaltV) {
        // No saltV on the authenticated user object: either AuthContext
        // hasn't hydrated yet, or the backend regressed and dropped
        // saltV from /auth/me. Fail loudly rather than deriving with
        // an empty salt (which would produce a deterministic wrong
        // vaultKey and then an opaque envelope_decrypt_failed).
        const e = new Error('missing_salt_v');
        e.code = 'missing_salt_v';
        throw e;
      }

      const startingSession = sessionGenRef.current;

      let snapshot;
      try {
        snapshot = await load();
      } catch (err) {
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

      const myGen = bumpGen();

      let decrypted;
      try {
        decrypted = await decryptWithMaster(master, snapshot, userSaltV);
      } catch (err) {
        // Decryption failed. Invariant preservation:
        //   (1) LOCKED must never retain keys. decryptWithMaster never
        //       touched the refs, but the vault may have been UNLOCKED
        //       with PRIOR keys when this attempt started (e.g. a
        //       second unlock attempt against an already-unlocked
        //       vault). Wipe on LOCKED transition. (Codex round 3 P2,
        //       PR 3.)
        //   (2) Don't stomp a concurrent winning unlock.
        if (
          mountedRef.current &&
          sessionGenRef.current === startingSession &&
          myGen === genRef.current
        ) {
          wipeKeys();
          commit(
            {
              status: LOCKED,
              error: (err && err.code) || 'unlock_failed',
              etag: snapshot.etag,
              blob: snapshot.blob,
              data: null,
            },
            myGen
          );
        }
        throw err;
      }

      // Gate key install. genRef alone isn't sufficient because our
      // own bumpGen() above advanced it past any intervening reset,
      // leaving a stale unlock looking current. sessionGenRef bumps
      // ONLY on reset(), so a mismatch there is the authoritative
      // "identity gone, don't install keys" signal. Between this
      // check and the subsequent commit there are no awaits, so no
      // window for a concurrent reset() to slip in.
      if (
        !mountedRef.current ||
        sessionGenRef.current !== startingSession ||
        myGen !== genRef.current
      ) {
        return { status: 'stale' };
      }
      dkRef.current = decrypted.dk;
      vaultKeyRef.current = decrypted.vaultKey;
      commit(
        {
          status: UNLOCKED,
          error: null,
          etag: snapshot.etag,
          blob: snapshot.blob,
          data: decrypted.data,
        },
        myGen
      );
      return { status: UNLOCKED };
    },
    [load, bumpGen, commit, decryptWithMaster, wipeKeys, userSaltV]
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
  // save(newPayload, opts?)
  //
  // Unified write path:
  //   - UNLOCKED path: re-encrypt under the cached (dk, vaultKey). No
  //     password prompt; no KDF; just AES-GCM + one PUT. Uses the
  //     current etag for optimistic concurrency.
  //   - EMPTY path: requires opts.password + opts.email (both strings).
  //     Derive master → vaultKey (from user.saltV) → generate a fresh
  //     DK → encrypt → PUT with If-Match: '*'. On success, install dk
  //     and vaultKey in refs and transition EMPTY → UNLOCKED in one
  //     shot.
  //   - Any other status: throws 'vault_not_ready'.
  //
  // Errors are NEVER committed to state.error — save() is a foreground
  // user action and the caller owns the error UI (toast / inline
  // message). Background errors (auth load, auto-unlock) still commit
  // so the passive status card renders correctly.
  //
  // Concurrency: save bumps gen inside its state writes (saving true,
  // saving false, or unlocked transition). Two rapid clicks will both
  // enter `saving: true`; the second one will observe stateRef.saving
  // and bail with 'save_in_progress'.
  // -----------------------------------------------------------------------
  const save = useCallback(
    async (newPayload, opts) => {
      const current = stateRef.current;

      if (current.saving) {
        const e = new Error('save_in_progress');
        e.code = 'save_in_progress';
        throw e;
      }

      const isEmpty = current.status === EMPTY;
      const isUnlocked = current.status === UNLOCKED;

      if (!isEmpty && !isUnlocked) {
        const e = new Error('vault_not_ready');
        e.code = 'vault_not_ready';
        throw e;
      }

      // Capture the session so a concurrent reset() invalidates us.
      const startingSession = sessionGenRef.current;

      // Mark saving=true. Do NOT move status — if we're UNLOCKED and
      // something fails, we stay UNLOCKED and surface the error to
      // the caller only. (Pages show the error; the status card
      // remains "Unlocked".)
      {
        const myGen = bumpGen();
        commit({ saving: true }, myGen);
      }

      async function finish(patch, myGen) {
        if (!mountedRef.current) return;
        if (sessionGenRef.current !== startingSession) return;
        commit({ ...patch, saving: false }, myGen);
      }

      try {
        let dk;
        let vaultKey;
        let ifMatch;

        if (isEmpty) {
          if (!opts || typeof opts.password !== 'string' || !opts.password) {
            const e = new Error('password_required');
            e.code = 'password_required';
            throw e;
          }
          const email = opts.email || userEmail;
          if (!email) {
            const e = new Error('email_required');
            e.code = 'email_required';
            throw e;
          }
          if (!userSaltV) {
            const e = new Error('missing_salt_v');
            e.code = 'missing_salt_v';
            throw e;
          }
          const master = await deriveMaster(opts.password, email);
          vaultKey = await deriveVaultKey(master, userSaltV);
          dk = generateDataKey();
          ifMatch = '*';
        } else {
          // UNLOCKED. Re-use cached keys.
          dk = dkRef.current;
          vaultKey = vaultKeyRef.current;
          if (!dk || !vaultKey) {
            // Invariant violation: status === UNLOCKED but refs are
            // null. Only possible if reset() fired between our
            // status read and here — treat as session loss.
            const e = new Error('vault_locked_out');
            e.code = 'vault_locked_out';
            throw e;
          }
          ifMatch = current.etag || undefined;
        }

        const blob = await encryptEnvelope(newPayload, dk, vaultKey);

        // Re-check session after the await train. If we logged out
        // mid-encrypt we don't want to PUT under the new user's
        // session cookie.
        if (sessionGenRef.current !== startingSession) {
          const e = new Error('session_changed');
          e.code = 'session_changed';
          throw e;
        }

        const result = await vaultService.save({ blob, ifMatch });

        // If the session churned during the network round-trip,
        // drop the response on the floor. Do NOT commit keys or
        // blob — they belong to an identity that's no longer
        // active. The server has accepted our write, but there's
        // nothing for this provider to do with it.
        if (sessionGenRef.current !== startingSession) {
          const e = new Error('session_changed');
          e.code = 'session_changed';
          throw e;
        }

        // If the user called lock() while the PUT was in flight, the
        // refs have already been wiped and the status moved to
        // LOCKED. Honour that — don't re-expose plaintext or
        // re-install keys. The server has persisted the new blob
        // (that's fine); the next unlock will GET the fresh blob and
        // matching etag, so nothing to track here.
        if (stateRef.current.status === LOCKED) {
          const e = new Error('vault_locked_during_save');
          e.code = 'vault_locked_during_save';
          throw e;
        }

        const myGen = bumpGen();
        if (isEmpty) {
          // Only install keys on the EMPTY→UNLOCKED promotion. For
          // update paths the refs are already populated.
          if (mountedRef.current) {
            dkRef.current = dk;
            vaultKeyRef.current = vaultKey;
          }
        }
        await finish(
          {
            status: UNLOCKED,
            error: null,
            etag: result.etag,
            blob,
            data: newPayload,
          },
          myGen
        );

        return { status: UNLOCKED, etag: result.etag };
      } catch (err) {
        // Clear the saving flag without mutating status. The caller
        // owns the error surface.
        const myGen = bumpGen();
        await finish({}, myGen);
        throw err;
      }
    },
    [
      bumpGen,
      commit,
      vaultService,
      userSaltV,
      userEmail,
    ]
  );

  // -----------------------------------------------------------------------
  // lock()
  //
  // Voluntary lock: wipe keys + payload. Keeps the blob pointer cached
  // so the next unlock doesn't re-GET.
  // -----------------------------------------------------------------------
  const lock = useCallback(() => {
    wipeKeys();
    const s = stateRef.current;
    if (s.status !== UNLOCKED && s.status !== LOCKED) return;
    const myGen = bumpGen();
    commit({ status: LOCKED, data: null, error: null }, myGen);
  }, [bumpGen, commit, wipeKeys]);

  // -----------------------------------------------------------------------
  // Auth lifecycle hooks.
  // -----------------------------------------------------------------------
  const prevUserIdRef = useRef(null);
  useEffect(() => {
    if (isAuthenticated && userId != null) {
      if (
        prevUserIdRef.current !== null &&
        prevUserIdRef.current !== userId
      ) {
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

  const hasDataKeyForTest = useCallback(() => dkRef.current !== null, []);
  const hasVaultKeyForTest = useCallback(
    () => vaultKeyRef.current !== null,
    []
  );

  const value = useMemo(
    () => ({
      status: state.status,
      error: state.error,
      data: state.data,
      etag: state.etag,
      isIdle: state.status === IDLE,
      isLoading: state.status === LOADING,
      isEmpty: state.status === EMPTY,
      isLocked: state.status === LOCKED,
      isUnlocked: state.status === UNLOCKED,
      isError: state.status === ERROR,
      isSaving: state.saving === true,
      load,
      unlock,
      unlockWithMaster,
      save,
      lock,
      reset,
      _hasDataKeyForTest: hasDataKeyForTest,
      _hasVaultKeyForTest: hasVaultKeyForTest,
    }),
    [
      state,
      load,
      unlock,
      unlockWithMaster,
      save,
      lock,
      reset,
      hasDataKeyForTest,
      hasVaultKeyForTest,
    ]
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
