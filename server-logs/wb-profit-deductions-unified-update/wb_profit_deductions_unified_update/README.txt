WB profit deductions unified update

Что исправляет:
- WbFinance.otherDeductions больше не подставляется целиком в прибыль WB.
- Удержания WB классифицируются через deductionReason:
  ADS -> реклама WB, не дублируется с WB Ads;
  CREDIT -> WB-кредит, не входит в unit-экономику товара;
  OPERATING -> прочие операционные удержания, входят в прибыль;
  UNKNOWN -> показывается отдельно и не вычитается автоматически.
- Profit WB, Dashboard и Telegram используют getProfitAnalytics как единый источник WB-выручки, рекламы и прибыли.
- Для будущих WB Sales импортов сохраняется колонка «Виды логистики, штрафов и корректировок ВВ».
