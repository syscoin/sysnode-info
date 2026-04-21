import React from 'react';
import { MemoryRouter, Route } from 'react-router-dom';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';

jest.mock('../lib/crypto/kdf', () => ({
  __esModule: true,
  deriveLoginKeys: jest.fn(),
  deriveMaster: jest.fn(),
  deriveAuthHash: jest.fn(),
  deriveVaultKey: jest.fn(),
}));

jest.mock('../lib/proposalService', () => {
  const actual = jest.requireActual('../lib/proposalService');
  return {
    ...actual,
    proposalService: {
      getSubmission: jest.fn(),
      deleteSubmission: jest.fn(),
    },
  };
});

/* eslint-disable import/first */
import ProposalStatus from './ProposalStatus';
import { AuthProvider } from '../context/AuthContext';
import { proposalService } from '../lib/proposalService';
/* eslint-enable import/first */

function makeAuthService() {
  return {
    me: jest.fn().mockResolvedValue({ user: { id: 42, email: 'a@b.c' } }),
    logout: jest.fn(),
    login: jest.fn(),
    register: jest.fn(),
    verifyEmail: jest.fn(),
  };
}

async function renderAt(id) {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[`/governance/proposal/${id}`]}>
        <AuthProvider authService={makeAuthService()}>
          <Route path="/governance/proposal/:id" component={ProposalStatus} />
        </AuthProvider>
      </MemoryRouter>
    );
  });
}

describe('ProposalStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('renders awaiting_collateral with conf counter', async () => {
    proposalService.getSubmission.mockResolvedValueOnce({
      id: 7,
      status: 'awaiting_collateral',
      title: 'my-grant',
      name: 'my-grant',
      proposalHash: 'aa'.repeat(32),
      paymentAddress: 'sys1qexample',
      paymentAmountSats: '100000000000',
      paymentCount: 1,
      startEpoch: 1700000000,
      endEpoch: 1701000000,
      collateralTxid: 'bb'.repeat(32),
      collateralConfs: 3,
    });
    await renderAt(7);
    await waitFor(() => {
      expect(screen.getByTestId('proposal-status-awaiting')).toBeInTheDocument();
    });
    expect(screen.getByTestId('proposal-status-confs')).toHaveTextContent(
      '3 / 6'
    );
    expect(screen.getByTestId('proposal-status-txid')).toHaveTextContent(
      'bb'.repeat(32)
    );
    expect(screen.getByTestId('proposal-status-chip')).toHaveTextContent(
      /Confirming collateral/i
    );
  });

  test('renders submitted state with governance hash', async () => {
    proposalService.getSubmission.mockResolvedValueOnce({
      id: 8,
      status: 'submitted',
      title: 't',
      name: 't',
      proposalHash: 'aa'.repeat(32),
      governanceHash: 'cc'.repeat(32),
      collateralTxid: 'dd'.repeat(32),
      paymentAddress: 'sys1q',
      paymentAmountSats: '1',
      paymentCount: 1,
      startEpoch: 1,
      endEpoch: 2,
    });
    await renderAt(8);
    await waitFor(() => {
      expect(screen.getByTestId('proposal-status-submitted')).toBeInTheDocument();
    });
    expect(screen.getByTestId('proposal-status-chip')).toHaveTextContent(
      /Submitted on-chain/i
    );
  });

  test('renders failed state with reason', async () => {
    proposalService.getSubmission.mockResolvedValueOnce({
      id: 9,
      status: 'failed',
      name: 't',
      proposalHash: 'aa'.repeat(32),
      failReason: 'timeout',
      failDetail: 'watched 144 blocks',
      paymentAddress: 'sys1q',
      paymentAmountSats: '1',
      paymentCount: 1,
      startEpoch: 1,
      endEpoch: 2,
    });
    await renderAt(9);
    await waitFor(() => {
      expect(screen.getByTestId('proposal-status-failed')).toBeInTheDocument();
    });
    expect(screen.getByText(/did not reach 6 confirmations/i)).toBeInTheDocument();
  });

  test('surfaces load errors', async () => {
    proposalService.getSubmission.mockRejectedValueOnce(
      Object.assign(new Error('not_found'), { code: 'not_found' })
    );
    await renderAt(10);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/not_found/);
    });
  });

  test('delete on failed submission navigates home', async () => {
    proposalService.getSubmission.mockResolvedValueOnce({
      id: 11,
      status: 'failed',
      name: 't',
      proposalHash: 'aa'.repeat(32),
      failReason: 'core_rejected',
      paymentAddress: 'sys1q',
      paymentAmountSats: '1',
      paymentCount: 1,
      startEpoch: 1,
      endEpoch: 2,
    });
    proposalService.deleteSubmission.mockResolvedValueOnce();
    const spy = jest
      .spyOn(window, 'confirm')
      .mockImplementation(() => true);
    await renderAt(11);
    await waitFor(() => {
      expect(screen.getByTestId('proposal-status-delete')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('proposal-status-delete'));
    });
    expect(proposalService.deleteSubmission).toHaveBeenCalledWith(11);
    spy.mockRestore();
  });
});
