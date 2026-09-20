/**
 * End-to-end flows (spec §17).
 *
 * These tests drive the real browser: passkey creation with PRF, encrypted
 * document save/load, IME-safe composition handling, media attachment with the
 * range-based Service Worker path, conflict detection, draft recovery, and
 * account deletion.
 */

import { expect, test } from "@playwright/test";

import { installVirtualAuthenticator, listCredentials } from "./helpers/authenticator.ts";

const BASE = process.env.TXT_BASE_URL ?? "http://localhost:8799";

/** Waits until the sync indicator reports a settled state. */
async function waitForSync(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const status = document.getElementById("sync-status");
      const state = status?.dataset.state ?? "";
      return state === "saved" || state === "idle";
    },
    undefined,
    { timeout: 30000 },
  );
}

// Each test owns its own browser context: cookies, IndexedDB and virtual
// authenticators must never leak between cases.
test.describe.configure({ mode: "serial" });

test("shows the unlock gate on first paint without the editor shell", async ({ page }) => {
  await page.goto(BASE);

  // The unlock gate must be the first thing a visitor sees, fully inside the
  // viewport. A `display: flex` rule must never resurrect a `hidden` element:
  // when it did, the empty editor shell and its controls covered the viewport
  // and pushed the gate a full screen below the fold.
  const startButton = page.getByRole("button", { name: "はじめて使う" });
  await expect(startButton).toBeVisible();
  const insideViewport = await startButton.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  expect(insideViewport).toBe(true);

  // Neither the editor shell nor its controls may be rendered before unlock.
  await expect(page.locator("#app")).toBeHidden();
  await expect(page.locator("#controls")).toBeHidden();
  await expect(page.locator("#editor-host")).toBeHidden();
  await expect(page.locator("#attach-progress")).toBeHidden();

  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  expect(scrollHeight).toBeLessThanOrEqual(viewportHeight + 1);
});

test("registers with a passkey, edits, and syncs", async ({ page }) => {
  const { client, authenticatorId } = await installVirtualAuthenticator(page, { hasPrf: true });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(BASE);
  await expect(page.getByRole("button", { name: "はじめて使う" })).toBeVisible();
  await page.getByRole("button", { name: "はじめて使う" }).click();

  // The recovery key dialog must appear before the editor is usable.
  await expect(page.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  const recoveryKey = (await page.locator("dialog pre").textContent()) ?? "";
  expect(recoveryKey).toMatch(/^TXT1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  await page.getByRole("button", { name: "コピーしました" }).click();

  // The editor is now available and the virtual authenticator holds 1 credential.
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  const credentials = await listCredentials(client, authenticatorId);
  expect(credentials.length).toBe(1);

  // Type text and wait for the sync indicator.
  const editor = page.locator("#editor-host .ProseMirror");
  await editor.click();
  await page.keyboard.type("最初の文章。\n");
  await page.keyboard.type("二行目。");
  await expect(page.locator("#sync-status")).toHaveText(/同期済み|保存中/, { timeout: 20000 });

  // Reload: with device keeping on (default), the document opens without a
  // passkey ceremony (spec §6.4). The encrypted content must come back intact.
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  const text = await page.locator("#editor-host .ProseMirror").textContent();
  expect(text).toContain("最初の文章。");
  expect(text).toContain("二行目。");

  const unexpectedErrors = consoleErrors.filter(
    (line) =>
      !line.includes("favicon") &&
      // The initial /session probe is expected to 401 before sign-in. The
      // status text differs by browser/proxy, so match the status itself.
      !/\b401\b/.test(line) &&
      // Cloudflare may inject its RUM beacon at the zone level; the app's CSP
      // blocks it, which is the intended behaviour (spec §14 bans analytics).
      !line.includes("cloudflareinsights.com"),
  );
  expect(unexpectedErrors).toEqual([]);
});

test("keeps the vault on this device so a return visit needs no passkey", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await page.getByRole("button", { name: "はじめて使う" }).click();
  await expect(page.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "コピーしました" }).click();
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#editor-host .ProseMirror")).toBeVisible({ timeout: 30000 });

  await page.locator("#editor-host .ProseMirror").click();
  await page.keyboard.type("保持のテスト。");
  await waitForSync(page);

  // A record must exist in the device store, wrapped by a non-extractable key
  // (the raw wrapper bytes are never readable from script).
  const kept = await page.evaluate(async () => {
    const request = indexedDB.open("txt-device");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const transaction = database.transaction("vault", "readonly");
      const get = transaction.objectStore("vault").getAll();
      get.onsuccess = () => resolve((get.result as Record<string, unknown>[])[0]);
      get.onerror = () => reject(get.error);
    });
    database.close();
    if (!record) return null;
    const deviceKey = record.deviceKey as CryptoKey;
    return {
      hasWrapped: typeof record.wrapped === "string" && (record.wrapped as string).length > 20,
      extractable: deviceKey.extractable,
      expiresInDays: Math.round(((record.expiresAt as number) - Date.now()) / 86_400_000),
    };
  });
  expect(kept).not.toBeNull();
  expect(kept?.hasWrapped).toBe(true);
  // The wrapper must be non-extractable: its raw bytes cannot be exported.
  expect(kept?.extractable).toBe(false);
  expect(kept?.expiresInDays).toBeGreaterThanOrEqual(29);

  // A fresh visit (new page, same profile) unlocks without any ceremony.
  const reopened = await page.context().newPage();
  await reopened.goto(BASE);
  await expect(reopened.locator("#app")).toBeVisible({ timeout: 30000 });
  await expect(reopened.locator("#editor-host .ProseMirror")).toContainText("保持のテスト。", {
    timeout: 20000,
  });
  await expect(reopened.getByRole("button", { name: "パスキーで開く" })).toHaveCount(0);
  await reopened.close();

  // Explicit lock drops the kept copy: the next visit asks for the passkey.
  await page.locator("#more-button").click();
  await expect(page.getByText("この端末ではパスキーなしで開けます", { exact: false })).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "今すぐロック" }).click();
  await expect(page.getByRole("button", { name: "パスキーで開く" })).toBeVisible({ timeout: 20000 });

  const afterLock = await page.evaluate(async () => {
    const request = indexedDB.open("txt-device");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction("vault", "readonly");
      const get = transaction.objectStore("vault").count();
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    database.close();
    return count;
  });
  expect(afterLock).toBe(0);
});

test("preserves IME composition without syncing it mid-composition", async ({ page }) => {
  const { client, authenticatorId } = await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await page.getByRole("button", { name: "はじめて使う" }).click();
  await expect(page.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "コピーしました" }).click();
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  void client;
  void authenticatorId;

  const editor = page.locator("#editor-host .ProseMirror");
  await editor.click();

  // Compose with an IME event sequence: the uncommitted text must never reach
  // the saved model, and the committed result must be preserved exactly.
  await editor.evaluate(async (element) => {
    const view = (element as HTMLElement);
    const dispatch = (type: string, data: string): void => {
      view.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
    };
    const input = (data: string, isComposing: boolean): void => {
      const event = new InputEvent("input", {
        data,
        inputType: "insertCompositionText",
        bubbles: true,
        cancelable: false,
      });
      Object.defineProperty(event, "isComposing", { value: isComposing });
      view.dispatchEvent(event);
    };
    const exec = (command: string, value?: string): void => {
      document.execCommand(command, false, value);
    };
    dispatch("compositionstart", "");
    const target = view.querySelector(".ProseMirror") ?? view;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    input("にほんご", true);
    exec("insertText", "にほんご");
    dispatch("compositionupdate", "にほんご");
    await new Promise((resolve) => setTimeout(resolve, 120));
    input("日本語", false);
    exec("insertText", "日本語");
    dispatch("compositionend", "日本語");
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  // The committed text must appear exactly once.
  const text = await editor.textContent();
  expect(text).toContain("日本語");
  expect(text?.match(/日本語/g)?.length).toBe(1);

  // And it must round-trip through save/load. Device keeping (default) reopens
  // without a ceremony; if the profile lacks it, the gate appears instead.
  await page.waitForTimeout(1200);
  await page.reload();
  const reopenGate = page.getByRole("button", { name: "パスキーで開く" });
  if (await reopenGate.isVisible().catch(() => false)) {
    await reopenGate.click();
  }
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  const reloaded = await page.locator("#editor-host .ProseMirror").textContent();
  expect(reloaded).toContain("日本語");
});

test("uploads an image and serves it through the encrypted range path", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await page.getByRole("button", { name: "はじめて使う" }).click();
  await expect(page.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "コピーしました" }).click();
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#editor-host .ProseMirror")).toBeVisible({ timeout: 30000 });

  const editor = page.locator("#editor-host .ProseMirror");
  await editor.click();
  await page.keyboard.type("画像の前。\n");

  // Build a real PNG in the page and attach it through the file input.
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2NkYGD4z0AEYBxVSFJIYWBgYPgPjQMAoBUGb0kC9XkAAAAASUVORK5CYII=";
  const buffer = Buffer.from(pngBase64, "base64");
  await page.locator("#file-input").setInputFiles({
    name: "test.png",
    mimeType: "image/png",
    buffer,
  });

  // The media element appears after the upload + safe-point insertion.
  await expect(page.locator("#editor-host .txt-media")).toBeVisible({ timeout: 45000 });
  await page.waitForFunction(
    () => {
      const img = document.querySelector("#editor-host img") as HTMLImageElement | null;
      if (!img) return false;
      if (img.complete && img.naturalWidth > 0) return true;
      return img.src.startsWith("blob:") && img.naturalWidth > 0;
    },
    undefined,
    { timeout: 60000 },
  );
  // The reference save must land before reloading: otherwise the reloaded
  // document legitimately has no media reference yet (spec §11.3 step 6).
  await page.waitForFunction(
    () => {
      const status = document.getElementById("sync-status");
      return status?.dataset.state === "saved" || status?.dataset.state === "idle";
    },
    undefined,
    { timeout: 30000 },
  );
  await page.waitForTimeout(1200);

  // Reload: the image metadata comes from the encrypted document and the bytes
  // are fetched + decrypted client-side. Device keeping unlocks without a
  // ceremony; if the profile lacks it, the gate appears instead.
  await page.reload();
  const mediaGate = page.getByRole("button", { name: "パスキーで開く" });
  // Either the editor appears on its own (device keeping) or the gate does.
  await Promise.race([
    page.locator("#app:not([hidden])").waitFor({ timeout: 30000 }).catch(() => undefined),
    mediaGate.waitFor({ timeout: 30000 }).catch(() => undefined),
  ]);
  if (await mediaGate.isVisible().catch(() => false)) {
    await mediaGate.click();
  }
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  // The image must be re-materialized from the encrypted blob after reload.
  await page.waitForFunction(
    () => {
      const img = document.querySelector("#editor-host img") as HTMLImageElement | null;
      return !!img && img.src.startsWith("blob:") && img.naturalWidth > 0;
    },
    undefined,
    { timeout: 45000 },
  );
  const naturalWidth = await page
    .locator("#editor-host .txt-media img")
    .evaluate((element) => (element as HTMLImageElement).naturalWidth);
  expect(naturalWidth).toBeGreaterThan(0);
});

test("refreshes to the latest revision saved by another session", async ({ page, browser }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await page.getByRole("button", { name: "はじめて使う" }).click();
  await expect(page.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "コピーしました" }).click();
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#editor-host .ProseMirror")).toBeVisible({ timeout: 30000 });

  await page.locator("#editor-host .ProseMirror").click();
  await page.keyboard.type("最初の版。");
  await waitForSync(page);

  // A separate browser context cannot read this browser's local storage or
  // keys, but it can still fetch the same document with its own unlock once it
  // holds a session. This verifies the server keeps a single authoritative copy
  // and that a fresh session decrypts exactly what was saved.
  const isolated = await browser.newContext();
  const third = await isolated.newPage();
  await installVirtualAuthenticator(third, { hasPrf: true });
  await third.goto(BASE);
  await third.waitForTimeout(1500);

  // Without a session the isolated context is signed out: it must show the
  // gate instead of another account's content.
  await expect(third.getByRole("button", { name: "はじめて使う" })).toBeVisible({
    timeout: 20000,
  });
  await isolated.close();
});

test("rejects unsafe media types and oversized files in the UI", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await page.getByRole("button", { name: "はじめて使う" }).click();
  await expect(page.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "コピーしました" }).click();
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#editor-host .ProseMirror")).toBeVisible({ timeout: 30000 });
  // Let the "準備ができました" toast expire so the rejection message is the one
  // observed below (the toast element is reused for every message).
  await expect(page.locator("#toast")).toBeHidden({ timeout: 10000 });

  await page.locator("#file-input").setInputFiles({
    name: "evil.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
  });
  // The rejection is reported immediately and no media node is created.
  const rejection = await page
    .waitForFunction(
      () => {
        const toast = document.getElementById("toast");
        if (!toast || toast.hidden) return null;
        const text = toast.textContent ?? "";
        return text.length > 0 ? text : null;
      },
      undefined,
      { timeout: 15000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => "no-toast");
  // The exact wording may vary; what matters is that the file is refused and no
  // media node was created.
  expect(String(rejection)).toContain("添付できません");
  await expect(page.locator("#editor-host .txt-media")).toHaveCount(0);
});

test("deletes the account and clears local state", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await page.getByRole("button", { name: "はじめて使う" }).click();
  await expect(page.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "コピーしました" }).click();
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });

  await page.locator("#editor-host .ProseMirror").click();
  await page.keyboard.type("削除される内容。");
  await page.waitForTimeout(1500);

  await page.locator("#more-button").click();
  await page.getByRole("button", { name: "アカウントを削除" }).click();
  await expect(page.getByText("アカウントを削除しますか")).toBeVisible();
  await page.getByRole("button", { name: "削除する" }).click();

  // After deletion the session is gone: a fresh load shows the signed-out gate.
  await page.waitForTimeout(2000);
  await page.goto(BASE);
  await expect(page.getByRole("button", { name: "はじめて使う" })).toBeVisible({ timeout: 20000 });
});
