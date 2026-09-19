/**
 * Vault: passkey/PRF key management and recovery (spec §6, §7).
 *
 * The VaultKey is either derived here (unlock) or created at registration and
 * stored only as wrappers on the server. It is held in memory for the unlocked
 * session and mirrored into the crypto worker; it is never persisted in
 * localStorage/sessionStorage.
 */

import {
  deriveKek,
  deriveRecoveryAuth,
  deriveRecoveryKek,
  formatRecoveryKey,
  parseRecoveryKey,
  randomBytes,
  recoveryAad,
  unwrapVaultKey,
  vaultKeyAad,
  wrapVaultKey,
} from "../../../../packages/protocol/src/crypto.ts";
import { toBase64Url } from "../../../../packages/protocol/src/base64url.ts";
import { api } from "./api.ts";
import type { KeyEnvelope, RecoveryRecord } from "./api.ts";
import { assertCredential, createCredential, WebAuthnError } from "./webauthn.ts";

export const FORMAT_VERSION = 1;
export const KEY_VERSION = 1;
export const RECOVERY_VERSION = 1;

export interface UnlockedVault {
  vaultKey: Uint8Array;
  accountId: string;
  credentialId: string;
  keyVersion: number;
}

/** Wraps the vault key for a credential and returns the envelope payload. */
async function buildEnvelope(options: {
  vaultKey: Uint8Array;
  prfOutput: Uint8Array;
  accountId: string;
  credentialId: Uint8Array;
}): Promise<{
  formatVersion: number;
  keyVersion: number;
  wrapSalt32: string;
  nonce: string;
  wrappedKey: string;
}> {
  const wrapSalt = randomBytes(32);
  const kek = await deriveKek(options.prfOutput, wrapSalt, options.accountId, options.credentialId);
  const aad = vaultKeyAad(FORMAT_VERSION, KEY_VERSION, options.accountId, options.credentialId);
  const { nonce, wrappedKey } = await wrapVaultKey(options.vaultKey, kek, aad);
  return {
    formatVersion: FORMAT_VERSION,
    keyVersion: KEY_VERSION,
    wrapSalt32: toBase64Url(wrapSalt),
    nonce: toBase64Url(nonce),
    wrappedKey: toBase64Url(wrappedKey),
  };
}

async function unwrapFromEnvelope(options: {
  envelope: KeyEnvelope;
  prfOutput: Uint8Array;
  accountId: string;
  credentialId: Uint8Array;
}): Promise<Uint8Array> {
  const { fromBase64Url } = await import("../../../../packages/protocol/src/base64url.ts");
  const kek = await deriveKek(
    options.prfOutput,
    fromBase64Url(options.envelope.wrapSalt32),
    options.accountId,
    options.credentialId,
  );
  const aad = vaultKeyAad(
    options.envelope.formatVersion,
    options.envelope.keyVersion,
    options.accountId,
    options.credentialId,
  );
  return unwrapVaultKey(
    kek,
    fromBase64Url(options.envelope.nonce),
    fromBase64Url(options.envelope.wrappedKey),
    aad,
  );
}

export interface RegistrationResult {
  vaultKey: Uint8Array;
  accountId: string;
  credentialId: Uint8Array;
  recoveryKeyText: string;
}

/**
 * Full registration (spec §5.3): passkey creation, PRF, VaultKey wrap, recovery
 * key generation, then the atomic bootstrap call. Nothing is activated until
 * bootstrap succeeds.
 */
export async function registerAccount(): Promise<RegistrationResult> {
  const { accountId, options } = await api.registerOptions();
  const created = await createCredential(options);
  const vaultKey = randomBytes(32);

  await api.registerVerify(created.dto);

  const recoverySeed = randomBytes(32);
  const envelope = await buildEnvelope({
    vaultKey,
    prfOutput: created.prfOutput,
    accountId,
    credentialId: created.credentialId,
  });

  const recoveryAuth = await deriveRecoveryAuth(recoverySeed, accountId);
  const recoveryKek = await deriveRecoveryKek(recoverySeed, accountId);
  const recoveryAadBytes = recoveryAad(accountId, RECOVERY_VERSION, KEY_VERSION);
  const { nonce: recoveryNonce, wrappedKey: recoveryWrapped } = await wrapVaultKey(
    vaultKey,
    recoveryKek,
    recoveryAadBytes,
  );
  const recoveryKeyText = await formatRecoveryKey(accountId, recoverySeed);
  const authHash = await crypto.subtle.digest("SHA-256", recoveryAuth as BufferSource);

  const documentId = crypto.randomUUID();
  const bootstrapId = crypto.randomUUID();
  // The initial empty document: one empty text block, encrypted client-side.
  const { createEmptyDocument, serializeDocument } = await import(
    "../../../../packages/protocol/src/document.ts"
  );
  const emptyDoc = createEmptyDocument();
  const snapshotKey = await (await import("../../../../packages/protocol/src/crypto.ts")).deriveDocumentKey(
    vaultKey,
    bootstrapId,
    accountId,
    documentId,
    KEY_VERSION,
  );
  const { aesGcmEncrypt } = await import("../../../../packages/protocol/src/crypto.ts");
  const { documentAad } = await import("../../../../packages/protocol/src/crypto.ts");
  const docNonce = randomBytes(12);
  const docAad = documentAad(FORMAT_VERSION, KEY_VERSION, accountId, documentId, bootstrapId, 0);
  const docCiphertext = await aesGcmEncrypt(
    snapshotKey,
    docNonce,
    new TextEncoder().encode(serializeDocument(emptyDoc)),
    docAad,
  );

  await api.bootstrap({
    bootstrapId,
    credentialId: created.dto.id,
    envelope,
    recovery: {
      recoveryVersion: RECOVERY_VERSION,
      keyVersion: KEY_VERSION,
      authHash32: toBase64Url(new Uint8Array(authHash)),
      nonce: toBase64Url(recoveryNonce),
      wrappedKey: toBase64Url(recoveryWrapped),
    },
    document: {
      documentId,
      formatVersion: FORMAT_VERSION,
      keyVersion: KEY_VERSION,
      nonce: toBase64Url(docNonce),
      ciphertext: toBase64Url(docCiphertext),
    },
  });

  return { vaultKey, accountId, credentialId: created.credentialId, recoveryKeyText };
}

/**
 * Login + unlock. A successful authentication without a usable PRF leaves the
 * vault locked (spec §7): the app must never fall back to a server-held key.
 */
export async function loginAndUnlock(): Promise<UnlockedVault> {
  const { options } = await api.loginOptions();
  const assertion = await assertCredential(options);
  const verified = await api.loginVerify(assertion.dto);

  if (!assertion.prfOutput) {
    throw new WebAuthnError(
      "no-prf",
      "この環境では、このパスキーで暗号化された内容を開けません。",
    );
  }

  const keys = await api.keys();
  const envelope = keys.envelopes.find((entry) => entry.credentialId === verified.credentialId);
  if (!envelope) {
    throw new Error("このパスキー用の鍵が見つかりません。");
  }
  const vaultKey = await unwrapFromEnvelope({
    envelope,
    prfOutput: assertion.prfOutput,
    accountId: verified.accountId,
    credentialId: assertion.credentialIdRaw,
  });
  return {
    vaultKey,
    accountId: verified.accountId,
    credentialId: verified.credentialId,
    keyVersion: envelope.keyVersion,
  };
}

export interface RecoveryOutcome {
  vaultKey: Uint8Array;
  accountId: string;
  newRecoveryKeyText: string;
}

/**
 * Recovery (spec §7.2): the seed never leaves the device — only the derived
 * RecoveryAuth is sent. After unlocking, a new passkey is registered and the
 * recovery record is replaced atomically.
 */
export async function recoverWithKey(recoveryKeyText: string): Promise<RecoveryOutcome> {
  const parsed = await parseRecoveryKey(recoveryKeyText);
  const recoveryAuth = await deriveRecoveryAuth(parsed.seed, parsed.accountId);
  await api.recoveryStart(parsed.accountId, toBase64Url(recoveryAuth));

  const keys = await api.keys();
  const recovery = keys.recovery;
  if (!recovery) throw new Error("復旧情報が見つかりません。");
  const recoveryKek = await deriveRecoveryKek(parsed.seed, parsed.accountId);
  const aad = recoveryAad(parsed.accountId, recovery.recoveryVersion, recovery.keyVersion);
  const { fromBase64Url } = await import("../../../../packages/protocol/src/base64url.ts");
  const vaultKey = await unwrapVaultKey(
    recoveryKek,
    fromBase64Url(recovery.nonce),
    fromBase64Url(recovery.wrappedKey),
    aad,
  );

  // Register a new passkey for this account and rotate the recovery record.
  const session = await api.session();
  const addOptions = await api.credentialAddOptions(await currentUserHandle());
  void session;
  const created = await createCredential(addOptions.options);

  const newSeed = randomBytes(32);
  const newAuth = await deriveRecoveryAuth(newSeed, parsed.accountId);
  const newKek = await deriveRecoveryKek(newSeed, parsed.accountId);
  const newVersion = recovery.recoveryVersion + 1;
  const newAad = recoveryAad(parsed.accountId, newVersion, KEY_VERSION);
  const { nonce, wrappedKey } = await wrapVaultKey(vaultKey, newKek, newAad);
  const newAuthHash = await crypto.subtle.digest("SHA-256", newAuth as BufferSource);
  const envelope = await buildEnvelope({
    vaultKey,
    prfOutput: created.prfOutput,
    accountId: parsed.accountId,
    credentialId: created.credentialId,
  });

  await api.recoveryComplete({
    operationId: crypto.randomUUID(),
    response: created.dto,
    userHandle: await currentUserHandle(),
    envelope,
    recovery: {
      recoveryVersion: newVersion,
      keyVersion: KEY_VERSION,
      authHash32: toBase64Url(new Uint8Array(newAuthHash)),
      nonce: toBase64Url(nonce),
      wrappedKey: toBase64Url(wrappedKey),
    },
  });

  return {
    vaultKey,
    accountId: parsed.accountId,
    newRecoveryKeyText: await formatRecoveryKey(parsed.accountId, newSeed),
  };
}

/** Reads the account's userHandle from /session (owner-only field). */
async function currentUserHandle(): Promise<string> {
  const session = await api.session();
  if (!session.userHandle) {
    throw new Error("このアカウントのパスキー情報を取得できません。");
  }
  return session.userHandle;
}

/** Adds another passkey to the unlocked account (spec §7). */
export async function addPasskey(options: {
  vaultKey: Uint8Array;
  accountId: string;
  keyVersion: number;
}): Promise<{ credentialId: string }> {
  // Step-up is required before adding an entry (§7).
  const stepup = await api.stepupOptions();
  const assertion = await assertCredential(stepup.options);
  await api.stepupVerify(assertion.dto);

  const credentials = await api.credentials();
  void credentials;
  const userHandle = await currentUserHandle();
  const addOptions = await api.credentialAddOptions(userHandle);
  const created = await createCredential(addOptions.options);

  const envelope = await buildEnvelope({
    vaultKey: options.vaultKey,
    prfOutput: created.prfOutput,
    accountId: options.accountId,
    credentialId: created.credentialId,
  });

  await api.credentialAddVerify(created.dto);
  await api.credentialActivate({
    credentialId: created.dto["id"] as string,
    operationId: crypto.randomUUID(),
    envelope,
  });
  return { credentialId: created.dto["id"] as string };
}

/** Rotates the recovery key while unlocked (spec §7.1). */
export async function rotateRecoveryKey(options: {
  vaultKey: Uint8Array;
  accountId: string;
}): Promise<string> {
  const stepup = await api.stepupOptions();
  const assertion = await assertCredential(stepup.options);
  await api.stepupVerify(assertion.dto);

  const current = await api.keys();
  const previous = current.recovery?.recoveryVersion ?? 0;
  const seed = randomBytes(32);
  const auth = await deriveRecoveryAuth(seed, options.accountId);
  const kek = await deriveRecoveryKek(seed, options.accountId);
  const version = previous + 1;
  const aad = recoveryAad(options.accountId, version, KEY_VERSION);
  const { nonce, wrappedKey } = await wrapVaultKey(options.vaultKey, kek, aad);
  const authHash = await crypto.subtle.digest("SHA-256", auth as BufferSource);

  await api.rotateRecovery({
    recoveryVersion: version,
    keyVersion: KEY_VERSION,
    authHash32: toBase64Url(new Uint8Array(authHash)),
    nonce: toBase64Url(nonce),
    wrappedKey: toBase64Url(wrappedKey),
  });
  return formatRecoveryKey(options.accountId, seed);
}

/** Unlocks an existing account whose session is valid but whose vault is locked. */
export async function unlockExisting(vault: {
  accountId: string;
  keyVersion: number;
}): Promise<UnlockedVault> {
  const stepup = await api.stepupOptions();
  const assertion = await assertCredential(stepup.options);
  // A fresh assertion provides a fresh PRF output for the same credential.
  if (!assertion.prfOutput) {
    throw new WebAuthnError("no-prf", "この環境では、このパスキーで暗号化された内容を開けません。");
  }
  const keys = await api.keys();
  const envelope = keys.envelopes.find(
    (entry) => entry.credentialId === (assertion.dto.id as string),
  );
  if (!envelope) throw new Error("このパスキー用の鍵が見つかりません。");
  const vaultKey = await unwrapFromEnvelope({
    envelope,
    prfOutput: assertion.prfOutput,
    accountId: vault.accountId,
    credentialId: assertion.credentialIdRaw,
  });
  return {
    vaultKey,
    accountId: vault.accountId,
    credentialId: assertion.dto.id as string,
    keyVersion: envelope.keyVersion,
  };
}

export const RECOVERY_HELP =
  "復旧キーは端末の外に保管してください。パスキーマネージャーと同じ場所だけに置くと、紛失時に同時に失われます。";
