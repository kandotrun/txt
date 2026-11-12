/**
 * Sync engine behaviour that protects what the user typed (spec §9.7, §10).
 *
 * The real SyncEngine runs against a scripted server: `api.document` and
 * `api.putDocument` are replaced, encryption is an identity stand-in, and the
 * draft store records what would have been written to IndexedDB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentModel } from "../../packages/protocol/src/document.ts";

const draftStore = vi.hoisted(() => ({ saved: [] as string[], cleared: 0 }));
vi.mock("../../apps/web/src/app/drafts.ts", () => ({
  saveDraft: async (draft: { plaintextDocument: string }) => { draftStore.saved.push(draft.plaintextDocument); },
  clearDraft: async () => { draftStore.cleared += 1; },
}));

const { api, ApiRequestError } = await import("../../apps/web/src/app/api.ts");
const { RevisionGuard } = await import("../../apps/web/src/app/revision-guard.ts");
const { SyncEngine } = await import("../../apps/web/src/app/sync.ts");

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const BLOCK = "22222222-2222-4222-8222-222222222222";
const etag = (revision: number): string => `"d-${DOC_ID}-e-1-r${revision}"`;
const docOf = (text: string): DocumentModel => ({ schemaVersion: 1, blocks: [{ id: BLOCK, type: "text", text }], media: {} });
/** A server copy: `sealedAt` is the revision the ciphertext was really made for. */
const serverCopy = (revision: number, text: string, sealedAt = revision) => ({
  data: {
    accountId: "a", documentId: DOC_ID, syncEpoch: 1, revision, encryptedRevision: sealedAt,
    formatVersion: 1, keyVersion: 1, mutationId: "m", nonce: "n", ciphertext: `${sealedAt}:${text}`,
    referencedMediaIds: [], updatedAt: 0,
  },
  etag: etag(revision),
  notModified: false,
});
const notModified = { notModified: true as const };

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

interface Harness {
  engine: InstanceType<typeof SyncEngine>;
  states: string[];
  applied: string[];
  editor: { text: string; safe: boolean };
  type(text: string): void;
  listeners: Map<string, Array<() => void>>;
}

function start(options: { revision: number; text: string }): Harness {
  const listeners = new Map<string, Array<() => void>>();
  const on = (name: string, handler: () => void): void => { listeners.set(name, [...(listeners.get(name) ?? []), handler]); };
  vi.stubGlobal("window", {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    addEventListener: on,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("document", { hidden: false, addEventListener: on, removeEventListener: () => undefined });
  vi.stubGlobal("BroadcastChannel", undefined);

  const editor = { text: options.text, safe: true };
  const states: string[] = [];
  const applied: string[] = [];
  const revisions = new RevisionGuard(DOC_ID, memoryStorage());
  revisions.record(options.revision);
  const engine = new SyncEngine({
    bridge: {
      lastDroppedMediaIds: [],
      // The stand-in for AEAD: the "ciphertext" names the revision it was
      // sealed for, and opening it under any other revision fails, exactly as
      // the AAD binding does.
      decryptDocument: async (input: { ciphertext: string; encryptedRevision: number }) => {
        const [sealedAt, ...rest] = input.ciphertext.split(":");
        if (Number(sealedAt) !== input.encryptedRevision) throw new Error("decrypt failed");
        return docOf(rest.join(":"));
      },
      encryptDocument: async (input: { document: DocumentModel; encryptedRevision: number }) => ({
        nonce: "n",
        ciphertext: `${input.encryptedRevision}:${(input.document.blocks[0] as { text: string }).text}`,
      }),
    } as never,
    callbacks: {
      getDocument: () => docOf(editor.text),
      applyRemote: (remote) => {
        editor.text = (remote.blocks[0] as { text: string }).text;
        applied.push(editor.text);
      },
      onState: (state, detail) => { states.push(detail ? `${state}:${detail}` : state); },
      onConflict: async () => "keep-local",
      isSafePoint: () => editor.safe,
    },
    accountId: "a",
    documentId: DOC_ID,
    keyVersion: 1,
    vaultKey: new Uint8Array(32),
    baseEtag: etag(options.revision),
    baseRevision: options.revision,
    revisions,
  });
  engine.start();
  return {
    engine, states, applied, editor, listeners,
    type(text: string) { editor.text = text; engine.noteCommittedChange(); },
  };
}

describe("SyncEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    draftStore.saved.length = 0;
    draftStore.cleared = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("spec: a save that fails on the network is sent again without another keystroke", async () => {
    vi.spyOn(api, "document").mockResolvedValue(notModified);
    const put = vi.spyOn(api, "putDocument")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ etag: etag(6), revision: 6, mutationId: "x", updatedAt: 0 });
    const h = start({ revision: 5, text: "v5" });

    h.type("last sentence");
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(1);

    // The user has stopped typing. The retry must happen on its own (§10.6).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(put).toHaveBeenCalledTimes(2);
    // Same mutation, same base: the retry is the idempotent re-send.
    expect(put.mock.calls[1]![0]).toEqual(put.mock.calls[0]![0]);
    expect(put.mock.calls[1]![1]).toBe(etag(5));
    expect(h.states.at(-1)).toMatch(/^(saved|idle)$/);
    h.engine.stop();
  });

  it.each([
    ["429", () => new ApiRequestError(429, "TOO_MANY_REQUESTS", "rate limited")],
    ["503", () => new ApiRequestError(503, "SERVICE_UNAVAILABLE", "unavailable")],
  ])("spec: a save refused with %s is retried", async (_name, failure) => {
    vi.spyOn(api, "document").mockResolvedValue(notModified);
    const put = vi.spyOn(api, "putDocument")
      .mockRejectedValueOnce(failure())
      .mockResolvedValue({ etag: etag(6), revision: 6, mutationId: "x", updatedAt: 0 });
    const h = start({ revision: 5, text: "v5" });
    h.type("text");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(put).toHaveBeenCalledTimes(2);
    h.engine.stop();
  });

  it("spec: a remote version is not applied during an IME composition, and is applied once it ends", async () => {
    // A conditional read: 304 once this device's base is the server's copy.
    const get = vi.spyOn(api, "document").mockImplementation(async (known?: string) =>
      known === etag(6) ? notModified : serverCopy(6, "from another device"));
    vi.spyOn(api, "putDocument");
    const h = start({ revision: 5, text: "v5" });

    // Composing: nothing is committed, so the engine is not dirty.
    h.editor.safe = false;
    h.engine.noteComposingChange();
    await vi.advanceTimersByTimeAsync(6000);
    expect(get).toHaveBeenCalled();
    expect(h.applied).toEqual([]);

    h.editor.safe = true;
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.applied).toEqual(["from another device"]);
    h.engine.stop();
  });

  it("spec: a copy sealed for an older revision is refused even when the server reports a current revision", async () => {
    // Authentic ciphertext of revision 3, relabelled as revision 11.
    vi.spyOn(api, "document").mockResolvedValue(serverCopy(11, "old text", 3));
    const put = vi.spyOn(api, "putDocument");
    const h = start({ revision: 10, text: "v10" });

    await vi.advanceTimersByTimeAsync(6000);
    expect(h.applied).toEqual([]);
    expect(h.editor.text).toBe("v10");
    expect(h.states.at(-1)).toContain("以前の版に戻されています");

    // What is on screen is the only surviving copy: it is stored locally.
    await vi.advanceTimersByTimeAsync(1000);
    expect(draftStore.saved.at(-1)).toContain("v10");

    // The warning stays, typing is still protected locally, nothing is sent.
    h.type("typed after the warning");
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.states.at(-1)).toContain("以前の版に戻されています");
    expect(draftStore.saved.at(-1)).toContain("typed after the warning");
    expect(put).not.toHaveBeenCalled();
    h.engine.stop();
  });

  it("spec: a raised sync epoch does not make an older copy acceptable", async () => {
    const older = serverCopy(2, "restored", 2);
    older.data.syncEpoch = 9;
    older.etag = `"d-${DOC_ID}-e-9-r2"`;
    vi.spyOn(api, "document").mockResolvedValue(older);
    const h = start({ revision: 10, text: "v10" });
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.applied).toEqual([]);
    expect(h.states.at(-1)).toContain("以前の版に戻されています");
    h.engine.stop();
  });

  it("spec: a response that merely arrives late is ignored, not treated as a rollback", async () => {
    // Two reads are in flight while this device saves revision 7.
    let releaseLate!: (value: ReturnType<typeof serverCopy>) => void;
    const late = new Promise<ReturnType<typeof serverCopy>>((resolve) => { releaseLate = resolve; });
    const get = vi.spyOn(api, "document")
      .mockReturnValueOnce(late as never)
      .mockResolvedValueOnce(serverCopy(6, "r6"))
      .mockResolvedValue(notModified);
    const put = vi.spyOn(api, "putDocument").mockImplementation(async (payload) => {
      const revision = (payload as { encryptedRevision: number }).encryptedRevision;
      return { etag: etag(revision), revision, mutationId: "x", updatedAt: 0 };
    });
    const h = start({ revision: 5, text: "v5" });

    for (const handler of h.listeners.get("focus") ?? []) handler(); // read #1 (slow)
    for (const handler of h.listeners.get("focus") ?? []) handler(); // read #2 (fast): r6 applied
    await vi.advanceTimersByTimeAsync(10);
    expect(h.applied).toEqual(["r6"]);

    h.type("r7 by this device");
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(1);

    releaseLate(serverCopy(6, "r6")); // read #1 finally answers with the older r6
    await vi.advanceTimersByTimeAsync(10);
    expect(h.states.join("|")).not.toContain("以前の版に戻されています");
    expect(h.editor.text).toBe("r7 by this device");

    h.type("r8 by this device");
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalled();
    h.engine.stop();
  });

  it("spec: converging with the server without a save clears the local draft", async () => {
    // The PUT is refused (the server already moved), and the server copy turns
    // out to equal what is on screen: nothing is unsynced any more.
    vi.spyOn(api, "document").mockResolvedValue(serverCopy(6, "same text"));
    vi.spyOn(api, "putDocument").mockRejectedValue(new ApiRequestError(412, "PRECONDITION_FAILED", "stale"));
    const h = start({ revision: 5, text: "v5" });
    h.type("same text");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.states.at(-1)).toBe("saved");
    expect(draftStore.cleared).toBeGreaterThanOrEqual(1);
    h.engine.stop();
  });

  it("spec: a sheet over the size limit is kept locally and explained, not sent and not retried", async () => {
    vi.spyOn(api, "document").mockResolvedValue(notModified);
    const put = vi.spyOn(api, "putDocument");
    const h = start({ revision: 5, text: "v5" });
    h.type("あ".repeat(400_000)); // 1.2 MB of UTF-8, over the 1 MiB limit
    await vi.advanceTimersByTimeAsync(60_000);
    expect(put).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toMatch(/^local-only:.*上限/);
    // The text is not dropped: it is still what a draft holds.
    expect(draftStore.saved.at(-1)?.length).toBeGreaterThan(400_000);
    h.engine.stop();
  });

  it("spec: a save the server rejects as too large is explained and not retried", async () => {
    vi.spyOn(api, "document").mockResolvedValue(notModified);
    const put = vi.spyOn(api, "putDocument")
      .mockRejectedValue(new ApiRequestError(413, "PAYLOAD_TOO_LARGE", "request body too large"));
    const h = start({ revision: 5, text: "v5" });
    h.type("text");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(put).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)).toMatch(/^local-only:.*上限/);
    h.engine.stop();
  });

  it("spec: a sheet that fails validation is reported instead of failing silently", async () => {
    vi.spyOn(api, "document").mockResolvedValue(notModified);
    const put = vi.spyOn(api, "putDocument");
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    try {
      const h = start({ revision: 5, text: "v5" });
      h.type("a line ending the document format forbids\r");
      await vi.advanceTimersByTimeAsync(5000);
      await new Promise<void>((resolve) => { vi.useRealTimers(); setTimeout(resolve, 20); });
      expect(put).not.toHaveBeenCalled();
      expect(h.states.at(-1)).toMatch(/^local-only:本文の整合性/);
      expect(rejections).toEqual([]);
      h.engine.stop();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
