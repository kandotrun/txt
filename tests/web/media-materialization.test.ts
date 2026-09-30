import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the real main integration functions, without booting the app or networking.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../apps/web/src/app/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ["attachFiles", "clampPosition", "mediaInfo", "materializeStream", "refreshStreamSources", "syncServiceWorkerMedia"];
const functions = names.map((name) => {
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing main function: ${name}`);
  return declaration.getText(source);
}).join("\n");
const code = transformSync(`${functions}\n globalThis.integration = { attachFiles, materializeStream, syncServiceWorkerMedia };`, { loader: "ts", target: "es2022" }).code;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const info = { kind: "video", name: "synthetic.mp4", mime: "video/mp4", plainBytes: 100 };
class Player {
  dataset = { swMedia: "existing" };
  isConnected = true;
  currentTime = 37;
  paused = false;
  writes: string[] = [];
  attribute: string | null;
  constructor(src: string | null) { this.attribute = src; }
  getAttribute(name: string) { return name === "src" ? this.attribute : null; }
  get src() { return this.attribute === null ? "" : `https://synthetic.invalid${this.attribute}`; }
  set src(value: string) { this.writes.push(value); this.attribute = value; this.currentTime = 0; this.paused = true; }
}
function harness(players: Player[] = []) {
  const completion = deferred<{ mediaId: string; info: typeof info }>();
  const metadataAck = deferred<boolean>();
  const updates: Record<string, typeof info>[] = [];
  const insertMedia = vi.fn();
  const noteCommittedChange = vi.fn();
  const toast = vi.fn();
  const state = {
    bridge: {}, unlocked: {}, sessionGeneration: 1, documentId: "doc",
    document: { media: { existing: info } as Record<string, typeof info> },
    editor: { insertMedia, state: { doc: { content: { size: 10 } } } },
    sync: { noteCommittedChange }, attaching: new Map(), serviceWorkerReady: true,
  };
  let holdMetadata = false;
  const context = {
    state, elements: { editorHost: { querySelectorAll: () => players } },
    serviceWorkerBridge: { ready: true, updateMedia: (media: Record<string, typeof info>) => {
      updates.push({ ...media });
      return holdMetadata && media.uploaded ? metadataAck.promise : Promise.resolve(true);
    } }, mediaReady: Promise.resolve(true), HTMLMediaElement: Player,
    AbortController, DOMException, crypto: { randomUUID: () => "placeholder" },
    classify: () => "video", renderAttachProgress: vi.fn(), toast,
    uploadFile: (options: { onStarted: (id: string) => void }) => {
      options.onStarted("uploaded");
      return completion.promise;
    },
  };
  runInNewContext(code, context);
  const integration = (context as typeof context & { integration: {
    attachFiles: (files: unknown[], position: number) => Promise<void>;
    materializeStream: (node: Player, id: string, metadata: typeof info) => Promise<void>;
    syncServiceWorkerMedia: () => Promise<boolean>;
  } }).integration;
  return {
    ...integration, state, completion, metadataAck, updates, insertMedia, noteCommittedChange, toast,
    holdMetadata: () => { holdMetadata = true; },
    cancel: () => {
      const entry = state.attaching.get("placeholder");
      expect(entry).toBeDefined();
      entry.controller.abort();
      state.attaching.delete("placeholder");
    },
  };
}

describe("main attachment cancellation and stream materialization", () => {
  it("does not insert, save or retain metadata when cancelled during the completion response", async () => {
    const h = harness();
    const pending = h.attachFiles([{}], 2);
    await flush();
    h.cancel();
    h.completion.resolve({ mediaId: "uploaded", info });
    await pending;
    expect(h.insertMedia).not.toHaveBeenCalled();
    expect(h.noteCommittedChange).not.toHaveBeenCalled();
    expect(h.state.document.media.uploaded).toBeUndefined();
    expect(h.updates.at(-1)?.uploaded).toBeUndefined();
    expect(h.state.attaching.size).toBe(0);
    expect(h.toast).not.toHaveBeenCalled();
    // No destructive server delete: the unreferenced ciphertext uses the E2EE GC grace.
  });
  it("does not insert or save and revokes staged metadata when cancelled during a held metadata ACK", async () => {
    const h = harness();
    h.holdMetadata();
    const pending = h.attachFiles([{}], 2);
    h.completion.resolve({ mediaId: "uploaded", info });
    await flush();
    expect(h.updates.at(-1)?.uploaded).toBe(info);
    h.cancel();
    h.metadataAck.resolve(true);
    await pending;
    await flush();
    expect(h.insertMedia).not.toHaveBeenCalled();
    expect(h.noteCommittedChange).not.toHaveBeenCalled();
    expect(h.state.document.media.uploaded).toBeUndefined();
    expect(h.updates.at(-1)?.uploaded).toBeUndefined();
    expect(h.state.attaching.size).toBe(0);
    expect(h.toast).not.toHaveBeenCalled();
  });
  it("inserts and saves a non-cancelled completed upload after its metadata ACK", async () => {
    const h = harness();
    h.holdMetadata();
    const pending = h.attachFiles([{}], 2);
    h.completion.resolve({ mediaId: "uploaded", info });
    await flush();
    expect(h.insertMedia).not.toHaveBeenCalled();
    h.metadataAck.resolve(true);
    await pending;
    expect(h.insertMedia).toHaveBeenCalledWith("uploaded", "video", 2);
    expect(h.noteCommittedChange).toHaveBeenCalledOnce();
    expect(h.state.document.media.uploaded).toBe(info);
  });
  it("preserves an unchanged playing stream-backed node across unrelated metadata ACKs", async () => {
    const player = new Player("/_local/media/existing");
    const h = harness([player]);
    const attachment = h.attachFiles([{}], 2);
    await flush(); // actual onStarted -> metadata ACK -> refreshStreamSources
    await h.syncServiceWorkerMedia();
    await flush();
    expect(player.writes).toEqual([]);
    expect(player.currentTime).toBe(37);
    expect(player.paused).toBe(false);
    h.cancel();
    h.completion.resolve({ mediaId: "uploaded", info });
    await attachment;
  });
  it.each([null, "/_local/media/retired"])("assigns an initial or retired stream source (%s)", async (src) => {
    const player = new Player(src);
    const h = harness([player]);
    await h.materializeStream(player, "existing", info);
    expect(player.writes).toEqual(["/_local/media/existing"]);
  });
});
