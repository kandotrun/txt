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
  /** Fires the page's `focus` listeners: the engine reads the server now. */
  focus(): void;
  /** Where the device's rollback mark lives; shared by every tab of the browser. */
  storage: ReturnType<typeof memoryStorage>;
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
  const storage = memoryStorage();
  const revisions = new RevisionGuard(DOC_ID, storage);
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
    engine, states, applied, editor, listeners, storage,
    type(text: string) { editor.text = text; engine.noteCommittedChange(); },
    focus() { for (const handler of listeners.get("focus") ?? []) handler(); },
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

    h.focus(); // read #1 (slow)
    h.focus(); // read #2 (fast): r6 applied
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
    h.focus(); // the read is in flight
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
    h.focus();
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
    h.focus(); // a read converges on "first"
    await vi.advanceTimersByTimeAsync(50);
    h.type("first, second");
    releaseRetry(); // the 412 about the old base arrives now
    await vi.advanceTimersByTimeAsync(30_000);
    expect(conflicts).toEqual([]);
    expect(server.text).toBe("first, second");
    expect(h.states.at(-1)).toMatch(/^(saved|idle)$/);
    h.engine.stop();
  });

  it("spec: a save confirmed late does not move the base back behind a copy applied meanwhile", async () => {
    // The save of "A" is stored as r6 but its answer takes long. Meanwhile a
    // read finds server and screen equal (base r6), another device stores r7,
    // and the next read applies it. The user then changes the text back.
    const server = { revision: 5, text: "v5", mutationId: "m" };
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      if (known === etag(server.revision)) return notModified;
      const copy = serverCopy(server.revision, server.text);
      copy.data.mutationId = server.mutationId;
      return copy;
    });
    let releaseFirstAnswer!: () => void;
    const firstAnswer = new Promise<void>((resolve) => { releaseFirstAnswer = resolve; });
    let puts = 0;
    vi.spyOn(api, "putDocument").mockImplementation(async (payload, ifMatch) => {
      const body = payload as { mutationId: string; encryptedRevision: number; ciphertext: string };
      puts += 1;
      if (ifMatch !== etag(server.revision)) throw new ApiRequestError(412, "PRECONDITION_FAILED", "stale");
      server.revision = body.encryptedRevision;
      server.text = body.ciphertext.split(":").slice(1).join(":");
      server.mutationId = body.mutationId;
      const answer = { etag: etag(server.revision), revision: server.revision, mutationId: body.mutationId, updatedAt: 0 };
      if (puts === 1) await firstAnswer;
      return answer;
    });
    const conflicts: string[] = [];
    const h = start({ revision: 5, text: "v5" });
    (h.engine as unknown as { callbacks: { onConflict: () => Promise<string> } }).callbacks.onConflict = async () => {
      conflicts.push("asked");
      return "keep-local";
    };
    const focus = (): void => { h.focus(); };

    h.type("A");
    await vi.advanceTimersByTimeAsync(400); // stored as r6; the answer is still on its way
    focus(); // read: the server equals the screen, base r6
    await vi.advanceTimersByTimeAsync(50);
    server.revision = 7; server.text = "A + phone"; server.mutationId = "foreign"; // another device
    focus(); // read: applied
    await vi.advanceTimersByTimeAsync(50);
    expect(h.applied).toEqual(["A + phone"]);

    h.type("A"); // the user removes what the other device added
    releaseFirstAnswer(); // the answer to the first save arrives only now
    await vi.advanceTimersByTimeAsync(30_000);

    // The user's change is saved on top of r7; nothing is applied over it.
    expect(h.applied).toEqual(["A + phone"]);
    expect(h.editor.text).toBe("A");
    expect(server.text).toBe("A");
    expect(conflicts).toEqual([]);
    h.engine.stop();
  });

  it("spec: a refusal already dealt with by an ordinary read does not raise a question against the page's own save", async () => {
    // One device. A save is stored, its answer lost; the retry is refused and
    // the engine reads the server copy. Before that read returns, a poll has
    // already found everything saved; the user then types on.
    const server = { revision: 5, text: "v5", mutationId: "m" };
    let slowRead: Promise<void> | null = null;
    let releaseSlowRead!: () => void;
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      if (known === undefined && slowRead) await slowRead; // the read made for the 412
      if (known === etag(server.revision)) return notModified;
      const copy = serverCopy(server.revision, server.text);
      copy.data.mutationId = server.mutationId;
      return copy;
    });
    let puts = 0;
    vi.spyOn(api, "putDocument").mockImplementation(async (payload, ifMatch) => {
      const body = payload as { mutationId: string; encryptedRevision: number; ciphertext: string };
      puts += 1;
      if (ifMatch !== etag(server.revision)) throw new ApiRequestError(412, "PRECONDITION_FAILED", "stale");
      server.revision = body.encryptedRevision;
      server.text = body.ciphertext.split(":").slice(1).join(":");
      server.mutationId = body.mutationId;
      if (puts === 1) throw new TypeError("Failed to fetch"); // stored, answer lost
      return { etag: etag(server.revision), revision: server.revision, mutationId: body.mutationId, updatedAt: 0 };
    });
    const conflicts: string[] = [];
    const h = start({ revision: 5, text: "v5" });
    (h.engine as unknown as { callbacks: { onConflict: () => Promise<string> } }).callbacks.onConflict = async () => {
      conflicts.push("asked");
      return "keep-local";
    };
    slowRead = new Promise<void>((resolve) => { releaseSlowRead = resolve; });
    h.type("first");
    await vi.advanceTimersByTimeAsync(400); // stored, answer lost
    await vi.advanceTimersByTimeAsync(2000); // retry: 412, the slow read starts
    h.focus(); // an ordinary read converges
    await vi.advanceTimersByTimeAsync(50);
    h.type("first, second"); // the user types on
    releaseSlowRead(); // the read made for the 412 returns only now
    await vi.advanceTimersByTimeAsync(30_000);
    expect(conflicts).toEqual([]);
    expect(server.text).toBe("first, second");
    h.engine.stop();
  });

  /**
   * The conflict question is open while reads go on behind it. Another device
   * stores exactly what this page shows, a read notices (the base moves, and
   * nothing is unsaved any more), and then something changes locally after
   * all — an upload that was still running inserts its block.
   */
  function dissolvedConflict() {
    const server = { revision: 6, text: "phone", mutationId: "foreign" };
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      if (known === etag(server.revision)) return notModified;
      const copy = serverCopy(server.revision, server.text);
      copy.data.mutationId = server.mutationId;
      return copy;
    });
    vi.spyOn(api, "putDocument").mockImplementation(async (payload, ifMatch) => {
      const body = payload as { mutationId: string; encryptedRevision: number; ciphertext: string };
      if (ifMatch !== etag(server.revision)) throw new ApiRequestError(412, "PRECONDITION_FAILED", "stale");
      server.revision = body.encryptedRevision;
      server.text = body.ciphertext.split(":").slice(1).join(":");
      server.mutationId = body.mutationId;
      return { etag: etag(server.revision), revision: server.revision, mutationId: body.mutationId, updatedAt: 0 };
    });
    let answer!: (decision: "keep-local" | "use-remote") => void;
    const answered = new Promise<"keep-local" | "use-remote">((resolve) => { answer = resolve; });
    const conflicts: Array<{ local: string; remote: string }> = [];
    const h = start({ revision: 5, text: "v5" });
    (h.engine as unknown as { callbacks: { onConflict: (details: { local: DocumentModel; remote: DocumentModel }) => Promise<string> } })
      .callbacks.onConflict = async ({ local, remote }) => {
        conflicts.push({
          local: (local.blocks[0] as { text: string }).text,
          remote: (remote.blocks[0] as { text: string }).text,
        });
        return answered;
      };
    return {
      h, server, conflicts, answer,
      /** Runs up to the point where the question is open and the conflict has dissolved. */
      async untilDissolved(): Promise<void> {
        h.type("X");
        await vi.advanceTimersByTimeAsync(400); // refused: r6 "phone" is in the way
        expect(conflicts).toEqual([{ local: "X", remote: "phone" }]);
        server.revision = 7; server.text = "X"; server.mutationId = "foreign-2"; // the same text, from the other device
        h.focus(); // a read finds server and screen equal
        await vi.advanceTimersByTimeAsync(50);
        expect((h.engine as unknown as { dirty: boolean }).dirty).toBe(false);
      },
    };
  }

  it("spec: choosing the server copy after the conflict dissolved also replaces a change made behind the question", async () => {
    const { h, server, answer, untilDissolved } = dissolvedConflict();
    await untilDissolved();
    h.type("X + photo"); // the upload finishes behind the question
    await vi.advanceTimersByTimeAsync(250); // its draft is stored
    const clearedBeforeAnswer = draftStore.cleared;
    answer("use-remote");
    await vi.advanceTimersByTimeAsync(30_000);
    // The server's copy is on screen, and the discarded change was neither
    // saved nor left on screen as content that nothing marks as unsaved. Its
    // draft is gone too: it must not be offered back on the next load.
    expect.soft(draftStore.cleared).toBeGreaterThan(clearedBeforeAnswer);
    expect.soft(h.editor.text).toBe("X");
    expect.soft(server.text).toBe("X");
    expect.soft(h.applied).toEqual(["X"]);
    expect.soft((h.engine as unknown as { dirty: boolean }).dirty).toBe(false);
    expect(h.states.at(-1)).toMatch(/^(saved|idle)$/);
    h.engine.stop();
  });

  it("spec: keeping the local copy after the conflict dissolved saves a change made behind the question", async () => {
    const { h, server, answer, untilDissolved } = dissolvedConflict();
    await untilDissolved();
    h.type("X + photo");
    // The change's own save timers fire while the question is still open and
    // find the engine busy: after the answer nothing else would send it.
    await vi.advanceTimersByTimeAsync(2500);
    answer("keep-local");
    await vi.advanceTimersByTimeAsync(2000);
    expect.soft(h.applied).toEqual([]);
    expect.soft(h.editor.text).toBe("X + photo");
    expect(server.text).toBe("X + photo");
    h.engine.stop();
  });

  it("spec: choosing the server copy during a composition, after the conflict dissolved, replaces nothing and loses nothing", async () => {
    const { h, server, answer, untilDissolved } = dissolvedConflict();
    await untilDissolved();
    h.type("X + photo");
    await vi.advanceTimersByTimeAsync(250); // the draft of that change is stored
    h.editor.safe = false; // a composition starts
    const clearedBeforeAnswer = draftStore.cleared;
    answer("use-remote");
    await vi.advanceTimersByTimeAsync(1000);
    // The editor is not touched under the composition, and the draft of the
    // unsaved change is still there.
    expect.soft(h.applied).toEqual([]);
    expect.soft(h.editor.text).toBe("X + photo");
    expect.soft(draftStore.cleared).toBe(clearedBeforeAnswer);
    h.editor.safe = true;
    h.type("X + photo + か"); // the composition is committed
    await vi.advanceTimersByTimeAsync(30_000);
    // The base is current, so there is no conflict left to ask about: what is
    // on screen is saved.
    expect.soft(h.applied).toEqual([]);
    expect(server.text).toBe("X + photo + か");
    h.engine.stop();
  });

  it("spec: a save answered after a rollback was refused does not delete the draft the refusal stored", async () => {
    // The save of the last paragraph is on its way when a read is answered
    // with an older, authentic copy: the page refuses it and stores the screen
    // as a draft. The answer to the save arrives only afterwards.
    let rolledBack = false;
    vi.spyOn(api, "document").mockImplementation(async () => (rolledBack ? serverCopy(5, "v5") : notModified));
    let releaseAnswer!: () => void;
    const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
    vi.spyOn(api, "putDocument").mockImplementation(async (payload) => {
      const body = payload as { mutationId: string; encryptedRevision: number };
      await answerGate;
      return { etag: etag(body.encryptedRevision), revision: body.encryptedRevision, mutationId: body.mutationId, updatedAt: 0 };
    });
    const h = start({ revision: 10, text: "v10" });
    h.type("v10 + the last paragraph");
    await vi.advanceTimersByTimeAsync(400);
    rolledBack = true;
    h.focus();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.states.at(-1)).toContain("以前の版に戻されています");
    expect(draftStore.saved.at(-1)).toContain("the last paragraph");
    const clearedAtRefusal = draftStore.cleared;
    releaseAnswer();
    await vi.advanceTimersByTimeAsync(30_000);
    // The draft may be the only copy of that paragraph: it stays.
    expect.soft(draftStore.cleared).toBe(clearedAtRefusal);
    expect(h.states.at(-1)).toContain("以前の版に戻されています");
    h.engine.stop();
  });

  it("spec: a refused save still being looked into when a rollback is refused does not delete that draft", async () => {
    // The save is refused (412) and the engine reads the server copy, slowly.
    // Meanwhile a poll is answered with an older copy and the page refuses.
    // The slow read then returns a copy equal to the screen.
    let rolledBack = false;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      if (known === undefined) {
        await readGate; // the read made for the 412
        return serverCopy(11, "v10 + the last paragraph");
      }
      return rolledBack ? serverCopy(5, "v5") : notModified;
    });
    vi.spyOn(api, "putDocument").mockRejectedValue(new ApiRequestError(412, "PRECONDITION_FAILED", "stale"));
    const h = start({ revision: 10, text: "v10" });
    h.type("v10 + the last paragraph");
    await vi.advanceTimersByTimeAsync(400);
    rolledBack = true;
    h.focus();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.states.at(-1)).toContain("以前の版に戻されています");
    const clearedAtRefusal = draftStore.cleared;
    releaseRead();
    await vi.advanceTimersByTimeAsync(30_000);
    expect.soft(draftStore.cleared).toBe(clearedAtRefusal);
    expect(h.states.at(-1)).toContain("以前の版に戻されています");
    h.engine.stop();
  });

  it("spec: an answer to the conflict question given after a rollback was refused changes nothing", async () => {
    let rolledBack = false;
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      if (known === undefined) return serverCopy(11, "phone"); // the copy that blocks the save
      return rolledBack ? serverCopy(5, "v5") : notModified;
    });
    vi.spyOn(api, "putDocument").mockRejectedValue(new ApiRequestError(412, "PRECONDITION_FAILED", "stale"));
    let answer!: (decision: "keep-local" | "use-remote") => void;
    const answered = new Promise<"keep-local" | "use-remote">((resolve) => { answer = resolve; });
    const h = start({ revision: 10, text: "v10" });
    (h.engine as unknown as { callbacks: { onConflict: () => Promise<string> } }).callbacks.onConflict = () => answered;
    h.type("v10 + the last paragraph");
    await vi.advanceTimersByTimeAsync(400); // the question is open
    expect(h.states.at(-1)).toMatch(/^conflict/);
    rolledBack = true;
    h.focus();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.states.at(-1)).toContain("以前の版に戻されています");
    const clearedAtRefusal = draftStore.cleared;
    answer("use-remote");
    await vi.advanceTimersByTimeAsync(30_000);
    // Syncing has stopped on this page: the copy the question showed is not
    // put on screen, and the draft is not dropped.
    expect.soft(h.applied).toEqual([]);
    expect.soft(h.editor.text).toBe("v10 + the last paragraph");
    expect(draftStore.cleared).toBe(clearedAtRefusal);
    h.engine.stop();
  });

  it("spec: a 304 for a base this device has already seen surpassed is refused as a rollback", async () => {
    // Another tab of this browser has opened r10. This page still holds r5 and
    // asks whether anything changed; "no" can only come from a server that
    // went back to r5.
    vi.spyOn(api, "document").mockResolvedValue(notModified);
    const put = vi.spyOn(api, "putDocument").mockRejectedValue(new Error("must not be called"));
    const h = start({ revision: 5, text: "v5" });
    new RevisionGuard(DOC_ID, h.storage).record(10);
    await vi.advanceTimersByTimeAsync(3000); // the first poll
    expect.soft(h.states.at(-1) ?? "").toContain("以前の版に戻されています");
    expect.soft(h.applied).toEqual([]);
    expect(put).not.toHaveBeenCalled();
    h.engine.stop();
  });

  it("spec: a 304 for the newest copy this device knows is not a rollback", async () => {
    vi.spyOn(api, "document").mockResolvedValue(notModified);
    const h = start({ revision: 5, text: "v5" });
    new RevisionGuard(DOC_ID, h.storage).record(5); // another tab holds the same copy
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.states.join("|")).not.toContain("以前の版に戻されています");
    expect((h.engine as unknown as { rollbackRefused: boolean }).rollbackRefused).toBe(false);
    h.engine.stop();
  });

  it("spec: a save the server accepts for a revision another tab already surpassed is refused as a rollback", async () => {
    // No read has run yet (the first poll is seconds away), so the save is
    // what meets the rolled-back server first.
    vi.spyOn(api, "document").mockResolvedValue(notModified);
    vi.spyOn(api, "putDocument").mockImplementation(async (payload) => {
      const body = payload as { mutationId: string; encryptedRevision: number };
      return { etag: etag(body.encryptedRevision), revision: body.encryptedRevision, mutationId: body.mutationId, updatedAt: 0 };
    });
    const h = start({ revision: 5, text: "v5" });
    new RevisionGuard(DOC_ID, h.storage).record(6); // another tab opened r6
    h.type("v5 + typed here");
    await vi.advanceTimersByTimeAsync(1000);
    expect.soft((h.engine as unknown as { rollbackRefused: boolean }).rollbackRefused).toBe(true);
    expect.soft(h.states.at(-1)).toContain("以前の版に戻されています");
    expect(draftStore.saved.at(-1)).toContain("typed here");
    h.engine.stop();
  });

  it("spec: a payload sealed for a revision that is no longer next is not sent", async () => {
    // One device. The save of "X" is stored and its answer lost. A change that
    // changes nothing starts another save, whose encryption is slow; meanwhile
    // a read finds everything saved (base r6) and the user types on.
    const server = { revision: 5, text: "v5", mutationId: "m" };
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      if (known === etag(server.revision)) return notModified;
      const copy = serverCopy(server.revision, server.text);
      copy.data.mutationId = server.mutationId;
      return copy;
    });
    const puts: string[] = [];
    vi.spyOn(api, "putDocument").mockImplementation(async (payload, ifMatch) => {
      const body = payload as { mutationId: string; encryptedRevision: number; ciphertext: string };
      puts.push(`${body.encryptedRevision}@${ifMatch.slice(-3, -1)}`);
      // The Worker's CAS: the ETag first, then the revision the copy is sealed for.
      if (ifMatch !== etag(server.revision) || body.encryptedRevision !== server.revision + 1) {
        throw new ApiRequestError(412, "PRECONDITION_FAILED", "stale");
      }
      server.revision = body.encryptedRevision;
      server.text = body.ciphertext.split(":").slice(1).join(":");
      server.mutationId = body.mutationId;
      if (puts.length === 1) throw new TypeError("Failed to fetch"); // stored, answer lost
      return { etag: etag(server.revision), revision: server.revision, mutationId: body.mutationId, updatedAt: 0 };
    });
    const conflicts: string[] = [];
    const h = start({ revision: 5, text: "v5" });
    (h.engine as unknown as { callbacks: { onConflict: (details: { local: DocumentModel; remote: DocumentModel }) => Promise<string> } })
      .callbacks.onConflict = async ({ local, remote }) => {
        conflicts.push(`${(local.blocks[0] as { text: string }).text} vs ${(remote.blocks[0] as { text: string }).text}`);
        return "keep-local";
      };
    const bridge = (h.engine as unknown as { bridge: { encryptDocument: (input: unknown) => Promise<unknown> } }).bridge;
    const encrypt = bridge.encryptDocument;
    let releaseEncryption!: () => void;
    const encryptionGate = new Promise<void>((resolve) => { releaseEncryption = resolve; });
    let encryptions = 0;
    bridge.encryptDocument = async (input) => {
      encryptions += 1;
      if (encryptions === 2) await encryptionGate;
      return encrypt(input);
    };

    h.type("X");
    await vi.advanceTimersByTimeAsync(400); // stored as r6, answer lost
    h.engine.noteCommittedChange(); // a change that changes nothing
    await vi.advanceTimersByTimeAsync(350); // the next save is being encrypted
    h.focus(); // a read finds the server holding "X": base r6
    await vi.advanceTimersByTimeAsync(20);
    h.type("X+");
    releaseEncryption();
    await vi.advanceTimersByTimeAsync(30_000);

    expect.soft(conflicts).toEqual([]);
    expect.soft(puts).toEqual(["6@r5", "7@r6"]);
    expect(server.text).toBe("X+");
    h.engine.stop();
  });

  it("spec: a 304 for a base ETag taken over from a draft is not judged as a rollback", async () => {
    // A duplicated tab. This page read r5; the other page then saved r6 and
    // left a draft written against r6, which this page adopts. Its ETag now
    // names r6 — a copy this page never opened — while the revision it knows
    // is still 5. The server is honest throughout.
    const server = { revision: 6, text: "v5 a", mutationId: "other" };
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      if (known === etag(server.revision)) return notModified;
      const copy = serverCopy(server.revision, server.text);
      copy.data.mutationId = server.mutationId;
      return copy;
    });
    vi.spyOn(api, "putDocument").mockImplementation(async (payload, ifMatch) => {
      const body = payload as { mutationId: string; encryptedRevision: number; ciphertext: string };
      if (ifMatch !== etag(server.revision) || body.encryptedRevision !== server.revision + 1) {
        throw new ApiRequestError(412, "PRECONDITION_FAILED", "stale");
      }
      server.revision = body.encryptedRevision;
      server.text = body.ciphertext.split(":").slice(1).join(":");
      server.mutationId = body.mutationId;
      return { etag: etag(server.revision), revision: server.revision, mutationId: body.mutationId, updatedAt: 0 };
    });
    let answer!: (decision: "keep-local" | "use-remote") => void;
    const answered = new Promise<"keep-local" | "use-remote">((resolve) => { answer = resolve; });
    const h = start({ revision: 5, text: "v5" });
    (h.engine as unknown as { callbacks: { onConflict: () => Promise<string> } }).callbacks.onConflict = () => answered;
    new RevisionGuard(DOC_ID, h.storage).record(6); // the other page's save
    h.editor.text = "v5 a b"; // the adopted draft
    h.engine.setBaseFromDraft(etag(6));
    h.engine.noteCommittedChange();
    h.focus(); // a read before the save has even gone out: 304 for r6
    await vi.advanceTimersByTimeAsync(400); // the save is refused (sealed for r6, not r7); the question opens
    await vi.advanceTimersByTimeAsync(6000); // polls behind the question: 304 for r6
    expect.soft((h.engine as unknown as { rollbackRefused: boolean }).rollbackRefused).toBe(false);
    expect.soft(h.states.join("|")).not.toContain("以前の版に戻されています");
    answer("keep-local");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.text).toBe("v5 a b");
    h.engine.stop();
  });

  it("spec: after a refused rollback, a save that was still being encrypted is not sent", async () => {
    let rolledBack = false;
    vi.spyOn(api, "document").mockImplementation(async () => (rolledBack ? serverCopy(5, "v5") : notModified));
    const put = vi.spyOn(api, "putDocument").mockResolvedValue({ etag: etag(11), revision: 11, mutationId: "x", updatedAt: 0 });
    const h = start({ revision: 10, text: "v10" });
    const bridge = (h.engine as unknown as { bridge: { encryptDocument: (input: unknown) => Promise<unknown> } }).bridge;
    const encrypt = bridge.encryptDocument;
    let releaseEncryption!: () => void;
    const encryptionGate = new Promise<void>((resolve) => { releaseEncryption = resolve; });
    bridge.encryptDocument = async (input) => { await encryptionGate; return encrypt(input); };
    h.type("v10 + more");
    await vi.advanceTimersByTimeAsync(400); // the payload is being encrypted
    rolledBack = true;
    h.focus();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.states.at(-1)).toContain("以前の版に戻されています");
    releaseEncryption();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(put).not.toHaveBeenCalled();
    h.engine.stop();
  });

  it("spec: after a refused rollback, the copy that blocked a save raises no conflict question", async () => {
    let rolledBack = false;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      if (known === undefined) {
        await readGate; // the read made for the 412
        return serverCopy(11, "phone");
      }
      return rolledBack ? serverCopy(5, "v5") : notModified;
    });
    vi.spyOn(api, "putDocument").mockRejectedValue(new ApiRequestError(412, "PRECONDITION_FAILED", "stale"));
    const conflicts: string[] = [];
    const h = start({ revision: 10, text: "v10" });
    (h.engine as unknown as { callbacks: { onConflict: () => Promise<string> } }).callbacks.onConflict = async () => {
      conflicts.push("asked");
      return "keep-local";
    };
    h.type("v10 + more");
    await vi.advanceTimersByTimeAsync(400);
    rolledBack = true;
    h.focus();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.states.at(-1)).toContain("以前の版に戻されています");
    releaseRead();
    await vi.advanceTimersByTimeAsync(30_000);
    expect.soft(conflicts).toEqual([]);
    // The copy that arrived after the refusal was not taken in as "seen".
    expect(new RevisionGuard(DOC_ID, h.storage).current()).toBe(10);
    h.engine.stop();
  });

  it("spec: after a refused rollback, a newer copy that was still being opened is not applied", async () => {
    const answers = [serverCopy(11, "newer"), serverCopy(5, "v5")];
    vi.spyOn(api, "document").mockImplementation(async () => answers.shift() ?? notModified);
    vi.spyOn(api, "putDocument").mockRejectedValue(new Error("must not be called"));
    const h = start({ revision: 10, text: "v10" });
    const bridge = (h.engine as unknown as { bridge: { decryptDocument: (input: unknown) => Promise<unknown> } }).bridge;
    const decrypt = bridge.decryptDocument;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let decryptions = 0;
    bridge.decryptDocument = async (input) => {
      decryptions += 1;
      if (decryptions === 1) await firstGate;
      return decrypt(input);
    };
    h.focus(); // read 1: r11, slow to open
    await vi.advanceTimersByTimeAsync(20);
    h.focus(); // read 2: an older copy — refused
    await vi.advanceTimersByTimeAsync(20);
    expect(h.states.at(-1)).toContain("以前の版に戻されています");
    releaseFirst();
    await vi.advanceTimersByTimeAsync(30_000);
    expect.soft(h.applied).toEqual([]);
    expect(h.editor.text).toBe("v10");
    h.engine.stop();
  });

  it("spec: a locked page never deletes a draft, whatever arrives afterwards", async () => {
    // Lock while a save is in flight: the draft is stored, the engine stopped.
    vi.spyOn(api, "document").mockResolvedValue(notModified);
    let releaseAnswer!: () => void;
    const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
    vi.spyOn(api, "putDocument").mockImplementation(async (payload) => {
      const body = payload as { mutationId: string; encryptedRevision: number };
      await answerGate;
      return { etag: etag(body.encryptedRevision), revision: body.encryptedRevision, mutationId: body.mutationId, updatedAt: 0 };
    });
    const h = start({ revision: 10, text: "v10" });
    h.type("v10 + more");
    await vi.advanceTimersByTimeAsync(400);
    await h.engine.persistDraftNow();
    h.engine.stop();
    const clearedAtLock = draftStore.cleared;
    releaseAnswer();
    await vi.advanceTimersByTimeAsync(30_000);
    // The next session may already be writing its own draft under this key.
    expect(draftStore.cleared).toBe(clearedAtLock);
  });

  it("spec: an answer to the conflict question given after the page was locked changes nothing", async () => {
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => (known === undefined ? serverCopy(11, "phone") : notModified));
    vi.spyOn(api, "putDocument").mockRejectedValue(new ApiRequestError(412, "PRECONDITION_FAILED", "stale"));
    let answer!: (decision: "keep-local" | "use-remote") => void;
    const answered = new Promise<"keep-local" | "use-remote">((resolve) => { answer = resolve; });
    const h = start({ revision: 10, text: "v10" });
    (h.engine as unknown as { callbacks: { onConflict: () => Promise<string> } }).callbacks.onConflict = () => answered;
    h.type("v10 + more");
    await vi.advanceTimersByTimeAsync(400); // the question is open
    await h.engine.persistDraftNow();
    h.engine.stop(); // locked
    const clearedAtLock = draftStore.cleared;
    answer("use-remote");
    await vi.advanceTimersByTimeAsync(30_000);
    expect.soft(h.applied).toEqual([]);
    expect(draftStore.cleared).toBe(clearedAtLock);
  });

  it("spec: the base is a copy of its own — later changes to the object it came from are not mistaken for edits", async () => {
    // The app keeps the applied remote document as its state and registers an
    // upload in that object's media map before the block is inserted. The
    // engine's base must not change with it: the screen is still what the
    // server holds, and a change that changes nothing must send nothing.
    const get = vi.spyOn(api, "document").mockResolvedValue(serverCopy(6, "v6"));
    const put = vi.spyOn(api, "putDocument").mockRejectedValue(new Error("must not be called"));
    const h = start({ revision: 5, text: "v5" });
    let appState: DocumentModel | null = null;
    const callbacks = (h.engine as unknown as { callbacks: { applyRemote: (remote: DocumentModel) => void } }).callbacks;
    callbacks.applyRemote = (remote) => {
      appState = remote;
      h.editor.text = (remote.blocks[0] as { text: string }).text;
    };
    h.focus(); // r6 is applied; the app holds that object as its state
    await vi.advanceTimersByTimeAsync(20);
    get.mockResolvedValue(notModified);
    expect(h.editor.text).toBe("v6");
    // An upload completes and is registered; its block is not inserted yet.
    appState!.media.uploaded = { kind: "image", name: "a.png", mime: "image/png", plainBytes: 1 } as never;
    h.engine.noteCommittedChange(); // a cancelled composition
    await vi.advanceTimersByTimeAsync(5000);
    expect.soft(put).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toMatch(/^(saved|idle)$/);
    h.engine.stop();
  });

  it("spec: a page whose base ETag came from a draft still takes in the newer copy when nothing is left to save", async () => {
    // The adopted draft is undone before its save goes out: the screen is the
    // loaded copy again and nothing is unsaved. The ETag still names r6, which
    // this page has not opened — asking "anything newer than r6?" would be
    // answered "no" for ever, and r6 would never reach the screen.
    const server = { revision: 6, text: "v5 a", mutationId: "other" };
    const validators: Array<string | undefined> = [];
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      validators.push(known);
      if (known === etag(server.revision)) return notModified;
      const copy = serverCopy(server.revision, server.text);
      copy.data.mutationId = server.mutationId;
      return copy;
    });
    const put = vi.spyOn(api, "putDocument").mockRejectedValue(new Error("must not be called"));
    const h = start({ revision: 5, text: "v5" });
    h.editor.text = "v5 b"; // the adopted draft
    h.engine.setBaseFromDraft(etag(6));
    h.engine.noteCommittedChange();
    h.type("v5"); // undone at once
    await vi.advanceTimersByTimeAsync(10_000);
    expect.soft(put).not.toHaveBeenCalled();
    expect.soft(h.applied).toEqual(["v5 a"]);
    expect.soft(h.editor.text).toBe("v5 a");
    // Once the copy has really been opened, reads are conditional again.
    expect(validators.at(-1)).toBe(etag(6));
    h.engine.stop();
  });

  it("spec: a locked page stores no draft of its own afterwards, even when its last save meets a server that went back", async () => {
    // Lock while a save is in flight. Another tab has opened a newer copy, so
    // the server accepting this save means it went back — but this page is
    // locked: it must not capture "the screen" (now blank, or the next
    // session's) over the draft stored at the lock.
    vi.spyOn(api, "document").mockResolvedValue(notModified);
    let releaseAnswer!: () => void;
    const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
    vi.spyOn(api, "putDocument").mockImplementation(async (payload) => {
      const body = payload as { mutationId: string; encryptedRevision: number };
      await answerGate;
      return { etag: etag(body.encryptedRevision), revision: body.encryptedRevision, mutationId: body.mutationId, updatedAt: 0 };
    });
    const h = start({ revision: 10, text: "v10" });
    new RevisionGuard(DOC_ID, h.storage).record(11); // another tab opened r11
    h.type("v10 + unsynced");
    await vi.advanceTimersByTimeAsync(400); // the save (sealed for r11) is in flight
    await h.engine.persistDraftNow();
    h.engine.stop(); // locked
    h.editor.text = ""; // the editor is emptied behind the gate
    const draftsAtLock = draftStore.saved.length;
    expect(draftStore.saved.at(-1)).toContain("unsynced");
    releaseAnswer();
    await vi.advanceTimersByTimeAsync(30_000);
    expect.soft(draftStore.saved.length).toBe(draftsAtLock);
    expect(draftStore.cleared).toBe(0);
  });

  it("spec: a save acknowledged after the lock still raises the mark of what this device has sealed", async () => {
    vi.spyOn(api, "document").mockResolvedValue(notModified);
    let releaseAnswer!: () => void;
    const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
    vi.spyOn(api, "putDocument").mockImplementation(async (payload) => {
      const body = payload as { mutationId: string; encryptedRevision: number };
      await answerGate;
      return { etag: etag(body.encryptedRevision), revision: body.encryptedRevision, mutationId: body.mutationId, updatedAt: 0 };
    });
    const h = start({ revision: 10, text: "v10" });
    h.type("v10 + more");
    await vi.advanceTimersByTimeAsync(400);
    h.engine.stop();
    releaseAnswer();
    await vi.advanceTimersByTimeAsync(1000);
    expect(new RevisionGuard(DOC_ID, h.storage).current()).toBe(11);
  });

  it("spec: a draft whose base is the loaded copy under the edge's weak ETag is not treated as another copy", async () => {
    // The previous build stored the ETag as the edge sent it (`W/"…"`). The
    // draft's base IS the copy this page loaded: reads stay conditional, and
    // the page's own save in flight is not mistaken for someone else's.
    const server = { revision: 5, text: "v5", mutationId: "m" };
    const strong = (value: string): string => value.replace(/^W\//, "");
    const validators: Array<string | undefined> = [];
    vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
      validators.push(known);
      if (known !== undefined && strong(known) === etag(server.revision)) return notModified;
      const copy = serverCopy(server.revision, server.text);
      copy.data.mutationId = server.mutationId;
      return copy;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let puts = 0;
    vi.spyOn(api, "putDocument").mockImplementation(async (payload, ifMatch) => {
      const body = payload as { mutationId: string; encryptedRevision: number; ciphertext: string };
      puts += 1;
      if (puts === 1) await firstGate; // on its way; not stored yet
      // The Worker accepts either form of the ETag.
      if (strong(ifMatch) !== etag(server.revision) || body.encryptedRevision !== server.revision + 1) {
        throw new ApiRequestError(412, "PRECONDITION_FAILED", "stale");
      }
      server.revision = body.encryptedRevision;
      server.text = body.ciphertext.split(":").slice(1).join(":");
      server.mutationId = body.mutationId;
      return { etag: etag(server.revision), revision: server.revision, mutationId: body.mutationId, updatedAt: 0 };
    });
    const conflicts: string[] = [];
    const h = start({ revision: 5, text: "v5" });
    (h.engine as unknown as { callbacks: { onConflict: () => Promise<string> } }).callbacks.onConflict = async () => {
      conflicts.push("asked");
      return "keep-local";
    };
    h.editor.text = "v5 x"; // the adopted draft
    h.engine.setBaseFromDraft(`W/${etag(5)}`);
    h.engine.noteCommittedChange();
    await vi.advanceTimersByTimeAsync(400); // its save is on its way
    h.type("v5"); // the user deletes the "x" again
    h.focus(); // a read overtakes the save
    await vi.advanceTimersByTimeAsync(50);
    expect.soft(validators.at(-1)).toBe(etag(5)); // conditional, and in the strong form
    releaseFirst();
    await vi.advanceTimersByTimeAsync(30_000);
    expect.soft(h.applied).toEqual([]);
    expect.soft(conflicts).toEqual([]);
    expect.soft(h.editor.text).toBe("v5");
    expect(server.text).toBe("v5");
    h.engine.stop();
  });
});
