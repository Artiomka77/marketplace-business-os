WB Profit + Dashboard + Telegram unified update

Files:
- lib/analytics/profitAnalytics.ts
- lib/telegram/dailyReport.ts
- scripts/enrich_wb_sale_spp_vat.js

What changes:
- /profit-wb continues to use WB Sales economics: seller price, SPP, WB realized amount, seller payout, commission/compensation, costs, ads, taxes.
- For old already-loaded WbSale rows where commission VAT was missing, a fallback 22% of WB commission before VAT is used.
- Telegram daily report and Dashboard now use getProfitAnalytics() for WB sales, ad spend and net profit after tax, so WB values are calculated from the same source/formula as /profit-wb.
- DB enrichment script fills missing SPP/VAT columns for already-loaded rows without reloading reports from WB API.
