/**
 * Agent key wrap contract (agent design §4, spec §6.6 proposal).
 *
 * Agents have no WebAuthn authenticator, so instead of a PRF output the
 * VaultKey is wrapped with an asymmetric key pair owned by the agent:
 *
 *   sharedSecret = ECDH(ephPriv, agentPub) raw 32 bytes (deriveBits 256)
 *   KEK-agent    = HKDF-SHA256(sharedSecret, wrapSalt32,
 *                  Encode("txt/v1/agent-wrap", accountId, agentId), 32)
 *   wrapAAD      = Encode("txt/v1/agent-vault-key", formatVersion,
 *                  keyVersion, accountId, agentId)
 *   wrappedKey   = AES-256-GCM(KEK-agent, randomNonce12, VaultKey, wrapAAD)
 *
 * The ephemeral private key is created for one wrap inside the browser and
 * discarded immediately; the server stores only the ephemeral public key,
 * the salt, the nonce and the wrapped key. Domain separation strings never
 * collide with the passkey (`txt/v1/passkey-wrap` / `txt/v1/vault-key`) or
 * recovery (`txt/v1/recovery-*`) contracts. All byte formats follow §6.3
 * (AES-256-GCM, HKDF-SHA256, 12-byte nonce, base64url on the wire).
 *
 * Activation additionally uses a canary: a random 16-byte value encrypted
 * under a VaultKey-derived key. Only an agent that truly recovered the
 * VaultKey from the wrap can return the canary plaintext (design §4.3).
 */

import { encode, utf8, uuidToBytes } from "./encode.ts";
import {
  KEY_BYTES,
  NONCE_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdf,
  randomBytes,
  sha256,
  unwrapVaultKey,
  wrapVaultKey,
} from "./crypto.ts";

export const AGENT_FORMAT_VERSION = 1;
export const AGENT_KEY_VERSION = 1;
/** Uncompressed P-256 point: 0x04 || x(32) || y(32). */
export const AGENT_PUBLIC_KEY_BYTES = 65;
export const AGENT_CANARY_PLAIN_BYTES = 16;

const ECDH_PARAMS = { name: "ECDH", namedCurve: "P-256" } as const;

/* ------------------------------------------------------------------ */
/* Key pairs                                                           */
/* ------------------------------------------------------------------ */

export async function generateAgentKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"]) as Promise<CryptoKeyPair>;
}

/** Raw uncompressed point (65 bytes) — the only key form sent to the server. */
export async function exportAgentPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  const raw = (await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer;
  const bytes = new Uint8Array(raw);
  assertAgentPublicKeyBytes(bytes);
  return bytes;
}

export function assertAgentPublicKeyBytes(bytes: Uint8Array): void {
  if (bytes.byteLength !== AGENT_PUBLIC_KEY_BYTES) {
    throw new RangeError("agent public key must be a 65-byte uncompressed P-256 point");
  }
  if (bytes[0] !== 0x04) {
    throw new RangeError("agent public key must be an uncompressed point (0x04 prefix)");
  }
}

export async function importAgentPublicKey(bytes: Uint8Array): Promise<CryptoKey> {
  assertAgentPublicKeyBytes(bytes);
  return crypto.subtle.importKey("raw", bytes as BufferSource, ECDH_PARAMS, true, []);
}

export async function importAgentPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ECDH_PARAMS, true, ["deriveBits"]);
}

export async function exportAgentPrivateKeyJwk(privateKey: CryptoKey): Promise<JsonWebKey> {
  return (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
}

/** SHA-256 of the raw public key — the fingerprint humans compare (design §4.3). */
export function agentPublicKeyFingerprint(publicKey: Uint8Array): Promise<Uint8Array> {
  assertAgentPublicKeyBytes(publicKey);
  return sha256(publicKey);
}

/**
 * Human-comparable fingerprint rendering, identical on the browser and the
 * agent side: lowercase hex in groups of 8 characters separated by spaces.
 */
export function formatAgentFingerprint(fingerprint: Uint8Array): string {
  const hex = Array.from(fingerprint, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{1,8}/g)?.join(" ") ?? hex;
}

/* ------------------------------------------------------------------ */
/* KEK derivation + wrap                                               */
/* ------------------------------------------------------------------ */

/** KEK = HKDF-SHA256(sharedSecret, wrapSalt32, Encode("txt/v1/agent-wrap", accountId, agentId), 32) */
export function deriveAgentKek(
  sharedSecret: Uint8Array,
  wrapSalt: Uint8Array,
  accountId: string,
  agentId: string,
): Promise<Uint8Array> {
  if (sharedSecret.byteLength !== KEY_BYTES) {
    throw new RangeError("ECDH shared secret must be 32 bytes");
  }
  if (wrapSalt.byteLength !== KEY_BYTES) throw new RangeError("wrapSalt must be 32 bytes");
  return hkdf(
    sharedSecret,
    wrapSalt,
    encode("txt/v1/agent-wrap", uuidToBytes(accountId), uuidToBytes(agentId)),
    KEY_BYTES,
  );
}

/** wrapAAD = Encode("txt/v1/agent-vault-key", formatVersion, keyVersion, accountId, agentId) */
export function agentVaultKeyAad(
  formatVersion: number,
  keyVersion: number,
  accountId: string,
  agentId: string,
): Uint8Array {
  return encode(
    "txt/v1/agent-vault-key",
    formatVersion,
    keyVersion,
    uuidToBytes(accountId),
    uuidToBytes(agentId),
  );
}

async function ecdhSharedSecret(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array> {
  const params = { name: "ECDH", public: publicKey } as unknown as Parameters<
    SubtleCrypto["deriveBits"]
  >[0];
  const bits = await crypto.subtle.deriveBits(params, privateKey, 256);
  const secret = new Uint8Array(bits);
  if (secret.byteLength !== KEY_BYTES) throw new RangeError("ECDH shared secret must be 32 bytes");
  return secret;
}

export interface AgentWrap {
  formatVersion: number;
  keyVersion: number;
  /** Browser ephemeral public key (raw 65 bytes); the private half is discarded. */
  ephemeralPublicKey: Uint8Array;
  wrapSalt: Uint8Array;
  nonce: Uint8Array;
  wrappedKey: Uint8Array;
}

/**
 * Browser side: wraps the VaultKey to the agent's static public key.
 * The ephemeral private key never leaves this call frame.
 */
export async function wrapVaultKeyForAgent(options: {
  vaultKey: Uint8Array;
  agentPublicKey: Uint8Array;
  accountId: string;
  agentId: string;
  formatVersion?: number;
  keyVersion?: number;
}): Promise<AgentWrap> {
  const formatVersion = options.formatVersion ?? AGENT_FORMAT_VERSION;
  const keyVersion = options.keyVersion ?? AGENT_KEY_VERSION;
  const agentPublic = await importAgentPublicKey(options.agentPublicKey);
  const ephemeral = await generateAgentKeyPair();
  const sharedSecret = await ecdhSharedSecret(ephemeral.privateKey, agentPublic);
  const wrapSalt = randomBytes(KEY_BYTES);
  const kek = await deriveAgentKek(sharedSecret, wrapSalt, options.accountId, options.agentId);
  const aad = agentVaultKeyAad(formatVersion, keyVersion, options.accountId, options.agentId);
  const { nonce, wrappedKey } = await wrapVaultKey(options.vaultKey, kek, aad);
  return {
    formatVersion,
    keyVersion,
    ephemeralPublicKey: await exportAgentPublicKey(ephemeral.publicKey),
    wrapSalt,
    nonce,
    wrappedKey,
  };
}

/** Agent side: recovers the VaultKey from a wrap. Tag failure throws. */
export async function unwrapVaultKeyForAgent(options: {
  privateKey: CryptoKey;
  wrap: {
    ephemeralPublicKey: Uint8Array;
    wrapSalt: Uint8Array;
    nonce: Uint8Array;
    wrappedKey: Uint8Array;
    formatVersion: number;
    keyVersion: number;
  };
  accountId: string;
  agentId: string;
}): Promise<Uint8Array> {
  const ephemeralPublic = await importAgentPublicKey(options.wrap.ephemeralPublicKey);
  const sharedSecret = await ecdhSharedSecret(options.privateKey, ephemeralPublic);
  const kek = await deriveAgentKek(
    sharedSecret,
    options.wrap.wrapSalt,
    options.accountId,
    options.agentId,
  );
  const aad = agentVaultKeyAad(
    options.wrap.formatVersion,
    options.wrap.keyVersion,
    options.accountId,
    options.agentId,
  );
  return unwrapVaultKey(kek, options.wrap.nonce, options.wrap.wrappedKey, aad);
}

/* ------------------------------------------------------------------ */
/* Activation canary (design §4.3 step 6)                              */
/* ------------------------------------------------------------------ */

/** canaryKey = HKDF-SHA256(VaultKey, agentId16, UTF8("txt/v1/agent-canary"), 32) */
export function deriveAgentCanaryKey(vaultKey: Uint8Array, agentId: string): Promise<Uint8Array> {
  if (vaultKey.byteLength !== KEY_BYTES) throw new RangeError("VaultKey must be 32 bytes");
  return hkdf(vaultKey, uuidToBytes(agentId), utf8("txt/v1/agent-canary"), KEY_BYTES);
}

export interface AgentCanary {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  /** Random, not secret: the server checks SHA-256(plaintext). */
  plaintext: Uint8Array;
  plaintextHash: Uint8Array;
}

/** Browser side: builds the activation canary for a freshly wrapped agent. */
export async function createAgentCanary(
  vaultKey: Uint8Array,
  agentId: string,
): Promise<AgentCanary> {
  const key = await deriveAgentCanaryKey(vaultKey, agentId);
  const plaintext = randomBytes(AGENT_CANARY_PLAIN_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const aad = encode("txt/v1/agent-canary", uuidToBytes(agentId));
  const ciphertext = await aesGcmEncrypt(key, nonce, plaintext, aad);
  return { nonce, ciphertext, plaintext, plaintextHash: await sha256(plaintext) };
}

/** Agent side: decrypts a canary after unwrapping the VaultKey. */
export async function decryptAgentCanary(
  vaultKey: Uint8Array,
  agentId: string,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const key = await deriveAgentCanaryKey(vaultKey, agentId);
  const aad = encode("txt/v1/agent-canary", uuidToBytes(agentId));
  const plaintext = await aesGcmDecrypt(key, nonce, ciphertext, aad);
  if (plaintext.byteLength !== AGENT_CANARY_PLAIN_BYTES) {
    throw new RangeError("agent canary plaintext must be 16 bytes");
  }
  return plaintext;
}
