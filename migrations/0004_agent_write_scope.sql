-- Agent access phase 2 (agent design §5.3, §10 phase 2): allow the
-- `agent:write` scope on agent tokens. The phase 1 table fixed the CHECK
-- constraint to `scopes IN ('agent:read')`; SQLite cannot alter a CHECK
-- in place, so the table is rebuilt with the same columns and constraints
-- and the rows are carried over unchanged (token hashes, epochs, expiry
-- and revocation state all survive — existing read tokens stay valid).
--
-- Scope semantics: a token holds exactly one scope value. `agent:write`
-- INCLUDES `agent:read` (design §5.3); the authorization layer treats a
-- write token as satisfying a read requirement, never the reverse.

CREATE TABLE agent_tokens_new (
  token_id    TEXT PRIMARY KEY,
  token_hash  BLOB NOT NULL UNIQUE,
  agent_id    TEXT NOT NULL REFERENCES agent_keys(agent_id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scopes      TEXT NOT NULL CHECK (scopes IN ('agent:read', 'agent:write')),
  auth_epoch  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at  INTEGER
);

INSERT INTO agent_tokens_new
  (token_id, token_hash, agent_id, account_id, scopes, auth_epoch,
   expires_at, created_at, last_used_at, revoked_at)
SELECT token_id, token_hash, agent_id, account_id, scopes, auth_epoch,
       expires_at, created_at, last_used_at, revoked_at
  FROM agent_tokens;

DROP TABLE agent_tokens;
ALTER TABLE agent_tokens_new RENAME TO agent_tokens;

CREATE INDEX idx_agent_tokens_agent ON agent_tokens(agent_id, revoked_at);
CREATE INDEX idx_agent_tokens_account ON agent_tokens(account_id, revoked_at);
