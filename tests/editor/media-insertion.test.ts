/**
 * Media insertion rules (spec §8): a media block must always have an editable
 * text block before and after it, and existing block IDs never change.
 */

import { describe, expect, it } from "vitest";

import { insertMediaAtCaret, insertMediaBlock, removeBlock } from "../../apps/web/src/app/document-blocks.ts";
import { pruneUnreferencedMedia, repairOrphanedMedia, validateDocument } from "../../packages/protocol/src/document.ts";
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

describe("insertMediaAtCaret (spec §8)", () => {
  it("splits the text block at the caret, keeping the left ID", () => {
    const { blocks, mediaIndex } = insertMediaAtCaret([textBlock(A, "あいうえお")], {
      mediaId: MEDIA_ID,
      index: 0,
      offset: 2,
    });
    expect(blocks.map((block) => block.type)).toEqual(["text", "media", "text"]);
    expect(blocks[0]?.id).toBe(A);
    expect(blocks[0]?.type === "text" && blocks[0].text).toBe("あい");
    expect(blocks[2]?.type === "text" && blocks[2].text).toBe("うえお");
    // The right half is a new ID, never the left one.
    expect(blocks[2]?.id).not.toBe(A);
    expect(mediaIndex).toBe(1);
    expect(validateDocument(toDocument(blocks))).toEqual([]);
  });

  it("places the media after the text when the caret is at the end", () => {
    const { blocks } = insertMediaAtCaret([textBlock(A, "末尾")], {
      mediaId: MEDIA_ID,
      index: 0,
      offset: 2,
    });
    expect(blocks.map((block) => block.type)).toEqual(["text", "media", "text"]);
    expect(blocks[0]?.type === "text" && blocks[0].text).toBe("末尾");
  });

  it("places the media before the text when the caret is at the start", () => {
    const { blocks } = insertMediaAtCaret([textBlock(A, "先頭")], {
      mediaId: MEDIA_ID,
      index: 0,
      offset: 0,
    });
    expect(blocks.map((block) => block.type)).toEqual(["text", "media", "text"]);
    // The media is not at the very top: an editable text block leads (§8).
    expect(blocks[0]?.type).toBe("text");
  });

  it("splits a middle block without touching its neighbours", () => {
    const { blocks } = insertMediaAtCaret(
      [textBlock(A, "前"), textBlock(B, "あいうえお"), textBlock(C, "後")],
      { mediaId: MEDIA_ID, index: 1, offset: 2 },
    );
    // 前 → あい → media → うえお → 後
    expect(blocks.map((block) => block.type)).toEqual(["text", "text", "media", "text", "text"]);
    const texts = blocks.filter((block) => block.type === "text").map((block) => (block as { text: string }).text);
    expect(texts).toEqual(["前", "あい", "うえお", "後"]);
    expect(blocks[0]?.id).toBe(A);
    expect(blocks[1]?.id).toBe(B);
    expect(blocks[4]?.id).toBe(C);
  });

  it("clamps an out-of-range offset instead of losing text", () => {
    const { blocks } = insertMediaAtCaret([textBlock(A, "短い")], {
      mediaId: MEDIA_ID,
      index: 0,
      offset: 99,
    });
    expect(validateDocument(toDocument(blocks))).toEqual([]);
    const texts = blocks.filter((block) => block.type === "text").map((block) => (block as { text: string }).text);
    expect(texts.join("")).toBe("短い");
  });
});

describe("orphaned media entries (spec §8)", () => {
  /** A valid document whose single media entry is referenced by a block. */
  function validWithMedia(): DocumentModel {
    return {
      schemaVersion: 1,
      blocks: [
        textBlock(A, ""),
        { id: B, type: "media", mediaId: MEDIA_ID },
        textBlock(C, ""),
      ],
      media: { [MEDIA_ID]: mediaInfo() },
    };
  }

  it("pruneUnreferencedMedia drops entries no block references", () => {
    const orphan = "66666666-6666-4666-8666-666666666666";
    const doc = validWithMedia();
    const pruned = pruneUnreferencedMedia({ ...doc, media: { ...doc.media, [orphan]: mediaInfo() } });
    expect(Object.keys(pruned.media)).toEqual([MEDIA_ID]);
    expect(validateDocument(pruned)).toEqual([]);
  });

  it("repairOrphanedMedia opens a document whose only defect is an orphaned entry", () => {
    const orphan = "66666666-6666-4666-8666-666666666666";
    const broken = {
      ...validWithMedia(),
      media: { [MEDIA_ID]: mediaInfo(), [orphan]: mediaInfo() },
    };
    const repaired = repairOrphanedMedia(broken);
    expect(repaired).not.toBeNull();
    expect(repaired?.dropped).toEqual([orphan]);
    expect(Object.keys(repaired?.document.media ?? {})).toEqual([MEDIA_ID]);
    expect(validateDocument(repaired?.document)).toEqual([]);
  });

  it("repairOrphanedMedia refuses any other damage", () => {
    // A media block pointing at a missing entry is not an orphaned entry:
    // repairing it would have to invent content, so it must keep failing.
    const broken = {
      schemaVersion: 1,
      blocks: [
        textBlock(A, ""),
        { id: B, type: "media", mediaId: "55555555-5555-4555-8555-555555555555" },
        textBlock(C, ""),
      ],
      media: {},
    };
    expect(repairOrphanedMedia(broken)).toBeNull();
  });

  it("repairOrphanedMedia passes through a valid document unchanged", () => {
    const doc = validWithMedia();
    const repaired = repairOrphanedMedia(doc);
    expect(repaired?.document).toEqual(doc);
    expect(repaired?.dropped).toEqual([]);
  });
});
