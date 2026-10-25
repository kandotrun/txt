/**
 * i18n foundation (spec §4.7): Japanese is the source string and the
 * default in non-browser environments; the browser language auto-detects
 * the locale, a saved choice wins over detection, placeholders are
 * substituted in both languages, and the date locale follows the UI.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { getLocale, localeTag, t } from "../../apps/web/src/app/i18n.ts";
import { INTRO_SLIDES, createIntro, primaryLabel } from "../../apps/web/src/app/onboarding-state.ts";
import { SHARE_TEXT } from "../../apps/web/src/app/share.ts";

describe("i18n (default environment)", () => {
  it("defaults to Japanese outside a browser", () => {
    expect(getLocale()).toBe("ja");
    expect(localeTag()).toBe("ja-JP");
  });

  it("returns the Japanese source unchanged, with placeholders filled", () => {
    expect(t("閉じる")).toBe("閉じる");
    expect(t("トークン期限 {date}", { date: "2026/11/24" })).toBe("トークン期限 2026/11/24");
    expect(
      t("{name}（{state}、{tokenNote}）", { name: "Clio", state: "有効", tokenNote: "トークンなし" }),
    ).toBe("Clio（有効、トークンなし）");
  });

  it("keeps onboarding labels and share text in Japanese by default", () => {
    const state = createIntro("register");
    expect(primaryLabel(state)).toBe("次へ");
    expect(INTRO_SLIDES[0]?.title).toBe("1枚だけ");
    expect(SHARE_TEXT).toContain("メールアドレスなしで、1枚のテキストを。");
  });
});

describe("i18n (browser language detection)", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
    vi.resetModules();
  });

  function stubBrowser(options: { language: string; stored?: string | null }): void {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => options.stored ?? null,
        setItem: () => undefined,
      },
      location: { reload: () => undefined },
    };
    // Node exposes `navigator` as a getter-only global; define it outright.
    Object.defineProperty(globalThis, "navigator", {
      value: { languages: [options.language], language: options.language },
      configurable: true,
    });
  }

  it("detects English from the browser language and translates", async () => {
    stubBrowser({ language: "en-US" });
    vi.resetModules();
    const mod = await import("../../apps/web/src/app/i18n.ts");
    expect(mod.getLocale()).toBe("en");
    expect(mod.localeTag()).toBe("en-US");
    expect(mod.t("閉じる")).toBe("Close");
    expect(mod.t("トークン期限 {date}", { date: "Nov 24, 2026" })).toBe("Token expires Nov 24, 2026");
    expect(
      mod.t("{name}（{state}、{tokenNote}）", { name: "Clio", state: "Active", tokenNote: "No token" }),
    ).toBe("Clio (Active, No token)");
  });

  it("detects Japanese from the browser language", async () => {
    stubBrowser({ language: "ja-JP" });
    vi.resetModules();
    const mod = await import("../../apps/web/src/app/i18n.ts");
    expect(mod.getLocale()).toBe("ja");
    expect(mod.t("閉じる")).toBe("閉じる");
  });

  it("lets a saved choice win over the browser language", async () => {
    stubBrowser({ language: "ja-JP", stored: "en" });
    vi.resetModules();
    const mod = await import("../../apps/web/src/app/i18n.ts");
    expect(mod.getLocale()).toBe("en");
  });
});
