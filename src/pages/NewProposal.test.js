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

function LocationDisplay() {
  // Small helper that echoes the current location into the DOM so
  // tests can assert on URL changes inside a MemoryRouter.
  // eslint-disable-next-line global-require
  const { useLocation } = require('react-router-dom');
  const loc = useLocation();
  return (
    <div data-testid="location-display">
      {`${loc.pathname}${loc.search || ''}`}
    </div>
  );
}

async function renderWizard({ initialEntry = '/governance/new', auth } = {}) {
  const svc = auth || makeAuthService();
  const routeSeen = { last: null };
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider authService={svc}>
          <LocationDisplay />
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

  test('saves a new draft, reflects id in URL, and does NOT trigger unsaved-changes modal (Codex round 2 P2)', async () => {
    // Regression: previously `dispatch({ type: 'mark_saved' })` was
    // called BEFORE history.replace, but React 18 batches state
    // updates so the block guard still saw dirty=true at replace
    // time, popped the modal on an otherwise-successful save, and
    // could drop the ?draft=<id> from the URL. The fix pre-authorises
    // the specific internal replace via allowedPathRef. Assert:
    //   1. createDraft is called with the right payload.
    //   2. URL now contains ?draft=7.
    //   3. The unsaved-changes modal stays hidden.
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
    // The modal must NOT have been popped by the internal URL bump.
    expect(screen.queryByTestId('unsaved-modal')).toBeNull();
    // And the URL must now carry ?draft=7 — the LocationDisplay
    // test component reflects the current MemoryRouter location.
    expect(screen.getByTestId('location-display').textContent).toBe(
      '/governance/new?draft=7'
    );
  });

  test('first-save URL bump does NOT refetch the draft (Codex round 3 P1)', async () => {
    // Regression: after a successful createDraft(), the wizard calls
    // setDraftId() AND history.replace({ ?draft=<id> }). The URL
    // change re-triggers the draft-load effect. Without a guard, it
    // re-fetches the draft and dispatches `replace` with the server
    // echo, silently clobbering any edits the user started typing
    // during the round-trip.
    //
    // The fix skips the fetch when local `draftId` already matches
    // `?draft=<id>` (i.e. this is an internal URL-sync triggered by
    // our own save path, not a cold reload). We assert two things:
    //   1. getDraft is NOT called after the URL bump.
    //   2. Local edits made AFTER save are preserved across the
    //      effect re-run that the URL change causes.
    proposalService.createDraft.mockResolvedValue({
      id: 11,
      userId: 42,
      name: 'pre-save-name',
      url: 'https://forum.syscoin.org/t/topic',
      paymentAmountSats: '0',
      paymentCount: 1,
    });
    // Never let getDraft resolve — any call here would be a bug.
    // Keep it pending so a failed guard would hang the effect's
    // "loading" state instead of silently overwriting.
    proposalService.getDraft.mockImplementation(
      () => new Promise(() => {})
    );

    await renderWizard();
    await screen.findByTestId('wizard-panel-basics');

    fireEvent.change(screen.getByTestId('wizard-field-name'), {
      target: { value: 'pre-save-name' },
    });
    fireEvent.change(screen.getByTestId('wizard-field-url'), {
      target: { value: 'https://forum.syscoin.org/t/topic' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-draft'));
    });

    expect(proposalService.createDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location-display').textContent).toBe(
      '/governance/new?draft=11'
    );
    // Critical invariant: the URL bump must NOT have re-triggered a
    // server fetch for our own draft.
    expect(proposalService.getDraft).not.toHaveBeenCalled();

    // User continues typing AFTER save. If the effect had refetched
    // and the mocked getDraft later resolved, it would clobber these
    // edits. With getDraft left pending indefinitely, the only way
    // this assertion passes is if the guard prevented the fetch.
    fireEvent.change(screen.getByTestId('wizard-field-name'), {
      target: { value: 'post-save-edit' },
    });
    expect(screen.getByTestId('wizard-field-name').value).toBe(
      'post-save-edit'
    );
  });

  test('successful prepare strips ?draft=<id> from URL (Codex round 3 P2)', async () => {
    // Regression: /prepare is sent with consumeDraft: true, so the
    // server deletes the draft row on success. If the wizard then
    // leaves ?draft=<id> in the URL, a browser reload on the Submit
    // step re-mounts the wizard, the load effect calls
    // getDraft(<deleted id>), surfaces a not-found error, and drops
    // the user out of the prepared flow — even though the
    // submission exists server-side. The fix strips the query param
    // after setPrepared() lands.
    proposalService.getDraft.mockResolvedValue({
      id: 15,
      userId: 42,
      name: 'my-grant',
      url: 'https://forum.syscoin.org/t/my-grant',
      paymentAddress: 'sys1qexampleexampleexampleexampleexampleaaaa',
      paymentAmountSats: '100000000000',
      paymentCount: 1,
      startEpoch: Math.floor(Date.now() / 1000) + 3600,
      endEpoch: Math.floor(Date.now() / 1000) + 7200,
    });
    proposalService.prepare.mockResolvedValue({
      submission: {
        id: 77,
        proposalHash: 'cc'.repeat(32),
        parentHash: '0',
        revision: 1,
        timeUnix: 1700000000,
        dataHex: 'feed',
        name: 'my-grant',
        paymentAmountSats: '100000000000',
        paymentCount: 1,
        startEpoch: 1700000000,
        endEpoch: 1701000000,
      },
      opReturnHex: 'cc'.repeat(32),
      canonicalJson: '{}',
      payloadBytes: 2,
      collateralFeeSats: '15000000000',
      requiredConfirmations: 6,
    });

    await renderWizard({ initialEntry: '/governance/new?draft=15' });
    await waitFor(() => {
      expect(proposalService.getDraft).toHaveBeenCalledWith(15);
    });
    // URL reflects the hydrated draft on mount.
    await waitFor(() => {
      expect(screen.getByTestId('location-display').textContent).toBe(
        '/governance/new?draft=15'
      );
    });

    // Walk the wizard to Review.
    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-panel-payment')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-prepare'));
    });

    expect(proposalService.prepare).toHaveBeenCalledTimes(1);
    expect(proposalService.prepare.mock.calls[0][0]).toMatchObject({
      draftId: 15,
      consumeDraft: true,
    });
    // Critical: after a successful prepare the ?draft=15 must be
    // gone so a reload on the Submit step does not re-hit getDraft
    // with a now-deleted id.
    expect(screen.getByTestId('location-display').textContent).toBe(
      '/governance/new'
    );
    // And the unsaved-changes modal must not have been popped by
    // our internal URL strip.
    expect(screen.queryByTestId('unsaved-modal')).toBeNull();
  });

  test('cold load with ?draft=<id> still fetches the server copy', async () => {
    // Sanity check: the guard in the draft-load effect must only
    // skip refetches when local `draftId` ALREADY matches the URL
    // (post-save path). Direct navigation to /governance/new?draft=9
    // must still call getDraft() and hydrate the form.
    proposalService.getDraft.mockResolvedValue({
      id: 9,
      userId: 42,
      name: 'hydrated-from-server',
      url: 'https://forum.syscoin.org/t/remote',
      paymentAmountSats: '0',
      paymentCount: 1,
    });

    await renderWizard({ initialEntry: '/governance/new?draft=9' });
    await waitFor(() => {
      expect(proposalService.getDraft).toHaveBeenCalledWith(9);
    });
    await waitFor(() => {
      expect(screen.getByTestId('wizard-field-name').value).toBe(
        'hydrated-from-server'
      );
    });
  });
});
