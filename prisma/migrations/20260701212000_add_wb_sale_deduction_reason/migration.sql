ALTER TABLE "WbSale"
  ADD COLUMN IF NOT EXISTS "deductionReason" TEXT;

CREATE INDEX IF NOT EXISTS "WbSale_deductionReason_idx"
  ON "WbSale"("deductionReason");
