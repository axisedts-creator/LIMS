// C3 T-06 — orderable search ranking (02-TRD §7.9) and LIKE escaping (REQ-SEC-082, AC-08.2).
// Rank: exact code = 0, code prefix = 1, name prefix = 2, name contains = 3; then length(code), then code.

/** Escapes `\`, `%`, `_` so the result is a literal operand for LIKE/ILIKE … ESCAPE '\'. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

export function rankOf(row: { code: string; name: string }, q: string): 0 | 1 | 2 | 3 | undefined {
  const t = q.trim();
  const upper = t.toUpperCase();
  if (row.code === upper) return 0;
  if (row.code.startsWith(upper)) return 1;
  const name = row.name.toLowerCase(), lower = t.toLowerCase();
  if (name.startsWith(lower)) return 2;
  if (name.includes(lower)) return 3;
  return undefined;
}

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function rankOrderables<T extends { code: string; name: string }>(rows: readonly T[], q: string, limit: number): T[] {
  return rows
    .map((r) => ({ r, k: rankOf(r, q) }))
    .filter((x): x is { r: T; k: 0 | 1 | 2 | 3 } => x.k !== undefined)
    .sort((a, b) => a.k - b.k || a.r.code.length - b.r.code.length || byCode(a.r.code, b.r.code))
    .slice(0, Math.max(0, limit))
    .map((x) => x.r);
}
