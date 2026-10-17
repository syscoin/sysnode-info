const { test, expect } = require('@playwright/test');
// Synthetic provider + HTTP fixtures exercise the production UI and wire
// contracts. Crypto/serialization are tested separately against the real SDK.
const HASH = 'a'.repeat(64);
const ADDRESS = `0x${'12'.repeat(20)}`;
async function fixtures(page, { unknown = false, recovery = false } = {}) {
  let submitted = 0;
  let operations = [];
  const preparations = [];
  await page.addInitScript(() => {
    window.__walletCalls = [];
    window.pali = {
      on() {}, removeListener() {},
      async request({ method, params }) {
        window.__walletCalls.push(method);
        if (method === 'sys_requestAccounts') return ['tsys-test-fixture'];
        if (method === 'sys_getPublicKey') return 'vpub-test-fixture';
        if (method === 'sys_getChangeAddress') return 'tsys-change-fixture';
        if (method === 'sys_getSentryCapabilities') return { operations: ['updateService', 'revoke'] };
        if (method === 'sys_signSentryOperation') return { transactionHex: 'operator-authorized' };
        if (method === 'sys_sign') return { psbt: 'fee-signed' };
        if (method === 'sys_linkSentryNode') return { version: 1, linked: true, proTxHash: params[0].proTxHash, genesisHash: params[0].genesisHash };
        throw new Error(`Unexpected method ${method}`);
      },
    };
  });
  await page.route('**/auth/me', (route) => route.fulfill({ json: { user: { id: 1, email: 'fixture@example.test', emailVerified: true, saltV: 'a'.repeat(32) } } }));
  await page.route('**/vault', (route) => route.fulfill({ status: 404, json: { error: 'not_found' } }));
  await page.route('**/api/sentry/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { version: 1, network: 'testnet', chain: { genesisHash: '12'.repeat(32), era: 'legacy-v3' }, operations: ['updateService', 'revoke'] } });
    if (path.endsWith('/nodes')) return route.fulfill({ json: [{ network: 'testnet', proTxHash: HASH, label: 'My Sentry node' }] });
    if (path.endsWith('/context')) return route.fulfill({ json: { chain: { genesisHash: '12'.repeat(32), era: 'legacy-v3' }, node: { proTxHash: HASH, operatorPublicKey: 'b'.repeat(96), service: recovery ? '[::]:0' : '1.2.3.4:18369', nevmAddress: '', poseBanHeight: recovery ? 10 : -1 } } });
    if (path.endsWith('/operations') && method === 'GET') return route.fulfill({ json: operations });
    if (path.endsWith('/operations') && method === 'POST') {
      const body = route.request().postDataJSON();
      preparations.push(body);
      if (body.operation === 'revoke') return route.fulfill({ json: { id: 'revoke1', prepared: { request: { version: 1, operation: 'revoke', transactionHex: 'unsigned' }, review: { fields: { reason: body.changes.reason }, feeSatoshis: '1000' } } } });
      expect(route.request().postDataJSON().changes).toEqual(recovery ? { service: '1.2.3.4:18369' } : { nevmAddress: ADDRESS });
      return route.fulfill({ json: { id: 'op1', prepared: { request: { version: 1, operation: 'updateService', transactionHex: 'unsigned' }, review: { changes: recovery ? { service: { previous: '[::]:0', next: '1.2.3.4:18369' } } : { nevmAddress: { previous: '', next: ADDRESS } }, feeSatoshis: '1000' } } } });
    }
    if (path.endsWith('/op1/authorize')) return route.fulfill({ json: { psbt: { psbt: 'authorized' } } });
    if (path.endsWith('/op1/submit')) {
      submitted += 1;
      operations = [{ id: 'op1', network: 'testnet', status: unknown ? 'submission_unknown' : 'submitted', txid: 'f'.repeat(64) }];
      return route.fulfill({ json: operations[0] });
    }
    if (path.endsWith('/op1/retry')) {
      expect(route.request().postDataJSON()).toEqual({});
      submitted += 1;
      operations = [{ ...operations[0], status: 'submitted' }];
      return route.fulfill({ json: operations[0] });
    }
    if (path.endsWith('/op1')) return route.fulfill({ json: { ...operations[0], status: 'confirmed' } });
    throw new Error(`Unexpected API request ${path}`);
  });
  return { submissions: () => submitted, preparations: () => preparations };
}
for (const width of [320, 400, 960]) test(`NEVM update and unknown-result recovery at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 568 });
  const fixture = await fixtures(page, { unknown: true });
  await page.goto('/nodes');
  await page.getByRole('button', { name: /My Sentry node/ }).click();
  await page.getByRole('button', { name: 'Link node to Pali' }).click();
  await expect(page.getByText('Node linked in Pali. This did not sign or broadcast a transaction.')).toBeVisible();
  expect(fixture.submissions()).toBe(0);
  await page.getByRole('combobox', { name: 'NEVM address', exact: true }).selectOption('set');
  await page.getByLabel('New NEVM address').fill(ADDRESS);
  await page.getByRole('button', { name: 'Prepare update' }).click();
  const review = page.getByRole('button', { name: 'Review and sign in Pali' });
  await expect(review).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`review-${width}.png`), fullPage: true });
  await review.click();
  await expect(page.getByRole('alert')).toContainText('Submission status is unknown');
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByText('confirmed', { exact: true })).toBeVisible();
  expect(fixture.submissions()).toBe(1);
  expect(await page.evaluate(() => window.__walletCalls.filter((name) => name === 'sys_signSentryOperation').length)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath(`confirmed-${width}.png`), fullPage: true });
});

test('service recovery is explicit and keeps NEVM unchanged at 320px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const fixture = await fixtures(page, { recovery: true });
  await page.goto('/nodes');
  await page.getByRole('button', { name: /My Sentry node/ }).click();
  await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
  await expect(page.getByText(/This node requires service recovery/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Service endpoint', exact: true }).selectOption('set');
  await page.getByLabel('Public IP and port', { exact: true }).fill('1.2.3.4:18369');
  await page.getByRole('button', { name: 'Prepare update' }).click();
  await expect(page.getByRole('button', { name: 'Review and sign in Pali' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('service-recovery-320.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review and sign in Pali' }).click();
  await expect(page.getByText('submitted', { exact: true })).toBeVisible();
  expect(fixture.submissions()).toBe(1);
});

test('manual identical-byte retry does not request another wallet signature', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const fixture = await fixtures(page, { unknown: true });
  await page.goto('/nodes');
  await page.getByRole('button', { name: /My Sentry node/ }).click();
  await page.getByRole('combobox', { name: 'NEVM address', exact: true }).selectOption('set');
  await page.getByLabel('New NEVM address').fill(ADDRESS);
  await page.getByRole('button', { name: 'Prepare update' }).click();
  await page.getByRole('button', { name: 'Review and sign in Pali' }).click();
  await expect(page.getByRole('alert')).toContainText('Submission status is unknown');
  await page.getByRole('button', { name: 'Retry identical transaction' }).click();
  await expect(page.getByText('submitted', { exact: true })).toBeVisible();
  expect(fixture.submissions()).toBe(2);
  expect(await page.evaluate(() => window.__walletCalls.filter((name) => name === 'sys_signSentryOperation').length)).toBe(1);
  expect(await page.evaluate(() => window.__walletCalls.filter((name) => name === 'sys_sign').length)).toBe(1);
});

test('changing a revocation reason removes the previous approval at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const fixture = await fixtures(page);
  await page.goto('/nodes');
  await page.getByRole('button', { name: /My Sentry node/ }).click();
  await page.getByText('Registration and authority management', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('revoke');
  await page.getByRole('combobox', { name: 'Revocation reason' }).selectOption('1');
  await page.getByRole('button', { name: 'Prepare operation' }).click();
  await expect(page.getByRole('button', { name: 'Review and sign in Pali' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Revocation reason' }).selectOption('2');
  await expect(page.getByRole('button', { name: 'Review and sign in Pali' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Prepare operation' }).click();
  await expect(page.getByRole('button', { name: 'Review and sign in Pali' })).toBeVisible();
  expect(fixture.preparations().map((request) => request.changes.reason)).toEqual([1, 2]);
  expect(fixture.submissions()).toBe(0);
  expect(await page.evaluate(() => window.__walletCalls.includes('sys_signSentryOperation'))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('partial loading and retry retain usable resources without exposing a guessed protocol at 320px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await fixtures(page);
  let resolveCapabilities;
  const capabilitiesReady = new Promise((resolve) => { resolveCapabilities = resolve; });
  await page.route('**/api/sentry/v1/capabilities', async (route) => {
    await capabilitiesReady;
    await route.fulfill({ json: { version: 1, network: 'testnet', chain: { genesisHash: '12'.repeat(32), era: 'pq-v4' }, operations: ['register'] } });
  });
  let historyFailed = true;
  await page.route('**/api/sentry/v1/operations', (route) => historyFailed
    ? route.fulfill({ status: 503, json: { error: 'history_temporarily_unavailable' } })
    : route.fulfill({ json: [] }));
  await page.goto('/nodes');
  await page.addStyleTag({ content: 'html, body { scroll-behavior: auto !important; }' });
  await expect(page.getByRole('button', { name: /My Sentry node/ })).toBeVisible();
  await page.getByText('Registration and authority management', { exact: true }).click();
  await expect(page.getByLabel('Operator BLS public key')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add node' })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('Could not load operation history');
  await expect(page.getByRole('alert')).toContainText('The service is temporarily unavailable. Try again.');
  await page.screenshot({ path: testInfo.outputPath('partial-loading-error-320.png'), fullPage: true });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('partial-loading-top-viewport-320.png') });
  await page.getByRole('button', { name: 'Retry loading' }).evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.screenshot({ path: testInfo.outputPath('partial-loading-error-viewport-320.png') });
  resolveCapabilities();
  await expect(page.getByLabel('Owner PQ public key')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add node' })).toBeEnabled();
  historyFailed = false;
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('testnet · Post-quantum')).toBeVisible();
  await expect(page.getByLabel('Operator BLS public key')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('retry-ready-pq-320.png'), fullPage: true });
  await page.getByRole('button', { name: 'Prepare operation' }).evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.screenshot({ path: testInfo.outputPath('retry-ready-pq-action-viewport-320.png') });
  expect(await page.evaluate(() => window.__walletCalls.includes('sys_signSentryOperation'))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
