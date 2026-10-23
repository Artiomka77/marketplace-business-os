export type SearchParamValue = string | string[] | undefined;

/** Next.js may pass duplicate query keys as string[]. Always coerce to one scalar. */
export function firstSearchParam(
  value: SearchParamValue,
  fallback = "",
): string {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const trimmed = String(entry ?? "").trim();
      if (trimmed) return trimmed;
    }
    return fallback;
  }

  if (value == null) return fallback;
  const trimmed = String(value).trim();
  return trimmed || fallback;
}
