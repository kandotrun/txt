/** 「txt を紹介する」 (spec §4.6): only the app URL and a fixed introduction leave the page. */

import { describe, expect, it, vi } from "vitest";

import { SHARE_TEXT, sharePayload, shareApp } from "../../apps/web/src/app/share.ts";

const ORIGIN = "https://txt.2-38.com";

function fakeNavigator(options: { share?: (data: ShareData) => Promise<void> } = {}) {
  const writeText = vi.fn(async (_text: string) => undefined);
  return {
    navigator: { share: options.share, clipboard: { writeText } },
    writeText,
  };
}

describe("sharePayload", () => {
  it("carries the title, the fixed introduction and the app URL only", () => {
    expect(sharePayload(ORIGIN)).toEqual({ title: "txt", text: SHARE_TEXT, url: `${ORIGIN}/` });
  });

  it("uses the current origin, so every environment shares itself", () => {
    expect(sharePayload("http://localhost:8799").url).toBe("http://localhost:8799/");
  });
});

describe("shareApp", () => {
  it("opens the share sheet when Web Share is available", async () => {
    const share = vi.fn(async (_data: ShareData) => undefined);
    const { navigator, writeText } = fakeNavigator({ share });
    await expect(shareApp({ navigator, origin: ORIGIN })).resolves.toBe("shared");
    expect(share).toHaveBeenCalledWith(sharePayload(ORIGIN));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("treats a dismissed share sheet as a cancel, without copying", async () => {
    const share = vi.fn(async () => {
      throw new DOMException("dismissed", "AbortError");
    });
    const { navigator, writeText } = fakeNavigator({ share });
    await expect(shareApp({ navigator, origin: ORIGIN })).resolves.toBe("cancelled");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies the link when Web Share is unavailable", async () => {
    const { navigator, writeText } = fakeNavigator();
    await expect(shareApp({ navigator, origin: ORIGIN })).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it("falls back to copying when the share sheet fails for another reason", async () => {
    const share = vi.fn(async () => {
      throw new DOMException("not allowed", "NotAllowedError");
    });
    const { navigator, writeText } = fakeNavigator({ share });
    await expect(shareApp({ navigator, origin: ORIGIN })).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});
