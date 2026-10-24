/**
 * Enrollment CLI (design §4.3, agent side).
 *
 * Commands:
 *   txt-agent enroll   --agent <agentId> --code <pairingCode> [--name "Clio (Mac)"]
 *   txt-agent activate --agent <agentId> --code <pairingCode>
 *   txt-agent set-token --token txta1.... [--token-id <id>] [--expires-at <ms>]
 *   txt-agent fingerprint
 *
 * The pairing code is shown once in the browser when the enrollment is
 * created. The private key generated here never leaves the secret store;
 * the fingerprint printed by `enroll` must match what the browser shows
 * before the user confirms the wrap.
 */

import {
  decryptAgentCanary,
  exportAgentPrivateKeyJwk,
  exportAgentPublicKey,
  formatAgentFingerprint,
  generateAgentKeyPair,
  agentPublicKeyFingerprint,
  importAgentPrivateKey,
  unwrapVaultKeyForAgent,
} from "../../../packages/protocol/src/agent.ts";
import { fromBase64Url, toBase64Url } from "../../../packages/protocol/src/base64url.ts";
import type { AgentState } from "./config.ts";
import { AgentApiError } from "./vault.ts";

function argValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function requireArg(argv: string[], name: string): string {
  const value = argValue(argv, name);
  if (!value) throw new Error(`missing required argument ${name}`);
  return value;
}

async function postJson(
  apiBase: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let code = "HTTP_ERROR";
    let message = `request failed (${response.status})`;
    try {
      const parsed = JSON.parse(text) as { error?: { code: string; message: string } };
      if (parsed.error) {
        code = parsed.error.code;
        message = parsed.error.message;
      }
    } catch {
      // keep the generic message
    }
    throw new AgentApiError(response.status, code, message);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export async function enroll(state: AgentState, argv: string[]): Promise<void> {
  const agentId = requireArg(argv, "--agent");
  const pairingCode = requireArg(argv, "--code");
  const name = argValue(argv, "--name") ?? undefined;
  const config = state.loadConfig();

  const existing = state.loadKeyPair();
  if (existing && !argv.includes("--force")) {
    throw new Error(
      "a key pair already exists in the secret store; pass --force to replace it (the old wrap becomes unusable)",
    );
  }
  const keyPair = await generateAgentKeyPair();
  const publicKey = await exportAgentPublicKey(keyPair.publicKey);
  const privateKeyJwk = await exportAgentPrivateKeyJwk(keyPair.privateKey);

  const result = await postJson(config.apiBase, `/api/v1/agents/enrollments/${agentId}/pubkey`, {
    pairingCode,
    publicKey: toBase64Url(publicKey),
    ...(name ? { displayName: name } : {}),
  });

  // Persist only after the server accepted the key: a failed submission
  // must not replace a working key pair.
  state.saveKeyPair({ privateKeyJwk, publicKey: toBase64Url(publicKey) });
  state.saveConfig({ ...config, agentId, displayName: name ?? config.displayName });

  const fingerprint = await agentPublicKeyFingerprint(publicKey);
  console.log(`agentId: ${agentId}`);
  console.log(`fingerprint: ${formatAgentFingerprint(fingerprint)}`);
  console.log(`server fingerprint: ${String(result.fingerprint ?? "")}`);
  console.log("Confirm the fingerprint matches in the browser, then run:");
  console.log(`  txt-agent activate --agent ${agentId} --code <pairingCode>`);
}

export async function activate(state: AgentState, argv: string[]): Promise<void> {
  const agentId = requireArg(argv, "--agent");
  const pairingCode = requireArg(argv, "--code");
  const config = state.loadConfig();
  const stored = state.loadKeyPair();
  if (!stored) throw new Error("no key pair; run enroll first");
  const privateKey = await importAgentPrivateKey(stored.privateKeyJwk);

  const challenge = await postJson(
    config.apiBase,
    `/api/v1/agents/enrollments/${agentId}/canary-challenge`,
    { pairingCode },
  );
  const accountId = String(challenge.accountId);
  const vaultKey = await unwrapVaultKeyForAgent({
    privateKey,
    wrap: {
      ephemeralPublicKey: fromBase64Url(String(challenge.ephemeralPublicKey)),
      wrapSalt: fromBase64Url(String(challenge.wrapSalt32)),
      nonce: fromBase64Url(String(challenge.nonce)),
      wrappedKey: fromBase64Url(String(challenge.wrappedKey)),
      formatVersion: Number(challenge.formatVersion),
      keyVersion: Number(challenge.keyVersion),
    },
    accountId,
    agentId,
  });
  const canaryPlaintext = await decryptAgentCanary(
    vaultKey,
    agentId,
    fromBase64Url(String(challenge.canaryNonce)),
    fromBase64Url(String(challenge.canaryCiphertext)),
  );
  const result = await postJson(config.apiBase, `/api/v1/agents/enrollments/${agentId}/canary`, {
    pairingCode,
    canaryPlaintext: toBase64Url(canaryPlaintext),
  });
  console.log(`activated: ${String(result.agentId ?? agentId)}`);
  console.log("Issue a read token in the browser, then run:");
  console.log("  txt-agent set-token --token txta1....");
}

export async function setToken(state: AgentState, argv: string[]): Promise<void> {
  const token = requireArg(argv, "--token");
  if (!token.startsWith("txta1.")) throw new Error("token must start with txta1.");
  const expiresAtRaw = argValue(argv, "--expires-at");
  const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : Date.now() + 30 * 24 * 3600 * 1000;
  if (!Number.isFinite(expiresAt)) throw new Error("--expires-at must be a Unix millisecond value");
  state.saveToken({ token, tokenId: argValue(argv, "--token-id") ?? "", expiresAt });
  console.log(`token stored (expires ${new Date(expiresAt).toISOString()})`);
}

export async function fingerprint(state: AgentState): Promise<void> {
  const stored = state.loadKeyPair();
  if (!stored) throw new Error("no key pair; run enroll first");
  const bytes = fromBase64Url(stored.publicKey);
  const digest = await agentPublicKeyFingerprint(bytes);
  console.log(formatAgentFingerprint(digest));
}
