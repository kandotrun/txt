/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Test setup: applies D1 migrations to the isolated test database.
 */

import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeAll } from "vitest";

interface TestEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  TEST_MIGRATIONS: D1Migration[];
}

beforeAll(async () => {
  const testEnv = env as unknown as TestEnv;
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
