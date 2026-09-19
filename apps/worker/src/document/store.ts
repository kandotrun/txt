/**
 * Document storage: conditional GET/PUT with idempotent mutations (spec §10).
 *
 * ETag format: `"d-<documentId>-e-<syncEpoch>-r<revision>"`.
 * - The document is resolved from the authenticated owner; ID, epoch and
 *   revision are all checked.
 * - `If-Match: *` and Last Write Wins are not allowed.
 * - Same mutationId + identical payload = no-op (idempotent). Same mutationId
 *   with a different payload = 409. Later updates proceed to normal CAS.
 * - CAS, referenced-media validation, reference-set update and unreferenced_at
 *   update happen in one D1 transaction. A 0-row UPDATE is not an error, so
 *   every later statement is guarded by the CAS having actually applied —
 *   invalid references therefore produce NO partial update.
 */

import type { Env } from "../types.ts";
import { conflict, preconditionFailed, unprocessable } from "../errors.ts";
import { readJson, requireInt, requireString } from "../util.ts";
import { derivePayloadHash } from "./payload-hash.ts";

export interface DocumentRow {
  id: string;
  account_id: string;
  sync_epoch: number;
  revision: number;
  encrypted_revision: number;
  format_version: number;
  key_version: number;
  mutation_id: string;
  nonce: ArrayBuffer;
  ciphertext: ArrayBuffer;
  last_payload_hash32: ArrayBuffer;
  updated_at: number;
}

export interface DocumentUpdate {
  mutationId: string;
  formatVersion: number;
  keyVersion: number;
  encryptedRevision: number;
  nonce: ArrayBuffer;
  ciphertext: ArrayBuffer;
  referencedMediaIds: string[];
}

const MAX_CIPHERTEXT_BYTES = 2_097_152; // 2MiB request budget (spec §11.1)

export function etagFor(row: { id: string; sync_epoch: number; revision: number }): string {
  return `"d-${row.id}-e-${row.sync_epoch}-r${row.revision}"`;
}

/**
 * Normalizes an ETag for comparison.
 *
 * Cloudflare's edge rewrites an origin ETag into its weak form (`W/"..."`) when
 * it processes the response, so a client can legitimately echo back either
 * form. The value is opaque and both sides are ours, so the comparison strips
 * the weakness marker; the ID/epoch/revision triple is still verified exactly
 * (spec §10.2).
 */
export function normalizeEtag(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
}

export function ifMatchMatches(header: string | null, row: DocumentRow): boolean {
  if (!header) return false;
  // `If-Match: *` and Last Write Wins are explicitly not allowed (spec §10.2).
  return normalizeEtag(header) === etagFor(row);
}

export async function loadDocument(env: Env, accountId: string): Promise<DocumentRow | null> {
  return env.DB.prepare(
    `SELECT id, account_id, sync_epoch, revision, encrypted_revision, format_version,
            key_version, mutation_id, nonce, ciphertext, last_payload_hash32, updated_at
       FROM documents WHERE account_id = ?1`,
  )
    .bind(accountId)
    .first<DocumentRow>();
}

export async function loadDocumentMeta(
  env: Env,
  accountId: string,
): Promise<Pick<DocumentRow, "id" | "sync_epoch" | "revision"> | null> {
  return env.DB.prepare(
    `SELECT id, sync_epoch, revision FROM documents WHERE account_id = ?1`,
  )
    .bind(accountId)
    .first<Pick<DocumentRow, "id" | "sync_epoch" | "revision">>();
}

export function decodeBase64Url(input: unknown, field: string, expectedLength?: number): ArrayBuffer {
  if (typeof input !== "string") {
    throw unprocessable(`field ${field} must be base64url`);
  }
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw unprocessable(`field ${field} is not valid base64url`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
    throw unprocessable(`field ${field} must be ${expectedLength} bytes`);
  }
  return bytes.buffer as ArrayBuffer;
}

export function encodeBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.byteLength ? (bytes[i + 1] as number) : undefined;
    const b2 = i + 2 < bytes.byteLength ? (bytes[i + 2] as number) : undefined;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += ALPHABET[b2 & 0x3f];
  }
  return out;
}

export interface ParsedUpdate {
  update: DocumentUpdate;
  payloadHash: ArrayBuffer;
}

/** Parses and validates a PUT /document body (spec §12.2). */
export async function parseDocumentUpdate(
  request: Request,
  accountId: string,
  documentId: string,
): Promise<ParsedUpdate> {
  const body = await readJson<Record<string, unknown>>(request, MAX_CIPHERTEXT_BYTES);
  const mutationId = requireString(body.mutationId, "mutationId", 64);
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(mutationId)) {
    throw unprocessable("mutationId must be a UUID");
  }
  const formatVersion = requireInt(body.formatVersion, "formatVersion", 255);
  const keyVersion = requireInt(body.keyVersion, "keyVersion", 255);
  const encryptedRevision = requireInt(body.encryptedRevision, "encryptedRevision");
  const nonce = decodeBase64Url(body.nonce, "nonce", 12);
  const ciphertext = decodeBase64Url(body.ciphertext, "ciphertext");
  if (ciphertext.byteLength === 0) {
    throw unprocessable("ciphertext must not be empty");
  }
  const referencedRaw = body.referencedMediaIds;
  if (!Array.isArray(referencedRaw)) {
    throw unprocessable("referencedMediaIds must be an array");
  }
  const referencedMediaIds: string[] = [];
  for (const value of referencedRaw) {
    if (typeof value !== "string" || !/^[0-9a-fA-F-]{36}$/.test(value)) {
      throw unprocessable("referencedMediaIds contains an invalid id");
    }
    referencedMediaIds.push(value);
  }
  const sorted = [...referencedMediaIds].sort();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) {
      throw unprocessable("referencedMediaIds must not contain duplicates");
    }
  }
  if (referencedMediaIds.join("\0") !== sorted.join("\0")) {
    throw unprocessable("referencedMediaIds must be sorted");
  }

  const update: DocumentUpdate = {
    mutationId,
    formatVersion,
    keyVersion,
    encryptedRevision,
    nonce,
    ciphertext,
    referencedMediaIds,
  };
  const payloadHash = await derivePayloadHash({ accountId, documentId, update });
  return { update, payloadHash };
}

/**
 * Applies a document update with CAS in a single D1 transaction.
 * Throws ApiError 409 (idempotency), 412 (stale ETag) or 422 (references).
 */
export async function applyDocumentUpdate(
  env: Env,
  options: {
    accountId: string;
    documentId: string;
    row: DocumentRow;
    parsed: ParsedUpdate;
    now: number;
  },
): Promise<{ revision: number; updatedAt: number }> {
  const { update, payloadHash } = options.parsed;
  const { row } = options;

  if (update.formatVersion !== row.format_version || update.keyVersion !== row.key_version) {
    throw unprocessable("formatVersion/keyVersion do not match the stored document");
  }

  // Idempotency: identical re-send of the last mutation is a no-op.
  if (update.mutationId === row.mutation_id) {
    if (arrayBufferEqual(payloadHash, row.last_payload_hash32)) {
      return { revision: row.revision, updatedAt: row.updated_at };
    }
    throw conflict("mutationId reused with a different payload", "MUTATION_CONFLICT");
  }

  // The wire contract: encryptedRevision must be the current revision + 1.
  if (update.encryptedRevision !== row.revision + 1) {
    throw preconditionFailed("encryptedRevision must equal the current revision + 1");
  }

  const nextRevision = row.revision + 1;
  const idsJson = JSON.stringify(update.referencedMediaIds);
  const refCount = update.referencedMediaIds.length;

  // Diagnostic pre-check only. Atomicity does NOT depend on it: the CAS
  // statement below re-verifies the reference set inside the transaction.
  if (refCount > 0) {
    const pre = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM json_each(?1) j
        JOIN media m ON m.id = j.value
       WHERE m.document_id = ?2 AND m.account_id = ?3 AND m.state = 'ready'`,
    )
      .bind(idsJson, row.id, options.accountId)
      .first<{ n: number }>();
    if ((pre?.n ?? 0) !== refCount) {
      throw unprocessable("referencedMediaIds contains media that is not ready or not owned");
    }
  }

  // Guard: every later statement only applies when the CAS update applied.
  const casGuard = `EXISTS (SELECT 1 FROM documents d
     WHERE d.id = ?1 AND d.revision = ?2 AND d.mutation_id = ?3)`;

  const statements: D1PreparedStatement[] = [];
  statements.push(
    env.DB.prepare(
      `UPDATE documents
          SET revision = ?4, encrypted_revision = ?5, mutation_id = ?6, nonce = ?7,
              ciphertext = ?8, last_payload_hash32 = ?9, updated_at = ?10
        WHERE id = ?1 AND revision = ?2 AND mutation_id = ?3
          AND (?11 = 0 OR (SELECT COUNT(*) FROM json_each(?12) j
                             JOIN media m ON m.id = j.value
                            WHERE m.document_id = ?1 AND m.account_id = ?13
                              AND m.state = 'ready') = ?11)`,
    ).bind(
      row.id,
      row.revision,
      row.mutation_id,
      nextRevision,
      update.encryptedRevision,
      update.mutationId,
      update.nonce,
      update.ciphertext,
      payloadHash,
      options.now,
      refCount,
      idsJson,
      options.accountId,
    ),
  );
  statements.push(
    env.DB.prepare(
      `DELETE FROM document_media
        WHERE document_id = ?1 AND ${casGuard}`,
    ).bind(row.id, nextRevision, update.mutationId),
  );
  if (refCount > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO document_media (document_id, media_id)
         SELECT ?1, j.value FROM json_each(?4) j
          WHERE ${casGuard}
            AND EXISTS (SELECT 1 FROM media m
                         WHERE m.id = j.value AND m.document_id = ?1
                           AND m.account_id = ?5 AND m.state = 'ready')`,
      ).bind(row.id, nextRevision, update.mutationId, idsJson, options.accountId),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE media SET unreferenced_at = COALESCE(unreferenced_at, ?4)
        WHERE document_id = ?1 AND state = 'ready' AND ${casGuard}
          AND id NOT IN (SELECT media_id FROM document_media WHERE document_id = ?1)`,
    ).bind(row.id, nextRevision, update.mutationId, options.now),
  );
  statements.push(
    env.DB.prepare(
      `UPDATE media SET unreferenced_at = NULL
        WHERE document_id = ?1 AND ${casGuard}
          AND id IN (SELECT media_id FROM document_media WHERE document_id = ?1)`,
    ).bind(row.id, nextRevision, update.mutationId),
  );

  const results = await env.DB.batch(statements);
  const casChanges = results[0]?.meta.changes ?? 0;
  if (casChanges !== 1) {
    throw preconditionFailed("document changed while saving");
  }

  return { revision: nextRevision, updatedAt: options.now };
}

function arrayBufferEqual(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  const left = a instanceof Uint8Array ? a : new Uint8Array(a);
  const right = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) diff |= (left[i] as number) ^ (right[i] as number);
  return diff === 0;
}
