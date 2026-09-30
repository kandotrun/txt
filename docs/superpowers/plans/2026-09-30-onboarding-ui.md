# Web Onboarding and UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a four-slide intro before registration, one-time hints after it, and a type-based ("活字") visual refresh of the Web app without touching the IME-sensitive editing surface.

**Architecture:** Pure intro state (`onboarding-state.ts`) is unit-tested; thin DOM modules (`onboarding.ts`, `coach.ts`, `motion.ts`, `icons.ts`) render it into static layers declared in `index.html`. `main.ts` only wires flows. All motion is CSS in `styles.css`, applied to layers outside the editor (gate, intro, dialog, toast, coach).

**Tech Stack:** TypeScript, esbuild, ProseMirror (unchanged), vitest (unit), Playwright + CDP virtual authenticator (E2E), Cloudflare Workers dev server (`npm run dev`, port 8799).

**Design:** `docs/superpowers/specs/2026-09-30-onboarding-ui-design.md`. **Contract:** `spec.md` §4.1, §4.2, §4.6, §17.5 (v1.2).

**Commands:**
- Unit: `npx vitest run --config vitest.config.ts <path>`
- Types: `npm run typecheck`
- All non-E2E: `npm run check`
- E2E: the dev server must be restarted after every web build (`bash scripts/dev.sh`, it rebuilds first), then `npx playwright test <file>`.

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `apps/web/src/app/onboarding-state.ts` | create | Slide data and pure transitions/labels |
| `apps/web/src/app/onboarding.ts` | create | Render intro into `#intro`, keyboard, art animations |
| `apps/web/src/app/coach.ts` | create | Non-modal one-time hints |
| `apps/web/src/app/motion.ts` | create | Reduced-motion check, exit sequencing |
| `apps/web/src/app/icons.ts` | create | Line icons built with DOM APIs |
| `apps/web/src/app/editor.ts` | modify | Export `isEmptyDoc` |
| `apps/web/src/app/main.ts` | modify | Wire gate, intro, dialog menu variant, recovery dialog, hints, toast, empty hint |
| `apps/web/static/index.html` | modify | Wordmark, `#intro`, `#coach`, `#empty-hint`, dialog header |
| `apps/web/static/styles.css` | rewrite | Tokens, components, motion, reduced motion |
| `apps/web/static/icon.svg` | modify | Blue dot |
| `tests/web/onboarding-state.test.ts` | create | Unit tests for the state machine |
| `tests/editor/empty-doc.test.ts` | create | Unit tests for `isEmptyDoc` |
| `tests/e2e/helpers/onboarding.ts` | create | `registerViaOnboarding()` |
| `tests/e2e/onboarding.spec.ts` | create | E2E for intro, recovery, hints, menu, motion |
| `tests/e2e/flows.spec.ts`, `tests/e2e/inactivity.spec.ts` | modify | Use the helper |
| `vitest.config.ts`, `tsconfig.web.json` | modify | Include `tests/web` |
| `README.md` | modify | Mention onboarding in the implemented scope |

---

### Task 1: Intro state machine

**Files:**
- Create: `apps/web/src/app/onboarding-state.ts`
- Create: `tests/web/onboarding-state.test.ts`
- Modify: `vitest.config.ts` (include), `tsconfig.web.json` (include)

- [ ] **Step 1: Include the new test directory**

`vitest.config.ts` `include` gains `"tests/web/**/*.test.ts"`; `tsconfig.web.json` `include` gains `"tests/web/**/*.ts"`.

- [ ] **Step 2: Write the failing test** — `tests/web/onboarding-state.test.ts`

```ts
/** Intro state machine (spec §4.6 「紹介」). */

import { describe, expect, it } from "vitest";

import {
  INTRO_SLIDES,
  back,
  createIntro,
  currentSlide,
  isFirst,
  isLast,
  next,
  primaryLabel,
  progressLabel,
  secondaryLabel,
  skip,
} from "../../apps/web/src/app/onboarding-state.ts";

describe("intro state machine", () => {
  it("covers the four topics in order", () => {
    expect(INTRO_SLIDES.map((slide) => slide.id)).toEqual(["sheet", "passkey", "encrypt", "recovery"]);
  });

  it("starts on the first slide", () => {
    const state = createIntro("register");
    expect(isFirst(state)).toBe(true);
    expect(currentSlide(state).id).toBe("sheet");
    expect(progressLabel(state)).toBe("1 / 4");
  });

  it("moves forward and stops at the last slide", () => {
    let state = createIntro("register");
    for (let step = 0; step < 10; step++) state = next(state);
    expect(isLast(state)).toBe(true);
    expect(currentSlide(state).id).toBe("recovery");
    expect(progressLabel(state)).toBe("4 / 4");
  });

  it("moves back and stops at the first slide", () => {
    const state = back(back(back(next(next(createIntro("register"))))));
    expect(isFirst(state)).toBe(true);
  });

  it("skips to the recovery slide, never past it", () => {
    const state = skip(createIntro("register"));
    expect(currentSlide(state).id).toBe("recovery");
    expect(skip(state)).toEqual(state);
  });

  it("labels the call to action by mode", () => {
    expect(primaryLabel(createIntro("register"))).toBe("次へ");
    expect(primaryLabel(skip(createIntro("register")))).toBe("パスキーを作成");
    expect(primaryLabel(skip(createIntro("replay")))).toBe("閉じる");
  });

  it("lets the first slide leave the intro", () => {
    expect(secondaryLabel(createIntro("register"))).toBe("やめる");
    expect(secondaryLabel(createIntro("replay"))).toBe("閉じる");
    expect(secondaryLabel(next(createIntro("register")))).toBe("戻る");
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run --config vitest.config.ts tests/web/onboarding-state.test.ts`
Expected: FAIL — cannot resolve `onboarding-state.ts`.

- [ ] **Step 4: Implement** — `apps/web/src/app/onboarding-state.ts`

```ts
/**
 * Intro state machine (spec §4.6 「紹介」).
 *
 * Pure data and transitions so slide order, bounds and button labels are
 * unit-testable without a DOM. Rendering lives in `onboarding.ts`.
 */

export type IntroMode = "register" | "replay";

export type IntroSlideId = "sheet" | "passkey" | "encrypt" | "recovery";

export interface IntroSlide {
  readonly id: IntroSlideId;
  readonly title: string;
  readonly body: string;
}

export const INTRO_SLIDES: readonly IntroSlide[] = [
  {
    id: "sheet",
    title: "1枚だけ",
    body: "タイトルも一覧もありません。開けばすぐ書けて、自動で保存・同期されます。",
  },
  {
    id: "passkey",
    title: "パスキーで開く",
    body: "メールアドレスもパスワードも要りません。指紋・顔・端末のロック解除などで開きます。",
  },
  {
    id: "encrypt",
    title: "端末で暗号化",
    body: "本文と添付はこの端末で暗号化され、サーバーには暗号文だけが届きます。運営者も中身を読めません。",
  },
  {
    id: "recovery",
    title: "復旧キーを控える",
    body: "パスキーを失くしたときに開ける唯一の鍵です。次の画面で表示されるので、パスキーとは別の場所に保存してください。",
  },
];

export interface IntroState {
  readonly mode: IntroMode;
  readonly index: number;
}

const LAST = INTRO_SLIDES.length - 1;

export function createIntro(mode: IntroMode): IntroState {
  return { mode, index: 0 };
}

export function next(state: IntroState): IntroState {
  return { ...state, index: Math.min(state.index + 1, LAST) };
}

export function back(state: IntroState): IntroState {
  return { ...state, index: Math.max(state.index - 1, 0) };
}

/** 「スキップ」 lands on the last slide so the recovery-key warning is never skipped. */
export function skip(state: IntroState): IntroState {
  return { ...state, index: LAST };
}

export function isFirst(state: IntroState): boolean {
  return state.index === 0;
}

export function isLast(state: IntroState): boolean {
  return state.index === LAST;
}

export function currentSlide(state: IntroState): IntroSlide {
  return INTRO_SLIDES[state.index]!;
}

/** Forward button: the last slide carries the call to action. */
export function primaryLabel(state: IntroState): string {
  if (!isLast(state)) return "次へ";
  return state.mode === "register" ? "パスキーを作成" : "閉じる";
}

/** Backward button: on the first slide it leaves the intro. */
export function secondaryLabel(state: IntroState): string {
  if (!isFirst(state)) return "戻る";
  return state.mode === "register" ? "やめる" : "閉じる";
}

export function progressLabel(state: IntroState): string {
  return `${state.index + 1} / ${INTRO_SLIDES.length}`;
}
```

- [ ] **Step 5: Run it and see it pass**

Run: `npx vitest run --config vitest.config.ts tests/web/onboarding-state.test.ts`
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts tsconfig.web.json apps/web/src/app/onboarding-state.ts tests/web/onboarding-state.test.ts
git commit -m "feat(web): add the intro state machine"
```

---

### Task 2: Empty-document detection

**Files:**
- Modify: `apps/web/src/app/editor.ts` (add export after `schema`)
- Create: `tests/editor/empty-doc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** Empty-state hint trigger (spec §4.1): only a single empty text block is empty. */

import { describe, expect, it } from "vitest";

import { isEmptyDoc, schema } from "../../apps/web/src/app/editor.ts";

const paragraph = (text?: string) =>
  schema.nodes.paragraph!.create(null, text ? schema.text(text) : null);
const doc = (...blocks: ReturnType<typeof paragraph>[]) => schema.nodes.doc!.create(null, blocks);

describe("isEmptyDoc", () => {
  it("is true for a single empty paragraph", () => {
    expect(isEmptyDoc(doc(paragraph()))).toBe(true);
  });

  it("is false once there is any text, including whitespace", () => {
    expect(isEmptyDoc(doc(paragraph(" ")))).toBe(false);
    expect(isEmptyDoc(doc(paragraph("a")))).toBe(false);
  });

  it("is false with media or several blocks", () => {
    const media = schema.nodes.media!.create({ mediaId: "m", kind: "image", id: "b" });
    expect(isEmptyDoc(schema.nodes.doc!.create(null, [paragraph(), media, paragraph()]))).toBe(false);
    expect(isEmptyDoc(doc(paragraph(), paragraph()))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run --config vitest.config.ts tests/editor/empty-doc.test.ts`
Expected: FAIL — `isEmptyDoc` is not exported.

- [ ] **Step 3: Implement** — in `editor.ts`, after the `schema` declaration:

```ts
/**
 * True when the document is a single empty text block: no text, no media.
 * Drives the empty-state hint, which lives outside the editing DOM (§4.1).
 */
export function isEmptyDoc(doc: PMNode): boolean {
  const only = doc.childCount === 1 ? doc.firstChild : null;
  return only !== null && only.type.name === "paragraph" && only.content.size === 0;
}
```

- [ ] **Step 4: Run it and see it pass** — Expected: 3 passed.

- [ ] **Step 5: Commit** — `git commit -m "feat(web): detect an empty document for the empty-state hint"`

---

### Task 3: E2E first (Red)

**Files:**
- Create: `tests/e2e/helpers/onboarding.ts`
- Create: `tests/e2e/onboarding.spec.ts`
- Modify: `tests/e2e/flows.spec.ts`, `tests/e2e/inactivity.spec.ts`

- [ ] **Step 1: Helper**

```ts
/**
 * Registration through the intro (spec §4.6 「紹介」→「新規作成」).
 */

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Creates an account from the gate and confirms the recovery key; returns the key. */
export async function registerViaOnboarding(page: Page): Promise<string> {
  await page.getByRole("button", { name: "はじめて使う" }).click();
  await page.getByRole("button", { name: "スキップ" }).click();
  await page.getByRole("button", { name: "パスキーを作成" }).click();
  await expect(page.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
  const recoveryKey = ((await page.locator("dialog pre").textContent()) ?? "").trim();
  await page.getByRole("button", { name: "保存しました" }).click();
  return recoveryKey;
}
```

- [ ] **Step 2: Replace the inline registration** in `flows.spec.ts` (9 places) and `inactivity.spec.ts` (1 place): each block

```ts
await page.getByRole("button", { name: "はじめて使う" }).click();
await expect(page.getByText("復旧キーを保存してください")).toBeVisible({ timeout: 30000 });
await page.getByRole("button", { name: "コピーしました" }).click();
```

becomes `await registerViaOnboarding(page);`. In "registers with a passkey, edits, and syncs", keep the format assertion on the returned key:

```ts
const recoveryKey = await registerViaOnboarding(page);
expect(recoveryKey).toMatch(/^TXT1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
```

- [ ] **Step 3: New spec** — `tests/e2e/onboarding.spec.ts` (full content in the repository; cases):
  1. intro via buttons, ←/→, 「スキップ」, Esc back to the gate with no ceremony;
  2. register from the last slide; 「コピー」 fills the clipboard and relabels to 「コピーしました」; 「ファイルに保存」 downloads `txt-recovery-key.txt` containing the key; 「保存しました」 opens the editor; `#coach` and `#empty-hint` visible, editor focused; typing hides both;
  3. 「その他」 is a `dialog--menu`, 「アカウントを削除」 has `danger`, 「閉じる」 closes it, 「使い方」 replays the intro whose last button is 「閉じる」 and returns with the text intact;
  4. during the gate→editor cross-fade no ancestor-or-self of `.ProseMirror` has a transform or a running animation;
  5. with `reducedMotion: "reduce"` every running animation lasts ≤ 1 ms.

- [ ] **Step 4: Build, restart, run — expect Red**

Run: `bash scripts/dev.sh` (background), then `npx playwright test`
Expected: onboarding.spec and every helper-based test FAIL (no 「スキップ」 button yet); the first-paint test passes.

- [ ] **Step 5: Commit** — `git commit -m "test(e2e): specify onboarding, recovery, hints, menu and motion"`

---

### Task 4: Motion and icon helpers

**Files:** Create `apps/web/src/app/motion.ts`, `apps/web/src/app/icons.ts` (code as committed; key API below).

```ts
export function prefersReducedMotion(): boolean;
/** Adds `className`, hides the element on `animationend` or after `timeoutMs`. */
export function playExit(element: HTMLElement, className: string, timeoutMs?: number): Promise<void>;
/** Cancels a pending exit (the element is being shown again). */
export function cancelExit(element: HTMLElement): void;
/** Restarts an entrance animation class. */
export function replayEnter(element: HTMLElement, className: string): void;

export type IconName = "device" | "lock" | "key" | "refresh" | "help" | "logout" | "trash" | "copy" | "download" | "close" | "check";
export function icon(name: IconName): SVGSVGElement;
```

- [ ] Typecheck: `npm run typecheck` → no errors. Commit: `feat(web): add motion and icon helpers`.

---

### Task 5: Markup and styles

**Files:** `apps/web/static/index.html`, `apps/web/static/styles.css`, `apps/web/static/icon.svg`

- [ ] `index.html`: wordmark (`.wordmark > .wordmark-text, .wordmark-dot, .wordmark-caret`, `aria-hidden`) at the top of `.gate-card`; `#empty-hint` (aria-hidden) and `#coach` (aria-live polite) inside `#app`; `#intro` section (`role="dialog" aria-modal="true" aria-labelledby="intro-title"`) with `#intro-progress`, `#intro-skip`, `#intro-stage` (aria-live polite) holding `#intro-art`, `#intro-title` (tabindex −1), `#intro-body`, and `#intro-back`, `#intro-dots`, `#intro-next`; dialog gains a header with `#dialog-close` (hidden unless menu).
- [ ] `styles.css`: tokens (light/dark), buttons (primary/secondary/ghost/danger/compact), gate (fixed layer, rise-in stagger, `.is-leaving` fade), wordmark (clip-path steps typing, dot drop, caret blink), intro (layer, stage slide-in, per-slide art), coach bubbles, empty hint, sync glyphs, dialog enter/exit with `@starting-style` + `allow-discrete`, menu rows and mobile sheet, toast enter/exit, reduced-motion override. The `.editor`/`.ProseMirror` rules keep no transform/animation.
- [ ] `icon.svg`: add `<circle cx="50" cy="44" r="4" fill="#0a84ff" />`.
- [ ] Commit: `feat(web): type-based look, motion layers and onboarding markup`.

---

### Task 6: Intro and hints modules

**Files:** Create `apps/web/src/app/onboarding.ts`, `apps/web/src/app/coach.ts`.

```ts
// onboarding.ts
export type IntroOutcome = "create" | "cancel" | "closed";
/** Shows the intro over `behind` (made inert meanwhile) and resolves with the user's choice. */
export function runIntro(mode: IntroMode, options: { behind: HTMLElement[] }): Promise<IntroOutcome>;

// coach.ts
export interface CoachHint { side: "start" | "end"; text: string }
/** Shows non-modal hints in `layer`; returns an idempotent dismiss function. */
export function showCoachMarks(layer: HTMLElement, hints: CoachHint[]): () => void;
```

Rules: `runIntro` wires buttons with `onclick =` (no listener build-up), keydown on `#intro` (←/→/Esc), focuses the title on open and the next button if focus is lost, rebuilds per-slide art so CSS animations restart, scrambles the cipher text with `requestAnimationFrame` (final text immediately under reduced motion), marks the layer `inert` while leaving. `showCoachMarks` listens in the capture phase for `keydown`, `compositionstart`, and outside `pointerdown`, never calls `preventDefault`.

- [ ] Typecheck, commit: `feat(web): render the intro and one-time hints`.

---

### Task 7: Wire `main.ts`

- [ ] `elements` gains `emptyHint`, `coach`, `dialogClose`.
- [ ] `buttonClass(action)` shared by gate and dialog: `danger` → `button danger`, `ghost` → `button ghost`, `primary === false` → `button secondary`, else `button`.
- [ ] `showGate`: `cancelExit(gate)`, `gate.inert = false`, then existing behaviour.
- [ ] `showApp`: show app first; if the gate is visible, `gate.inert = true` and `playExit(gate, "is-leaving")`.
- [ ] `toast`: `cancelExit`, `replayEnter(toast, "is-entering")`, timer → `playExit(toast, "is-leaving")`.
- [ ] `showDialog({ …, variant?: "menu" })`: toggles `dialog--menu`, shows `#dialog-close` (onclick settles `"dismissed"`), renders menu rows (`.menu-item` + icon, `.danger`, `.menu-separator` before `separatorBefore`) or buttons.
- [ ] `confirmRecoveryKey`: lead text + `RECOVERY_HELP`, `<pre class="recovery-key">`, tools row 「コピー」 (clipboard, relabel 「コピーしました」 for 2 s; on failure select the key and relabel 「選択しました」) and 「ファイルに保存」 (Blob URL anchor appended inside the dialog, `txt-recovery-key.txt`), actions 「保存しました」 / 「あとで」(ghost). No clipboard side effect on confirm.
- [ ] `startRegistration()`: `runIntro("register", { behind: [gate] })`; `"create"` → `registerFlow()`; otherwise focus the first gate button. Used by the 401 gate (はじめて使う primary, パスキーで開く secondary) and the signed-in-without-key gate. Error/pending gates keep calling `registerFlow()` directly.
- [ ] `registerFlow`: after `startSession`, replace the 「準備ができました。」 toast with `showCoachMarks(coach, [{ side: "start", text: "写真・動画・音声を本文に入れる" }, { side: "end", text: "ロック・パスキー・復旧キー・使い方" }])`; keep the dismiss function; `lockVault` calls it.
- [ ] Empty hint: `updateEmptyHint()` hides `#empty-hint` unless the editor exists, is at a safe point, and `isEmptyDoc(editor.state.doc)`; called from `onCommittedChange`, `onCompositionState` (composing hides immediately), after `replaceDocument`/`applyRemoteDocument` (startSession, applyRemote, draft recovery), and after `showApp`.
- [ ] 「その他」: `variant: "menu"`; rows 保持/解除 (device), 今すぐロック (lock), パスキーを追加 (key), 復旧キーを更新 (refresh), 使い方 (help), セッションを終了 (logout, separator), アカウントを削除 (trash, danger). `help` → `runIntro("replay", { behind: [app] })` then focus the editor. Delete confirmation 「削除する」 uses `tone: "danger"`.
- [ ] Typecheck + `npm run check`; commit: `feat(web): wire onboarding, the list menu and the recovery key tools`.

---

### Task 8: Green and verification

- [ ] `bash scripts/dev.sh` (restart), `npx playwright test` → all pass (14 existing + 5 new).
- [ ] Screenshots at 1280×800 and 390×844, light and dark: gate, intro slides 1–4, recovery dialog, editor with hints, 「その他」.
- [ ] README: add onboarding to the implemented scope. Commit: `docs: note the Web onboarding`.
