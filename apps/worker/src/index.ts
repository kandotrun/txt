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
import { agentRoutes } from "./routes/agents.ts";
import { mediaRoutes } from "./routes/media.ts";
import { accountRoutes } from "./routes/account.ts";
import { runMaintenance } from "./maintenance.ts";
import { isAllowedOrigin, isDevelopmentEnv } from "./auth/sessions.ts";
import { BASELINE_SECURITY_HEADERS, SHELL_CSP } from "./security-headers.ts";

const app = new Hono<AppBindings>();

/** Routes that must never be served by the SPA fallback. */
const API_PREFIX = "/api/";

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const host = url.hostname;

  // Only the canonical host serves production traffic. Development
  // (`wrangler dev`) rewrites the Host header to the configured custom domain
  // while serving from localhost, and tests use *.test hosts.
  // A production deployment (https APP_ORIGIN) answers on that one host and
  // nothing else, so no development alias can reach production data.
  const isProductionHost = host === c.env.WEBAUTHN_RP_ID;
  const isDevelopment = isDevelopmentEnv(c.env);
  const isWorkersDev = host.endsWith(".workers.dev");
  if (isWorkersDev || !(isProductionHost || isDevelopment)) {
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
  for (const [name, value] of Object.entries(BASELINE_SECURITY_HEADERS)) {
    // Static files may relax a value in `_headers` (the share card has to be
    // embeddable by other sites); the API never does.
    if (isApi || !headers.has(name)) headers.set(name, value);
  }

  if (isApi) {
    headers.set("cache-control", "private, no-store");
    headers.set(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox",
    );
  } else if (isServiceWorker) {
    headers.set("cache-control", "no-cache");
    headers.set("service-worker-allowed", "/");
  }
  // Static assets carry their own policy from `_headers` (which also applies
  // when Cloudflare serves a cached asset without invoking the Worker); the
  // Worker must not overwrite those values.
});

/**
 * Resource isolation for the API (spec §5.4, §14).
 *
 * The API is only ever called by this origin's own scripts (or by agents,
 * which are not browsers). A browser tells us where a request comes from, so
 * anything it labels as coming from another site or origin is refused before
 * a handler runs — including GETs, which carry no CSRF marker. `none` is a
 * direct navigation and is harmless: API responses are inert JSON.
 */
app.use("/api/*", async (c, next) => {
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return c.json({ error: { code: "ORIGIN_REJECTED", message: "origin is not allowed" } }, 403);
  }
  // Agent requests (Bearer) are not browser requests and are authorized by
  // their token alone (spec §5.4); every other write that names an origin
  // must name ours — including the ceremonies that run before a session exists.
  const origin = c.req.header("origin");
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  const agentPath = c.req.header("authorization") !== undefined;
  if (unsafe && !agentPath && origin !== undefined && !isAllowedOrigin(origin, c.env)) {
    return c.json({ error: { code: "ORIGIN_REJECTED", message: "origin is not allowed" } }, 403);
  }
  await next();
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
app.route("/api/v1", agentRoutes);
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

/** Unpublished well-known resources must not fall through to the SPA. */
app.all("/.well-known/*", (c) => {
  c.header("cache-control", "no-store");
  return c.text("not found", 404);
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
  if (url.pathname === "/" || response.headers.get("content-type")?.includes("text/html")) {
    headers.set("content-security-policy", SHELL_CSP);
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
  if (isDevelopmentEnv(c.env)) {
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
