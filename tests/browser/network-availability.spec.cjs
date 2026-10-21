const { test, expect } = require('@playwright/test');

const cold = {
  stats: {
    mn_stats: { total: '0', enabled: '0', pose_banned: '0', total_locked: '0.00',
      current_supply: '0.00', coins_percent_locked: 'NaN%', roi: 'Infinity%',
      roi_one: 'Infinity%', roi_two: 'Infinity%' },
    price_stats: { price_usd: '0.0000', volume_usd: '0.00', market_cap_usd: '0.00' },
    blockchain_stats: { version: 0, connections: '0' },
    superblock_stats: { superblock_date: 0, superblock_next_epoch_sec: 0 },
  },
  mapData: {},
};

for (const route of ['/', '/network']) {
  for (const width of [320, 390]) {
    test(`${route} keeps cold-start errors and history readable at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 640 });
      await page.route('**/auth/me', (request) => request.fulfill({ status: 401, json: { error: 'unauthorized' } }));
      await page.route('**/mnstats', (request) => request.fulfill({ json: cold }));
      await page.route('**/mncount', (request) => request.fulfill({ json: [
        { date: '2026-10-20', users: 3119 }, { date: '2026-10-21', users: 3123 },
      ] }));
      await page.goto(route);
      await expect(page.getByText('Live network statistics are unavailable right now.')).toBeVisible();
      await expect(page.locator('canvas')).toHaveCount(1);
      await expect(page.locator('main')).not.toContainText(/Infinity|NaN|SB0/);
      const layout = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll('body *')].filter((element) =>
          element.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map((element) =>
          ({ tag: element.tagName, className: element.className })),
      }));
      expect(layout.width, JSON.stringify(layout.overflow)).toBeLessThanOrEqual(width + 1);
      await page.screenshot({ path: testInfo.outputPath('stats-unavailable.png'), fullPage: true });
    });
  }
}

test('an HTTP stats failure still shows the independent history chart', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.route('**/auth/me', (request) => request.fulfill({ status: 401, json: { error: 'unauthorized' } }));
  await page.route('**/mnstats', (request) => request.fulfill({ status: 503, json: { error: 'stats_unavailable' } }));
  await page.route('**/mncount', (request) => request.fulfill({ json: [{ date: '2026-10-21', users: 3123 }] }));
  await page.goto('/network');
  await expect(page.getByText('Live network statistics are unavailable right now.')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(page.locator('main')).not.toContainText(/Infinity|NaN/);
  await page.screenshot({ path: testInfo.outputPath('stats-http-error.png'), fullPage: true });
});

test('market failure keeps known Core metrics and null-derived values readable', async ({ page }, testInfo) => {
  const now = Date.now();
  const payload = {
    stats_meta: { groups: {
      chain: { status: 'ready', updated_at: now },
      node: { status: 'ready', updated_at: now },
      governance: { status: 'ready', updated_at: now },
      market: { status: 'unavailable', updated_at: null },
    } },
    stats: {
      mn_stats: { total: '3,123', enabled: '2,139', pose_banned: '984', total_locked: '312,300,000.00',
        coins_percent_locked: null, current_supply: null, collateral_req: '100,000', roi: '5.20%',
        roi_one: '7.02%', roi_two: '10.40%', payout_frequency: '3d 17h 7m 30s' },
      blockchain_stats: { version: 50102, sub_version: 'Syscoin:5.0.1.2', protocol: 70022,
        connections: '2,329,762', genesis: '2018-01-01', avg_block: '2m 30s' },
      superblock_stats: { next_superblock: 'SB133 - 2330160', superblock_date: 'October 30th 2026, 1:00:00 pm',
        superblock_next_epoch_sec: Math.floor(now / 1000) + 86400 },
      price_stats: { price_usd: null, volume_usd: null, market_cap_usd: null },
      income_stats: { usd: { daily: null }, sys: { daily: '14.25 SYS' } },
    }, mapData: {},
  };
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('**/auth/me', (request) => request.fulfill({ status: 401, json: { error: 'unauthorized' } }));
  await page.route('**/mnstats', (request) => request.fulfill({ json: payload }));
  await page.route('**/mncount', (request) => request.fulfill({ json: [{ date: '2026-10-21', users: 3123 }] }));
  await page.goto('/network');
  await expect(page.getByText('Market statistics are unavailable.')).toBeVisible();
  await expect(page.locator('.summary-card').filter({ hasText: 'Enabled Nodes' }).getByText('2,139', { exact: true })).toBeVisible();
  await expect(page.getByText('14.25 SYS', { exact: true })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/Infinity|NaN|undefined/);
  const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
    .slice(0, 12).map((element) => ({ tag: element.tagName, className: element.className })));
  expect(await page.evaluate(() => document.documentElement.scrollWidth), JSON.stringify(overflow)).toBeLessThanOrEqual(321);
  await page.screenshot({ path: testInfo.outputPath('market-unavailable.png'), fullPage: true });
});

test('governance stats outage preserves proposals without false support at phone width', async ({ page }, testInfo) => {
  const now = Math.floor(Date.now() / 1000);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('**/auth/me', (request) => request.fulfill({ status: 401, json: { error: 'unauthorized' } }));
  await page.route('**/mnstats', (request) => request.fulfill({ json: cold }));
  await page.route('**/govlist', (request) => request.fulfill({ json: [{
    Key: 'a'.repeat(64), Hash: 'b'.repeat(64), ObectType: 1, fBlockchainValidity: true,
    fCachedValid: true, fCachedDelete: false, start_epoch: now - 86400, end_epoch: now + 86400 * 30,
    AbsoluteYesCount: 18, YesCount: 20, NoCount: 2, payment_amount: '1000',
    name: 'Example grant', title: 'Example grant', CreationTime: now - 86400,
  }] }));
  await page.goto('/governance');
  await expect(page.getByText('Support unavailable')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Passing', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Copy yes vote command' })).toBeEnabled();
  await expect(page.locator('main')).not.toContainText(/Not Enough Votes|0\.00%|Infinity|NaN/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
  await page.screenshot({ path: testInfo.outputPath('governance-stats-unavailable.png'), fullPage: true });
});
