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
