import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import {
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

    const errorState = await screen.findByTestId('vote-modal-error');
    expect(within(errorState).getByText(/lot of votes/i)).toBeInTheDocument();

    fireEvent.click(
      within(errorState).getByRole('button', { name: /try again/i })
    );
    await waitFor(() => {
      expect(screen.getByTestId('vote-modal-list')).toBeInTheDocument();
    });
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
    s.fetchReceipts = jest.fn().mockResolvedValue({
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

    // fetchReceipts got called with the proposal hash.
    expect(service.fetchReceipts).toHaveBeenCalledWith(
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
