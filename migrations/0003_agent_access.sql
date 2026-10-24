-- Agent access (agent design §6.1): per-agent VaultKey wraps and tokens.
-- Times are UTC Unix milliseconds. IDs are UUIDs (text). Binary fields are BLOBs.
-- The server stores only wrapped keys, public keys, token hashes and canary
-- ciphertext — never a VaultKey, a private key, or plaintext (spec §6.5).

CREATE TABLE agent_keys (
  agent_id               TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  display_name           TEXT NOT NULL DEFAULT '',
  public_key             BLOB,
  public_key_fingerprint BLOB,
  state                  TEXT NOT NULL CHECK (state IN ('pending','active','revoked')) DEFAULT 'pending',
  format_version         INTEGER,
  key_version            INTEGER,
  ephemeral_public_key   BLOB,
  wrap_salt              BLOB,
  wrap_nonce             BLOB,
  wrapped_key            BLOB,
  canary_nonce           BLOB,
  canary_ciphertext      BLOB,
  canary_hash            BLOB,
  -- Enrollment pairing code: only the SHA-256 hash is stored. It authorizes
  -- the public-key submission and the canary submission for this one
  -- enrollment and is cleared on activation or revocation (design §4.3).
  enrollment_hash32      BLOB,
  enrollment_expires_at  INTEGER,
  created_at             INTEGER NOT NULL,
  activated_at           INTEGER,
  revoked_at             INTEGER,
  last_used_at           INTEGER
);
CREATE INDEX idx_agent_keys_account ON agent_keys(account_id, state);

CREATE TABLE agent_tokens (
  token_id    TEXT PRIMARY KEY,
  token_hash  BLOB NOT NULL UNIQUE,
  agent_id    TEXT NOT NULL REFERENCES agent_keys(agent_id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scopes      TEXT NOT NULL CHECK (scopes IN ('agent:read')),
  auth_epoch  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX idx_agent_tokens_agent ON agent_tokens(agent_id, revoked_at);
CREATE INDEX idx_agent_tokens_account ON agent_tokens(account_id, revoked_at);
