// T-05 (C3) test fixture: in-memory Postgres fake for the coded sets — GLOBAL catalog.g_units / g_value_sets / g_value_set_values (no tenant,
// read-only for lims_app: GRANT SELECT only, 05-SCHEMA §10) and TENANT catalog.cs_units / cs_value_sets / cs_value_set_values — plus a
// read-only catalog.analyte_versions (seed only; the in-use rule reads it). Layered on the T-04 fake (mastersDb.ts -> catalogDb.ts) for
// catalog_state, core.event_log, app.enqueue_job and the tx/ctx machinery; reuses its SQL expression engine.
// Modelled for real (05-SCHEMA constraint names): PK(id), UNIQUE(tenant_id, code) / (tenant_id, value_set_id, code) -> 23505, CHECKs -> 23514,
// NOT NULL -> 23502, cs_value_set_values FK (tenant_id, value_set_id) -> cs_value_sets -> 23503, RLS (foreign tenant_id on INSERT -> 42501,
// tenant rows of other tenants invisible), writes to g_* / analyte_versions -> 42501, DELETE -> 42501 (no DELETE grant on these tables),
// READ COMMITTED with lock-then-re-evaluate per (table, tenant), writes private to the tx until COMMIT.
// NOT modelled on purpose: "a tenant code must differ from a global code" is a SERVICE rule (05-SCHEMA comment above cs_units) — the DB lets
// it through, so a service that forgets the g_* lookup is caught by the tests.
// SQL dialect: the one documented in mastersDb.ts (single-table SELECT/INSERT/UPDATE, bind params, no joins/subqueries/UNION) — a
// global ∪ tenant list is therefore two SELECTs merged in code. Synthetic data only.
import { STARTED_AT, USER, TENANT_A } from './catalogDb.js';
import { ID, RowLock, makeMastersDb, cmpAny, parseExpr, pgError, splitTop, tick, type MastersSeed, type Row } from './mastersDb.js';

export const SET_TABLES = ['g_units', 'g_value_sets', 'g_value_set_values', 'cs_units', 'cs_value_sets', 'cs_value_set_values', 'analyte_versions'] as const;
export type SetTable = (typeof SET_TABLES)[number];
const SET_RE = new RegExp(`catalog\\.(${SET_TABLES.join('|')})\\b`, 'i');

interface Def { tenant: boolean; writable: boolean; cols: string[]; notNull: string[]; sortDefault?: number; check(r: Row, bad: (c: string) => never): void; unique: Array<{ name: string; cols: string[] }> }
const AUDIT = ['version', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const len = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max;
const unitCk = (t: string) => (r: Row, bad: (c: string) => never) => {
  if (!(typeof r.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(r.code))) bad(`${t}__code__ck`);
  if (!len(r.display, 0, 32)) bad(`${t}__display__ck`);
};
const setCk = (t: string) => (r: Row, bad: (c: string) => never) => {
  if (!(typeof r.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(r.code))) bad(`${t}__code__ck`);
  if (!len(r.display, 1, 80)) bad(`${t}__display__ck`);
  if (typeof r.is_ordered !== 'boolean') bad(`${t}__is_ordered__ck`);
};
const valCk = (t: string) => (r: Row, bad: (c: string) => never) => {
  if (!(typeof r.code === 'string' && /^[A-Z0-9_+-]{1,16}$/.test(r.code))) bad(`${t}__code__ck`);
  if (!len(r.display, 0, 40)) bad(`${t}__display__ck`);
  if (!Number.isInteger(r.sort_order)) bad(`${t}__sort_order__ck`);
};
const DEFS: Record<SetTable, Def> = {
  g_units: { tenant: false, writable: false, sortDefault: 100, cols: ['id', 'code', 'display', 'sort_order', 'is_active', 'created_at'], notNull: ['id', 'code', 'display'], check: unitCk('g_units'), unique: [{ name: 'g_units__code__uq', cols: ['code'] }] },
  g_value_sets: { tenant: false, writable: false, cols: ['id', 'code', 'display', 'is_ordered', 'is_active', 'created_at'], notNull: ['id', 'code', 'display', 'is_ordered'], check: setCk('g_value_sets'), unique: [{ name: 'g_value_sets__code__uq', cols: ['code'] }] },
  g_value_set_values: { tenant: false, writable: false, cols: ['id', 'value_set_code', 'code', 'display', 'system', 'system_version', 'sort_order', 'is_active', 'created_at'], notNull: ['id', 'value_set_code', 'code', 'display', 'sort_order'], check: valCk('g_value_set_values'), unique: [{ name: 'g_value_set_values__set_code__uq', cols: ['value_set_code', 'code'] }] },
  cs_units: { tenant: true, writable: true, sortDefault: 100, cols: ['id', 'tenant_id', 'code', 'display', 'system', 'system_version', 'sort_order', 'is_active', ...AUDIT], notNull: ['id', 'tenant_id', 'code', 'display', 'created_by', 'updated_by'], check: unitCk('cs_units'), unique: [{ name: 'cs_units__tenant_id_code__uq', cols: ['tenant_id', 'code'] }] },
  cs_value_sets: { tenant: true, writable: true, cols: ['id', 'tenant_id', 'code', 'display', 'is_ordered', 'is_active', ...AUDIT], notNull: ['id', 'tenant_id', 'code', 'display', 'is_ordered', 'created_by', 'updated_by'], check: setCk('cs_value_sets'), unique: [{ name: 'cs_value_sets__tenant_id_code__uq', cols: ['tenant_id', 'code'] }] },
  cs_value_set_values: { tenant: true, writable: true, cols: ['id', 'tenant_id', 'value_set_id', 'code', 'display', 'system', 'system_version', 'sort_order', 'is_active', ...AUDIT], notNull: ['id', 'tenant_id', 'value_set_id', 'code', 'display', 'sort_order', 'created_by', 'updated_by'], check: valCk('cs_value_set_values'), unique: [{ name: 'cs_value_set_values__set_code__uq', cols: ['tenant_id', 'value_set_id', 'code'] }] },
  analyte_versions: { tenant: true, writable: false, cols: ['id', 'tenant_id', 'analyte_id', 'version_no', 'status', 'result_type', 'unit_code', 'decimals', 'method_id', 'value_set_code', 'is_active', ...AUDIT], notNull: ['id', 'tenant_id'], check: () => {}, unique: [] },
};

export interface SetsSeed extends Pick<MastersSeed, 'catalog'> { rows?: Partial<Record<SetTable, Row[]>> }

export function makeSetsDb(seed: SetsSeed = {}) {
  const m = makeMastersDb({ catalog: seed.catalog });
  const committed = new Map<SetTable, Map<string, Row>>(SET_TABLES.map((t) => [t, new Map()]));
  const locks = new Map<string, RowLock>();
  const failures: Array<{ match: RegExp; make: () => Error }> = [];
  const lockOf = (k: string) => { let l = locks.get(k); if (!l) locks.set(k, (l = new RowLock())); return l; };
  let seq = 0;

  function fill(t: SetTable, r: Row): Row {
    const d = DEFS[t]; const o: Row = {};
    for (const c of d.cols) o[c] = r[c] ?? null;
    if (d.cols.includes('is_active')) o.is_active = r.is_active ?? true;
    if (d.cols.includes('version')) o.version = r.version ?? 1;
    if (d.cols.includes('created_at')) o.created_at = r.created_at ?? STARTED_AT;
    if (d.cols.includes('updated_at')) o.updated_at = r.updated_at ?? STARTED_AT;
    if (d.cols.includes('created_by')) o.created_by = r.created_by ?? USER;
    if (d.cols.includes('updated_by')) o.updated_by = r.updated_by ?? USER;
    if (d.sortDefault !== undefined) o.sort_order = r.sort_order ?? d.sortDefault;
    return o;
  }
  for (const t of SET_TABLES) for (const r of seed.rows?.[t] ?? []) committed.get(t)!.set(r.id, fill(t, r));

  function begin(tenantId: string, actorId = USER) {
    const mt = m.begin(tenantId, actorId);
    const local = new Map<SetTable, Map<string, Row>>(SET_TABLES.map((t) => [t, new Map()]));
    const held = new Set<string>();
    const now = STARTED_AT;
    const visible = (t: SetTable): Row[] => {
      const map = new Map<string, Row>();
      for (const [id, r] of committed.get(t)!) if (!DEFS[t].tenant || r.tenant_id === tenantId) map.set(id, r);
      for (const [id, r] of local.get(t)!) map.set(id, r);
      return [...map.values()];
    };
    const take = async (t: SetTable) => { if (!DEFS[t].tenant) return; const k = `${t}:${tenantId}`; await lockOf(k).acquire(mt.id); held.add(k); };
    const releaseAll = () => { for (const k of held) lockOf(k).release(mt.id); held.clear(); };
    const out = (rows: Row[], returning: string | undefined) => (returning ? { rows: rows.map((r) => ({ ...r })) } : { rows: [] as Row[] });
    const readOnly = (t: SetTable) => pgError('42501', `permission denied for table ${t}`);

    function constraints(t: SetTable, r: Row, self?: Row): void {
      const d = DEFS[t];
      for (const c of d.notNull) if (r[c] == null) throw pgError('23502', `null value in column "${c}" violates not-null constraint`);
      d.check(r, (c) => { throw pgError('23514', `new row for relation "${t}" violates check constraint "${c}"`, c); });
      const others = visible(t).filter((x) => x.id !== self?.id);
      if (others.some((x) => x.id === r.id)) throw pgError('23505', `duplicate key value violates unique constraint "${t}__pk"`, `${t}__pk`);
      for (const u of d.unique) if (others.some((x) => u.cols.every((c) => x[c] === r[c]))) throw pgError('23505', `duplicate key value violates unique constraint "${u.name}"`, u.name);
      if (t === 'cs_value_set_values' && !visible('cs_value_sets').some((s) => s.id === r.value_set_id)) {
        throw pgError('23503', 'insert or update on table "cs_value_set_values" violates foreign key constraint "cs_value_set_values__set__fk"', 'cs_value_set_values__set__fk');
      }
    }

    async function insert(text: string, values: readonly unknown[]) {
      const x = /^INSERT INTO catalog\.(\w+) \(([^)]+)\) VALUES \((.+?)\)(?: ON CONFLICT .*?)?(?: RETURNING (.+))?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported INSERT: ${text.slice(0, 160)}`);
      const t = x[1]!.toLowerCase() as SetTable;
      if (!DEFS[t].writable) throw readOnly(t);
      const cols = x[2]!.split(',').map((c) => c.trim());
      const exprs = splitTop(x[3]!);
      if (cols.length !== exprs.length) throw new Error('fake: INSERT column/value count mismatch');
      const raw: Row = {};
      cols.forEach((c, i) => { if (!DEFS[t].cols.includes(c)) throw pgError('42703', `column "${c}" does not exist`); raw[c] = parseExpr(exprs[i]!)({ row: undefined, values, now }); });
      if (raw.tenant_id !== tenantId) throw pgError('42501', `new row violates row-level security policy for table "${t}"`);
      await take(t);
      const r = fill(t, raw);
      try { constraints(t, r); } catch (e) { if ((e as { code?: string }).code === '23505' && /ON CONFLICT[\s\S]*DO NOTHING/i.test(text)) return { rows: [] as Row[] }; throw e; }
      local.get(t)!.set(r.id, r);
      return out([r], x[4]);
    }

    async function select(text: string, values: readonly unknown[]) {
      const x = /^SELECT (.+?) FROM catalog\.(\w+)(?: (?:AS )?(?!WHERE\b|ORDER\b|LIMIT\b|OFFSET\b|FOR\b)(\w+))?(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\S+))?(?: OFFSET (\S+))?(?: FOR (UPDATE|SHARE)(?: NOWAIT)?)?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported SELECT: ${text.slice(0, 160)}`);
      const t = x[2]!.toLowerCase() as SetTable;
      if (x[8]?.toUpperCase() === 'UPDATE') { if (!DEFS[t].writable) throw readOnly(t); await take(t); }
      const where = x[4] ? parseExpr(x[4]) : () => true;
      let rows = visible(t).filter((r) => where({ row: r, values, now }) === true);
      if (x[5]) {
        const keys = splitTop(x[5]).map((k) => { const p = k.trim().split(/\s+/); return { col: p[0]!.slice(p[0]!.lastIndexOf('.') + 1), desc: /^DESC$/i.test(p[1] ?? '') }; });
        rows.sort((a, b) => { for (const k of keys) { const c = cmpAny(a[k.col], b[k.col]) ?? 0; if (c) return k.desc ? -c : c; } return 0; });
      }
      const num = (s: string | undefined) => (s === undefined ? undefined : s.startsWith('$') ? Number(values[Number(s.slice(1)) - 1]) : Number(s));
      const off = num(x[7]); const lim = num(x[6]);
      if (off) rows = rows.slice(off);
      if (lim !== undefined) { if (!Number.isInteger(lim) || lim < 0) throw pgError('2201W', 'LIMIT must not be negative'); rows = rows.slice(0, lim); }
      if (/^count\(\*\)/i.test(x[1]!.trim())) return { rows: [{ count: String(rows.length) }] };
      return { rows: rows.map((r) => ({ ...r })) };
    }

    async function update(text: string, values: readonly unknown[]) {
      const x = /^UPDATE catalog\.(\w+)(?: (?:AS )?(?!SET\b)(\w+))? SET (.+?) WHERE (.+?)(?: RETURNING (.+))?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported UPDATE (a WHERE clause is required): ${text.slice(0, 160)}`);
      const t = x[1]!.toLowerCase() as SetTable;
      if (!DEFS[t].writable) throw readOnly(t);
      await take(t);                                          // lock first, evaluate WHERE on the fresh committed state
      const sets = splitTop(x[3]!).map((s) => {
        const eq = s.indexOf('='); const col = s.slice(0, eq).trim();
        if (!DEFS[t].cols.includes(col)) throw pgError('42703', `column "${col}" does not exist`);
        return { col, ev: parseExpr(s.slice(eq + 1)) };
      });
      const where = parseExpr(x[4]!);
      const hit = visible(t).filter((r) => where({ row: r, values, now }) === true);
      const changed: Row[] = [];
      for (const r of hit) {
        const n: Row = { ...r };
        for (const s of sets) n[s.col] = s.ev({ row: r, values, now });
        if (n.tenant_id !== tenantId) throw pgError('42501', 'new row violates row-level security policy');
        constraints(t, n, r);
        local.get(t)!.set(n.id, n); changed.push(n);
      }
      return out(changed, x[5]);
    }

    const facade: any = {
      ...mt.facade,
      async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
        if (!SET_RE.test(text)) return mt.facade.query(text, values);
        await tick();
        m.base.stmts.push({ txId: mt.id, tenantId, text, values });
        const f = failures.find((y) => y.match.test(text));
        if (f) throw f.make();
        const s = text.replace(/\s+/g, ' ').trim();
        if (/^INSERT/i.test(s)) return insert(s, values);
        if (/^SELECT/i.test(s)) return select(s, values);
        if (/^UPDATE/i.test(s)) return update(s, values);
        if (/^DELETE/i.test(s)) throw pgError('42501', 'permission denied for table (lims_app has no DELETE grant)');
        throw new Error(`fake: unsupported SQL: ${s.slice(0, 160)}`);
      },
      savepoint: async <T>(fn: (t: unknown) => Promise<T>) => fn(facade),
    };
    return {
      id: mt.id, tenantId, actorId, facade,
      commit() { for (const t of SET_TABLES) for (const [id, r] of local.get(t)!) committed.get(t)!.set(id, r); mt.commit(); releaseAll(); },
      rollback() { mt.rollback(); releaseAll(); },
    };
  }

  /** One transaction: COMMIT when fn resolves (unless `rollback`), ROLLBACK when it rejects. */
  async function run<T>(fn: (ctx: ReturnType<typeof m.ctxFor>) => Promise<T>, o: { tenantId?: string; rollback?: boolean; actorId?: string; ctx?: Record<string, unknown> } = {}): Promise<T> {
    const tx = begin(o.tenantId ?? TENANT_A, o.actorId ?? USER);
    try {
      const r = await fn(m.ctxFor(tx as never, o.ctx));
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
    /** Committed rows of a table (tenant tables: all tenants unless filtered). */
    rows: (t: SetTable, tenantId?: string): Row[] => [...committed.get(t)!.values()].filter((r) => tenantId === undefined || r.tenant_id === tenantId).map((r) => ({ ...r })),
    row: (t: SetTable, id: string): Row | undefined => { const r = committed.get(t)!.get(id); return r ? { ...r } : undefined; },
    newId: () => ID(0xe000 + ++seq),
    fail(match: RegExp, make: () => Error = () => new Error('injected')) { failures.push({ match, make }); m.fail(match, make); },
  };
}
export type SetsDb = ReturnType<typeof makeSetsDb>;

// ------------------------------------------------------------------------------------------------ seed factories (synthetic)
export const gUnit = (n: number, o: Row = {}): Row => ({ id: ID(0x500 + n), code: `gu_${n}`, display: `gu ${n}`, ...o });
export const gSet = (n: number, o: Row = {}): Row => ({ id: ID(0x600 + n), code: `GSET${n}`, display: `Global set ${n}`, is_ordered: false, ...o });
let valueSeq = 0;                                    // value rows: unique ids across a test file; deterministic per import order
export const gVal = (setCode: string, n: number, o: Row = {}): Row => ({ id: ID(0xd000 + ++valueSeq), value_set_code: setCode, code: `V${n}`, display: `Value ${n}`, sort_order: n * 10, ...o });
export const unit = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0x800 + n), tenant_id: tenant, code: `lab_u${n}`, display: `lab ${n}`, ...o });
export const vset = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0x900 + n), tenant_id: tenant, code: `TSET${n}`, display: `Lab set ${n}`, is_ordered: false, ...o });
export const vval = (setId: string, n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0xd800 + ++valueSeq), tenant_id: tenant, value_set_id: setId, code: `V${n}`, display: `Value ${n}`, sort_order: n * 10, ...o });
/** An analyte version row as the in-use rule sees it: (tenant, value_set_code, status). */
export const av = (n: number, tenant: string, valueSetCode: string | null, status: string, o: Row = {}): Row => ({
  id: ID(0xb00 + n), tenant_id: tenant, analyte_id: ID(0xc00 + n), version_no: 1, status, result_type: valueSetCode ? 'ordinal' : 'numeric', value_set_code: valueSetCode, ...o,
});
