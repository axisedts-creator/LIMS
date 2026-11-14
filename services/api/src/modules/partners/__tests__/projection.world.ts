// C13 T17 test world (tester-owned): an in-memory SQL world for the price-list / statement projections, their API handlers and the catalog.changed consumer.
// Not a test file (no *.test.ts suffix). It interprets ONLY the SQL subset below and throws "fake SQL: ..." on anything else, so a writer reads the failure and
// either stays inside the subset or raises a dispute. All data is synthetic.
//
// SQL SUBSET (all values bound as $n; the fake logs every statement in w.log):
//   SELECT <col | alias.col | col AS x | expr AS x | * | alias.*> [, ...] FROM <schema.table> [alias] [WHERE <expr>] [ORDER BY <expr> [ASC|DESC], ...] [LIMIT $n|int] [OFFSET $n|int] [FOR UPDATE]
//   INSERT INTO <t> (cols) VALUES (tuple)[, (tuple)...] [ON CONFLICT (cols) DO NOTHING | DO UPDATE SET c = <expr> [, ...]] [RETURNING cols]   (EXCLUDED.c allowed)
//   UPDATE <t> SET c = <expr> [, ...] WHERE <expr> [RETURNING cols]      DELETE FROM <t> WHERE <expr> [RETURNING cols]
//   SELECT app.enqueue_job($1, $2::jsonb, $3[, $4])                       (job_key replaces a pending job with the same key; $4 = run_at)
//   <expr>: AND/OR/NOT, ( ), = <> != < <= > >=, IS [NOT] NULL, [NOT] IN (..), [NOT] ILIKE|LIKE $n [ESCAPE '\'], = ANY($n), <> ALL($n), row values (a,b) < ($1,$2),
//           a + 1, ::casts (ignored), now(), lower(), upper(), coalesce(), starts_with(), to_char(date,'YYYY-MM'|'YYYY-MM-DD'), literals 'x' 1 NULL TRUE FALSE 'infinity'.
//   The partner lookup of partnerContext (FROM partners.partner_users pu JOIN ...) and its invited->active UPDATE are answered as in the T03 world.
// Column types follow node-pg defaults: bigint (*_paisa) is a STRING, timestamptz a Date, `date` a 'YYYY-MM-DD' string, integer a number.
// Writes are allowed only to partners.price_list_items / price_list_syncs / statement_months (05-SCHEMA §3.x CHECK, NOT NULL, PK, FK enforced; pg error codes 23502/23503/23505/23514).
import { LimsError } from '../../../core/errors.js';

export type Row = Record<string, any>;
export const id = (n: number) => `01940e00-0000-7000-8000-c1317${String(n).padStart(7, '0')}`;
export const T_A = id(1), T_B = id(2);
export const SYSTEM = id(3);
export const CP = { one: id(10), two: id(11), three: id(12), b: id(13) };
export const P = { x: id(20), y: id(21), z: id(22), b: id(23) };           // z is suspended; b belongs to tenant B
export const O = { t1: id(30), t2: id(31), t3: id(32), t4: id(33), p1: id(34), p2: id(35), unknown: id(36) };
export const PL = { cp1: id(40), cp1old: id(41), dflt: id(42), cp2: id(43), cp3: id(44), b: id(45) };
export const NOW = new Date('2026-11-13T00:00:00.000Z');
export const NOW_ISO = NOW.toISOString();
export const SYNCED = new Date('2026-11-12T20:00:00.000Z');
const pgErr = (code: string, constraint: string) => Object.assign(new Error(`${code} ${constraint}`), { code, constraint });

// ------------------------------------------------------------------ expression parser
type Env = { row?: Row; excluded?: Row; params: unknown[]; now: Date };
type Ev = (e: Env) => any;
const isStr = (t: string) => t.startsWith("'");
function tokenize(s: string): string[] {
  const out: string[] = []; let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let j = i + 1, t = "'";
      for (; j < s.length; j++) { if (s[j] === "'") { if (s[j + 1] === "'") { t += "'"; j++; continue; } break; } t += s[j]; }
      out.push(`${t}'`); i = j + 1; continue;
    }
    const m = /^(::|\[\]|<=|>=|<>|!=|\$\d+|[A-Za-z_][A-Za-z_0-9.]*|\d+(?:\.\d+)?|[(),=<>+\-*])/.exec(s.slice(i));
    if (!m) throw new Error(`fake SQL: cannot tokenize near "${s.slice(i, i + 30)}"`);
    out.push(m[0]); i += m[0].length;
  }
  return out;
}
const ms = (x: any): number => (x instanceof Date ? x.getTime() : x === 'infinity' ? Infinity : Date.parse(x));
const intLike = (x: any) => typeof x === 'number' || (typeof x === 'string' && /^-?\d+$/.test(x));
/** -1/0/1, or null when either side is NULL. */
function cmp(a: any, b: any): number | null {
  if (a == null || b == null) return null;
  if (Array.isArray(a) && Array.isArray(b)) { for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c !== 0) return c; } return 0; }
  if (a instanceof Date || b instanceof Date) { const x = ms(a), y = ms(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (intLike(a) && intLike(b)) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  return a < b ? -1 : a > b ? 1 : 0;
}
function likeToRe(p: string, esc: string, ci: boolean): RegExp {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === esc && i + 1 < p.length) { re += p[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    re += c === '%' ? '.*' : c === '_' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, ci ? 'is' : 's');
}
class Parser {
  p = 0;
  constructor(readonly t: string[]) {}
  peek(o = 0) { return this.t[this.p + o]; }
  kw(w: string, o = 0) { return this.peek(o)?.toUpperCase() === w; }
  eat(w?: string) { const x = this.t[this.p++]; if (w !== undefined && x?.toUpperCase() !== w) throw new Error(`fake SQL: expected ${w}, got ${x}`); return x!; }
  done() { return this.p >= this.t.length; }
  or(): Ev { let l = this.and(); while (this.kw('OR')) { this.eat(); const a = l, b = this.and(); l = (e) => { const x = a(e); if (x === true) return true; const y = b(e); return y === true ? true : x == null || y == null ? null : false; }; } return l; }
  and(): Ev { let l = this.not(); while (this.kw('AND')) { this.eat(); const a = l, b = this.not(); l = (e) => { const x = a(e); if (x === false) return false; const y = b(e); return y === false ? false : x == null || y == null ? null : true; }; } return l; }
  not(): Ev { if (this.kw('NOT')) { this.eat(); const a = this.not(); return (e) => { const x = a(e); return x == null ? null : !x; }; } return this.cmpx(); }
  cmpx(): Ev {
    const l = this.add();
    if (this.kw('IS')) { this.eat(); const neg = this.kw('NOT') && (this.eat(), true); this.eat('NULL'); return (e) => (l(e) == null) !== neg; }
    let neg = false;
    if (this.kw('NOT') && (this.kw('ILIKE', 1) || this.kw('LIKE', 1) || this.kw('IN', 1))) { this.eat(); neg = true; }
    const flip = (f: Ev): Ev => (neg ? (e) => { const x = f(e); return x == null ? null : !x; } : f);
    if (this.kw('ILIKE') || this.kw('LIKE')) {
      const ci = this.kw('ILIKE'); this.eat(); const r = this.add(); let esc = '\\';
      if (this.kw('ESCAPE')) { this.eat(); esc = this.eat().slice(1, -1); }
      return flip((e) => { const a = l(e), b = r(e); return a == null || b == null ? null : likeToRe(String(b), esc, ci).test(String(a)); });
    }
    if (this.kw('IN')) {
      this.eat(); this.eat('('); const items: Ev[] = [this.or()]; while (this.peek() === ',') { this.eat(); items.push(this.or()); } this.eat(')');
      return flip((e) => { const a = l(e); if (a == null) return null; return items.some((i) => cmp(a, i(e)) === 0); });
    }
    const op = this.peek();
    if (!op || !['=', '<>', '!=', '<', '<=', '>', '>='].includes(op)) return l;
    this.eat();
    const test = (c: number | null) => (c == null ? null : op === '=' ? c === 0 : op === '<>' || op === '!=' ? c !== 0 : op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0);
    if (this.kw('ANY') || this.kw('ALL')) {
      const all = this.kw('ALL'); this.eat(); this.eat('('); const r = this.or(); this.eat(')');
      return (e) => { const a = l(e), arr = r(e) as any[]; if (a == null || !Array.isArray(arr)) return null; const f = (x: any) => test(cmp(a, x)); return all ? arr.every((x) => f(x) === true) : arr.some((x) => f(x) === true); };
    }
    const r = this.add();
    return (e) => test(cmp(l(e), r(e)));
  }
  add(): Ev {
    let l = this.primary();
    while (this.peek() === '+' || this.peek() === '-') { const o = this.eat(), a = l, b = this.primary(); l = (e) => { const x = a(e), y = b(e); if (x == null || y == null) return null; return o === '+' ? Number(x) + Number(y) : Number(x) - Number(y); }; }
    return l;
  }
  primary(): Ev {
    let ev = this.atom();
    while (this.peek() === '::') { this.eat(); this.eat(); if (this.peek() === '[]') this.eat(); }
    return ev;
  }
  atom(): Ev {
    const t = this.eat();
    if (t === '(') {
      const items: Ev[] = [this.or()]; while (this.peek() === ',') { this.eat(); items.push(this.or()); } this.eat(')');
      return items.length === 1 ? items[0]! : (e) => items.map((i) => i(e));
    }
    if (isStr(t)) { const v = t.slice(1, -1); return () => v; }
    if (/^\d/.test(t)) { const v = Number(t); return () => v; }
    if (/^\$\d+$/.test(t)) { const n = Number(t.slice(1)); return (e) => { if (n > e.params.length) throw new Error(`fake SQL: $${n} has no value`); return e.params[n - 1]; }; }
    const u = t.toUpperCase();
    if (u === 'NULL') return () => null;
    if (u === 'TRUE') return () => true;
    if (u === 'FALSE') return () => false;
    if (this.peek() === '(') {
      this.eat(); const args: Ev[] = [];
      if (this.peek() !== ')') { args.push(this.or()); while (this.peek() === ',') { this.eat(); args.push(this.or()); } }
      this.eat(')');
      const f = t.toLowerCase();
      if (f === 'now') return (e) => e.now;
      if (f === 'lower') return (e) => { const x = args[0]!(e); return x == null ? null : String(x).toLowerCase(); };
      if (f === 'upper') return (e) => { const x = args[0]!(e); return x == null ? null : String(x).toUpperCase(); };
      if (f === 'coalesce') return (e) => { for (const a of args) { const x = a(e); if (x != null) return x; } return null; };
      if (f === 'starts_with') return (e) => { const a = args[0]!(e), b = args[1]!(e); return a == null || b == null ? null : String(a).startsWith(String(b)); };
      if (f === 'to_char') return (e) => { const a = args[0]!(e), fmt = args[1]!(e); const s = a instanceof Date ? a.toISOString() : String(a); return fmt === 'YYYY-MM' ? s.slice(0, 7) : fmt === 'YYYY-MM-DD' ? s.slice(0, 10) : (() => { throw new Error(`fake SQL: to_char format ${fmt}`); })(); };
      throw new Error(`fake SQL: unsupported function ${f}()`);
    }
    if (/^[A-Za-z_]/.test(t)) {
      const parts = t.split('.'); const col = parts[parts.length - 1]!;
      if (parts.length > 1 && parts[parts.length - 2]!.toLowerCase() === 'excluded') return (e) => e.excluded![col];
      return (e) => { if (!e.row) throw new Error(`fake SQL: column ${t} outside a row context`); if (!(col in e.row)) throw new Error(`fake SQL: unknown column ${col}`); return e.row[col]; };
    }
    throw new Error(`fake SQL: unexpected token ${t}`);
  }
}
const parseExpr = (s: string): Ev => { const p = new Parser(tokenize(s)); const ev = p.or(); if (!p.done()) throw new Error(`fake SQL: trailing tokens in "${s}"`); return ev; };

function topLevelIndex(s: string, kw: string, from = 0): number {
  let depth = 0, q = false;
  const up = s.toUpperCase();
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "'") q = !q;
    if (q) continue;
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && up.startsWith(kw, i)) return i;
  }
  return -1;
}
function splitTopCommas(s: string): string[] {
  const out: string[] = []; let depth = 0, q = false, cur = '';
  for (const c of s) {
    if (c === "'") q = !q;
    if (!q && c === '(') depth++;
    if (!q && c === ')') depth--;
    if (!q && depth === 0 && c === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function balancedGroups(s: string): string[] {
  const out: string[] = []; let depth = 0, q = false, start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") q = !q;
    if (q) continue;
    if (c === '(') { if (depth++ === 0) start = i + 1; }
    if (c === ')' && --depth === 0) out.push(s.slice(start, i));
  }
  return out;
}
type SelItem = { star: true } | { star?: false; name: string; ev: Ev };
function parseSelectList(list: string): SelItem[] {
  return splitTopCommas(list).map((it): SelItem => {
    if (it === '*' || /^[a-z_]\w*\.\*$/i.test(it)) return { star: true };
    const asAt = topLevelIndex(it, ' AS ');
    const expr = asAt < 0 ? it : it.slice(0, asAt); const alias = asAt < 0 ? undefined : it.slice(asAt + 4).trim();
    const name = alias ?? (/^[a-z_][\w.]*(::\w+)?$/i.test(expr) ? expr.replace(/::\w+$/, '').split('.').pop()! : (() => { throw new Error(`fake SQL: select expression "${expr}" needs an AS alias`); })());
    return { name, ev: parseExpr(expr) };
  });
}

// ------------------------------------------------------------------ table definitions (05-SCHEMA)
/** `fkCheck` (T12): extra FK emulation hook, called on INSERT with the whole table map; returns a constraint name to raise 23503, else null. */
export interface Def { pk: string[]; notNull: string[]; bigint: string[]; defaults: Record<string, () => any>; check?: (r: Row) => string | null; fk?: boolean; fkCheck?: (r: Row, t: Record<string, Row[]>) => string | null }
const nowD = () => NOW;
const DEFS: Record<string, Def> = {
  'partners.price_list_items': {
    pk: ['tenant_id', 'partner_id', 'orderable_id'], fk: true, bigint: ['unit_price_paisa'], defaults: { created_at: nowD, department_name: () => null, effective_to: () => null },
    notNull: ['tenant_id', 'partner_id', 'orderable_id', 'kind', 'code', 'name', 'unit_price_paisa', 'source', 'price_list_id', 'price_list_version', 'effective_from', 'synced_at', 'created_by'],
    check: (r) => !['test', 'panel'].includes(r.kind) ? 'price_list_items__kind__ck' : r.code.length < 1 || r.code.length > 64 ? 'price_list_items__code__ck'
      : r.name.length < 1 || r.name.length > 200 ? 'price_list_items__name__ck' : r.department_name != null && r.department_name.length > 120 ? 'price_list_items__dept__ck'
      : !(BigInt(r.unit_price_paisa) >= 0n && BigInt(r.unit_price_paisa) <= 9007199254740991n) ? 'price_list_items__price__ck' : !['partner', 'standard'].includes(r.source) ? 'price_list_items__source__ck' : null,
  },
  'partners.price_list_syncs': {
    pk: ['tenant_id', 'partner_id'], fk: true, bigint: [], defaults: { created_at: nowD, updated_at: nowD, row_count: () => 0, price_list_version: () => null, last_error_code: () => null },
    notNull: ['tenant_id', 'partner_id', 'synced_at', 'row_count', 'created_by', 'updated_by'],
  },
  'partners.statement_months': {
    pk: ['tenant_id', 'partner_id', 'period_month', 'fiscal_year_bs'], fk: true, bigint: ['invoiced_paisa', 'paid_paisa', 'credited_paisa', 'closing_balance_paisa'],
    defaults: { created_at: nowD, updated_at: nowD, is_stale: () => false },
    notNull: ['tenant_id', 'partner_id', 'credit_party_id', 'period_month', 'fiscal_year_bs', 'invoiced_paisa', 'paid_paisa', 'credited_paisa', 'closing_balance_paisa', 'synced_at', 'is_stale', 'created_by', 'updated_by'],
    check: (r) => String(r.period_month).slice(8, 10) !== '01' ? 'statement_months__month__ck' : !/^[0-9]{4}\/[0-9]{2}$/.test(r.fiscal_year_bs) ? 'statement_months__fy__ck' : null,
  },
};
const READ_ONLY = ['catalog.v_pub_price_list_items', 'catalog.v_pub_test_directory', 'billing.v_pub_credit_party_statement', 'partners.partners', 'partners.settings', 'partners.partner_users'];

// ------------------------------------------------------------------ world
export interface Job { identifier: string; payload: any; jobKey: string | null; runAt: unknown }
/** T12: `extra.defs` adds writable tables, `extra.tables` adds (empty) readable ones; the T17 world is unchanged when omitted. */
export function makeWorld(extra: { defs?: Record<string, Def>; tables?: string[] } = {}) {
  const defs: Record<string, Def> = { ...DEFS, ...(extra.defs ?? {}) };
  const t: Record<string, Row[]> = {
    'catalog.v_pub_price_list_items': [], 'catalog.v_pub_test_directory': [], 'billing.v_pub_credit_party_statement': [],
    'partners.partners': [], 'partners.settings': [], 'partners.partner_users': [], 'partners.price_list_items': [], 'partners.price_list_syncs': [], 'partners.statement_months': [],
    ...Object.fromEntries([...Object.keys(extra.defs ?? {}), ...(extra.tables ?? [])].map((n) => [n, [] as Row[]])),
  };
  const w = {
    t, jobs: [] as Job[], log: [] as Array<{ text: string; values: unknown[] }>, portCalls: [] as string[], audit: [] as any[],
    pending: [] as Array<{ re: RegExp; err: Error }>,
    /** emulate the partner RLS predicate on partners.* reads (false = the handler itself must scope by tenant_id + partner_id) */
    rls: false as boolean | { tenantId: string; partnerId: string },
    failNext(re: RegExp, err: Error = new Error('injected database failure')) { w.pending.push({ re, err }); },
    sqlOf: (re: RegExp) => w.log.filter((q) => re.test(q.text)),
    writes: () => w.log.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text) && !/partner_users/i.test(q.text)),
    /** one job = one transaction: any throw restores every table and the job queue. */
    snapshot() { return structuredClone({ t: w.t, jobs: w.jobs }); },
    restore(s: { t: Record<string, Row[]>; jobs: Job[] }) { for (const k of Object.keys(w.t)) w.t[k] = s.t[k]!; w.jobs = s.jobs; },
    tx: undefined as unknown as { query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number }> },
  };
  const env = (params: unknown[], row?: Row, excluded?: Row): Env => ({ params, now: NOW, ...(row ? { row } : {}), ...(excluded ? { excluded } : {}) });
  const rlsOk = (table: string, r: Row) => !w.rls || !table.startsWith('partners.') || table === 'partners.partners' || table === 'partners.settings' || table === 'partners.partner_users'
    || (r.tenant_id === (w.rls as any).tenantId && r.partner_id === (w.rls as any).partnerId);
  const norm = (def: Def | undefined, r: Row): Row => { if (def) for (const c of def.bigint) if (r[c] != null) r[c] = String(r[c]); return r; };
  const table = (name: string): Row[] => { const r = w.t[name]; if (!r) throw new Error(`fake SQL: unknown table ${name}`); return r; };
  const project = (items: SelItem[], row: Row, params: unknown[]): Row => {
    const out: Row = {};
    for (const it of items) { if (it.star) Object.assign(out, row); else out[it.name] = it.ev(env(params, row)); }
    return out;
  };
  const returning = (s: string, rows: Row[], params: unknown[]) => { const at = topLevelIndex(s, ' RETURNING '); return at < 0 ? [] : rows.map((r) => project(parseSelectList(s.slice(at + 11)), r, params)); };

  function lookup(values: unknown[]) { // partnerContext LOOKUP_SQL (as the T03 world)
    const [tenant, membership] = values as string[];
    const u = t['partners.partner_users']!.find((x) => x.tenant_id === tenant && x.membership_id === membership);
    if (!u) return { rows: [], rowCount: 0 };
    const p = t['partners.partners']!.find((x) => x.tenant_id === u.tenant_id && x.id === u.partner_id)!;
    const s = t['partners.settings']!.find((x) => x.tenant_id === u.tenant_id);
    if (w.rls && !(['invited', 'active'].includes(u.status) && p.status === 'active')) return { rows: [], rowCount: 0 };
    return { rowCount: 1, rows: [{ partner_user_id: u.id, partner_id: u.partner_id, partner_role: u.partner_role, user_status: u.status, partner_status: p.status, display_name: u.display_name,
      partner_code: p.partner_code, partner_name: p.name, conversion_mode: p.conversion_mode ?? 'on_receipt', access_slip_enabled: s?.access_slip_enabled ?? null, include_default_price_list: s?.include_default_price_list ?? null }] };
  }

  function select(s: string, values: unknown[]) {
    const kws = [' FROM ', ' WHERE ', ' ORDER BY ', ' LIMIT ', ' OFFSET ', ' FOR UPDATE'];
    const pos = kws.map((k) => ({ k, i: topLevelIndex(s, k) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
    const seg = (k: string) => { const n = pos.findIndex((x) => x.k === k); return n < 0 ? undefined : s.slice(pos[n]!.i + k.length, pos[n + 1]?.i ?? s.length).trim(); };
    const from = seg(' FROM ')!; const m = /^([a-z_]+\.[a-z_0-9]+)(?: (?:AS )?([a-z_]\w*))?$/i.exec(from);
    if (!m) throw new Error(`fake SQL: unsupported FROM "${from}" (no joins/subqueries)`);
    const name = m[1]!; const def = defs[name];
    const where = seg(' WHERE '); const pred = where ? parseExpr(where) : undefined;
    let rows = table(name).filter((r) => rlsOk(name, r)).filter((r) => (pred ? pred(env(values, r)) === true : true));
    const ob = seg(' ORDER BY ');
    if (ob) {
      const keys = splitTopCommas(ob).map((x) => { const d = /\s+DESC$/i.test(x); return { ev: parseExpr(x.replace(/\s+(ASC|DESC)$/i, '')), desc: d }; });
      rows = [...rows].sort((a, b) => { for (const k of keys) { const x = k.ev(env(values, a)), y = k.ev(env(values, b)); if (x == null && y == null) continue; if (x == null) return k.desc ? -1 : 1; if (y == null) return k.desc ? 1 : -1; const c = cmp(x, y)!; if (c !== 0) return k.desc ? -c : c; } return 0; });
    }
    const num = (x?: string) => (x === undefined ? undefined : x.startsWith('$') ? Number(values[Number(x.slice(1)) - 1]) : Number(x));
    const off = num(seg(' OFFSET ')) ?? 0; const lim = num(seg(' LIMIT '));
    rows = rows.slice(off, lim === undefined ? undefined : off + lim);
    const items = parseSelectList(seg(' FROM ') === undefined ? '*' : s.slice('SELECT '.length, pos[0]!.i).trim());
    return { rows: rows.map((r) => norm(def, project(items, { ...r }, values))), rowCount: rows.length };
  }

  function insert(s: string, values: unknown[]) {
    const m = /^INSERT INTO ([a-z_]+\.[a-z_0-9]+) \(([^)]*)\) VALUES /i.exec(s);
    if (!m) throw new Error(`fake SQL: unsupported INSERT: ${s.slice(0, 80)}`);
    const name = m[1]!; const def = defs[name]; if (!def) throw new Error(`fake SQL: table ${name} is not writable here`);
    const cols = m[2]!.split(',').map((c) => c.trim());
    const rest = s.slice(m[0].length); const oc = topLevelIndex(rest, ' ON CONFLICT '); const ret = topLevelIndex(rest, ' RETURNING ');
    const valuesPart = rest.slice(0, [oc, ret].filter((x) => x >= 0).sort((a, b) => a - b)[0] ?? rest.length);
    const tuples = balancedGroups(valuesPart).map((g) => splitTopCommas(g).map(parseExpr));
    let doNothing = false, set: Array<[string, Ev]> | undefined;
    if (oc >= 0) {
      const tail = rest.slice(oc + ' ON CONFLICT '.length, ret >= 0 ? ret : undefined);
      const t2 = /^\(([^)]*)\) DO (NOTHING|UPDATE SET (.+))$/i.exec(tail.trim());
      if (!t2) throw new Error(`fake SQL: unsupported ON CONFLICT: ${tail}`);
      const target = t2[1]!.split(',').map((c) => c.trim()).join(',');
      if ([...t2[1]!.split(',').map((c) => c.trim())].sort().join(',') !== [...def.pk].sort().join(',')) throw new Error(`fake SQL: ON CONFLICT (${target}) is not a unique key of ${name} (pk ${def.pk.join(',')})`);
      if (/^NOTHING$/i.test(t2[2]!)) doNothing = true;
      else set = splitTopCommas(t2[3]!).map((a) => { const [c, ...e] = a.split('='); return [c!.trim(), parseExpr(e.join('='))]; });
    }
    const out: Row[] = []; const touched = new Set<string>(); const rows = table(name);
    for (const tup of tuples) {
      if (tup.length !== cols.length) throw new Error('fake SQL: VALUES arity differs from the column list');
      const row: Row = {}; cols.forEach((c, i) => { row[c] = tup[i]!(env(values)); });
      for (const [c, f] of Object.entries(def.defaults)) if (!(c in row)) row[c] = f();
      for (const c of def.notNull) if (row[c] == null) throw pgErr('23502', `${name}.${c}`);
      for (const c of def.bigint) if (row[c] != null) row[c] = String(row[c]);
      const bad = def.check?.(row); if (bad) throw pgErr('23514', bad);
      if (def.fk && !t['partners.partners']!.some((p) => p.tenant_id === row.tenant_id && p.id === row.partner_id)) throw pgErr('23503', `${name}__partner__fk`);
      const fkBad = def.fkCheck?.(row, t); if (fkBad) throw pgErr('23503', fkBad);
      const key = def.pk.map((c) => String(row[c] instanceof Date ? row[c].toISOString() : row[c])).join('|');
      const hit = rows.find((r) => def.pk.every((c) => String(r[c]) === String(row[c])));
      if (hit) {
        if (doNothing) continue;
        if (!set) throw pgErr('23505', `${name.split('.')[1]}__pk`);
        if (touched.has(key)) throw Object.assign(new Error('ON CONFLICT DO UPDATE command cannot affect row a second time'), { code: '21000' });
        touched.add(key);
        for (const [c, ev] of set) hit[c] = ev(env(values, hit, row));
        for (const c of def.bigint) if (hit[c] != null) hit[c] = String(hit[c]);
        out.push(hit); continue;
      }
      touched.add(key); rows.push(row); out.push(row);
    }
    return { rows: returning(s, out, values), rowCount: out.length };
  }

  function update(s: string, values: unknown[]) {
    const m = /^UPDATE ([a-z_]+\.[a-z_0-9]+)(?: (?:AS )?([a-z_]\w*))? SET /i.exec(s);
    if (!m) throw new Error(`fake SQL: unsupported UPDATE: ${s.slice(0, 80)}`);
    const name = m[1]!; const def = defs[name]; if (!def) throw new Error(`fake SQL: table ${name} is not writable here`);
    const w0 = topLevelIndex(s, ' WHERE '); if (w0 < 0) throw new Error('fake SQL: UPDATE without WHERE refused');
    const setStr = s.slice(m[0].length, w0); const r0 = topLevelIndex(s, ' RETURNING ');
    const pred = parseExpr(s.slice(w0 + 7, r0 >= 0 ? r0 : undefined));
    const set = splitTopCommas(setStr).map((a): [string, Ev] => { const [c, ...e] = a.split('='); return [c!.trim(), parseExpr(e.join('='))]; });
    const hit = table(name).filter((r) => pred(env(values, r)) === true);
    for (const r of hit) { const next: Row = {}; for (const [c, ev] of set) next[c] = ev(env(values, r)); Object.assign(r, next); for (const c of def.bigint) if (r[c] != null) r[c] = String(r[c]); }
    return { rows: returning(s, hit, values), rowCount: hit.length };
  }

  function del(s: string, values: unknown[]) {
    const m = /^DELETE FROM ([a-z_]+\.[a-z_0-9]+)(?: (?:AS )?([a-z_]\w*))? WHERE /i.exec(s);
    if (!m) throw new Error(`fake SQL: unsupported DELETE (a WHERE is mandatory): ${s.slice(0, 80)}`);
    const name = m[1]!; if (!defs[name]) throw new Error(`fake SQL: table ${name} is not writable here`);
    const r0 = topLevelIndex(s, ' RETURNING '); const pred = parseExpr(s.slice(m[0].length, r0 >= 0 ? r0 : undefined));
    const all = table(name); const gone = all.filter((r) => pred(env(values, r)) === true);
    w.t[name] = all.filter((r) => !gone.includes(r));
    return { rows: returning(s, gone, values), rowCount: gone.length };
  }

  w.tx = {
    async query(text: string, values: unknown[] = []) {
      w.log.push({ text, values });
      const fi = w.pending.findIndex((p) => p.re.test(text)); if (fi >= 0) throw w.pending.splice(fi, 1)[0]!.err;
      const s = text.trim().replace(/\s+/g, ' ').replace(/;$/, '');
      if (/^UPDATE partners\.partner_users /i.test(s)) { const u = t['partners.partner_users']!.find((x) => values.includes(x.id)); if (u) u.status = 'active'; return { rows: [], rowCount: u ? 1 : 0 }; }
      if (/FROM partners\.partner_users \w+ JOIN /i.test(s)) return lookup(values);
      const job = /^SELECT app\.enqueue_job\((.+)\)$/i.exec(s);
      if (job) {
        const args = splitTopCommas(job[1]!).map(parseExpr).map((e) => e(env(values)));
        const [identifier, payload, jobKey, runAt] = args as [string, string, string | null, unknown];
        const j: Job = { identifier, payload: typeof payload === 'string' ? JSON.parse(payload) : payload, jobKey: jobKey ?? null, runAt };
        const i = j.jobKey ? w.jobs.findIndex((x) => x.jobKey === j.jobKey) : -1;
        if (i >= 0) w.jobs[i] = j; else w.jobs.push(j);
        return { rows: [{ enqueue_job: null }], rowCount: 1 };
      }
      if (/^SELECT /i.test(s)) return select(s, values);
      if (/^INSERT /i.test(s)) return insert(s, values);
      if (/^UPDATE /i.test(s)) return update(s, values);
      if (/^DELETE /i.test(s)) return del(s, values);
      throw new Error(`fake SQL: unsupported statement: ${s.slice(0, 80)}`);
    },
  };
  for (const n of READ_ONLY) void n; // documentation only: DEFS gates writes
  return w;
}
export type World = ReturnType<typeof makeWorld>;

// ------------------------------------------------------------------ seed (synthetic)
// falls_through defaults to true (08 A13 D-19: consumers apply fall-through to the tenant default list; C3 priceMatch.ts: false = no lower source is consulted)
const plv = (o: Row) => ({ tenant_id: T_A, effective_to: null, falls_through: true, ...o });
export function seed(w: World) {
  const T = w.t;
  T['partners.partners']!.push(
    { id: P.x, tenant_id: T_A, partner_code: 'SYN-X', name: 'Synthetic Partner X', status: 'active', credit_party_id: CP.one, conversion_mode: 'on_receipt' },
    { id: P.y, tenant_id: T_A, partner_code: 'SYN-Y', name: 'Synthetic Partner Y', status: 'active', credit_party_id: CP.two, conversion_mode: 'on_receipt' },
    { id: P.z, tenant_id: T_A, partner_code: 'SYN-Z', name: 'Synthetic Partner Z', status: 'suspended', credit_party_id: CP.three, conversion_mode: 'on_receipt' },
    { id: P.b, tenant_id: T_B, partner_code: 'SYN-B', name: 'Synthetic Partner B', status: 'active', credit_party_id: CP.b, conversion_mode: 'on_receipt' },
  );
  // tenant B's directory row is listed FIRST for T1 with a different name: a read that is not tenant-bound picks it
  T['catalog.v_pub_test_directory']!.push(
    { tenant_id: T_B, test_id: O.t1, code: 'FOREIGN-T1', name: 'Foreign Tenant Name', department_id: id(90), workflow_type: 'quantitative', is_active: true },
    { tenant_id: T_A, test_id: O.t1, code: 'SYN-T1', name: 'Synthetic Hemogram', department_id: id(91), workflow_type: 'quantitative', is_active: true },
    { tenant_id: T_A, test_id: O.t2, code: 'SYN-T2', name: 'Synthetic Glucose', department_id: id(91), workflow_type: 'quantitative', is_active: true },
    { tenant_id: T_A, test_id: O.t3, code: 'SYN-T3', name: 'Synthetic Sodium', department_id: id(92), workflow_type: 'quantitative', is_active: true },
    { tenant_id: T_A, test_id: O.t4, code: 'SYN-T4', name: 'Synthetic Urea', department_id: id(92), workflow_type: 'quantitative', is_active: true },
  );
  const V = T['catalog.v_pub_price_list_items']!;
  const d = (s: string) => new Date(s);
  V.push(
    // CP1 (partner X): published v3, effective now; superseded v2 ended in June; T3 not yet effective; T4 ended in January
    plv({ price_list_id: PL.cp1, price_list_version: 3, owner_kind: 'credit_party', owner_id: CP.one, orderable_id: O.t1, unit_price_paisa: '150000', effective_from: d('2026-01-01T00:00:00Z') }),
    plv({ price_list_id: PL.cp1, price_list_version: 3, owner_kind: 'credit_party', owner_id: CP.one, orderable_id: O.p1, unit_price_paisa: '90000', effective_from: d('2026-01-01T00:00:00Z') }),
    plv({ price_list_id: PL.cp1, price_list_version: 3, owner_kind: 'credit_party', owner_id: CP.one, orderable_id: O.t2, unit_price_paisa: '60000', effective_from: d('2026-01-01T00:00:00Z'), effective_to: d('2027-01-01T00:00:00Z') }),
    plv({ price_list_id: PL.cp1, price_list_version: 3, owner_kind: 'credit_party', owner_id: CP.one, orderable_id: O.t3, unit_price_paisa: '70000', effective_from: d('2027-01-01T00:00:00Z') }),
    plv({ price_list_id: PL.cp1, price_list_version: 3, owner_kind: 'credit_party', owner_id: CP.one, orderable_id: O.t4, unit_price_paisa: '45000', effective_from: d('2025-01-01T00:00:00Z'), effective_to: d('2026-01-01T00:00:00Z') }),
    plv({ price_list_id: PL.cp1old, price_list_version: 2, owner_kind: 'credit_party', owner_id: CP.one, orderable_id: O.t1, unit_price_paisa: '120000', effective_from: d('2025-01-01T00:00:00Z'), effective_to: d('2026-01-01T00:00:00Z') }),
    // tenant default list v7
    ...[[O.t1, '200000'], [O.t2, '80000'], [O.t4, '50000'], [O.p1, '130000'], [O.p2, '110000'], [O.unknown, '1000']].map(([o, p]) =>
      plv({ price_list_id: PL.dflt, price_list_version: 7, owner_kind: 'default', owner_id: T_A, orderable_id: o, unit_price_paisa: p, effective_from: d('2026-01-01T00:00:00Z'), falls_through: true })),
    // other credit parties of the same tenant: distinct prices, must never reach X
    plv({ price_list_id: PL.cp2, price_list_version: 5, owner_kind: 'credit_party', owner_id: CP.two, orderable_id: O.t1, unit_price_paisa: '111000', effective_from: d('2026-01-01T00:00:00Z') }),
    plv({ price_list_id: PL.cp2, price_list_version: 5, owner_kind: 'credit_party', owner_id: CP.two, orderable_id: O.t3, unit_price_paisa: '222000', effective_from: d('2026-01-01T00:00:00Z') }),
    plv({ price_list_id: PL.cp3, price_list_version: 9, owner_kind: 'credit_party', owner_id: CP.three, orderable_id: O.t2, unit_price_paisa: '333000', effective_from: d('2026-01-01T00:00:00Z') }),
    plv({ price_list_id: PL.cp3, price_list_version: 9, owner_kind: 'credit_party', owner_id: CP.three, orderable_id: O.p2, unit_price_paisa: '444000', effective_from: d('2026-01-01T00:00:00Z') }),
    // probes: a referrer / centre list whose owner_id equals CP1's id; tenant B's list for the SAME credit party id
    plv({ price_list_id: id(46), price_list_version: 1, owner_kind: 'referrer', owner_id: CP.one, orderable_id: O.t3, unit_price_paisa: '99999', effective_from: d('2026-01-01T00:00:00Z') }),
    plv({ price_list_id: id(47), price_list_version: 1, owner_kind: 'centre', owner_id: CP.one, orderable_id: O.p2, unit_price_paisa: '88888', effective_from: d('2026-01-01T00:00:00Z') }),
    plv({ tenant_id: T_B, price_list_id: PL.b, price_list_version: 4, owner_kind: 'credit_party', owner_id: CP.one, orderable_id: O.t1, unit_price_paisa: '777777', effective_from: d('2026-01-01T00:00:00Z') }),
    plv({ tenant_id: T_B, price_list_id: id(48), price_list_version: 2, owner_kind: 'default', owner_id: T_B, orderable_id: O.t4, unit_price_paisa: '666666', effective_from: d('2026-01-01T00:00:00Z') }),
  );
  const S = T['billing.v_pub_credit_party_statement']!;
  const st = (tenant: string, cp: string, month: string, fy: string, inv: string, paid: string, cr: string, close: string) =>
    S.push({ tenant_id: tenant, credit_party_id: cp, period_month: month, fiscal_year_bs: fy, invoiced_paisa: inv, paid_paisa: paid, credited_paisa: cr, closing_balance_paisa: close });
  st(T_A, CP.one, '2024-01-01', '2080/81', '1000', '1000', '0', '0');            // older than 24 months
  st(T_A, CP.one, '2025-01-01', '2081/82', '500000', '300000', '0', '200000');
  st(T_A, CP.one, '2026-07-01', '2082/83', '100000', '50000', '0', '350000');    // July 2026 spans two B.S. fiscal years
  st(T_A, CP.one, '2026-07-01', '2083/84', '40000', '0', '10000', '380000');
  st(T_A, CP.one, '2026-08-01', '2083/84', '250000', '100000', '0', '530000');
  st(T_A, CP.one, '2026-09-01', '2083/84', '125000', '25000', '5000', '625000');
  st(T_A, CP.one, '2026-10-01', '2083/84', '900000', '200000', '0', '1325000');
  st(T_A, CP.two, '2026-10-01', '2083/84', '424242', '0', '0', '424242');
  st(T_A, CP.three, '2026-10-01', '2083/84', '333333', '0', '0', '333333');
  st(T_B, CP.one, '2026-10-01', '2083/84', '5550000', '0', '0', '5550000');      // same credit-party id, other tenant
  st(T_B, CP.b, '2026-10-01', '2083/84', '123456', '0', '0', '123456');
}

// ------------------------------------------------------------------ contexts
const CAT_TESTS: Record<string, { code: string; name: string; dept: string }> = {
  [O.t1]: { code: 'SYN-T1', name: 'Synthetic Hemogram', dept: 'Synthetic Haematology' }, [O.t2]: { code: 'SYN-T2', name: 'Synthetic Glucose', dept: 'Synthetic Biochemistry' },
  [O.t3]: { code: 'SYN-T3', name: 'Synthetic Sodium', dept: 'Synthetic Biochemistry' }, [O.t4]: { code: 'SYN-T4', name: 'Synthetic Urea', dept: 'Synthetic Biochemistry' },
};
const CAT_PANELS: Record<string, { code: string; name: string }> = { [O.p1]: { code: 'SYN-P1', name: 'Synthetic Lipid Package' }, [O.p2]: { code: 'SYN-P2', name: 'Synthetic Renal Package' } };
export function catalogPort(w: World, over: { getTest?: () => Error; getPanel?: () => Error } = {}) {
  return {
    async getTest(_c: unknown, i: { testId: string }) {
      w.portCalls.push(`getTest:${i.testId}`); if (over.getTest) throw over.getTest();
      const x = CAT_TESTS[i.testId]; if (!x) throw new LimsError('common.not_found');
      return { id: i.testId, code: x.code, name: x.name, departmentName: x.dept, isActive: true, revision: 1 };
    },
    async getPanel(_c: unknown, i: { panelId: string }) {
      w.portCalls.push(`getPanel:${i.panelId}`); if (over.getPanel) throw over.getPanel();
      const x = CAT_PANELS[i.panelId]; if (!x) throw new LimsError('common.not_found');
      return { id: i.panelId, code: x.code, name: x.name, panelKind: 'package', members: [], isActive: true, revision: 1 };
    },
  };
}
/** worker JobContext (core/consumer.ts: one transaction per job, db.tx reuses it, system actor, ports reachable as ctx.ports like analytics tasks). */
export function jobCtx(w: World, tenantId: string = T_A, over: Row = {}) {
  const logs: string[] = [];
  const ctx: any = {
    tenantId, actor: { type: 'system', id: SYSTEM }, requestId: id(99), tx: w.tx, events: {}, core: {}, storage: {}, files: {}, audit: {},
    log: { info: (o: unknown) => logs.push(JSON.stringify(o)), warn: (o: unknown) => logs.push(JSON.stringify(o)), error: (o: unknown) => logs.push(JSON.stringify(o)), debug: () => undefined, child: () => ctx.log },
    attempt: 1, maxAttempts: 10, jobId: '1', now: () => NOW_ISO, isNewer: (a: number | undefined, b: number) => a === undefined || b > a,
    ports: { CatalogPort: catalogPort(w, over['catalog'] as any) },
    ...over['ctx'] as object,
  };
  ctx.db = { tx: (fn: (c: unknown) => Promise<unknown>) => fn(ctx) };
  return { ctx, logs };
}
/** Runs a task/consumer as the worker would: one tx, rolled back (tables + queue) when the handler throws. */
export async function runJob(w: World, fn: (ctx: any) => Promise<unknown>, tenantId: string = T_A, over: Row = {}) {
  const { ctx, logs } = jobCtx(w, tenantId, over); const snap = w.snapshot();
  try { await fn(ctx); return { ok: true as const, error: undefined, logs }; } catch (error) { w.restore(snap); return { ok: false as const, error: error as Error, logs }; }
}
