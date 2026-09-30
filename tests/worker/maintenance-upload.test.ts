/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runMaintenance } from "../../apps/worker/src/maintenance.ts";
import { acceptPart, cancelUpload, completeUpload, loadUpload, startUpload } from "../../apps/worker/src/media/store.ts";
import type { Env } from "../../apps/worker/src/types.ts";

const real = env as Env;
let accountId: string;
let documentId: string;

beforeEach(async () => {
  await real.DB.prepare(`DELETE FROM accounts`).run();
  accountId = crypto.randomUUID();
  documentId = crypto.randomUUID();
  await real.DB.batch([
    real.DB.prepare(`INSERT INTO accounts (id,user_handle,display_label,status,created_at) VALUES (?1,?2,'GC test','active',?3)`)
      .bind(accountId, new Uint8Array(32), Date.now()),
    real.DB.prepare(`INSERT INTO documents (id,account_id,sync_epoch,format_version,key_version,mutation_id,nonce,ciphertext,last_payload_hash32,updated_at)
      VALUES (?1,?2,1,1,1,?1,?3,?3,?3,?4)`).bind(documentId, accountId, new Uint8Array(32), Date.now()),
    real.DB.prepare(`INSERT INTO storage_usage (account_id,limit_bytes) VALUES (?1,10737418240)`).bind(accountId),
  ]);
});

async function upload(bytes: number, expired = false) {
  const { media } = await startUpload(real, {
    request: new Request("https://txt.2-38.com/api/v1/media/uploads", {
      method: "POST", body: JSON.stringify({ clientUploadId: crypto.randomUUID(), cipherBytes: bytes, cryptoFormat: 1, chunkBytes: 1048592 }),
    }), accountId, documentId, now: Date.now(),
  });
  if (expired) await real.DB.prepare(`UPDATE media SET expires_at = 1 WHERE id = ?1`).bind(media.id).run();
  return loadUpload(real, media.id, accountId);
}
async function usage() {
  return real.DB.prepare(`SELECT used_bytes,reserved_bytes FROM storage_usage WHERE account_id = ?1`)
    .bind(accountId).first();
}
async function row(id: string) {
  return real.DB.prepare(`SELECT state FROM media WHERE id = ?1`).bind(id).first();
}

// 実 D1 の SELECT 結果だけを遅延し、古い GC スナップショットを再現する。
// 全 SQL と R2 は実バインディングで実行し、ストレージ内容を偽造しない。
function snapshotEnv(afterSnapshot: () => Promise<void>): Env {
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (key === "all") return async () => {
        const result = await target.all();
        if (sql.includes("SELECT id, object_key, account_id, cipher_bytes, state, upload_id")) await afterSnapshot();
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const DB = new Proxy(real.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ...real, DB };
}
function failDeleteOnce(): Env {
  let failed = false;
  const MEDIA = new Proxy(real.MEDIA, { get(target, key) {
    if (key === "delete") return async (objectKey: string) => {
      if (!failed) { failed = true; throw new Error("injected R2 delete failure"); }
      return target.delete(objectKey);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ...real, MEDIA };
}

describe("stale upload GC reservation and cleanup persistence", () => {
  it("spec: already-deleting expired upload preserves another 8192-byte reservation", async () => {
    const stale = await upload(4096, true);
    const other = await upload(8192);
    await real.MEDIA.put(stale.object_key, new Uint8Array(4096));
    await real.DB.batch([
      real.DB.prepare(`UPDATE storage_usage SET reserved_bytes = reserved_bytes - 4096 WHERE account_id = ?1`).bind(accountId),
      real.DB.prepare(`UPDATE media SET state = 'deleting', reservation_held = 0 WHERE id = ?1`).bind(stale.id),
    ]);
    await runMaintenance(real);
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 8192 });
    expect(await row(stale.id)).toBeNull();
    expect(await row(other.id)).toEqual({ state: "uploading" });
    expect(await real.MEDIA.head(stale.object_key)).toBeNull();
  });

  it("spec: stale GC snapshot becoming ready is not aborted or deleted and preserves used quota", async () => {
    const stale = await upload(4096, true);
    await upload(8192);
    await acceptPart(real, { media: stale, partNumber: 1, body: new ArrayBuffer(4096), now: Date.now() });
    const guarded = snapshotEnv(async () => { await completeUpload(real, { media: stale, now: Date.now() }); });
    let aborts = 0;
    const MEDIA = new Proxy(real.MEDIA, { get(target, key) {
      if (key === "resumeMultipartUpload") return (objectKey: string, uploadId: string) => {
        const multipart = target.resumeMultipartUpload(objectKey, uploadId);
        return new Proxy(multipart, { get(part, method) {
          if (method === "abort") return async () => { aborts++; return part.abort(); };
          const value = Reflect.get(part, method);
          return typeof value === "function" ? value.bind(part) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await runMaintenance({ ...guarded, MEDIA });
    expect(aborts).toBe(0);
    expect(await row(stale.id)).toEqual({ state: "ready" });
    expect((await real.MEDIA.head(stale.object_key))?.size).toBe(4096);
    expect(await usage()).toEqual({ used_bytes: 4096, reserved_bytes: 8192 });
  });

  it("spec: concurrent duplicate GC snapshots release a reservation exactly once", async () => {
    const stale = await upload(4096, true);
    await upload(8192);
    let count = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const concurrent = snapshotEnv(async () => { if (++count === 2) release(); await barrier; });
    await Promise.all([runMaintenance(concurrent), runMaintenance(concurrent)]);
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 8192 });
    expect(await row(stale.id)).toBeNull();
  });

  it("spec: live expiry renewed after stale GC snapshot preserves upload and reservation", async () => {
    const stale = await upload(4096, true);
    const renewed = snapshotEnv(async () => {
      await real.DB.prepare(`UPDATE media SET expires_at = ?2 WHERE id = ?1`).bind(stale.id, Date.now() + 86400000).run();
    });
    await runMaintenance(renewed);
    expect(await row(stale.id)).toEqual({ state: "uploading" });
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 4096 });
    await real.MEDIA.resumeMultipartUpload(stale.object_key, stale.upload_id!).uploadPart(1, new ArrayBuffer(4096));
  });

  it("spec: failed cancellation R2 delete retains metadata then cron retries without double release", async () => {
    const stale = await upload(4096, true);
    await upload(8192);
    await real.MEDIA.put(stale.object_key, new Uint8Array(4096));
    const fault = failDeleteOnce();
    await cancelUpload(fault, { media: stale, now: Date.now() });
    expect(await row(stale.id)).toEqual({ state: "deleting" });
    expect((await real.MEDIA.head(stale.object_key))?.size).toBe(4096);
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 12288 });
    await runMaintenance(fault);
    expect(await row(stale.id)).toBeNull();
    expect(await real.MEDIA.head(stale.object_key)).toBeNull();
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 8192 });
  });

  it("spec: failed GC delete retains reservation until R2 retry and never releases twice", async () => {
    const stale = await upload(4096, true);
    await upload(8192);
    await real.MEDIA.put(stale.object_key, new Uint8Array(4096));
    const fault = failDeleteOnce();
    await runMaintenance(fault);
    expect(await row(stale.id)).toEqual({ state: "deleting" });
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 12288 });
    expect((await real.MEDIA.head(stale.object_key))?.size).toBe(4096);
    await runMaintenance(fault);
    expect(await row(stale.id)).toBeNull();
    expect(await real.MEDIA.head(stale.object_key)).toBeNull();
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 8192 });
  });

  it("spec: failed completing-object delete stays charged at the 10GiB quota until a successful retry", async () => {
    const stale = await upload(4096, true);
    await acceptPart(real, { media: stale, partNumber: 1, body: new ArrayBuffer(4096), now: Date.now() });
    const parts = await real.DB.prepare(`SELECT etag FROM upload_parts WHERE media_id = ?1`).bind(stale.id).first<{ etag: string }>();
    await real.MEDIA.resumeMultipartUpload(stale.object_key, stale.upload_id!).complete([{ partNumber: 1, etag: parts!.etag }]);
    await real.DB.batch([
      real.DB.prepare(`UPDATE media SET state = 'completing' WHERE id = ?1`).bind(stale.id),
      real.DB.prepare(`UPDATE storage_usage SET used_bytes = limit_bytes - 4096 WHERE account_id = ?1`).bind(accountId),
    ]);
    const fault = failDeleteOnce();
    await runMaintenance(fault);
    expect.soft(await usage()).toEqual({ used_bytes: 10737418240 - 4096, reserved_bytes: 4096 });
    expect.soft((await real.MEDIA.head(stale.object_key))?.size).toBe(4096);
    expect.soft(await upload(4096).catch((error) => error)).toMatchObject({ status: 413 });
    await runMaintenance(fault);
    await runMaintenance(fault);
    expect(await row(stale.id)).toBeNull();
    expect(await usage()).toEqual({ used_bytes: 10737418240 - 4096, reserved_bytes: 0 });
    await upload(4096);
    expect(await usage()).toEqual({ used_bytes: 10737418240 - 4096, reserved_bytes: 4096 });
  });

  it("spec: genuine multipart abort failure preserves reservation, metadata and the real upload", async () => {
    const stale = await upload(4096, true);
    const MEDIA = new Proxy(real.MEDIA, { get(target, key) {
      if (key === "resumeMultipartUpload") return (objectKey: string, uploadId: string) => {
        const multipart = target.resumeMultipartUpload(objectKey, uploadId);
        return new Proxy(multipart, { get(part, method) {
          if (method === "abort") return async () => { throw new Error("injected unavailable multipart service"); };
          const value = Reflect.get(part, method);
          return typeof value === "function" ? value.bind(part) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await cancelUpload({ ...real, MEDIA }, { media: stale, now: Date.now() });
    expect.soft(await row(stale.id)).toEqual({ state: "deleting" });
    expect.soft(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 4096 });
    await real.MEDIA.resumeMultipartUpload(stale.object_key, stale.upload_id!).uploadPart(1, new ArrayBuffer(4096));
    await runMaintenance({ ...real, MEDIA });
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 4096 });
    await runMaintenance(real);
    expect(await row(stale.id)).toBeNull();
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 0 });
  });

  it("spec: simultaneous GC and cancellation release only the physically cleaned reservation", async () => {
    const stale = await upload(4096, true);
    await upload(8192);
    const concurrent = snapshotEnv(async () => { await cancelUpload(real, { media: stale, now: Date.now() }).catch(() => undefined); });
    await Promise.all([runMaintenance(concurrent), cancelUpload(real, { media: stale, now: Date.now() }).catch(() => undefined)]);
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 8192 });
    expect(await row(stale.id)).toBeNull();
  });
  it.each(["cancel", "GC"])("spec: legacy active flag0 %s claim holds quota until deletion succeeds", async (operation) => {
    const stale = await upload(4096, true);
    await upload(8192);
    await real.DB.prepare(`UPDATE media SET reservation_held = 0 WHERE id = ?1`).bind(stale.id).run();
    const fault = failDeleteOnce();
    if (operation === "cancel") await cancelUpload(fault, { media: stale, now: Date.now() });
    else await runMaintenance(fault);
    expect(await loadUpload(real, stale.id, accountId)).toMatchObject({ state: "deleting", reservation_held: 1 });
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 12288 });
    await runMaintenance(real);
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 8192 });
  });

  it("spec: legacy active flag0 completion moves reserved to used and clears the flag", async () => {
    const stale = await upload(4096);
    await upload(8192);
    await real.DB.prepare(`UPDATE media SET reservation_held = 0 WHERE id = ?1`).bind(stale.id).run();
    await acceptPart(real, { media: stale, partNumber: 1, body: new ArrayBuffer(4096), now: Date.now() });
    const completed = await completeUpload(real, { media: stale, now: Date.now() });
    expect(completed).toMatchObject({ state: "ready", reservation_held: 0 });
    expect(await usage()).toEqual({ used_bytes: 4096, reserved_bytes: 8192 });
  });

  it("spec: additive migration preserves legacy ready used quota, active reservations and all counters", async () => {
    await real.DB.prepare(`ALTER TABLE media DROP COLUMN reservation_held`).run();
    for (const state of ["ready", "creating", "uploading", "completing", "deleting"]) {
      const id = crypto.randomUUID();
      await real.DB.prepare(`INSERT INTO media
        (id,document_id,account_id,client_upload_id,object_key,cipher_bytes,crypto_format,chunk_bytes,state,created_at)
        VALUES (?1,?2,?3,?1,?1,4096,1,1048592,?4,1)`).bind(id, documentId, accountId, state).run();
    }
    await real.DB.prepare(`UPDATE storage_usage SET used_bytes = 4096, reserved_bytes = 12288 WHERE account_id = ?1`).bind(accountId).run();
    const before = await real.DB.prepare(`SELECT * FROM storage_usage WHERE account_id = ?1`).bind(accountId).first();
    const migrations = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
    const migration = migrations.find((item) => item.name === "0002_media_reservation_held.sql");
    expect(migration).toBeDefined();
    await real.DB.batch(migration!.queries.map((query) => real.DB.prepare(query)));
    expect(await real.DB.prepare(`SELECT state,reservation_held FROM media ORDER BY state`).all()).toMatchObject({
      results: ["completing", "creating", "deleting", "ready", "uploading"].map((state) => ({ state, reservation_held: 0 })),
    });
    expect(await real.DB.prepare(`SELECT * FROM storage_usage WHERE account_id = ?1`).bind(accountId).first()).toEqual(before);
  });

});
