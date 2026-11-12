/**
 * Hono context shape and small per-request helpers.
 */

import type { Context } from "hono";
import type { Env } from "./types.ts";
import type { AuthContext } from "./auth/sessions.ts";
import { ApiError } from "./errors.ts";
import { assertScopeAllowsRoute, isDevelopmentEnv, resolveSession } from "./auth/sessions.ts";
import { nowMs, sha256, toHex } from "./util.ts";
import { tooManyRequests } from "./errors.ts";

export interface AppBindings {
  Bindings: Env;
  Variables: {
    auth: AuthContext | null;
    requestId: string;
  };
}

export type AppContext = Context<AppBindings>;

export async function getAuth(c: AppContext): Promise<AuthContext | null> {
  if (c.get("auth")) return c.get("auth");
  const auth = await resolveSession(c.req.raw, c.env);
  c.set("auth", auth);
  return auth;
}

export async function requireAuth(c: AppContext): Promise<AuthContext> {
  const auth = await getAuth(c);
  if (!auth) throw new ApiError(401, "UNAUTHORIZED", "authentication required");
  assertScopeAllowsRoute(auth, c.req.raw);
  return auth;
}

/**
 * The network a request is counted against. Only Cloudflare's own header is
 * trusted — anything else is chosen by the client. IPv6 clients control a
 * whole /64, so that prefix is the unit; without the header (local dev) every
 * caller shares one bucket.
 */
export function clientNetwork(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (ip === "") return "unknown";
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const groups = head === "" ? [] : head.split(":");
  if (ip.includes("::")) {
    const tailGroups = tail === "" ? [] : tail.split(":");
    while (groups.length + tailGroups.length < 8) groups.push("0");
    groups.push(...tailGroups);
  }
  return groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** Hashed client identifier for rate limiting (raw IPs are never stored). */
export async function clientBucketKey(c: AppContext, scope: string): Promise<string> {
  const ip = clientNetwork(c.req.raw);
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

/**
 * Rate limits are relaxed on a local http deployment so repeated test runs do
 * not exhaust the production budget (spec §14).
 */
export function rateLimitScale(env: Env): number {
  return isDevelopmentEnv(env) ? 20 : 1;
}
