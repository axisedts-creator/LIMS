// C10 T-12 fixture: in-memory fake of the micro tables the job micro.breakpoint_import_validate touches + a JobContext (02-TRD §9; 05-SCHEMA §8).
// Writable: micro.breakpoint_sets (UPDATE only), micro.breakpoint_rows / breakpoint_bands / breakpoint_import_issues (INSERT only; 05-SCHEMA CHECKs, FKs, unique keys modelled).
// Read-only: micro.g_cs_organisms / g_cs_organism_groups / g_cs_antibiotics / g_cs_specimen_sites (+ tenant cs_* with RLS emulation), g_cs_ast_interpretations,
//   g_ast_category_restrictions. A SELECT returns EVERY row of every micro table named in FROM/JOIN (WHERE is NOT evaluated, except breakpoint_sets: by the bound set id);
//   so the job must merge/filter in code. Dictionary rows expose `code`, `is_active` (restrictions: standard, antibiotic_code, allowed_codes, is_active). Tenant cs_* rows of
//   another tenant are invisible (RLS). Any other table/statement -> "fake: unsupported SQL" (the writer adapts the SQL, this file is not widened for them).
// SQL dialect: INSERT INTO micro.<t> (cols) VALUES (<v>,…)[, (<v>,…)]   <v> = $n | 'lit' | number | true|false|NULL|now()
//              UPDATE micro.breakpoint_sets SET col = <v> | col = col + 1 [, …] WHERE <col = <v> | col IN (<v>,…) | col <> <v>> [AND …] [RETURNING …]
// Guard (micro.breakpoint_sets_guard + enforce_mutable_columns): transitions uploaded→validating, validating→validated|invalid, validated→active|discarded, uploaded→discarded,
//   invalid→discarded, active→retired only; anything else (incl. validating→validating) or a non-mutable column -> SQLSTATE P0001 'immutable_row'.
// Semantics: writes apply immediately with an undo log. `ctx.tx` (task transaction) COMMITS when the handler resolves and ROLLS BACK (undo) when it throws, as the worker core does;
//   `ctx.db.tx(fn)` is an INDEPENDENT transaction that commits when fn resolves (the only way a state survives a failed attempt).
import type { JobContext } from '../../../../core/manifest.js';

export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const SYS = '0190a000-0000-7000-8000-0000000c1001';      // micro system actor (shape only)
export const IMPORTER = '0190a000-0000-7000-8000-0000000c2002';
export const SET_ID = '0190a000-0000-7000-8000-0000000c3003';
export const NOW = '2026-11-12T04:00:00.000Z';
export const SET_PATH = `${TENANT_A}/breakpoints/${SET_ID}.csv`;

export type Row = Record<string, any>;
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const TRANSITIONS: Record<string, string[]> = { uploaded: ['validating', 'discarded'], validating: ['validated', 'invalid'], validated: ['active', 'discarded'], invalid: ['discarded'], active: ['retired'] };
const MUTABLE = ['status', 'validation_started_at', 'validated_at', 'row_count', 'band_count', 'error_count', 'warning_count', 'effective_from', 'effective_to', 'activated_by', 'activated_at', 'retired_by', 'retired_at', 'updated_at', 'updated_by', 'version'];
const DICT = ['g_cs_organisms', 'g_cs_organism_groups', 'g_cs_antibiotics', 'g_cs_specimen_sites', 'cs_organisms', 'cs_organism_groups', 'cs_antibiotics', 'cs_specimen_sites', 'g_cs_ast_interpretations', 'g_ast_category_restrictions'];
const TS = new Set(['validation_started_at', 'validated_at', 'updated_at', 'effective_from', 'effective_to', 'activated_at', 'retired_at', 'created_at', 'intended_effective_from']);

export function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, q = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'") q = !q;
    if (!q) { if (ch === '(') depth++; else if (ch === ')') depth--; }
    if (ch === ',' && depth === 0 && !q) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function tuples(s: string): string[] {            // "(a,b),(c,d)" -> ["a,b","c,d"]
  const out: string[] = []; let depth = 0, q = false, start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'") q = !q;
    if (q) continue;
    if (ch === '(') { if (depth++ === 0) start = i + 1; } else if (ch === ')' && --depth === 0) out.push(s.slice(start, i));
  }
  return out;
}
const val = (v: string, params: unknown[], now: Date): unknown => {
  const p = /^\$(\d+)/.exec(v);
  if (p) return params[Number(p[1]) - 1];
  const s = /^'((?:[^']|'')*)'/.exec(v);
  if (s) return s[1]!.replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  if (/^null$/i.test(v)) return null;
  if (/^now\(\)/i.test(v)) return now;
  throw new Error(`fake: unsupported SQL value ${v}`);
};
const asDate = (col: string, v: unknown) => (TS.has(col) && v != null && !(v instanceof Date) ? new Date(String(v)) : v);

export interface Call { readonly text: string; readonly params: unknown[]; readonly tx: 'task' | 'db' }
export interface WorldOpts { readonly set?: Partial<Row>; readonly dict?: Partial<Record<string, Row[]>> }

export function makeWorld(opts: WorldOpts = {}) {
  const w = {
    sets: [{
      id: SET_ID, tenant_id: TENANT_A, standard: 'CLSI', standard_version: '2026', title: 'Synthetic', licence_attestation_text: 'Synthetic attestation text, test only.',
      file_bucket: 'micro-imports', file_object_path: SET_PATH, file_sha256: 'a'.repeat(64), file_bytes: 1000, status: 'uploaded', intended_effective_from: null,
      validation_started_at: null, validated_at: null, row_count: 0, band_count: 0, error_count: 0, warning_count: 0, version: 1, is_active: true,
      created_at: new Date(NOW), created_by: IMPORTER, updated_at: new Date(NOW), updated_by: IMPORTER, ...opts.set,
    }] as Row[],
    rows: [] as Row[], bands: [] as Row[], issues: [] as Row[],
    dict: {
      g_cs_organisms: [{ code: 'syn_org_a', is_active: true }, { code: 'syn_org_inactive', is_active: false }],
      g_cs_organism_groups: [{ code: 'syn_group', is_active: true }],
      g_cs_antibiotics: [{ code: 'syn_abx_a', is_active: true }, { code: 'syn_abx_b', is_active: true }, { code: 'syn_colistin', is_active: true }],
      g_cs_specimen_sites: [{ code: 'syn_site', is_active: true }],
      cs_organisms: [] as Row[], cs_organism_groups: [] as Row[], cs_antibiotics: [] as Row[], cs_specimen_sites: [] as Row[],
      g_cs_ast_interpretations: [
        ...['S', 'SDD', 'I', 'I^', 'R', 'NS'].map((code) => ({ standard: 'CLSI', code, is_active: true })),
        ...['S', 'I', 'R'].map((code) => ({ standard: 'EUCAST', code, is_active: true })),
        ...['WT', 'NWT'].map((code) => ({ standard: 'ECOFF', code, is_active: true })),
      ],
      g_ast_category_restrictions: [{ standard: 'CLSI', antibiotic_code: 'syn_colistin', allowed_codes: ['I', 'R'], is_active: true }],
      ...opts.dict,
    } as Record<string, Row[]>,
    calls: [] as Call[],
    logs: [] as unknown[],
    idx: { ids: new Set<string>(), rowById: new Map<string, Row>(), rowKeys: new Set<string>(), bandKeys: new Set<string>() },
    failInsertInto: undefined as string | undefined,
    storageReads: [] as Array<[string, string]>,
  };
  const tableOf = (t: string): Row[] => (t === 'breakpoint_rows' ? w.rows : t === 'breakpoint_bands' ? w.bands : t === 'breakpoint_import_issues' ? w.issues : (undefined as never));
  const sets = () => w.sets;

  function makeTx(tenantId: string | undefined, kind: 'task' | 'db') {
    const undo: Array<() => void> = [];
    const tx = {
      async query(text: string, params: unknown[] = []) {
        w.calls.push({ text, params, tx: kind });
        const sql = text.replace(/\s+/g, ' ').trim();
        const now = new Date(NOW);
        if (/^SELECT/i.test(sql)) {
          const tabs = [...sql.matchAll(/(?:FROM|JOIN) (?:micro\.)?(\w+)/gi)].map((m) => m[1]!);
          if (tabs.length === 1 && tabs[0] === 'breakpoint_sets') {
            const hit = sets().filter((s) => s.tenant_id === tenantId && params.includes(s.id));
            return { rows: hit.map((s) => ({ ...s })), rowCount: hit.length };
          }
          if (tabs.length && tabs.every((t) => DICT.includes(t))) {
            const rows = tabs.flatMap((t) => (w.dict[t] ?? []).filter((r) => !t.startsWith('cs_') || r.tenant_id === tenantId));
            return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
          }
          throw new Error(`fake: unsupported SQL ${sql.slice(0, 80)}`);
        }
        const upd = /^UPDATE (?:micro\.)?breakpoint_sets SET (.*?) WHERE (.*?)(?: RETURNING (.*))?$/is.exec(sql);
        if (upd) {
          const conds = upd[2]!.split(/ AND /i).map((c) => c.trim());
          const sel = sets().filter((s) => s.tenant_id === tenantId && conds.every((c) => {
            let m = /^(?:\w+\.)?(\w+) = (.+)$/s.exec(c); if (m) return s[m[1]!] === val(m[2]!.trim(), params, now);
            m = /^(?:\w+\.)?(\w+) IN \((.*)\)$/s.exec(c); if (m) return splitTop(m[2]!).map((x) => val(x, params, now)).includes(s[m[1]!]);
            m = /^(?:\w+\.)?(\w+) <> (.+)$/s.exec(c); if (m) return s[m[1]!] !== val(m[2]!.trim(), params, now);
            throw new Error(`fake: unsupported WHERE ${c}`);
          }));
          for (const s of sel) {
            const next: Row = { ...s };
            for (const a of splitTop(upd[1]!)) {
              const [col, expr] = [a.slice(0, a.indexOf('=')).trim(), a.slice(a.indexOf('=') + 1).trim()];
              if (!MUTABLE.includes(col)) throw pgError('P0001', 'immutable_row');
              const inc = /^(\w+) \+ (\d+)$/.exec(expr);
              next[col] = inc ? (s[inc[1]!] as number) + Number(inc[2]) : asDate(col, val(expr, params, now));
            }
            if (next.status !== s.status && !(TRANSITIONS[s.status] ?? []).includes(next.status)) throw pgError('P0001', 'immutable_row');
            if (next.status === s.status && 'status' in Object.fromEntries(splitTop(upd[1]!).map((a) => [a.slice(0, a.indexOf('=')).trim(), 1]))) throw pgError('P0001', 'immutable_row');
            const old = { ...s }; Object.assign(s, next); undo.push(() => Object.assign(s, old));
          }
          return { rows: upd[3] ? sel.map((s) => ({ ...s })) : [], rowCount: sel.length };
        }
        const ins = /^INSERT INTO (?:micro\.)?(breakpoint_rows|breakpoint_bands|breakpoint_import_issues) \(([^)]*)\) VALUES (.*?)(?: RETURNING .*)?$/is.exec(sql);
        if (ins) {
          const table = ins[1]!;
          if (w.failInsertInto === table) throw new Error('fake: injected insert failure');
          const cols = ins[2]!.split(',').map((c) => c.trim());
          const target = tableOf(table);
          for (const t of tuples(ins[3]!)) {
            const vs = splitTop(t);
            const r: Row = {};
            cols.forEach((c, i) => { r[c] = asDate(c, val(vs[i]!, params, now)); });
            if (table === 'breakpoint_bands' && r.lower_inclusive == null) r.lower_inclusive = true;
            if (table === 'breakpoint_bands' && r.upper_inclusive == null) r.upper_inclusive = true;
            const bad = check(table, r, tenantId, w, target);
            if (bad) throw pgError(bad.startsWith('rls') ? '42501' : bad.endsWith('__uq') ? '23505' : bad.endsWith('__fk') ? '23503' : '23514', bad);
            target.push(r); const unreg = register(table, r, w.idx); undo.push(() => { const i = target.lastIndexOf(r); if (i >= 0) target.splice(i, 1); unreg(); });
          }
          return { rows: [], rowCount: tuples(ins[3]!).length };
        }
        throw new Error(`fake: unsupported SQL ${sql.slice(0, 80)}`);
      },
    };
    return { tx, commit: () => { undo.length = 0; }, rollback: () => { while (undo.length) undo.pop()!(); } };
  }

  function ctxFor(o: { tenantId?: string; attempt?: number; maxAttempts?: number; storage?: { read(bucket: string, path: string): Promise<Uint8Array> } } = {}) {
    const tenantId = 'tenantId' in o ? o.tenantId : TENANT_A;
    const task = makeTx(tenantId, 'task');
    const ctx: any = {
      tenantId, actor: { type: 'system', id: SYS }, requestId: 'req-t12', tx: task.tx, attempt: o.attempt ?? 1, maxAttempts: o.maxAttempts ?? 3, jobId: 'job-t12',
      now: () => NOW, isNewer: () => true, events: {}, core: {}, files: {}, audit: {},
      metrics: { inc: () => {}, observe: () => {} },
      log: { info: (x: unknown) => w.logs.push(x), warn: (x: unknown) => w.logs.push(x), error: (x: unknown) => w.logs.push(x), debug: (x: unknown) => w.logs.push(x) },
      storage: { read: async (bucket: string, path: string) => { w.storageReads.push([bucket, path]); if (!o.storage) throw new Error('fake: no storage'); return o.storage.read(bucket, path); } },
      db: {
        async tx<T>(fn: (c: JobContext) => Promise<T>): Promise<T> {
          const t = makeTx(tenantId, 'db');
          try { const out = await fn({ ...ctx, tx: t.tx }); t.commit(); return out; } catch (e) { t.rollback(); throw e; }
        },
      },
    };
    return { ctx: ctx as JobContext, commit: task.commit, rollback: task.rollback };
  }

  /** Runs the handler like the worker core: resolve -> COMMIT ctx.tx, throw -> ROLLBACK ctx.tx. Returns the error (never throws). */
  async function run(handler: (p: any, c: JobContext) => Promise<void>, payload: Record<string, unknown>, o: Parameters<typeof ctxFor>[0] = {}): Promise<{ error?: unknown }> {
    const { ctx, commit, rollback } = ctxFor(o);
    try { await handler(payload, ctx); commit(); return {}; } catch (error) { rollback(); return { error }; }
  }
  return { w, ctxFor, run, set: () => w.sets[0]! };
}

const rowKey = (x: Row) => [x.set_id, x.organism_scope, x.organism_code ?? '', x.antibiotic_code, x.method, x.specimen_site_code ?? '', x.qualifier_code ?? ''].join('|');
function register(table: string, r: Row, idx: ReturnType<typeof makeWorld>['w']['idx']): () => void {
  idx.ids.add(r.id);
  const k = table === 'breakpoint_rows' ? rowKey(r) : table === 'breakpoint_bands' ? r.row_id + ':' + r.band_no : '';
  if (table === 'breakpoint_rows') { idx.rowById.set(r.id, r); idx.rowKeys.add(k); }
  if (table === 'breakpoint_bands') idx.bandKeys.add(k);
  return () => { idx.ids.delete(r.id); if (table === 'breakpoint_rows') { idx.rowById.delete(r.id); idx.rowKeys.delete(k); } if (table === 'breakpoint_bands') idx.bandKeys.delete(k); };
}

function check(table: string, r: Row, tenantId: string | undefined, w: ReturnType<typeof makeWorld>['w'], target: Row[]): string | undefined {
  for (const c of ['id', 'tenant_id', 'set_id', 'created_by']) if (r[c] == null) return `${table}__${c}__nn`;
  if (r.tenant_id !== tenantId) return 'rls_tenant';
  if (!w.sets.some((s) => s.id === r.set_id && s.tenant_id === r.tenant_id)) return `${table}__set__fk`;
  if (w.idx.ids.has(r.id)) return `${table}__pk__uq`;
  if (table === 'breakpoint_rows') {
    if (!['organism', 'group', 'any'].includes(r.organism_scope) || (r.organism_scope === 'any') !== (r.organism_code == null)) return 'breakpoint_rows__scope__ck';
    if (!['mic', 'zone_diameter'].includes(r.method)) return 'breakpoint_rows__method__ck';
    if (r.qualifier_code != null && !/^[a-z0-9_]{1,32}$/.test(r.qualifier_code)) return 'breakpoint_rows__qualifier__ck';
    if (!Number.isInteger(r.line_no) || r.antibiotic_code == null) return 'breakpoint_rows__nn';
    if (w.idx.rowKeys.has(rowKey(r))) return 'breakpoint_rows__tenant_id_key__uq';
  }
  if (table === 'breakpoint_bands') {
    if (w.idx.rowById.get(r.row_id)?.set_id !== r.set_id) return 'breakpoint_bands__row__fk';
    if (!Number.isInteger(r.band_no) || r.band_no < 1 || r.band_no > 6) return 'breakpoint_bands__band_no__ck';
    if (w.idx.bandKeys.has(r.row_id + ':' + r.band_no)) return 'breakpoint_bands__row_band__uq';
    if (r.category_code == null) return 'breakpoint_bands__nn';
    const lo = r.lower_value == null ? null : Number(r.lower_value), hi = r.upper_value == null ? null : Number(r.upper_value);
    if (lo === null && hi === null) return 'breakpoint_bands__bound__ck';
    if (lo !== null && hi !== null && lo > hi) return 'breakpoint_bands__order__ck';
    if ((lo !== null && lo < 0) || (hi !== null && hi < 0)) return 'breakpoint_bands__nonneg__ck';
    if (r.note != null && String(r.note).length > 200) return 'breakpoint_bands__note__ck';
  }
  if (table === 'breakpoint_import_issues') {
    if (!['error', 'warning'].includes(r.severity)) return 'breakpoint_import_issues__severity__ck';
    if (!/^(file|row)\.[a-z_]{2,40}$/.test(String(r.code))) return 'breakpoint_import_issues__code__ck';
    if (r.field != null && String(r.field).length > 40) return 'breakpoint_import_issues__field__ck';
    if (r.message == null || String(r.message).length > 200) return 'breakpoint_import_issues__message__ck';
    if (r.line_no != null && !Number.isInteger(r.line_no)) return 'breakpoint_import_issues__line__ck';
  }
  return undefined;
}
