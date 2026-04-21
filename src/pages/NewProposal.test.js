import React from 'react';
import { MemoryRouter, Route, Switch } from 'react-router-dom';
import {
  render,
  screen,
  act,
  fireEvent,
  waitFor,
} from '@testing-library/react';

// Stub the crypto KDF so AuthProvider + any downstream auth flows don't
// run real PBKDF2 under jsdom (same reason as DeleteAccountCard.test.js).
jest.mock('../lib/crypto/kdf', () => ({
  __esModule: true,
  deriveLoginKeys: jest.fn(),
  deriveMaster: jest.fn(),
  deriveAuthHash: jest.fn(),
  deriveVaultKey: jest.fn(),
}));

jest.mock('../lib/proposalService', () => {
  // Keep the named export of HEX64_RE live so the wizard's own client
  // validation behaves as in production.
  const actual = jest.requireActual('../lib/proposalService');
  return {
    ...actual,
    proposalService: {
      createDraft: jest.fn(),
      listDrafts: jest.fn(),
      getDraft: jest.fn(),
      updateDraft: jest.fn(),
      deleteDraft: jest.fn(),
      prepare: jest.fn(),
      listSubmissions: jest.fn(),
      getSubmission: jest.fn(),
      attachCollateral: jest.fn(),
      deleteSubmission: jest.fn(),
    },
  };
});

/* eslint-disable import/first */
import NewProposal from './NewProposal';
import { AuthProvider } from '../context/AuthContext';
import { proposalService } from '../lib/proposalService';
/* eslint-enable import/first */

function makeAuthService(user = { id: 42, email: 'alice@example.com' }) {
  return {
    me: jest.fn().mockResolvedValue({ user }),
    login: jest.fn(),
    register: jest.fn(),
    verifyEmail: jest.fn(),
    logout: jest.fn(),
  };
}

async function renderWizard({ initialEntry = '/governance/new', auth } = {}) {
  const svc = auth || makeAuthService();
  const routeSeen = { last: null };
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider authService={svc}>
          <Switch>
            <Route path="/governance/new" component={NewProposal} />
            <Route
              path="/governance/proposal/:id"
              render={({ match }) => {
                routeSeen.last = `/governance/proposal/${match.params.id}`;
                return <div>status-page-for-{match.params.id}</div>;
              }}
            />
            <Route render={({ location }) => {
              routeSeen.last = location.pathname;
              return <div>other-{location.pathname}</div>;
            }} />
          </Switch>
        </AuthProvider>
      </MemoryRouter>
    );
  });
  return { routeSeen };
}

function validBasics() {
  fireEvent.change(screen.getByTestId('wizard-field-name'), {
    target: { value: 'my-grant' },
  });
  fireEvent.change(screen.getByTestId('wizard-field-url'), {
    target: { value: 'https://forum.syscoin.org/t/my-grant' },
  });
}

function validPayment({ count = '1' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  fireEvent.change(screen.getByTestId('wizard-field-address'), {
    target: { value: 'sys1qexampleexampleexampleexampleexampleaaaa' },
  });
  fireEvent.change(screen.getByTestId('wizard-field-amount'), {
    target: { value: '1000' },
  });
  fireEvent.change(screen.getByTestId('wizard-field-count'), {
    target: { value: count },
  });
  fireEvent.change(screen.getByTestId('wizard-field-start'), {
    target: { value: String(now + 3600) },
  });
  fireEvent.change(screen.getByTestId('wizard-field-end'), {
    target: { value: String(now + 7200) },
  });
}

describe('NewProposal wizard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default to no pre-existing draft fetch.
    proposalService.getDraft.mockRejectedValue(
      Object.assign(new Error('not_found'), { code: 'not_found' })
    );
  });

  test('redirects unauthenticated users to login', async () => {
    const svc = {
      me: jest.fn().mockRejectedValue(
        Object.assign(new Error('unauthorized'), { status: 401 })
      ),
    };
    await renderWizard({ auth: svc });
    // PrivateRoute isn't in this test's route tree — instead the page
    // renders its own "Please log in" fallback. The text is broken up
    // by an inline <a> so we assert against the link and surrounding
    // copy rather than the whole sentence.
    expect(await screen.findByRole('link', { name: /log in/i })).toBeInTheDocument();
    expect(screen.getByText(/to create a proposal/i)).toBeInTheDocument();
  });

  test('renders the Basics step for an authenticated user', async () => {
    await renderWizard();
    expect(
      await screen.findByTestId('wizard-panel-basics')
    ).toBeInTheDocument();
    expect(screen.getByTestId('wizard-step-basics')).toHaveClass('is-active');
    expect(screen.getByTestId('wizard-next')).toBeDisabled();
  });

  test('Next is disabled until Basics validates', async () => {
    await renderWizard();
    await screen.findByTestId('wizard-panel-basics');
    const next = screen.getByTestId('wizard-next');
    expect(next).toBeDisabled();

    // Invalid URL (no http)
    fireEvent.change(screen.getByTestId('wizard-field-name'), {
      target: { value: 'test-grant' },
    });
    fireEvent.change(screen.getByTestId('wizard-field-url'), {
      target: { value: 'not-a-url' },
    });
    expect(next).toBeDisabled();

    validBasics();
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
  });

  test('advances through Basics → Payment → Review and calls prepare', async () => {
    proposalService.prepare.mockResolvedValue({
      submission: {
        id: 99,
        proposalHash:
          'aa'.repeat(32),
        parentHash: '0',
        revision: 1,
        timeUnix: 1700000000,
        dataHex: 'deadbeef',
        name: 'my-grant',
        url: 'https://forum.syscoin.org/t/my-grant',
        paymentAddress: 'sys1qexampleexampleexampleexampleexampleaaaa',
        paymentAmountSats: '100000000000',
        paymentCount: 1,
        startEpoch: 1700000000,
        endEpoch: 1701000000,
      },
      opReturnHex: 'aa'.repeat(32),
      canonicalJson: '{}',
      payloadBytes: 2,
      collateralFeeSats: '15000000000',
      requiredConfirmations: 6,
    });

    await renderWizard();
    await screen.findByTestId('wizard-panel-basics');

    validBasics();
    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-panel-payment')).toBeInTheDocument();

    validPayment();
    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();
    expect(screen.getByTestId('review-name')).toHaveTextContent('my-grant');

    const prepareBtn = screen.getByTestId('wizard-prepare');
    await act(async () => {
      fireEvent.click(prepareBtn);
    });

    expect(proposalService.prepare).toHaveBeenCalledTimes(1);
    const body = proposalService.prepare.mock.calls[0][0];
    expect(body).toMatchObject({
      name: 'my-grant',
      url: 'https://forum.syscoin.org/t/my-grant',
      paymentAddress: 'sys1qexampleexampleexampleexampleexampleaaaa',
      paymentAmountSats: '100000000000',
      paymentCount: 1,
    });

    expect(screen.getByTestId('wizard-panel-submit')).toBeInTheDocument();
    expect(screen.getByTestId('submit-cli-command')).toHaveTextContent(
      /gobject prepare 0 1 1700000000 deadbeef/
    );
    expect(screen.getByTestId('submit-op-return')).toHaveTextContent(
      'aa'.repeat(32)
    );
  });

  test('attach collateral posts TXID and navigates to the status page', async () => {
    proposalService.prepare.mockResolvedValue({
      submission: {
        id: 99,
        proposalHash: 'bb'.repeat(32),
        parentHash: '0',
        revision: 1,
        timeUnix: 1700000000,
        dataHex: 'beef',
        name: 'my-grant',
        paymentAmountSats: '100000000000',
        paymentCount: 1,
        startEpoch: 1700000000,
        endEpoch: 1701000000,
      },
      opReturnHex: 'bb'.repeat(32),
      canonicalJson: '{}',
      payloadBytes: 2,
      collateralFeeSats: '15000000000',
      requiredConfirmations: 6,
    });
    proposalService.attachCollateral.mockResolvedValue({ id: 99 });

    const { routeSeen } = await renderWizard();
    await screen.findByTestId('wizard-panel-basics');

    validBasics();
    fireEvent.click(screen.getByTestId('wizard-next'));
    validPayment();
    fireEvent.click(screen.getByTestId('wizard-next'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-prepare'));
    });

    // Malformed TXID client-side check
    fireEvent.change(screen.getByTestId('submit-txid-input'), {
      target: { value: 'not-hex' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-attach-btn'));
    });
    expect(proposalService.attachCollateral).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /64-character hex TXID/i
    );

    // Valid 64-hex
    const txid = 'cc'.repeat(32);
    fireEvent.change(screen.getByTestId('submit-txid-input'), {
      target: { value: txid },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-attach-btn'));
    });

    expect(proposalService.attachCollateral).toHaveBeenCalledWith(99, txid);
    await waitFor(() => {
      expect(routeSeen.last).toBe('/governance/proposal/99');
    });
  });

  test('saves a new draft and reflects id in URL', async () => {
    proposalService.createDraft.mockResolvedValue({
      id: 7,
      userId: 42,
      name: 'my-grant',
      url: 'https://forum.syscoin.org/t/my-grant',
      paymentAmountSats: '0',
      paymentCount: 1,
    });
    await renderWizard();
    await screen.findByTestId('wizard-panel-basics');

    fireEvent.change(screen.getByTestId('wizard-field-name'), {
      target: { value: 'my-grant' },
    });
    fireEvent.change(screen.getByTestId('wizard-field-url'), {
      target: { value: 'https://forum.syscoin.org/t/my-grant' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-draft'));
    });

    expect(proposalService.createDraft).toHaveBeenCalledTimes(1);
    expect(proposalService.createDraft.mock.calls[0][0]).toMatchObject({
      name: 'my-grant',
      url: 'https://forum.syscoin.org/t/my-grant',
    });
    expect(screen.getByTestId('wizard-saved-indicator')).toBeInTheDocument();
  });
});
