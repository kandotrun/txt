/**
 * Agent token authentication (agent design §5).
 *
 * This is a SEPARATE authorization path from the Web session in
 * `sessions.ts`, which remains cookie-only (spec §5.4; `readSessionToken`
 * still refuses every Authorization header). Bearer is evaluated only on
 * the agent routes and on the agent branch of `GET/PUT /document`:
 *
 * - The token is an opaque 256-bit value presented as
 *   `Authorization: Bearer txta1.<base64url>`; D1 keeps only its SHA-256.
 * - The token resolves the account AND the agent. Clients never choose an
 *   agentId or accountId (spec §12.2: the owner comes from the credential).
 * - Expiry is absolute (30 days, protocol windows), revocation is immediate,
 *   and the account `auth_epoch` recorded at issuance must still match.
 * - Phase 1 issues `agent:read` only; a valid read token that attempts a
 *   write is a scope failure (403), not an authentication failure (401).
 */

import type { Env } from "../types.ts";
import { ApiError, scopeRequired, unauthorized } from "../errors.ts";
import { bytesEqual, nowMs, sha256 } from "../util.ts";

export const AGENT_TOKEN_PREFIX = "txta1.";
export const AGENT_READ_SCOPE = "agent:read";

export interface AgentAuthContext {
  tokenId: string;
  agentId: string;
  accountId: string;
  scopes: string[];
  via: "agent";
  expiresAt: number;
}

interface AgentTokenRow {
  token_id: string;
  token_hash: ArrayBuffer;
  agent_id: string;
  account_id: string;
  scopes: string;
  auth_epoch: number;
  expires_at: number;
  revoked_at: number | null;
  agent_state: string;
  agent_revoked_at: number | null;
  account_epoch: number;
  account_status: string;
}

/** Extracts the raw agent token from the Authorization header, if well-formed. */
export function readAgentToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer (txta1\.[A-Za-z0-9_-]+)$/.exec(header.trim());
  return match ? (match[1] as string) : null;
}

export function hasAuthorizationHeader(request: Request): boolean {
  return request.headers.has("authorization");
}

/**
 * Resolves an agent token. Returns null for any invalid token (unknown,
 * revoked, expired, epoch mismatch, agent not active) so callers answer a
 * uniform 401 without revealing which check failed.
 */
export async function resolveAgentAuth(
  request: Request,
  env: Env,
): Promise<AgentAuthContext | null> {
  const token = readAgentToken(request);
  if (!token) return null;
  const hash = await sha256(new TextEncoder().encode(token));
  const row = await env.DB.prepare(
    `SELECT t.token_id, t.token_hash, t.agent_id, t.account_id, t.scopes,
            t.auth_epoch, t.expires_at, t.revoked_at,
            k.state AS agent_state, k.revoked_at AS agent_revoked_at,
            a.auth_epoch AS account_epoch, a.status AS account_status
       FROM agent_tokens t
       JOIN agent_keys k ON k.agent_id = t.agent_id
       JOIN accounts a ON a.id = t.account_id
      WHERE t.token_hash = ?1`,
  )
    .bind(hash.buffer as ArrayBuffer)
    .first<AgentTokenRow>();
  if (!row) return null;
  if (!bytesEqual(new Uint8Array(row.token_hash), hash)) return null;
  if (row.revoked_at !== null) return null;
  if (row.agent_state !== "active" || row.agent_revoked_at !== null) return null;
  if (row.account_status === "deleting") return null;
  if (row.auth_epoch !== row.account_epoch) return null;
  if (row.expires_at <= nowMs()) return null;
  return {
    tokenId: row.token_id,
    agentId: row.agent_id,
    accountId: row.account_id,
    scopes: row.scopes.split(",").map((scope) => scope.trim()).filter(Boolean),
    via: "agent",
    expiresAt: row.expires_at,
  };
}

export async function requireAgentAuth(
  request: Request,
  env: Env,
  scope: string = AGENT_READ_SCOPE,
): Promise<AgentAuthContext> {
  const auth = await resolveAgentAuth(request, env);
  if (!auth) throw unauthorized("agent authentication required");
  if (!auth.scopes.includes(scope)) {
    throw scopeRequired(`scope ${scope} required`);
  }
  return auth;
}

/**
 * Phase 1 is read-only: PUT /document authenticates the agent token (401 for
 * invalid tokens) and then refuses with 403, because no write scope exists
 * yet. Kept as one helper so phase 2 only relaxes the scope check.
 */
export async function rejectAgentWrite(request: Request, env: Env): Promise<never> {
  const auth = await resolveAgentAuth(request, env);
  if (!auth) throw unauthorized("agent authentication required");
  throw new ApiError(403, "SCOPE_REQUIRED", "agent tokens are read-only in phase 1");
}

/** Best-effort usage stamps; failures never change the request outcome. */
export async function touchAgentAuth(env: Env, auth: AgentAuthContext): Promise<void> {
  const now = nowMs();
  await env.DB.batch([
    env.DB.prepare(`UPDATE agent_tokens SET last_used_at = ?1 WHERE token_id = ?2`).bind(
      now,
      auth.tokenId,
    ),
    env.DB.prepare(`UPDATE agent_keys SET last_used_at = ?1 WHERE agent_id = ?2`).bind(
      now,
      auth.agentId,
    ),
  ]);
}
