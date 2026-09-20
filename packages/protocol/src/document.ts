/**
 * Shared document model (spec §8).
 *
 * Web ProseMirror JSON, HTML, and NSAttributedString archives are NOT wire
 * formats. Every client converts to this JSON and encrypts the whole thing.
 *
 * - Only `text` and `media` blocks are allowed. Unknown types/formats are never
 *   deleted and re-saved; they are reported as errors instead.
 * - The `media` dictionary holds only currently referenced file information;
 *   each media block must reference an existing entry.
 * - An empty document is one empty text block. Leading/trailing and between
 *   adjacent media there must be an editable (possibly empty) text block.
 * - Normal text edits never regenerate IDs. Splitting text on media insertion:
 *   left keeps its ID, right gets a new one. Merging: left keeps its ID.
 * - Saved newlines are the LF character. Trailing newlines, blank lines, empty
 *   blocks, tabs, emoji must survive round-trips unchanged.
 */

import { fromBase64Url } from "./base64url.ts";
import { CHUNK_PLAIN_BYTES } from "./crypto.ts";
import { isUuid } from "./encode.ts";

export const SCHEMA_VERSION = 1;
export const FORMAT_VERSION = 1;
export const KEY_VERSION = 1;

export const MAX_BLOCKS = 2000;
export const MAX_MEDIA = 200;
export const MAX_DOCUMENT_JSON_BYTES = 1_048_576; // 1MiB before encryption
export const MAX_UPDATE_REQUEST_BYTES = 2_097_152; // 2MiB

export const MEDIA_KINDS = ["image", "video", "audio"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface TextBlock {
  id: string;
  type: "text";
  text: string;
}

interface MediaBlock {
  id: string;
  type: "media";
  mediaId: string;
}

export type Block = TextBlock | MediaBlock;

export interface MediaInfo {
  kind: MediaKind;
  name: string;
  mime: string;
  plainBytes: number;
  cryptoFormat: number;
  chunkBytes: number;
  chunkCount: number;
  noncePrefix: string; // base64url 8 bytes
  fileKey: string; // base64url 32 bytes
}

export interface SerializedMediaInfo extends MediaInfo {
  /** Ciphertext size on the wire (plainBytes + one tag per chunk). */
  cipherBytes: number;
}

export interface DocumentModel {
  schemaVersion: number;
  blocks: Block[];
  media: Record<string, MediaInfo>;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function createEmptyDocument(): DocumentModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    blocks: [{ id: newId(), type: "text", text: "" }],
    media: {},
  };
}

/* ------------------------------------------------------------------ */
/* Serialization (deterministic, for fixtures and payload comparisons) */
/* ------------------------------------------------------------------ */

function serializeMedia(info: MediaInfo): Record<string, unknown> {
  return {
    kind: info.kind,
    name: info.name,
    mime: info.mime,
    plainBytes: info.plainBytes,
    cryptoFormat: info.cryptoFormat,
    chunkBytes: info.chunkBytes,
    chunkCount: info.chunkCount,
    noncePrefix: info.noncePrefix,
    fileKey: info.fileKey,
  };
}

/** Stable JSON text: fixed key order, media keys sorted. */
export function serializeDocument(doc: DocumentModel): string {
  const blocks = doc.blocks.map((block) =>
    block.type === "text"
      ? { id: block.id, type: block.type, text: block.text }
      : { id: block.id, type: block.type, mediaId: block.mediaId },
  );
  const media: Record<string, unknown> = {};
  for (const key of Object.keys(doc.media).sort()) {
    media[key] = serializeMedia(doc.media[key] as MediaInfo);
  }
  return JSON.stringify({ schemaVersion: doc.schemaVersion, blocks, media });
}

export function parseDocument(bytes: Uint8Array): DocumentModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DocumentFormatError("document is not valid JSON");
  }
  return validateOrThrow(parsed);
}

export class DocumentFormatError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "DocumentFormatError";
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSafeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** Returns a list of human-readable problems; empty means valid. */
export function validateDocument(input: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainObject(input)) return ["document: not an object"];

  if (input.schemaVersion !== SCHEMA_VERSION) {
    issues.push(`schemaVersion: unsupported (${String(input.schemaVersion)})`);
  }
  const blocks = input.blocks;
  if (!Array.isArray(blocks)) {
    issues.push("blocks: not an array");
    return issues;
  }
  if (blocks.length > MAX_BLOCKS) {
    issues.push(`blocks: too many (${blocks.length} > ${MAX_BLOCKS})`);
  }
  const media = input.media;
  if (!isPlainObject(media)) {
    issues.push("media: not an object");
    return issues;
  }

  const seenIds = new Set<string>();
  let lastValidType: "text" | "media" | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!isPlainObject(block)) {
      issues.push(`blocks[${i}]: not an object`);
      continue;
    }
    const id = block.id;
    if (typeof id !== "string" || !isUuid(id)) {
      issues.push(`blocks[${i}].id: not a UUID`);
    } else if (seenIds.has(id)) {
      issues.push(`blocks[${i}].id: duplicated`);
    } else {
      seenIds.add(id);
    }
    const type = block.type;
    if (type !== "text" && type !== "media") {
      issues.push(`blocks[${i}].type: unsupported type (${String(type)})`);
      continue;
    }
    if (type === "text") {
      const text = block.text;
      if (typeof text !== "string") {
        issues.push(`blocks[${i}].text: not a string`);
      } else if (text.includes("\r")) {
        issues.push(`blocks[${i}].text: contains CR (newlines must be LF)`);
      }
    } else {
      const mediaId = block.mediaId;
      if (typeof mediaId !== "string" || !isUuid(mediaId)) {
        issues.push(`blocks[${i}].mediaId: not a UUID`);
      } else if (!(mediaId in media)) {
        issues.push(`blocks[${i}].mediaId: no such media entry`);
      }
      if (lastValidType !== "text") {
        issues.push(`blocks[${i}]: media needs an editable text block before it`);
      }
    }
    lastValidType = type;
  }
  if (lastValidType === "media") {
    issues.push("blocks: media needs an editable text block after it");
  }

  const mediaKeys = Object.keys(media);
  if (mediaKeys.length > MAX_MEDIA) {
    issues.push(`media: too many entries (${mediaKeys.length} > ${MAX_MEDIA})`);
  }
  const referenced = referencedMediaIdSet(blocks);
  for (const key of mediaKeys) {
    if (!isUuid(key)) {
      issues.push(`media["${key}"]: key is not a UUID`);
      continue;
    }
    if (!referenced.has(key)) {
      issues.push(`media["${key}"]: entry is not referenced`);
    }
    const info = media[key];
    if (!isPlainObject(info)) {
      issues.push(`media["${key}"]: not an object`);
      continue;
    }
    if (typeof info.kind !== "string" || !(MEDIA_KINDS as readonly string[]).includes(info.kind)) {
      issues.push(`media["${key}"].kind: unsupported`);
    }
    if (typeof info.name !== "string") issues.push(`media["${key}"].name: not a string`);
    if (typeof info.mime !== "string") issues.push(`media["${key}"].mime: not a string`);
    if (!isSafeInteger(info.plainBytes) || (info.plainBytes as number) <= 0) {
      issues.push(`media["${key}"].plainBytes: must be a positive integer`);
    }
    if (info.cryptoFormat !== FORMAT_VERSION) {
      issues.push(`media["${key}"].cryptoFormat: unsupported`);
    }
    if (info.chunkBytes !== CHUNK_PLAIN_BYTES) {
      issues.push(`media["${key}"].chunkBytes: unexpected chunk size`);
    }
    if (isSafeInteger(info.plainBytes)) {
      const expected = Math.ceil((info.plainBytes as number) / CHUNK_PLAIN_BYTES);
      if (info.chunkCount !== expected) {
        issues.push(`media["${key}"].chunkCount: ${String(info.chunkCount)} != ${expected}`);
      }
    }
    if (typeof info.noncePrefix === "string") {
      try {
        if (fromBase64Url(info.noncePrefix).byteLength !== 8) {
          issues.push(`media["${key}"].noncePrefix: not 8 bytes`);
        }
      } catch {
        issues.push(`media["${key}"].noncePrefix: not base64url`);
      }
    } else {
      issues.push(`media["${key}"].noncePrefix: missing`);
    }
    if (typeof info.fileKey === "string") {
      try {
        if (fromBase64Url(info.fileKey).byteLength !== 32) {
          issues.push(`media["${key}"].fileKey: not 32 bytes`);
        }
      } catch {
        issues.push(`media["${key}"].fileKey: not base64url`);
      }
    } else {
      issues.push(`media["${key}"].fileKey: missing`);
    }
  }

  return issues;
}

export function validateOrThrow(input: unknown): DocumentModel {
  const issues = validateDocument(input);
  if (issues.length > 0) {
    throw new DocumentFormatError(`document failed validation (${issues.length} issues)`, issues);
  }
  return input as DocumentModel;
}

/* ------------------------------------------------------------------ */
/* Derived helpers                                                     */
/* ------------------------------------------------------------------ */

export function referencedMediaIdSet(blocks: Block[]): Set<string> {
  const out = new Set<string>();
  for (const block of blocks) {
    if (block.type === "media") out.add(block.mediaId);
  }
  return out;
}

/** Sorted, unique media IDs for `referencedMediaIds` (spec §8, §10.3). */
export function referencedMediaIds(doc: DocumentModel): string[] {
  return [...referencedMediaIdSet(doc.blocks)].sort();
}

/* ------------------------------------------------------------------ */
/* Repair helpers (spec §8)                                            */
/* ------------------------------------------------------------------ */

/**
 * Returns a copy holding only the media entries its blocks reference.
 *
 * The wire format forbids orphaned entries, so every serialization prunes
 * them: an upload that finished after its insertion was undone/deleted, or an
 * insertion removed from history, must never persist a dictionary entry.
 */
export function pruneUnreferencedMedia(doc: DocumentModel): DocumentModel {
  const referenced = referencedMediaIdSet(doc.blocks);
  const keys = Object.keys(doc.media);
  if (keys.every((key) => referenced.has(key))) return doc;
  const media: Record<string, MediaInfo> = {};
  for (const key of keys) {
    if (referenced.has(key)) media[key] = doc.media[key] as MediaInfo;
  }
  return { ...doc, media };
}

const ORPHAN_ISSUE = /^media\[".+"\]: entry is not referenced$/;

/**
 * Recovers a stored document whose only defect is unreferenced media entries.
 *
 * Dropping such an entry loses nothing: no block points at it. Any other
 * problem returns null, because silently repairing unknown damage could
 * destroy visible content — the caller must keep failing closed there.
 */
export function repairOrphanedMedia(
  input: unknown,
): { document: DocumentModel; dropped: string[] } | null {
  const issues = validateDocument(input);
  if (issues.length === 0) return { document: input as DocumentModel, dropped: [] };
  if (!issues.every((issue) => ORPHAN_ISSUE.test(issue))) return null;
  const source = input as DocumentModel;
  const referenced = referencedMediaIdSet(source.blocks);
  const media: Record<string, MediaInfo> = {};
  const dropped: string[] = [];
  for (const key of Object.keys(source.media)) {
    if (referenced.has(key)) {
      media[key] = source.media[key] as MediaInfo;
    } else {
      dropped.push(key);
    }
  }
  const document: DocumentModel = {
    schemaVersion: source.schemaVersion,
    blocks: source.blocks,
    media,
  };
  // The repaired model must be fully valid; otherwise the caller treats the
  // document as unreadable exactly as before.
  if (validateDocument(document).length > 0) return null;
  return { document, dropped };
}

const KIND_LABELS: Record<MediaKind, string> = {
  image: "画像",
  video: "動画",
  audio: "音声",
};

/** Plaintext view for the clipboard; media becomes `[画像: name]` (spec §8). */
export function plainTextForCopy(doc: DocumentModel): string {
  const parts: string[] = [];
  for (const block of doc.blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    } else {
      const info = doc.media[block.mediaId];
      const label = info ? KIND_LABELS[info.kind] : "メディア";
      const name = info ? info.name : "";
      parts.push(`[${label}: ${name}]`);
    }
  }
  return parts.join("");
}

export function documentJsonBytes(doc: DocumentModel): number {
  return new TextEncoder().encode(serializeDocument(doc)).byteLength;
}
