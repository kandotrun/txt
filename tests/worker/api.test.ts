/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Worker integration tests against the real D1/R2 bindings (spec §17.3–17.5).
 *
 * These tests exercise the HTTP surface with a simulated WebAuthn credential
 * built from real ES256 keys, so signature verification actually runs.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { encodeBase64Url } from "../../apps/worker/src/document/store.ts";

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

/** Runs register/options + register/verify and returns the pending session. */
async function registerAccount(): Promise<RegisteredAccount> {
  const optionsResponse = await postJson("/api/v1/auth/register/options", {});
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

  const verifyResponse = await postJson("/api/v1/auth/register/verify", { response });
  expect(verifyResponse.status).toBe(200);
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

  async function startUpload(cipherBytes: number): Promise<string> {
    const response = await postJson(
      "/api/v1/media/uploads",
      {
        clientUploadId: crypto.randomUUID(),
        cipherBytes,
        cryptoFormat: 1,
        chunkBytes: 1_048_592,
      },
      webHeaders,
      account.cookie,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { mediaId: string };
    return body.mediaId;
  }

  it("reserves capacity and rejects a start beyond the account limit", async () => {
    const mediaId = await startUpload(2048);
    expect(mediaId).toBeTruthy();

    const tooBig = await postJson(
      "/api/v1/media/uploads",
      {
        clientUploadId: crypto.randomUUID(),
        cipherBytes: 536_879_105,
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
