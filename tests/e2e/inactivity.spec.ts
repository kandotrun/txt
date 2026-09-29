/** Web は放置時間だけでロックしない。実ブラウザー・仮想パスキーで検証する。 */
import { expect, test, type Page } from "@playwright/test";

import { installVirtualAuthenticator } from "./helpers/authenticator.ts";

// 実アカウントを使わず、ローカル Worker にテスト専用アカウントを作る。
async function openSheet(page: Page): Promise<void> {
  await installVirtualAuthenticator(page, { hasPrf: true });
  // 起動時に予約されるタイマーも対象にする。長い放置は待たずに再現する。
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "はじめて使う" }).click();
  await expect(page.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "コピーしました" }).click();
  await expect(page.locator("#editor-host .ProseMirror")).toBeVisible({ timeout: 30000 });
}

async function editAndSync(page: Page, text: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/document" &&
      response.request().method() === "PUT" &&
      response.status() === 200,
  );
  await page.locator("#editor-host .ProseMirror").fill(text);
  await saved;
  await expect(page.locator("#sync-status")).toHaveAttribute("data-state", "saved");
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  // ヘッドレスでもタブの非表示/復帰イベントを決定的に再現する。
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (value ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

for (const hidden of [false, true]) {
  test(`spec: ${hidden ? "バックグラウンド復帰" : "前面放置"}で5分・一晩経っても編集を続けられる`, async ({ page }) => {
    await openSheet(page);
    const before = "放置しても残る文章。";
    await editAndSync(page, before);
    const editor = page.locator("#editor-host .ProseMirror");
    const originalEditor = await editor.elementHandle();
    expect(originalEditor).not.toBeNull();

    // 本文だけでなくキャレットも保つ。フォーカスでタイマーをリセットしない。
    await editor.press("End");
    const selection = await page.evaluate(() => window.getSelection()?.anchorOffset);
    if (hidden) await setHidden(page, true);

    for (const elapsed of [6 * 60 * 1000, 12 * 60 * 60 * 1000]) {
      await page.clock.fastForward(elapsed);
      if (hidden) await setHidden(page, false);
      await expect(page.locator("#gate")).toBeHidden();
      await expect(editor).toHaveText(before);
      expect(await originalEditor!.evaluate((element) =>
        element === document.querySelector("#editor-host .ProseMirror"),
      )).toBe(true);
      expect(await page.evaluate(() => window.getSelection()?.anchorOffset)).toBe(selection);
      if (hidden) await setHidden(page, true);
    }
    if (hidden) await setHidden(page, false);

    // 再読み込みで回避せず、その場で保存まで通ることを確認する。
    const after = `${before}復帰後の追記。`;
    await editAndSync(page, after);
    await page.reload();
    await expect(editor).toHaveText(after, { timeout: 30000 });
  });
}

test("spec: オフラインの未同期入力も長時間放置で消えず、復帰後に保存できる", async ({ page, context }) => {
  await openSheet(page);
  await editAndSync(page, "同期済みの文章。");
  await context.setOffline(true);
  const editor = page.locator("#editor-host .ProseMirror");
  const unsaved = "オフライン中の未同期入力。";
  await editor.fill(unsaved);
  await expect(page.locator("#sync-status")).toHaveAttribute("data-state", /offline|local-only/);
  await setHidden(page, true);
  await page.clock.fastForward(12 * 60 * 60 * 1000);
  await setHidden(page, false);
  await expect(page.locator("#gate")).toBeHidden();
  await expect(editor).toHaveText(unsaved);

  // 未同期入力を失わず、その場で編集を続けて保存できることを確認する。
  await context.setOffline(false);
  const after = `${unsaved}接続復帰後の追記。`;
  await editAndSync(page, after);
  await page.reload();
  await expect(editor).toHaveText(after, { timeout: 30000 });
});

test("spec: 今すぐロックは時間経過や再読み込みで自動解除されない", async ({ page }) => {
  await openSheet(page);
  await editAndSync(page, "手動ロックで隠す文章。");
  await page.locator("#more-button").click();
  await page.getByRole("button", { name: "今すぐロック" }).click();
  await expect(page.locator("#app")).toBeHidden();
  await expect(page.getByRole("button", { name: "パスキーで開く" })).toBeVisible();
  await page.clock.fastForward(12 * 60 * 60 * 1000);
  await setHidden(page, true);
  await setHidden(page, false);
  await expect(page.locator("#app")).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: "パスキーで開く" })).toBeVisible();
  await expect(page.locator("#app")).toBeHidden();
});
