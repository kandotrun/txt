/**
 * Hono context shape and small per-request helpers.
 */

import type { Context } from "hono";
import type { Env } from "./types.ts";
import type { AuthContext } from "./auth/sessions.ts";
import { ApiError } from "./errors.ts";
import { resolveSession } from "./auth/sessions.ts";
import { nowMs, sha256, toHex } from "./util.ts";
import { tooManyRequests } from "./errors.ts";

export interface AppBindings {
  Bindings: Env;
  Variables: {
    auth: AuthContext | null;
    requestId: string;
    clientKind: "web" | "native";
  };
}

export type AppContext = Context<AppBindings>;

/** Web is decided by the exact Origin; `X-Client` never bypasses checks. */
export function clientKindFor(c: AppContext): "web" | "native" {
  const origin = c.req.header("origin");
  if (origin === c.env.APP_ORIGIN) return "web";
  const userAgent = c.req.header("user-agent") ?? "";
  if (/txt-ios|txt-macos/i.test(userAgent)) return "native";
  return "web";
}

export async function getAuth(c: AppContext): Promise<AuthContext | null> {
  if (c.get("auth")) return c.get("auth");
  const auth = await resolveSession(c.req.raw, c.env);
  c.set("auth", auth);
  return auth;
}

export async function requireAuth(c: AppContext): Promise<AuthContext> {
  const auth = await getAuth(c);
  if (!auth) throw new ApiError(401, "UNAUTHORIZED", "authentication required");
  return auth;
}

/** Hashed client identifier for rate limiting (raw IPs are never stored). */
export async function clientBucketKey(c: AppContext, scope: string): Promise<string> {
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
  const digest = await sha256(new TextEncoder().encode(`${scope}\n${ip}`));
  return `${scope}:${toHex(digest).slice(0, 32)}`;
}

export async function enforceRateLimit(
  c: AppContext,
  options: { bucketKey: string; limit: number; windowMs: number },
): Promise<void> {
  const now = nowMs();
  const windowStart = Math.floor(now / options.windowMs) * options.windowMs;
  const updated = await c.env.DB.prepare(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(options.bucketKey, windowStart)
    .first<{ count: number }>();
  if ((updated?.count ?? 0) > options.limit) {
    throw tooManyRequests("too many requests");
  }
}

export function readClientKindHint(body: Record<string, unknown>): "web" | "native" {
  return body.clientKind === "native" ? "native" : "web";
}
