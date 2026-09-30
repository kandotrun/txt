/**
 * Generates the share images from HTML (spec §14, design
 * docs/superpowers/specs/2026-09-30-share-card-design.md).
 *
 *   npm run brand:images
 *
 * Writes apps/web/static/og.png (1200×630) and apple-touch-icon.png (180×180).
 * The images are build inputs checked into the repository; regenerate them
 * here instead of editing the PNGs by hand. Rendering uses the system fonts of
 * the machine that runs it (the look matches the gate's monospace stack).
 */

import path from "node:path";

import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = (name) => path.join(root, "apps/web/static", name);

const FONT = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, monospace`;

const OG = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
  html, body { margin: 0; }
  .card {
    box-sizing: border-box; width: 1200px; height: 630px; padding: 72px 96px 56px;
    display: flex; flex-direction: column; justify-content: space-between;
    background: #ffffff; color: #111111; font-family: ${FONT};
    -webkit-font-smoothing: antialiased;
  }
  .mark { display: flex; align-items: baseline; font-size: 210px; font-weight: 800; line-height: 0.9; }
  .dot { color: #0a84ff; margin-left: -0.08em; }
  .caret { display: inline-block; width: 0.09em; height: 0.72em; margin-left: 0.05em; background: #111111; }
  h1 { margin: 0; font-size: 48px; font-weight: 700; line-height: 1.3; white-space: nowrap; }
  p { margin: 18px 0 0; font-size: 30px; color: #6b6b70; }
  footer {
    display: flex; justify-content: space-between; align-items: center;
    padding-top: 20px; border-top: 2px solid #e5e5ea; font-size: 26px; color: #6b6b70;
  }
  footer i { width: 14px; height: 14px; border-radius: 50%; background: #0a84ff; }
</style></head><body><div class="card">
  <div class="mark"><span>txt</span><span class="dot">.</span><span class="caret"></span></div>
  <div>
    <h1>メールアドレスなしで、1枚のテキストを。</h1>
    <p>パスキーで開く・端末で暗号化・自動で同期</p>
  </div>
  <footer><span>txt.2-38.com</span><i></i></footer>
</div></body></html>`;

// Full-bleed square: iOS applies its own corner mask to touch icons.
const TOUCH_ICON = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; }
  svg { display: block; }
</style></head><body>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="180" height="180">
    <rect width="64" height="64" fill="#111114" />
    <path d="M18 24h28M24 24v20M32 24v20M40 24v20" stroke="#f2f2f4" stroke-width="4" stroke-linecap="round" fill="none" />
    <circle cx="50" cy="44" r="4" fill="#0a84ff" />
  </svg>
</body></html>`;

const browser = await chromium.launch();
try {
  for (const { html, width, height, file } of [
    { html: OG, width: 1200, height: 630, file: "og.png" },
    { html: TOUCH_ICON, width: 180, height: 180, file: "apple-touch-icon.png" },
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: out(file), clip: { x: 0, y: 0, width, height } });
    await page.close();
    console.log(`wrote apps/web/static/${file} (${width}×${height})`);
  }
} finally {
  await browser.close();
}
