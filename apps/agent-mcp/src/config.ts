/**
 * Local state and secret storage for the agent bridge.
 *
 * Phase 1 stores secrets in files with owner-only permissions (directory
 * 0700, files 0600) behind the `SecretStore` abstraction, so the storage
 * backend can move to the macOS Keychain (design §8.2) without touching
 * callers. Plaintext, the VaultKey and tokens are never written to logs.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface SecretStore {
  read(name: string): string | null;
  write(name: string, value: string): void;
}

/** File-backed secret store (phase 1). Files are created 0600 in a 0700 dir. */
export class FileSecretStore implements SecretStore {
  constructor(private readonly dir: string) {}

  private fileFor(name: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`invalid store name: ${name}`);
    return path.join(this.dir, name);
  }

  read(name: string): string | null {
    const file = this.fileFor(name);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  }

  write(name: string, value: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const file = this.fileFor(name);
    writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
    chmodSync(file, 0o600);
  }
}

/**
 * macOS Keychain storage (design §8.2 target). Not implemented in phase 1;
 * selecting it fails loudly instead of silently falling back to files.
 */
export class KeychainSecretStore implements SecretStore {
  read(): string | null {
    throw new Error("Keychain storage is not implemented in phase 1 (see README)");
  }
  write(): void {
    throw new Error("Keychain storage is not implemented in phase 1 (see README)");
  }
}

export interface AgentConfig {
  /** Worker base URL, e.g. https://txt.2-38.com */
  apiBase: string;
  agentId: string | null;
  displayName: string | null;
}

export interface StoredKeyPair {
  /** JWK of the P-256 private key (secret; lives only in the SecretStore). */
  privateKeyJwk: JsonWebKey;
  /** Raw uncompressed public key point, base64url. */
  publicKey: string;
}

export interface StoredToken {
  token: string;
  tokenId: string;
  expiresAt: number;
}

export function stateDir(): string {
  return process.env.TXT_AGENT_HOME ?? path.join(homedir(), ".config", "txt-agent");
}

export function createSecretStore(): SecretStore {
  if ((process.env.TXT_AGENT_SECRET_STORE ?? "file") === "keychain") {
    return new KeychainSecretStore();
  }
  return new FileSecretStore(stateDir());
}

export class AgentState {
  readonly secrets: SecretStore;

  constructor(secrets: SecretStore = createSecretStore()) {
    this.secrets = secrets;
  }

  loadConfig(): AgentConfig {
    const raw = this.secrets.read("config.json");
    const parsed = raw ? (JSON.parse(raw) as Partial<AgentConfig>) : {};
    return {
      apiBase: (process.env.TXT_AGENT_API_BASE ?? parsed.apiBase ?? "https://txt.2-38.com").replace(
        /\/$/,
        "",
      ),
      agentId: parsed.agentId ?? null,
      displayName: parsed.displayName ?? null,
    };
  }

  saveConfig(config: AgentConfig): void {
    this.secrets.write(
      "config.json",
      JSON.stringify(
        { apiBase: config.apiBase, agentId: config.agentId, displayName: config.displayName },
        null,
        2,
      ),
    );
  }

  loadKeyPair(): StoredKeyPair | null {
    const raw = this.secrets.read("keypair.json");
    return raw ? (JSON.parse(raw) as StoredKeyPair) : null;
  }

  saveKeyPair(keyPair: StoredKeyPair): void {
    this.secrets.write("keypair.json", JSON.stringify(keyPair));
  }

  loadToken(): StoredToken | null {
    const raw = this.secrets.read("token.json");
    return raw ? (JSON.parse(raw) as StoredToken) : null;
  }

  saveToken(token: StoredToken): void {
    this.secrets.write("token.json", JSON.stringify(token));
  }

  /** Append-only audit log (design §8.5). Metadata only — never content. */
  audit(entry: Record<string, unknown>): void {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "audit.log");
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
    writeFileSync(file, line, { encoding: "utf8", flag: "a", mode: 0o600 });
    chmodSync(file, 0o600);
  }
}
