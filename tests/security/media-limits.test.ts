import { describe, expect, it } from "vitest";

import { BLOB_FALLBACK_MAX_BYTES, PART_BYTES, classify } from "../../apps/web/src/app/media.ts";
import { mediaChunkCount, mediaCipherLength } from "../../packages/protocol/src/crypto.ts";

// 容量判定はFileのメタデータだけを読む。10GBをテスト用にメモリー確保しない。
const file = (type: string, size: number): File => ({ type, size } as File);

describe("spec: Web添付の容量上限", () => {
  it.each(["image/jpeg", "image/png", "image/webp", "image/heic"])(
    "%s は100MBちょうどまで受け入れ、1バイト超過を拒否する",
    (type) => {
      expect(classify(file(type, 100_000_000))).toBe("image");
      expect(() => classify(file(type, 100_000_001))).toThrow("画像は100MBまでです。");
    },
  );

  it.each(["video/mp4", "video/webm", "video/quicktime"])(
    "%s は10GBちょうどまで受け入れ、1バイト超過を拒否する",
    (type) => {
      expect(classify(file(type, 10_000_000_000))).toBe("video");
      expect(() => classify(file(type, 10_000_000_001))).toThrow("動画は10GBまでです。");
    },
  );

  it("音声100MiBと小容量Blob復号20MiBは変更しない", () => {
    expect(classify(file("audio/mpeg", 104_857_600))).toBe("audio");
    expect(() => classify(file("audio/mpeg", 104_857_601))).toThrow("音声は100MiBまでです。");
    expect(BLOB_FALLBACK_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(() => classify(file("image/svg+xml", 100))).toThrow("この形式のファイルは添付できません。");
  });

  it("10GBは64bit容量のまま1193パートに分割できる", () => {
    expect(mediaChunkCount(10_000_000_000)).toBe(9537);
    const ciphertext = mediaCipherLength(10_000_000_000);
    expect(ciphertext).toBe(10_000_152_592);
    expect(Math.ceil(ciphertext / PART_BYTES)).toBe(1193);
    expect(ciphertext % PART_BYTES).toBe(779_280);
    // アカウント全体の10GiB枠は変更せず、暗号化の増分も含めて収まる。
    expect(ciphertext).toBeLessThan(10 * 1024 ** 3);
  });
});
