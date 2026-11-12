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
 */

type MarkStorage = Pick<Storage, "getItem" | "setItem">;

const KEY_PREFIX = "txt.seen.";

export class RevisionGuard {
  private readonly key: string;
  private readonly storage: MarkStorage | null;
  /** Kept in memory too, so a storage failure still protects this page. */
  private seen: number | null;

  constructor(documentId: string, storage: MarkStorage | null) {
    this.key = `${KEY_PREFIX}${documentId}`;
    this.storage = storage;
    this.seen = this.read();
  }

  /** The newest revision this device has opened, or null if none. */
  current(): number | null {
    return this.seen;
  }

  /**
   * False when `encryptedRevision` is older than `floor`. The floor defaults
   * to the current mark; pass the mark captured before a request was sent to
   * tell a rollback (older than what was known then) from a response that
   * merely arrived after a newer one (older only than what is known now).
   */
  accepts(encryptedRevision: number, floor: number | null = this.seen): boolean {
    return floor === null || encryptedRevision >= floor;
  }

  /** Remembers `encryptedRevision` if it is newer than the current mark. */
  record(encryptedRevision: number): void {
    if (this.seen !== null && encryptedRevision <= this.seen) return;
    this.write(encryptedRevision);
  }

  /** The user explicitly chose to open an older copy: restart from it. */
  reset(encryptedRevision: number): void {
    this.write(encryptedRevision);
  }

  private read(): number | null {
    try {
      const stored = this.storage?.getItem(this.key) ?? "";
      return /^\d{1,15}$/.test(stored) ? Number(stored) : null;
    } catch {
      return null;
    }
  }

  private write(encryptedRevision: number): void {
    this.seen = encryptedRevision;
    try {
      this.storage?.setItem(this.key, String(encryptedRevision));
    } catch {
      // Private mode or quota: the in-memory mark still guards this page.
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
