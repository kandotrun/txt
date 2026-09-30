/** Page/controller-scoped transport. Keys are sent only to this page's controller. */
export class ServiceWorkerBridge {
  private target: ServiceWorker | null = null;
  private lifetime = new AbortController();
  private authenticated = false;
  private generation = 0;
  private pendingUpdates = 0;
  private queue: Promise<boolean> = Promise.resolve(false);
  private readonly timeoutMs: number;
  private readonly createChannel: () => MessageChannel;

  constructor(private container: ServiceWorkerContainer, private options: {
    timeoutMs?: number;
    createChannel?: () => MessageChannel;
    onInvalidated?: () => void;
  } = {}) {
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.createChannel = options.createChannel ?? (() => new MessageChannel());
    container.addEventListener("controllerchange", () => {
      // First claim wakes the controller waiter; replacement revokes the owner.
      if (this.target && this.target !== container.controller) this.reset();
    });
  }

  get ready(): boolean {
    return this.authenticated && this.pendingUpdates === 0 && this.isCurrent(this.lifetime);
  }

  reset(): void {
    const previous = this.target;
    this.target = null;
    this.authenticated = false;
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.pendingUpdates = 0;
    this.queue = Promise.resolve(false);
    // Revoke in-flight streams in the old worker as well as local ACKs.
    try { previous?.postMessage({ type: "txt-lock" }); } catch { /* worker gone */ }
    this.options.onInvalidated?.();
  }

  async start(data: Record<string, unknown> & { sessionGeneration: number }): Promise<boolean> {
    this.reset();
    const lifetime = this.lifetime;
    const controller = await this.waitForController(lifetime.signal);
    if (!controller || lifetime !== this.lifetime || lifetime.signal.aborted) return false;
    this.target = controller;
    this.generation = data.sessionGeneration;
    const acknowledged = await this.request(data, lifetime);
    if (!this.isCurrent(lifetime)) return false;
    if (!acknowledged) { this.reset(); return false; }
    this.authenticated = true;
    return true;
  }

  updateMedia(media: Record<string, unknown>): Promise<boolean> {
    const lifetime = this.lifetime;
    if (!this.authenticated || !this.isCurrent(lifetime)) return Promise.resolve(false);
    // Snapshot at enqueue time; later uploads must not mutate an older update.
    const snapshot = structuredClone(media);
    this.pendingUpdates++;
    const next = this.queue.then(async () => {
      if (!this.authenticated || !this.isCurrent(lifetime)) return false;
      const acknowledged = await this.request({
        type: "txt-media-update", sessionGeneration: this.generation, media: snapshot,
      }, lifetime);
      if (!this.isCurrent(lifetime)) return false;
      if (!acknowledged) { this.reset(); return false; }
      return true;
    }).finally(() => {
      if (lifetime === this.lifetime) this.pendingUpdates--;
    });
    this.queue = next;
    return next;
  }

  private isCurrent(lifetime: AbortController): boolean {
    return lifetime === this.lifetime && !lifetime.signal.aborted &&
      this.target !== null && this.target === this.container.controller;
  }

  private waitForController(signal: AbortSignal): Promise<ServiceWorker | null> {
    if (signal.aborted) return Promise.resolve(null);
    if (this.container.controller) return Promise.resolve(this.container.controller);
    return new Promise((resolve) => {
      const finish = (controller: ServiceWorker | null): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.container.removeEventListener("controllerchange", changed);
        resolve(controller);
      };
      const changed = (): void => { if (this.container.controller) finish(this.container.controller); };
      const abort = (): void => finish(null);
      const timer = setTimeout(abort, this.timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      this.container.addEventListener("controllerchange", changed);
      changed();
    });
  }

  private request(data: Record<string, unknown>, lifetime: AbortController): Promise<boolean> {
    if (!this.isCurrent(lifetime)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const channel = this.createChannel();
      const finish = (acknowledged: boolean): void => {
        clearTimeout(timer);
        lifetime.signal.removeEventListener("abort", abort);
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
        resolve(acknowledged);
      };
      const abort = (): void => finish(false);
      const timer = setTimeout(abort, this.timeoutMs);
      lifetime.signal.addEventListener("abort", abort, { once: true });
      channel.port1.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "txt-ready" && event.data.sessionGeneration === this.generation) {
          finish(this.isCurrent(lifetime));
        }
      };
      try { this.target!.postMessage(data, [channel.port2]); } catch { finish(false); }
    });
  }
}
