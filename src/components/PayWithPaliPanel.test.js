import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import PayWithPaliPanel from './PayWithPaliPanel';

// The panel exercises the full Pali happy-path via paliProvider, so
// these tests double as the wizard/status integration test called
// for by plan PR10 (fe-tests) — they cover:
//   * button gating on window.pali absence
//   * network-probe states (loading / enabled / disabled)
//   * the full click path: phase transitions + attachCollateral side
//     effect + onAttached callback
//   * error rendering + retry reset
//
// We avoid mounting <NewProposal> directly because its parent hooks
// (auth, router, draft persistence) aren't relevant to the Pali
// behaviour and would drag the test surface into unrelated territory.

function installPali(request) {
  Object.defineProperty(window, 'pali', {
    value: { request },
    configurable: true,
    writable: true,
  });
}

function uninstallPali() {
  delete window.pali;
}

function buildHappyApi() {
  return {
    getGovernanceNetwork: jest.fn().mockResolvedValue({
      paliPathEnabled: true,
      networkKey: 'mainnet',
      chain: 'main',
      slip44: 57,
    }),
    buildCollateralPsbt: jest.fn().mockResolvedValue({
      psbt: { psbt: 'base64', assets: '[]' },
      feeSats: '1234',
    }),
    attachCollateral: jest.fn().mockResolvedValue({
      id: 7,
      status: 'awaiting_collateral',
    }),
  };
}

function happyPaliRequest(txid) {
  return jest.fn(async ({ method }) => {
    switch (method) {
      case 'sys_requestAccounts':
        return ['sys1qabc'];
      case 'sys_getPublicKey':
        return 'zpub'.padEnd(40, 'a');
      case 'sys_getChangeAddress':
        return 'sys1qchange';
      case 'sys_signAndSend':
        return { txid };
      default:
        throw new Error(`unexpected method ${method}`);
    }
  });
}

describe('PayWithPaliPanel', () => {
  afterEach(() => {
    uninstallPali();
    jest.restoreAllMocks();
  });

  test('renders nothing when Pali is not installed', async () => {
    const api = buildHappyApi();
    const { container } = render(
      <PayWithPaliPanel
        submission={{ id: 7 }}
        proposalServiceImpl={api}
        onAttached={jest.fn()}
      />
    );
    // Flush the network-probe useEffect (which still runs once even
    // though the panel renders null, because React fires effects for
    // the initial commit). Without this, React logs an "update not
    // wrapped in act()" warning, making the test log noisy.
    await act(async () => {
      await Promise.resolve();
    });
    expect(container).toBeEmptyDOMElement();
    expect(api.getGovernanceNetwork).not.toHaveBeenCalled();
  });

  test('picks up Pali when provider is injected after mount', async () => {
    // Pali's content script can finish injecting `window.pali` a beat
    // after React mounts this panel (common on cold deep-link nav).
    // The panel must flip from "render nothing" to the armed panel
    // within the poll window; otherwise users would need a hard reload.
    jest.useFakeTimers();
    try {
      const api = buildHappyApi();
      const { container } = render(
        <PayWithPaliPanel
          submission={{ id: 7 }}
          proposalServiceImpl={api}
          onAttached={jest.fn()}
        />
      );
      // First commit: Pali absent -> panel renders null.
      await act(async () => {
        await Promise.resolve();
      });
      expect(container).toBeEmptyDOMElement();

      installPali(happyPaliRequest('d'.repeat(64)));

      // Drive the 300ms poll + flush the probe effect that follows.
      await act(async () => {
        jest.advanceTimersByTime(400);
        await Promise.resolve();
      });
      jest.useRealTimers();
      await waitFor(() =>
        expect(screen.getByTestId('pali-pay-button')).toBeInTheDocument()
      );
    } finally {
      if (jest.isMockFunction(setTimeout)) jest.useRealTimers();
    }
  });

  test('disables the button and shows hint when server disables the path', async () => {
    installPali(jest.fn());
    const api = buildHappyApi();
    api.getGovernanceNetwork.mockResolvedValue({
      paliPathEnabled: false,
      networkKey: 'mainnet',
    });
    render(
      <PayWithPaliPanel
        submission={{ id: 7 }}
        proposalServiceImpl={api}
        onAttached={jest.fn()}
        fallbackHint="Use the manual form below."
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId('pali-pay-hint')).toHaveTextContent(
        'Use the manual form below.'
      )
    );
    expect(screen.getByTestId('pali-pay-button')).toBeDisabled();
  });

  test('happy click path: phase transitions, attach, onAttached', async () => {
    const TXID = 'b'.repeat(64);
    const request = happyPaliRequest(TXID);
    installPali(request);
    const api = buildHappyApi();
    const onAttached = jest.fn();

    render(
      <PayWithPaliPanel
        submission={{ id: 7 }}
        proposalServiceImpl={api}
        onAttached={onAttached}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId('pali-pay-button')).not.toBeDisabled()
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('pali-pay-button'));
    });

    await waitFor(() =>
      expect(screen.getByText(/Paid/)).toBeInTheDocument()
    );

    expect(api.buildCollateralPsbt).toHaveBeenCalledWith(7, {
      xpub: expect.any(String),
      changeAddress: 'sys1qchange',
    });
    expect(api.attachCollateral).toHaveBeenCalledWith(7, TXID);
    expect(onAttached).toHaveBeenCalledWith(TXID);
  });

  test('user_rejected from sys_signAndSend surfaces as a translated error with Retry', async () => {
    const request = jest.fn(async ({ method }) => {
      switch (method) {
        case 'sys_requestAccounts':
          return ['addr'];
        case 'sys_getPublicKey':
          return 'zpub'.padEnd(40, 'a');
        case 'sys_getChangeAddress':
          return 'sys1qchange';
        case 'sys_signAndSend':
          throw Object.assign(new Error('nope'), { code: 4001 });
        default:
          throw new Error(`unexpected method ${method}`);
      }
    });
    installPali(request);
    const api = buildHappyApi();

    render(
      <PayWithPaliPanel
        submission={{ id: 7 }}
        proposalServiceImpl={api}
        onAttached={jest.fn()}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId('pali-pay-button')).not.toBeDisabled()
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('pali-pay-button'));
    });

    const err = await screen.findByTestId('pali-pay-error');
    expect(err).toHaveTextContent('Signature cancelled in Pali');
    // attachCollateral must NOT have been called — we never got a
    // valid txid from Pali.
    expect(api.attachCollateral).not.toHaveBeenCalled();

    // Retry clears the error.
    fireEvent.click(screen.getByTestId('pali-pay-retry'));
    expect(screen.queryByTestId('pali-pay-error')).toBeNull();
  });

  // Codex PR14 round 2 P2: transient probe failures must be
  // retryable. A crashed first-load used to leave the button grey
  // for the lifetime of the mount, forcing a full page reload.
  describe('network probe transient failures', () => {
    test('probe crash surfaces a retry affordance; successful retry enables the button', async () => {
      installPali(jest.fn());
      const api = buildHappyApi();
      api.getGovernanceNetwork
        .mockRejectedValueOnce(
          Object.assign(new Error('boom'), { code: 'http_error', status: 503 })
        )
        .mockResolvedValueOnce({
          paliPathEnabled: true,
          networkKey: 'mainnet',
          chain: 'main',
          slip44: 57,
        });

      render(
        <PayWithPaliPanel
          submission={{ id: 7 }}
          proposalServiceImpl={api}
          onAttached={jest.fn()}
        />
      );

      const retry = await screen.findByTestId('pali-probe-retry');
      expect(screen.getByTestId('pali-pay-button')).toBeDisabled();
      expect(api.getGovernanceNetwork).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(retry);
      });
      await waitFor(() =>
        expect(screen.getByTestId('pali-pay-button')).not.toBeDisabled()
      );
      expect(screen.queryByTestId('pali-probe-error')).toBeNull();
      expect(api.getGovernanceNetwork).toHaveBeenCalledTimes(2);
    });
  });

  // Codex PR14 round 2 FE-P2 follow-up: server-side paliPathReason
  // must translate into a specific hint so the user knows whether
  // to wait, hit retry, or escalate to the operator.
  describe('server-reported paliPathReason copy', () => {
    test.each([
      [
        'pali_path_rpc_down',
        /Syscoin RPC node/i,
      ],
      [
        'pali_path_chain_mismatch',
        /misconfigured/i,
      ],
    ])('reason=%s renders matching hint', async (reason, re) => {
      installPali(jest.fn());
      const api = buildHappyApi();
      api.getGovernanceNetwork.mockResolvedValue({
        paliPathEnabled: false,
        paliPathReason: reason,
        networkKey: 'mainnet',
      });
      render(
        <PayWithPaliPanel
          submission={{ id: 7 }}
          proposalServiceImpl={api}
          onAttached={jest.fn()}
          fallbackHint="GENERIC FALLBACK"
        />
      );
      await waitFor(() =>
        expect(screen.getByTestId('pali-pay-hint')).toHaveTextContent(re)
      );
      expect(screen.getByTestId('pali-pay-hint')).not.toHaveTextContent(
        'GENERIC FALLBACK'
      );
      expect(screen.getByTestId('pali-pay-button')).toBeDisabled();
    });
  });

  test('insufficient_funds from the server lands in the error panel', async () => {
    const TXID = 'c'.repeat(64);
    installPali(happyPaliRequest(TXID));
    const api = buildHappyApi();
    api.buildCollateralPsbt.mockRejectedValue(
      Object.assign(new Error('low'), {
        code: 'insufficient_funds',
        shortfallSats: 1,
      })
    );

    render(
      <PayWithPaliPanel
        submission={{ id: 7 }}
        proposalServiceImpl={api}
        onAttached={jest.fn()}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId('pali-pay-button')).not.toBeDisabled()
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('pali-pay-button'));
    });

    const err = await screen.findByTestId('pali-pay-error');
    expect(err).toHaveTextContent('not have enough SYS');
    expect(api.attachCollateral).not.toHaveBeenCalled();
  });

  // Codex PR14 P1: attach failure AFTER a successful burn must NOT
  // surface the generic "Try again" (which re-runs buildPSBT +
  // sys_signAndSend, double-burning 150 SYS). It must park in an
  // attach-only retry state that preserves the txid.
  describe('attach failure after successful broadcast (double-burn guard)', () => {
    test('parks in attach_failed, preserves txid, "Retry attach" only hits attachCollateral', async () => {
      const TXID = 'd'.repeat(64);
      const request = happyPaliRequest(TXID);
      installPali(request);
      const api = buildHappyApi();
      api.attachCollateral
        .mockRejectedValueOnce(
          Object.assign(new Error('boom'), {
            code: 'http_error',
            status: 503,
          })
        )
        .mockResolvedValueOnce({ id: 7, status: 'awaiting_collateral' });
      const onAttached = jest.fn();

      render(
        <PayWithPaliPanel
          submission={{ id: 7 }}
          proposalServiceImpl={api}
          onAttached={onAttached}
        />
      );

      await waitFor(() =>
        expect(screen.getByTestId('pali-pay-button')).not.toBeDisabled()
      );
      await act(async () => {
        fireEvent.click(screen.getByTestId('pali-pay-button'));
      });

      // Attach-failed UI appears, txid is shown, and the primary
      // "Pay with Pali" button is DISABLED so the user cannot
      // accidentally re-burn.
      const panel = await screen.findByTestId('pali-attach-failed');
      expect(panel).toBeInTheDocument();
      expect(screen.getByTestId('pali-attach-txid')).toHaveTextContent(TXID);
      expect(screen.getByTestId('pali-pay-button')).toBeDisabled();
      // Generic "Try again" must NOT be rendered in this state.
      expect(screen.queryByTestId('pali-pay-retry')).toBeNull();
      // We only called buildPSBT + sys_signAndSend ONCE. The burn
      // has happened exactly once.
      expect(api.buildCollateralPsbt).toHaveBeenCalledTimes(1);
      expect(
        request.mock.calls.filter((c) => c[0].method === 'sys_signAndSend')
      ).toHaveLength(1);
      // Attach was tried once and failed.
      expect(api.attachCollateral).toHaveBeenCalledTimes(1);
      expect(api.attachCollateral).toHaveBeenLastCalledWith(7, TXID);

      // Retry attach: no re-sign, just a second attachCollateral.
      await act(async () => {
        fireEvent.click(screen.getByTestId('pali-attach-retry'));
      });
      await waitFor(() =>
        expect(screen.getByText(/Paid/)).toBeInTheDocument()
      );
      expect(api.buildCollateralPsbt).toHaveBeenCalledTimes(1);
      expect(
        request.mock.calls.filter((c) => c[0].method === 'sys_signAndSend')
      ).toHaveLength(1);
      expect(api.attachCollateral).toHaveBeenCalledTimes(2);
      expect(api.attachCollateral).toHaveBeenLastCalledWith(7, TXID);
      expect(onAttached).toHaveBeenCalledWith(TXID);
    });

    test('retry attach that keeps failing stays in attach_failed, txid preserved', async () => {
      const TXID = 'e'.repeat(64);
      installPali(happyPaliRequest(TXID));
      const api = buildHappyApi();
      api.attachCollateral.mockRejectedValue(
        Object.assign(new Error('boom'), { code: 'http_error', status: 500 })
      );

      render(
        <PayWithPaliPanel
          submission={{ id: 7 }}
          proposalServiceImpl={api}
          onAttached={jest.fn()}
        />
      );
      await waitFor(() =>
        expect(screen.getByTestId('pali-pay-button')).not.toBeDisabled()
      );
      await act(async () => {
        fireEvent.click(screen.getByTestId('pali-pay-button'));
      });
      await screen.findByTestId('pali-attach-failed');

      // Retry once more — still fails — stay in the same recovery
      // state with the SAME txid still visible.
      await act(async () => {
        fireEvent.click(screen.getByTestId('pali-attach-retry'));
      });
      await waitFor(() =>
        expect(screen.getByTestId('pali-attach-failed')).toBeInTheDocument()
      );
      expect(screen.getByTestId('pali-attach-txid')).toHaveTextContent(TXID);
      expect(api.buildCollateralPsbt).toHaveBeenCalledTimes(1);
      expect(api.attachCollateral).toHaveBeenCalledTimes(2);
    });

    test('Copy TXID button writes to clipboard without restarting the flow', async () => {
      const TXID = 'f'.repeat(64);
      installPali(happyPaliRequest(TXID));
      const api = buildHappyApi();
      api.attachCollateral.mockRejectedValue(
        Object.assign(new Error('boom'), { code: 'http_error', status: 500 })
      );
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });

      render(
        <PayWithPaliPanel
          submission={{ id: 7 }}
          proposalServiceImpl={api}
          onAttached={jest.fn()}
        />
      );
      await waitFor(() =>
        expect(screen.getByTestId('pali-pay-button')).not.toBeDisabled()
      );
      await act(async () => {
        fireEvent.click(screen.getByTestId('pali-pay-button'));
      });
      await screen.findByTestId('pali-attach-failed');

      await act(async () => {
        fireEvent.click(screen.getByTestId('pali-attach-copy-txid'));
      });
      expect(writeText).toHaveBeenCalledWith(TXID);
      // No side effects on the submission flow.
      expect(api.buildCollateralPsbt).toHaveBeenCalledTimes(1);
      expect(api.attachCollateral).toHaveBeenCalledTimes(1);
      // Write succeeded -> we may advertise the copy.
      await waitFor(() =>
        expect(screen.getByTestId('pali-attach-copy-txid')).toHaveTextContent(
          /copied/i
        )
      );
    });

    test('Copy TXID stays silent when the Clipboard API is unavailable', async () => {
      // Codex PR14 P3: don't flash "Copied!" unless we actually
      // copied anything — users in the attach-failed recovery path
      // need the txid reliably, and a false positive would bury the
      // fact that the API is blocked.
      const TXID = 'a'.repeat(64);
      installPali(happyPaliRequest(TXID));
      const api = buildHappyApi();
      api.attachCollateral.mockRejectedValue(
        Object.assign(new Error('boom'), { code: 'http_error', status: 500 })
      );
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
      });

      render(
        <PayWithPaliPanel
          submission={{ id: 7 }}
          proposalServiceImpl={api}
          onAttached={jest.fn()}
        />
      );
      await waitFor(() =>
        expect(screen.getByTestId('pali-pay-button')).not.toBeDisabled()
      );
      await act(async () => {
        fireEvent.click(screen.getByTestId('pali-pay-button'));
      });
      await screen.findByTestId('pali-attach-failed');

      const copyBtn = screen.getByTestId('pali-attach-copy-txid');
      await act(async () => {
        fireEvent.click(copyBtn);
      });
      // Button label must not flip to "Copied!" — the txid is
      // shown verbatim in the alert body for manual selection.
      expect(copyBtn).not.toHaveTextContent(/copied/i);
    });
  });
});
