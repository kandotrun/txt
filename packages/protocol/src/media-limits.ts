/** Web/API media limits (spec §11.1). MB/GB use decimal bytes. */
import { mediaCipherLength } from "./crypto.ts";

export const MEDIA_SIZE_LIMITS = {
  image: 100_000_000,
  audio: 100 * 1024 * 1024,
  video: 10_000_000_000,
} as const;

// The server does not learn media kind/MIME: enforce a common ciphertext cap.
export const MAX_MEDIA_CIPHER_BYTES = mediaCipherLength(MEDIA_SIZE_LIMITS.video);
