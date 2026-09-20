/**
 * Crypto bridge: the main thread's handle to the crypto worker (spec §9.1).
 *
 * All document/media encryption happens in the worker so input handling stays
 * free. Requests are correlated by requestId; the worker never receives the
 * VaultKey more than once per unlock.
 */

import type { DocumentModel } from "../../../../packages/protocol/src/document.ts";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class CryptoBridge {
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private unlocked: Promise<void>;
  private resolveUnlocked: (() => void) | null = null;
  private rejectUnlocked: ((reason: Error) => void) | null = null;
  private lockGeneration = 0;
  /**
   * Media IDs dropped while repairing the last decrypted document (spec §8).
   * The load path re-saves the repaired model so every client sees a clean
   * document; the list is informational only.
   */
  private lastDropped: string[] = [];

  constructor(workerUrl: string) {
    this.worker = new Worker(workerUrl, { type: "module", name: "txt-crypto" });
    this.unlocked = new Promise((resolve, reject) => {
      this.resolveUnlocked = resolve;
      this.rejectUnlocked = reject;
    });
    this.worker.addEventListener("message", (event) => this.onMessage(event));
    this.worker.addEventListener("error", (event) => {
      this.rejectUnlocked?.(new Error(event.message || "crypto worker failed"));
    });
  }

  private onMessage(event: MessageEvent): void {
    const data = event.data as Record<string, unknown>;
    const type = data.type as string;
    if (type === "unlocked") {
      this.resolveUnlocked?.();
      this.resolveUnlocked = null;
      return;
    }
    if (type === "locked") return;
    const requestId = data.requestId as string | undefined;
    if (type === "error") {
      const pending = requestId ? this.pending.get(requestId) : undefined;
      if (pending) {
        this.pending.delete(requestId as string);
        pending.reject(new Error(String(data.reason ?? "crypto error")));
      }
      return;
    }
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (type === "decrypt-failed") {
      pending.reject(new Error(String(data.reason ?? "decrypt failed")));
      return;
    }
    pending.resolve(data);
  }

  private request<T>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ ...message, requestId }, transfer);
    });
  }

  /** Unlocks the worker with the VaultKey for this account/document. */
  async unlock(options: {
    vaultKey: Uint8Array;
    accountId: string;
    documentId: string;
    keyVersion: number;
  }): Promise<void> {
    // Each unlock replaces the previous pending promise: the worker answers
    // "unlocked" per message, so the waiter must be re-armed before sending.
    this.unlocked = new Promise((resolve, reject) => {
      this.resolveUnlocked = resolve;
      this.rejectUnlocked = reject;
    });
    this.worker.postMessage({
      type: "unlock",
      vaultKey: options.vaultKey,
      accountId: options.accountId,
      documentId: options.documentId,
      keyVersion: options.keyVersion,
    });
    await this.unlocked;
  }

  lock(): void {
    this.lockGeneration += 1;
    this.worker.postMessage({ type: "lock" });
    for (const [, pending] of this.pending) {
      pending.reject(new Error("locked"));
    }
    this.pending.clear();
  }

  get generation(): number {
    return this.lockGeneration;
  }

  async encryptDocument(options: {
    mutationId: string;
    encryptedRevision: number;
    formatVersion: number;
    keyVersion: number;
    document: DocumentModel;
    documentJson: string;
  }): Promise<{ nonce: string; ciphertext: string }> {
    const response = await this.request<{ nonce: string; ciphertext: string }>({
      type: "encrypt-document",
      mutationId: options.mutationId,
      encryptedRevision: options.encryptedRevision,
      formatVersion: options.formatVersion,
      keyVersion: options.keyVersion,
      documentJson: options.documentJson,
    });
    return { nonce: response.nonce, ciphertext: response.ciphertext };
  }

  async decryptDocument(options: {
    mutationId: string;
    encryptedRevision: number;
    formatVersion: number;
    keyVersion: number;
    nonce: string;
    ciphertext: string;
  }): Promise<DocumentModel> {
    const response = await this.request<{ document: DocumentModel; droppedMediaIds?: string[] }>({
      type: "decrypt-document",
      ...options,
    });
    this.lastDropped = Array.isArray(response.droppedMediaIds) ? response.droppedMediaIds : [];
    return response.document;
  }

  /** Media entries the worker had to drop to open the last decrypted document. */
  get lastDroppedMediaIds(): string[] {
    return this.lastDropped;
  }

  async encryptChunk(options: {
    documentId: string;
    mediaId: string;
    fileKey: string;
    noncePrefix: string;
    cryptoFormat: number;
    totalPlainBytes: number;
    index: number;
    plaintext: Uint8Array;
  }): Promise<Uint8Array> {
    const buffer = options.plaintext.buffer.slice(
      options.plaintext.byteOffset,
      options.plaintext.byteOffset + options.plaintext.byteLength,
    ) as ArrayBuffer;
    const response = await this.request<{ ciphertext: ArrayBuffer }>(
      {
        type: "encrypt-chunk",
        documentId: options.documentId,
        mediaId: options.mediaId,
        fileKey: options.fileKey,
        noncePrefix: options.noncePrefix,
        cryptoFormat: options.cryptoFormat,
        totalPlainBytes: options.totalPlainBytes,
        index: options.index,
        plaintext: buffer,
      },
      [buffer],
    );
    return new Uint8Array(response.ciphertext);
  }

  async decryptChunk(options: {
    documentId: string;
    mediaId: string;
    fileKey: string;
    noncePrefix: string;
    cryptoFormat: number;
    totalPlainBytes: number;
    chunkPlainBytes: number;
    index: number;
    ciphertext: Uint8Array;
  }): Promise<Uint8Array> {
    const buffer = options.ciphertext.buffer.slice(
      options.ciphertext.byteOffset,
      options.ciphertext.byteOffset + options.ciphertext.byteLength,
    ) as ArrayBuffer;
    const response = await this.request<{ plaintext: ArrayBuffer }>(
      {
        type: "decrypt-chunk",
        documentId: options.documentId,
        mediaId: options.mediaId,
        fileKey: options.fileKey,
        noncePrefix: options.noncePrefix,
        cryptoFormat: options.cryptoFormat,
        totalPlainBytes: options.totalPlainBytes,
        chunkPlainBytes: options.chunkPlainBytes,
        index: options.index,
        ciphertext: buffer,
      },
      [buffer],
    );
    return new Uint8Array(response.plaintext);
  }
}
