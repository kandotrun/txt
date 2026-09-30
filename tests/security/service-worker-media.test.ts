/** Real SW handlers + real AES-GCM; only the network/client boundary is fake. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHUNK_PLAIN_BYTES,
  aesGcmEncrypt,
  mediaChunkAad,
  mediaChunkNonce,
} from "../../packages/protocol/src/crypto.ts";
import { fromBase64Url, toBase64Url } from "../../packages/protocol/src/base64url.ts";

const CHUNK = CHUNK_PLAIN_BYTES;
const CIPHER_CHUNK = CHUNK + 16;
const VIDEO_BYTES = 10_000_000_000;
const IMAGE_BYTES = 100_000_000;
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const DOCUMENT = "22222222-2222-4222-8222-222222222222";
const MEDIA = "33333333-3333-4333-8333-333333333333";
const CLIENT = "unlocked-editor";
const OTHER_MEDIA = "44444444-4444-4444-8444-444444444444";
const OTHER_CLIENT = "other-editor";
const ORIGIN = "https://txt.example.test";
const KEY = new Uint8Array(32).fill(7);
const NONCE = new Uint8Array(8).fill(9);
const NativeUint8Array = Uint8Array;

function metadata(plainBytes = VIDEO_BYTES) {
  return {
    kind: "video", name: "local-only.mp4", mime: "video/mp4", plainBytes,
    cryptoFormat: 1, chunkBytes: CHUNK, chunkCount: Math.ceil(plainBytes / CHUNK),
    noncePrefix: toBase64Url(NONCE), fileKey: toBase64Url(KEY),
  };
}
type MediaInfo = ReturnType<typeof metadata>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let listeners: Map<string, (event: unknown) => void>;
let fetchCipher: ReturnType<typeof vi.fn<typeof fetch>>;
let info: MediaInfo;
let allocations: number[];

function message(data: unknown, clientId: string | null = CLIENT, postMessage?: (data: unknown) => void) {
  listeners.get("message")!({
    data, source: clientId === null ? null : { id: clientId }, ports: postMessage ? [{ postMessage }] : [],
  });
}
function handshake(overrides: Record<string, unknown> = {}, clientId: string | null = CLIENT) {
  message({
    type: "txt-handshake", sessionGeneration: 1,
    accountId: ACCOUNT, documentId: DOCUMENT, keyVersion: 1,
    vaultKey: toBase64Url(KEY), media: { [MEDIA]: info }, ...overrides,
  }, clientId);
}
function request(range?: string, options: { method?: string; clientId?: string; mediaId?: string; signal?: AbortSignal } = {}) {
  let response: Promise<Response> | undefined;
  listeners.get("fetch")!({
    clientId: options.clientId ?? CLIENT,
    request: new Request(`${ORIGIN}/_local/media/${options.mediaId ?? MEDIA}`, {
      method: options.method ?? "GET", headers: range === undefined ? {} : { range },
      signal: options.signal,
    }),
    respondWith: (value: Promise<Response>) => { response = Promise.resolve(value); },
  });
  if (!response) throw new Error("the real SW fetch handler did not respond");
  return response;
}

function chunkValue(index: number) { return (index % 251) + 1; }
async function encryptedChunk(index: number, source = info, mediaId = MEDIA) {
  const bytes = Math.min(CHUNK, source.plainBytes - index * CHUNK);
  return aesGcmEncrypt(
    fromBase64Url(source.fileKey), mediaChunkNonce(fromBase64Url(source.noncePrefix), index),
    new Uint8Array(bytes).fill(chunkValue(index)),
    mediaChunkAad(source.cryptoFormat, ACCOUNT, DOCUMENT, mediaId, index, source.plainBytes, bytes),
  );
}
function cipherHeaders(index: number, source = info) {
  const start = index * CIPHER_CHUNK;
  const bytes = Math.min(CHUNK, source.plainBytes - index * CHUNK) + 16;
  return {
    "content-range": `bytes ${start}-${start + bytes - 1}/${source.plainBytes + source.chunkCount * 16}`,
    "content-length": String(bytes),
  };
}
async function validCipher(index: number, source = info, mediaId = MEDIA) {
  return new Response(await encryptedChunk(index, source, mediaId) as BodyInit, {
    status: 206, headers: cipherHeaders(index, source),
  });
}
function cipherIndex(init?: RequestInit) {
  const range = new Headers(init?.headers).get("range");
  const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
  expect(match, "each upstream fetch must be a closed ciphertext range").not.toBeNull();
  const start = Number(match![1]);
  const end = Number(match![2]);
  expect(start % CIPHER_CHUNK).toBe(0);
  expect(end - start + 1).toBeLessThanOrEqual(CIPHER_CHUNK);
  expect(init?.credentials).toBe("same-origin");
  return start / CIPHER_CHUNK;
}
async function streamingResponse(range?: string) {
  // A real stream returns headers without waiting for fetch or WebCrypto.
  let response: Response | undefined;
  void request(range).then((value) => { response = value; });
  await turn();
  expect(response, "headers must be available before any ciphertext arrives").toBeDefined();
  expect(response!.status).toBe(range ? 206 : 200);
  return response!;
}
function measuredBody(parts: Uint8Array[], close = true) {
  let index = 0;
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const part = parts[index++];
    if (part) controller.enqueue(part);
    else if (close) controller.close();
  });
  const cancel = vi.fn();
  return { stream: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), pull, cancel };
}

beforeEach(async () => {
  vi.resetModules();
  info = metadata();
  allocations = [];
  // RED must not actually reserve a 10 GB array. Also makes the memory bound
  // deterministic instead of depending on V8/OS OOM behavior.
  vi.stubGlobal("Uint8Array", new Proxy(NativeUint8Array, {
    construct(target, args) {
      if (typeof args[0] === "number") {
        allocations.push(args[0]);
        if (args[0] > 2 * CIPHER_CHUNK) throw new RangeError("test allocation budget exceeded");
      }
      return Reflect.construct(target, args);
    },
  }));
  listeners = new Map();
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    skipWaiting: vi.fn(), clients: { claim: vi.fn() },
  });
  fetchCipher = vi.fn<typeof fetch>(async (_url, init) => validCipher(cipherIndex(init)));
  vi.stubGlobal("fetch", fetchCipher);
  await import("../../apps/web/src/app/service-worker.ts");
  handshake();
});

afterEach(() => {
  message({ type: "txt-lock" });
  message({ type: "txt-lock" }, OTHER_CLIENT);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("spec: bounded authenticated Service Worker media streams", () => {
  it("returns 10 GB open-ended headers immediately and fetches only on pull", async () => {
    const response = await streamingResponse("bytes=0-");
    expect(response.headers.get("content-length")).toBe(String(VIDEO_BYTES));
    expect(response.headers.get("content-range")).toBe(`bytes 0-${VIDEO_BYTES - 1}/${VIDEO_BYTES}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(fetchCipher).not.toHaveBeenCalled();

    const reader = response.body!.getReader();
    for (let index = 0; index < 2; index++) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      expect(chunk.value).toEqual(new Uint8Array(CHUNK).fill(chunkValue(index)));
      await turn();
      // No eager next-chunk fetch while the consumer is paused.
      expect(fetchCipher).toHaveBeenCalledTimes(index + 1);
    }
    expect(fetchCipher.mock.calls[0]![0]).toBe(`/api/v1/media/${MEDIA}/cipher`);
    expect(new Headers(fetchCipher.mock.calls[1]![1]?.headers).get("range"))
      .toBe(`bytes=${CIPHER_CHUNK}-${2 * CIPHER_CHUNK - 1}`);
    expect(Math.max(...allocations)).toBeLessThanOrEqual(CIPHER_CHUNK);
    await reader.cancel();
    await turn();
    expect(fetchCipher).toHaveBeenCalledTimes(2);
  });

  it("streams a 100 MB image GET without creating a whole-image buffer", async () => {
    info = { ...metadata(IMAGE_BYTES), kind: "image", mime: "image/png" };
    handshake();
    const response = await streamingResponse();
    expect(response.headers.get("content-length")).toBe(String(IMAGE_BYTES));
    expect(response.headers.get("content-range")).toBeNull();
    expect(fetchCipher).not.toHaveBeenCalled();
    const reader = response.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(CHUNK);
    await turn();
    expect(fetchCipher).toHaveBeenCalledTimes(1);
    expect(Math.max(...allocations)).toBeLessThanOrEqual(CIPHER_CHUNK);
    await reader.cancel();
  });

  it("returns headers even while an upstream fetch would remain pending", async () => {
    const gate = deferred<Response>();
    fetchCipher.mockImplementation(() => gate.promise);
    info = metadata(19);
    handshake();
    const response = await streamingResponse("bytes=0-");
    expect(fetchCipher).not.toHaveBeenCalled();
    await response.body!.cancel();
  });

  it("seeks across 4 GiB with 64-bit offsets and the original uint64 AAD", async () => {
    const boundary = 2 ** 32;
    const response = await streamingResponse(`bytes=${boundary - 7}-${boundary + 8}`);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array(7).fill(chunkValue(boundary / CHUNK - 1)));
    expect((await reader.read()).value).toEqual(new Uint8Array(9).fill(chunkValue(boundary / CHUNK)));
    expect((await reader.read()).done).toBe(true);
    expect(response.headers.get("content-length")).toBe("16");
    expect(fetchCipher.mock.calls.map(([, init]) => new Headers(init?.headers).get("range"))).toEqual(
      [4095n, 4096n].map((index) => {
        const start = index * BigInt(CIPHER_CHUNK);
        return `bytes=${start}-${start + BigInt(CIPHER_CHUNK) - 1n}`;
      }),
    );
  });

  it("authenticates the short final ciphertext chunk for a suffix request", async () => {
    const last = info.chunkCount - 1;
    const response = await streamingResponse("bytes=-23");
    expect(response.headers.get("content-range")).toBe(`bytes ${VIDEO_BYTES - 23}-${VIDEO_BYTES - 1}/${VIDEO_BYTES}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(23).fill(chunkValue(last)));
    expect(fetchCipher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchCipher.mock.calls[0]![1]?.headers).get("range"))
      .toBe(`bytes=${last * CIPHER_CHUNK}-${VIDEO_BYTES + info.chunkCount * 16 - 1}`);
  });

  it.each([
    [undefined, 200, String(VIDEO_BYTES), null],
    ["bytes=0-", 206, String(VIDEO_BYTES), `bytes 0-${VIDEO_BYTES - 1}/${VIDEO_BYTES}`],
    ["bytes=7-11", 206, "5", `bytes 7-11/${VIDEO_BYTES}`],
    ["bytes=-17", 206, "17", `bytes ${VIDEO_BYTES - 17}-${VIDEO_BYTES - 1}/${VIDEO_BYTES}`],
    ["bytes=9999999998-10000000010", 206, "2", `bytes ${VIDEO_BYTES - 2}-${VIDEO_BYTES - 1}/${VIDEO_BYTES}`],
    ["bytes=10000000000-", 416, null, `bytes */${VIDEO_BYTES}`],
    ["bytes=10-7", 416, null, `bytes */${VIDEO_BYTES}`],
    ["bytes=0-1,4-5", 200, String(VIDEO_BYTES), null],
    ["not-a-range", 200, String(VIDEO_BYTES), null],
  ])("HEAD %s returns metadata without fetching/decrypting", async (range, status, length, contentRange) => {
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    const response = await request(range ?? undefined, { method: "HEAD" });
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe(length);
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchCipher).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("verifies a real GCM tag before enqueuing any part of a chunk", async () => {
    const ciphertext = await encryptedChunk(0);
    ciphertext[ciphertext.length - 1]! ^= 1;
    fetchCipher.mockResolvedValue(new Response(ciphertext as BodyInit, { status: 206, headers: cipherHeaders(0) }));
    const response = await streamingResponse("bytes=0-3");
    await expect(response.body!.getReader().read()).rejects.toThrow();
    expect(fetchCipher).toHaveBeenCalledTimes(1);
  });

  it("does not release any plaintext from a later tampered chunk", async () => {
    fetchCipher.mockImplementation(async (_url, init) => {
      const index = cipherIndex(init);
      const ciphertext = await encryptedChunk(index);
      if (index === 1) ciphertext[0]! ^= 1;
      return new Response(ciphertext as BodyInit, { status: 206, headers: cipherHeaders(index) });
    });
    const response = await streamingResponse(`bytes=${CHUNK - 1}-${CHUNK + 1}`);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([chunkValue(0)]));
    await expect(reader.read()).rejects.toThrow();
  });

  it.each([
    "200", "missing range", "wrong start", "wrong end", "wrong total", "wildcard total",
    "oversized length", "short length", "malformed length",
  ])("rejects %s ciphertext headers before reading the body", async (fault) => {
    const ciphertext = await encryptedChunk(0);
    const body = measuredBody([ciphertext]);
    const headers = new Headers(cipherHeaders(0));
    if (fault === "missing range") headers.delete("content-range");
    if (fault === "wrong start") headers.set("content-range", `bytes 1-${CIPHER_CHUNK}/${VIDEO_BYTES + info.chunkCount * 16}`);
    if (fault === "wrong end") headers.set("content-range", `bytes 0-${CIPHER_CHUNK}/${VIDEO_BYTES + info.chunkCount * 16}`);
    if (fault === "wrong total") headers.set("content-range", `bytes 0-${CIPHER_CHUNK - 1}/${VIDEO_BYTES}`);
    if (fault === "wildcard total") headers.set("content-range", `bytes 0-${CIPHER_CHUNK - 1}/*`);
    if (fault === "oversized length") headers.set("content-length", String(VIDEO_BYTES));
    if (fault === "short length") headers.set("content-length", String(CIPHER_CHUNK - 1));
    if (fault === "malformed length") headers.set("content-length", "1e6");
    fetchCipher.mockResolvedValue(new Response(body.stream, { status: fault === "200" ? 200 : 206, headers }));
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    const response = await streamingResponse("bytes=0-3");
    await expect(response.body!.getReader().read()).rejects.toThrow();
    expect(body.pull).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it.each([true, false])("caps actual bytes when Content-Length is %s", async (declared) => {
    const body = measuredBody([await encryptedChunk(0), new Uint8Array([42]), new Uint8Array([43])]);
    const headers = new Headers(cipherHeaders(0));
    if (!declared) headers.delete("content-length");
    fetchCipher.mockResolvedValue(new Response(body.stream, { status: 206, headers }));
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    const response = await streamingResponse("bytes=0-3");
    await expect(response.body!.getReader().read()).rejects.toThrow();
    expect(body.pull).toHaveBeenCalledTimes(2);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(decrypt).not.toHaveBeenCalled();
    expect(Math.max(...allocations)).toBeLessThanOrEqual(CIPHER_CHUNK);
  });

  it("rejects a single oversized transport chunk rather than slicing off the valid prefix", async () => {
    const oversized = new Uint8Array(CIPHER_CHUNK + 1);
    oversized.set(await encryptedChunk(0));
    const body = measuredBody([oversized]);
    fetchCipher.mockResolvedValue(new Response(body.stream, { status: 206, headers: cipherHeaders(0) }));
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    const response = await streamingResponse("bytes=0-3");
    await expect(response.body!.getReader().read()).rejects.toThrow();
    expect(body.pull).toHaveBeenCalledTimes(1);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("rejects a truncated ciphertext body before decryption", async () => {
    const body = measuredBody([(await encryptedChunk(0)).subarray(0, CIPHER_CHUNK - 1)]);
    fetchCipher.mockResolvedValue(new Response(body.stream, { status: 206, headers: cipherHeaders(0) }));
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    const response = await streamingResponse("bytes=0-3");
    await expect(response.body!.getReader().read()).rejects.toThrow();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("accepts correctly framed ciphertext split across transport reads without Content-Length", async () => {
    const ciphertext = await encryptedChunk(0);
    const body = measuredBody([ciphertext.subarray(0, 7), ciphertext.subarray(7, 500), ciphertext.subarray(500)]);
    const headers = new Headers(cipherHeaders(0));
    headers.delete("content-length");
    fetchCipher.mockResolvedValue(new Response(body.stream, { status: 206, headers }));
    const response = await streamingResponse("bytes=7-11");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(5).fill(chunkValue(0)));
  });

  it("aborts an in-flight fetch on consumer cancellation, including a late ignored-abort response", async () => {
    const started = deferred<AbortSignal | undefined>();
    const gate = deferred<Response>();
    fetchCipher.mockImplementation((_url, init) => { started.resolve(init?.signal ?? undefined); return gate.promise; });
    const response = await streamingResponse("bytes=0-");
    const reader = response.body!.getReader();
    const read = reader.read();
    const signal = await started.promise;
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    await reader.cancel("seek elsewhere");
    expect(signal?.aborted).toBe(true);
    expect((await read).done).toBe(true);
    const body = measuredBody([await encryptedChunk(0)]);
    gate.resolve(new Response(body.stream, { status: 206, headers: cipherHeaders(0) }));
    await turn();
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.pull).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(fetchCipher).toHaveBeenCalledTimes(1);
  });

  it.each(["lock", "new generation", "same generation replacement"])('terminates a mid-fetch stream on %s without late plaintext', async (change) => {
    const started = deferred<AbortSignal | undefined>();
    const gate = deferred<Response>();
    fetchCipher.mockImplementation((_url, init) => { started.resolve(init?.signal ?? undefined); return gate.promise; });
    const response = await streamingResponse("bytes=0-");
    const reader = response.body!.getReader();
    const read = reader.read();
    const rejected = expect(read).rejects.toThrow();
    const signal = await started.promise;
    if (change === "lock") message({ type: "txt-lock" });
    if (change === "new generation") handshake({ sessionGeneration: 2 });
    if (change === "same generation replacement") handshake();
    expect(signal?.aborted).toBe(true);
    await rejected;
    const body = measuredBody([await encryptedChunk(0)]);
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    gate.resolve(new Response(body.stream, { status: 206, headers: cipherHeaders(0) }));
    await turn();
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.pull).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("cancels a pending ciphertext body read immediately on lock", async () => {
    const started = deferred<void>();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: () => { started.resolve(); }, cancel }, { highWaterMark: 0 });
    fetchCipher.mockResolvedValue(new Response(body, { status: 206, headers: cipherHeaders(0) }));
    const response = await streamingResponse("bytes=0-");
    const read = response.body!.getReader().read();
    const rejected = expect(read).rejects.toThrow();
    await started.promise;
    message({ type: "txt-lock" });
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("checks session ownership again after real WebCrypto decryption completes", async () => {
    const nativeDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const started = deferred<void>();
    const gate = deferred<void>();
    vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
      const plain = await nativeDecrypt(...args);
      started.resolve();
      await gate.promise;
      return plain;
    });
    const response = await streamingResponse("bytes=0-");
    const read = response.body!.getReader().read();
    const rejected = expect(read).rejects.toThrow();
    await started.promise;
    message({ type: "txt-lock" });
    await rejected;
    gate.resolve();
    await turn();
    expect(fetchCipher).toHaveBeenCalledTimes(1);
  });

  it("does not fetch another chunk after a paused stream is locked", async () => {
    const response = await streamingResponse("bytes=0-");
    const reader = response.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(CHUNK);
    message({ type: "txt-lock" });
    await expect(reader.read()).rejects.toThrow();
    expect(fetchCipher).toHaveBeenCalledTimes(1);
  });

  it("also aborts ciphertext fetch when the original request is aborted", async () => {
    const started = deferred<AbortSignal | undefined>();
    fetchCipher.mockImplementation((_url, init) => { started.resolve(init?.signal ?? undefined); return new Promise(() => {}); });
    const controller = new AbortController();
    const response = await request("bytes=0-", { signal: controller.signal });
    expect(response.status).toBe(206);
    const read = response.body!.getReader().read();
    const rejected = expect(read).rejects.toThrow();
    const signal = await started.promise;
    controller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it("serves each independently handshaken client only its own file even when generations coincide", async () => {
    info = metadata(19);
    handshake();
    const otherInfo = {
      ...metadata(23), mime: "image/png", fileKey: toBase64Url(new Uint8Array(32).fill(11)),
      noncePrefix: toBase64Url(new Uint8Array(8).fill(13)),
    };
    handshake({ media: { [OTHER_MEDIA]: otherInfo } }, OTHER_CLIENT);
    fetchCipher.mockImplementation(async (url, init) => url === `/api/v1/media/${OTHER_MEDIA}/cipher`
      ? validCipher(cipherIndex(init), otherInfo, OTHER_MEDIA) : validCipher(cipherIndex(init)));
    for (const [clientId, mediaId, ownInfo] of [
      [CLIENT, MEDIA, info], [OTHER_CLIENT, OTHER_MEDIA, otherInfo],
    ] as const) {
      const response = await request(undefined, { clientId, mediaId });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(ownInfo.mime);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(ownInfo.plainBytes).fill(chunkValue(0)));
      expect((await request(undefined, {
        method: "HEAD", clientId, mediaId: mediaId === MEDIA ? OTHER_MEDIA : MEDIA,
      })).status).toBe(404);
    }
    expect((await request(undefined, { method: "HEAD", clientId: "stranger" })).status).toBe(423);
    expect((await request(undefined, { method: "HEAD", clientId: "" })).status).toBe(403);
    expect(fetchCipher).toHaveBeenCalledTimes(2);
  });

  it("does not revoke a first client's pending stream when a second client handshakes", async () => {
    info = metadata(19);
    handshake();
    const started = deferred<AbortSignal | undefined>();
    const gate = deferred<Response>();
    fetchCipher.mockImplementation((_url, init) => { started.resolve(init?.signal ?? undefined); return gate.promise; });
    const response = await streamingResponse();
    const reader = response.body!.getReader();
    const read = reader.read().catch((error: unknown) => ({ error }));
    const signal = await started.promise;
    handshake({ media: { [OTHER_MEDIA]: metadata(23) } }, OTHER_CLIENT);
    gate.resolve(await validCipher(0));
    expect(signal?.aborted).toBe(false);
    expect(await read).toEqual({ done: false, value: new Uint8Array(19).fill(chunkValue(0)) });
    expect((await reader.read()).done).toBe(true);
    expect((await request(undefined, { method: "HEAD" })).status).toBe(200);
  });

  it("locking one client aborts only its stream and leaves the other unlocked client streaming", async () => {
    info = metadata(CHUNK + 19);
    handshake();
    handshake({ media: { [OTHER_MEDIA]: info } }, OTHER_CLIENT);
    const started = deferred<AbortSignal | undefined>();
    const gate = deferred<Response>();
    fetchCipher.mockImplementation((url, init) => {
      if (url === `/api/v1/media/${OTHER_MEDIA}/cipher`) return validCipher(cipherIndex(init), info, OTHER_MEDIA);
      started.resolve(init?.signal ?? undefined);
      return gate.promise;
    });
    const first = await streamingResponse("bytes=0-");
    const rejected = expect(first.body!.getReader().read()).rejects.toThrow();
    const signal = await started.promise;
    const second = await request("bytes=0-", { clientId: OTHER_CLIENT, mediaId: OTHER_MEDIA });
    expect(second.status).toBe(206);
    const reader = second.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array(CHUNK).fill(chunkValue(0)));
    message({ type: "txt-lock" });
    expect(signal?.aborted).toBe(true);
    await rejected;
    gate.resolve(await validCipher(0));
    expect((await request(undefined, { method: "HEAD" })).status).toBe(423);
    expect((await reader.read()).value).toEqual(new Uint8Array(19).fill(chunkValue(1)));
    expect((await reader.read()).done).toBe(true);
    expect((await request(undefined, { method: "HEAD", clientId: OTHER_CLIENT, mediaId: OTHER_MEDIA })).status).toBe(200);
  });

  it.each(["stranger", "", null])("ignores a lock without an owning session from %s", async (clientId) => {
    handshake({ media: { [OTHER_MEDIA]: info } }, OTHER_CLIENT);
    message({ type: "txt-lock" }, clientId);
    expect((await request(undefined, { method: "HEAD" })).status).toBe(200);
    expect((await request(undefined, { method: "HEAD", clientId: OTHER_CLIENT, mediaId: OTHER_MEDIA })).status).toBe(200);
    expect(fetchCipher).not.toHaveBeenCalled();
  });

  it.each(["stranger", "", null])("never acknowledges a media update without an owning session from %s", async (clientId) => {
    const postMessage = vi.fn();
    message({ type: "txt-media-update", sessionGeneration: 1, media: {} }, clientId, postMessage);
    expect(postMessage).not.toHaveBeenCalled();
    expect((await request(undefined, { method: "HEAD" })).status).toBe(200);
    expect(fetchCipher).not.toHaveBeenCalled();
  });

  it.each([17, undefined])("acknowledges media update generation %s only after its manifest is installed", async (sessionGeneration) => {
    handshake({ sessionGeneration: 17, media: {} });
    expect((await request(undefined, { method: "HEAD" })).status).toBe(404);
    let installed: Promise<Response> | undefined;
    const postMessage = vi.fn(() => { installed = request(undefined, { method: "HEAD" }); });
    message({ type: "txt-media-update", sessionGeneration, media: { [MEDIA]: info } }, CLIENT, postMessage);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "txt-ready", sessionGeneration: 17 });
    expect((await installed)?.status).toBe(200);
  });

  it.each([16, 18, null, "17"])("rejects a mismatched update generation %s without modifying or acknowledging", async (sessionGeneration) => {
    handshake({ sessionGeneration: 17 });
    const postMessage = vi.fn();
    message({ type: "txt-media-update", sessionGeneration, media: {} }, CLIENT, postMessage);
    expect((await request(undefined, { method: "HEAD" })).status).toBe(200);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("installs and acknowledges another unlocked client's update without changing the first manifest", async () => {
    handshake({ sessionGeneration: 17, media: { [OTHER_MEDIA]: info } }, OTHER_CLIENT);
    const postMessage = vi.fn();
    message({ type: "txt-media-update", sessionGeneration: 17, media: {} }, OTHER_CLIENT, postMessage);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "txt-ready", sessionGeneration: 17 });
    expect((await request(undefined, { method: "HEAD", clientId: OTHER_CLIENT, mediaId: OTHER_MEDIA })).status).toBe(404);
    expect((await request(undefined, { method: "HEAD" })).status).toBe(200);
  });

  it("acknowledges an installed handshake through its MessageChannel", () => {
    const postMessage = vi.fn();
    listeners.get("message")!({
      data: {
        type: "txt-handshake", sessionGeneration: 17,
        accountId: ACCOUNT, documentId: DOCUMENT, keyVersion: 1,
        vaultKey: toBase64Url(KEY), media: { [MEDIA]: info },
      },
      source: { id: CLIENT }, ports: [{ postMessage }],
    });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "txt-ready", sessionGeneration: 17 });
  });

  it("does not unlock via a handshake with no real client identity", async () => {
    message({ type: "txt-lock" });
    handshake({}, null);
    expect((await request(undefined, { method: "HEAD" })).status).toBe(423);
    expect(fetchCipher).not.toHaveBeenCalled();
  });
});
