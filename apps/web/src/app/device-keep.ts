/**
 * Device-kept vault key (spec §6.4).
 *
 * The VaultKey is normally memory-only, which forces a passkey ceremony on
 * every reload. With device keeping enabled (default 30 days, per Kan's
 * request) the key is stored in IndexedDB wrapped by a non-extractable AES-GCM
 * CryptoKey that the browser holds for this origin. The wrapper is:
 *
 * - created with `extractable: false`, so a script cannot read the raw key
 *   bytes; the crypto worker can only ask the browser to use it,
 * - origin-bound by definition (IndexedDB + WebCrypto key storage),
 * - deleted on explicit lock, logout, or when the retention window lapses.
 *
 * This raises the bar against exfiltration of stored bytes, but it is NOT a
 * defence against script that already runs in this origin: such script can ask
 * the browser to unwrap the key, exactly as the app does. The threat model is
 * recorded in spec §6.5 ("Webは配信JavaScriptを信頼する").
 */

const DB_NAME = "txt-device";
const DB_VERSION = 1;
const STORE = "vault";

import { DEVICE_KEEP_TTL_MS } from "../../../../packages/protocol/src/windows.ts";

/** Default retention: 30 days, extended on every successful unwrap. */
export const KEEP_TTL_MS = DEVICE_KEEP_TTL_MS;
/** Legacy records: the pre-keep format stored the key with no wrapper. */
const RECORD_VERSION = 2;

export interface KeepRecord {
  accountId: string;
  documentId: string;
  keyVersion: number;
  /** AES-GCM nonce used when wrapping with the device key. */
  nonce: string;
  /** VaultKey ciphertext (ciphertext||tag) wrapped by the device key. */
  wrapped: string;
  /** Unix ms when the retention window ends. */
  expiresAt: number;
  /** Unix ms of the last successful unwrap. */
  refreshedAt: number;
  version: number;
}

interface StoredRecord extends KeepRecord {
  /** The non-extractable device key (a CryptoKey, structured-cloneable). */
  deviceKey: CryptoKey;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "accountId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
  });
}

function request<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const idbRequest = fn(transaction.objectStore(STORE));
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error ?? new Error("indexedDB request failed"));
  });
}

function toBase64Url(bytes: Uint8Array): string {
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

function fromBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function createDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Stores the VaultKey for this device, wrapped by a non-extractable key.
 * Returns the expiry timestamp so the UI can explain the retention window.
 */
export async function keepVaultKey(options: {
  accountId: string;
  documentId: string;
  keyVersion: number;
  vaultKey: Uint8Array;
  ttlMs?: number;
}): Promise<number> {
  const database = await openDatabase();
  try {
    const existing = await request<StoredRecord | undefined>(database, "readonly", (store) =>
      store.get(options.accountId),
    );
    // Reuse the existing device key when possible so an interrupted rotation
    // does not orphan the previous record.
    const deviceKey = existing?.deviceKey ?? (await createDeviceKey());
    const now = Date.now();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, tagLength: 128 },
        deviceKey,
        options.vaultKey as BufferSource,
      ),
    );
    const record: StoredRecord = {
      accountId: options.accountId,
      documentId: options.documentId,
      keyVersion: options.keyVersion,
      nonce: toBase64Url(nonce),
      wrapped: toBase64Url(wrapped),
      expiresAt: now + (options.ttlMs ?? KEEP_TTL_MS),
      refreshedAt: now,
      version: RECORD_VERSION,
      deviceKey,
    };
    await request(database, "readwrite", (store) => store.put(record));
    return record.expiresAt;
  } finally {
    database.close();
  }
}

export interface KeptVault {
  vaultKey: Uint8Array;
  documentId: string;
  keyVersion: number;
  expiresAt: number;
}

/**
 * Unwraps the kept VaultKey when the retention window is still open, extending
 * the window on success. Returns null when nothing is kept, the record is
 * expired, or the record cannot be decrypted (tampered or from another origin).
 */
export async function loadKeptVaultKey(
  accountId: string,
  ttlMs: number = KEEP_TTL_MS,
): Promise<KeptVault | null> {
  const database = await openDatabase();
  try {
    const record = await request<StoredRecord | undefined>(database, "readonly", (store) =>
      store.get(accountId),
    );
    if (!record) return null;
    if (record.version !== RECORD_VERSION) {
      await request(database, "readwrite", (store) => store.delete(accountId));
      return null;
    }
    if (record.expiresAt <= Date.now()) {
      await request(database, "readwrite", (store) => store.delete(accountId));
      return null;
    }
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64Url(record.nonce) as BufferSource, tagLength: 128 },
        record.deviceKey,
        fromBase64Url(record.wrapped) as BufferSource,
      );
    } catch {
      // A record that cannot be unwrapped is removed rather than retried.
      await request(database, "readwrite", (store) => store.delete(accountId));
      return null;
    }
    const vaultKey = new Uint8Array(plaintext);
    if (vaultKey.byteLength !== 32) {
      await request(database, "readwrite", (store) => store.delete(accountId));
      return null;
    }
    // Extend the window on every successful use.
    const nextExpiry = Date.now() + ttlMs;
    await request(database, "readwrite", (store) =>
      store.put({ ...record, expiresAt: nextExpiry, refreshedAt: Date.now() }),
    );
    return {
      vaultKey,
      documentId: record.documentId,
      keyVersion: record.keyVersion,
      expiresAt: nextExpiry,
    };
  } finally {
    database.close();
  }
}

/** Removes the kept key for one account (explicit lock, logout, or forget). */
export async function forgetKeptVaultKey(accountId: string): Promise<void> {
  const database = await openDatabase();
  try {
    await request(database, "readwrite", (store) => store.delete(accountId));
  } finally {
    database.close();
  }
}

/** Removes every kept key on this device (used when leaving the account). */
export async function forgetAllKeptVaultKeys(): Promise<void> {
  const database = await openDatabase();
  try {
    await request(database, "readwrite", (store) => store.clear());
  } finally {
    database.close();
  }
}
