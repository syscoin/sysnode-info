import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';

jest.mock('../lib/proposalService', () => {
  const actual = jest.requireActual('../lib/proposalService');
  return {
    ...actual,
    proposalService: {
      listDrafts: jest.fn(),
      listSubmissions: jest.fn(),
      deleteDraft: jest.fn(),
    },
  };
});

/* eslint-disable import/first */
import ProposalsCreatedPanel from './ProposalsCreatedPanel';
import { proposalService } from '../lib/proposalService';
/* eslint-enable import/first */

async function renderPanel() {
  await act(async () => {
    render(
      <MemoryRouter>
        <ProposalsCreatedPanel />
      </MemoryRouter>
    );
  });
}

describe('ProposalsCreatedPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    proposalService.listDrafts.mockResolvedValue([]);
    proposalService.listSubmissions.mockResolvedValue([]);
  });

  test('renders CTA and empty state when no drafts or in-flight', async () => {
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('create-proposal-cta')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/don't have any drafts/i)
    ).toBeInTheDocument();
  });

  test('renders drafts and toggles list visibility', async () => {
    proposalService.listDrafts.mockResolvedValue([
      { id: 1, name: 'draft-one', paymentAmountSats: '100000000000', paymentCount: 1 },
      { id: 2, name: 'draft-two', paymentAmountSats: '200000000000', paymentCount: 2 },
    ]);
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('proposals-drafts-toggle')).toHaveTextContent(
        'Drafts (2)'
      );
    });
    // Initially collapsed
    expect(screen.queryByTestId('proposals-drafts-list')).toBeNull();
    fireEvent.click(screen.getByTestId('proposals-drafts-toggle'));
    expect(screen.getByTestId('proposals-drafts-list')).toBeInTheDocument();
    expect(screen.getByText('draft-one')).toBeInTheDocument();
    expect(screen.getByText('draft-two')).toBeInTheDocument();
  });

  test('lists in-flight submissions', async () => {
    proposalService.listSubmissions.mockResolvedValue([
      { id: 11, name: 'pending-x', title: 'pending-x', status: 'awaiting_collateral' },
      { id: 12, name: 'done-y', title: 'done-y', status: 'submitted' },
    ]);
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('proposals-inflight-list')).toBeInTheDocument();
    });
    expect(screen.getByText('pending-x')).toBeInTheDocument();
    // 'submitted' rows are filtered out of in-flight.
    expect(screen.queryByText('done-y')).toBeNull();
  });

  test('deletes a draft on confirm', async () => {
    proposalService.listDrafts.mockResolvedValue([
      { id: 5, name: 'delete-me', paymentAmountSats: '0', paymentCount: 1 },
    ]);
    proposalService.deleteDraft.mockResolvedValue();
    const spy = jest.spyOn(window, 'confirm').mockImplementation(() => true);
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('proposals-drafts-toggle')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('proposals-drafts-toggle'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Delete/i }));
    });
    expect(proposalService.deleteDraft).toHaveBeenCalledWith(5);
    await waitFor(() => {
      expect(screen.queryByText('delete-me')).toBeNull();
    });
    spy.mockRestore();
  });
});
