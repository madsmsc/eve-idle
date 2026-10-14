'use strict';

const { defineConfig } = require('@playwright/test');
const os = require('os');
const path = require('path');

const PORT = 4199;
// Unique temp save per run so every E2E run starts from a clean slate.
const DATA_FILE = path.join(os.tmpdir(), `eve-idle-e2e-${process.pid}-${Date.now()}.json`);

module.exports = defineConfig({
  testDir: './tests',
  testMatch: /e2e\.spec\.js$/,
  timeout: 45000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
  },
  webServer: {
    command: 'node server/index.js',
    url: `http://127.0.0.1:${PORT}/health`,
    env: { PORT: String(PORT), DATA_FILE },
    cwd: __dirname,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
