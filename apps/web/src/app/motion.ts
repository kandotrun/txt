/**
 * Motion helpers (spec §4.2).
 *
 * Every animation is declared in styles.css and applies only to layers outside
 * the editing surface. This module reads the reduced-motion preference and
 * sequences exit animations so an element is hidden once it has left.
 */

const pendingExits = new WeakMap<HTMLElement, () => void>();

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Adds `className` (a CSS exit animation) and hides the element when it ends.
 *
 * `animationend` never fires in a background tab or when motion is reduced, so
 * a timeout backs it up: the UI can never stay stuck half-visible. Layers must
 * also drop pointer events while leaving (styles.css) so a slow exit never
 * blocks the screen underneath.
 */
export function playExit(element: HTMLElement, className: string, timeoutMs = 400): Promise<void> {
  cancelExit(element);
  if (element.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = 0;
    const cleanup = (): void => {
      window.clearTimeout(timer);
      element.removeEventListener("animationend", onEnd);
      element.classList.remove(className);
      pendingExits.delete(element);
    };
    const finish = (): void => {
      cleanup();
      element.hidden = true;
      resolve();
    };
    const onEnd = (event: AnimationEvent): void => {
      if (event.target === element) finish();
    };
    element.addEventListener("animationend", onEnd);
    element.classList.add(className);
    timer = window.setTimeout(finish, prefersReducedMotion() ? 0 : timeoutMs);
    pendingExits.set(element, () => {
      cleanup();
      resolve();
    });
  });
}

/** Stops a pending exit and leaves the element visible (it is shown again). */
export function cancelExit(element: HTMLElement): void {
  pendingExits.get(element)?.();
}

/** Restarts an entrance animation declared on `className`. */
export function replayEnter(element: HTMLElement, className: string): void {
  element.classList.remove(className);
  // Reading layout flushes styles, so re-adding the class restarts the animation.
  void element.offsetWidth;
  element.classList.add(className);
}
