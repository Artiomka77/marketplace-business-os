function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function getMoscowTodayNoon(now = new Date()) {
  const moscowNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);

  return new Date(
    Date.UTC(
      moscowNow.getUTCFullYear(),
      moscowNow.getUTCMonth(),
      moscowNow.getUTCDate(),
      12
    )
  );
}

/**
 * Последняя полностью завершённая неделя: понедельник — воскресенье.
 * Пример: если сегодня 2026-07-07, вернёт 2026-06-29 — 2026-07-05.
 */
export function getDefaultLastCompletedWeekRange(now = new Date()) {
  const today = getMoscowTodayNoon(now);
  const dayOfWeek = today.getUTCDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const currentWeekMonday = addUtcDays(today, -daysFromMonday);
  const previousWeekMonday = addUtcDays(currentWeekMonday, -7);
  const previousWeekSunday = addUtcDays(currentWeekMonday, -1);

  return {
    dateFrom: formatDateInput(previousWeekMonday),
    dateTo: formatDateInput(previousWeekSunday),
  };
}

/**
 * Текущий месяц по сегодня.
 */
export function getDefaultCurrentMonthRange(now = new Date()) {
  const today = getMoscowTodayNoon(now);
  const monthStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1, 12)
  );

  return {
    dateFrom: formatDateInput(monthStart),
    dateTo: formatDateInput(today),
  };
}

/**
 * Последние 30 дней, включая сегодня.
 */
export function getDefaultLast30DaysRange(now = new Date()) {
  const today = getMoscowTodayNoon(now);
  const dateFrom = addUtcDays(today, -29);

  return {
    dateFrom: formatDateInput(dateFrom),
    dateTo: formatDateInput(today),
  };
}
