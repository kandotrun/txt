/** Empty-state hint trigger (spec §4.1): only a single empty text block is empty. */

import { describe, expect, it } from "vitest";

import { isEmptyDoc, schema } from "../../apps/web/src/app/editor.ts";

const paragraph = (text?: string) =>
  schema.nodes.paragraph!.create(null, text ? schema.text(text) : null);
const doc = (...blocks: ReturnType<typeof paragraph>[]) => schema.nodes.doc!.create(null, blocks);

describe("isEmptyDoc", () => {
  it("is true for a single empty paragraph", () => {
    expect(isEmptyDoc(doc(paragraph()))).toBe(true);
  });

  it("is false once there is any text, including whitespace", () => {
    expect(isEmptyDoc(doc(paragraph(" ")))).toBe(false);
    expect(isEmptyDoc(doc(paragraph("a")))).toBe(false);
  });

  it("is false with media or several blocks", () => {
    const media = schema.nodes.media!.create({ mediaId: "m", kind: "image", id: "b" });
    expect(isEmptyDoc(schema.nodes.doc!.create(null, [paragraph(), media, paragraph()]))).toBe(false);
    expect(isEmptyDoc(doc(paragraph(), paragraph()))).toBe(false);
  });
});
