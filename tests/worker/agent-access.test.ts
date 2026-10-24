/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Agent access integration tests (agent design §10 phase 1 acceptance):
 * enrollment -> public key -> wrap -> canary -> token -> read, plus
 * revocation, expiry, and scope enforcement. Accounts/sessions/documents
 * are seeded directly in D1 (session rows with a fresh step-up stamp), so
 * the agent surface is tested without WebAuthn machinery; the document is
 * encrypted with the real protocol contract under a known VaultKey.
 */

import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  createAgentCanary,
  decryptAgentCanary,
  exportAgentPublicKey,
  generateAgentKeyPair,
  unwrapVaultKeyForAgent,
  wrapVaultKeyForAgent,
} from "../../packages/protocol/src/agent.ts";
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
import { fromBase64Url, toBase64Url } from "../../packages/protocol/src/base64url.ts";

const BASE = "https://txt.2-38.com";
const TEST_ENV = env as unknown as { DB: D1Database };

const webHeaders = {
  origin: BASE,
  "x-txt-request": "1",
  "content-type": "application/json",
};

function b64(bytes: Uint8Array | ArrayBuffer): string {
  return toBase64Url(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

function random(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

interface SeededAccount {
  accountId: string;
  sessionToken: string;
  cookie: string;
  documentId: string;
  vaultKey: Uint8Array;
  mutationId: string;
}

async function seedAccount(options: { stepUp?: boolean } = {}): Promise<SeededAccount> {
  const accountId = crypto.randomUUID();
  const documentId = crypto.randomUUID();
  const vaultKey = random(32);
  const mutationId = crypto.randomUUID();
  const now = Date.now();

  const model: DocumentModel = {
    schemaVersion: 1,
    blocks: [{ id: crypto.randomUUID(), type: "text", text: "phase1 agent read\n" }],
    media: {},
  };
  const docKey = await deriveDocumentKey(vaultKey, mutationId, accountId, documentId, 1);
  const nonce = random(12);
  const ciphertext = await aesGcmEncrypt(
    docKey,
    nonce,
    new TextEncoder().encode(serializeDocument(model)),
    documentAad(1, 1, accountId, documentId, mutationId, 0),
  );

  const sessionToken = `test-session-${crypto.randomUUID()}`;
  const tokenHash = await sha256(new TextEncoder().encode(sessionToken));

  await TEST_ENV.DB.batch([
    TEST_ENV.DB.prepare(
      `INSERT INTO accounts (id, user_handle, display_label, status, auth_epoch, created_at, activated_at)
       VALUES (?1, ?2, 'txt-test', 'active', 0, ?3, ?3)`,
    ).bind(accountId, random(32).buffer as ArrayBuffer, now),
    TEST_ENV.DB.prepare(
      `INSERT INTO sessions (token_hash32, sid, account_id, client_kind, scope, auth_epoch,
                             created_at, absolute_expires_at, idle_expires_at, stepup_at)
       VALUES (?1, ?2, ?3, 'web', 'active', 0, ?4, ?5, ?6, ?7)`,
    ).bind(
      tokenHash.buffer as ArrayBuffer,
      crypto.randomUUID(),
      accountId,
      now,
      now + 45 * 24 * 3600 * 1000,
      now + 30 * 24 * 3600 * 1000,
      options.stepUp === false ? null : now,
    ),
    TEST_ENV.DB.prepare(
      `INSERT INTO documents (id, account_id, sync_epoch, revision, encrypted_revision,
                              format_version, key_version, mutation_id, nonce, ciphertext,
                              last_payload_hash32, updated_at)
       VALUES (?1, ?2, 1, 0, 0, 1, 1, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      documentId,
      accountId,
      mutationId,
      nonce.buffer as ArrayBuffer,
      ciphertext.buffer as ArrayBuffer,
      random(32).buffer as ArrayBuffer,
      now,
    ),
  ]);

  return {
    accountId,
    sessionToken,
    cookie: `__Host-txt_session=${sessionToken}`,
    documentId,
    vaultKey,
    mutationId,
  };
}

async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

interface EnrolledAgent {
  agentId: string;
  token: string;
  keyPair: CryptoKeyPair;
}

/** Runs the full enrollment dance and returns an active agent + read token. */
async function enrollAgent(account: SeededAccount): Promise<EnrolledAgent> {
  const cookieHeaders = { ...webHeaders, cookie: account.cookie };

  const created = await postJson("/api/v1/agents/enrollments", { displayName: "Test Agent" }, cookieHeaders);
  expect(created.status).toBe(201);
  const { agentId, pairingCode } = (await created.json()) as {
    agentId: string;
    pairingCode: string;
  };

  const keyPair = await generateAgentKeyPair();
  const publicKey = await exportAgentPublicKey(keyPair.publicKey);

  const submitted = await postJson(
    `/api/v1/agents/enrollments/${agentId}/pubkey`,
    { pairingCode, publicKey: b64(publicKey), displayName: "Test Agent" },
    { "content-type": "application/json" },
  );
  expect(submitted.status).toBe(200);
  const submittedBody = (await submitted.json()) as { fingerprint: string };
  expect(submittedBody.fingerprint).toBe(b64(await sha256(publicKey)));

  const wrap = await wrapVaultKeyForAgent({
    vaultKey: account.vaultKey,
    agentPublicKey: publicKey,
    accountId: account.accountId,
    agentId,
  });
  const canary = await createAgentCanary(account.vaultKey, agentId);
  const wrapped = await postJson(
    `/api/v1/agents/${agentId}/wrap`,
    {
      formatVersion: wrap.formatVersion,
      keyVersion: wrap.keyVersion,
      ephemeralPublicKey: b64(wrap.ephemeralPublicKey),
      wrapSalt32: b64(wrap.wrapSalt),
      nonce: b64(wrap.nonce),
      wrappedKey: b64(wrap.wrappedKey),
      canaryNonce: b64(canary.nonce),
      canaryCiphertext: b64(canary.ciphertext),
      canaryHash32: b64(canary.plaintextHash),
    },
    cookieHeaders,
  );
  expect(wrapped.status).toBe(200);

  const challenge = await postJson(
    `/api/v1/agents/enrollments/${agentId}/canary-challenge`,
    { pairingCode },
    { "content-type": "application/json" },
  );
  expect(challenge.status).toBe(200);
  const challengeBody = (await challenge.json()) as {
    canaryNonce: string;
    canaryCiphertext: string;
  };

  // Agent side: unwrap with the private key, decrypt the canary, submit it.
  const recoveredVaultKey = await unwrapVaultKeyForAgent({
    privateKey: keyPair.privateKey,
    wrap: {
      ephemeralPublicKey: wrap.ephemeralPublicKey,
      wrapSalt: wrap.wrapSalt,
      nonce: wrap.nonce,
      wrappedKey: wrap.wrappedKey,
      formatVersion: wrap.formatVersion,
      keyVersion: wrap.keyVersion,
    },
    accountId: account.accountId,
    agentId,
  });
  const canaryPlaintext = await decryptAgentCanary(
    recoveredVaultKey,
    agentId,
    fromBase64Url(challengeBody.canaryNonce),
    fromBase64Url(challengeBody.canaryCiphertext),
  );
  const activated = await postJson(
    `/api/v1/agents/enrollments/${agentId}/canary`,
    { pairingCode, canaryPlaintext: b64(canaryPlaintext) },
    { "content-type": "application/json" },
  );
  expect(activated.status).toBe(200);

  const issued = await postJson(`/api/v1/agents/${agentId}/tokens`, {}, cookieHeaders);
  expect(issued.status).toBe(201);
  const { token } = (await issued.json()) as { token: string };
  expect(token.startsWith("txta1.")).toBe(true);

  return { agentId, token, keyPair };
}

describe("agent access phase 1", () => {
  it("enrolls, activates via canary, and reads the decrypted document end to end", async () => {
    const account = await seedAccount();
    const agent = await enrollAgent(account);
    const bearer = { authorization: `Bearer ${agent.token}` };

    const envelopeResponse = await SELF.fetch(`${BASE}/api/v1/agent/envelope`, {
      headers: bearer,
    });
    expect(envelopeResponse.status).toBe(200);
    const envelope = (await envelopeResponse.json()) as {
      agentId: string;
      accountId: string;
      ephemeralPublicKey: string;
      wrapSalt32: string;
      nonce: string;
      wrappedKey: string;
      formatVersion: number;
      keyVersion: number;
    };
    expect(envelope.agentId).toBe(agent.agentId);
    expect(envelope.accountId).toBe(account.accountId);

    const vaultKey = await unwrapVaultKeyForAgent({
      privateKey: agent.keyPair.privateKey,
      wrap: {
        ephemeralPublicKey: fromBase64Url(envelope.ephemeralPublicKey),
        wrapSalt: fromBase64Url(envelope.wrapSalt32),
        nonce: fromBase64Url(envelope.nonce),
        wrappedKey: fromBase64Url(envelope.wrappedKey),
        formatVersion: envelope.formatVersion,
        keyVersion: envelope.keyVersion,
      },
      accountId: account.accountId,
      agentId: agent.agentId,
    });
    expect(b64(vaultKey)).toBe(b64(account.vaultKey));

    const documentResponse = await SELF.fetch(`${BASE}/api/v1/document`, { headers: bearer });
    expect(documentResponse.status).toBe(200);
    const document = (await documentResponse.json()) as {
      accountId: string;
      mutationId: string;
      nonce: string;
      ciphertext: string;
      encryptedRevision: number;
      keyVersion: number;
    };
    expect(document.accountId).toBe(account.accountId);
    const docKey = await deriveDocumentKey(
      vaultKey,
      document.mutationId,
      document.accountId,
      account.documentId,
      document.keyVersion,
    );
    const plaintext = await aesGcmDecrypt(
      docKey,
      fromBase64Url(document.nonce),
      fromBase64Url(document.ciphertext),
      documentAad(1, document.keyVersion, document.accountId, account.documentId, document.mutationId, document.encryptedRevision),
    );
    const model = parseDocument(plaintext);
    expect(plainTextForCopy(model)).toBe("phase1 agent read\n");
  });

  it("refuses a write attempt with a read token (403) and changes nothing", async () => {
    const account = await seedAccount();
    const agent = await enrollAgent(account);
    const response = await SELF.fetch(`${BASE}/api/v1/document`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${agent.token}`,
        "content-type": "application/json",
        "if-match": `"d-${account.documentId}-e-1-r0"`,
      },
      body: JSON.stringify({
        mutationId: crypto.randomUUID(),
        formatVersion: 1,
        keyVersion: 1,
        encryptedRevision: 1,
        nonce: b64(random(12)),
        ciphertext: b64(random(64)),
        referencedMediaIds: [],
      }),
    });
    expect(response.status).toBe(403);

    const after = await SELF.fetch(`${BASE}/api/v1/document`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    const body = (await after.json()) as { revision: number };
    expect(body.revision).toBe(0);
  });

  it("answers 401 for unknown, revoked and expired tokens", async () => {
    const account = await seedAccount();
    const agent = await enrollAgent(account);
    const cookieHeaders = { ...webHeaders, cookie: account.cookie };

    const unknown = await SELF.fetch(`${BASE}/api/v1/document`, {
      headers: { authorization: `Bearer txta1.${b64(random(32))}` },
    });
    expect(unknown.status).toBe(401);

    // Expire the token in place.
    await TEST_ENV.DB.prepare(`UPDATE agent_tokens SET expires_at = ?1 WHERE agent_id = ?2`)
      .bind(Date.now() - 1, agent.agentId)
      .run();
    const expired = await SELF.fetch(`${BASE}/api/v1/document`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(expired.status).toBe(401);
    await TEST_ENV.DB.prepare(
      `UPDATE agent_tokens SET expires_at = ?1 WHERE agent_id = ?2`,
    )
      .bind(Date.now() + 30 * 24 * 3600 * 1000, agent.agentId)
      .run();

    // Revoking the agent kills its tokens.
    const revoked = await SELF.fetch(`${BASE}/api/v1/agents/${agent.agentId}`, {
      method: "DELETE",
      headers: cookieHeaders,
    });
    expect(revoked.status).toBe(200);
    const afterRevoke = await SELF.fetch(`${BASE}/api/v1/document`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(afterRevoke.status).toBe(401);
    const envelopeAfterRevoke = await SELF.fetch(`${BASE}/api/v1/agent/envelope`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(envelopeAfterRevoke.status).toBe(401);
  });

  it("revoking a single token stops that token only", async () => {
    const account = await seedAccount();
    const agent = await enrollAgent(account);
    const cookieHeaders = { ...webHeaders, cookie: account.cookie };

    const second = await postJson(`/api/v1/agents/${agent.agentId}/tokens`, {}, cookieHeaders);
    const { token: secondToken, tokenId: secondTokenId } = (await second.json()) as {
      token: string;
      tokenId: string;
    };
    const drop = await SELF.fetch(
      `${BASE}/api/v1/agents/${agent.agentId}/tokens/${secondTokenId}`,
      { method: "DELETE", headers: cookieHeaders },
    );
    expect(drop.status).toBe(200);
    const dropped = await SELF.fetch(`${BASE}/api/v1/document`, {
      headers: { authorization: `Bearer ${secondToken}` },
    });
    expect(dropped.status).toBe(401);
    const kept = await SELF.fetch(`${BASE}/api/v1/document`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(kept.status).toBe(200);
  });

  it("never returns another agent's envelope or document", async () => {
    const accountA = await seedAccount();
    const agentA = await enrollAgent(accountA);
    const accountB = await seedAccount();
    const agentB = await enrollAgent(accountB);

    const envelopeB = (await (
      await SELF.fetch(`${BASE}/api/v1/agent/envelope`, {
        headers: { authorization: `Bearer ${agentB.token}` },
      })
    ).json()) as { agentId: string; accountId: string };
    expect(envelopeB.agentId).toBe(agentB.agentId);
    expect(envelopeB.accountId).toBe(accountB.accountId);

    const documentA = (await (
      await SELF.fetch(`${BASE}/api/v1/document`, {
        headers: { authorization: `Bearer ${agentA.token}` },
      })
    ).json()) as { accountId: string };
    expect(documentA.accountId).toBe(accountA.accountId);
    expect(documentA.accountId).not.toBe(accountB.accountId);
  });

  it("does not let an auth_epoch bump leave tokens valid", async () => {
    const account = await seedAccount();
    const agent = await enrollAgent(account);
    await TEST_ENV.DB.prepare(`UPDATE accounts SET auth_epoch = auth_epoch + 1 WHERE id = ?1`)
      .bind(account.accountId)
      .run();
    const response = await SELF.fetch(`${BASE}/api/v1/document`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(response.status).toBe(401);
  });

  it("rejects a wrong pairing code and a canary mismatch without activating", async () => {
    const account = await seedAccount();
    const cookieHeaders = { ...webHeaders, cookie: account.cookie };
    const created = await postJson("/api/v1/agents/enrollments", {}, cookieHeaders);
    const { agentId, pairingCode } = (await created.json()) as {
      agentId: string;
      pairingCode: string;
    };
    const keyPair = await generateAgentKeyPair();
    const publicKey = await exportAgentPublicKey(keyPair.publicKey);

    const wrongCode = await postJson(
      `/api/v1/agents/enrollments/${agentId}/pubkey`,
      { pairingCode: "wrong-code-value", publicKey: b64(publicKey) },
      { "content-type": "application/json" },
    );
    expect(wrongCode.status).toBe(404);

    const submitted = await postJson(
      `/api/v1/agents/enrollments/${agentId}/pubkey`,
      { pairingCode, publicKey: b64(publicKey) },
      { "content-type": "application/json" },
    );
    expect(submitted.status).toBe(200);

    const wrap = await wrapVaultKeyForAgent({
      vaultKey: account.vaultKey,
      agentPublicKey: publicKey,
      accountId: account.accountId,
      agentId,
    });
    const canary = await createAgentCanary(account.vaultKey, agentId);
    await postJson(
      `/api/v1/agents/${agentId}/wrap`,
      {
        formatVersion: 1,
        keyVersion: 1,
        ephemeralPublicKey: b64(wrap.ephemeralPublicKey),
        wrapSalt32: b64(wrap.wrapSalt),
        nonce: b64(wrap.nonce),
        wrappedKey: b64(wrap.wrappedKey),
        canaryNonce: b64(canary.nonce),
        canaryCiphertext: b64(canary.ciphertext),
        canaryHash32: b64(canary.plaintextHash),
      },
      cookieHeaders,
    );

    const mismatch = await postJson(
      `/api/v1/agents/enrollments/${agentId}/canary`,
      { pairingCode, canaryPlaintext: b64(random(16)) },
      { "content-type": "application/json" },
    );
    expect(mismatch.status).toBe(422);

    const listed = (await (
      await SELF.fetch(`${BASE}/api/v1/agents`, { headers: { cookie: account.cookie } })
    ).json()) as { agents: Array<{ agentId: string; state: string }> };
    expect(listed.agents.find((entry) => entry.agentId === agentId)?.state).toBe("pending");
  });

  it("requires step-up for management and refuses write-scope issuance in phase 1", async () => {
    const noStepUp = await seedAccount({ stepUp: false });
    const denied = await postJson(
      "/api/v1/agents/enrollments",
      {},
      { ...webHeaders, cookie: noStepUp.cookie },
    );
    expect(denied.status).toBe(403);

    const account = await seedAccount();
    const agent = await enrollAgent(account);
    const writeScope = await postJson(
      `/api/v1/agents/${agent.agentId}/tokens`,
      { scope: "agent:write" },
      { ...webHeaders, cookie: account.cookie },
    );
    expect(writeScope.status).toBe(403);
  });

  it("keeps the Web session surface cookie-only against agent tokens", async () => {
    const account = await seedAccount();
    const agent = await enrollAgent(account);

    const session = await SELF.fetch(`${BASE}/api/v1/session`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(session.status).toBe(401);

    const mixed = await SELF.fetch(`${BASE}/api/v1/document`, {
      headers: { cookie: account.cookie, authorization: `Bearer ${agent.token}` },
    });
    expect(mixed.status).toBe(401);

    // The raw Web session token as a Bearer is not an agent token either.
    const rawSession = await SELF.fetch(`${BASE}/api/v1/document`, {
      headers: { authorization: `Bearer ${account.sessionToken}` },
    });
    expect(rawSession.status).toBe(401);
  });
});
