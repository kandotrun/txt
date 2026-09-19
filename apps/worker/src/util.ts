/**
 * Small helpers shared by routes: random IDs, hashing, time, and JSON body
 * parsing with size limits (spec §12.2, §14).
 */

import { ApiError, badRequest } from "./errors.ts";

export function nowMs(): number {
  return Date.now();
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.byteLength ? (bytes[i + 1] as number) : undefined;
    const b2 = i + 2 < bytes.byteLength ? (bytes[i + 2] as number) : undefined;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Constant-time-ish hex comparison for stored hashes. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new TypeError("fromHex: invalid input");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.byteLength; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Reads a JSON request body with a hard byte limit. Throws 400 on malformed
 * JSON, 413 when the body exceeds the limit (including for streaming bodies,
 * where Content-Length is not reliable).
 */
export async function readJson<T = Record<string, unknown>>(
  request: Request,
  maxBytes: number,
): Promise<T> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "request body too large");
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "request body too large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer)) as T;
  } catch {
    throw badRequest("body must be valid JSON");
  }
}

export async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "request body too large");
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "request body too large");
  }
  return new Uint8Array(buffer);
}

export function requireString(
  value: unknown,
  field: string,
  maxLength = 512,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw badRequest(`field ${field} is invalid`);
  }
  return value;
}

export function requireInt(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw badRequest(`field ${field} is invalid`);
  }
  return value;
}

export function parseJsonObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`field ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseTime(value: unknown, field: string): number {
  if (typeof value !== "string") throw badRequest(`field ${field} must be an ISO timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw badRequest(`field ${field} must be an ISO timestamp`);
  return ms;
}
