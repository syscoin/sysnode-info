const { test, expect } = require('@playwright/test');
const FIRST = 'a'.repeat(64);
const SECOND = 'b'.repeat(64);

test('bounded batch import keeps per-line results and failed-only retry usable at320px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  let watched = [];
  let failSecond = true;
  const lookups = [];
  const writes = [];
  await page.route('**/auth/me', (route) => route.fulfill({ json: { user: { id: 1, email: 'fixture@example.test', emailVerified: true, saltV: 'a'.repeat(32) } } }));
  await page.route('**/vault', (route) => route.fulfill({ json: { empty: true } }));
  await page.route('**/api/sentry/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/capabilities')) return route.fulfill({ json: { version: 1, network: 'testnet', chain: { genesisHash: 'c'.repeat(64), era: 'legacy-v3' }, operations: ['updateService'] } });
    if (url.pathname.endsWith('/operations')) return route.fulfill({ json: [] });
    if (url.pathname.endsWith('/nodes')) {
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        expect(body.preserveExisting).toBe(true);
        writes.push(body);
        watched = [...watched, body];
      }
      return route.fulfill({ json: watched });
    }
    if (url.pathname.endsWith('/context')) {
      const proTxHash = url.searchParams.get('proTxHash');
      lookups.push(proTxHash);
      if (proTxHash === SECOND && failSecond) return route.fulfill({ status: 503, json: { error: 'rpc_failed' } });
      return route.fulfill({ json: { chain: { genesisHash: 'c'.repeat(64), era: 'legacy-v3' }, node: { proTxHash, service: '1.2.3.4:18369', nevmAddress: '' } } });
    }
    throw new Error(`Unexpected route ${url.pathname}`);
  });
  await page.goto('/nodes');
  const open = page.getByRole('button', { name: 'Import nodes', exact: true });
  await expect(open).toBeEnabled();
  await open.click();
  const panel = page.getByRole('region', { name: 'Import nodes' });
  await page.getByLabel('Public ProTx IDs, one per line').fill(`${FIRST}, ${'12'.repeat(32)}`);
  await expect(page.getByText('Use a short human-readable label, never a private key or WIF.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check node IDs' })).toBeDisabled();
  expect(lookups).toHaveLength(0); expect(writes).toHaveLength(0);
  await page.getByLabel('Public ProTx IDs, one per line').fill(`${FIRST}, ${'LongNodeLabel'.repeat(5)}\nnot-an-id\n${FIRST}, duplicate\n${SECOND}, Retry node`);
  await page.getByRole('button', { name: 'Check node IDs' }).click();
  await expect(page.getByRole('button', { name: 'Watch selected nodes (1)' })).toBeEnabled();
  await expect(page.getByText('Needs retry', { exact: true })).toBeVisible();
  expect(lookups).toEqual([FIRST, SECOND]);
  expect(writes).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await panel.evaluate((node) => window.scrollTo({ top: node.getBoundingClientRect().top + window.scrollY - 90, behavior: 'instant' }));
  await page.screenshot({ path: testInfo.outputPath('batch-import-top-320.png'), animations: 'disabled' });
  const importButton = page.getByRole('button', { name: 'Watch selected nodes (1)' });
  await importButton.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('batch-import-results-320.png'), animations: 'disabled' });
  await importButton.click();
  await expect(page.getByText('Imported', { exact: true })).toBeVisible();
  failSecond = false;
  await page.getByRole('button', { name: 'Retry failed lookups' }).click();
  await expect(page.getByRole('button', { name: 'Watch selected nodes (1)' })).toBeEnabled();
  await page.getByRole('button', { name: 'Watch selected nodes (1)' }).click();
  await expect(page.getByText('Imported', { exact: true })).toHaveCount(2);
  expect(lookups).toEqual([FIRST, SECOND, SECOND]);
  expect(writes.map((node) => node.proTxHash)).toEqual([FIRST, SECOND]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Voting keys', exact: true }).click();
  await page.getByRole('button', { name: 'Import voting keys', exact: true }).click();
  const voting = page.getByTestId('vault-import-modal');
  await expect(voting).toBeVisible();
  await expect(voting.getByRole('heading', { name: 'Import voting keys' })).toBeInViewport({ timeout: 1500 });
  await expect(voting.getByText(/Paste one voting WIF or private descriptor per line/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('existing-voting-import-320.png'), animations: 'disabled' });
});
