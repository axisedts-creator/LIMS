// C10 T-08 test helper — an in-memory fake tx for the micro tables that M3–M6 (setupCulture, addCulturePlate, discardCulturePlate, recordCultureObservation) touch.
// NOT a SQL engine: a small dialect; anything outside it THROWS "fake dialect: ..." so a test cannot pass by accident (same idea as bpDb.ts, T-13).
//   SELECT <list> FROM [micro.]<table> [alias] [WHERE a = $n AND b = ANY($m) AND c = 'x' ...] [ORDER BY col [DESC]] [FOR UPDATE]   (first table only: no JOIN; max(col) / count(*) allowed)
//   INSERT INTO [micro.]<table> (cols) VALUES (expr, ...)[, (expr, ...)] [ON CONFLICT ... DO NOTHING] [RETURNING ...]               (no INSERT ... SELECT)
//   UPDATE [micro.]<table> [alias] SET col = <expr>, ... WHERE a = $n AND ... [RETURNING ...]
//   <expr>: $n[::type], now(), NULL, true/false, 'text', number, `col + 1`; other expressions leave the column untouched.
//   WHERE equalities are the only filter (`<col> = $n`, `<col> = 'x'`, `<col> = ANY($n)`; an optional alias. prefix); other predicates (IS NULL, <>, >=) are ignored.
// Emulated database rules (05-SCHEMA §8): cultures_guard (status transitions, P0001 culture_invalid_transition); tg_child_final_lock (P0001 immutable_row on culture_plates INSERT/UPDATE
//   and culture_observations INSERT when the parent culture is final_submitted); composite FKs of culture_plates / culture_observations (23503); culture_plates__culture_no__uq (23505);
//   culture_observations__read__ck / __finding__ck (23514); culture_plates__no__ck (23514).
// The service owns validation, id-belongs-to-culture checks and the cancelled-culture refusal; this fake never does them for it.
// Synthetic data only.
import type { Row } from './cultureReads.js';

export type { Row };
export type World = Record<string, Row[]>;
export const NOW = new Date('2026-11-05T05:00:00.000Z');   // = ctx.now() of helpers/cultureReads.ts mkCtx
export const HOUR = 3_600_000;

export interface Logged { sql: string; params: unknown[]; op: 'SELECT' | 'INSERT' | 'UPDATE' | 'OTHER'; table: string }

const pgErr = (code: string, message: string, extra: Row = {}) => Object.assign(new Error(message), { code, ...extra });
const UNKNOWN = Symbol('unknown');

function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0; let q = false; let cur = '';
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && depth === 0 && ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/** Balanced `( ... )` groups starting at `from`, separated by commas; returns the groups' inner text and the index after the last group. */
function groups(s: string, from: number): { inner: string[]; end: number } {
  const inner: string[] = []; let i = from;
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] !== '(') break;
    let depth = 0; let q = false; const start = i + 1;
    for (; i < s.length; i++) {
      const ch = s[i]!;
      if (ch === "'") q = !q;
      if (q) continue;
      if (ch === '(') depth++;
      if (ch === ')') { depth--; if (depth === 0) break; }
    }
    inner.push(s.slice(start, i)); i++;
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] === ',') { i++; continue; }
    break;
  }
  return { inner, end: i };
}

function expr(e: string, params: unknown[], row?: Row): unknown {
  const t = e.trim();
  let m: RegExpExecArray | null;
  if ((m = /^\$(\d+)(?:::[a-z_]+(?:\[\])?)?$/i.exec(t))) return params[Number(m[1]) - 1];
  if (/^now\(\)$/i.test(t)) return NOW;
  if (/^null$/i.test(t)) return null;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if ((m = /^'([^']*)'(?:::[a-z_]+)?$/i.exec(t))) return m[1];
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (row && (m = /^(?:\w+\.)?(\w+)\s*\+\s*1$/.exec(t))) return Number(row[m[1]!]) + 1;
  return UNKNOWN;
}

function equalities(where: string): { col: string; rhs: string; any: boolean }[] {
  const out: { col: string; rhs: string; any: boolean }[] = [];
  for (const m of where.matchAll(/(?:\b\w+\.)?\b([a-z_]+)\s*=\s*(ANY\s*\(\s*)?(\$\d+(?:::[a-z_]+(?:\[\])?)?|'[^']*')/gi)) out.push({ col: m[1]!, rhs: m[3]!, any: Boolean(m[2]) });
  return out;
}
const same = (a: unknown, b: unknown): boolean => (a instanceof Date || b instanceof Date ? new Date(a as any).getTime() === new Date(b as any).getTime() : String(a) === String(b));
function matches(row: Row, where: string, params: unknown[]): boolean {
  return equalities(where).every(({ col, rhs, any }) => {
    if (!(col in row)) return true;                                    // a column the fake row does not carry cannot filter
    const v = expr(rhs, params);
    return any ? Array.isArray(v) && v.some((x) => same(x, row[col])) : same(v, row[col]);
  });
}

const TABLE_DEFAULTS: Record<string, () => Row> = {
  culture_plates: () => ({ status: 'active', version: 1, is_active: true, incubation_text: null, parent_plate_id: null, source_isolate_id: null, discarded_at: null, planted_by_membership_id: null }),
  culture_observations: () => ({ plate_id: null, growth_code: null, quantity_text: null, finding_text: null, hours_since_planting: null, recorded_by_membership_id: null, corrects_observation_id: null }),
  culture_transitions: () => ({ reason_code: null, comment: null }),
};
const ALLOWED: Record<string, readonly string[]> = {
  awaiting_setup: ['incubating', 'cancelled'], incubating: ['growth_detected', 'final_submitted', 'cancelled'], growth_detected: ['final_submitted', 'cancelled'],
  final_submitted: ['amending'], amending: ['final_submitted'], cancelled: [],
};

export function fakeTx(w: World) {
  const log: Logged[] = [];
  const tbl = (t: string): Row[] => (w[t] ??= []);
  const culture = (tenant: unknown, id: unknown) => tbl('cultures').find((c) => same(c['tenant_id'], tenant) && same(c['id'], id));
  const exists = (t: string, tenant: unknown, id: unknown) => tbl(t).some((r) => same(r['tenant_id'], tenant) && same(r['id'], id));

  function insert(sql: string, params: unknown[]): Row[] {
    const m = /^\s*INSERT\s+INTO\s+(?:micro\.)?(\w+)\s*\(([^)]*)\)\s*VALUES\s*/i.exec(sql);
    if (!m) throw new Error(`fake dialect: INSERT shape not supported: ${sql.slice(0, 80)}`);
    const table = m[1]!; const cols = m[2]!.split(',').map((c) => c.trim());
    const g = groups(sql, m[0].length); const rest = sql.slice(g.end);
    const doNothing = /ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i.test(rest);
    const out: Row[] = [];
    for (const inner of g.inner) {
      const vals = splitTop(inner);
      if (vals.length !== cols.length) throw new Error('fake dialect: column/value count differs');
      const row: Row = { ...(TABLE_DEFAULTS[table]?.() ?? {}) };
      cols.forEach((c, i) => { const v = expr(vals[i]!, params); if (v !== UNKNOWN) row[c] = v; });
      const parent = (cid: unknown) => culture(row['tenant_id'], cid);
      if (table === 'culture_plates' || table === 'culture_observations') {
        if (parent(row['culture_id'])?.['status'] === 'final_submitted') throw pgErr('P0001', 'immutable_row');            // tg_child_final_lock
        if (row['parent_plate_id'] != null && !exists('culture_plates', row['tenant_id'], row['parent_plate_id'])) throw pgErr('23503', 'culture_plates__parent__fk');
        if (row['source_isolate_id'] != null && !exists('isolates', row['tenant_id'], row['source_isolate_id'])) throw pgErr('23503', 'culture_plates__source_isolate__fk');
      }
      if (table === 'culture_plates') {
        if (!(row['plate_no'] >= 1 && row['plate_no'] <= 50)) throw pgErr('23514', 'culture_plates__no__ck');
        const dup = tbl(table).some((r) => same(r['tenant_id'], row['tenant_id']) && same(r['culture_id'], row['culture_id']) && r['plate_no'] === row['plate_no']);
        if (dup) { if (doNothing) continue; throw pgErr('23505', 'culture_plates__culture_no__uq'); }
      }
      if (table === 'culture_observations') {
        if (row['plate_id'] != null && !exists('culture_plates', row['tenant_id'], row['plate_id'])) throw pgErr('23503', 'culture_observations__plate__fk');
        if (row['corrects_observation_id'] != null && !exists('culture_observations', row['tenant_id'], row['corrects_observation_id'])) throw pgErr('23503', 'culture_observations__corrects__fk');
        if (row['kind'] === 'plate_read' && (row['growth_code'] == null || row['plate_id'] == null)) throw pgErr('23514', 'culture_observations__read__ck');
        if (row['kind'] !== 'plate_read' && row['finding_text'] == null) throw pgErr('23514', 'culture_observations__finding__ck');
        if (row['finding_text'] != null && !(String(row['finding_text']).length >= 1 && String(row['finding_text']).length <= 2000)) throw pgErr('23514', 'culture_observations__texts__ck');
      }
      tbl(table).push(row); out.push({ ...row });
    }
    return /RETURNING/i.test(rest) ? out : [];
  }

  function update(sql: string, params: unknown[]): Row[] {
    const m = /^\s*UPDATE\s+(?:micro\.)?(\w+)(?:\s+(?!SET\b)\w+)?\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*?)(?:\s+RETURNING\s+[\s\S]*)?$/i.exec(sql);
    if (!m) throw new Error(`fake dialect: UPDATE shape not supported: ${sql.slice(0, 80)}`);
    const table = m[1]!; const sets = splitTop(m[2]!); const where = m[3]!;
    const out: Row[] = [];
    for (const row of tbl(table).filter((r) => matches(r, where, params))) {
      const next: Row = { ...row };
      for (const a of sets) {
        const eq = a.indexOf('='); const col = a.slice(0, eq).trim(); const v = expr(a.slice(eq + 1), params, row);
        if (v !== UNKNOWN) next[col] = v;
      }
      if (table === 'culture_plates' && culture(row['tenant_id'], row['culture_id'])?.['status'] === 'final_submitted') throw pgErr('P0001', 'immutable_row');
      if (table === 'cultures' && next['status'] !== row['status'] && !(ALLOWED[String(row['status'])] ?? []).includes(String(next['status']))) throw pgErr('P0001', 'culture_invalid_transition');
      Object.assign(row, next); out.push({ ...row });
    }
    return /RETURNING/i.test(sql) ? out : [];
  }

  function select(sql: string, params: unknown[]): Row[] {
    const f = /\bFROM\s+(?:micro\.)?(\w+)/i.exec(sql);
    if (!f) return [];
    const where = /\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bLIMIT\b|\bFOR\s+UPDATE\b|$)/i.exec(sql)?.[1] ?? '';
    let rows = tbl(f[1]!).filter((r) => matches(r, where, params)).map((r) => ({ ...r }));
    const ord = /\bORDER\s+BY\s+(?:\w+\.)?(\w+)(\s+DESC)?/i.exec(sql);
    if (ord && rows.length && ord[1]! in rows[0]!) rows = rows.sort((a, b) => (a[ord[1]!] > b[ord[1]!] ? 1 : a[ord[1]!] < b[ord[1]!] ? -1 : 0) * (ord[2] ? -1 : 1));
    const agg = /\b(max|count)\(\s*(\*|\w+(?:\.\w+)?)\s*\)(?:\s+AS\s+(\w+))?/i.exec(sql);
    if (agg) {
      const col = agg[2]!.replace(/^\w+\./, '');
      const v = agg[1]!.toLowerCase() === 'count' ? rows.length : rows.reduce<number | null>((a, r) => (a === null || Number(r[col]) > a ? Number(r[col]) : a), null);
      const alias = /\bAS\s+(\w+)/i.exec(sql.slice(0, f.index))?.[1] ?? agg[1]!.toLowerCase();
      return [{ [alias]: v, max: v, count: v, coalesce: v ?? 0 }];
    }
    return rows;
  }

  const tx = {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
      const head = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? '';
      const table = /\b(?:FROM|INTO|UPDATE)\s+(?:micro\.)?(\w+)/i.exec(sql)?.[1] ?? '';
      const op = head === 'SELECT' || head === 'INSERT' || head === 'UPDATE' ? head : 'OTHER';
      log.push({ sql, params, op, table });
      if (/^\s*WITH\b/i.test(sql)) throw new Error('fake dialect: WITH not supported');
      if (op === 'OTHER') return { rows: [], rowCount: 0 };
      const rows = op === 'INSERT' ? insert(sql, params) : op === 'UPDATE' ? update(sql, params) : select(sql, params);
      return { rows, rowCount: rows.length };
    },
  };
  return { tx, log, world: w };
}

export const writesOf = (log: Logged[]) => log.filter((l) => l.op === 'INSERT' || l.op === 'UPDATE');
export const iso = (d: unknown): string => new Date(d as any).toISOString();
export const hoursAfter = (d: Date | string, h: number): string => new Date(new Date(d).getTime() + h * HOUR).toISOString();
