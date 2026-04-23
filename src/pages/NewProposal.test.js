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

// Mock the network-stats fetcher that the wizard uses to anchor its
// derived voting window. Every test that reaches the Payment or
// Review step needs a stable next-superblock epoch; we default to
// 30 days in the future so the derived window falls roughly in the
// same shape the wizard would produce on mainnet (~15-day fudge
// before start, ~15-day fudge after the last payment). Individual
// tests can still override via `fetchNetworkStats.mockResolvedValueOnce`.
//
// Factory helpers MUST start with `mock` or Jest refuses to reference
// out-of-scope identifiers (hoisting guard against stale capture).
jest.mock('../lib/api', () => ({
  __esModule: true,
  fetchNetworkStats: jest.fn(() =>
    Promise.resolve({
      stats: {
        superblock_stats: {
          superblock_next_epoch_sec:
            Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      },
    })
  ),
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
import { fetchNetworkStats } from '../lib/api';
import { proposalService } from '../lib/proposalService';
/* eslint-enable import/first */

// Stable next-superblock anchor captured fresh per-test in beforeEach
// (see below). The wizard now fetches /mnStats BOTH on mount AND at
// Prepare time and compares the two — if they differ it assumes the
// chain advanced a cycle while the wizard was open and forces a
// re-review instead of submitting. A mock that recomputes
// `Date.now() + 30 days` on every call would cross the whole-second
// boundary between mount and prepare and spuriously trigger the
// drift branch, so we freeze a single value per test.
let currentStableNextSb = 0;
function defaultNetworkStatsResolver() {
  return Promise.resolve({
    stats: {
      superblock_stats: {
        superblock_next_epoch_sec: currentStableNextSb,
      },
    },
  });
}

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
  fireEvent.change(screen.getByTestId('wizard-field-address'), {
    target: { value: 'sys1qexampleexampleexampleexampleexampleaaaa' },
  });
  fireEvent.change(screen.getByTestId('wizard-field-amount'), {
    target: { value: '1000' },
  });
  fireEvent.change(screen.getByTestId('wizard-field-count'), {
    target: { value: count },
  });
  // Voting window is now derived at /prepare time from the live
  // next-superblock anchor (mocked above). No user-facing start/end
  // inputs to fill in anymore.
}

describe('NewProposal wizard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Snapshot a stable next-SB anchor at test start so both the
    // mount-time and prepare-time fetchNetworkStats calls return
    // the same value (same rationale as in production: /mnStats
    // reports the same pre-computed SB epoch across rapid calls).
    currentStableNextSb = Math.floor(Date.now() / 1000) + 30 * 86400;
    fetchNetworkStats.mockImplementation(defaultNetworkStatsResolver);
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
    // Next is always enabled — clicking it on an invalid step surfaces
    // inline errors rather than being a silent dead-end. Assert the
    // button exists, not that it's disabled. See "touch-all-on-Next"
    // handler in NewProposal.js.
    expect(screen.getByTestId('wizard-next')).toBeInTheDocument();
  });

  test('Next stays on Basics and surfaces errors until Basics validates', async () => {
    await renderWizard();
    await screen.findByTestId('wizard-panel-basics');
    const next = screen.getByTestId('wizard-next');
    expect(next).not.toBeDisabled();

    // Clicking Next on an empty step should NOT advance. It should
    // flip aria-invalid on the required fields so red borders +
    // inline error hints render (this is the behavior the wizard
    // used to bury behind a greyed-out button).
    fireEvent.click(next);
    expect(screen.getByTestId('wizard-panel-basics')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-field-name')).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(screen.getByTestId('wizard-field-url')).toHaveAttribute(
      'aria-invalid',
      'true'
    );

    // Invalid URL (no http) — Next still doesn't advance.
    fireEvent.change(screen.getByTestId('wizard-field-name'), {
      target: { value: 'test-grant' },
    });
    fireEvent.change(screen.getByTestId('wizard-field-url'), {
      target: { value: 'not-a-url' },
    });
    fireEvent.click(next);
    expect(screen.getByTestId('wizard-panel-basics')).toBeInTheDocument();

    validBasics();
    // Valid inputs — Next now advances to the Payment step.
    fireEvent.click(next);
    expect(screen.getByTestId('wizard-panel-payment')).toBeInTheDocument();
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
      // Wait for the mocked next-superblock anchor to resolve —
      // until it lands the Prepare button is disabled because we
      // refuse to submit an unanchored voting window.
      await screen.findByTestId('window-preview');
      fireEvent.click(screen.getByTestId('wizard-next'));
      expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();
      expect(screen.getByTestId('review-name')).toHaveTextContent('my-grant');

      const prepareBtn = screen.getByTestId('wizard-prepare');
      await waitFor(() => expect(prepareBtn).not.toBeDisabled());
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
      // Epochs are derived at prepare time, never from user input.
      // Sanity: start < end, end > now, span is roughly
      // paymentCount * cycle.
      expect(body.startEpoch).toBeGreaterThan(0);
      expect(body.endEpoch).toBeGreaterThan(body.startEpoch);
      expect(body.endEpoch).toBeGreaterThan(Math.floor(Date.now() / 1000));

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

  test(
    'first-save URL bump with a pre-existing hash does NOT pop the leave modal (Codex round 10 P3)',
    async () => {
      // Regression: allowedPathRef USED to include the current
      // location.hash in its whitelist key, but history.replace
      // here only writes pathname + search (no hash). For any URL
      // loaded with a fragment — e.g. a user deep-linked to
      // `/governance/new#draft-payment` or the page picked up a
      // stray `#` from copy/paste — the whitelist key became
      // `path?search#hash` while the post-replace location react-
      // router observes was `path?search`. The block callback
      // compared two different strings, treated our own internal
      // save as an untrusted navigation, and popped the unsaved-
      // changes modal on a successful first save. Worse, resolving
      // the modal could drop the `?draft=<id>` and break reload-
      // to-resume.
      //
      // Fix: drop the hash from the whitelist key so it matches
      // exactly what history.replace produces.
      proposalService.createDraft.mockResolvedValue({
        id: 42,
        userId: 42,
        name: 'my-grant',
        url: 'https://forum.syscoin.org/t/my-grant',
        paymentAmountSats: '0',
        paymentCount: 1,
      });
      // Mount with a fragment in the URL — this is the exact
      // scenario that exposed the bug.
      await renderWizard({ initialEntry: '/governance/new#section-payment' });
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

      // createDraft was called, indicator shown …
      expect(proposalService.createDraft).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('wizard-saved-indicator')).toBeInTheDocument();
      // … the unsaved-changes modal must NOT have popped …
      expect(screen.queryByTestId('unsaved-modal')).toBeNull();
      // … and the URL correctly carries ?draft=42 (not lost to the
      // block-callback falling through to the modal flow).
      expect(screen.getByTestId('location-display').textContent).toBe(
        '/governance/new?draft=42'
      );
    }
  );

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
    // Wait for the mocked next-superblock anchor before advancing
    // — Prepare is gated on a live window and tapping it too early
    // would no-op.
    await screen.findByTestId('window-preview');
    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();

    const prepareBtnA = screen.getByTestId('wizard-prepare');
    await waitFor(() => expect(prepareBtnA).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(prepareBtnA);
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
      await screen.findByTestId('window-preview');
      fireEvent.click(screen.getByTestId('wizard-next'));
      expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();

      const prepareBtnB = screen.getByTestId('wizard-prepare');
      await waitFor(() => expect(prepareBtnB).not.toBeDisabled());
      await act(async () => {
        fireEvent.click(prepareBtnB);
      });

      await waitFor(() => {
        expect(routeSeen.last).toBe('/governance/proposal/123');
      });
      // The leave-guard must NOT have intercepted this redirect.
      expect(screen.queryByTestId('unsaved-modal')).toBeNull();
    }
  );

  test(
    'Review step surfaces the projected payment schedule + total budget for paymentCount >= 2',
    async () => {
      // With the derived-window redesign the voting window is
      // computed from duration alone, so the Review step can be
      // positive about the schedule instead of warning about
      // truncation: the window is always wide enough to fit every
      // requested payment by construction (see
      // lib/governanceWindow.js). Assert the schedule lists N rows,
      // each carrying an index + a SYS amount, and that the total
      // budget is rendered.
      await renderWizard();
      await screen.findByTestId('wizard-panel-basics');
      validBasics();
      fireEvent.click(screen.getByTestId('wizard-next'));

      // Wait for the mocked next-SB anchor to land so the
      // derived window renders.
      await screen.findByTestId('window-preview');

      fireEvent.change(screen.getByTestId('wizard-field-address'), {
        target: { value: 'sys1qexampleexampleexampleexampleexampleaaaa' },
      });
      fireEvent.change(screen.getByTestId('wizard-field-amount'), {
        target: { value: '500' },
      });
      fireEvent.change(screen.getByTestId('wizard-field-count'), {
        target: { value: '3' },
      });
      fireEvent.click(screen.getByTestId('wizard-next'));

      expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();
      expect(screen.getByTestId('review-count')).toHaveTextContent('3');
      // Total budget = 3 × 500 = 1,500 SYS (locale-tolerant).
      expect(screen.getByTestId('review-total')).toHaveTextContent(
        /1[,\s]?500 SYS/
      );
      const rows = screen.getAllByTestId('review-schedule-row');
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.textContent).toMatch(/#\d+/);
        expect(row.textContent).toMatch(/SYS/);
      }
    }
  );

  test(
    'tight-voting-window notice hidden when the next superblock is comfortably far',
    async () => {
      // Default mock returns an anchor 30 days out — outside the
      // 4-day warning threshold. Warning must stay hidden on both
      // Payment and Review.
      await renderWizard();
      await screen.findByTestId('wizard-panel-basics');
      validBasics();
      fireEvent.click(screen.getByTestId('wizard-next'));

      // Payment step loaded, anchor resolved.
      await screen.findByTestId('window-preview');
      expect(
        screen.queryByTestId('tight-voting-window-warning')
      ).toBeNull();

      validPayment({ count: '3' });
      fireEvent.click(screen.getByTestId('wizard-next'));
      expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();
      // Review step — same expectation.
      expect(
        screen.queryByTestId('tight-voting-window-warning')
      ).toBeNull();
    }
  );

  test(
    'tight-voting-window notice fires on both Payment and Review when the next superblock is within 4 days',
    async () => {
      // Override the default 30-day mock: put the next superblock
      // only 2 days out. This is inside Core's 3-day maturity
      // window + the wizard's extra 1-day headroom — masternodes
      // likely won't have time to finish voting, so the proposal
      // would probably miss that superblock and pay out N-1
      // months instead of N. The warning must fire on BOTH steps
      // so the user doesn't skip past it. Anchor stable across
      // both fetchNetworkStats calls (mount + prepare) — see the
      // comment above `currentStableNextSb`.
      currentStableNextSb = Math.floor(Date.now() / 1000) + 2 * 86400;

      await renderWizard();
      await screen.findByTestId('wizard-panel-basics');
      validBasics();
      fireEvent.click(screen.getByTestId('wizard-next'));

      // Payment step loaded, anchor resolved.
      await screen.findByTestId('window-preview');
      const paymentWarn = screen.getByTestId('tight-voting-window-warning');
      expect(paymentWarn).toBeInTheDocument();
      expect(paymentWarn).toHaveAttribute('role', 'alert');
      expect(paymentWarn.textContent).toMatch(/next superblock/i);
      expect(paymentWarn.textContent).toMatch(/likely miss/i);

      // Fill duration=6 so the notice can quote "5 instead of 6".
      validPayment({ count: '6' });
      const paidChip = screen.getByTestId(
        'tight-voting-window-warning-paid'
      );
      expect(paidChip.textContent).toBe('5 months');

      fireEvent.click(screen.getByTestId('wizard-next'));
      expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();
      const reviewWarn = screen.getByTestId('tight-voting-window-warning');
      expect(reviewWarn).toBeInTheDocument();
      // Prepare stays enabled — notice is informational, not a blocker.
      const prepareBtn = screen.getByTestId('wizard-prepare');
      await waitFor(() => expect(prepareBtn).not.toBeDisabled());
    }
  );

  test(
    'tight-voting-window notice omits the "N-1 months" clause for 1-month proposals',
    async () => {
      // Edge case: user asked for 1 month. "Will pay 0 months
      // instead of 1" is unhelpful — the honest message is just
      // "will likely miss that superblock" without the demotion
      // clause. Same stable-anchor pattern as above.
      currentStableNextSb = Math.floor(Date.now() / 1000) + 2 * 86400;

      await renderWizard();
      await screen.findByTestId('wizard-panel-basics');
      validBasics();
      fireEvent.click(screen.getByTestId('wizard-next'));
      await screen.findByTestId('window-preview');
      validPayment({ count: '1' });

      const warn = screen.getByTestId('tight-voting-window-warning');
      expect(warn).toBeInTheDocument();
      expect(
        screen.queryByTestId('tight-voting-window-warning-paid')
      ).toBeNull();
      expect(warn.textContent).toMatch(/likely miss/i);
    }
  );

  test(
    'Prepare fails closed when the pre-submit /mnStats refresh throws (Codex round 2 P2)',
    async () => {
      // The wizard refreshes the next-SB anchor right before
      // submitting. If that fetch errors out, we must NOT fall
      // through to the cached (possibly-now-stale) anchor or to
      // computeProposalWindow's `now + cycle` fallback — either
      // path could ship a window that diverges from the reviewed
      // schedule and burn collateral. Fail closed: show the
      // stats-unavailable banner, drop the cached anchor so
      // Prepare stays disabled, and do NOT call prepare().
      await renderWizard();
      await screen.findByTestId('wizard-panel-basics');
      validBasics();
      fireEvent.click(screen.getByTestId('wizard-next'));
      await screen.findByTestId('window-preview');
      validPayment();
      fireEvent.click(screen.getByTestId('wizard-next'));
      expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();

      // Now break the /mnStats endpoint for the prepare-time
      // refresh. The mount-time fetch already succeeded with the
      // stable anchor from beforeEach.
      fetchNetworkStats.mockRejectedValueOnce(
        new Error('transient_network_failure')
      );

      const prepareBtn = screen.getByTestId('wizard-prepare');
      await waitFor(() => expect(prepareBtn).not.toBeDisabled());
      await act(async () => {
        fireEvent.click(prepareBtn);
      });

      // prepare() must NOT have been called — we short-circuited.
      expect(proposalService.prepare).not.toHaveBeenCalled();
      // The inline error banner surfaces the retry guidance.
      const alerts = screen.getAllByRole('alert');
      const errBanner = alerts.find((el) =>
        /could not confirm live superblock timing/i.test(el.textContent)
      );
      expect(errBanner).toBeDefined();
      // Cached anchor dropped → Prepare button goes back to
      // disabled until refreshStats recovers.
      await waitFor(() =>
        expect(screen.getByTestId('wizard-prepare')).toBeDisabled()
      );
    }
  );

  test(
    'Prepare fails closed when the pre-submit /mnStats refresh returns a stale (past) anchor',
    async () => {
      // Same fail-closed behaviour as the throw case: a lagging
      // /mnStats feed that still returns a positive but past
      // timestamp must not let us submit. The mount fetch used
      // the stable future anchor from beforeEach; we corrupt only
      // the prepare-time refresh.
      await renderWizard();
      await screen.findByTestId('wizard-panel-basics');
      validBasics();
      fireEvent.click(screen.getByTestId('wizard-next'));
      await screen.findByTestId('window-preview');
      validPayment();
      fireEvent.click(screen.getByTestId('wizard-next'));
      expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();

      fetchNetworkStats.mockResolvedValueOnce({
        stats: {
          superblock_stats: {
            superblock_next_epoch_sec: Math.floor(Date.now() / 1000) - 60,
          },
        },
      });

      const prepareBtn = screen.getByTestId('wizard-prepare');
      await waitFor(() => expect(prepareBtn).not.toBeDisabled());
      await act(async () => {
        fireEvent.click(prepareBtn);
      });

      expect(proposalService.prepare).not.toHaveBeenCalled();
      const alerts = screen.getAllByRole('alert');
      const errBanner = alerts.find((el) =>
        /could not confirm live superblock timing/i.test(el.textContent)
      );
      expect(errBanner).toBeDefined();
    }
  );

  test(
    'Prepare fails closed when /mnStats resolves across the SB boundary (anchor future at pre-await, past at post-await) (Codex round 3 P2)',
    async () => {
      // Codex PR20 round 3 P2: the previous implementation captured
      // `nowSec = Math.floor(Date.now() / 1000)` BEFORE awaiting
      // fetchNetworkStats() and reused it to validate the refreshed
      // anchor. /mnStats is a real network RTT and can straddle
      // wall-clock boundaries — including, at a SB transition, the
      // actual superblock. In that case an anchor that was strictly
      // future at pre-await time is already in the past by the time
      // we use it, so passing the pre-await clock to
      // nextSuperblockEpochSecFromStats would green-light a
      // just-passed anchor and ship a window anchored to a SB that
      // already happened (effective payouts shift N -> N-1).
      //
      // Simulate this by installing a Date.now() spy that advances
      // time forward WHILE fetchNetworkStats is in flight. The
      // anchor returned is +10s relative to the pre-await clock
      // but the clock moves +20s during the await, so the same
      // anchor is -10s relative to the post-await clock. The fix
      // captures nowSec AFTER the await, so the anchor is rejected
      // as stale and we fail closed with stats_unavailable.
      await renderWizard();
      await screen.findByTestId('wizard-panel-basics');
      validBasics();
      fireEvent.click(screen.getByTestId('wizard-next'));
      await screen.findByTestId('window-preview');
      validPayment();
      fireEvent.click(screen.getByTestId('wizard-next'));
      expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();

      const baseNowMs = Date.now();
      const baseNowSec = Math.floor(baseNowMs / 1000);

      // Install the Date.now spy AFTER all prior setup has run on
      // the real clock. The spy advances time on every read so that
      // once the fetchNetworkStats mock resolver fires we've already
      // moved past the anchor it's about to return.
      let dateNowSpy;
      try {
        fetchNetworkStats.mockImplementationOnce(async () => {
          // Bump the clock forward by 20s BEFORE resolving.
          // Consumers of Date.now() after the await will see the
          // advanced time; consumers before the await already
          // captured the un-advanced time. Also pin every subsequent
          // Date.now() read for the rest of the prepare call to
          // this value so the assertion is deterministic.
          dateNowSpy = jest
            .spyOn(Date, 'now')
            .mockReturnValue((baseNowSec + 20) * 1000);
          return {
            stats: {
              superblock_stats: {
                superblock_next_epoch_sec: baseNowSec + 10,
              },
            },
          };
        });

        const prepareBtn = screen.getByTestId('wizard-prepare');
        await waitFor(() => expect(prepareBtn).not.toBeDisabled());
        await act(async () => {
          fireEvent.click(prepareBtn);
        });

        // prepare() must NOT have been called — the post-await
        // clock read sees the anchor as already-past and fails
        // closed. Without the fix, nextSuperblockEpochSecFromStats
        // sees nowSec=baseNowSec and anchor=baseNowSec+10 → validates
        // as live and the submission proceeds.
        expect(proposalService.prepare).not.toHaveBeenCalled();
        const alerts = screen.getAllByRole('alert');
        const errBanner = alerts.find((el) =>
          /could not confirm live superblock timing/i.test(el.textContent)
        );
        expect(errBanner).toBeDefined();
      } finally {
        if (dateNowSpy) dateNowSpy.mockRestore();
      }
    }
  );

  test(
    'Prepare surfaces anchor_drift when the refreshed anchor differs from the cached one, and submits on the retry click',
    async () => {
      // Chain advanced a cycle while the wizard was open. The
      // fresh anchor is valid, but the user reviewed a schedule
      // built from the previous anchor. We must update state so
      // the WindowPreview rerenders with the new schedule, then
      // let the user commit by clicking Prepare again — this
      // ensures they only ever burn collateral on a window they
      // actually saw.
      proposalService.prepare.mockResolvedValue({
        submission: {
          id: 77,
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

      await renderWizard();
      await screen.findByTestId('wizard-panel-basics');
      validBasics();
      fireEvent.click(screen.getByTestId('wizard-next'));
      await screen.findByTestId('window-preview');
      validPayment();
      fireEvent.click(screen.getByTestId('wizard-next'));
      expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();

      // Next /mnStats call returns a DIFFERENT future anchor (one
      // superblock past the cached one). Subsequent calls return
      // the same drifted value so the retry click sees a stable
      // state.
      const driftedAnchor = currentStableNextSb + 30 * 86400;
      currentStableNextSb = driftedAnchor;

      const prepareBtn = screen.getByTestId('wizard-prepare');
      await waitFor(() => expect(prepareBtn).not.toBeDisabled());
      await act(async () => {
        fireEvent.click(prepareBtn);
      });

      // First click: detected drift, updated state, did NOT submit.
      expect(proposalService.prepare).not.toHaveBeenCalled();
      const alerts = screen.getAllByRole('alert');
      const errBanner = alerts.find((el) =>
        /chain timing updated while this wizard was open/i.test(
          el.textContent
        )
      );
      expect(errBanner).toBeDefined();
      // Prepare button is still enabled for the retry click
      // (cached anchor was updated, not cleared).
      expect(screen.getByTestId('wizard-prepare')).not.toBeDisabled();

      // Second click: cached anchor now matches the refreshed
      // one, so we proceed to prepare.
      await act(async () => {
        fireEvent.click(screen.getByTestId('wizard-prepare'));
      });
      expect(proposalService.prepare).toHaveBeenCalledTimes(1);
    }
  );

  test(
    'Prepare proceeds without anchor_drift when refreshed anchor differs only by estimate drift (sub-SB, Codex round 4 P1)',
    async () => {
      // sysMain.js on the backend recomputes
      // `superblock_next_epoch_sec` every 20 s as `now +
      // diffBlock * avgBlockTime`, so the value drifts by
      // seconds between fetches without the next superblock
      // actually rotating. The previous strict-equality check
      // in onPrepare treated every such drift as a rotation
      // and popped the "Chain timing updated" banner, which
      // meant users could get stuck never reaching
      // proposalService.prepare — clicking Prepare kept
      // bouncing them back to re-review. Regression: a 60 s
      // drift (well under the cycle/2 tolerance) must submit
      // cleanly on the first click.
      proposalService.prepare.mockResolvedValue({
        submission: {
          id: 88,
          proposalHash: 'bb'.repeat(32),
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
        opReturnHex: 'bb'.repeat(32),
        canonicalJson: '{}',
        payloadBytes: 2,
        collateralFeeSats: '15000000000',
        requiredConfirmations: 6,
      });

      await renderWizard();
      await screen.findByTestId('wizard-panel-basics');
      validBasics();
      fireEvent.click(screen.getByTestId('wizard-next'));
      await screen.findByTestId('window-preview');
      validPayment();
      fireEvent.click(screen.getByTestId('wizard-next'));
      expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();

      // Next /mnStats call returns a slightly drifted anchor
      // (60 s forward). Well within the cycle/2 tolerance, so
      // the wizard must treat it as "same SB, just a fresher
      // estimate" and proceed to prepare.
      currentStableNextSb += 60;

      const prepareBtn = screen.getByTestId('wizard-prepare');
      await waitFor(() => expect(prepareBtn).not.toBeDisabled());
      await act(async () => {
        fireEvent.click(prepareBtn);
      });

      // Submitted on the first click — no anchor_drift banner.
      expect(proposalService.prepare).toHaveBeenCalledTimes(1);
      const alerts = screen.queryAllByRole('alert');
      const spuriousDrift = alerts.find((el) =>
        /chain timing updated while this wizard was open/i.test(
          el.textContent
        )
      );
      expect(spuriousDrift).toBeUndefined();
    }
  );

  test(
    'Review step hides the schedule block for single-payment proposals',
    async () => {
      // paymentCount=1 is the default and most common case.
      // The schedule breakdown adds no useful information
      // ("payment #1 will be paid on the next superblock") and
      // would visually clutter the Review for the 99%-path user.
      await renderWizard();
      await screen.findByTestId('wizard-panel-basics');
      validBasics();
      fireEvent.click(screen.getByTestId('wizard-next'));
      validPayment();
      fireEvent.click(screen.getByTestId('wizard-next'));
      expect(screen.getByTestId('wizard-panel-review')).toBeInTheDocument();
      expect(screen.queryByTestId('review-schedule')).toBeNull();
    }
  );

  test(
    'edits typed while save is in flight remain dirty (baseline is the saved snapshot, not the live form) (Codex round 7 P1)',
    async () => {
      // Regression: `mark_saved` used to set
      //   baseline = state.form
      // at reducer-time. saveDraft snapshots the form BEFORE
      // awaiting the server, then dispatches mark_saved AFTER. If
      // the user keeps typing during that window, those new edits
      // end up in `state.form` by the time the reducer runs and
      // silently become the new baseline — dirty flips false and
      // the leave-guard stops prompting for data the server never
      // saw. Fix: callers now pass the saved snapshot explicitly
      // via `action.baseline`, so only what was actually persisted
      // becomes the new baseline.
      //
      // This test:
      //   1. Clicks Save (snapshots name="snapshot-value").
      //   2. While createDraft is still pending, types a new name.
      //   3. Resolves createDraft.
      //   4. Tries to navigate away to a non-whitelisted path and
      //      asserts the unsaved-changes modal DOES appear (the
      //      guard must still see the post-save edit as dirty).
      let resolveCreate;
      proposalService.createDraft.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          })
      );

      // Capture history so we can simulate a non-whitelisted push.
      let capturedHistory = null;
      function HistoryGrabber() {
        // eslint-disable-next-line global-require
        const { useHistory } = require('react-router-dom');
        capturedHistory = useHistory();
        return null;
      }

      const svc = makeAuthService();
      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/governance/new']}>
            <AuthProvider authService={svc}>
              <LocationDisplay />
              <HistoryGrabber />
              <Switch>
                <Route path="/governance/new" component={NewProposal} />
                <Route render={() => <div>elsewhere</div>} />
              </Switch>
            </AuthProvider>
          </MemoryRouter>
        );
      });
      await screen.findByTestId('wizard-panel-basics');

      // 1. Populate form and click Save. createDraft is pending.
      fireEvent.change(screen.getByTestId('wizard-field-name'), {
        target: { value: 'snapshot-value' },
      });
      fireEvent.change(screen.getByTestId('wizard-field-url'), {
        target: { value: 'https://forum.syscoin.org/t/original' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('wizard-save-draft'));
      });
      expect(proposalService.createDraft).toHaveBeenCalledTimes(1);
      expect(
        proposalService.createDraft.mock.calls[0][0].name
      ).toBe('snapshot-value');

      // 2. User keeps typing while createDraft is in flight.
      fireEvent.change(screen.getByTestId('wizard-field-name'), {
        target: { value: 'post-save-edit' },
      });

      // 3. Resolve the save.
      await act(async () => {
        resolveCreate({
          id: 42,
          userId: 42,
          name: 'snapshot-value',
          url: 'https://forum.syscoin.org/t/original',
          paymentAmountSats: '0',
          paymentCount: 1,
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      // URL has the draft id (save completed end-to-end).
      await waitFor(() => {
        expect(screen.getByTestId('location-display').textContent).toBe(
          '/governance/new?draft=42'
        );
      });

      // 4. Critical invariant: the form is still dirty relative to
      //    the saved snapshot. Attempt a non-whitelisted navigation
      //    and assert the leave-guard kicks in.
      act(() => {
        capturedHistory.push('/somewhere-else');
      });
      // The leave-modal comes from UnsavedChangesModal (testid
      // "unsaved-modal"). Pre-fix it would be absent because
      // baseline silently absorbed "post-save-edit" and `dirty`
      // went false.
      expect(
        await screen.findByTestId('unsaved-modal')
      ).toBeInTheDocument();
    }
  );

  test(
    'toolbar Save draft swallows rejections and surfaces saveDraftError (Codex round 6 P2)',
    async () => {
      // Regression: saveDraft() rethrows on failure so that
      // onModalSave() (which awaits it) can keep the unsaved-changes
      // modal open. The toolbar button, however, used to bind
      // `onClick={saveDraft}` directly — that turns the async
      // function's rejection into an unhandled promise because
      // React never attaches a catch to event-handler return
      // values. In production that hits the global
      // `unhandledrejection` hook; in CI it fails the test suite
      // under Jest's default handling. Fix wraps the call with a
      // local `.catch(() => {})` because the error is already
      // surfaced via `saveDraftError` state. Assert:
      //   1. clicking Save does NOT produce an unhandled rejection
      //   2. the visible save-error banner is still rendered
      const rejections = [];
      const handler = (ev) => rejections.push(ev.reason || ev);
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('unhandledrejection', handler);
      }

      proposalService.createDraft.mockRejectedValue(
        Object.assign(new Error('transient 500'), { code: 'server_error' })
      );
      try {
        await renderWizard();
        await screen.findByTestId('wizard-panel-basics');
        validBasics();

        await act(async () => {
          fireEvent.click(screen.getByTestId('wizard-save-draft'));
        });
        // Let any microtasks settle so a bare unhandled rejection
        // would actually surface before we assert.
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(proposalService.createDraft).toHaveBeenCalledTimes(1);
        // Error banner is still shown to the user.
        expect(
          screen.getByText(/save failed/i)
        ).toBeInTheDocument();
        // No unhandled rejection leaked.
        expect(rejections).toEqual([]);
      } finally {
        if (typeof window !== 'undefined' && window.removeEventListener) {
          window.removeEventListener('unhandledrejection', handler);
        }
      }
    }
  );

  test(
    'Discard in the leave modal preserves the saved server draft and only reverts unsaved edits (Codex round 8 P1)',
    async () => {
      // Regression: `discardDraft()` used to unconditionally call
      // `proposalService.deleteDraft(draftId)` whenever a draftId
      // existed. That meant the common flow:
      //   - resume an existing saved draft
      //   - edit a field
      //   - navigate away
      //   - pick "Discard" in the unsaved-changes modal
      // silently deleted the entire draft from the server, so the
      // user lost previously-saved work and could no longer resume
      // it from the drafts list. The correct semantics are "throw
      // away my recent edits, but keep the persisted draft" — the
      // leave-modal's Discard button is NOT a delete button.
      //
      // This test:
      //   1. Cold-loads the wizard with ?draft=9 so the existing
      //      server draft is hydrated as both `form` and `baseline`.
      //   2. Edits the name field (flips dirty=true).
      //   3. Triggers a navigation away to a non-whitelisted path.
      //   4. Clicks Discard in the unsaved-changes modal.
      //   5. Asserts that deleteDraft was NOT called, and the form
      //      reverted to the saved baseline value.
      proposalService.getDraft.mockResolvedValue({
        id: 9,
        userId: 42,
        name: 'server-saved-name',
        url: 'https://forum.syscoin.org/t/server-saved',
        paymentAmountSats: '0',
        paymentCount: 1,
      });

      let capturedHistory = null;
      function HistoryGrabber() {
        // eslint-disable-next-line global-require
        const { useHistory } = require('react-router-dom');
        capturedHistory = useHistory();
        return null;
      }

      const svc = makeAuthService();
      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/governance/new?draft=9']}>
            <AuthProvider authService={svc}>
              <LocationDisplay />
              <HistoryGrabber />
              <Switch>
                <Route path="/governance/new" component={NewProposal} />
                <Route render={() => <div>elsewhere</div>} />
              </Switch>
            </AuthProvider>
          </MemoryRouter>
        );
      });
      // Wait for the server draft to land in the form.
      await waitFor(() => {
        expect(screen.getByTestId('wizard-field-name').value).toBe(
          'server-saved-name'
        );
      });

      // 2. User edits. Form becomes dirty relative to baseline.
      fireEvent.change(screen.getByTestId('wizard-field-name'), {
        target: { value: 'unsaved-edit' },
      });
      expect(screen.getByTestId('wizard-field-name').value).toBe(
        'unsaved-edit'
      );

      // 3. Navigate to a non-whitelisted path. The leave-guard pops.
      await act(async () => {
        capturedHistory.push('/somewhere-else');
      });
      const modal = await screen.findByTestId('unsaved-modal');
      expect(modal).toBeInTheDocument();

      // 4. Click Discard.
      await act(async () => {
        fireEvent.click(screen.getByTestId('unsaved-modal-discard'));
      });

      // 5a. The server-side draft MUST still exist — no delete call.
      expect(proposalService.deleteDraft).not.toHaveBeenCalled();
      // 5b. Local form is reverted to the saved baseline, not wiped.
      //     (Wizard may have navigated to /somewhere-else now, so
      //     the field may be unmounted. Check form value only if
      //     wizard is still mounted.)
      const stillMounted = screen.queryByTestId('wizard-field-name');
      if (stillMounted) {
        expect(stillMounted.value).toBe('server-saved-name');
      }
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

  test(
    'clears stale draft form + draftId when loading a different ?draft= fails so saves cannot PATCH the wrong id (Codex round 11 P1)',
    async () => {
      // Regression: the draft-load effect used to leave previous
      // `form` + `draftId` state intact on fetch failure. If the
      // user switched /governance/new?draft=10 → ?draft=20 and the
      // /20 fetch failed (deleted, 403, network), the wizard kept
      // showing /10's fields AND `saveDraft()` kept PATCHing
      // /drafts/10 while the URL claimed /20. That's a cross-draft
      // write under the user's nose.
      //
      // Fix: when the effect sees `draftId != null && draftId !==
      // draftIdFromUrl`, reset the form to empty and drop draftId
      // BEFORE the new fetch starts. If that new fetch also fails,
      // the catch clears draftId again so the next save can only
      // create a new draft — never overwrite a draft the user is
      // no longer even viewing.

      // First call (id=10): loads successfully with distinctive
      // name we can later assert is gone.
      proposalService.getDraft
        .mockResolvedValueOnce({
          id: 10,
          userId: 42,
          name: 'original-ten',
          url: 'https://forum.syscoin.org/t/ten',
          paymentAmountSats: '0',
          paymentCount: 1,
        })
        .mockRejectedValueOnce(
          Object.assign(new Error('nope'), { code: 'not_found' })
        );

      let capturedHistory = null;
      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/governance/new?draft=10']}>
            <AuthProvider authService={makeAuthService()}>
              <Switch>
                <Route
                  path="/governance/new"
                  render={(props) => {
                    capturedHistory = props.history;
                    // eslint-disable-next-line global-require
                    const NewProposalLocal =
                      require('./NewProposal').default;
                    return <NewProposalLocal />;
                  }}
                />
              </Switch>
            </AuthProvider>
          </MemoryRouter>
        );
      });

      // Wait for initial hydrate.
      await waitFor(() => {
        expect(screen.getByTestId('wizard-field-name').value).toBe(
          'original-ten'
        );
      });

      // Switch to a different draft id; its fetch will reject.
      await act(async () => {
        capturedHistory.replace('/governance/new?draft=20');
      });

      // Critical invariants:
      //   a) Form is reset (NOT still showing original-ten).
      //   b) `saveDraft()` — invoked next — must either create a
      //      new draft (POST, no id) or refuse; it must NOT PATCH
      //      /drafts/10. We assert by calling the real service
      //      mock and checking what was called.
      await waitFor(() => {
        expect(
          screen.getByTestId('wizard-field-name').value
        ).not.toBe('original-ten');
      });

      // Confirm the UI isn't silently holding draftId=10 by
      // triggering a save. `createDraft` would fire for a new
      // draft; `updateDraft` (with id=10) would be the bug.
      proposalService.createDraft.mockResolvedValue({ id: 99 });
      fireEvent.change(screen.getByTestId('wizard-field-name'), {
        target: { value: 'fresh-entry' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('wizard-save-draft'));
      });
      expect(proposalService.updateDraft).not.toHaveBeenCalledWith(
        10,
        expect.anything()
      );
    }
  );

  test(
    'clears loaded draft when ?draft= is removed from the URL so Save does not PATCH the old id (Codex round 12 P2)',
    async () => {
      // Regression: the draft-load effect previously early-returned
      // on `!draftIdFromUrl` without doing anything, so navigating
      // /governance/new?draft=<id> → /governance/new (param removed)
      // kept `draftId` + `form` in memory. Save Draft then called
      // updateDraft(oldId) while the URL claimed a new proposal —
      // a silent cross-draft overwrite. Fix: the `!draftIdFromUrl`
      // branch now resets draftId and replaces the form with
      // emptyForm(), so the route state and the persisted target
      // stay aligned.
      proposalService.getDraft.mockResolvedValue({
        id: 50,
        userId: 42,
        name: 'loaded-from-fifty',
        url: 'https://forum.syscoin.org/t/fifty',
        paymentAmountSats: '0',
        paymentCount: 1,
      });

      let capturedHistory = null;
      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/governance/new?draft=50']}>
            <AuthProvider authService={makeAuthService()}>
              <Switch>
                <Route
                  path="/governance/new"
                  render={(props) => {
                    capturedHistory = props.history;
                    // eslint-disable-next-line global-require
                    const NewProposalLocal =
                      require('./NewProposal').default;
                    return <NewProposalLocal />;
                  }}
                />
              </Switch>
            </AuthProvider>
          </MemoryRouter>
        );
      });

      await waitFor(() => {
        expect(screen.getByTestId('wizard-field-name').value).toBe(
          'loaded-from-fifty'
        );
      });

      // Navigate away from ?draft=50 to bare /governance/new. The
      // effect must reset draftId + form even though there's no
      // new draft to load.
      await act(async () => {
        capturedHistory.replace('/governance/new');
      });

      await waitFor(() => {
        expect(
          screen.getByTestId('wizard-field-name').value
        ).not.toBe('loaded-from-fifty');
      });

      // Now type a new name and save. It must create a fresh
      // draft (or at minimum MUST NOT updateDraft(50, ...)).
      proposalService.createDraft.mockResolvedValue({ id: 51 });
      fireEvent.change(screen.getByTestId('wizard-field-name'), {
        target: { value: 'new-proposal-entry' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('wizard-save-draft'));
      });
      expect(proposalService.updateDraft).not.toHaveBeenCalledWith(
        50,
        expect.anything()
      );
    }
  );

  test(
    'clears "Couldn\'t load draft" banner when ?draft= is removed from URL (Codex round 13 P2)',
    async () => {
      // Regression: a failed ?draft=<id> load set loadError AND
      // cleared draftId to null (via the catch branch). The
      // !draftIdFromUrl branch then gated the loadError reset on
      // `draftId != null`, so when the user navigated away from
      // the failed draft URL to a bare /governance/new, the
      // "Couldn't load draft" banner persisted on the fresh route
      // with no draft context — misleading error state that made
      // the page look broken even though nothing was being loaded.
      // Fix: always clear loadError on the !draftIdFromUrl branch.
      proposalService.getDraft.mockRejectedValue(
        Object.assign(new Error('nope'), { code: 'not_found' })
      );

      let capturedHistory = null;
      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/governance/new?draft=999']}>
            <AuthProvider authService={makeAuthService()}>
              <Switch>
                <Route
                  path="/governance/new"
                  render={(props) => {
                    capturedHistory = props.history;
                    // eslint-disable-next-line global-require
                    const NewProposalLocal =
                      require('./NewProposal').default;
                    return <NewProposalLocal />;
                  }}
                />
              </Switch>
            </AuthProvider>
          </MemoryRouter>
        );
      });

      // Banner shows once the failed fetch settles.
      await waitFor(() => {
        expect(screen.getByText(/Couldn't load draft/i)).toBeInTheDocument();
      });

      // Drop the ?draft= query (user decides to start fresh).
      await act(async () => {
        capturedHistory.replace('/governance/new');
      });

      // Banner must disappear — the route is no longer tied to any
      // draft, so "couldn't load draft #NNN" is stale and wrong.
      await waitFor(() => {
        expect(
          screen.queryByText(/Couldn't load draft/i)
        ).not.toBeInTheDocument();
      });
    }
  );

  test(
    '"Saved" badge disappears after new edits dirty the form again (Codex round 14 P2)',
    async () => {
      // Regression: the saved-indicator was rendered purely from
      // draftSavedAt/savingDraft/saveDraftError, so after one
      // successful save it kept showing "Saved" even as the user
      // typed further edits that had not been persisted. Users
      // inferred their latest changes were safe when in fact they
      // were only in local state. Fix: gate on `!dirty`, which
      // flips back to true on any field mutation past the last
      // baseline.
      proposalService.createDraft.mockResolvedValue({
        id: 42,
        userId: 42,
        name: 'initial',
        url: 'https://forum.syscoin.org/t/initial',
        paymentAmountSats: '0',
        paymentCount: 1,
      });
      await renderWizard();
      await screen.findByTestId('wizard-panel-basics');

      // Fill + save so draftSavedAt is set and the badge renders.
      fireEvent.change(screen.getByTestId('wizard-field-name'), {
        target: { value: 'initial' },
      });
      fireEvent.change(screen.getByTestId('wizard-field-url'), {
        target: { value: 'https://forum.syscoin.org/t/initial' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('wizard-save-draft'));
      });
      expect(proposalService.createDraft).toHaveBeenCalledTimes(1);
      expect(
        screen.getByTestId('wizard-saved-indicator')
      ).toBeInTheDocument();

      // Now the user types more — form is dirty relative to the
      // saved baseline. The badge must disappear immediately to
      // avoid the false-safety signal.
      fireEvent.change(screen.getByTestId('wizard-field-name'), {
        target: { value: 'initial-edited' },
      });
      expect(
        screen.queryByTestId('wizard-saved-indicator')
      ).toBeNull();
    }
  );

  test(
    'updateDraft sends explicit empty strings for cleared text fields so the backend clears them (Codex round 13 P2)',
    async () => {
      // Regression: prior behavior dropped empty text fields from
      // the draft body entirely, so when a user resumed a draft,
      // deleted e.g. `url`, and clicked Save, the PATCH omitted
      // `url`. The backend kept the old stored value, while the
      // UI marked the blank snapshot as saved. Reload then
      // silently restored the deleted value. Fix: the update
      // branch emits empty-string for cleared text fields so the
      // PATCH actually clears them.
      proposalService.getDraft.mockResolvedValue({
        id: 77,
        userId: 42,
        name: 'resumed',
        url: 'https://forum.syscoin.org/t/original',
        paymentAddress: 'sys1qresumed1234567890',
        paymentAmountSats: '100000000',
        paymentCount: 1,
        startEpoch: 1800000000,
        endEpoch: 1802592000,
      });
      proposalService.updateDraft.mockResolvedValue({
        id: 77,
        userId: 42,
        name: 'resumed',
        url: '',
        paymentAddress: 'sys1qresumed1234567890',
        paymentAmountSats: '100000000',
        paymentCount: 1,
        startEpoch: 1800000000,
        endEpoch: 1802592000,
      });

      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/governance/new?draft=77']}>
            <AuthProvider authService={makeAuthService()}>
              <Switch>
                <Route
                  path="/governance/new"
                  render={() => {
                    // eslint-disable-next-line global-require
                    const NewProposalLocal =
                      require('./NewProposal').default;
                    return <NewProposalLocal />;
                  }}
                />
              </Switch>
            </AuthProvider>
          </MemoryRouter>
        );
      });

      // Wait for the draft to load into the form.
      await waitFor(() => {
        expect(screen.getByTestId('wizard-field-name').value).toBe('resumed');
        expect(screen.getByTestId('wizard-field-url').value).toBe(
          'https://forum.syscoin.org/t/original'
        );
      });

      // User deletes the url on step 1 (basics).
      fireEvent.change(screen.getByTestId('wizard-field-url'), {
        target: { value: '' },
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('wizard-save-draft'));
      });

      expect(proposalService.updateDraft).toHaveBeenCalledTimes(1);
      const [calledId, body] = proposalService.updateDraft.mock.calls[0];
      expect(calledId).toBe(77);
      // The critical invariant: cleared text fields MUST be sent
      // as explicit empty strings, NOT dropped from the body. Pre-
      // round-13 code dropped the empty `url` key entirely, so the
      // backend kept the old value and the user's delete was
      // silently reverted on reload.
      expect(body).toHaveProperty('url', '');
      // Populated text fields still flow through untouched.
      expect(body.name).toBe('resumed');
      // paymentAddress was loaded and NOT cleared — should be
      // included with its original value (forUpdate emits populated
      // text fields as-is).
      expect(body.paymentAddress).toBe('sys1qresumed1234567890');
    }
  );
});
