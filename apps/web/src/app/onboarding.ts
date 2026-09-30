/**
 * Intro slides (spec §4.6 「紹介」).
 *
 * Renders the pure state from `onboarding-state.ts` into the static `#intro`
 * layer. The intro is a separate full-screen layer: it covers the gate before
 * registration and the editor when replayed from 「その他」, and it never touches
 * the editing surface (spec §4.2).
 */

import { icon } from "./icons.ts";
import { cancelExit, playExit, prefersReducedMotion, replayEnter } from "./motion.ts";
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
} from "./onboarding-state.ts";
import type { IntroMode, IntroSlideId, IntroState } from "./onboarding-state.ts";

/** `create`: start registration. `cancel`: back to the gate. `closed`: replay ended. */
export type IntroOutcome = "create" | "cancel" | "closed";

const SCRAMBLE_GLYPHS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789#%&*+=?";

let open = false;

/**
 * Shows the intro over `behind` (made inert meanwhile) and resolves with the
 * user's choice. A second call while the intro is open resolves immediately.
 */
export function runIntro(mode: IntroMode, options: { behind: HTMLElement[] }): Promise<IntroOutcome> {
  if (open) return Promise.resolve(mode === "register" ? "cancel" : "closed");
  open = true;

  const root = byId("intro");
  const progress = byId("intro-progress");
  const skipButton = byId<HTMLButtonElement>("intro-skip");
  const stage = byId("intro-stage");
  const art = byId("intro-art");
  const title = byId("intro-title");
  const body = byId("intro-body");
  const backButton = byId<HTMLButtonElement>("intro-back");
  const dots = byId("intro-dots");
  const nextButton = byId<HTMLButtonElement>("intro-next");

  return new Promise((resolve) => {
    let state: IntroState = createIntro(mode);
    // Bumped on every render and on close so a running scramble stops.
    let artGeneration = 0;
    const previousInert = options.behind.map((element) => element.inert);

    const render = (direction: "forward" | "back" | null): void => {
      const slide = currentSlide(state);
      const generation = ++artGeneration;
      progress.textContent = progressLabel(state);
      const dot = document.createElement("span");
      dot.className = "title-dot";
      dot.setAttribute("aria-hidden", "true");
      dot.textContent = ".";
      title.replaceChildren(slide.title, dot);
      body.textContent = slide.body;
      art.replaceChildren(buildArt(slide.id, () => generation === artGeneration));
      dots.replaceChildren(
        ...INTRO_SLIDES.map((_, index) => {
          const item = document.createElement("span");
          if (index === state.index) item.className = "is-current";
          return item;
        }),
      );
      backButton.textContent = secondaryLabel(state);
      nextButton.textContent = primaryLabel(state);
      skipButton.hidden = isLast(state);
      root.dataset.slide = slide.id;
      if (direction) {
        replayEnter(stage, direction === "forward" ? "is-entering-forward" : "is-entering-back");
      }
      // Hiding 「スキップ」 must not drop keyboard focus onto the page body.
      const focusLost = !root.contains(document.activeElement);
      if (focusLost || (skipButton.hidden && document.activeElement === skipButton)) {
        nextButton.focus({ preventScroll: true });
      }
    };

    const go = (target: IntroState, direction: "forward" | "back"): void => {
      if (target.index === state.index) return;
      state = target;
      render(direction);
    };

    const finish = (outcome: IntroOutcome): void => {
      open = false;
      artGeneration += 1;
      root.removeEventListener("keydown", onKey);
      nextButton.onclick = null;
      backButton.onclick = null;
      skipButton.onclick = null;
      options.behind.forEach((element, index) => {
        element.inert = previousInert[index] ?? false;
      });
      root.inert = true;
      void playExit(root, "is-leaving");
      resolve(outcome);
    };

    const leave = (): void => finish(mode === "register" ? "cancel" : "closed");

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        go(next(state), "forward");
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(back(state), "back");
      } else if (event.key === "Escape") {
        event.preventDefault();
        leave();
      }
    };

    nextButton.onclick = () => {
      if (isLast(state)) finish(mode === "register" ? "create" : "closed");
      else go(next(state), "forward");
    };
    backButton.onclick = () => {
      if (isFirst(state)) leave();
      else go(back(state), "back");
    };
    skipButton.onclick = () => go(skip(state), "forward");
    root.addEventListener("keydown", onKey);

    options.behind.forEach((element) => {
      element.inert = true;
    });
    cancelExit(root);
    root.inert = false;
    root.hidden = false;
    replayEnter(root, "is-entering");
    render(null);
    // Focus the heading first so a screen reader starts with the slide title.
    title.focus({ preventScroll: true });
  });
}

/** Builds the typographic illustration for one slide; CSS runs its animation. */
function buildArt(id: IntroSlideId, alive: () => boolean): HTMLElement {
  // `art--<id>` (a modifier) must not collide with part classes like `.art-sheet`.
  const art = element("div", `art art--${id}`);
  switch (id) {
    case "sheet": {
      const sheet = element("div", "art-sheet");
      ["ここから書く。", "空白も改行も", "そのまま残る。"].forEach((line, index) => {
        sheet.append(element("span", `art-line l${index + 1}`, line));
      });
      sheet.append(element("span", "art-caret"));
      art.append(sheet);
      break;
    }
    case "passkey": {
      const key = element("span", "art-key");
      key.append(icon("key"));
      art.append(element("span", "art-password", "••••••••"), key);
      break;
    }
    case "encrypt": {
      const cipher = element("span", "art-cipher", "こんにちは");
      art.append(element("span", "art-plain", "こんにちは"), element("span", "art-arrow", "→"), cipher);
      scramble(cipher, "a8F#q2Zk", alive);
      break;
    }
    case "recovery": {
      const box = element("div", "art-key-box");
      box.append(element("code", "art-recovery-key", "TXT1.k7Qe…Zp3w"));
      const copy = element("span", "art-copy");
      copy.append(icon("copy"));
      art.append(box, copy);
      break;
    }
  }
  return art;
}

/**
 * Turns the plaintext into ciphertext glyphs from left to right. Decorative
 * only: `Math.random` is fine here and no real data is involved.
 */
function scramble(target: HTMLElement, finalText: string, alive: () => boolean): void {
  if (prefersReducedMotion()) {
    target.textContent = finalText;
    target.classList.add("is-sealed");
    return;
  }
  const delayMs = 550;
  const durationMs = 900;
  let start: number | null = null;
  const frame = (now: number): void => {
    if (!alive() || !target.isConnected) return;
    start ??= now;
    const progress = (now - start - delayMs) / durationMs;
    if (progress < 0) {
      window.requestAnimationFrame(frame);
      return;
    }
    if (progress >= 1) {
      target.textContent = finalText;
      target.classList.add("is-sealed");
      return;
    }
    const settled = Math.floor(progress * finalText.length);
    let text = finalText.slice(0, settled);
    for (let index = settled; index < finalText.length; index++) {
      text += SCRAMBLE_GLYPHS[Math.floor(Math.random() * SCRAMBLE_GLYPHS.length)];
    }
    target.textContent = text;
    window.requestAnimationFrame(frame);
  };
  window.requestAnimationFrame(frame);
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}
