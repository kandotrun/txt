/**
 * Scheduled maintenance (spec §5.3, §11.8, §15).
 *
 * - Cleans stale pending accounts (24h).
 * - Purges expired and long-revoked sessions and agent tokens.
 * - Removes unreferenced ready media after the 24h grace period.
 * - Retries unfinished/cancelled multipart cleanup.
 * - Finishes account deletion by removing ciphertext objects.
 *
 * Note: the grace period exists for cleanup/conflict/undo safety, not as a
 * trash can. A failed R2 delete is retried rather than silently dropped.
 */

import type { Env } from "./types.ts";
import { nowMs } from "./util.ts";
import { finalizeDeletion } from "./media/store.ts";

const MEDIA_BATCH = 25;

export async function runMaintenance(env: Env, _event?: ScheduledController): Promise<void> {
  const now = nowMs();

  await cleanStalePendingAccounts(env, now);
  await cleanExpiredChallenges(env, now);
  await purgeDeadCredentials(env, now);
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

/**
 * Token hashes that can never authorize anything again are not kept: an
 * expired or long-revoked session, an expired or long-revoked agent token and
 * an operation record past its expiry only add to what a database copy
 * reveals (spec §14). Recently revoked rows stay for a day so a session list
 * or an agent list read right after a revocation is still coherent.
 */
async function purgeDeadCredentials(env: Env, now: number): Promise<void> {
  const dayAgo = now - 24 * 60 * 60 * 1000;
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM sessions
        WHERE absolute_expires_at < ?1 OR idle_expires_at < ?1
           OR (revoked_at IS NOT NULL AND revoked_at < ?2)`,
    ).bind(now, dayAgo),
    env.DB.prepare(
      `DELETE FROM agent_tokens
        WHERE expires_at < ?1 OR (revoked_at IS NOT NULL AND revoked_at < ?1)`,
    ).bind(dayAgo),
    env.DB.prepare(`DELETE FROM operations WHERE expires_at IS NOT NULL AND expires_at < ?1`).bind(now),
  ]);
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
      // The live state/expiry claim retains quota, including legacy active rows.
      const claimed = await env.DB.prepare(
        `UPDATE media SET state = 'deleting', reservation_held = 1
          WHERE id = ?1 AND account_id = ?2
            AND state IN ('creating','uploading','completing')
            AND expires_at IS NOT NULL AND expires_at < ?3`,
      ).bind(media.id, media.account_id, now).run();
      if ((claimed.meta.changes ?? 0) !== 1) continue;
    } else {
      // Legacy deleting rows may already be released; never normalize their flag.
      const retry = await env.DB.prepare(
        `SELECT 1 FROM media WHERE id = ?1 AND account_id = ?2
          AND state = 'deleting' AND expires_at IS NOT NULL AND expires_at < ?3`,
      ).bind(media.id, media.account_id, now).first();
      if (!retry) continue;
    }
    await finalizeDeletion(env, media);
  }
}

/**
 * Objects removed per page (D1 binds at most 100 values per statement), and
 * pages per account per run.
 */
const DELETE_PAGE = 90;
const DELETE_PAGES_PER_RUN = 40;

/**
 * Removes every ciphertext object of one deleting account, a page at a time.
 * A media row is deleted only after R2 confirmed its object is gone, so a
 * row always stands for bytes that may still exist. Returns whether nothing
 * is left; a failure or an exhausted budget leaves the rest for the next run.
 */
async function purgeAccountMedia(env: Env, accountId: string): Promise<boolean> {
  for (let page = 0; page < DELETE_PAGES_PER_RUN; page++) {
    const media = await env.DB.prepare(
      `SELECT id, object_key, upload_id FROM media WHERE account_id = ?1 LIMIT ?2`,
    )
      .bind(accountId, DELETE_PAGE)
      .all<{ id: string; object_key: string; upload_id: string | null }>();
    const rows = media.results ?? [];
    if (rows.length === 0) return true;

    try {
      for (const row of rows) {
        if (!row.upload_id) continue;
        try {
          await env.MEDIA.resumeMultipartUpload(row.object_key, row.upload_id).abort();
        } catch (error) {
          // 10024 (NoSuchUpload) proves the multipart bytes are already gone;
          // anything else cannot, so the row must survive for a retry.
          if (!(error instanceof Error) || !/\(10024\)\s*$/.test(error.message)) throw error;
        }
      }
      await env.MEDIA.delete(rows.map((row) => row.object_key));
    } catch {
      return false;
    }

    const ids = rows.map((row) => row.id);
    const marks = ids.map((_, index) => `?${index + 2}`).join(",");
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM document_media WHERE media_id IN (${marks})
            AND document_id IN (SELECT id FROM documents WHERE account_id = ?1)`,
      ).bind(accountId, ...ids),
      env.DB.prepare(`DELETE FROM media WHERE account_id = ?1 AND id IN (${marks})`).bind(accountId, ...ids),
    ]);
  }
  return false;
}

async function finishAccountDeletions(env: Env, _now: number): Promise<void> {
  const accounts = await env.DB.prepare(
    `SELECT id FROM accounts WHERE status = 'deleting' LIMIT 10`,
  ).all<{ id: string }>();

  for (const account of accounts.results ?? []) {
    if (!(await purgeAccountMedia(env, account.id))) continue;

    // No media row is left, so no ciphertext object is left. The account row
    // goes last, and only if it is still deleting and still has no media.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM document_media WHERE document_id IN (
          SELECT id FROM documents WHERE account_id = ?1)`).bind(account.id),
      env.DB.prepare(`DELETE FROM documents WHERE account_id = ?1
          AND NOT EXISTS (SELECT 1 FROM media WHERE account_id = ?1)`).bind(account.id),
      env.DB.prepare(`DELETE FROM key_envelopes WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM recovery WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM credentials WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM sessions WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM operations WHERE account_id = ?1`).bind(account.id),
      env.DB.prepare(`DELETE FROM storage_usage WHERE account_id = ?1
          AND NOT EXISTS (SELECT 1 FROM media WHERE account_id = ?1)`).bind(account.id),
      env.DB.prepare(`DELETE FROM accounts WHERE id = ?1 AND status = 'deleting'
          AND NOT EXISTS (SELECT 1 FROM media WHERE account_id = ?1)`).bind(account.id),
    ]);
  }
}
