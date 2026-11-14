// C10 T-10 test helper — wraps the in-memory fake tx of isolateWrites.ts (-> cultureWrites.ts) with what M11 / M12 / M29–M32 depend on (05-SCHEMA §8):
//   SAVEPOINT <name> / ROLLBACK TO [SAVEPOINT] <name> / RELEASE [SAVEPOINT] <name>: the whole world is snapshotted at SAVEPOINT and restored at ROLLBACK TO (names: [A-Za-z_][A-Za-z0-9_]{0,62} only).
//     PostgreSQL rule emulated: after a statement fails with an SQLSTATE, EVERY further statement throws 25P02 "current transaction is aborted" until ROLLBACK TO a savepoint
//     (a service that catches a per-entry error without a savepoint cannot continue). BEGIN / COMMIT / plain ROLLBACK THROW "fake dialect" (the core owns the transaction).
//   micro.ast_results INSERT/UPDATE: defaults (report_visibility 'shown', off_panel false, is_reportable true, version 1 ...), ast_results__final_lock (P0001 immutable_row when the culture is
//     final_submitted), __culture__fk / __isolate__fk (23503), __isolate_abx_method__uq (23505), __method__ck, __qualifier__ck, __unit__ck, __standard__ck, __standard_src__ck, __interp_src__ck, __source__ck,
//     __visibility__ck, __category_needs_std__ck, __category_needs_value__ck, __texts__ck, __unknown__ck, __suggestion__ck (23514), __category__fk against g_cs_ast_interpretations when that table has rows (23503).
//   micro.ast_panels INSERT/UPDATE: defaults, __scope__ck / __code__ck / __display__ck / __method__ck (23514), __tenant_id_code_version__uq and the PARTIAL ast_panels__tenant_id_code__p_uq (WHERE superseded_at IS NULL)
//     (23505, error.constraint set): a new version must supersede the old row BEFORE inserting the new one. micro.ast_panel_antibiotics: panel FK (23503), method ck, unique (tenant, panel, antibiotic, method)
//     only when method IS NOT NULL (PostgreSQL: NULLs are distinct), so the service must itself refuse a duplicate antibiotic.
//   INSERT ... ON CONFLICT DO NOTHING on these tables skips a row that would violate a UNIQUE rule (no other conflict action is supported).
//   SELECT: besides the equalities of cultureWrites.ts the fake also honours `col IS NULL`, `col IS NOT NULL`, `col = TRUE|FALSE` (not OR, JOIN, sub-selects: single table, AND-ed predicates only).
// Synthetic data only.
import { isolateTx } from './isolateWrites.js';
import type { Row, World } from './cultureWrites.js';

export { NOW, HOUR, iso, writesOf, type Logged, type Row, type World } from './isolateWrites.js';

const pgErr = (code: string, message: string, extra: Row = {}) => Object.assign(new Error(message), { code, ...extra });
const same = (a: unknown, b: unknown) => String(a) === String(b);
const snapshot = (w: World): World => Object.fromEntries(Object.entries(w).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
const restore = (w: World, snap: World): void => {
  for (const k of Object.keys(w)) if (!(k in snap)) delete w[k];
  for (const [k, rows] of Object.entries(snap)) w[k] = rows.map((r) => ({ ...r }));
};

const DEFAULTS: Record<string, () => Row> = {
  ast_results: () => ({ raw_value: null, raw_qualifier: null, raw_numeric: null, unit_code: null, category_code: null, standard: null, standard_version: null, standard_source: null, interpretation_raw: null,
    interpretation_source: null, breakpoint_set_id: null, breakpoint_band_id: null, suggestion_overridden: false, instrument_record_id: null, instrument_id: null, instrument_result_time: null,
    is_reportable: true, report_visibility: 'shown', off_panel: false, panel_sort_order: null, entered_by_membership_id: null, entered_at: null, version: 1, is_active: true }),
  ast_panels: () => ({ version: 1, is_active: true, superseded_at: null, organism_code: null, organism_group_code: null, specimen_site_code: null }),
  ast_panel_antibiotics: () => ({ method: null, is_reported_default: true, version: 1, is_active: true }),
};
const METHODS = ['mic', 'zone_diameter', 'other'];

export function astTx(w: World) {
  const base = isolateTx(w);
  const tbl = (t: string): Row[] => (w[t] ??= []);
  const tenantRow = (t: string, r: Row, id: unknown) => tbl(t).find((x) => same(x['tenant_id'], r['tenant_id']) && same(x['id'], id));

  function checkResult(r: Row): void {
    const c = tenantRow('cultures', r, r['culture_id']);
    if (!c) throw pgErr('23503', 'ast_results__culture__fk', { constraint: 'ast_results__culture__fk' });
    if (c['status'] === 'final_submitted') throw pgErr('P0001', 'immutable_row');                                    // ast_results__final_lock
    if (!tenantRow('isolates', r, r['isolate_id'])) throw pgErr('23503', 'ast_results__isolate__fk', { constraint: 'ast_results__isolate__fk' });
    const bad = (n: string) => pgErr('23514', n, { constraint: n });
    if (!METHODS.includes(r['method'])) throw bad('ast_results__method__ck');
    if (r['raw_qualifier'] != null && !['=', '<', '<=', '>', '>='].includes(r['raw_qualifier'])) throw bad('ast_results__qualifier__ck');
    if (r['unit_code'] != null && !['ug_ml', 'mm'].includes(r['unit_code'])) throw bad('ast_results__unit__ck');
    if (r['standard'] != null && !['CLSI', 'EUCAST', 'ECOFF', 'unknown'].includes(r['standard'])) throw bad('ast_results__standard__ck');
    if (r['standard_source'] != null && !['manual', 'instrument_payload', 'instrument_default', 'breakpoint_set'].includes(r['standard_source'])) throw bad('ast_results__standard_src__ck');
    if (r['interpretation_source'] != null && !['manual', 'instrument', 'breakpoint_suggestion'].includes(r['interpretation_source'])) throw bad('ast_results__interp_src__ck');
    if (!['manual', 'instrument'].includes(r['source'])) throw bad('ast_results__source__ck');
    if (!['shown', 'suppressed_by_rule'].includes(r['report_visibility'])) throw bad('ast_results__visibility__ck');
    if (r['category_code'] != null && (r['standard'] == null || r['standard_version'] == null)) throw bad('ast_results__category_needs_std__ck');
    if (r['category_code'] != null && r['raw_value'] == null) throw bad('ast_results__category_needs_value__ck');
    const len = (v: unknown) => String(v).length;
    if ((r['raw_value'] != null && !(len(r['raw_value']) >= 1 && len(r['raw_value']) <= 32)) || (r['interpretation_raw'] != null && len(r['interpretation_raw']) > 16)
      || (r['standard_version'] != null && !(len(r['standard_version']) >= 1 && len(r['standard_version']) <= 32))) throw bad('ast_results__texts__ck');
    if (r['standard'] === 'unknown' && r['category_code'] != null) throw bad('ast_results__unknown__ck');
    if (r['interpretation_source'] === 'breakpoint_suggestion' && (r['breakpoint_set_id'] == null || r['breakpoint_band_id'] == null)) throw bad('ast_results__suggestion__ck');
    const cats = tbl('g_cs_ast_interpretations');
    if (r['standard'] != null && r['category_code'] != null && cats.length && !cats.some((x) => x['standard'] === r['standard'] && x['code'] === r['category_code']))
      throw pgErr('23503', 'ast_results__category__fk', { constraint: 'ast_results__category__fk' });
  }
  const uqResult = (r: Row, o: Row) => same(o['tenant_id'], r['tenant_id']) && same(o['isolate_id'], r['isolate_id']) && o['antibiotic_code'] === r['antibiotic_code'] && o['method'] === r['method'];
  function checkPanel(r: Row): void {
    const bad = (n: string) => pgErr('23514', n, { constraint: n });
    if (r['organism_code'] != null && r['organism_group_code'] != null) throw bad('ast_panels__scope__ck');
    if (!/^[a-z0-9_]{2,64}$/.test(String(r['code']))) throw bad('ast_panels__code__ck');
    if (!(String(r['display']).length >= 1 && String(r['display']).length <= 120)) throw bad('ast_panels__display__ck');
    if (!METHODS.includes(r['default_method'])) throw bad('ast_panels__method__ck');
  }
  const uqPanel = (r: Row, o: Row): string | null => {
    if (!same(o['tenant_id'], r['tenant_id']) || o['code'] !== r['code']) return null;
    if (o['version_no'] === r['version_no']) return 'ast_panels__tenant_id_code_version__uq';
    if (o['superseded_at'] == null && r['superseded_at'] == null) return 'ast_panels__tenant_id_code__p_uq';
    return null;
  };
  function checkPanelAbx(r: Row): void {
    if (!tenantRow('ast_panels', r, r['panel_id'])) throw pgErr('23503', 'ast_panel_antibiotics__panel__fk', { constraint: 'ast_panel_antibiotics__panel__fk' });
    if (r['method'] != null && !METHODS.includes(r['method'])) throw pgErr('23514', 'ast_panel_antibiotics__method__ck', { constraint: 'ast_panel_antibiotics__method__ck' });
  }
  const uqPanelAbx = (r: Row, o: Row) => r['method'] != null && same(o['tenant_id'], r['tenant_id']) && same(o['panel_id'], r['panel_id']) && o['antibiotic_code'] === r['antibiotic_code'] && o['method'] === r['method'];

  const RULES: Record<string, { check: (r: Row) => void; uq: (r: Row, o: Row) => string | null }> = {
    ast_results: { check: checkResult, uq: (r, o) => (uqResult(r, o) ? 'ast_results__isolate_abx_method__uq' : null) },
    ast_panels: { check: checkPanel, uq: uqPanel },
    ast_panel_antibiotics: { check: checkPanelAbx, uq: (r, o) => (uqPanelAbx(r, o) ? 'ast_panel_antibiotics__panel_abx_method__uq' : null) },
  };

  /** Runs a write on a ruled table; a violation restores the table (a statement is atomic) and throws. */
  async function guarded(name: string, sql: string, params: unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
    const rule = RULES[name]!;
    const before = new Map<Row, string>(tbl(name).map((r) => [r, JSON.stringify(r)]));
    const snap = tbl(name).map((r) => ({ ...r }));
    const doNothing = /ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i.test(sql);
    try {
      await base.tx.query(sql, params);
      const touched: Row[] = [];
      for (const r of [...tbl(name)]) {
        const old = before.get(r);
        const isNew = old === undefined;
        if (isNew) for (const [k, v] of Object.entries(DEFAULTS[name]!())) if (!(k in r)) r[k] = v;
        if (!isNew && old === JSON.stringify(r)) continue;
        const clash = tbl(name).filter((o) => o !== r).map((o) => rule.uq(r, o)).find((x) => x);
        if (clash && isNew && doNothing) { tbl(name).splice(tbl(name).indexOf(r), 1); continue; }
        if (clash) throw pgErr('23505', clash, { constraint: clash });
        rule.check(r);
        touched.push(r);
      }
      const rows = /RETURNING/i.test(sql) ? touched.map((r) => ({ ...r })) : [];
      return { rows, rowCount: rows.length };
    } catch (e) { w[name] = snap; throw e; }
  }

  function select(sql: string, rows: Row[]): Row[] {
    if (/\b(max|count)\(/i.test(sql)) return rows;
    const where = /\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bLIMIT\b|\bFOR\s+UPDATE\b|$)/i.exec(sql)?.[1] ?? '';
    return rows.filter((r) => {
      for (const m of where.matchAll(/(?:\b\w+\.)?\b([a-z_]+)\s+IS\s+(NOT\s+)?NULL/gi)) if (m[1]! in r && ((r[m[1]!] == null) === Boolean(m[2]))) return false;
      for (const m of where.matchAll(/(?:\b\w+\.)?\b([a-z_]+)\s*=\s*(TRUE|FALSE)\b/gi)) if (m[1]! in r && r[m[1]!] !== (m[2]!.toUpperCase() === 'TRUE')) return false;
      return true;
    });
  }

  const stack: { name: string; snap: World }[] = [];
  let aborted = false;
  const NAME = '("?)([A-Za-z_][A-Za-z0-9_]{0,62})\\1';
  const log = base.log;
  const note = (sql: string, params: unknown[]) => log.push({ sql, params, op: 'OTHER', table: '' });

  const tx = {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
      let m: RegExpExecArray | null;
      if (/^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK)\s*;?\s*$/i.test(sql)) throw new Error('fake dialect: a handler must not manage the transaction (BEGIN / COMMIT / ROLLBACK belong to the core); use SAVEPOINT');
      if ((m = new RegExp(`^\\s*ROLLBACK\\s+TO(?:\\s+SAVEPOINT)?\\s+${NAME}\\s*;?\\s*$`, 'i').exec(sql))) {
        note(sql, params);
        const i = stack.map((s) => s.name).lastIndexOf(m[2]!);
        if (i < 0) throw pgErr('3B001', `savepoint "${m[2]}" does not exist`);
        restore(w, stack[i]!.snap); stack.length = i + 1; aborted = false;
        return { rows: [], rowCount: 0 };
      }
      if (aborted) { note(sql, params); throw pgErr('25P02', 'current transaction is aborted, commands ignored until end of transaction block'); }
      try {
        if ((m = new RegExp(`^\\s*SAVEPOINT\\s+${NAME}\\s*;?\\s*$`, 'i').exec(sql))) { note(sql, params); stack.push({ name: m[2]!, snap: snapshot(w) }); return { rows: [], rowCount: 0 }; }
        if ((m = new RegExp(`^\\s*RELEASE(?:\\s+SAVEPOINT)?\\s+${NAME}\\s*;?\\s*$`, 'i').exec(sql))) {
          note(sql, params);
          const i = stack.map((s) => s.name).lastIndexOf(m[2]!);
          if (i < 0) throw pgErr('3B001', `savepoint "${m[2]}" does not exist`);
          stack.length = i; return { rows: [], rowCount: 0 };
        }
        if (/^\s*(SAVEPOINT|RELEASE|ROLLBACK)\b/i.test(sql)) throw new Error(`fake dialect: savepoint statement shape not supported (names must be plain identifiers): ${sql.slice(0, 80)}`);
        const head = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase();
        const table = /\b(?:FROM|INTO|UPDATE)\s+(?:micro\.)?(\w+)/i.exec(sql)?.[1] ?? '';
        if ((head === 'INSERT' || head === 'UPDATE') && table in RULES) {
          return await guarded(table, sql, params);                       // the base fake logs the statement
        }
        const out = await base.tx.query(sql, params);
        if (head === 'SELECT') { const rows = select(sql, out.rows); return { rows, rowCount: rows.length }; }
        return out;
      } catch (e) { if ((e as { code?: unknown })?.code !== undefined) aborted = true; throw e; }
    },
  };
  return { tx, log, world: w, open: () => stack.map((s) => s.name), aborted: () => aborted };
}
