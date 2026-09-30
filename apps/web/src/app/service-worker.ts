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
 * to Cache Storage or the HTTP cache. Each unlocked editing surface has its
 * own session bound via MessageChannel + a real clientId handshake.
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
  ownerClientId: string;
  lifetime: AbortController;
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

const sessions = new Map<string, SessionKeys>();

function clearSession(clientId: string): void {
  const previous = sessions.get(clientId);
  sessions.delete(clientId);
  // Error paused streams as well as aborting fetches already in progress.
  previous?.lifetime.abort();
}

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data as Record<string, unknown>;
  const clientId = event.source && "id" in event.source ? (event.source as Client).id : "";
  if (!clientId) return;
  if (data?.type === "txt-handshake") {
    const handshake = data as unknown as Handshake;
    const nextSession: SessionKeys = {
      accountId: handshake.accountId,
      documentId: handshake.documentId,
      keyVersion: handshake.keyVersion,
      vaultKey: fromBase64Url(handshake.vaultKey),
      media: new Map(Object.entries(handshake.media)),
      generation: handshake.sessionGeneration,
      ownerClientId: clientId,
      lifetime: new AbortController(),
    };
    // Generations are page-local. Replace only this client's session, revoking
    // its old streams even if the generation number is reused.
    clearSession(clientId);
    sessions.set(clientId, nextSession);
    event.ports[0]?.postMessage({ type: "txt-ready", sessionGeneration: handshake.sessionGeneration });
    return;
  }
  if (data?.type === "txt-lock") {
    clearSession(clientId);
    return;
  }
  const session = sessions.get(clientId);
  if (data?.type === "txt-media-update" && session?.ownerClientId === clientId) {
    if (data.sessionGeneration !== undefined && data.sessionGeneration !== session.generation) return;
    session.media = new Map(Object.entries((data.media ?? {}) as Record<string, MediaInfo>));
    event.ports[0]?.postMessage({ type: "txt-ready", sessionGeneration: session.generation });
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
  if (!event.clientId) {
    return noStore(new Response("forbidden", { status: 403 }));
  }
  const owner = sessions.get(event.clientId);
  if (!owner) {
    return noStore(new Response("locked", { status: 423 }));
  }
  if (event.clientId !== owner.ownerClientId) {
    return noStore(new Response("forbidden", { status: 403 }));
  }
  const info = owner.media.get(mediaId);
  if (!info) {
    return noStore(new Response("not found", { status: 404 }));
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
    const headers = new Headers({
      "content-type": info.mime,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": String(end - start + 1),
    });
    if (isRange) headers.set("content-range", `bytes ${start}-${end}/${totalPlain}`);
    // HEAD is metadata-only: do not fetch ciphertext or even construct a
    // decryption stream. GET headers likewise do not wait for upstream I/O.
    const body = event.request.method === "HEAD" ? null
      : streamPlainSlice(owner, event.clientId, event.request.signal, { ...info }, mediaId, start, end);
    return new Response(body, { status: isRange ? 206 : 200, headers });
  } catch {
    return noStore(new Response("invalid media", { status: 500 }));
  }
}

/** One authenticated chunk per pull, with no plaintext read-ahead queue. */
function streamPlainSlice(
  owner: SessionKeys,
  clientId: string,
  requestSignal: AbortSignal,
  info: MediaInfo,
  mediaId: string,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  const generation = owner.generation;
  const fileKey = fromBase64Url(info.fileKey);
  const noncePrefix = fromBase64Url(info.noncePrefix);
  const lastChunk = Math.floor(end / CHUNK_PLAIN_BYTES);
  let index = Math.floor(start / CHUNK_PLAIN_BYTES);
  let active = true;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const transfer = new AbortController();
  const assertActive = (): void => {
    if (!active || sessions.get(clientId) !== owner || owner.generation !== generation ||
      owner.ownerClientId !== clientId || owner.lifetime.signal.aborted || transfer.signal.aborted) {
      throw new Error("media session ended");
    }
  };
  const detach = (): void => {
    owner.lifetime.signal.removeEventListener("abort", invalidate);
    requestSignal.removeEventListener("abort", invalidate);
  };
  const fail = (error: unknown): void => {
    if (!active) return;
    active = false;
    detach();
    output.error(error);
    transfer.abort();
  };
  const invalidate = (): void => fail(new Error("media session ended"));

  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      owner.lifetime.signal.addEventListener("abort", invalidate, { once: true });
      requestSignal.addEventListener("abort", invalidate, { once: true });
      if (owner.lifetime.signal.aborted || requestSignal.aborted) invalidate();
    },
    async pull(controller) {
      try {
        assertActive();
        const plainStart = index * CHUNK_PLAIN_BYTES;
        const chunkPlainBytes = Math.min(CHUNK_PLAIN_BYTES, info.plainBytes - plainStart);
        const ciphertext = await readCipherChunk(info, mediaId, index, transfer.signal, assertActive);
        assertActive();
        // Capture the owning session, never another client's keys, for the AAD.
        const aad = mediaChunkAad(
          info.cryptoFormat, owner.accountId, owner.documentId, mediaId,
          index, info.plainBytes, chunkPlainBytes,
        );
        const plaintext = await aesGcmDecrypt(fileKey, mediaChunkNonce(noncePrefix, index), ciphertext, aad);
        // Fetch/body/WebCrypto are all asynchronous revocation boundaries.
        // No part of a chunk is released until its entire GCM tag verifies.
        assertActive();
        controller.enqueue(plaintext.subarray(
          Math.max(start - plainStart, 0),
          Math.min(end - plainStart + 1, chunkPlainBytes),
        ));
        index++;
        if (index > lastChunk) {
          active = false;
          detach();
          controller.close();
        }
      } catch (error) {
        fail(error);
      }
    },
    cancel() {
      if (!active) return;
      active = false;
      detach();
      transfer.abort();
    },
    // Default streams prefetch one chunk even with no reader. Zero means
    // every encrypted-chunk fetch needs actual downstream demand.
  }, { highWaterMark: 0 });
}

/** Reject whole-object responses before reading; bound actual bytes as well. */
async function readCipherChunk(
  info: MediaInfo,
  mediaId: string,
  index: number,
  signal: AbortSignal,
  assertActive: () => void,
): Promise<Uint8Array> {
  const expectedBytes = Math.min(CHUNK_PLAIN_BYTES, info.plainBytes - index * CHUNK_PLAIN_BYTES) + 16;
  const cipherStart = index * CIPHER_CHUNK_BYTES;
  const cipherEnd = cipherStart + expectedBytes - 1;
  const cipherTotal = info.plainBytes + info.chunkCount * 16;
  const response = await fetch(`/api/v1/media/${encodeURIComponent(mediaId)}/cipher`, {
    headers: { range: `bytes=${cipherStart}-${cipherEnd}` },
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelBody = (): void => {
    // Do not let an uncooperative source delay revocation or cancellation.
    void (reader ? reader.cancel() : response.body?.cancel())?.catch(() => {});
  };
  try {
    // A fetch implementation can resolve after abort; discard that body too.
    assertActive();
    const contentLength = response.headers.get("content-length");
    if (response.status !== 206 ||
      response.headers.get("content-range") !== `bytes ${cipherStart}-${cipherEnd}/${cipherTotal}` ||
      (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== expectedBytes)) ||
      !response.body) {
      throw new Error("invalid ciphertext range response");
    }
    reader = response.body.getReader();
    signal.addEventListener("abort", cancelBody, { once: true });
    const ciphertext = new Uint8Array(expectedBytes);
    let received = 0;
    while (true) {
      assertActive();
      const { done, value } = await reader.read();
      assertActive();
      if (done) break;
      // Check before copying; Content-Length is not an allocation guarantee.
      if (value.byteLength > expectedBytes - received) throw new Error("oversized ciphertext chunk");
      ciphertext.set(value, received);
      received += value.byteLength;
    }
    // Even an exactly sized body needs EOF verification before decryption.
    if (received !== expectedBytes) throw new Error("truncated ciphertext chunk");
    return ciphertext;
  } catch (error) {
    cancelBody();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelBody);
    reader?.releaseLock();
  }
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export {};
