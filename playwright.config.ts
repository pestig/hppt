import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { browserOptions } from './tests/browser-options';
if (existsSync('.env')) process.loadEnvFile('.env');
export default defineConfig({
  testDir: './tests/e2e', workers: 1, fullyParallel: false, timeout: 70000, globalTimeout: 600000,
  expect: { timeout: 10000 }, reporter: [['list'], ['html', { open: 'never' }]],
  // Traces record response bodies, including dev TURN credentials. Keep reports secret-free.
  use: { headless: true, launchOptions: browserOptions, trace: 'off', screenshot: 'only-on-failure' }
});
