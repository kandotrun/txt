/**
 * Rollback detection (spec §10.4): a device never silently accepts a copy of
 * the document that is older than one it has already seen.
 */
import { describe, expect, it } from "vitest";

import { RevisionGuard, markFromEtag } from "../../apps/web/src/app/revision-guard.ts";

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
  it("spec: accepts anything on a device that has seen nothing", () => {
    const guard = new RevisionGuard(DOC, memoryStorage());
    expect(guard.accepts({ syncEpoch: 1, revision: 0 })).toBe(true);
  });

  it("spec: refuses an older revision of the same epoch, and accepts the same or newer", () => {
    const guard = new RevisionGuard(DOC, memoryStorage());
    guard.record({ syncEpoch: 1, revision: 17 });
    expect.soft(guard.accepts({ syncEpoch: 1, revision: 16 })).toBe(false);
    expect.soft(guard.accepts({ syncEpoch: 1, revision: 0 })).toBe(false);
    expect.soft(guard.accepts({ syncEpoch: 1, revision: 17 })).toBe(true);
    expect(guard.accepts({ syncEpoch: 1, revision: 18 })).toBe(true);
  });

  it("spec: a raised epoch (a restored database) may restart the revision; a lowered one may not", () => {
    const guard = new RevisionGuard(DOC, memoryStorage());
    guard.record({ syncEpoch: 2, revision: 40 });
    expect.soft(guard.accepts({ syncEpoch: 3, revision: 5 })).toBe(true);
    expect(guard.accepts({ syncEpoch: 1, revision: 900 })).toBe(false);
  });

  it("spec: the mark never moves backwards and survives a reload", () => {
    const storage = memoryStorage();
    const guard = new RevisionGuard(DOC, storage);
    guard.record({ syncEpoch: 1, revision: 9 });
    guard.record({ syncEpoch: 1, revision: 4 });
    guard.record(null);
    expect(storage.data.get(`txt.seen.${DOC}`)).toBe("1:9");
    expect(new RevisionGuard(DOC, storage).accepts({ syncEpoch: 1, revision: 8 })).toBe(false);
    // Another document on the same device is tracked separately.
    expect(new RevisionGuard("other", storage).accepts({ syncEpoch: 1, revision: 0 })).toBe(true);
  });

  it("spec: only an explicit reset lowers the mark", () => {
    const storage = memoryStorage();
    const guard = new RevisionGuard(DOC, storage);
    guard.record({ syncEpoch: 1, revision: 9 });
    guard.reset({ syncEpoch: 1, revision: 3 });
    expect(guard.accepts({ syncEpoch: 1, revision: 3 })).toBe(true);
    expect(storage.data.get(`txt.seen.${DOC}`)).toBe("1:3");
  });

  it("spec: still guards the open page when storage is unavailable or corrupt", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const guard = new RevisionGuard(DOC, broken);
    guard.record({ syncEpoch: 1, revision: 5 });
    expect.soft(guard.accepts({ syncEpoch: 1, revision: 4 })).toBe(false);
    expect.soft(new RevisionGuard(DOC, null).accepts({ syncEpoch: 1, revision: 0 })).toBe(true);
    expect(new RevisionGuard(DOC, memoryStorage({ [`txt.seen.${DOC}`]: "garbage" }))
      .accepts({ syncEpoch: 1, revision: 0 })).toBe(true);
  });

  it("spec: reads the mark from a document ETag, weak or strong", () => {
    expect.soft(markFromEtag(`"d-${DOC}-e-3-r17"`)).toEqual({ syncEpoch: 3, revision: 17 });
    expect.soft(markFromEtag(`W/"d-${DOC}-e-3-r17"`)).toEqual({ syncEpoch: 3, revision: 17 });
    expect.soft(markFromEtag("*")).toBeNull();
    expect(markFromEtag(undefined)).toBeNull();
  });
});
