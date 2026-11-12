/**
 * Session authentication and CSRF/origin policy (spec §5.4).
 *
 * - Passkeys are used for login and unlock; not for every save.
 * - Normal APIs authorize with an opaque session token (>= 256 bits); D1 keeps
 *   only the SHA-256 hash.
 * - Web uses `__Host-txt_session` (Secure, HttpOnly, SameSite=Strict, Path=/,
 *   no Domain attribute). Cookie authentication is the only session transport.
 * - Cookie-authenticated writes require an exact Origin and `X-Txt-Request: 1`.
 *   A client-supplied `X-Client` header never bypasses CSRF checks.
 */

import type { Env, SessionRow } from "../types.ts";
import { ApiError, scopeRequired } from "../errors.ts";
import { sha256, nowMs, bytesToBase64Url } from "../util.ts";
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  RECOVERY_SESSION_TTL_MS,
  STEPUP_TTL_MS as SHARED_STEPUP_TTL_MS,
} from "../../../../packages/protocol/src/windows.ts";

export const SESSION_COOKIE = "__Host-txt_session";

/**
 * Cookie name selection.
 *
 * `__Host-` requires Secure, Path=/ and no Domain — and browsers reject it over
 * plain http, which would make local development impossible. Production always
 * uses the prefixed name; local development uses an unprefixed equivalent.
 */
export function sessionCookieName(env: Env): string {
  return env.APP_ORIGIN.startsWith("https://") ? SESSION_COOKIE : "txt_session";
}
// Windows live in the shared protocol package so the web app, the worker and
// the tests cannot drift (spec §5.4).
export const ABSOLUTE_TTL_MS = SESSION_ABSOLUTE_TTL_MS;
export const IDLE_TTL_MS = SESSION_IDLE_TTL_MS;
export const STEPUP_TTL_MS = SHARED_STEPUP_TTL_MS;

export interface AuthContext {
  session: SessionRow;
  accountId: string;
  clientKind: "web";
  scope: "pending" | "active" | "recovery";
  via: "cookie";
}

function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return out;
}

/** Reads the browser session cookie; Authorization cannot authenticate or override it. */
export function readSessionToken(
  request: Request,
  env: Env,
): { token: string; via: "cookie" } | null {
  if (request.headers.has("authorization")) return null;
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies.get(sessionCookieName(env)) ?? cookies.get(SESSION_COOKIE);
  if (token && token.length > 0) return { token, via: "cookie" };
  return null;
}

/** A deployment is production unless APP_ORIGIN is plain http (local dev). */
export function isDevelopmentEnv(env: Env): boolean {
  return env.APP_ORIGIN.startsWith("http://");
}

/**
 * The only origins that may call the API. Production accepts exactly
 * APP_ORIGIN; a local http deployment also accepts loopback origins, because
 * the dev server port is chosen by the developer.
 */
export function isAllowedOrigin(origin: string | null | undefined, env: Env): boolean {
  if (!origin) return false;
  if (origin === env.APP_ORIGIN) return true;
  if (!isDevelopmentEnv(env)) return false;
  return origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:");
}

/**
 * Verifies the request origin for cookie-authenticated writes.
 *
 * The Web build always sends `X-Txt-Request: 1` and an allowed Origin.
 */
export function assertWriteRequestAllowed(request: Request, via: "cookie", env: Env): void {
  if (via === "cookie") {
    const origin = request.headers.get("origin");
    if (!isAllowedOrigin(origin, env)) {
      const detail = isDevelopmentEnv(env) ? ` (origin=${String(origin)})` : "";
      throw new ApiError(403, "ORIGIN_REJECTED", `origin is not allowed${detail}`);
    }
    if (request.headers.get("x-txt-request") !== "1") {
      throw new ApiError(403, "CSRF_REQUIRED", "missing request marker");
    }
  }
}

/**
 * Resolves the session for a request. Returns null when unauthenticated.
 * Expired / revoked sessions and stale auth_epoch values are rejected.
 */
export async function resolveSession(
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  const found = readSessionToken(request, env);
  if (!found) return null;
  const hash = await sha256(new TextEncoder().encode(found.token));
  const tokenHash = hash.buffer as ArrayBuffer;
  const row = await env.DB.prepare(
    `SELECT s.token_hash32, s.sid, s.account_id, s.client_kind, s.scope, s.auth_epoch,
            s.created_at, s.absolute_expires_at, s.idle_expires_at, s.stepup_at, s.revoked_at,
            a.auth_epoch AS account_epoch, a.status AS account_status
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash32 = ?1`,
  )
    .bind(tokenHash)
    .first<SessionRow & { account_epoch: number; account_status: string }>();
  if (!row || row.client_kind !== "web") return null;
  if (row.revoked_at !== null) return null;
  const now = nowMs();
  if (row.absolute_expires_at <= now || row.idle_expires_at <= now) return null;
  if (row.auth_epoch !== row.account_epoch) return null;
  if (row.account_status === "deleting") return null;
  return {
    session: row,
    accountId: row.account_id,
    clientKind: "web",
    scope: row.scope,
    via: found.via,
  };
}

/**
 * What a recovery-scoped session may call (spec §7.2): read the key wraps,
 * register the replacement passkey, confirm, and sign out. Everything else —
 * the document, media, passkey and agent management — waits for completion.
 */
const RECOVERY_SCOPE_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/v1/session",
  "DELETE /api/v1/session",
  "GET /api/v1/keys",
  "POST /api/v1/recovery/options",
  "POST /api/v1/recovery/complete",
]);

/** Deny-by-default gate for restricted session scopes. */
export function assertScopeAllowsRoute(auth: AuthContext, request: Request): void {
  if (auth.scope !== "recovery") return;
  const route = `${request.method} ${new URL(request.url).pathname}`;
  if (!RECOVERY_SCOPE_ROUTES.has(route)) {
    throw scopeRequired("not available to a recovery session");
  }
}

/** Sensitive operations require a step-up re-authentication within 5 minutes. */
export function requireStepUp(auth: AuthContext): void {
  const at = auth.session.stepup_at;
  if (at === null || nowMs() - at > STEPUP_TTL_MS) {
    throw new ApiError(403, "STEPUP_REQUIRED", "recent re-authentication required");
  }
}

/** Issues a new session row and returns the raw token (never stored). */
export async function issueSession(
  env: Env,
  options: {
    accountId: string;
    clientKind: "web";
    scope: "pending" | "active" | "recovery";
    authEpoch: number;
    sid?: string;
  },
): Promise<{ token: string; sid: string; expiresAt: number; maxAgeMs: number }> {
  // A recovery session only has to outlive one ceremony (spec §7.2).
  const absoluteTtl = options.scope === "recovery" ? RECOVERY_SESSION_TTL_MS : ABSOLUTE_TTL_MS;
  const idleTtl = Math.min(IDLE_TTL_MS, absoluteTtl);
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64Url(tokenBytes);
  const hash = await sha256(new TextEncoder().encode(token));
  const now = nowMs();
  const sid = options.sid ?? crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sessions
       (token_hash32, sid, account_id, client_kind, scope, auth_epoch, created_at,
        absolute_expires_at, idle_expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      hash.buffer as ArrayBuffer,
      sid,
      options.accountId,
      options.clientKind,
      options.scope,
      options.authEpoch,
      now,
      now + absoluteTtl,
      now + idleTtl,
    )
    .run();
  return { token, sid, expiresAt: now + absoluteTtl, maxAgeMs: absoluteTtl };
}

/** Sliding idle expiry: each authorized request extends the idle window. */
export async function touchSession(env: Env, auth: AuthContext): Promise<void> {
  const now = nowMs();
  // Short-lived scopes keep the expiry they were issued with.
  if (auth.scope === "recovery") return;
  if (auth.session.idle_expires_at - now < IDLE_TTL_MS - 60_000) {
    await env.DB.prepare(`UPDATE sessions SET idle_expires_at = ?1 WHERE sid = ?2`)
      .bind(now + IDLE_TTL_MS, auth.session.sid)
      .run();
  }
}

export function sessionCookie(token: string, env: Env, maxAgeMs: number = ABSOLUTE_TTL_MS): string {
  const secure = env.APP_ORIGIN.startsWith("https://") ? "; Secure" : "";
  // No Domain attribute: `__Host-` requires host-only scope, Path=/ and Secure.
  // `Max-Age` makes this a persistent cookie: without it the browser drops the
  // session on close, which would defeat the 30-day idle window (spec §5.4).
  return `${sessionCookieName(env)}=${token}; HttpOnly; Path=/; SameSite=Strict${secure}; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

export function clearSessionCookie(env: Env): string {
  const secure = env.APP_ORIGIN.startsWith("https://") ? "; Secure" : "";
  return `${sessionCookieName(env)}=; HttpOnly; Path=/; SameSite=Strict${secure}; Max-Age=0`;
}
