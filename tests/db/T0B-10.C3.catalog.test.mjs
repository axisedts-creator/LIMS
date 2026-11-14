// T0B-10.C3 static checks of the Wave-1 catalog DDL translation: db/migrations/*_catalog__*.sql, db/policies/catalog.sql, db/meta/tables.yaml, v_pub_* views.
// Spec: C3 05-SCHEMA §1-§11 (§5 lifecycle rules, §6 views, §9 RLS, §10 DDL, §10.2 triggers, §10.3 policies/grants/exemptions, §10.4 views, §11 tests); IC §6.6;
// C0 05-SCHEMA §3.8/§10; 08 A10.5, A13 D-19, A17 P-16/P-18; AC-0B-2.1..2.4, 3.6 (probes), 4.1..4.3, 5.x, 6.x (static part).
// Run: node --test tests/db/T0B-10.C3.catalog.test.mjs   (live assertions: db/tests/catalog/T0B-10.C3_*.test.sql, pg_prove; generated probes: db/tests/isolation/catalog.*.test.sql)
// Method (as T0B-05 / T0B-10.C2): the expected DDL is PARSED FROM C3 05-SCHEMA §10 at test time and compared (whitespace/case-normalised) with the migrations,
// so a drifting column, constraint, index, trigger, policy, grant or view fails here. Function bodies of the four catalog.tg_* functions are compared too.
// T0B10C3_ROOT (optional) points the checks at another tree (db/migrations, db/policies, db/meta, db/tests) — used for scratch validation of this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B10C3_ROOT ? resolve(process.env.T0B10C3_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const catFiles = () => files().filter((f) => /^\d{14}_catalog__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const allSql = () => files().map(read).join('\n;\n');
const catSql = () => catFiles().map(read).join('\n;\n');
const polFile = polDir + 'catalog.sql';
const polSql = () => (existsSync(polFile) ? strip(readFileSync(polFile, 'utf8')) : '');
const allPolSql = () => (existsSync(polDir) ? readdirSync(polDir).filter((f) => f.endsWith('.sql')).map((f) => strip(readFileSync(polDir + f, 'utf8'))).join('\n;\n') : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / T0B-10.C2)
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
function createTable(sql, name) {
  const m = new RegExp(`CREATE\\s+(UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name.replace('.', '\\.')}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  const segs = splitTop(balanced(sql, m.index + m[0].length));
  const cons = segs.filter((s) => /^CONSTRAINT\b/i.test(s));
  const cols = segs.filter((s) => !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(s));
  const added = stmts(sql).filter((s) => new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${name.replace('.', '\\.')}\\s+ADD\\s+CONSTRAINT\\b`, 'i').test(ws(s)))
    .map((s) => ws(s).replace(new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${name.replace('.', '\\.')}\\s+ADD\\s+`, 'i'), ''));
  const allCons = [...cons, ...added];
  return {
    cols, cons: allCons, colNames: cols.map((c) => c.split(/\s+/)[0]),
    colMap: new Map(cols.map((c) => [c.split(/\s+/)[0], norm(c)])),
    conMap: new Map(allCons.map((c) => [c.split(/\s+/)[1], norm(c)])),
  };
}
const idxName = (s) => /INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s)[1];
const createIndexes = (sql) => stmts(sql).filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s)).map(ws);
const createTriggers = (sql) => stmts(sql).filter((s) => /^CREATE\s+TRIGGER\b/i.test(s)).map(ws);
const trgName = (s) => /TRIGGER\s+(\w+)/i.exec(s)[1];
function policies(sql) {
  return stmts(sql).filter((s) => /^CREATE\s+POLICY\s+(?!%)/i.test(s)).map((s) => {   // "%I" = dynamic-SQL template inside a DO loop, not a policy
    const m = /^CREATE\s+POLICY\s+(\w+)\s+ON\s+([\w.]+)\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([\w, ]+?)\s+(?=USING|WITH)([\s\S]*)$/i.exec(ws(s));
    assert.ok(m, `parsable policy: ${ws(s).slice(0, 110)}`);
    const rest = m[5], wi = rest.search(/\bWITH\s+CHECK\b/i);
    const using = /^USING/i.test(rest) ? (wi < 0 ? rest : rest.slice(0, wi)).replace(/^\s*USING\s*/i, '').trim() : '';
    const check = wi < 0 ? '' : rest.slice(wi).replace(/^\s*WITH\s+CHECK\s*/i, '').trim();
    const unwrap = (x) => { x = x.trim(); if (x[0] === '(' && balanced(x, 1).length === x.length - 2) return x.slice(1, -1).trim(); return x; };
    return { name: m[1], table: m[2], key: `${m[1]}@${m[2]}`, cmd: m[3].toUpperCase(), roles: m[4].split(',').map((r) => r.trim()).sort().join(','), using: norm(unwrap(using)), check: norm(unwrap(check)), text: ws(s) };
  });
}
function tableGrants(sql) {          // Map "schema.table" -> Map role -> Set(priv); whole-table grants only
  const g = new Map();
  for (const s of stmts(sql)) {
    const m = /^GRANT\s+([A-Z, ]+?)\s+ON\s+(?:TABLE\s+)?([\w., ]+?)\s+TO\s+([\w, ]+?)(\s+WITH\s+GRANT\s+OPTION)?$/i.exec(ws(s));
    if (!m || /\bFUNCTION\b|\bSCHEMA\b|\bSEQUENCE\b/i.test(s)) continue;
    if (/^(EXECUTE|USAGE|CREATE)$/i.test(m[1].trim())) continue;
    for (const t of m[2].split(',').map((x) => x.trim())) for (const r of m[3].split(',').map((x) => x.trim())) {
      if (!g.has(t)) g.set(t, new Map());
      const rm = g.get(t); if (!rm.has(r)) rm.set(r, new Set());
      for (const p of m[1].split(',').map((x) => x.trim().toUpperCase())) rm.get(r).add(p);
    }
  }
  return g;
}
function fnText(sql, qname) {
  const m = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${qname.replace('.', '\\.')}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  const open = /AS\s+(\$\w*\$)/i.exec(sql.slice(m.index));
  if (!open) return null;
  const bodyStart = m.index + open.index + open[0].length;
  const end = sql.indexOf(open[1], bodyStart);
  return end < 0 ? null : sql.slice(m.index, end + open[1].length);
}

// ---------------------------------------------------------------- spec extraction (C3 05-SCHEMA)
const specPath = repo + 'spec/chunks/C3-catalog-pricing/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = s.indexOf(b0, a + a0.length); assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const spec10 = () => strip(sqlBlocks(between(specRaw(), '## 10. DDL', '### 10.1 File references')));          // tables, indexes, 4 triggers, 2 functions
const spec102 = () => strip(sqlBlocks(between(specRaw(), '### 10.2 Lifecycle triggers', '### 10.3 RLS policies')));   // 2 functions, 14 triggers
const spec103 = () => strip(sqlBlocks(between(specRaw(), '### 10.3 RLS policies and grants', '### 10.4 Published views')));   // the DO loop
const spec103Raw = () => between(specRaw(), '### 10.3 RLS policies and grants', '### 10.4 Published views');
const spec104 = () => strip(sqlBlocks(between(specRaw(), '### 10.4 Published views', '## 11. DB tests')));
const arrayOf = (sql, v) => { const m = new RegExp(`${v}\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([^\\]]*)\\]`, 'i').exec(sql); assert.ok(m, `spec array ${v}`); return [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]); };

const G_TABLES = ['g_units', 'g_value_sets', 'g_value_set_values', 'g_tax_types', 'g_reference_release'];
const RW = () => arrayOf(spec103(), 'rw_tables');        // SELECT/INSERT/UPDATE
const RWD = () => arrayOf(spec103(), 'rwd_tables');      // plus DELETE
const TENANT = () => [...RW(), ...RWD()];                // the 38 tenant tables
const ALL43 = () => [...G_TABLES, ...TENANT()];
const NOT_AUDITED = ['files', 'import_issues', 'catalog_state', 'code_counters'];   // §5 rule 6
const AUDITED = () => TENANT().filter((t) => !NOT_AUDITED.includes(t));
const CLASS = (t) => (G_TABLES.includes(t) ? ['G'] : ['files', 'import_issues'].includes(t) ? ['E'] : ['catalog_state', 'code_counters'].includes(t) ? ['E', 'M'] : ['M']);
const PRED = 'tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())';
const VIEWS = ['v_pub_department', 'v_pub_test_directory', 'v_pub_price_list_items', 'v_pub_referrer_directory'];
const CATALOG_FNS = ['tg_revision_monotonic', 'tg_tax_rule_other_type', 'tg_version_status', 'tg_parent_is_draft'];

function expectedPolicies() {   // 08 / §10.3: the DO loop, expanded
  const out = [];
  for (const t of TENANT()) {
    out.push({ name: `${t}__select__tenant`, cmd: 'SELECT', using: norm(PRED), check: '' });
    out.push({ name: `${t}__insert__tenant`, cmd: 'INSERT', using: '', check: norm(PRED) });
    out.push({ name: `${t}__update__tenant`, cmd: 'UPDATE', using: norm(PRED), check: norm(PRED) });
  }
  for (const t of RWD()) out.push({ name: `${t}__delete__tenant`, cmd: 'DELETE', using: norm(PRED), check: '' });
  return out.map((p) => ({ ...p, table: `catalog.${p.name.split('__')[0]}`, roles: 'lims_app', key: `${p.name}@catalog.${p.name.split('__')[0]}` }));
}
// the migration may keep the spec's DO loop instead of literal statements: accept it only when its arrays and its format() strings equal the spec's
function loopForm(sql) {
  const s = ws(sql);
  const have = (v, want) => { const m = new RegExp(`${v}\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([^\\]]*)\\]`, 'i').exec(sql); return m && [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]).join() === want.join(); };
  return have('rw_tables', RW()) && have('rwd_tables', RWD()) && /ALTER TABLE catalog\.%I ENABLE ROW LEVEL SECURITY/i.test(s) && /ALTER TABLE catalog\.%I FORCE ROW LEVEL SECURITY/i.test(s)
    && /GRANT SELECT, INSERT, UPDATE ON catalog\.%I TO lims_app/i.test(s) && /GRANT DELETE ON catalog\.%I TO lims_app/i.test(s);
}

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: §10 yields 43 catalog tables (5 G + 38 tenant), 29+9 policy arrays, 18 triggers, 4 catalog functions, 4 views', () => {
  const ddl = spec10();
  for (const t of ALL43()) assert.ok(createTable(ddl, `catalog.${t}`), `spec has catalog.${t}`);
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+catalog\.(\w+)/gi)].length, 43, '43 CREATE TABLE in §10');
  assert.equal(RW().length, 29); assert.equal(RWD().length, 9); assert.equal(new Set(TENANT()).size, 38);
  assert.equal(expectedPolicies().length, 38 * 3 + 9, '123 policies');
  assert.equal(createTriggers(ddl).length + createTriggers(spec102()).length, 18, '4 (in tables) + 14 (§10.2) triggers');
  for (const f of CATALOG_FNS) assert.ok(fnText(ddl, `catalog.${f}`) ?? fnText(spec102(), `catalog.${f}`), `spec function catalog.${f}`);
  assert.ok(createIndexes(ddl).length >= 40, `indexes in §10: ${createIndexes(ddl).length}`);
  assert.equal([...spec104().matchAll(/CREATE\s+VIEW\s+catalog\.(\w+)/gi)].map((m) => m[1]).join(), VIEWS.join());
  assert.equal(AUDITED().length, 34, '34 audited tables');
});

// ================================================================ files
test('migration files: >= 1 db/migrations/<14 digits>_catalog__<name>.sql after the core tables it references; db/policies/catalog.sql exists; schema not re-created', () => {
  assert.ok(catFiles().length >= 1, 'no db/migrations/*_catalog__*.sql yet (T0B-10.C3 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const coreStamp = all.find((f) => /core__create_branches_and_centres/.test(f))?.slice(0, 14);
  assert.ok(coreStamp, 'core centres migration present');
  for (const f of catFiles()) assert.ok(f.slice(0, 14) > coreStamp, `${f} must sort after core.collection_centres (FK target)`);
  assert.ok(existsSync(polFile), 'db/policies/catalog.sql missing (canonical CREATE POLICY copy, AC-0B-2.3)');
  assert.doesNotMatch(catSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)catalog\b/i, 'schema catalog already exists (T0B-01); CREATE SCHEMA must be IF NOT EXISTS');
});

// ================================================================ tables
for (const t of [...G_TABLES, ...['catalog_state', 'code_counters', 'departments', 'specimen_types', 'containers', 'methods', 'cs_units', 'cs_value_sets', 'cs_value_set_values', 'orderables', 'tests', 'panels',
  'analytes', 'analyte_versions', 'reference_range_sets', 'critical_limit_sets', 'tat_targets', 'comment_codes', 'comment_code_texts', 'doctors', 'credit_parties', 'price_lists', 'price_list_versions',
  'surcharge_rules', 'cs_tax_types', 'tax_rules', 'instrument_code_maps', 'imports', 'exports', 'panel_members', 'test_specimen_types', 'price_list_assignments', 'reference_ranges', 'critical_limits',
  'price_list_items', 'formula_dependencies', 'files', 'import_issues']]) {
  test(`catalog.${t}: columns, constraints (names + text) equal 05-SCHEMA §10`, () => {
    const exp = createTable(spec10(), `catalog.${t}`);
    assert.ok(exp, `spec table ${t}`);
    const got = createTable(catSql(), `catalog.${t}`);
    assert.ok(got, `CREATE TABLE catalog.${t} not found in *_catalog__*.sql`);
    for (const [c, def] of exp.colMap) assert.equal(got.colMap.get(c), def, `catalog.${t}.${c}`);
    assert.deepEqual([...got.colMap.keys()].sort(), [...exp.colMap.keys()].sort(), `catalog.${t} column set`);
    for (const [c, def] of exp.conMap) assert.equal(got.conMap.get(c), def, `catalog.${t} constraint ${c}`);
    assert.deepEqual([...got.conMap.keys()].sort(), [...exp.conMap.keys()].sort(), `catalog.${t} constraint set (no extra, no missing)`);
  });
}
test('no ENUM types (CV §5.1); exactly the 43 §1 tables are created (no catalog.event_inbox: C3 consumes no events); no DEFAULT on id / tenant_id', () => {
  const sql = catSql();
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i);
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?catalog\.(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), ALL43().sort());
  assert.doesNotMatch(sql, /catalog\.event_inbox/i);
  assert.doesNotMatch(allSql(), /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?!catalog\.|identity\.|core\.|audit\.|frontdesk\.|billing\.|lab\.|instruments\.|reporting\.|analytics\.|quality\.|micro\.|anatomic\.|inventory\.|partners\.|smartreport\.|payments\.|engagement\.|homecollection\.)\w+\./i);
  for (const t of ALL43()) for (const c of ['id', 'tenant_id']) {
    const def = createTable(catSql(), `catalog.${t}`)?.colMap.get(c);
    if (def) assert.doesNotMatch(def, /\bdefault\b/, `catalog.${t}.${c} must have no DEFAULT (UUIDv7 in app code, 04 D9)`);
  }
});
test('cross-schema references (01-CM §5 R3): FKs only to catalog.*, core.tenants, core.collection_centres; none to instruments or any downstream schema', () => {
  const targets = new Set([...catSql().matchAll(/REFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  for (const t of targets) assert.ok(/^catalog\./.test(t) || t === 'core.tenants' || t === 'core.collection_centres', `unexpected FK target ${t}`);
  assert.ok(targets.has('core.tenants') && targets.has('core.collection_centres'));
  const imp = createTable(catSql(), 'catalog.imports');
  for (const c of ['upload_file_id', 'report_file_id']) assert.ok(imp.colMap.has(c) && !/references/.test(imp.colMap.get(c)), `${c} is a plain uuid (§10.1)`);
  assert.doesNotMatch(imp.cons.join(' '), /upload_file_id|report_file_id/i, 'no FK/CHECK on the purged file ids');
  assert.doesNotMatch(catSql(), /REFERENCES\s+catalog\.files\b/i, 'no FK to catalog.files from imports/exports');
});
test('indexes: every §10 CREATE INDEX present with identical definition; no extra index', () => {
  const have = new Map(createIndexes(catSql()).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(spec10());
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].sort(), exp.map(idxName).sort(), 'no index beyond the spec (§4 query->index map is complete)');
  for (const n of ['analyte_versions__tenant_id_analyte_id__draft__p_uq', 'price_lists__tenant_id__default__p_uq', 'instrument_code_maps__inbound__p_uq', 'cs_tax_types__tenant_id_code__open__p_uq',
    'tax_rules__tenant_id_scope_key__open__p_uq', 'comment_codes__tenant_id_code_dept__uq', 'imports__dedupe__p_idx']) {
    assert.ok(have.has(n), `index ${n}`);
    if (/__p_uq$|__uq$/.test(n)) assert.match(have.get(n), /unique/);
  }
});

// ================================================================ RLS
test('ENABLE + FORCE ROW LEVEL SECURITY on the 38 tenant tables; none on the 5 g_* tables (AC-0B-2.1, §11 test 13)', () => {
  const sql = catSql(), loop = loopForm(sql);
  for (const t of TENANT()) {
    const lit = (kw) => new RegExp(`ALTER\\s+TABLE\\s+catalog\\.${t}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(sql);
    assert.ok((lit('ENABLE') && lit('FORCE')) || loop, `catalog.${t}: ENABLE and FORCE ROW LEVEL SECURITY (literal statements, or the spec's DO loop with the spec's arrays)`);
  }
  for (const t of G_TABLES) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+catalog\\.${t}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${t} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i, 'RLS is never disabled (AC-0B-2.4)');
});
test('policies: db/policies/catalog.sql holds EXACTLY the 123 §10.3 policies as literal statements (name, command, role, USING, WITH CHECK); no extra policy', () => {
  const got = policies(polSql()).filter((p) => p.table.startsWith('catalog.'));
  assert.ok(got.length > 0, 'db/policies/catalog.sql has no literal CREATE POLICY (C0 expands the loop into explicit statements, §10.3 last line)');
  const byKey = new Map(got.map((p) => [p.key, p]));
  assert.equal(byKey.size, got.length, 'no duplicate policy name per table');
  const exp = expectedPolicies();
  for (const e of exp) {
    const g = byKey.get(e.key);
    assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`);
    assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(g.using, e.using, `${e.key} USING`);
    assert.equal(g.check, e.check, `${e.key} WITH CHECK`);
  }
  assert.deepEqual([...byKey.keys()].sort(), exp.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access; G tables have none)');
});
test('every catalog policy carries is_staff_or_system in USING/WITH CHECK (P-16, CR-C13-011); TO lims_app only; no owner_only policy (C3 has no DEFINER, §10.3 notes); DELETE policy only on rwd tables', () => {
  const ps = policies(polSql()).filter((x) => x.table.startsWith('catalog.'));
  assert.ok(ps.length >= 123, `db/policies/catalog.sql has ${ps.length} catalog policies`);
  for (const p of ps) {
    if (p.cmd !== 'INSERT') assert.match(p.using, /app\.is_staff_or_system\(\)/, `${p.key} USING`);
    if (p.cmd !== 'SELECT' && p.cmd !== 'DELETE') assert.match(p.check, /app\.is_staff_or_system\(\)/, `${p.key} WITH CHECK`);
    if (p.cmd === 'INSERT') assert.match(p.check, /app\.is_staff_or_system\(\)/, `${p.key} WITH CHECK`);
    assert.equal(p.roles, 'lims_app', `${p.key} roles`);
    assert.doesNotMatch(p.name, /__owner_only$|__platform$|__own$/, `${p.key}: C3 has no owner/platform/own policies`);
    assert.doesNotMatch(p.using + p.check, /app\.pre_|app\.maintenance|is_platform_actor/, p.key);
    if (p.cmd === 'DELETE') assert.ok(RWD().includes(p.table.slice(8)), `${p.key}: DELETE policy on a non-rwd table`);
    assert.doesNotMatch(p.using + p.check, /\btrue\b\s*$/i, p.key);
  }
  for (const t of RW()) assert.ok(!ps.some((p) => p.table === `catalog.${t}` && p.cmd === 'DELETE'), `catalog.${t} (master/E-like) has no DELETE policy (§5 rule 3)`);
});
test('policies written literally in migrations are identical to db/policies/catalog.sql (AC-0B-2.3 copy)', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  for (const p of policies(catSql()).filter((x) => x.table.startsWith('catalog.'))) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
});
test('no centre-scoped predicate anywhere in catalog (catalog is tenant-wide master data, §9)', () => {
  assert.doesNotMatch(polSql() + catSql(), /current_centre_ids/i);
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §11 test 2)
test('table grants: SELECT/INSERT/UPDATE (+DELETE on the 9 rwd tables) to lims_app; G tables SELECT only; nothing to other roles; no TRUNCATE/REFERENCES/TRIGGER/ALL', () => {
  const sql = catSql(), g = tableGrants(sql);
  const want = (t) => (G_TABLES.includes(t) ? ['SELECT'] : RWD().includes(t) ? ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] : ['INSERT', 'SELECT', 'UPDATE']);
  const literal = ALL43().every((t) => g.get(`catalog.${t}`)?.has('lims_app'));
  if (literal) {
    for (const t of ALL43()) {
      const rm = g.get(`catalog.${t}`);
      assert.deepEqual([...rm.keys()], ['lims_app'], `catalog.${t} granted to lims_app only`);
      assert.deepEqual([...rm.get('lims_app')].sort(), want(t), `catalog.${t} privileges`);
    }
  } else {
    assert.ok(loopForm(sql), 'grants must be literal statements for all 43 tables or the spec DO loop (arrays + GRANT format strings unchanged)');
    for (const t of G_TABLES) assert.deepEqual([...(g.get(`catalog.${t}`)?.get('lims_app') ?? [])].sort(), ['SELECT'], `catalog.${t} SELECT`);
  }
  for (const [t, rm] of g) if (t.startsWith('catalog.')) for (const [r, ps] of rm) {
    assert.equal(r, 'lims_app', `${t}: grant to ${r}`);
    for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!ps.has(bad), `${t} ${r} must not hold ${bad}`);
    if (RW().includes(t.slice(8)) || G_TABLES.includes(t.slice(8))) assert.ok(!ps.has('DELETE'), `${t}: no DELETE on master / G tables (§5 rule 3)`);
  }
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\bcatalog\./i);
  assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+catalog\b/i);
  assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*catalog/i);
  assert.doesNotMatch(sql, /GRANT\s+(INSERT|UPDATE|DELETE)[^;]*\bON\b[^;]*\bcatalog\.g_/i, 'G tables are read-only for lims_app');
  assert.doesNotMatch(sql, /GRANT\s*[A-Z, ]*\(\s*\w+/i, 'no column-level grants in catalog');
});
test('no GRANT on catalog objects to PUBLIC, anon, authenticated, service_role; schema USAGE only to lims_app', () => {
  for (const s of stmts(catSql()).map(ws)) {
    if (/^GRANT\b/i.test(s) && /\bcatalog\./i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role)\b/i, s);
    if (/^GRANT\s+USAGE\s+ON\s+SCHEMA\s+catalog\b/i.test(s)) assert.match(s, /\bTO\s+lims_app\s*$/i, s);
  }
});

// ================================================================ triggers + functions (§5, §10.2; AC-0B-4.1; §11 tests 3, 5, 8, 10, 11, 12)
test('the four catalog.tg_* functions equal the spec (SECURITY INVOKER, search_path pinned) and are the only functions created in schema catalog; C3 has no DEFINER and no app.* function', () => {
  const sql = catSql(), specAll = spec10() + '\n;\n' + spec102();
  for (const f of CATALOG_FNS) {
    const got = fnText(sql, `catalog.${f}`), exp = fnText(specAll, `catalog.${f}`);
    assert.ok(got, `catalog.${f} missing`); assert.equal(norm(got), norm(exp), `catalog.${f} body`);
    assert.doesNotMatch(got, /SECURITY\s+DEFINER/i);
    assert.match(got, /SET\s+search_path\s*=\s*''/i);
  }
  const made = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase());
  assert.deepEqual(made.sort(), CATALOG_FNS.map((f) => `catalog.${f}`).sort(), 'no other function (a DEFINER here would need an inventory entry + owner policies)');
  assert.doesNotMatch(sql, /SECURITY\s+DEFINER/i);
  assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+app\./i);
  const inv = readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8');
  assert.doesNotMatch(inv, /"catalog\./, 'no catalog function in the DEFINER inventory');
});
test('triggers: the 18 lifecycle triggers of §10 / §10.2 are present and equal the spec; no other non-audit trigger on catalog tables', () => {
  const have = new Map(createTriggers(catSql()).filter((s) => !/app\.tg_row_audit\(\)/i.test(s)).map((s) => [trgName(s), norm(s)]));
  const exp = [...createTriggers(spec10()), ...createTriggers(spec102())];
  assert.equal(exp.length, 18);
  for (const s of exp) assert.equal(have.get(trgName(s)), norm(s), `trigger ${trgName(s)}`);
  assert.deepEqual([...have.keys()].sort(), exp.map(trgName).sort(), 'no trigger beyond the spec');
});
test('immutability (AC-0B-4.1, §5): versioned tables carry __status + __mutable_columns (WHEN OLD.status <> draft); children carry __parent_draft; money rules / tax types / comment texts / catalog_state are guarded', () => {
  const trg = createTriggers(catSql());
  const one = (name) => { const hit = trg.filter((s) => trgName(s) === name); assert.equal(hit.length, 1, `trigger ${name}`); return hit[0]; };
  for (const t of ['analyte_versions', 'reference_range_sets', 'critical_limit_sets', 'price_list_versions']) {
    assert.match(one(`${t}__status`), new RegExp(`BEFORE UPDATE ON catalog\\.${t} FOR EACH ROW EXECUTE FUNCTION catalog\\.tg_version_status\\(\\)`, 'i'));
    const m = one(`${t}__mutable_columns`);
    assert.match(m, new RegExp(`BEFORE UPDATE ON catalog\\.${t} FOR EACH ROW WHEN \\(OLD\\.status <> 'draft'\\) EXECUTE FUNCTION app\\.enforce_mutable_columns\\('status', ?'effective_to', ?'updated_at', ?'updated_by', ?'version'\\)`, 'i'));
  }
  for (const [t, p, fk] of [['reference_ranges', 'reference_range_sets', 'set_id'], ['critical_limits', 'critical_limit_sets', 'set_id'], ['price_list_items', 'price_list_versions', 'price_list_version_id'],
    ['formula_dependencies', 'analyte_versions', 'analyte_version_id']]) {
    assert.match(one(`${t}__parent_draft`), new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON catalog\\.${t} FOR EACH ROW EXECUTE FUNCTION catalog\\.tg_parent_is_draft\\('${p}', ?'${fk}'\\)`, 'i'));
  }
  assert.match(one('surcharge_rules__mutable_columns'), /enforce_mutable_columns\('effective_to', ?'is_active', ?'updated_at', ?'updated_by', ?'version'\)/i);
  assert.match(one('tax_rules__mutable_columns'), /enforce_mutable_columns\('effective_to', ?'is_active', ?'updated_at', ?'updated_by', ?'version'\)/i);
  assert.match(one('comment_code_texts__mutable_columns'), /enforce_mutable_columns\('effective_to', ?'updated_at', ?'updated_by', ?'version'\)/i);
  assert.match(one('cs_tax_types__mutable_columns'), /enforce_mutable_columns\('display', ?'sort_order', ?'is_active', ?'effective_to', ?'updated_at', ?'updated_by', ?'version'\)/i);
  assert.match(one('catalog_state__monotonic'), /BEFORE UPDATE ON catalog\.catalog_state FOR EACH ROW EXECUTE FUNCTION catalog\.tg_revision_monotonic\(\)/i);
  assert.match(one('tax_rules__other_type'), /BEFORE INSERT OR UPDATE OF other_tax_code ON catalog\.tax_rules FOR EACH ROW EXECUTE FUNCTION catalog\.tg_tax_rule_other_type\(\)/i);
  // no trigger may be disabled or dropped, and no DELETE-allowing shortcut for versioned/rule tables
  assert.doesNotMatch(catSql(), /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i);
  assert.doesNotMatch(catSql(), /DROP\s+TRIGGER\b/i);
});
test('audit triggers (app.tg_row_audit) on exactly the 34 audited catalog tables; none on files / import_issues / catalog_state / code_counters / g_* (§5 rule 6)', () => {
  const trg = createTriggers(catSql()).filter((s) => /app\.tg_row_audit\(\)/i.test(s));
  const onTable = (t) => trg.filter((s) => new RegExp(`\\bON\\s+catalog\\.${t}\\b`, 'i').test(s));
  for (const t of AUDITED()) {
    const hit = onTable(t);
    assert.equal(hit.length, 1, `catalog.${t} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${t}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+catalog\\.${t}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(\\)`, 'i'));
  }
  for (const t of [...NOT_AUDITED, ...G_TABLES]) assert.equal(onTable(t).length, 0, `catalog.${t} must NOT be audited`);
  assert.equal(trg.length, 34);
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const EXEMPT_ROWS = () => {   // §10.3 notes: | `table`[, `table`] | `col`, `col` | reason |
  const out = new Map();
  for (const m of spec103Raw().matchAll(/^\|\s*((?:`\w+`(?:,\s*)?)+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm)) {
    const cols = [...m[2].matchAll(/`(\w+)`/g)].map((x) => x[1]);
    for (const t of [...m[1].matchAll(/`(\w+)`/g)].map((x) => x[1])) if (TENANT().includes(t)) out.set(t, cols);
  }
  return out;
};
test('tables.yaml: 43 catalog tables registered with class, centre_scoped=false, audited, retention, phi_class per column = DDL columns (REQ-SEC-004)', () => {
  const y = tablesYaml();
  for (const t of ALL43()) {
    const e = y[`catalog.${t}`]; assert.ok(e, `catalog.${t} in tables.yaml`);
    assert.ok(CLASS(t).includes(e.class), `catalog.${t} class ${e.class} not in ${CLASS(t)}`);
    assert.equal(e.centre_scoped, false, `catalog.${t} centre_scoped`);
    assert.equal(e.audited, AUDITED().includes(t), `catalog.${t} audited`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `catalog.${t} retention`);
    const cols = createTable(spec10(), `catalog.${t}`).colNames;
    assert.deepEqual(Object.keys(e.columns).sort(), [...cols].sort(), `catalog.${t} columns = DDL columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `catalog.${t}.${c} phi_class`);
  }
  assert.ok(!y['catalog.event_inbox'], 'no catalog inbox (08 A31.4)');
  assert.deepEqual(Object.keys(y).filter((k) => k.startsWith('catalog.')).sort(), ALL43().map((t) => `catalog.${t}`).sort(), 'no extra catalog entry');
});
test('tables.yaml phi_class (§3): doctor / credit-party personal columns and files.content are P2; created_by / updated_by P1; no P3 anywhere in catalog', () => {
  const y = tablesYaml();
  const P2 = { doctors: ['display_name', 'qualification', 'registration_no', 'phone_e164', 'email', 'notes'], credit_parties: ['contact_phone_e164', 'contact_email', 'pan', 'billing_address'], files: ['content'] };
  for (const [t, cs] of Object.entries(P2)) for (const c of cs) assert.equal(y[`catalog.${t}`].columns[c], 'P2', `catalog.${t}.${c} is P2`);
  for (const t of ALL43()) for (const [c, p] of Object.entries(y[`catalog.${t}`].columns)) {
    assert.notEqual(p, 'P3', `catalog.${t}.${c}: no patient data in catalog`);
    if (c === 'created_by' || c === 'updated_by') assert.equal(p, 'P1', `catalog.${t}.${c}`);
  }
  for (const t of ['departments', 'orderables', 'price_list_items', 'tax_rules', 'imports']) for (const [c, p] of Object.entries(y[`catalog.${t}`].columns)) {
    if (!['created_by', 'updated_by', 'version', 'is_active', 'created_at', 'updated_at', 'id', 'tenant_id'].includes(c)) assert.equal(p, 'P0', `catalog.${t}.${c}`);
  }
});
test('tables.yaml: shared_with empty everywhere (no catalog table is shared with partner/portal/patient, CR-C13-011); rls_exempt only on g_*; mandatory-column exceptions = §10.3 note table', () => {
  const y = tablesYaml(), exempt = EXEMPT_ROWS();
  assert.ok(exempt.size >= 8, `exemption rows parsed from the spec: ${[...exempt.keys()].join()}`);
  for (const t of ALL43()) {
    const e = y[`catalog.${t}`]; assert.ok(e, t);
    assert.deepEqual(e.shared_with ?? [], [], `${t} must not be shared`);
    if (G_TABLES.includes(t)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${t} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${t} must not be rls_exempt`);
    const got = [...(e.mandatory_column_exceptions ?? [])].sort(), want = [...(exempt.get(t) ?? [])].sort();
    assert.deepEqual(got, want, `catalog.${t} mandatory_column_exceptions (C0 lists each exemption with the reason given in §10.3)`);
    if (want.length) assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 5, `catalog.${t} needs mandatory_column_exceptions_reason`);
  }
});
test('tables.yaml retention (§7): files / import_issues cite expires_at and catalog.purge_files; masters and rules "never deleted"', () => {
  const y = tablesYaml();
  assert.match(y['catalog.files'].retention, /expires_at/); assert.match(y['catalog.import_issues'].retention, /expires_at/);
  assert.match(y['catalog.files'].retention + y['catalog.import_issues'].retention, /purge_files/);
  for (const t of ['departments', 'orderables', 'analyte_versions', 'price_list_versions', 'doctors', 'credit_parties', 'tax_rules']) assert.match(y[`catalog.${t}`].retention, /forever|never deleted|kept/i, t);
});
test('db/tests/rls_exempt.txt lists the five catalog.g_* tables with a reason, and nothing else from catalog (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => l.startsWith('catalog.'));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), G_TABLES.map((t) => `catalog.${t}`).sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ views (C3 publishes 4: IC §6.6, C3 §6, §10.4; AC-0B-6.x view column contract test)
const colsOfSelect = (sql) => {
  const m = /\bSELECT\s+([\s\S]+?)\s+FROM\b/i.exec(sql); assert.ok(m, 'view SELECT list');
  return splitTop(m[1]).map((item) => { const a = /\bAS\s+(\w+)\s*$/i.exec(item.trim()); return a ? a[1] : item.trim().split('.').pop().replace(/\W/g, ''); });
};
const viewSql = (sql, v) => { const s = stmts(sql).find((x) => new RegExp(`^CREATE\\s+(OR\\s+REPLACE\\s+)?VIEW\\s+catalog\\.${v}\\b`, 'i').test(ws(x))); return s ? ws(s) : null; };
const icCols = (v) => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8').replace(/\r\n?/g, '\n');
  const sec = ic.slice(ic.indexOf('### 6.6 `catalog`'), ic.indexOf('\n### 6.7', ic.indexOf('### 6.6 `catalog`')) > 0 ? ic.indexOf('\n### 6.7', ic.indexOf('### 6.6 `catalog`')) : ic.indexOf('\n## 7.', ic.indexOf('### 6.6 `catalog`')));
  const row = sec.split('\n').find((l) => l.startsWith(`| \`catalog.${v}\``)); assert.ok(row, `IC §6.6 row for ${v}`);
  return splitTop(row.split('|')[2]).map((c) => /^\s*`?(\w+)/.exec(c)[1]);
};
const c6Cols = (v) => {
  const row = specRaw().split('\n').find((l) => l.startsWith(`| \`catalog.${v}\``)); assert.ok(row, `C3 §6 row for ${v}`);
  return splitTop(row.split('|')[2].replace(/\*\*\+[^|]*$/, '').replace(/\*\*\+.*$/, '').replace(/\s*\+\s*\*\*.*$/, '')).map((c) => /^\s*`?(\w+)/.exec(c)[1]);
};
test('view column contract vs IC §6.6: each v_pub_* view has exactly the IC columns in IC order (spec §6, §10.4 and the migration agree)', () => {
  for (const v of VIEWS) {
    const ic = icCols(v), specSel = colsOfSelect(viewSql(spec104(), v)), got = viewSql(catSql(), v);
    assert.ok(got, `CREATE VIEW catalog.${v} missing from *_catalog__*.sql`);
    assert.deepEqual(specSel, ic, `${v}: C3 05-SCHEMA §10.4 vs IC §6.6`);
    assert.deepEqual(colsOfSelect(got), ic, `${v}: migration columns (names + order) vs IC §6.6`);
    assert.deepEqual(c6Cols(v).slice(0, 4), ic.slice(0, 4), `${v}: C3 §6 table starts with the IC columns`);
  }
  assert.deepEqual(icCols('v_pub_price_list_items').slice(-1), ['falls_through'], 'D-19 appended column');
  assert.deepEqual(icCols('v_pub_referrer_directory').slice(-1), ['canonical_referrer_id'], 'CR-C3-004 appended column');
});
test('views: definitions equal §10.4 (incl. the D-19 predicate), WITH (security_invoker = true), SELECT granted to lims_app only; no other view / materialised view in catalog; no contact columns exposed', () => {
  const sql = catSql(), exp = spec104();
  for (const v of VIEWS) {
    const got = viewSql(sql, v);
    assert.equal(norm(got), norm(viewSql(exp, v)), v);
    assert.match(got, /WITH\s*\(\s*security_invoker\s*=\s*(true|on)\s*\)/i, `${v} security_invoker`);
  }
  assert.deepEqual([...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\s+catalog\.(\w+)/gi)].map((m) => `${m[1] ? 'M:' : ''}${m[2]}`).sort(), [...VIEWS].sort());
  const g = tableGrants(sql);
  for (const v of VIEWS) { const rm = g.get(`catalog.${v}`); assert.ok(rm, `GRANT on catalog.${v}`); assert.deepEqual([...rm.keys()], ['lims_app']); assert.deepEqual([...rm.get('lims_app')], ['SELECT']); }
  assert.match(viewSql(sql, 'v_pub_price_list_items'), /v\.status IN \('published', ?'superseded'\) AND l\.is_active/i, 'only published/superseded versions of ACTIVE lists (08 A13 D-19)');
  for (const v of VIEWS) assert.doesNotMatch(viewSql(sql, v), /\b(phone_e164|email|registration_no|qualification|notes|pan|contact_|billing_address|content)\b/i, `${v} exposes no contact/PII column`);
});

// ================================================================ hygiene
test('catalog migrations: no secrets/real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of C0 tables, no dynamic SQL without %I', () => {
  const raw = catFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i);
  assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity)\./i, 'C3 migrations do not alter C0/C2 tables');
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\bformat\s*\([^)]*%s[^)]*catalog\.%s/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016');
  assert.doesNotMatch(raw, /\bINSERT\s+INTO\s+catalog\.g_/i, 'g_* seed rows belong to db/seeds (C3 §8), not to DDL migrations');
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts, check-migrations.ts and check-fk-dag.ts exit 0 on the tree (catalog -> core/audit/identity only)', () => {
  assert.ok(catFiles().length >= 1, 'catalog migrations missing');
  for (const t of ['check-registry.ts', 'check-migrations.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 38 tenant catalog tables, none for the 5 class G, and gen-isolation-probes --check is clean', () => {
  for (const t of TENANT()) assert.ok(existsSync(root + `db/tests/isolation/catalog.${t}.test.sql`), `db/tests/isolation/catalog.${t}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const t of G_TABLES) assert.ok(!existsSync(root + `db/tests/isolation/catalog.${t}.test.sql`), `class G ${t} has no probe`);
  assert.ok(!existsSync(root + 'db/tests/isolation/catalog.event_inbox.test.sql'), 'no catalog inbox probe');
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const t of ALL43()) assert.match(reg, new RegExp(`'catalog\\.${t}'`), `_registry.sql lists catalog.${t}`);
});

// ================================================================ pgTAP suites present and complete
const T = root + 'db/tests/catalog/';
const tapFiles = () => (existsSync(T) ? readdirSync(T).filter((f) => /^T0B-10\.C3_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/catalog/T0B-10.C3_*.test.sql exist and cover every C3 05-SCHEMA §11 test (1-13) by a "-- §11 test N" marker; RLS never disabled in them', () => {
  assert.ok(tapFiles().length >= 2, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(T + f, 'utf8')).join('\n');
  for (let n = 1; n <= 13; n++) assert.match(txt, new RegExp(`-- §11 test ${n}\\b`), `marker for §11 test ${n}`);
  for (const f of tapFiles()) {
    const s = readFileSync(T + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY|session_replication_role/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
  }
});
