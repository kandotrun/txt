/**
 * Rollback detection (spec §10.4): a device never silently accepts a copy of
 * the document that is older than one it has already opened. The mark is the
 * AEAD-bound `encryptedRevision`, never a counter the server merely reports.
 */
import { describe, expect, it } from "vitest";

import { RevisionGuard } from "../../apps/web/src/app/revision-guard.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

const DOC = "22222222-2222-4222-8222-222222222222";

describe("RevisionGuard", () => {
  it("spec: accepts anything on a device that has opened nothing", () => {
    const guard = new RevisionGuard(DOC, memoryStorage());
    expect(guard.current()).toBeNull();
    expect(guard.accepts(0)).toBe(true);
  });

  it("spec: refuses an older revision, and accepts the same or a newer one", () => {
    const guard = new RevisionGuard(DOC, memoryStorage());
    guard.record(17);
    expect.soft(guard.accepts(16)).toBe(false);
    expect.soft(guard.accepts(0)).toBe(false);
    expect.soft(guard.accepts(17)).toBe(true);
    expect(guard.accepts(18)).toBe(true);
  });

  it("spec: tells a rollback from a response that merely arrived late", () => {
    const guard = new RevisionGuard(DOC, memoryStorage());
    guard.record(5);
    const knownWhenSent = guard.current();
    guard.record(7); // this device saved twice while the read was in flight
    // The read answers with revision 6: older than now, not older than then.
    expect.soft(guard.accepts(6)).toBe(false);
    expect.soft(guard.accepts(6, knownWhenSent)).toBe(true);
    // Revision 4 is older than anything known when the read was sent.
    expect(guard.accepts(4, knownWhenSent)).toBe(false);
  });

  it("spec: the mark never moves backwards and survives a reload", () => {
    const storage = memoryStorage();
    const guard = new RevisionGuard(DOC, storage);
    guard.record(9);
    guard.record(4);
    expect(storage.data.get(`txt.seen.${DOC}`)).toBe("9");
    expect(new RevisionGuard(DOC, storage).accepts(8)).toBe(false);
    // Another document on the same device is tracked separately.
    expect(new RevisionGuard("other", storage).accepts(0)).toBe(true);
  });

  it("spec: only an explicit reset lowers the mark", () => {
    const storage = memoryStorage();
    const guard = new RevisionGuard(DOC, storage);
    guard.record(9);
    guard.reset(3);
    expect(guard.accepts(3)).toBe(true);
    expect(storage.data.get(`txt.seen.${DOC}`)).toBe("3");
  });

  it("spec: still guards the open page when storage is unavailable or corrupt", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const guard = new RevisionGuard(DOC, broken);
    guard.record(5);
    expect.soft(guard.accepts(4)).toBe(false);
    expect.soft(new RevisionGuard(DOC, null).accepts(0)).toBe(true);
    expect(new RevisionGuard(DOC, memoryStorage({ [`txt.seen.${DOC}`]: "1:9" })).accepts(0)).toBe(true);
  });

  it("spec: a page that is behind cannot lower the mark another page raised", () => {
    const storage = memoryStorage();
    const pageA = new RevisionGuard(DOC, storage);
    const pageB = new RevisionGuard(DOC, storage);
    pageA.record(5);
    pageB.record(5);
    pageA.record(10); // this tab saved several times
    pageB.record(6); // the other tab finally processes an older answer
    expect.soft(storage.data.get(`txt.seen.${DOC}`)).toBe("10");
    // Every page of the device, and any page opened later, judges by the
    // newest copy the device has opened.
    expect.soft(pageB.current()).toBe(10);
    expect.soft(pageB.accepts(8)).toBe(false);
    expect(new RevisionGuard(DOC, storage).accepts(8)).toBe(false);
  });
});
