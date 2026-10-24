/**
 * Agent management + envelope routes (agent design §7).
 *
 * Two authorization domains, never mixed on one route:
 *
 * - Management (this file, `/agents...`): Web cookie session, active scope,
 *   step-up within 5 minutes for state-changing operations (spec §5.4, §7).
 *   Agent tokens can never call these.
 * - Envelope (`/agent/envelope`): an `agent:read` Bearer token, and it can
 *   only ever return the wrap of the agent the token belongs to.
 *
 * The one session-less route is the enrollment submission, authorized by
 * the 128-bit pairing code (only its SHA-256 is stored, 10-minute expiry,
 * cleared on activation). The pairing code is shown once in the browser at
 * enrollment creation; knowing an agentId alone grants nothing.
 */

import { Hono } from "hono";

import type { AppBindings } from "../context.ts";
import { clientBucketKey, enforceRateLimit, requireAuth } from "../context.ts";
import { assertWriteRequestAllowed, requireStepUp } from "../auth/sessions.ts";
import {
  AGENT_READ_SCOPE,
  requireAgentAuth,
  touchAgentAuth,
} from "../auth/agent.ts";
import {
  badRequest,
  conflict,
  notFound,
  scopeRequired,
  unprocessable,
} from "../errors.ts";
import {
  bytesEqual,
  bytesToBase64Url,
  nowMs,
  randomBytes,
  readJson,
  requireInt,
  sha256,
  uuid,
} from "../util.ts";
import { decodeBase64Url, encodeBase64Url } from "../document/store.ts";
import {
  AGENT_ENROLLMENT_TTL_MS,
  AGENT_TOKEN_TTL_MS,
} from "../../../../packages/protocol/src/windows.ts";

const routes = new Hono<AppBindings>();

function rateScale(origin: string): number {
  return origin.startsWith("http://") ? 20 : 1;
}

interface AgentKeyRow {
  agent_id: string;
  account_id: string;
  display_name: string;
  public_key: ArrayBuffer | null;
  public_key_fingerprint: ArrayBuffer | null;
  state: string;
  format_version: number | null;
  key_version: number | null;
  ephemeral_public_key: ArrayBuffer | null;
  wrap_salt: ArrayBuffer | null;
  wrap_nonce: ArrayBuffer | null;
  wrapped_key: ArrayBuffer | null;
  canary_nonce: ArrayBuffer | null;
  canary_ciphertext: ArrayBuffer | null;
  canary_hash: ArrayBuffer | null;
  enrollment_hash32: ArrayBuffer | null;
  enrollment_expires_at: number | null;
  created_at: number;
  activated_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
}

const AGENT_KEY_COLUMNS = `agent_id, account_id, display_name, public_key,
  public_key_fingerprint, state, format_version, key_version,
  ephemeral_public_key, wrap_salt, wrap_nonce, wrapped_key, canary_nonce,
  canary_ciphertext, canary_hash, enrollment_hash32, enrollment_expires_at,
  created_at, activated_at, revoked_at, last_used_at`;

async function loadAgent(
  c: { env: AppBindings["Bindings"] },
  agentId: string,
): Promise<AgentKeyRow | null> {
  return c.env.DB.prepare(`SELECT ${AGENT_KEY_COLUMNS} FROM agent_keys WHERE agent_id = ?1`)
    .bind(agentId)
    .first<AgentKeyRow>();
}

async function requireWebAdmin(c: Parameters<typeof requireAuth>[0], stepUp: boolean) {
  const auth = await requireAuth(c);
  if (auth.scope !== "active") throw unprocessable("active session required");
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  if (stepUp) requireStepUp(auth);
  return auth;
}

function optionalDisplayName(body: Record<string, unknown>): string | null {
  const value = body.displayName;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 64) {
    throw badRequest("displayName must be a string of at most 64 characters");
  }
  return value;
}

async function pairingCodeHash(pairingCode: string): Promise<Uint8Array> {
  return sha256(new TextEncoder().encode(pairingCode));
}

/** Loads a pending enrollment and verifies the pairing code (404 otherwise). */
async function requireEnrollment(
  c: Parameters<typeof requireAuth>[0],
  agentId: string,
  pairingCode: unknown,
): Promise<AgentKeyRow> {
  if (typeof pairingCode !== "string" || pairingCode.length === 0 || pairingCode.length > 128) {
    throw notFound("enrollment not found");
  }
  const row = await loadAgent(c, agentId);
  if (!row || row.state !== "pending") throw notFound("enrollment not found");
  if (!row.enrollment_hash32 || !row.enrollment_expires_at) throw notFound("enrollment not found");
  if (row.enrollment_expires_at <= nowMs()) throw notFound("enrollment not found");
  const given = await pairingCodeHash(pairingCode);
  if (!bytesEqual(given, new Uint8Array(row.enrollment_hash32))) {
    throw notFound("enrollment not found");
  }
  return row;
}

async function acceptPublicKey(
  c: Parameters<typeof requireAuth>[0],
  row: AgentKeyRow,
  body: Record<string, unknown>,
): Promise<{ fingerprint: string }> {
  const publicKey = decodeBase64Url(body.publicKey, "publicKey", 65);
  if (new Uint8Array(publicKey)[0] !== 0x04) {
    throw unprocessable("publicKey must be an uncompressed P-256 point");
  }
  const fingerprint = await sha256(new Uint8Array(publicKey));
  const displayName = optionalDisplayName(body);
  await c.env.DB.prepare(
    `UPDATE agent_keys SET public_key = ?1, public_key_fingerprint = ?2,
            display_name = COALESCE(?3, display_name)
      WHERE agent_id = ?4 AND state = 'pending'`,
  )
    .bind(publicKey, fingerprint.buffer as ArrayBuffer, displayName, row.agent_id)
    .run();
  return { fingerprint: bytesToBase64Url(fingerprint) };
}

/* ------------------------------------------------------------------ */
/* Enrollment (Web creates; the agent side submits with the code)      */
/* ------------------------------------------------------------------ */

routes.post("/agents/enrollments", async (c) => {
  const auth = await requireWebAdmin(c, true);
  const bucketKey = await clientBucketKey(c, "agent:enroll");
  await enforceRateLimit(c, {
    bucketKey,
    limit: 30 * rateScale(c.env.APP_ORIGIN),
    windowMs: 60 * 60 * 1000,
  });

  const body = await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024).catch(
    () => ({}) as Record<string, unknown>,
  );
  const displayName = optionalDisplayName(body) ?? "";

  const agentId = uuid();
  const pairingCode = bytesToBase64Url(randomBytes(16));
  const hash = await pairingCodeHash(pairingCode);
  const now = nowMs();
  const expiresAt = now + AGENT_ENROLLMENT_TTL_MS;
  await c.env.DB.prepare(
    `INSERT INTO agent_keys
       (agent_id, account_id, display_name, state, enrollment_hash32,
        enrollment_expires_at, created_at)
     VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6)`,
  )
    .bind(agentId, auth.accountId, displayName, hash.buffer as ArrayBuffer, expiresAt, now)
    .run();

  // The pairing code is returned exactly once, to the step-up-verified
  // browser that created the enrollment (design §4.3).
  return c.json({ agentId, pairingCode, expiresAt }, 201);
});

/** Agent side: submits its public key + display name with the pairing code. */
routes.post("/agents/enrollments/:id/pubkey", async (c) => {
  const bucketKey = await clientBucketKey(c, "agent:enroll:pubkey");
  await enforceRateLimit(c, {
    bucketKey,
    limit: 60 * rateScale(c.env.APP_ORIGIN),
    windowMs: 60 * 60 * 1000,
  });
  const body = await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024);
  const row = await requireEnrollment(c, c.req.param("id"), body.pairingCode);
  const { fingerprint } = await acceptPublicKey(c, row, body);
  return c.json({ ok: true, agentId: row.agent_id, fingerprint });
});

/** Browser side (paste path): the same submission, authorized by step-up. */
routes.post("/agents/:id/pubkey", async (c) => {
  const auth = await requireWebAdmin(c, true);
  const row = await loadAgent(c, c.req.param("id"));
  if (!row || row.account_id !== auth.accountId || row.state !== "pending") {
    throw notFound("agent not found");
  }
  const body = await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024);
  const { fingerprint } = await acceptPublicKey(c, row, body);
  return c.json({ ok: true, agentId: row.agent_id, fingerprint });
});

/** Browser polling: enrollment state + the fingerprint to compare (§4.3). */
routes.get("/agents/enrollments/:id", async (c) => {
  const auth = await requireAuth(c);
  const row = await loadAgent(c, c.req.param("id"));
  if (!row || row.account_id !== auth.accountId) throw notFound("agent not found");
  return c.json({
    agentId: row.agent_id,
    state: row.state,
    displayName: row.display_name,
    publicKey: row.public_key ? encodeBase64Url(row.public_key) : null,
    fingerprint: row.public_key_fingerprint
      ? encodeBase64Url(row.public_key_fingerprint)
      : null,
    enrollmentExpiresAt: row.enrollment_expires_at,
    hasWrap: row.wrapped_key !== null,
    canaryReady: row.canary_hash !== null,
  });
});

/* ------------------------------------------------------------------ */
/* Wrap storage + canary activation                                    */
/* ------------------------------------------------------------------ */

routes.post("/agents/:id/wrap", async (c) => {
  const auth = await requireWebAdmin(c, true);
  const row = await loadAgent(c, c.req.param("id"));
  if (!row || row.account_id !== auth.accountId) throw notFound("agent not found");
  if (row.state !== "pending") throw conflict("agent is not pending");
  if (!row.public_key) throw unprocessable("agent public key is not registered yet");

  const body = await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024);
  const formatVersion = requireInt(body.formatVersion, "formatVersion", 255);
  const keyVersion = requireInt(body.keyVersion, "keyVersion", 255);
  const ephemeralPublicKey = decodeBase64Url(body.ephemeralPublicKey, "ephemeralPublicKey", 65);
  if (new Uint8Array(ephemeralPublicKey)[0] !== 0x04) {
    throw unprocessable("ephemeralPublicKey must be an uncompressed P-256 point");
  }
  const wrapSalt = decodeBase64Url(body.wrapSalt32, "wrapSalt32", 32);
  const nonce = decodeBase64Url(body.nonce, "nonce", 12);
  const wrappedKey = decodeBase64Url(body.wrappedKey, "wrappedKey", 48);
  const canaryNonce = decodeBase64Url(body.canaryNonce, "canaryNonce", 12);
  const canaryCiphertext = decodeBase64Url(body.canaryCiphertext, "canaryCiphertext", 32);
  const canaryHash = decodeBase64Url(body.canaryHash32, "canaryHash32", 32);

  await c.env.DB.prepare(
    `UPDATE agent_keys SET format_version = ?1, key_version = ?2,
            ephemeral_public_key = ?3, wrap_salt = ?4, wrap_nonce = ?5,
            wrapped_key = ?6, canary_nonce = ?7, canary_ciphertext = ?8,
            canary_hash = ?9
      WHERE agent_id = ?10 AND state = 'pending'`,
  )
    .bind(
      formatVersion,
      keyVersion,
      ephemeralPublicKey,
      wrapSalt,
      nonce,
      wrappedKey,
      canaryNonce,
      canaryCiphertext,
      canaryHash,
      row.agent_id,
    )
    .run();
  return c.json({ ok: true, agentId: row.agent_id, state: "pending" });
});

/** Agent side: fetches the canary ciphertext it must decrypt (code-auth). */
routes.post("/agents/enrollments/:id/canary-challenge", async (c) => {
  const bucketKey = await clientBucketKey(c, "agent:enroll:canary");
  await enforceRateLimit(c, {
    bucketKey,
    limit: 60 * rateScale(c.env.APP_ORIGIN),
    windowMs: 60 * 60 * 1000,
  });
  const body = await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024);
  const row = await requireEnrollment(c, c.req.param("id"), body.pairingCode);
  if (!row.canary_nonce || !row.canary_ciphertext || !row.canary_hash) {
    throw conflict("canary is not ready");
  }
  if (!row.ephemeral_public_key || !row.wrap_salt || !row.wrap_nonce || !row.wrapped_key) {
    throw conflict("wrap is not ready");
  }
  // The agent needs the wrap itself to recover the VaultKey before it can
  // answer the canary (design §4.3 step 6). Everything returned here is
  // either public (accountId, public keys) or encrypted (wrap, canary);
  // the pairing code is the enrollment-scoped credential for this data.
  return c.json({
    accountId: row.account_id,
    formatVersion: row.format_version,
    keyVersion: row.key_version,
    ephemeralPublicKey: encodeBase64Url(row.ephemeral_public_key),
    wrapSalt32: encodeBase64Url(row.wrap_salt),
    nonce: encodeBase64Url(row.wrap_nonce),
    wrappedKey: encodeBase64Url(row.wrapped_key),
    canaryNonce: encodeBase64Url(row.canary_nonce),
    canaryCiphertext: encodeBase64Url(row.canary_ciphertext),
  });
});

/** Agent side: returns the canary plaintext; hash match activates the agent. */
routes.post("/agents/enrollments/:id/canary", async (c) => {
  const bucketKey = await clientBucketKey(c, "agent:enroll:canary");
  await enforceRateLimit(c, {
    bucketKey,
    limit: 60 * rateScale(c.env.APP_ORIGIN),
    windowMs: 60 * 60 * 1000,
  });
  const body = await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024);
  const row = await requireEnrollment(c, c.req.param("id"), body.pairingCode);
  if (!row.canary_hash) throw conflict("canary is not ready");
  const plaintext = decodeBase64Url(body.canaryPlaintext, "canaryPlaintext", 16);
  const given = await sha256(new Uint8Array(plaintext));
  if (!bytesEqual(given, new Uint8Array(row.canary_hash))) {
    throw unprocessable("canary plaintext does not match");
  }
  const now = nowMs();
  const updated = await c.env.DB.prepare(
    `UPDATE agent_keys SET state = 'active', activated_at = ?1,
            enrollment_hash32 = NULL, enrollment_expires_at = NULL,
            canary_nonce = NULL, canary_ciphertext = NULL, canary_hash = NULL
      WHERE agent_id = ?2 AND state = 'pending'`,
  )
    .bind(now, row.agent_id)
    .run();
  if ((updated.meta.changes ?? 0) !== 1) throw conflict("agent is not pending");
  return c.json({ ok: true, agentId: row.agent_id, state: "active" });
});

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

routes.post("/agents/:id/tokens", async (c) => {
  const auth = await requireWebAdmin(c, true);
  const row = await loadAgent(c, c.req.param("id"));
  if (!row || row.account_id !== auth.accountId) throw notFound("agent not found");
  if (row.state !== "active") throw conflict("agent is not active");

  const body = await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024).catch(
    () => ({}) as Record<string, unknown>,
  );
  const requestedScope = body.scope;
  if (requestedScope !== undefined && requestedScope !== AGENT_READ_SCOPE) {
    // Phase 1 issues read-only tokens; write arrives in phase 2 (design §10).
    throw scopeRequired("only agent:read tokens are issued in phase 1");
  }

  const account = await c.env.DB.prepare(`SELECT auth_epoch FROM accounts WHERE id = ?1`)
    .bind(auth.accountId)
    .first<{ auth_epoch: number }>();
  if (!account) throw notFound("account not found");

  const tokenId = uuid();
  const token = `txta1.${bytesToBase64Url(randomBytes(32))}`;
  const hash = await sha256(new TextEncoder().encode(token));
  const now = nowMs();
  const expiresAt = now + AGENT_TOKEN_TTL_MS;
  await c.env.DB.prepare(
    `INSERT INTO agent_tokens
       (token_id, token_hash, agent_id, account_id, scopes, auth_epoch,
        expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      tokenId,
      hash.buffer as ArrayBuffer,
      row.agent_id,
      auth.accountId,
      AGENT_READ_SCOPE,
      account.auth_epoch,
      expiresAt,
      now,
    )
    .run();

  // The plaintext token is returned exactly once (design §5.3).
  return c.json({ tokenId, token, scope: AGENT_READ_SCOPE, expiresAt }, 201);
});

routes.delete("/agents/:id/tokens/:tokenId", async (c) => {
  const auth = await requireWebAdmin(c, true);
  const row = await c.env.DB.prepare(
    `SELECT token_id FROM agent_tokens WHERE token_id = ?1 AND agent_id = ?2 AND account_id = ?3`,
  )
    .bind(c.req.param("tokenId"), c.req.param("id"), auth.accountId)
    .first<{ token_id: string }>();
  if (!row) throw notFound("token not found");
  await c.env.DB.prepare(
    `UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?1) WHERE token_id = ?2`,
  )
    .bind(nowMs(), row.token_id)
    .run();
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Listing + revocation                                                */
/* ------------------------------------------------------------------ */

routes.get("/agents", async (c) => {
  const auth = await requireAuth(c);
  const agents = await c.env.DB.prepare(
    `SELECT ${AGENT_KEY_COLUMNS} FROM agent_keys WHERE account_id = ?1 ORDER BY created_at`,
  )
    .bind(auth.accountId)
    .all<AgentKeyRow>();
  const tokens = await c.env.DB.prepare(
    `SELECT token_id, agent_id, scopes, expires_at, created_at, last_used_at, revoked_at
       FROM agent_tokens WHERE account_id = ?1 ORDER BY created_at`,
  )
    .bind(auth.accountId)
    .all<{
      token_id: string;
      agent_id: string;
      scopes: string;
      expires_at: number;
      created_at: number;
      last_used_at: number | null;
      revoked_at: number | null;
    }>();

  const tokensByAgent = new Map<string, unknown[]>();
  for (const token of tokens.results ?? []) {
    const list = tokensByAgent.get(token.agent_id) ?? [];
    list.push({
      tokenId: token.token_id,
      scopes: token.scopes.split(","),
      expiresAt: token.expires_at,
      createdAt: token.created_at,
      lastUsedAt: token.last_used_at,
      revokedAt: token.revoked_at,
    });
    tokensByAgent.set(token.agent_id, list);
  }

  return c.json({
    agents: (agents.results ?? []).map((row) => ({
      agentId: row.agent_id,
      displayName: row.display_name,
      state: row.state,
      fingerprint: row.public_key_fingerprint
        ? encodeBase64Url(row.public_key_fingerprint)
        : null,
      createdAt: row.created_at,
      activatedAt: row.activated_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
      tokens: tokensByAgent.get(row.agent_id) ?? [],
    })),
  });
});

routes.delete("/agents/:id", async (c) => {
  const auth = await requireWebAdmin(c, true);
  const row = await loadAgent(c, c.req.param("id"));
  if (!row || row.account_id !== auth.accountId) throw notFound("agent not found");
  const now = nowMs();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE agent_keys SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?1),
              enrollment_hash32 = NULL, enrollment_expires_at = NULL
        WHERE agent_id = ?2`,
    ).bind(now, row.agent_id),
    c.env.DB.prepare(
      `UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?1) WHERE agent_id = ?2`,
    ).bind(now, row.agent_id),
  ]);
  return c.json({ ok: true, agentId: row.agent_id, state: "revoked" });
});

/* ------------------------------------------------------------------ */
/* Envelope (agent Bearer token)                                       */
/* ------------------------------------------------------------------ */

routes.get("/agent/envelope", async (c) => {
  const auth = await requireAgentAuth(c.req.raw, c.env, AGENT_READ_SCOPE);
  const row = await loadAgent(c, auth.agentId);
  if (!row || row.state !== "active" || !row.wrapped_key) {
    throw notFound("envelope not found");
  }
  await touchAgentAuth(c.env, auth);
  return c.json({
    agentId: row.agent_id,
    accountId: row.account_id,
    displayName: row.display_name,
    formatVersion: row.format_version,
    keyVersion: row.key_version,
    publicKey: row.public_key ? encodeBase64Url(row.public_key) : null,
    ephemeralPublicKey: row.ephemeral_public_key
      ? encodeBase64Url(row.ephemeral_public_key)
      : null,
    wrapSalt32: row.wrap_salt ? encodeBase64Url(row.wrap_salt) : null,
    nonce: row.wrap_nonce ? encodeBase64Url(row.wrap_nonce) : null,
    wrappedKey: encodeBase64Url(row.wrapped_key),
  });
});

export const agentRoutes = routes;
