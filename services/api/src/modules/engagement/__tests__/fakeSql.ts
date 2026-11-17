// Test-only helper (C16 T-Q2): a tiny in-memory SQL interpreter, just enough for the queue token statements of 02-TRD §4.10 / 05-SCHEMA §2 queue.
// Supports (everything else throws `fake-sql: unsupported ...` so a mismatch is loud, never a silent pass):
//   SELECT * | cols FROM [schema.]table [alias] [WHERE ..] [ORDER BY col [ASC|DESC], ..] [LIMIT n|$n] [FOR UPDATE [SKIP LOCKED]]   (also SELECT count(*))
//   INSERT INTO [schema.]table (cols) VALUES (exprs) [ON CONFLICT .. DO NOTHING] [RETURNING ..]
//   UPDATE [schema.]table [alias] SET col = expr, .. [WHERE ..] [RETURNING ..]          DELETE is refused (lims_app has no DELETE on queue tables).
//   expr: $n[::type] | 'literal' | NULL | number | true/false | now() | col | col + 1 | COALESCE(a, b)
//   WHERE terms joined by AND: col (=|<>|!=|<|<=|>|>=) expr | col IN (e, ..) | col = ANY($n) | col IS [NOT] NULL
// Models: tenant + centre RLS (STAFF_C), NOT NULL / UNIQUE / FK / CHECK, the enforce_mutable_columns trigger, row locks held until the session is released
// (SELECT .. FOR UPDATE waits for a lock held by another session; with SKIP LOCKED it skips the row) and an event-loop yield before every statement so
// concurrent requests really interleave.
export type Row = Record<string, any>;
export interface Call { text: string; values: unknown[] }
export interface Scope { all: boolean; centres: readonly string[] }
export interface TableDef {
  columns: readonly string[];
  notNull?: readonly string[];
  defaults?: Record<string, unknown>;
  unique?: readonly (readonly string[])[];
  fk?: readonly { cols: readonly string[]; ref: string; refCols: readonly string[] }[];
  mutable?: readonly string[];
  check?: (row: Row) => string | undefined;
}
const dbErr = (message: string, code: string, constraint?: string) => Object.assign(new Error(message), { code, ...(constraint ? { constraint } : {}) });
const tick = () => new Promise<void>((r) => setImmediate(r));

function splitTop(s: string, sep = ','): string[] {
  const out: string[] = []; let depth = 0, q = false, cur = '';
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && depth === 0 && ch === sep) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}
function takeParen(s: string, from: number): { inner: string; end: number } {
  const open = s.indexOf('(', from); let depth = 0, q = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") q = !q;
    if (q) continue;
    if (ch === '(') depth++;
    if (ch === ')' && --depth === 0) return { inner: s.slice(open + 1, i), end: i + 1 };
  }
  throw new Error('fake-sql: unbalanced parentheses');
}
const bare = (c: string) => c.trim().replace(/^\w+\./, '').replace(/"/g, '');
const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
const cmp = (a: unknown, b: unknown) => { const x: any = norm(a), y: any = norm(b); return x < y ? -1 : x > y ? 1 : 0; };

export class FakeDb {
  calls: Call[] = [];
  locks = new Map<Row, number>();
  private n = 0;
  constructor(public tables: Record<string, Row[]>, public defs: Record<string, TableDef>, public clock: { iso: string }) {}
  session(tenant: string, scope: Scope, actorId = 'actor') {
    const id = ++this.n;
    return { id, tx: { query: (text: string, values: unknown[] = []) => this.exec(id, tenant, scope, text, values) }, release: () => { for (const [r, s] of this.locks) if (s === id) this.locks.delete(r); }, actorId };
  }
  private visible(row: Row, tenant: string, scope: Scope) { return row.tenant_id === tenant && (row.centre_id === undefined || row.centre_id === null || scope.all || scope.centres.includes(row.centre_id)); }

  private ev(expr: string, values: unknown[], row?: Row, excluded?: Row): unknown {
    const e = expr.trim().replace(/::\w+(\[\])?/g, '');
    let m: RegExpExecArray | null;
    if (excluded && (m = /^excluded\.(\w+)$/i.exec(e))) return excluded[m[1]!];
    if ((m = /^\$(\d+)$/.exec(e))) { if (+m[1] > values.length) throw new Error(`fake-sql: placeholder $${m[1]} has no bound value`); return values[+m[1] - 1]; }
    if ((m = /^'(.*)'$/s.exec(e))) return m[1];
    if (/^null$/i.test(e)) return null;
    if (/^true$/i.test(e)) return true;
    if (/^false$/i.test(e)) return false;
    if (/^-?\d+$/.test(e)) return Number(e);
    if (/^(now|clock_timestamp|statement_timestamp)\(\)$/i.test(e)) return this.clock.iso;
    if ((m = /^coalesce\((.*)\)$/is.exec(e))) { for (const part of splitTop(m[1])) { const v = this.ev(part, values, row, excluded); if (v !== null && v !== undefined) return v; } return null; }
    if (row && (m = /^(\w+)\s*\+\s*1$/.exec(bare(e)))) return (row[m[1]] ?? 0) + 1;
    if (row && /^\w+$/.test(bare(e)) && bare(e) in row) return row[bare(e)];
    throw new Error(`fake-sql: unsupported expression: ${expr}`);
  }
  private where(clause: string | undefined, values: unknown[]): (row: Row) => boolean {
    if (!clause) return () => true;
    const terms = clause.split(/\s+and\s+/i).map((t) => t.trim().replace(/^\((.*)\)$/s, '$1'));
    const tests = terms.map((t): ((row: Row) => boolean) => {
      let m: RegExpExecArray | null;
      if ((m = /^([\w.]+)\s+in\s*\((.*)\)$/is.exec(t))) { const c = bare(m[1]); const list = splitTop(m[2]).map((x) => this.ev(x, values)); return (r) => list.some((v) => cmp(r[c], v) === 0); }
      if ((m = /^([\w.]+)\s*=\s*any\s*\((.*)\)$/is.exec(t))) { const c = bare(m[1]); const arr = this.ev(m[2], values) as unknown[]; return (r) => arr.some((v) => cmp(r[c], v) === 0); }
      if ((m = /^([\w.]+)\s+is\s+(not\s+)?null$/i.exec(t))) { const c = bare(m[1]); return (r) => ((r[c] === null || r[c] === undefined) === !m![2]); }
      if ((m = /^([\w.]+)\s*(<=|>=|<>|!=|=|<|>)\s*(.+)$/s.exec(t))) {
        const c = bare(m[1]), op = m[2], rhs = m[3];
        return (r) => { const k = cmp(r[c], this.ev(rhs, values, r)); return op === '=' ? k === 0 : op === '<>' || op === '!=' ? k !== 0 : op === '<' ? k < 0 : op === '<=' ? k <= 0 : op === '>' ? k > 0 : k >= 0; };
      }
      throw new Error(`fake-sql: unsupported WHERE term: ${t}`);
    });
    return (r) => tests.every((f) => f(r));
  }
  private finish(table: string, row: Row) {
    const d = this.defs[table]!;
    for (const c of d.notNull ?? []) if (row[c] === null || row[c] === undefined) throw dbErr(`null value in column ${c}`, '23502');
    const bad = d.check?.(row); if (bad) throw dbErr(`violates check ${bad}`, '23514', bad);
  }
  private fkCheck(table: string, row: Row) {
    for (const f of this.defs[table]!.fk ?? []) {
      if (f.cols.some((c) => row[c] === null || row[c] === undefined) || !this.tables[f.ref]) continue;
      if (!this.tables[f.ref]!.some((r) => f.cols.every((c, i) => r[f.refCols[i]!] === row[c]))) throw dbErr(`foreign key ${f.cols.join(',')} -> ${f.ref}`, '23503');
    }
  }
  private async exec(session: number, tenant: string, scope: Scope, text: string, values: unknown[]) {
    this.calls.push({ text, values });
    await tick();
    const verb = /^\s*(select|insert|update|delete)\b/i.exec(text)?.[1]?.toLowerCase();
    const table = /\b(?:engagement|core)\.(\w+)/i.exec(text)?.[1];
    if (!verb || !table || !this.tables[table] || !this.defs[table]) return { rows: [], rowCount: 0 }; // session settings, audit, etc.
    const rows = this.tables[table]!, d = this.defs[table]!;
    const copy = (r: Row) => ({ ...r });
    if (verb === 'delete') throw new Error(`fake: DELETE is not allowed on ${table} (05-SCHEMA table matrix: lims_app has no DELETE)`);

    if (verb === 'select') {
      const m = /^\s*select\s+(.+?)\s+from\s+(?:\w+\.)?(\w+)(?:\s+(?:as\s+)?(?!where\b|order\b|limit\b|for\b)(\w+))?\s*(?:where\s+(.+?))?\s*(?:order\s+by\s+(.+?))?\s*(?:limit\s+(\S+?))?\s*(for\s+update(\s+skip\s+locked)?)?\s*;?\s*$/is.exec(text);
      if (!m) throw new Error(`fake-sql: unsupported SELECT: ${text}`);
      const pred = this.where(m[4], values);
      let found = rows.filter((r) => this.visible(r, tenant, scope) && pred(r));
      if (m[5]) {
        const keys = splitTop(m[5]).map((k) => { const p = k.trim().split(/\s+/); return { c: bare(p[0]!), desc: /^desc$/i.test(p[1] ?? '') }; });
        found = [...found].sort((a, b) => { for (const k of keys) { const x = cmp(a[k.c], b[k.c]); if (x) return k.desc ? -x : x; } return 0; });
      }
      if (m[6]) found = found.slice(0, Number(this.ev(m[6], values)));
      if (/^count\(\*\)/i.test(m[1]!.trim())) return { rows: [{ count: found.length }], rowCount: 1 };
      if (m[7]) { // FOR UPDATE [SKIP LOCKED] (LIMIT is applied after skipping locked rows, as Postgres does)
        const skip = Boolean(m[8]); const limit = m[6] ? Number(this.ev(m[6], values)) : Infinity;
        let all = rows.filter((r) => this.visible(r, tenant, scope) && pred(r));
        if (m[5]) { const keys = splitTop(m[5]).map((k) => { const p = k.trim().split(/\s+/); return { c: bare(p[0]!), desc: /^desc$/i.test(p[1] ?? '') }; }); all = [...all].sort((a, b) => { for (const k of keys) { const x = cmp(a[k.c], b[k.c]); if (x) return k.desc ? -x : x; } return 0; }); }
        const got: Row[] = [];
        for (const r of all) {
          if (got.length >= limit) break;
          for (let spins = 0; this.locks.has(r) && this.locks.get(r) !== session && !skip; spins++) { if (spins > 200) throw new Error('fake: lock wait timeout'); await tick(); }
          if (this.locks.has(r) && this.locks.get(r) !== session) continue; // SKIP LOCKED
          if (!pred(r)) continue; // re-check after a wait (status may have changed)
          this.locks.set(r, session); got.push(r);
        }
        return { rows: got.map(copy), rowCount: got.length };
      }
      return { rows: found.map(copy), rowCount: found.length };
    }

    if (verb === 'insert') {
      const head = /^\s*insert\s+into\s+(?:\w+\.)?\w+\s*/i.exec(text)![0];
      const cols = takeParen(text, head.length - 1 >= 0 ? head.length : 0); const vIdx = text.search(/\bvalues\b/i);
      const vals = takeParen(text, vIdx); const tail = text.slice(vals.end);
      const names = splitTop(cols.inner).map(bare);
      const exprs = splitTop(vals.inner);
      if (names.length !== exprs.length) throw new Error('fake-sql: column/value count mismatch');
      for (const c of names) if (!d.columns.includes(c)) throw dbErr(`column "${c}" of relation "${table}" does not exist`, '42703');
      const row: Row = {}; for (const c of d.columns) row[c] = d.defaults?.[c] ?? null;
      names.forEach((c, i) => { row[c] = this.ev(exprs[i]!, values); });
      if (!this.visible(row, tenant, scope)) throw dbErr('new row violates row-level security policy', '42501');
      this.fkCheck(table, row); this.finish(table, row);
      const dup = (d.unique ?? []).find((u) => rows.some((r) => u.every((c) => cmp(r[c], row[c]) === 0)));
      if (dup) {
        if (/on\s+conflict[\s\S]*do\s+nothing/i.test(tail)) return { rows: [], rowCount: 0 };
        // T-B2: ON CONFLICT (..) DO UPDATE SET col = expr, .. [WHERE ..] [RETURNING ..]; `excluded.col` = the proposed row; the DO UPDATE WHERE is not evaluated (always applies).
        const up = /on\s+conflict[\s\S]*?do\s+update\s+set\s+([\s\S]+?)(?:\s+where\s+[\s\S]+?)?(?:\s+returning\s+([\s\S]+?))?\s*;?\s*$/i.exec(tail);
        if (up) {
          const cur = rows.find((r) => dup.every((c) => cmp(r[c], row[c]) === 0))!;
          const next = { ...cur };
          for (const a of splitTop(up[1]!)) { const i = a.indexOf('='); next[bare(a.slice(0, i))] = this.ev(a.slice(i + 1), values, cur, row); }
          this.fkCheck(table, next); this.finish(table, next);
          Object.assign(cur, next);
          return up[2] ? { rows: [copy(cur)], rowCount: 1 } : { rows: [], rowCount: 1 };
        }
        throw dbErr(`duplicate key ${dup.join(',')}`, '23505', `${table}__${dup.join('_')}__uq`);
      }
      rows.push(row);
      return /\breturning\b/i.test(tail) ? { rows: [copy(row)], rowCount: 1 } : { rows: [], rowCount: 1 };
    }

    const m = /^\s*update\s+(?:\w+\.)?(\w+)(?:\s+(?:as\s+)?(?!set\b)(\w+))?\s+set\s+(.+?)(?:\s+where\s+(.+?))?(?:\s+returning\s+(.+?))?\s*;?\s*$/is.exec(text);
    if (!m) throw new Error(`fake-sql: unsupported UPDATE: ${text}`);
    const pred = this.where(m[4], values);
    const sets = splitTop(m[3]!).map((a) => { const i = a.indexOf('='); if (i < 0) throw new Error(`fake-sql: bad SET item ${a}`); return { c: bare(a.slice(0, i)), e: a.slice(i + 1) }; });
    const hit = rows.filter((r) => this.visible(r, tenant, scope) && pred(r));
    const out: Row[] = [];
    for (const r of hit) {
      const next = { ...r };
      for (const s of sets) { if (!d.columns.includes(s.c)) throw dbErr(`column "${s.c}" does not exist`, '42703'); next[s.c] = this.ev(s.e, values, r); }
      for (const s of sets) if (cmp(next[s.c], r[s.c]) !== 0 && d.mutable && !d.mutable.includes(s.c)) throw dbErr(`column ${s.c} is immutable (enforce_mutable_columns)`, 'P0001');
      this.fkCheck(table, next); this.finish(table, next);
      Object.assign(r, next); out.push(copy(r));
    }
    return { rows: m[5] ? out : [], rowCount: out.length };
  }
}

// ---------------------------------------------------------------- engagement queue schema (05-SCHEMA §2: queue_definitions, queue_counters, queue_day_counters, queue_tokens, settings)
const TOKEN_COLS = ['id', 'tenant_id', 'centre_id', 'queue_id', 'business_date', 'seq', 'token_label', 'priority', 'status', 'booking_id', 'counter_id', 'issued_at', 'called_at', 'call_count',
  'serving_started_at', 'completed_at', 'transferred_to_token_id', 'transferred_from_token_id', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'] as const;
export const STATUSES = ['waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled', 'transferred', 'expired'] as const;
export const queueSchemaDefs = (clock: { iso: string }): Record<string, TableDef> => ({
  collection_centres: { columns: ['id', 'tenant_id'] },
  settings: { columns: ['id', 'tenant_id', 'queue_enabled', 'version'] },
  queue_definitions: { columns: ['id', 'tenant_id', 'centre_id', 'code', 'display_name', 'token_prefix', 'sort_order', 'is_active', 'board_version', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'] },
  queue_counters: { columns: ['id', 'tenant_id', 'centre_id', 'display_name', 'sort_order', 'is_active', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'] },
  queue_day_counters: {
    columns: ['tenant_id', 'queue_id', 'centre_id', 'business_date', 'last_seq', 'created_at', 'created_by', 'updated_at'],
    notNull: ['tenant_id', 'queue_id', 'centre_id', 'business_date', 'last_seq', 'created_by'],
    defaults: { last_seq: 0, created_at: clock.iso, updated_at: clock.iso },
    unique: [['tenant_id', 'queue_id', 'business_date']],
    fk: [{ cols: ['tenant_id', 'queue_id'], ref: 'queue_definitions', refCols: ['tenant_id', 'id'] }],
    check: (r) => (r['last_seq'] < 0 || r['last_seq'] > 9999 ? 'queue_day_counters__seq__ck' : undefined),
  },
  queue_tokens: {
    columns: TOKEN_COLS,
    notNull: ['id', 'tenant_id', 'centre_id', 'queue_id', 'business_date', 'seq', 'token_label', 'priority', 'status', 'issued_at', 'call_count', 'version', 'created_by', 'updated_by'],
    defaults: { priority: 'normal', status: 'waiting', call_count: 0, version: 1, created_at: clock.iso, updated_at: clock.iso },
    unique: [['tenant_id', 'id'], ['tenant_id', 'queue_id', 'business_date', 'seq']],
    fk: [
      { cols: ['tenant_id', 'queue_id'], ref: 'queue_definitions', refCols: ['tenant_id', 'id'] },
      { cols: ['tenant_id', 'centre_id'], ref: 'collection_centres', refCols: ['tenant_id', 'id'] },
      { cols: ['tenant_id', 'counter_id'], ref: 'queue_counters', refCols: ['tenant_id', 'id'] },
      { cols: ['tenant_id', 'transferred_to_token_id'], ref: 'queue_tokens', refCols: ['tenant_id', 'id'] },
      { cols: ['tenant_id', 'transferred_from_token_id'], ref: 'queue_tokens', refCols: ['tenant_id', 'id'] },
    ],
    mutable: ['status', 'counter_id', 'called_at', 'call_count', 'serving_started_at', 'completed_at', 'transferred_to_token_id', 'updated_at', 'updated_by', 'version'],
    check: (r) => !['normal', 'priority'].includes(r['priority']) ? 'queue_tokens__priority__ck'
      : !(STATUSES as readonly string[]).includes(r['status']) ? 'queue_tokens__status__ck'
      : !/^[A-Z]{1,2}-[0-9]{3,4}$/.test(r['token_label']) ? 'queue_tokens__label__ck'
      : r['call_count'] < 0 || r['call_count'] > 9 ? 'queue_tokens__calls__ck'
      : (r['status'] === 'transferred') !== (r['transferred_to_token_id'] !== null && r['transferred_to_token_id'] !== undefined) ? 'queue_tokens__transfer__ck' : undefined,
  },
});
