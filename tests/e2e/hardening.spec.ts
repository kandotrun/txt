/**
 * Hardening flows in a real browser (spec §5.4, §7.2, §14).
 *
 * - Recovery end to end: the recovery key alone opens the sheet on a device
 *   that has no passkey, registers a new passkey against a server challenge,
 *   and rotates the key.
 * - Adding a passkey goes through step-up.
 * - The CSP with Trusted Types is enforced, and the app runs under it without
 *   a single violation (crypto worker, Service Worker, editor paste).
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installVirtualAuthenticator, listCredentials } from "./helpers/authenticator.ts";
import { registerViaOnboarding } from "./helpers/onboarding.ts";

const BASE = process.env.TXT_BASE_URL ?? "http://localhost:8799";

async function waitForSync(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const state = document.getElementById("sync-status")?.dataset.state ?? "";
      return state === "saved" || state === "idle";
    },
    undefined,
    { timeout: 30000 },
  );
}

/** Opens the recovery form on the gate and submits a key. */
async function submitRecoveryKey(page: Page, recoveryKey: string): Promise<void> {
  await page.goto(BASE);
  await page.locator("#gate-details summary").click();
  await page.locator("#recovery-input").fill(recoveryKey);
  await page.locator("#recovery-submit").click();
}

test("spec: 復旧キーだけで別の端末から開き、新しいパスキーと復旧キーへ切り替わる", async ({ page, browser }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  const recoveryKey = await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  await page.locator("#editor-host .ProseMirror").click();
  await page.keyboard.type("復旧で読めるはずの本文。");
  await waitForSync(page);
  await page.waitForTimeout(1200);
  await waitForSync(page);

  // A different device: no cookies, no kept key, an authenticator that has
  // never seen this account.
  const otherContext = await browser.newContext({ locale: "ja-JP" });
  const other = await otherContext.newPage();
  const { client, authenticatorId } = await installVirtualAuthenticator(other, { hasPrf: true });
  await submitRecoveryKey(other, recoveryKey);

  // The replacement key is shown before the sheet opens.
  await expect(other.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  // Nothing is committed until the new key is confirmed: the first device's
  // session (and with it the old passkey and recovery key) is still valid.
  expect(await page.evaluate(async () => (await fetch("/api/v1/session", { credentials: "same-origin" })).status)).toBe(200);
  const newKey = ((await other.locator("dialog pre").textContent()) ?? "").trim();
  expect(newKey).toMatch(/^TXT1\./);
  expect(newKey).not.toBe(recoveryKey);
  await other.getByRole("button", { name: "保存しました" }).click();

  await expect(other.locator("#app")).toBeVisible({ timeout: 30000 });
  await expect(other.locator("#editor-host .ProseMirror")).toContainText("復旧で読めるはずの本文。");
  expect(await listCredentials(client, authenticatorId)).toHaveLength(1);

  // Nothing secret is left behind in the dialog or the recovery field.
  expect(await other.locator("#dialog-body").textContent()).toBe("");
  expect(await other.locator("#recovery-input").inputValue()).toBe("");

  // The promoted session is a normal one: the sheet can be edited and saved.
  await other.locator("#editor-host .ProseMirror").click();
  await other.keyboard.press("End");
  await other.keyboard.type("復旧後の追記。");
  await waitForSync(other);
  const session = await other.evaluate(async () => {
    const response = await fetch("/api/v1/session", { credentials: "same-origin" });
    return (await response.json()) as { scope: string; expiresAt: number };
  });
  expect(session.scope).toBe("active");
  expect(session.expiresAt - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000);

  // The first device's session and passkey were revoked by the recovery.
  const stale = await page.evaluate(async () => (await fetch("/api/v1/session", { credentials: "same-origin" })).status);
  expect(stale).toBe(401);

  // The spent recovery key no longer opens anything.
  const thirdContext = await browser.newContext({ locale: "ja-JP" });
  const third = await thirdContext.newPage();
  await installVirtualAuthenticator(third, { hasPrf: true });
  await submitRecoveryKey(third, recoveryKey);
  await expect(third.locator("#gate-footnote")).toHaveAttribute("data-state", "error", { timeout: 30000 });
  await expect(third.locator("#app")).toBeHidden();

  await thirdContext.close();
  await otherContext.close();
});

test("spec: パスキーの追加は再認証を経て完了する", async ({ page }) => {
  const first = await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });

  // The new passkey lives on another authenticator: the first one (rightly)
  // refuses to register twice for the same account. The swap happens after
  // the step-up assertion, which only the first authenticator can answer.
  let secondId = "";
  await page.route("**/api/v1/credentials/options", async (route) => {
    await first.client.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: first.authenticatorId });
    ({ authenticatorId: secondId } = await first.client.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
      },
    }));
    await route.continue();
  });

  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && /\/(stepup|credentials)\//.test(url.pathname)) requests.push(url.pathname);
  });
  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().includes("/api/")) {
      failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  await page.locator("#more-button").click();
  await page.getByRole("button", { name: "パスキーを追加" }).click();
  await expect(page.locator("#toast")).toHaveText(/.+/, { timeout: 30000 });
  expect({ toast: await page.locator("#toast").textContent(), failures }).toEqual({
    toast: "パスキーを追加しました。", failures: [],
  });

  expect(requests).toEqual([
    "/api/v1/auth/stepup/options",
    "/api/v1/auth/stepup/verify",
    "/api/v1/credentials/options",
    "/api/v1/credentials/verify",
    "/api/v1/credentials/activate",
  ]);
  expect(await listCredentials(first.client, secondId)).toHaveLength(1);
});

test("spec: CSPとTrusted Typesが有効なまま、違反なしで登録・編集・貼り付け・添付ができる", async ({ page }) => {
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { __violations: string[] }).__violations = violations;
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.effectiveDirective} ${event.blockedURI} ${event.sample}`);
    });
  });
  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|TrustedHTML|TrustedScript|Permissions-Policy|Unrecognized feature/i.test(text)) {
      consoleProblems.push(text);
    }
  });

  await installVirtualAuthenticator(page, { hasPrf: true });
  const response = await page.goto(BASE);
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).toContain("trusted-types txt ProseMirrorClipboard");

  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });

  // Typing, an HTML paste (the editor's clipboard parser), and an attachment
  // through the crypto worker and the Service Worker.
  const editor = page.locator("#editor-host .ProseMirror");
  await editor.click();
  await page.keyboard.type("貼り付け前。");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/html", "<p>貼り付けた<b>HTML</b></p><img src=\"/icon.svg\">");
    data.setData("text/plain", "貼り付けたHTML");
    document.querySelector("#editor-host .ProseMirror")!
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor).toContainText("貼り付けたHTML");
  expect(await editor.locator("b, img:not(.txt-media img)").count()).toBe(0);

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2NkYGD4z0AEYBxVSFJIYWBgYPgPjQMAoBUGb0kC9XkAAAAASUVORK5CYII=",
    "base64",
  );
  await page.locator("#file-input").setInputFiles({ name: "t.png", mimeType: "image/png", buffer: png });
  await expect(page.locator("#editor-host .txt-media")).toBeVisible({ timeout: 45000 });
  await page.waitForFunction(() => {
    const img = document.querySelector("#editor-host img") as HTMLImageElement | null;
    return !!img && img.naturalWidth > 0;
  }, undefined, { timeout: 60000 });
  await waitForSync(page);
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  // Everything the app itself does runs without a single policy violation.
  const violations = () => page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
  expect(await violations()).toEqual([]);
  expect(consoleProblems).toEqual([]);

  // Trusted Types is enforced, not merely declared: a DOM-injection sink
  // refuses a plain string, and a foreign script URL cannot be vetted.
  const sinks = await page.evaluate(() => {
    const attempt = (run: () => void): string => {
      try { run(); return "allowed"; } catch (error) { return (error as Error).name; }
    };
    const probe = document.createElement("div");
    return {
      innerHTML: attempt(() => { probe.innerHTML = "<img src=x>"; }),
      worker: attempt(() => { new Worker("https://evil.example/w.js"); }),
      policy: attempt(() => {
        (window as unknown as { trustedTypes: { createPolicy(name: string, rules: object): unknown } })
          .trustedTypes.createPolicy("attacker", { createHTML: (value: string) => value });
      }),
    };
  });
  expect(sinks).toEqual({ innerHTML: "TypeError", worker: "TypeError", policy: "TypeError" });

  // A hostile paste goes through the same parser: its markup never reaches
  // the document and its inline handler is refused by the policy.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/html", "<p>攻撃<img src=x onerror=\"window.__pwned=1\"></p><script>window.__pwned=2</script>");
    data.setData("text/plain", "攻撃");
    document.querySelector("#editor-host .ProseMirror")!
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor).toContainText("攻撃");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await editor.locator("script, [onerror]").count()).toBe(0);
  const blocked = await violations();
  expect(blocked.some((entry) => entry.includes("Element innerHTML"))).toBe(true);
  expect(blocked.some((entry) => entry.includes("Worker constructor"))).toBe(true);
  expect(blocked.some((entry) => entry.includes("trusted-types-policy attacker"))).toBe(true);
});

test("spec: 連続入力中の端末退避はキー入力ごとではなくまとめて行い、最後の入力まで退避する", async ({ page }) => {
  await page.addInitScript(() => {
    const counter = { puts: 0 };
    (window as unknown as { __draftWrites: typeof counter }).__draftWrites = counter;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === "drafts") counter.puts += 1;
      return put.apply(this, args);
    };
  });
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  await waitForSync(page);

  // Offline, so the draft is the only place the text can go and is not
  // cleared by a successful save while we count.
  await page.context().setOffline(true);
  const before = await page.evaluate(() => (window as unknown as { __draftWrites: { puts: number } }).__draftWrites.puts);
  await page.locator("#editor-host .ProseMirror").click();
  const text = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";
  await page.keyboard.type(text, { delay: 20 });
  await page.waitForTimeout(600);
  const writes = (await page.evaluate(() => (window as unknown as { __draftWrites: { puts: number } }).__draftWrites.puts)) - before;
  expect(writes).toBeGreaterThanOrEqual(1);
  expect(writes).toBeLessThan(text.length / 3);

  // The coalesced draft is complete: after a reload (saves still failing) the
  // whole text is offered back and restored.
  await page.route("**/api/v1/document", (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
  await page.context().setOffline(false);
  await page.reload();
  await expect(page.getByText("未同期の入力が残っています")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "採用する" }).click();
  await expect(page.locator("#editor-host .ProseMirror")).toContainText(text);
});

test("spec: 新しい復旧キーの保存を確認しなければ復旧は確定せず、元の復旧キーが使える", async ({ page, browser }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  const recoveryKey = await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });

  const otherContext = await browser.newContext({ locale: "ja-JP" });
  const other = await otherContext.newPage();
  await installVirtualAuthenticator(other, { hasPrf: true });
  await submitRecoveryKey(other, recoveryKey);
  await expect(other.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  await other.getByRole("button", { name: "あとで" }).click();
  await expect(other.locator("#gate-footnote")).toContainText("復旧を完了していません", { timeout: 30000 });
  await expect(other.locator("#app")).toBeHidden();
  await otherContext.close();

  // The first device is untouched, and the same key still recovers.
  expect(await page.evaluate(async () => (await fetch("/api/v1/session", { credentials: "same-origin" })).status)).toBe(200);
  const again = await browser.newContext({ locale: "ja-JP" });
  const retry = await again.newPage();
  await installVirtualAuthenticator(retry, { hasPrf: true });
  await submitRecoveryKey(retry, recoveryKey);
  await expect(retry.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  await retry.getByRole("button", { name: "保存しました" }).click();
  await expect(retry.locator("#app")).toBeVisible({ timeout: 30000 });
  await again.close();
});

test("spec: パスキーとセッションを一覧し、別のセッションを終了できる", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  const sessionCount = () => page.evaluate(async () => {
    const response = await fetch("/api/v1/sessions", { credentials: "same-origin" });
    return ((await response.json()) as { sessions: unknown[] }).sessions.length;
  });

  await page.locator("#more-button").click();
  await page.getByRole("button", { name: "パスキーとセッション" }).click();
  const dialog = page.locator("dialog");
  await expect(dialog).toContainText("パスキー1");
  await expect(dialog).toContainText("このブラウザー");
  // One passkey: nothing may be revoked, so no revoke action is offered.
  await expect(dialog.getByRole("button", { name: /^失効:/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /^終了:/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "閉じる" }).click();

  // Losing the cookie (another browser, cleared data) and signing in again
  // leaves the earlier session alive on the server: it must be listed and
  // endable from here.
  await page.context().clearCookies();
  await page.reload();
  await page.getByRole("button", { name: "パスキーで開く" }).click();
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  expect(await sessionCount()).toBe(2);

  await page.locator("#more-button").click();
  await page.getByRole("button", { name: "パスキーとセッション" }).click();
  await expect(dialog).toContainText("別のセッション");
  await dialog.getByRole("button", { name: /^終了: 別のセッション/ }).click();
  await expect(page.locator("#toast")).toHaveText("セッションを終了しました。", { timeout: 15000 });
  expect(await sessionCount()).toBe(1);
});

test("spec: 2本目のパスキーは再認証を経て失効でき、最後の1本は残る", async ({ page }) => {
  const first = await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });

  // Add a second passkey on another authenticator, then bring the first back
  // so the step-up for the revocation can be answered.
  let secondId = "";
  await page.route("**/api/v1/credentials/options", async (route) => {
    ({ authenticatorId: secondId } = await first.client.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
      },
    }));
    await first.client.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: first.authenticatorId, enabled: false });
    await route.continue();
  });
  await page.locator("#more-button").click();
  await page.getByRole("button", { name: "パスキーを追加" }).click();
  await expect(page.locator("#toast")).toHaveText("パスキーを追加しました。", { timeout: 30000 });
  await page.unroute("**/api/v1/credentials/options");
  await first.client.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: first.authenticatorId, enabled: true });
  await first.client.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: secondId, enabled: false });

  const activePasskeys = () => page.evaluate(async () => {
    const response = await fetch("/api/v1/credentials", { credentials: "same-origin" });
    const body = (await response.json()) as { credentials: Array<{ status: string }> };
    return body.credentials.filter((entry) => entry.status === "active").length;
  });
  expect(await activePasskeys()).toBe(2);

  await page.locator("#more-button").click();
  await page.getByRole("button", { name: "パスキーとセッション" }).click();
  const dialog = page.locator("dialog");
  await expect(dialog.getByRole("button", { name: /^失効:/ })).toHaveCount(2);
  await dialog.getByRole("button", { name: /^失効: パスキー2/ }).click();
  await dialog.getByRole("button", { name: "失効する" }).click();
  await expect(page.locator("#toast")).toHaveText("パスキーを失効しました。", { timeout: 30000 });
  expect(await activePasskeys()).toBe(1);

  // With one passkey left the screen offers no revocation at all.
  await page.locator("#more-button").click();
  await page.getByRole("button", { name: "パスキーとセッション" }).click();
  await expect(dialog.getByRole("button", { name: /^失効:/ })).toHaveCount(0);
});

/** A silent 20-second PCM WAV: real, seekable audio the browser can load. */
function silentWav(seconds = 20): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28); // byte rate (8-bit mono)
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 0x80)]);
}

test("spec: 他のタブの保存を取り込んでも、変わっていないメディアは読み込み直されず再生位置を保つ", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  const editor = page.locator("#editor-host .ProseMirror");
  await editor.click();
  await page.keyboard.type("音声の前。");
  await page.locator("#file-input").setInputFiles({ name: "t.wav", mimeType: "audio/wav", buffer: silentWav() });
  await expect(page.locator("#editor-host audio")).toBeAttached({ timeout: 45000 });
  await waitForSync(page);
  await page.waitForTimeout(1200);
  await waitForSync(page);

  // Load the stream through the Service Worker, seek into it, and watch for
  // anything that would reset the element from here on.
  await page.waitForFunction(() => (document.querySelector("#editor-host audio") as HTMLAudioElement | null)?.getAttribute("src"), undefined, { timeout: 30000 });
  await page.evaluate(async () => {
    const audio = document.querySelector("#editor-host audio") as HTMLAudioElement & { __resets?: number; __kept?: boolean };
    audio.preload = "auto";
    audio.load();
    await new Promise<void>((resolve, reject) => {
      audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
      audio.addEventListener("error", () => reject(new Error("audio failed to load")), { once: true });
    });
    audio.currentTime = 7;
    await new Promise<void>((resolve) => audio.addEventListener("seeked", () => resolve(), { once: true }));
    audio.__kept = true;
    audio.__resets = 0;
    for (const type of ["emptied", "loadstart", "abort"]) audio.addEventListener(type, () => { audio.__resets = (audio.__resets ?? 0) + 1; });
  });

  // A second tab of the same browser edits the text and saves.
  const second = await page.context().newPage();
  await second.goto(BASE);
  await expect(second.locator("#app")).toBeVisible({ timeout: 30000 });
  await expect(second.locator("#editor-host .ProseMirror")).toContainText("音声の前。");
  await second.locator("#editor-host .ProseMirror p").first().click();
  await second.keyboard.press("Home");
  await second.keyboard.type("別タブの追記。");
  await waitForSync(second);

  await expect(editor).toContainText("別タブの追記。", { timeout: 30000 });
  await page.waitForTimeout(800); // the Service Worker acknowledgement that follows an apply
  const state = await page.evaluate(() => {
    const audio = document.querySelector("#editor-host audio") as (HTMLAudioElement & { __resets?: number; __kept?: boolean }) | null;
    return {
      sameElement: audio?.__kept === true,
      resets: audio?.__resets,
      position: Math.round(audio?.currentTime ?? -1),
      hasSource: Boolean(audio?.getAttribute("src")),
    };
  });
  expect(state).toEqual({ sameElement: true, resets: 0, position: 7, hasSource: true });
  await second.close();
});

test("spec: 画面外の画像は表示が近づくまで取得・復号しない", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  const editor = page.locator("#editor-host .ProseMirror");
  await editor.click();
  // Several screens of text, then the image at the very end.
  await page.keyboard.insertText(Array.from({ length: 400 }, (_, index) => `行${index}`).join("\n"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2NkYGD4z0AEYBxVSFJIYWBgYPgPjQMAoBUGb0kC9XkAAAAASUVORK5CYII=",
    "base64",
  );
  await page.locator("#file-input").setInputFiles({ name: "t.png", mimeType: "image/png", buffer: png });
  await expect(page.locator("#editor-host .txt-media")).toBeAttached({ timeout: 45000 });
  await waitForSync(page);
  await page.waitForTimeout(1500);
  await waitForSync(page);

  let cipherFetches = 0;
  page.on("request", (request) => { if (/\/media\/[^/]+\/cipher/.test(request.url())) cipherFetches += 1; });
  await page.reload();
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#editor-host .ProseMirror")).toContainText("行399");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500);
  expect(cipherFetches).toBe(0);

  await page.locator("#editor-host .txt-media").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const img = document.querySelector("#editor-host img") as HTMLImageElement | null;
    return !!img && img.naturalWidth > 0;
  }, undefined, { timeout: 60000 });
  expect(cipherFetches).toBeGreaterThan(0);
});

test("spec: 貼り付け・ドロップされたHTMLでメディア要素を偽装できず、文書は保存できるまま", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  const editor = page.locator("#editor-host .ProseMirror");
  await editor.click();
  await page.keyboard.type("本文。");
  await waitForSync(page);

  // Markup shaped like this app's own media block, naming media that does not
  // exist. Accepting it would put an unknown reference into the document and
  // every later save would be refused.
  const forged =
    '<div class="txt-media" data-media-id="66666666-6666-4666-8666-666666666666" data-media-kind="video"></div><p>偽装の後。</p>';
  await page.evaluate((html) => {
    const target = document.querySelector("#editor-host .ProseMirror")!;
    const pasted = new DataTransfer();
    pasted.setData("text/html", html); // no text/plain: the HTML parser is the only path
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: pasted, bubbles: true, cancelable: true }));

    const dropped = new DataTransfer();
    dropped.setData("text/html", html);
    dropped.setData("text/plain", "ドロップ文。");
    const box = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent("drop", {
      dataTransfer: dropped, bubbles: true, cancelable: true,
      clientX: box.left + 20, clientY: box.top + 10,
    }));
  }, forged);

  await page.waitForTimeout(300);
  expect(await editor.locator(".txt-media, [data-media-id]").count()).toBe(0);
  expect(pageErrors).toEqual([]);

  // The sheet is still a valid document: a further edit saves.
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type("続き。");
  await waitForSync(page);
  await expect(page.locator("#sync-status")).not.toHaveAttribute("data-state", "local-only");
  const saved = await page.evaluate(async () => {
    const response = await fetch("/api/v1/document", { credentials: "same-origin" });
    return ((await response.json()) as { revision: number }).revision;
  });
  expect(saved).toBeGreaterThanOrEqual(2);
});

test("spec: サーバーが以前より古い版を返しても黙って適用せず、明示的に選んだときだけ開く", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  const editor = page.locator("#editor-host .ProseMirror");
  await editor.click();
  await page.keyboard.type("第一版。");
  await waitForSync(page);
  await page.waitForTimeout(1200);
  await waitForSync(page);

  // An authentic, correctly encrypted, but older copy of the sheet.
  const older = await page.evaluate(async () => {
    const response = await fetch("/api/v1/document", { credentials: "same-origin", cache: "no-store" });
    return { etag: response.headers.get("etag") ?? "", body: await response.text() };
  });
  expect((JSON.parse(older.body) as { revision: number }).revision).toBeGreaterThanOrEqual(1);

  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type("第二版の追記。");
  await waitForSync(page);
  await page.waitForTimeout(1200);
  await waitForSync(page);

  // From here on the "server" answers every read with the older copy.
  await page.route("**/api/v1/document", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", etag: older.etag, "cache-control": "private, no-store" },
      body: older.body,
    });
  });

  // While the page is open: the poll must not replace what is on screen.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#sync-status")).toContainText("以前の版に戻されています", { timeout: 30000 });
  await expect(editor).toContainText("第二版の追記。");

  // On reload: the gate explains instead of opening the older copy.
  await page.reload();
  await expect(page.getByText("以前より古い内容です")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#app")).toBeHidden();

  // Only an explicit choice opens it. The newer text that was on screen when
  // the rollback was refused was kept on this device and is offered back.
  await page.getByRole("button", { name: "この古い版を開く" }).click();
  await expect(page.getByText("未同期の入力が残っています")).toBeVisible({ timeout: 30000 });
  // The dialog cannot be dismissed into losing the draft.
  await page.keyboard.press("Escape");
  await expect(page.getByText("未同期の入力が残っています")).toBeVisible();

  // The server is honest again; restoring the kept text converges with it.
  await page.unroute("**/api/v1/document");
  await page.getByRole("button", { name: "採用する" }).click();
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#editor-host .ProseMirror")).toContainText("第二版の追記。");
  await waitForSync(page);
});

test("spec: 遠隔版の適用後もキャレットは本文に残り、Undoで他のタブの保存を巻き戻せない", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  const editor = page.locator("#editor-host .ProseMirror");
  await editor.click();
  await page.keyboard.type("hello");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2NkYGD4z0AEYBxVSFJIYWBgYPgPjQMAoBUGb0kC9XkAAAAASUVORK5CYII=",
    "base64",
  );
  await page.locator("#file-input").setInputFiles({ name: "t.png", mimeType: "image/png", buffer: png });
  await expect(page.locator("#editor-host .txt-media")).toBeVisible({ timeout: 45000 });
  await waitForSync(page);
  await page.waitForTimeout(1200);
  await waitForSync(page);

  // Caret at the end of the paragraph before the image.
  await editor.locator("p").first().click();
  await page.keyboard.press("End");

  // Another tab extends that same paragraph and saves.
  const second = await page.context().newPage();
  await second.goto(BASE);
  await expect(second.locator("#app")).toBeVisible({ timeout: 30000 });
  await second.locator("#editor-host .ProseMirror p").first().click();
  await second.keyboard.press("Home");
  await second.keyboard.type("B:");
  await waitForSync(second);
  await expect(editor.locator("p").first()).toHaveText("B:hello", { timeout: 30000 });
  await second.close();

  // Typing without clicking: the character lands in that paragraph, and the
  // image is neither selected nor replaced.
  await page.bringToFront();
  await page.keyboard.type("X");
  await expect(editor.locator("p").first()).toContainText("X");
  await expect(editor.locator(".txt-media")).toHaveCount(1);
  const firstParagraph = (await editor.locator("p").first().textContent()) ?? "";
  expect(firstParagraph.startsWith("B:hel")).toBe(true);

  // Undo takes back this tab's own typing only. Before the history was cut at
  // the remote apply, one more Undo reverted the image insertion and, with
  // it, the whole document — including the other tab's saved text.
  for (let step = 0; step < 4; step += 1) await page.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator("p").first()).toHaveText("B:hello");
  await expect(editor.locator(".txt-media")).toHaveCount(1);
});

test("spec: 新しい復旧キーの保存中に手続きの期限が切れても、保存したその復旧キーで復旧が確定する", async ({ page, browser }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  const recoveryKey = await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });

  const otherContext = await browser.newContext({ locale: "ja-JP" });
  const other = await otherContext.newPage();
  await installVirtualAuthenticator(other, { hasPrf: true });
  // The first completion is answered as the server answers a ceremony that
  // lapsed while the user was writing the key down.
  let completions = 0;
  await other.route("**/api/v1/recovery/complete", async (route) => {
    completions += 1;
    if (completions === 1) {
      await route.fulfill({
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: { code: "CHALLENGE_EXPIRED", message: "challenge expired" } }),
      });
      return;
    }
    await route.continue();
  });
  await submitRecoveryKey(other, recoveryKey);
  await expect(other.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  const savedKey = ((await other.locator("dialog pre").textContent()) ?? "").trim();
  await other.getByRole("button", { name: "保存しました" }).click();
  await expect(other.locator("#app")).toBeVisible({ timeout: 30000 });
  expect(completions).toBe(2);
  await otherContext.close();

  // The key the user saved is the one in force: it starts a recovery.
  const third = await browser.newContext({ locale: "ja-JP" });
  const check = await third.newPage();
  await installVirtualAuthenticator(check, { hasPrf: true });
  await submitRecoveryKey(check, savedKey);
  await expect(check.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  await third.close();
});

test("spec: Service Workerが再起動して鍵を失っても、再読み込みなしでメディアを再び読める", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  await page.locator("#editor-host .ProseMirror").click();
  await page.locator("#file-input").setInputFiles({ name: "t.wav", mimeType: "audio/wav", buffer: silentWav() });
  await expect(page.locator("#editor-host audio")).toBeAttached({ timeout: 45000 });
  await waitForSync(page);
  await page.waitForTimeout(1200);
  await waitForSync(page);
  await page.waitForFunction(() => (document.querySelector("#editor-host audio") as HTMLAudioElement | null)?.getAttribute("src"), undefined, { timeout: 30000 });

  // Stop the worker as a browser does when it has been idle: the next request
  // starts a fresh instance that remembers nothing.
  const client = await page.context().newCDPSession(page);
  await client.send("ServiceWorker.enable");
  await client.send("ServiceWorker.stopAllWorkers");
  await page.waitForTimeout(500);

  const loaded = await page.evaluate(async () => {
    const attempt = (): Promise<boolean> => new Promise((resolve) => {
      const audio = document.querySelector("#editor-host audio") as HTMLAudioElement;
      const done = (ok: boolean): void => {
        audio.removeEventListener("loadedmetadata", onLoaded);
        audio.removeEventListener("error", onError);
        resolve(ok);
      };
      const onLoaded = (): void => done(true);
      const onError = (): void => done(false);
      audio.addEventListener("loadedmetadata", onLoaded);
      audio.addEventListener("error", onError);
      audio.preload = "auto";
      audio.load();
      window.setTimeout(() => done(audio.readyState >= 1), 4000);
    });
    // The first load meets the restarted worker (423); the page answers its
    // request for a handshake and assigns the stream again, with no reload.
    for (let round = 0; round < 6; round += 1) {
      if (await attempt()) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    return false;
  });
  expect(loaded).toBe(true);
});

test("spec: Service Worker再起動後の最初の操作が添付の追加でも、メディアが再び読める", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  await page.locator("#editor-host .ProseMirror").click();
  await page.locator("#file-input").setInputFiles({ name: "a.wav", mimeType: "audio/wav", buffer: silentWav() });
  await expect(page.locator("#editor-host audio")).toHaveCount(1, { timeout: 45000 });
  await waitForSync(page);
  await page.waitForTimeout(1200);
  await waitForSync(page);

  const client = await page.context().newCDPSession(page);
  await client.send("ServiceWorker.enable");
  await client.send("ServiceWorker.stopAllWorkers");
  await page.waitForTimeout(500);

  // The first thing the restarted worker hears from the page is a media
  // update (a second attachment), not a media request.
  await page.locator("#file-input").setInputFiles({ name: "b.wav", mimeType: "audio/wav", buffer: silentWav(10) });
  await expect(page.locator("#editor-host audio")).toHaveCount(2, { timeout: 45000 });
  await waitForSync(page);
  await page.waitForTimeout(1500);
  await waitForSync(page);

  // Both players have a source again and the first one loads, with no reload.
  await page.waitForFunction(
    () => [...document.querySelectorAll("#editor-host audio")].every((node) => node.getAttribute("src")),
    undefined,
    { timeout: 30000 },
  );
  const loaded = await page.evaluate(async () => {
    const audio = document.querySelector("#editor-host audio") as HTMLAudioElement;
    for (let round = 0; round < 6; round += 1) {
      const ok = await new Promise<boolean>((resolve) => {
        const finish = (value: boolean): void => {
          audio.removeEventListener("loadedmetadata", onLoaded);
          audio.removeEventListener("error", onError);
          resolve(value);
        };
        const onLoaded = (): void => finish(true);
        const onError = (): void => finish(false);
        audio.addEventListener("loadedmetadata", onLoaded);
        audio.addEventListener("error", onError);
        audio.preload = "auto";
        audio.load();
        window.setTimeout(() => finish(audio.readyState >= 1), 4000);
      });
      if (ok) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    return false;
  });
  expect(loaded).toBe(true);
});

test("spec: 競合の問いは後から要求された別のダイアログに置き換えられず、答えたあと保存が続く", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  const editor = page.locator("#editor-host .ProseMirror");
  await editor.click();
  await page.keyboard.type("A1");
  await waitForSync(page);

  // This tab stops hearing about newer copies (its conditional reads fail on
  // the network), so its next save meets the other tab's copy as a conflict.
  await page.route("**/api/v1/document", (route) => {
    const request = route.request();
    if (request.method() === "GET" && request.headers()["if-none-match"]) return route.abort();
    return route.continue();
  });
  const second = await page.context().newPage();
  await second.goto(BASE);
  await expect(second.locator("#app")).toBeVisible({ timeout: 30000 });
  await second.locator("#editor-host .ProseMirror p").first().click();
  await second.keyboard.press("Home");
  await second.keyboard.type("B:");
  await waitForSync(second);
  await second.close();
  await page.bringToFront();

  // The passkeys-and-sessions screen is requested, but its lists are slow.
  let releaseLists!: () => void;
  const listsReleased = new Promise<void>((resolve) => { releaseLists = resolve; });
  const holdList = async (route: import("@playwright/test").Route): Promise<void> => {
    if (route.request().method() === "GET") await listsReleased;
    await route.continue();
  };
  await page.route("**/api/v1/credentials", holdList);
  await page.route("**/api/v1/sessions", holdList);
  await page.locator("#more-button").click();
  await page.getByRole("button", { name: "パスキーとセッション" }).click();

  // Meanwhile the user types; the save is refused and the conflict is asked.
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type("X");
  const dialog = page.locator("dialog");
  await expect(dialog).toContainText("競合しています", { timeout: 30000 });

  // The lists arrive. The question stays where it is, with its buttons.
  const listsArrived = Promise.all(["credentials", "sessions"].map((name) =>
    page.waitForResponse((response) => response.url().endsWith(`/api/v1/${name}`) && response.request().method() === "GET")));
  releaseLists();
  await listsArrived;
  await page.waitForTimeout(500);
  await expect(dialog).toContainText("競合しています");
  await expect(dialog).not.toContainText("パスキー1");
  await dialog.getByRole("button", { name: "編集して保存" }).click();

  // Only then does the other screen open; closing it leaves saving intact.
  await expect(dialog).toContainText("パスキー1", { timeout: 15000 });
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await page.unroute("**/api/v1/document");
  await waitForSync(page);
  await page.reload();
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#editor-host .ProseMirror")).toContainText("A1X", { timeout: 30000 });
});

test("spec: 「その他」を素早く2回押しても、メニューは1度だけ開く", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
  // Two activations before the menu has had time to open (it first reads the
  // device-keep state): the requests are answered one at a time, so a second
  // one would bring the menu back after it was closed.
  await page.locator("#more-button").evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  const dialog = page.locator("dialog");
  await expect(dialog).toContainText("今すぐロック");
  await page.locator("#dialog-close").click();
  await page.waitForTimeout(800);
  expect(await dialog.evaluate((node: HTMLDialogElement) => node.open)).toBe(false);
});

test("spec: 一覧の取得中に「パスキーとセッション」をもう一度選んでも、画面は1度だけ開く", async ({ page }) => {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto(BASE);
  await registerViaOnboarding(page);
  await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });

  let releaseLists!: () => void;
  const listsReleased = new Promise<void>((resolve) => { releaseLists = resolve; });
  const holdList = async (route: import("@playwright/test").Route): Promise<void> => {
    if (route.request().method() === "GET") await listsReleased;
    await route.continue();
  };
  await page.route("**/api/v1/credentials", holdList);
  await page.route("**/api/v1/sessions", holdList);

  // Nothing is on screen while the lists load, so the action can be chosen
  // again. Dialogs are shown one after another: a second request would bring
  // the same screen back after it was closed.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.locator("#more-button").click();
    await page.getByRole("button", { name: "パスキーとセッション" }).click();
  }
  const dialog = page.locator("dialog");
  const listsArrived = Promise.all(["credentials", "sessions"].map((name) =>
    page.waitForResponse((response) => response.url().endsWith(`/api/v1/${name}`) && response.request().method() === "GET")));
  releaseLists();
  await listsArrived;
  await expect(dialog).toContainText("パスキー1", { timeout: 15000 });
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await page.waitForTimeout(1000);
  expect(await dialog.evaluate((node: HTMLDialogElement) => node.open)).toBe(false);
});
