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

describe('ProposalVoteModal — guard rails', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns null when open=false', () => {
    const { container } = renderModal({ open: false, service: makeService() });
    expect(container.firstChild).toBeNull();
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
    expect(screen.getByTestId('vote-modal-toggle-k1').checked).toBe(true);
    expect(screen.getByTestId('vote-modal-toggle-k2').checked).toBe(true);
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

    fireEvent.click(screen.getByTestId('vote-modal-toggle-k2'));
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
