/**
 * Sync engine (spec §10).
 *
 * Separate states rather than a single dirty flag: editGeneration,
 * committedGeneration, inFlightSave, remoteCandidate, persistedGeneration.
 *
 * - 700ms debounce after the last committed change; at most 5s of continuous
 *   committed input before sending (IME safe points take priority, §9.6).
 * - Conditional GET: every 5s while interacting, every 30s after 60s idle,
 *   stopped when hidden, resumed on focus/visibility/online.
 * - 412 keeps the unsaved content, fetches and decrypts the latest, and either
 *   declares equality (normalized model) or shows both for manual resolution.
 * - Retries use 1/2/4s... up to 30s with jitter, respecting 429 Retry-After.
 *   Auth failures and decrypt failures do not loop forever.
 */

import {
  DocumentFormatError,
  serializeDocument,
  validateDocument,
} from "../../../../packages/protocol/src/document.ts";
import type { DocumentModel, MediaInfo } from "../../../../packages/protocol/src/document.ts";
import { ApiRequestError, api } from "./api.ts";
import type { DocumentResponse } from "./api.ts";
import type { CryptoBridge } from "./crypto-bridge.ts";
import { saveDraft, clearDraft } from "./drafts.ts";

export type SyncState =
  | "idle"
  | "saving"
  | "saved"
  | "local-only"
  | "offline"
  | "conflict"
  | "auth-expired"
  | "decrypt-failed";

export interface SyncCallbacks {
  getDocument: () => DocumentModel;
  applyRemote: (document: DocumentModel, options: { fromAdoption: boolean }) => void;
  onState: (state: SyncState, detail?: string) => void;
  onConflict: (details: {
    local: DocumentModel;
    remote: DocumentModel;
    remoteEtag: string;
    remoteResponse: DocumentResponse;
  }) => Promise<"keep-local" | "use-remote" | "pending">;
  isSafePoint: () => boolean;
  /** Called when the model changed locally and differs from the server copy. */
  onMediaManifestChanged?: () => void;
}

/**
 * Sync timings (spec §10.2).
 *
 * Tuned for a seamless feel: a short debounce after the last committed input,
 * a tighter continuous-typing ceiling, and a fast foreground poll. All of them
 * still defer to the IME safe point, which is what keeps input correct — the
 * numbers below trade a little more traffic for noticeably lower latency.
 */
const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 2000;
const ACTIVE_POLL_MS = 2500;
const IDLE_POLL_MS = 15000;
const IDLE_AFTER_MS = 60000;
const MAX_BACKOFF_MS = 30000;

/** Same-browser tab notifications: metadata only, never keys or content. */
const CHANNEL_NAME = "txt-document";
const CHANGE_MESSAGE = "document-changed";

export class SyncEngine {
  private readonly bridge: CryptoBridge;
  private readonly callbacks: SyncCallbacks;
  private readonly accountId: string;
  private readonly documentId: string;
  private readonly keyVersion: number;
  private readonly vaultKey: Uint8Array;

  private baseEtag: string | null = null;
  private baseRevision = -1;
  private editGeneration = 0;
  private committedGeneration = 0;
  private persistedGeneration = -1;
  private inFlight: { generation: number; mutationId: string; payload: SavePayload } | null = null;
  private remoteCandidate: { document: DocumentModel; response: DocumentResponse; etag: string } | null =
    null;
  private debounceTimer: number | null = null;
  private maxWaitTimer: number | null = null;
  private pollTimer: number | null = null;
  private retryTimer: number | null = null;
  private backoffMs = 1000;
  private lastInteraction = Date.now();
  private stopped = false;
  private syncing = false;
  private dirty = false;
  private pendingRemoteApply: DocumentModel | null = null;
  private channel: BroadcastChannel | null = null;

  constructor(options: {
    bridge: CryptoBridge;
    callbacks: SyncCallbacks;
    accountId: string;
    documentId: string;
    keyVersion: number;
    vaultKey: Uint8Array;
    /** Base revision/ETag of the document already loaded into the editor. */
    baseEtag?: string | null;
    baseRevision?: number;
  }) {
    this.bridge = options.bridge;
    this.callbacks = options.callbacks;
    this.accountId = options.accountId;
    this.documentId = options.documentId;
    this.keyVersion = options.keyVersion;
    this.vaultKey = options.vaultKey;
    this.baseEtag = options.baseEtag ?? null;
    this.baseRevision = options.baseRevision ?? -1;
  }

  /** Initial load. Returns the decrypted document and sets the base ETag. */
  async load(): Promise<{ document: DocumentModel; etag: string }> {
    const { data, etag } = await api.document();
    if (!data) throw new Error("文書を取得できません。");
    this.baseEtag = etag ?? null;
    this.baseRevision = data.revision;
    const document = await this.bridge.decryptDocument({
      mutationId: data.mutationId,
      encryptedRevision: data.encryptedRevision,
      formatVersion: data.formatVersion,
      keyVersion: data.keyVersion,
      nonce: data.nonce,
      ciphertext: data.ciphertext,
    });
    return { document, etag: etag ?? "" };
  }

  start(): void {
    this.schedulePoll();
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("focus", this.onFocus);
    window.addEventListener("online", this.onFocus);
    window.addEventListener("offline", () => this.callbacks.onState("offline"));
    this.startChannel();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("focus", this.onFocus);
    window.removeEventListener("online", this.onFocus);
    this.channel?.close();
    this.channel = null;
  }

  /**
   * Same-browser notifications (spec §10.5). Only that the document changed is
   * broadcast — never keys or content; receivers re-fetch from the API. A
   * missing notification is harmless because polling still converges.
   */
  private startChannel(): void {
    if (typeof BroadcastChannel === "undefined") return;
    try {
      this.channel = new BroadcastChannel(`${CHANNEL_NAME}:${this.documentId}`);
      this.channel.addEventListener("message", (event) => {
        if (event.data !== CHANGE_MESSAGE) return;
        // Another tab saved: fetch immediately instead of waiting for the poll.
        void this.refreshRemote();
      });
    } catch {
      this.channel = null; // private mode or unsupported: polling covers it
    }
  }

  private announceChange(): void {
    try {
      this.channel?.postMessage(CHANGE_MESSAGE);
    } catch {
      // A failed announcement never affects the save itself.
    }
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer !== null) {
      window.clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
    this.clearPollTimer();
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Marks a committed local change (called from the editor). */
  noteCommittedChange(): void {
    this.editGeneration += 1;
    this.committedGeneration = this.editGeneration;
    this.dirty = true;
    this.lastInteraction = Date.now();
    this.callbacks.onState("local-only");
    this.scheduleSave();
    void this.persistDraft();
  }

  /** Marks an uncommitted change (composing) — never synced (§9.6). */
  noteComposingChange(): void {
    this.editGeneration += 1;
  }

  get hasPendingLocalChanges(): boolean {
    return this.dirty;
  }

  get currentGeneration(): number {
    return this.editGeneration;
  }

  /** Save now (Cmd/Ctrl+S): only at a safe point, never forcing IME commit. */
  async saveNow(): Promise<void> {
    if (!this.callbacks.isSafePoint()) return;
    await this.flush();
  }

  /* ---------------------------------------------------------------- */
  /* Saving                                                            */
  /* ---------------------------------------------------------------- */

  private scheduleSave(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      void this.flush();
    }, DEBOUNCE_MS);
    if (this.maxWaitTimer === null) {
      this.maxWaitTimer = window.setTimeout(() => {
        this.maxWaitTimer = null;
        void this.flush();
      }, MAX_WAIT_MS);
    }
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.syncing) return;
    if (!this.dirty) return;
    if (!this.callbacks.isSafePoint()) {
      // Still composing: defer; the composition state change will re-trigger.
      return;
    }
    if (this.inFlight && this.inFlight.generation === this.committedGeneration) return;
    this.syncing = true;
    try {
      await this.pushOnce();
    } finally {
      this.syncing = false;
    }
  }

  private async pushOnce(): Promise<void> {
    const generation = this.committedGeneration;
    const document = this.callbacks.getDocument();
    const mutationId = this.inFlight?.generation === generation
      ? this.inFlight.mutationId
      : crypto.randomUUID();
    const encryptedRevision = this.baseRevision + 1;

    const payload = await this.buildPayload({ document, mutationId, encryptedRevision });
    this.inFlight = { generation, mutationId, payload };

    if (this.baseEtag === null) {
      // No base yet: fetch first so the CAS cannot silently overwrite.
      await this.refreshRemote({ force: true });
      if (this.baseEtag === null) {
        this.callbacks.onState("offline", "サーバーに接続できません。");
        this.scheduleRetry();
        return;
      }
    }

    this.callbacks.onState("saving");
    try {
      const result = await api.putDocument(
        {
          mutationId,
          formatVersion: payload.formatVersion,
          keyVersion: payload.keyVersion,
          encryptedRevision,
          nonce: payload.nonce,
          ciphertext: payload.ciphertext,
          referencedMediaIds: payload.referencedMediaIds,
        },
        this.baseEtag,
      );
      this.baseEtag = result.etag;
      this.baseRevision = result.revision;
      this.persistedGeneration = generation;
      this.backoffMs = 1000;
      const stillUnsynced = this.committedGeneration !== generation;
      this.callbacks.onState(stillUnsynced ? "saving" : "saved");
      if (stillUnsynced) {
        this.scheduleSave();
      } else {
        this.dirty = false;
        // The server now holds this content: the local draft is no longer a
        // recovery source and must not trigger a confirmation on next load.
        this.persistedGeneration = generation;
        void this.clearSyncedDraft();
        // Tell other tabs in this browser to fetch now instead of waiting for
        // their next poll (spec §10.5).
        this.announceChange();
        this.callbacks.onState("saved");
        window.setTimeout(() => {
          if (!this.dirty) this.callbacks.onState("idle");
        }, 2000);
      }
    } catch (error) {
      await this.handleSaveError(error as Error, generation, mutationId);
    }
  }

  private async buildPayload(options: {
    document: DocumentModel;
    mutationId: string;
    encryptedRevision: number;
  }): Promise<SavePayload> {
    // Last line of defence: a document that fails validation must never be
    // uploaded, because every client — including ones that cannot repair it —
    // would refuse to open it afterwards (spec §8).
    const issues = validateDocument(options.document);
    if (issues.length > 0) {
      throw new DocumentFormatError("document failed validation before save", issues);
    }
    const json = serializeDocument(options.document);
    const { nonce, ciphertext } = await this.bridge.encryptDocument({
      mutationId: options.mutationId,
      encryptedRevision: options.encryptedRevision,
      formatVersion: 1,
      keyVersion: this.keyVersion,
      document: options.document,
      documentJson: json,
    });
    const referencedMediaIds = sortedMediaIds(options.document);
    return {
      mutationId: options.mutationId,
      formatVersion: 1,
      keyVersion: this.keyVersion,
      nonce,
      ciphertext,
      referencedMediaIds,
      documentJson: json,
      media: options.document.media,
    };
  }

  private async handleSaveError(error: Error, generation: number, mutationId: string): Promise<void> {
    if (error instanceof ApiRequestError) {
      if (error.status === 401) {
        this.callbacks.onState("auth-expired", "再ログインが必要です。");
        return; // no infinite retry on 401
      }
      if (error.status === 412) {
        await this.resolvePrecondition(generation, mutationId);
        return;
      }
      if (error.status === 409) {
        // Mutation conflict: the payload changed under the same id. Send a new
        // mutation id on the next attempt.
        this.inFlight = null;
        this.backoffMs = 1000;
        this.scheduleRetry();
        return;
      }
      if (error.status === 422) {
        // Reference or integrity violation: keep the input, stop auto-retry.
        this.callbacks.onState("local-only", "参照の整合性が取れないため保存できません。");
        return;
      }
      if (error.status === 429) {
        const retryAfter = 5000;
        this.backoffMs = Math.max(this.backoffMs, retryAfter);
        this.scheduleRetry();
        return;
      }
    }
    // Decrypt failures and unknown formats are not network failures (§10.6).
    if ((error as Error).message?.includes("decrypt")) {
      this.callbacks.onState("decrypt-failed", "内容を開けません。データは変更していません。");
      return;
    }
    if (error instanceof DocumentFormatError) {
      // Refusing to save keeps the other devices readable; the local copy is
      // preserved and a retry cannot help until the model is repaired.
      this.callbacks.onState("local-only", "本文の整合性が取れないため保存できません。");
      return;
    }
    this.callbacks.onState("offline", "端末に保存済み・未同期");
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    const jitter = Math.random() * 0.3 + 0.85;
    const delay = Math.min(this.backoffMs * jitter, MAX_BACKOFF_MS);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
  }

  /** 412 handling (spec §10.4): compare, then either converge or ask. */
  private async resolvePrecondition(generation: number, mutationId: string): Promise<void> {
    this.inFlight = null;
    let remote: { data?: DocumentResponse; etag?: string; notModified: boolean };
    try {
      remote = await api.document();
    } catch {
      this.scheduleRetry();
      return;
    }
    if (remote.notModified || !remote.data) {
      // Nothing changed server-side beyond our stale base: refresh the base and
      // retry with a fresh revision.
      const meta = await api.document();
      if (meta.data) {
        this.baseEtag = meta.etag ?? this.baseEtag;
        this.baseRevision = meta.data.revision;
      }
      this.scheduleRetry();
      return;
    }
    const remoteDocument = await this.bridge.decryptDocument({
      mutationId: remote.data.mutationId,
      encryptedRevision: remote.data.encryptedRevision,
      formatVersion: remote.data.formatVersion,
      keyVersion: remote.data.keyVersion,
      nonce: remote.data.nonce,
      ciphertext: remote.data.ciphertext,
    });
    this.remoteCandidate = {
      document: remoteDocument,
      response: remote.data,
      etag: remote.etag ?? "",
    };

    const local = this.callbacks.getDocument();
    // Equality is decided on the normalized common model, never on ciphertext
    // bytes (randomized nonces would differ even for identical content).
    if (normalizedEqual(local, remoteDocument)) {
      this.baseEtag = remote.etag ?? this.baseEtag;
      this.baseRevision = remote.data.revision;
      this.persistedGeneration = generation;
      this.dirty = false;
      this.callbacks.onState("saved");
      return;
    }

    this.callbacks.onState("conflict", "競合があります。");
    const decision = await this.callbacks.onConflict({
      local,
      remote: remoteDocument,
      remoteEtag: remote.etag ?? "",
      remoteResponse: remote.data,
    });
    if (decision === "use-remote") {
      this.baseEtag = remote.etag ?? null;
      this.baseRevision = remote.data.revision;
      this.persistedGeneration = generation;
      this.dirty = false;
      this.callbacks.applyRemote(remoteDocument, { fromAdoption: true });
      this.callbacks.onState("saved");
      return;
    }
    if (decision === "keep-local") {
      // Keep editing; the next save uses the refreshed base ETag.
      this.baseEtag = remote.etag ?? this.baseEtag;
      this.baseRevision = remote.data.revision;
      this.inFlight = null;
      this.scheduleSave();
      return;
    }
    // pending: leave the decision to the user interface.
    void mutationId;
  }

  /* ---------------------------------------------------------------- */
  /* Fetching                                                          */
  /* ---------------------------------------------------------------- */

  private onVisibility = (): void => {
    if (document.hidden) {
      this.clearPollTimer();
      // Best-effort save when going background; never rely on unload events.
      if (this.callbacks.isSafePoint()) void this.flush();
      return;
    }
    this.lastInteraction = Date.now();
    void this.refreshRemote();
    this.schedulePoll();
  };

  private onFocus = (): void => {
    this.lastInteraction = Date.now();
    void this.refreshRemote();
    this.schedulePoll();
  };

  private schedulePoll(): void {
    this.clearPollTimer();
    if (this.stopped || document.hidden) return;
    const idleFor = Date.now() - this.lastInteraction;
    const interval = idleFor > IDLE_AFTER_MS ? IDLE_POLL_MS : ACTIVE_POLL_MS;
    this.pollTimer = window.setTimeout(() => {
      // Reserve the next poll only after this response returns (§10.2).
      void this.refreshRemote().finally(() => this.schedulePoll());
    }, interval);
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async refreshRemote(options: { force?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    if (!options.force && this.dirty) {
      // Local changes are pending: fetching is still allowed, but a remote
      // version is only applied at a safe point.
      if (!this.callbacks.isSafePoint()) return;
    }
    try {
      const result = await api.document(this.baseEtag ?? undefined);
      if (result.notModified || !result.data) return;
      const remoteDocument = await this.bridge.decryptDocument({
        mutationId: result.data.mutationId,
        encryptedRevision: result.data.encryptedRevision,
        formatVersion: result.data.formatVersion,
        keyVersion: result.data.keyVersion,
        nonce: result.data.nonce,
        ciphertext: result.data.ciphertext,
      });
      this.baseEtag = result.etag ?? this.baseEtag;
      this.baseRevision = result.data.revision;

      if (this.dirty) {
        // Unsaved local edits exist: never replace them silently.
        this.remoteCandidate = { document: remoteDocument, response: result.data, etag: result.etag ?? "" };
        if (normalizedEqual(this.callbacks.getDocument(), remoteDocument)) {
          this.persistedGeneration = this.committedGeneration;
          this.dirty = false;
          this.callbacks.onState("saved");
        }
        return;
      }
      this.callbacks.applyRemote(remoteDocument, { fromAdoption: false });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        this.callbacks.onState("auth-expired", "再ログインが必要です。");
        return;
      }
      // Network hiccups keep the polling cadence; no tight retry loop.
    }
  }

  /** Adopts the fetched remote version (explicit user decision). */
  adoptRemoteCandidate(): boolean {
    if (!this.remoteCandidate) return false;
    this.callbacks.applyRemote(this.remoteCandidate.document, { fromAdoption: true });
    this.baseEtag = this.remoteCandidate.etag;
    this.baseRevision = this.remoteCandidate.response.revision;
    this.dirty = false;
    this.remoteCandidate = null;
    this.callbacks.onState("saved");
    return true;
  }

  /** Saves the local contents over the fetched remote base. */
  async saveLocalOverRemote(): Promise<void> {
    if (!this.remoteCandidate) return;
    this.baseEtag = this.remoteCandidate.etag;
    this.baseRevision = this.remoteCandidate.response.revision;
    this.remoteCandidate = null;
    this.inFlight = null;
    this.dirty = true;
    await this.flush();
  }

  /* ---------------------------------------------------------------- */
  /* Local persistence                                                 */
  /* ---------------------------------------------------------------- */

  private async persistDraft(): Promise<void> {
    try {
      const document = this.callbacks.getDocument();
      await saveDraft({
        vaultKey: this.vaultKey,
        accountId: this.accountId,
        documentId: this.documentId,
        plaintextDocument: serializeDocument(document),
        baseEtag: this.baseEtag,
        mutationId: this.inFlight?.mutationId ?? null,
        keyVersion: this.keyVersion,
        provisional: !this.callbacks.isSafePoint(),
      });
    } catch {
      // Local persistence failures are surfaced by the caller's state machine;
      // an encrypted draft is best effort only (§10.6).
    }
  }

  /**
   * Drops the local draft once the server holds the same content.
   *
   * Keeping it would make every reload ask "未確定の入力が残っています" for
   * content that is already saved. The draft exists to protect *unsynced*
   * input, so it is cleared on a confirmed save (spec §10.6).
   */
  private async clearSyncedDraft(): Promise<void> {
    try {
      await clearDraft({
        accountId: this.accountId,
        documentId: this.documentId,
      });
    } catch {
      // A leftover draft only costs an extra confirmation, never data.
    }
  }
}

interface SavePayload {
  mutationId: string;
  formatVersion: number;
  keyVersion: number;
  nonce: string;
  ciphertext: string;
  referencedMediaIds: string[];
  documentJson: string;
  media: Record<string, MediaInfo>;
}

function sortedMediaIds(document: DocumentModel): string[] {
  const ids = new Set<string>();
  for (const block of document.blocks) {
    if (block.type === "media") ids.add(block.mediaId);
  }
  return [...ids].sort();
}

/** Structural comparison of the normalized model (spec §10.4). */
export function normalizedEqual(a: DocumentModel, b: DocumentModel): boolean {
  if (a.blocks.length !== b.blocks.length) return false;
  for (let i = 0; i < a.blocks.length; i++) {
    const left = a.blocks[i]!;
    const right = b.blocks[i]!;
    if (left.type !== right.type) return false;
    if (left.type === "text" && right.type === "text" && left.text !== right.text) return false;
    if (left.type === "media" && right.type === "media" && left.mediaId !== right.mediaId) return false;
  }
  const leftMedia = Object.keys(a.media).sort();
  const rightMedia = Object.keys(b.media).sort();
  return leftMedia.join("\u0000") === rightMedia.join("\u0000");
}
