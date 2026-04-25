import zxcvbn from 'zxcvbn';

export const MIN_VAULT_PASSWORD_LENGTH = 8;
export const MIN_VAULT_PASSWORD_SCORE = 3;

export const VAULT_PASSWORD_HINT =
  'Use at least 8 characters. Longer passphrases are best; weak or common passwords are rejected.';

export const PASSWORD_STRENGTH_LABELS = [
  'Very weak',
  'Weak',
  'Fair',
  'Strong',
  'Very strong',
];

function normalizeUserInputs(userInputs) {
  return (Array.isArray(userInputs) ? userInputs : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

export function estimateVaultPasswordStrength(password, userInputs = []) {
  return zxcvbn(String(password || ''), normalizeUserInputs(userInputs));
}

export function passwordStrengthLabel(score) {
  const index = Math.max(0, Math.min(PASSWORD_STRENGTH_LABELS.length - 1, score));
  return PASSWORD_STRENGTH_LABELS[index];
}

export function passwordStrengthFeedback(result) {
  if (!result || !result.feedback) return VAULT_PASSWORD_HINT;
  const parts = [
    result.feedback.warning,
    ...(result.feedback.suggestions || []),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : VAULT_PASSWORD_HINT;
}

export function validateVaultPassword(password, userInputs = []) {
  if (
    typeof password !== 'string' ||
    password.length < MIN_VAULT_PASSWORD_LENGTH
  ) {
    return {
      code: 'password_too_short',
      message: VAULT_PASSWORD_HINT,
    };
  }
  const result = estimateVaultPasswordStrength(password, userInputs);
  if (result.score < MIN_VAULT_PASSWORD_SCORE) {
    return {
      code: 'password_too_weak',
      message: passwordStrengthFeedback(result),
      score: result.score,
    };
  }
  return null;
}
