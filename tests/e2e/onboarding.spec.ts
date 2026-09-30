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

  // One-time hints and the empty-state hint appear without taking focus. The
  // #coach layer itself has no height; the bubbles are what the user sees.
  const hints = page.locator("#coach .coach-bubble");
  await expect(hints).toHaveCount(2);
  await expect(hints.first()).toBeVisible();
  await expect(hints.first()).toContainText("写真・動画・音声");
  await expect(hints.last()).toContainText("復旧キー");
  await expect(page.locator("#empty-hint")).toBeVisible();
  await expect(page.locator("#editor-host .ProseMirror")).toBeFocused();

  await page.keyboard.type("はじめの一行");
  await expect(page.locator("#coach")).toHaveAttribute("hidden", "");
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
  // Sample every frame from page load (§4.2): neither the surface nor any
  // ancestor may ever be transformed or animated, and the gate's fade-out
  // must actually have been observed on top of the visible editor.
  await page.addInitScript(() => {
    const record = { hazards: [] as string[], sawGateLeaving: false };
    (window as unknown as { __motion: typeof record }).__motion = record;
    const label = (node: Element) => node.id || String(node.className) || node.tagName;
    const sample = (): void => {
      const surface = document.querySelector("#editor-host .ProseMirror");
      const app = document.getElementById("app");
      if (surface && app && !app.hidden) {
        const chain: Element[] = [];
        for (let node: Element | null = surface; node; node = node.parentElement) chain.push(node);
        for (const node of chain) {
          if (getComputedStyle(node).transform !== "none") record.hazards.push(`transform:${label(node)}`);
        }
        for (const animation of document.getAnimations()) {
          const target = (animation.effect as KeyframeEffect | null)?.target ?? null;
          if (target && chain.includes(target)) record.hazards.push(`animation:${label(target)}`);
        }
        if (document.getElementById("gate")?.classList.contains("is-leaving")) {
          record.sawGateLeaving = true;
        }
      }
      window.requestAnimationFrame(sample);
    };
    window.requestAnimationFrame(sample);
  });
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#editor-host .ProseMirror")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#gate")).toBeHidden();

  const record = await page.evaluate(
    () => (window as unknown as { __motion: { hazards: string[]; sawGateLeaving: boolean } }).__motion,
  );
  expect(record.sawGateLeaving).toBe(true);
  expect([...new Set(record.hazards)]).toEqual([]);
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

test("centres a readable text column on wide screens", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  const surface = page.locator("#editor-host .ProseMirror");
  await expect(surface).toBeVisible({ timeout: 30000 });

  const measure = async () =>
    page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const text = box("#editor-host .ProseMirror");
      return {
        viewport: document.documentElement.clientWidth,
        left: text.left,
        right: text.right,
        width: text.width,
        attachCentre: box("#attach-button").left + 22,
        moreCentre: box("#more-button").right - 22,
      };
    });

  // Wide: at most 720px, centred, with the controls on the column's edges.
  const wide = await measure();
  expect(wide.width).toBeLessThanOrEqual(720);
  expect(Math.abs(wide.left - (wide.viewport - wide.right))).toBeLessThanOrEqual(1);
  expect(Math.abs(wide.attachCentre - (wide.left + 12))).toBeLessThanOrEqual(1);
  expect(Math.abs(wide.moreCentre - (wide.right - 12))).toBeLessThanOrEqual(1);

  // Narrow: the column uses the width with the mobile gutter (16px).
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await measure();
  expect(narrow.left).toBe(16);
  expect(narrow.viewport - narrow.right).toBe(16);
});
