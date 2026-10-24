/**
 * The agent-side vault: unwraps the VaultKey locally and decrypts the
 * document with the shared protocol contract.
 *
 * Boundary (design §2.3): the VaultKey and plaintext exist only in this
 * process's memory. The server only ever sees the Bearer token and returns
 * ciphertext. Nothing in this file logs keys, tokens or plaintext.
 */

import {
  importAgentPrivateKey,
  unwrapVaultKeyForAgent,
} from "../../../packages/protocol/src/agent.ts";
import { fromBase64Url } from "../../../packages/protocol/src/base64url.ts";
import {
  aesGcmDecrypt,
  deriveDocumentKey,
  documentAad,
} from "../../../packages/protocol/src/crypto.ts";
import {
  parseDocument,
  plainTextForCopy,
  validateOrThrow,
} from "../../../packages/protocol/src/document.ts";
import type { DocumentModel } from "../../../packages/protocol/src/document.ts";
import type { AgentState } from "./config.ts";

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
}

interface UnlockedState {
  vaultKey: Uint8Array;
  accountId: string;
  agentId: string;
  displayName: string;
  lastEtag: string | null;
  lastDocument: DocumentModel | null;
  lastRevision: number | null;
}

export class AgentVault {
  private unlocked: UnlockedState | null = null;

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
    const model = validateOrThrow(parseDocument(plaintext));
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
}
