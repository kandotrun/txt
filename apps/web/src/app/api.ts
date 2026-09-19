/**
 * API client (spec §12.2).
 *
 * Web uses relative URLs; cookie auth is automatic. Every state-changing
 * request carries `X-Txt-Request: 1` (the CSRF marker, spec §5.4). Error bodies
 * follow `{"error":{"code","message"}}`.
 */

export interface ApiErrorBody {
  code: string;
  message: string;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }

  get isAuthFailure(): boolean {
    return this.status === 401;
  }

  get isPrecondition(): boolean {
    return this.status === 412;
  }

  get isUnprocessable(): boolean {
    return this.status === 422;
  }
}

export interface DocumentResponse {
  accountId: string;
  documentId: string;
  syncEpoch: number;
  revision: number;
  encryptedRevision: number;
  formatVersion: number;
  keyVersion: number;
  mutationId: string;
  nonce: string;
  ciphertext: string;
  referencedMediaIds: string[];
  updatedAt: number;
}

export interface SessionInfo {
  accountId: string;
  displayLabel: string | null;
  accountStatus: string;
  userHandle: string | null;
  scope: "pending" | "active" | "recovery";
  clientKind: "web" | "native";
  via: "cookie" | "bearer";
  stepupAt: number | null;
  expiresAt: number;
  idleExpiresAt: number;
}

export interface KeyEnvelope {
  credentialId: string;
  formatVersion: number;
  keyVersion: number;
  wrapSalt32: string;
  nonce: string;
  wrappedKey: string;
}

export interface RecoveryRecord {
  recoveryVersion: number;
  keyVersion: number;
  nonce: string;
  wrappedKey: string;
}

class ApiClient {
  private async request<T>(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      headers.set("x-txt-request", "1");
    }

    const response = await fetch(path, {
      ...init,
      method,
      headers,
      body,
      credentials: "same-origin",
    });

    if (response.status === 304) return undefined as T;

    if (!response.ok) {
      let code = "HTTP_ERROR";
      let message = `request failed (${response.status})`;
      try {
        const parsed = (await response.json()) as { error?: ApiErrorBody };
        if (parsed?.error) {
          code = parsed.error.code;
          message = parsed.error.message;
        }
      } catch {
        // Non-JSON error bodies are surfaced with the generic message.
      }
      throw new ApiRequestError(response.status, code, message);
    }

    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new ApiRequestError(response.status, "UNEXPECTED_CONTENT_TYPE", "unexpected response type");
    }
    return (await response.json()) as T;
  }

  /* auth */
  registerOptions() {
    return this.request<{ accountId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
      "/api/v1/auth/register/options",
      { method: "POST", json: {} },
    );
  }

  registerVerify(response: unknown) {
    return this.request<{ accountId: string; credentialId: string; scope: string }>(
      "/api/v1/auth/register/verify",
      { method: "POST", json: { response } },
    );
  }

  loginOptions() {
    return this.request<{ options: PublicKeyCredentialRequestOptionsJSON }>(
      "/api/v1/auth/login/options",
      { method: "POST", json: {} },
    );
  }

  loginVerify(response: unknown) {
    return this.request<{ accountId: string; credentialId: string; scope: string }>(
      "/api/v1/auth/login/verify",
      { method: "POST", json: { response } },
    );
  }

  stepupOptions(credentialId?: string) {
    return this.request<{ options: PublicKeyCredentialRequestOptionsJSON }>(
      "/api/v1/auth/stepup/options",
      { method: "POST", json: credentialId ? { credentialId } : {} },
    );
  }

  stepupVerify(response: unknown) {
    return this.request<{ ok: boolean; stepupAt: number; credentialId: string }>(
      "/api/v1/auth/stepup/verify",
      { method: "POST", json: { response } },
    );
  }

  session() {
    return this.request<SessionInfo>("/api/v1/session");
  }

  endSession() {
    return this.request<{ ok: boolean }>("/api/v1/session", { method: "DELETE" });
  }

  /* identity */
  bootstrap(payload: Record<string, unknown>) {
    return this.request<{ ok: boolean; bootstrapId: string; documentId: string }>(
      "/api/v1/bootstrap",
      { method: "POST", json: payload },
    );
  }

  keys(credentialId?: string) {
    const query = credentialId ? `?credentialId=${encodeURIComponent(credentialId)}` : "";
    return this.request<{ envelopes: KeyEnvelope[]; recovery: RecoveryRecord | null }>(
      `/api/v1/keys${query}`,
    );
  }

  credentials() {
    return this.request<{
      credentials: Array<{
        credentialId: string;
        deviceType: string;
        backedUp: boolean;
        status: string;
        createdAt: number;
        lastUsedAt: number | null;
      }>;
    }>("/api/v1/credentials");
  }

  credentialAddOptions(userHandle: string) {
    return this.request<{ options: PublicKeyCredentialCreationOptionsJSON }>(
      "/api/v1/credentials/options",
      { method: "POST", json: { userHandle } },
    );
  }

  credentialAddVerify(response: unknown) {
    return this.request<{ credentialId: string; status: string }>(
      "/api/v1/credentials/verify",
      { method: "POST", json: { response } },
    );
  }

  credentialActivate(payload: Record<string, unknown>) {
    return this.request<{ ok: boolean; credentialId: string; status: string }>(
      "/api/v1/credentials/activate",
      { method: "POST", json: payload },
    );
  }

  revokeCredential(credentialId: string) {
    return this.request<{ ok: boolean }>(
      `/api/v1/credentials/${encodeURIComponent(credentialId)}`,
      { method: "DELETE" },
    );
  }

  recoveryStart(accountId: string, recoveryAuth: string) {
    return this.request<{ scope: string; recoveryVersion: number; keyVersion: number }>(
      "/api/v1/recovery/start",
      { method: "POST", json: { accountId, recoveryAuth } },
    );
  }

  recoveryComplete(payload: Record<string, unknown>) {
    return this.request<{ ok: boolean; operationId: string; credentialId: string }>(
      "/api/v1/recovery/complete",
      { method: "POST", json: payload },
    );
  }

  rotateRecovery(payload: Record<string, unknown>) {
    return this.request<{ ok: boolean; recoveryVersion: number }>("/api/v1/recovery", {
      method: "PUT",
      json: payload,
    });
  }

  /* document */
  async document(etag?: string): Promise<{ data?: DocumentResponse; etag?: string; notModified: boolean }> {
    const headers = new Headers();
    if (etag) headers.set("if-none-match", etag);
    const response = await fetch("/api/v1/document", {
      headers,
      credentials: "same-origin",
    });
    if (response.status === 304) {
      return { notModified: true, etag: etag ?? undefined };
    }
    if (!response.ok) {
      let code = "HTTP_ERROR";
      let message = `request failed (${response.status})`;
      try {
        const parsed = (await response.json()) as { error?: ApiErrorBody };
        if (parsed?.error) {
          code = parsed.error.code;
          message = parsed.error.message;
        }
      } catch {
        // ignore
      }
      throw new ApiRequestError(response.status, code, message);
    }
    const data = (await response.json()) as DocumentResponse;
    return { data, etag: response.headers.get("etag") ?? undefined, notModified: false };
  }

  putDocument(payload: Record<string, unknown>, etag: string) {
    return this.request<{ etag: string; revision: number; mutationId: string; updatedAt: number }>(
      "/api/v1/document",
      { method: "PUT", json: payload, headers: { "if-match": etag } },
    );
  }

  /* media */
  startUpload(payload: Record<string, unknown>) {
    return this.request<{
      mediaId: string;
      state: string;
      partCount: number;
      partBytes: number;
      cipherBytes: number;
      replayed: boolean;
    }>("/api/v1/media/uploads", { method: "POST", json: payload });
  }

  uploadStatus(mediaId: string) {
    return this.request<{
      mediaId: string;
      state: string;
      cipherBytes: number;
      partCount: number;
      acceptedParts: Array<{ partNumber: number; bytes: number }>;
    }>(`/api/v1/media/uploads/${encodeURIComponent(mediaId)}`);
  }

  async uploadPart(mediaId: string, partNumber: number, bytes: Uint8Array): Promise<void> {
    const response = await fetch(
      `/api/v1/media/uploads/${encodeURIComponent(mediaId)}/parts/${partNumber}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-txt-request": "1",
        },
        body: bytes as unknown as BodyInit,
        credentials: "same-origin",
      },
    );
    if (!response.ok) {
      let code = "UPLOAD_FAILED";
      let message = `part upload failed (${response.status})`;
      try {
        const parsed = (await response.json()) as { error?: ApiErrorBody };
        if (parsed?.error) {
          code = parsed.error.code;
          message = parsed.error.message;
        }
      } catch {
        // ignore
      }
      throw new ApiRequestError(response.status, code, message);
    }
  }

  completeUpload(mediaId: string) {
    return this.request<{ mediaId: string; state: string; cipherBytes: number }>(
      `/api/v1/media/uploads/${encodeURIComponent(mediaId)}/complete`,
      { method: "POST", json: {} },
    );
  }

  cancelUpload(mediaId: string) {
    return this.request<{ ok: boolean }>(
      `/api/v1/media/uploads/${encodeURIComponent(mediaId)}`,
      { method: "DELETE" },
    );
  }

  /* sessions & account */
  sessions() {
    return this.request<{
      sessions: Array<{
        sid: string;
        clientKind: string;
        scope: string;
        createdAt: number;
        expiresAt: number;
        idleExpiresAt: number;
        isCurrent: boolean;
      }>;
    }>("/api/v1/sessions");
  }

  revokeSession(sid: string) {
    return this.request<{ ok: boolean }>(`/api/v1/sessions/${encodeURIComponent(sid)}`, {
      method: "DELETE",
    });
  }

  deleteAccount(operationId: string) {
    return this.request<{ ok: boolean; operationId: string; state: string }>("/api/v1/account", {
      method: "DELETE",
      json: { confirm: "DELETE", operationId },
    });
  }
}

export const api = new ApiClient();

/* JSON-serializable WebAuthn option shapes (the browser API consumes the
 * base64url forms directly; the server sends JSON per spec §12.2). */
export interface PublicKeyCredentialCreationOptionsJSON {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: string; alg: number }>;
  excludeCredentials?: Array<{ id: string; type: string; transports?: string[] }>;
  authenticatorSelection?: Record<string, unknown>;
  attestation?: string;
  extensions?: Record<string, unknown>;
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  rpId: string;
  allowCredentials?: Array<{ id: string; type: string; transports?: string[] }>;
  userVerification?: string;
  extensions?: Record<string, unknown>;
}
