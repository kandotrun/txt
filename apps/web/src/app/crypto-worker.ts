/**
 * Crypto worker (spec §9.1, §9.8, §6.3).
 *
 * Heavy crypto (document encryption, media chunk encryption) is separated from
 * input handling so keystrokes are never blocked. The VaultKey lives only in
 * this worker's memory and in the main thread's memory during an unlocked
 * session; it is never persisted and never sent to the server.
 *
 * The draft cache is IndexedDB-backed and holds only ciphertext (spec §6.4).
 */

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  CHUNK_PLAIN_BYTES,
  deriveDocumentKey,
  documentAad,
  mediaChunkAad,
  mediaChunkNonce,
  randomBytes,
} from "../../../../packages/protocol/src/crypto.ts";
import { fromBase64Url, toBase64Url } from "../../../../packages/protocol/src/base64url.ts";
import { parseDocument, serializeDocument, validateDocument } from "../../../../packages/protocol/src/document.ts";
import type { DocumentModel, MediaInfo } from "../../../../packages/protocol/src/document.ts";

interface UnlockMessage {
  type: "unlock";
  /** Raw bytes (preferred) or base64url text. */
  vaultKey: Uint8Array | string;
  accountId: string;
  documentId: string;
  keyVersion: number;
}

interface LockMessage {
  type: "lock";
}

interface EncryptMessage {
  type: "encrypt-document";
  requestId: string;
  mutationId: string;
  encryptedRevision: number;
  formatVersion: number;
  keyVersion: number;
  documentJson: string;
}

interface DecryptMessage {
  type: "decrypt-document";
  requestId: string;
  mutationId: string;
  encryptedRevision: number;
  formatVersion: number;
  keyVersion: number;
  nonce: string;
  ciphertext: string;
}

interface EncryptChunkMessage {
  type: "encrypt-chunk";
  requestId: string;
  documentId: string;
  mediaId: string;
  fileKey: string;
  noncePrefix: string;
  cryptoFormat: number;
  totalPlainBytes: number;
  index: number;
  plaintext: ArrayBuffer;
}

interface DecryptChunkMessage {
  type: "decrypt-chunk";
  requestId: string;
  documentId: string;
  mediaId: string;
  fileKey: string;
  noncePrefix: string;
  cryptoFormat: number;
  totalPlainBytes: number;
  chunkPlainBytes: number;
  index: number;
  ciphertext: ArrayBuffer;
}

type Incoming =
  | UnlockMessage
  | LockMessage
  | EncryptMessage
  | DecryptMessage
  | EncryptChunkMessage
  | DecryptChunkMessage;

interface SessionKeys {
  vaultKey: Uint8Array;
  accountId: string;
  documentId: string;
  keyVersion: number;
}

let session: SessionKeys | null = null;

function requireSession(): SessionKeys {
  if (!session) throw new Error("locked");
  return session;
}

async function handleEncryptDocument(message: EncryptMessage): Promise<void> {
  const keys = requireSession();
  const snapshotKey = await deriveDocumentKey(
    keys.vaultKey,
    message.mutationId,
    keys.accountId,
    keys.documentId,
    message.keyVersion,
  );
  const aad = documentAad(
    message.formatVersion,
    message.keyVersion,
    keys.accountId,
    keys.documentId,
    message.mutationId,
    message.encryptedRevision,
  );
  const plaintext = new TextEncoder().encode(message.documentJson);
  const nonce = randomBytes(12);
  const ciphertext = await aesGcmEncrypt(snapshotKey, nonce, plaintext, aad);
  post({
    type: "encrypted-document",
    requestId: message.requestId,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(ciphertext),
  });
}

async function handleDecryptDocument(message: DecryptMessage): Promise<void> {
  const keys = requireSession();
  const snapshotKey = await deriveDocumentKey(
    keys.vaultKey,
    message.mutationId,
    keys.accountId,
    keys.documentId,
    message.keyVersion,
  );
  const aad = documentAad(
    message.formatVersion,
    message.keyVersion,
    keys.accountId,
    keys.documentId,
    message.mutationId,
    message.encryptedRevision,
  );
  try {
    const plaintext = await aesGcmDecrypt(
      snapshotKey,
      fromBase64Url(message.nonce),
      fromBase64Url(message.ciphertext),
      aad,
    );
    const issues = validateDocument(JSON.parse(new TextDecoder().decode(plaintext)));
    if (issues.length > 0) {
      post({
        type: "decrypt-failed",
        requestId: message.requestId,
        reason: `validation: ${issues.join("; ")}`,
      });
      return;
    }
    const document = parseDocument(plaintext);
    post({
      type: "decrypted-document",
      requestId: message.requestId,
      document,
    });
  } catch (error) {
    post({
      type: "decrypt-failed",
      requestId: message.requestId,
      reason: (error as Error).message,
    });
  }
}

async function handleEncryptChunk(message: EncryptChunkMessage): Promise<void> {
  requireSession();
  const fileKey = fromBase64Url(message.fileKey);
  const noncePrefix = fromBase64Url(message.noncePrefix);
  const plaintext = new Uint8Array(message.plaintext);
  const aad = mediaChunkAad(
    message.cryptoFormat,
    session?.accountId ?? "",
    message.documentId,
    message.mediaId,
    message.index,
    message.totalPlainBytes,
    plaintext.byteLength,
  );
  const nonce = mediaChunkNonce(noncePrefix, message.index);
  const ciphertext = await aesGcmEncrypt(fileKey, nonce, plaintext, aad);
  post({
    type: "encrypted-chunk",
    requestId: message.requestId,
    ciphertext: ciphertext.buffer,
  }, [ciphertext.buffer]);
}

async function handleDecryptChunk(message: DecryptChunkMessage): Promise<void> {
  requireSession();
  const fileKey = fromBase64Url(message.fileKey);
  const noncePrefix = fromBase64Url(message.noncePrefix);
  const aad = mediaChunkAad(
    message.cryptoFormat,
    session?.accountId ?? "",
    message.documentId,
    message.mediaId,
    message.index,
    message.totalPlainBytes,
    message.chunkPlainBytes,
  );
  const nonce = mediaChunkNonce(noncePrefix, message.index);
  const plaintext = await aesGcmDecrypt(
    fileKey,
    nonce,
    new Uint8Array(message.ciphertext),
    aad,
  );
  post(
    { type: "decrypted-chunk", requestId: message.requestId, plaintext: plaintext.buffer },
    [plaintext.buffer],
  );
}

function post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
  (self as unknown as { postMessage(data: unknown, transfer?: Transferable[]): void }).postMessage(
    message,
    transfer,
  );
}

self.addEventListener("message", (event: MessageEvent<Incoming>) => {
  const message = event.data;
  void (async () => {
    try {
      switch (message.type) {
        case "unlock": {
          const vaultKey =
            message.vaultKey instanceof Uint8Array
              ? message.vaultKey
              : fromBase64Url(message.vaultKey as string);
          session = {
            vaultKey,
            accountId: message.accountId,
            documentId: message.documentId,
            keyVersion: message.keyVersion,
          };
          post({ type: "unlocked" });
          break;
        }
        case "lock":
          session = null;
          post({ type: "locked" });
          break;
        case "encrypt-document":
          await handleEncryptDocument(message);
          break;
        case "decrypt-document":
          await handleDecryptDocument(message);
          break;
        case "encrypt-chunk":
          await handleEncryptChunk(message);
          break;
        case "decrypt-chunk":
          await handleDecryptChunk(message);
          break;
      }
    } catch (error) {
      post({
        type: "error",
        requestId: "requestId" in message ? message.requestId : undefined,
        reason: (error as Error).message,
      });
    }
  })();
});

export type { DocumentModel, MediaInfo };
