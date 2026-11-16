// T0B-SWEEP-1 review item 1: first log line or stack of a failure. The shared logger writes `level` as a string label
// (packages/shared-ts/src/logger/index.ts:99), pino numbers are still accepted. sendProblem logs `request_failed` with error_code/err_name only.
const LV: Record<string, number> = { warn: 40, error: 50, fatal: 60 };

export function failureDetail(logLines: string[], fallback?: string): string {
  const kept: any[] = [];
  for (const l of logLines) {
    let o: any;
    try { o = JSON.parse(l); } catch { continue; }
    if (o && (typeof o.level === 'number' ? o.level : LV[o.level] ?? 0) >= 40) kept.push(o);
  }
  const first = kept.find((o) => o.err) ?? kept[0];
  if (!first) return String(fallback ?? '');
  const text = first.err?.stack ?? first.err?.message ?? [first.msg, first.error_code, first.err_name].filter(Boolean).join(' ');
  return String(text).split('\n').slice(0, 3).join(' / ');
}
