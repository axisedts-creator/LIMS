// T-13 (C3) test fixture: in-memory Postgres fake for catalog.comment_codes and catalog.comment_code_texts (05-SCHEMA "Comment codes"),
// layered on the T-04 fake (mastersDb.ts -> catalogDb.ts) for catalog.departments (the FK target), catalog_state, core.event_log,
// app.enqueue_job and the tx/ctx machinery; reuses its SQL expression engine.
// Modelled for real (05-SCHEMA constraint names):
//   comment_codes       PK(id) | UNIQUE(tenant_id, id) | the EXPRESSION unique index comment_codes__tenant_id_code_dept__uq on
//                       (tenant_id, code, coalesce(department_id, '0000…'::uuid)) -> 23505 (so two tenant-wide rows with the same code collide,
//                       while the same code in one department and tenant-wide does not) | FK (tenant_id, department_id) -> departments -> 23503 |
//                       CHECK code ~ ^[A-Z0-9_]{1,16}$ and length(text) 1..2000 -> 23514 | NOT NULL -> 23502
//   comment_code_texts  PK | FK (tenant_id, comment_code_id) -> comment_codes -> 23503 | UNIQUE(tenant_id, comment_code_id, effective_from) -> 23505 |
//                       CHECK text_version >= 1, text 1..2000, effective_to >= effective_from | trigger comment_code_texts__mutable_columns:
//                       an UPDATE that changes any column except effective_to/updated_at/updated_by/version -> P0001 'immutable_row'
//   both                RLS (INSERT with a foreign tenant_id -> 42501; other tenants' rows invisible), DELETE -> 42501 (no DELETE grant),
//                       READ COMMITTED with lock-then-re-evaluate per (table, tenant), writes private to the tx until COMMIT,
//                       node-pg types (timestamptz -> Date: ISO-string binds are stored as Date).
// Time: `run(fn, { at })` fixes the transaction clock — ctx.now(), facade.startedAt and SQL now() all return `at` — so a text version's
// effective_from is deterministic whichever clock the service reads.
// SQL dialect: the one documented in mastersDb.ts (single-table SELECT/INSERT/UPDATE, bind params, no joins/subqueries/LIKE). A prefix filter is
// therefore a range predicate (code >= $n AND code < $m) or an in-code filter, and the department check is the FK (23503) or a departments SELECT.
// Synthetic data only.
import { STARTED_AT, TENANT_A, USER } from './catalogDb.js';
import { ID, RowLock, makeMastersDb, cmpAny, parseExpr, pgError, splitTop, tick, type MastersSeed, type Row } from './mastersDb.js';

export const COMMENT_TABLES = ['comment_codes', 'comment_code_texts'] as const;
export type CommentTable = (typeof COMMENT_TABLES)[number];
const COMMENT_RE = new RegExp(`catalog\\.(${COMMENT_TABLES.join('|')})\\b`, 'i');
export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const COLS: Record<CommentTable, string[]> = {
  comment_codes: ['id', 'tenant_id', 'code', 'department_id', 'text', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  comment_code_texts: ['id', 'tenant_id', 'comment_code_id', 'text_version', 'text', 'effective_from', 'effective_to', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'],
};
const NOT_NULL: Record<CommentTable, string[]> = {
  comment_codes: ['id', 'tenant_id', 'code', 'text', 'created_by', 'updated_by'],
  comment_code_texts: ['id', 'tenant_id', 'comment_code_id', 'text_version', 'text', 'effective_from', 'created_by', 'updated_by'],
};
const DATE_COLS = ['created_at', 'updated_at', 'effective_from', 'effective_to'];
const MUTABLE_TEXTS = ['effective_to', 'updated_at', 'updated_by', 'version'];
const toDate = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : v);
const same = (a: unknown, b: unknown) => (a instanceof Date || b instanceof Date ? +(a as Date) === +(b as Date) : a === b);
const len = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max;

export interface CommentsSeed extends Pick<MastersSeed, 'catalog'> { departments?: Row[]; rows?: Partial<Record<CommentTable, Row[]>> }

export function makeCommentsDb(seed: CommentsSeed = {}) {
  const m = makeMastersDb({ catalog: seed.catalog, rows: { departments: seed.departments ?? [] } });
  const committed = new Map<CommentTable, Map<string, Row>>(COMMENT_TABLES.map((t) => [t, new Map()]));
  const locks = new Map<string, RowLock>();
  const failures: Array<{ match: RegExp; make: () => Error }> = [];
  const lockOf = (k: string) => { let l = locks.get(k); if (!l) locks.set(k, (l = new RowLock())); return l; };
  let seq = 0;

  /** `db`: apply DB column defaults only (version, is_active, created_at, updated_at); `seed`: also default the audit actors. */
  function fill(t: CommentTable, r: Row, now: Date, mode: 'db' | 'seed'): Row {
    const o: Row = {};
    for (const c of COLS[t]) o[c] = r[c] ?? null;
    for (const c of DATE_COLS) if (c in o) o[c] = toDate(o[c]);
    o.version = r.version ?? 1;
    if (t === 'comment_codes') o.is_active = r.is_active ?? true;
    o.created_at = toDate(r.created_at) ?? now; o.updated_at = toDate(r.updated_at) ?? now;
    if (mode === 'seed') { o.created_by = r.created_by ?? USER; o.updated_by = r.updated_by ?? USER; }
    return o;
  }
  for (const t of COMMENT_TABLES) for (const r of seed.rows?.[t] ?? []) committed.get(t)!.set(r.id, fill(t, r, STARTED_AT, 'seed'));

  function begin(tenantId: string, actorId = USER, at: Date = STARTED_AT) {
    const mt = m.begin(tenantId, actorId);
    const local = new Map<CommentTable, Map<string, Row>>(COMMENT_TABLES.map((t) => [t, new Map()]));
    const held = new Set<string>();
    const now = at;
    const visible = (t: CommentTable): Row[] => {
      const map = new Map<string, Row>();
      for (const [id, r] of committed.get(t)!) if (r.tenant_id === tenantId) map.set(id, r);
      for (const [id, r] of local.get(t)!) map.set(id, r);
      return [...map.values()];
    };
    const take = async (t: CommentTable) => { const k = `${t}:${tenantId}`; await lockOf(k).acquire(mt.id); held.add(k); };
    const releaseAll = () => { for (const k of held) lockOf(k).release(mt.id); held.clear(); };
    const out = (rows: Row[], returning: string | undefined) => (returning ? { rows: rows.map((r) => ({ ...r })) } : { rows: [] as Row[] });

    function constraints(t: CommentTable, r: Row, self?: Row): void {
      const bad = (c: string): never => { throw pgError('23514', `new row for relation "${t}" violates check constraint "${c}"`, c); };
      for (const c of NOT_NULL[t]) if (r[c] == null) throw pgError('23502', `null value in column "${c}" violates not-null constraint`);
      if (!Number.isInteger(r.version)) throw pgError('22P02', 'invalid input syntax for type integer');
      const others = visible(t).filter((x) => x.id !== self?.id);
      if (t === 'comment_codes') {
        if (!(typeof r.code === 'string' && /^[A-Z0-9_]{1,16}$/.test(r.code))) bad('comment_codes__code__ck');
        if (!len(r.text, 1, 2000)) bad('comment_codes__text__ck');
        if (typeof r.is_active !== 'boolean') throw pgError('42804', 'column "is_active" is of type boolean');
        if (others.some((x) => x.id === r.id)) throw pgError('23505', 'duplicate key value violates unique constraint "comment_codes__pk"', 'comment_codes__pk');
        if (r.department_id != null && !m.rows('departments', tenantId).some((d) => d.id === r.department_id)) {
          throw pgError('23503', 'insert or update on table "comment_codes" violates foreign key constraint "comment_codes__department__fk"', 'comment_codes__department__fk');
        }
        if (others.some((x) => x.code === r.code && (x.department_id ?? ZERO_UUID) === (r.department_id ?? ZERO_UUID))) {
          throw pgError('23505', 'duplicate key value violates unique constraint "comment_codes__tenant_id_code_dept__uq"', 'comment_codes__tenant_id_code_dept__uq');
        }
      } else {
        if (!(Number.isInteger(r.text_version) && r.text_version >= 1)) bad('comment_code_texts__version__ck');
        if (!len(r.text, 1, 2000)) bad('comment_code_texts__text__ck');
        if (!(r.effective_from instanceof Date) || (r.effective_to != null && !(r.effective_to instanceof Date && +r.effective_to >= +r.effective_from))) bad('comment_code_texts__window__ck');
        if (others.some((x) => x.id === r.id)) throw pgError('23505', 'duplicate key value violates unique constraint "comment_code_texts__pk"', 'comment_code_texts__pk');
        if (!visible('comment_codes').some((c) => c.id === r.comment_code_id)) {
          throw pgError('23503', 'insert or update on table "comment_code_texts" violates foreign key constraint "comment_code_texts__code__fk"', 'comment_code_texts__code__fk');
        }
        if (others.some((x) => x.comment_code_id === r.comment_code_id && +x.effective_from === +r.effective_from)) {
          throw pgError('23505', 'duplicate key value violates unique constraint "comment_code_texts__tenant_id_code_id_from__uq"', 'comment_code_texts__tenant_id_code_id_from__uq');
        }
      }
    }

    async function insert(text: string, values: readonly unknown[]) {
      const x = /^INSERT INTO catalog\.(\w+) \(([^)]+)\) VALUES \((.+?)\)(?: ON CONFLICT .*?)?(?: RETURNING (.+))?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported INSERT: ${text.slice(0, 160)}`);
      const t = x[1]!.toLowerCase() as CommentTable;
      const cols = x[2]!.split(',').map((c) => c.trim());
      const exprs = splitTop(x[3]!);
      if (cols.length !== exprs.length) throw new Error('fake: INSERT column/value count mismatch');
      const raw: Row = {};
      cols.forEach((c, i) => { if (!COLS[t].includes(c)) throw pgError('42703', `column "${c}" does not exist`); raw[c] = parseExpr(exprs[i]!)({ row: undefined, values, now }); });
      if (raw.tenant_id !== tenantId) throw pgError('42501', `new row violates row-level security policy for table "${t}"`);
      await take(t);
      const r = fill(t, raw, now, 'db');
      try { constraints(t, r); } catch (e) { if ((e as { code?: string }).code === '23505' && /ON CONFLICT[\s\S]*DO NOTHING/i.test(text)) return { rows: [] as Row[] }; throw e; }
      local.get(t)!.set(r.id, r);
      return out([r], x[4]);
    }

    async function select(text: string, values: readonly unknown[]) {
      const x = /^SELECT (.+?) FROM catalog\.(\w+)(?: (?:AS )?(?!WHERE\b|ORDER\b|LIMIT\b|OFFSET\b|FOR\b)(\w+))?(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\S+))?(?: OFFSET (\S+))?(?: FOR (UPDATE|SHARE)(?: NOWAIT)?)?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported SELECT: ${text.slice(0, 160)}`);
      const t = x[2]!.toLowerCase() as CommentTable;
      if (x[8]?.toUpperCase() === 'UPDATE') await take(t);
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
      const t = x[1]!.toLowerCase() as CommentTable;
      await take(t);                                          // lock first, evaluate WHERE on the fresh committed state
      const sets = splitTop(x[3]!).map((s) => {
        const eq = s.indexOf('='); const col = s.slice(0, eq).trim();
        if (!COLS[t].includes(col)) throw pgError('42703', `column "${col}" does not exist`);
        return { col, ev: parseExpr(s.slice(eq + 1)) };
      });
      const where = parseExpr(x[4]!);
      const hit = visible(t).filter((r) => where({ row: r, values, now }) === true);
      const changed: Row[] = [];
      for (const r of hit) {
        const n: Row = { ...r };
        for (const s of sets) n[s.col] = s.ev({ row: r, values, now });
        for (const c of DATE_COLS) if (c in n) n[c] = toDate(n[c]);
        if (n.tenant_id !== tenantId) throw pgError('42501', 'new row violates row-level security policy');
        if (t === 'comment_code_texts') {
          for (const c of COLS[t]) if (!MUTABLE_TEXTS.includes(c) && !same(n[c], r[c])) throw pgError('P0001', 'immutable_row');
        }
        constraints(t, n, r);
        local.get(t)!.set(n.id, n); changed.push(n);
      }
      return out(changed, x[5]);
    }

    const facade: any = {
      ...mt.facade,
      startedAt: at,
      async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
        if (!COMMENT_RE.test(text)) return mt.facade.query(text, values);
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
      commit() { for (const t of COMMENT_TABLES) for (const [id, r] of local.get(t)!) committed.get(t)!.set(id, r); mt.commit(); releaseAll(); },
      rollback() { mt.rollback(); releaseAll(); },
    };
  }

  /** One transaction: COMMIT when fn resolves (unless `rollback`), ROLLBACK when it rejects. `at` = the transaction clock. */
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
    run, begin, base: m.base, masters: m,   // `masters` (T-25, additive): lets a composite mirror departments created elsewhere
    get stmts() { return m.stmts; },
    get events() { return m.events; },
    revisionOf: m.revisionOf,
    /** Committed rows of a table (all tenants unless filtered). */
    rows: (t: CommentTable, tenantId?: string): Row[] => [...committed.get(t)!.values()].filter((r) => tenantId === undefined || r.tenant_id === tenantId).map((r) => ({ ...r })),
    row: (t: CommentTable, id: string): Row | undefined => { const r = committed.get(t)!.get(id); return r ? { ...r } : undefined; },
    /** The text versions of one comment code, oldest first. */
    texts: (commentCodeId: string): Row[] => [...committed.get('comment_code_texts')!.values()].filter((r) => r.comment_code_id === commentCodeId).sort((a, b) => a.text_version - b.text_version).map((r) => ({ ...r })),
    newId: () => ID(0xa000 + ++seq),
    fail(match: RegExp, make: () => Error = () => new Error('injected')) { failures.push({ match, make }); m.fail(match, make); },
  };
}
export type CommentsDb = ReturnType<typeof makeCommentsDb>;

// ------------------------------------------------------------------------------------------------ seed factories (synthetic)
export { dept } from './mastersDb.js';
/** A comment code row. `department_id` omitted = tenant-wide. */
export const cc = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0xa00 + n), tenant_id: tenant, code: `CMT${n}`, text: `Synthetic comment ${n}.`, ...o });
/** A text-history row for a seeded comment code. */
export const ccText = (n: number, commentCodeId: string, tenant: string, o: Row = {}): Row => ({
  id: ID(0xb800 + n), tenant_id: tenant, comment_code_id: commentCodeId, text_version: 1, text: `Synthetic comment ${n}.`, effective_from: STARTED_AT, ...o,
});
