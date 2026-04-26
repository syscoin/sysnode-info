import zxcvbn from 'zxcvbn';

export const MIN_VAULT_PASSWORD_LENGTH = 8;
export const MIN_VAULT_PASSWORD_SCORE = 3;

export const VAULT_PASSWORD_HINT =
  'Use at least 8 characters. Longer passphrases are best; weak or common passwords are rejected.';
export const PERSONAL_INFO_PASSWORD_HINT =
  'Do not use your email address or account identifier in your password.';

export const PASSWORD_STRENGTH_LABELS = [
  'Very weak',
  'Weak',
  'Fair',
  'Strong',
  'Very strong',
];

function normalizeUserInputs(userInputs) {
  const tokens = [];
  for (const value of Array.isArray(userInputs) ? userInputs : []) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) continue;

    tokens.push(normalized);

    const [localPart, domain] = normalized.split('@');
    if (localPart && domain) {
      tokens.push(localPart, domain);
      tokens.push(...domain.split('.'));
    }

    tokens.push(...normalized.split(/[^a-z0-9]+/));
  }

  return [...new Set(tokens.filter((token) => token.length >= 3))];
}

function personalInfoTokens(userInputs) {
  const tokens = [];
  for (const value of Array.isArray(userInputs) ? userInputs : []) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) continue;

    const [localPart] = normalized.split('@');
    if (localPart) {
      tokens.push(localPart);
      tokens.push(...localPart.split(/[^a-z0-9]+/));
    }
  }

  return [...new Set(tokens.filter((token) => token.length >= 4))];
}

function findPersonalInfoToken(password, userInputs) {
  const normalizedPassword = String(password || '').toLowerCase();
  if (!normalizedPassword) return null;
  return (
    personalInfoTokens(userInputs).find((token) =>
      normalizedPassword.includes(token)
    ) || null
  );
}

export function estimateVaultPasswordStrength(password, userInputs = []) {
  const result = zxcvbn(String(password || ''), normalizeUserInputs(userInputs));
  const personalInfoToken = findPersonalInfoToken(password, userInputs);
  if (!personalInfoToken) return result;
  return {
    ...result,
    score: Math.min(result.score, 1),
    personalInfoToken,
    feedback: {
      warning: PERSONAL_INFO_PASSWORD_HINT,
      suggestions: [],
    },
  };
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
