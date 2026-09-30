import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceWorkerBridge } from "../../apps/web/src/app/service-worker-bridge.ts";

// Only the browser transport is simulated; all ordering/lifetime logic is real.
class Controller {
  messages: { data: Record<string, unknown>; port?: MessagePort }[] = [];
  postMessage(data: Record<string, unknown>, ports: MessagePort[] = []): void {
    this.messages.push({ data, port: ports[0] });
  }
  ack(index: number, data?: unknown): void {
    const message = this.messages[index]!;
    message.port?.postMessage(data ?? { type: "txt-ready", sessionGeneration: message.data.sessionGeneration });
  }
}
class Container extends EventTarget {
  controller: Controller | null = new Controller();
  replace(controller: Controller | null): void {
    this.controller = controller;
    this.dispatchEvent(new Event("controllerchange"));
  }
}
function transport() {
  const channels: { closed: number }[] = [];
  const createChannel = (): MessageChannel => {
    const lifecycle = { closed: 0 };
    channels.push(lifecycle);
    const port1 = { onmessage: null as ((event: MessageEvent) => void) | null, close: () => lifecycle.closed++, start() {} };
    const port2 = { postMessage: (data: unknown) => port1.onmessage?.({ data } as MessageEvent), close: () => lifecycle.closed++ };
    return { port1, port2 } as unknown as MessageChannel;
  };
  const container = new Container();
  const bridge = new ServiceWorkerBridge(container as unknown as ServiceWorkerContainer, { timeoutMs: 50, createChannel });
  return { container, bridge, channels };
}
const payload = (sessionGeneration = 1) => ({
  type: "txt-handshake" as const, sessionGeneration, accountId: "synthetic", documentId: "doc",
  keyVersion: 1, vaultKey: "synthetic-test-only", media: {},
});
async function flush(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve(); }
afterEach(() => vi.useRealTimers());

describe("page-specific Service Worker readiness", () => {
  it("requires a matching MessageChannel ACK before readiness", async () => {
    const { bridge, container, channels } = transport();
    const pending = bridge.start(payload());
    await flush();
    expect(bridge.ready).toBe(false);
    expect(container.controller!.messages[0]!.port).toBeDefined();
    container.controller!.ack(0);
    expect(await pending).toBe(true);
    expect(bridge.ready).toBe(true);
    expect(channels[0]!.closed).toBe(2);
    bridge.reset();
  });
  it("waits for this page's controller rather than an active registration", async () => {
    const { bridge, container } = transport();
    container.controller = null;
    const pending = bridge.start(payload());
    await flush();
    expect(bridge.ready).toBe(false);
    const controller = new Controller();
    container.replace(controller);
    await flush();
    expect(controller.messages[0]!.data.type).toBe("txt-handshake");
    controller.ack(0);
    expect(await pending).toBe(true);
    bridge.reset();
  });
  it("ignores wrong ACK type and generation", async () => {
    const { bridge, container } = transport();
    const pending = bridge.start(payload(7));
    await flush();
    container.controller!.ack(0, { type: "txt-lock", sessionGeneration: 7 });
    container.controller!.ack(0, { type: "txt-ready", sessionGeneration: 6 });
    expect(bridge.ready).toBe(false);
    container.controller!.ack(0);
    expect(await pending).toBe(true);
    bridge.reset();
  });
  it("bounds ACK timeout and closes both ports", async () => {
    vi.useFakeTimers();
    const { bridge, channels } = transport();
    const pending = bridge.start(payload());
    await flush();
    await vi.advanceTimersByTimeAsync(51);
    expect(await pending).toBe(false);
    expect(bridge.ready).toBe(false);
    expect(channels[0]!.closed).toBe(2);
  });
  it("bounds controller wait and removes its listener", async () => {
    vi.useFakeTimers();
    const { bridge, container } = transport();
    container.controller = null;
    const pending = bridge.start(payload());
    await vi.advanceTimersByTimeAsync(51);
    expect(await pending).toBe(false);
    const controller = new Controller();
    container.replace(controller);
    await flush();
    expect(controller.messages).toHaveLength(0);
  });
  it("does not revive readiness on delayed ACK after lock", async () => {
    const { bridge, container } = transport();
    const pending = bridge.start(payload());
    await flush();
    const controller = container.controller!;
    bridge.reset();
    controller.ack(0);
    expect(await pending).toBe(false);
    expect(bridge.ready).toBe(false);
    expect(controller.messages.at(-1)!.data.type).toBe("txt-lock");
  });
  it("does not revive an old session on delayed ACK", async () => {
    const { bridge, container } = transport();
    const old = bridge.start(payload());
    await flush();
    const current = bridge.start(payload(2));
    await flush();
    container.controller!.ack(0);
    expect(await old).toBe(false);
    expect(bridge.ready).toBe(false);
    container.controller!.ack(2);
    expect(await current).toBe(true);
    bridge.reset();
  });
  it("revokes readiness and ignores delayed ACK from a replaced controller", async () => {
    const { bridge, container } = transport();
    const oldController = container.controller!;
    const pending = bridge.start(payload());
    await flush();
    container.replace(new Controller());
    oldController.ack(0);
    expect(await pending).toBe(false);
    expect(bridge.ready).toBe(false);
    expect(oldController.messages.at(-1)!.data.type).toBe("txt-lock");
  });
  it("serializes metadata updates and waits for each matching ACK", async () => {
    const { bridge, container } = transport();
    const started = bridge.start(payload(4));
    await flush();
    container.controller!.ack(0);
    await started;
    const first = bridge.updateMedia({ first: {} });
    const second = bridge.updateMedia({ second: {} });
    await flush();
    expect(bridge.ready).toBe(false);
    expect(container.controller!.messages).toHaveLength(2);
    expect(container.controller!.messages[1]!.data).toMatchObject({ type: "txt-media-update", sessionGeneration: 4, media: { first: {} } });
    container.controller!.ack(1);
    expect(await first).toBe(true);
    await flush();
    expect(bridge.ready).toBe(false);
    expect(container.controller!.messages).toHaveLength(3);
    container.controller!.ack(2);
    expect(await second).toBe(true);
    expect(bridge.ready).toBe(true);
    bridge.reset();
  });
  it("drops queued metadata and late ACKs after lock", async () => {
    const { bridge, container } = transport();
    const started = bridge.start(payload());
    await flush();
    container.controller!.ack(0);
    await started;
    const first = bridge.updateMedia({ first: {} });
    const second = bridge.updateMedia({ second: {} });
    await flush();
    bridge.reset();
    container.controller!.ack(1);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(container.controller!.messages.filter(({ data }) => data.type === "txt-media-update")).toHaveLength(1);
    expect(bridge.ready).toBe(false);
  });
});
