// T-15 (C3) test fixture: in-memory Postgres fake for catalog.doctors and catalog.code_counters (05-SCHEMA "Doctors and credit parties", §code_counters),
// layered on the T-04 fake (mastersDb.ts -> catalogDb.ts) for catalog_state, core.event_log, app.enqueue_job and the tx/ctx machinery; reuses its SQL
// expression engine. Same construction as commentsDb.ts (T-13).
// Modelled for real (05-SCHEMA constraint names):
//   doctors        PK(id) | UNIQUE(tenant_id, doctor_code) doctors__tenant_id_doctor_code__uq -> 23505 | FK (tenant_id, merged_into_id) -> doctors -> 23503 |
//                  CHECKs -> 23514: doctor_code ~ ^[A-Z0-9_\-]{1,20}$, display_name 1..120, qualification <=120, registration_council <=20, registration_no <=30,
//                  phone_e164 ~ ^\+[1-9][0-9]{7,14}$, email <=254, notes <=500, source IN (back_office, quick_add, import), merged_into_id <> id,
//                  merged_into_id IS NULL OR is_active = false | NOT NULL -> 23502 (name_normalised included: it is service-computed)
//   code_counters  PK(tenant_id, counter_key) | CHECK counter_key IN (doctor_code, party_code), next_value >= 1 | next_value = the NEXT value to hand out (default 1)
//   both           RLS (INSERT with a foreign tenant_id -> 42501; other tenants' rows invisible), DELETE -> 42501 (no DELETE grant), READ COMMITTED with
//                  lock-then-re-evaluate per (table, tenant), writes private to the tx until COMMIT, node-pg types (timestamptz -> Date).
// Time: `run(fn, { at })` fixes the transaction clock — ctx.now(), facade.startedAt and SQL now() all return `at`.
// SQL dialect: the one documented in mastersDb.ts (single-table SELECT/INSERT/UPDATE, bind params, no joins/subqueries/CASE/DELETE) PLUS:
//   * `<col | lower(col)> [NOT] LIKE|ILIKE <$n | 'lit'> [ESCAPE '<c>']` (default escape is backslash, as Postgres) — evaluated for real, so an unescaped % or _ in a
//     search term WILL act as a wildcard here (REQ-SEC-082 probes depend on it);
//   * INSERT … ON CONFLICT [(cols)] DO NOTHING | DO UPDATE SET col = expr, … RETURNING … (expr sees the EXISTING row via col or table.col; no EXCLUDED.*);
//   * ISO-8601 string binds are compared as timestamps in WHERE (Postgres casts the parameter to the column type).
//   Ranking (exact code > code prefix > name prefix > name contains) therefore has to be computed in code or with several SELECTs, not ORDER BY CASE.
// A statement on catalog.price_list_assignments / price_lists is NOT modelled (T-17 owns price-list reassignment at merge): it raises "fake: unsupported SQL".
// Synthetic data only.
import { LimsError } from '../../../../core/errors.js';
import { STARTED_AT, TENANT_A, USER } from './catalogDb.js';
import { ID, RowLock, makeMastersDb, cmpAny, parseExpr, pgError, splitTop, tick, type MastersSeed, type Row } from './mastersDb.js';

export const DOCTOR_TABLES = ['doctors', 'code_counters'] as const;
export type DoctorTable = (typeof DOCTOR_TABLES)[number];
const DOCTOR_RE = new RegExp(`catalog\\.(${DOCTOR_TABLES.join('|')})\\b`, 'i');

const COLS: Record<DoctorTable, string[]> = {
  doctors: ['id', 'tenant_id', 'doctor_code', 'display_name', 'name_normalised', 'qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'notes',
    'is_verified', 'verified_at', 'verified_by', 'source', 'merged_into_id', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  code_counters: ['tenant_id', 'counter_key', 'next_value', 'created_at', 'created_by', 'updated_at'],
};
const NOT_NULL: Record<DoctorTable, string[]> = {
  doctors: ['id', 'tenant_id', 'doctor_code', 'display_name', 'name_normalised', 'is_verified', 'source', 'version', 'is_active', 'created_by', 'updated_by'],
  code_counters: ['tenant_id', 'counter_key', 'next_value', 'created_by'],
};
const DATE_COLS = ['created_at', 'updated_at', 'verified_at'];
const toDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? new Date(v) : v);
const len = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max;
const optLen = (v: unknown, max: number) => v == null || len(v, 0, max);
const keyOf = (t: DoctorTable, r: Row) => (t === 'doctors' ? (r.id as string) : `${r.tenant_id}:${r.counter_key}`);

/** The documented normalisation (05-SCHEMA name_normalised: lower, NFC, single spaces; APP-FLOW F-09: trim, collapse spaces, NFC). Used by seed factories only. */
export const normName = (s: string): string => s.normalize('NFC').toLowerCase().trim().replace(/ +/g, ' ');

export interface DoctorsSeed extends Pick<MastersSeed, 'catalog'> { rows?: Partial<Record<DoctorTable, Row[]>> }

// LIKE rewriting: `<col> LIKE <pattern>` becomes `<col> = ANY($k)` with $k = the distinct column values of the visible rows that match (computed here).
const LIKE_RE = /((?:lower\(\s*)?[A-Za-z_][A-Za-z0-9_.]*(?:\s*\))?)\s+(NOT\s+)?(I?LIKE)\s+(\$\d+|'(?:[^']|'')*')(?:\s+ESCAPE\s+('(?:[^']|'')*'|\$\d+))?/gi;
function likeRegex(pattern: string, esc: string, insensitive: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === esc) { if (i + 1 >= pattern.length) throw pgError('22025', 'LIKE pattern must not end with escape character'); re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    else if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, insensitive ? 'i' : '');
}
function rewriteLike(where: string, rows: Row[], values: readonly unknown[]): { sql: string; values: unknown[] } {
  const vals = [...values];
  const lit = (s: string) => s.slice(1, -1).replaceAll("''", "'");
  const arg = (s: string) => (s.startsWith('$') ? String(values[Number(s.slice(1)) - 1]) : lit(s));
  const sql = where.replace(LIKE_RE, (_m, colExpr: string, neg: string | undefined, kind: string, pat: string, escRaw: string | undefined) => {
    const lowered = /^lower\(/i.test(colExpr);
    const col = colExpr.replace(/^lower\(\s*/i, '').replace(/\s*\)$/, '');
    const name = col.slice(col.lastIndexOf('.') + 1);
    const esc = escRaw === undefined ? '\\' : arg(escRaw);
    if (esc.length !== 1) throw pgError('22019', 'invalid escape string');
    const re = likeRegex(arg(pat), esc, kind.toUpperCase() === 'ILIKE');
    const hits = new Set<string>();
    for (const r of rows) { const raw = r[name]; if (typeof raw !== 'string') continue; const v = lowered ? raw.toLowerCase() : raw; if (re.test(v)) hits.add(v); }
    vals.push([...hits]);
    return `${neg ? 'NOT ' : ''}(${colExpr} = ANY($${vals.length}))`;
  });
  return { sql, values: vals };
}

export function makeDoctorsDb(seed: DoctorsSeed = {}) {
  const m = makeMastersDb({ catalog: seed.catalog, rows: {} });
  const committed = new Map<DoctorTable, Map<string, Row>>(DOCTOR_TABLES.map((t) => [t, new Map()]));
  const locks = new Map<string, RowLock>();
  const failures: Array<{ match: RegExp; make: () => Error }> = [];
  const lockOf = (k: string) => { let l = locks.get(k); if (!l) locks.set(k, (l = new RowLock())); return l; };
  let seq = 0;

  /** `db`: apply DB column defaults only; `seed`: also default the audit actors. */
  function fill(t: DoctorTable, r: Row, now: Date, mode: 'db' | 'seed'): Row {
    const o: Row = {};
    for (const c of COLS[t]) o[c] = r[c] === undefined ? null : r[c];
    for (const c of DATE_COLS) if (c in o) o[c] = toDate(o[c]);
    o.created_at = toDate(r.created_at) ?? now; o.updated_at = toDate(r.updated_at) ?? now;
    if (t === 'doctors') { o.version = r.version ?? 1; o.is_active = r.is_active ?? true; o.is_verified = r.is_verified ?? false; }
    else o.next_value = r.next_value ?? 1;
    if (mode === 'seed') { o.created_by = r.created_by ?? USER; if (t === 'doctors') o.updated_by = r.updated_by ?? USER; }
    return o;
  }
  for (const t of DOCTOR_TABLES) for (const r of seed.rows?.[t] ?? []) { const f = fill(t, r, STARTED_AT, 'seed'); committed.get(t)!.set(keyOf(t, f), f); }

  function begin(tenantId: string, actorId = USER, at: Date = STARTED_AT) {
    const mt = m.begin(tenantId, actorId);
    const local = new Map<DoctorTable, Map<string, Row>>(DOCTOR_TABLES.map((t) => [t, new Map()]));
    const held = new Set<string>();
    const now = at;
    const visible = (t: DoctorTable): Row[] => {
      const map = new Map<string, Row>();
      for (const [k, r] of committed.get(t)!) if (r.tenant_id === tenantId) map.set(k, r);
      for (const [k, r] of local.get(t)!) map.set(k, r);
      return [...map.values()];
    };
    const take = async (t: DoctorTable) => { const k = `${t}:${tenantId}`; await lockOf(k).acquire(mt.id); held.add(k); };
    const releaseAll = () => { for (const k of held) lockOf(k).release(mt.id); held.clear(); };
    const out = (rows: Row[], returning: string | undefined) => (returning ? { rows: rows.map((r) => ({ ...r })) } : { rows: [] as Row[] });
    const bindFix = (values: readonly unknown[]) => values.map(toDate);

    function checks(t: DoctorTable, r: Row): void {
      const bad = (c: string): never => { throw pgError('23514', `new row for relation "${t}" violates check constraint "${c}"`, c); };
      for (const c of NOT_NULL[t]) if (r[c] == null) throw pgError('23502', `null value in column "${c}" violates not-null constraint`);
      if (t === 'doctors') {
        if (!Number.isInteger(r.version)) throw pgError('22P02', 'invalid input syntax for type integer');
        if (typeof r.is_active !== 'boolean' || typeof r.is_verified !== 'boolean') throw pgError('42804', 'column is of type boolean');
        if (!(typeof r.doctor_code === 'string' && /^[A-Z0-9_-]{1,20}$/.test(r.doctor_code))) bad('doctors__code__ck');
        if (!len(r.display_name, 1, 120)) bad('doctors__name__ck');
        if (!optLen(r.qualification, 120)) bad('doctors__qual__ck');
        if (!optLen(r.registration_council, 20)) bad('doctors__council__ck');
        if (!optLen(r.registration_no, 30)) bad('doctors__regno__ck');
        if (r.phone_e164 != null && !(typeof r.phone_e164 === 'string' && /^\+[1-9][0-9]{7,14}$/.test(r.phone_e164))) bad('doctors__phone__ck');
        if (!optLen(r.email, 254)) bad('doctors__email__ck');
        if (!optLen(r.notes, 500)) bad('doctors__notes__ck');
        if (!['back_office', 'quick_add', 'import'].includes(r.source)) bad('doctors__source__ck');
        if (r.merged_into_id != null && r.merged_into_id === r.id) bad('doctors__not_self__ck');
        if (r.merged_into_id != null && r.is_active !== false) bad('doctors__merged_inactive__ck');
      } else {
        if (!['doctor_code', 'party_code'].includes(r.counter_key)) bad('code_counters__key__ck');
        if (!(Number.isInteger(r.next_value) || typeof r.next_value === 'bigint') || Number(r.next_value) < 1) bad('code_counters__next__ck');
      }
    }
    function clash(t: DoctorTable, r: Row, self?: Row): { constraint: string; row: Row } | undefined {
      const others = visible(t).filter((x) => !self || keyOf(t, x) !== keyOf(t, self));
      if (t === 'code_counters') { const x = others.find((o) => o.counter_key === r.counter_key); return x ? { constraint: 'code_counters__pk', row: x } : undefined; }
      const pk = others.find((o) => o.id === r.id); if (pk) return { constraint: 'doctors__pk', row: pk };
      const u = others.find((o) => o.doctor_code === r.doctor_code); return u ? { constraint: 'doctors__tenant_id_doctor_code__uq', row: u } : undefined;
    }
    function fk(t: DoctorTable, r: Row): void {
      if (t === 'doctors' && r.merged_into_id != null && !visible('doctors').some((d) => d.id === r.merged_into_id)) {
        throw pgError('23503', 'insert or update on table "doctors" violates foreign key constraint "doctors__merged__fk"', 'doctors__merged__fk');
      }
    }
    const dup = (c: string) => pgError('23505', `duplicate key value violates unique constraint "${c}"`, c);

    async function insert(text: string, values: readonly unknown[]) {
      const x = /^INSERT INTO catalog\.(\w+) \(([^)]+)\) VALUES \((.+?)\)(?: ON CONFLICT(?: \([^)]*\))? (DO NOTHING|DO UPDATE SET (.+?)))?(?: RETURNING (.+))?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported INSERT: ${text.slice(0, 160)}`);
      const t = x[1]!.toLowerCase() as DoctorTable;
      const cols = x[2]!.split(',').map((c) => c.trim());
      const exprs = splitTop(x[3]!);
      if (cols.length !== exprs.length) throw new Error('fake: INSERT column/value count mismatch');
      const raw: Row = {};
      cols.forEach((c, i) => { if (!COLS[t].includes(c)) throw pgError('42703', `column "${c}" does not exist`); raw[c] = parseExpr(exprs[i]!)({ row: undefined, values, now }); });
      if (raw.tenant_id !== tenantId) throw pgError('42501', `new row violates row-level security policy for table "${t}"`);
      await take(t);
      const r = fill(t, raw, now, 'db');
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
        checks(t, n);
        local.get(t)!.set(keyOf(t, n), n);
        return out([n], x[6]);
      }
      fk(t, r);
      local.get(t)!.set(keyOf(t, r), r);
      return out([r], x[6]);
    }

    function where(text: string | undefined, t: DoctorTable, values: readonly unknown[]) {
      if (!text) return { pred: (_r: Row) => true };
      const rw = rewriteLike(text, visible(t), bindFix(values));
      const ev = parseExpr(rw.sql);
      return { pred: (r: Row) => ev({ row: r, values: rw.values, now }) === true };
    }

    async function select(text: string, values: readonly unknown[]) {
      const x = /^SELECT (.+?) FROM catalog\.(\w+)(?: (?:AS )?(?!WHERE\b|ORDER\b|LIMIT\b|OFFSET\b|FOR\b)(\w+))?(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\S+))?(?: OFFSET (\S+))?(?: FOR (UPDATE|SHARE)(?: NOWAIT)?)?$/i.exec(text);
      if (!x) throw new Error(`fake: unsupported SELECT: ${text.slice(0, 160)}`);
      const t = x[2]!.toLowerCase() as DoctorTable;
      if (x[8]?.toUpperCase() === 'UPDATE') await take(t);
      let rows = visible(t).filter(where(x[4], t, values).pred);
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
      const t = x[1]!.toLowerCase() as DoctorTable;
      await take(t);                                          // lock first, evaluate WHERE on the fresh committed state
      const sets = splitTop(x[3]!).map((s) => {
        const eq = s.indexOf('='); const col = s.slice(0, eq).trim();
        if (!COLS[t].includes(col)) throw pgError('42703', `column "${col}" does not exist`);
        return { col, ev: parseExpr(s.slice(eq + 1)) };
      });
      const hit = visible(t).filter(where(x[4], t, values).pred);
      const changed: Row[] = [];
      for (const r of hit) {
        const n: Row = { ...r };
        for (const s of sets) n[s.col] = s.ev({ row: r, values, now });
        for (const c of DATE_COLS) if (c in n) n[c] = toDate(n[c]);
        if (n.tenant_id !== tenantId) throw pgError('42501', 'new row violates row-level security policy');
        checks(t, n);
        const c = clash(t, n, r); if (c) throw dup(c.constraint);
        fk(t, n);
        local.get(t)!.set(keyOf(t, n), n);
        changed.push(n);
      }
      return out(changed, x[5]);
    }

    const facade: any = {
      ...mt.facade,
      startedAt: at,
      async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
        // T-17: mergeDoctor also re-points / drops the merged doctor's price-list assignment. This fake models no price-list tables, so every statement on
        // catalog.price_list_assignments sees an EMPTY table (the T-15 cases have no assignments); the T-17 cases use helpers/pricingDb.ts instead.
        if (/\bcatalog\.price_list_assignments\b/i.test(text)) { await tick(); m.base.stmts.push({ txId: mt.id, tenantId, text, values }); return { rows: [] }; }
        if (!DOCTOR_RE.test(text)) return mt.facade.query(text, values);
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
      commit() { for (const t of DOCTOR_TABLES) for (const [k, r] of local.get(t)!) committed.get(t)!.set(k, r); mt.commit(); releaseAll(); },
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
    rows: (t: DoctorTable, tenantId?: string): Row[] => [...committed.get(t)!.values()].filter((r) => tenantId === undefined || r.tenant_id === tenantId).map((r) => ({ ...r })),
    row: (id: string): Row | undefined => { const r = committed.get('doctors')!.get(id); return r ? { ...r } : undefined; },
    /** The committed `next_value` of a tenant's counter (undefined = no row yet). */
    counter: (tenantId: string = TENANT_A, key = 'doctor_code'): number | undefined => {
      const r = committed.get('code_counters')!.get(`${tenantId}:${key}`); return r ? Number(r.next_value) : undefined;
    },
    newId: () => ID(0xd800 + ++seq),
    fail(match: RegExp, make: () => Error = () => new Error('injected')) { failures.push({ match, make }); m.fail(match, make); },
  };
}
export type DoctorsDb = ReturnType<typeof makeDoctorsDb>;

// ------------------------------------------------------------------------------------------------ seed factories (synthetic)
/** A doctor row (active, unverified, back_office). `display_name`/`name_normalised` default together; override both to model a stale normalisation. */
export const doc = (n: number, tenant: string, o: Row = {}): Row => {
  const display_name = (o.display_name as string | undefined) ?? `Dr Seed ${n}`;
  return { id: ID(0xd00 + n), tenant_id: tenant, doctor_code: `SEED${n}`, display_name, name_normalised: normName(display_name), source: 'back_office', ...o };
};
/** A code_counters row. */
export const ctr = (tenant: string, nextValue: number, key = 'doctor_code'): Row => ({ tenant_id: tenant, counter_key: key, next_value: nextValue });

// ------------------------------------------------------------------------------------------------ fake IdentityPort (getActor + assertRole)
export const READ = 'catalog.referrer.read';
export const MANAGE = 'catalog.referrer.manage';
export interface ActorCall { readonly method: 'getActor' | 'assertRole'; readonly permission?: string }
/** IdentityPort subset (03-IC §4): getActor returns an ActorProfile whose `permissions` decide the mapper allow-list (REQ-SEC-081); assertRole throws auth.forbidden. */
export function actorIdentity(permissions: readonly string[]) {
  const calls: ActorCall[] = [];
  return {
    calls,
    async getActor(_ctx: unknown) {
      calls.push({ method: 'getActor' });
      return {
        actor: { type: 'user', id: USER }, displayName: 'Synthetic User', roles: [], permissions: [...permissions],
        centreScope: { all: true, centreIds: [] }, branchIds: [], mfa: { enrolled: true, level: 'aal2' }, isLocked: false,
      };
    },
    async assertRole(_ctx: unknown, req: { permission: string }) {
      calls.push({ method: 'assertRole', permission: req?.permission });
      if (!permissions.includes(req?.permission)) throw new LimsError('auth.forbidden');
    },
  };
}
export type ActorIdentity = ReturnType<typeof actorIdentity>;
export { TENANT_A, ID };
