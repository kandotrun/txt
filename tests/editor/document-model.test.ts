/**
 * Editor model tests (spec §8, §9).
 *
 * jsdom-free: ProseMirror runs headless here, so the schema/round-trip rules
 * are verified without a browser. IME event order is covered by the E2E suite.
 */

import { describe, expect, it } from "vitest";

import {
  createEmptyDocument,
  referencedMediaIds,
  serializeDocument,
  validateDocument,
} from "../../packages/protocol/src/document.ts";
import type { DocumentModel, MediaInfo } from "../../packages/protocol/src/document.ts";

const MEDIA_ID = "33333333-3333-4333-8333-333333333333";

function mediaInfo(): MediaInfo {
  return {
    kind: "image",
    name: "photo.png",
    mime: "image/png",
    plainBytes: 1024,
    cryptoFormat: 1,
    chunkBytes: 1_048_576,
    chunkCount: 1,
    noncePrefix: "AAAAAAAAAAA",
    fileKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
}

describe("document model invariants (spec §8)", () => {
  it("empty document is exactly one empty text block", () => {
    const doc = createEmptyDocument();
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]?.type).toBe("text");
    expect(validateDocument(doc)).toEqual([]);
  });

  it("preserves LF, blank lines, trailing newlines, tabs and emoji", () => {
    const doc: DocumentModel = {
      schemaVersion: 1,
      blocks: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "text",
          text: "一行目\n\n二行目\r".replace("\r", "") + "\t全角　空白🐕‍🦺\n",
        },
      ],
      media: {},
    };
    expect(validateDocument(doc)).toEqual([]);
    const json = serializeDocument(doc);
    const round = JSON.parse(json) as DocumentModel;
    expect(round.blocks[0]?.type === "text" && round.blocks[0].text).toBe((doc.blocks[0] as { text: string }).text);
  });

  it("rejects a media block without surrounding text blocks", () => {
    const doc = {
      schemaVersion: 1,
      blocks: [{ id: "22222222-2222-4222-8222-222222222222", type: "media", mediaId: MEDIA_ID }],
      media: { [MEDIA_ID]: mediaInfo() },
    };
    const issues = validateDocument(doc);
    expect(issues.join(" ")).toMatch(/text block before/);
    expect(issues.join(" ")).toMatch(/text block after/);
  });

  it("accepts media surrounded by text blocks", () => {
    const doc: DocumentModel = {
      schemaVersion: 1,
      blocks: [
        { id: "11111111-1111-4111-8111-111111111111", type: "text", text: "前。" },
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "media",
          mediaId: MEDIA_ID,
        },
        { id: "44444444-4444-4444-8444-444444444444", type: "text", text: "" },
      ],
      media: { [MEDIA_ID]: mediaInfo() },
    };
    expect(validateDocument(doc)).toEqual([]);
    expect(referencedMediaIds(doc)).toEqual([MEDIA_ID]);
  });

  it("rejects CR in text (newlines must be LF)", () => {
    const doc: DocumentModel = {
      schemaVersion: 1,
      blocks: [{ id: "11111111-1111-4111-8111-111111111111", type: "text", text: "a\r\nb" }],
      media: {},
    };
    expect(validateDocument(doc).join(" ")).toMatch(/CR/);
  });

  it("rejects a media entry that is not referenced and vice versa", () => {
    const doc = {
      schemaVersion: 1,
      blocks: [
        { id: "11111111-1111-4111-8111-111111111111", type: "text", text: "" },
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "media",
          mediaId: "55555555-5555-4555-8555-555555555555",
        },
        { id: "44444444-4444-4444-8444-444444444444", type: "text", text: "" },
      ],
      media: { [MEDIA_ID]: mediaInfo() },
    };
    const issues = validateDocument(doc).join(" ");
    expect(issues).toMatch(/no such media entry/);
    expect(issues).toMatch(/not referenced/);
  });

  it("does not silently accept an unknown schemaVersion", () => {
    const doc = { schemaVersion: 2, blocks: [], media: {} };
    expect(validateDocument(doc).join(" ")).toMatch(/schemaVersion/);
  });

  it("keeps block IDs stable across serialization", () => {
    const doc: DocumentModel = {
      schemaVersion: 1,
      blocks: [
        { id: "11111111-1111-4111-8111-111111111111", type: "text", text: "keep" },
        { id: "22222222-2222-4222-8222-222222222222", type: "media", mediaId: MEDIA_ID },
        { id: "44444444-4444-4444-8444-444444444444", type: "text", text: "me" },
      ],
      media: { [MEDIA_ID]: mediaInfo() },
    };
    const round = JSON.parse(serializeDocument(doc)) as DocumentModel;
    expect(round.blocks.map((block: { id: string }) => block.id)).toEqual(doc.blocks.map((block: { id: string }) => block.id));
  });
});
