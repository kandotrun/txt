/**
 * WebAuthn client + PRF handling (spec §5, §6.2, §6.3).
 *
 * - The server's JSON options are converted to the browser's ArrayBuffer/
 *   base64url forms manually: `parseCreationOptionsFromJSON` is not available
 *   in every supported browser, and the spec requires exact bytes.
 * - PRF is evaluated with the fixed public input. The output never leaves the
 *   device: only derived wrappers are sent.
 * - `toJSON()` is NOT used for transport; a minimal DTO is built instead so PRF
 *   results cannot leak (spec §6.2).
 */

import { PRF_INPUT_V1 } from "../../../../packages/protocol/src/crypto.ts";
import { fromBase64Url, toBase64Url } from "../../../../packages/protocol/src/base64url.ts";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "./api.ts";

export class WebAuthnError extends Error {
  readonly kind: "unsupported" | "cancelled" | "no-prf" | "failed";

  constructor(kind: WebAuthnError["kind"], message: string) {
    super(message);
    this.name = "WebAuthnError";
    this.kind = kind;
  }
}

export function isWebAuthnAvailable(): boolean {
  if (typeof window === "undefined" || typeof window.PublicKeyCredential === "undefined") {
    return false;
  }
  // Secure contexts only: https, or localhost for development.
  return location.protocol === "https:" || location.hostname === "localhost";
}

function toBuffer(source: string): ArrayBuffer {
  const bytes = fromBase64Url(source);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function creationOptionsFromJSON(
  json: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptions {
  return {
    challenge: toBuffer(json.challenge),
    rp: { id: json.rp.id, name: json.rp.name },
    user: {
      id: toBuffer(json.user.id),
      name: json.user.name,
      displayName: json.user.displayName,
    },
    pubKeyCredParams: json.pubKeyCredParams.map((param) => ({
      type: "public-key",
      alg: param.alg,
    })),
    excludeCredentials: json.excludeCredentials?.map((credential) => ({
      id: toBuffer(credential.id),
      type: "public-key",
      transports: credential.transports as AuthenticatorTransport[] | undefined,
    })),
    authenticatorSelection: json.authenticatorSelection as AuthenticatorSelectionCriteria,
    attestation: (json.attestation ?? "none") as AttestationConveyancePreference,
    extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
  };
}

function requestOptionsFromJSON(
  json: PublicKeyCredentialRequestOptionsJSON,
): PublicKeyCredentialRequestOptions {
  return {
    challenge: toBuffer(json.challenge),
    rpId: json.rpId,
    allowCredentials: json.allowCredentials?.map((credential) => ({
      id: toBuffer(credential.id),
      type: "public-key",
      transports: credential.transports as AuthenticatorTransport[] | undefined,
    })),
    userVerification: (json.userVerification ?? "required") as UserVerificationRequirement,
    // Discoverable login: `prf.eval` with a fixed input (spec §6.2). An empty
    // allowCredentials list must not be paired with evalByCredential.
    extensions: { prf: { eval: { first: PRF_INPUT_V1 as BufferSource } } },
  };
}

/** Public-key credential JSON for the server: only the verification fields. */
function credentialToDto(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response;
  if (response instanceof AuthenticatorAttestationResponse) {
    return {
      id: credential.id,
      rawId: toBase64Url(new Uint8Array(credential.rawId)),
      type: credential.type,
      response: {
        clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
        attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
        transports: response.getTransports ? response.getTransports() : [],
      },
      // `clientExtensionResults` is deliberately omitted: PRF results must not
      // be sent to the server (spec §6.2).
    };
  }
  const assertion = response as AuthenticatorAssertionResponse;
  const dto: Record<string, unknown> = {
    id: credential.id,
    rawId: toBase64Url(new Uint8Array(credential.rawId)),
    type: credential.type,
    response: {
      clientDataJSON: toBase64Url(new Uint8Array(assertion.clientDataJSON)),
      authenticatorData: toBase64Url(new Uint8Array(assertion.authenticatorData)),
      signature: toBase64Url(new Uint8Array(assertion.signature)),
    },
  };
  if (assertion.userHandle) {
    (dto.response as Record<string, unknown>).userHandle = toBase64Url(
      new Uint8Array(assertion.userHandle),
    );
  }
  return dto;
}

function classifyError(error: unknown): WebAuthnError {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return new WebAuthnError("cancelled", "パスキーの操作が取り消されました。");
    }
    if (error.name === "NotSupportedError") {
      return new WebAuthnError("unsupported", "この環境ではパスキーを利用できません。");
    }
  }
  if (error instanceof WebAuthnError) return error;
  return new WebAuthnError("failed", (error as Error).message ?? "パスキーの操作に失敗しました。");
}

export interface PrfResult {
  prfOutput: Uint8Array;
  credentialId: Uint8Array;
  dto: Record<string, unknown>;
}

function readPrfOutput(credential: PublicKeyCredential): Uint8Array | null {
  const results = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const first = results?.prf?.results?.first;
  if (!first) return null;
  return new Uint8Array(first);
}

/** Registration with PRF. Returns the DTO and the PRF output (device-only). */
export async function createCredential(
  optionsJson: PublicKeyCredentialCreationOptionsJSON,
): Promise<PrfResult> {
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: creationOptionsFromJSON(optionsJson),
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw classifyError(error);
  }
  if (!credential) throw new WebAuthnError("cancelled", "パスキーの作成が完了しませんでした。");

  let prfOutput = readPrfOutput(credential);
  if (!prfOutput) {
    // Spec §5.3: if the PRF output is missing after creation, run an
    // additional assertion before declaring the environment unsupported.
    const asserted = await assertCredential(
      {
        challenge: optionsJson.challenge,
        rpId: optionsJson.rp.id,
        allowCredentials: [{ id: toBase64Url(new Uint8Array(credential.rawId)), type: "public-key" }],
        userVerification: "required",
      },
      { returnCredential: true },
    );
    prfOutput = asserted.prfOutput;
    if (!prfOutput) {
      throw new WebAuthnError(
        "no-prf",
        "この環境では、このパスキーで暗号化された内容を開けません。",
      );
    }
  }
  return {
    prfOutput,
    credentialId: new Uint8Array(credential.rawId),
    dto: credentialToDto(credential),
  };
}

export interface AssertionResult {
  prfOutput: Uint8Array | null;
  credentialIdRaw: Uint8Array;
  dto: Record<string, unknown>;
}

/**
 * Assertion with PRF evaluation. `eval` is always the fixed public input;
 * evalByCredential is never combined with an empty allowCredentials list.
 */
export async function assertCredential(
  optionsJson: PublicKeyCredentialRequestOptionsJSON,
  flags: { returnCredential?: boolean } = {},
): Promise<AssertionResult> {
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: requestOptionsFromJSON(optionsJson),
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw classifyError(error);
  }
  if (!credential) throw new WebAuthnError("cancelled", "パスキーの操作が完了しませんでした。");
  void flags;
  return {
    prfOutput: readPrfOutput(credential),
    credentialIdRaw: new Uint8Array(credential.rawId),
    dto: credentialToDto(credential),
  };
}

/** Whether the platform advertises PRF support (necessary, not sufficient). */
export async function platformSupportsPrf(): Promise<boolean> {
  if (!isWebAuthnAvailable()) return false;
  if (typeof PublicKeyCredential.getClientCapabilities === "function") {
    try {
      const capabilities = await PublicKeyCredential.getClientCapabilities();
      return capabilities.prf === true;
    } catch {
      // Fall through to the optimistic default; the real check is the actual
      // PRF output, never the enabled/isSupported flags alone (spec §6.2).
      return true;
    }
  }
  return true;
}
