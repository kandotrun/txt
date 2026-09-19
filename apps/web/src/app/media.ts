/**
 * Media transfer (spec §11).
 *
 * Upload order: reserve capacity -> encrypt chunk by chunk in the crypto
 * worker -> upload parts -> complete -> insert at the tracked position on an
 * IME safe point -> CAS save (only then is it visible to other devices).
 *
 * The original file is read in bounded slices: a 512MiB video is never loaded
 * fully into memory for encryption.
 */

import { CHUNK_PLAIN_BYTES } from "../../../../packages/protocol/src/crypto.ts";
import { toBase64Url } from "../../../../packages/protocol/src/base64url.ts";
import { randomBytes } from "../../../../packages/protocol/src/crypto.ts";
import { mediaCipherLength } from "../../../../packages/protocol/src/crypto.ts";
import type { MediaInfo, MediaKind } from "../../../../packages/protocol/src/document.ts";
import { api } from "./api.ts";
import type { CryptoBridge } from "./crypto-bridge.ts";

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/x-m4a",
]);

const SIZE_LIMITS: Record<MediaKind, number> = {
  image: 20 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  video: 512 * 1024 * 1024,
};

export const PART_BYTES = 8_388_736; // 8 chunks (spec §11.1)

export class MediaRejectedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "MediaRejectedError";
    this.reason = reason;
  }
}

/** Classifies a file and enforces per-kind limits and MIME checks (§11.1). */
export function classify(file: File): MediaKind {
  const type = file.type.toLowerCase();
  if (IMAGE_TYPES.has(type)) {
    if (file.size > SIZE_LIMITS.image) throw new MediaRejectedError("画像は20MiBまでです。");
    return "image";
  }
  if (VIDEO_TYPES.has(type)) {
    if (file.size > SIZE_LIMITS.video) throw new MediaRejectedError("動画は512MiBまでです。");
    return "video";
  }
  if (AUDIO_TYPES.has(type)) {
    if (file.size > SIZE_LIMITS.audio) throw new MediaRejectedError("音声は100MiBまでです。");
    return "audio";
  }
  // SVG, HTML, PDF, executables and everything else are refused in the UI.
  throw new MediaRejectedError("この形式のファイルは添付できません。");
}

export interface UploadTarget {
  mediaId: string;
  fileKey: string;
  noncePrefix: Uint8Array;
}

/** Encrypts one chunk and returns its ciphertext. */
async function encryptChunk(options: {
  bridge: CryptoBridge;
  documentId: string;
  mediaId: string;
  fileKey: string;
  noncePrefix: string;
  totalPlainBytes: number;
  index: number;
  plaintext: Uint8Array;
}): Promise<Uint8Array> {
  return options.bridge.encryptChunk({
    documentId: options.documentId,
    mediaId: options.mediaId,
    fileKey: options.fileKey,
    noncePrefix: options.noncePrefix,
    cryptoFormat: 1,
    totalPlainBytes: options.totalPlainBytes,
    index: options.index,
    plaintext: options.plaintext,
  });
}

export interface UploadResult {
  mediaId: string;
  info: MediaInfo;
}

/**
 * Uploads one file. Progress is reported per part; cancellation is cooperative
 * and the caller removes the placeholder afterwards.
 */
export async function uploadFile(options: {
  file: File;
  kind: MediaKind;
  documentId: string;
  bridge: CryptoBridge;
  signal: AbortSignal;
  onProgress: (fraction: number) => void;
  onStarted: (mediaId: string) => void;
}): Promise<UploadResult> {
  const { file, kind, documentId, bridge } = options;
  if (file.size === 0) throw new MediaRejectedError("空のファイルは添付できません。");

  const cipherBytes = mediaCipherLength(file.size);
  const chunkCount = Math.ceil(file.size / CHUNK_PLAIN_BYTES);
  const fileKeyBytes = randomBytes(32);
  const noncePrefix = randomBytes(8);
  const fileKey = toBase64Url(fileKeyBytes);

  const start = await api.startUpload({
    clientUploadId: crypto.randomUUID(),
    cipherBytes,
    cryptoFormat: 1,
    chunkBytes: CHUNK_PLAIN_BYTES + 16,
  });
  options.onStarted(start.mediaId);

  const partCount = start.partCount;
  let uploadedParts = 0;

  try {
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      if (options.signal.aborted) throw new DOMException("aborted", "AbortError");
      const startByte = partIndex * PART_BYTES;
      const endByte = Math.min(startByte + PART_BYTES, cipherBytes);

      // Build the part as the concatenation of its chunk ciphertexts.
      const partBuffer = new Uint8Array(endByte - startByte);
      let partOffset = 0;
      const firstChunk = Math.floor(startByte / (CHUNK_PLAIN_BYTES + 16));
      const lastChunk = Math.ceil(endByte / (CHUNK_PLAIN_BYTES + 16));

      for (let chunkIndex = firstChunk; chunkIndex < lastChunk; chunkIndex++) {
        const plainStart = chunkIndex * CHUNK_PLAIN_BYTES;
        const plainEnd = Math.min(plainStart + CHUNK_PLAIN_BYTES, file.size);
        const plaintext = new Uint8Array(
          await file.slice(plainStart, plainEnd).arrayBuffer(),
        );
        const ciphertext = await encryptChunk({
          bridge,
          documentId,
          mediaId: start.mediaId,
          fileKey,
          noncePrefix: toBase64Url(noncePrefix),
          totalPlainBytes: file.size,
          index: chunkIndex,
          plaintext,
        });
        partBuffer.set(ciphertext, partOffset);
        partOffset += ciphertext.byteLength;
      }

      const expected = endByte - startByte;
      if (partOffset !== expected) {
        throw new Error("暗号化したパートの長さが一致しません。");
      }
      await api.uploadPart(start.mediaId, partIndex + 1, partBuffer);
      uploadedParts += 1;
      options.onProgress(uploadedParts / partCount);
    }

    await api.completeUpload(start.mediaId);

    const info: MediaInfo = {
      kind,
      name: file.name,
      mime: file.type,
      plainBytes: file.size,
      cryptoFormat: 1,
      chunkBytes: CHUNK_PLAIN_BYTES,
      chunkCount,
      noncePrefix: toBase64Url(noncePrefix),
      fileKey,
    };
    return { mediaId: start.mediaId, info };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      await api.cancelUpload(start.mediaId).catch(() => undefined);
    }
    throw error;
  }
}

/** Fetches and decrypts a full media object (small images only, spec §11.6). */
export async function fetchDecrypted(options: {
  mediaId: string;
  info: MediaInfo;
  documentId: string;
  bridge: CryptoBridge;
}): Promise<Blob> {
  const { mediaId, info, documentId, bridge } = options;
  const response = await fetch(`/api/v1/media/${encodeURIComponent(mediaId)}/cipher`, {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("メディアを取得できません。");
  const ciphertext = new Uint8Array(await response.arrayBuffer());
  const chunkCount = info.chunkCount;
  const plaintext = new Uint8Array(info.plainBytes);
  let cipherOffset = 0;
  let plainOffset = 0;
  for (let index = 0; index < chunkCount; index++) {
    const cipherLength =
      index === chunkCount - 1
        ? ciphertext.byteLength - cipherOffset
        : CHUNK_PLAIN_BYTES + 16;
    const chunkCipher = ciphertext.subarray(cipherOffset, cipherOffset + cipherLength);
    const chunkPlain = await bridge.decryptChunk({
      documentId,
      mediaId,
      fileKey: info.fileKey,
      noncePrefix: info.noncePrefix,
      cryptoFormat: info.cryptoFormat,
      totalPlainBytes: info.plainBytes,
      chunkPlainBytes: chunkCipher.byteLength - 16,
      index,
      ciphertext: chunkCipher,
    });
    plaintext.set(chunkPlain, plainOffset);
    plainOffset += chunkPlain.byteLength;
    cipherOffset += cipherLength;
  }
  return new Blob([plaintext as unknown as BlobPart], { type: info.mime });
}

/**
 * The overall Blob-based fallback is only allowed below 20MiB (spec §11.6);
 * larger media must go through the Service Worker stream.
 */
export const BLOB_FALLBACK_MAX_BYTES = 20 * 1024 * 1024;
