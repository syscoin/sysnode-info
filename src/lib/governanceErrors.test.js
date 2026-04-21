import {
  describeError,
  errorLabel,
  isBenignDup,
  SEVERITY,
} from './governanceErrors';

describe('governanceErrors.describeError', () => {
  test('unknown / missing codes fall back to a generic descriptor', () => {
    const d = describeError();
    expect(d.severity).toBe(SEVERITY.ERROR);
    expect(typeof d.short).toBe('string');
    expect(typeof d.long).toBe('string');
    expect(d.long.length).toBeGreaterThan(10);

    const named = describeError('completely_unknown_code');
    expect(named.severity).toBe(SEVERITY.ERROR);
    expect(named.short).toMatch(/completely_unknown_code/);
  });

  test('null / non-string input does not throw', () => {
    expect(() => describeError(null)).not.toThrow();
    expect(() => describeError(123)).not.toThrow();
    expect(() => describeError({})).not.toThrow();
  });

  test('already_voted is info severity (benign dup)', () => {
    const d = describeError('already_voted');
    expect(d.severity).toBe(SEVERITY.INFO);
    expect(isBenignDup('already_voted')).toBe(true);
  });

  test('mn_not_found carries a link-kind CTA to /account', () => {
    const d = describeError('mn_not_found');
    expect(d.severity).toBe(SEVERITY.WARN);
    expect(d.cta).toEqual(
      expect.objectContaining({ kind: 'link', href: '/account' })
    );
    // Copy explicitly calls out the active-on-chain angle so
    // operators recognise that the fix is in their MN setup,
    // not in the sysnode UI.
    expect(d.short.toLowerCase()).toMatch(/active|not found/);
    expect(d.long.toLowerCase()).toMatch(/no longer active/);
  });

  test('signature_invalid carries a link-kind CTA to /account', () => {
    const d = describeError('signature_invalid');
    expect(d.severity).toBe(SEVERITY.WARN);
    expect(d.cta).toEqual(
      expect.objectContaining({ kind: 'link', href: '/account' })
    );
  });

  test('rate_limited respects the Retry-After header and has no autoRetry', () => {
    const d = describeError('rate_limited');
    expect(d.severity).toBe(SEVERITY.ERROR);
    expect(d.respectsRetryAfter).toBe(true);
    expect(d.autoRetry).toBeNull();
  });

  test('server_error declares a bounded auto-retry policy', () => {
    const d = describeError('server_error');
    expect(d.severity).toBe(SEVERITY.ERROR);
    expect(d.autoRetry).toEqual(
      expect.objectContaining({
        delayMs: expect.any(Number),
        maxAttempts: expect.any(Number),
      })
    );
    // Bounded so the UI cannot loop.
    expect(d.autoRetry.maxAttempts).toBeGreaterThan(0);
    expect(d.autoRetry.maxAttempts).toBeLessThan(10);
  });

  test('offline descriptor exists for queued-while-offline copy', () => {
    const d = describeError('offline');
    expect(d.severity).toBe(SEVERITY.WARN);
    expect(d.short).toMatch(/offline/i);
  });

  test('proposal_not_found has a refresh-kind CTA', () => {
    const d = describeError('proposal_not_found');
    expect(d.severity).toBe(SEVERITY.WARN);
    expect(d.cta).toEqual(expect.objectContaining({ kind: 'refresh' }));
  });

  test('vote_too_often is warn severity without an autoRetry promise', () => {
    const d = describeError('vote_too_often');
    expect(d.severity).toBe(SEVERITY.WARN);
    // We deliberately do NOT promise auto-retry because the
    // Core-level cooldown duration is not predictable client-side.
    expect(d.autoRetry).toBeUndefined();
  });

  test('csrf maps to a clear "session expired" message', () => {
    const d = describeError('csrf');
    expect(d.severity).toBe(SEVERITY.ERROR);
    expect(d.short.toLowerCase()).toMatch(/session/);
    // Actionable CTA — log in again.
    expect(d.cta).toEqual(
      expect.objectContaining({ kind: 'link', href: '/login' })
    );
  });

  test('csrf_missing and csrf_mismatch alias to the csrf descriptor', () => {
    // Backend middleware emits these verbatim (see
    // sysnode-backend/middleware/csrf.js). Before aliases they
    // fell through to the generic "Vote failed (csrf_missing)"
    // fallback — unhelpful, because the real fix is "log in
    // again". Aliasing to the same descriptor keeps the copy
    // consistent without duplicating the descriptor entries.
    const base = describeError('csrf');
    for (const alias of ['csrf_missing', 'csrf_mismatch']) {
      const d = describeError(alias);
      expect(d.severity).toBe(base.severity);
      expect(d.short).toBe(base.short);
      expect(d.long).toBe(base.long);
      expect(d.cta).toEqual(base.cta);
    }
  });
});

describe('governanceErrors.errorLabel', () => {
  test('returns the short string for a known code', () => {
    expect(errorLabel('already_voted')).toBe(
      describeError('already_voted').short
    );
  });
});

describe('governanceErrors.isBenignDup', () => {
  test('true for already_voted, false for everything else', () => {
    expect(isBenignDup('already_voted')).toBe(true);
    expect(isBenignDup('mn_not_found')).toBe(false);
    expect(isBenignDup('rate_limited')).toBe(false);
    expect(isBenignDup('server_error')).toBe(false);
    expect(isBenignDup(null)).toBe(false);
    expect(isBenignDup(undefined)).toBe(false);
    expect(isBenignDup('unknown_code')).toBe(false);
  });
});
