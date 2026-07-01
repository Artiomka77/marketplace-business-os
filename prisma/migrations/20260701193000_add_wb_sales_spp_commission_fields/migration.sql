ALTER TABLE "WbSale" ADD COLUMN IF NOT EXISTS "retailPriceWithDiscount" DECIMAL(65,30);
ALTER TABLE "WbSale" ADD COLUMN IF NOT EXISTS "sppDiscountAmount" DECIMAL(65,30);
ALTER TABLE "WbSale" ADD COLUMN IF NOT EXISTS "platformDiscountPercent" DECIMAL(65,30);
ALTER TABLE "WbSale" ADD COLUMN IF NOT EXISTS "wbRewardVat" DECIMAL(65,30);
ALTER TABLE "WbSale" ADD COLUMN IF NOT EXISTS "wbRewardTotal" DECIMAL(65,30);
ALTER TABLE "WbSale" ADD COLUMN IF NOT EXISTS "commissionPercentBase" DECIMAL(65,30);
ALTER TABLE "WbSale" ADD COLUMN IF NOT EXISTS "commissionPercentFinal" DECIMAL(65,30);
ALTER TABLE "WbSale" ADD COLUMN IF NOT EXISTS "loyaltyDiscountCompensation" DECIMAL(65,30);
ALTER TABLE "WbSale" ADD COLUMN IF NOT EXISTS "loyaltyParticipationCost" DECIMAL(65,30);
ALTER TABLE "WbSale" ADD COLUMN IF NOT EXISTS "loyaltyPointsAmount" DECIMAL(65,30);

UPDATE "WbSale"
SET "retailPriceWithDiscount" = "retailPrice"
WHERE "retailPriceWithDiscount" IS NULL
  AND "retailPrice" IS NOT NULL;

UPDATE "WbSale"
SET "sppDiscountAmount" = COALESCE("retailPriceWithDiscount", "retailPrice", 0) - COALESCE("wbRealizedAmount", 0)
WHERE "sppDiscountAmount" IS NULL
  AND ("retailPriceWithDiscount" IS NOT NULL OR "retailPrice" IS NOT NULL)
  AND "wbRealizedAmount" IS NOT NULL;

UPDATE "WbSale"
SET "wbRewardTotal" = COALESCE("wbReward", 0) + COALESCE("wbRewardVat", 0)
WHERE "wbRewardTotal" IS NULL
  AND ("wbReward" IS NOT NULL OR "wbRewardVat" IS NOT NULL);
