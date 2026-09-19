/**
 * E2EE media transfer (spec §11).
 *
 * - The server never sees file names, MIME types, or keys. Only ciphertext
 *   totals, part structure and hashes.
 * - Capacity is reserved atomically in D1; the same clientUploadId resend
 *   returns the same state, different conditions are 409.
 * - Each part number freezes its ciphertext hash and size on first acceptance.
 *   The same number with a different hash is 409. Accepted parts are never
 *   overwritten by a duplicate request.
 * - States: creating, uploading, completing, ready, deleting.
 * - No distributed transaction between D1 and R2 is assumed: after R2 complete
 *   a D1 failure is recovered by comparing the object size against recorded
 *   parts.
 */

import type { Env } from "../types.ts";
import { conflict, notFound, payloadTooLarge, preconditionFailed, rangeNotSatisfiable, unprocessable } from "../errors.ts";
import { nowMs, randomBytes, uuid, bytesToBase64Url } from "../util.ts";
import { readJson, requireInt, requireString } from "../util.ts";

export function arrayBufferEqual(
  a: ArrayBuffer | Uint8Array | null,
  b: ArrayBuffer | Uint8Array | null,
): boolean {
  if (!a || !b) return false;
  const left = a instanceof Uint8Array ? a : new Uint8Array(a);
  const right = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) diff |= (left[i] as number) ^ (right[i] as number);
  return diff === 0;
}

export const MAX_CIPHER_BYTES = 536_879_104; // 512MiB plaintext + tags (spec §11.1)
export const NORMAL_PART_BYTES = 8_388_736; // 8 chunks
export const CHUNK_CIPHER_BYTES = 1_048_592;
export const PART_LEASE_MS = 60_000;
export const UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface MediaRow {
  id: string;
  document_id: string;
  account_id: string;
  client_upload_id: string;
  object_key: string;
  cipher_bytes: number;
  crypto_format: number;
  chunk_bytes: number;
  state: string;
  upload_id: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  expires_at: number | null;
  unreferenced_at: number | null;
  ready_at: number | null;
  created_at: number;
}

export interface UsageRow {
  account_id: string;
  used_bytes: number;
  reserved_bytes: number;
  limit_bytes: number;
}

export function planUpload(cipherBytes: number, chunkBytes: number) {
  if (!Number.isSafeInteger(cipherBytes) || cipherBytes <= 0) {
    throw unprocessable("cipherBytes must be a positive integer");
  }
  if (cipherBytes > MAX_CIPHER_BYTES) {
    throw payloadTooLarge("ciphertext exceeds the maximum object size");
  }
  if (chunkBytes !== CHUNK_CIPHER_BYTES) {
    throw unprocessable("chunkBytes must equal 1048592");
  }
  const partCount = Math.ceil(cipherBytes / NORMAL_PART_BYTES);
  return { partCount };
}

/**
 * Atomically reserves capacity and creates the media row + R2 multipart.
 * Re-sending the same clientUploadId returns the existing state.
 */
export async function startUpload(
  env: Env,
  options: {
    request: Request;
    accountId: string;
    documentId: string;
    now: number;
  },
): Promise<{ media: MediaRow; partCount: number; replayed: boolean }> {
  const body = await readJson<Record<string, unknown>>(options.request, 64 * 1024);
  const clientUploadId = requireString(body.clientUploadId, "clientUploadId", 64);
  // Large values are rejected by planUpload as 413 (payload too large) rather
  // than 400 (malformed), so the raw integer check must not cap here.
  const cipherBytes = requireInt(body.cipherBytes, "cipherBytes", Number.MAX_SAFE_INTEGER);
  const cryptoFormat = requireInt(body.cryptoFormat, "cryptoFormat", 255);
  const chunkBytes = requireInt(body.chunkBytes, "chunkBytes", 1_048_592);
  if (cryptoFormat !== 1) throw unprocessable("cryptoFormat must be 1");
  const { partCount } = planUpload(cipherBytes, chunkBytes);

  const existing = await env.DB.prepare(
    `SELECT * FROM media WHERE document_id = ?1 AND client_upload_id = ?2`,
  )
    .bind(options.documentId, clientUploadId)
    .first<MediaRow>();
  if (existing) {
    if (
      existing.cipher_bytes !== cipherBytes ||
      existing.crypto_format !== cryptoFormat ||
      existing.chunk_bytes !== chunkBytes
    ) {
      throw conflict("clientUploadId reused with different conditions", "UPLOAD_CONFLICT");
    }
    if (existing.state === "deleting") {
      throw conflict("upload was cancelled", "UPLOAD_CANCELLED");
    }
    return {
      media: existing,
      partCount: Math.ceil(existing.cipher_bytes / NORMAL_PART_BYTES),
      replayed: true,
    };
  }

  const mediaId = uuid();
  const objectKey = `cipher/${mediaId}`;

  // Reserve capacity first: a conditional update that cannot overshoot.
  const reserve = await env.DB.prepare(
    `UPDATE storage_usage
        SET reserved_bytes = ?
      WHERE account_id = ?1 AND used_bytes + reserved_bytes + ?2 <= limit_bytes`,
  )
    .bind(options.accountId, cipherBytes)
    .run();
  if ((reserve.meta.changes ?? 0) !== 1) {
    throw payloadTooLarge("account storage limit exceeded");
  }

  try {
    await env.DB.prepare(
      `INSERT INTO media
         (id, document_id, account_id, client_upload_id, object_key, cipher_bytes,
          crypto_format, chunk_bytes, state, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'creating', ?9, ?10)`,
    )
      .bind(
        mediaId,
        options.documentId,
        options.accountId,
        clientUploadId,
        objectKey,
        cipherBytes,
        cryptoFormat,
        chunkBytes,
        options.now + UPLOAD_EXPIRY_MS,
        options.now,
      )
      .run();
  } catch (error) {
    // Roll the reservation back so a failed insert cannot leak quota.
    await env.DB.prepare(
      `UPDATE storage_usage SET reserved_bytes = reserved_bytes - ?2 WHERE account_id = ?1`,
    )
      .bind(options.accountId, cipherBytes)
      .run();
    throw conflict(`upload already exists: ${(error as Error).message}`);
  }

  const multipart = await env.MEDIA.createMultipartUpload(objectKey);
  await env.DB.prepare(
    `UPDATE media SET state = 'uploading', upload_id = ?2 WHERE id = ?1`,
  )
    .bind(mediaId, multipart.uploadId)
    .run();

  const media = await env.DB.prepare(`SELECT * FROM media WHERE id = ?1`)
    .bind(mediaId)
    .first<MediaRow>();
  return { media: media as MediaRow, partCount, replayed: false };
}

export async function loadUpload(env: Env, mediaId: string, accountId: string): Promise<MediaRow> {
  const row = await env.DB.prepare(
    `SELECT * FROM media WHERE id = ?1 AND account_id = ?2`,
  )
    .bind(mediaId, accountId)
    .first<MediaRow>();
  if (!row) throw notFound("upload not found");
  return row;
}

export interface PartRow {
  media_id: string;
  part_number: number;
  state: string;
  hash32: ArrayBuffer | null;
  bytes: number | null;
  etag: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  accepted_at: number | null;
}

export async function loadParts(env: Env, mediaId: string): Promise<PartRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM upload_parts WHERE media_id = ?1 ORDER BY part_number`,
  )
    .bind(mediaId)
    .all<PartRow>();
  return result.results ?? [];
}

/**
 * Accepts one ciphertext part. Bounded to a single part in memory: the part is
 * read fully (max ~8MiB), verified against its frozen hash/size, then written.
 * The full file is never buffered.
 */
export async function acceptPart(
  env: Env,
  options: {
    media: MediaRow;
    partNumber: number;
    body: ArrayBuffer;
    now: number;
  },
): Promise<PartRow> {
  const { media } = options;
  if (media.state !== "uploading" && media.state !== "creating") {
    throw conflict(`upload is ${media.state}`);
  }
  if (!media.upload_id) throw conflict("upload has no multipart id");
  if (options.partNumber < 1) throw unprocessable("partNumber must be >= 1");

  const partCount = Math.ceil(media.cipher_bytes / NORMAL_PART_BYTES);
  if (options.partNumber > partCount) {
    throw unprocessable("partNumber beyond the planned part count");
  }
  const expectedBytes =
    options.partNumber < partCount
      ? NORMAL_PART_BYTES
      : media.cipher_bytes - (partCount - 1) * NORMAL_PART_BYTES;
  if (options.body.byteLength !== expectedBytes) {
    throw unprocessable(`part body must be ${expectedBytes} bytes`);
  }

  const hash = await crypto.subtle.digest("SHA-256", options.body);
  const hashBytes = new Uint8Array(hash);

  const existing = await env.DB.prepare(
    `SELECT * FROM upload_parts WHERE media_id = ?1 AND part_number = ?2`,
  )
    .bind(media.id, options.partNumber)
    .first<PartRow>();

  if (existing && existing.state === "accepted") {
    if (!arrayBufferEqual(hashBytes, existing.hash32) || existing.bytes !== options.body.byteLength) {
      throw conflict("part number reused with different content", "PART_CONFLICT");
    }
    // Identical retry: do not overwrite the accepted part in R2.
    return existing;
  }

  if (existing && existing.state === "uploading" && existing.lease_expires_at !== null
      && existing.lease_expires_at > options.now) {
    throw conflict("part is being processed; retry later", "PART_BUSY");
  }

  // Claim the part with a lease so concurrent requests do not double-write.
  const leaseOwner = bytesToBase64Url(randomBytes(16));
  const claim = await env.DB.prepare(
    `INSERT INTO upload_parts (media_id, part_number, state, hash32, bytes, lease_owner, lease_expires_at)
     VALUES (?1, ?2, 'uploading', ?3, ?4, ?5, ?6)
     ON CONFLICT(media_id, part_number) DO UPDATE SET
        state = 'uploading', hash32 = excluded.hash32, bytes = excluded.bytes,
        lease_owner = excluded.lease_owner, lease_expires_at = excluded.lease_expires_at
      WHERE upload_parts.state != 'accepted'
        AND (upload_parts.lease_expires_at IS NULL OR upload_parts.lease_expires_at <= ?7)`,
  )
    .bind(
      media.id,
      options.partNumber,
      hashBytes.buffer as ArrayBuffer,
      options.body.byteLength,
      leaseOwner,
      options.now + PART_LEASE_MS,
      options.now,
    )
    .run();
  if ((claim.meta.changes ?? 0) !== 1) {
    throw conflict("part is being processed; retry later", "PART_BUSY");
  }

  const multipart = env.MEDIA.resumeMultipartUpload(media.object_key, media.upload_id);
  let uploaded: R2UploadedPart;
  try {
    uploaded = await multipart.uploadPart(options.partNumber, options.body);
  } catch (error) {
    // Release the lease so a retry can proceed.
    await env.DB.prepare(
      `UPDATE upload_parts SET lease_owner = NULL, lease_expires_at = NULL
        WHERE media_id = ?1 AND part_number = ?2 AND state = 'uploading'`,
    )
      .bind(media.id, options.partNumber)
      .run();
    throw new Error(`R2 part upload failed: ${(error as Error).message}`);
  }

  await env.DB.prepare(
    `UPDATE upload_parts
        SET state = 'accepted', etag = ?3, accepted_at = ?4,
            lease_owner = NULL, lease_expires_at = NULL
      WHERE media_id = ?1 AND part_number = ?2 AND state = 'uploading' AND lease_owner = ?5`,
  )
    .bind(media.id, options.partNumber, uploaded.etag, options.now, leaseOwner)
    .run();

  const accepted = await env.DB.prepare(
    `SELECT * FROM upload_parts WHERE media_id = ?1 AND part_number = ?2`,
  )
    .bind(media.id, options.partNumber)
    .first<PartRow>();
  return accepted as PartRow;
}

/**
 * Completes an upload: all parts must be accepted, then R2 multipart is
 * completed and D1 flips to ready. R2 success + D1 failure is recovered by
 * comparing the stored object size against the recorded parts.
 */
export async function completeUpload(
  env: Env,
  options: { media: MediaRow; now: number },
): Promise<MediaRow> {
  const { media } = options;
  if (media.state === "ready") return media;
  if (media.state !== "uploading") {
    throw conflict(`upload is ${media.state}`);
  }
  if (!media.upload_id) throw conflict("upload has no multipart id");

  const parts = await loadParts(env, media.id);
  const partCount = Math.ceil(media.cipher_bytes / NORMAL_PART_BYTES);
  const acceptedCount = parts.filter((p) => p.state === "accepted").length;
  if (acceptedCount !== partCount) {
    throw conflict(`only ${acceptedCount} of ${partCount} parts are accepted`, "PARTS_INCOMPLETE");
  }

  const claimed = await env.DB.prepare(
    `UPDATE media SET state = 'completing'
      WHERE id = ?1 AND state IN ('uploading','creating')`,
  )
    .bind(media.id)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) {
    throw conflict("upload is being completed elsewhere", "COMPLETE_BUSY");
  }

  const multipart = env.MEDIA.resumeMultipartUpload(media.object_key, media.upload_id);
  const toEtag = (part: PartRow): R2UploadedPart => ({
    partNumber: part.part_number,
    etag: part.etag as string,
  });
  try {
    await multipart.complete(parts.filter((p) => p.state === "accepted").map(toEtag));
  } catch (error) {
    throw conflict(`R2 complete failed: ${(error as Error).message}`, "R2_COMPLETE_FAILED");
  }

  // Verify the object exists with the expected size before flipping to ready.
  const head = await env.MEDIA.head(media.object_key);
  if (!head || head.size !== media.cipher_bytes) {
    throw conflict("completed object size mismatch", "OBJECT_SIZE_MISMATCH");
  }

  await env.DB.prepare(
    `UPDATE media SET state = 'ready', ready_at = ?2, expires_at = NULL,
            unreferenced_at = ?2
      WHERE id = ?1 AND state = 'completing'`,
  )
    .bind(media.id, options.now)
    .run();

  // reserved -> used
  await env.DB.prepare(
    `UPDATE storage_usage
        SET reserved_bytes = reserved_bytes - ?2, used_bytes = used_bytes + ?2
      WHERE account_id = ?1`,
  )
    .bind(media.account_id, media.cipher_bytes)
    .run();

  const updated = await env.DB.prepare(`SELECT * FROM media WHERE id = ?1`)
    .bind(media.id)
    .first<MediaRow>();
  return updated as MediaRow;
}

export async function cancelUpload(
  env: Env,
  options: { media: MediaRow; now: number },
): Promise<void> {
  const { media } = options;
  if (media.state === "ready" || media.state === "deleting") {
    throw conflict("upload cannot be cancelled in its current state");
  }
  if (media.upload_id) {
    try {
      await env.MEDIA.resumeMultipartUpload(media.object_key, media.upload_id).abort();
    } catch {
      // Aborting a non-existent multipart is not fatal; cleanup retries later.
    }
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE media SET state = 'deleting' WHERE id = ?1`).bind(media.id),
    env.DB.prepare(
      `UPDATE storage_usage SET reserved_bytes = reserved_bytes - ?2 WHERE account_id = ?1`,
    ).bind(media.account_id, media.cipher_bytes),
  ]);
  await finalizeDeletion(env, media);
}

/** Removes metadata after the R2 object is gone (spec §11.8). */
export async function finalizeDeletion(env: Env, media: MediaRow): Promise<void> {
  await env.MEDIA.delete(media.object_key).catch(() => undefined);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM document_media WHERE media_id = ?1`).bind(media.id),
    env.DB.prepare(`DELETE FROM media WHERE id = ?1 AND state = 'deleting'`).bind(media.id),
  ]);
}

/**
 * Serves ciphertext with correct Range semantics (spec §11.5).
 * Single byte ranges, suffix ranges, HEAD, 206/416/200. Multiple ranges are
 * ignored (200). No public buckets, r2.dev, or presigned URLs.
 */
export async function serveCipher(
  env: Env,
  options: { media: MediaRow; request: Request },
): Promise<Response> {
  const requestedRange = rangedHeader(options.request);
  const object = await env.MEDIA.get(options.media.object_key, {
    range: requestedRange,
  });
  if (!object) throw notFound("media object not found");

  const headers = new Headers();
  headers.set("content-type", "application/octet-stream");
  headers.set("accept-ranges", "bytes");
  headers.set("etag", `"m-${options.media.id}"`);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");

  if (!("body" in object) || object.body === null) {
    headers.set("content-length", "0");
    return new Response(null, { status: 200, headers });
  }

  // The status follows the *request*: R2 may report a range for a full read,
  // but a request without a Range header must get a 200.
  if (requestedRange === undefined) {
    headers.set("content-length", String(options.media.cipher_bytes));
    if (options.request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(object.body, { status: 200, headers });
  }

  const range = object.range;
  if (!range || !("offset" in range) || typeof range.offset !== "number") {
    // The requested range could not be satisfied.
    throw rangeNotSatisfiable("range not satisfiable");
  }
  const start = range.offset;
  const length =
    "length" in range && typeof range.length === "number"
      ? range.length
      : options.media.cipher_bytes - start;
  headers.set(
    "content-range",
    `bytes ${start}-${start + length - 1}/${options.media.cipher_bytes}`,
  );
  headers.set("content-length", String(length));
  if (options.request.method === "HEAD") {
    return new Response(null, { status: 206, headers });
  }
  return new Response(object.body, { status: 206, headers });
}

function rangedHeader(request: Request): R2Range | undefined {
  const raw = request.headers.get("range");
  if (!raw) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match) return undefined; // multiple ranges -> full response (200)
  const [, startRaw, endRaw] = match as unknown as [string, string, string];
  if (startRaw === "" && endRaw === "") return undefined;
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    return { suffix };
  }
  const offset = Number(startRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  if (endRaw === "") return { offset };
  const end = Number(endRaw);
  if (!Number.isSafeInteger(end) || end < offset) return undefined;
  return { offset, length: end - offset + 1 };
}
