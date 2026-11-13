// PG-T16 test fixture: in-memory fake of `ctx.tx.query` for billing.v_pub_payment_collection (C4 view, read only, seeded) and
// payments.static_qr_reconciliations (05-SCHEMA §static QR worksheet: columns, GENERATED difference_paisa, CHECK / partial-unique names copied).
// Separate from merchantDb.ts on purpose (that fake is shared by other tasks). Synthetic data only.
// Dialect the writer's SQL must stay inside (anything else throws "fake: unsupported SQL"):
//   SELECT <*|cols|[COALESCE(]SUM(col)[, 0)] [AS a], ...> FROM billing.v_pub_payment_collection WHERE c AND c ...      (aggregates: no GROUP BY, no mixing with plain columns)
//   SELECT <*|cols> FROM payments.static_qr_reconciliations [WHERE c AND c ...] [ORDER BY col [ASC|DESC][, ...]] [LIMIT n] [FOR UPDATE]
//   INSERT INTO payments.static_qr_reconciliations (cols) VALUES (exprs) [ON CONFLICT [(cols)] [WHERE ...] DO NOTHING] [RETURNING cols|*]
//   cond := col (=|<>|!=|<|<=|>|>=) expr | col IS [NOT] NULL      expr := $n[::type] | now() | NULL | integer | 'text'      (no OR, no parentheses, no sub-selects, no BETWEEN)
// Modelled like node-pg: SUM() of bigint/int -> decimal STRING, bigint columns -> STRING, date -> Date, RLS (other tenants invisible; INSERT with a foreign
// tenant -> 42501), NOT NULL 23502, CHECK 23514, partial UNIQUE 23505, FK centre 23503, GENERATED column cannot be written 428C9, int parse 22P02.
// Transactions are serialised (a later run() starts from the earlier committed state): row-lock races themselves are only provable on a real DB.
import { randomUUID } from 'node:crypto';

export type Row = Record<string, any>;
export const TENANT_A = '01930000-0000-7000-8000-00000000000a';
export const TENANT_B = '01930000-0000-7000-8000-00000000000b';
export const USER = '01930000-0000-7000-8000-0000000000c1';
export const OTHER_USER = '01930000-0000-7000-8000-0000000000c2';
export const CENTRE_1 = '01930000-0000-7000-8000-0000000000e1';
export const CENTRE_2 = '01930000-0000-7000-8000-0000000000e2';
export const CENTRE_B = '01930000-0000-7000-8000-0000000000eb';   // a centre of tenant B
export const NOW = new Date(Date.UTC(2026, 10, 11, 6, 0, 0));

const VIEW = 'billing.v_pub_payment_collection';
const WS = 'payments.static_qr_reconciliations';
const WS_COLS = ['id', 'tenant_id', 'business_date', 'centre_id', 'system_entries', 'system_total_paisa', 'statement_total_paisa', 'difference_paisa', 'statement_reference', 'status',
  'note', 'reconciled_by', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const WS_NOT_NULL = ['id', 'tenant_id', 'business_date', 'system_entries', 'system_total_paisa', 'statement_total_paisa', 'statement_reference', 'status', 'reconciled_by', 'version', 'is_active', 'created_by', 'updated_by'];
const INT_COLS = ['system_entries', 'system_total_paisa', 'statement_total_paisa', 'version'];
const BIGINT_OUT = new Set(['system_total_paisa', 'statement_total_paisa', 'difference_paisa']);

export const pgError = (code: string, message: string, constraint?: string): Error => Object.assign(new Error(message), { code, constraint });
const unsupported = (sql: string): never => { throw new Error(`fake: unsupported SQL: ${sql.slice(0, 200)}`); };
const nn = (v: unknown): boolean => v !== null && v !== undefined;
const stripCasts = (s: string): string => s.replace(/::\s*[a-z_]+(\[\])?/gi, '');
const splitTop = (s: string, sep: string): string[] => {           // split on `sep` outside parentheses
  const out: string[] = []; let depth = 0; let cur = '';
  for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
const day = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
const norm = (col: string, v: unknown): unknown => (col === 'business_date' && nn(v) ? day(v) : v);

function evalExpr(e: string, vals: readonly unknown[], now: Date, sql: string): unknown {
  const x = e.trim(); let m: RegExpMatchArray | null;
  if ((m = x.match(/^\$(\d+)$/))) return vals[Number(m[1]) - 1];
  if (/^now\(\)$/i.test(x)) return now;
  if (/^null$/i.test(x)) return null;
  if (/^-?\d+$/.test(x)) return Number(x);
  if ((m = x.match(/^'((?:[^']|'')*)'$/))) return m[1]!.replaceAll("''", "'");
  return unsupported(sql);
}
function matches(where: string | undefined, vals: readonly unknown[], row: Row, now: Date, sql: string): boolean {
  if (!where) return true;
  return splitTop(where.replace(/\s+and\s+/gi, '\u0000'), '\u0000').every((c) => {
    let m: RegExpMatchArray | null;
    const col = (n: string): string => n.split('.').pop()!;
    if ((m = c.match(/^([\w.]+)\s+IS\s+(NOT\s+)?NULL$/i))) return m[2] ? nn(row[col(m[1]!)]) : !nn(row[col(m[1]!)]);
    if ((m = c.match(/^([\w.]+)\s*(<>|!=|<=|>=|=|<|>)\s*(.+)$/))) {
      const name = col(m[1]!); const l = norm(name, row[name]); const r = norm(name, evalExpr(m[3]!, vals, now, sql));
      if (!nn(l) || !nn(r)) return false;                          // three-valued logic: comparing with NULL is never true
      const cmp = typeof l === 'number' || /^-?\d+$/.test(String(l)) && /^-?\d+$/.test(String(r)) ? Number(l) - Number(r) : String(l) < String(r) ? -1 : String(l) > String(r) ? 1 : 0;
      return m[2] === '=' ? cmp === 0 : m[2] === '<>' || m[2] === '!=' ? cmp !== 0 : m[2] === '<' ? cmp < 0 : m[2] === '<=' ? cmp <= 0 : m[2] === '>' ? cmp > 0 : cmp >= 0;
    }
    return unsupported(sql);
  });
}

const wsChecks = (r: Row): string | undefined => {
  if (!(r.system_entries >= 0 && Number(r.system_total_paisa) >= 0 && Number(r.statement_total_paisa) >= 0)) return 'static_qr__amounts__ck';
  if (!(typeof r.statement_reference === 'string' && r.statement_reference.length >= 1 && r.statement_reference.length <= 100)) return 'static_qr__ref__ck';
  if (!['matched', 'accepted_with_difference'].includes(r.status)) return 'static_qr__status__ck';
  if ((r.status === 'matched') !== (Number(r.statement_total_paisa) === Number(r.system_total_paisa))) return 'static_qr__status__ck';
  if (r.status !== 'matched' && !nn(r.note)) return 'static_qr__status__ck';
  if (nn(r.note) && r.note.length > 1000) return 'static_qr__note__ck';
  return undefined;
};

export interface ViewRow { tenant_id: string; branch_id?: string | null; centre_id?: string | null; business_date: string; collected_by_membership_id?: string | null; payment_method_code: string;
  entries: number; reversals?: number; gross_collected_paisa?: number; reversed_paisa?: number; net_collected_paisa: number }
/** One billing.v_pub_payment_collection row (a day x collector x method group). */
export const viewRow = (o: Partial<ViewRow> & Pick<ViewRow, 'business_date' | 'payment_method_code' | 'entries' | 'net_collected_paisa'>): ViewRow =>
  ({ tenant_id: TENANT_A, branch_id: null, centre_id: CENTRE_1, collected_by_membership_id: USER, reversals: 0, gross_collected_paisa: o.net_collected_paisa, reversed_paisa: 0, ...o });

export function makeStaticQrDb(seed: { view?: ViewRow[]; worksheets?: Row[]; centres?: { tenant_id: string; id: string }[] } = {}) {
  const store = {
    view: (seed.view ?? []).map((r) => ({ ...r })),
    ws: (seed.worksheets ?? []).map((r) => ({ ...r })),
    centres: (seed.centres ?? [{ tenant_id: TENANT_A, id: CENTRE_1 }, { tenant_id: TENANT_A, id: CENTRE_2 }, { tenant_id: TENANT_B, id: CENTRE_B }]).map((r) => ({ ...r })),
  };
  const stmts: { text: string; values: unknown[]; tenantId: string }[] = [];
  const access: unknown[] = [];
  let chain: Promise<unknown> = Promise.resolve();

  const out = (rows: Row[]): Row[] => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k,
    BIGINT_OUT.has(k) && nn(v) ? String(v) : k === 'business_date' && nn(v) ? new Date(`${day(v)}T00:00:00.000Z`) : v])));

  function makeTx(tenantId: string, work: typeof store, clock: () => Date) {
    return {
      async query(text: string, values: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
        stmts.push({ text, values: [...values], tenantId });
        const sql = stripCasts(text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, ''));
        const now = clock(); let m: RegExpMatchArray | null;

        if ((m = sql.match(new RegExp(`^select (.+?) from ${VIEW.replace('.', '\\.')}(?: where (.+))?$`, 'i')))) {
          const rows = work.view.filter((r) => r.tenant_id === tenantId && matches(m![2], values, r, now, text));     // RLS (security_invoker) + the writer's own predicates
          const items = splitTop(m[1]!, ',');
          const aggs = items.map((it) => it.match(/^coalesce\(\s*sum\(\s*(\w+)\s*\)\s*,\s*0\s*\)(?:\s+as\s+(\w+))?$/i) ?? it.match(/^sum\(\s*(\w+)\s*\)(?:\s+as\s+(\w+))?$/i));
          if (aggs.every(Boolean)) {
            const rec = Object.fromEntries(aggs.map((a, i) => {
              const total = rows.reduce((s, r) => s + Number((r as Row)[a![1]!]), 0);
              const coalesced = /^coalesce/i.test(items[i]!);
              return [a![2] ?? 'sum', rows.length === 0 && !coalesced ? null : String(total)];       // numeric -> string, like node-pg
            }));
            return { rows: [rec], rowCount: 1 };
          }
          if (aggs.some(Boolean)) unsupported(text);
          const cols = m[1]!.trim();
          const res = rows.map((r) => (cols === '*' ? { ...r } : Object.fromEntries(splitTop(cols, ',').map((c) => { const k = c.split(/\s+as\s+/i); return [(k[1] ?? k[0]!).trim(), (r as Row)[k[0]!.trim()]]; }))));
          return { rows: res, rowCount: res.length };
        }

        if ((m = sql.match(new RegExp(`^select (.+?) from ${WS.replace('.', '\\.')}(?: where (.+?))?(?: order by (.+?))?(?: limit (\\d+))?(?: for update)?$`, 'i')))) {
          let rows = work.ws.filter((r) => r.tenant_id === tenantId && matches(m![2], values, r, now, text));
          if (m[3]) for (const o of splitTop(m[3], ',').reverse()) {
            const [c, d] = o.split(/\s+/); const sgn = /desc/i.test(d ?? '') ? -1 : 1; const k = c!.split('.').pop()!;
            rows = [...rows].sort((a, b) => (norm(k, a[k])! > norm(k, b[k])! ? 1 : norm(k, a[k])! < norm(k, b[k])! ? -1 : 0) * sgn);
          }
          if (m[4]) rows = rows.slice(0, Number(m[4]));
          const cols = m[1]!.trim();
          const res = out(cols === '*' ? rows.map((r) => ({ ...r })) : rows.map((r) => Object.fromEntries(splitTop(cols, ',').map((c) => { const k = c.split(/\s+as\s+/i); return [(k[1] ?? k[0]!).trim(), r[k[0]!.trim()]]; }))));
          return { rows: res, rowCount: res.length };
        }

        if ((m = sql.match(new RegExp(`^insert into ${WS.replace('.', '\\.')} \\(([^)]+)\\) values \\((.+?)\\)(?: on conflict(?: \\([^)]*\\))?(?: where .+?)? do nothing)?(?: returning (.+))?$`, 'i')))) {
          const cols = splitTop(m[1]!, ','); const exprs = splitTop(m[2]!, ',');
          if (cols.length !== exprs.length) unsupported(text);
          const row: Row = Object.fromEntries(WS_COLS.map((c) => [c, null]));
          Object.assign(row, { version: 1, is_active: true, created_at: now, updated_at: now });
          cols.forEach((c, i) => {
            if (c === 'difference_paisa') throw pgError('428C9', 'cannot insert a non-DEFAULT value into column "difference_paisa"');
            if (!WS_COLS.includes(c)) throw pgError('42703', `column "${c}" does not exist`);
            row[c] = evalExpr(exprs[i]!, values, now, text);
          });
          for (const c of INT_COLS) if (nn(row[c]) && !(typeof row[c] === 'number' ? Number.isSafeInteger(row[c]) : /^-?\d+$/.test(String(row[c])))) throw pgError('22P02', `invalid input syntax for type integer: "${row[c]}"`);
          for (const c of INT_COLS) if (nn(row[c])) row[c] = Number(row[c]);
          if (nn(row.business_date) && !/^\d{4}-\d\d-\d\d$/.test(day(row.business_date))) throw pgError('22007', 'invalid input syntax for type date');
          if (nn(row.business_date)) row.business_date = day(row.business_date);
          if (row.tenant_id !== tenantId) throw pgError('42501', 'new row violates row-level security policy');
          const nul = WS_NOT_NULL.find((c) => !nn(row[c]));
          if (nul) throw pgError('23502', `null value in column "${nul}"`);
          if (nn(row.centre_id) && !work.centres.some((c) => c.tenant_id === row.tenant_id && c.id === row.centre_id)) throw pgError('23503', 'violates foreign key constraint static_qr__centre__fk', 'static_qr__centre__fk');
          row.difference_paisa = Number(row.statement_total_paisa) - Number(row.system_total_paisa);
          const bad = wsChecks(row);
          if (bad) throw pgError('23514', `violates check constraint ${bad}`, bad);
          const dupe = work.ws.some((x) => x.id === row.id) ? 'static_qr__pk'
            : work.ws.some((x) => x.tenant_id === row.tenant_id && day(x.business_date) === row.business_date && (nn(row.centre_id) ? x.centre_id === row.centre_id : !nn(x.centre_id)))
              ? (nn(row.centre_id) ? 'static_qr__tenant_id_date_centre__p_uq' : 'static_qr__tenant_id_date_all__p_uq') : undefined;
          if (dupe) { if (/on conflict/i.test(sql)) return { rows: [], rowCount: 0 }; throw pgError('23505', `duplicate key value violates unique constraint ${dupe}`, dupe); }
          work.ws.push(row);
          const res = m[3] ? out([m[3].trim() === '*' ? { ...row } : Object.fromEntries(splitTop(m[3], ',').map((c) => [c.trim(), row[c.trim()]]))]) : [];
          return { rows: res, rowCount: 1 };
        }
        return unsupported(text);
      },
    };
  }

  /** Runs fn in one transaction for `tenantId` (default A). ctx.audit.access and every BillingPort/FrontdeskPort method are recorders: the worksheet must call none of them. */
  async function run<T>(fn: (ctx: any) => Promise<T>, o: { tenantId?: string; rollback?: boolean; now?: () => Date; actor?: Row } = {}): Promise<T> {
    const prev = chain; let release!: () => void;
    chain = new Promise<void>((r) => { release = r; });
    await prev;
    try {
      const tenantId = o.tenantId ?? TENANT_A; const clock = o.now ?? (() => NOW);
      const work = { view: store.view.map((r) => ({ ...r })), ws: store.ws.map((r) => ({ ...r })), centres: store.centres.map((r) => ({ ...r })) };
      const ctx: any = { tenantId, requestId: randomUUID(), actor: o.actor ?? { type: 'user', id: USER, membershipId: USER }, tx: makeTx(tenantId, work, clock), now: () => clock().toISOString() };
      ctx.audit = { access: async (e: unknown) => { access.push(e); } };
      ctx.ports = new Proxy({}, { get: (_t, port) => new Proxy({}, { get: (_t2, method) => async () => { access.push(`port:${String(port)}.${String(method)}`); throw new Error('worksheet must not call ports'); } }) });
      const res = await fn(ctx);
      if (!o.rollback) { store.ws = work.ws; }
      return res;
    } finally { release(); }
  }

  return {
    run, stmts, access,
    worksheets: (tenantId = TENANT_A): Row[] => store.ws.filter((r) => r.tenant_id === tenantId),
    /** arrange: add / replace view rows (the C4 ledger moves on between a preview and a save) */
    addView: (...rows: ViewRow[]): void => { store.view.push(...rows.map((r) => ({ ...r }))); },
    /** arrange: a stored worksheet (bypasses CHECKs on purpose); bigint-ish columns as numbers, the fake renders them as strings */
    putWorksheet: (r: Row): void => {
      store.ws.push({ ...Object.fromEntries(WS_COLS.map((c) => [c, null])), tenant_id: TENANT_A, version: 1, is_active: true, created_at: NOW, updated_at: NOW, reconciled_by: USER, created_by: USER, updated_by: USER,
        difference_paisa: Number(r['statement_total_paisa']) - Number(r['system_total_paisa']), ...r, business_date: day(r['business_date']) });
    },
  };
}
export type StaticQrDb = ReturnType<typeof makeStaticQrDb>;
