// T-17 (C3) test fixture: in-memory Postgres fake for the price-list tables (05-SCHEMA "Price lists"): catalog.price_lists, price_list_assignments, price_list_versions,
// price_list_items — PLUS catalog.doctors and code_counters (the doctor-merge reassignment runs in the same transaction) and READ-ONLY reference tables
// catalog.credit_parties, catalog.orderables, core.collection_centres (FK targets / existence checks; writes -> 42501). Layered on the T-04 fake
// (mastersDb.ts -> catalogDb.ts) for catalog_state, core.event_log, app.enqueue_job and the tx/ctx machinery. Same construction as doctorsDb.ts / creditPartiesDb.ts.
// Modelled for real (05-SCHEMA constraint names):
//   price_lists              UNIQUE(tenant, code) price_lists__tenant_id_code__uq | partial UNIQUE(tenant) WHERE owner_kind='default' price_lists__tenant_id__default__p_uq |
//                            CHECKs: code ~ ^[A-Z0-9][A-Z0-9_\-]{0,31}$, name 1..120, owner_kind enum, default => is_active (price_lists__default_active__ck) -> 23514
//   price_list_assignments   FK (tenant, price_list_id, owner_kind) -> price_lists; FK (tenant, credit_party_id|doctor_id|centre_id) -> credit_parties|doctors|collection_centres -> 23503;
//                            CHECK exactly one owner column matching owner_kind (…__one_owner__ck); partial UNIQUE per owner column (…credit_party_id|doctor_id|centre_id__p_uq) -> 23505
//   price_list_versions      UNIQUE(tenant, price_list_id, version_no); partial UNIQUE(tenant, price_list_id) WHERE status='draft' (…__draft__p_uq); status enum
//                            (draft|published|superseded|discarded); published/superseded need effective_from, published_at, change_reason (…__published_fields__ck);
//                            effective_to >= effective_from; change_reason <= 500
//                            TRIGGERS (05-SCHEMA §5.1): OLD.status <> 'draft' => only status, effective_to, updated_at, updated_by, version may change; transitions
//                            draft->draft|published|discarded, published->superseded, nothing else — violations raise P0001 "common.immutable_record"
//   price_list_items         UNIQUE(tenant, price_list_version_id, orderable_id); price 0..999999999 (price_list_items__price__ck); FK -> versions / orderables -> 23503;
//                            TRIGGER tg_parent_is_draft: INSERT/UPDATE/DELETE only while the parent version status='draft' — else P0001 "common.immutable_record"
//   doctors / code_counters  as doctorsDb.ts (UNIQUE doctor_code, merged_into FK/CHECKs); price_list_assignments.doctor_id FK -> doctors
//   all                      RLS (INSERT/UPDATE to a foreign tenant_id -> 42501; other tenants' rows invisible), READ COMMITTED with lock-then-re-evaluate per (table, tenant),
//                            writes private to the tx until COMMIT, node-pg types (timestamptz -> Date, bigint price stays a number here).
//                            DELETE is allowed ONLY on price_list_assignments and price_list_items (05-SCHEMA §5.3); every other table -> 42501.
// Time: `run(fn, { at })` fixes the transaction clock — ctx.now(), facade.startedAt and SQL now() all return `at`.
// SQL dialect: single-table SELECT / INSERT [ON CONFLICT] / UPDATE / DELETE with bind params exactly as doctorsDb.ts documents (no joins, subqueries, CASE, LIKE);
//   `= ANY($n)`, `count(*)`, ORDER BY col [DESC], LIMIT/OFFSET, FOR UPDATE; `<col> IS [NOT] NULL`; ISO strings compared as timestamps. A statement the engine cannot parse
//   raises "fake: unsupported SQL" — the writer adapts to the dialect (as T-15/T-16 writers did), the dialect is not widened for them.
// Synthetic data only.
import { LimsError } from '../../../../core/errors.js';
import { STARTED_AT, TENANT_A, USER } from './catalogDb.js';
import { ID, RowLock, makeMastersDb, cmpAny, parseExpr, pgError, splitTop, tick, type MastersSeed, type Row } from './mastersDb.js';

export const WRITABLE = ['price_lists', 'price_list_assignments', 'price_list_versions', 'price_list_items', 'doctors', 'code_counters'] as const;
export const REF = ['credit_parties', 'orderables', 'collection_centres'] as const;
export const ALL = [...WRITABLE, ...REF] as const;
export type PTable = (typeof ALL)[number];
const RE = new RegExp(`\\b(?:catalog|core)\\.(${ALL.join('|')})\\b`, 'i');
const isRef = (t: PTable) => (REF as readonly string[]).includes(t);

const COLS: Record<PTable, string[]> = {
  price_lists: ['id', 'tenant_id', 'code', 'name', 'owner_kind', 'falls_through', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  price_list_assignments: ['id', 'tenant_id', 'price_list_id', 'owner_kind', 'credit_party_id', 'doctor_id', 'centre_id', 'created_at', 'created_by'],
  price_list_versions: ['id', 'tenant_id', 'price_list_id', 'version_no', 'status', 'effective_from', 'effective_to', 'item_count', 'source_import_id', 'change_reason',
    'published_at', 'published_by', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  price_list_items: ['id', 'tenant_id', 'price_list_version_id', 'orderable_id', 'unit_price_paisa', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  doctors: ['id', 'tenant_id', 'doctor_code', 'display_name', 'name_normalised', 'qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'notes',
    'is_verified', 'verified_at', 'verified_by', 'source', 'merged_into_id', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  code_counters: ['tenant_id', 'counter_key', 'next_value', 'created_at', 'created_by', 'updated_at'],
  credit_parties: ['id', 'tenant_id', 'party_code', 'name', 'kind', 'allows_credit', 'is_active', 'version'],
  orderables: ['id', 'tenant_id', 'kind', 'code', 'name', 'department_id', 'sex_restriction', 'revision', 'version', 'is_active'],
  collection_centres: ['id', 'tenant_id', 'code', 'name', 'is_active'],
};
const NOT_NULL: Record<PTable, string[]> = {
  price_lists: ['id', 'tenant_id', 'code', 'name', 'owner_kind', 'falls_through', 'version', 'is_active', 'created_by', 'updated_by'],
  price_list_assignments: ['id', 'tenant_id', 'price_list_id', 'owner_kind', 'created_by'],
  price_list_versions: ['id', 'tenant_id', 'price_list_id', 'version_no', 'status', 'item_count', 'version', 'is_active', 'created_by', 'updated_by'],
  price_list_items: ['id', 'tenant_id', 'price_list_version_id', 'orderable_id', 'unit_price_paisa', 'version', 'created_by', 'updated_by'],
  doctors: ['id', 'tenant_id', 'doctor_code', 'display_name', 'name_normalised', 'is_verified', 'source', 'version', 'is_active', 'created_by', 'updated_by'],
  code_counters: ['tenant_id', 'counter_key', 'next_value', 'created_by'],
  credit_parties: ['id', 'tenant_id'], orderables: ['id', 'tenant_id'], collection_centres: ['id', 'tenant_id'],
};
const DATE_COLS = ['created_at', 'updated_at', 'verified_at', 'effective_from', 'effective_to', 'published_at'];
const toDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? new Date(v) : v);
const len = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max;
const keyOf = (t: PTable, r: Row) => (t === 'code_counters' ? `${r.tenant_id}:${r.counter_key}` : (r.id as string));
const MUTABLE_AFTER_DRAFT = ['status', 'effective_to', 'updated_at', 'updated_by', 'version'];
const TRANSITIONS: Record<string, string[]> = { draft: ['draft', 'published', 'discarded'], published: ['published', 'superseded'], superseded: ['superseded'], discarded: ['discarded'] };

export interface PricingSeed extends Pick<MastersSeed, 'catalog'> { rows?: Partial<Record<PTable, Row[]>> }

export function makePricingDb(seed: PricingSeed = {}) {
  const m = makeMastersDb({ catalog: seed.catalog, rows: {} });
  const committed = new Map<PTable, Map<string, Row>>(ALL.map((t) => [t, new Map()]));
  const locks = new Map<string, RowLock>();
  const failures: Array<{ match: RegExp; make: () => Error }> = [];
  const lockOf = (k: string) => { let l = locks.get(k); if (!l) locks.set(k, (l = new RowLock())); return l; };
  let seq = 0;

  function fill(t: PTable, r: Row, now: Date, mode: 'db' | 'seed'): Row {
    const o: Row = {};
    for (const c of COLS[t]) o[c] = r[c] === undefined ? null : r[c];
    for (const c of DATE_COLS) if (c in o) o[c] = toDate(o[c]);
    if ('created_at' in o) o.created_at = toDate(r.created_at) ?? now;
    if ('updated_at' in o) o.updated_at = toDate(r.updated_at) ?? now;
    if ('version' in o && !isRef(t)) o.version = r.version ?? 1;
    if ('is_active' in o) o.is_active = r.is_active ?? true;
    if (t === 'price_lists') o.falls_through = r.falls_through ?? true;
    if (t === 'price_list_versions') { o.status = r.status ?? 'draft'; o.item_count = r.item_count ?? 0; }
    if (t === 'code_counters') o.next_value = r.next_value ?? 1;
    if (t === 'doctors') o.is_verified = r.is_verified ?? false;
    if (mode === 'seed') { if ('created_by' in o) o.created_by = r.created_by ?? USER; if ('updated_by' in o) o.updated_by = r.updated_by ?? USER; }
    return o;
  }
  for (const t of ALL) for (const r of seed.rows?.[t] ?? []) { const f = fill(t, r, STARTED_AT, 'seed'); committed.get(t)!.set(keyOf(t, f), f); }

  function begin(tenantId: string, actorId = USER, at: Date = STARTED_AT) {
    const mt = m.begin(tenantId, actorId);
    const local = new Map<PTable, Map<string, Row | null>>(ALL.map((t) => [t, new Map()]));   // null = deleted in this tx
    const held = new Set<string>();
    const now = at;
    const visible = (t: PTable): Row[] => {
      const map = new Map<string, Row>();
      for (const [k, r] of committed.get(t)!) if (r.tenant_id === tenantId) map.set(k, r);
      for (const [k, r] of local.get(t)!) { if (r === null) map.delete(k); else map.set(k, r); }
      return [...map.values()];
    };
    const take = async (t: PTable) => { if (isRef(t)) return; const k = `${t}:${tenantId}`; await lockOf(k).acquire(mt.id); held.add(k); };
    const releaseAll = () => { for (const k of held) lockOf(k).release(mt.id); held.clear(); };
    const out = (rows: Row[], returning: string | undefined) => (returning ? { rows: rows.map((r) => ({ ...r })) } : { rows: [] as Row[] });
    const bindFix = (values: readonly unknown[]) => values.map(toDate);
    const bad = (t: PTable, c: string): never => { throw pgError('23514', `new row for relation "${t}" violates check constraint "${c}"`, c); };
    const dup = (c: string) => pgError('23505', `duplicate key value violates unique constraint "${c}"`, c);
    const immutable = (why: string): never => { throw pgError('P0001', `common.immutable_record: ${why}`); };

    function checks(t: PTable, r: Row): void {
      for (const c of NOT_NULL[t]) if (r[c] == null) throw pgError('23502', `null value in column "${c}" violates not-null constraint`);
      if (isRef(t)) return;
      if (t !== 'code_counters' && t !== 'price_list_assignments' && !Number.isInteger(r.version)) throw pgError('22P02', 'invalid input syntax for type integer');
      if ('is_active' in r && typeof r.is_active !== 'boolean') throw pgError('42804', 'column is of type boolean');
      switch (t) {
        case 'price_lists':
          if (typeof r.falls_through !== 'boolean') throw pgError('42804', 'column is of type boolean');
          if (!(typeof r.code === 'string' && /^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(r.code))) bad(t, 'price_lists__code__ck');
          if (!len(r.name, 1, 120)) bad(t, 'price_lists__name__ck');
          if (!['default', 'credit_party', 'referrer', 'centre'].includes(r.owner_kind)) bad(t, 'price_lists__owner_kind__ck');
          if (r.owner_kind === 'default' && r.is_active !== true) bad(t, 'price_lists__default_active__ck');
          break;
        case 'price_list_assignments': {
          if (!['credit_party', 'referrer', 'centre'].includes(r.owner_kind)) bad(t, 'pla__owner_kind__ck');
          const set = [r.credit_party_id, r.doctor_id, r.centre_id].filter((x) => x != null).length;
          const col = { credit_party: 'credit_party_id', referrer: 'doctor_id', centre: 'centre_id' }[r.owner_kind as string]!;
          if (set !== 1 || r[col] == null) bad(t, 'price_list_assignments__one_owner__ck');
          break;
        }
        case 'price_list_versions':
          if (!Number.isInteger(r.version_no) || r.version_no < 1) bad(t, 'price_list_versions__no__ck');
          if (!['draft', 'published', 'superseded', 'discarded'].includes(r.status)) bad(t, 'price_list_versions__status__ck');
          if (r.change_reason != null && !len(r.change_reason, 0, 500)) bad(t, 'price_list_versions__reason__ck');
          if (!['draft', 'discarded'].includes(r.status) && (r.effective_from == null || r.published_at == null || r.change_reason == null)) bad(t, 'price_list_versions__published_fields__ck');
          if (r.effective_to != null && r.effective_from != null && new Date(r.effective_to) < new Date(r.effective_from)) bad(t, 'price_list_versions__window__ck');
          if (!Number.isInteger(r.item_count)) throw pgError('22P02', 'invalid input syntax for type integer');
          break;
        case 'price_list_items':
          if (!((Number.isInteger(r.unit_price_paisa) || typeof r.unit_price_paisa === 'bigint') && Number(r.unit_price_paisa) >= 0 && Number(r.unit_price_paisa) <= 999_999_999)) bad(t, 'price_list_items__price__ck');
          break;
        case 'doctors':
          if (!(typeof r.doctor_code === 'string' && /^[A-Z0-9_-]{1,20}$/.test(r.doctor_code))) bad(t, 'doctors__code__ck');
          if (!len(r.display_name, 1, 120)) bad(t, 'doctors__name__ck');
          if (!['back_office', 'quick_add', 'import'].includes(r.source)) bad(t, 'doctors__source__ck');
          if (r.merged_into_id != null && r.merged_into_id === r.id) bad(t, 'doctors__merged_not_self__ck');
          if (r.merged_into_id != null && r.is_active !== false) bad(t, 'doctors__merged_inactive__ck');
          break;
        case 'code_counters':
          if (!['doctor_code', 'party_code'].includes(r.counter_key)) bad(t, 'code_counters__key__ck');
          if (!(Number.isInteger(r.next_value) || typeof r.next_value === 'bigint') || Number(r.next_value) < 1) bad(t, 'code_counters__next__ck');
          break;
      }
    }
    function clash(t: PTable, r: Row, self?: Row): { constraint: string; row: Row } | undefined {
      const others = visible(t).filter((x) => !self || keyOf(t, x) !== keyOf(t, self));
      const hit = (pred: (o: Row) => boolean, constraint: string) => { const x = others.find(pred); return x ? { constraint, row: x } : undefined; };
      switch (t) {
        case 'code_counters': return hit((o) => o.counter_key === r.counter_key, 'code_counters__pk');
        case 'price_lists':
          return hit((o) => o.id === r.id, 'price_lists__pk') ?? hit((o) => o.code === r.code, 'price_lists__tenant_id_code__uq')
            ?? (r.owner_kind === 'default' ? hit((o) => o.owner_kind === 'default', 'price_lists__tenant_id__default__p_uq') : undefined);
        case 'price_list_assignments':
          return hit((o) => o.id === r.id, 'price_list_assignments__pk')
            ?? (r.credit_party_id != null ? hit((o) => o.credit_party_id === r.credit_party_id, 'price_list_assignments__tenant_id_credit_party_id__p_uq') : undefined)
            ?? (r.doctor_id != null ? hit((o) => o.doctor_id === r.doctor_id, 'price_list_assignments__tenant_id_doctor_id__p_uq') : undefined)
            ?? (r.centre_id != null ? hit((o) => o.centre_id === r.centre_id, 'price_list_assignments__tenant_id_centre_id__p_uq') : undefined);
        case 'price_list_versions':
          return hit((o) => o.id === r.id, 'price_list_versions__pk')
            ?? hit((o) => o.price_list_id === r.price_list_id && o.version_no === r.version_no, 'price_list_versions__tenant_id_price_list_id_version_no__uq')
            ?? (r.status === 'draft' ? hit((o) => o.price_list_id === r.price_list_id && o.status === 'draft', 'price_list_versions__tenant_id_price_list_id__draft__p_uq') : undefined);
        case 'price_list_items':
          return hit((o) => o.id === r.id, 'price_list_items__pk')
            ?? hit((o) => o.price_list_version_id === r.price_list_version_id && o.orderable_id === r.orderable_id, 'price_list_items__tenant_id_version_id_orderable_id__uq');
        case 'doctors':
          return hit((o) => o.id === r.id, 'doctors__pk') ?? hit((o) => o.doctor_code === r.doctor_code, 'doctors__tenant_id_doctor_code__uq');
        default: return undefined;
      }
    }
    const fkFail = (c: string): never => { throw pgError('23503', `insert or update violates foreign key constraint "${c}"`, c); };
    function fk(t: PTable, r: Row): void {
      const has = (target: PTable, id: unknown) => id != null && visible(target).some((x) => x.id === id);
      if (t === 'price_list_assignments') {
        if (!visible('price_lists').some((x) => x.id === r.price_list_id && x.owner_kind === r.owner_kind)) fkFail('price_list_assignments__list__fk');
        if (r.credit_party_id != null && !has('credit_parties', r.credit_party_id)) fkFail('price_list_assignments__party__fk');
        if (r.doctor_id != null && !has('doctors', r.doctor_id)) fkFail('price_list_assignments__doctor__fk');
        if (r.centre_id != null && !has('collection_centres', r.centre_id)) fkFail('price_list_assignments__centre__fk');
      } else if (t === 'price_list_versions') { if (!has('price_lists', r.price_list_id)) fkFail('price_list_versions__list__fk'); }
      else if (t === 'price_list_items') {
        if (!has('price_list_versions', r.price_list_version_id)) fkFail('price_list_items__version__fk');
        if (!has('orderables', r.orderable_id)) fkFail('price_list_items__orderable__fk');
      } else if (t === 'doctors' && r.merged_into_id != null && !has('doctors', r.merged_into_id)) fkFail('doctors__merged_into__fk');
    }
    /** 05-SCHEMA §5 triggers. `old` undefined = INSERT, `n` undefined = DELETE. */
    function triggers(t: PTable, old: Row | undefined, n: Row | undefined): void {
      if (t === 'price_list_items') {
        const parent = visible('price_list_versions').find((v) => v.id === (n ?? old)!.price_list_version_id);
        if (parent && parent.status !== 'draft') immutable('price_list_items of a non-draft version');
      }
      if (t === 'price_list_versions' && old && n) {
        if (!(TRANSITIONS[old.status] ?? []).includes(n.status)) immutable(`status ${old.status} -> ${n.status}`);
        if (old.status !== 'draft') for (const c of COLS[t]) if (!MUTABLE_AFTER_DRAFT.includes(c) && cmpAny(old[c], n[c]) !== 0 && !(old[c] == null && n[c] == null)) immutable(`column ${c} of a ${old.status} version`);
      }
    }

    async function insert(text: string, values: readonly unknown[]) {
      const x = /^INSERT INTO (?:catalog|core)\.(\w+) \(([^)]+)\) VALUES \((.+?)\)(?: ON CONFLICT(?: \([^)]*\))? (DO NOTHING|DO UPDATE SET (.+?)))?(?: RETURNING (.+))?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported INSERT: ${text.slice(0, 160)}`);
      const t = x[1]!.toLowerCase() as PTable;
      if (isRef(t)) throw pgError('42501', `permission denied for table ${t}`);
      const cols = x[2]!.split(',').map((c) => c.trim());
      const exprs = splitTop(x[3]!);
      if (cols.length !== exprs.length) throw new Error('fake: INSERT column/value count mismatch');
      const raw: Row = {};
      cols.forEach((c, i) => { if (!COLS[t].includes(c)) throw pgError('42703', `column "${c}" does not exist`); raw[c] = parseExpr(exprs[i]!)({ row: undefined, values, now }); });
      if (raw.tenant_id !== tenantId) throw pgError('42501', `new row violates row-level security policy for table "${t}"`);
      await take(t);
      const r = fill(t, raw, now, 'db');
      triggers(t, undefined, r);                           // BEFORE ROW triggers fire before NOT NULL / CHECK / UNIQUE / FK (as in Postgres)
      checks(t, r);
      const c = clash(t, r);
      if (c) {
        if (!x[4]) throw dup(c.constraint);
        if (/^DO NOTHING$/i.test(x[4])) return { rows: [] as Row[] };
        const n: Row = { ...c.row };
        for (const s of splitTop(x[5]!)) {
          const eq = s.indexOf('='); const col = s.slice(0, eq).trim();
          if (!COLS[t].includes(col)) throw pgError('42703', `column "${col}" does not exist`);
          n[col] = parseExpr(s.slice(eq + 1))({ row: c.row, values, now });
        }
        for (const d of DATE_COLS) if (d in n) n[d] = toDate(n[d]);
        triggers(t, c.row, n); checks(t, n);
        local.get(t)!.set(keyOf(t, n), n);
        return out([n], x[6]);
      }
      fk(t, r);
      local.get(t)!.set(keyOf(t, r), r);
      return out([r], x[6]);
    }

    function where(text: string | undefined, values: readonly unknown[]) {
      if (!text) return { pred: (_r: Row) => true };
      const ev = parseExpr(text);
      const vals = bindFix(values);
      return { pred: (r: Row) => ev({ row: r, values: vals, now }) === true };
    }

    async function select(text: string, values: readonly unknown[]) {
      const x = /^SELECT (.+?) FROM (?:catalog|core)\.(\w+)(?: (?:AS )?(?!WHERE\b|ORDER\b|LIMIT\b|OFFSET\b|FOR\b)(\w+))?(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\S+))?(?: OFFSET (\S+))?(?: FOR (UPDATE|SHARE)(?: NOWAIT)?)?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported SELECT: ${text.slice(0, 160)}`);
      const t = x[2]!.toLowerCase() as PTable;
      if (x[8]?.toUpperCase() === 'UPDATE') await take(t);
      let rows = visible(t).filter(where(x[4], values).pred);
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
      const x = /^UPDATE (?:catalog|core)\.(\w+)(?: (?:AS )?(?!SET\b)(\w+))? SET (.+?) WHERE (.+?)(?: RETURNING (.+))?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported UPDATE (a WHERE clause is required): ${text.slice(0, 160)}`);
      const t = x[1]!.toLowerCase() as PTable;
      if (isRef(t)) throw pgError('42501', `permission denied for table ${t}`);
      await take(t);                                          // lock first, evaluate WHERE on the fresh committed state
      const sets = splitTop(x[3]!).map((s) => {
        const eq = s.indexOf('='); const col = s.slice(0, eq).trim();
        if (!COLS[t].includes(col)) throw pgError('42703', `column "${col}" does not exist`);
        return { col, ev: parseExpr(s.slice(eq + 1)) };
      });
      const hit = visible(t).filter(where(x[4], values).pred);
      const changed: Row[] = [];
      for (const r of hit) {
        const n: Row = { ...r };
        for (const s of sets) n[s.col] = s.ev({ row: r, values, now });
        for (const c of DATE_COLS) if (c in n) n[c] = toDate(n[c]);
        if (n.tenant_id !== tenantId) throw pgError('42501', 'new row violates row-level security policy');
        triggers(t, r, n);
        checks(t, n);
        const c = clash(t, n, r); if (c) throw dup(c.constraint);
        fk(t, n);
        local.get(t)!.set(keyOf(t, n), n);
        changed.push(n);
      }
      return out(changed, x[5]);
    }

    async function del(text: string, values: readonly unknown[]) {
      const x = /^DELETE FROM (?:catalog|core)\.(\w+)(?: (?:AS )?(?!WHERE\b)(\w+))? WHERE (.+?)(?: RETURNING (.+))?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported DELETE (a WHERE clause is required): ${text.slice(0, 160)}`);
      const t = x[1]!.toLowerCase() as PTable;
      if (t !== 'price_list_assignments' && t !== 'price_list_items') throw pgError('42501', `permission denied for table ${t} (no DELETE grant)`);
      await take(t);
      const hit = visible(t).filter(where(x[3], values).pred);
      for (const r of hit) { triggers(t, r, undefined); local.get(t)!.set(keyOf(t, r), null); }
      return out(hit, x[4]);
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
        if (/^DELETE/i.test(s)) return del(s, values);
        throw new Error(`fake: unsupported SQL: ${s.slice(0, 160)}`);
      },
      savepoint: async <T>(fn: (t: unknown) => Promise<T>) => fn(facade),
    };
    return {
      id: mt.id, tenantId, actorId, facade,
      commit() {
        for (const t of ALL) for (const [k, r] of local.get(t)!) { if (r === null) committed.get(t)!.delete(k); else committed.get(t)!.set(k, r); }
        mt.commit(); releaseAll();
      },
      rollback() { mt.rollback(); releaseAll(); },
    };
  }

  /** One transaction: COMMIT when fn resolves (unless `rollback`), ROLLBACK when it rejects. `at` = the transaction clock, `ctx` = ctx overrides (ports, …). */
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
    /** Committed rows of a table (all tenants unless filtered). */
    rows: (t: PTable, tenantId?: string): Row[] => [...committed.get(t)!.values()].filter((r) => tenantId === undefined || r.tenant_id === tenantId).map((r) => ({ ...r })),
    row: (t: PTable, id: string): Row | undefined => { const r = committed.get(t)!.get(id); return r ? { ...r } : undefined; },
    newId: () => ID(0xd700 + ++seq),
    fail(match: RegExp, make: () => Error = () => new Error('injected')) { failures.push({ match, make }); m.fail(match, make); },
  };
}
export type PricingDb = ReturnType<typeof makePricingDb>;

// ------------------------------------------------------------------------------------------------ seed factories (synthetic)
const T0 = new Date('2026-01-01T00:00:00.000Z');
/** A price list (default owner_kind credit_party, active, falls_through true). `n` makes a distinct id + code `PL{n}`. */
export const plist = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0xa00 + n), tenant_id: tenant, code: `PL${n}`, name: `Synthetic List ${n}`, owner_kind: 'credit_party', ...o });
/** The tenant's default list. */
export const defaultList = (n: number, tenant: string, o: Row = {}): Row => plist(n, tenant, { owner_kind: 'default', code: `DEFAULT${n}`, ...o });
/** A version of list `listId`. Published ones get the three published-fields-check columns; `status:'draft'` needs none. */
export const pver = (n: number, tenant: string, listId: string, versionNo: number, o: Row = {}): Row => {
  const status = (o.status as string | undefined) ?? 'draft';
  const pub = status === 'published' || status === 'superseded';
  return {
    id: ID(0xb00 + n), tenant_id: tenant, price_list_id: listId, version_no: versionNo, status,
    ...(pub ? { effective_from: T0, published_at: T0, published_by: USER, change_reason: 'Synthetic seed' } : {}), ...o,
  };
};
export const pitem = (n: number, tenant: string, versionId: string, orderableId: string, paisa: number, o: Row = {}): Row =>
  ({ id: ID(0xe00 + n), tenant_id: tenant, price_list_version_id: versionId, orderable_id: orderableId, unit_price_paisa: paisa, ...o });
export const passign = (n: number, tenant: string, listId: string, ownerKind: 'credit_party' | 'referrer' | 'centre', ownerId: string, o: Row = {}): Row => ({
  id: ID(0xf00 + n), tenant_id: tenant, price_list_id: listId, owner_kind: ownerKind,
  credit_party_id: ownerKind === 'credit_party' ? ownerId : null, doctor_id: ownerKind === 'referrer' ? ownerId : null, centre_id: ownerKind === 'centre' ? ownerId : null, ...o,
});
export const orderable = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0x1000 + n), tenant_id: tenant, kind: 'test', code: `ORD${n}`, name: `Synthetic Orderable ${n}`, ...o });
export const centre = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0x1100 + n), tenant_id: tenant, code: `CEN${n}`, name: `Synthetic Centre ${n}`, ...o });
export const party = (n: number, tenant: string, o: Row = {}): Row => ({ id: ID(0x1200 + n), tenant_id: tenant, party_code: `CPX${n}`, name: `Synthetic Party ${n}`, kind: 'hospital', ...o });

export { MANAGE, READ, actorIdentity } from './creditPartiesDb.js';
export { doc, ctr, normName } from './doctorsDb.js';
export { LimsError };
export { TENANT_A, ID };
