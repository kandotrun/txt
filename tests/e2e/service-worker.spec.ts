import { expect, test } from "@playwright/test";
import { installVirtualAuthenticator } from "./helpers/authenticator.ts";
import { registerViaOnboarding } from "./helpers/onboarding.ts";

const base = new URL(process.env.TXT_BASE_URL ?? "http://localhost:8799");
if (!["localhost", "127.0.0.1"].includes(base.hostname)) {
  throw new Error("Service Worker registration E2E requires a local synthetic account");
}

test("spec: 実際のESモジュール版Service Workerが初回登録でページを制御する", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto("/");
  await registerViaOnboarding(page);
  await expect(page.locator("#editor-host .ProseMirror")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ""), {
    timeout: 15_000,
  }).toBe(new URL("/sw.js", base).href);
});
