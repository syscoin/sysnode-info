const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4317', trace: 'retain-on-failure' },
  webServer: { command: 'PORT=4317 node server.js', url: 'http://127.0.0.1:4317', reuseExistingServer: false },
  outputDir: 'test-results/sentry',
});
