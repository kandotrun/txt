/**
 * Agent key wrap vectors and tamper tests (agent design §4.2, §10 phase 1).
 *
 * Deterministic parts (KEK from a fixed shared secret, canary key, public
 * key fingerprint) are pinned by snapshots from fixed inputs. Wrap/unwrap
 * uses real generated P-256 key pairs because Web Crypto cannot import a
 * raw ECDH scalar; the round-trip and tamper cases are the behavioural
 * contract the Web side and the MCP side must agree on.
 */

import { describe, expect, it } from "vitest";

import {
  agentPublicKeyFingerprint,
  agentVaultKeyAad,
  createAgentCanary,
  decryptAgentCanary,
  deriveAgentCanaryKey,
  deriveAgentKek,
  exportAgentPublicKey,
  formatAgentFingerprint,
  generateAgentKeyPair,
  unwrapVaultKeyForAgent,
  wrapVaultKeyForAgent,
} from "../../packages/protocol/src/agent.ts";
import { sha256 } from "../../packages/protocol/src/crypto.ts";
import { toBase64Url } from "../../packages/protocol/src/base64url.ts";

const ACCOUNT_ID = "8cf3a2b1-0000-4000-8000-000000000001";
const AGENT_ID = "8cf3a2b1-0000-4000-8000-0000000000a1";
const OTHER_AGENT_ID = "8cf3a2b1-0000-4000-8000-0000000000a2";
const VAULT_KEY = new Uint8Array(32).fill(0x17);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("agent wrap known-answer vectors", () => {
  it("KEK is reproducible from a fixed shared secret and salt", async () => {
    const sharedSecret = new Uint8Array(32).fill(0x5a);
    const wrapSalt = new Uint8Array(32).fill(0x99);
    const kek = await deriveAgentKek(sharedSecret, wrapSalt, ACCOUNT_ID, AGENT_ID);
    expect(kek.byteLength).toBe(32);
    expect(hex(kek)).toMatchSnapshot();
  });

  it("KEK differs for another agent and another account (domain separation)", async () => {
    const sharedSecret = new Uint8Array(32).fill(0x5a);
    const wrapSalt = new Uint8Array(32).fill(0x99);
    const base = await deriveAgentKek(sharedSecret, wrapSalt, ACCOUNT_ID, AGENT_ID);
    const otherAgent = await deriveAgentKek(sharedSecret, wrapSalt, ACCOUNT_ID, OTHER_AGENT_ID);
    const otherAccount = await deriveAgentKek(sharedSecret, wrapSalt, OTHER_AGENT_ID, AGENT_ID);
    expect(hex(otherAgent)).not.toBe(hex(base));
    expect(hex(otherAccount)).not.toBe(hex(base));
  });

  it("wrap AAD is reproducible and versioned", () => {
    expect(hex(agentVaultKeyAad(1, 1, ACCOUNT_ID, AGENT_ID))).toMatchSnapshot();
  });

  it("canary key is reproducible from the VaultKey and agentId", async () => {
    const key = await deriveAgentCanaryKey(VAULT_KEY, AGENT_ID);
    expect(key.byteLength).toBe(32);
    expect(hex(key)).toMatchSnapshot();
    const other = await deriveAgentCanaryKey(VAULT_KEY, OTHER_AGENT_ID);
    expect(hex(other)).not.toBe(hex(key));
  });

  it("public key fingerprint is SHA-256 of the raw point", async () => {
    const publicKey = new Uint8Array(65);
    publicKey[0] = 0x04;
    publicKey.fill(0x11, 1, 33);
    publicKey.fill(0x22, 33, 65);
    const fingerprint = await agentPublicKeyFingerprint(publicKey);
    expect(hex(fingerprint)).toBe(hex(await sha256(publicKey)));
    expect(hex(fingerprint)).toMatchSnapshot();
    expect(formatAgentFingerprint(fingerprint)).toBe(
      hex(fingerprint).match(/.{1,8}/g)?.join(" "),
    );
  });

  it("rejects malformed public keys", () => {
    expect(() => agentPublicKeyFingerprint(new Uint8Array(64))).toThrow(RangeError);
    const wrongPrefix = new Uint8Array(65).fill(0x02);
    expect(() => agentPublicKeyFingerprint(wrongPrefix)).toThrow(RangeError);
  });
});

describe("agent wrap round-trip (browser side <-> MCP side)", () => {
  it("unwraps to the original VaultKey with the agent private key", async () => {
    const agent = await generateAgentKeyPair();
    const agentPublicKey = await exportAgentPublicKey(agent.publicKey);
    const wrap = await wrapVaultKeyForAgent({
      vaultKey: VAULT_KEY,
      agentPublicKey,
      accountId: ACCOUNT_ID,
      agentId: AGENT_ID,
    });
    expect(wrap.ephemeralPublicKey.byteLength).toBe(65);
    expect(wrap.wrapSalt.byteLength).toBe(32);
    expect(wrap.nonce.byteLength).toBe(12);
    expect(wrap.wrappedKey.byteLength).toBe(48);

    const vaultKey = await unwrapVaultKeyForAgent({
      privateKey: agent.privateKey,
      wrap,
      accountId: ACCOUNT_ID,
      agentId: AGENT_ID,
    });
    expect(hex(vaultKey)).toBe(hex(VAULT_KEY));
  });

  it("fails with a different agent private key", async () => {
    const agent = await generateAgentKeyPair();
    const stranger = await generateAgentKeyPair();
    const wrap = await wrapVaultKeyForAgent({
      vaultKey: VAULT_KEY,
      agentPublicKey: await exportAgentPublicKey(agent.publicKey),
      accountId: ACCOUNT_ID,
      agentId: AGENT_ID,
    });
    await expect(
      unwrapVaultKeyForAgent({
        privateKey: stranger.privateKey,
        wrap,
        accountId: ACCOUNT_ID,
        agentId: AGENT_ID,
      }),
    ).rejects.toThrow();
  });
});

describe("agent wrap tamper detection", () => {
  async function freshWrap() {
    const agent = await generateAgentKeyPair();
    const wrap = await wrapVaultKeyForAgent({
      vaultKey: VAULT_KEY,
      agentPublicKey: await exportAgentPublicKey(agent.publicKey),
      accountId: ACCOUNT_ID,
      agentId: AGENT_ID,
    });
    return { agent, wrap };
  }

  function flip(bytes: Uint8Array): Uint8Array {
    const out = bytes.slice();
    out[0] = (out[0] as number) ^ 0xff;
    return out;
  }

  it("rejects a tampered wrapped key, nonce, salt or ephemeral key", async () => {
    const { agent, wrap } = await freshWrap();
    const variants = [
      { ...wrap, wrappedKey: flip(wrap.wrappedKey) },
      { ...wrap, nonce: flip(wrap.nonce) },
      { ...wrap, wrapSalt: flip(wrap.wrapSalt) },
      { ...wrap, ephemeralPublicKey: flip(wrap.ephemeralPublicKey) },
    ];
    for (const variant of variants) {
      await expect(
        unwrapVaultKeyForAgent({
          privateKey: agent.privateKey,
          wrap: variant,
          accountId: ACCOUNT_ID,
          agentId: AGENT_ID,
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects a wrap presented under another agentId or accountId (AAD binding)", async () => {
    const { agent, wrap } = await freshWrap();
    await expect(
      unwrapVaultKeyForAgent({
        privateKey: agent.privateKey,
        wrap,
        accountId: ACCOUNT_ID,
        agentId: OTHER_AGENT_ID,
      }),
    ).rejects.toThrow();
    await expect(
      unwrapVaultKeyForAgent({
        privateKey: agent.privateKey,
        wrap,
        accountId: OTHER_AGENT_ID,
        agentId: AGENT_ID,
      }),
    ).rejects.toThrow();
  });
});

describe("agent canary", () => {
  it("round-trips and its hash matches the returned plaintext", async () => {
    const canary = await createAgentCanary(VAULT_KEY, AGENT_ID);
    expect(canary.plaintext.byteLength).toBe(16);
    expect(canary.nonce.byteLength).toBe(12);
    expect(hex(await sha256(canary.plaintext))).toBe(hex(canary.plaintextHash));
    const recovered = await decryptAgentCanary(VAULT_KEY, AGENT_ID, canary.nonce, canary.ciphertext);
    expect(hex(recovered)).toBe(hex(canary.plaintext));
    // The wire form used by the canary submission is stable base64url.
    expect(toBase64Url(recovered)).toBe(toBase64Url(canary.plaintext));
  });

  it("rejects a tampered canary ciphertext", async () => {
    const canary = await createAgentCanary(VAULT_KEY, AGENT_ID);
    const tampered = canary.ciphertext.slice();
    tampered[0] = (tampered[0] as number) ^ 0xff;
    await expect(decryptAgentCanary(VAULT_KEY, AGENT_ID, canary.nonce, tampered)).rejects.toThrow();
  });
});
