/**
 * Schedules the encrypted local draft (spec §9.8, §10.6).
 *
 * Serialising and encrypting the whole document is not something to do on
 * every keystroke. Changes are coalesced: the first change after a write opens
 * a short window, and one snapshot of the latest content is taken when it
 * closes — so continuous typing still persists once per window.
 *
 * Writes are strictly ordered. A snapshot is captured synchronously (it must
 * describe the document as it is right now) but stored by a single drain
 * loop: at most one write is in flight, a newer snapshot replaces an older one
 * that has not started, and a clear always lands after the write in flight.
 * Without that ordering an older draft could finish last and resurrect
 * content the server already holds.
 */

type Job = () => Promise<void>;

export class DraftScheduler {
  private readonly delayMs: number;
  private readonly capture: () => Job;
  private readonly clearDraft: Job;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private pending: Job | null = null;
  private draining: Promise<void> | null = null;

  constructor(options: {
    /** Length of the coalescing window. */
    delayMs: number;
    /** Snapshots the document now; the returned job stores that snapshot. */
    capture: () => Job;
    /** Deletes the stored draft. */
    clear: Job;
  }) {
    this.delayMs = options.delayMs;
    this.capture = options.capture;
    this.clearDraft = options.clear;
  }

  /** A committed change happened; persist it within one window. */
  noteChange(): void {
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Persists outstanding changes now (page hidden, lock, shutdown). */
  flush(): Promise<void> {
    this.cancelTimer();
    if (this.dirty) {
      this.dirty = false;
      this.pending = this.capture();
    }
    return this.drain();
  }

  /** The server holds the content: drop the draft and any unwritten snapshot. */
  clear(): Promise<void> {
    this.cancelTimer();
    this.dirty = false;
    this.pending = this.clearDraft;
    return this.drain();
  }

  /**
   * Forgets changes that have not been captured yet. Used when the document
   * behind `capture` is going away: a late snapshot would describe whatever
   * replaced it. A snapshot already captured is still written.
   */
  cancel(): void {
    this.cancelTimer();
    this.dirty = false;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    if (!this.pending) return Promise.resolve();
    // The loop starts on a later microtask, after `draining` is assigned, so
    // its cleanup can never run before the assignment and leave a finished
    // promise behind for later callers to wait on.
    const run = Promise.resolve().then(async () => {
      try {
        while (this.pending) {
          const job = this.pending;
          this.pending = null;
          // A draft is best effort (§10.6): a failed write must not stop the
          // ones after it.
          await job().catch(() => undefined);
        }
      } finally {
        this.draining = null;
      }
    });
    this.draining = run;
    return run;
  }
}
