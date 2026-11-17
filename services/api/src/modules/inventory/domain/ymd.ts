// Strict 'YYYY-MM-DD' calendar-date check (A.D.). Never throws; rejects 2026-02-30, 2026-13-45, trailing newline, time parts.
export function isValidYmd(v: unknown): v is string {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}
