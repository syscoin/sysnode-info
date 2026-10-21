import { apiClient } from './apiClient';

export function createRecoveryAlertsService(client = apiClient) {
  return {
    async chains() {
      return (await client.get('/api/recovery/chains')).data.chains;
    },
    async subscriptions() {
      return (await client.get('/api/recovery/subscriptions')).data.subscriptions;
    },
    async challenge(chainId, account) {
      return (await client.post('/api/recovery/challenges', { chainId, account }))
        .data;
    },
    async subscribe(challengeId, signature, label) {
      const body = { challengeId, signature };
      if (label) body.label = label;
      return (await client.post('/api/recovery/subscriptions', body)).data
        .subscription;
    },
    async remove(id, credentials) {
      return (
        await client.delete(
          `/api/recovery/subscriptions/${encodeURIComponent(id)}`,
          {
            data: credentials,
          }
        )
      ).data;
    },
  };
}

export const recoveryAlertsService = createRecoveryAlertsService();

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function walletError(code) {
  return Object.assign(new Error(code), { code });
}

export function parseEvmChainId(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export async function readWalletSelection(provider, connect = false) {
  if (!provider || typeof provider.request !== 'function')
    throw walletError('wallet_unavailable');
  const accounts = await provider.request({
    method: connect ? 'eth_requestAccounts' : 'eth_accounts',
  });
  const chainId = parseEvmChainId(
    await provider.request({ method: 'eth_chainId' })
  );
  if (
    !Array.isArray(accounts) ||
    !accounts.length ||
    accounts.some(
      (account) => typeof account !== 'string' || !ADDRESS.test(account)
    )
  ) {
    throw walletError('wallet_account_missing');
  }
  if (!chainId) throw walletError('unsupported_chain');
  return {
    accounts: [...new Set(accounts.map((account) => account.toLowerCase()))],
    chainId,
  };
}

// Only sign the server-issued message, using the standard wallet interface.
// The backend verifies the signature against the contract, not its EOA owner.
export async function enrollRecoveryAlerts({
  provider,
  service = recoveryAlertsService,
  chainId,
  account,
  label,
  onProgress = () => {},
  isCurrent = () => true,
}) {
  let changed = false;
  let submitting = false;
  const invalidate = () => {
    changed = true;
  };
  provider.on?.('accountsChanged', invalidate);
  provider.on?.('chainChanged', invalidate);
  provider.on?.('disconnect', invalidate);
  const assertCurrent = async () => {
    if (changed || !isCurrent()) throw walletError('wallet_changed');
    const selected = await readWalletSelection(provider);
    if (
      changed ||
      !isCurrent() ||
      selected.chainId !== chainId ||
      !selected.accounts.includes(account.toLowerCase())
    ) {
      throw walletError('wallet_changed');
    }
  };
  try {
    await assertCurrent();
    onProgress('preparing');
    const challenge = await service.challenge(chainId, account);
    if (
      !challenge ||
      typeof challenge.id !== 'string' ||
      typeof challenge.message !== 'string' ||
      !challenge.message ||
      challenge.chainId !== chainId ||
      String(challenge.account).toLowerCase() !== account.toLowerCase()
    ) {
      throw walletError('invalid_challenge');
    }
    await assertCurrent();
    const encoded = `0x${Array.from(
      new TextEncoder().encode(challenge.message),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('')}`;
    onProgress('signing');
    const signature = await provider.request({
      method: 'personal_sign',
      params: [encoded, account],
    });
    // Contract signatures can be much longer than a 65-byte ECDSA signature.
    if (
      typeof signature !== 'string' ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)
    )
      throw walletError('invalid_signature');
    await assertCurrent();
    onProgress('saving');
    submitting = true;
    const subscription = await service.subscribe(
      challenge.id,
      signature,
      label
    );
    if (changed || !isCurrent()) {
      const error = walletError('wallet_changed');
      error.enrollmentMayHaveCompleted = true;
      throw error;
    }
    return subscription;
  } catch (error) {
    if ((changed || !isCurrent()) && error.code !== 'wallet_changed') {
      const out = walletError('wallet_changed');
      out.enrollmentMayHaveCompleted = submitting;
      throw out;
    }
    throw error;
  } finally {
    provider.removeListener?.('accountsChanged', invalidate);
    provider.removeListener?.('chainChanged', invalidate);
    provider.removeListener?.('disconnect', invalidate);
  }
}

// EIP-6963 metadata is display-only. Authorization never trusts a wallet name,
// icon or brand flag; the selected provider still needs an on-chain proof.
export function discoverWallets(
  onChange,
  target = typeof window === 'undefined' ? null : window
) {
  if (!target) return () => {};
  const choices = [];
  const add = (provider, name) => {
    if (
      !provider ||
      typeof provider.request !== 'function' ||
      choices.some((entry) => entry.provider === provider)
    )
      return;
    choices.push({
      provider,
      name: String(name || 'Browser wallet').slice(0, 64),
      id: `wallet-${choices.length}`,
    });
    onChange([...choices]);
  };
  const announced = (event) => {
    const detail = event && event.detail;
    if (detail && detail.info) add(detail.provider, detail.info.name);
  };
  target.addEventListener('eip6963:announceProvider', announced);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  const injected = target.ethereum;
  if (injected && Array.isArray(injected.providers)) {
    injected.providers.forEach((provider, i) =>
      add(
        provider,
        provider.isPali
          ? 'Pali'
          : provider.isMetaMask
          ? 'MetaMask'
          : `Browser wallet ${i + 1}`
      )
    );
  } else if (injected) {
    add(
      injected,
      injected.isPali
        ? 'Pali'
        : injected.isMetaMask
        ? 'MetaMask'
        : 'Browser wallet'
    );
  }
  return () =>
    target.removeEventListener('eip6963:announceProvider', announced);
}
