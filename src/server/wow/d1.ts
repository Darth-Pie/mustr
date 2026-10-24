/**
 * D1 caps every statement at 100 bound parameters ("too many SQL variables").
 * Multi-row INSERTs and long IN (…) lists blow past that at guild scale, so the
 * WoW code splits them with these helpers. Pure, so they're unit-tested.
 */

export const D1_MAX_PARAMS = 100;

/**
 * Split rows for multi-row INSERTs so no statement binds more than `max` values.
 * drizzle binds every defined value (null included) and writes DEFAULT for an
 * undefined one, so only defined values count.
 */
export function chunkByParams<T extends object>(rows: T[], max = D1_MAX_PARAMS): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const row of rows) {
    const n = Object.values(row).filter((v) => v !== undefined).length;
    if (cur.length && used + n > max) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(row);
    used += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
