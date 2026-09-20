/**
 * Document block surgery for media insertion (spec §8).
 *
 * Kept as a pure function over the block list so the structural rules can be
 * unit-tested without a browser: a media block must always have an editable
 * text block on each side, and normal text edits never regenerate IDs.
 */

import type { Block } from "../../../../packages/protocol/src/document.ts";
import { newId } from "../../../../packages/protocol/src/document.ts";

export interface InsertionResult {
  blocks: Block[];
  /** Index of the inserted media block. */
  mediaIndex: number;
}

/**
 * Inserts a media block at `position` (0-based top-level index) and repairs the
 * neighbours. IDs of existing blocks are preserved; only new text blocks (which
 * by definition have no prior identity) receive fresh IDs.
 */
export function insertMediaBlock(
  blocks: Block[],
  options: { mediaId: string; position: number },
): InsertionResult {
  const result: Block[] = blocks.map((block) => ({ ...block }));
  const clamped = Math.max(0, Math.min(options.position, result.length));

  const mediaBlock: Block = { id: newId(), type: "media", mediaId: options.mediaId };
  result.splice(clamped, 0, mediaBlock);
  let mediaIndex = clamped;

  // A media block needs an editable text block before it.
  if (mediaIndex === 0 || result[mediaIndex - 1]?.type === "media") {
    result.splice(mediaIndex, 0, { id: newId(), type: "text", text: "" });
    mediaIndex += 1;
  }
  // …and after it.
  if (mediaIndex === result.length - 1 || result[mediaIndex + 1]?.type === "media") {
    result.splice(mediaIndex + 1, 0, { id: newId(), type: "text", text: "" });
  }

  return { blocks: result, mediaIndex };
}

/**
 * Inserts a media block at the caret, splitting the text block it sits in.
 *
 * A caret inside a text block splits it: the left part keeps its ID, the
 * right part gets a new one, and the media sits between them (spec §8). A
 * caret on a block boundary (`offset` 0 or the block's full length) simply
 * places the media before/after that block. Neighbour repair (an editable text
 * block on both sides) reuses `insertMediaBlock`.
 */
export function insertMediaAtCaret(
  blocks: Block[],
  options: { mediaId: string; index: number; offset: number },
): InsertionResult {
  const index = Math.max(0, Math.min(options.index, blocks.length));
  const target = blocks[index];
  if (index >= blocks.length || !target || target.type !== "text") {
    return insertMediaBlock(blocks, { mediaId: options.mediaId, position: index });
  }
  const offset = Math.max(0, Math.min(options.offset, target.text.length));
  if (offset === 0) {
    return insertMediaBlock(blocks, { mediaId: options.mediaId, position: index });
  }
  if (offset === target.text.length) {
    return insertMediaBlock(blocks, { mediaId: options.mediaId, position: index + 1 });
  }
  const result: Block[] = blocks.map((block) => ({ ...block }));
  const left: Block = { ...target, text: target.text.slice(0, offset) };
  const right: Block = { id: newId(), type: "text", text: target.text.slice(offset) };
  const mediaBlock: Block = { id: newId(), type: "media", mediaId: options.mediaId };
  result.splice(index, 1, left, mediaBlock, right);
  return { blocks: result, mediaIndex: index + 1 };
}

/** Removes a block, keeping the surrounding text blocks valid. */
export function removeBlock(blocks: Block[], index: number): Block[] {
  const result = blocks.filter((_, position) => position !== index);
  if (result.length === 0) {
    return [{ id: newId(), type: "text", text: "" }];
  }
  if (result[0]?.type === "media") {
    result.unshift({ id: newId(), type: "text", text: "" });
  }
  if (result[result.length - 1]?.type === "media") {
    result.push({ id: newId(), type: "text", text: "" });
  }
  return result;
}
