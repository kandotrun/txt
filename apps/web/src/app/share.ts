/**
 * 「txt を紹介する」 (spec §4.6).
 *
 * Shares the app itself: a fixed introduction and the URL of the current
 * origin. Document text, file names and anything decrypted never enter the
 * payload (spec §6.5). Dependencies are injected so every branch is testable.
 */

export const SHARE_TEXT = "メールアドレスなしで、1枚のテキストを。パスキーで開いて、端末で暗号化されるメモです。";

export type ShareOutcome = "shared" | "cancelled" | "copied";

export interface ShareDependencies {
  navigator: {
    share?: (data: ShareData) => Promise<void>;
    clipboard: { writeText: (text: string) => Promise<void> };
  };
  origin: string;
}

export function sharePayload(origin: string): ShareData {
  return { title: "txt", text: SHARE_TEXT, url: new URL("/", origin).href };
}

/**
 * Opens the OS share sheet when available; otherwise copies the link.
 * Dismissing the sheet is a cancel, not a failure. Clipboard errors propagate
 * so the caller can tell the user.
 */
export async function shareApp({ navigator, origin }: ShareDependencies): Promise<ShareOutcome> {
  const payload = sharePayload(origin);
  if (navigator.share) {
    try {
      await navigator.share(payload);
      return "shared";
    } catch (error) {
      if ((error as Error).name === "AbortError") return "cancelled";
      // Share sheet refused (policy, no activation): fall back to the link.
    }
  }
  await navigator.clipboard.writeText(payload.url!);
  return "copied";
}
