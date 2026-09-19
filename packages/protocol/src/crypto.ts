/**
 * Cryptographic contract shared by Web (Web Crypto) and Swift (CryptoKit)
 * (spec §6.2, §6.3, §7.1, §11.2).
 *
 * AES-256-GCM, HKDF-SHA256, SHA-256. 12-byte nonces, 16-byte tags. Binary JSON
 * fields are padding-free base64url. Ciphertext fields are `ciphertext||tag`
 * concatenated, with the nonce in a separate field. CryptoKit's combined
 * representation must never be passed to the Web side unprocessed.
 */

import { encode, utf8, uuidToBytes } from "./encode.ts";
import { fromBase64Url, toBase64Url } from "./base64url.ts";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const CHUNK_PLAIN_BYTES = 1_048_576;
export const CHUNK_CIPHER_BYTES = CHUNK_PLAIN_BYTES + TAG_BYTES; // 1,048,592

/** Fixed public PRF input, identical across deploys (spec §6.2). */
export const PRF_INPUT_V1 = await sha256(utf8("txt.2-38.com/prf-input/v1"));

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest);
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/* ------------------------------------------------------------------ */
/* §6.2 passkey PRF -> KEK -> wrapped VaultKey                          */
/* ------------------------------------------------------------------ */

/** KEK = HKDF-SHA256(prfOutput, wrapSalt32, Encode("txt/v1/passkey-wrap", accountId, credentialId), 32) */
export function deriveKek(
  prfOutput: Uint8Array,
  wrapSalt: Uint8Array,
  accountId: string,
  credentialId: Uint8Array,
): Promise<Uint8Array> {
  if (wrapSalt.byteLength !== KEY_BYTES) throw new RangeError("wrapSalt must be 32 bytes");
  return hkdf(
    prfOutput,
    wrapSalt,
    encode("txt/v1/passkey-wrap", uuidToBytes(accountId), credentialId),
    KEY_BYTES,
  );
}

/** wrapAAD = Encode("txt/v1/vault-key", formatVersion, keyVersion, accountId, credentialId) */
export function vaultKeyAad(
  formatVersion: number,
  keyVersion: number,
  accountId: string,
  credentialId: Uint8Array,
): Uint8Array {
  return encode(
    "txt/v1/vault-key",
    formatVersion,
    keyVersion,
    uuidToBytes(accountId),
    credentialId,
  );
}

export interface WrappedKey {
  wrapSalt32: string; // base64url
  nonce: string; // base64url 12
  wrappedKey: string; // base64url ciphertext||tag
}

export async function wrapVaultKey(
  vaultKey: Uint8Array,
  kek: Uint8Array,
  aad: Uint8Array,
): Promise<{ nonce: Uint8Array; wrappedKey: Uint8Array }> {
  if (vaultKey.byteLength !== KEY_BYTES) throw new RangeError("VaultKey must be 32 bytes");
  const nonce = randomBytes(NONCE_BYTES);
  const ct = await aesGcmEncrypt(kek, nonce, vaultKey, aad);
  return { nonce, wrappedKey: ct };
}

export async function unwrapVaultKey(
  kek: Uint8Array,
  nonce: Uint8Array,
  wrappedKey: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const key = await aesGcmDecrypt(kek, nonce, wrappedKey, aad);
  if (key.byteLength !== KEY_BYTES) throw new RangeError("unwrapped VaultKey not 32 bytes");
  return key;
}

/* ------------------------------------------------------------------ */
/* §7.1 recovery key                                                   */
/* ------------------------------------------------------------------ */

/** RecoveryAuth = HKDF-SHA256(seed, accountId16, "txt/v1/recovery-auth", 32) */
export function deriveRecoveryAuth(seed: Uint8Array, accountId: string): Promise<Uint8Array> {
  return hkdf(seed, uuidToBytes(accountId), utf8("txt/v1/recovery-auth"), KEY_BYTES);
}

/** RecoveryKEK = HKDF-SHA256(seed, accountId16, "txt/v1/recovery-wrap", 32) */
export function deriveRecoveryKek(seed: Uint8Array, accountId: string): Promise<Uint8Array> {
  return hkdf(seed, uuidToBytes(accountId), utf8("txt/v1/recovery-wrap"), KEY_BYTES);
}

/** recoveryAAD = Encode("txt/v1/recovery-vault", accountId, recoveryVersion, keyVersion) */
export function recoveryAad(
  accountId: string,
  recoveryVersion: number,
  keyVersion: number,
): Uint8Array {
  return encode("txt/v1/recovery-vault", uuidToBytes(accountId), recoveryVersion, keyVersion);
}

/** `TXT1.<accountId b64url>.<seed b64url>.<checksum>` (spec §7.1). */
export async function formatRecoveryKey(
  accountId: string,
  seed: Uint8Array,
): Promise<string> {
  const body = `TXT1.${toBase64Url(uuidToBytes(accountId))}.${toBase64Url(seed)}`;
  const checksum = (await sha256(utf8(body))).slice(0, 4);
  return `${body}.${toBase64Url(checksum)}`;
}

export interface ParsedRecoveryKey {
  accountId: string;
  seed: Uint8Array;
}

export async function parseRecoveryKey(text: string): Promise<ParsedRecoveryKey> {
  const parts = text.trim().split(".");
  if (parts.length !== 4) throw new Error("recovery key: expected 4 segments");
  const [prefix, accountB64, seedB64, checksumB64] = parts as [string, string, string, string];
  if (prefix !== "TXT1") throw new Error("recovery key: bad prefix");
  const body = `TXT1.${accountB64}.${seedB64}`;
  const expected = (await sha256(utf8(body))).slice(0, 4);
  const actual = fromBase64Url(checksumB64);
  if (actual.byteLength !== 4) throw new Error("recovery key: bad checksum length");
  for (let i = 0; i < 4; i++) {
    if (actual[i] !== expected[i]) throw new Error("recovery key: checksum mismatch");
  }
  const accountBytes = fromBase64Url(accountB64);
  if (accountBytes.byteLength !== 16) throw new Error("recovery key: bad account id");
  const seed = fromBase64Url(seedB64);
  if (seed.byteLength !== KEY_BYTES) throw new Error("recovery key: bad seed length");
  const accountId = Array.from(accountBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const uuid = `${accountId.slice(0, 8)}-${accountId.slice(8, 12)}-${accountId.slice(12, 16)}-${accountId.slice(16, 20)}-${accountId.slice(20)}`;
  return { accountId: uuid, seed };
}

/* ------------------------------------------------------------------ */
/* §6.3 document key + AAD                                             */
/* ------------------------------------------------------------------ */

/** snapshotKey = HKDF-SHA256(VaultKey, mutationId16, Encode("txt/v1/document-key", accountId, documentId, keyVersion), 32) */
export function deriveDocumentKey(
  vaultKey: Uint8Array,
  mutationId: string,
  accountId: string,
  documentId: string,
  keyVersion: number,
): Promise<Uint8Array> {
  return hkdf(
    vaultKey,
    uuidToBytes(mutationId),
    encode("txt/v1/document-key", uuidToBytes(accountId), uuidToBytes(documentId), keyVersion),
    KEY_BYTES,
  );
}

/** documentAAD = Encode("txt/v1/document", formatVersion, keyVersion, accountId, documentId, mutationId, encryptedRevision) */
export function documentAad(
  formatVersion: number,
  keyVersion: number,
  accountId: string,
  documentId: string,
  mutationId: string,
  encryptedRevision: number,
): Uint8Array {
  return encode(
    "txt/v1/document",
    formatVersion,
    keyVersion,
    uuidToBytes(accountId),
    uuidToBytes(documentId),
    uuidToBytes(mutationId),
    encryptedRevision,
  );
}

/** Local encrypted draft: separate purpose names (spec §6.3). */
export function deriveDraftKey(
  vaultKey: Uint8Array,
  draftId: string,
  accountId: string,
  documentId: string,
  keyVersion: number,
): Promise<Uint8Array> {
  return hkdf(
    vaultKey,
    uuidToBytes(draftId),
    encode("txt/v1/draft-key", uuidToBytes(accountId), uuidToBytes(documentId), keyVersion),
    KEY_BYTES,
  );
}

export function draftAad(
  accountId: string,
  documentId: string,
  sceneId: string,
  draftVersion: number,
): Uint8Array {
  return encode("txt/v1/draft", uuidToBytes(accountId), uuidToBytes(documentId), sceneId, draftVersion);
}

/**
 * Local-only record container (spec §6.4).
 *
 * Used for small at-rest values that must not be readable without the VaultKey
 * (for example the WebAuthn user handle needed to add another passkey). These
 * records never travel to the server; the purpose name exists so local storage
 * is cryptographically separated from the wire containers.
 */
export function deriveLocalRecordKey(
  vaultKey: Uint8Array,
  recordId: string,
  accountId: string,
  keyVersion: number,
): Promise<Uint8Array> {
  return hkdf(
    vaultKey,
    uuidToBytes(recordId),
    encode("txt/v1/local-record-key", uuidToBytes(accountId), keyVersion),
    KEY_BYTES,
  );
}

export function localRecordAad(
  accountId: string,
  recordId: string,
  recordVersion: number,
): Uint8Array {
  return encode("txt/v1/local-record", uuidToBytes(accountId), recordId, recordVersion);
}

/* ------------------------------------------------------------------ */
/* §11.2 media chunk container                                         */
/* ------------------------------------------------------------------ */

export function mediaChunkNonce(noncePrefix: Uint8Array, index: number): Uint8Array {
  if (noncePrefix.byteLength !== 8) throw new RangeError("noncePrefix must be 8 bytes");
  const out = new Uint8Array(12);
  out.set(noncePrefix, 0);
  new DataView(out.buffer).setUint32(8, index, false);
  return out;
}

export function mediaChunkAad(
  cryptoFormat: number,
  accountId: string,
  documentId: string,
  mediaId: string,
  index: number,
  totalPlainBytes: number,
  chunkPlainBytes: number,
): Uint8Array {
  // All integers in the AAD use the §6 uint64 representation; only the
  // nonce's index is uint32 (spec §11.2).
  return encode(
    "txt/v1/media-chunk",
    cryptoFormat,
    uuidToBytes(accountId),
    uuidToBytes(documentId),
    uuidToBytes(mediaId),
    index,
    totalPlainBytes,
    chunkPlainBytes,
  );
}

export function mediaCipherLength(plainBytes: number): number {
  if (plainBytes <= 0) throw new RangeError("empty files are rejected");
  const chunks = Math.ceil(plainBytes / CHUNK_PLAIN_BYTES);
  return plainBytes + chunks * TAG_BYTES;
}

export function mediaChunkCount(plainBytes: number): number {
  if (plainBytes <= 0) throw new RangeError("empty files are rejected");
  return Math.ceil(plainBytes / CHUNK_PLAIN_BYTES);
}

/* ------------------------------------------------------------------ */
/* AES-256-GCM primitives                                              */
/* ------------------------------------------------------------------ */

export async function aesGcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (key.byteLength !== KEY_BYTES) throw new RangeError("AES-256-GCM key must be 32 bytes");
  if (nonce.byteLength !== NONCE_BYTES) throw new RangeError("GCM nonce must be 12 bytes");
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const out = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
    cryptoKey,
    plaintext as BufferSource,
  );
  return new Uint8Array(out);
}

export async function aesGcmDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertextAndTag: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (key.byteLength !== KEY_BYTES) throw new RangeError("AES-256-GCM key must be 32 bytes");
  if (nonce.byteLength !== NONCE_BYTES) throw new RangeError("GCM nonce must be 12 bytes");
  if (ciphertextAndTag.byteLength < TAG_BYTES) throw new RangeError("ciphertext shorter than tag");
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    "decrypt",
  ]);
  const out = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
    cryptoKey,
    ciphertextAndTag as BufferSource,
  );
  return new Uint8Array(out);
}
