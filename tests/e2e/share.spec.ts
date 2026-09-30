/**
 * Share card files and 「txt を紹介する」 (spec §4.6, §14).
 */

import { expect, test } from "@playwright/test";

import { installVirtualAuthenticator } from "./helpers/authenticator.ts";
import { registerViaOnboarding } from "./helpers/onboarding.ts";

const BASE = process.env.TXT_BASE_URL ?? "http://localhost:8799";

test.describe.configure({ mode: "serial" });

test("serves the share files as themselves, not as the SPA shell", async ({ request }) => {
  for (const [file, type] of [
    ["/og.png", "image/png"],
    ["/apple-touch-icon.png", "image/png"],
    ["/robots.txt", "text/plain"],
  ] as const) {
    const response = await request.get(`${BASE}${file}`);
    expect(response.status(), file).toBe(200);
    expect(response.headers()["content-type"], file).toContain(type);
  }

  const shell = await (await request.get(`${BASE}/`)).text();
  expect(shell).toContain('property="og:image" content="https://txt.2-38.com/og.png"');
  expect(shell).not.toContain("noindex");
});

test("shares only the app URL and the introduction", async ({ page }) => {
  // Record what would reach the OS share sheet.
  await page.addInitScript(() => {
    const calls: ShareData[] = [];
    (window as unknown as { __shared: ShareData[] }).__shared = calls;
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData) => {
        calls.push(data);
      },
    });
  });
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await page.locator("#editor-host .ProseMirror").click();
  await page.keyboard.type("ひみつのメモ");

  await page.getByRole("button", { name: "その他" }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "txt を紹介する" }).click();

  const shared = await page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared);
  expect(shared).toHaveLength(1);
  expect(shared[0]!.url).toBe(`${new URL(BASE).origin}/`);
  expect(shared[0]!.title).toBe("txt");
  // Nothing from the sheet itself may leave the page.
  expect(JSON.stringify(shared[0])).not.toContain("ひみつ");
});

test("copies the link where the share sheet is unavailable", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  });
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });

  await page.getByRole("button", { name: "その他" }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "txt を紹介する" }).click();
  await expect(page.locator("#toast")).toHaveText("リンクをコピーしました。");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(BASE).origin}/`);
});
