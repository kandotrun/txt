/**
 * Padding-free base64url helpers (spec §6.3).
 *
 * The wire format never carries `=` padding. Binary JSON fields use base64url.
 * Works in both Workers (no Buffer) and browsers (no Buffer), so it is
 * implemented with TextEncoder/btoa-free pure JS for reliability.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) LOOKUP.set(ALPHABET[i] as string, i);

export function toBase64Url(bytes: Uint8Array): string {
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

export function fromBase64Url(input: string): Uint8Array {
  if (typeof input !== "string") throw new TypeError("fromBase64Url: not a string");
  if (input.length === 0) return new Uint8Array(0);
  if (/[^A-Za-z0-9_-]/.test(input)) {
    throw new TypeError("fromBase64Url: invalid character");
  }
  const remainder = input.length % 4;
  if (remainder === 1) throw new TypeError("fromBase64Url: invalid length");
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 4) {
    const c0 = LOOKUP.get(input[i] as string) as number;
    const c1 = i + 1 < input.length ? LOOKUP.get(input[i + 1] as string) : undefined;
    const c2 = i + 2 < input.length ? LOOKUP.get(input[i + 2] as string) : undefined;
    const c3 = i + 3 < input.length ? LOOKUP.get(input[i + 3] as string) : undefined;
    if (c1 === undefined) throw new TypeError("fromBase64Url: invalid length");
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 === undefined) break;
    out.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (c3 === undefined) break;
    out.push(((c2 & 0x03) << 6) | c3);
  }
  return new Uint8Array(out);
}

/** Standard base64 (with padding) -> bytes. Used only to decode WebAuthn/PRF inputs. */
export function fromBase64(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  if (/[^A-Za-z0-9+/]/.test(normalized.replace(/=+$/, ""))) {
    throw new TypeError("fromBase64: invalid character");
  }
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (padded.length % 4 !== 0) throw new TypeError("fromBase64: invalid length");
  const out: number[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    const c0 = LOOKUP.get(padded[i] as string);
    const c1 = LOOKUP.get(padded[i + 1] as string);
    const c2 = padded[i + 2] === "=" ? undefined : LOOKUP.get(padded[i + 2] as string);
    const c3 = padded[i + 3] === "=" ? undefined : LOOKUP.get(padded[i + 3] as string);
    if (c0 === undefined || c1 === undefined) throw new TypeError("fromBase64: invalid data");
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 === undefined) break;
    out.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (c3 === undefined) break;
    out.push(((c2 & 0x03) << 6) | c3);
  }
  return new Uint8Array(out);
}

/** Standard base64 (with padding), for interop with base64-decoding parties. */
export function toBase64(bytes: Uint8Array): string {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.byteLength ? (bytes[i + 1] as number) : undefined;
    const b2 = i + 2 < bytes.byteLength ? (bytes[i + 2] as number) : undefined;
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 0x3f];
  }
  return out;
}
