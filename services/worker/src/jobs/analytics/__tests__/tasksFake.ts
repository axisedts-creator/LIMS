// AN-T06 test helper (not a test file): an in-memory world behind a JobContext for the analytics sweeps / self-check / purge / backfill tasks.
// It wraps the AN-T04 fake (marks, partition replace, locks, refresh bookkeeping) and adds the statements those tasks issue: dirty-mark inserts,
// app.enqueue_job, the self-check comparisons (R2/R3/R4), the backfill order_index seed, the report_backlog snapshot and the purge DELETEs.
// It never executes SQL: it classifies statements by their text (02-TRD §9.2-§9.5 shapes) and applies the spec'd effect to plain JS data.
// SEAMS the tasks must honour (documented in .orchestra/notes/AN-T06-tests.md):
//   - ctx = JobContext subset: tenantId, actor, tx.query, db.tx(fn({tx})), now() (INJECTED clock), log.warn(obj), metrics.inc(name, labels),
//     ports.IdentityPort.getTenantSettings(ctx, {keys}); the task may use ctx.tx or ctx.db.tx for the same statements.
//   - self-check: ONE read-only statement per (rule, family) that returns ONLY the mismatching business dates as rows `{ business_date: 'YYYY-MM-DD' }`
//     and binds (tenantId, from, to) with ISO dates, window [today-7, today) in Asia/Kathmandu.
import { FAMILIES, FAMILY_TABLE, SNAPSHOT_DATE, type Family } from '../../../../../api/src/modules/analytics/domain/families.js';
import { ACTOR, createCtx, createFakeDb, type HookArg } from '../../../../../api/src/modules/analytics/service/__tests__/refreshFake.js';

export { ACTOR, FAMILIES, FAMILY_TABLE, SNAPSHOT_DATE };
export type { Family };
export const TA = '01a1a98a-ac40-7000-8000-00000000a001', TB = '01a1a98a-ac40-7000-8000-00000000b001';
export const DATED = FAMILIES.filter((f) => f !== 'report_backlog') as Family[];
export const DAY = 86_400_000;
export const isoDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const localDate = (instant: string) => new Date(Date.parse(instant) + (5 * 60 + 45) * 60_000).toISOString().slice(0, 10);   // Asia/Kathmandu

// TRD §9.1: source views per family (R3 statements are recognised by "rollup table + one of its source views").
const SOURCE_VIEWS: Record<string, string[]> = {
  orders: ['frontdesk.v_pub_order_daily'], centre_volume: ['frontdesk.v_pub_centre_volume'], referrer_volume: ['frontdesk.v_pub_referrer_volume'],
  income: ['billing.v_pub_invoice_daily'], department_income: ['billing.v_pub_department_income'], collections: ['billing.v_pub_payment_collection'],
  referrer_billing: ['billing.v_pub_referrer_billing'], results: ['lab.v_pub_result_daily'], specimens: ['lab.v_pub_specimen_timeline'],
  rejections: ['lab.v_pub_rejection_daily'], critical_values: ['lab.v_pub_critical_value_daily'],
  tat: ['lab.v_pub_specimen_timeline', 'reporting.v_pub_order_report_tat'], releases: ['reporting.v_pub_report_release'],
  deliveries: ['reporting.v_pub_delivery_daily'], interface_messages: ['instruments.v_pub_message_daily'],
};
const tableRe = (t: string) => new RegExp(`analytics\\.${t}\\b`, 'i');

export const E_TABLES = ['order_index', 'refresh_runs', 'report_runs', 'report_run_recipients'] as const;
export const R_TABLES = DATED.map((f) => FAMILY_TABLE[f]);
export interface Row { id: string; tenant: string; expires_at?: string; requested_at?: string; business_date?: string }
export interface OrderRow { tenant: string; order_id: string; centre_id: string | null; branch_id: string | null; referrer_id: string | null; registered_at: string | null; registered_on: string | null; created_by: string; cancelled_at: string | null }
export interface ViewOrder { tenant: string; order_id: string; centre_id: string | null; registered_at: string; released?: boolean }

export function createWorld(opts: {
  now?: string; tenantId?: string | undefined; retentionYears?: unknown; failEnqueue?: boolean;
  hook?: (a: HookArg) => void | Promise<void>; marks?: NonNullable<Parameters<typeof createFakeDb>[0]>['marks'];
} = {}) {
  const fake = createFakeDb({ ...(opts.marks ? { marks: opts.marks } : {}), ...(opts.hook ? { hook: opts.hook } : {}) });
  const now0 = opts.now ?? '2026-11-08T08:00:00.000Z';
  fake.model.clock.now = now0; fake.model.hostClock.now = now0;
  let seq = 0;
  const w = {
    fake, model: fake.model,
    marksMade: [] as { seq: number; tenant: string; family: string; date: string; reason: string; actor: string }[],
    enqueued: [] as { seq: number; task: string; payload: any; values: unknown[]; text: string }[],
    compares: [] as { seq: number; rule: string; family: string; values: unknown[]; text: string }[],
    mismatches: new Map<string, string[]>(),            // `${rule}|${family}` -> mismatching business dates (injected)
    seeds: [] as { seq: number; from: string; to: string; text: string; values: unknown[] }[],
    viewOrders: [] as ViewOrder[], orderIndex: [] as OrderRow[],
    backlog: { orders: 0, seq: -1 },
    rows: Object.fromEntries([...E_TABLES, 'exports', 'export_files', ...R_TABLES].map((t) => [t, [] as Row[]])) as Record<string, Row[]>,
    purges: [] as { seq: number; table: string; deleted: number; text: string; values: unknown[] }[],
    purgeMode: false, backlogPurges: [] as string[],
    forbidden: [] as string[], unscoped: [] as string[], unbatched: [] as string[], otherStatements: [] as string[],
    texts: [] as string[],                              // every statement text seen, in order
    metrics: [] as { name: string; labels: Record<string, unknown> }[], warns: [] as any[], logs: [] as any[],
    setNow(iso: string) { fake.model.clock.now = iso; fake.model.hostClock.now = iso; },
    marksOf: (tenant?: string) => [...fake.model.marks.values()].filter((m) => !tenant || m.tenant === tenant),
    ctx: undefined as any,
  };

  async function mine(text: string, values: unknown[], base: () => Promise<any>): Promise<any> {
    const s = ++seq;
    w.texts.push(text);
    if (/^\s*INSERT\s+INTO\s+analytics\.dirty_partitions\b/i.test(text)) {
      const [tenant, family, date, reason, actor] = values as string[];
      w.marksMade.push({ seq: s, tenant: tenant!, family: family!, date: date!, reason: reason!, actor: actor! });
      const key = `${tenant}|${family}|${date}`, at = fake.model.clock.now, old = fake.model.marks.get(key);
      fake.model.marks.set(key, { tenant: tenant!, family: family!, date: date!, first: old?.first ?? at, last: at });
      return { rows: [], rowCount: 1 };
    }
    if (/app\.enqueue_job/i.test(text)) {
      if (opts.failEnqueue) throw Object.assign(new Error('enqueue failed'), { code: '57P01' });
      const task = /enqueue_job\(\s*'([\w.]+)'/i.exec(text)?.[1] ?? String(values[0]);
      const json = values.find((v) => typeof v === 'string' && v.trim().startsWith('{'));
      w.enqueued.push({ seq: s, task, payload: json ? JSON.parse(json as string) : undefined, values, text });
      return { rows: [{ enqueue_job: 1 }], rowCount: 1 };
    }
    if (/^\s*INSERT\s+INTO\s+analytics\.order_index\b[\s\S]*reporting\.v_pub_order_report_tat/i.test(text)) {
      const stamps = values.filter((v): v is string => typeof v === 'string' && (isoDay(v) || /^\d{4}-\d{2}-\d{2}T/.test(v)));
      const bound = (v: string) => (isoDay(v) ? Date.parse(`${v}T00:00:00Z`) - (5 * 60 + 45) * 60_000 : Date.parse(v));   // local midnight as instant
      const [from, to] = [stamps[0]!, stamps[1]!];
      w.seeds.push({ seq: s, from: from.slice(0, 10), to: to.slice(0, 10), text, values });
      const overwrite = /DO\s+UPDATE/i.test(text);
      let n = 0;
      for (const v of w.viewOrders) {
        if (v.tenant !== values[0] || Date.parse(v.registered_at) < bound(from) || Date.parse(v.registered_at) >= bound(to)) continue;
        const have = w.orderIndex.find((o) => o.tenant === v.tenant && o.order_id === v.order_id);
        const row: OrderRow = { tenant: v.tenant, order_id: v.order_id, centre_id: v.centre_id, branch_id: null, referrer_id: null, registered_at: v.registered_at,
          registered_on: localDate(v.registered_at), created_by: values.find((x) => x === ACTOR) as string ?? '?', cancelled_at: null };
        if (!have) { w.orderIndex.push(row); n++; } else if (overwrite) { Object.assign(have, row); n++; }
      }
      return { rows: [], rowCount: n };
    }
    if (/^\s*INSERT\s+INTO\s+analytics\.report_backlog\b/i.test(text)) {
      const out = await base();
      const days = Number(values.find((v) => typeof v === 'number') ?? 30), since = Date.parse(fake.model.clock.now) - days * DAY;
      w.backlog = { seq: s, orders: w.orderIndex.filter((o) => o.tenant === values[0] && !o.cancelled_at && o.registered_at && Date.parse(o.registered_at) >= since
        && !w.viewOrders.some((v) => v.order_id === o.order_id && v.released)).length };
      return out;
    }
    if (/^\s*(WITH|SELECT)\b/i.test(text) && /analytics\.(daily_|tat_facts)/i.test(text)) {
      const fams = DATED.filter((f) => tableRe(FAMILY_TABLE[f]).test(text));
      let rule = '', family = '';
      if (tableRe('daily_department_income').test(text) && tableRe('daily_income').test(text)) { rule = 'R2'; family = 'department_income'; }
      else if (fams.length === 1 && SOURCE_VIEWS[fams[0]!]!.some((v) => text.includes(v))) { rule = 'R3'; family = fams[0]!; }
      else if (fams.length === 1 && fams[0] === 'collections') { rule = 'R4'; family = 'collections'; }
      if (rule) {
        const days = values.filter((v): v is string => typeof v === 'string' && isoDay(v));
        w.compares.push({ seq: s, rule, family, values, text });
        const bad = (w.mismatches.get(`${rule}|${family}`) ?? []).filter((d) => days.length < 2 || (d >= days[0]! && d < days[1]!));
        return { rows: bad.map((business_date) => ({ business_date })), rowCount: bad.length };
      }
    }
    const del = /^\s*DELETE\s+FROM\s+analytics\.(\w+)/i.exec(text)?.[1];
    if (del && del !== 'dirty_partitions' && w.purgeMode) {   // purge tests: every other DELETE is a retention DELETE
      if (del === 'report_backlog') { w.backlogPurges.push(text); return { rows: [], rowCount: 0 }; }
      if (!(del in w.rows)) { w.forbidden.push(del); return { rows: [], rowCount: 0 }; }
      return purgeDelete(s, del, text, values);
    }
    return base();
  }

  function purgeDelete(s: number, table: string, text: string, values: unknown[]) {
    const tenant = values.find((v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) as string | undefined;
    if (tenant === undefined) { w.unscoped.push(text); return { rows: [], rowCount: 0 }; }
    const lim = /LIMIT\s+(\d+|\$(\d+))/i.exec(text);
    if (!lim) w.unbatched.push(text);
    const limit = lim ? (lim[2] ? Number(values[Number(lim[2]) - 1]) : Number(lim[1])) : Infinity;
    const nowMs = Date.parse(fake.model.clock.now);
    const day = values.find((v): v is string => typeof v === 'string' && isoDay(v)) ?? /'(\d{4}-\d{2}-\d{2})'/.exec(text)?.[1];
    const rows = w.rows[table] ?? [];
    let n = 0;
    for (let i = 0; i < rows.length && n < limit; i++) {
      const r = rows[i]!;
      if (r.tenant !== tenant) continue;
      const gone = table === 'exports' ? Date.parse(r.requested_at!) < nowMs - 400 * DAY
        : table in w.rows && r.business_date !== undefined ? day !== undefined && r.business_date < day
        : Date.parse(r.expires_at!) < nowMs;
      if (gone) { rows.splice(i--, 1); n++; }
    }
    w.purges.push({ seq: s, table, deleted: n, text, values });
    return { rows: [], rowCount: n };
  }

  const baseCtx = createCtx(fake, { tenantId: 'tenantId' in opts ? opts.tenantId : TA });
  const wrapTx = (base: { query: (t: string, v?: unknown[]) => Promise<any> } | undefined) =>
    ({ query: (t: string, v: unknown[] = []) => mine(t, v, async () => (base ? base.query(t, v) : { rows: [], rowCount: 0 })) });
  const db = { tx: <T>(fn: (c: any) => Promise<T>) => fake.db.tx((c: any) => fn({ tx: wrapTx(c.tx) })) };
  w.ctx = {
    ...baseCtx, db,
    tx: wrapTx(undefined),
    now: () => fake.model.hostClock.now,
    log: { info(o: unknown) { w.logs.push(o); }, warn(o: unknown) { w.warns.push(o); w.logs.push(o); }, error(o: unknown) { w.logs.push(o); }, debug() {} },
    metrics: { inc(name: string, labels: Record<string, unknown> = {}) { w.metrics.push({ name, labels }); }, set() {}, observe() {} },
    ports: { IdentityPort: { getTenantSettings: async (_c: unknown, input: { keys: readonly string[] }) => ({ retentionYears: 'retentionYears' in opts ? opts.retentionYears : 5, ...(input ? {} : {}) }) } },
  };
  return w;
}
export type World = ReturnType<typeof createWorld>;

/** Number of statements the tasks issued (tx-level) before anything else happened. */
export const statements = (w: World) => w.fake.log.length + w.texts.length;
