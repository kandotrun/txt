/**
 * Agent registration helpers for the browser (design §4.3).
 *
 * The browser is the only place besides the agent itself that ever holds
 * the VaultKey, so wrapping for an agent happens here: an ephemeral ECDH
 * key pair is generated per wrap, the VaultKey is wrapped to the agent's
 * public key with the shared protocol contract, and an activation canary
 * is built so the server can activate the agent only after the agent side
 * proves it recovered the VaultKey. Nothing secret is persisted here.
 */

import {
  agentPublicKeyFingerprint,
  createAgentCanary,
  formatAgentFingerprint,
  wrapVaultKeyForAgent,
} from "../../../../packages/protocol/src/agent.ts";
import { fromBase64Url, toBase64Url } from "../../../../packages/protocol/src/base64url.ts";

export interface AgentWrapPayload {
  formatVersion: number;
  keyVersion: number;
  ephemeralPublicKey: string;
  wrapSalt32: string;
  nonce: string;
  wrappedKey: string;
  canaryNonce: string;
  canaryCiphertext: string;
  canaryHash32: string;
}

/** Fingerprint text for a base64url public key, as shown on both sides. */
export async function agentFingerprintDisplay(publicKeyB64: string): Promise<string> {
  const fingerprint = await agentPublicKeyFingerprint(fromBase64Url(publicKeyB64));
  return formatAgentFingerprint(fingerprint);
}

/**
 * Builds the wrap + canary payload for POST /agents/:id/wrap.
 * The plaintext canary is intentionally NOT returned: only its hash goes to
 * the server, and the agent recovers the plaintext from the ciphertext.
 */
export async function buildAgentWrapPayload(options: {
  vaultKey: Uint8Array;
  accountId: string;
  agentId: string;
  publicKeyB64: string;
}): Promise<AgentWrapPayload> {
  const publicKey = fromBase64Url(options.publicKeyB64);
  const wrap = await wrapVaultKeyForAgent({
    vaultKey: options.vaultKey,
    agentPublicKey: publicKey,
    accountId: options.accountId,
    agentId: options.agentId,
  });
  const canary = await createAgentCanary(options.vaultKey, options.agentId);
  return {
    formatVersion: wrap.formatVersion,
    keyVersion: wrap.keyVersion,
    ephemeralPublicKey: toBase64Url(wrap.ephemeralPublicKey),
    wrapSalt32: toBase64Url(wrap.wrapSalt),
    nonce: toBase64Url(wrap.nonce),
    wrappedKey: toBase64Url(wrap.wrappedKey),
    canaryNonce: toBase64Url(canary.nonce),
    canaryCiphertext: toBase64Url(canary.ciphertext),
    canaryHash32: toBase64Url(canary.plaintextHash),
  };
}
