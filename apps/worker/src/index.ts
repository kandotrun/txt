/// <reference types="@cloudflare/workers-types" />

/**
 * Worker entrypoint (spec §14).
 *
 * - Same origin for HTML, static assets, API and the Service Worker.
 * - workers.dev and preview production paths are disabled: requests are only
 *   accepted on the canonical host (or localhost during development).
 * - CSP is self-centric; no external CDN scripts, eval, analytics, or session
 *   replay. `nosniff` and `Referrer-Policy: no-referrer` are always sent.
 * - API, ciphertext and decrypted responses are `private, no-store`. Only
 *   hashed public assets get long-lived caching.
 * - The API and `/_local/` never fall through to the SPA index.html.
 */

import { Hono } from "hono";

import type { AppBindings } from "./context.ts";
import type { Env } from "./types.ts";
import { ApiError } from "./errors.ts";
import { authRoutes, sessionRoutes } from "./routes/auth.ts";
import { identityRoutes } from "./routes/identity.ts";
import { documentRoutes } from "./routes/document.ts";
import { mediaRoutes } from "./routes/media.ts";
import { accountRoutes } from "./routes/account.ts";
import { runMaintenance } from "./maintenance.ts";

const app = new Hono<AppBindings>();

/** Routes that must never be served by the SPA fallback. */
const API_PREFIX = "/api/";

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const host = url.hostname;

  // Only the canonical host serves production traffic. Development
  // (`wrangler dev`) rewrites the Host header to the configured custom domain
  // while serving from localhost, and tests use *.test hosts.
  const isProductionHost = host === c.env.WEBAUTHN_RP_ID;
  const isDevelopmentHost =
    host === "localhost" || host === "127.0.0.1" || c.env.APP_ORIGIN.startsWith("http://");
  const isTestHost = host.endsWith(".test") || host.endsWith(".example.invalid");
  const isWorkersDev = host.endsWith(".workers.dev");
  if (isWorkersDev || !(isProductionHost || isDevelopmentHost || isTestHost)) {
    return c.json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
  }

  c.set("requestId", crypto.randomUUID());
  await next();
});

app.use("*", async (c, next) => {
  await next();

  const url = new URL(c.req.url);
  const isApi = url.pathname.startsWith(API_PREFIX);
  const isServiceWorker = url.pathname === "/sw.js";

  const headers = c.res.headers;
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");

  if (isApi) {
    headers.set("cache-control", "private, no-store");
    headers.set(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
  } else if (isServiceWorker) {
    headers.set("cache-control", "no-cache");
    headers.set("service-worker-allowed", "/");
  }
  // Static assets carry their own policy from `_headers` (which also applies
  // when Cloudflare serves a cached asset without invoking the Worker); the
  // Worker must not overwrite those values.
});

app.use("/api/*", async (c, next) => {
  const contentType = c.req.header("content-type") ?? "";
  if (
    ["POST", "PUT", "PATCH"].includes(c.req.method) &&
    !contentType.startsWith("application/json") &&
    !contentType.startsWith("application/octet-stream")
  ) {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "unexpected content type" } },
      400,
    );
  }
  await next();
});

app.route("/api/v1/auth", authRoutes);
app.route("/api/v1", sessionRoutes);
app.route("/api/v1", identityRoutes);
app.route("/api/v1", documentRoutes);
app.route("/api/v1/media", mediaRoutes);
app.route("/api/v1", accountRoutes);

/** Health probe used by deployment smoke checks. */
app.get("/api/v1/health", (c) =>
  c.json({
    ok: true,
    service: "txt",
    rpId: c.env.WEBAUTHN_RP_ID,
    registrationMode: c.env.REGISTRATION_MODE,
  }),
);

/** Temporary diagnostic route (removed before release). */
app.get("/api/v1/debug/host", (c) => {
  const url = new URL(c.req.url);
  return c.json({
    hostname: url.hostname,
    host: c.req.header("host"),
    rpId: c.env.WEBAUTHN_RP_ID,
    path: url.pathname,
  });
});

/**
 * Apple App Site Association (spec §13). Served only once real signed app
 * values are configured: a placeholder is never published.
 */
app.get("/.well-known/apple-app-site-association", (c) => {
  const { TxtTeamId, TxtIosBundleId, TxtMacosBundleId } = c.env;
  if (!TxtTeamId || !TxtIosBundleId || !TxtMacosBundleId) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "not configured" } },
      404,
    );
  }
  return c.json({
    webcredentials: {
      apps: [`${TxtTeamId}.${TxtIosBundleId}`, `${TxtTeamId}.${TxtMacosBundleId}`],
    },
  });
});

/** API 404s must not fall through to the SPA. */
app.all("/api/*", (c) =>
  c.json({ error: { code: "NOT_FOUND", message: "not found" } }, 404),
);

/**
 * `/_local/` is the Service Worker's virtual media URL space. Requests that
 * reach the network directly must not be served anything.
 */
app.all("/_local/*", (c) => {
  c.header("cache-control", "no-store");
  return c.text("not found", 404);
});

/**
 * Static assets and the SPA shell. The Service Worker and manifest are served
 * from the asset bundle; a missing API path never reaches here.
 */
app.get("*", async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(response.headers);
  const url = new URL(c.req.url);
  if (/\/assets\/[^/]+-[0-9a-f]{8,}\./.test(url.pathname)) {
    // Hashed public assets are immutable.
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  if (url.pathname === "/" || response.headers.get("content-type")?.includes("text/html")) {
    headers.set(
      "content-security-policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' blob:",
        "media-src 'self' blob:",
        "connect-src 'self'",
        "worker-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'",
      ].join("; "),
    );
  }
  // A null body (for example a 304 from the asset layer) is passed through
  // verbatim: constructing a Response with an exhausted stream throws.
  if (response.body === null) {
    return new Response(null, { status: response.status, statusText: response.statusText, headers });
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status as never);
  }
  // Never leak stack traces, keys or plaintext in error responses.
  const debug = c.env.APP_ORIGIN.startsWith("http://");
  if (debug) {
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: `${(error as Error).name}: ${(error as Error).message}`,
        },
      },
      500,
    );
  }
  return c.json(
    { error: { code: "INTERNAL_ERROR", message: "internal error" } },
    500,
  );
});

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "not found" } }, 404));

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runMaintenance(env, event));
  },
};
