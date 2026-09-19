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
