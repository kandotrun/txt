/** Real-browser large-file transfer. Only a local Worker and synthetic files. */
import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installVirtualAuthenticator } from "./helpers/authenticator.ts";
import { registerViaOnboarding } from "./helpers/onboarding.ts";

async function openSheet(page: Page): Promise<void> {
  await installVirtualAuthenticator(page, { hasPrf: true });
  await page.goto("/");
  await registerViaOnboarding(page);
  await expect(page.locator("#editor-host .ProseMirror")).toBeVisible({ timeout: 30000 });
}

// PNGの後ろにパディングを置く。上限サイズの実ファイルだが巨大Bufferは作らない。
async function makeImage(path: string, bytes: number): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.write(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2NkYGD4z0AEYBxVSFJIYWBgYPgPjQMAoBUGb0kC9XkAAAAASUVORK5CYII=",
      "base64",
    ));
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
}

const localOnly = new URL(process.env.TXT_BASE_URL ?? "http://localhost:8799");
if (!["localhost", "127.0.0.1"].includes(localOnly.hostname)) {
  throw new Error("large-media E2E may only run against a local synthetic account");
}

test("spec: 100MB画像を暗号化分割アップロードし、再読み込み後も表示できる", async ({ page }) => {
  test.setTimeout(600_000);
  const directory = await mkdtemp(join(tmpdir(), "txt-large-media-"));
  const path = join(directory, "image-100MB.png");
  try {
    await makeImage(path, 100_000_000);
    await openSheet(page);
    const parts: number[] = [];
    page.on("response", (response) => {
      if (/\/parts\/\d+$/.test(new URL(response.url()).pathname) && response.status() === 200) {
        parts.push(Number(new URL(response.url()).pathname.split("/").at(-1)));
      }
    });
    const saved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/document" &&
      response.request().method() === "PUT" && response.status() === 200,
      { timeout: 540_000 },
    );
    await page.locator("#file-input").setInputFiles(path);
    await saved;
    await expect(page.locator("#sync-status")).toHaveAttribute("data-state", /saved|idle/);
    expect(parts).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const image = page.locator("#editor-host img");
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
      timeout: 120_000,
    }).toBe(8);

    // 新clientIdになる再読込では、Service Workerとの解除ハンドシェイクを待って表示する。
    await page.reload();
    await expect(page.locator("#app")).toBeVisible({ timeout: 30000 });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
      timeout: 120_000,
    }).toBe(8);
    await expect(image).toHaveAttribute("src", /\/_local\/media\//);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
