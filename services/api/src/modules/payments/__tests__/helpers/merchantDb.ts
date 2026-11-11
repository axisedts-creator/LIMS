// PG-T17 test fixture: in-memory fake of `ctx.tx.query` for payments.merchant_accounts, payments.settings and audit.access_log
// (05-SCHEMA §1 constraints copied by name). The repo has no payments migration yet, so the fake is the integration seam (same approach as
// catalog/__tests__/helpers/*Db.ts). Synthetic data only.
// Dialect the writer's SQL must stay inside (anything else throws "fake: unsupported SQL"):
//   SELECT <cols|*> FROM <table> [WHERE c AND c ...] [ORDER BY col [ASC|DESC][, ...]] [LIMIT n] [FOR UPDATE]
//   INSERT INTO <table> (cols) VALUES (exprs) [ON CONFLICT [(cols)] DO NOTHING] [RETURNING cols|*]
//   UPDATE <table> SET col = expr[, ...] WHERE c AND c ... [RETURNING cols|*]
//   cond  := col (=|<>|!=) expr | col IS [NOT] NULL | col IS [NOT] DISTINCT FROM expr | col = ANY($n)   (no OR, no parentheses, no sub-selects)
//   expr  := $n[::type] | now() | NULL | true | false | integer | 'text' | col | col + integer
// Modelled: RLS (rows of other tenants invisible; INSERT with a foreign tenant_id -> 42501), NOT NULL (23502), UNIQUE (23505), CHECK (23514), version/defaults,
// writes private to the transaction until COMMIT (run() with rollback:true discards them), node-pg types (timestamptz -> Date, bytea -> Buffer).
import { randomUUID } from 'node:crypto';
import { access } from '../../../../core/audit/access.js';

export type Row = Record<string, any>;
export const TENANT_A = '01930000-0000-7000-8000-00000000000a';
export const TENANT_B = '01930000-0000-7000-8000-00000000000b';
export const USER = '01930000-0000-7000-8000-0000000000c1';
export const NOW = new Date(Date.UTC(2026, 10, 11, 6, 0, 0));
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const pgError = (code: string, message: string, constraint?: string): Error => Object.assign(new Error(message), { code, constraint });

const TABLES = {
  'payments.merchant_accounts': ['id', 'tenant_id', 'gateway', 'environment', 'is_enabled', 'esewa_product_code', 'khalti_website_url', 'secret_ciphertext', 'secret_nonce',
    'secret_auth_tag', 'secret_kek_id', 'secret_fingerprint', 'secret_set_at', 'secret_set_by', 'api_refunds_enabled', 'last_test_outcome', 'last_test_at', 'version',
    'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  'payments.settings': ['tenant_id', 'refund_two_person_threshold_paisa', 'purchase_order_label', 'reconciliation_enabled', 'version', 'is_active', 'created_at',
    'created_by', 'updated_at', 'updated_by'],
  'audit.access_log': ['id', 'tenant_id', 'centre_id', 'actor_id', 'actor_type', 'membership_id', 'support_session_id', 'action', 'entity_type', 'entity_id', 'purpose_code',
    'outcome', 'detail', 'request_id', 'created_by'],
} as const;
type Table = keyof typeof TABLES;
const NOT_NULL: Record<Table, string[]> = {
  'payments.merchant_accounts': ['id', 'tenant_id', 'gateway', 'environment', 'is_enabled', 'api_refunds_enabled', 'version', 'is_active', 'created_by', 'updated_by'],
  'payments.settings': ['tenant_id', 'refund_two_person_threshold_paisa', 'purchase_order_label', 'reconciliation_enabled', 'version', 'is_active', 'created_by', 'updated_by'],
  'audit.access_log': ['id', 'tenant_id', 'actor_id', 'actor_type', 'action', 'entity_type', 'outcome', 'detail', 'request_id', 'created_by'],
};
const DEFAULTS: Record<Table, () => Row> = {
  'payments.merchant_accounts': () => ({ is_enabled: false, api_refunds_enabled: false, version: 1, is_active: true }),
  'payments.settings': () => ({ refund_two_person_threshold_paisa: 0, purchase_order_label: 'Lab payment', reconciliation_enabled: true, version: 1, is_active: true }),
  'audit.access_log': () => ({}),
};
const nn = (v: unknown): boolean => v !== null && v !== undefined;

function checks(t: Table, r: Row): string | undefined {            // returns the violated constraint name
  if (t === 'payments.settings') {
    if (!(Number(r.refund_two_person_threshold_paisa) >= 0)) return 'settings__threshold__ck';
    if (!/^[A-Za-z0-9 .,&()-]{1,50}$/.test(String(r.purchase_order_label))) return 'settings__label__ck';
    return undefined;
  }
  if (t !== 'payments.merchant_accounts') return undefined;
  if (!['esewa', 'khalti', 'fonepay'].includes(r.gateway)) return 'merchant_accounts__gateway__ck';
  if (!['uat', 'production'].includes(r.environment)) return 'merchant_accounts__env__ck';
  if (r.gateway === 'fonepay' && r.is_enabled) return 'merchant_accounts__fonepay_off__ck';
  if (nn(r.esewa_product_code) && !(r.gateway === 'esewa' && /^[A-Za-z0-9_-]{1,64}$/.test(r.esewa_product_code))) return 'merchant_accounts__esewa_code__ck';
  if (nn(r.khalti_website_url) && !(r.gateway === 'khalti' && /^https:\/\//.test(r.khalti_website_url) && r.khalti_website_url.length <= 300)) return 'merchant_accounts__khalti_url__ck';
  const secretCols = ['secret_ciphertext', 'secret_nonce', 'secret_auth_tag', 'secret_kek_id', 'secret_fingerprint'];
  const none = secretCols.every((c) => !nn(r[c]));
  const all = nn(r.secret_ciphertext) && r.secret_nonce?.length === 12 && r.secret_auth_tag?.length === 16 && /^[A-Za-z0-9_-]{1,32}$/.test(String(r.secret_kek_id)) && /^[0-9a-f]{8}$/.test(String(r.secret_fingerprint));
  if (!none && !all) return 'merchant_accounts__secret_shape__ck';
  if (r.is_enabled && !(nn(r.secret_ciphertext) && ((r.gateway === 'esewa' && nn(r.esewa_product_code)) || (r.gateway === 'khalti' && nn(r.khalti_website_url))))) return 'merchant_accounts__enabled_complete__ck';
  if (r.api_refunds_enabled && r.gateway !== 'khalti') return 'merchant_accounts__api_refunds__ck';
  if (nn(r.last_test_outcome) && !['reachable_key_valid', 'reachable_key_unverifiable', 'auth_failed', 'unreachable'].includes(r.last_test_outcome)) return 'merchant_accounts__test__ck';
  return undefined;
}
const uniq = (t: Table, rows: Row[], r: Row, self?: Row): string | undefined => {
  const dup = (f: (x: Row) => boolean) => rows.some((x) => x !== self && f(x));
  if (t === 'payments.merchant_accounts') {
    if (dup((x) => x.id === r.id)) return 'merchant_accounts__pk';
    if (dup((x) => x.tenant_id === r.tenant_id && x.gateway === r.gateway && x.environment === r.environment)) return 'merchant_accounts__slot__uq';
  }
  if (t === 'payments.settings' && dup((x) => x.tenant_id === r.tenant_id)) return 'settings__pk';
  return undefined;
};

// ---------------------------------------------------------------- expression / condition evaluation
const unsupported = (sql: string): never => { throw new Error(`fake: unsupported SQL: ${sql.slice(0, 160)}`); };
const stripCasts = (s: string) => s.replace(/::\s*[a-z_]+(\[\])?/gi, '');
const splitTop = (s: string, sep: RegExp): string[] => s.split(sep).map((x) => x.trim()).filter(Boolean);
function evalExpr(e: string, vals: readonly unknown[], row: Row | undefined, now: Date, sql: string): unknown {
  const x = e.trim();
  let m: RegExpMatchArray | null;
  if ((m = x.match(/^\$(\d+)$/))) return vals[Number(m[1]) - 1];
  if (/^now\(\)$/i.test(x) || /^(clock_timestamp|statement_timestamp|transaction_timestamp)\(\)$/i.test(x)) return now;
  if (/^null$/i.test(x)) return null;
  if (/^true$/i.test(x)) return true;
  if (/^false$/i.test(x)) return false;
  if (/^-?\d+$/.test(x)) return Number(x);
  if ((m = x.match(/^'((?:[^']|'')*)'$/))) return m[1]!.replaceAll("''", "'");
  if ((m = x.match(/^(?:[a-z_]+\.)?([a-z_]+)\s*\+\s*(\d+)$/i)) && row) return Number(row[m[1]!]) + Number(m[2]);
  if ((m = x.match(/^(?:[a-z_]+\.)?([a-z_]+)$/i)) && row && m[1]! in row) return row[m[1]!];
  return unsupported(sql);
}
const same = (a: unknown, b: unknown): boolean => {
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
};
function matches(where: string | undefined, vals: readonly unknown[], row: Row, now: Date, sql: string): boolean {
  if (!where) return true;
  return splitTop(stripCasts(where), /\s+and\s+/i).every((c) => {
    let m: RegExpMatchArray | null;
    const col = (n: string) => row[n.split('.').pop()!];
    if ((m = c.match(/^([\w.]+)\s+IS\s+(NOT\s+)?NULL$/i))) return (m[2] ? nn(col(m[1]!)) : !nn(col(m[1]!)));
    if ((m = c.match(/^([\w.]+)\s+IS\s+(NOT\s+)?DISTINCT\s+FROM\s+(.+)$/i))) { const eq = same(col(m[1]!) ?? null, evalExpr(m[3]!, vals, row, now, sql) ?? null); return m[2] ? eq : !eq; }
    if ((m = c.match(/^([\w.]+)\s*=\s*ANY\s*\(\s*\$(\d+)\s*\)$/i))) return ((vals[Number(m[2]) - 1] as unknown[]) ?? []).some((v) => same(col(m![1]!), v));
    if ((m = c.match(/^([\w.]+)\s*(=|<>|!=)\s*(.+)$/))) {
      const l = col(m[1]!); const r = evalExpr(m[3]!, vals, row, now, sql);
      if (!nn(l) || !nn(r)) return false;                                  // SQL three-valued logic: comparison with NULL is never true
      return m[2] === '=' ? same(l, r) : !same(l, r);
    }
    return unsupported(sql);
  });
}

// ---------------------------------------------------------------- the fake
export interface Stmt { text: string; values: unknown[]; tenantId: string }
export interface AccessRow { action: string; entityType: string; entityId?: string; outcome: string; detail: Record<string, unknown> }

export function makeMerchantDb(seed: { merchant_accounts?: Row[]; settings?: Row[] } = {}) {
  const store: Record<Table, Row[]> = {
    'payments.merchant_accounts': (seed.merchant_accounts ?? []).map((r) => ({ ...r })),
    'payments.settings': (seed.settings ?? []).map((r) => ({ ...r })),
    'audit.access_log': [],
  };
  const stmts: Stmt[] = [];
  const logs: unknown[] = [];

  function makeTx(tenantId: string, work: Record<Table, Row[]>) {
    return {
      async query(text: string, values: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
        stmts.push({ text, values: [...values], tenantId });
        const sql = stripCasts(text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, ''));
        const now = NOW;
        const tbl = (n: string): Table => { const k = n.toLowerCase() as Table; if (!(k in TABLES)) unsupported(text); return k; };
        const project = (rows: Row[], cols: string | undefined) => (!cols ? [] : cols.trim() === '*' ? rows.map((r) => ({ ...r })) : rows.map((r) => Object.fromEntries(
          splitTop(cols, /,/).map((c) => { const [e, a] = c.split(/\s+as\s+/i); return [(a ?? e!).trim().split('.').pop()!, r[e!.trim().split('.').pop()!]]; }))));
        let m: RegExpMatchArray | null;

        if ((m = sql.match(/^select (.+?) from ([\w.]+)(?: where (.+?))?(?: order by (.+?))?(?: limit (\d+))?(?: for update)?$/i))) {
          const t = tbl(m[2]!);
          let rows = work[t].filter((r) => r.tenant_id === tenantId && matches(m![3], values, r, now, text));
          if (m[4]) for (const o of [...splitTop(m[4], /,/)].reverse()) {
            const [c, d] = o.split(/\s+/); const desc = /desc/i.test(d ?? '');
            rows = [...rows].sort((a, b) => (a[c!.split('.').pop()!] > b[c!.split('.').pop()!] ? 1 : a[c!.split('.').pop()!] < b[c!.split('.').pop()!] ? -1 : 0) * (desc ? -1 : 1));
          }
          if (m[5]) rows = rows.slice(0, Number(m[5]));
          const out = project(rows, m[1]);
          return { rows: out, rowCount: out.length };
        }
        if ((m = sql.match(/^insert into ([\w.]+) \(([^)]+)\) values \((.+?)\)(?: on conflict(?: \([^)]*\))? do nothing)?(?: returning (.+))?$/i))) {
          const t = tbl(m[1]!);
          const cols = splitTop(m[2]!, /,/);
          const exprs = splitTop(m[3]!, /,(?![^(]*\))/);
          if (cols.length !== exprs.length) unsupported(text);
          const row: Row = { ...DEFAULTS[t]() };
          cols.forEach((c, i) => { if (!(TABLES[t] as readonly string[]).includes(c)) throw pgError('42703', `column "${c}" does not exist`); row[c] = evalExpr(exprs[i]!, values, undefined, now, text); });
          if (t !== 'audit.access_log') { row.created_at ??= now; row.updated_at ??= now; }
          for (const c of TABLES[t]) row[c] ??= null;
          if (row.tenant_id !== tenantId) throw pgError('42501', 'new row violates row-level security policy');
          const nul = NOT_NULL[t].find((c) => !nn(row[c]));
          if (nul) throw pgError('23502', `null value in column "${nul}"`);
          const dupe = uniq(t, work[t], row);
          if (dupe) { if (/on conflict/i.test(sql)) return { rows: [], rowCount: 0 }; throw pgError('23505', `duplicate key ${dupe}`, dupe); }
          const bad = checks(t, row);
          if (bad) throw pgError('23514', `violates check constraint ${bad}`, bad);
          work[t].push(row);
          const out = project([row], m[4]);
          return { rows: out, rowCount: 1 };
        }
        if ((m = sql.match(/^update ([\w.]+) set (.+?) where (.+?)(?: returning (.+))?$/i))) {
          const t = tbl(m[1]!);
          const sets = splitTop(m[2]!, /,(?![^(]*\))/).map((s) => { const k = s.match(/^([a-z_]+)\s*=\s*(.+)$/i); return k ? [k[1]!, k[2]!] as const : unsupported(text); });
          const hit = work[t].filter((r) => r.tenant_id === tenantId && matches(m![3], values, r, now, text));
          for (const r of hit) {
            const next: Row = { ...r };
            for (const [c, e] of sets) { if (!(TABLES[t] as readonly string[]).includes(c)) throw pgError('42703', `column "${c}" does not exist`); next[c] = evalExpr(e, values, r, now, text); }
            const nul = NOT_NULL[t].find((c) => !nn(next[c]));
            if (nul) throw pgError('23502', `null value in column "${nul}"`);
            const dupe = uniq(t, work[t], next, r);
            if (dupe) throw pgError('23505', `duplicate key ${dupe}`, dupe);
            const bad = checks(t, next);
            if (bad) throw pgError('23514', `violates check constraint ${bad}`, bad);
            Object.assign(r, next);
          }
          const out = project(hit, m[4]);
          return { rows: out, rowCount: hit.length };
        }
        return unsupported(text);
      },
    };
  }

  /** Runs fn in one transaction for `tenantId`. The ctx has the real core `ctx.audit.access` (so its validation applies) writing audit.access_log on ctx.tx. */
  async function run<T>(fn: (ctx: any) => Promise<T>, o: { tenantId?: string; rollback?: boolean; permissions?: string[] } = {}): Promise<T> {
    const tenantId = o.tenantId ?? TENANT_A;
    const work = { 'payments.merchant_accounts': store['payments.merchant_accounts'].map((r) => ({ ...r })), 'payments.settings': store['payments.settings'].map((r) => ({ ...r })),
      'audit.access_log': store['audit.access_log'].map((r) => ({ ...r })) } as Record<Table, Row[]>;
    const tx = makeTx(tenantId, work);
    const ctx: any = { tenantId, requestId: randomUUID(), actor: { type: 'user', id: USER, membershipId: USER }, tx, now: () => NOW.toISOString(), permissions: o.permissions };
    ctx.audit = { access: (entry: any) => access(ctx, entry) };
    ctx.db = { tx: async (f: (c: any) => Promise<any>) => f(ctx) };
    const rec = (...a: unknown[]) => { logs.push(a); };
    ctx.log = { info: rec, warn: rec, error: rec, debug: rec };
    const out = await fn(ctx);
    if (!o.rollback) for (const t of Object.keys(store) as Table[]) store[t] = work[t];
    return out;
  }

  const accessRows = (tenantId = TENANT_A): AccessRow[] => store['audit.access_log'].filter((r) => r.tenant_id === tenantId).map((r) => ({
    action: r.action, entityType: r.entity_type, entityId: r.entity_id ?? undefined, outcome: r.outcome, detail: r.detail }));
  return {
    run, stmts, logs, accessRows,
    accounts: (tenantId = TENANT_A) => store['payments.merchant_accounts'].filter((r) => r.tenant_id === tenantId),
    settings: (tenantId = TENANT_A) => store['payments.settings'].filter((r) => r.tenant_id === tenantId),
    /** Every value the service ever sent to the database, flattened (Buffers also as utf8/base64/hex text) — for planted-secret scans. */
    sentText: (): string => stmts.map((s) => JSON.stringify(s.values.map((v) => (Buffer.isBuffer(v) ? `${v.toString('utf8')}|${v.toString('base64')}|${v.toString('hex')}` : v)))).join('\n'),
    /** Everything stored, flattened with the same Buffer treatment, EXCLUDING the secret ciphertext/nonce/tag columns themselves. */
    storedText: (): string => JSON.stringify(Object.values(store).flat().map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !/^secret_(ciphertext|nonce|auth_tag)$/.test(k))))),
  };
}
export type MerchantDb = ReturnType<typeof makeMerchantDb>;
export { UUIDV7 };
