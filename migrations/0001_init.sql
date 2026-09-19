-- txt.2-38.com schema (spec §12.1)
-- Times are UTC Unix milliseconds. IDs are UUIDs (text). Binary fields are BLOBs.
-- Note: media bytes are never stored in D1.

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  user_handle   BLOB NOT NULL UNIQUE,
  display_label TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','active','deleting')) DEFAULT 'pending',
  auth_epoch    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  activated_at  INTEGER
);

CREATE TABLE credentials (
  credential_id   TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key      BLOB NOT NULL,
  counter         INTEGER NOT NULL DEFAULT 0,
  transports      TEXT NOT NULL DEFAULT '[]',
  backup_eligible INTEGER NOT NULL DEFAULT 0,
  backup_state    INTEGER NOT NULL DEFAULT 0,
  device_type     TEXT NOT NULL DEFAULT 'singleDevice',
  status          TEXT NOT NULL CHECK (status IN ('pending','active','revoked')) DEFAULT 'pending',
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  UNIQUE (credential_id, account_id)
);
CREATE INDEX idx_credentials_account ON credentials(account_id, status);

CREATE TABLE key_envelopes (
  credential_id  TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  key_version    INTEGER NOT NULL,
  wrap_salt32    BLOB NOT NULL,
  nonce          BLOB NOT NULL,
  wrapped_key    BLOB NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (credential_id, key_version),
  FOREIGN KEY (credential_id, account_id) REFERENCES credentials(credential_id, account_id) ON DELETE CASCADE
);

CREATE TABLE recovery (
  account_id       TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  recovery_version INTEGER NOT NULL,
  key_version      INTEGER NOT NULL,
  auth_hash32      BLOB NOT NULL,
  nonce            BLOB NOT NULL,
  wrapped_key      BLOB NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE challenges (
  id               TEXT PRIMARY KEY,
  challenge_hash32 BLOB NOT NULL,
  purpose          TEXT NOT NULL CHECK (purpose IN
    ('register','login','stepup','credential-add','credential-activate','recovery-add')),
  account_id       TEXT,
  credential_id    TEXT,
  client_kind      TEXT NOT NULL,
  binding_hash32   BLOB NOT NULL,
  context          TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  consumed_at      INTEGER
);
CREATE INDEX idx_challenges_expiry ON challenges(expires_at);

CREATE TABLE sessions (
  token_hash32        BLOB PRIMARY KEY,
  sid                 TEXT NOT NULL UNIQUE,
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_kind         TEXT NOT NULL,
  scope               TEXT NOT NULL CHECK (scope IN ('pending','active','recovery')),
  auth_epoch          INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  idle_expires_at     INTEGER NOT NULL,
  stepup_at           INTEGER,
  revoked_at          INTEGER
);
CREATE INDEX idx_sessions_account ON sessions(account_id, revoked_at);

CREATE TABLE documents (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  sync_epoch         INTEGER NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 0,
  encrypted_revision INTEGER NOT NULL DEFAULT 0,
  format_version     INTEGER NOT NULL,
  key_version        INTEGER NOT NULL,
  mutation_id        TEXT NOT NULL,
  nonce              BLOB NOT NULL,
  ciphertext         BLOB NOT NULL,
  last_payload_hash32 BLOB NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE media (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_upload_id TEXT NOT NULL,
  object_key      TEXT NOT NULL UNIQUE,
  cipher_bytes    INTEGER NOT NULL,
  crypto_format   INTEGER NOT NULL,
  chunk_bytes     INTEGER NOT NULL,
  state           TEXT NOT NULL CHECK (state IN
    ('creating','uploading','completing','ready','deleting')) DEFAULT 'creating',
  upload_id       TEXT,
  lease_owner     TEXT,
  lease_expires_at INTEGER,
  expires_at      INTEGER,
  unreferenced_at INTEGER,
  ready_at        INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (document_id, client_upload_id),
  UNIQUE (document_id, id)
);
CREATE INDEX idx_media_cleanup ON media(state, expires_at);
CREATE INDEX idx_media_unreferenced ON media(state, unreferenced_at);

CREATE TABLE document_media (
  document_id TEXT NOT NULL,
  media_id    TEXT NOT NULL,
  PRIMARY KEY (document_id, media_id),
  FOREIGN KEY (document_id, media_id) REFERENCES media(document_id, id) ON DELETE CASCADE
);

CREATE TABLE upload_parts (
  media_id         TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  part_number      INTEGER NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('reserved','uploading','accepted')),
  hash32           BLOB,
  bytes            INTEGER,
  etag             TEXT,
  lease_owner      TEXT,
  lease_expires_at INTEGER,
  accepted_at      INTEGER,
  PRIMARY KEY (media_id, part_number)
);

CREATE TABLE operations (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('bootstrap','recovery','delete-account')),
  account_id     TEXT NOT NULL,
  payload_hash32 BLOB NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('pending','completed','failed')),
  result         TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  expires_at     INTEGER
);
CREATE INDEX idx_operations_account ON operations(account_id, kind);

CREATE TABLE storage_usage (
  account_id     TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  used_bytes     INTEGER NOT NULL DEFAULT 0,
  reserved_bytes INTEGER NOT NULL DEFAULT 0,
  limit_bytes    INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
