export const MIN_VAULT_PASSWORD_LENGTH = 8;
export const MIN_VAULT_PASSWORD_CLASSES = 3;

export const VAULT_PASSWORD_HINT =
  'Use at least 8 characters with at least 3 of: lowercase, uppercase, number, symbol.';

function countCharacterClasses(password) {
  let count = 0;
  if (/[a-z]/.test(password)) count += 1;
  if (/[A-Z]/.test(password)) count += 1;
  if (/[0-9]/.test(password)) count += 1;
  if (/[^A-Za-z0-9]/.test(password)) count += 1;
  return count;
}

export function validateVaultPassword(password) {
  if (
    typeof password !== 'string' ||
    password.length < MIN_VAULT_PASSWORD_LENGTH ||
    countCharacterClasses(password) < MIN_VAULT_PASSWORD_CLASSES
  ) {
    return {
      code: 'password_too_short',
      message: VAULT_PASSWORD_HINT,
    };
  }
  return null;
}
