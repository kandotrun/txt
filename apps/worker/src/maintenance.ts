/**
 * Scheduled maintenance (spec §5.3, §11.8, §15).
 *
 * - Cleans stale pending accounts (24h).
 * - Removes unreferenced ready media after the 24h grace period.
 * - Retries unfinished/cancelled multipart cleanup.
 * - Finishes account deletion by removing ciphertext objects.
 *
 * Note: the grace period exists for cleanup/conflict/undo safety, not as a
 * trash can. A failed R2 delete is retried rather than silently dropped.
 */

import type { Env } from "./types.ts";
import { nowMs } from "./util.ts";

const MEDIA_BATCH = 25;

export async function runMaintenance(env: Env, _event?: ScheduledController): Promise<void> {
  const now = nowMs();

  await cleanStalePendingAccounts(env, now);
  await cleanExpiredChallenges(env, now);
  await cleanUnreferencedMedia(env, now);
  await cleanStaleUploads(env, now);
  await finishAccountDeletions(env, now);
}

async function cleanStalePendingAccounts(env: Env, now: number): Promise<void> {
  const cutoff = now - 24 * 60 * 60 * 1000;
  const stale = await env.DB.prepare(
    `SELECT id FROM accounts WHERE status = 'pending' AND created_at < ?1 LIMIT 50`,
  )
    .bind(cutoff)
    .all<{ id: string }>();
  for (const account of stale.results ?? []) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM key_envelopes WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM challenges WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM sessions WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM credentials WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM accounts WHERE id = ?1 AND status = 'pending'`).bind(account.id),
    ]);
  }
}

async function cleanExpiredChallenges(env: Env, now: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM challenges WHERE expires_at < ?1`)
    .bind(now - 60 * 60 * 1000)
    .run();
  await env.DB.prepare(`DELETE FROM rate_limits WHERE window_start < ?1`)
    .bind(now - 24 * 60 * 60 * 1000)
    .run();
}

async function cleanUnreferencedMedia(env: Env, now: number): Promise<void> {
  const graceMs = Number(env.MEDIA_GRACE_MS) || 24 * 60 * 60 * 1000;
  const cutoff = now - graceMs;
  const rows = await env.DB.prepare(
    `SELECT id, object_key, account_id, cipher_bytes FROM media
      WHERE state = 'ready' AND unreferenced_at IS NOT NULL AND unreferenced_at < ?1
      LIMIT ?2`,
  )
    .bind(cutoff, MEDIA_BATCH)
    .all<{ id: string; object_key: string; account_id: string; cipher_bytes: number }>();

  for (const media of rows.results ?? []) {
    // Re-confirm inside a transaction: a re-reference that succeeded first must
    // win, and such an object is never deleted.
    const stillUnreferenced = await env.DB.prepare(
      `SELECT 1 FROM media m
        WHERE m.id = ?1 AND m.state = 'ready' AND m.unreferenced_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM document_media dm WHERE dm.media_id = m.id)`,
    )
      .bind(media.id)
      .first();
    if (!stillUnreferenced) continue;

    const claimed = await env.DB.prepare(
      `UPDATE media SET state = 'deleting'
        WHERE id = ?1 AND state = 'ready' AND unreferenced_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM document_media dm WHERE dm.media_id = media.id)`,
    )
      .bind(media.id)
      .run();
    if ((claimed.meta.changes ?? 0) !== 1) continue;

    try {
      await env.MEDIA.delete(media.object_key);
    } catch {
      // Retry on the next run; the row stays in `deleting` until R2 confirms.
      continue;
    }
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM document_media WHERE media_id = ?1`).bind(media.id),
      env.DB.prepare(`DELETE FROM media WHERE id = ?1 AND state = 'deleting'`).bind(media.id),
      env.DB.prepare(
        `UPDATE storage_usage SET used_bytes = MAX(used_bytes - ?2, 0) WHERE account_id = ?1`,
      ).bind(media.account_id, media.cipher_bytes),
    ]);
  }
}

async function cleanStaleUploads(env: Env, now: number): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, object_key, account_id, cipher_bytes, state, upload_id FROM media
      WHERE state IN ('creating','uploading','completing','deleting')
        AND (expires_at IS NOT NULL AND expires_at < ?1)
      LIMIT ?2`,
  )
    .bind(now, MEDIA_BATCH)
    .all<{
      id: string;
      object_key: string;
      account_id: string;
      cipher_bytes: number;
      state: string;
      upload_id: string | null;
    }>();

  for (const media of rows.results ?? []) {
    if (media.state !== "deleting") {
      if (media.upload_id) {
        try {
          await env.MEDIA.resumeMultipartUpload(media.object_key, media.upload_id).abort();
        } catch {
          // Already gone; proceed to metadata cleanup.
        }
      }
      const claimed = await env.DB.prepare(
        `UPDATE media SET state = 'deleting' WHERE id = ?1 AND state != 'ready'`,
      )
        .bind(media.id)
        .run();
      if ((claimed.meta.changes ?? 0) !== 1) continue;
    }
    try {
      await env.MEDIA.delete(media.object_key);
    } catch {
      continue;
    }
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM media WHERE id = ?1 AND state = 'deleting'`).bind(media.id),
      env.DB.prepare(
        `UPDATE storage_usage SET reserved_bytes = MAX(reserved_bytes - ?2, 0) WHERE account_id = ?1`,
      ).bind(media.account_id, media.cipher_bytes),
    ]);
  }
}

async function finishAccountDeletions(env: Env, _now: number): Promise<void> {
  const accounts = await env.DB.prepare(
    `SELECT id FROM accounts WHERE status = 'deleting' LIMIT 10`,
  ).all<{ id: string }>();

  for (const account of accounts.results ?? []) {
    const media = await env.DB.prepare(
      `SELECT id, object_key FROM media WHERE account_id = ?1 LIMIT 200`,
    )
      .bind(account.id)
      .all<{ id: string; object_key: string }>();

    let failed = false;
    for (const object of media.results ?? []) {
      try {
        await env.MEDIA.delete(object.object_key);
      } catch {
        failed = true;
      }
    }
    if (failed) continue;

    // Keep the minimum state needed to retry physical deletion, then remove
    // the account row last so a partial failure cannot orphan data silently.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM document_media WHERE document_id IN (
          SELECT id FROM documents WHERE account_id = ?1)`).bind(account.id),
      env.DB.prepare(`DELETE FROM media WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM documents WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM key_envelopes WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM recovery WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM credentials WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM sessions WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM storage_usage WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM accounts WHERE id = ?1 AND status = 'deleting'`).bind(account.id),
    ]);
  }
}
