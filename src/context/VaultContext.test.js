import React from 'react';
import { render, act, waitFor } from '@testing-library/react';

// Tests that drive a full PBKDF2-SHA512 @ 600k iterations (the real
// KDF, not a mock — we want to prove end-to-end crypto correctness)
// can take 10+ seconds in jsdom under parallel Jest workers. Give
// those tests enough headroom that they aren't the source of flakes
// when the suite is run alongside the other 15 files.
const PBKDF2_TIMEOUT_MS = 30000;

import { AuthProvider } from './AuthContext';
import {
  VaultProvider,
  useVault,
  zeroizeDataKey,
  __testing,
} from './VaultContext';
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

function renderWithProviders({
  authService,
  vaultService,
  onVault,
  idleLockMs,
}) {
  return render(
    <AuthProvider authService={authService}>
      <VaultProvider vaultService={vaultService} idleLockMs={idleLockMs}>
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

  test('idle timeout locks an unlocked vault and wipes keys', async () => {
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
      idleLockMs: 10,
      onVault: (v) => {
        last = v;
      },
    });
    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    await act(async () => {
      await last.unlockWithMaster(master);
    });
    await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));

    await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    expect(last.data).toBeNull();
    expect(last._hasDataKeyForTest()).toBe(false);
    expect(last._hasVaultKeyForTest()).toBe(false);
  });

  test('backgrounding the tab locks an unlocked vault immediately', async () => {
    const { master, blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E' }),
      save: jest.fn(),
    };
    let last;
    const originalVisibility = document.visibilityState;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      idleLockMs: 60_000,
      onVault: (v) => {
        last = v;
      },
    });
    try {
      await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
      await act(async () => {
        await last.unlockWithMaster(master);
      });
      await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
    }
  });

  test('unlocking while the tab is already hidden locks immediately', async () => {
    const { master, blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, blob, etag: 'E' }),
      save: jest.fn(),
    };
    let last;
    const originalVisibility = document.visibilityState;
    renderWithProviders({
      authService: authedAuthService(),
      vaultService,
      idleLockMs: 60_000,
      onVault: (v) => {
        last = v;
      },
    });
    try {
      await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      await act(async () => {
        await last.unlockWithMaster(master);
      });
      await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
      expect(last.data).toBeNull();
      expect(last._hasDataKeyForTest()).toBe(false);
      expect(last._hasVaultKeyForTest()).toBe(false);
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
    }
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

describe('VaultProvider — key zeroization', () => {
  test('zeroizeDataKey overwrites Uint8Array contents in place', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(zeroizeDataKey(bytes)).toBe(true);
    expect(Array.from(bytes)).toEqual([0, 0, 0, 0]);
  });

  test('zeroizeDataKey ignores non-byte-array values', () => {
    expect(zeroizeDataKey(null)).toBe(false);
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
// Fixture helper: a verifyAuthHash callback that always accepts the
// supplied authHash. The vast majority of first-write tests are
// concerned with downstream behavior (encryption, etag, key install,
// reconciliation) and not with the verification ceremony itself —
// they need a "yes, the password matches" stub. Tests that
// specifically exercise verification supply their own.
const acceptVerify = jest.fn().mockResolvedValue(true);

describe('VaultProvider — save() first write (EMPTY → UNLOCKED)', () => {
  beforeEach(() => {
    acceptVerify.mockClear();
  });

  test('encrypts under a fresh DK, PUTs with *, installs keys, transitions UNLOCKED', async () => {
    const password = 'Correct horse battery 1';
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
      const out = await last.save(data, {
        password,
        email,
        verifyAuthHash: acceptVerify,
      });
      expect(out.status).toBe(STATUS.UNLOCKED);
      expect(out.etag).toBe('NEW_ETAG');
    });

    // The verification step ran exactly once, with a 64-char hex
    // authHash that matches what /login would have submitted for
    // this (password, email) pair. This is the linchpin of the
    // anti-divergence guarantee — callers that wire it up know the
    // typed password was confirmed against the server credential
    // BEFORE we encrypted under a key derived from the same secret.
    expect(acceptVerify).toHaveBeenCalledTimes(1);
    expect(acceptVerify).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));

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

  test('first write accepts any non-empty current password after server verification', async () => {
    const vaultService = {
      load: jest.fn().mockResolvedValue({ empty: true }),
      save: jest.fn().mockResolvedValue({ etag: 'NEW_ETAG' }),
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
      const out = await last.save(
        { keys: [] },
        {
          password: 'short',
          email: 'x@y.com',
          verifyAuthHash: acceptVerify,
        }
      );
      expect(out.status).toBe(STATUS.UNLOCKED);
    });

    expect(acceptVerify).toHaveBeenCalledTimes(1);
    expect(vaultService.save).toHaveBeenCalledTimes(1);
    expect(last.status).toBe(STATUS.UNLOCKED);
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
        await last.save(
          { keys: [] },
          {
            password: 'Correct horse battery 1',
            email: 'x@y.com',
            verifyAuthHash: acceptVerify,
          }
        );
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
        await last.save(
          { k: 1 },
          {
            password: 'Correct horse battery 1',
            email: 'user@example.com',
            verifyAuthHash: acceptVerify,
          }
        );
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

  // ---------------------------------------------------------------------
  // Anti-divergence guard. The vault password and the account password
  // are the same secret feeding two different KDF outputs (authHash for
  // the server, vaultKey client-side). If we don't verify the typed
  // password against the server BEFORE encrypting, a typo at first
  // import locks the vault under a key that doesn't match the user's
  // actual account credential — every subsequent unlock with the real
  // password fails forever. (Apr 2026 prod bug.)
  // ---------------------------------------------------------------------

  test('first write requires a verifyAuthHash callback (programmer-error guard)', async () => {
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

    // Good password but no verifyAuthHash — must NOT silently proceed.
    let caught;
    await act(async () => {
      try {
        await last.save(
          { keys: [] },
          {
            password: 'Correct horse battery 1',
            email: 'user@example.com',
          }
        );
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('verify_required');
    expect(vaultService.save).not.toHaveBeenCalled();
    // No state change: still EMPTY, no keys installed.
    expect(last.status).toBe(STATUS.EMPTY);
    expect(last._hasDataKeyForTest()).toBe(false);
    expect(last._hasVaultKeyForTest()).toBe(false);
  });

  test('first write surfaces password_mismatch when verifyAuthHash rejects with invalid_credentials', async () => {
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

    let verifyCalls = 0;
    const verifyReject = async () => {
      verifyCalls += 1;
      const e = new Error('invalid_credentials');
      e.code = 'invalid_credentials';
      throw e;
    };

    // Use an explicit try/catch inside act() instead of
    // `expect(act(...)).rejects` — the latter pattern flushes act's
    // pending-state reconciliation differently and the assertion
    // can land before save's outer catch finishes its `finish()`
    // commit. The existing "PUT failure" test uses this same shape.
    let caught;
    await act(async () => {
      try {
        await last.save(
          { keys: [] },
          {
            password: 'Wrong but well-formed password 1',
            email: 'user@example.com',
            verifyAuthHash: verifyReject,
          }
        );
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('password_mismatch');
    expect(verifyCalls).toBe(1);

    // The PUT must NOT have happened. The whole point of the
    // verification step is to catch a divergent password BEFORE we
    // commit ciphertext under a divergent key.
    expect(vaultService.save).not.toHaveBeenCalled();
    expect(last.status).toBe(STATUS.EMPTY);
    expect(last._hasDataKeyForTest()).toBe(false);
    expect(last._hasVaultKeyForTest()).toBe(false);
    expect(last.isSaving).toBe(false);
  }, PBKDF2_TIMEOUT_MS);

  test('first write propagates non-credentials errors from verifyAuthHash unchanged', async () => {
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

    // Network / 5xx: must not be silently swallowed as a password
    // mismatch. The caller surfaces a "couldn't reach server" toast,
    // not a wrong-password message.
    const networkErr = Object.assign(new Error('network_unavailable'), {
      code: 'network_unavailable',
    });
    const verifyNetworkFail = async () => {
      throw networkErr;
    };

    let caught;
    await act(async () => {
      try {
        await last.save(
          { keys: [] },
          {
            password: 'Correct horse battery 1',
            email: 'user@example.com',
            verifyAuthHash: verifyNetworkFail,
          }
        );
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('network_unavailable');

    expect(vaultService.save).not.toHaveBeenCalled();
    expect(last.status).toBe(STATUS.EMPTY);
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
          {
            password: 'Correct horse battery 1',
            verifyAuthHash: acceptVerify,
          }
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
    const savedBlob = vaultService.save.mock.calls[0][0].blob;
    const vaultKey = await deriveVaultKey(master, SALT_A);
    const savedEnvelope = await decryptEnvelope(savedBlob, vaultKey);
    expect(savedEnvelope.data).toEqual({ k: 1 });
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

// ---------------------------------------------------------------------------
// PR 7 — rewrapForPasswordChange
// ---------------------------------------------------------------------------
//
// rewrapForPasswordChange(newMaster) is the bridge point between the
// AuthContext's password rotation and the VaultContext's in-memory key
// material. It MUST:
//
//   1. Refuse to run unless the vault is UNLOCKED (we need the OLD
//      vaultKey to rewrap). If the vault is EMPTY — a brand-new user
//      with no keys imported — it returns null so the caller skips the
//      vault leg of the atomic password change.
//
//   2. Produce a NEW blob whose payload ciphertext is byte-identical to
//      the old one (rewrapEnvelope only swaps the outer wrap, not the
//      inner DEK-protected payload). We assert this by re-decrypting
//      with the new vaultKey and comparing the decoded data.
//
//   3. Leave VaultContext state untouched until the caller invokes
//      rewrap.commit(newEtag). Before commit: the cached vaultKey is
//      still the old one, the state.blob + state.etag still point at
//      the original server blob. After commit: the new vaultKey is
//      cached and state.blob/state.etag reflect the server's post-
//      rotation response.
//
//   4. Be safe against reset()/logout() racing the commit — commit is
//      a no-op once VaultContext is no longer UNLOCKED.

describe('VaultProvider — rewrapForPasswordChange (PR 7)', () => {
  test('returns null when the vault is EMPTY (new user, no rewrap needed)', async () => {
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
    const out = await last.rewrapForPasswordChange(
      new Uint8Array(32).fill(0x42)
    );
    expect(out).toBeNull();
  });

  test(
    'rejects when the vault is LOCKED (old vaultKey not in memory)',
    async () => {
      const { blob } = await makeEncryptedBlobFor({});
      const vaultService = {
        load: jest.fn().mockResolvedValue({
          empty: false,
          blob,
          etag: 'E1',
        }),
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
        last.rewrapForPasswordChange(new Uint8Array(32).fill(0x42))
      ).rejects.toMatchObject({ code: 'vault_not_unlocked' });
    },
    PBKDF2_TIMEOUT_MS
  );

  test(
    'rewraps the blob so the NEW vaultKey can decrypt identical payload',
    async () => {
      const email = 'user@example.com';
      const saltV = SALT_A;
      const { blob, master, data } = await makeEncryptedBlobFor({
        password: 'old password',
        email,
        saltV,
      });
      const vaultService = {
        load: jest.fn().mockResolvedValue({
          empty: false,
          blob,
          etag: 'E1',
        }),
        save: jest.fn(),
      };
      let last;
      renderWithProviders({
        authService: authedAuthService({ email, saltV }),
        vaultService,
        onVault: (v) => {
          last = v;
        },
      });
      // Wait for the initial auth effect to settle and VaultContext
      // to land in LOCKED before calling unlockWithMaster, otherwise
      // the saltV gate inside unlockWithMaster can trip synchronously.
      await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
      await act(async () => {
        await last.unlockWithMaster(master);
      });
      await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));

      // Fresh "newMaster" — in production this is the PBKDF2 output
      // for (newPassword, email). Any 32-byte key material works for
      // exercising the rewrap path.
      const newMaster = new Uint8Array(32).fill(0x11);
      const rewrap = await last.rewrapForPasswordChange(newMaster);
      expect(rewrap).not.toBeNull();
      expect(typeof rewrap.blob).toBe('string');
      expect(typeof rewrap.ifMatch).toBe('string');
      expect(rewrap.ifMatch).toBe('E1');
      // Blob ciphertext must have CHANGED (new outer wrap) but the
      // payload must still decrypt to the original data under the
      // new vaultKey.
      expect(rewrap.blob).not.toBe(blob);
      const newVaultKey = await deriveVaultKey(newMaster, saltV);
      const decoded = await decryptEnvelope(rewrap.blob, newVaultKey);
      expect(decoded.data).toEqual(data);
    },
    PBKDF2_TIMEOUT_MS
  );

  test(
    'commit(newEtag) installs the new vaultKey + etag; save() under the new key works',
    async () => {
      const email = 'user@example.com';
      const saltV = SALT_A;
      const { blob, master } = await makeEncryptedBlobFor({
        password: 'old password',
        email,
        saltV,
      });
      let currentEtag = 'E1';
      const vaultService = {
        load: jest.fn().mockImplementation(async () => ({
          empty: false,
          blob,
          etag: currentEtag,
        })),
        save: jest.fn().mockImplementation(async () => {
          const next = `E${Number(currentEtag.slice(1)) + 1}`;
          currentEtag = next;
          return { etag: next };
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
      await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
      await act(async () => {
        await last.unlockWithMaster(master);
      });
      await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));

      const newMaster = new Uint8Array(32).fill(0x22);
      const rewrap = await last.rewrapForPasswordChange(newMaster);
      // Simulate the server accepting the rewrapped blob and echoing
      // back a fresh etag. The commit MUST be invoked inside act()
      // because it triggers a VaultContext state update.
      await act(async () => {
        rewrap.commit('E99');
      });

      // Post-commit: a save() under the new vaultKey should succeed.
      // If the vaultKey had NOT been swapped, encryptEnvelope would
      // produce a blob the future deriveVaultKey(newMaster, saltV)
      // couldn't decrypt. We don't re-drive that full decrypt here;
      // instead we assert save() passes the post-commit etag to
      // the vaultService (proves state.etag was updated) AND that
      // the blob it sends is NOT the original.
      await act(async () => {
        await last.save({ keys: [{ label: 'b', wif: 'L2...' }] });
      });
      expect(vaultService.save).toHaveBeenCalledTimes(1);
      const sentBlob = vaultService.save.mock.calls[0][0].blob;
      const sentIfMatch = vaultService.save.mock.calls[0][0].ifMatch;
      expect(sentIfMatch).toBe('E99');
      expect(sentBlob).not.toBe(blob);

      // And decrypting that sent blob with the NEW vaultKey recovers
      // the updated data — proof the cached vaultKey was rotated.
      const newVaultKey = await deriveVaultKey(newMaster, saltV);
      const decoded = await decryptEnvelope(sentBlob, newVaultKey);
      expect(decoded.data).toEqual({
        keys: [{ label: 'b', wif: 'L2...' }],
      });
    },
    PBKDF2_TIMEOUT_MS
  );

  test(
    'commit is a no-op after reset() (handles logout racing the commit)',
    async () => {
      const email = 'user@example.com';
      const saltV = SALT_A;
      const { blob, master } = await makeEncryptedBlobFor({
        password: 'old password',
        email,
        saltV,
      });
      const vaultService = {
        load: jest.fn().mockResolvedValue({
          empty: false,
          blob,
          etag: 'E1',
        }),
        save: jest.fn(),
      };
      let last;
      renderWithProviders({
        authService: authedAuthService({ email, saltV }),
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

      const newMaster = new Uint8Array(32).fill(0x33);
      const rewrap = await last.rewrapForPasswordChange(newMaster);

      // Tear down the vault (logout race) before the caller commits.
      await act(async () => {
        last.reset();
      });
      // Now commit — must NOT revive vault state or install keys
      // into the reset provider.
      await act(async () => {
        rewrap.commit('E99');
      });
      expect(last.status).not.toBe(STATUS.UNLOCKED);
    },
    PBKDF2_TIMEOUT_MS
  );

  test(
    'commit refreshes blob+etag when vault is locked mid-flight (cache short-circuit stays correct)',
    async () => {
      // Regression for Codex PR 7 round 1 P1:
      //   If the user locks the vault between POST /auth/change-password
      //   and rewrap.commit(), the server has already accepted the new
      //   blob. If commit no-ops, state.{blob,etag} still point to the
      //   OLD wrap. load()'s cache short-circuit then serves that stale
      //   snapshot for every future unlock attempt, and decrypt under
      //   the NEW vaultKey fails every time until a full page reload.
      const email = 'user@example.com';
      const saltV = SALT_A;
      const { blob, master } = await makeEncryptedBlobFor({
        password: 'old password',
        email,
        saltV,
      });
      const vaultService = {
        load: jest.fn().mockResolvedValue({
          empty: false,
          blob,
          etag: 'E1',
        }),
        save: jest.fn(),
      };
      let last;
      renderWithProviders({
        authService: authedAuthService({ email, saltV }),
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

      const newMaster = new Uint8Array(32).fill(0x44);
      const rewrap = await last.rewrapForPasswordChange(newMaster);

      // Simulate the lock-mid-flight race: user locks the vault
      // between POST and commit. vaultKey should be cleared.
      await act(async () => {
        last.lock();
      });
      await waitFor(() => expect(last.status).toBe(STATUS.LOCKED));
      expect(last._hasVaultKeyForTest()).toBe(false);

      // Server accepted the rewrap; commit arrives.
      await act(async () => {
        rewrap.commit('E42');
      });

      // Still LOCKED — we did not revive plaintext — but the cached
      // etag MUST have rotated so the next unlock sees the new wrap
      // via load()'s cache short-circuit.
      expect(last.status).toBe(STATUS.LOCKED);
      expect(last._hasVaultKeyForTest()).toBe(false);
      expect(last.etag).toBe('E42');

      // The real proof: unlocking with the NEW master succeeds
      // WITHOUT a fresh load() round-trip. If the cached blob were
      // still the old wrap, deriveVaultKey(newMaster) would fail to
      // decrypt it. The fact that the short-circuit returns a
      // decryptable snapshot proves blob was refreshed in the commit.
      vaultService.load.mockClear();
      await act(async () => {
        await last.unlockWithMaster(newMaster);
      });
      await waitFor(() => expect(last.status).toBe(STATUS.UNLOCKED));
      expect(vaultService.load).not.toHaveBeenCalled();
    },
    PBKDF2_TIMEOUT_MS
  );

  test('rejects a missing newMaster argument', async () => {
    const { blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest.fn().mockResolvedValue({
        empty: false,
        blob,
        etag: 'E1',
      }),
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
    await expect(last.rewrapForPasswordChange()).rejects.toThrow(
      /newMaster required/
    );
    await expect(
      last.rewrapForPasswordChange(new Uint8Array(0))
    ).rejects.toThrow(/newMaster required/);
  });
});
