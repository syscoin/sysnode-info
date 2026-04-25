export const MIN_VAULT_PASSWORD_LENGTH = 16;

export const VAULT_PASSWORD_HINT =
  'Use at least 16 characters. A long passphrase is best; this protects your encrypted voting-key vault if server blobs ever leak.';

export function validateVaultPassword(password) {
  if (
    typeof password !== 'string' ||
    password.length < MIN_VAULT_PASSWORD_LENGTH
  ) {
    return {
      code: 'password_too_short',
      message: VAULT_PASSWORD_HINT,
    };
  }
  return null;
}
