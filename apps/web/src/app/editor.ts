/**
 * Editor adapter (spec §9.2, §9.3, §9.4, §8.1).
 *
 * Restricted ProseMirror schema: an empty mark set, `text` blocks and
 * indivisible `media` blocks. Text blocks hold `text*` and treat whitespace/LF
 * literally. Enter/Shift+Enter both produce LF and never create headings or
 * lists.
 *
 * IME safety (mandatory):
 * - EditorView is kept for the lifetime of the editing surface; no per-input
 *   EditorState/EditorView recreation and no wholesale re-import from JSON.
 * - The engine's DOM is never touched via innerHTML/replaceChildren.
 * - Composition state is observed via multiple signals (composition events,
 *   InputEvent.isComposing, KeyboardEvent.isComposing, view.composing).
 * - `compositionend` is not treated as an insertion command: the committed
 *   result is read from the engine's latest model after settling.
 */

import { Schema } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";

import { newId, SCHEMA_VERSION } from "../../../../packages/protocol/src/document.ts";
import type { Block, DocumentModel, MediaInfo } from "../../../../packages/protocol/src/document.ts";
import { insertMediaAtCaret, insertMediaBlock } from "./document-blocks.ts";

export const MEDIA_NODE = "media";

/**
 * Restricted schema (spec §9.2): an empty mark set, `block` paragraphs and
 * indivisible `media` blocks.
 *
 * The inline node MUST be named `text` (ProseMirror reserves it); the block
 * node is therefore `paragraph` even though the wire model calls it a "text
 * block". Enter/Shift+Enter insert LF inside the paragraph instead of splitting
 * blocks.
 */
export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    // The inline text node MUST be declared as `text` (ProseMirror reserves the
    // name). It carries no marks in this app.
    text: { inline: true, group: "inline" },
    paragraph: {
      content: "text*",
      group: "block",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
      // Text blocks keep their whitespace and LF exactly.
      whitespace: "pre",
    },
    media: {
      inline: false,
      group: "block",
      atom: true,
      selectable: true,
      attrs: { mediaId: {}, kind: {}, id: {} },
      toDOM: (node) => [
        "div",
        {
          class: "txt-media",
          "data-media-id": node.attrs.mediaId as string,
          "data-media-kind": node.attrs.kind as string,
        },
        0,
      ],
      parseDOM: [
        {
          tag: "div[data-media-id]",
          getAttrs: (dom) => ({
            mediaId: (dom as HTMLElement).getAttribute("data-media-id"),
            kind: (dom as HTMLElement).getAttribute("data-media-kind") ?? "image",
          }),
        },
      ],
    },
  },
  marks: {},
});

export type CompositionState = "idle" | "composing" | "settling";

export interface EditorCallbacks {
  /** Called after the committed model changed (debounced by the sync layer). */
  onCommittedChange: () => void;
  /** Called when the composition state machine transitions. */
  onCompositionState: (state: CompositionState) => void;
  /** Files dropped or pasted; the sync layer tracks positions. */
  onFilesDropped: (files: File[], position: number) => void;
}

export interface EditorOptions {
  /** Provides current media metadata for rendering. */
  getMediaInfo: (mediaId: string) => MediaInfo | undefined;
  /** Builds the DOM for one media element; must never autoplay. */
  renderMedia: (mediaId: string, info: MediaInfo, blockId: string) => HTMLElement;
}

/**
 * Creates the editing surface. The caller owns document load/save; this class
 * only manages the engine, IME state and plaintext semantics.
 */
export class Editor {
  private readonly view: EditorView;
  private readonly options: EditorOptions;
  private compositionState: CompositionState = "idle";
  private readonly callbacks: EditorCallbacks;
  private externalApplyDepth = 0;
  private settlingTimer: number | null = null;
  private settlingGeneration = 0;

  constructor(host: HTMLElement, callbacks: EditorCallbacks, options: EditorOptions) {
    this.callbacks = callbacks;
    this.options = options;

    const state = EditorState.create({
      schema,
      doc: buildEmptyDoc(),
      plugins: [
        history(),
        keymap({
          // Cmd/Ctrl+S records a save request; it does not force IME commit
          // (spec §9.4).
          "Mod-s": () => {
            this.callbacks.onCommittedChange();
            return true;
          },
          Enter: (state, dispatch) => insertLineBreak(state, dispatch),
          "Shift-Enter": (state, dispatch) => insertLineBreak(state, dispatch),
          "Mod-z": undo,
          "Mod-y": redo,
          "Shift-Mod-z": redo,
        }),
        keymap(baseKeymap),
        new Plugin({
          props: {
            handleDOMEvents: {
              compositionstart: () => {
                this.setCompositionState("composing");
                return false; // observation only; never block the engine
              },
              compositionupdate: () => {
                if (this.compositionState !== "composing") this.setCompositionState("composing");
                return false;
              },
              compositionend: () => {
                // compositionend is not an insertion command: enter settling and
                // re-evaluate after the engine and events have settled.
                this.setCompositionState("settling");
                this.scheduleSettlingCheck();
                return false;
              },
            },
          },
        }),
        new Plugin({
          props: {
            handlePaste: (view, event) => {
              if (this.isComposing) return false;
              const clipboard = event.clipboardData;
              if (!clipboard) return false;
              // Files first: images/videos/audio pasted as files.
              const files = Array.from(clipboard.files ?? []).filter((file) => file.size > 0);
              if (files.length > 0) {
                event.preventDefault();
                this.callbacks.onFilesDropped(files, view.state.selection.from);
                return true;
              }
              const text = clipboard.getData("text/plain");
              if (text.length > 0) {
                event.preventDefault();
                insertPlainText(view, text);
                return true;
              }
              return false;
            },
            handleDrop: (view, event) => {
              const drag = event as DragEvent;
              const files = Array.from(drag.dataTransfer?.files ?? []).filter(
                (file) => file.size > 0,
              );
              if (files.length === 0) return false;
              event.preventDefault();
              if (this.isComposing) {
                // Defer to a safe point; track the intended position.
                this.callbacks.onFilesDropped(files, view.state.selection.from);
                return true;
              }
              const position =
                view.posAtCoords({ left: drag.clientX, top: drag.clientY })?.pos ??
                view.state.selection.from;
              this.callbacks.onFilesDropped(files, position);
              return true;
            },
          },
        }),
      ],
    });

    this.view = new EditorView(host, {
      state,
      dispatchTransaction: (transaction) => this.applyTransaction(transaction),
      attributes: {
        // Keep the editing surface free of spellcheck/autocorrect rewriting:
        // those are app-controllable automatic replacements (spec §9.4).
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
        translate: "no",
        class: "txt-editor-surface",
        role: "textbox",
        "aria-multiline": "true",
      },
      nodeViews: {
        [MEDIA_NODE]: (node) => this.createMediaNodeView(node),
      },
    });
  }

  get editorView(): EditorView {
    return this.view;
  }

  get state(): EditorState {
    return this.view.state;
  }

  get isComposing(): boolean {
    return this.view.composing || this.compositionState === "composing";
  }

  get inputState(): CompositionState {
    return this.compositionState;
  }

  /** True when it is safe to synchronize or apply a remote version. */
  isSafePoint(): boolean {
    return this.compositionState === "idle" && !this.view.composing;
  }

  focus(): void {
    this.view.focus();
  }

  /** Replaces the whole document (initial load or explicit remote adoption). */
  replaceDocument(document: DocumentModel): void {
    const doc = buildDocFromDocument(document);
    this.withExternalApply(() => {
      this.view.updateState(
        EditorState.create({ schema, doc, plugins: this.view.state.plugins }),
      );
    });
  }

  /** Serializes the current editor content into the shared document model. */
  toDocumentModel(media: Record<string, MediaInfo>): DocumentModel {
    const blocks: Block[] = [];
    this.view.state.doc.forEach((node) => {
      const id = (node.attrs.id as string | undefined) ?? newId();
      if (node.type.name === "paragraph") {
        blocks.push({ id, type: "text", text: node.textContent });
      } else {
        blocks.push({ id, type: "media", mediaId: node.attrs.mediaId as string });
      }
    });
    if (blocks.length === 0) blocks.push({ id: newId(), type: "text", text: "" });
    return { schemaVersion: SCHEMA_VERSION, blocks, media };
  }

  /**
   * Inserts a media node at the tracked position, ensuring editable text
   * blocks exist before and after it (spec §8).
   *
   * When the position resolves inside a text block (the normal case for a
   * caret), that block is split at the caret offset: left keeps its ID, right
   * gets a new one. Placing the media before the whole block instead is what
   * sent every attachment to the top of the document.
   *
   * The structural repair lives in `insertMediaBlock` / `insertMediaAtCaret`,
   * which are unit-tested as pure functions; this method only translates the
   * result into a ProseMirror transaction.
   */
  insertMedia(mediaId: string, kind: string, position?: number): void {
    const { state } = this.view;
    const mediaType = schema.nodes.media;
    const textType = schema.nodes.paragraph;
    const docType = schema.nodes.doc;
    if (!mediaType || !textType || !docType) return;

    const size = state.doc.content.size;
    const clamped = Math.max(0, Math.min(position ?? state.selection.from, size));
    const $pos = state.doc.resolve(clamped);

    // Convert the current document to the shared block model, apply the rules,
    // then rebuild — this guarantees the invariants the wire format validates.
    const current: Block[] = [];
    state.doc.forEach((child) => {
      const id = (child.attrs.id as string | undefined) ?? newId();
      if (child.type.name === "paragraph") {
        current.push({ id, type: "text", text: child.textContent });
      } else {
        current.push({ id, type: "media", mediaId: child.attrs.mediaId as string });
      }
    });

    const { blocks, mediaIndex } =
      $pos.depth > 0 && $pos.parent.type.name === "paragraph"
        ? insertMediaAtCaret(current, {
            mediaId,
            index: $pos.index(0),
            offset: $pos.parentOffset,
          })
        : insertMediaBlock(current, { mediaId, position: $pos.index(0) });
    const nodes: PMNode[] = blocks.map((block) =>
      block.type === "text"
        ? textType.create(
            { id: block.id },
            block.text.length > 0 ? [schema.text(block.text)] : [],
          )
        : mediaType.create({ mediaId: block.mediaId, kind, id: block.id }),
    );

    const nextDoc = docType.create(null, nodes);
    const transaction = state.tr.replaceWith(0, size, nextDoc.content);
    // Place the caret in the text block following the media.
    try {
      let offset = 0;
      for (let i = 0; i < mediaIndex + 1; i++) {
        offset += nodes[i]?.nodeSize ?? 0;
      }
      const caret = Math.min(offset + 1, nextDoc.content.size);
      transaction.setSelection(TextSelection.near(nextDoc.resolve(caret)));
    } catch {
      // Selection is cosmetic; the structure is already valid.
    }
    this.applyTransaction(transaction);
  }

  /** Applies a remote document with best-effort selection preservation. */
  applyRemoteDocument(document: DocumentModel): void {
    const previousSelection = this.view.state.selection.from;
    this.replaceDocument(document);
    const max = this.view.state.doc.content.size;
    const target = Math.max(1, Math.min(previousSelection, max));
    try {
      const selection = TextSelection.near(this.view.state.doc.resolve(target));
      this.withExternalApply(() => {
        this.view.dispatch(this.view.state.tr.setSelection(selection));
      });
    } catch {
      // A stale position simply keeps the default selection.
    }
  }

  /** Clears history so a remote adoption cannot be undone (spec §9.7). */
  clearHistory(): void {
    this.withExternalApply(() => {
      this.view.updateState(
        EditorState.create({ schema, doc: this.view.state.doc, plugins: this.view.state.plugins }),
      );
    });
  }

  destroy(): void {
    if (this.settlingTimer !== null) window.clearTimeout(this.settlingTimer);
    this.view.destroy();
  }

  private createMediaNodeView(node: PMNode): {
    dom: HTMLElement;
    update: (updated: PMNode) => boolean;
    ignoreMutation: () => boolean;
  } {
    const mediaId = node.attrs.mediaId as string;
    const blockId = (node.attrs.id as string | undefined) ?? newId();
    const info = this.options.getMediaInfo(mediaId);
    const dom = info
      ? this.options.renderMedia(mediaId, info, blockId)
      : buildPlaceholder(mediaId);
    // Keep the player identity: update() mutates attributes in place instead of
    // recreating the DOM (spec §3, §9.7).
    return {
      dom,
      update: (updated) => {
        if (updated.type.name !== MEDIA_NODE) return false;
        if (updated.attrs.mediaId !== mediaId) return false;
        dom.setAttribute("data-media-id", mediaId);
        dom.setAttribute("data-block-id", blockId);
        return true;
      },
      // The node view owns its internal mutations (player controls).
      ignoreMutation: () => true,
    };
  }

  private setCompositionState(next: CompositionState): void {
    if (this.compositionState === next) return;
    this.compositionState = next;
    this.callbacks.onCompositionState(next);
  }

  private scheduleSettlingCheck(): void {
    if (this.settlingTimer !== null) window.clearTimeout(this.settlingTimer);
    const generation = ++this.settlingGeneration;
    // Wait for the engine's DOM application and any follow-up events, then
    // re-check: still not composing, no newer local transaction.
    this.settlingTimer = window.setTimeout(() => {
      if (generation !== this.settlingGeneration) return;
      if (this.view.composing) {
        this.setCompositionState("composing");
        return;
      }
      this.setCompositionState("idle");
      this.callbacks.onCommittedChange();
    }, 32);
  }

  private withExternalApply(fn: () => void): void {
    this.externalApplyDepth += 1;
    try {
      fn();
    } finally {
      this.externalApplyDepth -= 1;
    }
  }

  private applyTransaction(transaction: Transaction): void {
    const wasComposing = this.view.composing;
    this.view.updateState(this.view.state.apply(transaction));
    if (!transaction.docChanged) return;
    // During composition the committed snapshot must not be synced, but the
    // engine keeps processing input normally (spec §9.1).
    if (this.compositionState === "composing" || wasComposing || this.view.composing) {
      if (this.compositionState !== "composing") this.setCompositionState("composing");
      return;
    }
    if (this.compositionState === "settling") return;
    if (this.externalApplyDepth > 0) return;
    this.callbacks.onCommittedChange();
  }
}

/** Enter/Shift+Enter inserts a literal newline (LF) inside the text block. */
function insertLineBreak(
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  const { $from } = state.selection;
  if ($from.parent.type.name !== "paragraph") return false;
  if (dispatch) {
    dispatch(state.tr.insertText("\n", $from.pos, $from.pos));
  }
  return true;
}

/** Inserts pasted text as plaintext (LF preserved verbatim). */
function insertPlainText(view: EditorView, text: string): void {
  const { state } = view;
  const { from, to } = state.selection;
  view.dispatch(state.tr.insertText(text, from, to));
}

function buildEmptyDoc(): PMNode {
  return schema.nodes.doc!.create(null, [schema.nodes.paragraph!.create({ id: newId() })]);
}

/** Rebuilds the engine document from the shared model, IDs preserved. */
function buildDocFromDocument(document: DocumentModel): PMNode {
  const textType = schema.nodes.paragraph!;
  const mediaType = schema.nodes.media!;
  const nodes: PMNode[] = [];
  for (const block of document.blocks) {
    if (block.type === "text") {
      nodes.push(
        textType.create({ id: block.id }, block.text.length > 0 ? [schema.text(block.text)] : []),
      );
    } else {
      nodes.push(mediaType.create({ mediaId: block.mediaId, kind: "image", id: block.id }));
    }
  }
  if (nodes.length === 0) return buildEmptyDoc();
  // Media needs an editable text block before and after it (spec §8).
  if (nodes[0]!.type.name === MEDIA_NODE) nodes.unshift(textType.create({ id: newId() }));
  if (nodes[nodes.length - 1]!.type.name === MEDIA_NODE) {
    nodes.push(textType.create({ id: newId() }));
  }
  return schema.nodes.doc!.create(null, nodes);
}

function buildPlaceholder(mediaId: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "txt-media txt-media-placeholder";
  element.setAttribute("data-media-id", mediaId);
  element.textContent = "読み込み中のメディア";
  return element;
}

export { undo, redo };
