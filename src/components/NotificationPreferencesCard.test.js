import React from 'react';
import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Why `fireEvent.click` for the checkbox (and not `userEvent.click`):
//
//   `userEvent` v13.x dispatches a full pointer/mouse/click sequence
//   that, for a checkbox rendered INSIDE a <label>, bubbles the click
//   up to the label. The native label-click-forwards-to-input
//   behaviour then synthesises a SECOND click on the input, toggling
//   it back. Net effect: the checkbox appears to never change state.
//
//   `fireEvent.click` dispatches a single synthetic click on the
//   target directly, which is the behaviour the component expects
//   and which matches what a real browser does when the user clicks
//   the checkbox itself (as opposed to the surrounding text). We use
//   fireEvent only for the checkbox; userEvent stays for button
//   clicks where the full sequence matters.

import NotificationPreferencesCard from './NotificationPreferencesCard';
import { AuthProvider, useAuth } from '../context/AuthContext';

// AuthProbe — a sibling component that surfaces AuthContext state into
// the DOM so tests can assert on auth transitions (e.g. the card
// triggering handleAuthLost on a 401 should flip the probe to
// `anonymous`).
function AuthProbe() {
  const { isAuthenticated, isBooting } = useAuth();
  const state = isBooting
    ? 'booting'
    : isAuthenticated
    ? 'authenticated'
    : 'anonymous';
  return <div data-testid="auth-probe">{state}</div>;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
//
// NotificationPreferencesCard sits under AuthProvider because it reads
// `user.notificationPrefs` from the auth context. We stub authService's
// `me()` so AuthProvider's mount-time refresh hydrates a predictable
// user, then pass a separate authService stub INTO the card itself so
// its getPrefs/updatePrefs calls are observable.

function makeAuthService({ notificationPrefs } = {}) {
  return {
    me: jest.fn().mockResolvedValue({
      user: {
        id: 1,
        email: 'u@e.com',
        emailVerified: true,
        notificationPrefs,
        saltV: 'ab'.repeat(32),
      },
    }),
    login: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    verifyEmail: jest.fn(),
  };
}

function renderCard({ authService, cardAuthService, withProbe = false }) {
  return render(
    <AuthProvider authService={authService}>
      <NotificationPreferencesCard authService={cardAuthService} />
      {withProbe ? <AuthProbe /> : null}
    </AuthProvider>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationPreferencesCard', () => {
  test('defaults to enabled when the server returns empty prefs', async () => {
    const authService = makeAuthService({ notificationPrefs: {} });
    const cardAuthService = {
      getPrefs: jest.fn(),
      updatePrefs: jest.fn(),
    };
    renderCard({ authService, cardAuthService });
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-vote-reminders')
      ).toBeChecked()
    );
    // With prefs hydrated from /auth/me, the fallback getPrefs MUST
    // NOT be called (spec: single network read of user identity).
    expect(cardAuthService.getPrefs).not.toHaveBeenCalled();
  });

  test('reflects a server-stored opt-out as an unchecked toggle', async () => {
    const authService = makeAuthService({
      notificationPrefs: { voteReminders: { enabled: false } },
    });
    const cardAuthService = {
      getPrefs: jest.fn(),
      updatePrefs: jest.fn(),
    };
    renderCard({ authService, cardAuthService });
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-vote-reminders')
      ).not.toBeChecked()
    );
  });

  test('Save button is disabled until the value changes (no spurious PUTs)', async () => {
    const authService = makeAuthService({ notificationPrefs: {} });
    const cardAuthService = {
      getPrefs: jest.fn(),
      updatePrefs: jest.fn(),
    };
    renderCard({ authService, cardAuthService });
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-vote-reminders')
      ).toBeChecked()
    );
    expect(screen.getByTestId('notification-prefs-submit')).toBeDisabled();
    // Toggling the checkbox flips it to dirty and enables the Save
    // button.
    fireEvent.click(
      screen.getByTestId('notification-prefs-vote-reminders')
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-submit')
      ).not.toBeDisabled()
    );
  });

  test('toggling and saving PUTs the new value and shows a success alert', async () => {
    const authService = makeAuthService({ notificationPrefs: {} });
    const cardAuthService = {
      getPrefs: jest.fn(),
      updatePrefs: jest.fn().mockResolvedValue({
        voteReminders: { enabled: false },
      }),
    };
    renderCard({ authService, cardAuthService });
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-vote-reminders')
      ).toBeChecked()
    );
    fireEvent.click(
      screen.getByTestId('notification-prefs-vote-reminders')
    );
    // Wait for the onChange re-render before submitting, otherwise
    // the submit handler can see the stale `remindersEnabled` state
    // and PUT the same value that was saved.
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-vote-reminders')
      ).not.toBeChecked()
    );
    // Use fireEvent.submit on the form directly. userEvent.click on
    // the submit button under user-event@13 runs a full pointer
    // sequence that triggers label-forwarded clicks on the checkbox,
    // re-toggling it before our handler sees the submit.
    await act(async () => {
      fireEvent.submit(screen.getByTestId('notification-prefs-card'));
    });
    expect(cardAuthService.updatePrefs).toHaveBeenCalledTimes(1);
    expect(cardAuthService.updatePrefs).toHaveBeenCalledWith({
      voteReminders: { enabled: false },
    });
    await screen.findByTestId('notification-prefs-success');
    // After a successful save, the Save button goes back to disabled
    // because the form is no longer dirty (current === saved).
    expect(
      screen.getByTestId('notification-prefs-submit')
    ).toBeDisabled();
  });

  test('renders an error alert when the save fails', async () => {
    const authService = makeAuthService({ notificationPrefs: {} });
    const err = new Error('invalid_body');
    err.code = 'invalid_body';
    err.status = 400;
    const cardAuthService = {
      getPrefs: jest.fn(),
      updatePrefs: jest.fn().mockRejectedValue(err),
    };
    renderCard({ authService, cardAuthService });
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-vote-reminders')
      ).toBeChecked()
    );
    fireEvent.click(
      screen.getByTestId('notification-prefs-vote-reminders')
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-vote-reminders')
      ).not.toBeChecked()
    );
    await act(async () => {
      fireEvent.submit(screen.getByTestId('notification-prefs-card'));
    });
    const alert = await screen.findByTestId('notification-prefs-error');
    expect(alert).toHaveTextContent(/rejected as invalid/i);
    // Failed save keeps the Save button available for retry (form is
    // still dirty).
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-submit')
      ).not.toBeDisabled()
    );
    expect(
      screen.queryByTestId('notification-prefs-success')
    ).not.toBeInTheDocument();
  });

  test('save returning unauthorized flips AuthContext to anonymous (Codex PR 7 round 2 P2)', async () => {
    const authService = makeAuthService({ notificationPrefs: {} });
    const err = new Error('unauthorized');
    err.code = 'unauthorized';
    err.status = 401;
    const cardAuthService = {
      getPrefs: jest.fn(),
      updatePrefs: jest.fn().mockRejectedValue(err),
    };
    renderCard({ authService, cardAuthService, withProbe: true });
    await waitFor(() =>
      expect(screen.getByTestId('auth-probe')).toHaveTextContent('authenticated')
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-vote-reminders')
      ).toBeChecked()
    );
    fireEvent.click(
      screen.getByTestId('notification-prefs-vote-reminders')
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-vote-reminders')
      ).not.toBeChecked()
    );
    await act(async () => {
      fireEvent.submit(screen.getByTestId('notification-prefs-card'));
    });
    await waitFor(() =>
      expect(cardAuthService.updatePrefs).toHaveBeenCalled()
    );
    // Auth state must mirror the server's rejection.
    await waitFor(() =>
      expect(screen.getByTestId('auth-probe')).toHaveTextContent('anonymous')
    );
    // And we do NOT surface a spurious inline error — the user is
    // about to be redirected by PrivateRoute.
    expect(
      screen.queryByTestId('notification-prefs-error')
    ).not.toBeInTheDocument();
  });

  test('hydration returning unauthorized flips AuthContext to anonymous (Codex PR 7 round 2 P2)', async () => {
    // /auth/me omitted notificationPrefs → card falls back to GET
    // /auth/prefs, which then 401s. The expired-session path must
    // not leave us stuck rendering the Account page.
    const authService = {
      me: jest.fn().mockResolvedValue({
        user: {
          id: 1,
          email: 'u@e.com',
          emailVerified: true,
          saltV: 'ab'.repeat(32),
        },
      }),
      login: jest.fn(),
      logout: jest.fn(),
      register: jest.fn(),
      verifyEmail: jest.fn(),
    };
    const err = new Error('unauthorized');
    err.code = 'unauthorized';
    err.status = 401;
    const cardAuthService = {
      getPrefs: jest.fn().mockRejectedValue(err),
      updatePrefs: jest.fn(),
    };
    renderCard({ authService, cardAuthService, withProbe: true });
    await waitFor(() =>
      expect(cardAuthService.getPrefs).toHaveBeenCalled()
    );
    await waitFor(() =>
      expect(screen.getByTestId('auth-probe')).toHaveTextContent('anonymous')
    );
  });

  test('re-runs fallback hydration when the authenticated user identity changes (Codex PR 7 round 2 P2)', async () => {
    // Scenario: /auth/me omits notificationPrefs for BOTH users (so
    // the fallback GET /auth/prefs path is exercised), then the
    // session is refreshed and /auth/me now returns a different
    // user. Without keying hydration on user.id, the component
    // would keep user A's in-memory toggle state — and a Save
    // would PUT that stale value under user B's credentials.
    //
    // We drive the swap through a dedicated test-only button that
    // calls refresh() on AuthContext, since that's the same
    // mechanism real code uses (e.g. after login on the existing
    // tab, or after /auth/me is re-queried).
    function RefreshButton() {
      const { refresh } = useAuth();
      return (
        <button
          type="button"
          data-testid="trigger-refresh"
          onClick={() => {
            refresh();
          }}
        >
          refresh
        </button>
      );
    }
    const me = jest
      .fn()
      .mockResolvedValueOnce({
        user: {
          id: 1,
          email: 'a@e.com',
          emailVerified: true,
          saltV: 'ab'.repeat(32),
        },
      })
      .mockResolvedValueOnce({
        user: {
          id: 2,
          email: 'b@e.com',
          emailVerified: true,
          saltV: 'cd'.repeat(32),
        },
      });
    const authService = {
      me,
      login: jest.fn(),
      logout: jest.fn(),
      register: jest.fn(),
      verifyEmail: jest.fn(),
    };
    const getPrefs = jest
      .fn()
      .mockResolvedValueOnce({ voteReminders: { enabled: true } })
      .mockResolvedValueOnce({ voteReminders: { enabled: false } });
    const cardAuthService = {
      getPrefs,
      updatePrefs: jest.fn(),
    };

    render(
      <AuthProvider authService={authService}>
        <NotificationPreferencesCard authService={cardAuthService} />
        <RefreshButton />
      </AuthProvider>
    );

    // User A hydrates via GET /auth/prefs → enabled=true.
    await waitFor(() => expect(getPrefs).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-vote-reminders')
      ).toBeChecked()
    );

    // Swap to user B (different id, still no notificationPrefs).
    await act(async () => {
      fireEvent.click(screen.getByTestId('trigger-refresh'));
    });

    // The hydration effect MUST re-fire for the new identity and
    // the form MUST reflect user B's stored preference (disabled).
    await waitFor(() => expect(getPrefs).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-vote-reminders')
      ).not.toBeChecked()
    );
  });

  test('falls back to GET /auth/prefs only when /auth/me omitted notificationPrefs', async () => {
    const authService = makeAuthService({ notificationPrefs: null });
    // Simulate an older backend that didn't include notificationPrefs
    // on /auth/me. The card must hydrate via GET /auth/prefs exactly
    // once.
    authService.me = jest.fn().mockResolvedValue({
      user: {
        id: 1,
        email: 'u@e.com',
        emailVerified: true,
        saltV: 'ab'.repeat(32),
      },
    });
    const cardAuthService = {
      getPrefs: jest.fn().mockResolvedValue({
        voteReminders: { enabled: false },
      }),
      updatePrefs: jest.fn(),
    };
    renderCard({ authService, cardAuthService });
    await waitFor(() =>
      expect(cardAuthService.getPrefs).toHaveBeenCalledTimes(1)
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('notification-prefs-vote-reminders')
      ).not.toBeChecked()
    );
  });
});
