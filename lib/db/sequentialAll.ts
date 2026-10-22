/**
 * Run async factories one-at-a-time, preserving Promise.all result order.
 * Required under certified Prisma/pg pool max=1: nested Promise.all of global
 * Prisma queries causes "timeout exceeded when trying to connect" on long ranges.
 */
export async function sequentialAll<const T extends readonly (() => Promise<unknown>)[]>(
  factories: T
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const factory of factories) {
    out.push(await factory());
  }
  return out as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
}
