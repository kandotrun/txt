/**
 * Agent MCP vault tests (design §8.2, §10 phase 1): the MCP side unwraps
 * the VaultKey from the server-stored wrap and decrypts the document
 * against a stub Worker API. No plaintext, key or token is logged.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  exportAgentPrivateKeyJwk,
  exportAgentPublicKey,
  generateAgentKeyPair,
  wrapVaultKeyForAgent,
} from "../../packages/protocol/src/agent.ts";
import { toBase64Url } from "../../packages/protocol/src/base64url.ts";
import {
  aesGcmEncrypt,
  deriveDocumentKey,
  documentAad,
} from "../../packages/protocol/src/crypto.ts";
import {
  serializeDocument,
} from "../../packages/protocol/src/document.ts";
import type { DocumentModel } from "../../packages/protocol/src/document.ts";
import { AgentState } from "../../apps/agent-mcp/src/config.ts";
import { AgentVault } from "../../apps/agent-mcp/src/vault.ts";

const ACCOUNT_ID = "8cf3a2b1-0000-4000-8000-000000000001";
const AGENT_ID = "8cf3a2b1-0000-4000-8000-0000000000a1";
const DOCUMENT_ID = "8cf3a2b1-0000-4000-8000-000000000002";
const VAULT_KEY = new Uint8Array(32).fill(0x2a);
const TOKEN = "txta1.test-token-for-local-stub";

let server: Server;
let stateDir: string;
let vault: AgentVault;

beforeAll(async () => {
  const keyPair = await generateAgentKeyPair();
  const publicKey = await exportAgentPublicKey(keyPair.publicKey);
  const wrap = await wrapVaultKeyForAgent({
    vaultKey: VAULT_KEY,
    agentPublicKey: publicKey,
    accountId: ACCOUNT_ID,
    agentId: AGENT_ID,
  });

  const mutationId = "8cf3a2b1-0000-4000-8000-000000000003";
  const model: DocumentModel = {
    schemaVersion: 1,
    blocks: [
      { id: "8cf3a2b1-0000-4000-8000-000000000004", type: "text", text: "mcp read test\n" },
      { id: "8cf3a2b1-0000-4000-8000-000000000005", type: "media", mediaId: "8cf3a2b1-0000-4000-8000-000000000006" },
      { id: "8cf3a2b1-0000-4000-8000-000000000007", type: "text", text: "after media" },
    ],
    media: {
      "8cf3a2b1-0000-4000-8000-000000000006": {
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
  const docKey = await deriveDocumentKey(VAULT_KEY, mutationId, ACCOUNT_ID, DOCUMENT_ID, 1);
  const nonce = new Uint8Array(12).fill(3);
  const ciphertext = await aesGcmEncrypt(
    docKey,
    nonce,
    new TextEncoder().encode(serializeDocument(model)),
    documentAad(1, 1, ACCOUNT_ID, DOCUMENT_ID, mutationId, 0),
  );

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
  const document = {
    accountId: ACCOUNT_ID,
    documentId: DOCUMENT_ID,
    syncEpoch: 1,
    revision: 7,
    encryptedRevision: 0,
    formatVersion: 1,
    keyVersion: 1,
    mutationId,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(ciphertext),
    referencedMediaIds: ["8cf3a2b1-0000-4000-8000-000000000006"],
    updatedAt: 1_700_000_000_000,
  };

  server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no" } }));
      return;
    }
    if (request.url === "/api/v1/agent/envelope") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(envelope));
      return;
    }
    if (request.url === "/api/v1/document") {
      response.writeHead(200, { "content-type": "application/json", etag: `"d-${DOCUMENT_ID}-e-1-r7"` });
      response.end(JSON.stringify(document));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub server has no port");
  const apiBase = `http://127.0.0.1:${address.port}`;

  stateDir = mkdtempSync(path.join(tmpdir(), "txt-agent-test-"));
  process.env.TXT_AGENT_HOME = stateDir;
  const state = new AgentState();
  state.saveConfig({ apiBase, agentId: AGENT_ID, displayName: "Test Agent" });
  state.saveKeyPair({
    privateKeyJwk: await exportAgentPrivateKeyJwk(keyPair.privateKey),
    publicKey: toBase64Url(publicKey),
  });
  state.saveToken({ token: TOKEN, tokenId: "token-1", expiresAt: Date.now() + 60_000 });
  vault = new AgentVault(state);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  delete process.env.TXT_AGENT_HOME;
});

describe("agent MCP vault", () => {
  it("unwraps the VaultKey and decrypts the document, rendering media as placeholders", async () => {
    const result = await vault.readDocument();
    expect(result.revision).toBe(7);
    expect(result.text).toBe("mcp read test\n[画像: photo.jpg]after media");
    expect(vault.isUnlocked).toBe(true);
  });

  it("reports metadata-only status", async () => {
    const status = await vault.status();
    expect(status.agentId).toBe(AGENT_ID);
    expect(status.revision).toBe(7);
    expect(status.updatedAt).toBe(1_700_000_000_000);
    expect(JSON.stringify(status)).not.toContain("mcp read test");
  });
});
