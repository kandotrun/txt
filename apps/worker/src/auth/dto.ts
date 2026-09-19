/**
 * WebAuthn DTO sanitization (spec §6.2).
 *
 * `credential.toJSON()`, `getClientExtensionResults()` and the raw library
 * response are never accepted wholesale. Only the fields required for
 * signature verification are kept — PRF results are explicitly excluded, and
 * the server never stores or logs them.
 */

import { badRequest } from "../errors.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function requireB64(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 65536) {
    throw badRequest(`response.${field} is required`);
  }
  if (!BASE64URL.test(value)) {
    throw badRequest(`response.${field} is not base64url`);
  }
  return value;
}

export interface RegistrationResponseDto {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
  };
  clientExtensionResults: Record<string, never>;
}

export interface AuthenticationResponseDto {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  clientExtensionResults: Record<string, never>;
}

function baseFields(response: Record<string, unknown>): {
  id: string;
  rawId: string;
  inner: Record<string, unknown>;
} {
  const inner = response["response"];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) {
    throw badRequest("response.response must be an object");
  }
  const innerObj = inner as Record<string, unknown>;
  const id = requireB64(response["id"], "id");
  const rawId =
    typeof response["rawId"] === "string" ? requireB64(response["rawId"], "rawId") : id;
  if (response["type"] !== undefined && response["type"] !== "public-key") {
    throw badRequest("response.type must be public-key");
  }
  return { id, rawId, inner: innerObj };
}

/** Strips everything except the verification fields for registration. */
export function sanitizeRegistrationResponse(
  credential: Record<string, unknown>,
): RegistrationResponseDto {
  const { id, rawId, inner } = baseFields(credential);
  return {
    id,
    rawId,
    type: "public-key",
    // `clientExtensionResults` is intentionally emptied: PRF results must not
    // travel to the server even if a client sends them.
    clientExtensionResults: {},
    response: {
      clientDataJSON: requireB64(inner["clientDataJSON"], "response.clientDataJSON"),
      attestationObject: requireB64(inner["attestationObject"], "response.attestationObject"),
    },
  };
}

/** Strips everything except the verification fields for authentication. */
export function sanitizeAuthenticationResponse(
  credential: Record<string, unknown>,
): AuthenticationResponseDto {
  const { id, rawId, inner } = baseFields(credential);
  const dto: AuthenticationResponseDto = {
    id,
    rawId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: requireB64(inner["clientDataJSON"], "response.clientDataJSON"),
      authenticatorData: requireB64(inner["authenticatorData"], "response.authenticatorData"),
      signature: requireB64(inner["signature"], "response.signature"),
    },
  };
  if (typeof inner["userHandle"] === "string" && inner["userHandle"].length > 0) {
    dto.response.userHandle = requireB64(inner["userHandle"], "response.userHandle");
  }
  return dto;
}

/** Decodes clientDataJSON and returns the challenge string. */
export function challengeFromClientData(clientDataJSON: string): string {
  const normalized = clientDataJSON.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw badRequest("clientDataJSON is not base64url");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  let parsed: { challenge?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as { challenge?: unknown };
  } catch {
    throw badRequest("clientDataJSON is not valid JSON");
  }
  if (typeof parsed.challenge !== "string" || parsed.challenge.length === 0) {
    throw badRequest("clientDataJSON has no challenge");
  }
  return parsed.challenge;
}
