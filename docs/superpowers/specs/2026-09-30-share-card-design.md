# Share card, search indexing and 「txt を紹介する」 — design

Date: 2026-09-30
Scope: Web app only. Contract: `spec.md` §4.6, §14, §19 (updated first).

## Problem

A shared link to `https://txt.2-38.com/` previews as a bare "txt": no
description, no image. The shell also carries `noindex, nofollow`, and any
missing path (including `/robots.txt` and would-be images) falls back to the
SPA HTML, so crawlers cannot get proper files.

## Decisions (agreed with Kan)

| Topic | Decision |
| --- | --- |
| Share card | Full OGP + `twitter:card=summary_large_image`, 活字-style 1200×630 image |
| Search | Allow indexing: drop `noindex`, publish `robots.txt` (allow `/`, disallow `/api/` and `/_local/`) |
| In-app sharing | 「その他」→「txt を紹介する」: OS share sheet, or copy the link when unavailable |

## Details

- `<title>` stays `txt` (spec §4.2). Share wording lives in `og:title`
  (「txt — メールアドレスなしで、1枚のテキストを。」) and `description` /
  `og:description`.
- Absolute URLs point at the production origin (`https://txt.2-38.com/`),
  including `canonical`, `og:url` and `og:image`.
- `theme-color` for light (`#ffffff`) and dark (`#0b0b0c`); `apple-touch-icon`
  (180×180 PNG) for iMessage/iOS previews and the home screen.
- Images are generated, not hand-edited: `scripts/brand-images.mjs` renders HTML
  templates with Playwright into `apps/web/static/og.png` and
  `apple-touch-icon.png` (`npm run brand:images`).
- `_headers`: the PNGs cache for a day, `robots.txt` for an hour.
- Sharing sends only a fixed introduction and the app URL for the current
  origin — never document text, file names, or anything decrypted.
  `shareApp()` lives in `share.ts` with injected `navigator`/`origin` so its
  branches are unit-testable: share sheet → `"shared"`, user cancel
  (`AbortError`) → `"cancelled"`, no Web Share → copy link → `"copied"`.

## Testing

- Unit (`tests/web/share-meta.test.ts`): required meta tags with absolute https
  URLs, no `noindex`, PNG dimensions read from the IHDR chunk, robots rules.
- Unit (`tests/web/share.test.ts`): `shareApp` branches and payload contents.
- E2E (`tests/e2e/share.spec.ts`): `/og.png`, `/apple-touch-icon.png` and
  `/robots.txt` are served with their own types (not the SPA shell); the menu
  shares only the URL and the introduction; the copy fallback works.
