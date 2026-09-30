# Web onboarding and UI refresh — design

Date: 2026-09-30
Scope: Web app only (`apps/web`). iOS/macOS are out of scope for this change.
Contract: `spec.md` §4.1, §4.2, §4.6, §17.5 are updated first (spec version 1.2).

## Problem

A first-time visitor sees one sentence and two buttons. Pressing 「はじめて使う」
immediately opens the OS passkey sheet with no explanation of passkeys,
end-to-end encryption, or why the recovery key matters. After registration the
editor is a blank white page: nothing says where to type, what the paperclip
does, or that saving is automatic.

Current UI issues found while auditing (screenshots taken against `npm run dev`):

1. Gate: no brand presence, no explanation beyond one sentence.
2. Recovery key dialog: the 「コピーしました」 button *performs* the copy — the
   label claims a past action the user may not have taken. No file-save option
   although spec §7.1 asks for "copy or file save".
3. Empty editor: no hint at all.
4. 「その他」: six identical blue primary buttons in a grid, including the
   destructive 「アカウントを削除」; no close button.
5. No motion anywhere: gate/editor swap, dialogs, and toasts appear instantly.

## Decisions (agreed with Kan)

| Topic | Decision |
| --- | --- |
| Platforms | Web only |
| Onboarding form | Intro slides before registration + one-time hints after it |
| Visual direction | "C. 活字 (type)": white page, large monospace `txt.` wordmark with a blue period, black pill primary buttons, the existing blue as accent |

## Experience flow

```
Gate (wordmark types in: t → x → t → blue ".")
 ├─ パスキーで開く ─────────────→ existing login flow (unchanged)
 ├─ 復旧キーで開く ─────────────→ existing recovery flow (unchanged)
 └─ はじめて使う → intro, 4 slides ("スキップ" jumps to the last slide)
      1. 1枚だけ.         lines type onto a sheet
      2. パスキーで開く.   "••••••" is struck out and becomes a key
      3. 端末で暗号化.     plaintext scrambles into ciphertext glyphs
      4. 復旧キーを控える. "TXT1.…" types out → [パスキーを作成]
   → OS passkey sheet → recovery key dialog (コピー / ファイルに保存 / 保存しました / あとで)
   → editor: empty-state hint + one-time hints for 📎 and …
```

- Intro controls: 「戻る」 (hidden on slide 1, where 「やめる」 returns to the
  gate), progress dots, 「次へ」; 「スキップ」 top-right. Keyboard: ←/→ move,
  Esc leaves the intro. Focus moves to the slide heading on each change; a
  polite live region announces 「n / 4」 and the title.
- Replay: 「その他」 → 「使い方」 opens the same slides in replay mode; the last
  slide's primary button reads 「閉じる」 and returns to the editor.
- One-time hints appear only right after a successful registration. The flag is
  in memory, so nothing is written to storage. Hints are non-modal: they never
  take focus from the editor and disappear on 「わかった」, Escape, the first
  keystroke, or the start of an IME composition.
- Empty-state hint 「ここから書く。自動で保存されます。」 is shown whenever the
  document has no text and no media. It is a `::before` on `#editor-host`
  driven by a `data-empty` attribute; ProseMirror's DOM is never touched. The
  attribute is updated only at IME safe points and is forced off while
  composing.

## UI refresh

- Tokens: `--bg #fff`, `--fg #111`, `--muted #6b6b70`, `--line #e5e5ea`,
  `--accent #0a84ff`, `--danger #d70015`; dark: `--bg #0b0b0c`, `--fg #f2f2f4`,
  `--accent #4c9aff`, `--danger #ff6961`. The editor keeps system monospace,
  16px, line-height 1.6 (spec §4.2).
- Buttons: `.button` (primary, black pill; white in dark mode), `.button.secondary`
  (outline pill), `.button.ghost` (text only), `.button.danger` (red text).
  `:active` gives scale 0.98 — buttons only, never the editor.
- 「その他」: a list menu using the existing `<dialog>` with a `menu` variant:
  status line, rows with inline SVG icons, a divider before session/account
  actions, 「アカウントを削除」 in red with an icon (not colour alone), and a
  close (×) button. Bottom sheet under 720px, centred panel above.
- Recovery dialog: key shown in a tinted mono block; 「コピー」 (clipboard,
  toast 「コピーしました」), 「ファイルに保存」 (downloads `txt-recovery-key.txt`
  from a Blob URL), primary 「保存しました」, ghost 「あとで」. The primary no
  longer writes to the clipboard as a side effect.
- Sync status: a small glyph plus the existing text — pulsing dot while saving,
  a dot on 同期済み, a hollow dot when stored locally only, ⚠ on errors.
- Toast: rises in and fades out instead of blinking.
- Icon: the existing mark gains a blue dot.

## Motion safety rules

1. Nothing inside or wrapping the editing surface is transformed or has its
   opacity animated (spec §4.2 IME hazard). Gate → editor is a cross-fade in
   which the editor appears underneath and the fixed-position gate fades out
   on top (`inert` while leaving).
2. All motion is CSS keyframes/transitions in `styles.css` (CSP `style-src
   'self'`; no inline style attributes).
3. `prefers-reduced-motion: reduce` disables animation and shows final states.
4. Dialog exit animation uses `transition-behavior: allow-discrete` as progressive
   enhancement. `showDialog`'s close/answer logic is unchanged.

## Code structure

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `apps/web/src/app/onboarding-state.ts` (new) | Pure intro state machine: `createIntro`, `next`, `back`, `skip`, `isLast`, slide data | nothing |
| `apps/web/src/app/onboarding.ts` (new) | Renders slides into `#intro`, keyboard and focus handling; `runIntro(mode)` resolves `"create" \| "cancel" \| "closed"` | onboarding-state, motion |
| `apps/web/src/app/coach.ts` (new) | One-time hints: `showCoachMarks()` returns `dismiss()` | motion |
| `apps/web/src/app/motion.ts` (new) | `prefersReducedMotion()`, `playExit(element, className)` (waits for `animationend` with a timeout fallback) | nothing |
| `apps/web/src/app/main.ts` | Wire-up only: gate, `showApp` cross-fade, dialog `menu` variant, more menu, recovery dialog, register flow, empty-state toggling | all of the above |
| `apps/web/static/index.html`, `styles.css`, `icon.svg` | Markup, tokens, motion | — |

## Error handling

- Cancelling the passkey sheet from the last slide lands on the existing
  「うまくいきませんでした」 gate (unchanged `reportAuthError`).
- Clipboard or download failure shows a toast; the key stays visible, so the
  user can still copy it by hand.
- If `animationend` never fires (hidden tab, reduced motion), `playExit`
  resolves on a timeout, so the UI can never get stuck mid-transition.

## Testing

- Unit (vitest, `tests/web/onboarding-state.test.ts`): initial slide, next/back
  bounds, skip jumps to last, `isLast`, replay mode CTA label.
- E2E (`tests/e2e/onboarding.spec.ts`): wordmark gate; intro next/back/skip,
  keyboard ←/→/Esc; register from the last slide; recovery dialog copy and file
  save; coach marks visible after registration and dismissed by typing;
  empty-state hint toggles; more menu close button, danger styling, 「使い方」
  replay; reduced motion shows final states.
- Existing E2E registrations go through a shared `registerViaOnboarding()` helper.
- Gate: `npm run check` and `npm run test:e2e` green, plus before/after
  screenshots at 1280×800 and 390×844 in light and dark.
