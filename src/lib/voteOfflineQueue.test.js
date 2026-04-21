import {
  enqueue,
  peek,
  drain,
  clear,
  listPending,
  isOffline,
  onOnline,
  __internal,
} from './voteOfflineQueue';

// Clean sessionStorage between tests so enqueued fixtures from one
// case can't leak into another. We also intentionally exercise the
// safeStorage availability probe by asserting on it in the
// "sessionStorage disabled" case.
beforeEach(() => {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    window.sessionStorage.clear();
  }
});

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function makeEntry(hash, overrides = {}) {
  return {
    proposalHash: hash,
    voteOutcome: 'yes',
    voteSignal: 'funding',
    targets: [
      {
        collateralHash: 'c'.repeat(64),
        collateralIndex: 0,
        keyId: 'k1',
        address: 'sys1qaaaaaa',
        label: 'My MN',
      },
    ],
    ...overrides,
  };
}

describe('voteOfflineQueue.enqueue + peek', () => {
  test('round-trips a single entry keyed on proposalHash', () => {
    enqueue(makeEntry(HASH_A));
    const hit = peek(HASH_A);
    expect(hit).toBeTruthy();
    expect(hit.proposalHash).toBe(HASH_A);
    expect(hit.voteOutcome).toBe('yes');
    expect(hit.targets).toHaveLength(1);
    expect(hit.targets[0]).toEqual(
      expect.objectContaining({
        collateralHash: 'c'.repeat(64),
        collateralIndex: 0,
        keyId: 'k1',
      })
    );
    expect(hit.queuedAt).toEqual(expect.any(Number));
  });

  test('normalises proposalHash to lowercase on enqueue and peek', () => {
    enqueue(makeEntry(HASH_A.toUpperCase()));
    expect(peek(HASH_A.toLowerCase())).toBeTruthy();
    expect(peek(HASH_A.toUpperCase())).toBeTruthy();
  });

  test('enqueueing twice for the same proposal replaces the prior intent', () => {
    enqueue(makeEntry(HASH_A, { voteOutcome: 'yes' }));
    enqueue(makeEntry(HASH_A, { voteOutcome: 'abstain' }));
    const hit = peek(HASH_A);
    expect(hit.voteOutcome).toBe('abstain');
  });

  test('distinct proposalHashes coexist', () => {
    enqueue(makeEntry(HASH_A));
    enqueue(makeEntry(HASH_B, { voteOutcome: 'no' }));
    expect(peek(HASH_A).voteOutcome).toBe('yes');
    expect(peek(HASH_B).voteOutcome).toBe('no');
    expect(listPending()).toHaveLength(2);
  });

  test('ignores malformed input (null, missing hash, non-object)', () => {
    enqueue(null);
    enqueue({});
    enqueue({ proposalHash: '' });
    enqueue('not-an-object');
    expect(listPending()).toHaveLength(0);
  });

  test('peek on missing hash returns null', () => {
    expect(peek(HASH_A)).toBeNull();
    expect(peek(null)).toBeNull();
    expect(peek('')).toBeNull();
  });
});

describe('voteOfflineQueue.drain', () => {
  test('returns the stashed entry AND removes it from the queue', () => {
    enqueue(makeEntry(HASH_A));
    const drained = drain(HASH_A);
    expect(drained).toBeTruthy();
    expect(drained.proposalHash).toBe(HASH_A);
    expect(peek(HASH_A)).toBeNull();
  });

  test('drain on a missing hash returns null and does not throw', () => {
    expect(drain(HASH_A)).toBeNull();
    expect(() => drain(null)).not.toThrow();
    expect(() => drain('')).not.toThrow();
  });

  test('drain is isolated per proposal', () => {
    enqueue(makeEntry(HASH_A));
    enqueue(makeEntry(HASH_B));
    drain(HASH_A);
    expect(peek(HASH_A)).toBeNull();
    expect(peek(HASH_B)).toBeTruthy();
  });
});

describe('voteOfflineQueue.clear', () => {
  test('removes without returning the entry', () => {
    enqueue(makeEntry(HASH_A));
    clear(HASH_A);
    expect(peek(HASH_A)).toBeNull();
  });
});

describe('voteOfflineQueue corruption tolerance', () => {
  test('garbage payload in storage is wiped on next read', () => {
    const store = __internal.safeStorage();
    expect(store).toBeTruthy();
    store.setItem(__internal.STORAGE_KEY, '{not-json');
    expect(listPending()).toEqual([]);
    // And subsequent writes work cleanly.
    enqueue(makeEntry(HASH_A));
    expect(peek(HASH_A)).toBeTruthy();
  });

  test('array payload (wrong shape) is ignored', () => {
    const store = __internal.safeStorage();
    store.setItem(__internal.STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(listPending()).toEqual([]);
  });
});

describe('voteOfflineQueue.onOnline', () => {
  test('invokes the callback on the browser online event and can be unsubscribed', () => {
    const cb = jest.fn();
    const unsubscribe = onOnline(cb);
    window.dispatchEvent(new Event('online'));
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
    window.dispatchEvent(new Event('online'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('a throwing subscriber does not prevent unsubscription', () => {
    const cb = jest.fn(() => {
      throw new Error('from-subscriber');
    });
    const unsubscribe = onOnline(cb);
    expect(() => window.dispatchEvent(new Event('online'))).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe('voteOfflineQueue.isOffline', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    window.navigator,
    'onLine'
  );

  function setOnline(value) {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => value,
    });
  }

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(window.navigator, 'onLine', originalDescriptor);
    } else {
      setOnline(true);
    }
  });

  test('true only when navigator.onLine is explicitly false', () => {
    setOnline(false);
    expect(isOffline()).toBe(true);
    setOnline(true);
    expect(isOffline()).toBe(false);
  });
});
