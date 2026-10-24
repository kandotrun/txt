/**
 * Document routes (spec §10, §12.2).
 *
 * GET  /api/v1/document — returns ciphertext + metadata. An unchanged request
 *      (matching ETag) returns 304 without reading the BLOB.
 * PUT  /api/v1/document — conditional CAS update; success returns only the new
 *      ETag, revision, mutationId and updatedAt.
 */

import { Hono } from "hono";

import type { AppBindings, AppContext } from "../context.ts";
import { requireAuth } from "../context.ts";
import { assertWriteRequestAllowed, touchSession } from "../auth/sessions.ts";
import {
  AGENT_READ_SCOPE,
  AGENT_WRITE_SCOPE,
  hasAuthorizationHeader,
  requireAgentAuth,
  touchAgentAuth,
} from "../auth/agent.ts";
import type { AgentAuthContext } from "../auth/agent.ts";
import { ApiError, badRequest, preconditionRequired } from "../errors.ts";
import {
  applyDocumentUpdate,
  encodeBase64Url,
  etagFor,
  loadDocument,
  loadDocumentMeta,
  normalizeEtag,
  parseDocumentUpdate,
} from "../document/store.ts";
import { nowMs } from "../util.ts";

const routes = new Hono<AppBindings>();

/**
 * Resolves the reader of GET /document: a Web cookie session OR an agent
 * Bearer token (design §5.2, §7.2). The two are never combined — a request
 * carrying both a session cookie and an Authorization header is rejected
 * rather than resolved ambiguously, and the Web resolver itself still
 * refuses Authorization outright (spec §5.4). The document handler below is
 * shared; only the authorization source differs.
 */
async function resolveDocumentReader(
  c: AppContext,
): Promise<{ accountId: string; agent: AgentAuthContext | null }> {
  const hasCookie = (c.req.header("cookie") ?? "").length > 0;
  const hasBearer = hasAuthorizationHeader(c.req.raw);
  if (hasCookie && hasBearer) {
    throw new ApiError(401, "UNAUTHORIZED", "ambiguous authentication");
  }
  if (hasBearer) {
    const agent = await requireAgentAuth(c.req.raw, c.env, AGENT_READ_SCOPE);
    await touchAgentAuth(c.env, agent);
    return { accountId: agent.accountId, agent };
  }
  const auth = await requireAuth(c);
  if (auth.scope === "pending") {
    throw badRequest("document is not available before bootstrap completes");
  }
  await touchSession(c.env, auth);
  return { accountId: auth.accountId, agent: null };
}

routes.get("/document", async (c) => {
  const { accountId } = await resolveDocumentReader(c);

  const ifNoneMatch = c.req.header("if-none-match");
  const meta = await loadDocumentMeta(c.env, accountId);
  if (!meta) {
    // The server never generates an empty document on the client's behalf.
    return c.json({ error: { code: "NOT_FOUND", message: "document not found" } }, 404);
  }

  const etag = etagFor(meta);
  if (ifNoneMatch && normalizeEtag(ifNoneMatch) === etag) {
    c.header("etag", etag);
    c.header("cache-control", "private, no-store");
    return c.body(null, 304);
  }

  const row = await loadDocument(c.env, accountId);
  if (!row) {
    return c.json({ error: { code: "NOT_FOUND", message: "document not found" } }, 404);
  }

  // Body and reference set are read in a single consistent snapshot: both come
  // from the same row, and references are only ever written with the CAS.
  const references = await c.env.DB.prepare(
    `SELECT media_id FROM document_media WHERE document_id = ?1 ORDER BY media_id`,
  )
    .bind(row.id)
    .all<{ media_id: string }>();

  c.header("etag", etag);
  c.header("cache-control", "private, no-store");
  c.header("x-txt-document-id", row.id);
  return c.json({
    accountId: row.account_id,
    documentId: row.id,
    syncEpoch: row.sync_epoch,
    revision: row.revision,
    encryptedRevision: row.encrypted_revision,
    formatVersion: row.format_version,
    keyVersion: row.key_version,
    mutationId: row.mutation_id,
    nonce: encodeBase64Url(row.nonce),
    ciphertext: encodeBase64Url(row.ciphertext),
    referencedMediaIds: (references.results ?? []).map(
      (row: { media_id: string }) => row.media_id,
    ),
    updatedAt: row.updated_at,
  });
});

/**
 * Shared PUT tail for both authorization sources (design §7.2): the CAS
 * contract — If-Match required, encryptedRevision checked against the
 * stored revision, mutationId idempotency, 412/409/422 separation in
 * `applyDocumentUpdate` — is identical whether the writer is the Web
 * session or an agent token. Only the account resolution differs.
 */
async function applyDocumentPut(c: AppContext, accountId: string) {
  const ifMatch = c.req.header("if-match");
  if (!ifMatch) throw preconditionRequired("If-Match is required");

  const row = await loadDocument(c.env, accountId);
  if (!row) {
    return c.json({ error: { code: "NOT_FOUND", message: "document not found" } }, 404);
  }
  if (normalizeEtag(ifMatch) !== etagFor(row)) {
    return c.json(
      { error: { code: "PRECONDITION_FAILED", message: "stale ETag" } },
      412,
    );
  }

  const parsed = await parseDocumentUpdate(c.req.raw, accountId, row.id);
  const now = nowMs();
  const result = await applyDocumentUpdate(c.env, {
    accountId,
    documentId: row.id,
    row,
    parsed,
    now,
  });

  const nextEtag = `"d-${row.id}-e-${row.sync_epoch}-r${result.revision}"`;
  c.header("etag", nextEtag);
  return c.json({
    etag: nextEtag,
    revision: result.revision,
    mutationId: parsed.update.mutationId,
    updatedAt: result.updatedAt,
  });
}

routes.put("/document", async (c) => {
  // Agent path (design §5.2, §7.2; phase 2): a Bearer-carrying PUT is
  // resolved ONLY as an agent token — 401 for an invalid token, 403 for a
  // valid token without `agent:write` — and never falls through to the
  // cookie path. Cookie + Bearer together stay ambiguous and are refused,
  // exactly like the GET path. The agent path has no Origin/X-Txt-Request
  // CSRF check: it is not a browser client, and the token is the credential.
  if (hasAuthorizationHeader(c.req.raw)) {
    const hasCookie = (c.req.header("cookie") ?? "").length > 0;
    if (hasCookie) {
      throw new ApiError(401, "UNAUTHORIZED", "ambiguous authentication");
    }
    const agent = await requireAgentAuth(c.req.raw, c.env, AGENT_WRITE_SCOPE);
    await touchAgentAuth(c.env, agent);
    return applyDocumentPut(c, agent.accountId);
  }
  const auth = await requireAuth(c);
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  if (auth.scope !== "active") {
    throw badRequest("active session required");
  }
  return applyDocumentPut(c, auth.accountId);
});

export const documentRoutes = routes;
