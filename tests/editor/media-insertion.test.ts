/**
 * Media insertion rules (spec §8): a media block must always have an editable
 * text block before and after it, and existing block IDs never change.
 */

import { describe, expect, it } from "vitest";

import { insertMediaBlock, removeBlock } from "../../apps/web/src/app/document-blocks.ts";
import { validateDocument } from "../../packages/protocol/src/document.ts";
import type { Block, DocumentModel, MediaInfo } from "../../packages/protocol/src/document.ts";

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

function textBlock(id: string, text: string): Block {
  return { id, type: "text", text };
}

function toDocument(blocks: Block[]): DocumentModel {
  return { schemaVersion: 1, blocks, media: { [MEDIA_ID]: mediaInfo() } };
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "44444444-4444-4444-8444-444444444444";

describe("insertMediaBlock (spec §8)", () => {
  it("inserts into an empty document with text on both sides", () => {
    const { blocks } = insertMediaBlock([textBlock(A, "")], { mediaId: MEDIA_ID, position: 0 });
    expect(validateDocument(toDocument(blocks))).toEqual([]);
    expect(blocks.map((block) => block.type)).toEqual(["text", "media", "text"]);
  });

  it("keeps a leading text block when inserting at index 0", () => {
    const { blocks } = insertMediaBlock([textBlock(A, "本文")], { mediaId: MEDIA_ID, position: 0 });
    expect(blocks.map((block) => block.type)).toEqual(["text", "media", "text"]);
    expect(validateDocument(toDocument(blocks))).toEqual([]);
  });

  it("places media between two existing text blocks", () => {
    const { blocks } = insertMediaBlock(
      [textBlock(A, "前"), textBlock(B, "後")],
      { mediaId: MEDIA_ID, position: 1 },
    );
    expect(blocks.map((block) => block.type)).toEqual(["text", "media", "text"]);
    expect(validateDocument(toDocument(blocks))).toEqual([]);
  });

  it("inserts at the end and appends a trailing text block", () => {
    const { blocks } = insertMediaBlock([textBlock(A, "前")], { mediaId: MEDIA_ID, position: 1 });
    expect(blocks.map((block) => block.type)).toEqual(["text", "media", "text"]);
    expect(validateDocument(toDocument(blocks))).toEqual([]);
  });

  it("repairs a media-to-media neighbour", () => {
    const withTwo = insertMediaBlock(
      insertMediaBlock([textBlock(A, "")], { mediaId: MEDIA_ID, position: 0 }).blocks,
      { mediaId: MEDIA_ID, position: 2 },
    ).blocks;
    // text, media, text, media, text
    expect(withTwo.map((block) => block.type)).toEqual(["text", "media", "text", "media", "text"]);
    expect(validateDocument(toDocument(withTwo))).toEqual([]);
  });

  it("never regenerates the IDs of existing blocks", () => {
    const { blocks } = insertMediaBlock(
      [textBlock(A, "前"), textBlock(B, "後")],
      { mediaId: MEDIA_ID, position: 1 },
    );
    const ids = blocks.map((block) => block.id);
    expect(ids).toContain(A);
    expect(ids).toContain(B);
    // Existing text blocks keep their IDs; only the media block is new here
    // (B already provides the trailing text block).
    expect(ids).toEqual([A, blocks[1]?.id, B]);
    expect(blocks[1]?.type).toBe("media");
  });

  it("preserves LF, tabs and emoji in neighbouring text", () => {
    const text = "行1\n\n行3\t全角　🐕‍🦺\n";
    const { blocks } = insertMediaBlock([textBlock(A, text)], { mediaId: MEDIA_ID, position: 1 });
    const preserved = blocks.find((block) => block.id === A);
    expect(preserved?.type === "text" && preserved.text).toBe(text);
    expect(validateDocument(toDocument(blocks))).toEqual([]);
  });

  it("clamps an out-of-range position", () => {
    const { blocks } = insertMediaBlock([textBlock(A, "x")], { mediaId: MEDIA_ID, position: 99 });
    expect(validateDocument(toDocument(blocks))).toEqual([]);
    expect(blocks.map((block) => block.type)).toEqual(["text", "media", "text"]);
  });

  it("inserts into a document that already holds a media block", () => {
    const one = insertMediaBlock([textBlock(A, "")], { mediaId: MEDIA_ID, position: 0 }).blocks;
    const two = insertMediaBlock(one, { mediaId: MEDIA_ID, position: 1 }).blocks;
    expect(validateDocument(toDocument(two))).toEqual([]);
    const types = two.map((block) => block.type);
    expect(types[0]).toBe("text");
    expect(types[types.length - 1]).toBe("text");
  });
});

describe("removeBlock", () => {
  it("keeps a single empty text block when everything is removed", () => {
    const blocks = removeBlock([textBlock(A, "")], 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
  });

  it("re-adds a surrounding text block when a media becomes terminal", () => {
    const inserted = insertMediaBlock([textBlock(A, "x")], { mediaId: MEDIA_ID, position: 1 }).blocks;
    // Remove the trailing text block; the media must not become the last block.
    const trimmed = removeBlock(inserted, inserted.length - 1);
    expect(trimmed[trimmed.length - 1]?.type).toBe("text");
    void B;
    void C;
  });
});
