/**
 * Auth routes (spec §5, §12.2): register / login / stepup / session.
 *
 * Registration is pending until /bootstrap atomically activates the account.
 * The document API is not available to pending sessions.
 */

import { Hono } from "hono";

import type { AppBindings } from "../context.ts";
import { enforceRateLimit, clientBucketKey, rateLimitScale, requireAuth } from "../context.ts";
import { badRequest, conflict, notFound, unauthorized } from "../errors.ts";
import { nowMs, readJson, uuid } from "../util.ts";
import { encodeBase64Url } from "../document/store.ts";

import {
  assertWriteRequestAllowed,
  clearSessionCookie,
  issueSession,
  sessionCookie,
  touchSession,
} from "../auth/sessions.ts";
import {
  bindingHash,
  buildLoginOptions,
  buildRegistrationOptions,
  consumeChallenge,
  credentialOwner,
  loadCredential,
  newUserHandle,
  randomDisplayLabel,
  storeChallenge,
  verifyAuthentication,
  verifyRegistration,
} from "../auth/webauthn.ts";
import {
  challengeFromClientData,
  sanitizeAuthenticationResponse,
  sanitizeRegistrationResponse,
} from "../auth/dto.ts";

const register = new Hono<AppBindings>();

/** POST /api/v1/auth/register/options — creates a pending account + challenge. */
register.post("/register/options", async (c) => {
  const bucketKey = await clientBucketKey(c, "register:options");
  await enforceRateLimit(c, { bucketKey, limit: 30 * rateLimitScale(c.env), windowMs: 60 * 60 * 1000 });

  // The body carries nothing we use, but it is still bounded and must parse.
  await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024);
  const clientKind = "web";

  // Fail closed: only the exact switch value opens registration (spec §14).
  if (c.env.REGISTRATION_MODE !== "open") {
    throw conflict("registration is closed", "REGISTRATION_CLOSED");
  }

  const accountId = uuid();
  const userHandle = newUserHandle();
  const label = randomDisplayLabel();
  const now = nowMs();
  await c.env.DB.prepare(
    `INSERT INTO accounts (id, user_handle, display_label, status, auth_epoch, created_at)
     VALUES (?1, ?2, ?3, 'pending', 0, ?4)`,
  )
    .bind(accountId, userHandle.buffer as ArrayBuffer, label, now)
    .run();

  // Storage usage row is created with the account so quota checks never miss.
  await c.env.DB.prepare(
    `INSERT INTO storage_usage (account_id, used_bytes, reserved_bytes, limit_bytes)
     VALUES (?1, 0, 0, ?2)`,
  )
    .bind(accountId, Number(c.env.ACCOUNT_LIMIT_BYTES))
    .run();

  const options = await buildRegistrationOptions(c.env, {
    accountId,
    userHandle,
    existingCredentialIds: [],
  });

  const binding = await bindingHash(c.req.raw, "register");
  await storeChallenge(c.env, {
    purpose: "register",
    challenge: options.challenge,
    accountId,
    clientKind,
    binding,
    context: { label },
  });

  return c.json({ accountId, options });
});

/** POST /api/v1/auth/register/verify — verifies the credential and issues a pending session. */
register.post("/register/verify", async (c) => {
  const bucketKey = await clientBucketKey(c, "register:verify");
  await enforceRateLimit(c, { bucketKey, limit: 60 * rateLimitScale(c.env), windowMs: 60 * 60 * 1000 });

  const body = await readJson<Record<string, unknown>>(c.req.raw, 64 * 1024);
  const dto = sanitizeRegistrationResponse(body["response"] as Record<string, unknown>);

  const binding = await bindingHash(c.req.raw, "register");
  const challenge = await consumeChallenge(c.env, {
    purpose: "register",
    responseClientDataJSON: dto.response.clientDataJSON,
    binding,
  });
  if (!challenge.account_id) throw badRequest("challenge has no account");

  const verified = await verifyRegistration(c.env, {
    response: dto,
    expectedChallenge: challengeFromClientData(dto.response.clientDataJSON),
  });

  const now = nowMs();
  const insert = await c.env.DB.prepare(
    `INSERT INTO credentials
       (credential_id, account_id, public_key, counter, transports, backup_eligible,
        backup_state, device_type, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9)
     ON CONFLICT(credential_id) DO NOTHING`,
  )
    .bind(
      verified.credentialId,
      challenge.account_id,
      verified.publicKey.buffer as ArrayBuffer,
      verified.counter,
      JSON.stringify(verified.transports),
      verified.backedUp ? 1 : 0,
      verified.backedUp ? 1 : 0,
      verified.deviceType,
      now,
    )
    .run();
  if ((insert.meta.changes ?? 0) !== 1) {
    throw conflict("credential already registered");
  }

  const account = await c.env.DB.prepare(`SELECT auth_epoch FROM accounts WHERE id = ?1`)
    .bind(challenge.account_id)
    .first<{ auth_epoch: number }>();
  if (!account) throw notFound("account not found");

  const clientKind = "web";
  const session = await issueSession(c.env, {
    accountId: challenge.account_id,
    clientKind,
    scope: "pending",
    authEpoch: account.auth_epoch,
  });

  c.header("set-cookie", sessionCookie(session.token, c.env));
  return c.json({
    accountId: challenge.account_id,
    credentialId: verified.credentialId,
    scope: "pending",
    expiresAt: session.expiresAt,
  });
});

/** POST /api/v1/auth/login/options — discoverable credential login. */
register.post("/login/options", async (c) => {
  const bucketKey = await clientBucketKey(c, "login:options");
  await enforceRateLimit(c, { bucketKey, limit: 120 * rateLimitScale(c.env), windowMs: 60 * 60 * 1000 });

  await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024).catch(() => ({}));
  const clientKind = "web";
  const options = await buildLoginOptions(c.env, {});
  const binding = await bindingHash(c.req.raw, "login");
  await storeChallenge(c.env, { purpose: "login", challenge: options.challenge, clientKind, binding });
  return c.json({ options });
});

/** POST /api/v1/auth/login/verify — verifies an assertion and issues an active session. */
register.post("/login/verify", async (c) => {
  const bucketKey = await clientBucketKey(c, "login:verify");
  await enforceRateLimit(c, { bucketKey, limit: 120 * rateLimitScale(c.env), windowMs: 60 * 60 * 1000 });

  const body = await readJson<Record<string, unknown>>(c.req.raw, 64 * 1024);
  const dto = sanitizeAuthenticationResponse(body["response"] as Record<string, unknown>);

  const binding = await bindingHash(c.req.raw, "login");
  await consumeChallenge(c.env, {
    purpose: "login",
    responseClientDataJSON: dto.response.clientDataJSON,
    binding,
  });

  const credentialId = dto.id;
  const owner = await credentialOwner(c.env, credentialId);
  if (!owner) throw unauthorized("unknown credential");
  const stored = await loadCredential(c.env, credentialId);
  if (!stored) throw unauthorized("unknown credential");

  const verified = await verifyAuthentication(c.env, {
    response: dto,
    expectedChallenge: challengeFromClientData(dto.response.clientDataJSON),
    credential: stored,
  });

  const now = nowMs();
  await c.env.DB.prepare(
    `UPDATE credentials SET counter = ?1, last_used_at = ?2 WHERE credential_id = ?3`,
  )
    .bind(verified.newCounter, now, credentialId)
    .run();

  const account = await c.env.DB.prepare(
    `SELECT auth_epoch, status, user_handle FROM accounts WHERE id = ?1`,
  )
    .bind(owner)
    .first<{ auth_epoch: number; status: string; user_handle: ArrayBuffer }>();
  if (!account) throw unauthorized("account unavailable");
  if (account.status === "deleting") throw unauthorized("account is being deleted");
  // The owner comes from the server's credential table; a userHandle the
  // authenticator reports must name that same account (spec §5.2).
  if (
    dto.response.userHandle !== undefined &&
    dto.response.userHandle !== encodeBase64Url(account.user_handle)
  ) {
    throw unauthorized("unknown credential");
  }

  const clientKind = "web";
  const scope = account.status === "pending" ? "pending" : "active";
  const session = await issueSession(c.env, {
    accountId: owner,
    clientKind,
    scope,
    authEpoch: account.auth_epoch,
  });

  c.header("set-cookie", sessionCookie(session.token, c.env, session.maxAgeMs));
  return c.json({
    accountId: owner,
    credentialId,
    scope,
    expiresAt: session.expiresAt,
  });
});

/** POST /api/v1/auth/stepup/options — re-authentication for sensitive operations. */
register.post("/stepup/options", async (c) => {
  const auth = await requireAuth(c);
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  await readJson<Record<string, unknown>>(c.req.raw, 16 * 1024).catch(() => ({}));

  // Only passkeys that are already trusted can re-authenticate: a pending or
  // revoked one must never be able to vouch for the session (spec §5.4).
  const rows = await c.env.DB.prepare(
    `SELECT credential_id FROM credentials WHERE account_id = ?1 AND status = 'active'`,
  )
    .bind(auth.accountId)
    .all<{ credential_id: string }>();
  const allowCredentialIds = (rows.results ?? []).map(
    (row: { credential_id: string }) => row.credential_id,
  );
  if (allowCredentialIds.length === 0) throw conflict("no active credentials");

  const options = await buildLoginOptions(c.env, { allowCredentialIds });
  const binding = await bindingHash(c.req.raw, "stepup");
  await storeChallenge(c.env, {
    purpose: "stepup",
    challenge: options.challenge,
    accountId: auth.accountId,
    clientKind: auth.clientKind,
    binding,
  });
  return c.json({ options });
});

/** POST /api/v1/auth/stepup/verify — marks the session as recently re-authenticated. */
register.post("/stepup/verify", async (c) => {
  const auth = await requireAuth(c);
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  const bucketKey = await clientBucketKey(c, "stepup:verify");
  await enforceRateLimit(c, { bucketKey, limit: 60 * rateLimitScale(c.env), windowMs: 60 * 60 * 1000 });

  const body = await readJson<Record<string, unknown>>(c.req.raw, 64 * 1024);
  const dto = sanitizeAuthenticationResponse(body["response"] as Record<string, unknown>);

  const binding = await bindingHash(c.req.raw, "stepup");
  const challenge = await consumeChallenge(c.env, {
    purpose: "stepup",
    responseClientDataJSON: dto.response.clientDataJSON,
    binding,
  });
  if (challenge.account_id !== auth.accountId) {
    throw unauthorized("challenge does not belong to this account");
  }

  const stored = await loadCredential(c.env, dto.id);
  if (!stored || stored.account_id !== auth.accountId || stored.status !== "active") {
    throw unauthorized("credential does not belong to this account");
  }

  const verified = await verifyAuthentication(c.env, {
    response: dto,
    expectedChallenge: challengeFromClientData(dto.response.clientDataJSON),
    credential: stored,
  });

  const now = nowMs();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE credentials SET counter = ?1, last_used_at = ?2 WHERE credential_id = ?3`,
    ).bind(verified.newCounter, now, stored.credential_id),
    // Guarded in SQL: a passkey revoked between the check and this write
    // leaves the session without a step-up.
    c.env.DB.prepare(
      `UPDATE sessions SET stepup_at = ?1
        WHERE sid = ?2 AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM credentials
                       WHERE credential_id = ?3 AND account_id = ?4 AND status = 'active')`,
    ).bind(now, auth.session.sid, stored.credential_id, auth.accountId),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) {
    throw unauthorized("credential does not belong to this account");
  }

  return c.json({ ok: true, stepupAt: now, credentialId: stored.credential_id });
});

/** GET /api/v1/session — current authentication state. */
export const sessionRoutes = new Hono<AppBindings>();

sessionRoutes.get("/session", async (c) => {
  const auth = await requireAuth(c);
  await touchSession(c.env, auth);
  const account = await c.env.DB.prepare(
    `SELECT display_label, status, user_handle FROM accounts WHERE id = ?1`,
  )
    .bind(auth.accountId)
    .first<{ display_label: string; status: string; user_handle: ArrayBuffer }>();
  // The userHandle is a public WebAuthn value the client needs to add another
  // passkey; it is only exposed to an authenticated owner (spec §5.1).
  const userHandle = account?.user_handle ? encodeBase64Url(account.user_handle) : null;
  return c.json({
    accountId: auth.accountId,
    displayLabel: account?.display_label ?? null,
    accountStatus: account?.status ?? "unknown",
    userHandle,
    scope: auth.scope,
    clientKind: auth.clientKind,
    via: auth.via,
    stepupAt: auth.session.stepup_at,
    expiresAt: auth.session.absolute_expires_at,
    idleExpiresAt: auth.session.idle_expires_at,
  });
});

/** DELETE /api/v1/session — ends the current session only. */
sessionRoutes.delete("/session", async (c) => {
  const auth = await requireAuth(c);
  assertWriteRequestAllowed(c.req.raw, auth.via, c.env);
  await c.env.DB.prepare(`UPDATE sessions SET revoked_at = ?1 WHERE sid = ?2`)
    .bind(nowMs(), auth.session.sid)
    .run();
  c.header("set-cookie", clearSessionCookie(c.env));
  return c.json({ ok: true });
});

export const authRoutes = register;
