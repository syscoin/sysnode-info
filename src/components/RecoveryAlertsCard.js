import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '../context/AuthContext';
import { authService as defaultAuthService } from '../lib/authService';
import {
  discoverWallets,
  enrollRecoveryAlerts,
  readWalletSelection,
  recoveryAlertsService,
} from '../lib/recoveryAlerts';
import PasswordInput from './PasswordInput';
import './RecoveryAlertsCard.css';

const ERROR_COPY = {
  wallet_unavailable:
    'Open this page in a browser with Pali or another compatible smart-account wallet.',
  wallet_account_missing:
    'Select your smart account in the wallet, then connect again.',
  unsupported_chain:
    'This network is not monitored. Switch networks in your wallet, then connect again.',
  monitor_unavailable:
    'Monitoring is temporarily unavailable. Your existing alerts have not been removed.',
  recovery_not_installed:
    'This account needs guardian recovery installed before alerts can be enabled.',
  invalid_signature:
    'The smart account could not verify this signature. Select its current authorized signer and try again.',
  invalid_challenge:
    'The enrollment request could not be verified. Refresh and try again.',
  challenge_expired:
    'The enrollment request expired. Try again to get a fresh signature request.',
  wallet_changed:
    'The wallet account or network changed. Connect again before enabling alerts.',
  invalid_credentials: 'Your current Sysnode password is incorrect.',
  totp_required: 'Enter the current six-digit authenticator code.',
  invalid_totp_code:
    'That authenticator code did not work. Enter the current code and try again.',
  email_not_verified:
    'Verify your Sysnode email before enabling recovery alerts.',
  unauthorized: 'Your session expired. Please sign in again.',
  network_error:
    'We could not reach Sysnode. Check your connection and try again.',
  not_found: 'This alert subscription no longer exists. Refresh the list.',
  invalid_body: 'Check the supplied details and try again.',
};

function errorText(error) {
  if (error && error.enrollmentMayHaveCompleted)
    return 'Your wallet changed while enrollment was being saved. Refresh the list to check whether alerts were enabled for the original account.';
  if (error && (error.code === 4001 || error.code === 'user_rejected'))
    return 'The signature request was canceled. No alerts were enabled.';
  return (
    ERROR_COPY[error && error.code] ||
    'We could not complete that request. Please try again.'
  );
}

function datetime(value, milliseconds = false) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0)
    return 'Not yet checked';
  return new Date(Number(value) * (milliseconds ? 1 : 1000)).toLocaleString(
    undefined,
    { dateStyle: 'medium', timeStyle: 'short' }
  );
}

function monitoringCopy(status) {
  if (status === 'active')
    return {
      title: 'Monitoring active',
      tone: 'is-positive',
      description: 'The monitor is caught up with the chain.',
    };
  if (status === 'catching_up')
    return {
      title: 'Checking chain history',
      tone: 'is-warning',
      description:
        'Checking for recent and existing recoveries. Monitoring starts when this check is complete.',
    };
  return {
    title: 'Monitoring delayed',
    tone: 'is-warning',
    description:
      'Chain data is not current. Alerts may be delayed; check the account in your wallet.',
  };
}

function AccountAddress({ address }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch (_error) {
      setCopied(false);
    }
  }
  return (
    <div className="recovery-address">
      <code>{address}</code>
      <button
        type="button"
        className="recovery-copy"
        onClick={copy}
        aria-label={`Copy account address ${address}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function RecoveryAlertsCard({
  service = recoveryAlertsService,
  authService = defaultAuthService,
  defaultOpen = false,
  discover = discoverWallets,
}) {
  const { user, handleAuthLost } = useAuth();
  const userId = user && user.id;
  const [open, setOpen] = useState(
    defaultOpen ||
      (typeof window !== 'undefined' &&
        window.location.hash === '#recovery-alerts')
  );
  const [wallets, setWallets] = useState([]);
  const [walletId, setWalletId] = useState('');
  const [selection, setSelection] = useState(null);
  const [account, setAccount] = useState('');
  const [label, setLabel] = useState('');
  const [chains, setChains] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const generation = useRef(0);
  const fetchGeneration = useRef(0);
  const userRef = useRef(userId);
  userRef.current = userId;
  const mounted = useRef(true);
  const busy = useRef(false);
  const wallet = wallets.find((item) => item.id === walletId);
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  useEffect(
    () =>
      discover((choices) => {
        setWallets(choices);
        setWalletId(
          (current) => current || (choices[0] && choices[0].id) || ''
        );
      }),
    [discover]
  );

  const handleError = useCallback(
    (err) => {
      if (err && err.code === 'unauthorized') {
        handleAuthLost();
        return;
      }
      setError(errorText(err));
    },
    [handleAuthLost]
  );

  const load = useCallback(async () => {
    const id = userRef.current;
    if (id == null) return;
    const request = ++fetchGeneration.current;
    setLoading(true);
    try {
      const [supported, saved] = await Promise.all([
        service.chains(),
        service.subscriptions(),
      ]);
      if (
        !mounted.current ||
        userRef.current !== id ||
        fetchGeneration.current !== request
      )
        return;
      if (!Array.isArray(supported) || !Array.isArray(saved))
        throw new Error('invalid_response');
      setChains(supported);
      setSubscriptions(saved);
      setLoaded(true);
    } catch (err) {
      if (
        mounted.current &&
        userRef.current === id &&
        fetchGeneration.current === request
      ) {
        setSubscriptions((current) => current.map((subscription) => ({
          ...subscription,
          monitoring: { ...subscription.monitoring, status: 'degraded' },
        })));
        handleError(err);
      }
    } finally {
      if (
        mounted.current &&
        userRef.current === id &&
        fetchGeneration.current === request
      )
        setLoading(false);
    }
  }, [service, handleError]);

  useEffect(() => {
    generation.current += 1;
    fetchGeneration.current += 1;
    setSelection(null);
    setAccount('');
    setSubscriptions([]);
    setChains([]);
    setLoaded(false);
    setError(null);
    setNotice(null);
    setRemoving(null);
    setPassword('');
    setCode('');
    setNeedTotp(false);
    setLabel('');
    setLoading(false);
    if (open && userId != null) load();
  }, [userId, open, load]);

  useEffect(() => {
    if (!open || !loaded) return undefined;
    const refreshVisible = () => {
      if (document.visibilityState !== 'hidden' && !busy.current) load();
    };
    const timer = setInterval(refreshVisible, 30000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [open, loaded, load]);

  useEffect(() => {
    generation.current += 1;
    setSelection(null);
    setAccount('');
    const provider = wallet && wallet.provider;
    if (!provider) return undefined;
    const changed = () => {
      generation.current += 1;
      setSelection(null);
      setAccount('');
      setNotice(null);
      setError(ERROR_COPY.wallet_changed);
    };
    provider.on?.('accountsChanged', changed);
    provider.on?.('chainChanged', changed);
    provider.on?.('disconnect', changed);
    return () => {
      provider.removeListener?.('accountsChanged', changed);
      provider.removeListener?.('chainChanged', changed);
      provider.removeListener?.('disconnect', changed);
    };
  }, [wallet]);

  async function connect() {
    if (!wallet || busy.current) return;
    busy.current = true;
    setPhase('connecting');
    setError(null);
    setNotice(null);
    const provider = wallet.provider;
    const id = userId;
    generation.current += 1;
    try {
      const selected = await readWalletSelection(provider, true);
      if (
        !mounted.current ||
        walletRef.current?.provider !== provider ||
        userRef.current !== id
      )
        return;
      if (!chains.some((chain) => chain.chainId === selected.chainId))
        throw Object.assign(new Error(), { code: 'unsupported_chain' });
      setSelection(selected);
      setAccount(selected.accounts[0]);
      setError(null);
    } catch (err) {
      if (
        mounted.current &&
        walletRef.current?.provider === provider &&
        userRef.current === id
      )
        handleError(err);
    } finally {
      busy.current = false;
      if (mounted.current) setPhase('');
    }
  }

  async function enroll(event) {
    event.preventDefault();
    if (busy.current || !selection || !account || !wallet) return;
    busy.current = true;
    fetchGeneration.current += 1;
    setLoading(false);
    setPhase('preparing');
    setError(null);
    setNotice(null);
    const attempt = generation.current;
    const id = userId;
    try {
      await enrollRecoveryAlerts({
        provider: wallet.provider,
        service,
        chainId: selection.chainId,
        account,
        label: label.trim(),
        isCurrent: () =>
          mounted.current &&
          userRef.current === id &&
          generation.current === attempt,
        onProgress: (next) => {
          if (mounted.current && generation.current === attempt) setPhase(next);
        },
      });
      if (!mounted.current || userRef.current !== id) return;
      setNotice(
        'Account linked for recovery alerts. Monitoring starts after the initial chain checks.'
      );
      setLabel('');
      await load();
    } catch (err) {
      if (mounted.current && userRef.current === id) handleError(err);
    } finally {
      busy.current = false;
      if (mounted.current) setPhase('');
    }
  }

  async function remove(event) {
    event.preventDefault();
    if (busy.current || !removing || !password || !user) return;
    busy.current = true;
    fetchGeneration.current += 1;
    setLoading(false);
    setPhase('removing');
    setError(null);
    setNotice(null);
    const id = userId;
    try {
      const oldAuthHash = await authService.deriveStepUpAuthHash(
        password,
        user.email
      );
      if (!mounted.current || userRef.current !== id) return;
      await service.remove(removing.id, {
        oldAuthHash,
        ...(code ? { code } : {}),
      });
      if (!mounted.current || userRef.current !== id) return;
      // The acknowledged mutation is authoritative even if a following status
      // refresh fails. Never leave a disabled watch labelled as active.
      setSubscriptions((current) =>
        current.filter((subscription) => subscription.id !== removing.id)
      );
      setRemoving(null);
      setPassword('');
      setCode('');
      setNotice(
        'Alerts for this account were disabled. This does not cancel any on-chain recovery.'
      );
      await load();
    } catch (err) {
      if (mounted.current && userRef.current === id) {
        if (err && err.code === 'totp_required') setNeedTotp(true);
        handleError(err);
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPhase('');
    }
  }

  const chain =
    selection && chains.find((item) => item.chainId === selection.chainId);
  const isLinked =
    selection &&
    subscriptions.some(
      (item) =>
        item.chainId === selection.chainId &&
        chain &&
        item.recoveryModule?.toLowerCase() === chain.recoveryModule?.toLowerCase() &&
        item.account.toLowerCase() === account.toLowerCase()
    );
  const phaseLabel = {
    connecting: 'Connecting…',
    preparing: 'Preparing request…',
    signing: 'Confirm in wallet…',
    saving: 'Saving alerts…',
    removing: 'Disabling alerts…',
  }[phase];

  return (
    <section
      id="recovery-alerts"
      className="auth-card auth-card--info recovery-alerts"
      aria-labelledby="recovery-alerts-title"
    >
      <div className="auth-card__header">
        <div className="auth-card__header-text">
          <h2 id="recovery-alerts-title" className="auth-card__title">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
            </svg>
            Recovery alerts
          </h2>
          <p className="auth-card__hint">
            Email warnings when guardian recovery starts on your smart account.
          </p>
        </div>
        <button
          type="button"
          className="auth-card__disclosure-toggle"
          aria-expanded={open}
          aria-controls="recovery-alerts-body"
          aria-label={
            open ? 'Collapse recovery alerts' : 'Expand recovery alerts'
          }
          onClick={() => setOpen((value) => !value)}
        >
          <span className="auth-card__chevron" aria-hidden="true">
            ▸
          </span>
        </button>
      </div>
      {open && (
        <div id="recovery-alerts-body" className="auth-card__body">
          <p className="auth-card__hint">
            Recovery-start, reminder and outcome emails go to{' '}
            <strong className="recovery-email">{user && user.email}</strong>.
            Keys and recovery control stay in your wallet.
          </p>
          <p className="recovery-note">
            Alerts may be delayed and cannot cancel recovery. Keep access to
            your wallet.
          </p>
          {error && (
            <div className="auth-alert auth-alert--error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="auth-alert auth-alert--success" role="status">
              {notice}
            </div>
          )}
          {loading && !loaded && <p role="status">Loading recovery alerts…</p>}
          <div className="recovery-subscriptions">
            {subscriptions.map((subscription) => {
              const network = chains.find(
                (item) => item.chainId === subscription.chainId
              );
              const monitor = monitoringCopy(
                subscription.monitoring?.status === 'active' &&
                (!subscription.monitoring.lastCheckedAt ||
                  Date.now() - subscription.monitoring.lastCheckedAt > 60000)
                  ? 'degraded'
                  : subscription.monitoring?.status
              );
              return (
                <article
                  className="recovery-subscription"
                  key={subscription.id}
                >
                  <div className="recovery-subscription__heading">
                    <h3>{subscription.label || 'Smart account'}</h3>
                    <span className={`status-chip ${monitor.tone}`}>
                      {monitor.title}
                    </span>
                  </div>
                  <AccountAddress address={subscription.account} />
                  <p className="recovery-note">
                    {network ? network.name : `Chain ${subscription.chainId}`}
                    {network && network.testnet ? ' · Testnet' : ''}
                  </p>
                  <p className="auth-card__hint">{monitor.description}</p>
                  <p className="recovery-note">
                    Last chain check:{' '}
                    {datetime(
                      subscription.monitoring &&
                        subscription.monitoring.lastCheckedAt,
                      true
                    )}
                  </p>
                  {(subscription.pending || []).map((operation) => (
                    <div
                      key={operation.operationId}
                      className="recovery-operation"
                    >
                      <strong>
                        {{
                          scheduled: 'Recovery pending',
                          pending: 'Recovery pending',
                          ready: 'Recovery can be executed',
                          expired: 'Recovery expired',
                          executed: 'Recovery executed',
                          canceled: 'Recovery canceled or invalidated',
                          invalidated: 'Recovery no longer pending',
                          orphaned: 'Recovery observation no longer canonical',
                          unknown: 'Recovery status unavailable',
                        }[operation.status] || 'Recovery observed'}
                      </strong>
                      <span>
                        {['pending', 'ready', 'scheduled'].includes(
                          operation.status
                        )
                          ? 'Can execute from'
                          : 'Original execution time'}{' '}
                        {datetime(operation.executableAt)}
                      </span>
                      {Number(operation.expiresAt) > 0 && (
                        <span>
                          {['pending', 'ready', 'scheduled'].includes(
                            operation.status
                          )
                            ? 'Expires'
                            : 'Original expiry'}{' '}
                          {datetime(operation.expiresAt)}
                        </span>
                      )}
                      <span className="recovery-note">
                        Review this operation in your wallet. Passing the
                        deadline does not mean it has executed.
                      </span>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="auth-linklike recovery-disable"
                    disabled={!!phase}
                    onClick={() => {
                      setRemoving(subscription);
                      setPassword('');
                      setCode('');
                      setNeedTotp(!!(user && user.totpEnabled));
                      setError(null);
                      setNotice(null);
                    }}
                  >
                    Disable these alerts…
                  </button>
                </article>
              );
            })}
            {loaded && subscriptions.length === 0 && (
              <p className="recovery-empty">
                No smart accounts linked yet. Connect one below to begin.
              </p>
            )}
          </div>
          {removing ? (
            <form className="recovery-remove" onSubmit={remove}>
              <h3>
                Disable alerts for {removing.label || 'this smart account'}?
              </h3>
              <AccountAddress address={removing.account} />
              <p className="recovery-note">
                {chains.find((item) => item.chainId === removing.chainId)
                  ?.name || `Chain ${removing.chainId}`}
              </p>
              <p className="auth-card__hint">
                This stops its emails only. Any pending recovery remains
                on-chain. Confirm with your Sysnode password.
              </p>
              <div className="auth-field">
                <label className="auth-label" htmlFor="recovery-password">
                  Current Sysnode password
                </label>
                <PasswordInput
                  id="recovery-password"
                  className="auth-input"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={!!phase}
                  required
                />
              </div>
              {needTotp && (
                <div className="auth-field">
                  <label className="auth-label" htmlFor="recovery-totp">
                    Authenticator code
                  </label>
                  <input
                    id="recovery-totp"
                    className="auth-input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    onChange={(event) =>
                      setCode(event.target.value.replace(/\D/g, ''))
                    }
                    required
                    disabled={!!phase}
                  />
                </div>
              )}
              <div className="recovery-actions">
                <button
                  className="button button--danger"
                  type="submit"
                  disabled={
                    !!phase || !password || (needTotp && code.length !== 6)
                  }
                >
                  {phase === 'removing' ? phaseLabel : 'Disable alerts'}
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={!!phase}
                  onClick={() => {
                    setRemoving(null);
                    setPassword('');
                    setCode('');
                  }}
                >
                  Keep alerts
                </button>
              </div>
            </form>
          ) : (
            <details
              className="recovery-link-details"
              open={subscriptions.length === 0}
            >
              <summary>
                {subscriptions.length === 0
                  ? 'Link a smart account'
                  : 'Link another smart account'}
              </summary>
              <form className="recovery-enroll" onSubmit={enroll}>
                <p className="auth-card__hint">
                  An off-chain signature links this account address to your
                  Sysnode email. No private keys or funds are sent.
                </p>
                {wallets.length > 0 ? (
                  <>
                    <div className="auth-field">
                      <label className="auth-label" htmlFor="recovery-wallet">
                        Wallet
                      </label>
                      <select
                        id="recovery-wallet"
                        className="auth-input"
                        value={walletId}
                        onChange={(event) => {
                          generation.current += 1;
                          setWalletId(event.target.value);
                          setError(null);
                        }}
                        disabled={!!phase}
                      >
                        {wallets.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      className="button button--ghost"
                      disabled={
                        !!phase ||
                        !loaded ||
                        !chains.length ||
                        !(user && user.emailVerified)
                      }
                      onClick={connect}
                    >
                      {phase === 'connecting'
                        ? phaseLabel
                        : selection
                        ? 'Reconnect wallet'
                        : 'Connect wallet'}
                    </button>
                  </>
                ) : (
                  <p className="auth-alert auth-alert--warning">
                    Open this page in a browser with Pali or another compatible
                    smart-account wallet. Select your smart account in the
                    wallet before connecting.
                  </p>
                )}
                {loaded && !chains.length && (
                  <p className="auth-alert auth-alert--warning">
                    No recovery networks are enabled on this service yet.
                  </p>
                )}
                {chains.length > 0 && (
                  <p className="recovery-note">
                    Available networks:{' '}
                    {chains
                      .map(
                        (item) =>
                          `${item.name}${item.testnet ? ' (testnet)' : ''}`
                      )
                      .join(', ')}
                    .
                  </p>
                )}
                {selection && (
                  <>
                    <p className="recovery-network">
                      {chain && chain.name}
                      {chain && chain.testnet ? ' · Testnet' : ''}
                    </p>
                    <div className="auth-field">
                      <label className="auth-label" htmlFor="recovery-account">
                        Smart account
                      </label>
                      <select
                        id="recovery-account"
                        className="auth-input recovery-account-select"
                        value={account}
                        disabled={!!phase}
                        onChange={(event) => {
                          generation.current += 1;
                          setAccount(event.target.value);
                          setNotice(null);
                        }}
                      >
                        {selection.accounts.map((address) => (
                          <option key={address} value={address}>
                            {address}
                          </option>
                        ))}
                      </select>
                    </div>
                    <AccountAddress address={account} />
                    <div className="auth-field">
                      <label className="auth-label" htmlFor="recovery-label">
                        Account label (optional)
                      </label>
                      <input
                        id="recovery-label"
                        className="auth-input"
                        placeholder="e.g. Savings"
                        maxLength={64}
                        value={label}
                        disabled={!!phase}
                        onChange={(event) => setLabel(event.target.value)}
                      />
                    </div>
                    <button
                      className="button button--primary"
                      type="submit"
                      disabled={
                        !!phase || !(user && user.emailVerified) || isLinked
                      }
                    >
                      {phase
                        ? phaseLabel
                        : isLinked
                        ? 'Account already linked'
                        : 'Enable recovery alerts'}
                    </button>
                  </>
                )}
              </form>
            </details>
          )}
          <button
            type="button"
            className="auth-linklike recovery-refresh"
            disabled={loading || !!phase}
            onClick={() => {
              setError(null);
              load();
            }}
          >
            {loading ? 'Refreshing…' : 'Refresh status'}
          </button>
        </div>
      )}
    </section>
  );
}
