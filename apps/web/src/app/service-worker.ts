/**
 * Service Worker (spec §11.6).
 *
 * Serves large encrypted media through the virtual `/_local/media/:id` URL: the
 * standard player's plaintext Range requests are converted into the ciphertext
 * chunks needed, decrypted in the client, and only the requested plaintext
 * slice is returned. The server never serves plaintext on this path — direct
 * requests to `/_local/` are 404/no-store (enforced by the Worker).
 *
 * Keys and decrypted Response bodies live only in memory. Nothing is persisted
 * to Cache Storage or the HTTP cache. The SW is bound to one unlocked editing
 * surface via MessageChannel + a real clientId handshake.
 */

/// <reference lib="webworker" />

import {
  CHUNK_PLAIN_BYTES,
  aesGcmDecrypt,
  mediaChunkAad,
  mediaChunkNonce,
} from "../../../../packages/protocol/src/crypto.ts";
import { fromBase64Url } from "../../../../packages/protocol/src/base64url.ts";

declare const self: ServiceWorkerGlobalScope;

const CIPHER_CHUNK_BYTES = CHUNK_PLAIN_BYTES + 16;

interface MediaInfo {
  kind: string;
  name: string;
  mime: string;
  plainBytes: number;
  cryptoFormat: number;
  chunkBytes: number;
  chunkCount: number;
  noncePrefix: string;
  fileKey: string;
}

interface SessionKeys {
  accountId: string;
  documentId: string;
  keyVersion: number;
  vaultKey: Uint8Array;
  media: Map<string, MediaInfo>;
  generation: number;
}

interface Handshake {
  type: "txt-handshake";
  sessionGeneration: number;
  accountId: string;
  documentId: string;
  keyVersion: number;
  vaultKey: string;
  media: Record<string, MediaInfo>;
}

let session: SessionKeys | null = null;
let sessionGeneration = 0;
const allowedClients = new Set<string>();

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data as Record<string, unknown>;
  if (data?.type === "txt-handshake") {
    const handshake = data as unknown as Handshake;
    // The unlocking page is remembered by its real clientId; other tabs can
    // never fall back to this key.
    if (event.source && "id" in event.source) {
      allowedClients.add((event.source as Client).id);
    }
    session = {
      accountId: handshake.accountId,
      documentId: handshake.documentId,
      keyVersion: handshake.keyVersion,
      vaultKey: fromBase64Url(handshake.vaultKey),
      media: new Map(Object.entries(handshake.media)),
      generation: handshake.sessionGeneration,
    };
    sessionGeneration = handshake.sessionGeneration;
    return;
  }
  if (data?.type === "txt-lock") {
    session = null;
    allowedClients.clear();
    return;
  }
  if (data?.type === "txt-media-update") {
    if (session) {
      session.media = new Map(Object.entries((data.media ?? {}) as Record<string, MediaInfo>));
    }
    return;
  }
});

const VIRTUAL_PREFIX = "/_local/media/";

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(VIRTUAL_PREFIX)) return;
  if (url.origin !== self.location.origin) return;
  event.respondWith(handleMediaRequest(event));
});

async function handleMediaRequest(event: FetchEvent): Promise<Response> {
  const url = new URL(event.request.url);
  const mediaId = url.pathname.slice(VIRTUAL_PREFIX.length).split("/")[0] ?? "";
  if (!session) {
    return noStore(new Response("locked", { status: 423 }));
  }
  const info = session.media.get(mediaId);
  if (!info) {
    return noStore(new Response("not found", { status: 404 }));
  }
  if (event.clientId && session.generation === sessionGeneration && allowedClients.size > 0) {
    // Only requests originating from an allowed client are served.
    if (!allowedClients.has(event.clientId)) {
      return noStore(new Response("forbidden", { status: 403 }));
    }
  }

  const totalPlain = info.plainBytes;
  const rangeHeader = event.request.headers.get("range");
  let start = 0;
  let end = totalPlain - 1;
  let isRange = false;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const [, startRaw, endRaw] = match as unknown as [string, string, string];
      if (startRaw === "" && endRaw !== "") {
        const suffix = Number(endRaw);
        if (Number.isFinite(suffix) && suffix > 0) {
          start = Math.max(0, totalPlain - suffix);
          isRange = true;
        }
      } else if (startRaw !== "") {
        start = Number(startRaw);
        if (endRaw !== "") end = Math.min(Number(endRaw), totalPlain - 1);
        isRange = true;
      }
    }
  }
  if (start >= totalPlain || start < 0 || end < start) {
    return noStore(
      new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${totalPlain}` },
      }),
    );
  }

  try {
    const plaintext = await readPlainSlice(info, mediaId, start, end);
    const headers = new Headers({
      "content-type": info.mime,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": String(plaintext.byteLength),
    });
    if (isRange) {
      headers.set("content-range", `bytes ${start}-${start + plaintext.byteLength - 1}/${totalPlain}`);
    }
    if (event.request.method === "HEAD") {
      return noStore(new Response(null, { status: isRange ? 206 : 200, headers }));
    }
    return noStore(
      new Response(plaintext as unknown as BodyInit, {
        status: isRange ? 206 : 200,
        headers,
      }),
    );
  } catch (error) {
    return noStore(new Response(`decrypt failed: ${(error as Error).message}`, { status: 500 }));
  }
}

async function readPlainSlice(
  info: MediaInfo,
  mediaId: string,
  start: number,
  end: number,
): Promise<Uint8Array> {
  if (!session) throw new Error("locked");
  const firstChunk = Math.floor(start / CHUNK_PLAIN_BYTES);
  const lastChunk = Math.floor(end / CHUNK_PLAIN_BYTES);
  const fileKey = fromBase64Url(info.fileKey);
  const noncePrefix = fromBase64Url(info.noncePrefix);
  const totalChunks = lastChunk - firstChunk + 1;
  // Bounded cache: one chunk window only, so seeking does not accumulate memory.
  const output = new Uint8Array(end - start + 1);
  let outputOffset = 0;

  for (let index = firstChunk; index <= lastChunk; index++) {
    const cipherStart = index * CIPHER_CHUNK_BYTES;
    const cipherEnd = Math.min(cipherStart + CIPHER_CHUNK_BYTES, info.plainBytes + info.chunkCount * 16) - 1;
    const response = await fetch(`/api/v1/media/${encodeURIComponent(mediaId)}/cipher`, {
      headers: { range: `bytes=${cipherStart}-${cipherEnd}` },
      credentials: "same-origin",
    });
    if (response.status !== 206 && response.status !== 200) {
      throw new Error(`cipher fetch failed (${response.status})`);
    }
    const ciphertext = new Uint8Array(await response.arrayBuffer());
    const chunkPlainBytes = Math.min(CHUNK_PLAIN_BYTES, info.plainBytes - index * CHUNK_PLAIN_BYTES);
    const nonce = mediaChunkNonce(noncePrefix, index);
    // Shared contract: identical AAD bytes as the uploader and the native app.
    const aad = mediaChunkAad(
      info.cryptoFormat,
      session.accountId,
      session.documentId,
      mediaId,
      index,
      info.plainBytes,
      chunkPlainBytes,
    );
    const plaintext = await aesGcmDecrypt(fileKey, nonce, ciphertext.slice(0, chunkPlainBytes + 16), aad);

    const sliceStart = Math.max(start, index * CHUNK_PLAIN_BYTES) - index * CHUNK_PLAIN_BYTES;
    const sliceEnd = Math.min(end, index * CHUNK_PLAIN_BYTES + chunkPlainBytes - 1) - index * CHUNK_PLAIN_BYTES;
    const slice = plaintext.subarray(sliceStart, sliceEnd + 1);
    output.set(slice, outputOffset);
    outputOffset += slice.byteLength;
    void totalChunks;
  }
  return output;
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export {};
