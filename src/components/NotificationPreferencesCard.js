import React, { useCallback, useEffect, useRef, useState } from 'react';

import { authService as defaultAuthService } from '../lib/authService';
import { useAuth } from '../context/AuthContext';

// NotificationPreferencesCard
// -----------------------------------------------------------------------
// Account-page card for toggling email notification preferences.
//
// The only bucket wired today is `voteReminders.enabled`, which
// controls whether the backend's reminderDispatcher sends a user a
// "proposals closing soon" email once per cycle.
//
// Default value: the backend treats an omitted flag as `enabled:true`
// (see sysnode-backend/lib/users.js:listWithRemindersEnabled). We
// mirror that default on the client so the checkbox is pre-checked
// for users who have never touched the setting. Users only store an
// explicit value once they've interacted with this card.
//
// Persistence model:
//   - Initial hydration: read from auth.user.notificationPrefs if
//     present, otherwise GET /auth/prefs (once).
//   - Save model: explicit "Save" button rather than auto-save on
//     toggle. This avoids spamming PUT requests as users flick the
//     checkbox, and it gives us a clear place to surface errors.
//
// Why not auto-save every toggle:
//   Auto-save feels magical in isolation but couples the UI to
//   network latency — every mis-tap triggers a round trip, and the
//   error surface becomes a toast storm instead of a single inline
//   message. Explicit save keeps the UX predictable on flaky mobile
//   connections and mirrors the rest of the account page.

const ERROR_COPY = {
  invalid_body:
    'Those preferences were rejected as invalid. Refresh this page and try again.',
  unauthorized: 'Your session expired. Please sign in again.',
  network_error:
    "We couldn't reach the sysnode server. Check your connection and try again.",
};

function errorCopy(code) {
  return ERROR_COPY[code] || "Couldn't save preferences. Please try again.";
}

// Default reminder opt-in — matches
// sysnode-backend/lib/users.js:listWithRemindersEnabled.
// If the value is missing OR the enabled flag is not strictly
// `false`, the user is considered opted-in.
function remindersEnabledFromPrefs(prefs) {
  const v = prefs && prefs.voteReminders && prefs.voteReminders.enabled;
  return v !== false;
}

// `defaultOpen` — whether the card's form body is revealed on mount.
// Kept as `true` by default so component-level tests (which render
// the card in isolation and interact with its checkbox directly)
// keep working without having to expand the disclosure first.
// Account.js overrides to `false` so users land on a compact
// settings stack and opt in to the form explicitly.
export default function NotificationPreferencesCard({
  authService = defaultAuthService,
  defaultOpen = true,
}) {
  const { user, isAuthenticated, handleAuthLost } = useAuth();
  const [open, setOpen] = useState(defaultOpen);
  // `user.notificationPrefs` is whatever /auth/me returned. It may
  // be `{}` (no explicit preferences saved yet), a populated object,
  // or missing entirely (older backends / partial hydration). We
  // only fall back to GET /auth/prefs if the key is genuinely
  // absent, which is extremely rare in practice.
  const initialPrefs = user && user.notificationPrefs;
  const needsHydration =
    isAuthenticated && user && initialPrefs == null;
  // `hydrated` is true once we know the authoritative value from the
  // server — either because /auth/me included notificationPrefs OR
  // the fallback GET /auth/prefs completed. Until then we render a
  // "Loading…" placeholder instead of an interactive checkbox, so
  // there is no window in which a user's toggle can race the
  // async hydration and get stomped back to the server value.
  const [hydrated, setHydrated] = useState(
    Boolean(user) && initialPrefs != null
  );

  const [remindersEnabled, setRemindersEnabled] = useState(
    remindersEnabledFromPrefs(initialPrefs)
  );
  // Snapshot of the LAST-SAVED server value, used to detect "dirty"
  // state so the Save button can be disabled when nothing changed.
  const [savedRemindersEnabled, setSavedRemindersEnabled] = useState(
    remindersEnabledFromPrefs(initialPrefs)
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errCode, setErrCode] = useState(null);
  const [success, setSuccess] = useState(false);

  // Both hydration paths (the fast one from /auth/me, and the
  // fallback GET /auth/prefs) are keyed on user.id rather than a
  // boolean gate. Otherwise, if user A hydrates via GET /auth/prefs
  // (initialPrefs stays null) and the app then swaps to user B who
  // also has initialPrefs null, no dependency changes — the fallback
  // effect would not re-fire, and the card would submit user A's
  // in-memory toggle value for user B. Keying on identity collapses
  // that window and guarantees the form reflects THIS user's prefs.
  // Codex round-2 P2.
  const userId = user ? user.id : null;
  const lastHydratedUserIdRef = useRef(null);
  useEffect(() => {
    if (!user) return;
    if (lastHydratedUserIdRef.current === user.id) return;
    if (initialPrefs == null) return;
    const enabled = remindersEnabledFromPrefs(initialPrefs);
    setRemindersEnabled(enabled);
    setSavedRemindersEnabled(enabled);
    lastHydratedUserIdRef.current = user.id;
    setHydrated(true);
  }, [user, initialPrefs]);

  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  // Fallback GET /auth/prefs — ONLY when we're authenticated AND
  // /auth/me didn't include notificationPrefs. This guards against
  // firing the request during BOOTING (before auth resolves) or
  // while anonymous. Keyed on userId so an identity change (logout +
  // different sign-in without page reload) re-triggers hydration
  // instead of holding the previous user's in-memory state.
  useEffect(() => {
    if (!needsHydration) return;
    if (!userId) return;
    if (lastHydratedUserIdRef.current === userId) return;
    // Identity may have just changed under our feet. Hide the
    // interactive form until the fetch below lands so the user
    // cannot submit stale toggle state for the new account.
    setHydrated(false);
    setErrCode(null);
    setSuccess(false);
    let cancelled = false;
    setLoading(true);
    authService
      .getPrefs()
      .then((prefs) => {
        if (cancelled || !mountedRef.current) return;
        const enabled = remindersEnabledFromPrefs(prefs);
        setRemindersEnabled(enabled);
        setSavedRemindersEnabled(enabled);
        setHydrated(true);
        lastHydratedUserIdRef.current = userId;
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current) return;
        const code = (err && err.code) || 'http_error';
        // `unauthorized` during hydration means the server no longer
        // considers this client signed in (session expired, or was
        // revoked in another tab). /auth/* calls bypass the global
        // auth-loss interceptor, so we flip AuthContext to ANONYMOUS
        // explicitly — PrivateRoute then redirects to /login. We do
        // NOT reveal the form here; the whole page is about to
        // unmount.
        if (code === 'unauthorized') {
          handleAuthLost();
          return;
        }
        setErrCode(code);
        // Even on non-auth failure, reveal the form with whatever
        // default value we have so the user isn't stuck behind an
        // infinite "Loading…" spinner — they can still toggle + retry.
        setHydrated(true);
        // Mark hydration "done for this user" so the effect doesn't
        // retry in a loop. A real recovery path is the Save retry,
        // or a fresh /auth/me refresh.
        lastHydratedUserIdRef.current = userId;
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsHydration, userId, authService, handleAuthLost]);

  const dirty = remindersEnabled !== savedRemindersEnabled;

  const onToggle = useCallback((e) => {
    setErrCode(null);
    setSuccess(false);
    setRemindersEnabled(e.target.checked);
  }, []);

  const onSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (saving || !dirty) return;
      setErrCode(null);
      setSuccess(false);
      setSaving(true);
      try {
        await authService.updatePrefs({
          voteReminders: { enabled: remindersEnabled },
        });
        if (!mountedRef.current) return;
        setSavedRemindersEnabled(remindersEnabled);
        setSuccess(true);
      } catch (err) {
        if (!mountedRef.current) return;
        const code = (err && err.code) || 'http_error';
        // See the hydration catch above for the rationale — same
        // story on save: unauthorized means the server has moved on
        // without us, and local auth state must match.
        if (code === 'unauthorized') {
          handleAuthLost();
          return;
        }
        setErrCode(code);
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [authService, dirty, handleAuthLost, remindersEnabled, saving]
  );

  return (
    <form
      className="auth-card auth-card--info auth-card--collapsible"
      onSubmit={onSubmit}
      data-testid="notification-prefs-card"
      data-open={open ? 'true' : 'false'}
      noValidate
    >
      <div className="auth-card__header">
        <div className="auth-card__header-text">
          <h2 className="auth-card__title">Notifications</h2>
          <p className="auth-card__hint">
            Governance moves on-chain whether you're watching or not.
            Enable reminders and we'll email you a few days before
            each superblock — and once more in the final 24 hours if
            you haven't voted yet.
          </p>
        </div>
        <button
          type="button"
          className="auth-card__disclosure-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="notification-prefs-body"
          aria-label={
            open
              ? 'Collapse notification preferences'
              : 'Expand notification preferences'
          }
          data-testid="notification-prefs-toggle"
        >
          <span className="auth-card__chevron" aria-hidden="true">
            ▸
          </span>
        </button>
      </div>

      {open ? (
        <div id="notification-prefs-body" className="auth-card__body">
          {!hydrated || loading ? (
            <p
              className="auth-card__hint"
              data-testid="notification-prefs-loading"
            >
              Loading your preferences…
            </p>
          ) : (
            <>
              <label className="auth-toggle">
                <input
                  type="checkbox"
                  checked={remindersEnabled}
                  onChange={onToggle}
                  data-testid="notification-prefs-vote-reminders"
                />
                <span className="auth-toggle__body">
                  <span className="auth-toggle__label">
                    Governance vote reminders
                  </span>
                  <span className="auth-toggle__hint">
                    At most two emails per governance cycle. Skipped
                    entirely once you've voted that cycle.
                  </span>
                </span>
              </label>

              {errCode ? (
                <div
                  className="auth-alert auth-alert--error"
                  role="alert"
                  data-testid="notification-prefs-error"
                >
                  {errorCopy(errCode)}
                </div>
              ) : null}

              {success ? (
                <div
                  className="auth-alert auth-alert--success"
                  role="status"
                  data-testid="notification-prefs-success"
                >
                  Preferences saved.
                </div>
              ) : null}

              <button
                type="submit"
                className="button button--primary"
                disabled={saving || !dirty}
                data-testid="notification-prefs-submit"
              >
                {saving ? 'Saving…' : 'Save preferences'}
              </button>
            </>
          )}
        </div>
      ) : null}
    </form>
  );
}
