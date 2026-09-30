/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runMaintenance } from "../../apps/worker/src/maintenance.ts";
import { acceptPart, completeUpload, finalizeDeletion, loadUpload, startUpload, UPLOAD_EXPIRY_MS } from "../../apps/worker/src/media/store.ts";
import type { Env } from "../../apps/worker/src/types.ts";

const real = env as Env;
let accountId: string;
let documentId: string;
beforeEach(async () => {
  await real.DB.prepare(`DELETE FROM accounts`).run();
  accountId = crypto.randomUUID();
  documentId = crypto.randomUUID();
  await real.DB.batch([
    real.DB.prepare(`INSERT INTO accounts (id,user_handle,display_label,status,created_at) VALUES (?1,?2,'Liveness test','active',?3)`)
      .bind(accountId, new Uint8Array(32), Date.now()),
    real.DB.prepare(`INSERT INTO documents (id,account_id,sync_epoch,format_version,key_version,mutation_id,nonce,ciphertext,last_payload_hash32,updated_at)
      VALUES (?1,?2,1,1,1,?1,?3,?3,?3,?4)`).bind(documentId, accountId, new Uint8Array(32), Date.now()),
    real.DB.prepare(`INSERT INTO storage_usage (account_id,limit_bytes) VALUES (?1,10737418240)`).bind(accountId),
  ]);
});
async function upload(now = Date.now()) {
  return (await startUpload(real, {
    request: new Request("https://txt.2-38.com/api/v1/media/uploads", {
      method: "POST", body: JSON.stringify({ clientUploadId: crypto.randomUUID(), cipherBytes: 4096, cryptoFormat: 1, chunkBytes: 1048592 }),
    }), accountId, documentId, now,
  })).media;
}
async function usage() {
  return real.DB.prepare(`SELECT used_bytes,reserved_bytes FROM storage_usage WHERE account_id = ?1`).bind(accountId).first();
}
async function row(id: string) {
  return real.DB.prepare(`SELECT state,expires_at FROM media WHERE id = ?1`).bind(id).first();
}
function faultEnv(abortError: unknown, deleteFails = false): Env {
  const MEDIA = new Proxy(real.MEDIA, { get(target, key) {
    if (key === "resumeMultipartUpload") return (objectKey: string, uploadId: string) => {
      const multipart = target.resumeMultipartUpload(objectKey, uploadId);
      return new Proxy(multipart, { get(part, method) {
        if (method === "abort") return async () => { throw abortError; };
        const value = Reflect.get(part, method);
        return typeof value === "function" ? value.bind(part) : value;
      } });
    };
    if (key === "delete" && deleteFails) return async () => { throw new Error("injected physical delete failure"); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ...real, MEDIA };
}

// R2/D1 は実バインディング。故障注入はプロバイダ例外の境界だけに限定する。
describe("upload activity and definitive multipart absence", () => {
  it("spec: an accepted part near the original deadline survives GC while an idle upload expires", async () => {
    // Acceptance is just before the old deadline; GC runs after that deadline.
    const now = Date.now() - 2000;
    const started = now - UPLOAD_EXPIRY_MS + 1000;
    const active = await upload(started);
    const idle = await upload(now - UPLOAD_EXPIRY_MS - 1000);
    await acceptPart(real, { media: active, partNumber: 1, body: new ArrayBuffer(4096), now });
    expect(await row(active.id)).toEqual({ state: "uploading", expires_at: now + UPLOAD_EXPIRY_MS });
    await runMaintenance(real);
    expect(await row(active.id)).toEqual({ state: "uploading", expires_at: now + UPLOAD_EXPIRY_MS });
    expect(await row(idle.id)).toBeNull();
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 4096 });
  });

  it("spec: identical accepted retries renew inactivity expiry without rewriting the accepted part", async () => {
    const now = Date.now();
    const media = await upload(now - UPLOAD_EXPIRY_MS + 2000);
    const first = await acceptPart(real, { media, partNumber: 1, body: new ArrayBuffer(4096), now });
    const retried = await acceptPart(real, { media, partNumber: 1, body: new ArrayBuffer(4096), now: now + 1000 });
    expect(retried).toEqual(first);
    expect(await row(media.id)).toEqual({ state: "uploading", expires_at: now + 1000 + UPLOAD_EXPIRY_MS });
  });

  it.each(["ready", "deleting", "completing"])("spec: stale accepted retry never renews a live %s row", async (state) => {
    const media = await upload();
    await acceptPart(real, { media, partNumber: 1, body: new ArrayBuffer(4096), now: Date.now() });
    await real.DB.prepare(`UPDATE media SET state = ?2, expires_at = NULL WHERE id = ?1`).bind(media.id, state).run();
    await acceptPart(real, { media, partNumber: 1, body: new ArrayBuffer(4096), now: Date.now() + 1000 }).catch(() => undefined);
    expect(await row(media.id)).toEqual({ state, expires_at: null });
  });

  it("spec: successful R2 part response cannot revive a row concurrently claimed for deletion", async () => {
    const media = await upload();
    const MEDIA = new Proxy(real.MEDIA, { get(target, key) {
      if (key === "resumeMultipartUpload") return (objectKey: string, uploadId: string) => {
        const multipart = target.resumeMultipartUpload(objectKey, uploadId);
        return new Proxy(multipart, { get(part, method) {
          if (method === "uploadPart") return async (number: number, body: ArrayBuffer) => {
            const result = await part.uploadPart(number, body);
            await real.DB.prepare(`UPDATE media SET state = 'deleting', expires_at = NULL WHERE id = ?1`).bind(media.id).run();
            return result;
          };
          const value = Reflect.get(part, method);
          return typeof value === "function" ? value.bind(part) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await acceptPart({ ...real, MEDIA }, { media, partNumber: 1, body: new ArrayBuffer(4096), now: Date.now() }).catch(() => undefined);
    expect(await row(media.id)).toEqual({ state: "deleting", expires_at: null });
    expect((await real.DB.prepare(`SELECT state FROM upload_parts WHERE media_id = ?1`).bind(media.id).first())?.state).not.toBe("accepted");
  });

  it.each(["aborted", "completed"])("spec: definitive missing multipart after actual R2 %s permits physical deletion and one quota release", async (operation) => {
    const media = await upload();
    await upload(); // An unrelated live reservation must survive duplicate cleanup.
    const multipart = real.MEDIA.resumeMultipartUpload(media.object_key, media.upload_id!);
    if (operation === "completed") {
      const part = await multipart.uploadPart(1, new ArrayBuffer(4096));
      await multipart.complete([part]);
    } else {
      await multipart.abort();
      await real.MEDIA.put(media.object_key, new Uint8Array(4096));
    }
    // Native local R2 abort is idempotent. Obtain its actual missing-upload exception
    // via uploadPart, then inject that same exception at the production abort boundary.
    const missing = await multipart.uploadPart(1, new ArrayBuffer(4096)).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(Error);
    expect((missing as Error).message).toMatch(/\(10024\)\s*$/);
    await real.DB.prepare(`UPDATE media SET state = 'deleting' WHERE id = ?1`).bind(media.id).run();
    const fault = faultEnv(missing);
    await Promise.all([finalizeDeletion(fault, media), finalizeDeletion(fault, media)]);
    expect(await row(media.id)).toBeNull();
    expect(await real.MEDIA.head(media.object_key)).toBeNull();
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 4096 });
  });

  it("spec: definitive missing multipart still retains quota when physical object delete fails", async () => {
    const media = await upload();
    const multipart = real.MEDIA.resumeMultipartUpload(media.object_key, media.upload_id!);
    await multipart.abort();
    await real.MEDIA.put(media.object_key, new Uint8Array(4096));
    const missing = await multipart.uploadPart(1, new ArrayBuffer(4096)).catch((error: unknown) => error);
    await real.DB.prepare(`UPDATE media SET state = 'deleting' WHERE id = ?1`).bind(media.id).run();
    await finalizeDeletion(faultEnv(missing, true), media);
    expect((await row(media.id))?.state).toBe("deleting");
    expect((await real.MEDIA.head(media.object_key))?.size).toBe(4096);
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 4096 });
  });

  it.each([
    new Error("transient R2 unavailable"),
    Object.assign(new Error("404 Not Found"), { status: 404 }),
    new Error("abortMultipartUpload: unavailable (100240)"),
    new Error("abortMultipartUpload: unavailable (10024) retry later"),
    Object.assign(new Error("unknown abort failure"), { name: "NoSuchUpload", code: 10024 }),
    { message: "abortMultipartUpload: not found (10024)" },
  ])("spec: unverified abort error %# retains charge even when HEAD returns null", async (error) => {
    const media = await upload();
    await real.DB.prepare(`UPDATE media SET state = 'deleting' WHERE id = ?1`).bind(media.id).run();
    expect(await real.MEDIA.head(media.object_key)).toBeNull();
    await finalizeDeletion(faultEnv(error), media);
    expect((await row(media.id))?.state).toBe("deleting");
    expect(await usage()).toEqual({ used_bytes: 0, reserved_bytes: 4096 });
    await real.MEDIA.resumeMultipartUpload(media.object_key, media.upload_id!).uploadPart(1, new ArrayBuffer(4096));
  });

  it("spec: stale deletion finalization never touches a ready object or its used quota", async () => {
    const media = await upload();
    await acceptPart(real, { media, partNumber: 1, body: new ArrayBuffer(4096), now: Date.now() });
    const ready = await completeUpload(real, { media, now: Date.now() });
    await finalizeDeletion(real, ready);
    expect((await row(media.id))?.state).toBe("ready");
    expect((await real.MEDIA.head(media.object_key))?.size).toBe(4096);
    expect(await usage()).toEqual({ used_bytes: 4096, reserved_bytes: 0 });
    expect((await loadUpload(real, media.id, accountId)).expires_at).toBeNull();
  });
});
