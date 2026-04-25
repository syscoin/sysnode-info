import React, { useMemo } from 'react';

import {
  estimateVaultPasswordStrength,
  MIN_VAULT_PASSWORD_LENGTH,
  MIN_VAULT_PASSWORD_SCORE,
  passwordStrengthFeedback,
  passwordStrengthLabel,
  VAULT_PASSWORD_HINT,
} from '../lib/passwordPolicy';

export default function PasswordStrengthMeter({
  password,
  userInputs,
  id,
  describedBy,
}) {
  const result = useMemo(
    () => estimateVaultPasswordStrength(password, userInputs),
    [password, userInputs]
  );
  const hasPassword = typeof password === 'string' && password.length > 0;
  const lengthOk = hasPassword && password.length >= MIN_VAULT_PASSWORD_LENGTH;
  const scoreOk = lengthOk && result.score >= MIN_VAULT_PASSWORD_SCORE;
  const label = hasPassword ? passwordStrengthLabel(result.score) : 'Start typing';
  const feedback = !hasPassword
    ? VAULT_PASSWORD_HINT
    : !lengthOk
    ? `Use at least ${MIN_VAULT_PASSWORD_LENGTH} characters.`
    : scoreOk
    ? 'Looks strong enough for vault encryption.'
    : passwordStrengthFeedback(result);

  return (
    <div
      className="password-meter"
      data-score={hasPassword ? result.score : -1}
      data-valid={scoreOk ? 'true' : 'false'}
      id={id}
      aria-describedby={describedBy}
    >
      <div className="password-meter__topline">
        <span>Password strength</span>
        <strong>{label}</strong>
      </div>
      <div
        className="password-meter__track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={hasPassword ? result.score : 0}
        aria-valuetext={label}
      >
        <span
          className="password-meter__bar"
          style={{ width: `${hasPassword ? ((result.score + 1) / 5) * 100 : 0}%` }}
        />
      </div>
      <p className="password-meter__feedback">{feedback}</p>
    </div>
  );
}
