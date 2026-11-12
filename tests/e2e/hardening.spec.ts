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
