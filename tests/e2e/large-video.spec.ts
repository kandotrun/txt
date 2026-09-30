/** Opt-in real-browser transfer of a large synthetic MP4; local accounts only. */
import { execFileSync } from "node:child_process";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { mediaCipherLength } from "../../packages/protocol/src/crypto.ts";
import { installVirtualAuthenticator } from "./helpers/authenticator.ts";
import { registerViaOnboarding } from "./helpers/onboarding.ts";

const base = new URL(process.env.TXT_BASE_URL ?? "http://localhost:8799");
if (!["localhost", "127.0.0.1"].includes(base.hostname)) {
  throw new Error("large-video E2E may only run against a local synthetic account");
}
const enabled = process.env.TXT_LARGE_VIDEO_SMOKE === "1";
const plainBytes = Number(process.env.TXT_LARGE_VIDEO_BYTES ?? "600000000");
if (!Number.isSafeInteger(plainBytes) || plainBytes <= 512 * 1024 * 1024 || plainBytes > 10_000_000_000) {
  throw new Error("large-video fixture must exceed the old 512MiB limit and be at most 10GB");
}

// Long transfers must not accumulate ciphertext request bodies in a trace.
test.use({ trace: "off" });

async function makeVideo(path: string, size: number): Promise<void> {
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=32x32:r=10:d=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path,
  ], { timeout: 30_000 });
  const originalBytes = (await stat(path)).size;
  const freeBytes = size - originalBytes;
  if (freeBytes < 16) throw new Error("fixture has no room for a free box");
  // A 64-bit ISO-BMFF free box makes this a valid MP4 of the exact test size.
  // Padding is sparse on disk, but encryption and upload still consume every byte.
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write("free", 4, "ascii");
  header.writeBigUInt64BE(BigInt(freeBytes), 8);
  const handle = await open(path, "r+");
  try {
    await handle.write(header, 0, header.length, originalBytes);
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
  expect((await stat(path)).size).toBe(size);
}

test("spec: 大容量MP4を全量暗号化転送し、再読み込み・64bit位置のRange復号もできる", async ({ page }) => {
  test.skip(!enabled, "Set TXT_LARGE_VIDEO_SMOKE=1 for the expensive local transfer smoke");
  test.setTimeout(7_200_000);
  const directory = await mkdtemp(join(tmpdir(), "txt-large-video-"));
  const path = join(directory, "video.mp4");
  try {
    await makeVideo(path, plainBytes);
    await installVirtualAuthenticator(page, { hasPrf: true });
    await page.goto("/");
    await registerViaOnboarding(page);
    await expect(page.locator("#editor-host .ProseMirror")).toBeVisible({ timeout: 30_000 });
    const parts = new Set<number>();
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      if (/\/parts\/\d+$/.test(pathname) && response.status() === 200) {
        parts.add(Number(pathname.split("/").at(-1)));
        if (parts.size % 100 === 0) console.log(`large-video: ${parts.size} accepted parts`);
      }
    });
    const saved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/document" &&
      response.request().method() === "PUT" && response.status() === 200,
      { timeout: 7_000_000 },
    );
    await page.locator("#file-input").setInputFiles(path);
    await saved;
    await expect(page.locator("#sync-status")).toHaveAttribute("data-state", /saved|idle/, { timeout: 30_000 });
    const expectedParts = Math.ceil(mediaCipherLength(plainBytes) / 8_388_736);
    expect([...parts].sort((a, b) => a - b)).toEqual(Array.from({ length: expectedParts }, (_, i) => i + 1));

    const video = page.locator("#editor-host video");
    await expect(video).toHaveAttribute("src", /\/_local\/media\//, { timeout: 30_000 });
    // The app deliberately uses preload=none; request metadata explicitly.
    await video.evaluate((element: HTMLVideoElement) => { element.preload = "metadata"; element.load(); });
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth), {
      timeout: 120_000,
    }).toBe(32);
    await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play(); });
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), {
      timeout: 30_000,
    }).toBeGreaterThan(0);
    await video.evaluate((element: HTMLVideoElement) => element.pause());
    await page.reload();
    await expect(page.locator("#app")).toBeVisible({ timeout: 30_000 });
    await expect(video).toHaveAttribute("src", /\/_local\/media\//, { timeout: 30_000 });
    // The app deliberately uses preload=none; request metadata explicitly.
    await video.evaluate((element: HTMLVideoElement) => { element.preload = "metadata"; element.load(); });
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth), {
      timeout: 120_000,
    }).toBe(32);

    // All these positions lie inside the zero-filled free box. A >4GiB range
    // exercises uint64 AAD and offsets against ciphertext actually uploaded.
    const start = plainBytes > 2 ** 32 + 64 ? 2 ** 32 + 17 : plainBytes - 64;
    const range = await video.evaluate(async (element: HTMLVideoElement, position: number) => {
      const response = await fetch(element.src, { headers: { range: `bytes=${position}-${position + 31}` } });
      return { status: response.status, range: response.headers.get("content-range"), bytes: [...new Uint8Array(await response.arrayBuffer())] };
    }, start);
    expect(range.status).toBe(206);
    expect(range.range).toBe(`bytes ${start}-${start + 31}/${plainBytes}`);
    expect(range.bytes).toEqual(Array(32).fill(0));
    console.log(`large-video verified: ${plainBytes} plaintext bytes, ${expectedParts} accepted parts, reload and range ${start}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
