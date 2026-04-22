import { defineConfig } from '@playwright/test';

// BENCH_WS_PORT overrides the replay-server port (and the port Vite exposes
// to the frontend) so an A/B run can avoid colliding with another service
// already bound to 8081.
const WS_PORT = Number(process.env.BENCH_WS_PORT ?? 8081);

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
      command: `BENCH_WS_PORT=${WS_PORT} npx tsx server/replay-server.ts`,
      port: WS_PORT,
      reuseExistingServer: true,
    },
    {
      command: `VITE_BENCH_WS_PORT=${WS_PORT} npx vite --port 5174`,
      port: 5174,
      reuseExistingServer: true,
    },
  ],
});
