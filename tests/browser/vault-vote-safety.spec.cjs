const { test, expect } = require('@playwright/test');
const { createCipheriv, createHash, hkdfSync, pbkdf2Sync, randomBytes } = require('node:crypto');
const { base58check } = require('@scure/base');
const { addressFromWif } = require('../../src/lib/syscoin/wif');
const { signVoteFromWif } = require('../../src/lib/syscoin/voteSigner');

// Synthetic keys only. The real rendered vault must decrypt its normal SYSV2
// envelope and perform the vote signing; no React/context state is injected.
const EMAIL = 'vault-browser-fixture@example.test';
const PASSWORD = 'Synthetic vault browser password';
const SALT = 'ab'.repeat(32);
const PROPOSAL = 'e'.repeat(64);
const COLLATERAL = 'f'.repeat(64);
const NODE = 'a'.repeat(64);

function encryptedVault() {
  const scalar = Buffer.alloc(32); scalar[31] = 1;
  const sha256 = (data) => new Uint8Array(createHash('sha256').update(data).digest());
  const wif = base58check(sha256).encode(Buffer.concat([Buffer.from([128]), scalar, Buffer.from([1])]));
  const address = addressFromWif(wif);
  const master = pbkdf2Sync(PASSWORD, EMAIL, 600000, 32, 'sha512');
  const vaultKey = Buffer.from(hkdfSync('sha256', master, Buffer.from(SALT, 'hex'), 'sysnode-vault-v1', 32));
  const dataKey = randomBytes(32);
  const header = Buffer.concat([Buffer.from('SYSV2'), Buffer.from([2])]);
  const wrapIv = randomBytes(12); const payloadIv = randomBytes(12);
  const encrypt = (key, iv, plain) => {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header);
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  };
  const payload = Buffer.from(JSON.stringify({ version: 1, keys: [{ id: 'fixture-voting-key', label: 'Browser fixture node', wif, address, createdAt: 1700000000000 }] }));
  const blob = Buffer.concat([header, wrapIv, encrypt(vaultKey, wrapIv, dataKey), payloadIv, encrypt(dataKey, payloadIv, payload)]).toString('base64url');
  master.fill(0); vaultKey.fill(0); dataKey.fill(0); scalar.fill(0); payload.fill(0);
  return { blob, wif, address };
}

async function fixture(page, { holdSubmission = false, uncertainRow = false } = {}) {
  const vault = encryptedVault();
  const writes = []; const requests = []; let checks = 0; let releaseSubmission;
  const held = new Promise((resolve) => { releaseSubmission = resolve; });
  const receipt = () => ({ proposalHash: PROPOSAL, collateralHash: COLLATERAL, collateralIndex: 1, voteOutcome: writes[0].voteOutcome, voteSignal: 'funding', voteTime: writes[0].time, status: 'confirmed' });
  await page.route('**/auth/me', (route) => route.fulfill({ json: { user: { id: 1, email: EMAIL, emailVerified: true, saltV: SALT } } }));
  await page.route('**/vault', (route) => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json: { blob: vault.blob, etag: '"fixture-vault"', updatedAt: 1700000000000 } });
  });
  await page.route('**/mnstats', (route) => route.fulfill({ json: { stats: { mn_stats: { enabled: 10 }, superblock_stats: { budget: 100000 } } } }));
  await page.route('**/govlist', (route) => route.fulfill({ json: [{ Key: PROPOSAL, Hash: 'd'.repeat(64), ObectType: 1, fBlockchainValidity: true, fCachedValid: true, fCachedDelete: false, start_epoch: Math.floor(Date.now() / 1000) - 86400, end_epoch: Math.floor(Date.now() / 1000) + 86400 * 365, name: 'Browser vault safety proposal', title: 'Browser vault safety proposal', AbsoluteYesCount: 1, YesCount: 2, NoCount: 1, payment_amount: 10 }] }));
  await page.route('**/gov/**', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const body = request.postData() || ''; requests.push({ path: url.pathname, body });
    expect(body).not.toContain(vault.wif); expect(body).not.toContain(PASSWORD);
    if (url.pathname.endsWith('/mns/lookup')) {
      expect(request.postDataJSON().votingAddresses).toEqual([vault.address]);
      return route.fulfill({ json: { matches: [{ votingaddress: vault.address, proTxHash: NODE, collateralHash: COLLATERAL, collateralIndex: 1, status: 'ENABLED', address: '127.0.0.1:8369' }] } });
    }
    if (url.pathname.endsWith('/vote')) {
      const vote = request.postDataJSON(); writes.push(vote);
      expect(vote).toEqual({ proposalHash: PROPOSAL, voteOutcome: 'yes', voteSignal: 'funding', time: expect.any(Number), entries: [{ collateralHash: COLLATERAL, collateralIndex: 1, voteSig: expect.any(String) }] });
      expect(vote.entries[0].voteSig).toBe(signVoteFromWif({ wif: vault.wif, collateralHash: COLLATERAL, collateralIndex: 1, proposalHash: PROPOSAL, voteOutcome: 'yes', voteSignal: 'funding', time: vote.time }).voteSig);
      if (holdSubmission) {
        await held;
        return route.fulfill({ json: { accepted: 1, rejected: 0, results: [{ collateralHash: COLLATERAL, collateralIndex: 1, ok: true }] } }).catch(() => {});
      }
      if (uncertainRow) return route.fulfill({ json: { accepted: 0, rejected: 0, unknown: 1, notSubmitted: 0, results: [{ collateralHash: COLLATERAL, collateralIndex: 1, ok: false, error: 'submission_unknown', uncertain: true }] } });
      return route.abort('timedout');
    }
    if (url.pathname.endsWith('/reconcile')) {
      checks += 1;
      return route.fulfill({ json: { receipts: writes.length ? [receipt()] : [], reconciled: true } });
    }
    if (url.pathname.endsWith('/summary')) return route.fulfill({ json: { summary: [] } });
    if (url.pathname.endsWith('/recent')) return route.fulfill({ json: { receipts: [] } });
    return route.fulfill({ json: { receipts: [] } });
  });
  return { writes, requests, checks: () => checks, releaseSubmission };
}

async function unlockAndChooseBrowser(page) {
  await page.goto('/governance');
  const unlock = page.getByTestId('gov-ops-hero-locked');
  await expect(unlock).toBeVisible();
  await unlock.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await unlock.getByRole('button', { name: 'Unlock vault', exact: true }).click();
  await expect(unlock).toHaveCount(0);
  await page.getByRole('button', { name: 'Vote on proposal' }).click();
  await page.getByRole('button', { name: /Browser voting vault/ }).click();
  const submit = page.getByRole('button', { name: 'Sign & submit 1 vote', exact: true });
  await expect(submit).toBeEnabled();
  return submit;
}

for (const uncertainRow of [false, true]) test(`browser vault ${uncertainRow ? 'per-row uncertainty' : 'transport timeout'} checks status without signing or submitting again at320px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const state = await fixture(page, { uncertainRow });
  await (await unlockAndChooseBrowser(page)).click();
  const dialog = page.getByRole('dialog');
  if (uncertainRow) await expect(dialog).toContainText('1 uncertain.');
  else await expect(dialog).toContainText('Submission status unknown');
  await expect(dialog).toContainText(/no votes will be automatically/i);
  await expect(dialog.getByRole('button', { name: /Retry|Try again/i })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  const before = state.checks();
  const check = dialog.getByRole('button', { name: 'Check status', exact: true });
  await check.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('vault-vote-unknown-320.png'), animations: 'disabled' });
  await check.click();
  await expect(dialog.getByTestId('vote-modal-done')).toContainText('1 accepted, 0 rejected.');
  await expect(dialog.getByRole('button', { name: 'Check status', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1); expect(state.checks()).toBe(before + 1);
  expect(state.requests.filter((request) => request.path.endsWith('/vote'))).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('vault-vote-confirmed-320.png'), animations: 'disabled' });
});

test('browser background lock ignores a late submission response and cannot resume signing at320px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const state = await fixture(page, { holdSubmission: true });
  await (await unlockAndChooseBrowser(page)).click();
  await expect.poll(() => state.writes.length).toBe(1);
  // Exercise the production background-lock event handler, not a context setter.
  // This synthetic visibility event keeps the network response explicitly held.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
  });
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('vote-modal-guard-locked')).toBeVisible();
  const lateResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/gov/vote'));
  state.releaseSubmission();
  await (await lateResponse).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(dialog.getByTestId('vote-modal-guard-locked')).toBeVisible();
  await expect(dialog.getByTestId('vote-modal-done')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Sign & submit|Retry|Check status/ })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('vault-background-lock-320.png'), animations: 'disabled' });
});
