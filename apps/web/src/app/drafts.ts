/**
 * Local encrypted draft cache (spec §6.4, §10.6, §9.6).
 *
 * IndexedDB holds only ciphertext and the latest unsynced draft per
 * accountId/documentId/tab. Plaintext and keys are never written to
 * localStorage or sessionStorage. Drafts are encrypted with a per-save
 * `draftId` and separate `txt/v1/draft-key` / `txt/v1/draft` purpose names.
 */

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveDraftKey,
  draftAad,
  randomBytes,
} from "../../../../packages/protocol/src/crypto.ts";
import { fromBase64Url, toBase64Url } from "../../../../packages/protocol/src/base64url.ts";

const DB_NAME = "txt-drafts";
const DB_VERSION = 1;
const STORE = "drafts";

export interface DraftRecord {
  accountId: string;
  documentId: string;
  tabId: string;
  draftId: string;
  keyVersion: number;
  nonce: string;
  ciphertext: string;
  baseEtag: string | null;
  mutationId: string | null;
  savedAt: number;
  provisional: boolean;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: ["accountId", "documentId", "tabId"] });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
  });
}

function tx<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = fn(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
  });
}

/** Identity used to key the draft: tab-scoped so tabs never clobber each other. */
export function tabId(): string {
  const key = "txt-tab-id";
  let value = sessionStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    sessionStorage.setItem(key, value);
  }
  return value;
}

export async function saveDraft(options: {
  vaultKey: Uint8Array;
  accountId: string;
  documentId: string;
  plaintextDocument: string;
  baseEtag: string | null;
  mutationId: string | null;
  keyVersion: number;
  provisional: boolean;
  sceneId?: string;
}): Promise<void> {
  const draftId = crypto.randomUUID();
  const draftKey = await deriveDraftKey(
    options.vaultKey,
    draftId,
    options.accountId,
    options.documentId,
    options.keyVersion,
  );
  const aad = draftAad(
    options.accountId,
    options.documentId,
    options.sceneId ?? tabId(),
    1,
  );
  const nonce = randomBytes(12);
  const ciphertext = await aesGcmEncrypt(
    draftKey,
    nonce,
    new TextEncoder().encode(options.plaintextDocument),
    aad,
  );
  const record: DraftRecord = {
    accountId: options.accountId,
    documentId: options.documentId,
    tabId: options.sceneId ?? tabId(),
    draftId,
    keyVersion: options.keyVersion,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(ciphertext),
    baseEtag: options.baseEtag,
    mutationId: options.mutationId,
    savedAt: Date.now(),
    provisional: options.provisional,
  };
  const database = await openDatabase();
  await tx(database, "readwrite", (store) => store.put(record));
  database.close();
}

export async function loadDraft(options: {
  vaultKey: Uint8Array;
  accountId: string;
  documentId: string;
  keyVersion: number;
  sceneId?: string;
}): Promise<{ documentJson: string; baseEtag: string | null; mutationId: string | null; savedAt: number; provisional: boolean } | null> {
  const database = await openDatabase();
  const record = await tx<DraftRecord | undefined>(database, "readonly", (store) =>
    store.get([options.accountId, options.documentId, options.sceneId ?? tabId()]),
  );
  database.close();
  if (!record) return null;
  const draftKey = await deriveDraftKey(
    options.vaultKey,
    record.draftId,
    options.accountId,
    options.documentId,
    record.keyVersion,
  );
  const aad = draftAad(options.accountId, options.documentId, record.tabId, 1);
  try {
    const plaintext = await aesGcmDecrypt(
      draftKey,
      fromBase64Url(record.nonce),
      fromBase64Url(record.ciphertext),
      aad,
    );
    return {
      documentJson: new TextDecoder().decode(plaintext),
      baseEtag: record.baseEtag,
      mutationId: record.mutationId,
      savedAt: record.savedAt,
      provisional: record.provisional,
    };
  } catch {
    // A draft that cannot be decrypted is discarded rather than silently
    // treated as an empty document (spec §6.3).
    await clearDraft({
      accountId: options.accountId,
      documentId: options.documentId,
      sceneId: options.sceneId,
    });
    return null;
  }
}

export async function clearDraft(options: {
  accountId: string;
  documentId: string;
  sceneId?: string;
}): Promise<void> {
  const database = await openDatabase();
  await tx(database, "readwrite", (store) =>
    store.delete([options.accountId, options.documentId, options.sceneId ?? tabId()]),
  );
  database.close();
}

/** Removes every draft for an account (used on logout). */
export async function clearAccountDrafts(accountId: string): Promise<void> {
  const database = await openDatabase();
  const keys = await tx<IDBValidKey[]>(database, "readonly", (store) => store.getAllKeys());
  const transaction = database.transaction(STORE, "readwrite");
  const store = transaction.objectStore(STORE);
  for (const key of keys) {
    const parts = key as unknown as [string, string, string];
    if (parts[0] === accountId) store.delete(key);
  }
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("delete failed"));
  });
  database.close();
}
