const { test, expect } = require('@playwright/test');
const vectors = require('../../src/testUtils/governanceCoreVectors.json');
const vector = vectors[0];
const hash = 'a'.repeat(64);
const genesisHash = 'c'.repeat(64);

async function setup(page, { unknown = false, missingKey = false } = {}) {
  let writes = 0; let reconciles = 0;
  await page.addInitScript(({ vector, hash, genesisHash, missingKey }) => {
    window.__voteCalls = [];
    window.pali = { on() {}, removeListener() {}, request: async ({ method, params }) => {
      window.__voteCalls.push({ method, params });
      if (method === 'sys_requestAccounts') return ['tsys-fixture'];
      if (method === 'sys_getSentryCapabilities') return { governanceVote: { scheme: 'secp256k1', signal: 'funding', maxNodes: 20 } };
      if (method === 'sys_signSentryVote') {
        if (missingKey) throw { code: -32603, message: `SENTRY_VOTING_KEY_MISSING: Import the matching voting keys for these nodes: ${hash}` };
        const request = params[0];
        if (request.proposalHash !== vector.proposalHash || request.chain.genesisHash !== genesisHash || request.outcome !== 'yes' || request.nodes.length !== 1 || request.nodes[0].proTxHash !== hash) throw new Error('Unexpected vote intent');
        const result = { ...request, votes: [{ proTxHash: hash, collateralOutpoint: { txid: vector.collateralHash, vout: vector.collateralIndex }, voteSig: vector.voteSig, signatureHash: vector.signatureHash, voteHash: vector.voteHash }] };
        delete result.nodes; return result;
      }
      throw new Error(`Unexpected wallet method ${method}`);
    } };
  }, { vector, hash, genesisHash, missingKey });
  await page.route('**/auth/me', (route) => route.fulfill({ json: { user: { id: 1, email: 'fixture@example.test', emailVerified: true, saltV: 'a'.repeat(32) } } }));
  await page.route('**/vault', (route) => route.fulfill({ json: { empty: true } }));
  await page.route('**/mnstats', (route) => route.fulfill({ json: { mn_stats: { enabled: 10 }, superblock_stats: { budget: 100000 } } }));
  // Core's object Key is the voting parent; nested Hash is a distinct DataHash.
  await page.route('**/govlist', (route) => route.fulfill({ json: [{ Key: vector.proposalHash, Hash: 'd'.repeat(64), ObectType: 1, name: 'A deliberately long funding proposal name for narrow-window layout checks', title: 'A deliberately long funding proposal name for narrow-window layout checks', AbsoluteYesCount: 1, YesCount: 2, NoCount: 1, payment_amount: 10 }] }));
  await page.route('**/gov/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/vote')) {
      writes += 1;
      const body = route.request().postDataJSON();
      expect(body).toEqual({ proposalHash: vector.proposalHash, voteOutcome: 'yes', voteSignal: 'funding', time: vector.timestamp, entries: [{ collateralHash: vector.collateralHash, collateralIndex: vector.collateralIndex, voteSig: vector.voteSig }] });
      if (unknown && writes === 1) return route.abort('timedout');
      return route.fulfill({ json: { accepted: 1, rejected: 0, results: [{ collateralHash: vector.collateralHash, collateralIndex: vector.collateralIndex, ok: true }] } });
    }
    if (path.endsWith('/reconcile')) { reconciles += 1; return route.fulfill({ json: { receipts: [], reconciled: true } }); }
    if (path.endsWith('/summary')) return route.fulfill({ json: { summary: [] } });
    if (path.endsWith('/recent')) return route.fulfill({ json: { receipts: [] } });
    return route.fulfill({ json: { receipts: [], matches: [] } });
  });
  await page.route('**/api/sentry/v1/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/capabilities')) return route.fulfill({ json: { version: 1, network: 'testnet', chain: { genesisHash, era: 'legacy-v3' }, operations: [] } });
    if (url.pathname.endsWith('/nodes')) return route.fulfill({ json: [{ network: 'testnet', proTxHash: hash, label: 'LongSentryNodeLabel'.repeat(4) }] });
    if (url.pathname.endsWith('/voting-context')) {
      expect(url.searchParams.get('proTxHashes')).toBe(hash);
      return route.fulfill({ json: { chain: { genesisHash, era: 'legacy-v3' }, now: vector.timestamp, proposalHash: vector.proposalHash, proposal: { name: 'A verified funding proposal name' }, nodes: [{ proTxHash: hash, collateralOutpoint: { txid: vector.collateralHash, vout: 0 }, votingKeyId: '751e76e8199196d454941c45d1b3a323f1433bd6', valid: true }] } });
    }
    throw new Error(`Unexpected API ${url.pathname}`);
  });
  return { writes: () => writes, reconciles: () => reconciles };
}

test('Pali voting uses an explicit custody choice and remains usable at320px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const fixture = await setup(page);
  await page.goto('/governance');
  await page.getByRole('button', { name: 'Vote on proposal' }).click();
  await expect(page.getByRole('dialog')).toContainText('Choose where your voting keys stay');
  await page.screenshot({ path: testInfo.outputPath('voting-key-store-choice-320.png'), animations: 'disabled' });
  await page.getByRole('button', { name: /Pali wallet Approve/ }).click();
  const review = page.getByRole('button', { name: 'Review 1 yes vote in Pali' });
  await expect(review).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('pali-vote-review-top-320.png'), animations: 'disabled' });
  await review.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('pali-vote-review-320.png'), animations: 'disabled' });
  await review.click();
  await expect(page.getByText(/1 of 1 relayed/)).toBeVisible();
  expect(fixture.writes()).toBe(1);
  expect(await page.evaluate(() => window.__voteCalls.map((call) => call.method))).toEqual(['sys_requestAccounts', 'sys_getSentryCapabilities', 'sys_signSentryVote']);
  await page.screenshot({ path: testInfo.outputPath('pali-vote-result-320.png'), animations: 'disabled' });
});

test('uncertain vote relay checks status before retrying the same approved signatures', async ({ page }) => {
  const fixture = await setup(page, { unknown: true });
  await page.goto('/governance');
  await page.getByRole('button', { name: 'Vote on proposal' }).click();
  await page.getByRole('button', { name: /Pali wallet Approve/ }).click();
  await page.getByRole('button', { name: 'Review 1 yes vote in Pali' }).click();
  await expect(page.getByRole('alert')).toContainText('Check status before retrying');
  await expect(page.getByRole('button', { name: 'Retry 1 failed vote' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check status' }).click();
  await page.getByRole('button', { name: 'Retry 1 failed vote' }).click();
  await expect(page.getByText(/1 of 1 relayed/)).toBeVisible();
  expect(fixture.writes()).toBe(2); expect(fixture.reconciles()).toBe(1);
  expect(await page.evaluate(() => window.__voteCalls.filter((call) => call.method === 'sys_signSentryVote').length)).toBe(1);
});

test('missing Pali key remains a readable non-submitting error at320px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const fixture = await setup(page, { missingKey: true });
  await page.goto('/governance');
  await page.getByRole('button', { name: 'Vote on proposal' }).click();
  await page.getByRole('button', { name: /Pali wallet Approve/ }).click();
  await page.getByRole('button', { name: 'Review 1 yes vote in Pali' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Pali does not hold every selected node');
  await alert.scrollIntoViewIfNeeded();
  expect(fixture.writes()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('pali-missing-voting-key-320.png'), animations: 'disabled' });
});
