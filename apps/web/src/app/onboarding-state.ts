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
