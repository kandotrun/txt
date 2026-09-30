# Share Card and App Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rich link previews (OGP), search indexing, and a 「txt を紹介する」 menu item that shares only the app URL.

**Architecture:** Static metadata in `index.html`; generated PNGs and `robots.txt` as static assets copied by `build.mjs`; a pure `shareApp()` with injected dependencies, wired into the existing 「その他」 menu.

**Design:** `docs/superpowers/specs/2026-09-30-share-card-design.md`

---

### Task 1: `shareApp` (unit, TDD)
- Test `tests/web/share.test.ts`: share sheet used when `navigator.share` exists → `"shared"` with `{ title: "txt", text: SHARE_TEXT, url: origin + "/" }`; `AbortError` → `"cancelled"` and no clipboard write; no Web Share → `clipboard.writeText(url)` → `"copied"`; other share errors fall back to copying.
- Implement `apps/web/src/app/share.ts`: `SHARE_TEXT`, `sharePayload(origin)`, `shareApp({ navigator, origin })`.

### Task 2: Share metadata and assets (unit, TDD)
- Test `tests/web/share-meta.test.ts` reading `apps/web/static/`: no `noindex`; `description`, `canonical`, `og:type|site_name|title|description|url|image|image:width|image:height|image:alt|locale`, `twitter:card`, two `theme-color`, `apple-touch-icon`; every URL absolute `https://txt.2-38.com/…`; `og.png` is 1200×630 and `apple-touch-icon.png` 180×180 (PNG IHDR); `robots.txt` allows `/` and disallows `/api/`, `/_local/`; `build.mjs` copies the three files.

### Task 3: Image generator
- `scripts/brand-images.mjs` renders two HTML templates with Playwright Chromium → `apps/web/static/og.png`, `apple-touch-icon.png`; `npm run brand:images`.

### Task 4: Shell and static files
- `index.html` head, `robots.txt`, `_headers` cache rules, `build.mjs` copy list. Task 2 goes green.

### Task 5: Menu wiring
- `icons.ts` gains `share`; 「その他」 row 「txt を紹介する」 after 「使い方」; result `"copied"` → toast 「リンクをコピーしました。」, failure → toast.

### Task 6: E2E (`tests/e2e/share.spec.ts`)
- Asset types (not SPA HTML); shared payload via a stubbed `navigator.share` excludes typed text; copy fallback when `navigator.share` is absent.

### Task 7: Verify and ship
- `npm run check`, rebuild + restart dev server, full `npx playwright test`, screenshot the menu, PR + squash merge.
