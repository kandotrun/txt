/**
 * Session management and account deletion (spec §5.4, §15).
 *
 * DELETE /account moves the account to `deleting`, revokes every session and
 * credential, and removes the ciphertext, attachments, key envelopes and
 * recovery data. A plain logout or an email request is not a substitute.
 */

import { Hono } from "hono";

import type { AppBindings } from "../context.ts";
import { requireAuth } from "../context.ts";
import {
  assertWriteRequestAllowed,
  clearSessionCookie,
  requireStepUp,
} from "../auth/sessions.ts";
import { badRequest, notFound } from "../errors.ts";
import { nowMs, readJson, requireString } from "../util.ts";

const routes = new Hono<AppBindings>();

/** GET /api/v1/sessions — the caller's sessions. */
routes.get("/sessions", async (c) => {
  const auth = await requireAuth(c);
  const rows = await c.env.DB.prepare(
    `SELECT sid, client_kind, scope, created_at, absolute_expires_at, idle_expires_at, stepup_at
       FROM sessions WHERE account_id = ?1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
  )
    .bind(auth.accountId)
    .all<Record<string, unknown>>();
  return c.json({
    sessions: (rows.results ?? []).map((row: Record<string, unknown>) => ({
      sid: row.sid,
      clientKind: row.client_kind,
      scope: row.scope,
      createdAt: row.created_at,
      expiresAt: row.absolute_expires_at,
      idleExpiresAt: row.idle_expires_at,
      isCurrent: row.sid === auth.session.sid,
    })),
  });
});

/** DELETE /api/v1/sessions/:id — ends one of the caller's sessions. */
routes.delete("/sessions/:id", async (c) => {
  const auth = await requireAuth(c);
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  const sid = c.req.param("id");
  const updated = await c.env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?1 WHERE sid = ?2 AND account_id = ?3 AND revoked_at IS NULL`,
  )
    .bind(nowMs(), sid, auth.accountId)
    .run();
  if ((updated.meta.changes ?? 0) !== 1) throw notFound("session not found");
  if (sid === auth.session.sid && auth.via === "cookie") {
    c.header("set-cookie", clearSessionCookie(c.env));
  }
  return c.json({ ok: true });
});

/**
 * DELETE /api/v1/account — begins account deletion (spec §15).
 * Requires a step-up within 5 minutes and an explicit confirmation string.
 */
routes.delete("/account", async (c) => {
  const auth = await requireAuth(c);
  if (auth.scope !== "active") throw badRequest("active session required");
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  requireStepUp(auth);

  const body = await readJson<Record<string, unknown>>(c.req.raw, 8 * 1024);
  const confirmation = requireString(body.confirm, "confirm", 64);
  if (confirmation !== "DELETE") {
    throw badRequest("confirm must be the exact string DELETE");
  }

  const operationId = requireString(body.operationId, "operationId", 64);
  const now = nowMs();

  // Mark the account as deleting first so no new work can start.
  const marked = await c.env.DB.prepare(
    `UPDATE accounts SET status = 'deleting', auth_epoch = auth_epoch + 1
      WHERE id = ?1 AND status IN ('active','pending')`,
  )
    .bind(auth.accountId)
    .run();
  if ((marked.meta.changes ?? 0) !== 1) throw notFound("account not found");

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO operations (id, kind, account_id, payload_hash32, state, result, created_at, updated_at, expires_at)
       VALUES (?1, 'delete-account', ?2, ?3, 'pending', '{}', ?4, ?4, ?5)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(operationId, auth.accountId, new Uint8Array(32).buffer as ArrayBuffer, now, now + 30 * 24 * 3600 * 1000),
    c.env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?2 WHERE account_id = ?1 AND revoked_at IS NULL`,
    ).bind(auth.accountId, now),
    c.env.DB.prepare(
      `UPDATE credentials SET status = 'revoked' WHERE account_id = ?1`,
    ).bind(auth.accountId),
    c.env.DB.prepare(`DELETE FROM key_envelopes WHERE account_id = ?1`).bind(auth.accountId),
    c.env.DB.prepare(`DELETE FROM recovery WHERE account_id = ?1`).bind(auth.accountId),
  ]);

  if (auth.via === "cookie") c.header("set-cookie", clearSessionCookie(c.env));

  // Physical cleanup of ciphertext is performed asynchronously by the
  // scheduled handler so the response is not blocked by object deletion.
  return c.json({ ok: true, operationId, state: "deleting" }, 202);
});

export const accountRoutes = routes;
