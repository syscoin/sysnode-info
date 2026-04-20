import React from 'react';
import { render, act, waitFor } from '@testing-library/react';

import { AuthProvider } from './AuthContext';
import { VaultProvider, useVault, __testing } from './VaultContext';
import {
  encryptEnvelope,
  generateDataKey,
} from '../lib/crypto/envelope';
import { deriveMaster, deriveVaultKey } from '../lib/crypto/kdf';

const { STATUS } = __testing;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Stubs the AuthContext's authService so it reports an authenticated user
// immediately. The payload is dummy: we only need .me to succeed so
// AuthProvider transitions to AUTHENTICATED, which is the trigger
// VaultProvider subscribes to.
function authedAuthService(email = 'user@example.com') {
  return {
    me: jest.fn().mockResolvedValue({
      user: { id: 1, email, emailVerified: true, notificationPrefs: {} },
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

async function makeEncryptedBlobFor({
  password = 'correct horse battery',
  email = 'user@example.com',
  data = { keys: [{ label: 'a', wif: 'KxFoo...' }] },
}) {
  const master = await deriveMaster(password, email);
  const saltV = 'ab'.repeat(32);
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
    // Wait a tick so the anonymous path settles.
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
    const { blob, saltV } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, saltV, blob, etag: 'E1' }),
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
    const { master, saltV, blob, data } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, saltV, blob, etag: 'E' }),
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
    const { saltV, blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, saltV, blob, etag: 'E' }),
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
    const { saltV, blob, data } = await makeEncryptedBlobFor({ password, email });
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, saltV, blob, etag: 'E' }),
      save: jest.fn(),
    };
    let last;
    renderWithProviders({
      authService: authedAuthService(email),
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
  });

  test('rejects an empty password', async () => {
    const { saltV, blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, saltV, blob, etag: 'E' }),
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
});

describe('VaultProvider — lock + logout', () => {
  test('lock() wipes the plaintext but keeps the cached blob', async () => {
    const { master, saltV, blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, saltV, blob, etag: 'E' }),
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
  });

  test('hard-resets and wipes state when auth transitions to anonymous', async () => {
    const { master, saltV, blob } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, saltV, blob, etag: 'E' }),
      save: jest.fn(),
    };

    // Build an authService we can flip from authed -> anonymous mid-test
    // by triggering a logout and relying on AuthContext's own logic.
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
    expect(last.saltV).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Codex review round 1 — concurrency regressions.
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
//
// Both fix to the same code path (single-flight, cache-aware load()).
// ---------------------------------------------------------------------------
describe('VaultProvider — load() single-flight + cache (Codex round 1)', () => {
  test('auth-effect load and unlockWithMaster coalesce onto one GET and land in UNLOCKED (P1)', async () => {
    const { master, saltV, blob, data } = await makeEncryptedBlobFor({});

    // Gate vaultService.load on a resolver we control so we can
    // deterministically order the two callers regardless of React /
    // microtask scheduling.
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

    // The auth-effect has fired and issued load(); it's parked on the
    // gate. Simulate Login's fire-and-forget unlockWithMaster racing in
    // before the GET resolves.
    await waitFor(() => expect(last.status).toBe(STATUS.LOADING));
    expect(vaultService.load).toHaveBeenCalledTimes(1);

    let unlockErr = null;
    const unlockPromise = last
      .unlockWithMaster(master)
      .catch((e) => {
        unlockErr = e;
      });

    // Critical invariant: the concurrent unlock must NOT issue a second
    // GET — it must coalesce onto the in-flight promise. Without that,
    // the second call bumps gen and the first caller's LOCKED write is
    // dropped (or vice versa).
    expect(vaultService.load).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLoad({ empty: false, saltV, blob, etag: 'E' });
      await unlockPromise;
    });

    expect(unlockErr).toBeNull();
    expect(last.status).toBe(STATUS.UNLOCKED);
    expect(last.data).toEqual(data);
    // Still only one GET total: unlockWithMaster reused the in-flight
    // result instead of firing its own.
    expect(vaultService.load).toHaveBeenCalledTimes(1);
  });

  test('unlockWithMaster reuses the cached snapshot after initial load (P2)', async () => {
    const { master, saltV, blob, data } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, saltV, blob, etag: 'E' }),
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

    // Simulate "user is now offline": subsequent GETs would reject.
    // With a proper cache-aware unlock, this reject never fires because
    // unlockWithMaster must decrypt from the cached blob.
    vaultService.load.mockImplementation(() => {
      throw new Error('network should not have been touched');
    });

    await act(async () => {
      await last.unlockWithMaster(master);
    });
    expect(last.status).toBe(STATUS.UNLOCKED);
    expect(last.data).toEqual(data);
    // One total GET, from the initial auto-load.
    expect(vaultService.load).toHaveBeenCalledTimes(1);
  });

  test('lock() followed by unlockWithMaster decrypts from cache without a re-GET (P2)', async () => {
    const { master, saltV, blob, data } = await makeEncryptedBlobFor({});
    const vaultService = {
      load: jest
        .fn()
        .mockResolvedValue({ empty: false, saltV, blob, etag: 'E' }),
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
    // Re-unlock from LOCKED must not hit the network.
    expect(vaultService.load).not.toHaveBeenCalled();
  });
});
