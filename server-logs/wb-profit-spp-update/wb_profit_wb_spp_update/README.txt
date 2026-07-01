WB Profit SPP update

Changed files:
- prisma/schema.prisma
- prisma/migrations/20260701193000_add_wb_sales_spp_commission_fields/migration.sql
- lib/import/normalizers/wbSalesNormalizer.ts
- lib/wb/syncWb.ts
- lib/analytics/profitAnalytics.ts
- app/profit-wb/page.tsx

Main calculation change:
- WB tax/DRR revenue = WbSale.wbRealizedAmount / WbFinance.salesAmount.
- Seller price before SPP = retailPriceWithDiscount / retailPrice.
- SPP WB = seller price before SPP - WB realized amount.
- Commission/compensation WB can be negative and is shown separately.
- Management margin now starts from sellerPayout, then subtracts COGS, logistics, storage, acceptance, penalties, deductions, ads and taxes.
- Commission/compensation WB, payment services, PVZ and platform discounts are not deducted twice because they are already inside sellerPayout.
