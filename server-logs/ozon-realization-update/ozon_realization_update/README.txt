# Ozon realization / discount points update

Этот пакет добавляет первый безопасный слой данных для Ozon:

1. OzonRealizationSummary / OzonRealizationRow — ежемесячный отчёт реализации.
2. OzonDiscountPointsSummary / OzonDiscountPointsRow — отчёт начисления и списания баллов / соинвест Ozon.
3. Скрипт SQL-патча для production DB без Prisma migrate.
4. Скрипт загрузки двух Excel-отчётов.
5. Диагностический скрипт сверки OzonFinance против отчёта реализации.

Profit Ozon на этом этапе ещё не переключается на новую формулу автоматически.
Сначала нужно загрузить данные и сверить цифры, чтобы не сломать прибыль.
