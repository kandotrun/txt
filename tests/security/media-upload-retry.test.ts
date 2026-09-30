import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadFile } from "../../apps/web/src/app/media.ts";
import type { CryptoBridge } from "../../apps/web/src/app/crypto-bridge.ts";

const mediaId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function upload(signal = new AbortController().signal) {
  // 転送再試行だけを検証する。暗号ワーカー境界は固定サイズの暗号文fixture。
  const encryptChunk = vi.fn(async () => new Uint8Array(48).fill(7));
  const promise = uploadFile({
    file: new File([new Uint8Array(32)], "fixture.mp4", { type: "video/mp4" }),
    kind: "video", documentId,
    bridge: { encryptChunk } as unknown as CryptoBridge,
    signal, onProgress: vi.fn(), onStarted: vi.fn(),
  });
  return { promise, encryptChunk };
}

function installFetch(statuses: number[]) {
  const bodies: BodyInit[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/parts/1")) {
      bodies.push(init!.body!);
      const status = statuses.shift() ?? 200;
      return json({ error: { code: status === 409 ? "PART_CONFLICT" : "UPLOAD_FAILED" } }, status);
    }
    if (url.endsWith("/complete")) return json({ mediaId, state: "ready" });
    if (init?.method === "DELETE") return json({ ok: true });
    return json({ mediaId, partCount: 1, partBytes: 8_388_736, cipherBytes: 48 }, 201);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, bodies };
}


function installBusyPollFetch(poll: (attempt: number) => Promise<Response> | Response, lostResponse = false) {
  const bodies: BodyInit[] = [];
  const partTimes: number[] = [];
  const pollTimes: number[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/parts/1")) {
      bodies.push(init!.body!);
      partTimes.push(Date.now());
      if (lostResponse && bodies.length === 1) throw new TypeError("response lost");
      return json({ error: { code: "PART_BUSY" } }, 409);
    }
    if (init?.method === "GET" && url.endsWith(mediaId)) {
      pollTimes.push(Date.now());
      return poll(pollTimes.length);
    }
    if (init?.method === "DELETE") return json({ ok: true });
    if (url.endsWith("/complete")) return json({ mediaId, state: "ready" });
    return json({ mediaId, partCount: 1, cipherBytes: 48 }, 201);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, bodies, partTimes, pollTimes };
}

const accepted = () => json({ mediaId, state: "uploading", acceptedParts: [{ partNumber: 1, bytes: 48 }] });

function cleanupCalls(fetch: ReturnType<typeof installBusyPollFetch>["fetch"]) {
  return fetch.mock.calls.filter(([url, init]) => url.endsWith(mediaId) && init?.method === "DELETE");
}

describe("spec: PART_BUSY status polling transient failures", () => {
  it("lost part response then poll network failure reconciles the same ciphertext", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { bodies, pollTimes, partTimes } = installBusyPollFetch((attempt) => {
      if (attempt === 1) throw new TypeError("status network failure");
      return accepted();
    }, true);
    const { promise, encryptChunk } = upload();
    const result = promise.catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ mediaId });
    expect(partTimes.map((time) => time - start)).toEqual([0, 1000]);
    expect(pollTimes.map((time) => time - start)).toEqual([2000, 4000]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(encryptChunk).toHaveBeenCalledTimes(1);
  });

  it("HTML 502 status response retries before parsing success JSON", async () => {
    vi.useFakeTimers();
    const { pollTimes, bodies } = installBusyPollFetch((attempt) => attempt === 1
      ? new Response("<html>Bad Gateway</html>", { status: 502 }) : accepted());
    const result = upload().promise.catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ mediaId });
    expect(pollTimes).toHaveLength(2);
    expect(pollTimes[1]! - pollTimes[0]!).toBe(1000);
    expect(bodies).toHaveLength(1);
  });

  it.each([408, 429, 500, 503, 599])("HTTP %i status failure retries within the part budget", async (status) => {
    vi.useFakeTimers();
    const { pollTimes, bodies } = installBusyPollFetch((attempt) => attempt === 1
      ? json({ error: { code: "STATUS_TEMPORARY" } }, status) : accepted());
    const result = upload().promise.catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ mediaId });
    expect(pollTimes).toHaveLength(2);
    expect(bodies).toHaveLength(1);
  });

  it("permanent 403 with invalid error JSON fails as ApiRequestError and cleans up", async () => {
    vi.useFakeTimers();
    const { fetch, pollTimes, bodies } = installBusyPollFetch(() => new Response("<html>Forbidden</html>", { status: 403 }));
    const result = upload().promise.catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ name: "ApiRequestError", status: 403, code: "HTTP_ERROR" });
    expect(pollTimes).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    expect(cleanupCalls(fetch)).toHaveLength(1);
  });

  it("repeated polling failures exhaust two backoffs without resetting the budget", async () => {
    vi.useFakeTimers();
    const { fetch, pollTimes, bodies } = installBusyPollFetch(() => { throw new TypeError("status offline"); });
    const result = upload().promise.catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(TypeError);
    expect(pollTimes).toHaveLength(3);
    expect(pollTimes.slice(1).map((time, index) => time - pollTimes[index]!)).toEqual([1000, 2000]);
    expect(bodies).toHaveLength(1);
    expect(cleanupCalls(fetch)).toHaveLength(1);
  });

  it("lost part response consumes one of the two shared poll backoffs", async () => {
    vi.useFakeTimers();
    const { fetch, pollTimes, bodies } = installBusyPollFetch(() => json({ error: { code: "STATUS_FAILED" } }, 503), true);
    const result = upload().promise.catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ status: 503 });
    expect(pollTimes).toHaveLength(2);
    expect(pollTimes[1]! - pollTimes[0]!).toBe(2000);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(cleanupCalls(fetch)).toHaveLength(1);
  });

  it("abort during polling backoff stops every later poll and upload and cleans up", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { fetch, pollTimes, bodies } = installBusyPollFetch(() => {
      setTimeout(() => controller.abort(), 100);
      throw new TypeError("status offline");
    });
    const result = upload(controller.signal).promise.catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(controller.signal.aborted).toBe(true);
    expect(pollTimes).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    expect(cleanupCalls(fetch)).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/complete"))).toHaveLength(0);
  });
});

describe("spec: 大容量転送の一時的なパート失敗", () => {
  it("一時的な500を同一暗号文で再試行し、再暗号化しない", async () => {
    vi.useFakeTimers();
    const { bodies } = installFetch([500, 200]);
    const { promise, encryptChunk } = upload();
    const result = promise.then((value) => value, (error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ mediaId });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(encryptChunk).toHaveBeenCalledTimes(1);
  });

  it("失敗が続いても3回で打ち切る", async () => {
    vi.useFakeTimers();
    const { bodies } = installFetch([503, 503, 503, 200]);
    const { promise } = upload();
    const rejected = promise.catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await rejected).toMatchObject({ status: 503 });
    expect(bodies).toHaveLength(3);
  });

  it.each([401, 403, 409, 413, 422])("HTTP %i は再試行しない", async (status) => {
    const { bodies } = installFetch([status, 200]);
    await expect(upload().promise).rejects.toMatchObject({ status });
    expect(bodies).toHaveLength(1);
  });

  it("spec: lost response then PART_BUSY reconciles acceptance without re-encryption", async () => {
    vi.useFakeTimers();
    const bodies: BodyInit[] = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    const controller = new AbortController();
    let polls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/parts/1")) {
        bodies.push(init!.body!);
        signals.push(init?.signal);
        if (bodies.length === 1) throw new TypeError("response lost");
        return json({ error: { code: "PART_BUSY", message: "retry later" } }, 409);
      }
      if (init?.method === "GET" && url.endsWith(mediaId)) {
        polls++;
        signals.push(init.signal);
        return json({ mediaId, state: "uploading", acceptedParts: [{ partNumber: 1, bytes: 48 }] });
      }
      if (url.endsWith("/complete")) return json({ mediaId, state: "ready" });
      return json({ mediaId, partCount: 1, cipherBytes: 48 }, 201);
    }));
    const { promise, encryptChunk } = upload(controller.signal);
    const result = promise.catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ mediaId });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(encryptChunk).toHaveBeenCalledTimes(1);
    expect(polls).toBe(1);
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });

  it("spec: persistent PART_BUSY terminates with bounded retries using the same encrypted buffer", async () => {
    vi.useFakeTimers();
    const bodies: BodyInit[] = [];
    let polls = 0;
    const startTime = Date.now();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/parts/1")) {
        bodies.push(init!.body!);
        return json({ error: { code: "PART_BUSY" } }, 409);
      }
      if (init?.method === "GET" && url.endsWith(mediaId)) {
        polls++;
        return json({ mediaId, state: "uploading", acceptedParts: [] });
      }
      return json({ mediaId, partCount: 1, cipherBytes: 48 }, 201);
    }));
    const { promise, encryptChunk } = upload();
    const result = promise.catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ status: 409, code: "PART_BUSY" });
    expect(polls).toBeGreaterThan(0);
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.length).toBeLessThanOrEqual(17);
    expect(Date.now() - startTime).toBeLessThanOrEqual(65_000);
    expect(bodies.every((body) => body === bodies[0])).toBe(true);
    expect(encryptChunk).toHaveBeenCalledTimes(1);
  });

  it("spec: abort during PART_BUSY backoff stops retries and sends cleanup DELETE", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/parts/1")) {
        setTimeout(() => controller.abort(), 100);
        return json({ error: { code: "PART_BUSY" } }, 409);
      }
      if (init?.method === "DELETE") return json({ ok: true });
      return json({ mediaId, partCount: 1, cipherBytes: 48 }, 201);
    });
    vi.stubGlobal("fetch", fetch);
    const result = upload(controller.signal).promise.catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/parts/1"))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url, init]) => url.endsWith(mediaId) && init?.method === "DELETE")).toHaveLength(1);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(0);
  });

  it("取消は送信中のfetchにも伝わり、次のパートを送らない", async () => {
    const controller = new AbortController();
    let partSignal: AbortSignal | null | undefined;
    let started!: () => void;
    const partStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/parts/1")) {
        partSignal = init?.signal;
        started();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      if (init?.method === "DELETE") return json({ ok: true });
      return json({ mediaId, partCount: 1, partBytes: 8_388_736, cipherBytes: 48 }, 201);
    }));
    const { promise } = upload(controller.signal);
    const rejected = promise.catch((error: Error) => error);
    await partStarted;
    // REDでもハングせず、実際にsignal未配線であることを先に検出する。
    expect(partSignal).toBe(controller.signal);
    controller.abort();
    expect(await rejected).toMatchObject({ name: "AbortError" });
  });
});
