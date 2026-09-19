/**
 * Media routes (spec §11, §12.2).
 *
 * Uploads reserve capacity, accept ciphertext parts, and complete to `ready`.
 * Delivery (`GET/HEAD /media/:id/cipher`) serves only ready objects currently
 * referenced by the owner's document, always with correct Range semantics.
 */

import { Hono } from "hono";

import type { AppBindings } from "../context.ts";
import { requireAuth } from "../context.ts";
import { assertWriteRequestAllowed } from "../auth/sessions.ts";
import { conflict, notFound, preconditionFailed } from "../errors.ts";
import { nowMs } from "../util.ts";
import { normalizeEtag } from "../document/store.ts";
import {
  acceptPart,
  cancelUpload,
  completeUpload,
  loadParts,
  loadUpload,
  NORMAL_PART_BYTES,
  serveCipher,
  startUpload,
} from "../media/store.ts";

const routes = new Hono<AppBindings>();

async function activeDocumentId(c: Parameters<typeof requireAuth>[0]): Promise<string> {
  const auth = await requireAuth(c);
  if (auth.scope !== "active") throw conflict("active session required");
  const row = await c.env.DB.prepare(`SELECT id FROM documents WHERE account_id = ?1`)
    .bind(auth.accountId)
    .first<{ id: string }>();
  if (!row) throw notFound("document not found");
  return row.id;
}

/** POST /api/v1/media/uploads — reserve capacity and start a multipart upload. */
routes.post("/uploads", async (c) => {
  const auth = await requireAuth(c);
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  const documentId = await activeDocumentId(c);
  const { media, partCount, replayed } = await startUpload(c.env, {
    request: c.req.raw,
    accountId: auth.accountId,
    documentId,
    now: nowMs(),
  });
  return c.json(
    {
      mediaId: media.id,
      state: media.state,
      partCount,
      partBytes: NORMAL_PART_BYTES,
      cipherBytes: media.cipher_bytes,
      replayed,
    },
    replayed ? 200 : 201,
  );
});

/** GET /api/v1/media/uploads/:id — upload state plus accepted parts. */
routes.get("/uploads/:id", async (c) => {
  const auth = await requireAuth(c);
  const media = await loadUpload(c.env, c.req.param("id"), auth.accountId);
  const parts = await loadParts(c.env, media.id);
  return c.json({
    mediaId: media.id,
    state: media.state,
    cipherBytes: media.cipher_bytes,
    partCount: Math.ceil(media.cipher_bytes / NORMAL_PART_BYTES),
    acceptedParts: parts
      .filter((part) => part.state === "accepted")
      .map((part) => ({ partNumber: part.part_number, bytes: part.bytes })),
  });
});

/** PUT /api/v1/media/uploads/:id/parts/:partNumber — one ciphertext part. */
routes.put("/uploads/:id/parts/:partNumber", async (c) => {
  const auth = await requireAuth(c);
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  const media = await loadUpload(c.env, c.req.param("id"), auth.accountId);
  const partNumber = Number(c.req.param("partNumber"));
  if (!Number.isSafeInteger(partNumber) || partNumber < 1) {
    return c.json({ error: { code: "BAD_REQUEST", message: "invalid part number" } }, 400);
  }
  const body = await c.req.raw.arrayBuffer();
  const part = await acceptPart(c.env, { media, partNumber, body, now: nowMs() });
  return c.json({
    partNumber: part.part_number,
    bytes: part.bytes,
    state: part.state,
  });
});

/** POST /api/v1/media/uploads/:id/complete — verify all parts and go ready. */
routes.post("/uploads/:id/complete", async (c) => {
  const auth = await requireAuth(c);
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  const media = await loadUpload(c.env, c.req.param("id"), auth.accountId);
  const updated = await completeUpload(c.env, { media, now: nowMs() });
  return c.json({
    mediaId: updated.id,
    state: updated.state,
    cipherBytes: updated.cipher_bytes,
  });
});

/** DELETE /api/v1/media/uploads/:id — cancels an unfinished transfer. */
routes.delete("/uploads/:id", async (c) => {
  const auth = await requireAuth(c);
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  const media = await loadUpload(c.env, c.req.param("id"), auth.accountId);
  await cancelUpload(c.env, { media, now: nowMs() });
  return c.json({ ok: true });
});

/**
 * GET/HEAD /api/v1/media/:id/cipher — ciphertext with Range support.
 * Only ready objects referenced by the caller's current document are served.
 */
routes.on(["GET", "HEAD"], "/:id/cipher", async (c) => {
  const auth = await requireAuth(c);
  if (auth.scope !== "active") throw notFound("media not found");

  const row = await c.env.DB.prepare(
    `SELECT m.*, d.id AS doc_id FROM media m
       JOIN documents d ON d.id = m.document_id
       JOIN document_media dm ON dm.media_id = m.id AND dm.document_id = d.id
      WHERE m.id = ?1 AND d.account_id = ?2 AND m.state = 'ready'`,
  )
    .bind(c.req.param("id"), auth.accountId)
    .first<Parameters<typeof serveCipher>[1]["media"]>();
  if (!row) throw notFound("media not found");

  const ifMatch = c.req.header("if-match");
  if (ifMatch && normalizeEtag(ifMatch) !== `"m-${row.id}"`) {
    throw preconditionFailed("stale media ETag");
  }

  return serveCipher(c.env, { media: row, request: c.req.raw });
});

export const mediaRoutes = routes;
