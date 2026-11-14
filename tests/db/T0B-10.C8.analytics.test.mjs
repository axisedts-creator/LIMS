// T0B-10.C8 static checks of the Wave-1 analytics DDL translation: db/migrations/*_analytics__*.sql, db/policies/analytics.sql, db/meta/tables.yaml, the 3 guard triggers, mutable-column triggers,
// audit triggers (schedules, schedule_recipients), seeds (g_cs_families, g_cs_report_codes), grant matrix. C8 publishes NO v_pub_* view (IC §6 has no analytics section; it only READS other schemas' views).
// Spec: C8 05-SCHEMA §1-§9 (§3 RLS + grants, §4 seeds, §5 triggers, §6 DDL + policies, §7 index map, §8 PHI); 02-CV §5.2 class R/E/M/G; C0 05-SCHEMA §3.8/§9/§10; 08 A16.1, A17 P-16/P-18/P-22, D-45/D-48; CR-C8-003..005;
// AC-0B-2.1..2.4, 3.6 (probes), 4.1..4.3, 5.x (audit triggers), 6.1..6.3 (static part: order, role switch, FK direction). AC-0B-6.4 is billing-only (T0B-11) and does not apply to analytics.
// Run: node --test tests/db/T0B-10.C8.analytics.test.mjs   (live: db/tests/analytics/T0B-10.C8_*.test.sql via pg_prove; generated probes: db/tests/isolation/analytics.*.test.sql)
// Method (as T0B-10.C2..C7): the expected DDL is PARSED FROM C8 05-SCHEMA at test time and compared (whitespace/case-normalised) with the migrations. The spec writes its policies as a plpgsql DO block
// (format(...) loops) plus 14 literal CREATE POLICY: the DO block is expanded here from the predicates the spec itself declares (pred_t / pred_c / p_sys / r_tables), and the migrations must contain the
// expanded LITERAL statements (no DO). What the spec only describes (guard-function bodies, mutable-column lists in the §5 table, seed lists in §4) is checked by property / parsed from the prose.
// T0B10C8_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B10C8_ROOT ? resolve(process.env.T0B10C8_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const anFiles = () => files().filter((f) => /^\d{14}_analytics__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const anSql = () => anFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'analytics.sql') ? strip(readFileSync(polDir + 'analytics.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C7)
function splitTop(body) {
  const out = []; let depth = 0, q = false, cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === "'") { if (body[i + 1] === "'") { cur += "'"; i++; } else q = false; } continue; }
    if (c === "'") { q = true; cur += c; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function balanced(sql, from) {
  let i = from, depth = 1, q = false;
  while (i < sql.length && depth) {
    const c = sql[i];
    if (q) { if (c === "'") { if (sql[i + 1] === "'") i++; else q = false; } } else if (c === "'") q = true; else if (c === '(') depth++; else if (c === ')') depth--;
    i++;
  }
  return sql.slice(from, i - 1);
}
const esc = (n) => n.replace('.', '\\.');
function createTable(sql, name) {
  const m = new RegExp(`CREATE\\s+(UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${esc(name)}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  const segs = splitTop(balanced(sql, m.index + m[0].length));
  const cons = segs.filter((s) => /^CONSTRAINT\b/i.test(s));
  const cols = segs.filter((s) => !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(s));
  const added = stmts(sql).filter((s) => new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${esc(name)}\\s+ADD\\s+CONSTRAINT\\b`, 'i').test(ws(s)))
    .map((s) => ws(s).replace(new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${esc(name)}\\s+ADD\\s+`, 'i'), ''));
  const allCons = [...cons, ...added];
  const nameOf = (c) => c.split(/\s+/)[0];
  return { cols, cons: allCons, colNames: cols.map(nameOf), colMap: new Map(cols.map((c) => [nameOf(c), norm(c)])), conMap: new Map(allCons.map((c) => [c.split(/\s+/)[1], norm(c)])) };
}
const idxName = (s) => /INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s)[1];
const createIndexes = (sql) => stmts(sql).filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s)).map(ws);
const createTriggers = (sql) => stmts(sql).filter((s) => /^CREATE\s+TRIGGER\b/i.test(s)).map(ws);
const trgName = (s) => /TRIGGER\s+(\w+)/i.exec(s)[1];
const isAudit = (s) => /app\.tg_row_audit\(/i.test(s);
const trgArgs = (s, fn) => { const m = new RegExp(`${fn}\\s*\\(`, 'i').exec(s); return m ? splitTop(balanced(s, m.index + m[0].length)).map((a) => a.replace(/^'|'$/g, '')).sort() : null; };
function policies(sql) {
  return stmts(sql).filter((s) => /^CREATE\s+POLICY\s+(?!%)/i.test(ws(s))).map((s) => {
    const m = /^CREATE\s+POLICY\s+(\w+)\s+ON\s+([\w.]+)\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([\w, ]+?)\s+(?=USING|WITH)([\s\S]*)$/i.exec(ws(s));
    assert.ok(m, `parsable policy: ${ws(s).slice(0, 110)}`);
    const rest = m[5], wi = rest.search(/\bWITH\s+CHECK\b/i);
    const using = /^USING/i.test(rest) ? (wi < 0 ? rest : rest.slice(0, wi)).replace(/^\s*USING\s*/i, '').trim() : '';
    const check = wi < 0 ? '' : rest.slice(wi).replace(/^\s*WITH\s+CHECK\s*/i, '').trim();
    const unwrap = (x) => { x = x.trim(); if (x[0] === '(' && balanced(x, 1).length === x.length - 2) return x.slice(1, -1).trim(); return x; };
    return { name: m[1], table: m[2], key: `${m[1]}@${m[2]}`, cmd: m[3].toUpperCase(), roles: m[4].split(',').map((r) => r.trim()).sort().join(','), using: norm(unwrap(using)), check: norm(unwrap(check)), text: ws(s) };
  });
}
// GRANT ... ON table: Map "schema.table" -> Map role -> { all: Set(priv), cols: Map(priv -> Set(col)) }   (functions / schemas / sequences skipped)
function grantsOf(sql) {
  const g = new Map();
  for (const s of stmts(sql)) {
    const m = /^GRANT\s+(.+?)\s+ON\s+(?:TABLE\s+)?([\w., ]+?)\s+TO\s+([\w, ]+?)(\s+WITH\s+GRANT\s+OPTION)?$/i.exec(ws(s));
    if (!m || /\bFUNCTION\b|\bSCHEMA\b|\bSEQUENCE\b/i.test(s) || /^(EXECUTE|USAGE|CREATE)$/i.test(m[1].trim())) continue;
    const items = splitTop(m[1]).map((x) => /^(\w+)\s*(?:\(([^)]*)\))?$/.exec(x.trim())).filter(Boolean);
    for (const t of m[2].split(',').map((x) => x.trim())) for (const r of m[3].split(',').map((x) => x.trim())) {
      if (!g.has(t)) g.set(t, new Map());
      const rm = g.get(t); if (!rm.has(r)) rm.set(r, { all: new Set(), cols: new Map() });
      for (const [, p, cl] of items) {
        const P = p.toUpperCase();
        if (cl === undefined) rm.get(r).all.add(P);
        else { if (!rm.get(r).cols.has(P)) rm.get(r).cols.set(P, new Set()); for (const c of cl.split(',').map((x) => x.trim())) rm.get(r).cols.get(P).add(c); }
      }
    }
  }
  return g;
}
function fnText(sql, qname) {
  const m = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${esc(qname)}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  const open = /AS\s+(\$\w*\$)/i.exec(sql.slice(m.index));
  if (!open) return null;
  const bodyStart = m.index + open.index + open[0].length;
  const end = sql.indexOf(open[1], bodyStart);
  return end < 0 ? null : sql.slice(m.index, end + open[1].length);
}
const fnNames = (sql) => [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase());
// INSERT INTO <table> (cols) VALUES (...),(...) -> [{col: rawValue}]
function insertRows(sql, table) {
  const rows = [];
  for (const s of stmts(sql).map(ws).filter((x) => new RegExp(`^INSERT\\s+INTO\\s+${esc(table)}\\b`, 'i').test(x))) {
    const m = new RegExp(`^INSERT\\s+INTO\\s+${esc(table)}\\s*\\(([^)]*)\\)\\s*VALUES\\s*([\\s\\S]*?)(?:\\s+ON\\s+CONFLICT[\\s\\S]*)?$`, 'i').exec(s);
    assert.ok(m, `seed INSERT INTO ${table} must name its columns: ${s.slice(0, 80)}`);
    const cols = m[1].split(',').map((c) => c.trim());
    for (const tup of splitTop(m[2])) {
      assert.match(tup, /^\(/, `tuple ${tup.slice(0, 40)}`);
      const vals = splitTop(balanced(tup, 1)); assert.equal(vals.length, cols.length, `${table}: tuple arity ${tup.slice(0, 60)}`);
      rows.push(Object.fromEntries(cols.map((c, i) => [c, vals[i]])));
    }
  }
  return rows;
}

// ---------------------------------------------------------------- spec extraction (C8 05-SCHEMA)
const specPath = repo + 'spec/chunks/C8-analytics-mis/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = s.indexOf(b0, a + a0.length); assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const S1 = '## 1. Table inventory', S2 = '## 2. Columns', S3 = '## 3. RLS', S4 = '## 4. Coded sets', S5 = '## 5. Triggers', S6 = '## 6. DDL', S7 = '## 7. Query', S8 = '## 8. Data classification';
const specDdlRaw = () => sqlBlocks(between(specRaw(), S6, S7));
const specDdl = () => strip(specDdlRaw());
const spec3 = () => between(specRaw(), S3, S4);
const spec4 = () => between(specRaw(), S4, S5);
const spec5 = () => between(specRaw(), S5, S6);
const spec7 = () => between(specRaw(), S7, S8);

const G_T = ['g_cs_families', 'g_cs_report_codes'].map((t) => `analytics.${t}`);
const R_N = ['daily_orders', 'daily_centre_volume', 'daily_referrer_volume', 'daily_income', 'daily_department_income', 'daily_collections', 'daily_referrer_billing', 'daily_results', 'daily_specimens',
  'daily_rejections', 'daily_critical_values', 'tat_facts', 'daily_releases', 'daily_deliveries', 'daily_interface_messages', 'report_backlog'];
const R_T = R_N.map((t) => `analytics.${t}`);
const E_N = ['refresh_state', 'dirty_partitions', 'refresh_runs', 'order_index', 'exports', 'export_files', 'report_runs', 'report_run_recipients'];
const M_N = ['schedules', 'schedule_recipients'];
const TENANT = [...R_N, ...E_N, ...M_N].map((t) => `analytics.${t}`);                       // 26 tenant tables (event_inbox exists from T0B-05)
const ALLT = [...G_T, ...TENANT];                                                              // 28 new tables
const isG = (q) => /\.g_/.test(q);
const CLS = { ...Object.fromEntries(R_N.map((t) => [t, 'R'])), ...Object.fromEntries(E_N.map((t) => [t, 'E'])), schedules: 'M', schedule_recipients: 'M' };
const AUDITED = ['schedules', 'schedule_recipients'].map((t) => `analytics.${t}`);
// §3 grants (lims_app only; lims_analytics gets none)
const SIU_T = ['refresh_state', 'schedules', 'schedule_recipients'].map((t) => `analytics.${t}`);
const SIUD_T = ['dirty_partitions', 'refresh_runs', 'order_index', 'exports', 'report_runs'].map((t) => `analytics.${t}`);
const SID_T = [...R_T, 'analytics.export_files', 'analytics.report_run_recipients'];
const GUARD_FN = ['analytics.exports_transition_guard', 'analytics.schedules_codes_guard', 'analytics.schedule_recipients_cap'];
const OPTIONAL_FN = ['analytics.refresh_runs_transition_guard'];    // spec §5: refresh_runs.status running -> succeeded|failed only; no function is named, this is the only extra name tolerated
const MUT_TBL = ['exports', 'refresh_runs', 'report_runs'];

// ---- expected policies: the DO block of §6 expanded from the predicates the spec declares, plus the 14 literal policies
function specPreds() {
  const d = specDdlRaw().replace(/\r\n?/g, '\n');
  const g = (n) => { const m = new RegExp(`${n}\\s+text\\s*:=\\s*\\$p\\$([\\s\\S]*?)\\$p\\$`).exec(d); assert.ok(m, `spec predicate ${n}`); return ws(m[1]); };
  const rt = /r_tables\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/.exec(d); assert.ok(rt, 'spec r_tables');
  return { PT: g('pred_t'), PC: g('pred_c'), PS: g('p_sys'), rTables: [...rt[1].matchAll(/'(\w+)'/g)].map((m) => m[1]) };
}
function expectedPolicies() {
  const { PT, PC, PS } = specPreds(), out = [];
  const add = (tbl, cmd, name, using, check) => {
    let s = `CREATE POLICY ${name} ON analytics.${tbl} FOR ${cmd} TO lims_app`;
    if (using) s += ` USING (${using})`; if (check) s += ` WITH CHECK (${check})`;
    out.push(...policies(s));
  };
  for (const t of R_N) { add(t, 'SELECT', `${t}__select__tenant_centre`, PC); add(t, 'INSERT', `${t}__insert__tenant`, null, `${PT} AND ${PS}`); add(t, 'DELETE', `${t}__delete__tenant`, `${PT} AND ${PS}`); }
  add('refresh_state', 'SELECT', 'refresh_state__select__tenant', PT);
  add('refresh_state', 'INSERT', 'refresh_state__insert__tenant', null, `${PT} AND ${PS}`);
  add('refresh_state', 'INSERT', 'refresh_state__insert__tenant_manual', null, `${PT} AND family = '_manual'`);
  add('refresh_state', 'UPDATE', 'refresh_state__update__tenant', `${PT} AND ${PS}`, `${PT} AND ${PS}`);
  add('refresh_state', 'UPDATE', 'refresh_state__update__tenant_manual', `${PT} AND family = '_manual'`, `${PT} AND family = '_manual'`);
  add('dirty_partitions', 'SELECT', 'dirty_partitions__select__tenant', PT);
  add('dirty_partitions', 'INSERT', 'dirty_partitions__insert__tenant', null, PT);
  add('dirty_partitions', 'UPDATE', 'dirty_partitions__update__tenant', PT, PT);
  add('dirty_partitions', 'DELETE', 'dirty_partitions__delete__tenant', `${PT} AND ${PS}`);
  for (const t of ['refresh_runs', 'order_index']) {
    add(t, 'SELECT', `${t}__select__tenant`, t === 'refresh_runs' ? PT : `${PT} AND ${PS}`);
    add(t, 'INSERT', `${t}__insert__tenant`, null, `${PT} AND ${PS}`);
    add(t, 'UPDATE', `${t}__update__tenant`, `${PT} AND ${PS}`, `${PT} AND ${PS}`);
    add(t, 'DELETE', `${t}__delete__tenant`, `${PT} AND ${PS} AND expires_at < now()`);
  }
  for (const t of M_N) { add(t, 'SELECT', `${t}__select__tenant`, PT); add(t, 'INSERT', `${t}__insert__tenant`, null, PT); add(t, 'UPDATE', `${t}__update__tenant`, PT, PT); }
  return [...out, ...policies(specDdl()).filter((p) => /^analytics\.(exports|export_files|report_runs|report_run_recipients)$/.test(p.table))];
}
const EXPECTED_POLICY_COUNT = 85;                                                       // 48 R + 5 refresh_state + 4 dirty + 4 + 4 + 3 + 3 + 14 literal (exports 4, export_files 3, report_runs 4, report_run_recipients 3)
// C5/C6/C7 precedent: pred_c carries no staff guard in the spec but gate 9 (check-registry, 08 A17 P-16) requires it on every __tenant / __tenant_centre policy. The comparison is modulo that one conjunct;
// the shape test below demands it.
const noGuard = (x) => x.replace(/and\(select app\.is_staff_or_system\(\)\)/g, '').replace(/\(select app\.is_staff_or_system\(\)\)and/g, '');
const STAFF = /\(select app\.is_staff_or_system\(\)\)/;

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 28 new analytics tables (2 G + 26 tenant), 16 R tables in the DO list, 85 expected policies derived, 3 guard functions named, no views / DEFINERs, §3 index names, §4 seed lists', () => {
  const ddl = specDdl();
  for (const q of ALLT) assert.ok(createTable(ddl, q), `spec has ${q}`);
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 28, '28 CREATE TABLE in §6');
  assert.doesNotMatch(ddl, /CREATE\s+TABLE\s+analytics\.event_inbox/i);
  assert.deepEqual(specPreds().rTables, R_N, 'spec r_tables list = the 16 class R tables');
  assert.doesNotMatch(ddl, /CREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\b/i, 'C8 has no view');
  assert.doesNotMatch(ddl, /SECURITY\s+DEFINER/i);
  for (const f of GUARD_FN) assert.ok(spec5().includes(f.replace('analytics.', '')) || specRaw().includes(f), `spec names ${f}`);
  const ps = expectedPolicies();
  assert.equal(new Set(ps.map((p) => p.key)).size, ps.length, 'no duplicate expected policy');
  assert.equal(ps.length, EXPECTED_POLICY_COUNT, `expected policies: ${ps.length}`);
  assert.deepEqual([...new Set(ps.map((p) => p.table))].sort(), [...TENANT].sort(), 'every tenant table (and no G table) has policies');
  const refs = new Set([...ddl.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase().split('.')[0]));
  assert.deepEqual([...refs].sort(), ['analytics', 'core'], 'spec FK target schemas (§ header: analytics -> core only)');
  const names = [...spec7().matchAll(/`([a-z_0-9]+__[a-z_0-9]*(?:uq|idx|pk))\b/g)].map((m) => m[1]);
  assert.ok(names.length >= 14, `§7 index names: ${names.length}`);
  assert.equal(spec4().match(/`_manual`/g)?.length >= 1, true);
});

// ================================================================ files, order, owner (AC-0B-6.1 / 6.3)
test('migration files: >= 1 *_analytics__*.sql, unique timestamps, after the core + identity + catalog + frontdesk + billing + lab + reporting + instruments + event_inboxes migrations (stage order, analytics last in the DAG), db/policies/analytics.sql exists', () => {
  assert.ok(anFiles().length >= 1, 'no db/migrations/*_analytics__*.sql yet (T0B-10.C8 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => /_(core|catalog|frontdesk|billing|lab|identity|reporting|instruments)__/.test(f) || /core__create_event_inboxes|app__create_queue_wrapper/.test(f));
  assert.ok(earlier.length >= 9, 'earlier-stage migrations present');
  for (const f of anFiles()) for (const e of earlier) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (02-TRD §4.2 stage order; analytics is last in the DAG, CM §5 R3)`);
  assert.ok(existsSync(polDir + 'analytics.sql'), 'db/policies/analytics.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(anSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)analytics\b/i, 'schema analytics exists since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every analytics migration is SET LOCAL ROLE lims_owner and it is the only role switch (all objects owned by lims_owner; no D-201 window: C8 has no lookup role)', () => {
  assert.ok(anFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+|SET\s+SESSION\s+AUTHORIZATION)/gi)].map((m) => ws(m[1]).toUpperCase());
  for (const f of anFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch`);
  }
  assert.doesNotMatch(anSql(), /GRANT\s+CREATE\s+ON\s+(SCHEMA\s+app|DATABASE)/i, 'no standing CREATE grants');
  assert.doesNotMatch(anSql(), /CREATE\s+ROLE|ALTER\s+ROLE/i, 'roles are C0 bootstrap');
});

// ================================================================ tables (columns + constraints = spec exactly; only UNIQUE (tenant_id, id) may be added)
for (const q of ALLT) {
  test(`${q}: every spec column + constraint (name + text) present identically in the migration; no extra column (the spec DDL is complete incl. the mandatory-column exceptions); only UNIQUE (tenant_id, id) may be added (05-SCHEMA §6; C0 §9 rule 1)`, () => {
    const exp = createTable(specDdl(), q); assert.ok(exp, `spec table ${q}`);
    const got = createTable(anSql(), q);
    assert.ok(got, `CREATE TABLE ${q} not found in *_analytics__*.sql`);
    for (const [c, def] of exp.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    for (const c of got.colMap.keys()) assert.ok(exp.colMap.has(c), `${q}: extra column ${c} (class ${isG(q) ? 'G' : CLS[q.split('.')[1]]} mandatory-column exceptions are deliberate, 08 A17 P-18(b))`);
    for (const [c, def] of exp.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    for (const [c, def] of got.conMap) if (!exp.conMap.has(c)) assert.match(def, /^constraint\s+\w+\s+unique\(tenant_id,id\)$/, `${q}: extra constraint ${c} (only UNIQUE (tenant_id, id) may be added)`);
  });
}
test('exactly the 28 §6 tables are created in analytics (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9); export_files.content SET STORAGE EXTERNAL; no patient / name / phone / barcode / result column (§8)', () => {
  const sql = anSql(), bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(bare, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /event_inbox/i, 'C8 migrations do not touch event_inbox (T0B-05 owns it)');
  for (const q of ALLT) for (const c of ['id', 'tenant_id']) { const def = createTable(sql, q).colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`); }
  assert.match(sql, /ALTER\s+TABLE\s+analytics\.export_files\s+ALTER\s+COLUMN\s+content\s+SET\s+STORAGE\s+EXTERNAL/i);
  const cols = ALLT.flatMap((q) => createTable(sql, q).colNames.map((c) => `${q}.${c}`));
  assert.deepEqual(cols.filter((c) => /(patient_(id|name|no|ref)|phone|barcode|registration|result_value|test_name|first_name|last_name|password|secret|token)/.test(c.split('.')[2])), [], '§8: no personal / credential column in analytics');
});
test('cross-schema references (01-CM §5 R3): analytics -> analytics / core.tenants / core.memberships only, identical target set to the spec; NO FK into billing / lab / frontdesk / reporting / instruments / catalog; nothing references analytics (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(anSql()), exp = tgt(specDdl());
  assert.deepEqual([...got].sort(), [...exp].sort(), 'FK target tables equal the spec');
  for (const t of got) assert.ok(/^analytics\./.test(t) || /^core\.(tenants|memberships)$/.test(t), `analytics FK target ${t}`);
  assert.doesNotMatch(files().filter((f) => !/_analytics__/.test(f)).map(read).join('\n'), /\bREFERENCES\s+analytics\./i, 'no FK into analytics from any other migration');
});
test('indexes: every §6 CREATE INDEX present with identical definition (partial predicates, DESC, INCLUDE); no extra index; every §7 index name exists as an index or a constraint', () => {
  const have = new Map(createIndexes(anSql()).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  assert.equal(exp.length, 16, `spec indexes: ${exp.length}`);
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].sort(), exp.map(idxName).sort(), 'no index beyond the spec');
  assert.match(have.get('tat_facts__tenant_id_segment_date__idx') ?? '', /include\(centre_id,duration_seconds,is_anomaly\)/);
  assert.match(have.get('refresh_runs__tenant_id_family_started__idx') ?? '', /started_at desc/);
  for (const n of ['order_index__tenant_id_open__p_idx', 'exports__tenant_id_expiry__p_idx', 'schedules__tenant_id_due__p_idx']) assert.match(have.get(n) ?? '', /\bwhere\b/, `${n} is partial`);
  const conNames = new Set(ALLT.flatMap((q) => [...createTable(anSql(), q).conMap.keys()]));
  const missing = [...new Set([...spec7().matchAll(/`([a-z_0-9]+__[a-z_0-9]*(?:uq|idx|pk))\b/g)].map((m) => m[1]))].filter((n) => !have.has(n) && !conNames.has(n));
  assert.deepEqual(missing, [], '§7 index names that exist neither as CREATE INDEX nor as a constraint');
});
test('tenant_id leads every index and UNIQUE / PRIMARY KEY constraint of a tenant table (except single-column PRIMARY KEY (id)); the 16 class R tables have a natural composite key with tenant_id leading (02-CV §5.2 R); unique keys over nullable columns are NULLS NOT DISTINCT', () => {
  const sql = anSql();
  for (const s of createIndexes(sql)) {
    const m = /\bON\s+(\w+\.\w+)\s+(?:USING\s+\w+\s+)?\(\s*([^,)]+)/i.exec(s); assert.ok(m, s);
    assert.equal(m[2].trim(), 'tenant_id', `index ${idxName(s)} on ${m[1]} must lead with tenant_id`);
  }
  for (const q of TENANT) {
    const t = createTable(sql, q);
    for (const c of [...t.conMap.values()].filter((x) => /\b(primary key|unique(?: nulls not distinct)?)\(/.test(x))) {
      const k = /\b(?:primary key|unique(?: nulls not distinct)?)\(([^)]*)\)/.exec(c)[1];
      if (/primary key/.test(c) && k === 'id') continue;
      assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${c}`);
    }
    if (R_T.includes(q)) assert.ok([...t.conMap.values()].some((c) => /\b(primary key|unique nulls not distinct)\(tenant_id,/.test(c)), `${q}: class R natural composite key`);
    if ([...t.conMap.values()].some((c) => /primary key\(id\)/.test(c))) assert.ok([...t.conMap.values()].some((c) => /unique\(tenant_id,id\)/.test(c)), `${q}: PRIMARY KEY (id) requires UNIQUE (tenant_id, id) (04 D8)`);
  }
  for (const q of R_T) for (const c of ['tenant_id', 'refresh_run_id', 'refreshed_at']) assert.ok(createTable(sql, q).colMap.has(c), `${q}.${c} (class R mandatory)`);
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A10.5, A16.1)
test('ENABLE + FORCE ROW LEVEL SECURITY (literal statements, no DO block) on the 26 tenant tables; none on the 2 g_cs_* tables; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = anSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of G_T) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(anSql(), /\bDO\s+\$/i, 'literal statements only (C0 expands the spec DO block; the policy dump / CI tools read the files)');
  assert.doesNotMatch(polSql(), /\bDO\s+\$/i);
});
const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('analytics.') && !/\.event_inbox$/.test(p.table));
test('policies: db/policies/analytics.sql holds EXACTLY the expected 85 policies (spec DO block expanded + 14 literal): name, command, role, USING, WITH CHECK (modulo the staff-guard conjunct); G tables none; only event_inbox may be extra', () => {
  const exp = expectedPolicies(), got = gotPolicies();
  assert.ok(got.length > 0, 'db/policies/analytics.sql has no CREATE POLICY');
  const byKey = new Map(got.map((p) => [p.key, p])); assert.equal(byKey.size, got.length, 'no duplicate policy');
  for (const e of exp) {
    const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(noGuard(g.using), noGuard(e.using), `${e.key} USING`); assert.equal(noGuard(g.check), noGuard(e.check), `${e.key} WITH CHECK`);
  }
  assert.deepEqual([...byKey.keys()].sort(), exp.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access)');
  for (const p of policies(polSql()).filter((x) => /\.event_inbox$/.test(x.table))) assert.match(p.name, /^event_inbox__(select|insert|delete)__(tenant|owner_only)$/, `${p.key}: only the C0 inbox shapes may appear`);
});
test('policy shape: names <table>__<cmd>__(tenant|tenant_centre|tenant_manual); all TO lims_app (no owner_only / lookup: C8 has no purge DEFINER, retention deletes run as the system actor); ::uuid[] cast (A16.1); staff guard in USING and WITH CHECK of every policy (08 A17 P-16, gate 9); class R: INSERT/DELETE system-only, SELECT centre-scoped, no UPDATE; M: no DELETE; no true / PUBLIC / anon', () => {
  const ps = gotPolicies();
  assert.equal(ps.length, EXPECTED_POLICY_COUNT, `policies: ${ps.length}`);
  for (const p of ps) {
    const tbl = p.table.split('.')[1], m = new RegExp(`^${tbl}__${p.cmd.toLowerCase()}__(tenant|tenant_centre|tenant_manual)$`).exec(p.name);
    assert.ok(m, `${p.key}: name <table>__<cmd>__<scope>`);
    assert.equal(p.roles, 'lims_app', `${p.key} roles`);
    const t = p.using + ' ' + p.check;
    if (/current_centre_ids/.test(t)) assert.match(t, /any\(\(select app\.current_centre_ids\(\)\)::uuid\[\]\)/, `${p.key}: A16.1 cast`);
    if (p.cmd !== 'INSERT') assert.match(p.using, STAFF, `${p.key} USING lacks the staff guard (08 A17 P-16; check-registry)`);
    if (p.cmd === 'INSERT' || p.cmd === 'UPDATE') assert.match(p.check, STAFF, `${p.key} WITH CHECK lacks the staff guard (08 A17 P-16; check-registry)`);
    if (m[1] === 'tenant_centre') { assert.ok(R_T.includes(p.table) && p.cmd === 'SELECT', `${p.key}: tenant_centre is the class R SELECT scope`); assert.match(p.using, /has_all_centres/); assert.match(p.using, /centre_id is not null and centre_id=any/, `${p.key}: NULL-centre rows hidden from centre-restricted readers (PRD §8.3)`); }
    if (m[1] === 'tenant_manual') { assert.equal(p.table, 'analytics.refresh_state'); assert.match(t, /family='_manual'/); assert.doesNotMatch(t, /current_actor_type/, `${p.key}: the user path is the _manual row only`); }
    assert.match(t, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: tenant predicate`);
    assert.doesNotMatch(t, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|is_platform_actor|app\.maintenance|app\.pre_/, p.key);
    assert.ok(!isG(p.table), `${p.key}: G tables carry no policy`);
  }
  const sys = /\(select app\.current_actor_type\(\)\)='system'/;
  for (const q of R_T) {
    const cmds = ps.filter((p) => p.table === q).map((p) => p.cmd).sort(); assert.deepEqual(cmds, ['DELETE', 'INSERT', 'SELECT'], `${q}: class R has SELECT / INSERT / DELETE policies and no UPDATE`);
    for (const p of ps.filter((x) => x.table === q && x.cmd !== 'SELECT')) assert.match(p.using + ' ' + p.check, sys, `${p.key}: class R writes by the system actor only (CR-C8-003)`);
  }
  const tbls = (cmd) => [...new Set(ps.filter((p) => p.cmd === cmd).map((p) => p.table))].sort();
  assert.deepEqual(tbls('DELETE'), [...R_T, ...['dirty_partitions', 'refresh_runs', 'order_index', 'exports', 'export_files', 'report_runs', 'report_run_recipients'].map((t) => `analytics.${t}`)].sort(), 'DELETE policies exactly where §3 lists them (none on refresh_state, schedules, schedule_recipients)');
  assert.deepEqual(tbls('UPDATE'), [...SIU_T, ...SIUD_T].sort(), 'UPDATE policies only where §3 lists them (none on class R, export_files, report_run_recipients)');
  for (const t of ['refresh_runs', 'order_index', 'report_runs', 'report_run_recipients']) assert.match(ps.find((p) => p.table === `analytics.${t}` && p.cmd === 'DELETE').using, /expires_at ?< ?now\(\)/, `${t}: retention delete by expires_at (P-18(c))`);
  assert.match(ps.find((p) => p.table === 'analytics.exports' && p.cmd === 'DELETE').using, /requested_at ?< ?now\(\) ?- ?interval '400 days'/, 'exports metadata is deleted by requested_at');
  assert.match(ps.find((p) => p.key === 'exports__insert__tenant@analytics.exports').check, /status='queued'/);
  assert.match(ps.find((p) => p.key === 'exports__insert__tenant@analytics.exports').check, /requested_by_membership_id=\(select nullif\(app\.current_claims\(\) ?->> ?'membership_id',''\)::uuid\)/, 'a user can only create an export for itself');
  for (const k of ['report_runs__select__tenant@analytics.report_runs', 'report_run_recipients__select__tenant@analytics.report_run_recipients']) assert.match(ps.find((p) => p.key === k).using, /exists\(select 1 from analytics\.schedules s where/, `${k}: owner branch reads schedules directly (no policy cycle, §3 note)`);
  assert.doesNotMatch(ps.find((p) => p.key === 'report_run_recipients__select__tenant@analytics.report_run_recipients').using, /analytics\.report_runs/, 'report_run_recipients never references report_runs (infinite recursion)');
});
test('policies written literally in migrations are identical to db/policies/analytics.sql (AC-0B-2.3 copy)', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(anSql()).filter((x) => x.table.startsWith('analytics.') && !/\.event_inbox$/.test(x.table));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort(), 'every policy of the file is created by a migration and vice versa');
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §3 grants paragraph)
test('grants equal §3: lims_app SELECT+INSERT+DELETE on the 16 class R + export_files + report_run_recipients; SELECT+INSERT+UPDATE on refresh_state / schedules / schedule_recipients; SELECT+INSERT+UPDATE+DELETE on dirty_partitions / refresh_runs / order_index / exports / report_runs; SELECT on g_cs_*; NO DELETE on schedules / schedule_recipients / refresh_state; lims_analytics NO grant on analytics.*', () => {
  const sql = anSql() + '\n;\n' + polSql(), g = grantsOf(sql);
  const privs = (q, r) => g.get(q)?.get(r)?.all ?? new Set();
  for (const q of SIU_T) assert.deepEqual([...privs(q, 'lims_app')].sort(), ['INSERT', 'SELECT', 'UPDATE'], `${q} lims_app`);
  for (const q of SIUD_T) assert.deepEqual([...privs(q, 'lims_app')].sort(), ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], `${q} lims_app`);
  for (const q of SID_T) assert.deepEqual([...privs(q, 'lims_app')].sort(), ['DELETE', 'INSERT', 'SELECT'], `${q} lims_app (no UPDATE grant: class R rule / outcome set once)`);
  for (const q of G_T) assert.deepEqual([...privs(q, 'lims_app')].sort(), ['SELECT'], `${q} lims_app`);
  const expTargets = new Set([...SIU_T, ...SIUD_T, ...SID_T, ...G_T]);
  assert.equal(expTargets.size, 28);
  for (const [t, rm] of g) if (/^analytics\./.test(t)) {
    assert.ok(expTargets.has(t), `${t}: unexpected grant target`);
    for (const [r, p] of rm) {
      assert.equal(r, 'lims_app', `${t}: unexpected grantee ${r} (lims_analytics gets no grant on analytics.* in v1, §3)`);
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!p.all.has(bad) && !p.cols.has(bad), `${t}: ${r} must not hold ${bad}`);
      assert.equal(p.cols.size, 0, `${t}: whole-table grants only`);
    }
  }
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\banalytics\./i);
  assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+analytics\b/i);
  assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\banalytics\b/i);
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\banalytics\./i.test(s) && !/FUNCTION/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner|lims_analytics)\b/i, s);
  for (const q of ALLT) { const c = ['A', 'B', 'C'].includes(tablesYamlSafe()?.[q]?.class); assert.equal(c, false, `${q}: no C8 table is class A, B or C (08 A17 P-18(a))`); }
});

// ================================================================ functions + triggers (AC-0B-4.1; §5)
test('the 3 guard functions (analytics.exports_transition_guard / schedules_codes_guard / schedule_recipients_cap) are SECURITY INVOKER plpgsql RETURNS trigger with search_path = \'\' (no DEFINER, no inventory entry: 04 D7) and encode the §5 rules; no other function except the optional refresh_runs_transition_guard', () => {
  const sql = anSql();
  for (const f of GUARD_FN) {
    const got = fnText(sql, f); assert.ok(got, `${f} missing (05-SCHEMA §6 closing paragraph)`);
    assert.match(got, /RETURNS\s+trigger/i); assert.match(got, /LANGUAGE\s+plpgsql/i); assert.match(got, /SET\s+search_path\s*=\s*''/i); assert.doesNotMatch(got, /SECURITY\s+DEFINER/i, `${f} is INVOKER`);
  }
  const eg = fnText(sql, 'analytics.exports_transition_guard');
  assert.match(eg, /ERRCODE\s*=\s*'P0001'/i, 'SQLSTATE P0001 (§5 closing line)'); assert.match(eg, /immutable_row|invalid_transition/);
  for (const w of ['queued', 'building', 'ready', 'failed', 'expired', 'downloads_used', 'downloads_allowed', 'current_actor_type', 'system', 'updated_at', 'updated_by', 'version']) assert.match(eg, new RegExp(w), `exports_transition_guard mentions ${w}`);
  const cg = fnText(sql, 'analytics.schedules_codes_guard');
  assert.match(cg, /ERRCODE\s*=\s*'23514'/i, 'SQLSTATE 23514 -> common.validation_failed (§6)');
  for (const w of ['g_cs_report_codes', 'is_active', 'is_schedulable', 'report_codes']) assert.match(cg, new RegExp(w), `schedules_codes_guard mentions ${w}`);
  const cap = fnText(sql, 'analytics.schedule_recipients_cap');
  for (const w of ['schedule_recipients', 'is_active', '20', 'schedule_id']) assert.match(cap, new RegExp(w), `schedule_recipients_cap mentions ${w}`);
  assert.match(cap, /RAISE\s+EXCEPTION/i);
  const extra = fnNames(sql).filter((f) => !GUARD_FN.includes(f)); for (const f of extra) assert.ok(OPTIONAL_FN.includes(f), `unexpected function ${f}`);
  assert.doesNotMatch(sql, /SECURITY\s+DEFINER/i, 'C8 has no SECURITY DEFINER function: retention deletes run as the system actor under __delete__tenant (P-18(c)); definer-inventory.yaml gets no analytics row');
});
test('triggers: exports / refresh_runs / report_runs mutable_columns lists equal the §5 table; exports_transition_guard BEFORE UPDATE on exports, schedules_codes_guard BEFORE INSERT OR UPDATE on schedules, schedule_recipients_cap BEFORE INSERT OR UPDATE on schedule_recipients (FOR EACH ROW); no other non-audit trigger; none disabled or dropped', () => {
  const sql = anSql(), trg = createTriggers(sql).filter((s) => !isAudit(s)), byName = new Map(trg.map((s) => [trgName(s), s]));
  const s5 = spec5(), want = {};
  for (const t of MUT_TBL) {
    const row = s5.split('\n').find((l) => l.startsWith(`| \`analytics.${t}\``)); assert.ok(row, `spec §5 row ${t}`);
    const m = /enforce_mutable_columns\(([^)]*)\)/.exec(row); assert.ok(m, `spec §5 mutable list ${t}`);
    want[t] = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).sort();
  }
  assert.deepEqual(want.refresh_runs, ['error_code', 'finished_at', 'rows_written', 'status']);
  assert.deepEqual(want.report_runs, ['omitted_report_codes', 'sent_count', 'skipped_count', 'state']);
  assert.equal(want.exports.length, 13);
  for (const t of MUT_TBL) {
    const s = byName.get(`${t}__mutable_columns`); assert.ok(s, `${t}__mutable_columns missing`);
    assert.match(s, new RegExp(`^CREATE TRIGGER ${t}__mutable_columns BEFORE UPDATE ON analytics\\.${t} FOR EACH ROW EXECUTE FUNCTION app\\.enforce_mutable_columns\\(`, 'i'));
    assert.deepEqual(trgArgs(s, 'app\\.enforce_mutable_columns'), want[t], `analytics.${t}: mutable columns = spec §5`);
    for (const c of want[t]) assert.ok(createTable(sql, `analytics.${t}`).colMap.has(c), `${t}.${c} is a real column`);
  }
  const one = (fn) => { const hit = trg.filter((s) => new RegExp(`EXECUTE\\s+FUNCTION\\s+${esc(fn)}\\(\\s*\\)$`, 'i').test(s)); assert.equal(hit.length, 1, `exactly one trigger runs ${fn}`); return hit[0]; };
  assert.match(one('analytics.exports_transition_guard'), /^CREATE TRIGGER \w+ BEFORE UPDATE\b[^;]*\bON analytics\.exports FOR EACH ROW/i);
  assert.match(one('analytics.schedules_codes_guard'), /^CREATE TRIGGER \w+ BEFORE INSERT OR UPDATE\b[^;]*\bON analytics\.schedules FOR EACH ROW/i, 'must also fire on INSERT (a new schedule with a non-schedulable code is refused)');
  assert.match(one('analytics.schedule_recipients_cap'), /^CREATE TRIGGER \w+ BEFORE INSERT OR UPDATE\b[^;]*\bON analytics\.schedule_recipients FOR EACH ROW/i, 'must fire on INSERT and UPDATE (re-activation counts, D-45)');
  const rest = trg.filter((s) => !/enforce_mutable_columns/i.test(s) && !GUARD_FN.concat(OPTIONAL_FN).some((f) => new RegExp(`EXECUTE\\s+FUNCTION\\s+${esc(f)}\\(`, 'i').test(s)));
  assert.deepEqual(rest, [], 'no trigger beyond 3 mutable_columns + 3 guards (+ the optional refresh_runs transition guard)');
  assert.doesNotMatch(sql, /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(sql, /DROP\s+TRIGGER\b/i);
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x): <t>__audit AFTER INSERT OR UPDATE OR DELETE on schedules and schedule_recipients ONLY (M class, 04 D11); none on R / E / G (derived or ephemeral; export_files content is never logged)', () => {
  const trg = createTriggers(anSql()).filter(isAudit);
  const onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of AUDITED) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(\\s*\\)$`, 'i'), q);
  }
  for (const q of ALLT.filter((x) => !AUDITED.includes(x))) assert.equal(onTable(q).length, 0, `${q} must NOT be audited`);
  assert.equal(trg.length, 2);
});

// ================================================================ DEFINER inventory (none)
test('db/meta/definer-inventory.yaml has no analytics row (C8 adds no SECURITY DEFINER function; 04 D7)', () => {
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  assert.deepEqual(Object.keys(inv).filter((k) => /analytics/i.test(k) || GUARD_FN.concat(OPTIONAL_FN).includes(k)), []);
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYamlSafe = () => { try { return JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables; } catch { return null; } };
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
test('tables.yaml: all 28 C8 tables registered (class G / R / E / M per §1, centre_scoped = the 16 R tables, audited = trigger, retention, no shared_with, phi_class for exactly the migration columns); event_inbox entry untouched', () => {
  const y = tablesYaml(), centre = new Set(expectedPolicies().filter((p) => /current_centre_ids/.test(p.using + p.check)).map((p) => p.table));
  const trgAudited = (q) => createTriggers(anSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of ALLT) {
    const e = y[q]; assert.ok(e, `${q} in tables.yaml`);
    assert.equal(e.class, isG(q) ? 'G' : CLS[q.split('.')[1]], `${q} class (02-CV §5.2, CR-C8-003 for R)`);
    if (q === 'analytics.order_index') assert.equal(typeof e.centre_scoped, 'boolean', 'order_index centre_scoped: §1 says "yes (nullable)" but its policies are system-only without a centre predicate; either value is accepted');
    else assert.equal(e.centre_scoped, centre.has(q), `${q} centre_scoped`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`);
    assert.equal(e.audited, AUDITED.includes(q), `${q} audited per spec §5`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), [...createTable(anSql(), q).colNames.map((c) => c.replace(/"/g, ''))].sort(), `${q} columns = migration columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
    assert.deepEqual([...(e.shared_with ?? [])], [], `${q}: no actor-scoped policies, shared_with empty`);
  }
  assert.equal(centre.size, 16);
  assert.ok(y['analytics.event_inbox'].class === 'A', 'inbox entry remains as C0 wrote it');
  assert.deepEqual(Object.keys(y).filter((k) => /^analytics\./.test(k) && !/\.event_inbox$/.test(k)).sort(), [...ALLT].sort(), 'no extra analytics entry');
});
test('tables.yaml phi_class (§8): export_files.content P2 (the only P2); *_id uuids (centre / branch / referrer / department / test / analyte / instrument / membership / order / subject) P1; *_paisa and counts P0; tat_facts timestamps + subject_id P1; schedules.name / exports.params P1; created_by / updated_by never above P1; nothing P3', () => {
  const y = tablesYaml(), col = (q, c) => { const v = y[`analytics.${q}`].columns[c]; assert.ok(v !== undefined, `${q}.${c} registered`); return v; };
  assert.equal(col('export_files', 'content'), 'P2');
  for (const [q, cs] of Object.entries({ daily_orders: ['branch_id', 'centre_id'], daily_referrer_volume: ['referrer_id', 'centre_id'], daily_collections: ['collected_by_membership_id', 'centre_id'], daily_results: ['department_id', 'test_id', 'processing_branch_id'],
    daily_critical_values: ['analyte_id'], daily_interface_messages: ['instrument_id'], order_index: ['order_id', 'referrer_id', 'centre_id'], tat_facts: ['subject_id', 'centre_id', 'started_at', 'stopped_at'],
    exports: ['requested_by_membership_id', 'params'], schedules: ['name', 'owner_membership_id'], schedule_recipients: ['membership_id'], report_run_recipients: ['membership_id'] })) for (const c of cs) assert.equal(col(q, c), 'P1', `${q}.${c}`);
  for (const q of R_N) for (const c of Object.keys(y[`analytics.${q}`].columns)) if (/_paisa$/.test(c)) assert.equal(col(q, c), 'P0', `${q}.${c} (aggregate money, §8)`);
  for (const [q, cs] of Object.entries({ daily_orders: ['orders_registered', 'patients_distinct', 'new_patients'], daily_interface_messages: ['messages', 'duplicates'], daily_releases: ['released'], daily_rejections: ['rejections'] })) for (const c of cs) assert.equal(col(q, c), 'P0', `${q}.${c}`);
  for (const q of ALLT) for (const [c, p] of Object.entries(y[q].columns)) {
    assert.notEqual(p, 'P3', `${q}.${c}: no P3 column in analytics (no result value / patient data, §8)`);
    if (['created_by', 'updated_by'].includes(c)) assert.ok(['P0', 'P1'].includes(p), `${q}.${c}`);
    if (q !== 'analytics.export_files' || c !== 'content') assert.notEqual(p, 'P2', `${q}.${c}: only export_files.content is P2`);
  }
  for (const q of G_T) for (const c of Object.keys(y[q].columns)) assert.equal(y[q].columns[c], 'P0', `${q}.${c}`);
});
test('tables.yaml: rls_exempt only on the 2 g_cs_* tables (with a reason); mandatory-column exceptions (§1 table, 08 A17 P-18(b)) are listed exactly: refresh_state id/expires_at/version/is_active, dirty_partitions id/expires_at, export_files id, order_index id, g_cs_* id; every class mandatory column a table lacks is listed; each exception is real and carries a reason', () => {
  const y = tablesYaml();
  const MAND = { M: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'is_active'], E: ['id', 'tenant_id', 'created_at', 'expires_at'], R: ['tenant_id', 'refresh_run_id', 'refreshed_at'], G: ['id', 'created_at', 'is_active'] };
  const SPEC_EXC = { refresh_state: ['id', 'expires_at', 'version', 'is_active'], dirty_partitions: ['id', 'expires_at'], export_files: ['id'], order_index: ['id'], g_cs_families: ['id'], g_cs_report_codes: ['id'] };
  for (const q of ALLT) {
    const e = y[q], t = q.split('.')[1], cols = new Set(createTable(anSql(), q).colNames), cls = isG(q) ? 'G' : CLS[t];
    if (isG(q)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    const exc = [...(e.mandatory_column_exceptions ?? [])];
    for (const c of exc) assert.ok(!cols.has(c), `${q}: exception ${c} but the table has that column`);
    for (const c of SPEC_EXC[t] ?? []) assert.ok(exc.includes(c), `${q}: spec §1 exception ${c} not listed`);
    const missing = MAND[cls].filter((c) => !cols.has(c));
    for (const c of missing) assert.ok(exc.includes(c), `${q}: lacks class-${cls} mandatory column ${c} without a listed exception`);
    if (exc.length) assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 5, `${q} needs mandatory_column_exceptions_reason`);
  }
});
test('tables.yaml retention (§1): refresh_state life of tenant; dirty_partitions deleted when processed; refresh_runs 90 d; order_index / exports / report_runs / report_run_recipients 400 d; R tables retentionYears (tat_facts 3 FY, report_backlog replaced every refresh); export_files <= 24 h; schedules / schedule_recipients never deleted; g_* seed', () => {
  const r = (q) => tablesYaml()[`analytics.${q}`].retention;
  assert.match(r('refresh_state'), /life|tenant|never/i); assert.match(r('dirty_partitions'), /processed/i); assert.match(r('refresh_runs'), /90/);
  for (const q of ['order_index', 'exports', 'report_runs', 'report_run_recipients']) assert.match(r(q), /400/, q);
  for (const q of R_N.filter((x) => !['tat_facts', 'report_backlog'].includes(x))) assert.match(r(q), /retentionYears|year/i, q);
  assert.match(r('tat_facts'), /3\s*FY|3 fiscal/i); assert.match(r('report_backlog'), /replaced|refresh/i);
  assert.match(r('export_files'), /24\s*h/i);
  for (const q of ['schedules', 'schedule_recipients']) assert.match(r(q), /never|deactivat/i, q);
  for (const q of G_T) assert.match(tablesYaml()[q].retention, /seed|permanent|never deleted|kept|forever|global/i, q);
});
test('db/tests/rls_exempt.txt lists exactly the two analytics g_cs_* tables, each with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^analytics\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), [...G_T].sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ seeds (§4)
test('seed rows (§4): g_cs_families = the 16 families + internal `_manual` (is_active false, all others true); g_cs_report_codes = the 14 report codes, interfaces is_schedulable false, all others true; INSERTs name their columns; no other INSERT into analytics; no tenant seed data', () => {
  const sql = anSql(), s4 = spec4();
  const famWant = ['orders', 'centre_volume', 'referrer_volume', 'income', 'department_income', 'collections', 'referrer_billing', 'results', 'specimens', 'rejections', 'critical_values', 'tat', 'releases', 'deliveries', 'interface_messages', 'report_backlog', '_manual'];
  const repWant = ['dashboard', 'income', 'department_income', 'collections', 'volume', 'top_referrers', 'top_centres', 'referral_incentive', 'tests_done', 'tat', 'pending_tests', 'quality_indicators', 'delivery', 'interfaces'];
  for (const c of [...famWant, ...repWant]) assert.ok(s4.includes('`' + c + '`'), `spec §4 names ${c}`);   // the lists above are the spec lists
  const lit = (v) => /^'(.*)'$/.exec(v)?.[1];
  const fam = insertRows(sql, 'analytics.g_cs_families'), rep = insertRows(sql, 'analytics.g_cs_report_codes');
  assert.deepEqual(fam.map((r) => lit(r.code)).sort(), [...famWant].sort());
  assert.deepEqual(rep.map((r) => lit(r.code)).sort(), [...repWant].sort());
  for (const r of fam) { const c = lit(r.code); if (c === '_manual') assert.equal(r.is_active?.toLowerCase(), 'false', '_manual is_active = false (never in UI lists)'); else assert.notEqual(r.is_active?.toLowerCase(), 'false', `${c} active`); assert.ok(lit(r.display)?.length > 1, `${c} display`); }
  for (const r of rep) {
    const c = lit(r.code); assert.ok(lit(r.display)?.length > 1, `${c} display`);
    assert.ok('is_schedulable' in r && 'is_exportable' in r, `${c}: is_exportable / is_schedulable given explicitly`);
    assert.equal(r.is_schedulable.toLowerCase(), c === 'interfaces' ? 'false' : 'true', `${c} is_schedulable`);
    assert.doesNotMatch(r.display + c, /commission/i, '04 L19');
  }
  assert.deepEqual([...stmts(sql).map(ws).filter((s) => /^INSERT\s+INTO\b/i.test(s)).map((s) => /INTO\s+(\S+)/i.exec(s)[1])].filter((t, i, a) => a.indexOf(t) === i).sort(), [...G_T].sort(), 'no other INSERT in the analytics migrations');
});

// ================================================================ views: none
test('no views in analytics (IC §6 has no analytics section: C8 only READS other schemas\' v_pub_*); no view / materialised view created; hence no view column contract to check; lims_analytics holds no grant on analytics.* (§3)', () => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8').replace(/\r\n?/g, '\n');
  assert.doesNotMatch(ic, /###\s+6\.\d+\s+`analytics`/, 'IC §6 has no analytics subsection');
  assert.doesNotMatch(anSql(), /CREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\b/i);
  assert.doesNotMatch(anSql() + polSql(), /\blims_analytics\b/);
});

// ================================================================ hygiene
test('C8 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of other schemas\' tables, no USING (true), no GRANT to PUBLIC', () => {
  const raw = anFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 12000, 'C8 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i);
  assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016');
  assert.doesNotMatch(strip(raw), /\bTO\s+PUBLIC\b/i);
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts, check-migrations.ts and check-fk-dag.ts exit 0 on the tree (analytics -> core only; nothing into analytics)', () => {
  assert.ok(anFiles().length >= 1, 'C8 migrations missing');
  for (const t of ['check-registry.ts', 'check-migrations.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 26 tenant C8 tables (incl. the 16 class R: gen-isolation-probes.ts must accept class R, CR-C8-003 / 02-CV §5.2), none for the 2 class G, and gen-isolation-probes --check is clean', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts; class R must be in its CLASSES set)`);
  for (const q of G_T) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/analytics/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-10\.C8_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/analytics/T0B-10.C8_*.test.sql exist (tester-owned: writer must keep them) and cover the AC list by "-- AC-0B-x.y" markers and 14 checks by "-- C8 check N" markers; RLS never disabled in them', () => {
  assert.ok(tapFiles().length >= 2, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 14; n++) assert.match(txt, new RegExp(`-- C8 check ${n}\\b`), `marker for C8 check ${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.2', '6.3']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY|session_replication_role/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
  }
});
