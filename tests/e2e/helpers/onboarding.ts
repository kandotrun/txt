/**
 * Registration through the intro (spec §4.6 「紹介」→「新規作成」).
 */

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Creates an account from the gate and confirms the recovery key; returns the key. */
export async function registerViaOnboarding(page: Page): Promise<string> {
  await page.getByRole("button", { name: "はじめて使う" }).click();
  await page.getByRole("button", { name: "スキップ" }).click();
  await page.getByRole("button", { name: "パスキーを作成" }).click();
  await expect(page.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  const recoveryKey = ((await page.locator("dialog pre").textContent()) ?? "").trim();
  await page.getByRole("button", { name: "保存しました" }).click();
  return recoveryKey;
}
