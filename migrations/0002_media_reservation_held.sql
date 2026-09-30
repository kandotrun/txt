-- Additive rollout: old workers ignore this flag and retain their existing accounting.
-- Legacy active rows are normalized to 1 only by the new deleting-state claim.
-- Legacy deleting rows may already have released their reservation: leave them 0.
ALTER TABLE media ADD COLUMN reservation_held INTEGER NOT NULL DEFAULT 0
  CHECK (reservation_held IN (0, 1));
