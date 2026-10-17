const { test, expect } = require('@playwright/test');

for (const viewport of [{ width: 320, height: 360 }, { width: 400, height: 620 }]) {
  test(`governance shows supported dates and estimated selection at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const now = Math.floor(Date.now() / 1000);
    // Production /mnstats supplies UTC display strings, not numeric seconds.
    const dashboardDate = epoch => {
      const date = new Date(epoch * 1000);
      const day = date.getUTCDate();
      const ordinal = day >= 11 && day <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th');
      const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
      const hour = date.getUTCHours();
      const pad = value => String(value).padStart(2, '0');
      return `${month} ${day}${ordinal} ${date.getUTCFullYear()}, ${hour % 12 || 12}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${hour >= 12 ? 'pm' : 'am'}`;
    };
    const valid = {
      Key: 'a'.repeat(64),
      // The old one-off blacklist must not hide a supported record.
      Hash: '1b9039bd9f7b36dc43a2d8e4dea944550897414fabd981404b3d3d51741175d6',
      ObectType: 1, fBlockchainValidity: true, fCachedValid: true, fCachedDelete: false,
      start_epoch: now - 86400, end_epoch: now + 86400 * 365 * 5,
      name: 'supported-proposal', title: 'Supported long-running proposal',
      AbsoluteYesCount: 3, YesCount: 4, NoCount: 1, payment_amount: 10,
    };
    const malformed = { ...valid, Key: 'b'.repeat(64), Hash: 'c'.repeat(64), title: 'Malformed millisecond proposal', end_epoch: 1743371426000 };
    await page.route('**/auth/me', route => route.fulfill({ status: 401, json: { error: 'unauthorized' } }));
    await page.route('**/mnstats', route => route.fulfill({ json: { stats: { mn_stats: { enabled: 10 }, superblock_stats: { budget: 100000, voting_deadline: dashboardDate(now + 3 * 86400), superblock_date: dashboardDate(now + 6 * 86400) } } } }));
    await page.route('**/govlist', route => route.fulfill({ json: [malformed, valid] }));
    await page.goto('/governance');
    const title = page.getByText('Estimated Selection Start', { exact: true });
    await expect(title).toBeVisible();
    await expect(title.locator('..')).not.toContainText('Loading...');
    await expect(title.locator('..')).not.toContainText('Pending feed');
    await expect(page.getByText('Voting Deadline', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Malformed millisecond proposal', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: valid.title })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await title.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`selection-summary-${viewport.width}.png`) });
    const chip = page.getByTestId('proposal-row-meta-chip').filter({ hasText: 'Selection in' });
    await chip.scrollIntoViewIfNeeded();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('title', /not a deadline for submitting proposal votes/);
    await expect(page.getByText(/Closes in/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`selection-row-${viewport.width}.png`) });
  });
}
