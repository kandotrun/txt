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

  it("spec: this page's own save coming back through a poll is not applied as a remote version", async () => {
    // The read is sent while the save is in flight (so it still names the old
    // base) and is answered, after the save, with the page's own new copy.
    let releaseRead!: (value: ReturnType<typeof serverCopy>) => void;
    const slowRead = new Promise<ReturnType<typeof serverCopy>>((resolve) => { releaseRead = resolve; });
    vi.spyOn(api, "document").mockReturnValueOnce(slowRead as never).mockResolvedValue(notModified);
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    vi.spyOn(api, "putDocument").mockImplementation(async () => {
      await saveGate;
      return { etag: etag(6), revision: 6, mutationId: "x", updatedAt: 0 };
    });
    const h = start({ revision: 5, text: "v5" });
    h.type("hello");
    await vi.advanceTimersByTimeAsync(400); // the save is in flight
    for (const handler of h.listeners.get("focus") ?? []) handler(); // the read is in flight
    await vi.advanceTimersByTimeAsync(10);
    releaseSave();
    await vi.advanceTimersByTimeAsync(10);
    releaseRead(serverCopy(6, "hello"));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.applied).toEqual([]);
    h.engine.stop();
  });

  it("spec: a lost response to this page's own save does not become a conflict with itself", async () => {
    // The first save reaches the server but its answer is lost; the user keeps
    // typing. The retry is refused (the base moved to the page's own save).
    const server = { revision: 5, text: "v5", mutationId: "m" };
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      if (known === etag(server.revision)) return notModified;
      const copy = serverCopy(server.revision, server.text);
      copy.data.mutationId = server.mutationId;
      return copy;
    });
    let lostOnce = true;
    const put = vi.spyOn(api, "putDocument").mockImplementation(async (payload, ifMatch) => {
      const body = payload as { mutationId: string; encryptedRevision: number; ciphertext: string };
      if (ifMatch !== etag(server.revision)) throw new ApiRequestError(412, "PRECONDITION_FAILED", "stale");
      server.revision = body.encryptedRevision;
      server.text = body.ciphertext.split(":").slice(1).join(":");
      server.mutationId = body.mutationId;
      if (lostOnce) {
        lostOnce = false;
        throw new TypeError("Failed to fetch"); // committed, answer lost
      }
      return { etag: etag(server.revision), revision: server.revision, mutationId: body.mutationId, updatedAt: 0 };
    });
    const conflicts: string[] = [];
    const h = start({ revision: 5, text: "v5" });
    (h.engine as unknown as { callbacks: { onConflict: () => Promise<string> } }).callbacks.onConflict = async () => {
      conflicts.push("asked");
      return "keep-local";
    };
    h.type("first sentence");
    await vi.advanceTimersByTimeAsync(400);
    h.type("first sentence, second sentence");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(conflicts).toEqual([]);
    expect(server.text).toBe("first sentence, second sentence");
    expect(put.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(h.states.at(-1)).toMatch(/^(saved|idle)$/);
    h.engine.stop();
  });

  it("spec: the rollback warning is not replaced by a later status", async () => {
    const get = vi.spyOn(api, "document").mockResolvedValue(notModified);
    vi.spyOn(api, "putDocument").mockResolvedValue({ etag: etag(11), revision: 11, mutationId: "x", updatedAt: 0 });
    const h = start({ revision: 10, text: "v10" });
    h.type("v11");
    await vi.advanceTimersByTimeAsync(500); // saved; the "idle" timer is pending
    get.mockResolvedValue(serverCopy(12, "old", 3));
    for (const handler of h.listeners.get("focus") ?? []) handler();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.states.at(-1)).toContain("以前の版に戻されています");
    await vi.advanceTimersByTimeAsync(5000); // the pending "idle" timer fires
    for (const handler of h.listeners.get("offline") ?? []) handler();
    expect(h.states.at(-1)).toContain("以前の版に戻されています");
    h.engine.stop();
  });

  it("spec: an edit made while a save was being refused is still sent", async () => {
    vi.spyOn(api, "document").mockResolvedValue(notModified);
    let rejectFirst!: (reason: unknown) => void;
    const firstSave = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    const put = vi.spyOn(api, "putDocument")
      .mockReturnValueOnce(firstSave as never)
      .mockResolvedValue({ etag: etag(6), revision: 6, mutationId: "x", updatedAt: 0 });
    const h = start({ revision: 5, text: "v5" });
    h.type("refused content");
    await vi.advanceTimersByTimeAsync(400); // first save in flight
    h.type("corrected content");
    await vi.advanceTimersByTimeAsync(5000); // its timers fire while the first is pending
    rejectFirst(new ApiRequestError(422, "UNPROCESSABLE", "bad reference"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(put).toHaveBeenCalledTimes(2);
    expect(h.states.at(-1)).toMatch(/^(saved|idle)$/);
    h.engine.stop();
  });

  it("spec: a composition that changes nothing lets the deferred remote version apply, with no conflict", async () => {
    vi.spyOn(api, "document").mockImplementation(async (known?: string) =>
      known === etag(6) ? notModified : serverCopy(6, "from another device"));
    const put = vi.spyOn(api, "putDocument");
    const conflicts: string[] = [];
    const h = start({ revision: 5, text: "v5" });
    (h.engine as unknown as { callbacks: { onConflict: () => Promise<string> } }).callbacks.onConflict = async () => {
      conflicts.push("asked");
      return "keep-local";
    };
    h.editor.safe = false;
    h.engine.noteComposingChange();
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.applied).toEqual([]);
    // The composition is cancelled: the app reports a committed change even
    // though the text is what it was.
    h.editor.safe = true;
    h.engine.noteCommittedChange();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(conflicts).toEqual([]);
    expect(put).not.toHaveBeenCalled();
    expect(h.applied).toEqual(["from another device"]);
    h.engine.stop();
  });

  it("spec: a refused save whose remote copy cannot be opened is reported, not left hanging", async () => {
    // 412, then a copy whose ciphertext does not open under the revision it
    // claims (tampered or corrupted): decryption fails.
    const unreadable = serverCopy(9, "garbled");
    unreadable.data.ciphertext = "1:garbled";
    vi.spyOn(api, "document").mockImplementation(async (known?: string) =>
      known === undefined ? unreadable : notModified);
    vi.spyOn(api, "putDocument").mockRejectedValue(new ApiRequestError(412, "PRECONDITION_FAILED", "stale"));
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    try {
      const h = start({ revision: 5, text: "v5" });
      h.type("text");
      await vi.advanceTimersByTimeAsync(2000);
      await new Promise<void>((resolve) => { vi.useRealTimers(); setTimeout(resolve, 20); });
      expect(rejections).toEqual([]);
      expect(h.states.at(-1)).toContain("内容を開けません");
      h.engine.stop();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("spec: undoing a save whose answer was lost is itself saved, not replaced by that save", async () => {
    // Base "PARAGRAPH". The user replaces it with "x"; the save is stored but
    // its answer is lost. The user presses Undo before the retry.
    const server = { revision: 5, text: "PARAGRAPH", mutationId: "m" };
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      if (known === etag(server.revision)) return notModified;
      const copy = serverCopy(server.revision, server.text);
      copy.data.mutationId = server.mutationId;
      return copy;
    });
    let loseNextAnswer = true;
    vi.spyOn(api, "putDocument").mockImplementation(async (payload, ifMatch) => {
      const body = payload as { mutationId: string; encryptedRevision: number; ciphertext: string };
      if (ifMatch !== etag(server.revision)) throw new ApiRequestError(412, "PRECONDITION_FAILED", "stale");
      server.revision = body.encryptedRevision;
      server.text = body.ciphertext.split(":").slice(1).join(":");
      server.mutationId = body.mutationId;
      if (loseNextAnswer) {
        loseNextAnswer = false;
        throw new TypeError("Failed to fetch");
      }
      return { etag: etag(server.revision), revision: server.revision, mutationId: body.mutationId, updatedAt: 0 };
    });
    const conflicts: string[] = [];
    const h = start({ revision: 5, text: "PARAGRAPH" });
    (h.engine as unknown as { callbacks: { onConflict: () => Promise<string> } }).callbacks.onConflict = async () => {
      conflicts.push("asked");
      return "keep-local";
    };
    h.type("x");
    await vi.advanceTimersByTimeAsync(400);
    expect(server.text).toBe("x"); // stored; the page does not know
    h.type("PARAGRAPH"); // Undo: the screen equals the old base again
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.applied).toEqual([]);
    expect(h.editor.text).toBe("PARAGRAPH");
    expect(server.text).toBe("PARAGRAPH");
    expect(conflicts).toEqual([]);
    h.engine.stop();
  });

  it("spec: undoing a lost-answer save that another device built on asks instead of taking the other copy", async () => {
    const server = { revision: 5, text: "PARAGRAPH", mutationId: "m" };
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      if (known === etag(server.revision)) return notModified;
      const copy = serverCopy(server.revision, server.text);
      copy.data.mutationId = server.mutationId;
      return copy;
    });
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    let puts = 0;
    vi.spyOn(api, "putDocument").mockImplementation(async (payload, ifMatch) => {
      const body = payload as { mutationId: string; encryptedRevision: number; ciphertext: string };
      puts += 1;
      if (puts === 1) {
        // Stored, answer lost; then another device saves on top of it.
        server.revision = body.encryptedRevision;
        server.text = body.ciphertext.split(":").slice(1).join(":");
        server.mutationId = body.mutationId;
        server.revision += 1;
        server.text = "x + phone";
        server.mutationId = "foreign";
        throw new TypeError("Failed to fetch");
      }
      if (puts === 2) await retryGate; // the retry is in flight while the user undoes
      if (ifMatch !== etag(server.revision)) throw new ApiRequestError(412, "PRECONDITION_FAILED", "stale");
      server.revision = body.encryptedRevision;
      server.text = body.ciphertext.split(":").slice(1).join(":");
      server.mutationId = body.mutationId;
      return { etag: etag(server.revision), revision: server.revision, mutationId: body.mutationId, updatedAt: 0 };
    });
    const conflicts: Array<{ local: string; remote: string }> = [];
    const h = start({ revision: 5, text: "PARAGRAPH" });
    (h.engine as unknown as { callbacks: { onConflict: (details: { local: DocumentModel; remote: DocumentModel }) => Promise<string> } })
      .callbacks.onConflict = async ({ local, remote }) => {
        conflicts.push({
          local: (local.blocks[0] as { text: string }).text,
          remote: (remote.blocks[0] as { text: string }).text,
        });
        return "keep-local";
      };
    h.type("x");
    await vi.advanceTimersByTimeAsync(400); // first save: stored, answer lost
    await vi.advanceTimersByTimeAsync(2000); // the retry starts and waits
    h.type("PARAGRAPH"); // Undo while the retry is in flight
    releaseRetry();
    await vi.advanceTimersByTimeAsync(30_000);
    // The other device's copy is never taken silently: the user is asked.
    expect(h.applied).toEqual([]);
    expect(conflicts).toEqual([{ local: "PARAGRAPH", remote: "x + phone" }]);
    h.engine.stop();
  });

  it("spec: a refusal that concerns a base the page has already left is not shown as a conflict", async () => {
    // The first save is stored but its answer is lost; a read then finds the
    // server already holding what is on screen and moves the base. The late
    // 412 for the retry must not turn the next edit into a conflict question.
    const server = { revision: 5, text: "v5", mutationId: "m" };
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      if (known === etag(server.revision)) return notModified;
      const copy = serverCopy(server.revision, server.text);
      copy.data.mutationId = server.mutationId;
      return copy;
    });
    let puts = 0;
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    vi.spyOn(api, "putDocument").mockImplementation(async (payload, ifMatch) => {
      const body = payload as { mutationId: string; encryptedRevision: number; ciphertext: string };
      puts += 1;
      const stale = ifMatch !== etag(server.revision);
      if (!stale) {
        server.revision = body.encryptedRevision;
        server.text = body.ciphertext.split(":").slice(1).join(":");
        server.mutationId = body.mutationId;
      }
      if (puts === 1) throw new TypeError("Failed to fetch");
      if (puts === 2) await retryGate;
      if (stale) throw new ApiRequestError(412, "PRECONDITION_FAILED", "stale");
      return { etag: etag(server.revision), revision: server.revision, mutationId: body.mutationId, updatedAt: 0 };
    });
    const conflicts: string[] = [];
    const h = start({ revision: 5, text: "v5" });
    (h.engine as unknown as { callbacks: { onConflict: () => Promise<string> } }).callbacks.onConflict = async () => {
      conflicts.push("asked");
      return "keep-local";
    };
    h.type("first");
    await vi.advanceTimersByTimeAsync(400); // stored, answer lost
    await vi.advanceTimersByTimeAsync(2000); // retry in flight (will be 412)
    for (const handler of h.listeners.get("focus") ?? []) handler(); // a read converges on "first"
    await vi.advanceTimersByTimeAsync(50);
    h.type("first, second");
    releaseRetry(); // the 412 about the old base arrives now
    await vi.advanceTimersByTimeAsync(30_000);
    expect(conflicts).toEqual([]);
    expect(server.text).toBe("first, second");
    expect(h.states.at(-1)).toMatch(/^(saved|idle)$/);
    h.engine.stop();
  });
});
