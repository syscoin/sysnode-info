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

  test(
    'advances through Basics → Payment → Review, calls prepare, and redirects to the status page (Codex round 5 P2)',
    async () => {
      // Codex PR8 round 5 P2: the wizard used to park the user on a
      // local-state-only "Submit" step after /prepare. A browser
      // reload there dropped the prepared envelope and sent the
      // user back to an empty wizard even though the submission
      // existed server-side. The fix redirects to the canonical
      // reload-safe /governance/proposal/:id page, which already
      // hydrates from the server row and hosts the attach-collateral
      // UX + OP_RETURN + CLI fallback at feature parity with the old
      // SubmitStep.
      proposalService.prepare.mockResolvedValue({
        submission: {
          id: 99,
          proposalHash: 'aa'.repeat(32),
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

      const { routeSeen } = await renderWizard();
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

      // Critical invariant: on successful prepare the wizard hands
      // off to the dedicated status page. The old in-wizard Submit
      // panel must not be reachable because its state-only envelope
      // would be lost on reload.
      await waitFor(() => {
        expect(routeSeen.last).toBe('/governance/proposal/99');
      });
      expect(screen.queryByTestId('wizard-panel-submit')).toBeNull();
      // The unsaved-changes modal must not fire on this internal
      // navigation (allowedPathRef whitelists the exact target).
      expect(screen.queryByTestId('unsaved-modal')).toBeNull();
    }
  );

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

  test(
    'successful prepare navigates off /governance/new so reload never re-fetches the consumed draft (Codex round 3 P2 + round 5 P2)',
    async () => {
    // Regression history:
    //   R3 P2: /prepare is sent with consumeDraft: true, so the
    //     server deletes the draft row on success. If the wizard
    //     left ?draft=<id> in the URL, a browser reload would call
    //     getDraft(<deleted id>) and surface a not-found error.
    //   R5 P2: the round-3 fix stripped the query param but kept
    //     the user on /governance/new in a local-state-only Submit
    //     step — a reload there still dropped them back to an empty
    //     wizard. The round-5 fix redirects to
    //     /governance/proposal/:id, which hydrates from the server
    //     row, so reload is fully lossless. This test asserts the
    //     stronger post-R5 invariant: after prepare, the location
    //     is the dedicated status page (no ?draft, no /governance/new).
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
    // Critical: after a successful prepare the user is on the
    // status page (not /governance/new with stripped ?draft), so a
    // reload hydrates from the server row instead of re-entering
    // the wizard with an empty form.
    await waitFor(() => {
      expect(screen.getByTestId('location-display').textContent).toBe(
        '/governance/proposal/77'
      );
    });
    // And the unsaved-changes modal must not have been popped by
    // our internal navigation.
    expect(screen.queryByTestId('unsaved-modal')).toBeNull();
    }
  );

  test(
    'submission_exists redirect is pre-authorised via allowedPathRef and does not pop the leave-modal (Codex round 5 P2)',
    async () => {
      // Regression: when /prepare comes back with `submission_exists`
      // (another tab/device already prepared this payload, or a
      // previous prepare landed but the client never navigated away),
      // the wizard pushes the user to the existing submission's
      // status page. In that branch we deliberately do NOT flip the
      // baseline via `mark_saved` — the draft was not consumed this
      // call — so the form is still dirty relative to pristine. The
      // block callback would therefore pop the unsaved-changes modal
      // in front of a legitimate redirect. Fix: whitelist the exact
      // target via allowedPathRef before calling history.push.
      proposalService.prepare.mockRejectedValue(
        Object.assign(new Error('submission_exists'), {
          code: 'submission_exists',
          details: { id: 123 },
        })
      );

      const { routeSeen } = await renderWizard();
      await screen.findByTestId('wizard-panel-basics');

      validBasics();
      fireEvent.click(screen.getByTestId('wizard-next'));
      validPayment();
      fireEvent.click(screen.getByTestId('wizard-next'));
      expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByTestId('wizard-prepare'));
      });

      await waitFor(() => {
        expect(routeSeen.last).toBe('/governance/proposal/123');
      });
      // The leave-guard must NOT have intercepted this redirect.
      expect(screen.queryByTestId('unsaved-modal')).toBeNull();
    }
  );

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
