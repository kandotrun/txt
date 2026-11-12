/**
 * Randomised interleavings of the real SyncEngine (spec §9.7, §10).
 *
 * The directed tests in sync-engine.test.ts pin down known cases. This one
 * goes looking for the ones nobody thought of: a seeded generator mixes
 * typing, undo, changes that change nothing, IME compositions, focus and
 * visibility events, latency, lost answers, offline periods, 429/503, and
 * optionally a second device, against a server that follows the Worker's CAS
 * rules. After every run the oracles below must hold. A failure prints the
 * seed and the trace, so it can be replayed exactly.
 *
 * Oracles:
 * - LOST-UPDATE   the page saved over a server copy it never applied, matched
 *                 or asked about
 * - OVERWRITE     a remote copy silently replaced text the user had changed
 * - IME           a remote copy was applied during a composition
 * - DRAFT-CLEARED the local draft was dropped while the screen held text that
 *                 is not on the server
 * - DRAFT-MISSING unsynced text was on screen with no draft holding it
 * - DIVERGED      after everything settled, server and screen differ
 * - STUCK-DIRTY   equal content, but the engine still considers itself unsaved
 * - FALSE-ROLLBACK the engine refused a rollback that never happened
 * - STATUS        settled, but the status still says saving/offline/conflict
 * - SELF-CONFLICT a conflict question although no other device ever wrote
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentModel } from "../../packages/protocol/src/document.ts";

const draftStore = vi.hoisted(() => ({ current: null as string | null }));
vi.mock("../../apps/web/src/app/drafts.ts", () => ({
  saveDraft: async (draft: { plaintextDocument: string }) => {
    draftStore.current = (JSON.parse(draft.plaintextDocument) as { blocks: Array<{ text: string }> }).blocks[0]!.text;
  },
  clearDraft: async () => { draftStore.current = null; },
}));

const { api, ApiRequestError } = await import("../../apps/web/src/app/api.ts");
const { RevisionGuard } = await import("../../apps/web/src/app/revision-guard.ts");
const { SyncEngine } = await import("../../apps/web/src/app/sync.ts");

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const BLOCK = "22222222-2222-4222-8222-222222222222";
const etag = (revision: number): string => `"d-${DOC_ID}-e-1-r${revision}"`;
const docOf = (text: string): DocumentModel => ({ schemaVersion: 1, blocks: [{ id: BLOCK, type: "text", text }], media: {} });
const textOf = (document: DocumentModel): string => (document.blocks[0] as { text: string }).text;

interface PutBody { mutationId: string; encryptedRevision: number; ciphertext: string }
interface PutResult { etag: string; revision: number; mutationId: string; updatedAt: number }

/** A server with the CAS rules of apps/worker/src/document/store.ts. */
class Server {
  mutationId = "m0";
  constructor(public revision: number, public text: string) {}

  get(known?: string) {
    if (known === etag(this.revision)) return { notModified: true as const };
    return {
      data: {
        accountId: "a", documentId: DOC_ID, syncEpoch: 1, revision: this.revision,
        encryptedRevision: this.revision, formatVersion: 1, keyVersion: 1,
        mutationId: this.mutationId, nonce: "n", ciphertext: `${this.revision}:${this.text}`,
        referencedMediaIds: [], updatedAt: 0,
      },
      etag: etag(this.revision),
      notModified: false as const,
    };
  }

  /** The success body, or the status to answer with. */
  put(body: PutBody, ifMatch: string): PutResult | number {
    if (ifMatch !== etag(this.revision)) return 412;
    if (body.mutationId === this.mutationId) {
      return { etag: etag(this.revision), revision: this.revision, mutationId: body.mutationId, updatedAt: 0 };
    }
    if (body.encryptedRevision !== this.revision + 1) return 412;
    this.revision += 1;
    this.text = body.ciphertext.split(":").slice(1).join(":");
    this.mutationId = body.mutationId;
    return { etag: etag(this.revision), revision: this.revision, mutationId: body.mutationId, updatedAt: 0 };
  }

  /** Another device writes. */
  foreign(text: string): void {
    this.revision += 1;
    this.text = text;
    this.mutationId = `foreign-${this.revision}`;
  }
}

/** mulberry32: a small deterministic generator, so a seed replays a run. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimOptions {
  seed: number;
  steps: number;
  /** Another device also writes. */
  foreign: boolean;
  decision: "keep-local" | "use-remote" | "random";
}

interface SimResult {
  violations: string[];
  trace: string[];
}

async function simulate(options: SimOptions): Promise<SimResult> {
  const rand = rng(options.seed);
  const jitter = rng(options.seed * 7919 + 13);
  vi.spyOn(Math, "random").mockImplementation(() => jitter());
  const pick = (n: number): number => Math.floor(rand() * n);
  const trace: string[] = [];
  const violations: string[] = [];
  const server = new Server(5, "base");
  /** The newest server version the page's content derives from. */
  let trueBase = "base";
  let foreignWrites = 0;
  let applyingChosenRemote = false;
  let mode: "ok" | "offline" | "lossy" = "ok";
  let failNextPut: number | null = null;
  /** The conflict question is modal: no editing behind it. */
  let questionOpen = false;
  /** Server versions the page has applied, matched or asked about. */
  const integrated = new Set<string>(["base"]);

  // Read through functions: the network mode changes while a request awaits.
  const offline = (): boolean => mode === "offline";
  const lossy = (): boolean => mode === "lossy";
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const latency = (): number => pick(400);

  vi.spyOn(api, "document").mockImplementation(async (known?: string) => {
    if (offline()) { await delay(pick(30)); throw new TypeError("Failed to fetch"); }
    await delay(latency());
    const result = server.get(known);
    const lost = lossy() && rand() < 0.5;
    await delay(latency());
    if (lost || offline()) throw new TypeError("Failed to fetch");
    return result as never;
  });
  vi.spyOn(api, "putDocument").mockImplementation(async (payload, ifMatch) => {
    if (offline()) { await delay(pick(30)); throw new TypeError("Failed to fetch"); }
    await delay(latency());
    if (failNextPut !== null) {
      const status = failNextPut;
      failNextPut = null;
      trace.push(`  server: PUT refused ${status} (not stored)`);
      await delay(latency());
      throw new ApiRequestError(status, "X", "x");
    }
    const before = server.revision;
    const previousText = server.text;
    const result = server.put(payload as unknown as PutBody, ifMatch);
    const stored = typeof result !== "number" && server.revision !== before;
    if (stored && !integrated.has(previousText)) {
      violations.push(`LOST-UPDATE: the page saved "${server.text}" over "${previousText}", which it never applied, matched or asked about`);
    }
    if (stored) {
      integrated.add(server.text);
      trueBase = server.text;
      trace.push(`  server: stored own r${server.revision} "${server.text}"`);
    } else if (typeof result === "number") {
      trace.push(`  server: PUT ${result} (if-match ${ifMatch.slice(-4)} vs r${server.revision})`);
    }
    const lost = lossy() && rand() < 0.6;
    await delay(latency());
    if (lost || offline()) { trace.push("  net: PUT answer lost"); throw new TypeError("Failed to fetch"); }
    if (typeof result === "number") throw new ApiRequestError(result, "X", "x");
    return result;
  });

  const listeners = new Map<string, Array<() => void>>();
  const on = (name: string, handler: () => void): void => { listeners.set(name, [...(listeners.get(name) ?? []), handler]); };
  const page = { hidden: false, addEventListener: on, removeEventListener: () => undefined };
  vi.stubGlobal("window", {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    addEventListener: on,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("document", page);
  vi.stubGlobal("BroadcastChannel", undefined);

  const editor = { text: "base", safe: true };
  const states: string[] = [];
  let conflicts = 0;
  const stored = new Map<string, string>();
  const revisions = new RevisionGuard(DOC_ID, {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
  });
  revisions.record(5);
  const engine = new SyncEngine({
    bridge: {
      lastDroppedMediaIds: [],
      // The stand-in for AEAD: a ciphertext opens only under the revision it
      // was sealed for.
      decryptDocument: async (input: { ciphertext: string; encryptedRevision: number }) => {
        const [sealedAt, ...rest] = input.ciphertext.split(":");
        if (Number(sealedAt) !== input.encryptedRevision) throw new Error("decrypt failed");
        return docOf(rest.join(":"));
      },
      encryptDocument: async (input: { document: DocumentModel; encryptedRevision: number }) => ({
        nonce: "n",
        ciphertext: `${input.encryptedRevision}:${textOf(input.document)}`,
      }),
    } as never,
    callbacks: {
      getDocument: () => docOf(editor.text),
      applyRemote: (remote) => {
        const next = textOf(remote);
        if (!editor.safe) violations.push(`IME: remote "${next}" applied during a composition`);
        if (!applyingChosenRemote && editor.text !== next && editor.text !== trueBase) {
          violations.push(`OVERWRITE: screen "${editor.text}" silently replaced by "${next}" (true base "${trueBase}")`);
        }
        trace.push(`  page: applyRemote "${next}" over "${editor.text}"`);
        integrated.add(next);
        editor.text = next;
        trueBase = next;
      },
      onState: (state, detail) => {
        states.push(state);
        trace.push(`  state: ${state}${detail ? ` (${detail.slice(0, 16)})` : ""}`);
      },
      onConflict: async ({ local, remote }) => {
        conflicts += 1;
        integrated.add(textOf(remote));
        if (foreignWrites === 0) violations.push(`SELF-CONFLICT: asked about "${textOf(local)}" vs "${textOf(remote)}" although no other device ever wrote`);
        const decision = options.decision === "random" ? (rand() < 0.5 ? "keep-local" : "use-remote") : options.decision;
        trace.push(`  page: CONFLICT local "${textOf(local)}" remote "${textOf(remote)}" -> ${decision}`);
        questionOpen = true;
        await delay(pick(1500));
        questionOpen = false;
        if (decision === "use-remote") {
          applyingChosenRemote = true;
          // Covers only the synchronous apply that follows the answer.
          queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { applyingChosenRemote = false; })));
        } else {
          // Keeping the local copy makes the remote the version it continues from.
          trueBase = textOf(remote);
        }
        return decision;
      },
      isSafePoint: () => editor.safe,
    },
    accountId: "a",
    documentId: DOC_ID,
    keyVersion: 1,
    vaultKey: new Uint8Array(32),
    baseEtag: etag(5),
    baseRevision: 5,
    revisions,
  });
  engine.start();

  const internal = engine as unknown as {
    drafts: { clear: () => Promise<void> };
    dirty: boolean;
    stopped: boolean;
    rollbackRefused: boolean;
  };
  const clearDraft = internal.drafts.clear.bind(internal.drafts);
  internal.drafts.clear = () => {
    if (!applyingChosenRemote && editor.safe && editor.text !== trueBase && editor.text !== server.text) {
      violations.push(`DRAFT-CLEARED: draft dropped while the screen "${editor.text}" is neither the server copy "${server.text}" nor the true base "${trueBase}"`);
    }
    trace.push("  page: draft cleared");
    return clearDraft();
  };
  let lastEdit = Date.now();
  const checkDraft = (): void => {
    if (!editor.safe || questionOpen) return;
    if (Date.now() - lastEdit < 400) return; // inside the draft's coalescing window
    if (editor.text === server.text || editor.text === trueBase) return;
    if (draftStore.current !== editor.text) {
      violations.push(`DRAFT-MISSING: screen "${editor.text}" is not on the server ("${server.text}") and the stored draft is ${draftStore.current === null ? "absent" : `"${draftStore.current}"`}`);
    }
  };

  let counter = 0;
  const history = ["base"];
  let composingFrom: string | null = null;
  const fire = (name: string): void => { for (const handler of listeners.get(name) ?? []) handler(); };
  const edited = (text: string): void => {
    editor.text = text;
    history.push(text);
    lastEdit = Date.now();
    integrated.add(text);
    engine.noteCommittedChange();
  };

  for (let step = 0; step < options.steps; step += 1) {
    let r = rand();
    if (questionOpen && composingFrom === null && r < 0.40) r += 0.40; // no user input behind the question
    if (composingFrom !== null) {
      // While composing only time passes, reads happen, or the composition ends.
      if (r < 0.35) {
        const commit = rand() < 0.6;
        const text = commit ? `${composingFrom}+c${(counter += 1)}` : composingFrom;
        editor.safe = true;
        composingFrom = null;
        trace.push(`user: composition ${commit ? "committed" : "cancelled"} -> "${text}"`);
        edited(text); // the app reports a committed change either way
      } else if (r < 0.5) {
        trace.push("event: focus");
        fire("focus");
      } else {
        const ms = pick(1500);
        trace.push(`time: +${ms}`);
        await vi.advanceTimersByTimeAsync(ms);
      }
      continue;
    }
    if (r < 0.22) {
      edited(`${editor.text}.${(counter += 1)}`);
      trace.push(`user: type -> "${editor.text}"`);
    } else if (r < 0.30) {
      edited(history[Math.max(0, history.length - 1 - (1 + pick(2)))]!);
      trace.push(`user: undo -> "${editor.text}"`);
    } else if (r < 0.34) {
      trace.push("user: save request / change that changes nothing");
      engine.noteCommittedChange();
    } else if (r < 0.40) {
      composingFrom = editor.text;
      editor.safe = false;
      editor.text = `${editor.text}~`;
      trace.push("user: composition starts");
      engine.noteComposingChange();
    } else if (r < 0.46 && options.foreign) {
      foreignWrites += 1;
      server.foreign(`${server.text}/F${foreignWrites}`);
      trace.push(`other device: stored r${server.revision} "${server.text}"`);
    } else if (r < 0.54) {
      mode = (["ok", "offline", "lossy"] as const)[pick(3)]!;
      trace.push(`net: ${mode}`);
    } else if (r < 0.58) {
      failNextPut = rand() < 0.5 ? 503 : 429;
      trace.push(`net: next PUT -> ${failNextPut}`);
    } else if (r < 0.66) {
      trace.push("event: focus");
      fire("focus");
    } else if (r < 0.70) {
      page.hidden = !page.hidden;
      trace.push(`event: visibility hidden=${page.hidden}`);
      fire("visibilitychange");
    } else {
      const ms = [10, 100, 250, 350, 600, 1200, 3000][pick(7)]!;
      trace.push(`time: +${ms}`);
      await vi.advanceTimersByTimeAsync(ms);
      checkDraft();
    }
  }

  // Settle: the network is healthy, no composition, the page is visible.
  if (composingFrom !== null) {
    editor.safe = true;
    trace.push("user: composition cancelled (settle)");
    edited(composingFrom);
  }
  mode = "ok";
  failNextPut = null;
  if (page.hidden) { page.hidden = false; fire("visibilitychange"); }
  trace.push("settle");
  await vi.advanceTimersByTimeAsync(180_000);

  if (server.text !== editor.text) {
    violations.push(`DIVERGED: after settling the server holds "${server.text}" but the screen shows "${editor.text}" (dirty=${internal.dirty}, stopped=${internal.stopped}, state=${states.at(-1)})`);
  } else if (internal.dirty) {
    violations.push(`STUCK-DIRTY: content equal but the engine is still dirty (state=${states.at(-1)})`);
  }
  if (internal.rollbackRefused) violations.push("FALSE-ROLLBACK: the page refused a rollback that never happened");
  if (["saving", "local-only", "offline", "conflict"].includes(states.at(-1) ?? "")) {
    violations.push(`STATUS: settled but the last reported state is "${states.at(-1)}"`);
  }
  expect(conflicts === 0 || options.foreign).toBe(true);
  engine.stop();
  return { violations, trace };
}

describe("SyncEngine under random interleavings", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "one device", foreign: false, decision: "keep-local" as const, steps: 30, seeds: 1000 },
    { name: "another device writing, either answer to a conflict", foreign: true, decision: "random" as const, steps: 30, seeds: 1000 },
    { name: "another device writing, always taking the server copy, long runs", foreign: true, decision: "use-remote" as const, steps: 60, seeds: 400 },
  ])("spec: no typed text is lost, overwritten or left unsaved — $name", async ({ foreign, decision, steps, seeds }) => {
    const failures: string[] = [];
    for (let seed = 1; seed <= seeds; seed += 1) {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      vi.useFakeTimers();
      draftStore.current = null;
      const result = await simulate({ seed, steps, foreign, decision });
      if (result.violations.length > 0) {
        failures.push(`seed ${seed}: ${result.violations.join(" | ")}\n${result.trace.join("\n")}`);
        if (failures.length >= 3) break; // three traces are enough to work from
      }
    }
    expect(failures.join("\n\n")).toBe("");
  }, 120_000);
});
