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
