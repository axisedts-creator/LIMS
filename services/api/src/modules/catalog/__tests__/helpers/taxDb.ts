// T-18 (C3) test fixture: in-memory Postgres fake for catalog.surcharge_rules, catalog.tax_rules, catalog.cs_tax_types (writable) and READ-ONLY catalog.g_tax_types (global, no tenant_id),
// catalog.orderables, catalog.price_lists (FK targets / existence checks; writes -> 42501). catalog.departments comes from the T-04 masters fake underneath (seed via `departments`).
// Layered on mastersDb.ts -> catalogDb.ts for catalog_state, core.event_log, app.enqueue_job and the tx/ctx machinery. Same construction (copied, not shared) as pricingDb.ts (T-17).
// Modelled for real (05-SCHEMA "Surcharge and tax", constraint names verbatim):
//   surcharge_rules  CHECK scope/amount_kind enums, amount_paisa 1..999999999, percent_bp 1..100000, scope_key (scope all => no keys; department => department_id only; orderable => orderable_id only),
//                    amount_kind (flat => amount_paisa only; percent => percent_bp only), window (effective_to >= effective_from) -> 23514; FK (tenant, department|orderable|price_list) -> 23503;
//                    TRIGGER surcharge_rules__mutable_columns: only effective_to, is_active, updated_at, updated_by, version may change -> P0001 "common.immutable_record"
//   tax_rules        CHECK scope/vat enums, other_tax_code ~ ^[A-Z0-9_]{1,16}$, hs_code ~ ^[0-9]{4,8}$, scope_key (tenant_default => no keys), window -> 23514; FK department/orderable -> 23503;
//                    partial UNIQUE tax_rules__tenant_id_scope_key__open__p_uq (one open rule per (scope, coalesce(department_id, orderable_id, nil))) -> 23505;
//                    TRIGGER tax_rules__other_type: other_tax_code must name an ACTIVE cs_tax_types code of the tenant -> 23503 "tax_rules__other_type__fk";
//                    TRIGGER tax_rules__mutable_columns (as surcharge_rules)
//   cs_tax_types     CHECK code ~ ^[A-Z0-9_]{1,16}$, code <> 'VAT' (cs_tax_types__not_vat__ck), display 1..60, rate_bp 0..10000 or NULL, window (effective_to > effective_from) -> 23514;
//                    UNIQUE(tenant, code, effective_from) cs_tax_types__tenant_id_code_effective_from__uq; partial UNIQUE(tenant, code) WHERE effective_to IS NULL
//                    cs_tax_types__tenant_id_code__open__p_uq -> 23505; TRIGGER cs_tax_types__mutable_columns: only display, sort_order, is_active, effective_to, updated_*, version may change -> P0001
//   g_tax_types      seeded with the VAT row ('VAT', 1300) by default; read-only (writes -> 42501); no tenant column, visible to every tenant.
//   all              RLS (INSERT/UPDATE with a foreign tenant_id -> 42501; other tenants' rows invisible), READ COMMITTED with lock-then-re-evaluate per (table, tenant), writes private to the tx until COMMIT.
//                    NO DELETE on any table (05-SCHEMA: rules are ended, never deleted) -> 42501.
// Time: `run(fn, { at })` fixes the transaction clock (ctx.now(), SQL now()). SQL dialect = pricingDb.ts (single-table SELECT / INSERT / UPDATE, bind params, no joins / subqueries / CASE / LIKE).
// Synthetic data only.
import { STARTED_AT, TENANT_A, USER } from './catalogDb.js';
import { ID, RowLock, makeMastersDb, cmpAny, parseExpr, pgError, splitTop, tick, type MastersSeed, type Row } from './mastersDb.js';

export const WRITABLE = ['surcharge_rules', 'tax_rules', 'cs_tax_types'] as const;
export const REF = ['g_tax_types', 'orderables', 'price_lists'] as const;
export const ALL = [...WRITABLE, ...REF] as const;
export type TTable = (typeof ALL)[number];
const RE = new RegExp(`\\bcatalog\\.(${ALL.join('|')})\\b`, 'i');
const isRef = (t: TTable) => (REF as readonly string[]).includes(t);
const NIL = '00000000-0000-0000-0000-000000000000';

const AUDIT = ['version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const COLS: Record<TTable, string[]> = {
  surcharge_rules: ['id', 'tenant_id', 'scope', 'department_id', 'orderable_id', 'price_list_id', 'amount_kind', 'amount_paisa', 'percent_bp', 'effective_from', 'effective_to', ...AUDIT],
  tax_rules: ['id', 'tenant_id', 'scope', 'department_id', 'orderable_id', 'vat_treatment', 'other_tax_code', 'hs_code', 'effective_from', 'effective_to', ...AUDIT],
  cs_tax_types: ['id', 'tenant_id', 'code', 'display', 'rate_bp', 'effective_from', 'effective_to', 'sort_order', ...AUDIT],
  g_tax_types: ['id', 'code', 'display', 'rate_bp', 'is_active', 'created_at'],
  orderables: ['id', 'tenant_id', 'kind', 'code', 'name', 'department_id', 'revision', 'version', 'is_active'],
  price_lists: ['id', 'tenant_id', 'code', 'name', 'owner_kind', 'falls_through', 'version', 'is_active'],
};
const NOT_NULL: Record<TTable, string[]> = {
  surcharge_rules: ['id', 'tenant_id', 'scope', 'amount_kind', 'effective_from', 'version', 'is_active', 'created_by', 'updated_by'],
  tax_rules: ['id', 'tenant_id', 'scope', 'vat_treatment', 'effective_from', 'version', 'is_active', 'created_by', 'updated_by'],
  cs_tax_types: ['id', 'tenant_id', 'code', 'display', 'effective_from', 'sort_order', 'version', 'is_active', 'created_by', 'updated_by'],
  g_tax_types: ['id', 'code', 'display', 'rate_bp'], orderables: ['id', 'tenant_id'], price_lists: ['id', 'tenant_id'],
};
const DATE_COLS = ['created_at', 'updated_at', 'effective_from', 'effective_to'];
const toDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? new Date(v) : v);
const keyOf = (r: Row) => r.id as string;
const MUTABLE: Record<string, string[]> = {
  surcharge_rules: ['effective_to', 'is_active', 'updated_at', 'updated_by', 'version'],
  tax_rules: ['effective_to', 'is_active', 'updated_at', 'updated_by', 'version'],
  cs_tax_types: ['display', 'sort_order', 'is_active', 'effective_to', 'updated_at', 'updated_by', 'version'],
};
export const VAT_ROW: Row = { id: ID(0x7a01), code: 'VAT', display: 'Value Added Tax', rate_bp: 1300, is_active: true };

export interface TaxSeed extends Pick<MastersSeed, 'catalog'> { rows?: Partial<Record<TTable | 'departments', Row[]>>; noVat?: boolean }

export function makeTaxDb(seed: TaxSeed = {}) {
  const m = makeMastersDb({ catalog: seed.catalog, rows: { departments: (seed.rows?.departments ?? []) as never } });
  const committed = new Map<TTable, Map<string, Row>>(ALL.map((t) => [t, new Map()]));
  const locks = new Map<string, RowLock>();
  const failures: Array<{ match: RegExp; make: () => Error }> = [];
  const lockOf = (k: string) => { let l = locks.get(k); if (!l) locks.set(k, (l = new RowLock())); return l; };
  let seq = 0;

  function fill(t: TTable, r: Row, now: Date, mode: 'db' | 'seed'): Row {
    const o: Row = {};
    for (const c of COLS[t]) o[c] = r[c] === undefined ? null : r[c];
    for (const c of DATE_COLS) if (c in o) o[c] = toDate(o[c]);
    if ('created_at' in o) o.created_at = toDate(r.created_at) ?? now;
    if ('updated_at' in o) o.updated_at = toDate(r.updated_at) ?? now;
    if ('version' in o) o.version = r.version ?? 1;
    if ('is_active' in o) o.is_active = r.is_active ?? true;
    if (t === 'cs_tax_types') o.sort_order = r.sort_order ?? 100;
    if (t === 'price_lists') o.falls_through = r.falls_through ?? true;
    if (mode === 'seed') { if ('created_by' in o) o.created_by = r.created_by ?? USER; if ('updated_by' in o) o.updated_by = r.updated_by ?? USER; }
    return o;
  }
  for (const t of ALL) for (const r of t === 'g_tax_types' && !seed.noVat ? [VAT_ROW, ...(seed.rows?.[t] ?? [])] : seed.rows?.[t] ?? []) { const f = fill(t, r, STARTED_AT, 'seed'); committed.get(t)!.set(keyOf(f), f); }

  function begin(tenantId: string, actorId = USER, at: Date = STARTED_AT) {
    const mt = m.begin(tenantId, actorId);
    const local = new Map<TTable, Map<string, Row>>(ALL.map((t) => [t, new Map()]));
    const held = new Set<string>();
    const now = at;
    const visible = (t: TTable): Row[] => {
      const map = new Map<string, Row>();
      for (const [k, r] of committed.get(t)!) if (t === 'g_tax_types' || r.tenant_id === tenantId) map.set(k, r);
      for (const [k, r] of local.get(t)!) map.set(k, r);
      return [...map.values()];
    };
    const take = async (t: TTable) => { if (isRef(t)) return; const k = `${t}:${tenantId}`; await lockOf(k).acquire(mt.id); held.add(k); };
    const releaseAll = () => { for (const k of held) lockOf(k).release(mt.id); held.clear(); };
    const out = (rows: Row[], returning: string | undefined) => (returning ? { rows: rows.map((r) => ({ ...r })) } : { rows: [] as Row[] });
    const bad = (t: TTable, c: string): never => { throw pgError('23514', `new row for relation "${t}" violates check constraint "${c}"`, c); };
    const dup = (c: string) => pgError('23505', `duplicate key value violates unique constraint "${c}"`, c);
    const immutable = (why: string): never => { throw pgError('P0001', `common.immutable_record: ${why}`); };
    const win = (r: Row, strict: boolean) => r.effective_to != null && r.effective_from != null && (strict ? new Date(r.effective_to) <= new Date(r.effective_from) : new Date(r.effective_to) < new Date(r.effective_from));

    function checks(t: TTable, r: Row): void {
      for (const c of NOT_NULL[t]) if (r[c] == null) throw pgError('23502', `null value in column "${c}" violates not-null constraint`);
      if (isRef(t)) return;
      if (!Number.isInteger(r.version)) throw pgError('22P02', 'invalid input syntax for type integer');
      if (typeof r.is_active !== 'boolean') throw pgError('42804', 'column is of type boolean');
      const nz = (...v: unknown[]) => v.filter((x) => x != null).length;
      if (t === 'surcharge_rules') {
        if (!['all', 'department', 'orderable'].includes(r.scope)) bad(t, 'surcharge_rules__scope__ck');
        if (!['flat', 'percent'].includes(r.amount_kind)) bad(t, 'surcharge_rules__kind__ck');
        if (r.amount_paisa != null && !(Number.isInteger(Number(r.amount_paisa)) && Number(r.amount_paisa) >= 1 && Number(r.amount_paisa) <= 999_999_999)) bad(t, 'surcharge_rules__amount__ck');
        if (r.percent_bp != null && !(Number.isInteger(r.percent_bp) && r.percent_bp >= 1 && r.percent_bp <= 100_000)) bad(t, 'surcharge_rules__bp__ck');
        const keyOk = (r.scope === 'all' && nz(r.department_id, r.orderable_id) === 0) || (r.scope === 'department' && r.department_id != null && r.orderable_id == null)
          || (r.scope === 'orderable' && r.orderable_id != null && r.department_id == null);
        if (!keyOk) bad(t, 'surcharge_rules__scope_key__ck');
        if (!((r.amount_kind === 'flat' && r.amount_paisa != null && r.percent_bp == null) || (r.amount_kind === 'percent' && r.percent_bp != null && r.amount_paisa == null))) bad(t, 'surcharge_rules__amount_kind__ck');
        if (win(r, false)) bad(t, 'surcharge_rules__window__ck');
      } else if (t === 'tax_rules') {
        if (!['tenant_default', 'department', 'orderable'].includes(r.scope)) bad(t, 'tax_rules__scope__ck');
        if (!['exempt', 'taxable'].includes(r.vat_treatment)) bad(t, 'tax_rules__vat__ck');
        if (r.other_tax_code != null && !/^[A-Z0-9_]{1,16}$/.test(r.other_tax_code)) bad(t, 'tax_rules__other__ck');
        if (r.hs_code != null && !/^[0-9]{4,8}$/.test(r.hs_code)) bad(t, 'tax_rules__hs__ck');
        const keyOk = (r.scope === 'tenant_default' && nz(r.department_id, r.orderable_id) === 0) || (r.scope === 'department' && r.department_id != null && r.orderable_id == null)
          || (r.scope === 'orderable' && r.orderable_id != null && r.department_id == null);
        if (!keyOk) bad(t, 'tax_rules__scope_key__ck');
        if (win(r, false)) bad(t, 'tax_rules__window__ck');
      } else if (t === 'cs_tax_types') {
        if (!(typeof r.code === 'string' && /^[A-Z0-9_]{1,16}$/.test(r.code))) bad(t, 'cs_tax_types__code__ck');
        if (!(typeof r.display === 'string' && r.display.length >= 1 && r.display.length <= 60)) bad(t, 'cs_tax_types__display__ck');
        if (r.rate_bp != null && !(Number.isInteger(r.rate_bp) && r.rate_bp >= 0 && r.rate_bp <= 10_000)) bad(t, 'cs_tax_types__rate__ck');
        if (r.code === 'VAT') bad(t, 'cs_tax_types__not_vat__ck');
        if (win(r, true)) bad(t, 'cs_tax_types__window__ck');
      }
    }
    function clash(t: TTable, r: Row, self?: Row): { constraint: string } | undefined {
      const others = visible(t).filter((x) => !self || keyOf(x) !== keyOf(self));
      const hit = (pred: (o: Row) => boolean, constraint: string) => (others.some(pred) ? { constraint } : undefined);
      if (t === 'cs_tax_types') {
        return hit((o) => o.id === r.id, 'cs_tax_types__pk') ?? hit((o) => o.code === r.code && +new Date(o.effective_from) === +new Date(r.effective_from), 'cs_tax_types__tenant_id_code_effective_from__uq')
          ?? (r.effective_to == null ? hit((o) => o.code === r.code && o.effective_to == null, 'cs_tax_types__tenant_id_code__open__p_uq') : undefined);
      }
      if (t === 'tax_rules') {
        const k = (x: Row) => `${x.scope}:${x.department_id ?? x.orderable_id ?? NIL}`;
        return hit((o) => o.id === r.id, 'tax_rules__pk') ?? (r.effective_to == null ? hit((o) => o.effective_to == null && k(o) === k(r), 'tax_rules__tenant_id_scope_key__open__p_uq') : undefined);
      }
      return t === 'surcharge_rules' ? hit((o) => o.id === r.id, 'surcharge_rules__pk') : undefined;
    }
    const fkFail = (c: string): never => { throw pgError('23503', `insert or update violates foreign key constraint "${c}"`, c); };
    function fk(t: TTable, r: Row): void {
      const has = (target: TTable, id: unknown) => id != null && visible(target).some((x) => x.id === id);
      const dept = (id: unknown) => id != null && m.rows('departments', tenantId).some((d) => d.id === id);
      if (t === 'surcharge_rules') {
        if (r.department_id != null && !dept(r.department_id)) fkFail('surcharge_rules__department__fk');
        if (r.orderable_id != null && !has('orderables', r.orderable_id)) fkFail('surcharge_rules__orderable__fk');
        if (r.price_list_id != null && !has('price_lists', r.price_list_id)) fkFail('surcharge_rules__list__fk');
      } else if (t === 'tax_rules') {
        if (r.department_id != null && !dept(r.department_id)) fkFail('tax_rules__department__fk');
        if (r.orderable_id != null && !has('orderables', r.orderable_id)) fkFail('tax_rules__orderable__fk');
      }
    }
    /** 05-SCHEMA triggers. `old` undefined = INSERT. */
    function triggers(t: TTable, old: Row | undefined, n: Row): void {
      if (t === 'tax_rules' && n.other_tax_code != null && (!old || old.other_tax_code !== n.other_tax_code)
        && !visible('cs_tax_types').some((x) => x.code === n.other_tax_code && x.is_active)) throw pgError('23503', 'tax_rules__other_type__fk', 'tax_rules__other_type__fk');
      if (old && MUTABLE[t]) for (const c of COLS[t]) if (!MUTABLE[t]!.includes(c) && cmpAny(old[c], n[c]) !== 0 && !(old[c] == null && n[c] == null)) immutable(`column ${c} of ${t}`);
    }

    async function insert(text: string, values: readonly unknown[]) {
      const x = /^INSERT INTO catalog\.(\w+) \(([^)]+)\) VALUES \((.+?)\)(?: RETURNING (.+))?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported INSERT: ${text.slice(0, 160)}`);
      const t = x[1]!.toLowerCase() as TTable;
      if (isRef(t)) throw pgError('42501', `permission denied for table ${t}`);
      const cols = x[2]!.split(',').map((c) => c.trim());
      const exprs = splitTop(x[3]!);
      if (cols.length !== exprs.length) throw new Error('fake: INSERT column/value count mismatch');
      const raw: Row = {};
      cols.forEach((c, i) => { if (!COLS[t].includes(c)) throw pgError('42703', `column "${c}" does not exist`); raw[c] = parseExpr(exprs[i]!)({ row: undefined, values, now }); });
      if (raw.tenant_id !== tenantId) throw pgError('42501', `new row violates row-level security policy for table "${t}"`);
      await take(t);
      const r = fill(t, raw, now, 'db');
      triggers(t, undefined, r);
      checks(t, r);
      const c = clash(t, r);
      if (c) throw dup(c.constraint);
      fk(t, r);
      local.get(t)!.set(keyOf(r), r);
      return out([r], x[4]);
    }
    const where = (text: string | undefined, values: readonly unknown[]) => {
      if (!text) return (_r: Row) => true;
      const ev = parseExpr(text); const vals = values.map(toDate);
      return (r: Row) => ev({ row: r, values: vals, now }) === true;
    };
    async function select(text: string, values: readonly unknown[]) {
      const x = /^SELECT (.+?) FROM catalog\.(\w+)(?: (?:AS )?(?!WHERE\b|ORDER\b|LIMIT\b|OFFSET\b|FOR\b)(\w+))?(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\S+))?(?: OFFSET (\S+))?(?: FOR (UPDATE|SHARE)(?: NOWAIT)?)?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported SELECT: ${text.slice(0, 160)}`);
      const t = x[2]!.toLowerCase() as TTable;
      if (x[8]?.toUpperCase() === 'UPDATE') await take(t);
      let rows = visible(t).filter(where(x[4], values));
      if (x[5]) {
        const keys = splitTop(x[5]).map((k) => { const p = k.trim().split(/\s+/); return { col: p[0]!.slice(p[0]!.lastIndexOf('.') + 1), desc: /^DESC$/i.test(p[1] ?? '') }; });
        rows.sort((a, b) => { for (const k of keys) { const c = cmpAny(a[k.col], b[k.col]) ?? 0; if (c) return k.desc ? -c : c; } return 0; });
      }
      const num = (s: string | undefined) => (s === undefined ? undefined : s.startsWith('$') ? Number(values[Number(s.slice(1)) - 1]) : Number(s));
      const off = num(x[7]); const lim = num(x[6]);
      if (off) rows = rows.slice(off);
      if (lim !== undefined) rows = rows.slice(0, lim);
      if (/^count\(\*\)/i.test(x[1]!.trim())) return { rows: [{ count: String(rows.length) }] };
      return { rows: rows.map((r) => ({ ...r })) };
    }
    async function update(text: string, values: readonly unknown[]) {
      const x = /^UPDATE catalog\.(\w+)(?: (?:AS )?(?!SET\b)(\w+))? SET (.+?) WHERE (.+?)(?: RETURNING (.+))?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported UPDATE (a WHERE clause is required): ${text.slice(0, 160)}`);
      const t = x[1]!.toLowerCase() as TTable;
      if (isRef(t)) throw pgError('42501', `permission denied for table ${t}`);
      await take(t);
      const sets = splitTop(x[3]!).map((s) => {
        const eq = s.indexOf('='); const col = s.slice(0, eq).trim();
        if (!COLS[t].includes(col)) throw pgError('42703', `column "${col}" does not exist`);
        return { col, ev: parseExpr(s.slice(eq + 1)) };
      });
      const changed: Row[] = [];
      for (const r of visible(t).filter(where(x[4], values))) {
        const n: Row = { ...r };
        for (const s of sets) n[s.col] = s.ev({ row: r, values, now });
        for (const c of DATE_COLS) if (c in n) n[c] = toDate(n[c]);
        if (n.tenant_id !== tenantId) throw pgError('42501', 'new row violates row-level security policy');
        triggers(t, r, n); checks(t, n);
        const c = clash(t, n, r); if (c) throw dup(c.constraint);
        fk(t, n);
        local.get(t)!.set(keyOf(n), n);
        changed.push(n);
      }
      return out(changed, x[5]);
    }

    const facade: any = {
      ...mt.facade,
      startedAt: at,
      async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
        if (!RE.test(text)) return mt.facade.query(text, values);
        await tick();
        m.base.stmts.push({ txId: mt.id, tenantId, text, values });
        const f = failures.find((y) => y.match.test(text));
        if (f) throw f.make();
        const s = text.replace(/\s+/g, ' ').trim();
        if (/^INSERT/i.test(s)) return insert(s, values);
        if (/^SELECT/i.test(s)) return select(s, values);
        if (/^UPDATE/i.test(s)) return update(s, values);
        if (/^DELETE/i.test(s)) throw pgError('42501', 'permission denied (no DELETE grant on rule / tax-type tables)');
        throw new Error(`fake: unsupported SQL: ${s.slice(0, 160)}`);
      },
      savepoint: async <T>(fn: (t: unknown) => Promise<T>) => fn(facade),
    };
    return {
      id: mt.id, tenantId, actorId, facade,
      commit() { for (const t of ALL) for (const [k, r] of local.get(t)!) committed.get(t)!.set(k, r); mt.commit(); releaseAll(); },
      rollback() { mt.rollback(); releaseAll(); },
    };
  }

  async function run<T>(fn: (ctx: ReturnType<typeof m.ctxFor>) => Promise<T>, o: { tenantId?: string; rollback?: boolean; actorId?: string; ctx?: Record<string, unknown>; at?: Date } = {}): Promise<T> {
    const at = o.at ?? STARTED_AT;
    const tx = begin(o.tenantId ?? TENANT_A, o.actorId ?? USER, at);
    try {
      const r = await fn(m.ctxFor(tx as never, { now: () => at.toISOString(), ...o.ctx }));
      if (o.rollback) throw new Error('forced rollback');
      tx.commit();
      return r;
    } catch (e) { tx.rollback(); throw e; }
  }

  return {
    run, begin, base: m.base,
    get stmts() { return m.stmts; },
    get events() { return m.events; },
    revisionOf: m.revisionOf,
    rows: (t: TTable, tenantId?: string): Row[] => [...committed.get(t)!.values()].filter((r) => tenantId === undefined || r.tenant_id === tenantId).map((r) => ({ ...r })),
    row: (t: TTable, id: string): Row | undefined => { const r = committed.get(t)!.get(id); return r ? { ...r } : undefined; },
    newId: () => ID(0xd800 + ++seq),
    fail(match: RegExp, make: () => Error = () => new Error('injected')) { failures.push({ match, make }); m.fail(match, make); },
  };
}
export type TaxDb = ReturnType<typeof makeTaxDb>;

// ------------------------------------------------------------------------------------------------ seed factories (synthetic)
const T0 = new Date('2026-01-01T00:00:00.000Z');
export const srule = (n: number, tenant: string, o: Row = {}): Row => ({
  id: ID(0x2000 + n), tenant_id: tenant, scope: 'all', amount_kind: 'flat', amount_paisa: 10_000, effective_from: T0, ...o,
});
export const trule = (n: number, tenant: string, o: Row = {}): Row => ({
  id: ID(0x2100 + n), tenant_id: tenant, scope: 'tenant_default', vat_treatment: 'exempt', effective_from: T0, ...o,
});
export const ttype = (n: number, tenant: string, code: string, o: Row = {}): Row => ({
  id: ID(0x2200 + n), tenant_id: tenant, code, display: `Synthetic ${code}`, rate_bp: 500, effective_from: T0, ...o,
});
export const orderable = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0x1000 + n), tenant_id: tenant, kind: 'test', code: `ORD${n}`, name: `Synthetic Orderable ${n}`, ...o });
export const plist = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0xa00 + n), tenant_id: tenant, code: `PL${n}`, name: `Synthetic List ${n}`, owner_kind: 'credit_party', ...o });
export const dept = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0x100 + n), tenant_id: tenant, code: `DEPT${n}`, name: `Department ${n}`, report_order: 10 * n, ...o });

export { MANAGE, READ, actorIdentity } from './creditPartiesDb.js';
export { TENANT_A, ID };
