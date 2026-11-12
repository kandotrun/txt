/**
 * Draft persistence scheduling (spec §9.8, §10.6): snapshots are coalesced
 * instead of being taken per keystroke, writes never overlap, and a write that
 * was superseded can never land after a newer write or after a clear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DraftScheduler } from "../../apps/web/src/app/draft-scheduler.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("DraftScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("spec: a burst of changes takes one snapshot, of the latest content", async () => {
    let content = "";
    const written: string[] = [];
    const scheduler = new DraftScheduler({
      delayMs: 200,
      capture: () => { const snapshot = content; return async () => { written.push(snapshot); }; },
      clear: async () => undefined,
    });
    for (const next of ["a", "ab", "abc", "abcd"]) {
      content = next;
      scheduler.noteChange();
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(written).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(written).toEqual(["abcd"]);
  });

  it("spec: continuous typing still persists at least once per window", async () => {
    let content = "";
    const written: string[] = [];
    const scheduler = new DraftScheduler({
      delayMs: 200,
      capture: () => { const snapshot = content; return async () => { written.push(snapshot); }; },
      clear: async () => undefined,
    });
    for (let index = 0; index < 20; index++) {
      content += "x";
      scheduler.noteChange();
      await vi.advanceTimersByTimeAsync(50);
    }
    // 1 s of typing every 50 ms: a trailing-only debounce would have written nothing.
    expect(written.length).toBeGreaterThanOrEqual(4);
    expect(written.length).toBeLessThanOrEqual(6);
  });

  it("spec: flush persists immediately and writes never overlap or go backwards", async () => {
    let content = "one";
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    const finished: string[] = [];
    let active = 0;
    let maxActive = 0;
    const scheduler = new DraftScheduler({
      delayMs: 200,
      capture: () => {
        const snapshot = content;
        const gate = gates[started.length]!;
        return async () => {
          started.push(snapshot);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await gate.promise;
          active -= 1;
          finished.push(snapshot);
        };
      },
      clear: async () => undefined,
    });
    scheduler.noteChange();
    const first = scheduler.flush();
    await Promise.resolve();
    expect(started).toEqual(["one"]);

    // Two more changes arrive while the first write is still in flight: only
    // the newest is worth writing.
    content = "two";
    scheduler.noteChange();
    void scheduler.flush();
    content = "three";
    scheduler.noteChange();
    const last = scheduler.flush();
    await Promise.resolve();
    expect(started).toEqual(["one"]);

    gates[0]!.resolve();
    gates[1]!.resolve();
    gates[2]!.resolve();
    await first;
    await last;
    expect(finished).toEqual(["one", "three"]);
    expect(maxActive).toBe(1);
  });

  it("spec: a clear cancels the pending snapshot and lands after the write in flight", async () => {
    const gate = deferred();
    const log: string[] = [];
    let content = "draft";
    const scheduler = new DraftScheduler({
      delayMs: 200,
      capture: () => { const snapshot = content; return async () => { await gate.promise; log.push(`write:${snapshot}`); }; },
      clear: async () => { log.push("clear"); },
    });
    scheduler.noteChange();
    void scheduler.flush();
    await Promise.resolve();

    content = "newer";
    scheduler.noteChange();
    const cleared = scheduler.clear();
    gate.resolve();
    await cleared;
    await vi.advanceTimersByTimeAsync(1000);
    // The stale write finishes first, the clear is last, and the change that
    // the clear superseded is never written afterwards.
    expect(log).toEqual(["write:draft", "clear"]);
  });

  it("spec: cancel drops an uncaptured change but not a snapshot already taken", async () => {
    let content = "kept";
    const written: string[] = [];
    const scheduler = new DraftScheduler({
      delayMs: 200,
      capture: () => { const snapshot = content; return async () => { written.push(snapshot); }; },
      clear: async () => undefined,
    });
    scheduler.noteChange();
    const flushed = scheduler.flush();
    // The document is replaced (lock): a later snapshot would be of the wrong content.
    content = "";
    scheduler.noteChange();
    scheduler.cancel();
    await flushed;
    await vi.advanceTimersByTimeAsync(1000);
    expect(written).toEqual(["kept"]);
  });

  it("spec: a flush with nothing to write does not stop later writes or clears", async () => {
    const log: string[] = [];
    const scheduler = new DraftScheduler({
      delayMs: 200,
      capture: () => async () => { log.push("write"); },
      clear: async () => { log.push("clear"); },
    });
    // A clean page going to the background flushes with nothing pending.
    await scheduler.flush();
    scheduler.noteChange();
    await scheduler.flush();
    await scheduler.clear();
    expect(log).toEqual(["write", "clear"]);
  });

  it("spec: a failed write does not stop later writes", async () => {
    const written: string[] = [];
    let fail = true;
    const scheduler = new DraftScheduler({
      delayMs: 200,
      capture: () => async () => {
        if (fail) { fail = false; throw new Error("quota"); }
        written.push("ok");
      },
      clear: async () => undefined,
    });
    scheduler.noteChange();
    await scheduler.flush();
    scheduler.noteChange();
    await scheduler.flush();
    expect(written).toEqual(["ok"]);
  });
});
