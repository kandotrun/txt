/**
 * Rollback detection (spec §10.4).
 *
 * The server cannot read or forge the document, but it could hand back an
 * older, perfectly authentic snapshot — silently undoing what the user wrote.
 * This device therefore remembers the newest copy it has opened and refuses
 * anything older.
 *
 * The mark is the document's `encryptedRevision`. That number is part of the
 * AEAD associated data: a ciphertext only opens under the revision it was
 * sealed for, so the server cannot relabel an old copy as a new one. The
 * counters the server reports next to it (`revision`, `syncEpoch`, the ETag)
 * are not authenticated and are deliberately not used — a raised epoch does
 * not make an older copy acceptable. A copy that really is older, such as a
 * restored backup, is therefore shown to the user, who decides.
 *
 * Callers must only pass revisions of copies they have decrypted (or sealed)
 * themselves. What is stored is one counter per document id — no content and
 * no key — in localStorage, next to the language choice (spec §4.7, §6.5).
 *
 * Every tab of the browser shares that stored mark. Reading it is always
 * safe; changing it is a read-compare-write, which two tabs could interleave
 * (the slower one would write its smaller number last). Raising the mark
 * therefore runs under a Web Lock named after the document, so the stored
 * mark only ever grows — except through `reset`, the user's explicit choice.
 */

type MarkStorage = Pick<Storage, "getItem" | "setItem">;

/** The part of the Web Locks API this needs (`navigator.locks`). */
export interface MarkLocks {
  request(name: string, callback: () => void | Promise<void>): Promise<unknown>;
}

const KEY_PREFIX = "txt.seen.";

export class RevisionGuard {
  private readonly key: string;
  private storage: MarkStorage | null;
  private readonly locks: MarkLocks | null;
  /** Kept in memory too, so a storage failure still protects this page. */
  private seen: number | null;
  /** How often this page lowered the mark on the user's explicit choice. */
  private resets = 0;

  constructor(documentId: string, storage: MarkStorage | null, locks: MarkLocks | null = null) {
    this.key = `${KEY_PREFIX}${documentId}`;
    this.storage = storage;
    this.locks = locks;
    this.seen = null;
    this.current();
  }

  /**
   * The newest revision this device has opened, or null if none. Other pages
   * of the same document share the stored mark, so it is read every time:
   * the answer is the newest copy any of them has opened.
   */
  current(): number | null {
    const stored = this.read();
    if (stored !== null && (this.seen === null || stored > this.seen)) this.seen = stored;
    return this.seen;
  }

  /**
   * False when `encryptedRevision` is older than `floor`. The floor defaults
   * to the current mark; pass the mark captured before a request was sent to
   * tell a rollback (older than what was known then) from a response that
   * merely arrived after a newer one (older only than what is known now).
   */
  accepts(encryptedRevision: number, floor: number | null = this.current()): boolean {
    return floor === null || encryptedRevision >= floor;
  }

  /**
   * Remembers `encryptedRevision` if it is newer than the device's mark. A
   * page that is behind another one never lowers it.
   */
  record(encryptedRevision: number): void {
    const known = this.current();
    if (known !== null && encryptedRevision <= known) return;
    this.seen = encryptedRevision;
    const storedWhenQueued = this.read();
    const resetsWhenQueued = this.resets;
    this.exclusively(() => {
      // The stored mark only falls through reset(). If it fell while this
      // raise was waiting for the lock — here or in another page — the user
      // chose an older copy in the meantime, and that choice stands.
      if (this.resets !== resetsWhenQueued) return;
      const stored = this.read();
      if (stored !== null && storedWhenQueued !== null && stored < storedWhenQueued) return;
      if (stored === null || encryptedRevision > stored) this.write(encryptedRevision);
    });
  }

  /**
   * The user explicitly chose to open an older copy: restart from it. Written
   * at once and unconditionally — it must hold for the very next check on
   * this page, and it is the one change that is allowed to lower the mark.
   */
  reset(encryptedRevision: number): void {
    this.resets += 1;
    this.seen = encryptedRevision;
    this.write(encryptedRevision);
  }

  /**
   * Runs a change of the stored mark with no other tab in the middle of one.
   * Without the Web Locks API the change simply runs; so does a change whose
   * lock request fails.
   */
  private exclusively(change: () => void): void {
    if (!this.locks) {
      change();
      return;
    }
    let done = false;
    const once = (): void => {
      if (done) return;
      done = true;
      change();
    };
    try {
      void this.locks.request(this.key, once).catch(once);
    } catch {
      once();
    }
  }

  private read(): number | null {
    try {
      const stored = this.storage?.getItem(this.key) ?? "";
      if (!/^\d{1,16}$/.test(stored)) return null;
      const value = Number(stored);
      return Number.isSafeInteger(value) ? value : null;
    } catch {
      return null;
    }
  }

  private write(encryptedRevision: number): void {
    try {
      this.storage?.setItem(this.key, String(encryptedRevision));
    } catch {
      // Private mode or quota. From here on the in-memory mark is the only
      // one this page has: stop consulting a store that cannot be updated, or
      // its stale value would override an explicit reset.
      this.storage = null;
    }
  }
}

/** Thrown when the server offers a copy older than one this device has opened. */
export class RollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RollbackError";
  }
}
