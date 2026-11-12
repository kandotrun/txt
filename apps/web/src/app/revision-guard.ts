/**
 * Rollback detection (spec §10.4).
 *
 * The server cannot read or forge the document, but it could hand back an
 * older, perfectly authentic snapshot — silently undoing what the user wrote.
 * This device therefore remembers the highest revision it has seen for a
 * document and refuses anything older.
 *
 * The mark is `(syncEpoch, revision)`. The revision only ever grows within an
 * epoch; an operator restoring a database backup raises the epoch (spec §14),
 * which is the one legitimate way for the revision to restart.
 *
 * What is stored is two counters per document id — no content and no key — in
 * localStorage, next to the language choice (spec §4.7, §6.5).
 */

export interface RevisionMark {
  syncEpoch: number;
  revision: number;
}

type MarkStorage = Pick<Storage, "getItem" | "setItem">;

const KEY_PREFIX = "txt.seen.";
const ETAG = /^(?:W\/)?"d-[0-9a-fA-F-]+-e-(\d+)-r(\d+)"$/;

/** Reads the mark out of a document ETag (`"d-<id>-e-<epoch>-r<revision>"`). */
export function markFromEtag(etag: string | null | undefined): RevisionMark | null {
  const match = ETAG.exec(etag?.trim() ?? "");
  return match ? { syncEpoch: Number(match[1]), revision: Number(match[2]) } : null;
}

function isOlder(candidate: RevisionMark, seen: RevisionMark): boolean {
  if (candidate.syncEpoch !== seen.syncEpoch) return candidate.syncEpoch < seen.syncEpoch;
  return candidate.revision < seen.revision;
}

export class RevisionGuard {
  private readonly key: string;
  private readonly storage: MarkStorage | null;
  /** Kept in memory too, so a storage failure still protects this page. */
  private seen: RevisionMark | null;

  constructor(documentId: string, storage: MarkStorage | null) {
    this.key = `${KEY_PREFIX}${documentId}`;
    this.storage = storage;
    this.seen = this.read();
  }

  /** False when `mark` is older than something this device already saw. */
  accepts(mark: RevisionMark): boolean {
    return this.seen === null || !isOlder(mark, this.seen);
  }

  /** Remembers `mark` if it is newer than the current one. */
  record(mark: RevisionMark | null): void {
    if (!mark || (this.seen !== null && !isOlder(this.seen, mark))) return;
    this.write(mark);
  }

  /** The user explicitly chose to open an older copy: restart from it. */
  reset(mark: RevisionMark): void {
    this.write(mark);
  }

  private read(): RevisionMark | null {
    try {
      const match = /^(\d+):(\d+)$/.exec(this.storage?.getItem(this.key) ?? "");
      return match ? { syncEpoch: Number(match[1]), revision: Number(match[2]) } : null;
    } catch {
      return null;
    }
  }

  private write(mark: RevisionMark): void {
    this.seen = { syncEpoch: mark.syncEpoch, revision: mark.revision };
    try {
      this.storage?.setItem(this.key, `${mark.syncEpoch}:${mark.revision}`);
    } catch {
      // Private mode or quota: the in-memory mark still guards this page.
    }
  }
}

/** Thrown when the server offers a copy older than one this device has seen. */
export class RollbackError extends Error {
  readonly mark: RevisionMark;
  constructor(message: string, mark: RevisionMark) {
    super(message);
    this.name = "RollbackError";
    this.mark = mark;
  }
}
