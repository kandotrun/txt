import { defineConfig } from "@playwright/test";

/**
 * E2E configuration.
 *
 * The suite runs against `wrangler dev` (port 8799) with the production-shaped
 * build, exercising the real browser APIs: WebAuthn via CDP virtual
 * authenticators (with PRF), IndexedDB drafts, Service Worker media streaming.
 *
 * Every test gets an isolated context: storage, cookies and authenticators must
 * not leak between cases (the app is passkey-scoped per browser profile).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: ["**/debug*.spec.ts"],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.TXT_BASE_URL ?? "http://localhost:8799",
    trace: "retain-on-failure",
    ignoreHTTPSErrors: false,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
