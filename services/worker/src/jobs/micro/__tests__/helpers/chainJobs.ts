// C10 T-18 fixture: scripted JobContext for the three micro cron tasks (02-TRD §9; 05-SCHEMA §8; 07-SECURITY P-6). NO database.
// The fake `tx.query` is a RECORDER with canned answers; it does NOT evaluate WHERE. So the filters (active, older than 24 h, status, expires_at,
// NOT EXISTS) are proven by chainJobs.live.test.ts against the real DDL; this file pins the control flow around them.
// Canned answers (by statement text, case-insensitive, whitespace-collapsed):
//   SELECT … FROM micro.cultures [no GROUP BY, no count(*)]  -> `world.cultures` (rows as given, cut to the statement's LIMIT: literal or the bound value)
//   SELECT … FROM micro.cultures … GROUP BY …status…        -> `world.byStatus`        rows { status, n }
//   SELECT … FROM micro.cultures … count(*) (no GROUP BY)   -> `world.overdue`         one row { n }   (reads overdue)
//   SELECT … FROM micro.instrument_records … GROUP BY       -> `world.openRecords`     rows { match_status, n }
//   UPDATE/INSERT (any micro table)                          -> recorded, rowCount 1, rows [{ id }]
//   DELETE FROM micro.instrument_records                     -> rowCount = next of `world.deletes` (default 0)
//   anything else                                            -> throws "fake: unsupported SQL" (the writer adapts the SQL; this file is not widened for them)
// Count rows carry the number under n / count / c / total alike, so the SQL alias is free.
// ctx.metrics.inc(name, labels, n = 1) and ctx.metrics.set(name, value, labels) are recorded (worker metrics convention: core/cron.ts, jobs/instruments/maintenance.ts).
import type { JobContext } from '../../../../core/manifest.js';

export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const SYS = '0190a000-0000-7000-8000-0000000c1001';
export const CENTRE = '0190a000-0000-7000-8000-0000000ce001';
export const NOW = '2026-11-13T02:17:00.000Z';
export const u = (n: number) => `0190c60a-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export type Row = Record<string, any>;
export interface Stmt { readonly text: string; readonly params: unknown[] }
export interface World {
  cultures?: Row[]; byStatus?: Row[]; overdue?: number; openRecords?: Row[]; deletes?: number[];
  /** LabPort.getOrderResults: order id -> answer (items[{orderItemId, results[]}]); a function may throw. */
  orders?: Record<string, Row | ((i: Row) => Row)>;
  labFails?: string; deleteFails?: string;
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
const count = (n: number, extra: Row = {}) => ({ n, count: n, c: n, total: n, ...extra });

export function makeJob(world: World = {}, o: { tenantId?: string | undefined; noTenant?: boolean; attempt?: number; maxAttempts?: number } = {}) {
  const stmts: Stmt[] = [];
  const labCalls: Row[] = [];
  const logs: unknown[] = [];
  const incs: Array<{ name: string; labels: Row; n: number }> = [];
  const sets: Array<{ name: string; value: number; labels: Row }> = [];
  const deletes = [...(world.deletes ?? [])];
  const tenantId = o.noTenant ? undefined : 'tenantId' in o ? o.tenantId : TENANT_A;

  const tx = {
    async query(text: string, params: unknown[] = []) {
      stmts.push({ text, params });
      const sql = norm(text);
      if (/^SELECT/i.test(sql)) {
        if (/FROM (?:micro\.)?cultures\b/i.test(sql)) {
          if (/GROUP BY/i.test(sql)) return { rows: (world.byStatus ?? []).map((r) => ({ ...count(Number(r.n)), ...r })), rowCount: (world.byStatus ?? []).length };
          if (/count\(/i.test(sql)) return { rows: [count(world.overdue ?? 0)], rowCount: 1 };
          const lim = /LIMIT (?:(\d+)|\$(\d+))/i.exec(sql);
          const cap = lim ? Number(lim[1] ?? params[Number(lim[2]) - 1]) : Infinity;
          const rows = (world.cultures ?? []).slice(0, cap).map((r) => ({ ...r }));
          return { rows, rowCount: rows.length };
        }
        if (/FROM (?:micro\.)?instrument_records\b/i.test(sql) && /GROUP BY/i.test(sql)) {
          return { rows: (world.openRecords ?? []).map((r) => ({ ...count(Number(r.n)), ...r })), rowCount: (world.openRecords ?? []).length };
        }
        throw new Error(`fake: unsupported SQL ${sql.slice(0, 90)}`);
      }
      if (/^DELETE FROM (?:micro\.)?instrument_records\b/i.test(sql)) { if (world.deleteFails) throw Object.assign(new Error(world.deleteFails), { code: '42501' }); const n = deletes.shift() ?? 0; return { rows: [], rowCount: n }; }
      if (/^(UPDATE|INSERT INTO) (?:micro\.)?\w+/i.test(sql)) return { rows: [{ id: u(0xf0) }], rowCount: 1 };
      throw new Error(`fake: unsupported SQL ${sql.slice(0, 90)}`);
    },
  };

  const lab = {
    async getOrderResults(_c: unknown, i: Row) {
      labCalls.push(i);
      if (world.labFails) throw new Error(world.labFails);
      const a = world.orders?.[i['orderId']];
      if (a === undefined) return { orderId: i['orderId'], items: [], specimens: [], approvedSetHash: 'h' };
      return typeof a === 'function' ? a(i) : a;
    },
  };
  const ctx: any = {
    tenantId, actor: { type: 'system', id: SYS }, requestId: 'req-t18', tx, attempt: o.attempt ?? 1, maxAttempts: o.maxAttempts ?? 5, jobId: 'job-t18',
    now: () => NOW, isNewer: () => true, events: { publish() {} }, core: {}, files: {}, storage: {}, audit: { access: async () => undefined },
    metrics: { inc: (name: string, labels: Row = {}, n = 1) => { incs.push({ name, labels, n }); }, set: (name: string, value: number, labels: Row = {}) => { sets.push({ name, value, labels }); }, observe() {} },
    log: { info: (x: unknown) => logs.push(x), warn: (x: unknown) => logs.push(x), error: (x: unknown) => logs.push(x), debug: (x: unknown) => logs.push(x), child() { return this; } },
    ports: { LabPort: lab },
    db: { async tx<T>(fn: (c: JobContext) => Promise<T>): Promise<T> { return fn({ ...ctx, tx }); } },
  };
  const writes = () => stmts.filter((s) => /^\s*(insert|update|delete)\b/i.test(s.text));
  const only = (re: RegExp) => stmts.filter((s) => re.test(norm(s.text)));
  const run = async (handler: (p: any, c: JobContext) => Promise<void>, payload: Row = { tenant_id: TENANT_A }) => {
    try { await handler(payload, ctx as JobContext); return {} as { error?: unknown }; } catch (error) { return { error }; }
  };
  return { ctx: ctx as JobContext, stmts, labCalls, logs, incs, sets, writes, only, run, norm };
}

/** C5 order answer with ONE micro item: the line carries `status` and (optionally) a moduleRef to the culture. */
export const orderWith = (orderId: string, items: Array<{ orderItemId: string; lines: Array<{ status: string; cultureId?: string }> }>): Row => ({
  orderId, specimens: [], approvedSetHash: 'h',
  items: items.map((it) => ({ orderItemId: it.orderItemId, testId: u(0x71), departmentId: u(0x30),
    results: it.lines.map((l) => ({ status: l.status, ...(l.cultureId ? { moduleRef: { module: 'micro', entityId: l.cultureId, versionNo: 1 } } : {}) })) })),
});

/** A micro.cultures row as the reconcile SELECT may read it (every column the task might ask for; extra columns are harmless). */
export const culture = (n: number, o: Row = {}): Row => ({
  id: u(0xc00 + n), tenant_id: TENANT_A, centre_id: CENTRE, order_id: u(0x500 + (o['orderN'] ?? n)), order_item_id: u(0x600 + n), specimen_id: u(0x900 + n),
  status: 'incubating', current_report_version_no: 0, has_report: false, chain_cancelled: false, version: 3, cancel_reason_code: null,
  received_at: '2026-11-10T01:00:00.000Z', ...o,
});
