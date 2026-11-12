/**
 * The app has one <dialog> element, and questions arrive from flows that do
 * not know about each other: the sync engine asks about a conflict whenever a
 * save is refused, while the user may be halfway into another screen that
 * shows its dialog after an await (the passkey list, a rotated recovery key).
 *
 * A question must never be replaced by a later one. A replaced question can no
 * longer be answered — and the sync engine, waiting for the answer to a
 * conflict, would never save again (spec §10.4: the user chooses). And a lock
 * must leave nothing of the session behind: not the open question, not the
 * ones that were waiting for their turn.
 *
 * The real functions are cut out of main.ts and run against a stand-in for the
 * dialog element whose `close` event fires asynchronously, as in a browser.
 * They are evaluated in this realm (`new Function`), not in a `vm` context: an
 * `await` across realms takes extra microtask turns, and the order in which
 * "the menu was answered", "the lock ran" and "the next dialog opens" happen
 * is exactly what these tests are about. The only code evaluated this way is
 * this repository's own main.ts, read from the working tree.
 */
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import ts from "typescript5";
import { describe, expect, it } from "vitest";

import { SerialQueue } from "../../apps/web/src/app/serial-queue.ts";

const source = ts.createSourceFile(
  "main.ts",
  readFileSync(new URL("../../apps/web/src/app/main.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
);
const NAMES = [
  "dialogToken", "dialogQueue", "releaseOpenDialog", "lastDialogAnswerAt", "showDialog", "openDialog", "abandonDialogs",
  "clearDialogContent", "textParagraph", "askConflict", "preparing", "prepareOnce", "manageSecurity",
  "rotationsAnnounced", "showMoreMenu", "confirmRecoveryKey",
];
/** In the app the moment in which a freshly opened dialog ignores input is longer; the tests need not wait that long. */
const GUARD_MS = 60;
const declarations = NAMES
  .map((name) => {
    const node = source.statements.find((statement) =>
      (ts.isFunctionDeclaration(statement) && statement.name?.text === name) ||
      (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === name)));
    if (!node) throw new Error(`Missing in main.ts: ${name}`);
    return node.getText(source);
  })
  .join("\n");
const code = transformSync(
  `${declarations}\n return { showDialog, abandonDialogs, askConflict, prepareOnce, manageSecurity, showMoreMenu };`,
  { loader: "ts", target: "es2022" },
).code;

class FakeElement {
  children: FakeElement[] = [];
  textContent = "";
  hidden = false;
  disabled = false;
  className = "";
  type = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  onclick: (() => void) | null = null;
  classList = { toggle: (): void => undefined };
  private readonly listeners = new Map<string, Set<() => void>>();
  replaceChildren(...nodes: FakeElement[]): void { this.children = nodes; }
  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  focusCalls = 0;
  focus(): void { this.focusCalls += 1; }
  setAttribute(): void { /* not needed here */ }
  addEventListener(name: string, handler: () => void): void {
    this.listeners.set(name, (this.listeners.get(name) ?? new Set()).add(handler));
  }
  removeEventListener(name: string, handler: () => void): void { this.listeners.get(name)?.delete(handler); }
  listenerCount(name: string): number { return this.listeners.get(name)?.size ?? 0; }
  dispatch(name: string): void { for (const handler of [...(this.listeners.get(name) ?? [])]) handler(); }
  click(): void {
    if (this.disabled) return; // a disabled button takes no click, as in a browser
    this.onclick?.();
    this.dispatch("click");
  }
}

class FakeDialog extends FakeElement {
  open = false;
  returnValue = "";
  showModal(): void { this.open = true; }
  close(): void {
    if (!this.open) return;
    this.open = false;
    setTimeout(() => this.dispatch("close"), 0); // asynchronous, as in a browser
  }
}

interface DialogRequest {
  title: string;
  body: string;
  actions: Array<{ label: string; value: string }>;
  survivesLock?: boolean;
}
interface Dialogs {
  showDialog(options: DialogRequest): Promise<string>;
  abandonDialogs(): void;
  askConflict(details: { local: unknown; remote: unknown }): Promise<"keep-local" | "use-remote">;
  prepareOnce<T>(action: string, work: () => Promise<T>): Promise<{ value: T } | null>;
  manageSecurity(): Promise<void>;
  showMoreMenu(): Promise<void>;
}

/** The parts of the app the passkeys-and-sessions screen touches. */
function appStubs() {
  let releaseLists!: () => void;
  const lists = new Promise<void>((resolve) => { releaseLists = resolve; });
  let releaseKept!: () => void;
  let keptHeld: Promise<void> | null = null;
  let releaseRotation!: (key: string) => void;
  const log: string[] = [];
  const unlocked = { credentialId: "c1", accountId: "a", keyVersion: 1, vaultKey: new Uint8Array(32) };
  const state = {
    unlocked: unlocked as typeof unlocked | null,
    sessionGeneration: 1,
    bridge: null as { lock(): void } | null,
  };
  const api = {
    credentials: async () => { await lists; return { credentials: [{ credentialId: "c1", status: "active", createdAt: 0 }] }; },
    sessions: async () => { await lists; return { sessions: [{ sid: "s1", isCurrent: true, createdAt: 0 }] }; },
    endSession: async () => { log.push("api.endSession"); },
  };
  return {
    state, api, releaseLists, log, toasts: [] as string[],
    /** The device-keep read the menu makes before it opens; held when asked to. */
    holdKept(): void { keptHeld = new Promise<void>((resolve) => { releaseKept = resolve; }); },
    releaseKept: (): void => releaseKept(),
    loadKeptVaultKey: async () => { if (keptHeld) await keptHeld; return null; },
    rotateRecoveryKey: () => new Promise<string>((resolve) => { log.push("rotation sent"); releaseRotation = resolve; }),
    releaseRotation: (key: string): void => releaseRotation(key),
    clearAccountDrafts: async () => { log.push("drafts cleared"); },
    forgetKeptVaultKey: async () => undefined,
    reload: (): void => { log.push("reload"); },
  };
}

function harness(Queue: typeof SerialQueue = SerialQueue) {
  const app = appStubs();
  const elements = {
    dialog: new FakeDialog(),
    dialogTitle: new FakeElement(),
    dialogBody: new FakeElement(),
    dialogActions: new FakeElement(),
    dialogClose: new FakeElement(),
  };
  const fakeDocument = { createElement: () => new FakeElement() };
  const dialogs = new Function(
    "elements", "SerialQueue", "document", "window", "buttonClass", "menuItem", "t", "serializeDocument",
    "DIALOG_INPUT_GUARD_MS", "performance", "state", "api", "toast", "localeTag", "performStepUp",
    "loadKeptVaultKey", "rotateRecoveryKey", "clearAccountDrafts", "forgetKeptVaultKey", "serviceWorkerBridge",
    "mediaReady", "setToolButton", "downloadText", "RECOVERY_HELP", "navigator", "lockVaultForget",
    code,
  )(
    elements, Queue, fakeDocument,
    {
      document: fakeDocument,
      setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
      location: { reload: app.reload },
    },
    () => "button", () => new FakeElement(), (text: string) => text, (value: unknown) => JSON.stringify(value),
    GUARD_MS, performance, app.state, app.api, (message: string) => { app.toasts.push(message); }, () => "ja-JP", async () => undefined,
    app.loadKeptVaultKey, app.rotateRecoveryKey, app.clearAccountDrafts, app.forgetKeptVaultKey, null,
    Promise.resolve(true), () => undefined, () => undefined, "help", {}, () => lock(),
  ) as Dialogs;
  /** What lockVault does that matters here. */
  const lock = (): void => {
    app.state.unlocked = null;
    app.state.sessionGeneration += 1;
    dialogs.abandonDialogs();
  };
  return {
    ...dialogs,
    elements,
    app,
    lock,
    shown: (): string => (elements.dialog.open ? elements.dialogTitle.textContent : ""),
    press(value: string): void {
      const button = elements.dialogActions.children.find((child) => child.dataset.value === value);
      if (!button) throw new Error(`no button ${value} in "${elements.dialogTitle.textContent}"`);
      button.click();
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
/** Long enough for a dialog that opened right after an answer to take input. */
const guard = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, GUARD_MS + 30));
const conflict = { title: "競合しています", body: "この端末の内容…", actions: [{ label: "編集して保存", value: "keep-local" }, { label: "サーバーの内容を使う", value: "use-remote" }] };
const security = { title: "パスキーとセッション", body: "…", actions: [{ label: "閉じる", value: "close" }] };
const menu = { title: "その他", body: "…", actions: [{ label: "今すぐロック", value: "lock-now" }, { label: "閉じる", value: "close" }] };
const gate = { title: "以前より古い内容です", body: "…", actions: [{ label: "もう一度試す", value: "retry" }] };

describe("the shared dialog", () => {
  it("spec: a question requested while another is open waits for its answer instead of replacing it", async () => {
    const h = harness();
    const answers: string[] = [];
    void h.showDialog(conflict).then((value) => answers.push(`conflict:${value}`));
    await settle();
    expect(h.shown()).toBe("競合しています");

    // The security screen finishes loading its lists and asks for the dialog.
    void h.showDialog(security).then((value) => answers.push(`security:${value}`));
    await settle();
    expect(h.shown()).toBe("競合しています"); // the question is still there, with its buttons
    h.press("keep-local");
    await settle();
    expect(answers).toEqual(["conflict:keep-local"]);

    // Only now does the second dialog open.
    expect(h.shown()).toBe("パスキーとセッション");
    await guard();
    h.press("close");
    await settle();
    expect(answers).toEqual(["conflict:keep-local", "security:close"]);
    expect(h.elements.dialog.open).toBe(false);
  });

  it("spec: three requests are answered in the order they were made", async () => {
    const h = harness();
    const answers: string[] = [];
    for (const title of ["one", "two", "three"]) {
      void h.showDialog({ title, body: "…", actions: [{ label: "OK", value: title }] }).then((value) => answers.push(value));
    }
    for (const title of ["one", "two", "three"]) {
      await guard();
      expect(h.shown()).toBe(title);
      h.press(title);
    }
    await settle();
    expect(answers).toEqual(["one", "two", "three"]);
  });

  it("spec: a question abandoned by a lock neither gets an answer nor holds up the dialogs of the gate", async () => {
    const h = harness();
    const answers: string[] = [];
    void h.showDialog(conflict).then((value) => answers.push(`conflict:${value}`));
    void h.showDialog(security).then((value) => answers.push(`security:${value}`));
    await settle();
    expect(h.shown()).toBe("競合しています");

    h.abandonDialogs(); // the vault is locked: nothing shown while unlocked stays
    await settle();
    expect(h.elements.dialog.open).toBe(false);
    expect(h.elements.dialogBody.children).toEqual([]);
    // The abandoned question's handlers went with it: they held its content.
    expect(h.elements.dialog.listenerCount("close")).toBe(0);
    expect(h.elements.dialogClose.onclick).toBeNull();

    void h.showDialog(gate).then((value) => answers.push(`gate:${value}`));
    await settle();
    expect(h.shown()).toBe("以前より古い内容です");
    h.press("retry");
    await settle();
    // The abandoned questions were never answered, and the one that was
    // waiting behind the conflict never opened.
    expect(answers).toEqual(["gate:retry"]);
    expect(h.elements.dialog.open).toBe(false);
  });

  it("spec: locking from the menu discards the question that was waiting behind the menu", async () => {
    const h = harness();
    const answers: string[] = [];
    // The menu flow of main.ts: the lock runs in the continuation of the answer.
    const menuFlow = async (): Promise<void> => {
      const decision = await h.showDialog(menu);
      if (decision === "lock-now") h.abandonDialogs();
    };
    void menuFlow();
    // A save is refused while the menu is open: the conflict waits its turn.
    void h.showDialog(conflict).then((value) => answers.push(`conflict:${value}`));
    await settle();
    expect(h.shown()).toBe("その他");

    h.press("lock-now");
    await settle();
    // Locked: no dialog of the session opens over the gate, least of all one
    // that shows the document.
    expect.soft(h.shown()).toBe("");
    expect.soft(h.elements.dialogBody.children).toEqual([]);
    expect.soft(answers).toEqual([]);

    void h.showDialog(gate).then((value) => answers.push(`gate:${value}`));
    await guard();
    expect(h.shown()).toBe("以前より古い内容です");
    h.press("retry");
    await settle();
    expect(answers).toEqual(["gate:retry"]);
  });

  it("spec: a rotated recovery key that was waiting behind the menu is still shown after the lock", async () => {
    const h = harness();
    const answers: string[] = [];
    const menuFlow = async (): Promise<void> => {
      const decision = await h.showDialog(menu);
      if (decision === "lock-now") h.abandonDialogs();
    };
    void menuFlow();
    void h.showDialog(security).then((value) => answers.push(`security:${value}`));
    // The rotation finished while the menu was open: the old key is gone.
    void h.showDialog({ title: "復旧キーを保存してください", body: "NEW-KEY", actions: [{ label: "保存しました", value: "confirm" }], survivesLock: true })
      .then((value) => answers.push(`recovery:${value}`));
    await settle();
    h.press("lock-now");
    await guard();
    expect(h.shown()).toBe("復旧キーを保存してください");
    h.press("confirm");
    await settle();
    expect(answers).toEqual(["recovery:confirm"]);
    expect(h.elements.dialog.open).toBe(false);
  });

  it("spec: closing the conflict question without choosing is not a choice — it is asked again", async () => {
    const h = harness();
    let decision = "";
    void h.askConflict({ local: { text: "mine" }, remote: { text: "theirs" } }).then((value) => { decision = value; });
    await settle();
    expect(h.shown()).toBe("競合しています");
    h.elements.dialog.close(); // Escape, or the Back gesture
    await guard();
    expect.soft(decision).toBe("");
    expect(h.shown()).toBe("競合しています");
    // Both copies are still there to compare.
    expect(JSON.stringify(h.elements.dialogBody.children.map((node) => node.children.map((child) => child.textContent)))).toContain("theirs");
    h.press("use-remote");
    await settle();
    expect(decision).toBe("use-remote");
    expect(h.elements.dialog.open).toBe(false);
  });

  it("spec: a question that opens the moment another dialog was answered takes no input for a moment", async () => {
    // The second click of a double click, or a key still held, belongs to the
    // dialog that was just answered — not to the conflict question that takes
    // its place in the same instant, whose buttons discard one copy or the other.
    const h = harness();
    let decision = "";
    void h.showDialog(menu);
    void h.showDialog(conflict).then((value) => { decision = value; });
    await settle();
    h.press("close");
    await settle();
    expect(h.shown()).toBe("競合しています");
    h.press("use-remote"); // lands on the new dialog at once
    await settle();
    expect.soft(decision).toBe("");
    expect.soft(h.shown()).toBe("競合しています");
    // Escape in that moment does not answer it either: it is shown again.
    h.elements.dialog.close();
    await settle();
    expect.soft(decision).toBe("");
    expect.soft(h.shown()).toBe("競合しています");
    await guard();
    // No button is given the focus when the moment is over: a key that is
    // still held down must not find one.
    expect.soft(h.elements.dialogActions.children.map((button) => button.focusCalls)).toEqual([0, 0]);
    h.press("use-remote"); // a deliberate answer
    await settle();
    expect(decision).toBe("use-remote");
  });

  it("spec: a dialog that opens on its own, with nothing answered just before, takes input at once", async () => {
    const h = harness();
    let decision = "";
    void h.showDialog(conflict).then((value) => { decision = value; });
    h.press("keep-local");
    await settle();
    expect(decision).toBe("keep-local");
  });

  it("spec: the passkey list of a session that was locked while it loaded does not open over the gate", async () => {
    const h = harness();
    void h.manageSecurity();
    await settle();
    // Locked while the lists are on their way.
    h.app.state.unlocked = null;
    h.app.state.sessionGeneration += 1;
    h.abandonDialogs();
    h.app.releaseLists();
    await settle();
    expect(h.shown()).toBe("");
    expect(h.elements.dialogBody.children).toEqual([]);
  });

  it("spec: the menu of a session that was locked while it was opening does not open over the gate", async () => {
    const h = harness();
    h.app.holdKept();
    void h.showMoreMenu();
    await settle();
    h.lock();
    h.app.releaseKept();
    await settle();
    expect(h.shown()).toBe("");
  });

  it("spec: ending the session waits for a recovery key that is still being rotated, and for it to be confirmed", async () => {
    const h = harness();
    void h.showMoreMenu();
    await settle();
    h.press("rotate-recovery"); // the request is on its way; nothing is on screen
    await guard();
    expect(h.app.log).toEqual(["rotation sent"]);
    void h.showMoreMenu(); // the user opens the menu again…
    await guard();
    expect(h.shown()).toBe("その他");
    h.press("end-session"); // …and ends the session before the answer arrives
    await guard();
    // The server may already have replaced the old key: nothing is ended and
    // nothing is reloaded until the new one has been shown and answered.
    expect(h.app.log).toEqual(["rotation sent"]);
    h.app.releaseRotation("NEW-KEY");
    await guard();
    expect(h.shown()).toBe("復旧キーを保存してください");
    expect(h.app.log).toEqual(["rotation sent"]);
    h.press("confirm");
    await settle();
    expect(h.app.log).toEqual(["rotation sent", "api.endSession", "drafts cleared", "reload"]);
  });

  it("spec: ending the session with nothing pending is not held up", async () => {
    const h = harness();
    void h.showMoreMenu();
    await settle();
    h.press("end-session");
    await settle();
    expect(h.app.log).toEqual(["api.endSession", "drafts cleared", "reload"]);
  });

  it("spec: the passkey list opens for the session that asked for it", async () => {
    const h = harness();
    void h.manageSecurity();
    h.app.releaseLists();
    await settle();
    expect(h.shown()).toBe("パスキーとセッション");
    h.press("close");
    await settle();
    expect(h.elements.dialog.open).toBe(false);
  });

  it("spec: an action asked for again while it is still preparing its dialog is ignored", async () => {
    const h = harness();
    let releaseLists!: (value: string) => void;
    let reads = 0;
    const readLists = (): Promise<string> => new Promise((resolve) => { reads += 1; releaseLists = resolve; });
    const first = h.prepareOnce("security", readLists);
    const second = h.prepareOnce("security", readLists); // chosen again from the menu
    const other = h.prepareOnce("menu", async () => "kept"); // a different action is not held up
    await expect(second).resolves.toBeNull();
    await expect(other).resolves.toEqual({ value: "kept" });
    expect(reads).toBe(1);
    releaseLists("lists");
    await expect(first).resolves.toEqual({ value: "lists" });
    // Once its dialog has been requested, the action can be asked for again —
    // also after a failure.
    await expect(h.prepareOnce("security", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await expect(h.prepareOnce("security", async () => "again")).resolves.toEqual({ value: "again" });
  });
});

describe("SerialQueue", () => {
  it("runs one job at a time, in order, and keeps going after a failure", async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    let release!: () => void;
    const first = queue.run(() => new Promise<string>((resolve) => { log.push("first starts"); release = () => resolve("a"); }));
    const second = queue.run(async () => { log.push("second starts"); throw new Error("boom"); });
    const third = queue.run(() => { log.push("third starts"); throw new Error("thrown before any promise"); });
    const fourth = queue.run(async () => { log.push("fourth starts"); return "d"; });
    await settle();
    expect(log).toEqual(["first starts"]);
    release();
    await expect(first).resolves.toBe("a");
    await expect(second).rejects.toThrow("boom");
    await expect(third).rejects.toThrow("thrown before any promise");
    await expect(fourth).resolves.toBe("d");
    expect(log).toEqual(["first starts", "second starts", "third starts", "fourth starts"]);
  });

  it("after a reset, neither the running job nor the ones waiting behind it hold up or precede later jobs", async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    void queue.run(() => new Promise<void>(() => { log.push("stuck"); }));
    void queue.run(async () => { log.push("was waiting behind it"); });
    await settle();
    queue.reset();
    await expect(queue.run(async () => "later")).resolves.toBe("later");
    await settle();
    expect(log).toEqual(["stuck"]);
  });

  it("a reset made in the continuation of an answered job still discards what was waiting", async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    let answer!: (value: string) => void;
    const flow = async (): Promise<void> => {
      const value = await queue.run(() => new Promise<string>((resolve) => { answer = resolve; }));
      if (value === "lock") queue.reset();
    };
    void flow();
    void queue.run(async () => { log.push("waiting job started"); });
    answer("lock");
    await settle();
    expect(log).toEqual([]);
  });

  it("whenIdle resolves once nothing is running or waiting — after the dialogs still due were answered", async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    let answerFirst!: () => void;
    let answerSecond!: () => void;
    void queue.run(() => new Promise<void>((resolve) => { answerFirst = resolve; }));
    void queue.run(() => new Promise<void>((resolve) => { answerSecond = resolve; }));
    void queue.whenIdle().then(() => log.push("idle"));
    await settle();
    answerFirst();
    await settle();
    expect(log).toEqual([]);
    answerSecond();
    await settle();
    expect(log).toEqual(["idle"]);
    await expect(queue.whenIdle()).resolves.toBeUndefined(); // already idle
    // An abandoned job does not keep it waiting for ever.
    void queue.run(() => new Promise<void>(() => undefined));
    const afterReset = queue.whenIdle().then(() => "idle again");
    queue.reset();
    await expect(afterReset).resolves.toBe("idle again");
  });

  it("a job marked keepOnReset still runs after a reset, in its turn", async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    void queue.run(() => new Promise<void>(() => { log.push("stuck"); }));
    void queue.run(async () => { log.push("dropped"); });
    const kept = queue.run(async () => { log.push("kept"); return "k"; }, { keepOnReset: true });
    queue.reset();
    const later = queue.run(async () => { log.push("later"); return "l"; });
    await expect(kept).resolves.toBe("k");
    await expect(later).resolves.toBe("l");
    expect(log).toEqual(["stuck", "kept", "later"]);
  });
});
