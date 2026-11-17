import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 180000,
  use: {
    baseURL: "http://localhost:3100",
    actionTimeout: 15000,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm start -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
