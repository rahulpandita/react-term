import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 10 * 60 * 1000, // 10 minutes per test
  retries: 0,
  workers: 1, // sequential — one terminal at a time
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: [
        '--enable-features=SharedArrayBuffer',
      ],
    },
  },
  webServer: [
    {
      command: 'npx tsx server/replay-server.ts',
      port: 8081,
      reuseExistingServer: true,
    },
    {
      command: 'npx vite --port 5174',
      port: 5174,
      reuseExistingServer: true,
    },
  ],
});
