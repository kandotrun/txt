/**
 * Runs asynchronous jobs one at a time, in the order they were requested.
 *
 * Used for the app's single dialog element: a question requested while
 * another one is open must wait for that answer instead of taking the element
 * over (see `showDialog` in main.ts).
 */

interface Waiting {
  start: () => void;
  keepOnReset: boolean;
}

export class SerialQueue {
  private waiting: Waiting[] = [];
  private busy = false;
  /** Raised by reset(): a job started before it no longer counts as running. */
  private epoch = 0;
  private idleWaiters: Array<() => void> = [];

  /**
   * Runs `job` once every job requested before it has settled, whether those
   * succeeded or failed, and returns its result. With nothing running, the
   * job starts at once.
   *
   * `keepOnReset`: the job still runs if a reset arrives while it is waiting.
   */
  run<T>(job: () => Promise<T>, options: { keepOnReset?: boolean } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({
        keepOnReset: options.keepOnReset === true,
        start: () => {
          const epoch = this.epoch;
          const finished = (): void => {
            // Abandoned by a reset in the meantime: the queue has moved on.
            if (epoch !== this.epoch) return;
            this.busy = false;
            this.next();
          };
          let running: Promise<T>;
          try {
            running = job();
          } catch (error) {
            reject(error);
            finished();
            return;
          }
          running.then(resolve, reject).then(finished);
        },
      });
      this.next();
    });
  }

  /**
   * Abandons the running job and every waiting one that was not marked
   * `keepOnReset`: none of them holds up a later job, and the abandoned
   * waiting ones never start (their promises never settle). For when what
   * the jobs were about has ended and the running one will never finish by
   * itself — its dialog was closed by a lock, not by an answer.
   */
  reset(): void {
    this.epoch += 1;
    this.busy = false;
    this.waiting = this.waiting.filter((entry) => entry.keepOnReset);
    this.next();
  }

  /** Resolves once nothing is running or waiting (at once, if so already). */
  whenIdle(): Promise<void> {
    if (!this.busy && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => { this.idleWaiters.push(resolve); });
  }

  private next(): void {
    if (this.busy) return;
    const entry = this.waiting.shift();
    if (!entry) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      return;
    }
    this.busy = true;
    entry.start();
  }
}
