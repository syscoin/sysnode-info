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
      attachCollateral: jest.fn(),
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

  test('prepared state renders inline attach-collateral form (Codex P1)', async () => {
    // Hash with a trailing "ff" byte proves the reversal logic:
    // big-endian "...ff" must render as a little-endian OP_RETURN
    // that starts with "ff...".
    const hashBig = 'aa'.repeat(31) + 'ff';
    proposalService.getSubmission.mockResolvedValueOnce({
      id: 15,
      status: 'prepared',
      title: 'resume-flow',
      name: 'resume-flow',
      proposalHash: hashBig,
      paymentAddress: 'sys1qexample',
      paymentAmountSats: '100000000000',
      paymentCount: 1,
      startEpoch: 1700000000,
      endEpoch: 1701000000,
    });
    await renderAt(15);
    await waitFor(() => {
      expect(screen.getByTestId('proposal-status-prepared')).toBeInTheDocument();
    });
    // OP_RETURN hex is the byte-reversed proposal hash, little-endian.
    expect(screen.getByTestId('proposal-status-opreturn')).toHaveTextContent(
      'ff' + 'aa'.repeat(31)
    );
    expect(screen.getByTestId('proposal-status-txid-input')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-status-attach')).toBeDisabled();
  });

  test(
    'prepared state surfaces the gobject prepare CLI fallback when dataHex + timeUnix are available (Codex round 5 P2)',
    async () => {
      // Parity with the former wizard Submit step: users who want to
      // pay collateral from Syscoin-Qt instead of a wallet that can
      // emit an OP_RETURN need the exact `gobject prepare` argv. Now
      // that /prepare redirects here, this page has to host that
      // fallback so the manual-pay path is not regressed.
      proposalService.getSubmission.mockResolvedValueOnce({
        id: 21,
        status: 'prepared',
        title: 'cli-fallback',
        name: 'cli-fallback',
        proposalHash: 'aa'.repeat(32),
        parentHash: '0',
        revision: 1,
        timeUnix: 1700000000,
        dataHex: 'deadbeef',
        paymentAddress: 'sys1qexample',
        paymentAmountSats: '100000000000',
        paymentCount: 1,
        startEpoch: 1700000000,
        endEpoch: 1701000000,
      });
      await renderAt(21);
      await waitFor(() => {
        expect(
          screen.getByTestId('proposal-status-prepared')
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('proposal-status-cli-command')
      ).toHaveTextContent(/gobject prepare 0 1 1700000000 deadbeef/);
    }
  );

  test(
    'prepared state omits the CLI fallback when dataHex is missing (legacy rows)',
    async () => {
      // Defensive: very old prepared rows pre-dated the dataHex
      // persistence. Without it we cannot reconstruct the correct
      // CLI argv, so we must not render a broken command.
      proposalService.getSubmission.mockResolvedValueOnce({
        id: 22,
        status: 'prepared',
        name: 'legacy',
        proposalHash: 'aa'.repeat(32),
        paymentAddress: 'sys1q',
        paymentAmountSats: '100000000000',
        paymentCount: 1,
        startEpoch: 1,
        endEpoch: 2,
      });
      await renderAt(22);
      await waitFor(() => {
        expect(
          screen.getByTestId('proposal-status-prepared')
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByTestId('proposal-status-cli-command')
      ).toBeNull();
    }
  );

  test('prepared state: malformed TXID surfaces inline error, no RPC call', async () => {
    proposalService.getSubmission.mockResolvedValueOnce({
      id: 16,
      status: 'prepared',
      name: 't',
      proposalHash: 'aa'.repeat(32),
      paymentAddress: 'sys1q',
      paymentAmountSats: '100000000000',
      paymentCount: 1,
      startEpoch: 1,
      endEpoch: 2,
    });
    await renderAt(16);
    await waitFor(() => {
      expect(screen.getByTestId('proposal-status-prepared')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('proposal-status-txid-input'), {
      target: { value: 'not-a-hash' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('proposal-status-attach'));
    });
    expect(screen.getByTestId('proposal-status-attach-error')).toHaveTextContent(
      /64-character hex/i
    );
    expect(proposalService.attachCollateral).not.toHaveBeenCalled();
  });

  test('prepared state: valid TXID calls attachCollateral and swaps to awaiting_collateral', async () => {
    const hashBig = 'aa'.repeat(32);
    const txid = 'cc'.repeat(32);
    proposalService.getSubmission.mockResolvedValueOnce({
      id: 17,
      status: 'prepared',
      name: 't',
      proposalHash: hashBig,
      paymentAddress: 'sys1q',
      paymentAmountSats: '100000000000',
      paymentCount: 1,
      startEpoch: 1,
      endEpoch: 2,
    });
    proposalService.attachCollateral.mockResolvedValueOnce({
      id: 17,
      status: 'awaiting_collateral',
      name: 't',
      proposalHash: hashBig,
      paymentAddress: 'sys1q',
      paymentAmountSats: '100000000000',
      paymentCount: 1,
      startEpoch: 1,
      endEpoch: 2,
      collateralTxid: txid,
      collateralConfs: 0,
    });
    await renderAt(17);
    await waitFor(() => {
      expect(screen.getByTestId('proposal-status-prepared')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('proposal-status-txid-input'), {
      target: { value: txid.toUpperCase() }, // test normalisation
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('proposal-status-attach'));
    });
    expect(proposalService.attachCollateral).toHaveBeenCalledWith(17, txid);
    await waitFor(() => {
      expect(
        screen.getByTestId('proposal-status-awaiting')
      ).toBeInTheDocument();
    });
  });

  test('polling continues to schedule after a transient fetch failure (Codex P1)', async () => {
    // 1st call: row is awaiting_collateral (live). 2nd call: throws.
    // 3rd call: still live. We need to assert the scheduler keeps
    // ticking — otherwise a blip freezes the status page until
    // reload.
    jest.useFakeTimers();
    proposalService.getSubmission
      .mockResolvedValueOnce({
        id: 21,
        status: 'awaiting_collateral',
        name: 't',
        proposalHash: 'aa'.repeat(32),
        paymentAddress: 'sys1q',
        paymentAmountSats: '100000000000',
        paymentCount: 1,
        startEpoch: 1,
        endEpoch: 2,
        collateralTxid: 'bb'.repeat(32),
        collateralConfs: 2,
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('boom'), { code: 'network' })
      )
      .mockResolvedValueOnce({
        id: 21,
        status: 'awaiting_collateral',
        name: 't',
        proposalHash: 'aa'.repeat(32),
        paymentAddress: 'sys1q',
        paymentAmountSats: '100000000000',
        paymentCount: 1,
        startEpoch: 1,
        endEpoch: 2,
        collateralTxid: 'bb'.repeat(32),
        collateralConfs: 4,
      });
    await act(async () => {
      render(
        <MemoryRouter initialEntries={[`/governance/proposal/21`]}>
          <AuthProvider authService={makeAuthService()}>
            <Route path="/governance/proposal/:id" component={ProposalStatus} />
          </AuthProvider>
        </MemoryRouter>
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('proposal-status-confs')).toHaveTextContent(
        '2 / 6'
      );
    });
    // Tick forward the fast-poll interval; 2nd call errors, but
    // the scheduler must re-arm.
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    // Second tick — this one should succeed and bump confs to 4/6.
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await waitFor(() => {
      expect(screen.getByTestId('proposal-status-confs')).toHaveTextContent(
        '4 / 6'
      );
    });
    expect(proposalService.getSubmission).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
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

  test(
    'delete failure surfaces an inline error banner on the visible submission (Codex round 5 P2)',
    async () => {
      // Regression: previously onDelete() stuffed the error into the
      // top-level `error` state, but that banner only renders when
      // `submission` is null. So a transient 5xx / 403 while the
      // panel is on-screen just re-enabled the Delete button with
      // no user-visible feedback. The fix routes delete failures to
      // a distinct `deleteError` state rendered *inside* the panel.
      proposalService.getSubmission.mockResolvedValueOnce({
        id: 31,
        status: 'prepared',
        name: 't',
        proposalHash: 'aa'.repeat(32),
        paymentAddress: 'sys1q',
        paymentAmountSats: '100000000000',
        paymentCount: 1,
        startEpoch: 1,
        endEpoch: 2,
      });
      proposalService.deleteSubmission.mockRejectedValueOnce(
        Object.assign(new Error('boom'), { code: 'transient_5xx' })
      );
      const spy = jest
        .spyOn(window, 'confirm')
        .mockImplementation(() => true);

      await renderAt(31);
      await waitFor(() => {
        expect(
          screen.getByTestId('proposal-status-prepared')
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('proposal-status-delete'));
      });

      // Critical invariant: the inline banner must render AND the
      // submission panel must still be visible (the user hasn't
      // been navigated off, and the fetch-error top banner must
      // remain hidden because submission is populated).
      expect(
        screen.getByTestId('proposal-status-delete-error')
      ).toHaveTextContent(/transient_5xx/);
      expect(
        screen.getByTestId('proposal-status-panel')
      ).toBeInTheDocument();
      // Delete button re-enabled for retry.
      expect(
        screen.getByTestId('proposal-status-delete')
      ).not.toBeDisabled();
      spy.mockRestore();
    }
  );

  test(
    'transient poll failure surfaces a stale-data banner while keeping the cached panel (Codex round 9 P2)',
    async () => {
      // Regression: load()'s catch left `submission` untouched but
      // the only error banner was guarded by `!submission`, so a
      // later failed poll (transient 5xx, network blip) rendered no
      // feedback at all — users kept reading stale status as if the
      // server were healthy. Fix: a new warning banner renders
      // when both a cached submission AND a fresh error exist.
      //
      // Use fake timers BEFORE mount so the effect's scheduled
      // setTimeout is captured by the mock clock (in jest 27's
      // legacy fake timers, switching mid-test does not retarget
      // already-scheduled real timers).
      jest.useFakeTimers();
      try {
        proposalService.getSubmission
          .mockResolvedValueOnce({
            id: 55,
            status: 'awaiting_collateral',
            name: 'grant',
            proposalHash: 'aa'.repeat(32),
            paymentAddress: 'sys1q',
            paymentAmountSats: '100000000000',
            paymentCount: 1,
            startEpoch: 1,
            endEpoch: 2,
            collateralTxid: 'bb'.repeat(32),
            collateralConfs: 3,
          })
          .mockRejectedValueOnce(
            Object.assign(new Error('boom'), { code: 'server_error' })
          );

        await act(async () => {
          render(
            <MemoryRouter initialEntries={[`/governance/proposal/55`]}>
              <AuthProvider authService={makeAuthService()}>
                <Route
                  path="/governance/proposal/:id"
                  component={ProposalStatus}
                />
              </AuthProvider>
            </MemoryRouter>
          );
        });

        // Drain microtasks for mount + first getSubmission to resolve
        // and React to commit the panel. Each async boundary inside
        // the component (me() in AuthProvider, then getSubmission)
        // needs its own microtask flush cycle.
        for (let i = 0; i < 30; i++) {
          // eslint-disable-next-line no-await-in-loop
          await act(async () => {
            await Promise.resolve();
          });
          if (screen.queryByTestId('proposal-status-panel')) break;
        }
        expect(
          screen.getByTestId('proposal-status-panel')
        ).toBeInTheDocument();

        // Advance past POLL_FAST_MS (10s) so the scheduled poll
        // fires the second (rejecting) getSubmission.
        await act(async () => {
          jest.advanceTimersByTime(15000);
        });
        for (let i = 0; i < 30; i++) {
          // eslint-disable-next-line no-await-in-loop
          await act(async () => {
            await Promise.resolve();
          });
          if (screen.queryByTestId('proposal-status-stale-banner')) break;
        }

        // Cached panel is still visible (transient failures must
        // not displace usable data) …
        expect(
          screen.getByTestId('proposal-status-panel')
        ).toBeInTheDocument();
        // … and the stale-data warning banner is shown with the
        // error code so users know the data may be out of date.
        expect(
          screen.getByTestId('proposal-status-stale-banner')
        ).toHaveTextContent(/server_error/);
      } finally {
        jest.useRealTimers();
      }
    }
  );

  test(
    'hard not_found clears cached submission and shows the full-page error (Codex round 9 P2)',
    async () => {
      // Regression companion to the stale-banner test above. If a
      // later poll returns `not_found` (or `forbidden`), the
      // submission is gone from the user's perspective and we must
      // stop showing the cached panel — otherwise a deleted row
      // keeps rendering as if it were live. Fix: on those two
      // error codes, clear `submission` so the "Could not load"
      // banner (gated by !submission) takes over.
      jest.useFakeTimers();
      try {
        proposalService.getSubmission
          .mockResolvedValueOnce({
            id: 77,
            status: 'awaiting_collateral', // 10s poll for a fast test
            name: 'gone-soon',
            proposalHash: 'aa'.repeat(32),
            paymentAddress: 'sys1q',
            paymentAmountSats: '100000000000',
            paymentCount: 1,
            startEpoch: 1,
            endEpoch: 2,
            collateralTxid: 'bb'.repeat(32),
            collateralConfs: 3,
          })
          .mockRejectedValueOnce(
            Object.assign(new Error('gone'), { code: 'not_found' })
          );

        await act(async () => {
          render(
            <MemoryRouter initialEntries={[`/governance/proposal/77`]}>
              <AuthProvider authService={makeAuthService()}>
                <Route
                  path="/governance/proposal/:id"
                  component={ProposalStatus}
                />
              </AuthProvider>
            </MemoryRouter>
          );
        });
        for (let i = 0; i < 30; i++) {
          // eslint-disable-next-line no-await-in-loop
          await act(async () => {
            await Promise.resolve();
          });
          if (screen.queryByTestId('proposal-status-panel')) break;
        }
        expect(
          screen.getByTestId('proposal-status-panel')
        ).toBeInTheDocument();

        await act(async () => {
          jest.advanceTimersByTime(15000);
        });
        for (let i = 0; i < 30; i++) {
          // eslint-disable-next-line no-await-in-loop
          await act(async () => {
            await Promise.resolve();
          });
          if (!screen.queryByTestId('proposal-status-panel')) break;
        }

        // Cached panel is gone; full-page "Could not load" banner
        // takes over with the not_found code.
        expect(
          screen.queryByTestId('proposal-status-panel')
        ).toBeNull();
        expect(screen.getByRole('alert')).toHaveTextContent(/not_found/);
      } finally {
        jest.useRealTimers();
      }
    }
  );
});
