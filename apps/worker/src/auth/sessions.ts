/**
 * Session authentication and CSRF/origin policy (spec §5.4).
 *
 * - Passkeys are used for login and unlock; not for every save.
 * - Normal APIs authorize with an opaque session token (>= 256 bits); D1 keeps
 *   only the SHA-256 hash.
 * - Web uses `__Host-txt_session` (Secure, HttpOnly, SameSite=Strict, Path=/,
 *   no Domain attribute). Native uses a Keychain Bearer token.
 * - Cookie-authenticated writes require an exact Origin and `X-Txt-Request: 1`.
 *   Native requests without Origin go through the verified Bearer path; a
 *   client-supplied `X-Client` header never bypasses CSRF checks.
 */

import type { Env, SessionRow } from "../types.ts";
import { ApiError, scopeRequired, unauthorized } from "../errors.ts";
import { sha256, nowMs, bytesToBase64Url } from "../util.ts";

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
export const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const STEPUP_TTL_MS = 5 * 60 * 1000;

export interface AuthContext {
  session: SessionRow;
  accountId: string;
  clientKind: "web" | "native";
  scope: "pending" | "active" | "recovery";
  via: "cookie" | "bearer";
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

/** Reads the session token, if any, from either the cookie or Bearer header. */
export function readSessionToken(
  request: Request,
  env: Env,
): { token: string; via: "cookie" | "bearer" } | null {
  const authorization = request.headers.get("authorization");
  if (authorization && /^Bearer\s+/i.test(authorization)) {
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (token.length > 0) return { token, via: "bearer" };
  }
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies.get(sessionCookieName(env)) ?? cookies.get(SESSION_COOKIE);
  if (token && token.length > 0) return { token, via: "cookie" };
  return null;
}

/**
 * Verifies the request origin for cookie-authenticated writes.
 *
 * The Web build always sends `X-Txt-Request: 1`; native sends Bearer without
 * Origin. Requests that present both Cookie and Bearer are rejected.
 */
export function assertWriteRequestAllowed(request: Request, via: "cookie" | "bearer", env: Env): void {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const hasSessionCookie =
    cookieHeader.includes(SESSION_COOKIE) || cookieHeader.includes("txt_session=");
  if (hasSessionCookie && via === "bearer") {
    throw new ApiError(400, "MIXED_AUTH", "cookie and bearer must not be mixed");
  }
  if (via === "cookie") {
    const origin = request.headers.get("origin");
    // Development serves the app from localhost while APP_ORIGIN may already
    // point at the production host (wrangler rewrites Host). A local origin is
    // accepted only when APP_ORIGIN itself is non-https.
    const development = env.APP_ORIGIN.startsWith("http://");
    const originAllowed =
      origin === env.APP_ORIGIN ||
      (development && (origin === "http://localhost:8799" || origin === "http://127.0.0.1:8799" ||
        origin?.startsWith("http://localhost:") === true ||
        origin?.startsWith("http://127.0.0.1:") === true));
    if (!originAllowed) {
      const detail = env.APP_ORIGIN.startsWith("http://") ? ` (origin=${String(origin)})` : "";
      throw new ApiError(403, "ORIGIN_REJECTED", `origin is not allowed${detail}`);
    }
    if (request.headers.get("x-txt-request") !== "1") {
      throw new ApiError(403, "CSRF_REQUIRED", "missing request marker");
    }
  }
  if (via === "bearer") {
    const origin = request.headers.get("origin");
    // Browser-originated bearer requests are not part of the contract; native
    // URLSession either omits Origin or sends a non-browser value.
    if (origin !== null && origin === env.APP_ORIGIN) {
      throw new ApiError(403, "BEARER_FROM_WEB", "bearer is not accepted from the web origin");
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
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  const now = nowMs();
  if (row.absolute_expires_at <= now || row.idle_expires_at <= now) return null;
  if (row.auth_epoch !== row.account_epoch) return null;
  if (row.account_status === "deleting") return null;
  return {
    session: row,
    accountId: row.account_id,
    clientKind: row.client_kind === "native" ? "native" : "web",
    scope: row.scope,
    via: found.via,
  };
}

export async function requireSession(request: Request, env: Env): Promise<AuthContext> {
  const auth = await resolveSession(request, env);
  if (!auth) throw unauthorized();
  return auth;
}

export async function requireActiveSession(request: Request, env: Env): Promise<AuthContext> {
  const auth = await requireSession(request, env);
  if (auth.scope !== "active") throw scopeRequired("active session required");
  return auth;
}

export async function requirePendingSession(request: Request, env: Env): Promise<AuthContext> {
  const auth = await requireSession(request, env);
  if (auth.scope !== "pending" && auth.scope !== "active") {
    throw scopeRequired("pending or active session required");
  }
  return auth;
}

export async function requireRecoverySession(request: Request, env: Env): Promise<AuthContext> {
  const auth = await requireSession(request, env);
  if (auth.scope !== "recovery") throw scopeRequired("recovery session required");
  return auth;
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
    clientKind: "web" | "native";
    scope: "pending" | "active" | "recovery";
    authEpoch: number;
    sid?: string;
  },
): Promise<{ token: string; sid: string; expiresAt: number }> {
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
      now + ABSOLUTE_TTL_MS,
      now + IDLE_TTL_MS,
    )
    .run();
  return { token, sid, expiresAt: now + ABSOLUTE_TTL_MS };
}

/** Sliding idle expiry: each authorized request extends the idle window. */
export async function touchSession(env: Env, auth: AuthContext): Promise<void> {
  const now = nowMs();
  if (auth.session.idle_expires_at - now < IDLE_TTL_MS - 60_000) {
    await env.DB.prepare(`UPDATE sessions SET idle_expires_at = ?1 WHERE sid = ?2`)
      .bind(now + IDLE_TTL_MS, auth.session.sid)
      .run();
  }
}

export function sessionCookie(token: string, env: Env): string {
  const secure = env.APP_ORIGIN.startsWith("https://") ? "; Secure" : "";
  // No Domain attribute: `__Host-` requires host-only scope, Path=/ and Secure.
  return `${sessionCookieName(env)}=${token}; HttpOnly; Path=/; SameSite=Strict${secure}`;
}

export function clearSessionCookie(env: Env): string {
  const secure = env.APP_ORIGIN.startsWith("https://") ? "; Secure" : "";
  return `${sessionCookieName(env)}=; HttpOnly; Path=/; SameSite=Strict${secure}; Max-Age=0`;
}
