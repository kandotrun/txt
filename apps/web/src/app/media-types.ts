/**
 * Media types the app stores and renders (spec §11.1).
 *
 * The list is enforced twice. `classify` refuses other files when attaching.
 * `renderableMime` is the second gate, applied whenever decrypted bytes are
 * handed to the browser: the type recorded inside a document is data — another
 * client or an older build wrote it — so it is never trusted to
 * decide how a same-origin response is interpreted. Anything off the list
 * (HTML, SVG, scripts, PDF, ...) is served as opaque bytes.
 */

import type { MediaKind } from "../../../../packages/protocol/src/document.ts";

const TYPES: Readonly<Record<MediaKind, readonly string[]>> = {
  image: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
    "image/heic",
    "image/heif",
  ],
  video: ["video/mp4", "video/webm", "video/quicktime"],
  audio: [
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/wav",
    "audio/ogg",
    "audio/webm",
    "audio/flac",
    "audio/x-m4a",
  ],
};

const KIND_BY_TYPE: ReadonlyMap<string, MediaKind> = new Map(
  (Object.entries(TYPES) as Array<[MediaKind, readonly string[]]>).flatMap(([kind, types]) =>
    types.map((type) => [type, kind] as const),
  ),
);

export const OPAQUE_MIME = "application/octet-stream";

/** The kind a declared type belongs to, or null when it is not accepted. */
export function mediaKindForType(type: string): MediaKind | null {
  return KIND_BY_TYPE.get(type.toLowerCase()) ?? null;
}

/** The Content-Type decrypted bytes may be given to the browser with. */
export function renderableMime(stored: string): string {
  const type = typeof stored === "string" ? stored.toLowerCase() : "";
  return KIND_BY_TYPE.has(type) ? type : OPAQUE_MIME;
}
