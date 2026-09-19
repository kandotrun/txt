/**
 * Document routes (spec §10, §12.2).
 *
 * GET  /api/v1/document — returns ciphertext + metadata. An unchanged request
 *      (matching ETag) returns 304 without reading the BLOB.
 * PUT  /api/v1/document — conditional CAS update; success returns only the new
 *      ETag, revision, mutationId and updatedAt.
 */

import { Hono } from "hono";

import type { AppBindings } from "../context.ts";
import { requireAuth } from "../context.ts";
import { assertWriteRequestAllowed, touchSession } from "../auth/sessions.ts";
import { badRequest, preconditionRequired } from "../errors.ts";
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

routes.get("/document", async (c) => {
  const auth = await requireAuth(c);
  if (auth.scope === "pending") {
    throw badRequest("document is not available before bootstrap completes");
  }
  await touchSession(c.env, auth);

  const ifNoneMatch = c.req.header("if-none-match");
  const meta = await loadDocumentMeta(c.env, auth.accountId);
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

  const row = await loadDocument(c.env, auth.accountId);
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

routes.put("/document", async (c) => {
  const auth = await requireAuth(c);
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  if (auth.scope !== "active") {
    throw badRequest("active session required");
  }

  const ifMatch = c.req.header("if-match");
  if (!ifMatch) throw preconditionRequired("If-Match is required");

  const row = await loadDocument(c.env, auth.accountId);
  if (!row) {
    return c.json({ error: { code: "NOT_FOUND", message: "document not found" } }, 404);
  }
  if (normalizeEtag(ifMatch) !== etagFor(row)) {
    return c.json(
      { error: { code: "PRECONDITION_FAILED", message: "stale ETag" } },
      412,
    );
  }

  const parsed = await parseDocumentUpdate(c.req.raw, auth.accountId, row.id);
  const now = nowMs();
  const result = await applyDocumentUpdate(c.env, {
    accountId: auth.accountId,
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
});

export const documentRoutes = routes;
