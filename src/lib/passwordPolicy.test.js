import {
  estimateVaultPasswordStrength,
  MIN_VAULT_PASSWORD_LENGTH,
  validateVaultPassword,
} from './passwordPolicy';

test('rejects passwords below the minimum length', () => {
  expect(validateVaultPassword('A7$qP9z')).toMatchObject({
    code: 'password_too_short',
  });
});

test('rejects common passwords even when they meet length and class rules', () => {
  const result = validateVaultPassword('Password1!');
  expect(result).toMatchObject({ code: 'password_too_weak' });
  expect(result.message).toMatch(/common|another word/i);
});

test('accepts strong passphrases with spaces', () => {
  expect(validateVaultPassword('correct horse battery 1')).toBeNull();
});

test('accepts generated passwords once estimator score is strong enough', () => {
  expect(validateVaultPassword('A7$qP9z!mK')).toBeNull();
});

test('feeds user inputs into the strength estimator', () => {
  const emailLocalPart = 'sentryoperator';
  const password = `${emailLocalPart}2026!`;
  const withoutEmail = estimateVaultPasswordStrength(password);
  const withEmail = estimateVaultPasswordStrength(password, [
    `${emailLocalPart}@example.com`,
  ]);

  expect(password.length).toBeGreaterThanOrEqual(MIN_VAULT_PASSWORD_LENGTH);
  expect(withEmail.guesses).toBeLessThan(withoutEmail.guesses);
});

test('rejects passwords built from the email local part', () => {
  expect(
    validateVaultPassword('sentryoperator2026!', ['sentryoperator@example.com'])
  ).toMatchObject({ code: 'password_too_weak' });
});

test('caps strength for email-like personal-info variants even when long', () => {
  const userInputs = ['doejohn@gmail.com'];
  const result = estimateVaultPasswordStrength(
    'doejohn@gmail.co123456789',
    userInputs
  );

  expect(result.score).toBeLessThan(3);
  expect(result.feedback.warning).toMatch(/email address|account identifier/i);
  expect(
    validateVaultPassword('doejohn@gmail.co123456789', userInputs)
  ).toMatchObject({
    code: 'password_too_weak',
  });
});

test('keeps personal-info passwords weak after adding extra numbers', () => {
  const userInputs = ['doejohn@gmail.com'];

  expect(validateVaultPassword('doejohn123!', userInputs)).toMatchObject({
    code: 'password_too_weak',
  });
  expect(validateVaultPassword('doejohn123456789!', userInputs)).toMatchObject({
    code: 'password_too_weak',
  });
});
