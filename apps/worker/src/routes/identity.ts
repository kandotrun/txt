/**
 * Bootstrap, key envelopes, credential management and recovery
 * (spec §5.3, §6, §7, §12.2).
 *
 * The server never receives PRF output, KEK, VaultKey, RecoverySeed or any
 * plaintext. Only wrapped keys, salts, nonces and derived auth hashes.
 */

import { Hono } from "hono";

import type { AppBindings } from "../context.ts";
import { enforceRateLimit, clientBucketKey, rateLimitScale, requireAuth } from "../context.ts";
import {
  ABSOLUTE_TTL_MS,
  IDLE_TTL_MS,
  assertWriteRequestAllowed,
  issueSession,
  readSessionToken,
  requireStepUp,
  sessionCookie,
} from "../auth/sessions.ts";
import {
  bindingHash,
  buildRegistrationOptions,
  consumeChallenge,
  loadCredential,
  storeChallenge,
  verifyRegistration,
} from "../auth/webauthn.ts";
import {
  challengeFromClientData,
  sanitizeRegistrationResponse,
} from "../auth/dto.ts";
import {
  badRequest,
  conflict,
  notFound,
  scopeRequired,
  unprocessable,
} from "../errors.ts";
import { bytesEqual, nowMs, readJson, requireInt, requireString, sha256 } from "../util.ts";
import { decodeBase64Url, encodeBase64Url } from "../document/store.ts";

const routes = new Hono<AppBindings>();

/* ------------------------------------------------------------------ */
/* POST /api/v1/bootstrap                                              */
/* ------------------------------------------------------------------ */

/**
 * Atomically activates a pending account: the wrapped VaultKey for the new
 * credential, the recovery record, the encrypted empty document and the
 * `active` flip all happen in one D1 transaction.
 *
 * The same bootstrapId with a different payload is rejected (409).
 */
routes.post("/bootstrap", async (c) => {
  const auth = await requireAuth(c);
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);

  const body = await readJson<Record<string, unknown>>(c.req.raw, 256 * 1024);
  const bootstrapId = requireString(body.bootstrapId, "bootstrapId", 64);
  const credentialId = requireString(body.credentialId, "credentialId", 1024);
  const envelope = body.envelope as Record<string, unknown> | undefined;
  const recovery = body.recovery as Record<string, unknown> | undefined;
  const document = body.document as Record<string, unknown> | undefined;
  if (!envelope || !recovery || !document) {
    throw badRequest("envelope, recovery and document are required");
  }

  const formatVersion = requireInt(envelope.formatVersion, "envelope.formatVersion", 255);
  const keyVersion = requireInt(envelope.keyVersion, "envelope.keyVersion", 255);
  const wrapSalt = decodeBase64Url(envelope.wrapSalt32, "envelope.wrapSalt32", 32);
  const wrapNonce = decodeBase64Url(envelope.nonce, "envelope.nonce", 12);
  const wrappedKey = decodeBase64Url(envelope.wrappedKey, "envelope.wrappedKey");
  if (wrappedKey.byteLength !== 48) {
    throw unprocessable("envelope.wrappedKey must be 48 bytes (32 + 16 tag)");
  }

  const recoveryVersion = requireInt(recovery.recoveryVersion, "recovery.recoveryVersion", 255);
  const recoveryKeyVersion = requireInt(recovery.keyVersion, "recovery.keyVersion", 255);
  const authHash = decodeBase64Url(recovery.authHash32, "recovery.authHash32", 32);
  const recoveryNonce = decodeBase64Url(recovery.nonce, "recovery.nonce", 12);
  const recoveryWrapped = decodeBase64Url(recovery.wrappedKey, "recovery.wrappedKey");
  if (recoveryWrapped.byteLength !== 48) {
    throw unprocessable("recovery.wrappedKey must be 48 bytes");
  }

  const documentId = requireString(document.documentId, "document.documentId", 64);
  const docFormatVersion = requireInt(document.formatVersion, "document.formatVersion", 255);
  const docKeyVersion = requireInt(document.keyVersion, "document.keyVersion", 255);
  const docNonce = decodeBase64Url(document.nonce, "document.nonce", 12);
  const docCiphertext = decodeBase64Url(document.ciphertext, "document.ciphertext");
  if (docCiphertext.byteLength === 0) throw unprocessable("document.ciphertext must not be empty");

  const credential = await loadCredential(c.env, credentialId);
  if (!credential || credential.account_id !== auth.accountId) {
    throw notFound("credential not found");
  }

  const payloadHash = await sha256(
    new TextEncoder().encode(JSON.stringify({ envelope, recovery, document })),
  );

  const existing = await c.env.DB.prepare(
    `SELECT id, account_id, payload_hash32, state FROM operations WHERE id = ?1 AND kind = 'bootstrap'`,
  )
    .bind(bootstrapId)
    .first<{ id: string; account_id: string; payload_hash32: ArrayBuffer; state: string }>();
  if (existing) {
    if (existing.account_id !== auth.accountId) throw notFound("bootstrap not found");
    const same = (() => {
      const left = new Uint8Array(existing.payload_hash32);
      if (left.byteLength !== payloadHash.byteLength) return false;
      for (let i = 0; i < left.byteLength; i++) {
        if (left[i] !== payloadHash[i]) return false;
      }
      return true;
    })();
    if (!same) throw conflict("bootstrapId reused with a different payload", "BOOTSTRAP_CONFLICT");
    if (existing.state === "completed") {
      return c.json({ ok: true, bootstrapId, documentId, replayed: true });
    }
  }

  // Bootstrap is the one-time activation of a pending account with its
  // pending passkey. Once the account is active this endpoint only answers
  // the replay above: it must never become a way to replace the recovery
  // record or to re-activate a passkey without a step-up (spec §5.3).
  const accountRow = await c.env.DB.prepare(`SELECT status FROM accounts WHERE id = ?1`)
    .bind(auth.accountId)
    .first<{ status: string }>();
  if (accountRow?.status !== "pending" || credential.status !== "pending") {
    throw conflict("account is already activated", "ALREADY_BOOTSTRAPPED");
  }

  if (!existing) {
    await c.env.DB.prepare(
      `INSERT INTO operations (id, kind, account_id, payload_hash32, state, result, created_at, updated_at)
       VALUES (?1, 'bootstrap', ?2, ?3, 'pending', '{}', ?4, ?4)`,
    )
      .bind(bootstrapId, auth.accountId, payloadHash.buffer as ArrayBuffer, nowMs())
      .run();
  }

  const now = nowMs();

  const existingDoc = await c.env.DB.prepare(
    `SELECT id FROM documents WHERE account_id = ?1`,
  )
    .bind(auth.accountId)
    .first<{ id: string }>();
  if (existingDoc && existingDoc.id !== documentId) {
    throw conflict("account already has a document", "DOCUMENT_EXISTS");
  }

  // Every statement re-checks in SQL that the account is still pending when
  // the batch runs, so a concurrent activation turns the whole batch into a
  // no-op instead of overwriting what the winner stored.
  const stillPending = `EXISTS (SELECT 1 FROM accounts WHERE id = ?2 AND status = 'pending')`;
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO key_envelopes
         (credential_id, account_id, format_version, key_version, wrap_salt32, nonce, wrapped_key, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE ${stillPending}
       ON CONFLICT(credential_id, key_version) DO NOTHING`,
    ).bind(
      credentialId,
      auth.accountId,
      formatVersion,
      keyVersion,
      wrapSalt,
      wrapNonce,
      wrappedKey,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO recovery
         (recovery_version, account_id, key_version, auth_hash32, nonce, wrapped_key, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${stillPending}
       ON CONFLICT(account_id) DO UPDATE SET
          recovery_version = excluded.recovery_version,
          key_version = excluded.key_version,
          auth_hash32 = excluded.auth_hash32,
          nonce = excluded.nonce,
          wrapped_key = excluded.wrapped_key
        WHERE recovery.recovery_version < excluded.recovery_version`,
    ).bind(
      recoveryVersion,
      auth.accountId,
      recoveryKeyVersion,
      authHash,
      recoveryNonce,
      recoveryWrapped,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO documents
         (id, account_id, sync_epoch, revision, encrypted_revision, format_version, key_version,
          mutation_id, nonce, ciphertext, last_payload_hash32, updated_at)
       SELECT ?1, ?2, 1, 0, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${stillPending}
       ON CONFLICT(account_id) DO NOTHING`,
    ).bind(
      documentId,
      auth.accountId,
      docFormatVersion,
      docKeyVersion,
      bootstrapId,
      docNonce,
      docCiphertext,
      await sha256(new TextEncoder().encode("bootstrap")),
      now,
    ),
    c.env.DB.prepare(
      `UPDATE credentials SET status = 'active'
        WHERE credential_id = ?1 AND account_id = ?2 AND status = 'pending' AND ${stillPending}`,
    ).bind(credentialId, auth.accountId),
    c.env.DB.prepare(
      `UPDATE accounts SET status = 'active', activated_at = ?2 WHERE id = ?1 AND status = 'pending'`,
    ).bind(auth.accountId, now),
    c.env.DB.prepare(
      `UPDATE sessions SET scope = 'active'
        WHERE account_id = ?1 AND scope = 'pending'
          AND EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND status = 'active')`,
    ).bind(auth.accountId),
    // Completed only if this very bootstrap stored the document: the initial
    // mutationId is the bootstrapId (spec §5.3).
    c.env.DB.prepare(
      `UPDATE operations SET state = 'completed', result = ?2, updated_at = ?3
        WHERE id = ?1
          AND EXISTS (SELECT 1 FROM documents WHERE account_id = ?4 AND mutation_id = ?1)`,
    ).bind(bootstrapId, JSON.stringify({ documentId }), now, auth.accountId),
  ];

  const results = await c.env.DB.batch(statements);
  if ((results[4]?.meta.changes ?? 0) !== 1) {
    throw conflict("account is already activated", "ALREADY_BOOTSTRAPPED");
  }
  const envelopeChanges = results[0]?.meta.changes ?? 0;
  if (envelopeChanges !== 1) {
    throw conflict("a VaultKey envelope already exists for this credential");
  }

  return c.json({ ok: true, bootstrapId, documentId }, 201);
});

/* ------------------------------------------------------------------ */
/* GET /api/v1/keys                                                    */
/* ------------------------------------------------------------------ */

/** Returns key envelopes for the caller's credentials. Owners only. */
routes.get("/keys", async (c) => {
  const auth = await requireAuth(c);
  if (auth.scope === "pending") {
    // A pending account has no usable envelopes; return an empty list rather
    // than leaking whether other accounts have keys.
    return c.json({ envelopes: [], recovery: null });
  }
  const credentialId = c.req.query("credentialId") ?? null;

  const condition = credentialId ? " AND e.credential_id = ?2" : "";
  const statement = c.env.DB.prepare(
    `SELECT e.credential_id, e.format_version, e.key_version, e.wrap_salt32, e.nonce, e.wrapped_key
       FROM key_envelopes e JOIN credentials c ON c.credential_id = e.credential_id
      WHERE e.account_id = ?1 AND c.status IN ('active','pending')${condition}`,
  );
  const rows = credentialId
    ? await statement.bind(auth.accountId, credentialId).all<Record<string, unknown>>()
    : await statement.bind(auth.accountId).all<Record<string, unknown>>();

  const recoveryRow = await c.env.DB.prepare(
    `SELECT recovery_version, key_version, nonce, wrapped_key FROM recovery WHERE account_id = ?1`,
  )
    .bind(auth.accountId)
    .first<Record<string, unknown>>();

  return c.json({
    envelopes: (rows.results ?? []).map((row: Record<string, unknown>) => ({
      credentialId: row.credential_id,
      formatVersion: row.format_version,
      keyVersion: row.key_version,
      wrapSalt32: encodeBase64Url(row.wrap_salt32 as ArrayBuffer),
      nonce: encodeBase64Url(row.nonce as ArrayBuffer),
      wrappedKey: encodeBase64Url(row.wrapped_key as ArrayBuffer),
    })),
    recovery: recoveryRow
      ? {
          recoveryVersion: recoveryRow.recovery_version,
          keyVersion: recoveryRow.key_version,
          nonce: encodeBase64Url(recoveryRow.nonce as ArrayBuffer),
          wrappedKey: encodeBase64Url(recoveryRow.wrapped_key as ArrayBuffer),
        }
      : null,
  });
});

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

/** GET /api/v1/credentials — the caller's passkeys. */
routes.get("/credentials", async (c) => {
  const auth = await requireAuth(c);
  const rows = await c.env.DB.prepare(
    `SELECT credential_id, device_type, backup_state, status, created_at, last_used_at
       FROM credentials WHERE account_id = ?1 AND status IN ('active','pending')`,
  )
    .bind(auth.accountId)
    .all<Record<string, unknown>>();
  return c.json({
    credentials: (rows.results ?? []).map((row: Record<string, unknown>) => ({
      credentialId: row.credential_id,
      deviceType: row.device_type,
      backedUp: row.backup_state === 1,
      status: row.status,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    })),
  });
});

/**
 * POST /api/v1/credentials/options — starts adding a new passkey.
 * Requires an unlocked, step-up verified active session (spec §7).
 */
routes.post("/credentials/options", async (c) => {
  const auth = await requireAuth(c);
  if (auth.scope !== "active") throw unprocessable("active session required");
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  requireStepUp(auth);

  const body = await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024);
  const userHandleRaw = body.userHandle;
  if (typeof userHandleRaw !== "string") throw badRequest("userHandle is required");
  const userHandle = decodeBase64Url(userHandleRaw, "userHandle", 32);

  const account = await c.env.DB.prepare(
    `SELECT user_handle, auth_epoch FROM accounts WHERE id = ?1`,
  )
    .bind(auth.accountId)
    .first<{ user_handle: ArrayBuffer; auth_epoch: number }>();
  if (!account) throw notFound("account not found");

  const storedHandle = new Uint8Array(account.user_handle);
  const givenHandle = new Uint8Array(userHandle);
  if (storedHandle.byteLength !== givenHandle.byteLength) {
    throw unprocessable("userHandle mismatch");
  }
  for (let i = 0; i < storedHandle.byteLength; i++) {
    if (storedHandle[i] !== givenHandle[i]) throw unprocessable("userHandle mismatch");
  }

  const existing = await c.env.DB.prepare(
    `SELECT credential_id FROM credentials WHERE account_id = ?1 AND status IN ('active','pending')`,
  )
    .bind(auth.accountId)
    .all<{ credential_id: string }>();

  // Build registration options with the same random-label policy.
  const options = await buildRegistrationOptions(c.env, {
    accountId: auth.accountId,
    userHandle: storedHandle,
    existingCredentialIds: (existing.results ?? []).map(
      (row: { credential_id: string }) => row.credential_id,
    ),
  });

  const binding = await bindingHash(c.req.raw, "credential-add");
  await storeChallenge(c.env, {
    purpose: "credential-add",
    challenge: options.challenge,
    accountId: auth.accountId,
    clientKind: auth.clientKind,
    binding,
  });
  return c.json({ options });
});

/** POST /api/v1/credentials/verify — stores the new credential as pending. */
routes.post("/credentials/verify", async (c) => {
  const auth = await requireAuth(c);
  if (auth.scope !== "active") throw unprocessable("active session required");
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  requireStepUp(auth);
  const bucketKey = await clientBucketKey(c, "credential:verify");
  await enforceRateLimit(c, { bucketKey, limit: 60 * rateLimitScale(c.env), windowMs: 60 * 60 * 1000 });

  const body = await readJson<Record<string, unknown>>(c.req.raw, 64 * 1024);
  const dto = sanitizeRegistrationResponse(body["response"] as Record<string, unknown>);
  const binding = await bindingHash(c.req.raw, "credential-add");
  const challenge = await consumeChallenge(c.env, {
    purpose: "credential-add",
    responseClientDataJSON: dto.response.clientDataJSON,
    binding,
  });
  if (challenge.account_id !== auth.accountId) {
    throw badRequest("challenge does not belong to this account");
  }

  const verified = await verifyRegistration(c.env, {
    response: dto,
    expectedChallenge: challengeFromClientData(dto.response.clientDataJSON),
  });

  const now = nowMs();
  await c.env.DB.prepare(
    `INSERT INTO credentials
       (credential_id, account_id, public_key, counter, transports, backup_eligible,
        backup_state, device_type, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9)`,
  )
    .bind(
      verified.credentialId,
      auth.accountId,
      verified.publicKey.buffer as ArrayBuffer,
      verified.counter,
      JSON.stringify(verified.transports),
      verified.backedUp ? 1 : 0,
      verified.backedUp ? 1 : 0,
      verified.deviceType,
      now,
    )
    .run();

  return c.json({ credentialId: verified.credentialId, status: "pending" }, 201);
});

/**
 * POST /api/v1/credentials/activate — activates a pending credential once the
 * key envelope for it exists. The previous entry is never removed before the
 * new one is proven (spec §7).
 */
routes.post("/credentials/activate", async (c) => {
  const auth = await requireAuth(c);
  if (auth.scope !== "active") throw unprocessable("active session required");
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  requireStepUp(auth);

  const body = await readJson<Record<string, unknown>>(c.req.raw, 256 * 1024);
  const credentialId = requireString(body.credentialId, "credentialId", 1024);
  const operationId = requireString(body.operationId, "operationId", 64);
  const envelope = body.envelope as Record<string, unknown> | undefined;
  if (!envelope) throw badRequest("envelope is required");

  const formatVersion = requireInt(envelope.formatVersion, "envelope.formatVersion", 255);
  const keyVersion = requireInt(envelope.keyVersion, "envelope.keyVersion", 255);
  const wrapSalt = decodeBase64Url(envelope.wrapSalt32, "envelope.wrapSalt32", 32);
  const nonce = decodeBase64Url(envelope.nonce, "envelope.nonce", 12);
  const wrappedKey = decodeBase64Url(envelope.wrappedKey, "envelope.wrappedKey");
  if (wrappedKey.byteLength !== 48) throw unprocessable("wrappedKey must be 48 bytes");

  const credential = await loadCredential(c.env, credentialId);
  if (!credential || credential.account_id !== auth.accountId) {
    throw notFound("credential not found");
  }
  if (credential.status !== "pending") {
    throw conflict("credential is not pending");
  }
  const keyOwner = await c.env.DB.prepare(
    `SELECT account_id FROM key_envelopes WHERE credential_id = ?1 AND key_version = ?2`,
  )
    .bind(credentialId, keyVersion)
    .first<{ account_id: string }>();
  if (keyOwner && keyOwner.account_id !== auth.accountId) {
    throw notFound("envelope not found");
  }

  const now = nowMs();
  const payloadHash = await sha256(
    new TextEncoder().encode(JSON.stringify({ credentialId, envelope })),
  );

  const existingOp = await c.env.DB.prepare(
    `SELECT id, payload_hash32, state FROM operations WHERE id = ?1 AND kind = 'bootstrap'`,
  )
    .bind(operationId)
    .first<{ id: string; payload_hash32: ArrayBuffer; state: string }>();
  if (existingOp) {
    const left = new Uint8Array(existingOp.payload_hash32);
    const right = payloadHash;
    let same = left.byteLength === right.byteLength;
    if (same) {
      for (let i = 0; i < left.byteLength; i++) {
        if (left[i] !== right[i]) {
          same = false;
          break;
        }
      }
    }
    if (!same) throw conflict("operationId reused with a different payload");
  } else {
    await c.env.DB.prepare(
      `INSERT INTO operations (id, kind, account_id, payload_hash32, state, result, created_at, updated_at)
       VALUES (?1, 'bootstrap', ?2, ?3, 'pending', '{}', ?4, ?4)`,
    )
      .bind(operationId, auth.accountId, payloadHash.buffer as ArrayBuffer, now)
      .run();
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO key_envelopes
         (credential_id, account_id, format_version, key_version, wrap_salt32, nonce, wrapped_key, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(credential_id, key_version) DO NOTHING`,
    ).bind(credentialId, auth.accountId, formatVersion, keyVersion, wrapSalt, nonce, wrappedKey, now),
    c.env.DB.prepare(
      `UPDATE credentials SET status = 'active' WHERE credential_id = ?1 AND account_id = ?2 AND status = 'pending'`,
    ).bind(credentialId, auth.accountId),
    c.env.DB.prepare(
      `UPDATE operations SET state = 'completed', result = ?2, updated_at = ?3 WHERE id = ?1`,
    ).bind(operationId, JSON.stringify({ credentialId }), now),
  ]);

  return c.json({ ok: true, credentialId, status: "active" });
});

/**
 * DELETE /api/v1/credentials/:id — revokes a passkey.
 * Requires a step-up, and refuses to remove the last active credential
 * (spec §7).
 */
routes.delete("/credentials/:id", async (c) => {
  const auth = await requireAuth(c);
  if (auth.scope !== "active") throw scopeRequired("active session required");
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  requireStepUp(auth);
  const credentialId = c.req.param("id");

  const target = await loadCredential(c.env, credentialId);
  if (!target || target.account_id !== auth.accountId) throw notFound("credential not found");

  // One statement decides and writes: two concurrent revocations can never
  // both pass a separate "is another passkey left?" read.
  const revoked = await c.env.DB.prepare(
    `UPDATE credentials SET status = 'revoked'
      WHERE credential_id = ?1 AND account_id = ?2 AND status IN ('active','pending')
        AND (status != 'active' OR EXISTS (
              SELECT 1 FROM credentials other
               WHERE other.account_id = ?2 AND other.status = 'active'
                 AND other.credential_id != ?1))`,
  )
    .bind(credentialId, auth.accountId)
    .run();
  if ((revoked.meta.changes ?? 0) !== 1) {
    if (target.status === "revoked") return c.json({ ok: true });
    throw conflict("cannot remove the last active passkey", "LAST_CREDENTIAL");
  }
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Recovery                                                            */
/* ------------------------------------------------------------------ */

/**
 * POST /api/v1/recovery/start — exchanges a derived RecoveryAuth for a
 * recovery-scoped session. The RecoverySeed itself is never sent.
 */
routes.post("/recovery/start", async (c) => {
  const bucketKey = await clientBucketKey(c, "recovery:start");
  await enforceRateLimit(c, { bucketKey, limit: 20 * rateLimitScale(c.env), windowMs: 60 * 60 * 1000 });

  const body = await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024);
  const accountId = requireString(body.accountId, "accountId", 64);
  const recoveryAuthRaw = body.recoveryAuth;
  if (typeof recoveryAuthRaw !== "string") throw badRequest("recoveryAuth is required");
  const recoveryAuth = decodeBase64Url(recoveryAuthRaw, "recoveryAuth", 32);

  const row = await c.env.DB.prepare(
    `SELECT auth_hash32, recovery_version, key_version FROM recovery WHERE account_id = ?1`,
  )
    .bind(accountId)
    .first<{ auth_hash32: ArrayBuffer; recovery_version: number; key_version: number }>();
  if (!row) throw notFound("recovery not found");

  // The database keeps SHA-256(RecoveryAuth) (spec §7.1): what is presented
  // is hashed before the comparison, so a copy of the stored row is not a
  // credential.
  const given = await sha256(new Uint8Array(recoveryAuth));
  if (!bytesEqual(new Uint8Array(row.auth_hash32), given)) throw notFound("recovery not found");

  const account = await c.env.DB.prepare(`SELECT auth_epoch, status FROM accounts WHERE id = ?1`)
    .bind(accountId)
    .first<{ auth_epoch: number; status: string }>();
  if (!account || account.status === "deleting") throw notFound("recovery not found");

  const clientKind = "web";
  const session = await issueSession(c.env, {
    accountId,
    clientKind,
    scope: "recovery",
    authEpoch: account.auth_epoch,
  });

  // The userHandle is a public, account-bound value; a caller that proved
  // knowledge of the RecoveryAuth needs it to build registration options.
  const accountRow = await c.env.DB.prepare(`SELECT user_handle FROM accounts WHERE id = ?1`)
    .bind(accountId)
    .first<{ user_handle: ArrayBuffer }>();
  const userHandle = accountRow
    ? encodeBase64Url(accountRow.user_handle)
    : null;

  c.header("set-cookie", sessionCookie(session.token, c.env, session.maxAgeMs));
  return c.json({
    scope: "recovery",
    recoveryVersion: row.recovery_version,
    keyVersion: row.key_version,
    userHandle,
    expiresAt: session.expiresAt,
  });
});

/**
 * POST /api/v1/recovery/options — starts registering the replacement passkey.
 * Only a recovery session can ask, and the challenge is bound to its account
 * and consumed once by /recovery/complete (spec §5.2, §7.2).
 */
routes.post("/recovery/options", async (c) => {
  const auth = await requireAuth(c);
  if (auth.scope !== "recovery") throw scopeRequired("recovery session required");
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024).catch(() => ({}));

  const account = await c.env.DB.prepare(`SELECT user_handle FROM accounts WHERE id = ?1`)
    .bind(auth.accountId)
    .first<{ user_handle: ArrayBuffer }>();
  if (!account) throw notFound("account not found");
  const existing = await c.env.DB.prepare(
    `SELECT credential_id FROM credentials WHERE account_id = ?1 AND status IN ('active','pending')`,
  )
    .bind(auth.accountId)
    .all<{ credential_id: string }>();

  const options = await buildRegistrationOptions(c.env, {
    accountId: auth.accountId,
    userHandle: new Uint8Array(account.user_handle),
    existingCredentialIds: (existing.results ?? []).map(
      (row: { credential_id: string }) => row.credential_id,
    ),
  });
  await storeChallenge(c.env, {
    purpose: "recovery-add",
    challenge: options.challenge,
    accountId: auth.accountId,
    clientKind: auth.clientKind,
    binding: await bindingHash(c.req.raw, "recovery-add"),
  });
  return c.json({ options });
});

/**
 * POST /api/v1/recovery/complete — finishes recovery: the new passkey is
 * registered and activated, the old credentials/sessions are revoked and the
 * recovery record is replaced, atomically (spec §7.2).
 */
routes.post("/recovery/complete", async (c) => {
  const auth = await requireAuth(c);
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);

  const body = await readJson<Record<string, unknown>>(c.req.raw, 256 * 1024);
  const operationId = requireString(body.operationId, "operationId", 64);
  const envelope = body.envelope as Record<string, unknown> | undefined;
  const newRecovery = body.recovery as Record<string, unknown> | undefined;
  const userHandleRaw = body.userHandle;
  if (!envelope || !newRecovery || typeof userHandleRaw !== "string") {
    throw badRequest("response, envelope, recovery and userHandle are required");
  }
  const dto = sanitizeRegistrationResponse(body["response"] as Record<string, unknown>);

  const account = await c.env.DB.prepare(
    `SELECT user_handle, auth_epoch FROM accounts WHERE id = ?1`,
  )
    .bind(auth.accountId)
    .first<{ user_handle: ArrayBuffer; auth_epoch: number }>();
  if (!account) throw notFound("account not found");

  const storedHandle = new Uint8Array(account.user_handle);
  const givenHandle = new Uint8Array(decodeBase64Url(userHandleRaw, "userHandle", 32));
  if (storedHandle.byteLength !== givenHandle.byteLength) {
    throw unprocessable("userHandle mismatch");
  }
  for (let i = 0; i < storedHandle.byteLength; i++) {
    if (storedHandle[i] !== givenHandle[i]) throw unprocessable("userHandle mismatch");
  }

  const formatVersion = requireInt(envelope.formatVersion, "envelope.formatVersion", 255);
  const keyVersion = requireInt(envelope.keyVersion, "envelope.keyVersion", 255);
  const wrapSalt = decodeBase64Url(envelope.wrapSalt32, "envelope.wrapSalt32", 32);
  const nonce = decodeBase64Url(envelope.nonce, "envelope.nonce", 12);
  const wrappedKey = decodeBase64Url(envelope.wrappedKey, "envelope.wrappedKey");
  if (wrappedKey.byteLength !== 48) throw unprocessable("wrappedKey must be 48 bytes");

  const recoveryVersion = requireInt(newRecovery.recoveryVersion, "recovery.recoveryVersion", 255);
  const recoveryKeyVersion = requireInt(newRecovery.keyVersion, "recovery.keyVersion", 255);
  const authHash = decodeBase64Url(newRecovery.authHash32, "recovery.authHash32", 32);
  const recoveryNonce = decodeBase64Url(newRecovery.nonce, "recovery.nonce", 12);
  const recoveryWrapped = decodeBase64Url(newRecovery.wrappedKey, "recovery.wrappedKey");
  if (recoveryWrapped.byteLength !== 48) throw unprocessable("recovery.wrappedKey must be 48 bytes");

  // The session cookie is re-issued with the full lifetime once the session
  // is promoted; the token itself does not change.
  const sessionToken = readSessionToken(c.req.raw, c.env)?.token ?? "";
  const promotedCookie = sessionCookie(sessionToken, c.env);

  // A retry after a lost response is answered from the operation record. By
  // then this session is already `active`, so the replay check comes before
  // the scope check — and is scoped to the caller's own account.
  const payloadHash = await sha256(
    new TextEncoder().encode(JSON.stringify({ operationId, response: dto, envelope, newRecovery })),
  );
  const existingOp = await c.env.DB.prepare(
    `SELECT payload_hash32, state FROM operations
      WHERE id = ?1 AND kind = 'recovery' AND account_id = ?2`,
  )
    .bind(operationId, auth.accountId)
    .first<{ payload_hash32: ArrayBuffer; state: string }>();
  if (existingOp) {
    if (!bytesEqual(new Uint8Array(existingOp.payload_hash32), payloadHash)) {
      throw conflict("operationId reused with a different payload");
    }
    if (existingOp.state === "completed") {
      c.header("set-cookie", promotedCookie);
      return c.json({ ok: true, operationId, replayed: true });
    }
  }
  if (auth.scope !== "recovery") throw scopeRequired("recovery session required");

  // The registration must answer a challenge this server issued to this
  // recovery session, exactly once (spec §5.2).
  const challenge = await consumeChallenge(c.env, {
    purpose: "recovery-add",
    responseClientDataJSON: dto.response.clientDataJSON,
    binding: await bindingHash(c.req.raw, "recovery-add"),
  });
  if (challenge.account_id !== auth.accountId) {
    throw badRequest("challenge does not belong to this account");
  }
  const verified = await verifyRegistration(c.env, {
    response: dto,
    expectedChallenge: challengeFromClientData(dto.response.clientDataJSON),
  });

  const now = nowMs();
  const nextEpoch = account.auth_epoch + 1;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO operations (id, kind, account_id, payload_hash32, state, result, created_at, updated_at)
       VALUES (?1, 'recovery', ?2, ?3, 'pending', '{}', ?4, ?4)`,
    ).bind(operationId, auth.accountId, payloadHash.buffer as ArrayBuffer, now),
    c.env.DB.prepare(
      `INSERT INTO credentials
         (credential_id, account_id, public_key, counter, transports, backup_eligible,
          backup_state, device_type, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9)`,
    ).bind(
      verified.credentialId,
      auth.accountId,
      verified.publicKey.buffer as ArrayBuffer,
      verified.counter,
      JSON.stringify(verified.transports),
      verified.backedUp ? 1 : 0,
      verified.backedUp ? 1 : 0,
      verified.deviceType,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO key_envelopes
         (credential_id, account_id, format_version, key_version, wrap_salt32, nonce, wrapped_key, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      verified.credentialId,
      auth.accountId,
      formatVersion,
      keyVersion,
      wrapSalt,
      nonce,
      wrappedKey,
      now,
    ),
    c.env.DB.prepare(
      `UPDATE recovery SET recovery_version = ?2, key_version = ?3, auth_hash32 = ?4,
              nonce = ?5, wrapped_key = ?6, created_at = ?7
        WHERE account_id = ?1`,
    ).bind(
      auth.accountId,
      recoveryVersion,
      recoveryKeyVersion,
      authHash,
      recoveryNonce,
      recoveryWrapped,
      now,
    ),
    c.env.DB.prepare(
      `UPDATE credentials SET status = 'revoked'
        WHERE account_id = ?1 AND credential_id != ?2`,
    ).bind(auth.accountId, verified.credentialId),
    c.env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?2
        WHERE account_id = ?1 AND sid != ?3 AND revoked_at IS NULL`,
    ).bind(auth.accountId, now, auth.session.sid),
    c.env.DB.prepare(`UPDATE accounts SET auth_epoch = ?2 WHERE id = ?1`).bind(
      auth.accountId,
      nextEpoch,
    ),
    c.env.DB.prepare(
      `UPDATE sessions SET auth_epoch = ?2, scope = 'active',
              absolute_expires_at = ?3, idle_expires_at = ?4
        WHERE sid = ?1`,
    ).bind(auth.session.sid, nextEpoch, now + ABSOLUTE_TTL_MS, now + IDLE_TTL_MS),
    c.env.DB.prepare(
      `UPDATE operations SET state = 'completed', result = ?2, updated_at = ?3 WHERE id = ?1`,
    ).bind(operationId, JSON.stringify({ credentialId: verified.credentialId }), now),
  ]);

  c.header("set-cookie", promotedCookie);
  return c.json({ ok: true, operationId, credentialId: verified.credentialId }, 201);
});

/**
 * PUT /api/v1/recovery — rotates the recovery key while the vault is unlocked.
 * Requires a step-up within 5 minutes.
 */
routes.put("/recovery", async (c) => {
  const auth = await requireAuth(c);
  if (auth.scope !== "active") throw unprocessable("active session required");
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  requireStepUp(auth);

  const body = await readJson<Record<string, unknown>>(c.req.raw, 64 * 1024);
  const recoveryVersion = requireInt(body.recoveryVersion, "recoveryVersion", 255);
  const keyVersion = requireInt(body.keyVersion, "keyVersion", 255);
  const authHash = decodeBase64Url(body.authHash32, "authHash32", 32);
  const nonce = decodeBase64Url(body.nonce, "nonce", 12);
  const wrappedKey = decodeBase64Url(body.wrappedKey, "wrappedKey");
  if (wrappedKey.byteLength !== 48) throw unprocessable("wrappedKey must be 48 bytes");

  const now = nowMs();
  const updated = await c.env.DB.prepare(
    `UPDATE recovery SET recovery_version = ?2, key_version = ?3, auth_hash32 = ?4,
            nonce = ?5, wrapped_key = ?6, created_at = ?7
      WHERE account_id = ?1 AND recovery_version < ?2`,
  )
    .bind(auth.accountId, recoveryVersion, keyVersion, authHash, nonce, wrappedKey, now)
    .run();
  if ((updated.meta.changes ?? 0) !== 1) {
    throw conflict("recoveryVersion must increase", "RECOVERY_VERSION_STALE");
  }
  return c.json({ ok: true, recoveryVersion });
});

/* ------------------------------------------------------------------ */
/* GET /api/v1/operations/:id — owner-only completion check            */
/* ------------------------------------------------------------------ */

routes.get("/operations/:id", async (c) => {
  const auth = await requireAuth(c);
  const row = await c.env.DB.prepare(
    `SELECT id, kind, state, result FROM operations WHERE id = ?1 AND account_id = ?2`,
  )
    .bind(c.req.param("id"), auth.accountId)
    .first<{ id: string; kind: string; state: string; result: string }>();
  if (!row) throw notFound("operation not found");
  return c.json({
    operationId: row.id,
    kind: row.kind,
    state: row.state,
    result: JSON.parse(row.result) as unknown,
  });
});

export const identityRoutes = routes;
