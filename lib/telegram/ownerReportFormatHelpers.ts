import {
  formatCompactMoney,
  formatPercent,
} from "@/lib/telegram/dailyReport";

/**
 * Owner-report presentation helpers.
 * Kept outside sealed dailyReport.ts so Financial Core hashes stay intact.
 */

export function formatCompactSignedMoney(value: number) {
  if (value > 0) return `+${formatCompactMoney(value)}`;
  if (value < 0) return formatCompactMoney(value);
  return formatCompactMoney(0);
}

function formatPercentChange(value: number | null, inverse = false) {
  if (value === null || !Number.isFinite(value)) return "нет базы";
  if (value === 0) return "0.0%";

  const sign = value > 0 ? "+" : "";
  const marker = inverse
    ? value < 0
      ? "🟢"
      : "🔴"
    : value > 0
      ? "🟢"
      : "🔴";

  return `${marker} ${sign}${formatPercent(value)}`;
}

function formatPointDiff(value: number | null, inverse = true) {
  if (value === null || !Number.isFinite(value)) return "нет базы";
  if (value === 0) return "0.0 п.п.";

  const sign = value > 0 ? "+" : "";
  const marker = inverse
    ? value < 0
      ? "🟢"
      : "🔴"
    : value > 0
      ? "🟢"
      : "🔴";

  return `${marker} ${sign}${new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 1,
  }).format(value)} п.п.`;
}

export function compactChangeSuffix(percent: number | null, inverse = false) {
  if (percent === null || !Number.isFinite(percent)) return "";
  const formatted = formatPercentChange(percent, inverse);
  if (formatted === "нет базы") return "";
  return ` ${formatted}`;
}

export function compactPointSuffix(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "";
  const formatted = formatPointDiff(value, true);
  if (formatted === "нет базы") return "";
  return ` ${formatted}`;
}
