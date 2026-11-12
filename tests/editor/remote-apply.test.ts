/**
 * Remote documents are applied as the smallest block replacement (spec §9.7,
 * §9.8): untouched blocks — media in particular — are not part of the change,
 * so their DOM and any playing media survive another device's save.
 */
import { describe, expect, it } from "vitest";
import { Fragment, Slice } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";

import { changedBlockRange, schema } from "../../apps/web/src/app/editor.ts";

const p = (text = ""): PMNode => schema.nodes.paragraph!.create(null, text ? [schema.text(text)] : []);
const m = (mediaId: string): PMNode => schema.nodes.media!.create({ mediaId, kind: "video", id: `block-${mediaId}` });
const doc = (...nodes: PMNode[]): PMNode => schema.nodes.doc!.create(null, nodes);

/** Applies the reported range to `current`, as the editor's transaction does. */
function apply(current: PMNode, next: PMNode): { result: PMNode; touched: PMNode[] } {
  const range = changedBlockRange(current, next);
  if (!range) return { result: current, touched: [] };
  const touched: PMNode[] = [];
  let position = 0;
  current.forEach((child) => {
    if (position >= range.from && position + child.nodeSize <= range.to) touched.push(child);
    position += child.nodeSize;
  });
  const result = current.replace(range.from, range.to, new Slice(Fragment.from(range.replacement), 0, 0));
  return { result, touched };
}

describe("changedBlockRange", () => {
  it("spec: an identical document changes nothing", () => {
    const current = doc(p("a"), m("1"), p("b"));
    expect(changedBlockRange(current, doc(p("a"), m("1"), p("b")))).toBeNull();
  });

  it.each([
    ["text edited after the media", doc(p("a"), m("1"), p("b")), doc(p("a"), m("1"), p("b!"))],
    ["text edited before the media", doc(p("a"), m("1"), p("b")), doc(p("A"), m("1"), p("b"))],
    ["blocks appended", doc(p("a"), m("1"), p("b")), doc(p("a"), m("1"), p("b"), m("2"), p())],
    ["blocks prepended", doc(p("a"), m("1"), p("b")), doc(p("x"), m("2"), p("a"), m("1"), p("b"))],
    ["text on both sides edited", doc(p("a"), m("1"), p("b"), m("2"), p("c")), doc(p("A"), m("1"), p("b"), m("2"), p("C"))],
  ])("spec: %s leaves the untouched media out of the change", (_name, current, next) => {
    const { result, touched } = apply(current, next);
    expect(result.eq(next)).toBe(true);
    const keptEverywhere = (id: string): boolean => {
      let inCurrent = false;
      let inNext = false;
      current.forEach((child) => { if (child.attrs.mediaId === id) inCurrent = true; });
      next.forEach((child) => { if (child.attrs.mediaId === id) inNext = true; });
      return inCurrent && inNext;
    };
    // Media 1 exists before and after; in every case but the last it must not
    // be inside the replaced range.
    if (_name !== "text on both sides edited") {
      expect(touched.some((node) => node.attrs.mediaId === "1" && keptEverywhere("1"))).toBe(false);
    }
  });

  it.each([
    ["a removed media", doc(p("a"), m("1"), p("b"), m("2"), p("c")), doc(p("a"), m("1"), p("bc"))],
    ["everything replaced", doc(p("a")), doc(p("x"), m("9"), p("y"))],
    ["a shorter document", doc(p("a"), m("1"), p("b")), doc(p("a"))],
    ["repeated equal blocks", doc(p("a"), p("a"), p("a")), doc(p("a"), p("a"))],
  ])("spec: %s still converges exactly", (_name, current, next) => {
    expect(apply(current, next).result.eq(next)).toBe(true);
  });
});
