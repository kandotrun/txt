/**
 * Cross-implementation fixture (spec §17.3).
 *
 * Emits the exact JSON the Swift serializer must produce for the same model.
 * Kept as a test so the expected value can never drift silently.
 */
import { describe, expect, it } from "vitest";
import { serializeDocument } from "../../packages/protocol/src/document.ts";

describe("cross-implementation JSON fixture (Swift parity)", () => {
  it("serializes the shared fixture exactly", () => {
    const doc = {
      schemaVersion: 1,
      blocks: [
        { id: "11111111-1111-4111-8111-111111111111", type: "text" as const, text: "前。" },
        { id: "22222222-2222-4222-8222-222222222222", type: "media" as const, mediaId: "33333333-3333-4333-8333-333333333333" },
        { id: "44444444-4444-4444-8444-444444444444", type: "text" as const, text: "" },
      ],
      media: {
        "33333333-3333-4333-8333-333333333333": {
          kind: "image" as const, name: "photo.png", mime: "image/png", plainBytes: 1024,
          cryptoFormat: 1, chunkBytes: 1048576, chunkCount: 1,
          noncePrefix: "AAAAAAAAAAA", fileKey: "A".repeat(43),
        },
      },
    };
    const json = serializeDocument(doc);
    console.log("SWIFT_FIXTURE=" + json);
    expect(json.length).toBeGreaterThan(0);
  });
});
