const { test, expect } = require('@playwright/test');

const ACCOUNT = `0x${'12'.repeat(20)}`;
const CHAIN = {
  chainId: 57057,
  name: 'zkTanenbaum',
  recoveryModule: `0x${'45'.repeat(20)}`,
  testnet: true,
};
const signature = `0x${'ab'.repeat(24000)}`;

async function fixtures(
  page,
  {
    monitored = false,
    degraded = false,
    emailVerified = true,
    subscribeError = null,
    withHistory = false,
    deferSignature = false,
  } = {}
) {
  let subscriptions = monitored
    ? [
        {
          id: 1,
          account: ACCOUNT,
          chainId: 57057,
          label: 'Savings with a long but valid account label',
          createdAt: Date.now(),
          monitoring: {
            status: degraded ? 'degraded' : 'active',
            lastCheckedAt: Date.now(),
            lastBlockTimestamp: Math.floor(Date.now() / 1000),
          },
          pending: [
            {
              operationId: `0x${'de'.repeat(32)}`,
              scheduledAt: Math.floor(Date.now() / 1000),
              executableAt: Math.floor(Date.now() / 1000) + 259200,
              expiresAt: Math.floor(Date.now() / 1000) + 864000,
              status: 'pending',
            },
            ...(withHistory
              ? [
                  {
                    operationId: `0x${'bc'.repeat(32)}`,
                    executableAt: Math.floor(Date.now() / 1000) - 3600,
                    status: 'canceled',
                  },
                ]
              : []),
          ],
        },
      ]
    : [];
  const writes = [];
  let verified = emailVerified;
  await page.addInitScript(
    ({ ACCOUNT, signature, deferSignature }) => {
      const listeners = new Map();
      window.__walletCalls = [];
      const provider = {
        isPali: true,
        on(event, callback) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event).add(callback);
        },
        removeListener(event, callback) {
          listeners.get(event)?.delete(callback);
        },
        async request({ method, params }) {
          window.__walletCalls.push({ method, params });
          if (method === 'eth_chainId') return '0xdee1';
          if (method === 'eth_accounts' || method === 'eth_requestAccounts')
            return [ACCOUNT];
          if (method === 'personal_sign') {
            if (deferSignature)
              return new Promise((_resolve, reject) => {
                window.__rejectRecoverySignature = () => reject({ code: 4001 });
              });
            return signature;
          }
          throw new Error(`Unexpected wallet method: ${method}`);
        },
      };
      window.ethereum = provider;
    },
    { ACCOUNT, signature, deferSignature }
  );
  await page.route('**/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 1,
          email: 'recovery.alerts.qa@example.test',
          emailVerified: verified,
          saltV: 'ab'.repeat(32),
          notificationPrefs: {},
          totpEnabled: true,
        },
      },
    })
  );
  await page.route('**/vault', (route) =>
    route.fulfill({ json: { empty: true } })
  );
  await page.route('**/api/recovery/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/recovery/chains')
      return route.fulfill({ json: { chains: [CHAIN] } });
    if (
      path === '/api/recovery/subscriptions' &&
      route.request().method() === 'GET'
    )
      return route.fulfill({ json: { subscriptions } });
    const body = route.request().postDataJSON();
    writes.push({ path, body });
    if (path === '/api/recovery/challenges')
      return route.fulfill({
        json: {
          id: 'nonce',
          message: 'Sysnode recovery alert enrollment\nAccount: ' + ACCOUNT,
          chainId: 57057,
          account: ACCOUNT,
          expiresAt: Date.now() + 300000,
        },
      });
    if (path === '/api/recovery/subscriptions') {
      expect(body).toEqual({
        challengeId: 'nonce',
        signature,
        label: 'Savings',
      });
      if (subscribeError)
        return route.fulfill({ status: 400, json: { error: subscribeError } });
      const subscription = {
        id: 1,
        account: ACCOUNT,
        chainId: 57057,
        label: 'Savings',
        monitoring: { status: 'catching_up', lastCheckedAt: null },
        pending: [],
      };
      subscriptions = [subscription];
      return route.fulfill({ json: { subscription } });
    }
    if (path === '/api/recovery/subscriptions/1')
      return route.fulfill({
        status: 401,
        json: { error: 'invalid_credentials' },
      });
    throw new Error(`Unexpected API: ${path}`);
  });
  return {
    writes,
    verifyEmail: () => {
      verified = true;
    },
  };
}

async function noHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => {
    if (document.documentElement.scrollWidth <= window.innerWidth) return [];
    return [...document.querySelectorAll('body *')]
      .filter(
        (element) =>
          element.getBoundingClientRect().right > window.innerWidth + 1
      )
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        width: element.getBoundingClientRect().width,
      }));
  });
  expect(overflow).toEqual([]);
}

test('320px recovery enrollment uses standard wallet signing and shows catch-up instead of claiming monitoring active', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 500 });
  const fixture = await fixtures(page);
  await page.goto('/account#recovery-alerts');
  await page
    .getByRole('button', { name: 'Connect wallet', exact: true })
    .click();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.getByLabel('Account label (optional)').fill('Savings');
  await page
    .getByRole('button', { name: 'Enable recovery alerts', exact: true })
    .click();
  await expect(
    page.getByText('Checking chain history', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(/Account linked for recovery alerts/)
  ).toBeVisible();
  expect(fixture.writes).toHaveLength(2);
  const calls = await page.evaluate(() => window.__walletCalls);
  expect(calls.filter((call) => call.method === 'personal_sign')).toHaveLength(
    1
  );
  expect(calls.some((call) => call.method === 'eth_sendTransaction')).toBe(
    false
  );
  await noHorizontalOverflow(page);
  await page.locator('#recovery-alerts').screenshot({
    path: testInfo.outputPath('recovery-enrollment-320.png'),
    style: '.site-header { visibility: hidden !important; }',
  });
});

test('a signature rejection reveals a collapsed enrollment and focuses its error', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  const fixture = await fixtures(page, { deferSignature: true });
  await page.goto('/account#recovery-alerts');
  await page
    .getByRole('button', { name: 'Connect wallet', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Enable recovery alerts', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Confirm in wallet…' })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Collapse recovery alerts' })
  ).toBeDisabled();
  await page.getByText('Link a smart account', { exact: true }).click();
  await expect(page.locator('.recovery-enroll')).toBeHidden();
  await page.evaluate(() => window.__rejectRecoverySignature());
  await expect(page.getByRole('alert')).toHaveText(
    /signature request was canceled/
  );
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).toBeFocused();
  expect(fixture.writes).toHaveLength(1);
});

test('small-window pending recovery and disable confirmation remain readable with correct account and network', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 500 });
  const fixture = await fixtures(page, { monitored: true, degraded: true });
  await page.goto('/account#recovery-alerts');
  await expect(
    page.getByText('Monitoring delayed', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('Recovery pending', { exact: true })
  ).toBeVisible();
  await page.locator('#recovery-alerts').screenshot({
    path: testInfo.outputPath('recovery-pending-360.png'),
    style: '.site-header { visibility: hidden !important; }',
  });
  await page.getByRole('button', { name: 'Disable these alerts…' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Disable alerts for Savings with a long but valid account label?',
    })
  ).toBeVisible();
  await page.getByLabel('Current Sysnode password').fill('wrong-password');
  await page.getByLabel('Authenticator code').fill('123456');
  await page
    .getByRole('button', { name: 'Disable alerts', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveText(
    /current Sysnode password is incorrect/
  );
  await expect(page.getByRole('alert')).toBeFocused();
  expect(fixture.writes.at(-1).body.code).toBe('123456');
  await noHorizontalOverflow(page);
  await page.locator('.recovery-remove').screenshot({
    path: testInfo.outputPath('recovery-disable-360.png'),
    style: '.site-header { visibility: hidden !important; }',
  });
  await page.getByRole('button', { name: 'Keep alerts' }).click();
  await expect(page.getByLabel('Current Sysnode password')).toHaveCount(0);
});

for (const width of [320, 390]) {
  test(`${width}px disable errors stay beside the password confirmation and in view`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 500 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const fixture = await fixtures(page, { monitored: true });
    await page.goto('/account#recovery-alerts');
    await page.getByRole('button', { name: 'Disable these alerts…' }).click();
    await page.getByLabel('Current Sysnode password').fill('wrong-password');
    await page.getByLabel('Authenticator code').fill('123456');
    await page
      .getByRole('button', { name: 'Disable alerts', exact: true })
      .click();
    const error = page.getByRole('alert');
    await expect(error).toHaveText(/current Sysnode password is incorrect/);
    await expect(error).toBeFocused();
    await expect
      .poll(async () => {
        const bounds = await error.boundingBox();
        return bounds.y >= 70 && bounds.y + bounds.height <= 500;
      })
      .toBe(true);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0].path).toBe('/api/recovery/subscriptions/1');
    await noHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`recovery-disable-error-${width}.png`),
    });
    await page.locator('.recovery-remove').screenshot({
      path: testInfo.outputPath(`recovery-disable-${width}.png`),
      style: '.site-header { visibility: hidden !important; }',
    });
  });

  test(`${width}px enrollment failure stays in view below long recovery status`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 500 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const fixture = await fixtures(page, {
      monitored: true,
      withHistory: true,
      subscribeError: 'invalid_signature',
    });
    await page.goto('/account#recovery-alerts');
    await expect(
      page.getByText('Recovery pending', { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText('Recovery canceled or invalidated')
    ).toBeHidden();
    await page.getByText('How to review in Pali', { exact: true }).click();
    await expect(
      page.getByText('Disable guardian recovery', { exact: true })
    ).toBeVisible();
    await page.locator('#recovery-alerts').screenshot({
      path: testInfo.outputPath(`recovery-pending-${width}.png`),
      style: '.site-header { visibility: hidden !important; }',
    });
    await page.getByText('Link another smart account', { exact: true }).click();
    await page
      .getByRole('button', { name: 'Connect wallet', exact: true })
      .click();
    await page.getByLabel('Account label (optional)').fill('Savings');
    await page
      .getByRole('button', { name: 'Enable recovery alerts', exact: true })
      .click();
    const error = page.getByRole('alert');
    await expect(error).toHaveText(/could not verify this signature/);
    await expect(error).toBeFocused();
    await expect
      .poll(async () => {
        const bounds = await error.boundingBox();
        return bounds.y >= 70 && bounds.y + bounds.height <= 500;
      })
      .toBe(true);
    expect(fixture.writes).toHaveLength(2);
    await noHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`recovery-enrollment-error-${width}.png`),
    });
  });

  test(`${width}px unverified email has a read-only next step and no wallet request`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 500 });
    const fixture = await fixtures(page, { emailVerified: false });
    await page.goto('/account#recovery-alerts');
    await expect(
      page.getByRole('button', { name: 'Connect wallet', exact: true })
    ).toBeDisabled();
    await expect(
      page.getByText(/Verify your email before linking/)
    ).toBeVisible();
    await noHorizontalOverflow(page);
    await page.locator('#recovery-alerts').screenshot({
      path: testInfo.outputPath(`recovery-unverified-${width}.png`),
      style: '.site-header { visibility: hidden !important; }',
    });
    fixture.verifyEmail();
    await page
      .getByRole('button', { name: 'Check verification status' })
      .click();
    await expect(
      page.getByRole('button', { name: 'Connect wallet', exact: true })
    ).toBeEnabled();
    expect(fixture.writes).toHaveLength(0);
    expect(await page.evaluate(() => window.__walletCalls)).toEqual([]);
  });
}
