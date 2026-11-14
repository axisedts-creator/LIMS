// AN-T05 test helper (not a test file): an in-memory model of analytics.order_index + analytics.dirty_partitions + the enqueue call behind a fake `ctx.tx`.
// It never executes real SQL. It reads each INSERT's column list and VALUES items, evaluates the only expressions 02-TRD §8.2 uses
// (`$n[::type]`, literals, NULL, now(), `(… AT TIME ZONE 'Asia/Kathmandu')::date`, `… + interval '400 days'`) and applies the ON CONFLICT clause that the statement text names.
// Consumers may reach the tx through `ctx.tx` or `ctx.db.tx(fn)` (the same tx, as in the C0 wrapper). Everything a handler sends is logged in `log`.
export const TA = '01a1a98a-ac40-7000-8000-00000000a001';
export const TB = '01a1a98a-ac40-7000-8000-00000000b001';
export const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';          // the analytics system actor (job claims `sub`)
export const NOW = '2026-11-08T06:00:00.000Z';                          // DB clock == ctx.now()
export const SNAPSHOT = '1970-01-01';
export const DAY = 86_400_000;

/** Business date of an instant, Asia/Kathmandu = UTC+05:45 (no DST). */
export const bd = (iso: string): string => new Date(Date.parse(iso) + 345 * 60_000).toISOString().slice(0, 10);
const plus400 = (iso: string) => new Date(Date.parse(iso) + 400 * DAY).toISOString();

export interface OrderRow {
  tenant_id: string; order_id: string; centre_id: string | null; branch_id: string | null; referrer_id: string | null;
  registered_at: string | null; registered_on: string | null; cancelled_at: string | null;
  source_event_id: string | null; created_by: string | null; expires_at: string | null;
}
export interface DirtyRow { tenant_id: string; family: string; business_date: string; first_marked_at: string; last_marked_at: string; reason: unknown; created_by: unknown }
export interface Logged { i: number; text: string; values: unknown[]; kind: 'order_insert' | 'order_update' | 'order_select' | 'dirty_insert' | 'enqueue' | 'bd_select' | 'other' }

function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, quote = false, cur = '';
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (!quote) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; } }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}
function balanced(s: string, from: number): string {
  let depth = 0, quote = false;
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === '(') depth++;
    if (ch === ')') { depth--; if (depth === 0) return s.slice(from + 1, i); }
  }
  throw new Error('unbalanced parentheses in statement');
}
/** Evaluates one VALUES item. `undefined` = an expression this model does not know (the test then fails loudly on the missing column). */
function evalExpr(expr: string, values: unknown[], clock: string): unknown {
  const e = expr.trim();
  let m = /^\$(\d+)(?:::[\w ]+)?$/.exec(e);
  if (m) return values[Number(m[1]) - 1];
  if (/^NULL$/i.test(e)) return null;
  m = /^'([^']*)'$/.exec(e);
  if (m) return m[1];
  if (/^now\(\)$/i.test(e)) return clock;
  const p = /\$(\d+)/.exec(e);
  const base = (p ? values[Number(p[1]) - 1] : clock) as string;
  if (/AT TIME ZONE\s+'Asia\/Kathmandu'/i.test(e)) return bd(base);
  if (/interval\s+'400 days'/i.test(e)) return plus400(base);
  return undefined;
}
function parseInsert(text: string, table: string, values: unknown[], clock: string): Record<string, unknown> {
  const head = new RegExp(`INSERT\\s+INTO\\s+analytics\\.${table}\\s*\\(([^)]*)\\)\\s*VALUES\\s*`, 'i').exec(text);
  if (!head) throw new Error(`cannot parse INSERT INTO analytics.${table}`);
  const cols = head[1]!.split(',').map((c) => c.trim());
  const items = splitTop(balanced(text, head.index + head[0].length));
  const row: Record<string, unknown> = {};
  cols.forEach((c, i) => { row[c] = evalExpr(items[i] ?? '', values, clock); });
  return row;
}
const operand = (text: string, col: string, values: unknown[]) => {
  const m = new RegExp(`\\b${col}\\s*=\\s*\\$(\\d+)`, 'i').exec(text);
  return m ? values[Number(m[1]) - 1] : undefined;
};

export interface WorldOpts { now?: string; tenantId?: string | undefined; orders?: Partial<OrderRow>[]; marks?: { family: string; date: string }[]; failEnqueue?: boolean }

export function createWorld(opts: WorldOpts = {}) {
  const clock = opts.now ?? NOW;
  const orders = new Map<string, OrderRow>();
  const dirty = new Map<string, DirtyRow>();
  const log: Logged[] = [];
  const key = (t: unknown, o: unknown) => `${String(t)}|${String(o)}`;
  const dkey = (t: unknown, f: unknown, d: unknown) => `${String(t)}|${String(f)}|${String(d)}`;
  const blank = (t: string, o: string): OrderRow => ({ tenant_id: t, order_id: o, centre_id: null, branch_id: null, referrer_id: null, registered_at: null, registered_on: null, cancelled_at: null, source_event_id: null, created_by: null, expires_at: null });
  for (const o of opts.orders ?? []) { const r = { ...blank(o.tenant_id ?? TA, o.order_id!), ...o } as OrderRow; orders.set(key(r.tenant_id, r.order_id), r); }
  for (const m of opts.marks ?? []) dirty.set(dkey(TA, m.family, m.date), { tenant_id: TA, family: m.family, business_date: m.date, first_marked_at: '2026-11-07T00:00:00.000Z', last_marked_at: '2026-11-07T00:00:00.000Z', reason: 'event', created_by: ACTOR });

  const query = async (text: string, values: unknown[] = []) => {
    await new Promise<void>((r) => setImmediate(r));
    const entry: Logged = { i: log.length, text, values, kind: 'other' };
    log.push(entry);
    if (/^\s*INSERT\s+INTO\s+analytics\.order_index\b/i.test(text)) {
      entry.kind = 'order_insert';
      const row = parseInsert(text, 'order_index', values, clock);
      const k = key(row['tenant_id'], row['order_id']);
      const cur = orders.get(k);
      if (!cur) { orders.set(k, { ...blank(String(row['tenant_id']), String(row['order_id'])), ...row } as OrderRow); return { rows: [], rowCount: 1 }; }
      if (/ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i.test(text)) return { rows: [], rowCount: 0 };
      if (/ON\s+CONFLICT[\s\S]*DO\s+UPDATE/i.test(text)) {
        if (/WHERE[\s\S]*registered_on\s+IS\s+NULL/i.test(text) && cur.registered_on !== null) return { rows: [], rowCount: 0 };
        for (const c of ['centre_id', 'branch_id', 'referrer_id', 'registered_at', 'registered_on', 'expires_at'] as const) if (c in row) (cur as any)[c] = row[c];
        return { rows: [], rowCount: 1 };
      }
      throw Object.assign(new Error('duplicate key value violates unique constraint "order_index__pk"'), { code: '23505' });
    }
    if (/^\s*UPDATE\s+analytics\.order_index\b/i.test(text)) {
      entry.kind = 'order_update';
      const cur = orders.get(key(operand(text, 'tenant_id', values), operand(text, 'order_id', values)));
      const set = /SET\s+cancelled_at\s*=\s*(\$\d+(?:::\w+)?)/i.exec(text);
      if (!cur || !set || (/cancelled_at\s+IS\s+NULL/i.test(text.slice(text.search(/WHERE/i))) && cur.cancelled_at !== null)) return { rows: [], rowCount: 0 };
      cur.cancelled_at = evalExpr(set[1]!, values, clock) as string;
      return { rows: /RETURNING/i.test(text) ? [{ ...cur }] : [], rowCount: 1 };
    }
    if (/^\s*SELECT\b[\s\S]*\bFROM\s+analytics\.order_index\b/i.test(text)) {
      entry.kind = 'order_select';
      const cur = orders.get(key(operand(text, 'tenant_id', values), operand(text, 'order_id', values)));
      return { rows: cur ? [{ ...cur }] : [], rowCount: cur ? 1 : 0 };
    }
    if (/^\s*INSERT\s+INTO\s+analytics\.dirty_partitions\b/i.test(text)) {
      entry.kind = 'dirty_insert';
      const row = parseInsert(text, 'dirty_partitions', values, clock);
      const k = dkey(row['tenant_id'], row['family'], row['business_date']);
      const cur = dirty.get(k);
      if (cur) {
        if (!/ON\s+CONFLICT[\s\S]*DO\s+UPDATE/i.test(text)) throw Object.assign(new Error('duplicate key value violates unique constraint "dirty_partitions__pk"'), { code: '23505' });
        cur.last_marked_at = clock;
      } else dirty.set(k, { tenant_id: String(row['tenant_id']), family: String(row['family']), business_date: String(row['business_date']), first_marked_at: clock, last_marked_at: clock, reason: row['reason'], created_by: row['created_by'] });
      return { rows: [], rowCount: 1 };
    }
    if (/app\.enqueue_job/i.test(text)) {
      entry.kind = 'enqueue';
      if (opts.failEnqueue) throw Object.assign(new Error('enqueue failed'), { code: '57P01' });
      return { rows: [{ enqueue_job: 1 }], rowCount: 1 };
    }
    if (/^\s*SELECT\b/i.test(text) && /AT\s+TIME\s+ZONE\s+'Asia\/Kathmandu'/i.test(text) && !/\bFROM\b/i.test(text)) {
      entry.kind = 'bd_select';
      const p = /\$(\d+)/.exec(text);
      const v = bd(p ? (values[Number(p[1]) - 1] as string) : clock);
      return { rows: [{ business_date: v, bd: v, d: v, date: v, today: v }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const tx = { query, startedAt: new Date(clock) };
  const ctx: any = {
    tenantId: 'tenantId' in opts ? opts.tenantId : TA,
    actor: { type: 'system' as const, id: ACTOR }, requestId: 'req-an-t05', jobId: '1', attempt: 1, maxAttempts: 10,
    tx, now: () => clock, isNewer: () => true,
    log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
    events: {}, core: {}, storage: {}, files: {}, audit: {},
  };
  ctx.db = { tx: async (fn: (c: any) => Promise<unknown>) => fn(ctx) };

  const snapshot = () => ({ orders: structuredClone([...orders]), dirty: structuredClone([...dirty]) });
  return {
    ctx, log, orders, dirty,
    /** Sorted 'family@date' strings of every dirty mark. */
    marks: () => [...dirty.values()].map((d) => `${d.family}@${d.business_date}`).sort(),
    order: (id: string, tenant = TA) => orders.get(key(tenant, id)),
    enqueues: () => log.filter((l) => l.kind === 'enqueue'),
    /** Statements the model could not classify that still look like writes (a handler using an unexpected SQL shape fails loudly instead of silently). */
    unknownWrites: () => log.filter((l) => l.kind === 'other' && /^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(l.text)),
    /** The C0 consumer wrapper: one tx per delivery; a throw rolls every effect back. */
    async deliver(handler: (env: any, ctx: any) => Promise<void>, env: unknown): Promise<void> {
      const before = snapshot();
      try { await handler(env, ctx); } catch (e) {
        orders.clear(); dirty.clear();
        for (const [k, v] of before.orders) orders.set(k, v);
        for (const [k, v] of before.dirty) dirty.set(k, v);
        throw e;
      }
    },
  };
}
export type World = ReturnType<typeof createWorld>;

let seq = 0;
export const id = (n: number) => `0190c409-0000-7000-8000-${String(n).padStart(12, '0')}`;

export interface EnvOver { event_id?: string; tenant_id?: string; occurred_at?: string }
/** Full C0 event envelope (contracts/events/_envelope.v1) around `payload`. */
export function envelope(event_type: string, producer: string, aggType: string, aggId: string, payload: Record<string, unknown>, over: EnvOver = {}) {
  return {
    event_id: over.event_id ?? id(900000 + ++seq), event_type, tenant_id: over.tenant_id ?? TA, occurred_at: over.occurred_at ?? NOW,
    actor: { type: 'user', id: id(1) }, idempotency_key: `${event_type}:${aggId}:${seq}`, producer,
    aggregate: { type: aggType, id: aggId, seq: 1 }, request_id: id(2), payload,
  };
}
