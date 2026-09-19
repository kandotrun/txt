/**
 * Worker environment bindings and shared types (spec §14).
 */

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  WEBAUTHN_RP_ID: string;
  WEBAUTHN_RP_NAME: string;
  REGISTRATION_MODE: string;
  ACCOUNT_LIMIT_BYTES: string;
  MEDIA_GRACE_MS: string;
  TxtTeamId?: string;
  TxtIosBundleId?: string;
  TxtMacosBundleId?: string;
}

export type ClientKind = "web" | "native";

export interface SessionRow {
  token_hash32: ArrayBuffer;
  sid: string;
  account_id: string;
  client_kind: string;
  scope: "pending" | "active" | "recovery";
  auth_epoch: number;
  created_at: number;
  absolute_expires_at: number;
  idle_expires_at: number;
  stepup_at: number | null;
  revoked_at: number | null;
}
