import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

// Mock AuthContext and VaultContext — same rationale as
// useOwnedMasternodes.test.js: reconstructing the real providers drags
// PBKDF2 through jsdom and these component tests only care about the
// narrow surface (isAuthenticated, isUnlocked, data.keys).
jest.mock('../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));
jest.mock('../context/VaultContext', () => ({
  useVault: jest.fn(),
}));
// Voting itself is covered by voteSigner.test.js (KATs). Here we
// only care that the modal orchestrates the service correctly, so
// we stub signVoteFromWif to return a deterministic fake signature.
//
// NOTE: CRA's Jest config defaults to `resetMocks: true`, which
// wipes implementations (not just call history) before every test.
// So we can't rely on an impl passed to `jest.fn()` inside the
// factory — it'd be gone by the time each test runs. We install
// the default impl in beforeEach below.
jest.mock('../lib/syscoin/voteSigner', () => ({
  signVoteFromWif: jest.fn(),
}));

// eslint-disable-next-line import/first
import ProposalVoteModal from './ProposalVoteModal';
// eslint-disable-next-line import/first
import { useAuth } from '../context/AuthContext';
// eslint-disable-next-line import/first
import { useVault } from '../context/VaultContext';
// eslint-disable-next-line import/first
import { signVoteFromWif } from '../lib/syscoin/voteSigner';

function makeAuth(partial) {
  return { isAuthenticated: true, user: { id: 1 }, ...partial };
}
function makeVault(partial) {
  return {
    isIdle: false,
    isLoading: false,
    isLocked: false,
    isUnlocked: false,
    isEmpty: false,
    data: null,
    ...partial,
  };
}

function renderModal({
  auth = makeAuth(),
  vault = makeVault(),
  service,
  proposal = { Key: 'h'.repeat(64), name: 'SomeSponsor', title: 'Test Prop' },
  onClose = jest.fn(),
  open = true,
} = {}) {
  useAuth.mockReturnValue(auth);
  useVault.mockReturnValue(vault);
  return {
    onClose,
    ...render(
      <MemoryRouter>
        <ProposalVoteModal
          open={open}
          onClose={onClose}
          proposal={proposal}
          governanceService={service}
        />
      </MemoryRouter>
    ),
  };
}

function makeService({ lookup, submit } = {}) {
  return {
    lookupOwnedMasternodes:
      lookup ||
      jest.fn().mockResolvedValue([
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: 'c'.repeat(64),
          collateralIndex: 0,
          status: 'ENABLED',
        },
        {
          votingaddress: 'sys1qb',
          proTxHash: 'pro2',
          collateralHash: 'd'.repeat(64),
          collateralIndex: 1,
          status: 'ENABLED',
        },
      ]),
    submitVote:
      submit ||
      jest.fn().mockResolvedValue({
        accepted: 2,
        rejected: 0,
        results: [
          {
            collateralHash: 'c'.repeat(64),
            collateralIndex: 0,
            ok: true,
          },
          {
            collateralHash: 'd'.repeat(64),
            collateralIndex: 1,
            ok: true,
          },
        ],
      }),
  };
}

// Install the default signVoteFromWif impl for every test. Individual
// tests can still call mockImplementationOnce() to override.
beforeEach(() => {
  signVoteFromWif.mockImplementation(({ wif }) => {
    if (wif === 'THROW') {
      const e = new Error('bad wif');
      e.code = 'wif_invalid';
      throw e;
    }
    return { voteSig: `sig(${wif})` };
  });
});

const UNLOCKED_VAULT_WITH_TWO_KEYS = makeVault({
  isUnlocked: true,
  data: {
    keys: [
      { id: 'k1', label: 'alpha', wif: 'Lwif1', address: 'sys1qa' },
      { id: 'k2', label: 'beta', wif: 'Lwif2', address: 'sys1qb' },
    ],
  },
});

// Selection identity is keyed on collateralHash:collateralIndex (see
// `mnId` in the component). These match the fixture returned by
// makeService() below so tests can address individual checkboxes.
const OUTPOINT_A = `${'c'.repeat(64)}:0`;
const OUTPOINT_B = `${'d'.repeat(64)}:1`;

describe('ProposalVoteModal — guard rails', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns null when open=false', () => {
    const { container } = renderModal({ open: false, service: makeService() });
    expect(container.firstChild).toBeNull();
  });

  test('open=false never POSTs to /gov/mns/lookup, even with unlocked vault', async () => {
    // Governance.js always renders <ProposalVoteModal open={...} />,
    // so the hook must stay dormant until the user actually opens
    // the modal. Otherwise every authenticated user with an
    // unlocked vault hits /gov/mns/lookup on every page view and
    // leaks all their vault addresses pre-intent.
    const service = makeService();
    renderModal({
      open: false,
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(service.lookupOwnedMasternodes).not.toHaveBeenCalled();
  });

  test('open flipping false → true triggers the lookup exactly once', async () => {
    const service = makeService();
    useAuth.mockReturnValue(makeAuth());
    useVault.mockReturnValue(UNLOCKED_VAULT_WITH_TWO_KEYS);
    const proposal = { Key: 'h'.repeat(64), name: 'Sponsor', title: 'Prop' };

    const { rerender } = render(
      <MemoryRouter>
        <ProposalVoteModal
          open={false}
          onClose={() => {}}
          proposal={proposal}
          governanceService={service}
        />
      </MemoryRouter>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(service.lookupOwnedMasternodes).not.toHaveBeenCalled();

    rerender(
      <MemoryRouter>
        <ProposalVoteModal
          open
          onClose={() => {}}
          proposal={proposal}
          governanceService={service}
        />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(service.lookupOwnedMasternodes).toHaveBeenCalledTimes(1)
    );
  });

  test('unauthenticated users see the Login CTA', () => {
    renderModal({
      auth: makeAuth({ isAuthenticated: false, user: null }),
      service: makeService(),
    });
    expect(screen.getByTestId('vote-modal-guard-anon')).toBeInTheDocument();
    expect(screen.getByText(/log in to vote/i)).toBeInTheDocument();
  });

  test('authenticated but locked vault shows the unlock CTA', () => {
    renderModal({
      vault: makeVault({ isLocked: true }),
      service: makeService(),
    });
    expect(screen.getByTestId('vote-modal-guard-locked')).toBeInTheDocument();
  });

  test('authenticated + unlocked vault with zero imported keys shows the empty-vault CTA', async () => {
    // First-time user path: vault is unlocked but no voting keys have
    // been imported yet. Must NOT be conflated with "keys present but
    // none match a live MN" — different copy, different CTA.
    const service = {
      lookupOwnedMasternodes: jest.fn(),
      submitVote: jest.fn(),
    };
    renderModal({
      vault: makeVault({ isUnlocked: true, data: { keys: [] } }),
      service,
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('vote-modal-guard-empty-vault')
      ).toBeInTheDocument();
    });
    // Backend must not be hit — we know there are no addresses to look up.
    expect(service.lookupOwnedMasternodes).not.toHaveBeenCalled();
    // The "no matching MNs" guard MUST NOT render in parallel.
    expect(screen.queryByTestId('vote-modal-no-owned')).toBeNull();
    expect(screen.getByRole('link', { name: /go to account/i })).toHaveAttribute(
      'href',
      '/account'
    );
  });

  test('unlocked vault with no matching masternodes shows the empty state', async () => {
    const service = makeService({
      lookup: jest.fn().mockResolvedValue([]),
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-no-owned')).toBeInTheDocument();
    });
  });

  test('lookup error renders the retry CTA', async () => {
    const err = new Error('boom');
    err.code = 'rate_limited';
    const service = makeService({
      lookup: jest.fn().mockRejectedValue(err),
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('vote-modal-lookup-error')
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/rate_limited/)).toBeInTheDocument();
  });
});

describe('ProposalVoteModal — happy-path voting', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('renders picker with all MNs selected by default', async () => {
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service: makeService(),
    });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    expect(screen.getAllByTestId('vote-modal-row')).toHaveLength(2);
    expect(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_A}`).checked).toBe(
      true
    );
    expect(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_B}`).checked).toBe(
      true
    );
    expect(screen.getByTestId('vote-modal-submit').textContent).toMatch(
      /2 votes/i
    );
  });

  test('submit signs every selected MN, relays to service, renders per-entry results', async () => {
    const service = makeService();
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId('vote-modal-outcome-no'));
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });

    expect(signVoteFromWif).toHaveBeenCalledTimes(2);
    const firstCall = signVoteFromWif.mock.calls[0][0];
    expect(firstCall.voteOutcome).toBe('no');
    expect(firstCall.voteSignal).toBe('funding');
    expect(firstCall.proposalHash).toBe('h'.repeat(64));
    // collateralHash/Index derived from lookup
    expect(firstCall.collateralHash).toBe('c'.repeat(64));
    expect(firstCall.collateralIndex).toBe(0);

    expect(service.submitVote).toHaveBeenCalledTimes(1);
    const payload = service.submitVote.mock.calls[0][0];
    expect(payload.voteOutcome).toBe('no');
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0]).toEqual({
      collateralHash: 'c'.repeat(64),
      collateralIndex: 0,
      voteSig: 'sig(Lwif1)',
    });

    const rows = screen.getAllByTestId('vote-result-row');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.getAttribute('data-ok') === 'true')).toBe(true);
  });

  test('deselecting an MN shrinks the submitted batch', async () => {
    const service = makeService();
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_B}`));
    expect(screen.getByTestId('vote-modal-submit').textContent).toMatch(
      /1 vote/
    );

    fireEvent.click(screen.getByTestId('vote-modal-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });

    expect(signVoteFromWif).toHaveBeenCalledTimes(1);
    expect(service.submitVote.mock.calls[0][0].entries).toHaveLength(1);
    expect(service.submitVote.mock.calls[0][0].entries[0].voteSig).toBe(
      'sig(Lwif1)'
    );
  });

  test('two masternodes sharing one voting key are selectable independently', async () => {
    // Operators sometimes reuse a single voting key across multiple
    // masternodes. The backend returns one row per MN keyed on the
    // collateral outpoint, so one vault key can produce N `owned`
    // rows. Keying selection on vault-key-id would deduplicate
    // those rows into a single checkbox and force the user to vote
    // all-or-nothing. Selection MUST be keyed on outpoint so each
    // MN is an independent toggle.
    const SHARED_HASH_1 = 'c'.repeat(64);
    const SHARED_HASH_2 = 'e'.repeat(64);
    const service = {
      lookupOwnedMasternodes: jest.fn().mockResolvedValue([
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: SHARED_HASH_1,
          collateralIndex: 0,
          status: 'ENABLED',
        },
        {
          votingaddress: 'sys1qa', // SAME voting address, different MN
          proTxHash: 'pro2',
          collateralHash: SHARED_HASH_2,
          collateralIndex: 0,
          status: 'ENABLED',
        },
      ]),
      submitVote: jest.fn().mockResolvedValue({
        accepted: 1,
        rejected: 0,
        results: [
          { collateralHash: SHARED_HASH_1, collateralIndex: 0, ok: true },
        ],
      }),
    };
    renderModal({
      vault: makeVault({
        isUnlocked: true,
        data: {
          keys: [
            { id: 'k1', label: 'shared', wif: 'LwifS', address: 'sys1qa' },
          ],
        },
      }),
      service,
    });

    await waitFor(() =>
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument()
    );

    // Two distinct rows must render even though both share keyId 'k1'.
    expect(screen.getAllByTestId('vote-modal-row')).toHaveLength(2);

    // Each checkbox has a distinct outpoint-based testid.
    const tog1 = screen.getByTestId(`vote-modal-toggle-${SHARED_HASH_1}:0`);
    const tog2 = screen.getByTestId(`vote-modal-toggle-${SHARED_HASH_2}:0`);
    expect(tog1.checked).toBe(true);
    expect(tog2.checked).toBe(true);

    // Deselecting one must leave the other selected.
    fireEvent.click(tog2);
    expect(tog1.checked).toBe(true);
    expect(tog2.checked).toBe(false);
    expect(screen.getByTestId('vote-modal-submit').textContent).toMatch(
      /1 vote/
    );

    fireEvent.click(screen.getByTestId('vote-modal-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument()
    );

    // Only the selected MN got signed + relayed.
    expect(signVoteFromWif).toHaveBeenCalledTimes(1);
    expect(signVoteFromWif.mock.calls[0][0].collateralHash).toBe(SHARED_HASH_1);
    expect(service.submitVote.mock.calls[0][0].entries).toEqual([
      {
        collateralHash: SHARED_HASH_1,
        collateralIndex: 0,
        voteSig: 'sig(LwifS)',
      },
    ]);
  });

  test('Clear button disables the submit button', async () => {
    const service = makeService();
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('vote-modal-select-none'));
    expect(screen.getByTestId('vote-modal-submit')).toBeDisabled();
  });
});

describe('ProposalVoteModal — cancellation', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('closing the modal mid-signing aborts before submitVote is called', async () => {
    // Five vault keys force the sign loop into a yield checkpoint
    // (the modal yields to the event loop every 4 signatures). We
    // close the modal while that yield is pending, then let it
    // resume. The guarded code MUST NOT call submitVote on a cancelled
    // run — otherwise votes the user intended to cancel are still
    // relayed to Core.
    useAuth.mockReturnValue(makeAuth());
    useVault.mockReturnValue(
      makeVault({
        isUnlocked: true,
        data: {
          keys: [
            { id: 'k1', label: 'alpha', wif: 'Lwif1', address: 'sys1qa' },
            { id: 'k2', label: 'beta', wif: 'Lwif2', address: 'sys1qb' },
            { id: 'k3', label: 'gamma', wif: 'Lwif3', address: 'sys1qc' },
            { id: 'k4', label: 'delta', wif: 'Lwif4', address: 'sys1qd' },
            { id: 'k5', label: 'epsilon', wif: 'Lwif5', address: 'sys1qe' },
          ],
        },
      })
    );

    // Pending promise we never resolve — if the cancellation guard
    // isn't wired, submitVote would still be called post-yield and
    // setState would race.
    let submitVoteCalled = false;
    const service = {
      lookupOwnedMasternodes: jest.fn().mockResolvedValue([
        { votingaddress: 'sys1qa', proTxHash: 'p1', collateralHash: 'c'.repeat(64), collateralIndex: 0, status: 'ENABLED' },
        { votingaddress: 'sys1qb', proTxHash: 'p2', collateralHash: 'd'.repeat(64), collateralIndex: 0, status: 'ENABLED' },
        { votingaddress: 'sys1qc', proTxHash: 'p3', collateralHash: 'e'.repeat(64), collateralIndex: 0, status: 'ENABLED' },
        { votingaddress: 'sys1qd', proTxHash: 'p4', collateralHash: 'f'.repeat(64), collateralIndex: 0, status: 'ENABLED' },
        { votingaddress: 'sys1qe', proTxHash: 'p5', collateralHash: 'a'.repeat(64), collateralIndex: 0, status: 'ENABLED' },
      ]),
      submitVote: jest.fn(() => {
        submitVoteCalled = true;
        return new Promise(() => {});
      }),
    };

    const proposal = { Key: 'h'.repeat(64), name: 'Sponsor', title: 'Prop' };

    const { rerender } = render(
      <MemoryRouter>
        <ProposalVoteModal
          open
          onClose={() => {}}
          proposal={proposal}
          governanceService={service}
        />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled()
    );

    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    // Wait for the SIGNING phase to render — that only happens after
    // the first batch of 4 signs completed and the loop hit its 0-ms
    // setTimeout yield. At this point the run is pending inside the
    // yield, waiting on the macrotask queue.
    await waitFor(() =>
      expect(screen.getByTestId('vote-modal-progress')).toBeInTheDocument()
    );

    // Close the modal. This is the trigger Codex flagged: the parent
    // unmounts / sets open=false, and the cleanup effect must bump
    // the run generation so the resumed sign loop bails.
    rerender(
      <MemoryRouter>
        <ProposalVoteModal
          open={false}
          onClose={() => {}}
          proposal={proposal}
          governanceService={service}
        />
      </MemoryRouter>
    );

    // Give the setTimeout(0) a chance to fire and any microtasks to
    // drain. If the guard is working, the resumed loop sees the
    // generation mismatch and returns before calling submitVote.
    await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 5));

    expect(submitVoteCalled).toBe(false);
    expect(service.submitVote).not.toHaveBeenCalled();
  });

  test('closing during submitVote suppresses the late DONE transition', async () => {
    // Guard against the other race: submitVote is in-flight when the
    // user closes. The response must NOT transition the (now-gone)
    // modal into DONE with stale results — otherwise reopening the
    // modal on a different proposal would show the previous run's
    // acceptance count for a split second.
    let resolveSubmit;
    const submitPromise = new Promise((resolve) => {
      resolveSubmit = resolve;
    });
    const service = makeService({
      submit: jest.fn(() => submitPromise),
    });

    useAuth.mockReturnValue(makeAuth());
    useVault.mockReturnValue(UNLOCKED_VAULT_WITH_TWO_KEYS);

    const proposal = { Key: 'h'.repeat(64), name: 'Sponsor', title: 'Prop' };

    const { rerender } = render(
      <MemoryRouter>
        <ProposalVoteModal
          open
          onClose={() => {}}
          proposal={proposal}
          governanceService={service}
        />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled()
    );
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    await waitFor(() => expect(service.submitVote).toHaveBeenCalled());

    rerender(
      <MemoryRouter>
        <ProposalVoteModal
          open={false}
          onClose={() => {}}
          proposal={proposal}
          governanceService={service}
        />
      </MemoryRouter>
    );

    resolveSubmit({
      accepted: 2,
      rejected: 0,
      results: [
        { collateralHash: 'c'.repeat(64), collateralIndex: 0, ok: true },
        { collateralHash: 'd'.repeat(64), collateralIndex: 1, ok: true },
      ],
    });
    await new Promise((r) => setTimeout(r, 5));

    // Re-open on same proposal and confirm we're back at the picker
    // phase, NOT the stale DONE view.
    rerender(
      <MemoryRouter>
        <ProposalVoteModal
          open
          onClose={() => {}}
          proposal={proposal}
          governanceService={service}
        />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('vote-modal-done')).toBeNull();
  });
});

describe('ProposalVoteModal — error paths', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('submitVote rejection puts the modal in the error phase with retry', async () => {
    const err = new Error('nope');
    err.code = 'rate_limited';
    const service = makeService({
      submit: jest.fn().mockRejectedValue(err),
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    // Error phase renders the richer rate-limit descriptor: a
    // short headline, the long explanation, and a live
    // countdown. "Try again" is disabled while the countdown is
    // positive so we don't silently retry into another 429.
    const errorState = await screen.findByTestId('vote-modal-error');
    expect(within(errorState).getByText(/too many votes/i)).toBeInTheDocument();
    expect(within(errorState).getByText(/lot of votes/i)).toBeInTheDocument();
    expect(
      within(errorState).getByTestId('vote-modal-rate-limit-countdown')
    ).toBeInTheDocument();
    expect(
      within(errorState).getByTestId('vote-modal-error-try-again')
    ).toBeDisabled();

    // "Edit selection" is always available — users can reconsider
    // their selection without waiting out the countdown.
    fireEvent.click(
      within(errorState).getByTestId('vote-modal-error-back-to-picker')
    );
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });
  });

  test('rate-limited error honours an explicit Retry-After from the server', async () => {
    const err = new Error('nope');
    err.code = 'rate_limited';
    // Retry-After of ~2 seconds — picked short enough to be
    // observable within the test's timing budget without mocking
    // timers, but long enough that the countdown definitely
    // renders before the tick clears it.
    err.retryAfterMs = 2500;
    const service = makeService({
      submit: jest.fn().mockRejectedValue(err),
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    const errorState = await screen.findByTestId('vote-modal-error');
    const countdown = within(errorState).getByTestId(
      'vote-modal-rate-limit-countdown'
    );
    // The rendered integer should reflect the server's hint
    // (~2s) rather than the DEFAULT_RATE_LIMIT_RETRY_MS fallback
    // (~60s). Use a range because the test tick measures wall
    // clock time.
    const match = countdown.textContent.match(/(\d+)s/);
    expect(match).toBeTruthy();
    const seconds = Number(match[1]);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(3);
  });

  test('server_error shows an auto-retry countdown and a cancel button', async () => {
    // The first submit returns a 5xx-style error; we verify the
    // modal schedules an auto-retry (visible countdown) and that
    // the user can cancel it.
    const err = new Error('boom');
    err.code = 'server_error';
    const service = makeService({
      submit: jest.fn().mockRejectedValue(err),
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    const errorState = await screen.findByTestId('vote-modal-error');
    expect(
      within(errorState).getByTestId('vote-modal-auto-retry-countdown')
    ).toBeInTheDocument();
    const cancel = within(errorState).getByTestId(
      'vote-modal-cancel-auto-retry'
    );
    fireEvent.click(cancel);
    // After cancel, the auto-retry countdown disappears but the
    // error state remains.
    await waitFor(() => {
      expect(
        within(errorState).queryByTestId('vote-modal-auto-retry-countdown')
      ).toBeNull();
    });
  });

  test('online-event auto-resume drains the offline queue before rerunning', async () => {
    // Codex P1: resumeOfflineQueue / discardOfflineQueue were the
    // only code paths calling drainOfflineVote; the onOnline auto-
    // resume fell straight through to rerunLastBatch() without
    // clearing sessionStorage. A successful auto-retry therefore
    // left the entry behind as a phantom that would re-surface on
    // the next modal open. Lock in the contract: the `online`
    // event drains the queue before calling rerun.
    const originalOnLine = Object.getOwnPropertyDescriptor(
      window.navigator,
      'onLine'
    );
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => false,
    });
    try {
      window.sessionStorage.clear();
      const netErr = new Error('net');
      netErr.code = 'network_error';
      const service = makeService({
        submit: jest
          .fn()
          // First attempt: offline failure, enqueues intent.
          .mockRejectedValueOnce(netErr)
          // Second attempt (online-event rerun): succeeds.
          .mockResolvedValueOnce({
            accepted: 2,
            rejected: 0,
            results: [
              { collateralHash: 'c'.repeat(64), collateralIndex: 0, ok: true },
              { collateralHash: 'd'.repeat(64), collateralIndex: 1, ok: true },
            ],
          }),
      });
      renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });
      await waitFor(() => {
        expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
      });
      fireEvent.click(screen.getByTestId('vote-modal-submit'));
      await screen.findByTestId('vote-modal-error');
      // Queue is populated by the failure path.
      expect(window.sessionStorage.getItem('gov:pending:v1')).toBeTruthy();

      // Come back online: the onOnline handler must drain the
      // queue BEFORE firing the rerun, so after the successful
      // second attempt we end up with an empty queue (not a
      // phantom entry that would re-surface on reopen).
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => true,
      });
      await act(async () => {
        window.dispatchEvent(new Event('online'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
      });
      expect(service.submitVote).toHaveBeenCalledTimes(2);
      expect(window.sessionStorage.getItem('gov:pending:v1')).toBeNull();
    } finally {
      if (originalOnLine) {
        Object.defineProperty(window.navigator, 'onLine', originalOnLine);
      }
      window.sessionStorage.clear();
    }
  });

  test('auto-retry budget resets per user-initiated run', async () => {
    // Codex P2: autoRetryAttemptsRef was only reset on modal open.
    // After one server-error incident burned its maxAttempts
    // window, a later independent server error in the same modal
    // session would skip auto-retry entirely. Verify the budget is
    // actually reset when the user clicks Try again — a fresh
    // incident should show a fresh countdown.
    const err = new Error('boom');
    err.code = 'server_error';
    const service = makeService({
      submit: jest.fn().mockRejectedValue(err),
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    const errorState = await screen.findByTestId('vote-modal-error');
    // First error session: countdown visible. Cancel to consume
    // the budget manually (simpler and deterministic than waiting
    // for two real timers to fire).
    expect(
      within(errorState).getByTestId('vote-modal-auto-retry-countdown')
    ).toBeInTheDocument();
    fireEvent.click(
      within(errorState).getByTestId('vote-modal-cancel-auto-retry')
    );
    await waitFor(() => {
      expect(
        within(errorState).queryByTestId('vote-modal-auto-retry-countdown')
      ).toBeNull();
    });

    // Click Try again. The submit rejects again with server_error
    // → we land back in ERROR. If the budget had not been reset
    // by the user-initiated run, the scheduler would skip the
    // countdown. Assert the fresh countdown appears.
    fireEvent.click(
      within(errorState).getByTestId('vote-modal-error-try-again')
    );
    await waitFor(() => {
      // submitVote was called twice (initial + Try again rerun).
      expect(service.submitVote).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId('vote-modal-error')).getByTestId(
          'vote-modal-auto-retry-countdown'
        )
      ).toBeInTheDocument();
    });
  });

  test('mn_not_found renders the CTA link on the DONE row', async () => {
    // A mn_not_found failure should render an inline "Go to
    // Account" link so the user can self-serve the fix without
    // hunting for the Account page.
    const service = makeService({
      submit: jest.fn().mockResolvedValue({
        accepted: 1,
        rejected: 1,
        results: [
          { collateralHash: 'c'.repeat(64), collateralIndex: 0, ok: true },
          {
            collateralHash: 'd'.repeat(64),
            collateralIndex: 1,
            ok: false,
            error: 'mn_not_found',
          },
        ],
      }),
    });
    renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('vote-modal-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId('vote-result-row');
    const failingRow = rows.find(
      (r) => r.getAttribute('data-error-code') === 'mn_not_found'
    );
    expect(failingRow).toBeTruthy();
    const cta = within(failingRow).getByTestId('vote-result-row-cta');
    expect(cta.getAttribute('href')).toBe('/account');
  });

  test('network_error while offline captures the intent and offers Resume / Discard', async () => {
    // Simulate an offline device: navigator.onLine=false + the
    // submitVote promise rejects with network_error. The modal
    // should surface the offline descriptor and the Resume /
    // Discard pair instead of the normal Try again CTA, and the
    // intent should land in sessionStorage so a fresh modal open
    // can re-offer it.
    const originalOnLine = Object.getOwnPropertyDescriptor(
      window.navigator,
      'onLine'
    );
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => false,
    });
    try {
      window.sessionStorage.clear();
      const err = new Error('net');
      err.code = 'network_error';
      const service = makeService({
        submit: jest
          .fn()
          // First call during offline: reject with network_error.
          .mockRejectedValueOnce(err)
          // Second call on Resume (test flips navigator back to
          // online before Resume): accept.
          .mockResolvedValueOnce({
            accepted: 2,
            rejected: 0,
            results: [
              {
                collateralHash: 'c'.repeat(64),
                collateralIndex: 0,
                ok: true,
              },
              {
                collateralHash: 'd'.repeat(64),
                collateralIndex: 1,
                ok: true,
              },
            ],
          }),
      });
      renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });
      await waitFor(() => {
        expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
      });
      fireEvent.click(screen.getByTestId('vote-modal-submit'));
      const errorState = await screen.findByTestId('vote-modal-error');
      // The offline descriptor replaces the raw network_error one.
      expect(errorState.getAttribute('data-error-code')).toBe('offline');
      const shortHeadline = errorState.querySelector(
        '.vote-modal__error-short'
      );
      expect(shortHeadline.textContent).toMatch(/offline/i);
      // Queue is persisted for this proposal.
      const queueRaw = window.sessionStorage.getItem('gov:pending:v1');
      expect(queueRaw).toBeTruthy();
      expect(JSON.parse(queueRaw)).toHaveProperty('h'.repeat(64));
      // Flip online so the Resume rerun actually reaches the
      // (now-succeeding) submit mock.
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => true,
      });
      fireEvent.click(
        within(errorState).getByTestId('vote-modal-offline-resume')
      );
      await waitFor(() => {
        expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
      });
      // Queue drained after resume.
      expect(window.sessionStorage.getItem('gov:pending:v1')).toBeNull();
    } finally {
      if (originalOnLine) {
        Object.defineProperty(window.navigator, 'onLine', originalOnLine);
      }
      window.sessionStorage.clear();
    }
  });

  test('cross-session: pre-existing offline queue surfaces as ERROR with Resume/Discard on reopen', async () => {
    // Codex P1: closing the modal (or reloading the page) while a
    // vote is queued offline must re-surface the pending intent
    // the next time the modal opens. Simulate that by seeding
    // sessionStorage with the canonical queue shape, opening a
    // fresh modal, and asserting:
    //
    //   * The modal lands in PHASE.ERROR with the `offline`
    //     descriptor (not the empty PICK that shipped originally).
    //   * Resume rehydrates the batch from queued.targets ×
    //     owned, calls submitVote with exactly those outpoints,
    //     and drains the sessionStorage entry.
    const PROPOSAL_HASH = 'h'.repeat(64);
    const queuedEntry = {
      proposalHash: PROPOSAL_HASH,
      voteOutcome: 'no',
      voteSignal: 'funding',
      targets: [
        {
          collateralHash: 'c'.repeat(64),
          collateralIndex: 0,
          keyId: 'k1',
          address: 'sys1qa',
          label: 'alpha',
        },
        {
          collateralHash: 'd'.repeat(64),
          collateralIndex: 1,
          keyId: 'k2',
          address: 'sys1qb',
          label: 'beta',
        },
      ],
      queuedAt: Date.now() - 1000,
      retryAfterMs: null,
    };
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      'gov:pending:v1',
      JSON.stringify({ [PROPOSAL_HASH]: queuedEntry })
    );
    try {
      const service = makeService({
        submit: jest.fn().mockResolvedValue({
          accepted: 2,
          rejected: 0,
          results: [
            { collateralHash: 'c'.repeat(64), collateralIndex: 0, ok: true },
            { collateralHash: 'd'.repeat(64), collateralIndex: 1, ok: true },
          ],
        }),
      });
      renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });

      // The modal must surface the queued intent immediately —
      // not render the empty PICK view.
      const errorState = await screen.findByTestId('vote-modal-error');
      expect(errorState.getAttribute('data-error-code')).toBe('offline');
      expect(
        within(errorState).getByTestId('vote-modal-offline-resume')
      ).toBeInTheDocument();
      expect(
        within(errorState).getByTestId('vote-modal-offline-discard')
      ).toBeInTheDocument();

      // Wait for `owned` to load so resume has something to map
      // targets against.
      await waitFor(() => {
        expect(service.lookupOwnedMasternodes).toHaveBeenCalled();
      });

      fireEvent.click(
        within(errorState).getByTestId('vote-modal-offline-resume')
      );

      await waitFor(() => {
        expect(service.submitVote).toHaveBeenCalledTimes(1);
      });
      const payload = service.submitVote.mock.calls[0][0];
      expect(payload.proposalHash).toBe(PROPOSAL_HASH);
      // Outcome is restored from the queued entry, not the default.
      expect(payload.voteOutcome).toBe('no');
      expect(payload.entries).toHaveLength(2);
      const outpoints = payload.entries
        .map((e) => `${e.collateralHash}:${e.collateralIndex}`)
        .sort();
      expect(outpoints).toEqual(
        [`${'c'.repeat(64)}:0`, `${'d'.repeat(64)}:1`].sort()
      );
      await waitFor(() => {
        expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
      });
      // Queue drained after resume.
      expect(window.sessionStorage.getItem('gov:pending:v1')).toBeNull();
    } finally {
      window.sessionStorage.clear();
    }
  });

  test('offline-queued error body uses WARN severity from the displayed descriptor', async () => {
    // Codex P3: severityClass was being derived from the raw
    // submitError descriptor (network_error → ERROR severity),
    // but the copy shown to the user comes from the `offline`
    // descriptor (WARN severity). That made the banner look
    // "red alarm" while reading "queued for later" — a visual
    // contradiction. Assert the severity class follows the
    // displayed descriptor.
    const originalOnLine = Object.getOwnPropertyDescriptor(
      window.navigator,
      'onLine'
    );
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => false,
    });
    try {
      window.sessionStorage.clear();
      const err = new Error('net');
      err.code = 'network_error';
      const service = makeService({
        submit: jest.fn().mockRejectedValue(err),
      });
      renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });
      await waitFor(() => {
        expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
      });
      fireEvent.click(screen.getByTestId('vote-modal-submit'));
      const errorState = await screen.findByTestId('vote-modal-error');
      expect(errorState.getAttribute('data-error-code')).toBe('offline');
      expect(errorState.className).toMatch(/vote-modal__error--warn/);
      expect(errorState.className).not.toMatch(/vote-modal__error--error/);
    } finally {
      if (originalOnLine) {
        Object.defineProperty(window.navigator, 'onLine', originalOnLine);
      }
      window.sessionStorage.clear();
    }
  });

  test('cross-session: queued-offline recovery is reachable even when no MNs are currently owned', async () => {
    // Codex P2: the `owned.length === 0` guard short-circuited
    // rendering to the "no masternodes" state, hiding the
    // Resume/Discard UI. A stale queued entry would then be
    // unreachable — sitting in sessionStorage forever and
    // re-surfacing on every reopen. The ERROR branch with
    // offlineQueued must take precedence so the user can at
    // least Discard the stale queue (and Resume falls back to
    // PICK gracefully when chosen.length === 0).
    const PROPOSAL_HASH = 'h'.repeat(64);
    const queuedEntry = {
      proposalHash: PROPOSAL_HASH,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      targets: [
        {
          collateralHash: 'c'.repeat(64),
          collateralIndex: 0,
          keyId: 'k1',
          address: 'sys1qa',
          label: 'alpha',
        },
      ],
      queuedAt: Date.now() - 1000,
      retryAfterMs: null,
    };
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      'gov:pending:v1',
      JSON.stringify({ [PROPOSAL_HASH]: queuedEntry })
    );
    try {
      // Lookup returns zero owned MNs — this is the state where
      // Codex flagged the bug.
      const service = makeService({
        lookup: jest.fn().mockResolvedValue([]),
      });
      renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });

      // The no-owned branch must NOT preempt the offline ERROR.
      const errorState = await screen.findByTestId('vote-modal-error');
      expect(errorState.getAttribute('data-error-code')).toBe('offline');
      expect(screen.queryByTestId('vote-modal-no-owned')).toBeNull();
      // Discard is reachable, and it clears the queue.
      fireEvent.click(
        within(errorState).getByTestId('vote-modal-offline-discard')
      );
      await waitFor(() => {
        expect(window.sessionStorage.getItem('gov:pending:v1')).toBeNull();
      });
    } finally {
      window.sessionStorage.clear();
    }
  });

  test('cross-session: Discard on a surfaced offline queue returns to PICK and drops the entry', async () => {
    const PROPOSAL_HASH = 'h'.repeat(64);
    const queuedEntry = {
      proposalHash: PROPOSAL_HASH,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      targets: [
        {
          collateralHash: 'c'.repeat(64),
          collateralIndex: 0,
          keyId: 'k1',
          address: 'sys1qa',
          label: 'alpha',
        },
      ],
      queuedAt: Date.now() - 1000,
      retryAfterMs: null,
    };
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      'gov:pending:v1',
      JSON.stringify({ [PROPOSAL_HASH]: queuedEntry })
    );
    try {
      const service = makeService();
      renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });

      const errorState = await screen.findByTestId('vote-modal-error');
      fireEvent.click(
        within(errorState).getByTestId('vote-modal-offline-discard')
      );

      // Back to the picker, and the queue entry is gone.
      await waitFor(() => {
        expect(screen.getByTestId('vote-modal-submit')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('vote-modal-error')).toBeNull();
      expect(window.sessionStorage.getItem('gov:pending:v1')).toBeNull();
      // No relay attempt.
      expect(service.submitVote).not.toHaveBeenCalled();
    } finally {
      window.sessionStorage.clear();
    }
  });

  test('already_voted renders as a benign dedup, not a red failure', async () => {
    // When the backend echoes already_voted for a row, the
    // network already has the exact vote the user wanted — so
    // the row should render as "Already on-chain" and should NOT
    // be counted toward the retryable-failure set.
    const service = makeService({
      submit: jest.fn().mockResolvedValue({
        accepted: 0,
        rejected: 1,
        results: [
          {
            collateralHash: 'c'.repeat(64),
            collateralIndex: 0,
            ok: false,
            error: 'already_voted',
          },
          {
            collateralHash: 'd'.repeat(64),
            collateralIndex: 1,
            ok: false,
            error: 'already_voted',
          },
        ],
      }),
    });
    renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('vote-modal-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId('vote-result-row');
    expect(rows).toHaveLength(2);
    rows.forEach((r) => {
      expect(r.getAttribute('data-benign-dup')).toBe('true');
      expect(within(r).getByText(/already on-chain/i)).toBeInTheDocument();
    });
    // No "Retry failed" prompt — the batch is logically done.
    expect(screen.queryByTestId('vote-modal-retry-failed')).toBeNull();
  });

  test('Retry failed re-submits only the failed rows and preserves prior successes in the DONE view', async () => {
    // First pass: one row succeeds, one row rejected. Second pass
    // (Retry failed): only the previously-failed MN is re-signed
    // and re-submitted; the prior success stays visible with its
    // original status row, and the totals reflect the merged state.
    const service = makeService({
      submit: jest
        .fn()
        // First attempt: k2 rejected by voteraw.
        .mockResolvedValueOnce({
          accepted: 1,
          rejected: 1,
          results: [
            { collateralHash: 'c'.repeat(64), collateralIndex: 0, ok: true },
            {
              collateralHash: 'd'.repeat(64),
              collateralIndex: 1,
              ok: false,
              error: 'vote_too_often',
            },
          ],
        })
        // Retry attempt: only k2 re-signs/re-submits and is accepted.
        .mockResolvedValueOnce({
          accepted: 1,
          rejected: 0,
          results: [
            { collateralHash: 'd'.repeat(64), collateralIndex: 1, ok: true },
          ],
        }),
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });
    expect(signVoteFromWif).toHaveBeenCalledTimes(2);
    // Retry button is visible because one row failed and it maps to
    // an MN still present in the `owned` list.
    const retryBtn = screen.getByTestId('vote-modal-retry-failed');
    fireEvent.click(retryBtn);

    await waitFor(() => {
      // Final totals: 1 prior success + 1 retry success = 2 accepted.
      expect(screen.getByText(/2/).closest('p').textContent).toMatch(
        /2 accepted/i
      );
    });
    // k2 was the only row re-signed on the retry pass (k1 already ok).
    expect(signVoteFromWif).toHaveBeenCalledTimes(3);
    expect(signVoteFromWif.mock.calls[2][0].collateralHash).toBe('d'.repeat(64));
    // The second submitVote payload contains only the failed row.
    expect(service.submitVote).toHaveBeenCalledTimes(2);
    const retryPayload = service.submitVote.mock.calls[1][0];
    expect(retryPayload.entries).toHaveLength(1);
    expect(retryPayload.entries[0].collateralHash).toBe('d'.repeat(64));

    // After the retry succeeds the failed row should no longer be
    // shown in the `is-error` state; both rows are now is-ok.
    await waitFor(() => {
      const rows = screen.getAllByTestId('vote-result-row');
      expect(rows.every((r) => r.getAttribute('data-ok') === 'true')).toBe(
        true
      );
    });
    // Retry button is gone because there's nothing left to retry.
    expect(screen.queryByTestId('vote-modal-retry-failed')).toBeNull();
  });

  test('Retry failed preserves unretryable failures in the merged summary', async () => {
    // Scenario: first pass produces three failure rows — two for
    // MNs that ARE still in `owned` (retryable) and one for an
    // outpoint that is NOT in `owned` (simulating an MN that
    // disappeared, or a phantom row the backend emitted). Retry
    // must re-sign the two retryable rows while keeping the third
    // failure visible and counted in the final rejected tally,
    // otherwise the DONE summary silently under-reports the
    // unresolved work.
    const PHANTOM = 'e'.repeat(64);
    const service = makeService({
      submit: jest
        .fn()
        // First attempt: both selected MNs fail, and the backend
        // additionally reports a failure for PHANTOM:0 (an
        // outpoint the frontend never sent — modelling a stale
        // row we have no way to retry).
        .mockResolvedValueOnce({
          accepted: 0,
          rejected: 3,
          results: [
            {
              collateralHash: 'c'.repeat(64),
              collateralIndex: 0,
              ok: false,
              error: 'vote_too_often',
            },
            {
              collateralHash: 'd'.repeat(64),
              collateralIndex: 1,
              ok: false,
              error: 'vote_too_often',
            },
            {
              collateralHash: PHANTOM,
              collateralIndex: 0,
              ok: false,
              error: 'mn_not_found',
            },
          ],
        })
        // Retry attempt: the two retryable rows succeed.
        .mockResolvedValueOnce({
          accepted: 2,
          rejected: 0,
          results: [
            { collateralHash: 'c'.repeat(64), collateralIndex: 0, ok: true },
            { collateralHash: 'd'.repeat(64), collateralIndex: 1, ok: true },
          ],
        }),
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });
    // First DONE: 3 rejections visible.
    expect(screen.getAllByTestId('vote-result-row')).toHaveLength(3);

    fireEvent.click(screen.getByTestId('vote-modal-retry-failed'));

    await waitFor(() => {
      // Retry payload contains ONLY the two retryable rows —
      // PHANTOM is not re-sent because it isn't in `owned`.
      expect(service.submitVote).toHaveBeenCalledTimes(2);
    });
    const retryPayload = service.submitVote.mock.calls[1][0];
    expect(retryPayload.entries).toHaveLength(2);
    expect(retryPayload.entries.map((e) => e.collateralHash).sort()).toEqual(
      ['c'.repeat(64), 'd'.repeat(64)].sort()
    );

    await waitFor(() => {
      const summary = screen.getByTestId('vote-modal-done').querySelector('p');
      // 2 accepted (retry successes), 1 rejected (PHANTOM carried
      // forward). The critical property: the phantom row is NOT
      // silently dropped from the rejected count.
      expect(summary.textContent).toMatch(/2 accepted/i);
      expect(summary.textContent).toMatch(/1 rejected/i);
    });
    // And the PHANTOM row is still visible in the list so the user
    // sees what's unresolved.
    const rows = screen.getAllByTestId('vote-result-row');
    expect(rows).toHaveLength(3);
    const phantomRow = rows.find(
      (r) => within(r).queryByText(/no longer active|vote failed/i) !== null
    );
    expect(phantomRow).toBeTruthy();
    expect(phantomRow.getAttribute('data-ok')).toBe('false');
  });

  test('Retry failed tolerates case-mismatched collateral hashes between endpoints', async () => {
    // Codex-review guard: if `/gov/mns/lookup` emits lowercase hashes
    // but `/gov/vote`'s response echoes them uppercase (or any
    // permutation), the retry path previously compared raw strings
    // and would classify every real failure as "unretryable",
    // silently hiding the Retry button. The outpoint-key helper
    // normalizes casing on both sides so such misalignment cannot
    // cause the user to lose the ability to retry.
    const lookupHash = 'c'.repeat(64); // lowercase from /gov/mns/lookup
    const voteHash = 'C'.repeat(64); // uppercase from /gov/vote
    const service = makeService({
      lookup: jest.fn().mockResolvedValue([
        {
          votingaddress: 'sys1qa',
          proTxHash: 'pro1',
          collateralHash: lookupHash,
          collateralIndex: 0,
          status: 'ENABLED',
        },
      ]),
      submit: jest
        .fn()
        .mockResolvedValueOnce({
          accepted: 0,
          rejected: 1,
          results: [
            {
              collateralHash: voteHash,
              collateralIndex: 0,
              ok: false,
              error: 'vote_too_often',
            },
          ],
        })
        .mockResolvedValueOnce({
          accepted: 1,
          rejected: 0,
          results: [
            { collateralHash: lookupHash, collateralIndex: 0, ok: true },
          ],
        }),
    });
    renderModal({
      vault: {
        ...makeVault({ isUnlocked: true }),
        data: {
          keys: [
            {
              keyId: 'k1',
              wif: 'L4rK1eSyt6yJ2e7wGrHqH2Dq8oBFhrDpGZsJZxJV9Z1Kzcc2KP3e',
              collateralHash: lookupHash,
              collateralIndex: 0,
              address: 'sys1qa',
              label: 'mn-1',
            },
          ],
        },
      },
      service,
    });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });
    // Retry button must be visible — despite the backend echoing
    // the hash in uppercase, the frontend recognises the failed
    // row as retryable because case is normalized.
    const retryBtn = screen.getByTestId('vote-modal-retry-failed');
    expect(retryBtn).toBeInTheDocument();

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(service.submitVote).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      const summary = screen.getByTestId('vote-modal-done').querySelector('p');
      expect(summary.textContent).toMatch(/1 accepted/i);
      expect(summary.textContent).toMatch(/0 rejected/i);
    });
  });

  test('Retry failed excludes benign dedup (already_voted) rows from the re-submit payload', async () => {
    // Codex P2: the retry picker previously included every !ok row,
    // so in a mixed batch it would re-submit `already_voted`
    // alongside real failures. That contradicts the benign-dedup
    // story we tell the user (Already on-chain) and would trigger
    // avoidable duplicate / cooldown errors. Lock in the contract:
    // on Retry failed, only rows that are !ok && !isBenignDup are
    // re-signed and re-submitted; benign-dup rows stay in place in
    // the merged summary as soft successes.
    const service = makeService({
      submit: jest
        .fn()
        // First pass: k1 → already_voted (benign), k2 → real failure.
        .mockResolvedValueOnce({
          accepted: 0,
          rejected: 2,
          results: [
            {
              collateralHash: 'c'.repeat(64),
              collateralIndex: 0,
              ok: false,
              error: 'already_voted',
            },
            {
              collateralHash: 'd'.repeat(64),
              collateralIndex: 1,
              ok: false,
              error: 'vote_too_often',
            },
          ],
        })
        // Retry pass: only k2 is re-submitted (see assertions).
        .mockResolvedValueOnce({
          accepted: 1,
          rejected: 0,
          results: [
            { collateralHash: 'd'.repeat(64), collateralIndex: 1, ok: true },
          ],
        }),
    });
    renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });

    const retryBtn = screen.getByTestId('vote-modal-retry-failed');
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(service.submitVote).toHaveBeenCalledTimes(2);
    });
    const retryPayload = service.submitVote.mock.calls[1][0];
    expect(retryPayload.entries).toHaveLength(1);
    expect(retryPayload.entries[0].collateralHash).toBe('d'.repeat(64));
    expect(retryPayload.entries[0].collateralIndex).toBe(1);
    // The benign row must have been re-signed zero additional
    // times — the retry set never included its outpoint.
    const firstSignCalls = signVoteFromWif.mock.calls.filter(
      (c) => c[0].collateralHash === 'c'.repeat(64)
    );
    // One sign for the initial submit, none for the retry pass.
    expect(firstSignCalls).toHaveLength(1);

    // The merged DONE view: k1 stays as Already on-chain, k2 is now ok.
    await waitFor(() => {
      const summary = screen.getByTestId('vote-modal-done').querySelector('p');
      expect(summary.textContent).toMatch(/1 accepted/i);
    });
    const rows = screen.getAllByTestId('vote-result-row');
    expect(rows).toHaveLength(2);
    const benignRow = rows.find(
      (r) => r.getAttribute('data-benign-dup') === 'true'
    );
    expect(benignRow).toBeDefined();
    expect(within(benignRow).getByText(/already on-chain/i)).toBeInTheDocument();
  });

  test('per-signing-row failure surfaces in the DONE list alongside backend results', async () => {
    // Make signVoteFromWif throw for the second key; the first one
    // still signs. Backend relay should get only one entry, but the
    // DONE view shows both rows (one ok, one signing-failed).
    signVoteFromWif.mockImplementationOnce(() => ({ voteSig: 'sig(Lwif1)' }));
    signVoteFromWif.mockImplementationOnce(() => {
      const e = new Error('bad');
      e.code = 'wif_invalid';
      throw e;
    });

    const service = makeService({
      submit: jest.fn().mockResolvedValue({
        accepted: 1,
        rejected: 0,
        results: [
          {
            collateralHash: 'c'.repeat(64),
            collateralIndex: 0,
            ok: true,
          },
        ],
      }),
    });

    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });

    const rows = screen.getAllByTestId('vote-result-row');
    expect(rows).toHaveLength(2);
    const ok = rows.find((r) => r.getAttribute('data-ok') === 'true');
    const bad = rows.find((r) => r.getAttribute('data-ok') === 'false');
    expect(ok).toBeTruthy();
    expect(bad).toBeTruthy();
    expect(within(bad).getByText(/vote failed/i)).toBeInTheDocument();

    expect(service.submitVote.mock.calls[0][0].entries).toHaveLength(1);
  });
});

describe('ProposalVoteModal — receipts-aware default selection', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  function makeReceiptService({ receipts = [], reconcileError = null } = {}) {
    const s = makeService();
    s.reconcileReceipts = jest.fn().mockResolvedValue({
      receipts,
      reconciled: !reconcileError,
      reconcileError,
      updated: 0,
    });
    return s;
  }

  function confirmedReceipt({ hash, index, outcome = 'yes' }) {
    return {
      collateralHash: hash,
      collateralIndex: index,
      status: 'confirmed',
      voteOutcome: outcome,
      voteSignal: 'funding',
      voteTime: 1700000000,
      verifiedAt: 1700000001,
      updatedAt: 1700000001,
      createdAt: 1700000000,
      lastError: null,
    };
  }

  test('default selection excludes MNs with a confirmed receipt at the current outcome', async () => {
    // MN "A" (c:0) already has a confirmed 'yes' vote on this
    // proposal. The initial outcome is 'yes', so A should render
    // unchecked by default — we don't want to re-submit a vote the
    // network already has. MN "B" has no receipt and stays checked.
    const service = makeReceiptService({
      receipts: [
        confirmedReceipt({ hash: 'c'.repeat(64), index: 0, outcome: 'yes' }),
      ],
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    // reconcileReceipts got called with the proposal hash.
    expect(service.reconcileReceipts).toHaveBeenCalledWith(
      'h'.repeat(64),
      expect.objectContaining({ refresh: false })
    );

    expect(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_A}`).checked).toBe(
      false
    );
    expect(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_B}`).checked).toBe(
      true
    );
    // The submit button reflects the reduced default count.
    expect(screen.getByTestId('vote-modal-submit').textContent).toMatch(
      /1 vote/
    );

    // And row A shows a receipt badge telling the user why.
    const rowA = screen.getByTestId('vote-modal-list').querySelector(
      `[data-mn-id="${OUTPOINT_A}"]`
    );
    expect(within(rowA).getByTestId('vote-modal-row-receipt').textContent).toMatch(
      /already voted yes/i
    );
  });

  test('switching outcome recomputes the default to include a vote-change candidate', async () => {
    // MN A has confirmed 'yes'. User switches outcome to 'no' → A
    // should now be CHECKED by default because the intent is to
    // change the vote. The badge flips to "(will change)".
    const service = makeReceiptService({
      receipts: [
        confirmedReceipt({ hash: 'c'.repeat(64), index: 0, outcome: 'yes' }),
      ],
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    expect(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_A}`).checked).toBe(
      false
    );
    fireEvent.click(screen.getByTestId('vote-modal-outcome-no'));

    // Default selection recomputes because the user hasn't interacted
    // with any checkbox yet (selected === null).
    expect(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_A}`).checked).toBe(
      true
    );
    const rowA = screen.getByTestId('vote-modal-list').querySelector(
      `[data-mn-id="${OUTPOINT_A}"]`
    );
    expect(within(rowA).getByTestId('vote-modal-row-receipt').textContent).toMatch(
      /voted yes \(will change\)/i
    );
  });

  test('explicit user interaction freezes the selection across outcome changes', async () => {
    // Same setup as above but the user deselects MN B before
    // changing outcome. Once `selected` becomes a concrete Set we
    // must not override it on outcome changes — otherwise a user
    // who explicitly unchecked a row would see it silently get
    // re-checked by the receipt-aware default.
    const service = makeReceiptService({
      receipts: [
        confirmedReceipt({ hash: 'c'.repeat(64), index: 0, outcome: 'yes' }),
      ],
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    // Default: A unchecked (confirmed-yes), B checked.
    fireEvent.click(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_B}`));
    // Now A unchecked, B unchecked. Submit should be disabled.
    expect(screen.getByTestId('vote-modal-submit')).toBeDisabled();

    // Change outcome to 'no'. Explicit selection must persist —
    // A does NOT flip back to checked.
    fireEvent.click(screen.getByTestId('vote-modal-outcome-no'));
    expect(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_A}`).checked).toBe(
      false
    );
    expect(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_B}`).checked).toBe(
      false
    );
  });

  test('Select all overrides the receipt-aware default', async () => {
    // Explicit "select all" is a user intent we must respect even
    // if it re-submits votes that already succeeded on-chain. The
    // backend decideRelay() will short-circuit them as skipped so
    // this is harmless — but we still want the checkbox to reflect
    // the selection the user chose.
    const service = makeReceiptService({
      receipts: [
        confirmedReceipt({ hash: 'c'.repeat(64), index: 0, outcome: 'yes' }),
      ],
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('vote-modal-select-all'));

    expect(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_A}`).checked).toBe(
      true
    );
    expect(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_B}`).checked).toBe(
      true
    );
  });

  test('DONE view uses distinct copy for short-circuited backend results', async () => {
    // decideRelay() on the backend can return ok:true with a
    // skipped reason ('already_on_chain' or 'recently_relayed').
    // The DONE view should surface the distinction so the user
    // isn't told "Yes accepted" for a vote that wasn't actually
    // relayed again.
    const service = makeService({
      submit: jest.fn().mockResolvedValue({
        accepted: 2,
        rejected: 0,
        results: [
          {
            collateralHash: 'c'.repeat(64),
            collateralIndex: 0,
            ok: true,
            skipped: 'already_on_chain',
          },
          {
            collateralHash: 'd'.repeat(64),
            collateralIndex: 1,
            ok: true,
            skipped: 'recently_relayed',
          },
        ],
      }),
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId('vote-result-row');
    expect(rows).toHaveLength(2);
    const alreadyOnChain = rows.find(
      (r) => r.getAttribute('data-skipped') === 'already_on_chain'
    );
    const recentlyRelayed = rows.find(
      (r) => r.getAttribute('data-skipped') === 'recently_relayed'
    );
    expect(alreadyOnChain).toBeTruthy();
    expect(recentlyRelayed).toBeTruthy();
    expect(within(alreadyOnChain).getByText(/already on-chain/i)).toBeInTheDocument();
    expect(within(recentlyRelayed).getByText(/already submitted/i)).toBeInTheDocument();
  });

  test('reconcile error surfaces as a non-blocking banner', async () => {
    // Receipts fetch failed (backend RPC down, etc). Voting still
    // works — the banner warns the user that recent votes may be
    // re-submitted, which is harmless thanks to decideRelay.
    const service = makeReceiptService({
      receipts: [],
      reconcileError: 'rpc_failed',
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('vote-modal-reconcile-error').textContent
    ).toMatch(/rpc_failed/);
    // Voting stays functional.
    expect(screen.getByTestId('vote-modal-submit')).not.toBeDisabled();
  });

  test('non-confirmed receipts (failed/stale) leave the row checked with a hint badge', async () => {
    // A 'failed' receipt means the last attempt didn't land. We
    // want the user to include that row by default (so another
    // attempt actually happens) AND to see a label explaining the
    // state, so the unchanged checkbox isn't a silent surprise.
    const service = makeReceiptService({
      receipts: [
        {
          collateralHash: 'c'.repeat(64),
          collateralIndex: 0,
          status: 'failed',
          voteOutcome: 'yes',
          voteSignal: 'funding',
          lastError: 'vote_too_often',
          voteTime: 1700000000,
          verifiedAt: null,
          updatedAt: 1700000100,
          createdAt: 1700000000,
        },
      ],
    });
    renderModal({
      vault: UNLOCKED_VAULT_WITH_TWO_KEYS,
      service,
    });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    expect(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_A}`).checked).toBe(
      true
    );
    const rowA = screen.getByTestId('vote-modal-list').querySelector(
      `[data-mn-id="${OUTPOINT_A}"]`
    );
    expect(within(rowA).getByTestId('vote-modal-row-receipt').textContent).toMatch(
      /last attempt failed/i
    );
  });
});

describe('ProposalVoteModal — grouped picker + vote-change confirmation', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  // Same helpers as the receipts-aware describe block. Duplicated
  // locally to keep this suite independently runnable; they're
  // cheap and the signatures rarely churn.
  function makeReceiptService({ receipts = [], reconcileError = null } = {}) {
    const s = makeService();
    s.reconcileReceipts = jest.fn().mockResolvedValue({
      receipts,
      reconciled: !reconcileError,
      reconcileError,
      updated: 0,
    });
    return s;
  }
  function receipt({ hash, index, status = 'confirmed', outcome = 'yes' }) {
    return {
      collateralHash: hash,
      collateralIndex: index,
      status,
      voteOutcome: outcome,
      voteSignal: 'funding',
      voteTime: 1700000000,
      verifiedAt: 1700000001,
      updatedAt: 1700000001,
      createdAt: 1700000000,
      lastError: null,
    };
  }

  test('rows bucket into Action needed and Already voted sections', async () => {
    // Two MNs from the standard fixture:
    //  A (c:0) → confirmed 'yes' at current outcome → Already voted
    //  B (d:1) → failed last attempt              → Action needed
    //
    // Needs vote section is intentionally absent in this fixture
    // (covered separately by "only sections with content render").
    const service = makeReceiptService({
      receipts: [
        receipt({ hash: 'c'.repeat(64), index: 0, status: 'confirmed', outcome: 'yes' }),
        receipt({ hash: 'd'.repeat(64), index: 1, status: 'failed', outcome: 'yes' }),
      ],
    });
    renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    const actionNeeded = screen.getByTestId('vote-modal-group-action-needed');
    const alreadyVoted = screen.getByTestId('vote-modal-group-already-voted');
    expect(
      screen.queryByTestId('vote-modal-group-needs-vote')
    ).not.toBeInTheDocument();

    // Each row lands in exactly one section.
    expect(
      within(actionNeeded).getByTestId('vote-modal-row').getAttribute('data-mn-id')
    ).toBe(OUTPOINT_B);
    // Already voted section is collapsed by default — the section
    // itself mounts but its <ul> is hidden. The checkbox is still
    // in the DOM (testing-library ignores display) so `selected`
    // logic has a stable target for tests.
    expect(alreadyVoted.getAttribute('data-collapsed')).toBe('true');
    const alreadyRow = alreadyVoted.querySelector(
      `[data-mn-id="${OUTPOINT_A}"]`
    );
    expect(alreadyRow).not.toBeNull();
    expect(alreadyRow.getAttribute('data-row-kind')).toBe(
      'confirmed-match'
    );
  });

  test('Already voted section toggles open on click and reveals its rows', async () => {
    const service = makeReceiptService({
      receipts: [
        receipt({ hash: 'c'.repeat(64), index: 0, status: 'confirmed', outcome: 'yes' }),
      ],
    });
    renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    const alreadyVoted = screen.getByTestId('vote-modal-group-already-voted');
    expect(alreadyVoted.getAttribute('data-collapsed')).toBe('true');
    const toggle = screen.getByTestId('vote-modal-toggle-already-voted');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(alreadyVoted.getAttribute('data-collapsed')).toBe('false');
    expect(
      screen.getByTestId('vote-modal-toggle-already-voted').getAttribute(
        'aria-expanded'
      )
    ).toBe('true');
  });

  test('only sections with content render', async () => {
    // No receipts at all → only "Needs vote" is mounted.
    const service = makeReceiptService({ receipts: [] });
    renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    expect(screen.getByTestId('vote-modal-group-needs-vote')).toBeInTheDocument();
    expect(
      screen.queryByTestId('vote-modal-group-action-needed')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('vote-modal-group-already-voted')
    ).not.toBeInTheDocument();
  });

  test('vote-change confirmation guards overwriting an existing on-chain vote', async () => {
    // MN A confirmed yes. User flips outcome to no and clicks Sign
    // & Submit — should first see a CONFIRM_CHANGE phase listing
    // the vote-change targets, not jump straight to signing.
    const service = makeReceiptService({
      receipts: [
        receipt({ hash: 'c'.repeat(64), index: 0, status: 'confirmed', outcome: 'yes' }),
      ],
    });
    renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    // Flip to no — A now becomes a vote-change candidate, so it's
    // checked by default and sits in the Action needed bucket.
    fireEvent.click(screen.getByTestId('vote-modal-outcome-no'));
    expect(
      screen.getByTestId(`vote-modal-toggle-${OUTPOINT_A}`).checked
    ).toBe(true);

    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    // Confirmation phase replaces the picker — no submit yet.
    expect(
      screen.getByTestId('vote-modal-confirm-change')
    ).toBeInTheDocument();
    expect(service.submitVote).not.toHaveBeenCalled();

    // And it tells the user exactly which MNs are changing.
    const changeList = screen.getByTestId('vote-modal-change-list');
    expect(within(changeList).getAllByText(/yes → no/i).length).toBe(1);
  });

  test('CONFIRM_CHANGE "Back" returns to picker without calling submitVote', async () => {
    const service = makeReceiptService({
      receipts: [
        receipt({ hash: 'c'.repeat(64), index: 0, status: 'confirmed', outcome: 'yes' }),
      ],
    });
    renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('vote-modal-outcome-no'));
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    fireEvent.click(
      screen.getByTestId('vote-modal-confirm-change-cancel')
    );

    // Back in the picker.
    expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    expect(
      screen.queryByTestId('vote-modal-confirm-change')
    ).not.toBeInTheDocument();
    expect(service.submitVote).not.toHaveBeenCalled();
  });

  test('CONFIRM_CHANGE "Change votes" proceeds to sign and submit', async () => {
    const service = makeReceiptService({
      receipts: [
        receipt({ hash: 'c'.repeat(64), index: 0, status: 'confirmed', outcome: 'yes' }),
      ],
    });
    // Mute submitVote so we land cleanly in DONE.
    service.submitVote = jest.fn().mockResolvedValue({
      accepted: 1,
      rejected: 0,
      results: [
        {
          ok: true,
          collateralHash: 'c'.repeat(64),
          collateralIndex: 0,
          error: null,
        },
      ],
    });
    renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });
    // Only select A so the vote-change fires.
    fireEvent.click(screen.getByTestId('vote-modal-outcome-no'));
    // Deselect B (no receipt, not a change candidate).
    fireEvent.click(screen.getByTestId(`vote-modal-toggle-${OUTPOINT_B}`));

    fireEvent.click(screen.getByTestId('vote-modal-submit'));
    expect(
      screen.getByTestId('vote-modal-confirm-change')
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByTestId('vote-modal-confirm-change-submit')
    );

    // Eventually we reach DONE — submitVote was called with 'no'.
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });
    expect(service.submitVote).toHaveBeenCalledWith(
      expect.objectContaining({ voteOutcome: 'no' })
    );
  });

  test('live progress renders a per-row status during SIGNING', async () => {
    // We deliberately set signVoteFromWif up to throw for MN B and
    // succeed for MN A. Because the real sign loop yields control
    // every 4 iterations (2 MNs here stays synchronous), the
    // signing completes before we can see intermediate states —
    // so this test inspects the terminal live-progress view just
    // before submit resolves. Wrap submitVote in a pending promise
    // to hold SUBMITTING open while we assert.
    let releaseSubmit;
    const service = makeReceiptService({ receipts: [] });
    service.submitVote = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseSubmit = () =>
            resolve({
              accepted: 1,
              rejected: 0,
              results: [
                {
                  ok: true,
                  collateralHash: 'c'.repeat(64),
                  collateralIndex: 0,
                  error: null,
                },
              ],
            });
        })
    );
    signVoteFromWif.mockImplementation(({ wif }) => {
      if (wif === 'Lwif2') {
        const e = new Error('sig fail');
        e.code = 'sign_failed';
        throw e;
      }
      return { voteSig: '00'.repeat(65) };
    });

    renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    // After signing finishes we're in SUBMITTING waiting for the
    // pending submitVote promise. The progress list should carry
    // two rows — A in 'submitting' status (signed OK) and B in
    // 'sign-failed' status (sticky).
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-progress')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId('vote-modal-progress-row');
    expect(rows).toHaveLength(2);
    const byMn = {};
    for (const r of rows) byMn[r.getAttribute('data-mn-id')] = r;
    expect(byMn[OUTPOINT_A].getAttribute('data-row-status')).toBe(
      'submitting'
    );
    expect(byMn[OUTPOINT_B].getAttribute('data-row-status')).toBe(
      'sign-failed'
    );

    // Release the pending submitVote so the modal transitions to
    // DONE cleanly and the test doesn't leak a hanging promise.
    releaseSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });
  });

  test('no confirmation step when selection has no vote-change candidates', async () => {
    // Confirmed receipts at the CURRENT outcome stay in Already
    // voted and are excluded from the default selection → no
    // vote-change candidates → startVoting goes straight to signing.
    const service = makeReceiptService({
      receipts: [
        receipt({ hash: 'c'.repeat(64), index: 0, status: 'confirmed', outcome: 'yes' }),
      ],
    });
    service.submitVote = jest.fn().mockResolvedValue({
      accepted: 1,
      rejected: 0,
      results: [
        {
          ok: true,
          collateralHash: 'd'.repeat(64),
          collateralIndex: 1,
          error: null,
        },
      ],
    });
    renderModal({ vault: UNLOCKED_VAULT_WITH_TWO_KEYS, service });
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });
    // Outcome stays 'yes'. Submit — only B is chosen by default
    // (A sits in Already voted, unchecked). No change, straight to
    // signing.
    fireEvent.click(screen.getByTestId('vote-modal-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-done')).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId('vote-modal-confirm-change')
    ).not.toBeInTheDocument();
    expect(service.submitVote).toHaveBeenCalledTimes(1);
  });
});
