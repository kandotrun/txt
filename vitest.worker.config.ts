import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // The bundled workerd in vitest-pool-workers lags the production
          // wrangler; pin the highest date that binary supports so tests can
          // run while production keeps the newer compatibility date.
          compatibilityDate: "2026-08-22",
          // Tests exercise the production host policy: the canonical origin and
          // RP ID, which also selects the `__Host-` session cookie. The local
          // `.dev.vars` values are deliberately not used here.
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ORIGIN: "https://txt.2-38.com",
            WEBAUTHN_RP_ID: "txt.2-38.com",
            WEBAUTHN_RP_NAME: "txt",
            REGISTRATION_MODE: "open",
            ACCOUNT_LIMIT_BYTES: "10737418240",
            MEDIA_GRACE_MS: "86400000",
          },
        },
      }),
    ],
    test: {
      include: ["tests/worker/**/*.test.ts"],
      setupFiles: ["./tests/worker/setup.ts"],
    },
  };
});
