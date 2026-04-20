import React from 'react';
import { render, act, waitFor } from '@testing-library/react';

// Tests that drive a full PBKDF2-SHA512 @ 600k iterations (the real
// KDF, not a mock — we want to prove end-to-end crypto correctness)
// can take 10+ seconds in jsdom under parallel Jest workers. Give
// those tests enough headroom that they aren't the source of flakes
// when the suite is run alongside the other 15 files.
const PBKDF2_TIMEOUT_MS = 30000;

import { AuthProvider } from './AuthContext';
import { VaultProvider, useVault, __testing } from './VaultContext';
import {
  encryptEnvelope,
  decryptEnvelope,
  generateDataKey,
} from '../lib/crypto/envelope';
import { deriveMaster, deriveVaultKey } from '../lib/crypto/kdf';

const { STATUS } = __testing;

// Canonical per-user saltV used by the auth-service stub. Tests that
// want a different saltV (to simulate account-switch) pass one in.
const SALT_A = 'ab'.repeat(32);
const SALT_B = 'cd'.repeat(32);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Stubs the AuthContext's authService so it reports an authenticated user
// immediately. saltV is part of the user identity now (migration 004) —
// VaultContext reads it from useAuth().user.saltV rather than from the
// /vault response.
function authedAuthService({
  email = 'user@example.com',
  id = 1,
  saltV = SALT_A,
} = {}) {
  return {
    me: jest.fn().mockResolvedValue({
      user: {
        id,
        email,
        emailVerified: true,
        notificationPrefs: {},
        saltV,
      },
    }),
    login: jest.fn(),
    logout: jest.fn().mockResolvedValue({}),
    register: jest.fn(),
    verifyEmail: jest.fn(),
  };
}

// Stubs the AuthContext to stay anonymous — useful for the "no auto-load"
// assertion.
function anonymousAuthService() {
  const err = new Error('unauthorized');
  err.status = 401;
  return {
    me: jest.fn().mockRejectedValue(err),
    login: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    verifyEmail: jest.fn(),
  };
}

function VaultObserver({ onValue }) {
  const v = useVault();
  React.useEffect(() => {
    onValue(v);
  });
  return null;
}

function renderWithProviders({ authService, vaultService, onVault }) {
  return render(
    <AuthProvider authService={authService}>
      <VaultProvider vaultService={vaultService}>
        <VaultObserver onValue={onVault} />
      </VaultProvider>
    </AuthProvider>
  );
}

// Produce a freshly-encrypted vault blob matching the given saltV. The
// auth stub MUST return the same saltV as the one used here, otherwise
// unlock derives a different vaultKey and decryption fails.
async function makeEncryptedBlobFor({
  password = 'correct horse battery',
  email = 'user@example.com',
  saltV = SALT_A,
  data = { keys: [{ label: 'a', wif: 'KxFoo...' }] },
}) {
  const master = await deriveMaster(password, email);
  const vaultKey = await deriveVaultKey(master, saltV);
  const dk = generateDataKey();
  const blob = await encryptEnvelope(data, dk, vaultKey);
  return { master, saltV, blob, data };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VaultProvider — auth wiring', () => {
  test('does not fetch the vault while unauthenticated', async () => {
    const vaultService = {
      load: jest.fn(),
      save: jest.fn(),
    };
    const values = [];
    renderWithProviders({
      authService: anonymousAuthService(),
      vaultService,
      onVault: (v) => values.push(v.status),
    });
    await waitFor(() => {
      expect(values[values.length - 1]).toBe(STATUS.IDLE);
    });
    expect(vaultService.load).not.toHaveBeenCalled();
  });

  test('auto-runs load() once authenticated and lands in EMPTY when backend has no vault', async () => {
    const vaultService = {
      load: jest.fn().mockResolvedValue({ empty: true }),
      save: jest.fn(),
    };
    const values = [];
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => values.push(v.status),
    });
    await waitFor(() => {
      expect(values[values.length - 1]).toBe(STATUS.EMPTY);
    });
    expect(vaultService.load).toHaveBeenCalledTimes(1);
  });

  test('lands in LOCKED when backend returns a blob', async () => {
    const { blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E1' }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => {
      expect(last.status).toBe(STATUS.LOCKED);
    });
    expect(last.data).toBeNull();
    expect(last.etag).toBe('E1');
  });

  test('lands in ERROR when GET /vault fails and keeps the code surfaced', async () => {
    const err = new Error('server_error');
    err.code = 'internal';
    err.status = 500;
    const vaultService = {
      load: jest.fn().mockRejectedValue(err),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.ERROR));
    expect(last.error).toBe('internal');
  });
});

describe('VaultProvider — unlock with master (login auto-unlock path)', () => {
  test('decrypts the blob and exposes the plaintext', async () => {
    const { master, blob, data } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E' }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));

    await act(async () => {
      await last.unlockWithMaster(master);
    });
    await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));
    expect(last.data).toEqual(data);
  });

  test('wrong master lands in LOCKED with unlock_failed and keeps the blob cached', async () => {
    const { blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E' }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));

    let caught;
    await act(async () => {
      try {
        await last.unlockWithMaster(new Uint8Array(32).fill(9));
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toMatchObject({ code: 'envelope_decrypt_failed' });

    await waitFor(() => expect(last.error).toBe('envelope_decrypt_failed'));
    expect(last.status).toBe(STATUS.LOCKED);
  });

  test('throws on a non-32-byte master without touching the service', async () => {
    const vaultService = {
      load: jest.fn().mockResolvedValue({ empty: true }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.EMPTY));
    vaultService.load.mockClear();

    await expect(
      act(async () => {
        await last.unlockWithMaster(new Uint8Array(16));
      })
    ).rejects.toMatchObject({ code: 'master_key_required' });
    expect(vaultService.load).not.toHaveBeenCalled();
  });

  test('empty-vault unlockWithMaster lands in EMPTY and does not invoke the KDF', async () => {
    const vaultService = {
      load: jest.fn().mockResolvedValue({ empty: true }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.EMPTY));

    await act(async () => {
      const out = await last.unlockWithMaster(new Uint8Array(32));
      expect(out.status).toBe(STATUS.EMPTY);
    });
    expect(last.status).toBe(STATUS.EMPTY);
  });
});

describe('VaultProvider — unlock({password,email}) (reload path)', () => {
  test('derives master from password+email and unlocks', async () => {
    const password = 'super secret';
    const email = 'me@example.com';
    const { blob, data } = await makeEncryptedBlobFor({ password, email });
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E' }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService({ email }),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));

    await act(async () => {
      await last.unlock({ password, email });
    });
    expect(last.status).toBe(STATUS.UNLOCKED);
    expect(last.data).toEqual(data);
  }, PBKDF2_TIMEOUT_MS);

  test('rejects an empty password', async () => {
    const { blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E' }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));

    await expect(
      act(async () => {
        await last.unlock({ password: '', email: 'a@b.com' });
      })
    ).rejects.toMatchObject({ code: 'password_required' });
  });

  test('unlockWithMaster defers saltV gate so Login auto-unlock can race auth hydration (Codex round 2 P1)', async () => {
    // Real-world scenario:
    //   1. Login's login() resolves. AuthContext queues setUser(...).
    //   2. Login's .then (same microtask) calls
    //      vault.unlockWithMaster(master).
    //   3. React has NOT yet committed the AuthProvider re-render,
    //      so the captured unlockWithMaster callback sees
    //      userSaltV = null at call time.
    //
    // Pre-fix the saltV check ran synchronously at the top of the
    // callback and threw, cancelling the auto-unlock. The fix
    // defers the check until after `await load()` — by then React
    // has had a chance to commit the AuthProvider update and
    // populate userSaltVRef.current via the render-body assignment.
    //
    // Minimal regression assertion: with anonymous auth (saltV
    // will stay null forever), unlockWithMaster still invokes
    // vaultService.load() before rejecting. Pre-fix, load() would
    // have zero calls because the saltV check short-circuited.
    const vaultService = {
      load: jest.fn().mockResolvedValue({ empty: true }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: anonymousAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.IDLE));

    const master = new Uint8Array(32);
    master[0] = 1;

    // unlockWithMaster must NOT throw missing_salt_v synchronously.
    // It should enter load() first — that's what gives a real
    // Login-initiated call its opportunity to observe a newly
    // committed saltV.
    let rejection;
    await act(async () => {
      rejection = await last
        .unlockWithMaster(master)
        .then(() => null, (err) => err);
    });

    expect(rejection).toBeTruthy();
    expect(rejection.code).toBe('missing_salt_v');
    // The critical behavioural assertion: the synchronous gate is
    // gone, so load() had a chance to run (and in the real race it
    // would have yielded long enough for React to flush the user
    // hydration).
    expect(vaultService.load).toHaveBeenCalledTimes(1);
  });
});

describe('VaultProvider — lock + logout', () => {
  test('lock() wipes the plaintext but keeps the cached blob', async () => {
    const { master, blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E' }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    await act(async () => {
      await last.unlockWithMaster(master);
    });
    await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));

    act(() => last.lock());
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    expect(last.data).toBeNull();
    expect(last.etag).toBe('E');
    // Both key refs wiped on lock — enforces the invariant that
    // status === LOCKED ⇒ no keys in memory.
    expect(last._hasDataKeyForTest()).toBe(false);
    expect(last._hasVaultKeyForTest()).toBe(false);
  });

  test('hard-resets and wipes state when auth transitions to anonymous', async () => {
    const { master, blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E' }),
      save: jest.fn(),
    };

    const authService = authedAuthService();
    let last;
    let authSnapshot;
    function AuthObserver() {
      // eslint-disable-next-line global-require
      const { useAuth } = require('./AuthContext');
      authSnapshot = useAuth();
      return null;
    }
    render(
      <AuthProvider authService={authService}>
        <AuthObserver />
        <VaultProvider vaultService={vaultService}>
          <VaultObserver onValue={(v) => (last = v)} />
        </VaultProvider>
      </AuthProvider>
    );

    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    await act(async () => {
      await last.unlockWithMaster(master);
    });
    await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));

    await act(async () => {
      await authSnapshot.logout();
    });
    await waitFor(() => expect(last.status).toBe(STATUS.IDLE));
    expect(last.data).toBeNull();
    expect(last.etag).toBeNull();
    expect(last._hasDataKeyForTest()).toBe(false);
    expect(last._hasVaultKeyForTest()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codex review round 1 — concurrency regressions (PR 3).
//
// P1 (race): the auth-effect load() and Login's fire-and-forget
// unlockWithMaster(master) both ran to completion unconditionally, and
// whichever bumped gen last invalidated the other's commit — so the
// UNLOCKED write could land as a no-op and the user would see LOCKED
// despite decryption having succeeded.
//
// P2 (cache): unlockWithMaster unconditionally re-GETed /vault even when
// state already held a fresh blob/saltV, so offline relock-then-unlock
// failed with a load error instead of decrypting from cache.
// ---------------------------------------------------------------------------
describe('VaultProvider — load() single-flight + cache (Codex round 1)', () => {
  test('auth-effect load and unlockWithMaster coalesce onto one GET and land in UNLOCKED (P1)', async () => {
    const { master, blob, data } = await makeEncryptedBlobFor({});

    let resolveLoad;
    const loadGate = new Promise((resolve) => {
      resolveLoad = resolve;
    });
    const vaultService = {
      load: jest.fn().mockImplementation(() => loadGate),
      save: jest.fn(),
    };

    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });

    await waitFor(() => expect(last.status).toBe(STATUS.LOADING));
    expect(vaultService.load).toHaveBeenCalledTimes(1);

    let unlockErr = null;
    const unlockPromise = last
      .unlockWithMaster(master)
      .catch((e) => {
        unlockErr = e;
      });

    expect(vaultService.load).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLoad({ empty: false, blob, etag: 'E' });
      await unlockPromise;
    });

    expect(unlockErr).toBeNull();
    expect(last.status).toBe(STATUS.UNLOCKED);
    expect(last.data).toEqual(data);
    expect(vaultService.load).toHaveBeenCalledTimes(1);
  });

  test('unlockWithMaster reuses the cached snapshot after initial load (P2)', async () => {
    const { master, blob, data } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E' }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    expect(vaultService.load).toHaveBeenCalledTimes(1);

    vaultService.load.mockImplementation(() => {
      throw new Error('network should not have been touched');
    });

    await act(async () => {
      await last.unlockWithMaster(master);
    });
    expect(last.status).toBe(STATUS.UNLOCKED);
    expect(last.data).toEqual(data);
    expect(vaultService.load).toHaveBeenCalledTimes(1);
  });

  test('resets and refetches when authenticated identity changes without logout (P1 round 2)', async () => {
    const blobA = await makeEncryptedBlobFor({
      password: 'pw-a',
      email: 'a@example.com',
      saltV: SALT_A,
      data: { keys: [{ label: 'A' }] },
    });
    const blobB = await makeEncryptedBlobFor({
      password: 'pw-b',
      email: 'b@example.com',
      saltV: SALT_B,
      data: { keys: [{ label: 'B' }] },
    });

    const meResults = [
      {
        user: {
          id: 1,
          email: 'a@example.com',
          emailVerified: true,
          notificationPrefs: {},
          saltV: SALT_A,
        },
      },
      {
        user: {
          id: 2,
          email: 'b@example.com',
          emailVerified: true,
          notificationPrefs: {},
          saltV: SALT_B,
        },
      },
    ];
    const me = jest.fn().mockImplementation(() => {
      const next = meResults.shift();
      return Promise.resolve(next || meResults[meResults.length] || me.lastResult);
    });
    const login = jest.fn().mockResolvedValue({
      user: {
        id: 2,
        email: 'b@example.com',
        emailVerified: true,
        notificationPrefs: {},
        saltV: SALT_B,
      },
      master: blobB.master,
    });
    const authService = {
      me,
      login,
      logout: jest.fn().mockResolvedValue({}),
      register: jest.fn(),
      verifyEmail: jest.fn(),
    };

    const load = jest
      .fn()
      .mockResolvedValueOnce({
        empty: false,
        blob: blobA.blob,
        etag: 'Ea',
      })
      .mockResolvedValueOnce({
        empty: false,
        blob: blobB.blob,
        etag: 'Eb',
      });
    const vaultService = { load, save: jest.fn() };

    let last;
    let authSnapshot;
    function AuthObserver() {
      // eslint-disable-next-line global-require
      const { useAuth } = require('./AuthContext');
      authSnapshot = useAuth();
      return null;
    }
    render(
      <AuthProvider authService={authService}>
        <AuthObserver />
        <VaultProvider vaultService={vaultService}>
          <VaultObserver onValue={(v) => (last = v)} />
        </VaultProvider>
      </AuthProvider>
    );

    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    expect(last.etag).toBe('Ea');
    await act(async () => {
      await last.unlockWithMaster(blobA.master);
    });
    await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));
    expect(last.data).toEqual(blobA.data);

    await act(async () => {
      await authSnapshot.login({
        email: 'b@example.com',
        password: 'pw-b',
      });
    });

    await waitFor(() => expect(last.etag).toBe('Eb'));
    expect(last.status).toBe(STATUS.LOCKED);
    expect(last.data).toBeNull();
    expect(last._hasDataKeyForTest()).toBe(false);
    expect(last._hasVaultKeyForTest()).toBe(false);

    await act(async () => {
      await last.unlockWithMaster(blobB.master);
    });
    expect(last.status).toBe(STATUS.UNLOCKED);
    expect(last.data).toEqual(blobB.data);
    expect(vaultService.load).toHaveBeenCalledTimes(2);
  });

  test('stale unlock (reset mid-decrypt) does not leak keys into refs (P2 round 2)', async () => {
    const { master, blob } = await makeEncryptedBlobFor({});

    let resolveLoad;
    const gate = new Promise((r) => {
      resolveLoad = r;
    });
    const vaultService = {
      load: jest.fn().mockImplementation(() => gate),
      save: jest.fn(),
    };

    const authService = authedAuthService();
    let last;
    let authSnapshot;
    function AuthObserver() {
      // eslint-disable-next-line global-require
      const { useAuth } = require('./AuthContext');
      authSnapshot = useAuth();
      return null;
    }
    render(
      <AuthProvider authService={authService}>
        <AuthObserver />
        <VaultProvider vaultService={vaultService}>
          <VaultObserver onValue={(v) => (last = v)} />
        </VaultProvider>
      </AuthProvider>
    );

    await waitFor(() => expect(last.status).toBe(STATUS.LOADING));

    const unlockPromise = last.unlockWithMaster(master).catch(() => {});

    await act(async () => {
      await authSnapshot.logout();
    });

    await act(async () => {
      resolveLoad({ empty: false, blob, etag: 'E' });
      await unlockPromise;
    });

    expect(last.status).toBe(STATUS.IDLE);
    expect(last._hasDataKeyForTest()).toBe(false);
    expect(last._hasVaultKeyForTest()).toBe(false);
  });

  test('failed unlock from an UNLOCKED vault wipes keys before landing in LOCKED (P2 round 3)', async () => {
    const { master, blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E' }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));

    await act(async () => {
      await last.unlockWithMaster(master);
    });
    await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));
    expect(last._hasDataKeyForTest()).toBe(true);
    expect(last._hasVaultKeyForTest()).toBe(true);

    let caught;
    await act(async () => {
      try {
        await last.unlockWithMaster(new Uint8Array(32).fill(7));
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toMatchObject({ code: 'envelope_decrypt_failed' });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    expect(last.error).toBe('envelope_decrypt_failed');
    expect(last._hasDataKeyForTest()).toBe(false);
    expect(last._hasVaultKeyForTest()).toBe(false);
  });

  test('lock() followed by unlockWithMaster decrypts from cache without a re-GET (P2)', async () => {
    const { master, blob, data } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E' }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    await act(async () => {
      await last.unlockWithMaster(master);
    });
    await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));

    act(() => last.lock());
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));

    vaultService.load.mockClear();
    await act(async () => {
      await last.unlockWithMaster(master);
    });
    expect(last.status).toBe(STATUS.UNLOCKED);
    expect(last.data).toEqual(data);
    expect(vaultService.load).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// save() — the write path (PR 4).
//
// Two shapes:
//
//   (a) EMPTY → UNLOCKED   First write. Requires {password, email}.
//                          Derives master (→ vaultKey from user.saltV),
//                          generates a fresh DK, encrypts under the new
//                          vaultKey/DK, PUTs with If-Match: '*'. On
//                          success the keys are installed in refs and
//                          the state transitions straight to UNLOCKED.
//
//   (b) UNLOCKED → UNLOCKED  Update. Re-uses the cached (dk, vaultKey).
//                            Sends the current etag as If-Match; server
//                            rejects with vault_stale if someone else
//                            wrote in between.
// ---------------------------------------------------------------------------
describe('VaultProvider — save() first write (EMPTY → UNLOCKED)', () => {
  test('encrypts under a fresh DK, PUTs with *, installs keys, transitions UNLOCKED', async () => {
    const password = 'hunter22a';
    const email = 'new@example.com';
    const saltV = SALT_A;
    const data = { keys: [{ label: 'mn1', wif: 'KxFoo...' }] };

    let capturedBlob = null;
    let capturedIfMatch = null;
    const vaultService = {
      load: jest.fn().mockResolvedValue({ empty: true }),
      save: jest.fn().mockImplementation(({ blob, ifMatch }) => {
        capturedBlob = blob;
        capturedIfMatch = ifMatch;
        return Promise.resolve({ etag: 'NEW_ETAG' });
      }),
    };

    let last;
    renderWithProviders({
      authService: authedAuthService({ email, saltV }),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.EMPTY));

    await act(async () => {
      const out = await last.save(data, { password, email });
      expect(out.status).toBe(STATUS.UNLOCKED);
      expect(out.etag).toBe('NEW_ETAG');
    });

    // After first-write we MUST be UNLOCKED with the payload available
    // — no intermediate LOCKED state that would force the user to
    // unlock again.
    expect(last.status).toBe(STATUS.UNLOCKED);
    expect(last.data).toEqual(data);
    expect(last.etag).toBe('NEW_ETAG');
    expect(last._hasDataKeyForTest()).toBe(true);
    expect(last._hasVaultKeyForTest()).toBe(true);

    // If-Match: * identifies a first-write. Any concrete etag would
    // be a client bug here.
    expect(capturedIfMatch).toBe('*');

    // And the produced blob must actually round-trip: derive the
    // user's vaultKey the same way save() did and confirm the server
    // received a valid SYSV2 envelope.
    const masterVerify = await deriveMaster(password, email);
    const vaultKeyVerify = await deriveVaultKey(masterVerify, saltV);
    const decrypted = await decryptEnvelope(capturedBlob, vaultKeyVerify);
    expect(decrypted.data).toEqual(data);
  }, PBKDF2_TIMEOUT_MS);

  test('first write rejects missing password', async () => {
    const vaultService = {
      load: jest.fn().mockResolvedValue({ empty: true }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.EMPTY));

    await expect(
      act(async () => {
        await last.save({ keys: [] }, { email: 'x@y.com' });
      })
    ).rejects.toMatchObject({ code: 'password_required' });
    expect(vaultService.save).not.toHaveBeenCalled();
    // Error must NOT promote us out of EMPTY — caller retries.
    expect(last.status).toBe(STATUS.EMPTY);
    expect(last._hasDataKeyForTest()).toBe(false);
  });

  test('first write rejects when user has no saltV on their identity', async () => {
    const vaultService = {
      load: jest.fn().mockResolvedValue({ empty: true }),
      save: jest.fn(),
    };
    let last;
    // Build an authService that surfaces a user without saltV —
    // simulates a regressed backend or missing migration.
    const brokenAuth = {
      me: jest.fn().mockResolvedValue({
        user: { id: 1, email: 'x@y.com', emailVerified: true },
      }),
      login: jest.fn(),
      logout: jest.fn().mockResolvedValue({}),
      register: jest.fn(),
      verifyEmail: jest.fn(),
    };
    renderWithProviders({
      authService: brokenAuth,
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.EMPTY));

    await expect(
      act(async () => {
        await last.save({ keys: [] }, { password: 'pw', email: 'x@y.com' });
      })
    ).rejects.toMatchObject({ code: 'missing_salt_v' });
    expect(vaultService.save).not.toHaveBeenCalled();
  });

  test('first write PUT failure leaves EMPTY intact and surfaces the error', async () => {
    const err = new Error('vault_stale');
    err.code = 'vault_stale';
    err.status = 412;
    const vaultService = {
      load: jest.fn().mockResolvedValue({ empty: true }),
      save: jest.fn().mockRejectedValue(err),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.EMPTY));

    let caught;
    await act(async () => {
      try {
        await last.save({ k: 1 }, { password: 'pw', email: 'user@example.com' });
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toMatchObject({ code: 'vault_stale' });
    // Invariant: a failed first-write must NOT install keys in refs.
    // If it did, a subsequent retry would think we're UNLOCKED and
    // skip the password prompt — turning a transient network error
    // into an authentication bypass if keys ever leaked.
    expect(last.status).toBe(STATUS.EMPTY);
    expect(last._hasDataKeyForTest()).toBe(false);
    expect(last._hasVaultKeyForTest()).toBe(false);
    expect(last.isSaving).toBe(false);
  }, PBKDF2_TIMEOUT_MS);
});

describe('VaultProvider — save() update (UNLOCKED → UNLOCKED)', () => {
  test('re-encrypts under cached keys, sends If-Match: <etag>, returns new etag', async () => {
    const { master, blob: initialBlob } = await makeEncryptedBlobFor({
      data: { keys: [{ label: 'original' }] },
    });

    const saveCalls = [];
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob: initialBlob, etag: 'E0' }),
      save: jest.fn().mockImplementation(({ blob, ifMatch }) => {
        saveCalls.push({ blob, ifMatch });
        return Promise.resolve({ etag: 'E1' });
      }),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    await act(async () => {
      await last.unlockWithMaster(master);
    });
    await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));

    const updated = { keys: [{ label: 'original' }, { label: 'added' }] };
    await act(async () => {
      const out = await last.save(updated);
      expect(out.etag).toBe('E1');
    });

    expect(saveCalls).toHaveLength(1);
    // Update path must echo the current etag — that's the whole
    // point of optimistic concurrency control.
    expect(saveCalls[0].ifMatch).toBe('E0');
    expect(last.status).toBe(STATUS.UNLOCKED);
    expect(last.data).toEqual(updated);
    expect(last.etag).toBe('E1');

    // New ciphertext must decrypt with the same (dk, vaultKey) that
    // was installed at unlock — i.e. the DK must be stable across
    // saves (no accidental re-keying).
    const vaultKey = await deriveVaultKey(master, SALT_A);
    const { data: rt } = await decryptEnvelope(saveCalls[0].blob, vaultKey);
    expect(rt).toEqual(updated);
  });

  test('propagates vault_stale without mutating UNLOCKED state', async () => {
    const { master, blob, data } = await makeEncryptedBlobFor({});
    const err = new Error('vault_stale');
    err.code = 'vault_stale';
    err.status = 412;
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E0' }),
      save: jest.fn().mockRejectedValue(err),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    await act(async () => {
      await last.unlockWithMaster(master);
    });
    await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));

    let caught;
    await act(async () => {
      try {
        await last.save({ keys: [] });
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toMatchObject({ code: 'vault_stale' });
    // Stale-write error must not demote us out of UNLOCKED —
    // otherwise a conflict from another tab would force the user to
    // re-enter their password just to retry. The caller is expected
    // to load+retry, not re-authenticate.
    expect(last.status).toBe(STATUS.UNLOCKED);
    expect(last.data).toEqual(data);
    expect(last.etag).toBe('E0');
    expect(last.isSaving).toBe(false);
  });

  test('refuses concurrent save() (second call throws save_in_progress)', async () => {
    const { master, blob } = await makeEncryptedBlobFor({});
    let releaseFirstSave;
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E0' }),
      save: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseFirstSave = () => resolve({ etag: 'E1' });
          })
      ),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    await act(async () => {
      await last.unlockWithMaster(master);
    });
    await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));

    // First save parks in flight. Second call must be refused
    // synchronously rather than racing the network.
    let firstPromise;
    await act(async () => {
      firstPromise = last.save({ k: 1 });
      // Give encryptEnvelope a chance to complete and the PUT to
      // dispatch so `releaseFirstSave` is wired up. We wait for the
      // mock to record a call rather than for a fixed number of
      // microtasks so we're robust to WebCrypto timing.
      await waitFor(() => expect(vaultService.save).toHaveBeenCalledTimes(1));
    });
    expect(last.isSaving).toBe(true);

    await expect(last.save({ k: 2 })).rejects.toMatchObject({
      code: 'save_in_progress',
    });

    await act(async () => {
      releaseFirstSave();
      await firstPromise;
    });
    expect(last.status).toBe(STATUS.UNLOCKED);
    expect(last.isSaving).toBe(false);
  });

  test('EMPTY first-write that races and loses (vault_stale) reconciles to LOCKED (Codex round 2 P2)', async () => {
    // Two tabs both started from EMPTY and raced their first PUT
    // with If-Match: '*'. This tab loses — vaultService.save rejects
    // with vault_stale. Without reconciliation we'd stay EMPTY
    // forever, and every retry keeps hitting If-Match: '*' on an
    // existing blob. The fix kicks off a force-refetch so state
    // advances EMPTY → LOCKED using the winning tab's blob.
    const { blob } = await makeEncryptedBlobFor({});
    const staleErr = Object.assign(new Error('stale'), {
      code: 'vault_stale',
    });
    const vaultService = {
      // load() has TWO calls:
      //   1. the auto-load on auth (returns empty)
      //   2. the reconciliation kicked off by the save catch
      //      (returns the winning tab's blob)
      load: jest
        .fn()
        .mockResolvedValueOnce({ empty: true })
        .mockResolvedValueOnce({ empty: false, blob, etag: 'E1' }),
      save: jest.fn().mockRejectedValue(staleErr),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.EMPTY));

    let caught;
    await act(async () => {
      try {
        await last.save(
          { version: 1, keys: [] },
          { password: 'correct horse battery' }
        );
      } catch (err) {
        caught = err;
      }
    });
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('vault_stale');

    // Reconciliation load was dispatched (fire-and-forget) and
    // advanced the state machine EMPTY → LOCKED using the winning
    // tab's etag. That unblocks the user from the permanent-EMPTY
    // trap: the Account card now renders the unlock form and a
    // retry proceeds through the update path with a valid etag.
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    expect(vaultService.load).toHaveBeenCalledTimes(2);
    expect(last.etag).toBe('E1');
  });

  test('lock() mid-flight wins: save completion does not re-expose plaintext (Codex P1)', async () => {
    // Scenario: user is UNLOCKED, starts a save, then clicks lock
    // before the PUT resolves. The server write still succeeds, but
    // the client must honour the lock — no plaintext payload, no
    // refs, status stays LOCKED.
    const { master, blob } = await makeEncryptedBlobFor({});
    let releaseSave;
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E0' }),
      save: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseSave = () => resolve({ etag: 'E1' });
          })
      ),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    await act(async () => {
      await last.unlockWithMaster(master);
    });
    await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));

    let savePromise;
    await act(async () => {
      savePromise = last.save({ k: 1 });
      await waitFor(() =>
        expect(vaultService.save).toHaveBeenCalledTimes(1)
      );
    });
    expect(last.isSaving).toBe(true);

    await act(async () => {
      last.lock();
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));

    await act(async () => {
      releaseSave();
      await expect(savePromise).rejects.toMatchObject({
        code: 'vault_locked_during_save',
      });
    });

    expect(last.status).toBe(STATUS.LOCKED);
    expect(last.data).toBeNull();
    expect(last.isSaving).toBe(false);
    expect(last.error).toBeNull();
  });

  test('save() from LOCKED throws vault_not_ready without touching the service', async () => {
    const { blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E0' }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));

    await expect(
      act(async () => {
        await last.save({ k: 1 });
      })
    ).rejects.toMatchObject({ code: 'vault_not_ready' });
    expect(vaultService.save).not.toHaveBeenCalled();
    expect(last.status).toBe(STATUS.LOCKED);
  });
});
