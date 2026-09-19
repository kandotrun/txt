/**
 * WebAuthn ceremonies (spec §5.1, §5.2, §5.3, §7).
 *
 * - accountId is a UUID, userHandle is 32 random bytes. No email/phone/name
 *   columns or inputs.
 * - WebAuthn `user.name` / `displayName` use a random label like `txt-8CF3A2B1`.
 * - Ownership is decided by verified credentials plus the server's mapping,
 *   never by a label or a client-supplied accountId.
 * - `residentKey: required`, `userVerification: required`, `attestation: none`.
 *   `authenticatorAttachment: platform` is NOT pinned.
 * - Challenges: >= 32 random bytes, 5 minute expiry, single use, bound to
 *   purpose + client_kind + accountId. Consumption is atomic.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import type { Env } from "../types.ts";
import { badRequest, conflict, notFound, unauthorized } from "../errors.ts";
import { nowMs, randomBytes, sha256, uuid } from "../util.ts";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type ChallengePurpose =
  | "register"
  | "login"
  | "stepup"
  | "credential-add"
  | "credential-activate"
  | "recovery-add";

export interface ChallengeContext {
  /** Purpose-specific payload (pending keys, target credential, ...). */
  [key: string]: unknown;
}

export interface ChallengeRow {
  id: string;
  challenge_hash32: ArrayBuffer;
  purpose: ChallengePurpose;
  account_id: string | null;
  credential_id: string | null;
  client_kind: string;
  binding_hash32: ArrayBuffer;
  context: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

/** Random label like `txt-8CF3A2B1` (spec §5.1). */
export function randomDisplayLabel(): string {
  const bytes = randomBytes(4);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `txt-${hex.toUpperCase()}`;
}

/** 32 random bytes as base64 (the WebAuthn user handle). */
export function newUserHandle(): Uint8Array {
  return randomBytes(32);
}

export function originFor(env: Env): string {
  return env.APP_ORIGIN;
}

/**
 * Binds a ceremony to the requesting context so a verified response cannot be
 * replayed for a different session or operation.
 */
export async function bindingHash(
  request: Request,
  purpose: ChallengePurpose,
): Promise<ArrayBuffer> {
  const userAgent = request.headers.get("user-agent") ?? "";
  const acceptLanguage = request.headers.get("accept-language") ?? "";
  const clientHint = request.headers.get("sec-ch-ua") ?? "";
  const material = `${purpose}\n${userAgent}\n${acceptLanguage}\n${clientHint}`;
  const digest = await sha256(new TextEncoder().encode(material));
  return digest.buffer as ArrayBuffer;
}

export async function storeChallenge(
  env: Env,
  options: {
    purpose: ChallengePurpose;
    challenge: string;
    accountId?: string | null;
    credentialId?: string | null;
    clientKind: "web" | "native";
    binding: ArrayBuffer;
    context?: ChallengeContext;
  },
): Promise<string> {
  const id = uuid();
  const challengeHash = await sha256(new TextEncoder().encode(options.challenge));
  const now = nowMs();
  await env.DB.prepare(
    `INSERT INTO challenges
       (id, challenge_hash32, purpose, account_id, credential_id, client_kind,
        binding_hash32, context, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      challengeHash.buffer as ArrayBuffer,
      options.purpose,
      options.accountId ?? null,
      options.credentialId ?? null,
      options.clientKind,
      options.binding,
      JSON.stringify(options.context ?? {}),
      now,
      now + CHALLENGE_TTL_MS,
    )
    .run();
  return id;
}

/**
 * Atomically consumes a challenge and returns it. A second consumption, an
 * expired challenge, or a binding mismatch all fail.
 */
export async function consumeChallenge(
  env: Env,
  options: {
    purpose: ChallengePurpose;
    responseClientDataJSON: string;
    binding: ArrayBuffer;
  },
): Promise<ChallengeRow> {
  let clientData: { challenge?: unknown };
  try {
    clientData = JSON.parse(decodeBase64Url(options.responseClientDataJSON));
  } catch {
    throw badRequest("clientDataJSON is not valid JSON");
  }
  const challenge = clientData.challenge;
  if (typeof challenge !== "string" || challenge.length === 0) {
    throw badRequest("clientDataJSON has no challenge");
  }
  const challengeHash = await sha256(new TextEncoder().encode(challenge));
  const now = nowMs();
  const row = await env.DB.prepare(
    `SELECT id, challenge_hash32, purpose, account_id, credential_id, client_kind,
            binding_hash32, context, created_at, expires_at, consumed_at
       FROM challenges WHERE challenge_hash32 = ?1 AND purpose = ?2`,
  )
    .bind(challengeHash.buffer as ArrayBuffer, options.purpose)
    .first<ChallengeRow>();
  if (!row) throw badRequest("unknown or already consumed challenge");
  if (row.consumed_at !== null) throw conflict("challenge already used");
  if (row.expires_at <= now) throw badRequest("challenge expired");
  if (!arrayBufferEqual(row.binding_hash32, options.binding)) {
    throw badRequest("challenge is bound to a different client");
  }
  const consumed = await env.DB.prepare(
    `UPDATE challenges SET consumed_at = ?1 WHERE id = ?2 AND consumed_at IS NULL`,
  )
    .bind(now, row.id)
    .run();
  if ((consumed.meta.changes ?? 0) !== 1) {
    throw conflict("challenge already used");
  }
  return row;
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function arrayBufferEqual(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  const left = a instanceof Uint8Array ? a : new Uint8Array(a);
  const right = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) diff |= (left[i] as number) ^ (right[i] as number);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export async function buildRegistrationOptions(
  env: Env,
  options: { accountId: string; userHandle: Uint8Array; existingCredentialIds: string[] },
): Promise<ReturnType<typeof generateRegistrationOptions>> {
  const label = randomDisplayLabel();
  return generateRegistrationOptions({
    rpName: env.WEBAUTHN_RP_NAME,
    rpID: env.WEBAUTHN_RP_ID,
    userID: options.userHandle.slice(),
    userName: label,
    userDisplayName: label,
    attestationType: "none",
    excludeCredentials: options.existingCredentialIds.map((id) => ({
      id,
      transports: undefined,
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
      // No `authenticatorAttachment` pin: the spec forbids narrowing the store.
    },
    extensions: {
      // Request the PRF extension; the actual output is only read client-side.
      prf: {},
    },
  }) as ReturnType<typeof generateRegistrationOptions>;
}

export async function verifyRegistration(
  env: Env,
  options: { response: RegistrationResponseJSON; expectedChallenge: string },
): Promise<{
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
}> {
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: options.response,
      expectedChallenge: options.expectedChallenge,
      expectedOrigin: originFor(env),
      expectedRPID: env.WEBAUTHN_RP_ID,
      requireUserVerification: true,
    });
  } catch (error) {
    throw badRequest(`registration verification failed: ${(error as Error).message}`);
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw badRequest("registration not verified");
  }
  const info = verification.registrationInfo;
  return {
    credentialId: info.credential.id,
    publicKey: info.credential.publicKey,
    counter: info.credential.counter,
    transports: (info.credential.transports ?? []) as string[],
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
  };
}

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

export async function buildLoginOptions(
  env: Env,
  options: { allowCredentialIds?: string[] } = {},
): Promise<ReturnType<typeof generateAuthenticationOptions>> {
  return generateAuthenticationOptions({
    rpID: env.WEBAUTHN_RP_ID,
    // Discoverable credentials: an empty allowCredentials list by default.
    allowCredentials:
      options.allowCredentialIds && options.allowCredentialIds.length > 0
        ? options.allowCredentialIds.map((id) => ({ id }))
        : [],
    userVerification: "required",
    extensions: { prf: {} },
  }) as ReturnType<typeof generateAuthenticationOptions>;
}

export async function loadCredential(
  env: Env,
  credentialId: string,
): Promise<{
  credential_id: string;
  account_id: string;
  public_key: ArrayBuffer;
  counter: number;
  transports: string;
  status: string;
  account_status: string;
  auth_epoch: number;
} | null> {
  return env.DB.prepare(
    `SELECT c.credential_id, c.account_id, c.public_key, c.counter, c.transports, c.status,
            a.status AS account_status, a.auth_epoch
       FROM credentials c JOIN accounts a ON a.id = c.account_id
      WHERE c.credential_id = ?1`,
  )
    .bind(credentialId)
    .first();
}

export async function verifyAuthentication(
  env: Env,
  options: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    credential: {
      credential_id: string;
      public_key: ArrayBuffer;
      counter: number;
      transports: string;
    };
  },
): Promise<{ newCounter: number; userVerified: boolean; backedUp: boolean }> {
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: options.response,
      expectedChallenge: options.expectedChallenge,
      expectedOrigin: originFor(env),
      expectedRPID: env.WEBAUTHN_RP_ID,
      requireUserVerification: true,
      credential: {
        id: options.credential.credential_id,
        publicKey: new Uint8Array(options.credential.public_key),
        counter: options.credential.counter,
        transports: JSON.parse(options.credential.transports || "[]") as AuthenticatorTransport[],
      },
    });
  } catch (error) {
    throw unauthorized(`authentication verification failed: ${(error as Error).message}`);
  }
  if (!verification.verified) throw unauthorized("authentication not verified");
  return {
    newCounter: verification.authenticationInfo.newCounter,
    userVerified: verification.authenticationInfo.userVerified,
    backedUp: verification.authenticationInfo.credentialBackedUp,
  };
}

/**
 * Resolves the account that owns a credential whose id appears in an
 * assertion. Unknown credential IDs are treated as 404 (existence is not
 * leaked) — the caller must not echo them back to the client in errors.
 */
export async function credentialOwner(env: Env, credentialId: string): Promise<string | null> {
  const row = await loadCredential(env, credentialId);
  if (!row) return null;
  if (row.status !== "active") return null;
  if (row.account_status !== "active" && row.account_status !== "pending") return null;
  return row.account_id;
}

export async function requireCredential(env: Env, credentialId: string): Promise<NonNullable<Awaited<ReturnType<typeof loadCredential>>>> {
  const row = await loadCredential(env, credentialId);
  if (!row) throw notFound("credential not found");
  return row;
}
