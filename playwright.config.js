const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 60000,
  use: {
    baseURL: process.env.TEST_URL || 'http://localhost:8787',
    headless: true,
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
});
