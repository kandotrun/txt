/**
 * Onboarding and the refreshed UI (spec §4.1, §4.2, §4.6, §17.5).
 *
 * The intro explains the sheet, passkeys, device encryption and the recovery
 * key before any passkey ceremony; one-time hints follow registration without
 * taking focus; motion never touches the editing surface.
 */

import fs from "node:fs/promises";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installVirtualAuthenticator } from "./helpers/authenticator.ts";
import { registerViaOnboarding } from "./helpers/onboarding.ts";

const BASE = process.env.TXT_BASE_URL ?? "http://localhost:8799";

test.describe.configure({ mode: "serial" });

const introTitle = (page: Page) => page.locator("#intro-title");

test("walks through the intro with buttons and the keyboard", async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator(".wordmark")).toBeVisible();
  await page.getByRole("button", { name: "はじめて使う" }).click();

  const intro = page.locator("#intro");
  await expect(intro).toBeVisible();
  await expect(page.locator("#intro-progress")).toHaveText("1 / 4");
  await expect(introTitle(page)).toContainText("1枚だけ");
  await expect(intro.getByRole("button", { name: "やめる" })).toBeVisible();

  await intro.getByRole("button", { name: "次へ" }).click();
  await expect(page.locator("#intro-progress")).toHaveText("2 / 4");
  await expect(introTitle(page)).toContainText("パスキーで開く");

  await page.keyboard.press("ArrowRight");
  await expect(introTitle(page)).toContainText("端末で暗号化");
  await page.keyboard.press("ArrowLeft");
  await expect(introTitle(page)).toContainText("パスキーで開く");
  await intro.getByRole("button", { name: "戻る" }).click();
  await expect(page.locator("#intro-progress")).toHaveText("1 / 4");

  // Skipping still lands on the recovery-key slide, never past it.
  await intro.getByRole("button", { name: "スキップ" }).click();
  await expect(introTitle(page)).toContainText("復旧キーを控える");
  await expect(intro.getByRole("button", { name: "パスキーを作成" })).toBeVisible();
  await expect(intro.getByRole("button", { name: "スキップ" })).toBeHidden();

  // Escape leaves the intro without starting a passkey ceremony.
  await page.keyboard.press("Escape");
  await expect(intro).toBeHidden();
  await expect(page.getByRole("button", { name: "はじめて使う" })).toBeVisible();
});

test("registers from the last slide and guides the first edit", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await page.getByRole("button", { name: "はじめて使う" }).click();
  for (const title of ["パスキーで開く", "端末で暗号化", "復旧キーを控える"]) {
    await page.locator("#intro").getByRole("button", { name: "次へ" }).click();
    await expect(introTitle(page)).toContainText(title);
  }
  await page.getByRole("button", { name: "パスキーを作成" }).click();

  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  const recoveryKey = ((await dialog.locator("pre").textContent()) ?? "").trim();
  expect(recoveryKey).toMatch(/^TXT1\./);

  // Copying is its own action; the confirmation no longer claims a copy happened.
  await dialog.getByRole("button", { name: "コピー", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "コピーしました" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(recoveryKey);

  // The key can also be saved as a file (spec §7.1).
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "ファイルに保存" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("txt-recovery-key.txt");
  const saved = await fs.readFile(await download.path(), "utf8");
  expect(saved).toContain(recoveryKey);

  await dialog.getByRole("button", { name: "保存しました" }).click();
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });

  // One-time hints and the empty-state hint appear without taking focus.
  const coach = page.locator("#coach");
  await expect(coach).toBeVisible();
  await expect(coach).toContainText("写真・動画・音声");
  await expect(coach).toContainText("復旧キー");
  await expect(page.locator("#empty-hint")).toBeVisible();
  await expect(page.locator("#editor-host .ProseMirror")).toBeFocused();

  await page.keyboard.type("はじめの一行");
  await expect(coach).toBeHidden();
  await expect(page.locator("#empty-hint")).toBeHidden();
  await expect(page.locator("#editor-host .ProseMirror")).toContainText("はじめの一行");
});

test("organises 「その他」 as a list and replays the intro", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  await page.locator("#editor-host .ProseMirror").click();
  await page.keyboard.type("残る本文");

  await page.getByRole("button", { name: "その他" }).click();
  const menu = page.locator("dialog[open]");
  await expect(menu).toHaveClass(/dialog--menu/);
  // The irreversible action is set apart by more than colour: its own tone
  // class, an icon, and a divider above the session actions.
  const remove = menu.getByRole("button", { name: "アカウントを削除" });
  await expect(remove).toHaveClass(/danger/);
  await expect(remove.locator("svg")).toHaveCount(1);
  await expect(menu.locator(".menu-separator")).toHaveCount(1);
  await menu.getByRole("button", { name: "閉じる" }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);

  await page.getByRole("button", { name: "その他" }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "使い方" }).click();
  const intro = page.locator("#intro");
  await expect(intro).toBeVisible();
  await intro.getByRole("button", { name: "スキップ" }).click();
  await expect(intro.getByRole("button", { name: "パスキーを作成" })).toHaveCount(0);
  await intro.getByRole("button", { name: "閉じる" }).click();
  await expect(intro).toBeHidden();
  await expect(page.locator("#editor-host .ProseMirror")).toContainText("残る本文");
});

test("keeps motion off the editing surface during the cross-fade", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#editor-host .ProseMirror")).toBeVisible({ timeout: 30000 });

  // Sampled while the gate is still fading out on top of the editor (§4.2):
  // neither the surface nor any ancestor may be transformed or animated.
  const hazards = await page.evaluate(() => {
    const surface = document.querySelector("#editor-host .ProseMirror");
    const chain: Element[] = [];
    for (let node: Element | null = surface; node; node = node.parentElement) chain.push(node);
    const label = (node: Element) => node.id || node.className || node.tagName;
    const transformed = chain
      .filter((node) => getComputedStyle(node).transform !== "none")
      .map(label);
    const animated = document
      .getAnimations()
      .map((animation) => (animation.effect as KeyframeEffect | null)?.target ?? null)
      .filter((target): target is Element => target !== null && chain.includes(target))
      .map(label);
    return { surfaceFound: surface !== null, transformed, animated };
  });
  expect(hazards).toEqual({ surfaceFound: true, transformed: [], animated: [] });
});

test("honours reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(BASE);
  await page.getByRole("button", { name: "はじめて使う" }).click();
  await page.locator("#intro").getByRole("button", { name: "次へ" }).click();
  await expect(introTitle(page)).toContainText("パスキーで開く");

  // Every animation or transition that exists is effectively instant.
  const slow = await page.evaluate(() =>
    document
      .getAnimations()
      .map((animation) => Number(animation.effect?.getComputedTiming().duration ?? 0))
      .filter((duration) => duration > 1),
  );
  expect(slow).toEqual([]);
});
