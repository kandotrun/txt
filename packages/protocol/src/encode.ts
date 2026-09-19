/**
 * Binary encoding primitives (spec §6.3).
 *
 * `Encode` prefixes each field's bytes with a uint32 big-endian length and
 * concatenates them. Strings are UTF-8, UUIDs are 16 bytes, credential IDs are
 * raw bytes, integers are uint64 big-endian.
 *
 * No JSON key ordering, locale-dependent strings, or Swift hash ordering.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const MAX_U64 = 0xffffffffffffffffn;

/** UTF-8 bytes of a string, for `Encode` string fields and HKDF info. */
export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * A field value accepted by `Encode`.
 *
 * - `string` -> UTF-8 bytes
 * - `Uint8Array` -> raw bytes (UUID 16, credential ID, salt, ...)
 * - `number` / `bigint` -> uint64 big-endian
 * - `boolean` -> uint64 0 or 1 (never used in the current contract; kept
 *   explicit so callers cannot smuggle in JSON booleans)
 */
export type EncodeField = string | Uint8Array | number | bigint;

function uint64Be(value: number | bigint): Uint8Array {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n || v > MAX_U64) {
    throw new RangeError("Encode: integer out of uint64 range");
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, false);
  return out;
}

function fieldBytes(field: EncodeField): Uint8Array {
  if (field instanceof Uint8Array) return field;
  if (typeof field === "string") return utf8(field);
  if (typeof field === "number" || typeof field === "bigint") {
    return uint64Be(field);
  }
  throw new TypeError("Encode: unsupported field type");
}

/**
 * `Encode(fields...)`: uint32 big-endian length || bytes, concatenated.
 * Used for HKDF info and AEAD AAD construction (spec §6.3).
 */
export function encode(...fields: EncodeField[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const field of fields) {
    const bytes = fieldBytes(field);
    if (bytes.byteLength > 0xffffffff) {
      throw new RangeError("Encode: field longer than uint32");
    }
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, bytes.byteLength, false);
    parts.push(head, bytes);
    total += head.byteLength + bytes.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** UUID hyphenated form -> 16 raw bytes. */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new TypeError("uuidToBytes: not a UUID");
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 16 raw bytes -> UUID hyphenated form (lowercase). */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) throw new TypeError("bytesToUuid: need 16 bytes");
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}
