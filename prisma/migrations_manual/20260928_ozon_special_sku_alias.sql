-- Durable Ozon special SKU alias table (P0 COGS final closure)
CREATE TABLE IF NOT EXISTS "OzonSpecialSkuAlias" (
  "id" TEXT PRIMARY KEY,
  "companyName" TEXT NOT NULL,
  "ozonSku" TEXT NOT NULL,
  "canonicalVendorCode" TEXT NOT NULL,
  "baseNmId" TEXT,
  "offerId" TEXT,
  "productName" TEXT,
  "barcode" TEXT,
  "mappingEvidence" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'OZON_PRODUCT_INFO_API',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "OzonSpecialSkuAlias_companyName_ozonSku_key"
  ON "OzonSpecialSkuAlias" ("companyName", "ozonSku");
CREATE INDEX IF NOT EXISTS "OzonSpecialSkuAlias_ozonSku_idx"
  ON "OzonSpecialSkuAlias" ("ozonSku");
CREATE INDEX IF NOT EXISTS "OzonSpecialSkuAlias_canonicalVendorCode_idx"
  ON "OzonSpecialSkuAlias" ("canonicalVendorCode");
CREATE INDEX IF NOT EXISTS "OzonSpecialSkuAlias_baseNmId_idx"
  ON "OzonSpecialSkuAlias" ("baseNmId");
