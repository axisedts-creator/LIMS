// T-04 (C3) test fixture: in-memory Postgres fake for catalog.departments / specimen_types / containers / methods, layered on the T-03
// fake (catalogDb.ts: catalog_state + core.event_log + app.enqueue_job + row lock). One tx facade routes SQL by CONTENT (never position).
// Semantics that matter for T-04 and are modelled for real:
//   - RLS: a tx sees/changes only rows of its own tenant; INSERT with a foreign tenant_id raises 42501. A statement WITHOUT a tenant
//     predicate is therefore still safe here — explicit-predicate rules are asserted separately on `stmts`.
//   - READ COMMITTED + row-lock-then-re-evaluate: INSERT/UPDATE/SELECT..FOR UPDATE take a lock per (table, tenant), held to COMMIT/ROLLBACK;
//     the WHERE is evaluated AFTER the lock is granted, against the freshly committed state (so `version = $n` optimistic locking and
//     unique-violation races behave like Postgres). Writes are private to the tx until COMMIT; ROLLBACK discards them.
//   - Constraints of 05-SCHEMA / migration 20261105001500: PK(id), UNIQUE(tenant_id, code) -> 23505, CHECKs -> 23514, NOT NULL -> 23502,
//     containers FK (tenant_id, default_specimen_type_id) -> specimen_types -> 23503.
//   - node-pg types: integer -> number, timestamptz -> Date, uuid/text -> string.
// SQL dialect the engine understands (anything else throws "fake: unsupported SQL" — the writer must stay inside it):
//   INSERT INTO catalog.<t> (cols) VALUES (exprs) [ON CONFLICT … DO NOTHING] [RETURNING cols|*]
//   SELECT <anything|count(*)> FROM catalog.<t> [alias] [WHERE expr] [ORDER BY col [ASC|DESC], …] [LIMIT n|$n] [OFFSET n|$n] [FOR UPDATE|SHARE]
//   UPDATE catalog.<t> [alias] SET col = expr, … WHERE expr [RETURNING cols|*]
//   expr: $n, 'text', numbers, true/false/NULL, now(), col | alias.col, + -, = <> != < > <= >=, row tuples (a, b) > ($1, $2), AND/OR/NOT,
//         IS [NOT] NULL, [NOT] IN (…), = ANY($n), COALESCE(…), LOWER(…), UPPER(…), LENGTH(…), parentheses,
//         [NOT] LIKE/ILIKE pat [ESCAPE c] (default escape \), a || b, CASE WHEN … THEN … [ELSE …] END (also in ORDER BY; T-06 additions). No joins, subqueries, DELETE (lims_app has no DELETE grant -> 42501).
// Synthetic data only.
import { REQ_ID, STARTED_AT, TENANT_A, USER, makeCatalogDb, type CatalogDb } from './catalogDb.js';
import { createEvents } from '../../../../core/events/publish.js';

export type Row = Record<string, any>;
export const TABLES = ['departments', 'specimen_types', 'containers', 'methods'] as const;
export type Table = (typeof TABLES)[number];
const TABLE_RE = new RegExp(`catalog\\.(${TABLES.join('|')})\\b`, 'i');

export const pgError = (code: string, message: string, constraint?: string) => Object.assign(new Error(message), { code, constraint });
export const tick = () => new Promise<void>((r) => setImmediate(r));
export const ID = (n: number) => `0190c300-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

// ------------------------------------------------------------------------------------------------ constraints
const CODE_OK = (v: unknown) => typeof v === 'string' && /^[A-Z0-9][A-Z0-9_]{0,31}$/.test(v);
const LEN = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max;
const NOT_NULL: Record<Table, string[]> = {
  departments: ['id', 'tenant_id', 'code', 'name', 'created_by', 'updated_by'],
  specimen_types: ['id', 'tenant_id', 'code', 'name', 'report_label', 'created_by', 'updated_by'],
  containers: ['id', 'tenant_id', 'code', 'name', 'created_by', 'updated_by'],
  methods: ['id', 'tenant_id', 'code', 'name', 'created_by', 'updated_by'],
};
const COLUMNS: Record<Table, string[]> = {
  departments: ['id', 'tenant_id', 'code', 'name', 'report_order', 'report_heading', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  specimen_types: ['id', 'tenant_id', 'code', 'name', 'report_label', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  containers: ['id', 'tenant_id', 'code', 'name', 'additive', 'cap_colour_display', 'default_specimen_type_id', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  methods: ['id', 'tenant_id', 'code', 'name', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
};
function checks(t: Table, r: Row): void {
  const bad = (c: string) => { throw pgError('23514', `new row for relation "${t}" violates check constraint "${c}"`, c); };
  if (!CODE_OK(r.code)) bad(`${t}__code__ck`);
  if (!LEN(r.name, 1, t === 'methods' ? 120 : 100)) bad(`${t}__name__ck`);
  if (t === 'departments') {
    if (!(Number.isInteger(r.report_order) && r.report_order >= 0 && r.report_order <= 9999)) bad('departments__order__ck');
    if (r.report_heading != null && !LEN(r.report_heading, 0, 100)) bad('departments__heading__ck');
  }
  if (t === 'specimen_types' && !LEN(r.report_label, 1, 100)) bad('specimen_types__label__ck');
  if (t === 'containers') {
    if (r.additive != null && !LEN(r.additive, 0, 60)) bad('containers__additive__ck');
    if (r.cap_colour_display != null && !LEN(r.cap_colour_display, 0, 40)) bad('containers__colour__ck');
  }
}

// ------------------------------------------------------------------------------------------------ expression engine
type Tok = { k: 'id' | 'param' | 'num' | 'str' | 'op'; v: string };
function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\$\d+)|('(?:[^']|'')*')|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|(<>|!=|<=|>=|\|\||[(),=<>+\-*]))/gy;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < s.trimEnd().length && (m = re.exec(s))) {
    pos = re.lastIndex;
    if (m[1]) out.push({ k: 'param', v: m[1].slice(1) });
    else if (m[2]) out.push({ k: 'str', v: m[2].slice(1, -1).replaceAll("''", "'") });
    else if (m[3]) out.push({ k: 'num', v: m[3] });
    else if (m[4]) out.push({ k: 'id', v: m[4] });
    else out.push({ k: 'op', v: m[5]! });
  }
  if (pos < s.trimEnd().length) throw new Error(`fake: cannot tokenize SQL near "${s.slice(pos, pos + 30)}"`);
  return out;
}
export type Env = { row: Row | undefined; values: readonly unknown[]; now: Date };
export type Ev = (e: Env) => any;
const cmpVal = (a: any, b: any): number => (a instanceof Date || b instanceof Date ? +a - +b : a < b ? -1 : a > b ? 1 : 0);
export function cmpAny(a: any, b: any): number | undefined {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < a.length; i++) { const c = cmpAny(a[i], b[i]); if (c === undefined) return undefined; if (c !== 0) return c; }
    return 0;
  }
  if (a == null || b == null) return undefined;           // SQL NULL: comparison is unknown
  return cmpVal(a, b);
}

const likeCache = new Map<string, RegExp>();
const reEsc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** SQL LIKE/ILIKE pattern -> RegExp: % = any run, _ = any one char, `esc` + char = that char literally. */
export function likeRe(p: string, esc: string, ci: boolean): RegExp {
  const key = `${ci ? 'i' : 's'}|${esc}|${p}`;
  let r = likeCache.get(key);
  if (r) return r;
  let body = '';
  for (let k = 0; k < p.length; k++) {
    const c = p[k]!;
    if (esc && c === esc && k + 1 < p.length) body += reEsc(p[++k]!);
    else if (c === '%') body += '[\\s\\S]*';
    else if (c === '_') body += '[\\s\\S]';
    else body += reEsc(c);
  }
  r = new RegExp(`^${body}$`, ci ? 'i' : '');
  if (likeCache.size > 500) likeCache.clear();
  likeCache.set(key, r);
  return r;
}

export function parseExpr(sql: string): Ev {
  const t = tokenize(sql);
  let i = 0;
  const peek = () => t[i];
  const kw = (w: string) => peek()?.k === 'id' && peek()!.v.toUpperCase() === w;
  const op = (o: string) => peek()?.k === 'op' && peek()!.v === o;
  const eat = () => t[i++]!;
  const expect = (o: string) => { if (!op(o)) throw new Error(`fake: expected "${o}" in SQL "${sql.slice(0, 120)}"`); i++; };

  const or = (): Ev => { let l = and(); while (kw('OR')) { i++; const a = l, b = and(); l = (e) => { const x = a(e); return x === true ? true : (b(e) === true ? true : (x === undefined || x === null ? null : false)); }; } return l; };
  const and = (): Ev => { let l = not(); while (kw('AND')) { i++; const a = l, b = not(); l = (e) => (a(e) === true && b(e) === true); } return l; };
  const not = (): Ev => { if (kw('NOT')) { i++; const a = not(); return (e) => { const x = a(e); return x == null ? null : !x; }; } return cmp(); };
  const cmp = (): Ev => {
    const l = add();
    if (kw('IS')) {
      i++; const neg = kw('NOT'); if (neg) i++;
      if (!kw('NULL')) throw new Error('fake: only IS [NOT] NULL supported'); i++;
      return (e) => (l(e) == null) !== neg;
    }
    let neg = false;
    if (kw('NOT') && ['IN', 'LIKE', 'ILIKE'].includes(t[i + 1]?.v.toUpperCase() ?? '')) { neg = true; i++; }
    if (kw('LIKE') || kw('ILIKE')) {
      const ci = kw('ILIKE'); i++;
      const pat = add();
      let esc: Ev = () => '\\';
      if (kw('ESCAPE')) { i++; esc = add(); }
      return (e) => { const v = l(e), p = pat(e); if (v == null || p == null) return null; const hit = likeRe(String(p), String(esc(e)), ci).test(String(v)); return neg ? !hit : hit; };
    }
    if (kw('IN')) {
      i++; expect('('); const items: Ev[] = [add()]; while (op(',')) { i++; items.push(add()); } expect(')');
      return (e) => { const v = l(e); if (v == null) return null; const hit = items.some((x) => cmpAny(v, x(e)) === 0); return neg ? !hit : hit; };
    }
    if (peek()?.k === 'op' && ['=', '<>', '!=', '<', '>', '<=', '>='].includes(peek()!.v)) {
      const o = eat().v;
      if (o === '=' && kw('ANY')) { i++; expect('('); const arr = add(); expect(')'); return (e) => { const v = l(e); const a = arr(e) as any[]; return v == null ? null : a.some((x) => cmpAny(v, x) === 0); }; }
      const r = add();
      return (e) => {
        const c = cmpAny(l(e), r(e));
        if (c === undefined) return null;
        return o === '=' ? c === 0 : o === '<>' || o === '!=' ? c !== 0 : o === '<' ? c < 0 : o === '>' ? c > 0 : o === '<=' ? c <= 0 : c >= 0;
      };
    }
    return l;
  };
  const add = (): Ev => {
    let l = atom();
    while (op('+') || op('-') || op('||')) {
      const o = eat().v, a = l, b = atom();
      l = (e) => { const x = a(e), y = b(e); return x == null || y == null ? null : o === '||' ? String(x) + String(y) : o === '+' ? x + y : x - y; };
    }
    return l;
  };
  const atom = (): Ev => {
    const tk = eat();
    if (tk.k === 'param') { const n = Number(tk.v); return (e) => { if (n > e.values.length) throw new Error(`fake: missing bind $${n}`); return e.values[n - 1]; }; }
    if (tk.k === 'num') { const n = Number(tk.v); return () => n; }
    if (tk.k === 'str') return () => tk.v;
    if (tk.k === 'op' && tk.v === '(') {
      const items: Ev[] = [or()];
      while (op(',')) { i++; items.push(or()); }
      expect(')');
      return items.length === 1 ? items[0]! : (e) => items.map((x) => x(e));
    }
    if (tk.k === 'id') {
      const u = tk.v.toUpperCase();
      if (u === 'TRUE') return () => true;
      if (u === 'FALSE') return () => false;
      if (u === 'NULL') return () => null;
      if (u === 'CASE') {
        const arms: Array<[Ev, Ev]> = []; let other: Ev = () => null;
        while (kw('WHEN')) { i++; const c = or(); if (!kw('THEN')) throw new Error('fake: CASE WHEN without THEN'); i++; arms.push([c, or()]); }
        if (kw('ELSE')) { i++; other = or(); }
        if (!kw('END')) throw new Error('fake: CASE without END');
        i++;
        return (e) => { for (const [c, v] of arms) if (c(e) === true) return v(e); return other(e); };
      }
      if (op('(')) {                                          // function call
        i++; const args: Ev[] = [];
        if (!op(')')) { args.push(or()); while (op(',')) { i++; args.push(or()); } }
        expect(')');
        if (u === 'NOW') return (e) => e.now;
        if (u === 'COALESCE') return (e) => { for (const a of args) { const v = a(e); if (v != null) return v; } return null; };
        if (u === 'UPPER') return (e) => { const v = args[0]!(e); return v == null ? null : String(v).toUpperCase(); };
        if (u === 'LENGTH' || u === 'CHAR_LENGTH') return (e) => { const v = args[0]!(e); return v == null ? null : String(v).length; };
        if (u === 'LOWER') return (e) => { const v = args[0]!(e); return v == null ? null : String(v).toLowerCase(); };
        throw new Error(`fake: unsupported function ${tk.v}()`);
      }
      const col = tk.v.includes('.') ? tk.v.slice(tk.v.lastIndexOf('.') + 1) : tk.v;
      return (e) => { if (!e.row) throw new Error(`fake: column ${col} outside a row context`); return e.row[col] === undefined ? null : e.row[col]; };
    }
    throw new Error(`fake: unexpected token "${tk.v}" in SQL "${sql.slice(0, 120)}"`);
  };
  const ev = or();
  if (i < t.length) throw new Error(`fake: trailing tokens in SQL near "${t[i]!.v}"`);
  return ev;
}
/** Splits on top-level commas (outside parentheses and quotes). */
export function splitTop(s: string): string[] {
  const out: string[] = []; let d = 0, q = false, cur = '';
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') d++;
    if (!q && ch === ')') d--;
    if (!q && d === 0 && ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export class RowLock {
  owner: number | undefined;
  private readonly q: Array<{ id: number; go: () => void }> = [];
  async acquire(id: number) {
    if (this.owner === id) return;
    if (this.owner === undefined) { this.owner = id; return; }
    await new Promise<void>((go) => this.q.push({ id, go }));
  }
  release(id: number) {
    if (this.owner !== id) return;
    const n = this.q.shift(); this.owner = n?.id; n?.go();
  }
}

// ------------------------------------------------------------------------------------------------ the fake
export interface MastersSeed { rows?: Partial<Record<Table, Row[]>>; catalog?: Parameters<typeof makeCatalogDb>[0] }

export function makeMastersDb(seed: MastersSeed = {}) {
  const base: CatalogDb = makeCatalogDb(seed.catalog);
  const committed = new Map<Table, Map<string, Row>>(TABLES.map((t) => [t, new Map()]));
  for (const t of TABLES) for (const r of seed.rows?.[t] ?? []) committed.get(t)!.set(r.id, { ...fill(t, r) });
  const locks = new Map<string, RowLock>();
  const failures: Array<{ match: RegExp; make: () => Error }> = [];
  const lockOf = (k: string) => { let l = locks.get(k); if (!l) locks.set(k, (l = new RowLock())); return l; };
  let seq = 0;

  function fill(t: Table, r: Row): Row {
    const o: Row = {};
    for (const c of COLUMNS[t]) o[c] = r[c] ?? null;
    o.version = r.version ?? 1; o.is_active = r.is_active ?? true;
    o.created_at = r.created_at ?? STARTED_AT; o.updated_at = r.updated_at ?? STARTED_AT;
    o.created_by = r.created_by ?? USER; o.updated_by = r.updated_by ?? USER;
    if (t === 'departments') o.report_order = r.report_order ?? 100;
    return o;
  }

  function begin(tenantId: string, actorId = USER) {
    const btx = base.begin(tenantId, actorId);
    const local = new Map<Table, Map<string, Row>>(TABLES.map((t) => [t, new Map()]));
    const held = new Set<string>();
    const now = STARTED_AT;
    const visible = (t: Table): Row[] => {
      const m = new Map<string, Row>();
      for (const [id, r] of committed.get(t)!) if (r.tenant_id === tenantId) m.set(id, r);
      for (const [id, r] of local.get(t)!) m.set(id, r);
      return [...m.values()];
    };
    const take = async (t: Table) => { const k = `${t}:${tenantId}`; await lockOf(k).acquire(btx.id); held.add(k); };
    const releaseAll = () => { for (const k of held) lockOf(k).release(btx.id); held.clear(); };
    const out = (rows: Row[], returning: string | undefined) => {
      if (!returning) return { rows: [] as Row[] };
      return { rows: rows.map((r) => ({ ...r })) };
    };

    async function insert(text: string, values: readonly unknown[]) {
      const m = /^INSERT INTO catalog\.(\w+) \(([^)]+)\) VALUES \((.+?)\)(?: ON CONFLICT .*?)?(?: RETURNING (.+))?$/i.exec(text);
      if (!m) throw new Error(`fake: unsupported INSERT: ${text.slice(0, 160)}`);
      const t = m[1]!.toLowerCase() as Table;
      const cols = m[2]!.split(',').map((c) => c.trim());
      const exprs = splitTop(m[3]!);
      if (cols.length !== exprs.length) throw new Error('fake: INSERT column/value count mismatch');
      const raw: Row = {};
      cols.forEach((c, i) => { if (!COLUMNS[t].includes(c)) throw pgError('42703', `column "${c}" does not exist`); raw[c] = parseExpr(exprs[i]!)({ row: undefined, values, now }); });
      if (raw.tenant_id !== tenantId) throw pgError('42501', `new row violates row-level security policy for table "${t}"`);
      await take(t);
      const r = fill(t, raw);
      for (const c of NOT_NULL[t]) if (r[c] == null) throw pgError('23502', `null value in column "${c}" violates not-null constraint`);
      checks(t, r);
      const all = visible(t);
      const conflict = all.find((x) => x.id === r.id) ? `${t}__pk` : all.find((x) => x.code === r.code) ? `${t}__tenant_id_code__uq` : undefined;
      if (conflict) {
        if (/ON CONFLICT[\s\S]*DO NOTHING/i.test(text)) return { rows: [] as Row[] };
        throw pgError('23505', `duplicate key value violates unique constraint "${conflict}"`, conflict);
      }
      if (t === 'containers' && r.default_specimen_type_id != null && !visible('specimen_types').some((s) => s.id === r.default_specimen_type_id)) {
        throw pgError('23503', 'insert or update on table "containers" violates foreign key constraint "containers__specimen_type__fk"', 'containers__specimen_type__fk');
      }
      local.get(t)!.set(r.id, r);
      return out([r], m[4]);
    }

    async function select(text: string, values: readonly unknown[]) {
      const m = /^SELECT (.+?) FROM catalog\.(\w+)(?: (?:AS )?(?!WHERE\b|ORDER\b|LIMIT\b|OFFSET\b|FOR\b)(\w+))?(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\S+))?(?: OFFSET (\S+))?(?: FOR (UPDATE|SHARE)(?: NOWAIT)?)?$/i.exec(text);
      if (!m) throw new Error(`fake: unsupported SELECT: ${text.slice(0, 160)}`);
      const t = m[2]!.toLowerCase() as Table;
      if (m[8]?.toUpperCase() === 'UPDATE') await take(t);
      const where = m[4] ? parseExpr(m[4]) : () => true;
      let rows = visible(t).filter((r) => where({ row: r, values, now }) === true);
      if (m[5]) {
        const keys = splitTop(m[5]).map((k) => { const mm = /^(.*?)(?:\s+(ASC|DESC))?$/i.exec(k.trim())!; return { ev: parseExpr(mm[1]!), desc: /^DESC$/i.test(mm[2] ?? '') }; });
        rows.sort((a, b) => { for (const k of keys) { const c = cmpAny(k.ev({ row: a, values, now }), k.ev({ row: b, values, now })) ?? 0; if (c) return k.desc ? -c : c; } return 0; });
      }
      const num = (s: string | undefined) => (s === undefined ? undefined : s.startsWith('$') ? Number(values[Number(s.slice(1)) - 1]) : Number(s));
      const off = num(m[7]); const lim = num(m[6]);
      if (off) rows = rows.slice(off);
      if (lim !== undefined) { if (!Number.isInteger(lim) || lim < 0) throw pgError('2201W', 'LIMIT must not be negative'); rows = rows.slice(0, lim); }
      if (/^count\(\*\)/i.test(m[1]!.trim())) return { rows: [{ count: String(rows.length) }] };
      return { rows: rows.map((r) => ({ ...r })) };
    }

    async function update(text: string, values: readonly unknown[]) {
      const m = /^UPDATE catalog\.(\w+)(?: (?:AS )?(?!SET\b)(\w+))? SET (.+?) WHERE (.+?)(?: RETURNING (.+))?$/i.exec(text);
      if (!m) throw new Error(`fake: unsupported UPDATE (a WHERE clause is required): ${text.slice(0, 160)}`);
      const t = m[1]!.toLowerCase() as Table;
      await take(t);                                           // lock first, evaluate WHERE on the fresh committed state
      const sets = splitTop(m[3]!).map((s) => {
        const eq = s.indexOf('='); const col = s.slice(0, eq).trim();
        if (!COLUMNS[t].includes(col)) throw pgError('42703', `column "${col}" does not exist`);
        return { col, ev: parseExpr(s.slice(eq + 1)) };
      });
      const where = parseExpr(m[4]!);
      const hit = visible(t).filter((r) => where({ row: r, values, now }) === true);
      const changed: Row[] = [];
      for (const r of hit) {
        const n: Row = { ...r };
        for (const s of sets) n[s.col] = s.ev({ row: r, values, now });
        if (n.tenant_id !== tenantId) throw pgError('42501', 'new row violates row-level security policy');
        for (const c of NOT_NULL[t]) if (n[c] == null) throw pgError('23502', `null value in column "${c}" violates not-null constraint`);
        checks(t, n);
        if (n.code !== r.code && visible(t).some((x) => x.id !== r.id && x.code === n.code)) throw pgError('23505', 'duplicate key', `${t}__tenant_id_code__uq`);
        if (t === 'containers' && n.default_specimen_type_id != null && !visible('specimen_types').some((s) => s.id === n.default_specimen_type_id)) {
          throw pgError('23503', 'violates foreign key constraint "containers__specimen_type__fk"', 'containers__specimen_type__fk');
        }
        local.get(t)!.set(n.id, n); changed.push(n);
      }
      return out(changed, m[5]);
    }

    const facade: any = {
      startedAt: STARTED_AT,
      operation: { module: 'catalog', operationId: 'fake', context: 'tenant' },
      async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
        if (!TABLE_RE.test(text)) return btx.facade.query(text, values);
        await tick();
        base.stmts.push({ txId: btx.id, tenantId, text, values });
        const f = failures.find((x) => x.match.test(text));
        if (f) throw f.make();
        const t = text.replace(/\s+/g, ' ').trim();
        if (/^INSERT/i.test(t)) return insert(t, values);
        if (/^SELECT/i.test(t)) return select(t, values);
        if (/^UPDATE/i.test(t)) return update(t, values);
        if (/^DELETE/i.test(t)) throw pgError('42501', 'permission denied for table (lims_app has no DELETE grant)');
        throw new Error(`fake: unsupported SQL: ${t.slice(0, 160)}`);
      },
      savepoint: async <T>(fn: (t: unknown) => Promise<T>) => fn(facade),
    };
    return {
      id: btx.id, tenantId, actorId, facade,
      /** T-25 (additive): a row of this tx's own view (committed + its uncommitted writes) — what a Postgres FK check inside one transaction sees. */
      visibleRow: (t: Table, id: string): Row | undefined => visible(t).find((r) => r.id === id),
      commit() {
        for (const t of TABLES) for (const [id, r] of local.get(t)!) committed.get(t)!.set(id, r);
        btx.commit(); releaseAll();
      },
      rollback() { btx.rollback(); releaseAll(); },
    };
  }

  type Tx = ReturnType<typeof begin>;
  const ctxFor = (tx: Tx, over: Record<string, unknown> = {}) => ({
    tenantId: tx.tenantId,
    actor: { type: 'user', id: tx.actorId },
    requestId: REQ_ID,
    tx: tx.facade,
    now: () => '2026-11-07T12:00:00.000Z',
    ports: {},
    operationId: 'fake',
    clientIp: '203.0.113.9',
    log: { info() {}, warn() {}, error() {} },
    events: createEvents({ producer: 'catalog' } as never),
    ...over,
  });

  /** One transaction: COMMIT when fn resolves (unless `rollback`), ROLLBACK when it rejects. */
  async function run<T>(fn: (ctx: ReturnType<typeof ctxFor>) => Promise<T>, o: { tenantId?: string; rollback?: boolean; actorId?: string; ctx?: Record<string, unknown> } = {}): Promise<T> {
    const tx = begin(o.tenantId ?? TENANT_A, o.actorId ?? USER);
    try {
      const r = await fn(ctxFor(tx, o.ctx));
      if (o.rollback) throw new Error('forced rollback');
      tx.commit();
      return r;
    } catch (e) { tx.rollback(); throw e; }
  }

  return {
    run, begin, ctxFor, base,
    get stmts() { return base.stmts; },
    get events() { return base.events; },
    revisionOf: base.revisionOf,
    /** Committed rows of a table (all tenants unless filtered). */
    rows: (t: Table, tenantId?: string): Row[] => [...committed.get(t)!.values()].filter((r) => tenantId === undefined || r.tenant_id === tenantId).map((r) => ({ ...r })),
    row: (t: Table, id: string): Row | undefined => { const r = committed.get(t)!.get(id); return r ? { ...r } : undefined; },
    newId: () => ID(0xf000 + ++seq),
    /** T-25 (additive): copy rows into the COMMITTED state of this instance (cross-fake FK targets that a layered fake cannot see). Idempotent by id. */
    mirror: (t: Table, rows: Row[]) => { for (const r of rows) if (!committed.get(t)!.has(r.id)) committed.get(t)!.set(r.id, { ...fill(t, r) }); },
    fail(match: RegExp, make: () => Error = () => new Error('injected')) { failures.push({ match, make }); base.fail(match, make); },
  };
}
export type MastersDb = ReturnType<typeof makeMastersDb>;

/** Seed-row factories (tenant-scoped, synthetic). */
export const dept = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0x100 + n), tenant_id: tenant, code: `DEPT${n}`, name: `Department ${n}`, report_order: 10 * n, ...o });
export const spec = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0x200 + n), tenant_id: tenant, code: `SPEC${n}`, name: `Specimen type ${n}`, report_label: `LABEL ${n}`, ...o });
export const cont = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0x300 + n), tenant_id: tenant, code: `CONT${n}`, name: `Container ${n}`, ...o });
export const meth = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0x400 + n), tenant_id: tenant, code: `METH${n}`, name: `Method ${n}`, ...o });
