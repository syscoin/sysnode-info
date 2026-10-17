import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import VoteMethodModal from './VoteMethodModal';
let mockAuth;
jest.mock('../context/AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('./ProposalVoteModal', () => () => <p>Original browser and phone flow</p>);
jest.mock('./PaliVoteModal', () => () => <p>Pali approval flow</p>);
beforeEach(() => { mockAuth = { user: { id: 1 }, isAuthenticated: true }; });
test.each([['Browser voting vault', 'Original browser and phone flow'], ['Pali wallet', 'Pali approval flow']])('explicit %s choice preserves separate custody', (name, text) => {
  render(<VoteMethodModal proposal={{ Key: 'a'.repeat(64), name: 'Funding' }} onClose={jest.fn()} />);
  expect(screen.getByRole('dialog')).toHaveTextContent('Selecting one never copies keys');
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
  expect(screen.getByText(text)).toBeInTheDocument();
});
test('account changes close the custody choice and do not expose the old user flow', () => {
  const onClose = jest.fn(); const props = { proposal: { Key: 'a'.repeat(64), name: 'Funding' }, onClose };
  const { rerender } = render(<VoteMethodModal {...props} />);
  mockAuth = { user: { id: 2 }, isAuthenticated: true };
  rerender(<VoteMethodModal {...props} />);
  expect(onClose).toHaveBeenCalledTimes(1); expect(screen.queryByRole('dialog')).toBeNull();
});
