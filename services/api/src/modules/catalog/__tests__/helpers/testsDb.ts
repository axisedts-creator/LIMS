// T-06 (C3) test fixture: in-memory Postgres fake for catalog.orderables / tests / panels / test_specimen_types and (seed-only)
// analytes / analyte_versions, layered on the T-04 fake (mastersDb.ts: departments, specimen_types, containers, methods) and the T-03 fake
// (catalogDb.ts: catalog_state + core.event_log + row lock). One tx facade routes SQL by CONTENT; statements on the T-06 tables are
// handled here, everything else is delegated untouched.
// Modelled for real (05-SCHEMA §4 orderables/tests/test_specimen_types):
//   - RLS: a tx sees/changes only rows of its own tenant; INSERT with a foreign tenant_id raises 42501. A statement WITHOUT a tenant predicate is
//     therefore still safe here — explicit-predicate rules are asserted separately on `stmts`.
//   - READ COMMITTED + lock-then-re-evaluate (same as mastersDb): INSERT/UPDATE/DELETE/SELECT..FOR UPDATE take a lock per (table, tenant) held to
//     COMMIT/ROLLBACK; the WHERE runs AFTER the lock is granted against freshly committed state. Writes are private to the tx until COMMIT.
//   - Constraints: orderables PK / UNIQUE(tenant_id, code) -> 23505, CHECKs -> 23514 (code regex, name length, sex, test_has_department),
//     FK department -> 23503; tests FK (id, kind) -> orderables -> 23503, workflow/report_order CHECKs; test_specimen_types PK(test, specimen_type),
//     partial UNIQUE (tenant_id, test_id) WHERE is_preferred -> 23505, min_volume_ul CHECK, FKs test/specimen type/container -> 23503
//     (specimen types / containers / departments are looked up in COMMITTED masters rows). DELETE is allowed on test_specimen_types only
//     (association table); every other table raises 42501 (lims_app has no DELETE grant).
//   - analytes / analyte_versions / panels are SEED-ONLY: SELECT works, any write throws "fake: unsupported" (their writers are T-07 / T-12).
// SQL dialect (anything else throws "fake: unsupported SQL" — the writer must stay inside it; one table per statement, no joins/subqueries):
//   INSERT INTO catalog.<t> (cols) VALUES (exprs)[, (exprs)…] [RETURNING cols|*]
//   SELECT <anything|count(*)> FROM catalog.<t> [alias] [WHERE expr] [ORDER BY expr [ASC|DESC], …] [LIMIT n|$n] [OFFSET n|$n] [FOR UPDATE|SHARE]
//   UPDATE catalog.<t> [alias] SET col = expr, … WHERE expr [RETURNING cols|*]
//   DELETE FROM catalog.test_specimen_types [alias] WHERE expr [RETURNING cols|*]
//   expr: see the dialect in mastersDb.ts (LIKE/ILIKE … ESCAPE, ||, UPPER, LENGTH, CASE, = ANY($n), row tuples, COALESCE …).
// Synthetic data only.
import { STARTED_AT, TENANT_A, USER } from './catalogDb.js';
import { ID, RowLock, makeMastersDb, parseExpr, pgError, splitTop, tick, type MastersSeed, type Row } from './mastersDb.js';

export { ID, type Row };
export const T6_TABLES = ['orderables', 'tests', 'panels', 'test_specimen_types', 'analytes', 'analyte_versions'] as const;
export type T6Table = (typeof T6_TABLES)[number];
const TABLE_RE = new RegExp(`catalog\\.(${T6_TABLES.join('|')})\\b`, 'i');
const WRITABLE = new Set<T6Table>(['orderables', 'tests', 'test_specimen_types']);

const COLUMNS: Record<T6Table, string[]> = {
  orderables: ['id', 'tenant_id', 'kind', 'code', 'name', 'department_id', 'sex_restriction', 'is_orderable', 'revision', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  tests: ['id', 'tenant_id', 'kind', 'workflow_type', 'report_order', 'uses_existing_material', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  panels: ['id', 'tenant_id', 'kind', 'panel_kind', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  test_specimen_types: ['tenant_id', 'test_id', 'specimen_type_id', 'container_id', 'is_preferred', 'min_volume_ul', 'created_at', 'created_by'],
  analytes: ['id', 'tenant_id', 'test_id', 'code', 'name', 'print_name', 'report_subheading', 'sort_order', 'is_reportable', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  analyte_versions: ['id', 'tenant_id', 'analyte_id', 'version_no', 'status', 'result_type', 'unit_code', 'decimals', 'method_id', 'value_set_code', 'formula_expression', 'formula_inputs',
    'formula_input_units', 'effective_from', 'effective_to', 'change_reason', 'published_at', 'published_by', 'source_import_id', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
};
const NOT_NULL: Record<T6Table, string[]> = {
  orderables: ['id', 'tenant_id', 'kind', 'code', 'name', 'is_orderable', 'revision', 'created_by', 'updated_by'],
  tests: ['id', 'tenant_id', 'kind', 'workflow_type', 'report_order', 'uses_existing_material', 'created_by', 'updated_by'],
  panels: ['id', 'tenant_id', 'kind', 'panel_kind'],
  test_specimen_types: ['tenant_id', 'test_id', 'specimen_type_id', 'is_preferred', 'created_by'],
  analytes: ['id', 'tenant_id', 'test_id', 'code', 'name'],
  analyte_versions: ['id', 'tenant_id', 'analyte_id', 'version_no', 'status', 'result_type'],
};
const WORKFLOWS = ['standard', 'narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced'];
const keyOf = (t: T6Table, r: Row): string => (t === 'test_specimen_types' ? `${r.test_id}:${r.specimen_type_id}` : r.id);
const LEN = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max;

function checks(t: T6Table, r: Row): void {
  const bad = (c: string) => { throw pgError('23514', `new row for relation "${t}" violates check constraint "${c}"`, c); };
  if (t === 'orderables') {
    if (!['test', 'panel'].includes(r.kind)) bad('orderables__kind__ck');
    if (!(typeof r.code === 'string' && /^[A-Z0-9][A-Z0-9_\-+.]{0,31}$/.test(r.code))) bad('orderables__code__ck');
    if (!LEN(r.name, 1, 200)) bad('orderables__name__ck');
    if (r.sex_restriction != null && !['male', 'female'].includes(r.sex_restriction)) bad('orderables__sex__ck');
    if (r.kind === 'test' && r.department_id == null) bad('orderables__test_has_department__ck');
  }
  if (t === 'tests') {
    if (r.kind !== 'test') bad('tests__kind__ck');
    if (!WORKFLOWS.includes(r.workflow_type)) bad('tests__workflow__ck');
    if (!(Number.isInteger(r.report_order) && r.report_order >= 0 && r.report_order <= 9999)) bad('tests__order__ck');
  }
  if (t === 'test_specimen_types' && r.min_volume_ul != null && !(Number.isInteger(r.min_volume_ul) && r.min_volume_ul >= 1 && r.min_volume_ul <= 100000)) bad('test_specimen_types__vol__ck');
}

export interface TestsSeed extends MastersSeed { t6?: Partial<Record<T6Table, Row[]>> }

export function makeTestsDb(seed: TestsSeed = {}) {
  const masters = makeMastersDb(seed);
  const base = masters.base;
  const committed = new Map<T6Table, Map<string, Row>>(T6_TABLES.map((t) => [t, new Map()]));
  const locks = new Map<string, RowLock>();
  const failures: Array<{ match: RegExp; make: () => Error }> = [];
  const lockOf = (k: string) => { let l = locks.get(k); if (!l) locks.set(k, (l = new RowLock())); return l; };
  let seq = 0;

  function fill(t: T6Table, r: Row): Row {
    const o: Row = {};
    for (const c of COLUMNS[t]) o[c] = r[c] ?? null;
    if ('version' in o) o.version = r.version ?? 1;
    if ('is_active' in o) o.is_active = r.is_active ?? true;
    if ('created_at' in o) { o.created_at = r.created_at ?? STARTED_AT; o.created_by = r.created_by ?? USER; }
    if ('updated_at' in o) { o.updated_at = r.updated_at ?? STARTED_AT; o.updated_by = r.updated_by ?? USER; }
    if (t === 'orderables') { o.is_orderable = r.is_orderable ?? true; o.revision = r.revision ?? 0; }
    if (t === 'tests') { o.kind = 'test'; o.report_order = r.report_order ?? 100; o.uses_existing_material = r.uses_existing_material ?? false; }
    if (t === 'panels') o.kind = 'panel';
    if (t === 'test_specimen_types') o.is_preferred = r.is_preferred ?? false;
    if (t === 'analytes') { o.sort_order = r.sort_order ?? 100; o.is_reportable = r.is_reportable ?? true; }
    if (t === 'analyte_versions') o.formula_inputs = r.formula_inputs ?? [];
    return o;
  }
  for (const t of T6_TABLES) for (const r of seed.t6?.[t] ?? []) committed.get(t)!.set(keyOf(t, r), fill(t, r));

  function begin(tenantId: string, actorId = USER) {
    const mtx = masters.begin(tenantId, actorId);
    const local = new Map<T6Table, Map<string, Row | null>>(T6_TABLES.map((t) => [t, new Map()]));
    const held = new Set<string>();
    const now = STARTED_AT;
    const visible = (t: T6Table): Row[] => {
      const m = new Map<string, Row>();
      for (const [k, r] of committed.get(t)!) if (r.tenant_id === tenantId) m.set(k, r);
      for (const [k, r] of local.get(t)!) { if (r === null) m.delete(k); else m.set(k, r); }
      return [...m.values()];
    };
    const take = async (t: T6Table) => { const k = `${t}:${tenantId}`; await lockOf(k).acquire(mtx.id); held.add(k); };
    const releaseAll = () => { for (const k of held) lockOf(k).release(mtx.id); held.clear(); };
    const master = (tbl: 'departments' | 'specimen_types' | 'containers', id: unknown) => id != null && masters.row(tbl, String(id))?.tenant_id === tenantId;
    const out = (rows: Row[], returning: string | undefined) => (returning ? { rows: rows.map((r) => ({ ...r })) } : { rows: [] as Row[] });

    /** All constraints for a row about to be written; `self` = the key of the row being replaced (UPDATE) so it does not conflict with itself. */
    function validate(t: T6Table, r: Row, self?: string, pending: Row[] = []): void {
      for (const c of NOT_NULL[t]) if (r[c] == null) throw pgError('23502', `null value in column "${c}" violates not-null constraint`);
      checks(t, r);
      const others = [...visible(t).filter((x) => keyOf(t, x) !== self), ...pending];
      if (t === 'test_specimen_types') {
        if (others.some((x) => keyOf(t, x) === keyOf(t, r))) throw pgError('23505', 'duplicate key value violates unique constraint "test_specimen_types__pk"', 'test_specimen_types__pk');
        if (r.is_preferred && others.some((x) => x.test_id === r.test_id && x.is_preferred)) {
          throw pgError('23505', 'duplicate key value violates unique constraint "test_specimen_types__tenant_id_test_id__preferred__p_uq"', 'test_specimen_types__tenant_id_test_id__preferred__p_uq');
        }
        if (!visible('tests').some((x) => x.id === r.test_id)) throw pgError('23503', 'violates foreign key constraint "test_specimen_types__test__fk"', 'test_specimen_types__test__fk');
        if (!master('specimen_types', r.specimen_type_id)) throw pgError('23503', 'violates foreign key constraint "test_specimen_types__type__fk"', 'test_specimen_types__type__fk');
        if (r.container_id != null && !master('containers', r.container_id)) throw pgError('23503', 'violates foreign key constraint "test_specimen_types__container__fk"', 'test_specimen_types__container__fk');
        return;
      }
      if (others.some((x) => x.id === r.id)) throw pgError('23505', `duplicate key value violates unique constraint "${t}__pk"`, `${t}__pk`);
      if (t === 'orderables') {
        if (others.some((x) => x.code === r.code)) throw pgError('23505', 'duplicate key value violates unique constraint "orderables__tenant_id_code__uq"', 'orderables__tenant_id_code__uq');
        if (r.department_id != null && !master('departments', r.department_id)) throw pgError('23503', 'violates foreign key constraint "orderables__department__fk"', 'orderables__department__fk');
      }
      if (t === 'tests' && !visible('orderables').some((x) => x.id === r.id && x.kind === r.kind)) throw pgError('23503', 'violates foreign key constraint "tests__orderable__fk"', 'tests__orderable__fk');
    }

    const target = (m: RegExpExecArray | null, text: string, kind: string): T6Table => {
      if (!m) throw new Error(`fake: unsupported ${kind}: ${text.slice(0, 160)}`);
      const t = m[1]!.toLowerCase() as T6Table;
      if (!WRITABLE.has(t)) throw new Error(`fake: unsupported ${kind} on seed-only table catalog.${t}`);
      return t;
    };

    async function insert(text: string, values: readonly unknown[]) {
      const m = /^INSERT INTO catalog\.(\w+) \(([^)]+)\) VALUES (.+?)(?: RETURNING (.+))?$/i.exec(text);
      const t = target(m, text, 'INSERT');
      const cols = m![2]!.split(',').map((c) => c.trim());
      const groups = splitTop(m![3]!);
      const added: Row[] = [];
      await take(t);
      for (const g of groups) {
        if (!/^\(.*\)$/s.test(g)) throw new Error(`fake: unsupported INSERT VALUES: ${g.slice(0, 80)}`);
        const exprs = splitTop(g.slice(1, -1));
        if (cols.length !== exprs.length) throw new Error('fake: INSERT column/value count mismatch');
        const raw: Row = {};
        cols.forEach((c, i) => { if (!COLUMNS[t].includes(c)) throw pgError('42703', `column "${c}" does not exist`); raw[c] = parseExpr(exprs[i]!)({ row: undefined, values, now }); });
        if (raw.tenant_id !== tenantId) throw pgError('42501', `new row violates row-level security policy for table "${t}"`);
        const r = fill(t, raw);
        validate(t, r, undefined, added);
        added.push(r);
      }
      for (const r of added) local.get(t)!.set(keyOf(t, r), r);
      return out(added, m![4]);
    }

    async function select(text: string, values: readonly unknown[]) {
      const m = /^SELECT (.+?) FROM catalog\.(\w+)(?: (?:AS )?(?!WHERE\b|ORDER\b|LIMIT\b|OFFSET\b|FOR\b)(\w+))?(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\S+))?(?: OFFSET (\S+))?(?: FOR (UPDATE|SHARE)(?: NOWAIT)?)?$/i.exec(text);
      if (!m) throw new Error(`fake: unsupported SELECT: ${text.slice(0, 160)}`);
      const t = m[2]!.toLowerCase() as T6Table;
      if (m[8]?.toUpperCase() === 'UPDATE') await take(t);
      const where = m[4] ? parseExpr(m[4]) : () => true;
      let rows = visible(t).filter((r) => where({ row: r, values, now }) === true);
      if (m[5]) {
        const keys = splitTop(m[5]).map((k) => { const mm = /^(.*?)(?:\s+(ASC|DESC))?$/i.exec(k.trim().replace(/\s+COLLATE\s+"C"/i, ''))!; // fake compares by code point == COLLATE "C" return { ev: parseExpr(mm[1]!), desc: /^DESC$/i.test(mm[2] ?? '') }; });
        const dec = rows.map((r) => ({ r, k: keys.map((k) => k.ev({ row: r, values, now })) }));
        dec.sort((a, b) => {
          for (let i = 0; i < keys.length; i++) {
            const x = a.k[i], y = b.k[i];
            const c = x == null || y == null ? 0 : x instanceof Date || y instanceof Date ? +x - +y : x < y ? -1 : x > y ? 1 : 0;
            if (c) return keys[i]!.desc ? -c : c;
          }
          return 0;
        });
        rows = dec.map((d) => d.r);
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
      const t = target(m, `${text} (a WHERE clause is required)`, 'UPDATE');
      await take(t);                                          // lock first, evaluate WHERE on the fresh committed state
      const sets = splitTop(m![3]!).map((s) => {
        const eq = s.indexOf('='); const col = s.slice(0, eq).trim();
        if (!COLUMNS[t].includes(col)) throw pgError('42703', `column "${col}" does not exist`);
        return { col, ev: parseExpr(s.slice(eq + 1)) };
      });
      const where = parseExpr(m![4]!);
      const hit = visible(t).filter((r) => where({ row: r, values, now }) === true);
      const changed: Row[] = [];
      for (const r of hit) {
        const n: Row = { ...r };
        for (const s of sets) n[s.col] = s.ev({ row: r, values, now });
        if (n.tenant_id !== tenantId) throw pgError('42501', 'new row violates row-level security policy');
        validate(t, n, keyOf(t, r));
        local.get(t)!.set(keyOf(t, n), n); changed.push(n);
      }
      return out(changed, m![5]);
    }

    async function del(text: string, values: readonly unknown[]) {
      const m = /^DELETE FROM catalog\.(\w+)(?: (?:AS )?(?!WHERE\b)(\w+))? WHERE (.+?)(?: RETURNING (.+))?$/i.exec(text);
      if (!m) throw new Error(`fake: unsupported DELETE (a WHERE clause is required): ${text.slice(0, 160)}`);
      const t = m[1]!.toLowerCase() as T6Table;
      if (t !== 'test_specimen_types') throw pgError('42501', `permission denied for table ${t} (lims_app has no DELETE grant)`);
      await take(t);
      const where = parseExpr(m[3]!);
      const hit = visible(t).filter((r) => where({ row: r, values, now }) === true);
      for (const r of hit) local.get(t)!.set(keyOf(t, r), null);
      return out(hit, m[4]);
    }

    const facade: any = {
      startedAt: STARTED_AT,
      operation: { module: 'catalog', operationId: 'fake', context: 'tenant' },
      async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
        if (!TABLE_RE.test(text)) return mtx.facade.query(text, values);
        await tick();
        base.stmts.push({ txId: mtx.id, tenantId, text, values });
        const f = failures.find((x) => x.match.test(text));
        if (f) throw f.make();
        const t = text.replace(/\s+/g, ' ').trim();
        if (/^INSERT/i.test(t)) return insert(t, values);
        if (/^SELECT/i.test(t)) return select(t, values);
        if (/^UPDATE/i.test(t)) return update(t, values);
        if (/^DELETE/i.test(t)) return del(t, values);
        throw new Error(`fake: unsupported SQL: ${t.slice(0, 160)}`);
      },
      savepoint: async <T>(fn: (t: unknown) => Promise<T>) => fn(facade),
    };
    return {
      id: mtx.id, tenantId, actorId, facade,
      commit() {
        for (const t of T6_TABLES) for (const [k, r] of local.get(t)!) { if (r === null) committed.get(t)!.delete(k); else committed.get(t)!.set(k, r); }
        mtx.commit(); releaseAll();
      },
      rollback() { mtx.rollback(); releaseAll(); },
    };
  }

  type Tx = ReturnType<typeof begin>;
  /** One transaction: COMMIT when fn resolves (unless `rollback`), ROLLBACK when it rejects. */
  async function run<T>(fn: (ctx: ReturnType<typeof masters.ctxFor>) => Promise<T>, o: { tenantId?: string; rollback?: boolean; actorId?: string; ctx?: Record<string, unknown> } = {}): Promise<T> {
    const tx = begin(o.tenantId ?? TENANT_A, o.actorId ?? USER);
    try {
      const r = await fn(masters.ctxFor(tx as never, o.ctx));
      if (o.rollback) throw new Error('forced rollback');
      tx.commit();
      return r;
    } catch (e) { tx.rollback(); throw e; }
  }

  return {
    run, begin: begin as (tenantId: string, actorId?: string) => Tx, ctxFor: masters.ctxFor, masters, base,
    get stmts() { return base.stmts; },
    get events() { return base.events; },
    revisionOf: base.revisionOf,
    /** Statements that touched the T-06 tables. */
    t6Stmts: () => base.stmts.filter((s) => TABLE_RE.test(s.text)),
    rows: (t: T6Table, tenantId?: string): Row[] => [...committed.get(t)!.values()].filter((r) => tenantId === undefined || r.tenant_id === tenantId).map((r) => ({ ...r })),
    row: (t: T6Table, key: string): Row | undefined => { const r = committed.get(t)!.get(key); return r ? { ...r } : undefined; },
    orderableRevision: (id: string): number | undefined => committed.get('orderables')!.get(id)?.revision,
    newId: () => ID(0xe000 + ++seq),
    fail(match: RegExp, make: () => Error = () => new Error('injected')) { failures.push({ match, make }); masters.fail(match, make); },
  };
}
export type TestsDb = ReturnType<typeof makeTestsDb>;

// ------------------------------------------------------------------------------------------------ seed factories (synthetic)
/** An orderable row (kind test) + its tests row. */
export const tst = (n: number, tenant: string, dept: string, o: Row = {}): { orderable: Row; test: Row } => {
  const id = ID(0x1000 + n);
  return {
    orderable: { id, tenant_id: tenant, kind: 'test', code: o['code'] ?? `T${n}`, name: o['name'] ?? `Test ${n}`, department_id: dept, sex_restriction: o['sex_restriction'] ?? null,
      is_orderable: o['is_orderable'] ?? true, revision: o['revision'] ?? 0, version: o['version'] ?? 1, is_active: o['is_active'] ?? true },
    test: { id, tenant_id: tenant, workflow_type: o['workflow_type'] ?? 'standard', report_order: o['report_order'] ?? 100, uses_existing_material: o['uses_existing_material'] ?? false,
      version: o['version'] ?? 1, is_active: o['is_active'] ?? true },
  };
};
/** An orderable row (kind panel) + its panels row. */
export const pnl = (n: number, tenant: string, o: Row = {}): { orderable: Row; panel: Row } => {
  const id = ID(0x2000 + n);
  return {
    orderable: { id, tenant_id: tenant, kind: 'panel', code: o['code'] ?? `P${n}`, name: o['name'] ?? `Panel ${n}`, department_id: o['department_id'] ?? null, sex_restriction: o['sex_restriction'] ?? null,
      is_orderable: o['is_orderable'] ?? true, revision: o['revision'] ?? 0, is_active: o['is_active'] ?? true },
    panel: { id, tenant_id: tenant, panel_kind: o['panel_kind'] ?? 'clinical', is_active: o['is_active'] ?? true },
  };
};
export const tsr = (testId: string, specimenTypeId: string, tenant: string, o: Row = {}): Row => ({ tenant_id: tenant, test_id: testId, specimen_type_id: specimenTypeId, container_id: o['container_id'] ?? null, is_preferred: o['is_preferred'] ?? false, min_volume_ul: o['min_volume_ul'] ?? null });
export const ana = (n: number, tenant: string, testId: string, o: Row = {}): Row => ({ id: ID(0x3000 + n), tenant_id: tenant, test_id: testId, code: o['code'] ?? `AN${n}`, name: o['name'] ?? `Analyte ${n}`, ...o });
export const anv = (n: number, tenant: string, analyteId: string, o: Row = {}): Row => ({ id: ID(0x4000 + n), tenant_id: tenant, analyte_id: analyteId, version_no: 1, status: 'published', result_type: 'numeric', decimals: 1,
  effective_from: new Date(Date.UTC(2026, 0, 1)), published_at: new Date(Date.UTC(2026, 0, 1)), change_reason: 'initial', ...o });
