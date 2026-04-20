import { normalizeEmail, isValidEmailSyntax } from './normalize';

describe('normalize.normalizeEmail', () => {
  test('trims and lowercases', () => {
    expect(normalizeEmail('  User@Example.COM  ')).toBe('user@example.com');
  });

  test('applies NFKC', () => {
    expect(normalizeEmail('\u{FB01}oo@bar.com')).toBe('fioo@bar.com');
  });

  test('is idempotent', () => {
    const first = normalizeEmail('User@Example.com');
    expect(normalizeEmail(first)).toBe(first);
  });

  test('returns empty string for non-strings', () => {
    expect(normalizeEmail(null)).toBe('');
    expect(normalizeEmail(undefined)).toBe('');
    expect(normalizeEmail(42)).toBe('');
  });
});

describe('normalize.isValidEmailSyntax', () => {
  test('accepts common formats', () => {
    expect(isValidEmailSyntax('a@b.co')).toBe(true);
    expect(isValidEmailSyntax('user+tag@sub.example.com')).toBe(true);
  });

  test('rejects obvious malformations', () => {
    expect(isValidEmailSyntax('')).toBe(false);
    expect(isValidEmailSyntax('no-at-symbol')).toBe(false);
    expect(isValidEmailSyntax('two@@at.com')).toBe(false);
    expect(isValidEmailSyntax('space in@email.com')).toBe(false);
    expect(isValidEmailSyntax('@nouser.com')).toBe(false);
    expect(isValidEmailSyntax('nodot@test')).toBe(false);
  });

  test('accepts domains whose labels start with a digit', () => {
    expect(isValidEmailSyntax('user@1domain.com')).toBe(true);
    expect(isValidEmailSyntax('user@sub.1domain.com')).toBe(true);
  });
});
