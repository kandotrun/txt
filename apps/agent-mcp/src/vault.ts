/**
 * The agent-side vault: unwraps the VaultKey locally and decrypts the
 * document with the shared protocol contract.
 *
 * Boundary (design §2.3): the VaultKey and plaintext exist only in this
 * process's memory. The server only ever sees the Bearer token and
 * ciphertext. Nothing in this file logs keys, tokens or plaintext.
 *
 * Phase 2 adds writes (design §8.4, §9): every write fetches the current
 * ciphertext, decrypts and validates the common document model, applies a
 * block-level operation, re-encrypts under a fresh mutationId/nonce, and
 * saves through the existing ETag CAS. A 412 is never retried into an
 * overwrite — the caller gets the base→latest diff and decides. Before
 * each PUT the pre-write ciphertext record is backed up locally (§9.5) so
 * a bad write can be rolled back.
 */

import {
  importAgentPrivateKey,
  unwrapVaultKeyForAgent,
} from "../../../packages/protocol/src/agent.ts";
import { fromBase64Url, toBase64Url } from "../../../packages/protocol/src/base64url.ts";
import {
  NONCE_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveDocumentKey,
  documentAad,
  randomBytes,
} from "../../../packages/protocol/src/crypto.ts";
import {
  MAX_DOCUMENT_JSON_BYTES,
  documentJsonBytes,
  newId,
  parseDocument,
  plainTextForCopy,
  referencedMediaIds,
  serializeDocument,
  validateDocument,
  validateOrThrow,
} from "../../../packages/protocol/src/document.ts";
import type { DocumentModel } from "../../../packages/protocol/src/document.ts";
import type { AgentState, CiphertextBackup } from "./config.ts";

export interface EnvelopeResponse {
  agentId: string;
  accountId: string;
  displayName: string;
  formatVersion: number;
  keyVersion: number;
  ephemeralPublicKey: string;
  wrapSalt32: string;
  nonce: string;
  wrappedKey: string;
}

export interface DocumentResponse {
  accountId: string;
  documentId: string;
  syncEpoch: number;
  revision: number;
  encryptedRevision: number;
  formatVersion: number;
  keyVersion: number;
  mutationId: string;
  nonce: string;
  ciphertext: string;
  referencedMediaIds: string[];
  updatedAt: number;
}

export interface DocumentUpdatePayload {
  mutationId: string;
  formatVersion: number;
  keyVersion: number;
  encryptedRevision: number;
  nonce: string;
  ciphertext: string;
  referencedMediaIds: string[];
}

export class AgentApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export class TxtClient {
  constructor(
    private readonly apiBase: string,
    private readonly token: string | null,
  ) {}

  private async request<T>(
    path: string,
    init: { method?: string; json?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: T | null; etag: string | null }> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const response = await fetch(`${this.apiBase}${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
    });
    if (response.status === 304) return { status: 304, body: null, etag: response.headers.get("etag") };
    const text = await response.text();
    if (!response.ok) {
      let code = "HTTP_ERROR";
      let message = `request failed (${response.status})`;
      try {
        const parsed = JSON.parse(text) as { error?: { code: string; message: string } };
        if (parsed.error) {
          code = parsed.error.code;
          message = parsed.error.message;
        }
      } catch {
        // Non-JSON error bodies keep the generic message.
      }
      throw new AgentApiError(response.status, code, message);
    }
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as T) : null,
      etag: response.headers.get("etag"),
    };
  }

  async envelope(): Promise<EnvelopeResponse> {
    const { body } = await this.request<EnvelopeResponse>("/api/v1/agent/envelope");
    if (!body) throw new Error("empty envelope response");
    return body;
  }

  async document(etag?: string): Promise<{ document: DocumentResponse | null; etag: string | null }> {
    const result = await this.request<DocumentResponse>("/api/v1/document", {
      headers: etag ? { "if-none-match": etag } : {},
    });
    return { document: result.body, etag: result.etag };
  }

  /** Conditional CAS update (spec §10.2/§12.2): If-Match is mandatory. */
  async putDocument(
    payload: DocumentUpdatePayload,
    etag: string,
  ): Promise<{ revision: number; mutationId: string; updatedAt: number; etag: string | null }> {
    const result = await this.request<{
      etag: string;
      revision: number;
      mutationId: string;
      updatedAt: number;
    }>("/api/v1/document", {
      method: "PUT",
      json: payload,
      headers: { "if-match": etag },
    });
    if (!result.body) throw new Error("empty document update response");
    return { ...result.body, etag: result.etag ?? result.body.etag };
  }
}

/* ------------------------------------------------------------------ */
/* Document model operations (design §8, §9.1)                         */
/* ------------------------------------------------------------------ */

function cloneModel(model: DocumentModel): DocumentModel {
  return structuredClone(model);
}

/**
 * Append text per design §9.1: onto the trailing text block when there is
 * one; when the document ends with a media block, a new text block (fresh
 * ID) is added after it, as §8 requires editable text around media.
 * Existing block IDs are never changed. No implicit formatting (no added
 * newline) is applied to the caller's text.
 */
export function appendToModel(model: DocumentModel, text: string): DocumentModel {
  const next = cloneModel(model);
  const last = next.blocks[next.blocks.length - 1];
  if (!last) {
    next.blocks.push({ id: newId(), type: "text", text });
    return next;
  }
  if (last.type === "text") {
    last.text += text;
    return next;
  }
  next.blocks.push({ id: newId(), type: "text", text });
  return next;
}

export type ReplaceBlockResult =
  | { model: DocumentModel }
  | { reason: string; currentText?: string };

/**
 * Block replacement (design §9.2): runs only when `expectedText` is the
 * block's exact current value. Any mismatch refuses with the current
 * content so the caller can show it — never a partial/fuzzy match.
 */
export function replaceBlockInModel(
  model: DocumentModel,
  blockId: string,
  expectedText: string,
  newText: string,
): ReplaceBlockResult {
  const block = model.blocks.find((entry) => entry.id === blockId);
  if (!block) return { reason: `block ${blockId} not found` };
  if (block.type !== "text") return { reason: `block ${blockId} is not a text block` };
  if (block.text !== expectedText) {
    return { reason: "expected_text does not match the block's current text", currentText: block.text };
  }
  const next = cloneModel(model);
  const target = next.blocks.find((entry) => entry.id === blockId);
  if (target && target.type === "text") target.text = newText;
  return { model: next };
}

export type SearchReplaceResult =
  | { model: DocumentModel; blockId: string }
  | { matchCount: number; blockIds: string[] };

function countOccurrences(text: string, find: string): number {
  if (find.length === 0) return 0;
  return text.split(find).length - 1;
}

/**
 * Full-text search & replace (design §8.3 tool contract): the match count
 * is computed across all text blocks and the replacement runs only when
 * there is EXACTLY ONE occurrence. Zero or multiple matches refuse and
 * report where the matches are.
 */
export function searchReplaceInModel(
  model: DocumentModel,
  find: string,
  replacement: string,
): SearchReplaceResult {
  if (find.length === 0) return { matchCount: 0, blockIds: [] };
  let total = 0;
  const blockIds: string[] = [];
  for (const block of model.blocks) {
    if (block.type !== "text") continue;
    const count = countOccurrences(block.text, find);
    if (count > 0) {
      total += count;
      blockIds.push(block.id);
    }
  }
  if (total !== 1) return { matchCount: total, blockIds };
  const blockId = blockIds[0] as string;
  const next = cloneModel(model);
  const target = next.blocks.find((entry) => entry.id === blockId);
  if (target && target.type === "text") {
    const at = target.text.indexOf(find);
    target.text = target.text.slice(0, at) + replacement + target.text.slice(at + find.length);
  }
  return { model: next, blockId };
}

/* ------------------------------------------------------------------ */
/* Line diff (conflict / preview reporting, design §9.4)               */
/* ------------------------------------------------------------------ */

/**
 * Minimal LCS-based line diff with `- `/`+ `/`  ` prefixes. For very
 * large inputs the quadratic table is skipped and a summary is returned;
 * the caller also receives the full latest text separately.
 */
export function diffTexts(before: string, after: string): string {
  if (before === after) return "(no differences)";
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000) {
    return `(diff too large to render line-by-line: ${a.length} lines -> ${b.length} lines)`;
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? (dp[i + 1]![j + 1] as number) + 1
          : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Write outcomes                                                      */
/* ------------------------------------------------------------------ */

export type WriteOutcome =
  | { status: "saved"; revision: number; etag: string | null; mutationId: string }
  | {
      status: "conflict";
      attempted: string;
      baseRevision: number;
      latestRevision: number;
      diff: string;
      latestText: string;
    }
  | {
      status: "rejected";
      reason: string;
      currentText?: string;
      matchCount?: number;
      blockIds?: string[];
    }
  | { status: "preview"; description: string; diff: string };

type MutationResult =
  | { model: DocumentModel }
  | {
      reject: {
        reason: string;
        currentText?: string;
        matchCount?: number;
        blockIds?: string[];
      };
    };

interface UnlockedState {
  vaultKey: Uint8Array;
  accountId: string;
  agentId: string;
  displayName: string;
  lastEtag: string | null;
  lastDocument: DocumentModel | null;
  lastRevision: number | null;
}

interface CurrentDocument {
  response: DocumentResponse;
  etag: string | null;
  model: DocumentModel;
}

export class AgentVault {
  private unlocked: UnlockedState | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly state: AgentState) {}

  get isUnlocked(): boolean {
    return this.unlocked !== null;
  }

  private client(): TxtClient {
    const config = this.state.loadConfig();
    const token = this.state.loadToken();
    if (!token) {
      throw new Error("no agent token is registered; run `txt-agent set-token` first");
    }
    if (token.expiresAt <= Date.now()) {
      throw new Error("the agent token has expired; issue a new one from the Web settings");
    }
    return new TxtClient(config.apiBase, token.token);
  }

  /** Fetches the wrap and recovers the VaultKey into memory (design §8.2). */
  async unlock(): Promise<UnlockedState> {
    if (this.unlocked) return this.unlocked;
    const keyPair = this.state.loadKeyPair();
    if (!keyPair) throw new Error("no agent key pair; run `txt-agent enroll` first");
    const privateKey = await importAgentPrivateKey(keyPair.privateKeyJwk);
    const envelope = await this.client().envelope();
    const vaultKey = await unwrapVaultKeyForAgent({
      privateKey,
      wrap: {
        ephemeralPublicKey: fromBase64Url(envelope.ephemeralPublicKey),
        wrapSalt: fromBase64Url(envelope.wrapSalt32),
        nonce: fromBase64Url(envelope.nonce),
        wrappedKey: fromBase64Url(envelope.wrappedKey),
        formatVersion: envelope.formatVersion,
        keyVersion: envelope.keyVersion,
      },
      accountId: envelope.accountId,
      agentId: envelope.agentId,
    });
    this.unlocked = {
      vaultKey,
      accountId: envelope.accountId,
      agentId: envelope.agentId,
      displayName: envelope.displayName,
      lastEtag: null,
      lastDocument: null,
      lastRevision: null,
    };
    return this.unlocked;
  }

  lock(): void {
    this.unlocked = null;
  }

  private async decryptDocument(
    session: UnlockedState,
    document: DocumentResponse,
  ): Promise<DocumentModel> {
    const key = await deriveDocumentKey(
      session.vaultKey,
      document.mutationId,
      document.accountId,
      document.documentId,
      document.keyVersion,
    );
    const plaintext = await aesGcmDecrypt(
      key,
      fromBase64Url(document.nonce),
      fromBase64Url(document.ciphertext),
      documentAad(
        document.formatVersion,
        document.keyVersion,
        document.accountId,
        document.documentId,
        document.mutationId,
        document.encryptedRevision,
      ),
    );
    // Unknown shapes fail closed (design §8.4 step 2): never re-serialize or
    // return partial content from an invalid model.
    return validateOrThrow(parseDocument(plaintext));
  }

  /** Unconditional fetch + decrypt: the server is always authoritative. */
  private async fetchCurrent(): Promise<CurrentDocument> {
    const session = await this.unlock();
    const { document, etag } = await this.client().document();
    if (!document) throw new Error("document unavailable");
    const model = await this.decryptDocument(session, document);
    session.lastDocument = model;
    session.lastRevision = document.revision;
    session.lastEtag = etag;
    return { response: document, etag, model };
  }

  /**
   * Fetches and decrypts the current document. A conditional GET is used,
   * but the cache is never treated as authoritative: whenever the server
   * answers 200 the new ciphertext is decrypted and validated (design §8.3).
   */
  async readDocument(): Promise<{
    model: DocumentModel;
    text: string;
    revision: number;
    etag: string | null;
    updatedAt: number;
  }> {
    const session = await this.unlock();
    const { document, etag } = await this.client().document(session.lastEtag ?? undefined);
    if (!document) {
      if (!session.lastDocument || session.lastRevision === null) {
        throw new Error("document unavailable");
      }
      return {
        model: session.lastDocument,
        text: plainTextForCopy(session.lastDocument),
        revision: session.lastRevision,
        etag: session.lastEtag,
        updatedAt: 0,
      };
    }
    const model = await this.decryptDocument(session, document);
    session.lastDocument = model;
    session.lastRevision = document.revision;
    session.lastEtag = etag;
    return { model, text: plainTextForCopy(model), revision: document.revision, etag, updatedAt: document.updatedAt };
  }

  /** Metadata-only status (design §8.3 `txt_status`): never returns content. */
  async status(): Promise<{
    agentId: string | null;
    displayName: string | null;
    locked: boolean;
    tokenExpiresAt: number | null;
    revision: number | null;
    updatedAt: number | null;
  }> {
    const config = this.state.loadConfig();
    const token = this.state.loadToken();
    const base = {
      agentId: config.agentId,
      displayName: config.displayName,
      locked: !this.isUnlocked,
      tokenExpiresAt: token?.expiresAt ?? null,
      revision: null as number | null,
      updatedAt: null as number | null,
    };
    if (!token) return base;
    const { document } = await this.client().document();
    if (!document) return base;
    return { ...base, revision: document.revision, updatedAt: document.updatedAt };
  }

  /* ---------------------------------------------------------------- */
  /* Writes (phase 2)                                                  */
  /* ---------------------------------------------------------------- */

  /** Serializes writes inside this process (design §8.4). */
  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async encryptModel(
    session: UnlockedState,
    meta: DocumentResponse,
    model: DocumentModel,
    mutationId: string,
    encryptedRevision: number,
  ): Promise<{ nonce: string; ciphertext: string }> {
    const key = await deriveDocumentKey(
      session.vaultKey,
      mutationId,
      meta.accountId,
      meta.documentId,
      meta.keyVersion,
    );
    const nonce = randomBytes(NONCE_BYTES);
    const ciphertext = await aesGcmEncrypt(
      key,
      nonce,
      new TextEncoder().encode(serializeDocument(model)),
      documentAad(
        meta.formatVersion,
        meta.keyVersion,
        meta.accountId,
        meta.documentId,
        mutationId,
        encryptedRevision,
      ),
    );
    return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) };
  }

  private backupRecord(current: CurrentDocument): CiphertextBackup {
    const doc = current.response;
    return {
      version: 1,
      savedAt: Date.now(),
      accountId: doc.accountId,
      documentId: doc.documentId,
      syncEpoch: doc.syncEpoch,
      revision: doc.revision,
      encryptedRevision: doc.encryptedRevision,
      formatVersion: doc.formatVersion,
      keyVersion: doc.keyVersion,
      mutationId: doc.mutationId,
      etag: current.etag,
      nonce: doc.nonce,
      ciphertext: doc.ciphertext,
      referencedMediaIds: [...doc.referencedMediaIds],
      updatedAt: doc.updatedAt,
    };
  }

  /**
   * The one write path every write tool funnels through (design §8.4):
   * fetch → decrypt → validate → mutate → media-set guard → pre-write
   * ciphertext backup → encrypt with a fresh mutationId → CAS PUT.
   * A 412 returns a conflict outcome with the base→latest diff; it never
   * retries into an overwrite and never auto-merges (§9.4).
   */
  private async performWrite(
    attempted: string,
    mutate: (base: DocumentModel) => MutationResult,
  ): Promise<WriteOutcome> {
    return this.enqueueWrite(async () => {
      const session = await this.unlock();
      const base = await this.fetchCurrent();
      const mutation = mutate(base.model);
      if ("reject" in mutation) {
        return { status: "rejected", ...mutation.reject } as WriteOutcome;
      }
      const next = validateOrThrow(mutation.model as unknown);
      const baseRefs = [...base.response.referencedMediaIds].sort();
      const nextRefs = referencedMediaIds(next);
      if (nextRefs.join("\0") !== baseRefs.join("\0")) {
        // Design §9.3: an agent write must never change the media set —
        // dropping a fileKey from the model would orphan the attachment.
        throw new Error("write would change the referenced media set; refused");
      }
      if (documentJsonBytes(next) > MAX_DOCUMENT_JSON_BYTES) {
        throw new Error("write would exceed the document size limit; refused");
      }

      // §9.5 insurance: keep the pre-write ciphertext before sending ours.
      this.state.saveCiphertextBackup(this.backupRecord(base));

      const mutationId = crypto.randomUUID();
      const encryptedRevision = base.response.revision + 1;
      const encrypted = await this.encryptModel(
        session,
        base.response,
        next,
        mutationId,
        encryptedRevision,
      );
      const payload: DocumentUpdatePayload = {
        mutationId,
        formatVersion: base.response.formatVersion,
        keyVersion: base.response.keyVersion,
        encryptedRevision,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        referencedMediaIds: nextRefs,
      };
      if (!base.etag) throw new Error("server did not return an ETag for the current document");
      try {
        const result = await this.client().putDocument(payload, base.etag);
        session.lastDocument = next;
        session.lastRevision = result.revision;
        session.lastEtag = result.etag;
        return {
          status: "saved",
          revision: result.revision,
          etag: result.etag,
          mutationId: result.mutationId,
        } as WriteOutcome;
      } catch (error) {
        if (error instanceof AgentApiError && error.status === 412) {
          const latest = await this.fetchCurrent();
          return {
            status: "conflict",
            attempted,
            baseRevision: base.response.revision,
            latestRevision: latest.response.revision,
            diff: diffTexts(plainTextForCopy(base.model), plainTextForCopy(latest.model)),
            latestText: plainTextForCopy(latest.model),
          } as WriteOutcome;
        }
        if (error instanceof TypeError) {
          // The response may have been lost after the server applied the
          // write. Per §10.3, resolve by mutationId instead of resending
          // blindly: if the stored mutation is ours, the write landed.
          const latest = await this.fetchCurrent().catch(() => null);
          if (latest && latest.response.mutationId === mutationId) {
            session.lastDocument = next;
            session.lastRevision = latest.response.revision;
            session.lastEtag = latest.etag;
            return {
              status: "saved",
              revision: latest.response.revision,
              etag: latest.etag,
              mutationId,
            } as WriteOutcome;
          }
        }
        throw error;
      }
    });
  }

  /** `txt_append`: the default write path (design §9.1). */
  async appendText(text: string): Promise<WriteOutcome> {
    if (typeof text !== "string") throw new Error("text must be a string");
    return this.performWrite("append", (base) => ({ model: appendToModel(base, text) }));
  }

  /**
   * `txt_replace` (design §9.2): approval-gated at the MCP layer. Without
   * `confirm`, nothing is written and the caller gets a diff preview of
   * what WOULD change. With `confirm`, `expectedText` must still match
   * the block exactly or the write is refused with the current content.
   */
  async replaceBlock(options: {
    blockId: string;
    expectedText: string;
    newText: string;
    confirm?: boolean;
  }): Promise<WriteOutcome> {
    if (!options.confirm) {
      const current = await this.fetchCurrent();
      const probe = replaceBlockInModel(
        current.model,
        options.blockId,
        options.expectedText,
        options.newText,
      );
      if ("reason" in probe) {
        return { status: "rejected", reason: probe.reason, currentText: probe.currentText };
      }
      return {
        status: "preview",
        description:
          "txt_replace is approval-gated: nothing was written. Re-call with confirm: true and the same expected_text to apply this change.",
        diff: diffTexts(plainTextForCopy(current.model), plainTextForCopy(probe.model)),
      };
    }
    return this.performWrite("replace block", (base) => {
      const result = replaceBlockInModel(base, options.blockId, options.expectedText, options.newText);
      if ("reason" in result) {
        return { reject: { reason: result.reason, currentText: result.currentText } };
      }
      return { model: result.model };
    });
  }

  /**
   * `txt_search_replace` (design §9.2): same approval gate as txt_replace,
   * plus the exactly-one-occurrence rule of §8.3. Zero or multiple matches
   * write nothing.
   */
  async searchReplace(options: {
    find: string;
    replacement: string;
    confirm?: boolean;
  }): Promise<WriteOutcome> {
    if (!options.confirm) {
      const current = await this.fetchCurrent();
      const probe = searchReplaceInModel(current.model, options.find, options.replacement);
      if ("matchCount" in probe) {
        return {
          status: "rejected",
          reason: `find matched ${probe.matchCount} occurrence(s); exactly one is required`,
          matchCount: probe.matchCount,
          blockIds: probe.blockIds,
        };
      }
      return {
        status: "preview",
        description:
          "txt_search_replace is approval-gated: nothing was written. Re-call with confirm: true to apply this change.",
        diff: diffTexts(plainTextForCopy(current.model), plainTextForCopy(probe.model)),
      };
    }
    return this.performWrite("search & replace", (base) => {
      const result = searchReplaceInModel(base, options.find, options.replacement);
      if ("matchCount" in result) {
        return {
          reject: {
            reason: `find matched ${result.matchCount} occurrence(s); exactly one is required`,
            matchCount: result.matchCount,
            blockIds: result.blockIds,
          },
        };
      }
      return { model: result.model };
    });
  }

  /** Backup generations currently stored (metadata only, no ciphertext). */
  listBackups(): Array<{ savedAt: number; revision: number; documentId: string }> {
    return this.state.loadCiphertextBackups().map((entry) => ({
      savedAt: entry.savedAt,
      revision: entry.revision,
      documentId: entry.documentId,
    }));
  }

  private async decryptBackup(
    session: UnlockedState,
    backup: CiphertextBackup,
  ): Promise<DocumentModel> {
    const model = await this.decryptDocument(session, {
      accountId: backup.accountId,
      documentId: backup.documentId,
      syncEpoch: backup.syncEpoch,
      revision: backup.revision,
      encryptedRevision: backup.encryptedRevision,
      formatVersion: backup.formatVersion,
      keyVersion: backup.keyVersion,
      mutationId: backup.mutationId,
      nonce: backup.nonce,
      ciphertext: backup.ciphertext,
      referencedMediaIds: backup.referencedMediaIds,
      updatedAt: backup.updatedAt,
    });
    const issues = validateDocument(model);
    if (issues.length > 0) throw new Error("stored backup failed validation; rollback refused");
    return model;
  }

  /**
   * `txt_rollback` (design §9.5): restores the newest pre-write ciphertext
   * backup. The backup is decrypted locally and re-encrypted for the
   * CURRENT revision (its AAD binds the old encryptedRevision, so the raw
   * ciphertext cannot be replayed as-is), then saved through the same CAS
   * path as every other write — including a fresh backup of the state
   * being rolled back, so a rollback is itself undoable. Approval-gated:
   * without `confirm`, only a preview diff is returned.
   */
  async rollback(options: { confirm?: boolean } = {}): Promise<WriteOutcome> {
    const backups = this.state.loadCiphertextBackups();
    const target = backups[0];
    if (!target) return { status: "rejected", reason: "no ciphertext backups are stored" };
    const session = await this.unlock();
    const targetModel = await this.decryptBackup(session, target);
    if (!options.confirm) {
      const current = await this.fetchCurrent();
      return {
        status: "preview",
        description:
          `txt_rollback is approval-gated: nothing was written. The newest backup is revision ${target.revision} ` +
          `(saved ${new Date(target.savedAt).toISOString()}). Re-call with confirm: true to restore it.`,
        diff: diffTexts(plainTextForCopy(current.model), plainTextForCopy(targetModel)),
      };
    }
    return this.performWrite(`rollback to revision ${target.revision}`, (base) => {
      const baseRefs = referencedMediaIds(base);
      const targetRefs = referencedMediaIds(targetModel);
      if (baseRefs.join("\0") !== targetRefs.join("\0")) {
        return {
          reject: {
            reason: "the referenced media set changed since the backup; rollback refused",
          },
        };
      }
      return { model: cloneModel(targetModel) };
    });
  }
}
