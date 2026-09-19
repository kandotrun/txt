/**
 * Deterministic payload hash for idempotency (spec §10.3).
 *
 * `last_payload_hash` is computed from a deterministic `Encode` of format/key
 * version, encryptedRevision, nonce, ciphertext and the sorted reference set —
 * never from arbitrary JSON key ordering.
 */

import { encode, uuidToBytes } from "../../../../packages/protocol/src/encode.ts";
import { sha256 } from "../util.ts";
import type { DocumentUpdate } from "./store.ts";

export async function derivePayloadHash(input: {
  accountId: string;
  documentId: string;
  update: DocumentUpdate;
}): Promise<ArrayBuffer> {
  const { update } = input;
  const referenceBytes = encode(...update.referencedMediaIds.map((id) => uuidToBytes(id)));
  const material = encode(
    "txt/v1/payload",
    uuidToBytes(input.accountId),
    uuidToBytes(input.documentId),
    update.formatVersion,
    update.keyVersion,
    update.encryptedRevision,
    new Uint8Array(update.nonce),
    new Uint8Array(update.ciphertext),
    referenceBytes,
  );
  const digest = await sha256(material);
  return digest.buffer as ArrayBuffer;
}
