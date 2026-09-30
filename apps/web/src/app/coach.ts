/**
 * One-time hints after registration (spec §4.1, §4.6 「新規作成」).
 *
 * The hints are non-modal and never take focus: the editor keeps the caret,
 * and a key press, any text input (voice input and some software keyboards
 * send no keydown), the start of an IME composition, a tap outside the hints,
 * or 「わかった」 dismisses them. Listeners observe in the capture phase and
 * never cancel an event, so IME and ProseMirror handling are untouched
 * (spec §4.5, §9).
 */

import { playExit } from "./motion.ts";

export interface CoachHint {
  /** `start` points at 添付 (bottom left), `end` at その他 (bottom right). */
  side: "start" | "end";
  text: string;
}

/** Shows `hints` in `layer`; returns an idempotent dismiss function. */
export function showCoachMarks(layer: HTMLElement, hints: CoachHint[]): () => void {
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "coach-ok";
  ok.textContent = "わかった";

  layer.replaceChildren(
    ...hints.map((hint, index) => {
      const bubble = document.createElement("div");
      bubble.className = `coach-bubble ${hint.side}`;
      const text = document.createElement("p");
      text.textContent = hint.text;
      bubble.append(text);
      if (index === hints.length - 1) bubble.append(ok);
      return bubble;
    }),
  );
  layer.hidden = false;

  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    document.removeEventListener("keydown", dismiss, true);
    document.removeEventListener("beforeinput", dismiss, true);
    document.removeEventListener("compositionstart", dismiss, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    void playExit(layer, "is-leaving");
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (!layer.contains(event.target as Node)) dismiss();
  };

  ok.addEventListener("click", dismiss);
  document.addEventListener("keydown", dismiss, true);
  document.addEventListener("beforeinput", dismiss, true);
  document.addEventListener("compositionstart", dismiss, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  return dismiss;
}
