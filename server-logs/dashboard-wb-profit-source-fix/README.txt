Dashboard WB Profit Source Fix

Исправляет Dashboard:
- WB-продажи/начисления берутся из getProfitAnalytics.totals.revenue;
- WB-реклама берётся из getProfitAnalytics.totals.adsCost;
- WB-прибыль после налогов берётся из getProfitAnalytics.totals.netProfitAfterTax;
- поэтому Dashboard должен совпадать со страницей /profit-wb по WB за тот же период и компанию.

Файл:
- app/page.tsx
