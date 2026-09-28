/**
 * Europe/Moscow business-date helpers for the loans canonical read model.
 * Scoped to loan-state surfaces — not a global date refactor.
 */

export const LOAN_BUSINESS_TIMEZONE = "Europe/Moscow";

const moscowDateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: LOAN_BUSINESS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD in Europe/Moscow. */
export function toMoscowDateKey(date: Date): string {
  return moscowDateKeyFormatter.format(date);
}

/** YYYY-MM in Europe/Moscow. */
export function toMoscowMonthKey(date: Date): string {
  return toMoscowDateKey(date).slice(0, 7);
}

export function getMoscowBusinessDateKey(now: Date = new Date()): string {
  return toMoscowDateKey(now);
}

export function compareMoscowDateKeys(a: string, b: string): number {
  return a.localeCompare(b);
}

export function addDaysToMoscowDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const utcNoon = new Date(Date.UTC(year, month - 1, day, 12));
  utcNoon.setUTCDate(utcNoon.getUTCDate() + days);
  return toMoscowDateKey(utcNoon);
}

export function moscowDateKeyToUtcNoon(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

export function startOfMoscowMonthKey(monthKey: string): string {
  return `${monthKey}-01`;
}

export function endOfMoscowMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0, 12));
  return toMoscowDateKey(lastDay);
}

export function parsePeriodToMoscowMonthKey(
  period: string | null | undefined,
  fallbackNow: Date = new Date(),
): string {
  if (period && /^\d{4}-\d{2}$/.test(period)) {
    return period;
  }
  return toMoscowMonthKey(fallbackNow);
}
