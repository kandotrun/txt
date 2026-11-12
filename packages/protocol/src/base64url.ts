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
