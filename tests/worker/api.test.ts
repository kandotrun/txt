/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Worker integration tests against the real D1/R2 bindings (spec §17.3–17.5).
 *
 * These tests exercise the HTTP surface with a simulated WebAuthn credential
 * built from real ES256 keys, so signature verification actually runs.
 */

import { SELF, createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { encodeBase64Url } from "../../apps/worker/src/document/store.ts";
import worker from "../../apps/worker/src/index.ts";
import type { Env } from "../../apps/worker/src/types.ts";
import { cancelUpload, completeUpload, loadUpload } from "../../apps/worker/src/media/store.ts";

const BASE = "https://txt.2-38.com";

/* ------------------------------------------------------------------ */
/* WebAuthn test client (real ES256 signing)                           */
/* ------------------------------------------------------------------ */

interface TestCredential {
  credentialId: string;
  privateKey: CryptoKey;
  publicKeyCose: Uint8Array;
  signCount: number;
}

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  return encodeBase64Url(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

async function createCredential(): Promise<TestCredential> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer,
  );
  const credentialId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return {
    credentialId,
    privateKey: keyPair.privateKey,
    publicKeyCose: coseFromRaw(raw),
    signCount: 0,
  };
}

/** COSE_Key for ES256 from an uncompressed P-256 point. */
function coseFromRaw(raw: Uint8Array): Uint8Array {
  const x = raw.slice(1, 33);
  const y = raw.slice(33, 65);
  const parts: number[] = [];
  const encodeInt = (value: number): number[] => {
    if (value >= 0) return value < 24 ? [value] : [0x18, value];
    return [0x20 + (-value - 1)];
  };
  const encodeBytes = (input: Uint8Array): number[] => [
    input.byteLength < 24 ? 0x40 + input.byteLength : 0x58,
    ...(input.byteLength < 24 ? [] : [input.byteLength]),
    ...Array.from(input),
  ];
  parts.push(0xa5); // map(5)
  parts.push(...encodeInt(1), ...encodeInt(2)); // kty: EC2
  parts.push(...encodeInt(3), ...encodeInt(-7)); // alg: ES256
  parts.push(...encodeInt(-1), ...encodeInt(1)); // crv: P-256
  parts.push(...encodeInt(-2), ...encodeBytes(x));
  parts.push(...encodeInt(-3), ...encodeBytes(y));
  return new Uint8Array(parts);
}

async function clientDataJSON(challenge: string, type: string, origin = BASE): Promise<string> {
  return b64url(
    new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    ),
  );
}

function decodeBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeChallenge(clientData: string): string {
  const parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(clientData))) as {
    challenge: string;
  };
  return parsed.challenge;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Builds a registration response with a real signature over authData. */
async function registrationResponse(
  credential: TestCredential,
  options: { challenge: string; rpId: string; userHandle: Uint8Array },
): Promise<Record<string, unknown>> {
  const clientData = await clientDataJSON(options.challenge, "webauthn.create");
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(options.rpId)),
  );
  const flags = 0x45; // UP | UV | AT
  const signCount = new Uint8Array(4);
  const aaguid = new Uint8Array(16);
  const credentialIdBytes = decodeBase64Url(credential.credentialId);
  const credIdLength = new Uint8Array(2);
  new DataView(credIdLength.buffer).setUint16(0, credentialIdBytes.byteLength, false);
  const cose = credential.publicKeyCose;

  const authData = concatBytes(
    rpIdHash,
    new Uint8Array([flags]),
    signCount,
    aaguid,
    credIdLength,
    credentialIdBytes,
    cose,
  );
  const clientDataBytes = decodeBase64Url(clientData);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      credential.privateKey,
      concatBytes(authData, new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataBytes))),
    ),
  );

  return {
    id: credential.credentialId,
    rawId: credential.credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData,
      attestationObject: b64url(buildAttestationObject(authData)),
      transports: ["internal"],
    },
  };
}

/** CBOR map {fmt, attStmt, authData} for attestation "none". */
function buildAttestationObject(authData: Uint8Array): Uint8Array {
  const head: number[] = [0xa3]; // map(3)
  const text = (value: string): number[] => [
    0x60 + value.length,
    ...Array.from(new TextEncoder().encode(value)),
  ];
  head.push(...text("fmt"), ...text("none"));
  head.push(...text("attStmt"), 0xa0); // empty map
  head.push(...text("authData"));
  const len = authData.byteLength;
  if (len < 24) {
    head.push(0x40 + len);
  } else if (len < 256) {
    head.push(0x58, len);
  } else {
    head.push(0x59, len >> 8, len & 0xff);
  }
  return concatBytes(new Uint8Array(head), authData);
}

/** Converts a raw 64-byte ECDSA signature (r||s) to ASN.1 DER, matching what
 * real authenticators return. Web Crypto only produces the raw form. */
function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const encodeInteger = (value: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start++;
    let trimmed = value.slice(start);
    if ((trimmed[0] as number) & 0x80) {
      const padded = new Uint8Array(trimmed.length + 1);
      padded.set(trimmed, 1);
      trimmed = padded;
    }
    const out = new Uint8Array(trimmed.length + 2);
    out[0] = 0x02;
    out[1] = trimmed.length;
    out.set(trimmed, 2);
    return out;
  };
  const r = encodeInteger(raw.slice(0, 32));
  const s = encodeInteger(raw.slice(32, 64));
  const out = new Uint8Array(r.length + s.length + 2);
  out[0] = 0x30;
  out[1] = r.length + s.length;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}

/**
 * Builds an assertion response with a real signature over authData.
 *
 * In getAssertion, authData is `rpIdHash || flags || signCount` (+extensions).
 * The userHandle is returned in `response.userHandle`, never appended to
 * authData — setting the AT flag here would make parsers read it as attested
 * credential data.
 */
async function assertionResponse(
  credential: TestCredential,
  options: { challenge: string; rpId: string; userHandle?: Uint8Array },
): Promise<Record<string, unknown>> {
  const clientData = await clientDataJSON(options.challenge, "webauthn.get");
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(options.rpId)),
  );
  const flags = 0x05; // UP | UV
  credential.signCount += 1;
  const signCount = new Uint8Array(4);
  new DataView(signCount.buffer).setUint32(0, credential.signCount, false);
  const authData = concatBytes(rpIdHash, new Uint8Array([flags]), signCount);
  const clientDataBytes = decodeBase64Url(clientData);
  const rawSignature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      credential.privateKey,
      concatBytes(authData, new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataBytes))),
    ),
  );
  return {
    id: credential.credentialId,
    rawId: credential.credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData,
      authenticatorData: b64url(authData),
      signature: b64url(rawSignatureToDer(rawSignature)),
      userHandle: options.userHandle ? b64url(options.userHandle) : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  // crypto.getRandomValues caps at 64KiB per call.
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + 65536, length)));
  }
  return out;
}

const webHeaders = {
  origin: BASE,
  "x-txt-request": "1",
  "content-type": "application/json",
};

async function postJson(path: string, body: unknown, headers: Record<string, string> = webHeaders, cookie?: string) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: cookie ? { ...headers, cookie } : headers,
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string | undefined {
  const header = response.headers.get("set-cookie");
  if (!header) return undefined;
  return header.split(";")[0];
}

interface RegisteredAccount {
  accountId: string;
  credential: TestCredential;
  userHandle: Uint8Array;
  cookie: string;
}

let registrationSequence = 0;

/** Runs register/options + register/verify and returns the pending session. */
async function registerAccount(clientHeaders: Record<string, string> = webHeaders): Promise<RegisteredAccount> {
  // 各テストの合成クライアントを分離し、実運用の登録制限は変更しない。
  const registrationHeaders = {
    ...clientHeaders,
    "cf-connecting-ip": `2001:db8::${(++registrationSequence).toString(16)}`,
  };
  const optionsResponse = await postJson("/api/v1/auth/register/options", {}, registrationHeaders);
  expect(optionsResponse.status).toBe(200);
  const optionsBody = (await optionsResponse.json()) as {
    accountId: string;
    options: { challenge: string; user: { id: string } };
  };

  const credential = await createCredential();
  const userHandle = decodeBase64Url(optionsBody.options.user.id);
  const response = await registrationResponse(credential, {
    challenge: optionsBody.options.challenge,
    rpId: "txt.2-38.com",
    userHandle,
  });

  const verifyResponse = await postJson("/api/v1/auth/register/verify", { response }, registrationHeaders);
  expect(verifyResponse.status).toBe(200);
  expect(await verifyResponse.json()).not.toHaveProperty("token");
  const cookie = cookieFrom(verifyResponse);
  expect(cookie).toBeTruthy();
  return {
    accountId: optionsBody.accountId,
    credential,
    userHandle,
    cookie: cookie as string,
  };
}

/** Completes bootstrap with an encrypted empty document. */
async function bootstrapAccount(account: RegisteredAccount): Promise<string> {
  const documentId = crypto.randomUUID();
  const response = await postJson(
    "/api/v1/bootstrap",
    {
      bootstrapId: crypto.randomUUID(),
      credentialId: account.credential.credentialId,
      envelope: {
        formatVersion: 1,
        keyVersion: 1,
        wrapSalt32: b64url(crypto.getRandomValues(new Uint8Array(32))),
        nonce: b64url(crypto.getRandomValues(new Uint8Array(12))),
        wrappedKey: b64url(crypto.getRandomValues(new Uint8Array(48))),
      },
      recovery: {
        recoveryVersion: 1,
        keyVersion: 1,
        authHash32: b64url(crypto.getRandomValues(new Uint8Array(32))),
        nonce: b64url(crypto.getRandomValues(new Uint8Array(12))),
        wrappedKey: b64url(crypto.getRandomValues(new Uint8Array(48))),
      },
      document: {
        documentId,
        formatVersion: 1,
        keyVersion: 1,
        nonce: b64url(crypto.getRandomValues(new Uint8Array(12))),
        ciphertext: b64url(crypto.getRandomValues(new Uint8Array(64))),
      },
    },
    webHeaders,
    account.cookie,
  );
  expect(response.status).toBe(201);
  return documentId;
}

function documentPutBody(overrides: Record<string, unknown> = {}) {
  return {
    mutationId: crypto.randomUUID(),
    formatVersion: 1,
    keyVersion: 1,
    encryptedRevision: 1,
    nonce: b64url(crypto.getRandomValues(new Uint8Array(12))),
    ciphertext: b64url(crypto.getRandomValues(new Uint8Array(96))),
    referencedMediaIds: [],
    ...overrides,
  };
}

async function putDocument(
  account: RegisteredAccount,
  etag: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return SELF.fetch(`${BASE}/api/v1/document`, {
    method: "PUT",
    headers: { ...webHeaders, "if-match": etag, cookie: account.cookie },
    body: JSON.stringify(body),
  });
}

async function getDocument(account: RegisteredAccount, etag?: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/v1/document`, {
    headers: etag ? { cookie: account.cookie, "if-none-match": etag } : { cookie: account.cookie },
  });
}

const TEST_ENV = env as unknown as {
  DB: D1Database;
  MEDIA: R2Bucket;
};

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("host policy", () => {
  it("serves the health probe on the canonical host", async () => {
    const response = await SELF.fetch(`${BASE}/api/v1/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rpId: string };
    expect(body.rpId).toBe("txt.2-38.com");
  });

  it("does not serve workers.dev or other hosts", async () => {
    const response = await SELF.fetch("https://txt.example.workers.dev/api/v1/health");
    expect(response.status).toBe(404);
    const other = await SELF.fetch("https://evil.example/api/v1/health");
    expect(other.status).toBe(404);
  });

  it("rejects API bodies with an unexpected content type", async () => {
    const response = await SELF.fetch(`${BASE}/api/v1/auth/register/options`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "text/plain" },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });
});

describe("registration and bootstrap", () => {
  let account: RegisteredAccount;
  beforeEach(async () => {
    account = await registerAccount();
  });

  it("registers a passkey and issues a pending session", async () => {
    const session = await SELF.fetch(`${BASE}/api/v1/session`, {
      headers: { cookie: account.cookie },
    });
    expect(session.status).toBe(200);
    const body = (await session.json()) as { scope: string; accountId: string };
    expect(body.scope).toBe("pending");
    expect(body.accountId).toBe(account.accountId);
  });

  it("denies the document API before bootstrap", async () => {
    const response = await getDocument(account);
    expect(response.status).toBe(400);
  });

  it("activates the account atomically via bootstrap", async () => {
    const documentId = await bootstrapAccount(account);
    const response = await getDocument(account);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { documentId: string; revision: number; syncEpoch: number };
    expect(body.documentId).toBe(documentId);
    expect(body.revision).toBe(0);
    expect(body.syncEpoch).toBe(1);

    const accountRow = await TEST_ENV.DB.prepare(
      `SELECT status, auth_epoch FROM accounts WHERE id = ?1`,
    )
      .bind(account.accountId)
      .first<{ status: string; auth_epoch: number }>();
    expect(accountRow?.status).toBe("active");
    expect(accountRow?.auth_epoch).toBe(0);
  });

  it("rejects a bootstrap replay with a different payload", async () => {
    const bootstrapId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const base = {
      bootstrapId,
      credentialId: account.credential.credentialId,
      envelope: {
        formatVersion: 1,
        keyVersion: 1,
        wrapSalt32: b64url(crypto.getRandomValues(new Uint8Array(32))),
        nonce: b64url(crypto.getRandomValues(new Uint8Array(12))),
        wrappedKey: b64url(crypto.getRandomValues(new Uint8Array(48))),
      },
      recovery: {
        recoveryVersion: 1,
        keyVersion: 1,
        authHash32: b64url(crypto.getRandomValues(new Uint8Array(32))),
        nonce: b64url(crypto.getRandomValues(new Uint8Array(12))),
        wrappedKey: b64url(crypto.getRandomValues(new Uint8Array(48))),
      },
      document: {
        documentId,
        formatVersion: 1,
        keyVersion: 1,
        nonce: b64url(crypto.getRandomValues(new Uint8Array(12))),
        ciphertext: b64url(crypto.getRandomValues(new Uint8Array(64))),
      },
    };
    const first = await postJson("/api/v1/bootstrap", base, webHeaders, account.cookie);
    expect(first.status).toBe(201);

    const conflicting = structuredClone(base);
    (conflicting.document as { ciphertext: string }).ciphertext = b64url(
      crypto.getRandomValues(new Uint8Array(64)),
    );
    const second = await postJson("/api/v1/bootstrap", conflicting, webHeaders, account.cookie);
    expect(second.status).toBe(409);

    const replayed = await postJson("/api/v1/bootstrap", base, webHeaders, account.cookie);
    expect([200, 201]).toContain(replayed.status);
  });
});

describe("CSRF and origin policy", () => {
  it("rejects a cookie write from a foreign origin", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);
    const response = await SELF.fetch(`${BASE}/api/v1/document`, {
      method: "PUT",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
        "x-txt-request": "1",
        cookie: account.cookie,
      },
      body: JSON.stringify(documentPutBody()),
    });
    expect([403, 401]).toContain(response.status);
  });

  it("rejects a cookie write without the request marker", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);
    const response = await SELF.fetch(`${BASE}/api/v1/document`, {
      method: "PUT",
      headers: {
        origin: BASE,
        "content-type": "application/json",
        cookie: account.cookie,
      },
      body: JSON.stringify(documentPutBody()),
    });
    expect(response.status).toBe(403);
  });

  it("ignores an X-Client header as a CSRF bypass", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);
    const response = await SELF.fetch(`${BASE}/api/v1/document`, {
      method: "PUT",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
        "x-client": "native",
        cookie: account.cookie,
      },
      body: JSON.stringify(documentPutBody()),
    });
    expect(response.status).not.toBe(200);
  });
});

describe("document CAS and idempotency", () => {
  let account: RegisteredAccount;
  let etag: string;

  beforeEach(async () => {
    account = await registerAccount();
    await bootstrapAccount(account);
    const response = await getDocument(account);
    etag = response.headers.get("etag") as string;
  });

  it("returns 304 when nothing changed", async () => {
    const response = await getDocument(account, etag);
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });

  it("saves conditionally and returns the new ETag only", async () => {
    const response = await putDocument(account, etag, documentPutBody());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { etag: string; revision: number };
    expect(body.revision).toBe(1);
    expect(body.etag).toMatch(/^"d-[0-9a-f-]+-e-1-r1"$/);

    const reload = await getDocument(account, etag);
    expect(reload.status).toBe(200);
    const fresh = (await reload.json()) as { revision: number };
    expect(fresh.revision).toBe(1);
  });

  it("rejects a stale ETag with 412 and preserves the stored content", async () => {
    await putDocument(account, etag, documentPutBody());
    const stale = await putDocument(account, etag, documentPutBody());
    expect(stale.status).toBe(412);

    const current = await getDocument(account);
    const body = (await current.json()) as { revision: number };
    expect(body.revision).toBe(1);
  });

  it("treats an identical mutation retry as a no-op", async () => {
    const body = documentPutBody();
    const first = await putDocument(account, etag, body);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { etag: string; revision: number };

    const retry = await putDocument(account, firstBody.etag, body);
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { revision: number };
    expect(retryBody.revision).toBe(1);

    const rows = await TEST_ENV.DB.prepare(
      `SELECT COUNT(*) AS n FROM documents WHERE account_id = ?1`,
    )
      .bind(account.accountId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("rejects a mutationId reuse with a different payload (409)", async () => {
    const body = documentPutBody();
    const first = await putDocument(account, etag, body);
    const firstBody = (await first.json()) as { etag: string };
    const modified = { ...body, ciphertext: b64url(crypto.getRandomValues(new Uint8Array(96))) };
    const conflictResponse = await putDocument(account, firstBody.etag, modified);
    expect(conflictResponse.status).toBe(409);
  });

  it("rejects If-Match: * and a missing If-Match", async () => {
    const wildcard = await putDocument(account, "*", documentPutBody());
    expect(wildcard.status).toBe(412);

    const missing = await SELF.fetch(`${BASE}/api/v1/document`, {
      method: "PUT",
      headers: { ...webHeaders, cookie: account.cookie },
      body: JSON.stringify(documentPutBody()),
    });
    expect(missing.status).toBe(428);
  });

  it("rejects a mismatched encryptedRevision", async () => {
    const response = await putDocument(account, etag, documentPutBody({ encryptedRevision: 5 }));
    expect(response.status).toBe(412);
  });

  it("rejects unsorted or duplicated referencedMediaIds", async () => {
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    const unsorted = await putDocument(
      account,
      etag,
      documentPutBody({ referencedMediaIds: [idB, idA] }),
    );
    expect(unsorted.status).toBe(422);

    const duplicated = await putDocument(
      account,
      etag,
      documentPutBody({ referencedMediaIds: [idA, idA] }),
    );
    expect(duplicated.status).toBe(422);
  });

  it("does not leak another account's document", async () => {
    const other = await registerAccount();
    await bootstrapAccount(other);
    const response = await SELF.fetch(`${BASE}/api/v1/document`, {
      headers: { cookie: other.cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accountId: string };
    expect(body.accountId).toBe(other.accountId);
    expect(body.accountId).not.toBe(account.accountId);
  });
});

describe("media upload", () => {
  let account: RegisteredAccount;
  let etag: string;

  beforeEach(async () => {
    account = await registerAccount();
    await bootstrapAccount(account);
    const response = await getDocument(account);
    etag = response.headers.get("etag") as string;
  });

  // 公開仕様の固定値。実装の定数を参照せず、上限や整数幅の回帰を検出する。
  const MAX_CIPHER_BYTES = 10_000_152_592;
  const ACCOUNT_LIMIT_BYTES = 10_737_418_240;
  const NORMAL_PART_BYTES = 8_388_736;

  function requestUpload(cipherBytes: number, clientUploadId = crypto.randomUUID()) {
    return postJson(
      "/api/v1/media/uploads",
      { clientUploadId, cipherBytes, cryptoFormat: 1, chunkBytes: 1_048_592 },
      webHeaders,
      account.cookie,
    );
  }

  async function startUpload(cipherBytes: number): Promise<string> {
    const response = await requestUpload(cipherBytes);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { mediaId: string };
    return body.mediaId;
  }

  function partHeaders() {
    return { ...webHeaders, "content-type": "application/octet-stream", cookie: account.cookie };
  }

  function uploadPart(mediaId: string, partNumber: number, bytes: number) {
    return SELF.fetch(`${BASE}/api/v1/media/uploads/${mediaId}/parts/${partNumber}`, {
      method: "PUT", headers: partHeaders(), body: new Uint8Array(bytes),
    });
  }

  async function usage() {
    return TEST_ENV.DB.prepare(
      `SELECT used_bytes, reserved_bytes, limit_bytes, typeof(reserved_bytes) AS reserved_type
         FROM storage_usage WHERE account_id = ?1`,
    ).bind(account.accountId).first<{
      used_bytes: number; reserved_bytes: number | string; limit_bytes: number; reserved_type: string;
    }>();
  }

  async function mediaRows() {
    const rows = await TEST_ENV.DB.prepare(
      `SELECT id, state, cipher_bytes FROM media WHERE account_id = ?1 ORDER BY id`,
    ).bind(account.accountId).all();
    return rows.results;
  }

  it("spec: plans the maximum 10GB ciphertext and accepts its final partial part without truncation", async () => {
    // 10GB 全体は確保せず、開始・D1 の64bit値・最終パートだけを実際に検証する。
    const response = await requestUpload(MAX_CIPHER_BYTES);
    expect(response.status).toBe(201);
    const body = await response.json() as { mediaId: string };
    expect(body).toEqual({
      mediaId: expect.any(String), state: "uploading", partCount: 1193,
      partBytes: NORMAL_PART_BYTES, cipherBytes: MAX_CIPHER_BYTES, replayed: false,
    });
    expect(await usage()).toEqual({
      used_bytes: 0, reserved_bytes: MAX_CIPHER_BYTES,
      limit_bytes: ACCOUNT_LIMIT_BYTES, reserved_type: "integer",
    });
    expect((await mediaRows())?.[0]?.cipher_bytes).toBe(MAX_CIPHER_BYTES);

    expect((await uploadPart(body.mediaId, 1193, 779_279)).status).toBe(422);
    const last = await uploadPart(body.mediaId, 1193, 779_280);
    expect(last.status).toBe(200);
    expect(await last.json()).toEqual({ partNumber: 1193, bytes: 779_280, state: "accepted" });
    expect((await uploadPart(body.mediaId, 1194, 16)).status).toBe(422);
    const status = await SELF.fetch(`${BASE}/api/v1/media/uploads/${body.mediaId}`, {
      headers: { cookie: account.cookie },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      mediaId: body.mediaId, state: "uploading", cipherBytes: MAX_CIPHER_BYTES,
      partCount: 1193, acceptedParts: [{ partNumber: 1193, bytes: 779_280 }],
    });
  });

  it("spec: rejects maximum ciphertext plus one byte without creating a reservation", async () => {
    const before = await usage();
    const response = await requestUpload(MAX_CIPHER_BYTES + 1);
    expect(response.status).toBe(413);
    expect(await usage()).toEqual(before);
    expect(await mediaRows()).toEqual([]);
  });

  it("spec: enforces remaining capacity against already used bytes without changing the quota", async () => {
    await TEST_ENV.DB.prepare(`UPDATE storage_usage SET used_bytes = ?2 WHERE account_id = ?1`)
      .bind(account.accountId, ACCOUNT_LIMIT_BYTES - MAX_CIPHER_BYTES + 1).run();
    const before = await usage();
    const denied = await requestUpload(MAX_CIPHER_BYTES);
    expect(denied.status).toBe(413);
    expect(await usage()).toEqual(before);
    expect(await mediaRows()).toEqual([]);
    const allowed = await requestUpload(MAX_CIPHER_BYTES - 1);
    expect(allowed.status).toBe(201);
    expect(await usage()).toEqual({ ...before, reserved_bytes: MAX_CIPHER_BYTES - 1 });
  });

  it("spec: concurrent reservations cannot exceed the account hard cap", async () => {
    const cipherBytes = 200_000_000;
    await TEST_ENV.DB.prepare(`UPDATE storage_usage SET used_bytes = ?2 WHERE account_id = ?1`)
      .bind(account.accountId, ACCOUNT_LIMIT_BYTES - 2 * cipherBytes).run();
    const responses = await Promise.all(Array.from({ length: 4 }, () => requestUpload(cipherBytes)));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 201, 413, 413]);
    expect(await usage()).toEqual({
      used_bytes: ACCOUNT_LIMIT_BYTES - 2 * cipherBytes, reserved_bytes: 2 * cipherBytes,
      limit_bytes: ACCOUNT_LIMIT_BYTES, reserved_type: "integer",
    });
    expect(await mediaRows()).toHaveLength(2);
  });

  it("spec: repeated and changed starts never double-reserve while distinct uploads accumulate", async () => {
    const clientUploadId = crypto.randomUUID();
    const first = await requestUpload(4096, clientUploadId);
    expect(first.status).toBe(201);
    const original = await first.json() as { mediaId: string };
    const retry = await requestUpload(4096, clientUploadId);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ mediaId: original.mediaId, replayed: true });
    expect((await requestUpload(4097, clientUploadId)).status).toBe(409);
    await startUpload(8192);
    expect(await usage()).toEqual({
      used_bytes: 0, reserved_bytes: 12_288,
      limit_bytes: ACCOUNT_LIMIT_BYTES, reserved_type: "integer",
    });
    expect(await mediaRows()).toHaveLength(2);
  });

  it("spec: cancellation releases only its own reservation and repeated cancellation cannot subtract again", async () => {
    const cancelledId = await startUpload(4096);
    const remainingId = await startUpload(8192);
    const cancel = () => SELF.fetch(`${BASE}/api/v1/media/uploads/${cancelledId}`, {
      method: "DELETE", headers: { ...webHeaders, cookie: account.cookie },
    });
    expect((await cancel()).status).toBe(200);
    expect((await cancel()).status).toBe(404);
    expect(await usage()).toEqual({
      used_bytes: 0, reserved_bytes: 8192,
      limit_bytes: ACCOUNT_LIMIT_BYTES, reserved_type: "integer",
    });
    expect(await mediaRows()).toEqual([{ id: remainingId, state: "uploading", cipher_bytes: 8192 }]);
  });

  it("spec: concurrent duplicate DELETE releases its reservation exactly once in real D1", async () => {
    const cancelledId = await startUpload(4096);
    const remainingId = await startUpload(8192);
    let arrivals = 0;
    let release!: () => void;
    const snapshots = new Promise<void>((resolve) => { release = resolve; });
    const db = new Proxy(TEST_ENV.DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("SELECT * FROM media WHERE id = ?1 AND account_id = ?2")) return statement;
          return { bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return { async first<T>() {
              const row = await bound.first<T>();
              if (values[0] === cancelledId) { if (++arrivals === 2) release(); await snapshots; }
              return row;
            } };
          } } as unknown as D1PreparedStatement;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // HTTP handler に同じ uploading snapshot を渡す。SQL 実行・transaction は実 D1 のまま。
    const responses = await Promise.all(Array.from({ length: 2 }, () => worker.fetch(new Request(
      `${BASE}/api/v1/media/uploads/${cancelledId}`,
      { method: "DELETE", headers: { ...webHeaders, cookie: account.cookie } },
    ), { ...env, DB: db } as Env, createExecutionContext())));
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => [200, 404, 409].includes(response.status))).toBe(true);
    expect(await usage()).toMatchObject({ used_bytes: 0, reserved_bytes: 8192 });
    expect(await mediaRows()).toEqual([{ id: remainingId, state: "uploading", cipher_bytes: 8192 }]);
  });

  it("spec: stale cancellation after completion cannot delete ready ciphertext or subtract quota", async () => {
    const completedId = await startUpload(4096);
    await startUpload(8192);
    expect((await uploadPart(completedId, 1, 4096)).status).toBe(200);
    const stale = await loadUpload(env as Env, completedId, account.accountId);
    await completeUpload(env as Env, { media: stale, now: Date.now() });
    const result = await cancelUpload(env as Env, { media: stale, now: Date.now() }).catch((error) => error);
    expect.soft(result).toMatchObject({ status: 409 });
    expect.soft(await usage()).toMatchObject({ used_bytes: 4096, reserved_bytes: 8192 });
    expect.soft(await loadUpload(env as Env, completedId, account.accountId).catch(() => null)).toMatchObject({ state: "ready" });
    expect((await TEST_ENV.MEDIA.head(`cipher/${completedId}`))?.size).toBe(4096);
  });

  it("spec: cancellation racing an in-flight completion preserves the completion and other quota", async () => {
    const completedId = await startUpload(4096);
    await startUpload(8192);
    expect((await uploadPart(completedId, 1, 4096)).status).toBe(200);
    const stale = await loadUpload(env as Env, completedId, account.accountId);
    let entered!: () => void;
    let release!: () => void;
    const completing = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // D1 と R2 は実物。R2 complete 境界だけで停止し、古い uploading snapshot の取消を競合させる。
    const bucket = {
      resumeMultipartUpload(key: string, uploadId: string) {
        const multipart = TEST_ENV.MEDIA.resumeMultipartUpload(key, uploadId);
        return { async complete(parts: R2UploadedPart[]) { entered(); await gate; return multipart.complete(parts); } };
      },
      head: TEST_ENV.MEDIA.head.bind(TEST_ENV.MEDIA),
    } as unknown as R2Bucket;
    const completion = completeUpload({ ...env, MEDIA: bucket } as Env, { media: stale, now: Date.now() })
      .then((value) => value, (error) => error);
    await completing;
    const cancellation = await cancelUpload(env as Env, { media: stale, now: Date.now() }).catch((error) => error);
    release();
    expect.soft(cancellation).toMatchObject({ status: 409 });
    expect.soft(await completion).toMatchObject({ state: "ready" });
    expect.soft(await usage()).toMatchObject({ used_bytes: 4096, reserved_bytes: 8192 });
    expect((await TEST_ENV.MEDIA.head(`cipher/${completedId}`))?.size).toBe(4096);
  });

  it.each([undefined, "1"])(
    "spec: bounds actual upload-start JSON stream when Content-Length is %s before any media writes",
    async (declaredLength) => {
      const before = await usage();
      let reads = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (++reads <= 3) controller.enqueue(new Uint8Array(65536));
          else controller.close();
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const headers = new Headers({ ...webHeaders, cookie: account.cookie });
      if (declaredLength !== undefined) headers.set("content-length", declaredLength);
      const response = await worker.fetch(new Request(`${BASE}/api/v1/media/uploads`, {
        method: "POST", headers, body,
      }), env as Env, createExecutionContext());
      expect.soft(response.status).toBe(413);
      expect.soft(reads).toBe(2);
      expect.soft(cancelled).toBe(true);
      expect(await usage()).toEqual(before);
      expect(await mediaRows()).toEqual([]);
    },
  );

  it("spec: completion moves reserved bytes to used once while preserving other reservations", async () => {
    await TEST_ENV.DB.prepare(`UPDATE storage_usage SET used_bytes = 12345 WHERE account_id = ?1`)
      .bind(account.accountId).run();
    const completedId = await startUpload(4096);
    await startUpload(8192);
    expect((await uploadPart(completedId, 1, 4096)).status).toBe(200);
    for (let retry = 0; retry < 2; retry++) {
      const response = await postJson(`/api/v1/media/uploads/${completedId}/complete`, {}, webHeaders, account.cookie);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "ready", cipherBytes: 4096 });
      expect(await usage()).toEqual({
        used_bytes: 12345 + 4096, reserved_bytes: 8192,
        limit_bytes: ACCOUNT_LIMIT_BYTES, reserved_type: "integer",
      });
    }
  });

  it.each(["legacy-account-uuid", -4096, 1.5])(
    "spec: repairs an idle invalid reservation counter %s without touching used bytes or the account limit",
    async (invalid) => {
      await TEST_ENV.DB.prepare(
        `UPDATE storage_usage SET reserved_bytes = ?2, used_bytes = 12345 WHERE account_id = ?1`,
      ).bind(account.accountId, invalid).run();
      await startUpload(4096);
      expect(await usage()).toEqual({
        used_bytes: 12345, reserved_bytes: 4096,
        limit_bytes: ACCOUNT_LIMIT_BYTES, reserved_type: "integer",
      });
    },
  );

  for (const state of ["creating", "uploading", "completing", "deleting"]) {
    it.each(["legacy-account-uuid", -4096, 1.5])(
      `spec: fails closed for an invalid %s reservation with a ${state} upload`,
      async (invalid) => {
        const mediaId = await startUpload(4096);
        await TEST_ENV.DB.batch([
          TEST_ENV.DB.prepare(`UPDATE media SET state = ?2 WHERE id = ?1`).bind(mediaId, state),
          TEST_ENV.DB.prepare(
            `UPDATE storage_usage SET reserved_bytes = ?2, used_bytes = 12345 WHERE account_id = ?1`,
          ).bind(account.accountId, invalid),
        ]);
        const beforeUsage = await usage();
        const beforeMedia = await mediaRows();
        const response = await requestUpload(8192);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "STORAGE_USAGE_INVALID" } });
        expect(await usage()).toEqual(beforeUsage);
        expect(await mediaRows()).toEqual(beforeMedia);
      },
    );
  }

  async function expectNoPartWritten(mediaId: string) {
    const parts = await TEST_ENV.DB.prepare(`SELECT * FROM upload_parts WHERE media_id = ?1`)
      .bind(mediaId).all();
    expect(parts.results).toEqual([]);
    expect(await TEST_ENV.MEDIA.head(`cipher/${mediaId}`)).toBeNull();
    const status = await SELF.fetch(`${BASE}/api/v1/media/uploads/${mediaId}`, {
      headers: { cookie: account.cookie },
    });
    expect(await status.json()).toMatchObject({ acceptedParts: [] });
  }

  it("spec: rejects an oversized declared part before reading or accepting its otherwise valid body", async () => {
    const mediaId = await startUpload(4096);
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(4096)); controller.close(); },
    }, { highWaterMark: 0 });
    // 直接 dispatch し、fetch が Content-Length を書き換えない状態で実認証ルートを通す。
    const request = new Request(`${BASE}/api/v1/media/uploads/${mediaId}/parts/1`, {
      method: "PUT", headers: { ...partHeaders(), "content-length": String(NORMAL_PART_BYTES + 1) }, body,
    });
    const response = await worker.fetch(request, env as Env, createExecutionContext());
    expect.soft(response.status).toBe(413);
    expect.soft(reads).toBe(0);
    await expectNoPartWritten(mediaId);
    await body.cancel();
  });

  it.each([undefined, "1"])(
    "spec: bounds actual streamed part bytes even when Content-Length is %s",
    async (declaredLength) => {
      const mediaId = await startUpload(NORMAL_PART_BYTES);
      let reads = 0;
      let cancelled = false;
      const chunks = [new Uint8Array(NORMAL_PART_BYTES), new Uint8Array(1), new Uint8Array(1024)];
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[reads++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const headers = new Headers(partHeaders());
      if (declaredLength !== undefined) headers.set("content-length", declaredLength);
      const request = new Request(`${BASE}/api/v1/media/uploads/${mediaId}/parts/1`, {
        method: "PUT", headers, body,
      });
      const response = await worker.fetch(request, env as Env, createExecutionContext());
      expect.soft(response.status).toBe(413);
      expect.soft(reads).toBe(2); // 上限超過を検出した時点で停止し、後続を読まない。
      expect.soft(cancelled).toBe(true);
      await expectNoPartWritten(mediaId);
    },
  );

  it("reserves capacity and rejects a start beyond the object limit", async () => {
    const mediaId = await startUpload(2048);
    expect(mediaId).toBeTruthy();

    const tooBig = await postJson(
      "/api/v1/media/uploads",
      {
        clientUploadId: crypto.randomUUID(),
        cipherBytes: MAX_CIPHER_BYTES + 1,
        cryptoFormat: 1,
        chunkBytes: 1_048_592,
      },
      webHeaders,
      account.cookie,
    );
    expect(tooBig.status).toBe(413);
  });

  it("uploads parts, completes, and serves ranges", async () => {
    // A normal multipart part carries 8 chunks: 8 x 1,048,592 = 8,388,736 B.
    const partBytes = 8_388_736;
    const remainder = 4096;
    const cipherBytes = partBytes + remainder;
    const mediaId = await startUpload(cipherBytes);

    const part0 = randomBytes(partBytes);
    const part1 = randomBytes(remainder);

    for (const [index, data] of [part0, part1].entries()) {
      const response = await SELF.fetch(
        `${BASE}/api/v1/media/uploads/${mediaId}/parts/${index + 1}`,
        {
          method: "PUT",
          headers: {
            origin: BASE,
            "x-txt-request": "1",
            "content-type": "application/octet-stream",
            cookie: account.cookie,
          },
          body: data,
        },
      );
      expect(response.status).toBe(200);
    }

    const complete = await postJson(
      `/api/v1/media/uploads/${mediaId}/complete`,
      {},
      webHeaders,
      account.cookie,
    );
    expect(complete.status).toBe(200);

    // Media becomes deliverable only once the document references it.
    const beforeRef = await SELF.fetch(`${BASE}/api/v1/media/${mediaId}/cipher`, {
      headers: { cookie: account.cookie },
    });
    expect(beforeRef.status).toBe(404);

    const save = await putDocument(
      account,
      etag,
      documentPutBody({ referencedMediaIds: [mediaId] }),
    );
    expect(save.status).toBe(200);
    const saveBody = (await save.json()) as { etag: string };

    const full = await SELF.fetch(`${BASE}/api/v1/media/${mediaId}/cipher`, {
      headers: { cookie: account.cookie },
    });
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("application/octet-stream");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect((await full.arrayBuffer()).byteLength).toBe(cipherBytes);

    const range = await SELF.fetch(`${BASE}/api/v1/media/${mediaId}/cipher`, {
      headers: { cookie: account.cookie, range: "bytes=10-19" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 10-19/${cipherBytes}`);

    const suffix = await SELF.fetch(`${BASE}/api/v1/media/${mediaId}/cipher`, {
      headers: { cookie: account.cookie, range: "bytes=-16" },
    });
    expect(suffix.status).toBe(206);

    const head = await SELF.fetch(`${BASE}/api/v1/media/${mediaId}/cipher`, {
      method: "HEAD",
      headers: { cookie: account.cookie },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(cipherBytes));

    // Another account cannot read it, and existence is not leaked.
    const other = await registerAccount();
    await bootstrapAccount(other);
    const denied = await SELF.fetch(`${BASE}/api/v1/media/${mediaId}/cipher`, {
      headers: { cookie: other.cookie },
    });
    expect(denied.status).toBe(404);

    const savedEtag = saveBody.etag;
    return savedEtag;
  });

  it("is idempotent for an identical part retry and 409 for a changed one", async () => {
    const partBytes = 8_388_736;
    const mediaId = await startUpload(partBytes);
    const data = randomBytes(partBytes);

    const first = await SELF.fetch(`${BASE}/api/v1/media/uploads/${mediaId}/parts/1`, {
      method: "PUT",
      headers: {
        origin: BASE,
        "x-txt-request": "1",
        "content-type": "application/octet-stream",
        cookie: account.cookie,
      },
      body: data,
    });
    expect(first.status).toBe(200);

    const retry = await SELF.fetch(`${BASE}/api/v1/media/uploads/${mediaId}/parts/1`, {
      method: "PUT",
      headers: {
        origin: BASE,
        "x-txt-request": "1",
        "content-type": "application/octet-stream",
        cookie: account.cookie,
      },
      body: data,
    });
    expect(retry.status).toBe(200);

    const changed = await SELF.fetch(`${BASE}/api/v1/media/uploads/${mediaId}/parts/1`, {
      method: "PUT",
      headers: {
        origin: BASE,
        "x-txt-request": "1",
        "content-type": "application/octet-stream",
        cookie: account.cookie,
      },
      body: randomBytes(partBytes),
    });
    expect(changed.status).toBe(409);
  });

  it("refuses to complete while parts are missing", async () => {
    const mediaId = await startUpload(1_048_592 * 2);
    const complete = await postJson(
      `/api/v1/media/uploads/${mediaId}/complete`,
      {},
      webHeaders,
      account.cookie,
    );
    expect(complete.status).toBe(409);
  });

  it("rejects a short part body", async () => {
    const mediaId = await startUpload(1_048_592);
    const response = await SELF.fetch(`${BASE}/api/v1/media/uploads/${mediaId}/parts/1`, {
      method: "PUT",
      headers: {
        origin: BASE,
        "x-txt-request": "1",
        "content-type": "application/octet-stream",
        cookie: account.cookie,
      },
      body: randomBytes(1024),
    });
    expect(response.status).toBe(422);
  });
});

describe("login and sessions", () => {
  it("logs in with a discoverable passkey and rejects replay", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);

    const optionsResponse = await postJson("/api/v1/auth/login/options", {});
    expect(optionsResponse.status).toBe(200);
    const optionsBody = (await optionsResponse.json()) as {
      options: { challenge: string; allowCredentials: unknown[] };
    };
    expect(optionsBody.options.allowCredentials).toEqual([]);

    const response = await assertionResponse(account.credential, {
      challenge: optionsBody.options.challenge,
      rpId: "txt.2-38.com",
      userHandle: account.userHandle,
    });
    const verify = await postJson("/api/v1/auth/login/verify", { response });
    expect(verify.status).toBe(200);
    const body = (await verify.json()) as { scope: string };
    expect(body.scope).toBe("active");

    // Challenge reuse must fail (spec §5.2: single-use, atomic consumption).
    const replay = await postJson("/api/v1/auth/login/verify", { response });
    expect([400, 409]).toContain(replay.status);
  });

  it("rejects an assertion signed for a different origin", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);

    const optionsResponse = await postJson("/api/v1/auth/login/options", {});
    const optionsBody = (await optionsResponse.json()) as { options: { challenge: string } };

    const clientData = await clientDataJSON(
      optionsBody.options.challenge,
      "webauthn.get",
      "https://evil.example",
    );
    const response = await assertionResponse(account.credential, {
      challenge: decodeChallenge(clientData),
      rpId: "txt.2-38.com",
    });
    (response.response as { clientDataJSON: string }).clientDataJSON = clientData;

    const verify = await postJson("/api/v1/auth/login/verify", { response });
    expect(verify.status).toBe(401);
  });

  it("ends only the current session on DELETE /session", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);
    const response = await SELF.fetch(`${BASE}/api/v1/session`, {
      method: "DELETE",
      headers: { ...webHeaders, cookie: account.cookie },
    });
    expect(response.status).toBe(200);

    const after = await SELF.fetch(`${BASE}/api/v1/session`, {
      headers: { cookie: account.cookie },
    });
    expect(after.status).toBe(401);
  });
});



describe("Web-only contract", () => {
  // アプリ関連付けは残存bindingがあっても配信せず、SPAへ渡さない。
  it.each(["GET", "HEAD"])("does not serve application association for %s", async (method) => {
    let assetCalls = 0;
    const response = await worker.fetch(new Request(`${BASE}/.well-known/apple-app-site-association`, { method }), {
      ...(env as Env),
      TxtTeamId: "LEGACYTEAM",
      TxtIosBundleId: "legacy.ios",
      TxtMacosBundleId: "legacy.mac",
      ASSETS: { fetch() { assetCalls++; return Promise.resolve(new Response("SPA")); } } as unknown as Fetcher,
    } as Env, createExecutionContext());
    expect.soft(response.status).toBe(404);
    expect.soft(response.headers.get("cache-control")).toBe("no-store");
    expect(assetCalls).toBe(0);
  });

  it("registers through cookie-only WebAuthn despite a legacy app User-Agent", async () => {
    const account = await registerAccount({ "content-type": "application/json", "user-agent": "txt-ios/1.0" });
    const session = await SELF.fetch(`${BASE}/api/v1/session`, { headers: { cookie: account.cookie } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ clientKind: "web", via: "cookie" });
  });

  it("logs in through cookie-only WebAuthn despite a legacy app User-Agent", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);
    const headers = { "content-type": "application/json", "user-agent": "txt-macos/1.0" };
    const options = await postJson("/api/v1/auth/login/options", {}, headers);
    const body = await options.json() as { options: { challenge: string } };
    const response = await assertionResponse(account.credential, {
      challenge: body.options.challenge, rpId: "txt.2-38.com", userHandle: account.userHandle,
    });
    const verify = await postJson("/api/v1/auth/login/verify", { response }, headers);
    expect.soft(verify.status).toBe(200);
    expect.soft(await verify.json()).not.toHaveProperty("token");
    expect(cookieFrom(verify)).toBeTruthy();
  });

  it("starts recovery with a cookie and never returns a raw session token", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);
    const recoveryAuth = randomBytes(32);
    await TEST_ENV.DB.prepare(`UPDATE recovery SET auth_hash32 = ?2 WHERE account_id = ?1`)
      .bind(account.accountId, recoveryAuth).run();
    const response = await postJson("/api/v1/recovery/start", {
      accountId: account.accountId, recoveryAuth: b64url(recoveryAuth),
    }, { "content-type": "application/json" });
    expect.soft(response.status).toBe(200);
    expect.soft(await response.json()).not.toHaveProperty("token");
    expect(cookieFrom(response)).toBeTruthy();
  });

  // 既存Webセッションの生値であってもBearer経路は読み書きとも認可しない。
  it.each([undefined, BASE, "https://evil.example"])("rejects Bearer reads and writes with origin %s", async (origin) => {
    const account = await registerAccount();
    await bootstrapAccount(account);
    const before = await getDocument(account);
    const snapshot = await before.json();
    const headers: Record<string, string> = { authorization: `Bearer ${account.cookie.split("=")[1]}` };
    if (origin !== undefined) headers.origin = origin;
    const read = await SELF.fetch(`${BASE}/api/v1/document`, { headers });
    expect.soft(read.status).toBe(401);
    const write = await SELF.fetch(`${BASE}/api/v1/document`, {
      method: "PUT", headers: { ...headers, "content-type": "application/json", "if-match": before.headers.get("etag")! },
      body: JSON.stringify(documentPutBody()),
    });
    expect.soft(write.status).toBe(401);
    expect(await (await getDocument(account)).json()).toEqual(snapshot);
  });

  it("rejects cookie writes without Origin and preserves the document", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);
    const before = await getDocument(account);
    const snapshot = await before.json();
    const response = await SELF.fetch(`${BASE}/api/v1/document`, {
      method: "PUT", headers: { cookie: account.cookie, "content-type": "application/json", "x-txt-request": "1", "if-match": before.headers.get("etag")! },
      body: JSON.stringify(documentPutBody()),
    });
    expect(response.status).toBe(403);
    expect(await (await getDocument(account)).json()).toEqual(snapshot);
  });

  it("lists only browser sessions while leaving legacy rows intact", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);
    const originalSid = (await TEST_ENV.DB.prepare(`SELECT sid FROM sessions WHERE account_id = ?1`)
      .bind(account.accountId).first<{ sid: string }>())!.sid;
    await TEST_ENV.DB.prepare(`UPDATE sessions SET client_kind = 'native' WHERE sid = ?1`).bind(originalSid).run();
    const { issueSession } = await import("../../apps/worker/src/auth/sessions.ts");
    const browserSession = await issueSession(env as Env, { accountId: account.accountId, clientKind: "web", scope: "active", authEpoch: 0 });
    const response = await SELF.fetch(`${BASE}/api/v1/sessions`, { headers: { cookie: `__Host-txt_session=${browserSession.token}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as { sessions: Array<{ sid: string; clientKind: string }> };
    expect(body.sessions.map((session) => session.sid)).toEqual([browserSession.sid]);
    expect(body.sessions[0]!.clientKind).toBe("web");
    expect(await TEST_ENV.DB.prepare(`SELECT client_kind FROM sessions WHERE sid = ?1`).bind(originalSid)
      .first()).toMatchObject({ client_kind: "native" });
  });

  it("does not accept a legacy non-Web session via a cookie", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);
    await TEST_ENV.DB.prepare(`UPDATE sessions SET client_kind = 'native' WHERE account_id = ?1`)
      .bind(account.accountId).run();
    const read = await SELF.fetch(`${BASE}/api/v1/session`, { headers: { cookie: account.cookie } });
    expect(read.status).toBe(401);
  });

  it("rejects an in-flight legacy non-Web WebAuthn challenge", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);
    const options = await postJson("/api/v1/auth/login/options", {});
    const body = await options.json() as { options: { challenge: string } };
    await TEST_ENV.DB.prepare(`UPDATE challenges SET client_kind = 'native' WHERE purpose = 'login'`).run();
    const response = await assertionResponse(account.credential, {
      challenge: body.options.challenge, rpId: "txt.2-38.com", userHandle: account.userHandle,
    });
    const verify = await postJson("/api/v1/auth/login/verify", { response });
    expect(verify.status).toBe(400);
    expect(cookieFrom(verify)).toBeUndefined();
  });
});

describe("credential management", () => {
  it("refuses to remove the last active passkey", async () => {
    const account = await registerAccount();
    await bootstrapAccount(account);
    const response = await SELF.fetch(
      `${BASE}/api/v1/credentials/${encodeURIComponent(account.credential.credentialId)}`,
      {
        method: "DELETE",
        headers: { ...webHeaders, cookie: account.cookie },
      },
    );
    expect(response.status).toBe(409);
  });
});
