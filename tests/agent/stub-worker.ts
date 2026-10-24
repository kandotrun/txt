/**
 * Stateful stub Worker for agent MCP tests: serves the agent envelope and
 * implements the real document CAS contract (If-Match required,
 * encryptedRevision check, mutationId idempotency no-op) over the shared
 * protocol encryption, so vault/write/smoke tests exercise the same byte
 * formats as production. Test-only code — nothing here is shipped.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";

import {
  exportAgentPrivateKeyJwk,
  exportAgentPublicKey,
  generateAgentKeyPair,
  wrapVaultKeyForAgent,
} from "../../packages/protocol/src/agent.ts";
import { fromBase64Url, toBase64Url } from "../../packages/protocol/src/base64url.ts";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveDocumentKey,
  documentAad,
} from "../../packages/protocol/src/crypto.ts";
import {
  parseDocument,
  plainTextForCopy,
  serializeDocument,
} from "../../packages/protocol/src/document.ts";
import type { DocumentModel } from "../../packages/protocol/src/document.ts";

export const ACCOUNT_ID = "8cf3a2b1-0000-4000-8000-000000000001";
export const AGENT_ID = "8cf3a2b1-0000-4000-8000-0000000000a1";
export const DOCUMENT_ID = "8cf3a2b1-0000-4000-8000-000000000002";
export const MEDIA_ID = "8cf3a2b1-0000-4000-8000-000000000006";
export const VAULT_KEY = new Uint8Array(32).fill(0x2a);
export const TOKEN = "txta1.test-token-for-local-stub";
export const FIRST_TEXT_ID = "8cf3a2b1-0000-4000-8000-000000000004";
export const MEDIA_BLOCK_ID = "8cf3a2b1-0000-4000-8000-000000000005";
export const TAIL_TEXT_ID = "8cf3a2b1-0000-4000-8000-000000000007";

export function textOnlyModel(text: string): DocumentModel {
  return {
    schemaVersion: 1,
    blocks: [{ id: FIRST_TEXT_ID, type: "text", text }],
    media: {},
  };
}

export function mediaModel(): DocumentModel {
  return {
    schemaVersion: 1,
    blocks: [
      { id: FIRST_TEXT_ID, type: "text", text: "before\n" },
      { id: MEDIA_BLOCK_ID, type: "media", mediaId: MEDIA_ID },
      { id: TAIL_TEXT_ID, type: "text", text: "after" },
    ],
    media: {
      [MEDIA_ID]: {
        kind: "image",
        name: "photo.jpg",
        mime: "image/jpeg",
        plainBytes: 100,
        cryptoFormat: 1,
        chunkBytes: 1_048_576,
        chunkCount: 1,
        noncePrefix: toBase64Url(new Uint8Array(8).fill(7)),
        fileKey: toBase64Url(new Uint8Array(32).fill(9)),
      },
    },
  };
}

export async function encryptModel(
  model: DocumentModel,
  mutationId: string,
  encryptedRevision: number,
) {
  const docKey = await deriveDocumentKey(VAULT_KEY, mutationId, ACCOUNT_ID, DOCUMENT_ID, 1);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await aesGcmEncrypt(
    docKey,
    nonce,
    new TextEncoder().encode(serializeDocument(model)),
    documentAad(1, 1, ACCOUNT_ID, DOCUMENT_ID, mutationId, encryptedRevision),
  );
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) };
}

export interface StubRecord {
  revision: number;
  encryptedRevision: number;
  mutationId: string;
  nonce: string;
  ciphertext: string;
  referencedMediaIds: string[];
  updatedAt: number;
}

export class StubWorker {
  server!: Server;
  record!: StubRecord;
  putAttempts = 0;
  publicKeyB64 = "";
  privateKeyJwk: JsonWebKey = {};
  private hijackModel: DocumentModel | null = null;
  private dropNextPutResponse = false;

  async start(model: DocumentModel): Promise<string> {
    const mutationId = crypto.randomUUID();
    const encrypted = await encryptModel(model, mutationId, 0);
    this.record = {
      revision: 0,
      encryptedRevision: 0,
      mutationId,
      ...encrypted,
      referencedMediaIds: Object.keys(model.media).sort(),
      updatedAt: 1_700_000_000_000,
    };

    const keyPair = await generateAgentKeyPair();
    const publicKey = await exportAgentPublicKey(keyPair.publicKey);
    const wrap = await wrapVaultKeyForAgent({
      vaultKey: VAULT_KEY,
      agentPublicKey: publicKey,
      accountId: ACCOUNT_ID,
      agentId: AGENT_ID,
    });
    const envelope = {
      agentId: AGENT_ID,
      accountId: ACCOUNT_ID,
      displayName: "Test Agent",
      formatVersion: wrap.formatVersion,
      keyVersion: wrap.keyVersion,
      ephemeralPublicKey: toBase64Url(wrap.ephemeralPublicKey),
      wrapSalt32: toBase64Url(wrap.wrapSalt),
      nonce: toBase64Url(wrap.nonce),
      wrappedKey: toBase64Url(wrap.wrappedKey),
    };

    this.server = createServer((request, response) => {
      void this.handle(request, response, envelope);
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("stub server has no port");
    this.publicKeyB64 = toBase64Url(publicKey);
    this.privateKeyJwk = await exportAgentPrivateKeyJwk(keyPair.privateKey);
    return `http://127.0.0.1:${address.port}`;
  }

  private etag(): string {
    return `"d-${DOCUMENT_ID}-e-1-r${this.record.revision}"`;
  }

  private async applyModel(model: DocumentModel): Promise<void> {
    const mutationId = crypto.randomUUID();
    const encrypted = await encryptModel(model, mutationId, this.record.revision + 1);
    this.record = {
      revision: this.record.revision + 1,
      encryptedRevision: this.record.revision + 1,
      mutationId,
      ...encrypted,
      referencedMediaIds: Object.keys(model.media).sort(),
      updatedAt: Date.now(),
    };
  }

  /** Simulates a concurrent (browser) edit landing mid-PUT. */
  hijackNextPutWith(model: DocumentModel): void {
    this.hijackModel = model;
  }

  /** Simulates the PUT being applied but its response being lost. */
  dropResponseOfNextPut(): void {
    this.dropNextPutResponse = true;
  }

  private async handle(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
    envelope: unknown,
  ): Promise<void> {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no" } }));
      return;
    }
    if (request.url === "/api/v1/agent/envelope" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(envelope));
      return;
    }
    if (request.url === "/api/v1/document" && request.method === "GET") {
      if (request.headers["if-none-match"] === this.etag()) {
        response.writeHead(304, { etag: this.etag() });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", etag: this.etag() });
      response.end(
        JSON.stringify({
          accountId: ACCOUNT_ID,
          documentId: DOCUMENT_ID,
          syncEpoch: 1,
          formatVersion: 1,
          keyVersion: 1,
          ...this.record,
        }),
      );
      return;
    }
    if (request.url === "/api/v1/document" && request.method === "PUT") {
      this.putAttempts++;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        mutationId: string;
        encryptedRevision: number;
        nonce: string;
        ciphertext: string;
        referencedMediaIds: string[];
      };
      if (this.hijackModel) {
        const model = this.hijackModel;
        this.hijackModel = null;
        await this.applyModel(model);
        response.writeHead(412, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { code: "PRECONDITION_FAILED", message: "stale ETag" } }),
        );
        return;
      }
      if (request.headers["if-match"] !== this.etag()) {
        response.writeHead(412, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { code: "PRECONDITION_FAILED", message: "stale ETag" } }),
        );
        return;
      }
      if (body.mutationId === this.record.mutationId) {
        // Idempotent re-send of the last mutation (§10.3): a no-op success.
        response.writeHead(200, { "content-type": "application/json", etag: this.etag() });
        response.end(
          JSON.stringify({
            etag: this.etag(),
            revision: this.record.revision,
            mutationId: body.mutationId,
            updatedAt: this.record.updatedAt,
          }),
        );
        return;
      }
      if (body.encryptedRevision !== this.record.revision + 1) {
        response.writeHead(412, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { code: "PRECONDITION_FAILED", message: "bad revision" } }),
        );
        return;
      }
      this.record = {
        revision: this.record.revision + 1,
        encryptedRevision: body.encryptedRevision,
        mutationId: body.mutationId,
        nonce: body.nonce,
        ciphertext: body.ciphertext,
        referencedMediaIds: body.referencedMediaIds,
        updatedAt: Date.now(),
      };
      if (this.dropNextPutResponse) {
        this.dropNextPutResponse = false;
        response.socket?.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", etag: this.etag() });
      response.end(
        JSON.stringify({
          etag: this.etag(),
          revision: this.record.revision,
          mutationId: body.mutationId,
          updatedAt: this.record.updatedAt,
        }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no" } }));
  }

  async currentModel(): Promise<DocumentModel> {
    const docKey = await deriveDocumentKey(
      VAULT_KEY,
      this.record.mutationId,
      ACCOUNT_ID,
      DOCUMENT_ID,
      1,
    );
    const plaintext = await aesGcmDecrypt(
      docKey,
      fromBase64Url(this.record.nonce),
      fromBase64Url(this.record.ciphertext),
      documentAad(1, 1, ACCOUNT_ID, DOCUMENT_ID, this.record.mutationId, this.record.encryptedRevision),
    );
    return parseDocument(plaintext);
  }

  async currentText(): Promise<string> {
    return plainTextForCopy(await this.currentModel());
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
