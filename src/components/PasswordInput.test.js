import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import PasswordInput from './PasswordInput';

test('keeps password hidden by default and reveals it on explicit toggle', async () => {
  render(
    <>
      <label htmlFor="pw">Password</label>
      <PasswordInput id="pw" value="hunter22a" onChange={() => {}} />
    </>
  );

  const input = screen.getByLabelText('Password');
  expect(input).toHaveAttribute('type', 'password');

  await userEvent.click(screen.getByRole('button', { name: /show password/i }));
  expect(input).toHaveAttribute('type', 'text');

  await userEvent.click(screen.getByRole('button', { name: /hide password/i }));
  expect(input).toHaveAttribute('type', 'password');
});
