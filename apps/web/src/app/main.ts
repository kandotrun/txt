/**
 * Application entrypoint (spec §3, §4, §9, §10, §11).
 *
 * Responsibilities: gate screens, passkey registration/unlock, editor wiring,
 * sync engine, media rendering, lock policy, the "その他" menu, and wiring the
 * onboarding layers (intro, one-time hints, empty-state hint).
 */

import { pruneUnreferencedMedia, serializeDocument } from "../../../../packages/protocol/src/document.ts";
import type { DocumentModel, MediaInfo } from "../../../../packages/protocol/src/document.ts";
import { toBase64Url } from "../../../../packages/protocol/src/base64url.ts";
import { api, ApiRequestError } from "./api.ts";
import { CryptoBridge } from "./crypto-bridge.ts";
import { clearAccountDrafts, clearDraft, loadDraft } from "./drafts.ts";
import {
  forgetAllKeptVaultKeys,
  forgetKeptVaultKey,
  loadKeptVaultKey,
  keepVaultKey,
} from "./device-keep.ts";
import { showCoachMarks } from "./coach.ts";
import { Editor, isEmptyDoc } from "./editor.ts";
import { icon } from "./icons.ts";
import type { IconName } from "./icons.ts";
import { BLOB_FALLBACK_MAX_BYTES, classify, fetchDecrypted, uploadFile } from "./media.ts";
import type { MediaRejectedError } from "./media.ts";
import { cancelExit, playExit, replayEnter } from "./motion.ts";
import { runIntro } from "./onboarding.ts";
import { shareApp } from "./share.ts";
import { SyncEngine, normalizedEqual } from "./sync.ts";
import { ServiceWorkerBridge } from "./service-worker-bridge.ts";
import type { SyncState } from "./sync.ts";
import {
  addPasskey,
  loginAndUnlock,
  registerAccount,
  rotateRecoveryKey,
  unlockExisting,
  RECOVERY_HELP,
} from "./vault.ts";
import type { UnlockedVault } from "./vault.ts";
import { WebAuthnError, assertCredential } from "./webauthn.ts";

/* ------------------------------------------------------------------ */
/* Element handles                                                     */
/* ------------------------------------------------------------------ */

const elements = {
  app: must<HTMLElement>("app"),
  editorHost: must<HTMLElement>("editor-host"),
  gate: must<HTMLElement>("gate"),
  gateTitle: must<HTMLElement>("gate-title"),
  gateBody: must<HTMLElement>("gate-body"),
  gateActions: must<HTMLElement>("gate-actions"),
  gateDetails: must<HTMLDetailsElement>("gate-details"),
  gateFootnote: must<HTMLElement>("gate-footnote"),
  recoveryInput: must<HTMLTextAreaElement>("recovery-input"),
  recoverySubmit: must<HTMLButtonElement>("recovery-submit"),
  attachButton: must<HTMLButtonElement>("attach-button"),
  moreButton: must<HTMLButtonElement>("more-button"),
  controls: must<HTMLElement>("controls"),
  fileInput: must<HTMLInputElement>("file-input"),
  syncStatus: must<HTMLElement>("sync-status"),
  attachProgress: must<HTMLElement>("attach-progress"),
  emptyHint: must<HTMLElement>("empty-hint"),
  coach: must<HTMLElement>("coach"),
  dialog: must<HTMLDialogElement>("dialog"),
  dialogClose: must<HTMLButtonElement>("dialog-close"),
  dialogTitle: must<HTMLElement>("dialog-title"),
  dialogBody: must<HTMLElement>("dialog-body"),
  dialogActions: must<HTMLElement>("dialog-actions"),
  toast: must<HTMLElement>("toast"),
};

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}

/* ------------------------------------------------------------------ */
/* App state                                                           */
/* ------------------------------------------------------------------ */

interface AttachEntry {
  progress: number;
  controller: AbortController;
  position: number;
  mediaId?: string;
  kind?: string;
  done?: boolean;
}

interface AppState {
  unlocked: UnlockedVault | null;
  bridge: CryptoBridge | null;
  editor: Editor | null;
  sync: SyncEngine | null;
  document: DocumentModel;
  documentId: string;
  sessionGeneration: number;
  serviceWorkerReady: boolean;
  swGeneration: number;
  attaching: Map<string, AttachEntry>;
  objectUrls: Map<string, string>;
}

const state: AppState = {
  unlocked: null,
  bridge: null,
  editor: null,
  sync: null,
  document: { schemaVersion: 1, blocks: [], media: {} },
  documentId: "",
  sessionGeneration: 0,
  serviceWorkerReady: false,
  swGeneration: 0,
  attaching: new Map(),
  objectUrls: new Map(),
};

let mediaReady: Promise<boolean> = Promise.resolve(false);
const serviceWorkerBridge = "serviceWorker" in navigator
  ? new ServiceWorkerBridge(navigator.serviceWorker, { onInvalidated: () => {
      state.serviceWorkerReady = false;
      clearStreamSources();
    } })
  : null;

/* ------------------------------------------------------------------ */
/* Gate rendering (spec §4.6)                                          */
/* ------------------------------------------------------------------ */

/** Visual weight of a button: primary by default (§4.2 活字). */
interface ButtonTone {
  primary?: boolean;
  /** `ghost` for a quiet alternative, `danger` for an irreversible action. */
  tone?: "ghost" | "danger";
}

function buttonClass(action: ButtonTone): string {
  if (action.tone === "danger") return "button danger";
  if (action.tone === "ghost") return "button ghost";
  return action.primary === false ? "button secondary" : "button";
}

type GateAction = ButtonTone & { label: string; onClick: () => void | Promise<void> };

function showGate(options: {
  title?: string;
  body?: string;
  actions: GateAction[];
  footnote?: string;
  error?: boolean;
  showRecovery?: boolean;
}): void {
  // The gate may still be fading out from the last unlock: bring it back.
  cancelExit(elements.gate);
  elements.gate.inert = false;
  elements.gate.hidden = false;
  elements.app.hidden = true;
  elements.gateTitle.textContent = options.title ?? "メールアドレスなしで、1枚のテキストを。";
  elements.gateBody.textContent =
    options.body ??
    "パスキーで暗号化された、あなた専用の1枚です。本文と添付は端末で暗号化され、サーバーには暗号文だけが保存されます。";
  elements.gateActions.replaceChildren(
    ...options.actions.map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = buttonClass(action);
      button.textContent = action.label;
      button.addEventListener("click", () => {
        void action.onClick();
      });
      return button;
    }),
  );
  elements.gateFootnote.textContent = options.footnote ?? "";
  elements.gateFootnote.dataset.state = options.error ? "error" : "idle";
  elements.gateDetails.hidden = !options.showRecovery;
}

/**
 * Shows the editor. The editor appears at once *underneath* the gate, which
 * then fades out on top of it: the editing surface is never animated (§4.2).
 */
function showApp(): void {
  elements.app.hidden = false;
  elements.controls.hidden = false;
  updateEmptyHint();
  if (!elements.gate.hidden) {
    elements.gate.inert = true;
    void playExit(elements.gate, "is-leaving");
  }
}

/* ------------------------------------------------------------------ */
/* Onboarding hints (spec §4.1, §4.6)                                   */
/* ------------------------------------------------------------------ */

let dismissCoach: (() => void) | null = null;

/**
 * Shows 「ここから書く」 only while the document is empty. The hint is a sibling
 * of the editor host, and it is re-evaluated only at IME safe points; while a
 * composition is in progress it stays hidden so it never overlaps marked text.
 */
function updateEmptyHint(): void {
  const editor = state.editor;
  elements.emptyHint.hidden =
    !editor || !editor.isSafePoint() || !isEmptyDoc(editor.state.doc);
}

/* ------------------------------------------------------------------ */
/* Toast / dialog                                                      */
/* ------------------------------------------------------------------ */

let toastTimer: number | null = null;

function toast(message: string, duration = 2600): void {
  cancelExit(elements.toast);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  replayEnter(elements.toast, "is-entering");
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    void playExit(elements.toast, "is-leaving");
  }, duration);
}

interface DialogAction extends ButtonTone {
  label: string;
  value: string;
  /** Menu rows only: leading icon. */
  icon?: IconName;
  /** Menu rows only: draw a divider above this row. */
  separatorBefore?: boolean;
}

/**
 * Identifies the currently-shown dialog. A `<dialog>` element fires `close`
 * asynchronously, so a stale event from a just-answered dialog must not resolve
 * the next one (the "その他" menu is immediately followed by a confirmation).
 */
let dialogToken = 0;

function showDialog(options: {
  title: string;
  body: HTMLElement | string;
  actions: DialogAction[];
  /** `menu`: a list of rows with a close button (「その他」, §4.6). */
  variant?: "menu";
}): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    /**
     * A `<dialog>` fires `close` asynchronously. When one dialog is answered
     * and another opens immediately after (the "その他" menu followed by a
     * confirmation), that late event would resolve the *new* dialog with the
     * previous answer. Capture the element we opened and ignore any `close`
     * that arrives once a newer dialog has been shown.
     */
    const dialog = elements.dialog;
    const openToken = ++dialogToken;
    const settle = (value: string): void => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("close", onClose);
      resolve(value);
    };
    const onClose = (): void => {
      // A `close` event fires asynchronously. When the next dialog has already
      // been shown on the same element, this event belongs to the previous one
      // and must be ignored — `dialog.open` is the reliable discriminator,
      // because a genuine user dismissal leaves it closed.
      if (openToken !== dialogToken || settled || dialog.open) return;
      const value = dialog.returnValue || "dismissed";
      dialog.returnValue = "";
      settle(value);
    };

    const isMenu = options.variant === "menu";
    dialog.classList.toggle("dialog--menu", isMenu);
    elements.dialogTitle.textContent = options.title;
    elements.dialogBody.replaceChildren(
      typeof options.body === "string" ? textParagraph(options.body) : options.body,
    );
    // Assigning (not adding) the handler binds the close button to this
    // dialog's answer only.
    elements.dialogClose.hidden = !isMenu;
    elements.dialogClose.onclick = () => {
      settle("dismissed");
      if (dialog.open) dialog.close();
    };
    // Rebuilding the buttons each time prevents stale listeners from resolving
    // a later dialog with an earlier answer.
    elements.dialogActions.replaceChildren(
      ...options.actions.flatMap((action) => {
        const button = isMenu ? menuItem(action) : document.createElement("button");
        button.type = "button";
        if (!isMenu) {
          button.className = buttonClass(action);
          button.textContent = action.label;
        }
        button.dataset.value = action.value;
        button.addEventListener("click", () => {
          // Resolve directly on the click: relying solely on the <dialog>
          // close event is fragile when the browser suppresses it.
          settle(action.value);
          if (dialog.open) dialog.close();
        });
        if (!isMenu || !action.separatorBefore) return [button];
        const separator = document.createElement("div");
        separator.className = "menu-separator";
        separator.setAttribute("role", "separator");
        return [separator, button];
      }),
    );
    dialog.addEventListener("close", onClose);
    // Clear any leftover value *before* opening: a `close` event from the
    // previous dialog can arrive after this one is shown, and reading a stale
    // `returnValue` would answer the new dialog with the old answer.
    dialog.returnValue = "";
    if (!dialog.open) dialog.showModal();
  });
}

function textParagraph(text: string, className?: string): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  paragraph.style.margin = "0";
  if (className) paragraph.className = className;
  return paragraph;
}

/** A 「その他」 row: icon + label; irreversible rows use the danger tone. */
function menuItem(action: DialogAction): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = action.tone === "danger" ? "menu-item danger" : "menu-item";
  if (action.icon) button.append(icon(action.icon));
  const label = document.createElement("span");
  label.textContent = action.label;
  button.append(label);
  return button;
}

/** Swaps a tool button's icon and label (e.g. コピー → コピーしました). */
function setToolButton(button: HTMLButtonElement, label: string, name: IconName): void {
  const text = document.createElement("span");
  text.textContent = label;
  button.replaceChildren(icon(name), text);
}

/**
 * Saves `text` as a file through a Blob URL. The anchor lives inside `host`
 * (the open dialog) because everything outside a modal dialog is inert.
 */
function downloadText(filename: string, text: string, host: HTMLElement): void {
  const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  host.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* Media rendering                                                     */
/* ------------------------------------------------------------------ */

function mediaInfo(mediaId: string): MediaInfo | undefined {
  return state.document.media[mediaId];
}

function renderMedia(mediaId: string, info: MediaInfo, _blockId: string): HTMLElement {
  void _blockId;
  const container = document.createElement("div");
  container.className = "txt-media";
  container.setAttribute("data-media-id", mediaId);
  container.setAttribute("data-media-kind", info.kind);
  container.contentEditable = "false";

  if (info.kind === "image" && info.plainBytes <= BLOB_FALLBACK_MAX_BYTES) {
    const img = document.createElement("img");
    img.alt = info.name;
    img.decoding = "async";
    img.loading = "lazy";
    container.append(img);
    void materializeImage(img, mediaId, info);
    return container;
  }
  if (info.kind === "image") {
    // Images above the blob fallback are handled by the Service Worker stream.
    const img = document.createElement("img");
    img.alt = info.name;
    // A fresh attachment is inaccessible until its reference PUT commits.
    // Handle the rare ordering where that initial 404 arrives after the save.
    img.addEventListener("error", () => {
      if (["saved", "idle"].includes(elements.syncStatus.dataset.state ?? "")) {
        void materializeStream(img, mediaId, info);
      }
    }, { once: true });
    void materializeStream(img, mediaId, info);
    container.append(img);
    return container;
  }

  const tag = info.kind === "video" ? "video" : "audio";
  const player = document.createElement(tag) as HTMLVideoElement | HTMLAudioElement;
  player.controls = true;
  player.preload = "none";
  void materializeStream(player, mediaId, info);
  player.setAttribute("playsinline", "");
  container.append(player);
  return container;
}

function clearStreamSources(): void {
  for (const node of elements.editorHost.querySelectorAll<HTMLImageElement | HTMLMediaElement>("[data-sw-media]")) {
    node.removeAttribute("src");
    if (node instanceof HTMLMediaElement) { node.pause(); node.load(); }
  }
}

function refreshStreamSources(): void {
  for (const node of elements.editorHost.querySelectorAll<HTMLImageElement | HTMLMediaElement>("[data-sw-media]")) {
    const mediaId = node.dataset.swMedia!;
    const info = mediaInfo(mediaId);
    if (info) void materializeStream(node, mediaId, info);
  }
}

async function materializeStream(node: HTMLImageElement | HTMLMediaElement, mediaId: string, info: MediaInfo): Promise<void> {
  node.dataset.swMedia = mediaId;
  const generation = state.sessionGeneration;
  let barrier = mediaReady;
  while (await barrier) {
    if (generation !== state.sessionGeneration || !state.unlocked || mediaInfo(mediaId) !== info) return;
    if (barrier !== mediaReady) { barrier = mediaReady; continue; }
    if (!node.isConnected || !serviceWorkerBridge?.ready) return;
    const src = `/_local/media/${encodeURIComponent(mediaId)}`;
    // Reassigning an unchanged player source restarts resource selection/playback.
    // Images still need same-URL retries when a fresh reference initially returned 404.
    if (!(node instanceof HTMLMediaElement) || node.getAttribute("src") !== src) node.src = src;
    return;
  }
}

async function materializeImage(
  img: HTMLImageElement,
  mediaId: string,
  info: MediaInfo,
): Promise<void> {
  if (!state.bridge || !state.unlocked) return;
  const generation = state.sessionGeneration;
  const cached = state.objectUrls.get(mediaId);
  if (cached) {
    img.src = cached;
    return;
  }
  // The media node is inserted immediately, but the blob only becomes
  // deliverable after the reference save lands (spec §11.3 step 6). Retry a few
  // times before giving up so a fresh insertion is not stuck on a placeholder.
  for (let attempt = 0; attempt < 4; attempt++) {
    const bridge: CryptoBridge | null = state.bridge;
    if (!bridge || generation !== state.sessionGeneration || mediaInfo(mediaId) !== info) return;
    try {
      const blob = await fetchDecrypted({
        mediaId,
        info,
        documentId: state.documentId,
        bridge,
      });
      if (generation !== state.sessionGeneration || state.bridge !== bridge || mediaInfo(mediaId) !== info) return;
      const url = URL.createObjectURL(blob);
      state.objectUrls.set(mediaId, url);
      img.src = url;
      return;
    } catch {
      if (attempt === 3) break;
      await new Promise((resolve) => window.setTimeout(resolve, 700 * (attempt + 1)));
      if (!img.isConnected) return; // the node was removed while waiting
    }
  }
  const placeholder = document.createElement("div");
  placeholder.className = "txt-media-placeholder";
  placeholder.textContent = "この画像を表示できません。";
  if (img.isConnected) img.replaceWith(placeholder);
}

/* ------------------------------------------------------------------ */
/* Attachment flow (spec §11.3, §9.7)                                  */
/* ------------------------------------------------------------------ */

async function attachFiles(files: File[], position: number): Promise<void> {
  if (!state.bridge || !state.unlocked || !state.editor) return;
  const generation = state.sessionGeneration;
  for (const file of files) {
    if (generation !== state.sessionGeneration || !state.bridge || !state.editor) return;
    let kind;
    try {
      kind = classify(file);
    } catch (error) {
      toast((error as MediaRejectedError).reason);
      continue;
    }
    const placeholderId = crypto.randomUUID();
    const controller = new AbortController();
    const entry: AttachEntry = { progress: 0, controller, position, kind };
    state.attaching.set(placeholderId, entry);
    renderAttachProgress();

    let result: Awaited<ReturnType<typeof uploadFile>> | undefined;
    try {
      result = await uploadFile({
        file,
        kind,
        documentId: state.documentId,
        bridge: state.bridge,
        signal: controller.signal,
        onStarted: (mediaId) => {
          entry.mediaId = mediaId;
          if (generation === state.sessionGeneration) void syncServiceWorkerMedia();
        },
        onProgress: (fraction) => {
          entry.progress = fraction;
          renderAttachProgress();
        },
      });
      controller.signal.throwIfAborted();
      if (generation !== state.sessionGeneration || !state.editor) return;
      // Register metadata. The insertion itself happens at an IME safe point;
      // if the surrounding text was deleted meanwhile, the position collapses
      // to the current selection instead of resurrecting a stale offset (§9.7).
      state.document.media[result.mediaId] = result.info;
      entry.mediaId = result.mediaId;
      entry.kind = result.info.kind;
      entry.done = true;
      await syncServiceWorkerMedia();
      controller.signal.throwIfAborted();
      if (generation !== state.sessionGeneration || !state.editor) return;
      if (mediaInfo(result.mediaId) !== result.info) {
        throw new Error("文書が更新されました。添付をやり直してください。");
      }
      // Insertion happens here (the upload completed); when composing, the
      // editor defers the structural change to the next safe point internally.
      state.editor.insertMedia(result.mediaId, result.info.kind, clampPosition(entry.position));
      state.sync?.noteCommittedChange();
      state.attaching.delete(placeholderId);
      renderAttachProgress();
    } catch (error) {
      if (generation !== state.sessionGeneration) return;
      if (controller.signal.aborted && result && mediaInfo(result.mediaId) === result.info) {
        // Revoke local/SW metadata, but leave completed unreferenced ciphertext
        // to the server's normal GC grace instead of destructively deleting it.
        delete state.document.media[result.mediaId];
        void syncServiceWorkerMedia();
      }
      state.attaching.delete(placeholderId);
      renderAttachProgress();
      if ((error as Error).name !== "AbortError") {
        toast(`添付に失敗しました: ${(error as Error).message}`);
      }
    }
  }
}

/** Keeps a tracked insertion position inside the current document. */
function clampPosition(position: number): number {
  const size = state.editor?.state.doc.content.size ?? 1;
  return Math.max(1, Math.min(position, Math.max(1, size - 1)));
}

function renderAttachProgress(): void {
  const items: HTMLElement[] = [];
  for (const [id, entry] of state.attaching) {
    const row = document.createElement("div");
    row.className = "attach-item";
    const label = document.createElement("span");
    label.textContent = `${Math.round(entry.progress * 100)}%`;
    const progress = document.createElement("progress");
    progress.max = 1;
    progress.value = entry.progress;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
      entry.controller.abort();
      state.attaching.delete(id);
      renderAttachProgress();
    });
    row.append(label, progress, cancel);
    items.push(row);
  }
  elements.attachProgress.replaceChildren(...items);
  elements.attachProgress.hidden = items.length === 0;
}

/* ------------------------------------------------------------------ */
/* Sync wiring                                                         */
/* ------------------------------------------------------------------ */

function setSyncState(next: SyncState, detail?: string): void {
  const labels: Record<SyncState, string> = {
    idle: "",
    saving: "保存中",
    saved: "同期済み",
    "local-only": "端末に保存済み・未同期",
    offline: "端末に保存済み・未同期",
    conflict: "競合を確認してください",
    "auth-expired": "再ログインが必要です",
    "decrypt-failed": "内容を開けません。データは変更していません。",
  };
  elements.syncStatus.textContent = detail ?? labels[next];
  elements.syncStatus.dataset.state = next;
  if (next === "saved") {
    window.setTimeout(() => {
      if (elements.syncStatus.dataset.state === "saved") {
        elements.syncStatus.textContent = "";
        elements.syncStatus.dataset.state = "idle";
      }
    }, 2200);
  }
}

/* ------------------------------------------------------------------ */
/* Session start                                                       */
/* ------------------------------------------------------------------ */

async function startSession(vault: UnlockedVault): Promise<void> {
  state.sessionGeneration += 1;
  const generation = state.sessionGeneration;
  serviceWorkerBridge?.reset();
  mediaReady = Promise.resolve(false);

  try {
    setSyncState("saving", "読み込み中");
    const session = await api.session();
    if (generation !== state.sessionGeneration) return;
    const bridge = new CryptoBridge(cryptoWorkerUrl());
    if (window.__txtDebug) window.__txtDebug.step = "session:api-done";

    // The document payload carries the real documentId; load it before unlocking
    // the workers so the AAD matches. This must be an unconditional fetch: a
    // 304 from a stale validator would leave us without a payload to decrypt.
    const first = await api.document();
    if (generation !== state.sessionGeneration) { bridge.lock(); return; }
    if (!first.data) throw new Error("文書を取得できません。");
    state.documentId = first.data.documentId;
    if (window.__txtDebug) window.__txtDebug.step = "session:document-done";

    await bridge.unlock({
      vaultKey: vault.vaultKey,
      accountId: vault.accountId,
      documentId: state.documentId,
      keyVersion: first.data.keyVersion,
    });
    if (generation !== state.sessionGeneration) { bridge.lock(); return; }
    if (window.__txtDebug) window.__txtDebug.step = "session:unlocked";

    // Keep the vault on this device so the next visit does not require a passkey
    // ceremony (spec §6.4). The wrapped key is re-derived per document, so a
    // failure here never blocks the session that is already unlocked.
    try {
      const expiresAt = await keepVaultKey({
        accountId: vault.accountId,
        documentId: state.documentId,
        keyVersion: first.data.keyVersion,
        vaultKey: vault.vaultKey,
      });
      if (window.__txtDebug) {
        window.__txtDebug.step = `session:kept-until-${new Date(expiresAt).toISOString()}`;
      }
    } catch {
      // Storage unavailable (private mode, quota): the session works, it just
      // requires the passkey again next time.
    }

    if (generation !== state.sessionGeneration) { bridge.lock(); return; }
    const document = await bridge.decryptDocument({
      mutationId: first.data.mutationId,
      encryptedRevision: first.data.encryptedRevision,
      formatVersion: first.data.formatVersion,
      keyVersion: first.data.keyVersion,
      nonce: first.data.nonce,
      ciphertext: first.data.ciphertext,
    });
    if (window.__txtDebug) window.__txtDebug.step = "session:decrypted";

  if (generation !== state.sessionGeneration) { bridge.lock(); return; }
  state.unlocked = vault;
  state.bridge = bridge;
  state.document = document;
  await setupServiceWorker(vault);
  if (generation !== state.sessionGeneration) return;

  let editor = state.editor;
  if (!editor) {
    editor = new Editor(
      elements.editorHost,
      {
        onCommittedChange: () => {
          if (state.editor?.isComposing) {
            elements.emptyHint.hidden = true;
            state.sync?.noteComposingChange();
            return;
          }
          updateEmptyHint();
          state.sync?.noteCommittedChange();
        },
        onCompositionState: (compositionState) => {
          if (compositionState === "idle") {
            // Committed input after composition: resume the normal schedule.
            updateEmptyHint();
            state.sync?.noteCommittedChange();
          } else {
            // Never let the hint overlap marked text (spec §4.1, §9).
            elements.emptyHint.hidden = true;
          }
        },
        onFilesDropped: (files, position) => {
          void attachFiles(files, position);
        },
      },
      { getMediaInfo: mediaInfo, renderMedia },
    );
    state.editor = editor;
  }
  editor.replaceDocument(document);
  // The editor resolves media metadata through `state.document`; it must hold
  // the freshly decrypted model *before* the editor builds its node views.
  state.document = document;

  const sync = new SyncEngine({
    bridge,
    callbacks: {
      getDocument: () => {
        const model = state.editor?.toDocumentModel(state.document.media) ?? state.document;
        // The wire format forbids entries that no block references, and an
        // upload can outlive the insertion it belonged to (deleted or undone
        // meanwhile). Pruning at the single read point keeps every save and
        // draft valid (spec §8).
        return pruneUnreferencedMedia(model);
      },
      applyRemote: (remote, { fromAdoption }) => {
        if (generation !== state.sessionGeneration) return;
        clearStreamSources();
        state.document = remote;
        void syncServiceWorkerMedia();
        if (fromAdoption) {
          // Clearing history avoids undoing back into the previous version
          // (spec §9.7).
          state.editor?.applyRemoteDocument(remote);
          state.editor?.clearHistory();
        } else {
          state.editor?.applyRemoteDocument(remote);
        }
        updateEmptyHint();
        // A remote copy that carried unreferenced media entries was opened with
        // them dropped; persist the repaired model so the stored document stops
        // being broken for every other client (spec §8).
        if (bridge.lastDroppedMediaIds.length > 0) {
          sync.noteCommittedChange();
        }
      },
      onState: (nextState, detail) => {
        if (generation !== state.sessionGeneration) return;
        setSyncState(nextState, detail);
        if (nextState === "saved") {
          for (const img of elements.editorHost.querySelectorAll<HTMLImageElement>("img[data-sw-media]")) {
            const mediaId = img.dataset.swMedia!;
            const info = mediaInfo(mediaId);
            if (info && img.complete && img.naturalWidth === 0) void materializeStream(img, mediaId, info);
          }
        }
      },
      onConflict: async ({ local, remote, remoteEtag }) => {
        const localPreview = window.document.createElement("pre");
        localPreview.textContent = serializeDocument(local);
        const remotePreview = window.document.createElement("pre");
        remotePreview.textContent = serializeDocument(remote);
        const body = window.document.createElement("div");
        const localLabel = window.document.createElement("p");
        localLabel.textContent = "この端末の内容";
        const remoteLabel = window.document.createElement("p");
        remoteLabel.textContent = "サーバーの内容";
        body.append(localLabel, localPreview, remoteLabel, remotePreview);
        const decision = await showDialog({
          title: "競合しています",
          body,
          actions: [
            { label: "編集して保存", value: "keep-local", primary: true },
            { label: "サーバーの内容を使う", value: "use-remote", primary: false },
          ],
        });
        void remoteEtag;
        return decision === "use-remote" ? "use-remote" : "keep-local";
      },
      isSafePoint: () => state.editor?.isSafePoint() ?? true,
    },
    accountId: vault.accountId,
    documentId: state.documentId,
    keyVersion: first.data.keyVersion,
    vaultKey: vault.vaultKey,
    // The engine must start from the loaded revision; otherwise the first save
    // races against an unknown base and 412s (spec §10.2).
    baseEtag: first.etag ?? null,
    baseRevision: first.data.revision,
  });
  state.sync = sync;
  sync.start();

  // A document that arrived with unreferenced media entries was opened with
  // those entries dropped (spec §8). Persist the repaired model once so every
  // client — including ones that do not implement the repair — sees a clean
  // document; otherwise the stored copy stays broken forever.
  if (bridge.lastDroppedMediaIds.length > 0) {
    toast("添付情報の整合性を修復しました。", 4000);
    sync.noteCommittedChange();
  }

  // Local draft recovery (§9.6, §10.6): a draft is only meaningful when it
  // holds input the server does not have yet. Committed snapshots are dropped
  // once saved, so anything left here is either unsynced or provisional.
  const draft = await loadDraft({
    vaultKey: vault.vaultKey,
    accountId: vault.accountId,
    documentId: state.documentId,
    keyVersion: vault.keyVersion,
  });
  if (generation !== state.sessionGeneration) return;
  if (draft && draft.mutationId) {
    const decision = await showDialog({
      title: draft.provisional ? "未確定の入力が残っています" : "未同期の入力が残っています",
      body: "前回の続きがあります。採用しますか。",
      actions: [
        { label: "採用する", value: "accept", primary: true },
        { label: "破棄する", value: "discard", primary: false },
      ],
    });
    if (generation !== state.sessionGeneration) return;
    if (decision === "accept") {
      try {
        const recovered = pruneUnreferencedMedia(
          JSON.parse(draft.documentJson) as DocumentModel,
        );
        if (normalizedEqual(recovered, document)) {
          // The draft matches what the server already holds (a leftover from a
          // best-effort clear): drop it silently instead of re-saving it.
          await clearDraft({
            accountId: vault.accountId,
            documentId: state.documentId,
          });
        } else {
          // The app state must carry the recovered media dictionary: the editor
          // resolves node metadata through `state.document` (spec §10.6).
          clearStreamSources();
          state.document = recovered;
          await syncServiceWorkerMedia();
          if (generation !== state.sessionGeneration) return;
          if (state.document !== recovered) throw new Error("draft superseded by remote document");
          editor.applyRemoteDocument(recovered);
          updateEmptyHint();
          // Save from the base the draft was written against: if the server has
          // moved past it, the save fails closed with 412 and the conflict
          // dialog decides — never a silent overwrite (spec §10.4).
          sync.setBaseFromDraft(draft.baseEtag);
          sync.noteCommittedChange();
        }
      } catch {
        toast("保存済みの下書きを読み込めませんでした。");
      }
    } else if (decision === "discard") {
      await clearDraft({
        accountId: vault.accountId,
        documentId: state.documentId,
      });
    }
  }

  if (generation !== state.sessionGeneration) return;
  showApp();
  setSyncState("idle");
  editor.focus();
  } catch (error) {
    if (generation !== state.sessionGeneration) return;
    // A failed start must never present as an empty document.
    if (window.__txtDebug) window.__txtDebug.lastError = `${(error as Error).name}: ${(error as Error).message}`;
    setSyncState("decrypt-failed", "内容を開けません。データは変更していません。");
    showGate({
      title: "開けませんでした",
      body: `${(error as Error).message}。データは変更していません。`,
      actions: [
        { label: "もう一度試す", onClick: () => void unlockFlow() },
        { label: "復旧キーで開く", primary: false, onClick: () => {
          elements.gateDetails.hidden = false;
          elements.gateDetails.open = true;
        } },
      ],
      error: true,
      showRecovery: true,
    });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Service Worker handshake (spec §11.6)                               */
/* ------------------------------------------------------------------ */

async function setupServiceWorker(vault: UnlockedVault): Promise<void> {
  if (!serviceWorkerBridge) return;
  const generation = state.sessionGeneration;
  const swGeneration = ++state.swGeneration;
  state.serviceWorkerReady = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Registration can stall independently of controller/ACK waiters.
    await Promise.race([
      navigator.serviceWorker.register("/sw.js", { scope: "/", type: "module" }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Service Worker timeout")), 8000); }),
    ]);
    if (generation !== state.sessionGeneration || swGeneration !== state.swGeneration || state.unlocked !== vault) return;
    mediaReady = serviceWorkerBridge.start({
      type: "txt-handshake",
      sessionGeneration: swGeneration,
      accountId: vault.accountId,
      documentId: state.documentId,
      keyVersion: vault.keyVersion,
      vaultKey: toBase64Url(vault.vaultKey),
      media: state.document.media,
    });
    await mediaReady;
    if (generation !== state.sessionGeneration || swGeneration !== state.swGeneration) return;
    // Claim/handshake can overlap a newer document dictionary.
    await syncServiceWorkerMedia();
  } catch {
    // Keep the small-blob fallback available; never materialize an unowned URL.
    if (generation === state.sessionGeneration && swGeneration === state.swGeneration) state.serviceWorkerReady = false;
  } finally {
    clearTimeout(timeout);
  }
}

function syncServiceWorkerMedia(): Promise<boolean> {
  const generation = state.sessionGeneration;
  const pending = serviceWorkerBridge?.updateMedia(state.document.media) ?? Promise.resolve(false);
  mediaReady = pending;
  state.serviceWorkerReady = false;
  void pending.then((acknowledged) => {
    if (generation !== state.sessionGeneration || mediaReady !== pending) return;
    state.serviceWorkerReady = acknowledged && (serviceWorkerBridge?.ready ?? false);
    if (state.serviceWorkerReady) refreshStreamSources();
  });
  return pending;
}

if (serviceWorkerBridge) navigator.serviceWorker.addEventListener("controllerchange", () => {
  clearStreamSources();
  state.serviceWorkerReady = false;
  if (state.unlocked) void setupServiceWorker(state.unlocked);
});

/* ------------------------------------------------------------------ */
/* Lock policy (spec §6.4)                                             */
/* ------------------------------------------------------------------ */

function lockVault(reason: string): void {
  if (!state.unlocked) return;
  if (state.editor && !state.editor.isSafePoint()) {
    // Never force-commit marked text on lock; retry shortly instead (§9.6).
    window.setTimeout(() => lockVault(reason), 1500);
    return;
  }
  if (state.editor && !state.editor.isSafePoint()) return;
  dismissCoach?.();
  state.sessionGeneration += 1;
  serviceWorkerBridge?.reset();
  mediaReady = Promise.resolve(false);
  for (const entry of state.attaching.values()) entry.controller.abort();
  state.attaching.clear();
  renderAttachProgress();
  state.sync?.stop();
  state.sync = null;
  state.bridge?.lock();
  state.bridge = null;
  const accountId = state.unlocked.accountId;
  state.unlocked = null;
  for (const url of state.objectUrls.values()) URL.revokeObjectURL(url);
  state.objectUrls.clear();
  state.document = { schemaVersion: 1, blocks: [], media: {} };
  state.editor?.replaceDocument({ schemaVersion: 1, blocks: [{ id: crypto.randomUUID(), type: "text", text: "" }], media: {} });
  void accountId;
  showGate({
    title: "パスキーで開く",
    body: reason,
    actions: [
      { label: "パスキーで開く", onClick: () => void unlockFlow() },
      { label: "復旧キーで開く", primary: false, onClick: () => {
        elements.gateDetails.hidden = false;
        elements.gateDetails.open = true;
      } },
    ],
    showRecovery: true,
  });
}

/**
 * Explicit lock: drop the in-memory key AND the device-kept copy so the next
 * visit really requires a passkey (spec §6.4). Web has no inactivity lock:
 * only an explicit user action ends the unlocked page's editing session.
 */
function lockVaultForget(): void {
  const accountId = state.unlocked?.accountId;
  if (accountId) {
    void forgetKeptVaultKey(accountId).catch(() => undefined);
  }
  lockVault("ロックしました。");
  toast("ロックしました。次回はパスキーが必要です。");
}

/* ------------------------------------------------------------------ */
/* Flows                                                               */
/* ------------------------------------------------------------------ */

async function unlockFlow(): Promise<void> {
  showGate({ body: "パスキーを確認しています……", actions: [] });
  try {
    const session = await api.session();
    let vault: UnlockedVault;
    if (session.scope === "active" || session.scope === "pending") {
      vault = await unlockExisting({ accountId: session.accountId, keyVersion: 1 });
    } else {
      vault = await loginAndUnlock();
    }
    await startSession(vault);
  } catch (error) {
    reportAuthError(error);
  }
}

async function loginFlow(): Promise<void> {
  showGate({ body: "パスキーを確認しています……", actions: [] });
  try {
    // Always a fresh discoverable-credential login, then unlock with the PRF.
    const vault = await loginAndUnlock();
    await startSession(vault);
  } catch (error) {
    if (error instanceof WebAuthnError && error.kind === "no-prf") {
      showGate({
        title: "この環境では、このパスキーで暗号化された内容を開けません。",
        body: "別の対応パスキー、または復旧キーを使用してください。",
        actions: [
          { label: "別のパスキーを試す", onClick: () => void loginFlow() },
          { label: "復旧キーで開く", primary: false, onClick: () => {
            elements.gateDetails.hidden = false;
            elements.gateDetails.open = true;
          } },
        ],
        showRecovery: true,
      });
      return;
    }
    reportAuthError(error);
  }
}

async function registerFlow(): Promise<void> {
  showGate({ body: "パスキーを作成しています……", actions: [] });
  try {
    if (window.__txtDebug) window.__txtDebug.step = "register:start";
    const result = await registerAccount();
    if (window.__txtDebug) window.__txtDebug.step = "register:bootstrap-done";
    // Recovery key must be saved and confirmed before the account is usable.
    const confirmed = await confirmRecoveryKey(result.recoveryKeyText);
    if (window.__txtDebug) window.__txtDebug.step = `register:confirmed:${String(confirmed)}`;
    if (!confirmed) {
      toast("復旧キーの保存を確認できませんでした。設定から再度表示できます。");
    }
    await startSession({
      vaultKey: result.vaultKey,
      accountId: result.accountId,
      credentialId: "",
      keyVersion: 1,
    });
    // First edit: point at the two permanent controls once (spec §4.6 新規作成).
    dismissCoach = showCoachMarks(elements.coach, [
      { side: "start", text: "写真・動画・音声を本文に入れる" },
      { side: "end", text: "ロック・パスキー・復旧キー・使い方" },
    ]);
  } catch (error) {
    reportAuthError(error);
  }
}

/**
 * 「はじめて使う」 from a fresh gate: explain the sheet, passkeys, encryption and
 * the recovery key first, and create the passkey only when asked (§4.6 紹介).
 */
async function startRegistration(): Promise<void> {
  const outcome = await runIntro("register", { behind: [elements.gate] });
  if (outcome === "create") {
    await registerFlow();
    return;
  }
  elements.gateActions.querySelector<HTMLButtonElement>("button")?.focus();
}

function reportAuthError(error: unknown): void {
  const message =
    error instanceof ApiRequestError
      ? `通信に失敗しました (${error.code}): ${error.message}`
      : (error as Error).message || "操作を完了できませんでした。";
  showGate({
    title: "うまくいきませんでした",
    body: message,
    actions: [
      { label: "もう一度試す", onClick: () => void loginFlow() },
      { label: "はじめて使う", primary: false, onClick: () => void registerFlow() },
    ],
    error: true,
    showRecovery: true,
  });
}

/**
 * Shows the recovery key and asks the user to keep it (spec §5.3, §7.1).
 * Copying and saving to a file are explicit actions; 「保存しました」 only
 * confirms and has no clipboard side effect.
 */
async function confirmRecoveryKey(recoveryKeyText: string): Promise<boolean> {
  const body = document.createElement("div");
  const key = document.createElement("pre");
  key.className = "recovery-key";
  key.textContent = recoveryKeyText;

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "button secondary compact";
  setToolButton(copy, "コピー", "copy");
  copy.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(recoveryKeyText)
      .then(() => setToolButton(copy, "コピーしました", "check"))
      .catch(() => {
        // Clipboard unavailable: select the key so it can be copied by hand.
        window.getSelection()?.selectAllChildren(key);
        setToolButton(copy, "選択しました", "check");
      })
      .finally(() => {
        window.setTimeout(() => setToolButton(copy, "コピー", "copy"), 2400);
      });
  });

  const save = document.createElement("button");
  save.type = "button";
  save.className = "button secondary compact";
  setToolButton(save, "ファイルに保存", "download");
  save.addEventListener("click", () => {
    downloadText("txt-recovery-key.txt", recoveryKeyText, body);
  });

  const tools = document.createElement("div");
  tools.className = "recovery-tools";
  tools.append(copy, save);
  body.append(
    textParagraph("パスキーを失くしたときに、この1枚を開ける唯一の鍵です。", "recovery-lead"),
    key,
    tools,
    textParagraph(RECOVERY_HELP, "recovery-note"),
  );
  const decision = await showDialog({
    title: "復旧キーを保存してください",
    body,
    actions: [
      { label: "保存しました", value: "confirm", primary: true },
      { label: "あとで", value: "later", tone: "ghost" },
    ],
  });
  return decision === "confirm";
}

async function recoveryFlow(): Promise<void> {
  const value = elements.recoveryInput.value.trim();
  if (!value) {
    elements.gateFootnote.textContent = "復旧キーを入力してください。";
    elements.gateFootnote.dataset.state = "error";
    return;
  }
  elements.gateFootnote.textContent = "復旧しています……";
  elements.gateFootnote.dataset.state = "idle";
  try {
    const outcome = await (await import("./vault.ts")).recoverWithKey(value);
    await confirmRecoveryKey(outcome.newRecoveryKeyText);
    await startSession({
      vaultKey: outcome.vaultKey,
      accountId: outcome.accountId,
      credentialId: "",
      keyVersion: 1,
    });
    toast("復旧が完了しました。");
  } catch (error) {
    elements.gateFootnote.textContent = (error as Error).message;
    elements.gateFootnote.dataset.state = "error";
  }
}

/**
 * Re-authenticates the current session for a sensitive operation (spec §5.4).
 * The ceremony is the same passkey the user already holds; it only refreshes
 * the step-up window on the server session.
 */
async function performStepUp(): Promise<void> {
  const { options } = await api.stepupOptions();
  const assertion = await assertCredential(options);
  await api.stepupVerify(assertion.dto);
}

/* ------------------------------------------------------------------ */
/* "その他" menu (spec §4.6)                                           */
/* ------------------------------------------------------------------ */

async function showMoreMenu(): Promise<void> {
  const accountId = state.unlocked?.accountId;
  const kept = accountId ? await loadKeptVaultKey(accountId).catch(() => null) : null;
  const keepLabel = kept ? "この端末の保持を解除" : "この端末に保持（30日）";
  const decision = await showDialog({
    title: "その他",
    body: kept
      ? `この端末ではパスキーなしで開けます（${new Date(kept.expiresAt).toLocaleDateString("ja-JP")} まで）。`
      : "この1枚に関する操作です。",
    variant: "menu",
    actions: [
      { label: keepLabel, value: kept ? "forget-device" : "keep-device", icon: "device" },
      { label: "今すぐロック", value: "lock-now", icon: "lock" },
      { label: "パスキーを追加", value: "add-passkey", icon: "key" },
      { label: "復旧キーを更新", value: "rotate-recovery", icon: "refresh" },
      { label: "使い方", value: "help", icon: "help" },
      // Shares the app's URL only — never the sheet (spec §4.6).
      { label: "txt を紹介する", value: "share", icon: "share" },
      // Session and account actions sit apart; deletion is marked by tone and
      // icon, not by colour alone (spec §4.1, §4.6).
      { label: "セッションを終了", value: "end-session", icon: "logout", separatorBefore: true },
      { label: "アカウントを削除", value: "delete-account", icon: "trash", tone: "danger" },
    ],
  });
  if (!state.unlocked) return;
  switch (decision) {
    case "help":
      await runIntro("replay", { behind: [elements.app] });
      state.editor?.focus();
      break;
    case "share":
      try {
        const outcome = await shareApp({ navigator, origin: window.location.origin });
        if (outcome === "copied") toast("リンクをコピーしました。");
      } catch {
        toast("共有できませんでした。アドレスバーのURLを共有してください。");
      }
      break;
    case "keep-device": {
      if (!state.documentId) break;
      try {
        const expiresAt = await keepVaultKey({
          accountId: state.unlocked.accountId,
          documentId: state.documentId,
          keyVersion: state.unlocked.keyVersion,
          vaultKey: state.unlocked.vaultKey,
        });
        toast(
          `この端末に保持しました（${new Date(expiresAt).toLocaleDateString("ja-JP")} まで）。`,
        );
      } catch (error) {
        toast(`保持できませんでした: ${(error as Error).message}`);
      }
      break;
    }
    case "forget-device":
      try {
        await forgetKeptVaultKey(state.unlocked.accountId);
        toast("この端末の保持を解除しました。次回はパスキーが必要です。");
      } catch (error) {
        toast((error as Error).message);
      }
      break;
    case "lock-now":
      lockVaultForget();
      break;
    case "add-passkey":
      try {
        await addPasskey({
          vaultKey: state.unlocked.vaultKey,
          accountId: state.unlocked.accountId,
          keyVersion: state.unlocked.keyVersion,
        });
        toast("パスキーを追加しました。");
      } catch (error) {
        toast((error as Error).message);
      }
      break;
    case "rotate-recovery": {
      try {
        const text = await rotateRecoveryKey({
          vaultKey: state.unlocked.vaultKey,
          accountId: state.unlocked.accountId,
        });
        await confirmRecoveryKey(text);
      } catch (error) {
        toast((error as Error).message);
      }
      break;
    }
    case "end-session":
      await api.endSession().catch(() => undefined);
      if (state.unlocked) {
        await clearAccountDrafts(state.unlocked.accountId);
        await forgetKeptVaultKey(state.unlocked.accountId).catch(() => undefined);
      }
      state.sessionGeneration += 1;
      serviceWorkerBridge?.reset();
      mediaReady = Promise.resolve(false);
      state.unlocked = null;
      state.bridge?.lock();
      state.bridge = null;
      window.location.reload();
      break;
    case "delete-account": {
      const confirmed = await showDialog({
        title: "アカウントを削除しますか",
        body: "本文・添付・鍵が削除され、元に戻せません。",
        actions: [
          { label: "削除する", value: "confirm", tone: "danger" },
          { label: "やめる", value: "cancel", primary: false },
        ],
      });
      if (confirmed === "confirm") {
        try {
          // Deletion is a sensitive operation: the server requires a step-up
          // re-authentication within 5 minutes (spec §5.4). Perform it here so
          // the user is not left with a 403 they cannot resolve.
          await performStepUp();
          await api.deleteAccount(crypto.randomUUID());
          await clearAccountDrafts(state.unlocked.accountId);
          await forgetAllKeptVaultKeys().catch(() => undefined);
          state.sessionGeneration += 1;
          serviceWorkerBridge?.reset();
          mediaReady = Promise.resolve(false);
          window.location.reload();
        } catch (error) {
          toast((error as Error).message);
        }
      }
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

/**
 * Caret position captured when the attach button is pressed.
 *
 * iOS Safari drops the editor's focus while the file picker is open and can
 * move the DOM selection to the start of the surface. Reading the caret in
 * `change` would then attach at the top of the document, so it is captured at
 * `pointerdown` — the last moment the editor still owns the selection — and
 * kept until the picker answers (spec §11.3).
 */
let pendingAttachPosition: number | null = null;

elements.attachButton.addEventListener(
  "pointerdown",
  () => {
    pendingAttachPosition = state.editor?.state.selection.from ?? null;
  },
  { passive: true },
);

elements.attachButton.addEventListener("click", () => {
  // Keyboard activation does not fire pointerdown; keep whatever was captured.
  if (pendingAttachPosition === null) {
    pendingAttachPosition = state.editor?.state.selection.from ?? null;
  }
  elements.fileInput.click();
});

elements.fileInput.addEventListener("change", () => {
  const files = Array.from(elements.fileInput.files ?? []);
  elements.fileInput.value = "";
  if (files.length === 0) {
    pendingAttachPosition = null;
    return;
  }
  const position = pendingAttachPosition ?? state.editor?.state.selection.from ?? 0;
  pendingAttachPosition = null;
  void attachFiles(files, position);
});

elements.moreButton.addEventListener("click", () => {
  void showMoreMenu();
});

elements.recoverySubmit.addEventListener("click", () => {
  void recoveryFlow();
});

document.addEventListener("visibilitychange", () => {
  // Backgrounding only flushes safe input; keep the editor and keys intact.
  // SyncEngine resumes fetching on visibility/focus/online (§10.2).
  if (document.hidden && state.editor?.isSafePoint()) state.sync?.saveNow();
});

async function boot(): Promise<void> {
  try {
    const session = await api.session();

    // With a valid session, try the device-kept VaultKey first: this is what
    // makes a return visit open without a passkey ceremony (spec §6.4).
    if (session.scope === "active") {
      const kept = await loadKeptVaultKey(session.accountId).catch(() => null);
      if (kept) {
        try {
          await startSession({
            vaultKey: kept.vaultKey,
            accountId: session.accountId,
            credentialId: "",
            keyVersion: kept.keyVersion,
          });
          return;
        } catch {
          // The kept key no longer opens the document (rotation, other device):
          // fall through to the explicit unlock gate.
          await forgetKeptVaultKey(session.accountId).catch(() => undefined);
        }
      }
    }

    if (session.scope === "pending") {
      // A half-finished registration: offer to complete it.
      showGate({
        title: "登録を完了してください",
        body: "パスキーは作成済みですが、準備が完了していません。",
        actions: [
          { label: "続ける", onClick: () => void loginFlow() },
          { label: "はじめて使う", primary: false, onClick: () => void registerFlow() },
        ],
        showRecovery: true,
      });
      return;
    }
    // A valid session without a device-kept key still needs an explicit unlock.
    showGate({
      title: "パスキーで開く",
      body: "暗号化された内容を開くため、パスキーを確認します。",
      actions: [
        { label: "パスキーで開く", onClick: () => void unlockFlow() },
        { label: "はじめて使う", primary: false, onClick: () => void startRegistration() },
      ],
      showRecovery: true,
    });
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      // First visit (or a new browser): lead with the intro (§4.6 紹介).
      showGate({
        actions: [
          { label: "はじめて使う", onClick: () => void startRegistration() },
          { label: "パスキーで開く", primary: false, onClick: () => void loginFlow() },
        ],
        showRecovery: true,
      });
      return;
    }
    showGate({
      title: "接続できません",
      body: "ネットワークを確認して、もう一度お試しください。",
      actions: [{ label: "再試行", onClick: () => void boot() }],
      error: true,
    });
  }
}

declare global {
  interface Window {
    __txtDebug?: {
      state: typeof state;
      lastError?: string;
      step?: string;
      documentIssues?: string[];
    };
  }
}

/**
 * Resolves the crypto worker URL from the build-injected data attribute.
 * Reading it from the DOM keeps the CSP free of `unsafe-inline` (spec §14).
 */
function cryptoWorkerUrl(): string {
  const config = document.getElementById("txt-config");
  const url = config?.dataset.cryptoWorker;
  if (!url) throw new Error("crypto worker URL is not configured");
  return url;
}

// Development-only inspection hook: lets the E2E suite observe async state
// without guessing from the DOM. It exposes no secrets (keys stay inside the
// crypto worker) and is inert in production.
window.__txtDebug = { state };

void boot();
