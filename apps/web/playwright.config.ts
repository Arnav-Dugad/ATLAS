import { defineConfig, devices } from "@playwright/test";

/** End-to-end smoke tests against the static (snapshot-mode) build and a frozen real-data fixture. */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4179/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npx vite preview --outDir dist-e2e --port 4179 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4179/",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
