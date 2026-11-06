/**
 * `txt-agent edit` reconstruction tests (spec §6.6 exception):
 * modelFromEditedText rebuilds a document model from the plaintext form
 * (plainTextForCopy format) the user edited in their own editor. Media
 * placeholders must match the base model's sequence exactly — in count,
 * order and label/name — or the edit is refused without a model.
 */

import { describe, expect, it } from "vitest";

import { toBase64Url } from "../../packages/protocol/src/base64url.ts";
import { plainTextForCopy } from "../../packages/protocol/src/document.ts";
import type { DocumentModel } from "../../packages/protocol/src/document.ts";
import { modelFromEditedText } from "../../apps/agent-mcp/src/vault.ts";
import {
  FIRST_TEXT_ID,
  MEDIA_BLOCK_ID,
  MEDIA_ID,
  TAIL_TEXT_ID,
  mediaModel,
  textOnlyModel,
} from "./stub-worker.ts";

const MEDIA2_ID = "8cf3a2b1-0000-4000-8000-000000000020";
const MEDIA2_BLOCK_ID = "8cf3a2b1-0000-4000-8000-000000000021";
const MID_TEXT_ID = "8cf3a2b1-0000-4000-8000-000000000022";
const END_TEXT_ID = "8cf3a2b1-0000-4000-8000-000000000023";
const SPLIT_TEXT_ID = "8cf3a2b1-0000-4000-8000-000000000024";

function mediaInfo(kind: "image" | "video", name: string, mime: string) {
  return {
    kind,
    name,
    mime,
    plainBytes: 100,
    cryptoFormat: 1,
    chunkBytes: 1_048_576,
    chunkCount: 1,
    noncePrefix: toBase64Url(new Uint8Array(8).fill(7)),
    fileKey: toBase64Url(new Uint8Array(32).fill(9)),
  };
}

function twoMediaModel(): DocumentModel {
  const base = mediaModel();
  return {
    schemaVersion: 1,
    blocks: [
      { id: FIRST_TEXT_ID, type: "text", text: "head" },
      { id: MEDIA_BLOCK_ID, type: "media", mediaId: MEDIA_ID },
      { id: MID_TEXT_ID, type: "text", text: "mid" },
      { id: MEDIA2_BLOCK_ID, type: "media", mediaId: MEDIA2_ID },
      { id: END_TEXT_ID, type: "text", text: "tail" },
    ],
    media: {
      ...base.media,
      [MEDIA2_ID]: mediaInfo("video", "clip.mp4", "video/mp4"),
    },
  };
}

describe("modelFromEditedText", () => {
  it("text-only edit replaces the text and keeps the block ID", () => {
    const base = textOnlyModel("hello");
    const result = modelFromEditedText(base, "hello world\nsecond line");
    expect("model" in result).toBe(true);
    if ("model" in result) {
      expect(result.model.blocks).toEqual([
        { id: FIRST_TEXT_ID, type: "text", text: "hello world\nsecond line" },
      ]);
      expect(result.model.media).toEqual({});
    }
    // The base model is not mutated.
    expect(base.blocks[0]).toMatchObject({ text: "hello" });
  });

  it("text-only round-trip with no changes is refused as unchanged", () => {
    const base = textOnlyModel("same text");
    const result = modelFromEditedText(base, plainTextForCopy(base));
    expect("reason" in result && result.reason).toBe("document is unchanged");
  });

  it("media is preserved: block ID, mediaId and the media dictionary survive an edit", () => {
    const base = mediaModel();
    const result = modelFromEditedText(base, "before v2\n[画像: photo.jpg]after v2");
    expect("model" in result).toBe(true);
    if ("model" in result) {
      expect(result.model.blocks).toEqual([
        { id: FIRST_TEXT_ID, type: "text", text: "before v2\n" },
        { id: MEDIA_BLOCK_ID, type: "media", mediaId: MEDIA_ID },
        { id: TAIL_TEXT_ID, type: "text", text: "after v2" },
      ]);
      expect(result.model.media).toEqual(base.media);
      expect(plainTextForCopy(result.model)).toBe("before v2\n[画像: photo.jpg]after v2");
    }
    expect(base.blocks[0]).toMatchObject({ text: "before\n" });
  });

  it("media round-trip with no changes is refused as unchanged", () => {
    const base = mediaModel();
    const result = modelFromEditedText(base, plainTextForCopy(base));
    expect("reason" in result && result.reason).toBe("document is unchanged");
  });

  it("a missing placeholder refuses the edit", () => {
    const result = modelFromEditedText(mediaModel(), "before\nafter");
    expect("reason" in result).toBe(true);
    if ("reason" in result) expect(result.reason).toContain("[画像: photo.jpg]");
  });

  it("a renamed placeholder refuses the edit", () => {
    const result = modelFromEditedText(mediaModel(), "before\n[画像: other.jpg]after");
    expect("reason" in result).toBe(true);
  });

  it("reordered placeholders refuse the edit", () => {
    const base = twoMediaModel();
    const edited = "head[動画: clip.mp4]mid[画像: photo.jpg]tail";
    const result = modelFromEditedText(base, edited);
    expect("reason" in result).toBe(true);
  });

  it("an extra (duplicated) placeholder refuses the edit", () => {
    const edited = "before\n[画像: photo.jpg]after[画像: photo.jpg]";
    const result = modelFromEditedText(mediaModel(), edited);
    expect("reason" in result).toBe(true);
    if ("reason" in result) expect(result.reason).toContain("extra");
  });

  it("two media in order round-trip with both placeholders matched", () => {
    const base = twoMediaModel();
    const edited = "head v2[画像: photo.jpg]mid v2[動画: clip.mp4]tail v2";
    const result = modelFromEditedText(base, edited);
    expect("model" in result).toBe(true);
    if ("model" in result) {
      expect(result.model.blocks.map((block) => block.id)).toEqual([
        FIRST_TEXT_ID,
        MEDIA_BLOCK_ID,
        MID_TEXT_ID,
        MEDIA2_BLOCK_ID,
        END_TEXT_ID,
      ]);
      expect(Object.keys(result.model.media).sort()).toEqual([MEDIA_ID, MEDIA2_ID].sort());
    }
  });

  it("a gap split across multiple text blocks merges into the first block's ID", () => {
    const base: DocumentModel = {
      schemaVersion: 1,
      blocks: [
        { id: FIRST_TEXT_ID, type: "text", text: "a" },
        { id: SPLIT_TEXT_ID, type: "text", text: "b" },
        { id: MEDIA_BLOCK_ID, type: "media", mediaId: MEDIA_ID },
        { id: TAIL_TEXT_ID, type: "text", text: "c" },
      ],
      media: mediaModel().media,
    };
    const result = modelFromEditedText(base, "ab edited[画像: photo.jpg]c");
    expect("model" in result).toBe(true);
    if ("model" in result) {
      expect(result.model.blocks).toEqual([
        { id: FIRST_TEXT_ID, type: "text", text: "ab edited" },
        { id: MEDIA_BLOCK_ID, type: "media", mediaId: MEDIA_ID },
        { id: TAIL_TEXT_ID, type: "text", text: "c" },
      ]);
    }
  });

  it("empty gaps keep empty text blocks with the original IDs", () => {
    const result = modelFromEditedText(mediaModel(), "[画像: photo.jpg]");
    expect("model" in result).toBe(true);
    if ("model" in result) {
      expect(result.model.blocks).toEqual([
        { id: FIRST_TEXT_ID, type: "text", text: "" },
        { id: MEDIA_BLOCK_ID, type: "media", mediaId: MEDIA_ID },
        { id: TAIL_TEXT_ID, type: "text", text: "" },
      ]);
    }
  });

  it("edited text containing CR is refused", () => {
    const result = modelFromEditedText(textOnlyModel("a"), "a\r\nb");
    expect("reason" in result).toBe(true);
    if ("reason" in result) expect(result.reason).toContain("CR");
  });

  it("a media block without dictionary info uses the fallback placeholder label", () => {
    const base: DocumentModel = {
      schemaVersion: 1,
      blocks: [
        { id: FIRST_TEXT_ID, type: "text", text: "x" },
        { id: MEDIA_BLOCK_ID, type: "media", mediaId: MEDIA_ID },
        { id: TAIL_TEXT_ID, type: "text", text: "y" },
      ],
      media: {},
    };
    const result = modelFromEditedText(base, "x2[メディア: ]y2");
    expect("model" in result).toBe(true);
    if ("model" in result) {
      expect(result.model.blocks[1]).toEqual({
        id: MEDIA_BLOCK_ID,
        type: "media",
        mediaId: MEDIA_ID,
      });
    }
  });
});
