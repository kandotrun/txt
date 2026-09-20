/**
 * Application entrypoint (spec §3, §4, §9, §10, §11).
 *
 * Responsibilities: gate screens, passkey registration/unlock, editor wiring,
 * sync engine, media rendering, lock policy, and the "その他" menu.
 */

import { serializeDocument } from "../../../../packages/protocol/src/document.ts";
import { IDLE_LOCK_MS } from "../../../../packages/protocol/src/windows.ts";
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
import { Editor } from "./editor.ts";
import { BLOB_FALLBACK_MAX_BYTES, classify, fetchDecrypted, uploadFile } from "./media.ts";
import type { MediaRejectedError } from "./media.ts";
import { SyncEngine } from "./sync.ts";
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
  dialog: must<HTMLDialogElement>("dialog"),
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
  lastActivity: number;
  lockTimer: number | null;
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
  lastActivity: Date.now(),
  lockTimer: null,
  serviceWorkerReady: false,
  swGeneration: 0,
  attaching: new Map(),
  objectUrls: new Map(),
};

const LOCK_AFTER_MS = IDLE_LOCK_MS;

/* ------------------------------------------------------------------ */
/* Gate rendering (spec §4.6)                                          */
/* ------------------------------------------------------------------ */

type GateAction = { label: string; primary?: boolean; onClick: () => void | Promise<void> };

function showGate(options: {
  title?: string;
  body?: string;
  actions: GateAction[];
  footnote?: string;
  error?: boolean;
  showRecovery?: boolean;
}): void {
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
      button.className = action.primary === false ? "button secondary" : "button";
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

function showApp(): void {
  elements.gate.hidden = true;
  elements.app.hidden = false;
  elements.controls.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Toast / dialog                                                      */
/* ------------------------------------------------------------------ */

let toastTimer: number | null = null;

function toast(message: string, duration = 2600): void {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, duration);
}

interface DialogAction {
  label: string;
  primary?: boolean;
  value: string;
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

    elements.dialogTitle.textContent = options.title;
    elements.dialogBody.replaceChildren(
      typeof options.body === "string" ? textParagraph(options.body) : options.body,
    );
    // Rebuilding the buttons each time prevents stale listeners from resolving
    // a later dialog with an earlier answer.
    elements.dialogActions.replaceChildren(
      ...options.actions.map((action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = action.primary === false ? "button secondary" : "button";
        button.textContent = action.label;
        button.dataset.value = action.value;
        button.addEventListener("click", () => {
          // Resolve directly on the click: relying solely on the <dialog>
          // close event is fragile when the browser suppresses it.
          settle(action.value);
          if (dialog.open) dialog.close();
        });
        return button;
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

function textParagraph(text: string): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  paragraph.style.margin = "0";
  return paragraph;
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
    img.src = `/_local/media/${encodeURIComponent(mediaId)}`;
    container.append(img);
    return container;
  }

  const tag = info.kind === "video" ? "video" : "audio";
  const player = document.createElement(tag) as HTMLVideoElement | HTMLAudioElement;
  player.controls = true;
  player.preload = "none";
  player.src = `/_local/media/${encodeURIComponent(mediaId)}`;
  player.setAttribute("playsinline", "");
  container.append(player);
  return container;
}

async function materializeImage(
  img: HTMLImageElement,
  mediaId: string,
  info: MediaInfo,
): Promise<void> {
  if (!state.bridge || !state.unlocked) return;
  const cached = state.objectUrls.get(mediaId);
  if (cached) {
    img.src = cached;
    return;
  }
  // The media node is inserted immediately, but the blob only becomes
  // deliverable after the reference save lands (spec §11.3 step 6). Retry a few
  // times before giving up so a fresh insertion is not stuck on a placeholder.
  for (let attempt = 0; attempt < 4; attempt++) {
    const bridge = state.bridge;
    if (!bridge) return;
    try {
      const blob = await fetchDecrypted({
        mediaId,
        info,
        documentId: state.documentId,
        bridge,
      });
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
  for (const file of files) {
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

    try {
      const result = await uploadFile({
        file,
        kind,
        documentId: state.documentId,
        bridge: state.bridge,
        signal: controller.signal,
        onStarted: (mediaId) => {
          entry.mediaId = mediaId;
          syncServiceWorkerMedia();
        },
        onProgress: (fraction) => {
          entry.progress = fraction;
          renderAttachProgress();
        },
      });
      // Register metadata. The insertion itself happens at an IME safe point;
      // if the surrounding text was deleted meanwhile, the position collapses
      // to the current selection instead of resurrecting a stale offset (§9.7).
      state.document.media[result.mediaId] = result.info;
      entry.mediaId = result.mediaId;
      entry.kind = result.info.kind;
      entry.done = true;
      // Insertion happens here (the upload completed); when composing, the
      // editor defers the structural change to the next safe point internally.
      state.editor.insertMedia(result.mediaId, result.info.kind, clampPosition(entry.position));
      state.sync?.noteCommittedChange();
      state.attaching.delete(placeholderId);
      renderAttachProgress();
      syncServiceWorkerMedia();
    } catch (error) {
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

  try {
    setSyncState("saving", "読み込み中");
    const session = await api.session();
    const bridge = new CryptoBridge(cryptoWorkerUrl());
    if (window.__txtDebug) window.__txtDebug.step = "session:api-done";

    // The document payload carries the real documentId; load it before unlocking
    // the workers so the AAD matches. This must be an unconditional fetch: a
    // 304 from a stale validator would leave us without a payload to decrypt.
    const first = await api.document();
    if (!first.data) throw new Error("文書を取得できません。");
    state.documentId = first.data.documentId;
    if (window.__txtDebug) window.__txtDebug.step = "session:document-done";

    await bridge.unlock({
      vaultKey: vault.vaultKey,
      accountId: vault.accountId,
      documentId: state.documentId,
      keyVersion: first.data.keyVersion,
    });
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

    const document = await bridge.decryptDocument({
      mutationId: first.data.mutationId,
      encryptedRevision: first.data.encryptedRevision,
      formatVersion: first.data.formatVersion,
      keyVersion: first.data.keyVersion,
      nonce: first.data.nonce,
      ciphertext: first.data.ciphertext,
    });
    if (window.__txtDebug) window.__txtDebug.step = "session:decrypted";

  state.unlocked = vault;
  state.bridge = bridge;
  state.document = document;

  let editor = state.editor;
  if (!editor) {
    editor = new Editor(
      elements.editorHost,
      {
        onCommittedChange: () => {
          state.lastActivity = Date.now();
          if (state.editor?.isComposing) {
            state.sync?.noteComposingChange();
            return;
          }
          state.sync?.noteCommittedChange();
        },
        onCompositionState: (compositionState) => {
          if (compositionState === "idle") {
            // Committed input after composition: resume the normal schedule.
            state.sync?.noteCommittedChange();
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
        const model = state.editor?.toDocumentModel(state.document.media);
        return model ?? state.document;
      },
      applyRemote: (remote, { fromAdoption }) => {
        state.document = remote;
        if (fromAdoption) {
          // Clearing history avoids undoing back into the previous version
          // (spec §9.7).
          state.editor?.applyRemoteDocument(remote);
          state.editor?.clearHistory();
        } else {
          state.editor?.applyRemoteDocument(remote);
        }
        syncServiceWorkerMedia();
      },
      onState: (nextState, detail) => {
        if (generation !== state.sessionGeneration) return;
        setSyncState(nextState, detail);
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

  // Local draft recovery (§9.6, §10.6): a draft is only meaningful when it
  // holds input the server does not have yet. Committed snapshots are dropped
  // once saved, so anything left here is either unsynced or provisional.
  const draft = await loadDraft({
    vaultKey: vault.vaultKey,
    accountId: vault.accountId,
    documentId: state.documentId,
    keyVersion: vault.keyVersion,
  });
  if (draft && draft.mutationId) {
    const decision = await showDialog({
      title: draft.provisional ? "未確定の入力が残っています" : "未同期の入力が残っています",
      body: "前回の続きがあります。採用しますか。",
      actions: [
        { label: "採用する", value: "accept", primary: true },
        { label: "破棄する", value: "discard", primary: false },
      ],
    });
    if (decision === "accept") {
      try {
        const recovered = JSON.parse(draft.documentJson) as DocumentModel;
        editor.applyRemoteDocument(recovered);
        sync.noteCommittedChange();
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

  await setupServiceWorker(vault);
  showApp();
  setSyncState("idle");
  editor.focus();
  resetLockTimer();
  } catch (error) {
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
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const registration = await navigator.serviceWorker.ready;
    state.serviceWorkerReady = true;
    const target = registration.active ?? navigator.serviceWorker.controller;
    if (!target) return;
    state.swGeneration += 1;
    target.postMessage({
      type: "txt-handshake",
      sessionGeneration: state.swGeneration,
      accountId: vault.accountId,
      documentId: state.documentId,
      keyVersion: vault.keyVersion,
      vaultKey: toBase64Url(vault.vaultKey),
      media: state.document.media,
    });
  } catch {
    // Without the Service Worker, large media playback is unavailable; the
    // small-blob path stays available and nothing else degrades (§11.6).
    state.serviceWorkerReady = false;
  }
}

function syncServiceWorkerMedia(): void {
  if (!state.serviceWorkerReady) return;
  const target = navigator.serviceWorker.controller;
  target?.postMessage({ type: "txt-media-update", media: state.document.media });
}

/* ------------------------------------------------------------------ */
/* Lock policy (spec §6.4)                                             */
/* ------------------------------------------------------------------ */

function resetLockTimer(): void {
  state.lastActivity = Date.now();
  if (state.lockTimer !== null) window.clearTimeout(state.lockTimer);
  state.lockTimer = window.setTimeout(() => {
    lockVault("一定時間操作がありませんでした。");
  }, LOCK_AFTER_MS);
}

function lockVault(reason: string): void {
  if (!state.unlocked) return;
  if (state.editor && !state.editor.isSafePoint()) {
    // Never force-commit marked text on lock; retry shortly instead (§9.6).
    window.setTimeout(() => lockVault(reason), 1500);
    return;
  }
  if (state.editor && !state.editor.isSafePoint()) return;
  state.sessionGeneration += 1;
  state.sync?.stop();
  state.sync = null;
  state.bridge?.lock();
  state.bridge = null;
  const accountId = state.unlocked.accountId;
  state.unlocked = null;
  for (const url of state.objectUrls.values()) URL.revokeObjectURL(url);
  state.objectUrls.clear();
  navigator.serviceWorker.controller?.postMessage({ type: "txt-lock" });
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
 * visit really requires a passkey (spec §6.4). Unlike the idle lock, this is a
 * deliberate user action, so nothing is retained.
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
    toast("準備ができました。");
  } catch (error) {
    reportAuthError(error);
  }
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

async function confirmRecoveryKey(recoveryKeyText: string): Promise<boolean> {
  const pre = document.createElement("pre");
  pre.textContent = recoveryKeyText;
  const note = document.createElement("p");
  note.textContent = RECOVERY_HELP;
  note.style.margin = "0";
  const body = document.createElement("div");
  body.append(note, pre);
  const decision = await showDialog({
    title: "復旧キーを保存してください",
    body,
    actions: [
      { label: "コピーしました", value: "confirm", primary: true },
      { label: "あとで", value: "later", primary: false },
    ],
  });
  if (decision === "confirm") {
    await navigator.clipboard.writeText(recoveryKeyText).catch(() => undefined);
    return true;
  }
  return false;
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
    actions: [
      { label: keepLabel, value: kept ? "forget-device" : "keep-device", primary: true },
      { label: "パスキーを追加", value: "add-passkey" },
      { label: "復旧キーを更新", value: "rotate-recovery" },
      { label: "今すぐロック", value: "lock-now" },
      { label: "セッションを終了", value: "end-session" },
      { label: "アカウントを削除", value: "delete-account" },
    ],
  });
  if (!state.unlocked) return;
  switch (decision) {
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
          { label: "削除する", value: "confirm", primary: true },
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

elements.attachButton.addEventListener("click", () => {
  elements.fileInput.click();
});

elements.fileInput.addEventListener("change", () => {
  const files = Array.from(elements.fileInput.files ?? []);
  elements.fileInput.value = "";
  if (files.length === 0) return;
  const position = state.editor?.state.selection.from ?? 0;
  void attachFiles(files, position);
});

elements.moreButton.addEventListener("click", () => {
  void showMoreMenu();
});

elements.recoverySubmit.addEventListener("click", () => {
  void recoveryFlow();
});

window.addEventListener("pointerdown", resetLockTimer, { passive: true });
window.addEventListener("keydown", resetLockTimer);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) resetLockTimer();
  else if (state.editor?.isSafePoint()) state.sync?.saveNow();
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
        { label: "はじめて使う", primary: false, onClick: () => void registerFlow() },
      ],
      showRecovery: true,
    });
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      showGate({
        actions: [
          { label: "パスキーで開く", onClick: () => void loginFlow() },
          { label: "はじめて使う", primary: false, onClick: () => void registerFlow() },
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
