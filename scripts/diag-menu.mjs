/**
 * Diagnostic: inspect the production page state (locked/unlocked, layout,
 * and whether the controls respond). Read-only except for clicking buttons.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.TXT_BASE_URL ?? "https://txt.2-38.com";

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 160)}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message.slice(0, 200)}`));

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

const state = await page.evaluate(() => {
  const info = (id) => {
    const el = document.getElementById(id);
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      hiddenAttr: el.hasAttribute("hidden"),
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
  };
  return {
    app: info("app"),
    gate: info("gate"),
    controls: info("controls"),
    moreButton: info("more-button"),
    attachButton: info("attach-button"),
    gateActionsHtml: document.getElementById("gate-actions")?.innerHTML?.slice(0, 200) ?? "",
    bodyScrollHeight: document.body.scrollHeight,
    innerHeight: window.innerHeight,
    scrollY: window.scrollY,
  };
});
console.log("=== INITIAL STATE ===");
console.log(JSON.stringify(state, null, 2));

await page.screenshot({ path: "/tmp/txt-diag-initial.png" });

// Can the user reach the gate buttons without scrolling?
const gateBtn = page.getByRole("button", { name: "はじめて使う" });
const gateBtnVisible = await gateBtn.isVisible().catch(() => false);
const gateBtnInViewport = await gateBtn
  .evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight;
  })
  .catch(() => false);
console.log("GATE_BTN_VISIBLE:", gateBtnVisible, "IN_VIEWPORT:", gateBtnInViewport);

// Click the その他 button as a real user would.
try {
  await page.locator("#more-button").click({ timeout: 5000, force: false });
  await page.waitForTimeout(600);
  const dialogCount = await page.locator("dialog[open]").count();
  const title = await page.locator("#dialog-title").textContent().catch(() => null);
  const actions = await page.locator("#dialog-actions button").allTextContents().catch(() => []);
  console.log("MORE_CLICK: dialogOpen=", dialogCount, " title=", JSON.stringify(title), " actions=", JSON.stringify(actions));
  await page.screenshot({ path: "/tmp/txt-diag-menu.png" });

  if (dialogCount > 0 && actions.length > 0) {
    // Try the first action.
    await page.locator("#dialog-actions button").first().click({ timeout: 5000 });
    await page.waitForTimeout(2500);
    const afterTitle = await page.locator("#dialog-title").textContent().catch(() => null);
    const stillOpen = await page.locator("dialog[open]").count();
    const toast = await page.locator("#toast").textContent().catch(() => null);
    console.log("AFTER_ACTION: title=", JSON.stringify(afterTitle), " open=", stillOpen, " toast=", JSON.stringify(toast));
    await page.screenshot({ path: "/tmp/txt-diag-after-action.png" });
  }
} catch (e) {
  console.log("MORE_CLICK_FAILED:", String(e.message).slice(0, 300));
}

console.log("=== CONSOLE ===");
console.log(logs.slice(0, 20).join("\n"));

await browser.close();
