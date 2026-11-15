// T0B-13.C9 static checks of the Wave-2 quality DDL translation: db/migrations/*_quality__*.sql, db/policies/quality.sql, db/meta/tables.yaml, v_pub_qc_summary, 5 guard triggers + 3 functions, 14 audit triggers.
// Spec: C9 05-SCHEMA §1-§9 (§2 value lists + seeds, §3 indexes, §4 immutability, §5 RLS + grants, §6 view, §8 DDL); IC §6.7; C0 05-SCHEMA §3.8 (audit default: every class M/C/B table), §9, §10; 02-CV §5.2/§5.3;
// 08 A16.1 (::uuid[] cast), A17 P-16 (staff guard), P-18 (class follows write path; purge path); LD-202 (translate exactly, no redesign, a gap = blocking CR).
// AC-0B-2.1..2.4, 3.6 (probes), 4.1..4.3, 5.x (audit triggers), 6.1..6.3 (static part: order, role switch, FK direction), view column contract vs IC §6.7. AC-0B-6.4 is billing-only (T0B-11) and does not apply to quality.
// Run: node --test tests/db/T0B-13.C9.quality.test.mjs   (live: db/tests/quality/T0B-13.C9_*.test.sql via pg_prove; generated probes: db/tests/isolation/quality.*.test.sql)
// Method (as T0B-10.C2..C8): the expected DDL is PARSED FROM C9 05-SCHEMA §8 at test time and compared (whitespace/case-normalised) with the migrations. What the spec only describes in prose (grants §5, policy
// templates §5, seeds §2, audit default) is rebuilt here from the spec's own text and the rebuilt text is itself checked against the spec in the sanity test.
// T0B13C9_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B13C9_ROOT ? resolve(process.env.T0B13C9_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const qFiles = () => files().filter((f) => /^\d{14}_quality__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const qSql = () => qFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'quality.sql') ? strip(readFileSync(polDir + 'quality.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C8)
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
// explicit table (cols + constraints, incl. constraints added by ALTER TABLE ... ADD CONSTRAINT a, ADD CONSTRAINT b) or a LIKE ... INCLUDING ALL table (like = base name)
function createTable(sql, name) {
  const m = new RegExp(`CREATE\\s+(UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${esc(name)}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  const segs = splitTop(balanced(sql, m.index + m[0].length));
  const cons = segs.filter((s) => /^CONSTRAINT\b/i.test(s));
  const cols = segs.filter((s) => !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(s));
  const added = [];
  for (const s of stmts(sql).map(ws)) {
    const a = new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${esc(name)}\\s+(ADD\\s+CONSTRAINT\\b[\\s\\S]*)$`, 'i').exec(s);
    if (a) for (const part of splitTop(a[1])) added.push(part.replace(/^ADD\s+/i, ''));
  }
  const allCons = [...cons, ...added];
  const like = cols.length === 1 && cons.length === 0 ? /^LIKE\s+([\w.]+)\s+INCLUDING\s+ALL$/i.exec(ws(cols[0])) : null;
  const nameOf = (c) => c.split(/\s+/)[0];
  return { like: like ? like[1].toLowerCase() : null, cols, cons: allCons, colNames: cols.map(nameOf),
    colMap: new Map(cols.map((c) => [nameOf(c), norm(c)])), conMap: new Map(allCons.map((c) => [c.split(/\s+/)[1], norm(c)])) };
}
// spec model of a table: a LIKE table = its base with the table-name prefix of every constraint renamed (spec: "C0 renames the copied constraints; adds FK cs_exclusion_reasons__tenant__fk")
function specTable(sql, name) {
  const t = createTable(sql, name); if (!t) return null;
  if (!t.like) return t;
  const base = createTable(sql, t.like); assert.ok(base, `LIKE base ${t.like}`);
  const bn = t.like.split('.')[1], tn = name.split('.')[1];
  const conMap = new Map([...base.conMap].map(([k, v]) => [k.replace(bn + '__', tn + '__'), v.split(bn + '__').join(tn + '__')]));
  return { like: t.like, cols: base.cols, colNames: base.colNames, colMap: base.colMap, cons: base.cons, conMap };
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

// ---------------------------------------------------------------- spec extraction (C9 05-SCHEMA)
const specPath = repo + 'spec/chunks/C9-quality-engine/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = b0 ? s.indexOf(b0, a + a0.length) : s.length; assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const S1 = '## 1. Table inventory', S2 = '## 2. Coded sets', S3 = '## 3. Indexes', S4 = '## 4. Immutability', S5 = '## 5. RLS', S6 = '## 6. Published view', S7 = '## 7. Retention', S8 = '## 8. DDL', S9 = '## 9. Seed data';
const specDdl = () => strip(sqlBlocks(between(specRaw(), S8, S9)));
const spec1 = () => between(specRaw(), S1, S2);
const spec2 = () => between(specRaw(), S2, S3);
const spec3 = () => between(specRaw(), S3, S4);
const spec5 = () => between(specRaw(), S5, S6);

// ---------------------------------------------------------------- the 25 tables
const G_N = ['g_cs_corrective_actions', 'g_cs_exclusion_reasons'];
const CLS = { settings: 'M', cs_corrective_actions: 'M', cs_exclusion_reasons: 'M', control_materials: 'M', control_levels: 'M', control_lots: 'M', control_id_maps: 'M', qc_plans: 'M', qc_plan_versions: 'M', qc_targets: 'M',
  qc_runs: 'C', qc_observations: 'C', qc_corrective_actions: 'A', qc_run_reviews: 'A', qc_activity: 'E', sync_state: 'E', autoverify_rule_sets: 'M', autoverify_versions: 'M', autoverify_decisions: 'A', verification_log: 'A',
  tat_items: 'E', tat_alert_events: 'A', tat_alert_acks: 'A' };
const T_N = Object.keys(CLS);                                                       // 23 tenant tables (event_inbox exists from T0B-05)
const G_T = G_N.map((t) => `quality.${t}`), TENANT = T_N.map((t) => `quality.${t}`), ALLT = [...G_T, ...TENANT];   // 25 new tables
const isG = (q) => /\.g_/.test(q);
const CENTRE_N = ['tat_items', 'tat_alert_events', 'tat_alert_acks'], CENTRE_T = CENTRE_N.map((t) => `quality.${t}`);
const NO_UPDATE_N = ['qc_plan_versions', 'qc_corrective_actions', 'qc_run_reviews', 'autoverify_decisions', 'verification_log', 'tat_alert_events', 'tat_alert_acks'];   // §5: INSERT + SELECT only
const UPD_N = T_N.filter((t) => !NO_UPDATE_N.includes(t));                         // 16: M (except qc_plan_versions), C, E tables (incl. tat_items)
const AUDITED = T_N.filter((t) => ['M', 'C'].includes(CLS[t])).map((t) => `quality.${t}`);   // C0 §3.8 default: every class M / C / B table is audited; C9 declares no other rule
const TRG_FN = ['quality.enforce_version_frozen', 'quality.enforce_run_frozen', 'quality.enforce_observation_exclusion'];
const NON_AUDIT_TRG = ['qc_targets__mutable_columns', 'qc_observations__mutable_columns', 'qc_runs__frozen', 'qc_observations__exclusion', 'autoverify_versions__frozen'];
const VIEW = 'quality.v_pub_qc_summary';

// ---- expected policies: spec §5 templates (tenant variant, centre variant, tat_items delete) applied to the tables §5 assigns them to
const GUARD = '(SELECT app.is_staff_or_system())';
const TEN = `tenant_id = (SELECT app.current_tenant_id()) AND ${GUARD}`;
const CEN = `${TEN} AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))`;
const DEL = `tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now()`;
function expectedPolicies() {
  const out = [];
  const add = (tbl, cmd, scope, using, check) => {
    let s = `CREATE POLICY ${tbl}__${cmd.toLowerCase()}__${scope} ON quality.${tbl} FOR ${cmd} TO lims_app`;
    if (using) s += ` USING (${using})`; if (check) s += ` WITH CHECK (${check})`;
    out.push(...policies(s));
  };
  for (const t of T_N) {
    const c = CENTRE_N.includes(t), scope = c ? 'tenant_centre' : 'tenant', P = c ? CEN : TEN;
    add(t, 'SELECT', scope, P); add(t, 'INSERT', scope, null, P);
    if (UPD_N.includes(t)) add(t, 'UPDATE', scope, P, P);
  }
  add('tat_items', 'DELETE', 'tenant', DEL);
  return out;
}
const EXPECTED_POLICY_COUNT = 63;                 // 20 non-centre tenant tables x (select + insert) + 15 updates + tat_items (select, insert, update, delete) + events (2) + acks (2)
const STAFF = /\(select app\.is_staff_or_system\(\)\)/;
// Spec/gate conflict (as C5..C8 pred_c): the spec's tat_items__delete__tenant has no staff guard, but check-registry (P-16, gate 9) demands it on every policy of a table that is not shared_with.
// Policy comparison is therefore modulo that one conjunct; the shape test demands it on every policy incl. the purge DELETE.
const noGuard = (x) => x.replace(/and\(select app\.is_staff_or_system\(\)\)/g, '').replace(/\(select app\.is_staff_or_system\(\)\)and/g, '');

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 25 CREATE TABLE in §8 (2 G + 23 tenant; no event_inbox), 2 LIKE tables, 26 indexes, 5 non-audit triggers, 3 functions, 1 view, 63 expected policies whose templates equal the spec §5 text, no DEFINER', () => {
  const ddl = specDdl();
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 25, '25 CREATE TABLE in §8');
  for (const q of ALLT) assert.ok(createTable(ddl, q), `spec has ${q}`);
  assert.doesNotMatch(ddl, /CREATE\s+TABLE\s+quality\.event_inbox/i);
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+\w+\.\w+\s*\(\s*LIKE/gi)].length, 2, '2 LIKE tables (g_cs_exclusion_reasons, cs_exclusion_reasons)');
  assert.equal(createIndexes(ddl).length, 26, `spec indexes: ${createIndexes(ddl).length}`);
  assert.deepEqual(createTriggers(ddl).map(trgName).sort(), [...NON_AUDIT_TRG].sort());
  assert.deepEqual(fnNames(ddl).sort(), [...TRG_FN].sort());
  assert.equal([...ddl.matchAll(/CREATE\s+VIEW\s+(\w+\.\w+)/gi)].length, 1);
  assert.doesNotMatch(ddl, /SECURITY\s+DEFINER/i);
  assert.equal(TENANT.length, 23);
  const ps = expectedPolicies();
  assert.equal(new Set(ps.map((p) => p.key)).size, ps.length); assert.equal(ps.length, EXPECTED_POLICY_COUNT, `expected policies: ${ps.length}`);
  const s5 = norm(spec5());   // the templates used here are the spec's own text
  for (const t of [TEN, CEN, DEL]) assert.ok(s5.includes(norm(t).replace(/^\(|\)$/g, '')) || s5.includes(norm(t)), `spec §5 contains template: ${t.slice(0, 60)}`);
  assert.ok(s5.includes(norm('((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))')));
  const refs = new Set([...ddl.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  assert.deepEqual([...refs].sort(), ['catalog.analytes', 'catalog.departments', 'catalog.tests', 'core.collection_centres', 'core.tenants', 'frontdesk.order_items', 'frontdesk.orders', 'instruments.instruments', 'lab.qc_results', 'lab.results', 'lab.specimens',
    'quality.autoverify_rule_sets', 'quality.autoverify_versions', 'quality.control_levels', 'quality.control_lots', 'quality.control_materials', 'quality.qc_plan_versions', 'quality.qc_plans', 'quality.qc_runs', 'quality.qc_targets', 'quality.tat_items'], '§1 cross-schema FK list');
  for (const row of spec1().split('\n').filter((l) => /^\| `quality\.\w+` \|/.test(l))) { const t = /`quality\.(\w+)`/.exec(row)[1]; assert.ok(t === 'event_inbox' || T_N.includes(t) || G_N.includes(t), `§1 row ${t}`); }
});

// ================================================================ files, order, owner (AC-0B-6.1 / 6.3)
test('migration files: >= 1 *_quality__*.sql, timestamps strictly after 20261114120000 (LD-202: the cloud DB already has migrations up to it) and after every existing migration, unique; db/policies/quality.sql exists; schema creation IF NOT EXISTS', () => {
  assert.ok(qFiles().length >= 1, 'no db/migrations/*_quality__*.sql yet (T0B-13.C9 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => !/_quality__/.test(f) && !/_(micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection|migration_staging)__/.test(f));
  assert.ok(earlier.length >= 24, 'wave-1 migrations present');
  for (const f of qFiles()) { assert.ok(f.slice(0, 14) > '20261114120000', `${f} must be later than 20261114120000`); for (const e of earlier) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (quality follows analytics in the DAG, C0 05-SCHEMA l.402)`); }
  assert.ok(existsSync(polDir + 'quality.sql'), 'db/policies/quality.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(qSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)quality\b/i, 'schema quality exists since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every quality migration is SET LOCAL ROLE lims_owner and it is the only role switch (all objects owned by lims_owner); no standing CREATE grant, no role DDL', () => {
  assert.ok(qFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+|SET\s+SESSION\s+AUTHORIZATION)/gi)].map((m) => ws(m[1]).toUpperCase());
  for (const f of qFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch`);
  }
  assert.doesNotMatch(qSql(), /GRANT\s+CREATE\s+ON\s+(SCHEMA\s+app|DATABASE)/i); assert.doesNotMatch(qSql(), /CREATE\s+ROLE|ALTER\s+ROLE/i);
});

// ================================================================ tables (columns + constraints = spec exactly; only UNIQUE (tenant_id, id) may be added)
for (const q of ALLT) {
  test(`${q}: every spec column + constraint (name + text) present identically in the migration; no extra column; only UNIQUE (tenant_id, id) may be added (05-SCHEMA §8; C0 §9 rule 1); LIKE tables renamed per spec`, () => {
    const exp = specTable(specDdl(), q); assert.ok(exp, `spec table ${q}`);
    const sql = qSql(), got = createTable(sql, q);
    assert.ok(got, `CREATE TABLE ${q} not found in *_quality__*.sql`);
    if (got.like) {            // LIKE ... INCLUDING ALL form: same base as the spec; every expected constraint name is renamed / re-added; the re-added tenant FK equals the spec text
      assert.equal(got.like, exp.like, `${q}: LIKE base`);
      const named = new Map();
      for (const s of stmts(sql).map(ws)) {
        let m;
        if ((m = new RegExp(`^ALTER TABLE (?:ONLY )?${esc(q)} RENAME CONSTRAINT \\w+ TO (\\w+)$`, 'i').exec(s))) named.set(m[1], null);
        else if ((m = /^ALTER INDEX (?:IF EXISTS )?[\w.]+ RENAME TO (\w+)$/i.exec(s)) && m[1].startsWith(q.split('.')[1] + '__')) named.set(m[1], null);
        else if ((m = new RegExp(`^ALTER TABLE (?:ONLY )?${esc(q)} ADD (CONSTRAINT (\\w+) .*)$`, 'i').exec(s))) named.set(m[2], norm(m[1]));
      }
      for (const [c, def] of exp.conMap) {
        assert.ok(named.has(c), `${q}: constraint ${c} must be renamed/re-added after LIKE (02-CV §5 names)`);
        if (named.get(c) !== null) assert.equal(named.get(c), def, `${q} constraint ${c}`);
      }
      for (const c of named.keys()) assert.ok(exp.conMap.has(c), `${q}: unexpected constraint name ${c}`);
      assert.equal([...named.keys()].some((c) => c.endsWith('__tenant__fk')), q === 'quality.cs_exclusion_reasons', `${q}: tenant FK re-added exactly on cs_exclusion_reasons (LIKE does not copy FKs)`);
      return;
    }
    for (const [c, def] of exp.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    for (const c of got.colMap.keys()) assert.ok(exp.colMap.has(c), `${q}: extra column ${c} (the spec DDL is complete; "mandatory-column exceptions: none")`);
    for (const [c, def] of exp.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    for (const [c, def] of got.conMap) if (!exp.conMap.has(c)) assert.match(def, /^constraint\s+\w+\s+unique\(tenant_id,id\)$/, `${q}: extra constraint ${c} (only UNIQUE (tenant_id, id) may be added)`);
  });
}
test('exactly the 25 §8 tables are created in quality (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9); table count == spec count', () => {
  const sql = qSql(), bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.equal(made.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'migration CREATE TABLE count == spec CREATE TABLE count (impl note states both)');
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(bare, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /event_inbox/i, 'C9 migrations do not touch event_inbox (T0B-05 owns it)');
  for (const q of TENANT) for (const c of ['id', 'tenant_id']) { const t = specTable(sql, q); const def = t?.colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`); }
});
test('cross-schema references (01-CM §5 R3): quality -> quality / core / catalog / frontdesk / lab / instruments only, identical target set to the spec; NO FK into billing / reporting / analytics / identity; nothing outside quality references quality (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(qSql()), exp = tgt(specDdl());
  assert.deepEqual([...got].sort(), [...exp].sort(), 'FK target tables equal the spec');
  for (const t of got) assert.match(t, /^(quality|core|catalog|frontdesk|lab|instruments)\./, `quality FK target ${t}`);
  assert.doesNotMatch(files().filter((f) => !/_quality__/.test(f)).map(read).join('\n'), /\bREFERENCES\s+quality\./i, 'no FK into quality from any other migration');
});
test('indexes: every §8 CREATE INDEX present with identical definition (partial predicates, DESC); no extra index; every §3 index name exists as an index or a constraint; tenant_id leads every index and UNIQUE / PRIMARY KEY (except PRIMARY KEY (id))', () => {
  const sql = qSql(), have = new Map(createIndexes(sql).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].sort(), exp.map(idxName).sort(), 'no index beyond the spec');
  for (const n of ['qc_runs__tenant_plan_collecting__p_uq', 'qc_runs__tenant_plan_open_rejected__p_idx', 'qc_runs__tenant_collecting_assembled__p_idx', 'qc_observations__tenant_status_observed__p_idx', 'control_id_maps__tenant_key__p_uq',
    'qc_targets__tenant_plan_lot_active__p_uq', 'autoverify_versions__tenant_active__p_uq', 'autoverify_versions__tenant_simulating__p_uq', 'tat_items__tenant_running__p_idx', 'tat_items__tenant_open_alerts__p_idx']) assert.match(have.get(n) ?? '', /\bwhere\b/, `${n} is partial`);
  assert.match(have.get('control_id_maps__tenant_key__p_uq'), /coalesce\(control_lot_raw,''\)/);
  assert.match(have.get('qc_runs__tenant_plan_runat__idx'), /run_at desc/);
  const conNames = new Set(ALLT.flatMap((q) => [...specTable(sql, q).conMap.keys()]));
  const missing = [...new Set([...spec3().matchAll(/`([a-z_0-9]+__[a-z_0-9]*(?:uq|idx|pk))\b/g)].map((m) => m[1]))].filter((n) => !have.has(n) && !conNames.has(n));
  assert.deepEqual(missing, [], '§3 index names that exist neither as CREATE INDEX nor as a constraint');
  for (const s of createIndexes(sql)) assert.equal(/\bON\s+\w+\.\w+\s*\(\s*([^,)]+)/i.exec(s)[1].trim(), 'tenant_id', `index ${idxName(s)} leads with tenant_id`);
  for (const q of TENANT) for (const c of [...specTable(sql, q).conMap.values()].filter((x) => /\b(primary key|unique)\(/.test(x))) {
    const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1]; if (/primary key/.test(c) && k === 'id') continue;
    assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${c}`);
  }
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A10.5, A16.1, A17 P-16/P-18)
test('ENABLE + FORCE ROW LEVEL SECURITY (literal statements) on the 23 tenant tables; none on the 2 g_cs_* tables; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = qSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of G_T) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(qSql(), /\bDO\s+\$/i, 'literal statements only'); assert.doesNotMatch(polSql(), /\bDO\s+\$/i);
});
const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('quality.') && !/\.event_inbox$/.test(p.table));
test('policies: db/policies/quality.sql holds EXACTLY the expected 63 policies (§5 templates): name, command, role, USING, WITH CHECK; G tables none; only event_inbox may be extra; no DELETE policy except tat_items__delete__tenant', () => {
  const exp = expectedPolicies(), got = gotPolicies();
  assert.ok(got.length > 0, 'db/policies/quality.sql has no CREATE POLICY');
  const byKey = new Map(got.map((p) => [p.key, p])); assert.equal(byKey.size, got.length, 'no duplicate policy');
  for (const e of exp) {
    const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(noGuard(g.using), noGuard(e.using), `${e.key} USING`); assert.equal(noGuard(g.check), noGuard(e.check), `${e.key} WITH CHECK`);
  }
  assert.deepEqual([...byKey.keys()].sort(), exp.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access)');
  assert.deepEqual(got.filter((p) => p.cmd === 'DELETE').map((p) => p.key), ['tat_items__delete__tenant@quality.tat_items']);
  for (const p of policies(polSql()).filter((x) => /\.event_inbox$/.test(x.table))) assert.match(p.name, /^event_inbox__(select|insert|delete)__(tenant|owner_only)$/, `${p.key}: only the C0 inbox shapes may appear`);
});
test('policy shape: names <table>__<cmd>__(tenant|tenant_centre); all TO lims_app; staff guard in USING and WITH CHECK of every policy except the system-only DELETE (P-16, gate 9); ::uuid[] cast (A16.1); tenant predicate everywhere; no true / PUBLIC / anon; A tables and qc_plan_versions: no UPDATE policy; tat_items delete = system actor + expired rows only (P-18(c))', () => {
  const ps = gotPolicies(); assert.equal(ps.length, EXPECTED_POLICY_COUNT, `policies: ${ps.length}`);
  for (const p of ps) {
    const tbl = p.table.split('.')[1], m = new RegExp(`^${tbl}__${p.cmd.toLowerCase()}__(tenant|tenant_centre)$`).exec(p.name);
    assert.ok(m, `${p.key}: name <table>__<cmd>__<scope>`); assert.equal(p.roles, 'lims_app', `${p.key} roles`);
    const t = p.using + ' ' + p.check;
    assert.match(t, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: tenant predicate`);
    if (/current_centre_ids/.test(t)) assert.match(t, /any\(\(select app\.current_centre_ids\(\)\)::uuid\[\]\)/, `${p.key}: A16.1 cast`);
    assert.equal(m[1] === 'tenant_centre', CENTRE_T.includes(p.table) && p.cmd !== 'DELETE', `${p.key}: centre scope exactly on the tat_* SELECT / INSERT / UPDATE policies (§5; the purge DELETE is tenant-scoped)`);
    if (m[1] === 'tenant_centre') assert.match(t, /has_all_centres/);
    if (p.cmd !== 'INSERT') assert.match(p.using, STAFF, `${p.key} USING lacks the staff guard (P-16, gate 9 check-registry)`);
    if (p.cmd === 'INSERT' || p.cmd === 'UPDATE') assert.match(p.check, STAFF, `${p.key} WITH CHECK lacks the staff guard`);
    assert.doesNotMatch(t, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|is_platform_actor|app\.maintenance|app\.pre_/, p.key);
    assert.ok(!isG(p.table), `${p.key}: G tables carry no policy`);
  }
  for (const t of NO_UPDATE_N) assert.equal(ps.filter((p) => p.table === `quality.${t}` && p.cmd === 'UPDATE').length, 0, `quality.${t}: no UPDATE policy (§4/§5)`);
  const d = ps.find((p) => p.cmd === 'DELETE'); assert.match(d.using, /\(select app\.current_actor_type\(\)\)='system'/); assert.match(d.using, /expires_at ?< ?now\(\)/); assert.match(d.using, STAFF, 'gate 9 demands the guard on the purge policy too (spec gap, C5..C8 precedent)');
  assert.equal(ps.filter((p) => p.cmd === 'DELETE' || (p.cmd === 'UPDATE' && !UPD_N.includes(p.table.split('.')[1]))).length, 1);
});
test('policies written literally in migrations are identical to db/policies/quality.sql (AC-0B-2.3 copy)', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(qSql()).filter((x) => x.table.startsWith('quality.') && !/\.event_inbox$/.test(x.table));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort(), 'every policy of the file is created by a migration and vice versa');
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §5 grants paragraph)
test('grants equal §5: lims_app SELECT+INSERT+UPDATE on M/C/E tables except qc_plan_versions; SELECT+INSERT on qc_plan_versions and every A table; DELETE on tat_items only (E, P-18(c)); SELECT on g_cs_* and v_pub_qc_summary; nothing else, nothing to other roles; no DELETE on M/C/A', () => {
  const sql = qSql() + '\n;\n' + polSql(), g = grantsOf(sql);
  const privs = (q, r) => [...(g.get(q)?.get(r)?.all ?? [])].sort();
  for (const t of T_N) {
    const want = t === 'tat_items' ? ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] : UPD_N.includes(t) ? ['INSERT', 'SELECT', 'UPDATE'] : ['INSERT', 'SELECT'];
    assert.deepEqual(privs(`quality.${t}`, 'lims_app'), want, `quality.${t} lims_app`);
  }
  for (const q of G_T) assert.deepEqual(privs(q, 'lims_app'), ['SELECT'], `${q} lims_app`);
  assert.deepEqual(privs(VIEW, 'lims_app'), ['SELECT']);
  const expTargets = new Set([...ALLT, VIEW]); assert.equal(expTargets.size, 26);
  for (const [t, rm] of g) if (/^quality\./.test(t)) {
    assert.ok(expTargets.has(t), `${t}: unexpected grant target`);
    for (const [r, p] of rm) {
      assert.equal(r, 'lims_app', `${t}: unexpected grantee ${r}`);
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!p.all.has(bad) && !p.cols.has(bad), `${t}: ${r} must not hold ${bad}`);
      assert.equal(p.cols.size, 0, `${t}: whole-table grants only`);
    }
  }
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\bquality\./i); assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+quality\b/i); assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bquality\b/i);
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\bquality\./i.test(s) && !/FUNCTION/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner|lims_analytics)\b/i, s);
  assert.match(spec5(), /GRANT DELETE|`DELETE` on `quality\.tat_items` only/, 'spec §5 grants paragraph names the single DELETE');
});

// ================================================================ functions + triggers (AC-0B-4.1; §4, §8)
test('the 3 trigger functions (quality.enforce_version_frozen / enforce_run_frozen / enforce_observation_exclusion) equal the spec text, are SECURITY INVOKER plpgsql RETURNS trigger with search_path = \'\' (no DEFINER, no inventory entry: 04 D7); no other function', () => {
  const sql = qSql(), exp = specDdl();
  for (const f of TRG_FN) {
    const got = fnText(sql, f); assert.ok(got, `${f} missing (05-SCHEMA §8)`);
    assert.match(got, /RETURNS\s+trigger/i); assert.match(got, /LANGUAGE\s+plpgsql/i); assert.match(got, /SET\s+search_path\s*=\s*''/i); assert.doesNotMatch(got, /SECURITY\s+DEFINER/i, `${f} is INVOKER`);
    assert.equal(norm(got), norm(fnText(exp, f)), `${f} body equals the spec`);
    assert.match(got, /ERRCODE\s*=\s*'P0001'/i); assert.match(got, /MESSAGE\s*=\s*'immutable_row'/i);
  }
  assert.deepEqual(fnNames(sql).sort(), [...TRG_FN].sort(), 'no function beyond the three');
  assert.doesNotMatch(sql, /SECURITY\s+DEFINER/i, 'C9 has no SECURITY DEFINER function: quality.purge_tat_items is a worker task under policy tat_items__delete__tenant, not a function (§4, P-18(c))');
  assert.match(fnText(sql, 'quality.enforce_run_frozen'), /qc_corrective_actions/, 'close-out backstop reads corrective actions');
});
test('triggers: the 5 spec triggers equal the §8 text (qc_targets / qc_observations mutable_columns lists = §4, qc_runs__frozen, qc_observations__exclusion, autoverify_versions__frozen); no other non-audit trigger; none disabled or dropped', () => {
  const sql = qSql(), trg = createTriggers(sql).filter((s) => !isAudit(s)), byName = new Map(trg.map((s) => [trgName(s), s]));
  const exp = new Map(createTriggers(specDdl()).map((s) => [trgName(s), s]));
  assert.deepEqual([...byName.keys()].sort(), [...NON_AUDIT_TRG].sort(), 'exactly the 5 spec triggers');
  for (const [n, s] of exp) assert.equal(norm(byName.get(n) ?? ''), norm(s), `trigger ${n}`);
  const s4 = between(specRaw(), S4, S5);
  for (const [t, row] of [['qc_targets', '| `qc_targets`'], ['qc_observations', '| `qc_observations`']]) {
    const line = s4.split('\n').find((l) => l.startsWith(row)); assert.ok(line, `spec §4 row ${t}`);
    const want = /enforce_mutable_columns\(([^)]*)\)/.exec(line)[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).sort();
    assert.deepEqual(trgArgs(byName.get(`${t}__mutable_columns`), 'app\\.enforce_mutable_columns'), want, `quality.${t}: mutable columns = spec §4`);
    for (const c of want) assert.ok(createTable(sql, `quality.${t}`).colMap.has(c), `${t}.${c} is a real column`);
  }
  assert.match(byName.get('qc_targets__mutable_columns'), /^CREATE TRIGGER qc_targets__mutable_columns BEFORE UPDATE ON quality\.qc_targets FOR EACH ROW EXECUTE FUNCTION app\.enforce_mutable_columns\(/i);
  assert.doesNotMatch(sql, /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(sql, /DROP\s+TRIGGER\b/i);
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x; C0 §3.8 default = every class M / C table, the spec §8 DDL names none): <t>__audit AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW on the 12 M + 2 C tables; none on A / E / G', () => {
  const trg = createTriggers(qSql()).filter(isAudit), onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  assert.equal(AUDITED.length, 14);
  for (const q of AUDITED) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(\\s*\\)$`, 'i'), q);
  }
  for (const q of ALLT.filter((x) => !AUDITED.includes(x))) assert.equal(onTable(q).length, 0, `${q} must NOT be audited (class A / E log or ephemeral; G global)`);
  assert.equal(trg.length, 14);
});

// ================================================================ DEFINER inventory (none)
test('db/meta/definer-inventory.yaml has no quality row (C9 adds no SECURITY DEFINER function; the 3 trigger functions are INVOKER)', () => {
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  assert.deepEqual(Object.keys(inv).filter((k) => /quality/i.test(k) || TRG_FN.includes(k)), []);
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYamlSafe = () => { try { return JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables; } catch { return null; } };
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const P3_N = ['autoverify_decisions', 'verification_log', 'tat_items', 'tat_alert_events', 'tat_alert_acks'];      // §1 PHI column
test('tables.yaml: all 25 C9 tables registered (class G/M/C/A/E per §1, centre_scoped exactly tat_*, audited = trigger, retention, no shared_with (P-16 note), columns = the migration columns, phi_class P0..P3); the count equals the CREATE TABLE count; event_inbox entry untouched', () => {
  const y = tablesYaml(), regs = Object.keys(y).filter((k) => /^quality\./.test(k) && !/\.event_inbox$/.test(k));
  assert.equal(regs.length, 25, 'tables.yaml quality entries (ex event_inbox)'); assert.equal(regs.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'tables.yaml count == chunk DDL count');
  const trgAudited = (q) => createTriggers(qSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of ALLT) {
    const e = y[q], t = q.split('.')[1]; assert.ok(e, `${q} in tables.yaml`);
    assert.equal(e.class, isG(q) ? 'G' : CLS[t], `${q} class (§1)`);
    assert.equal(e.centre_scoped, CENTRE_T.includes(q), `${q} centre_scoped`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`); assert.equal(e.audited, AUDITED.includes(q), `${q} audited per C0 §3.8 default`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), [...specTable(qSql(), q).colNames.map((c) => c.replace(/"/g, ''))].sort(), `${q} columns = migration columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
    assert.deepEqual([...(e.shared_with ?? [])], [], `${q}: nothing shared with partner / portal / patient (§1 staff-actor guard note)`);
  }
  assert.ok(y['quality.event_inbox'].class === 'A', 'inbox entry remains as C0 wrote it');
});
test('tables.yaml phi_class (§1): P3 only on autoverify_decisions / verification_log / tat_items / tat_alert_events / tat_alert_acks (each with >= 1 P3 column, incl. their result / order / test ids), every other quality table P0..P1 (free-text staff notes stay P0); never P2; created_by / updated_by P0..P1', () => {
  const y = tablesYaml();
  for (const q of ALLT) {
    const t = q.split('.')[1], cols = Object.entries(y[q].columns), has3 = cols.some(([, p]) => p === 'P3');
    assert.equal(has3, P3_N.includes(t), `${q}: P3 ${P3_N.includes(t) ? 'required' : 'forbidden'} (§1 PHI column)`);
    for (const [c, p] of cols) { assert.notEqual(p, 'P2', `${q}.${c}: no P2 in quality`); if (['created_by', 'updated_by'].includes(c)) assert.ok(['P0', 'P1'].includes(p), `${q}.${c}`); }
  }
  assert.equal(y['quality.autoverify_decisions'].columns.result_id, 'P3'); assert.equal(y['quality.verification_log'].columns.result_id, 'P3'); assert.equal(y['quality.tat_items'].columns.order_id, 'P3');
  for (const q of G_T) for (const c of Object.keys(y[q].columns)) assert.equal(y[q].columns[c], 'P0', `${q}.${c}`);
});
test('tables.yaml: rls_exempt only on the 2 g_cs_* tables (with a reason); mandatory-column exceptions: none (§1: "Mandatory-column exceptions: none"), and the DDL really carries every class-mandatory column (02-CV §5.2)', () => {
  const y = tablesYaml();
  const MAND = { M: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'is_active'], C: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version'], A: ['id', 'tenant_id', 'created_at', 'created_by'],
    E: ['id', 'tenant_id', 'created_at', 'expires_at'], G: ['id', 'created_at', 'is_active'] };
  assert.match(spec1(), /Mandatory-column exceptions[^\n]*: none/);
  for (const q of ALLT) {
    const e = y[q], cls = isG(q) ? 'G' : CLS[q.split('.')[1]], cols = new Set(specTable(qSql(), q).colNames);
    if (isG(q)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    assert.deepEqual([...(e.mandatory_column_exceptions ?? [])], [], `${q}: no mandatory-column exception listed`);
    for (const c of MAND[cls]) assert.ok(cols.has(c), `${q}: class ${cls} mandatory column ${c} missing in the DDL`);
    assert.equal(isG(q), !cols.has('tenant_id'));
  }
});
test('tables.yaml retention (§7): tat_items 400 days / purge task; decisions / verification_log / alert events / acks retentionYears + no purge in v1; QC set-up, runs, observations, reviews retentionYears and never purged; qc_activity / sync_state live state; event_inbox 90 days; g_cs_* seed/permanent', () => {
  const r = (q) => tablesYaml()[`quality.${q}`].retention;
  assert.match(r('tat_items'), /400/); assert.match(r('tat_items'), /purge_tat_items/);
  for (const q of ['autoverify_decisions', 'verification_log', 'tat_alert_events', 'tat_alert_acks']) { assert.match(r(q), /retentionYears|year/i, q); assert.match(r(q), /no purge|never/i, q); }
  for (const q of ['qc_runs', 'qc_observations', 'qc_corrective_actions', 'qc_run_reviews']) assert.match(r(q), /retentionYears|year/i, q);
  for (const q of ['qc_activity', 'sync_state']) assert.match(r(q), /live|never|life/i, q);
  for (const q of ['settings', 'control_materials', 'qc_plans', 'qc_targets', 'autoverify_versions']) assert.match(r(q), /never deleted|deactivat|retentionYears/i, q);
  for (const q of G_N) assert.match(r(q), /seed|permanent|never deleted|kept|forever|global/i, q);
});
test('db/tests/rls_exempt.txt lists exactly the two quality g_cs_* tables, each with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^quality\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), [...G_T].sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ seeds (§2 coded sets, §9 "Global (migration seed): the two coded sets in §2")
test('seed rows (§9, §2): g_cs_corrective_actions = the 7 codes + displays of §2, g_cs_exclusion_reasons = the 6; INSERTs name their columns incl. id, code, display; no other INSERT into quality (no tenant seed: §9 per-tenant data belongs to packages/test-fixtures)', () => {
  const sql = qSql(), s2 = spec2();
  const want = (set) => { const row = s2.split('\n').find((l) => l.startsWith(`| \`quality.${set}\``)); assert.ok(row, `spec §2 row ${set}`); return [...row.split('|')[2].matchAll(/`([a-z_]+)`\s+"([^"]+)"/g)].map((m) => [m[1], m[2]]); };
  const lit = (v) => /^'(.*)'$/.exec(v)?.[1];
  for (const [tbl, set, n] of [['quality.g_cs_corrective_actions', 'corrective_actions', 7], ['quality.g_cs_exclusion_reasons', 'exclusion_reasons', 6]]) {
    const w = want(set), rows = insertRows(sql, tbl); assert.equal(w.length, n, `spec lists ${n} codes for ${set}`);
    assert.deepEqual(rows.map((r) => [lit(r.code), lit(r.display)]).sort(), [...w].sort(), `${tbl} seed = spec §2`);
    for (const r of rows) { assert.ok('id' in r && r.id.length > 5, `${tbl}: id given explicitly (no DEFAULT on id)`); if ('is_active' in r) assert.equal(r.is_active.toLowerCase(), 'true'); }
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, `${tbl}: distinct ids`);
  }
  assert.deepEqual([...new Set(stmts(sql).map(ws).filter((s) => /^INSERT\s+INTO\b/i.test(s)).map((s) => /INTO\s+(\S+)/i.exec(s)[1]))].sort(), [...G_T].sort(), 'no other INSERT in the quality migrations');
});

// ================================================================ view (IC §6.7; 05-SCHEMA §6, §8)
const viewSql = (sql) => { const s = stmts(sql).find((x) => /^CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+quality\.v_pub_qc_summary\b/i.test(ws(x))); return s ? ws(s) : null; };
const finalSelectCols = (v) => {                       // the view is WITH d AS (...) SELECT <cols> FROM d ...: take the outer select list
  const m = /\bAS\s+WITH\s+d\s+AS\s*\(/i.exec(v); assert.ok(m, 'CTE view shape');
  const rest = v.slice(m.index + m[0].length + balanced(v, m.index + m[0].length).length + 1);
  const sel = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+d\b/i.exec(rest); assert.ok(sel, 'outer SELECT');
  return splitTop(sel[1]).map((item) => { const a = /\bAS\s+(\w+)\s*$/i.exec(item.trim()); return a ? a[1] : item.trim().split('.').pop(); });
};
const icCols = () => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8').replace(/\r\n?/g, '\n'), a = ic.indexOf('### 6.7 `quality`');
  assert.ok(a >= 0, 'IC §6.7'); const sec = ic.slice(a, ic.indexOf('\n### 6.8', a));
  const row = sec.split('\n').find((l) => l.startsWith('| `quality.v_pub_qc_summary`')); assert.ok(row, 'IC §6.7 row');
  return splitTop(row.split('|')[2]).map((c) => /^\s*`?(\w+)/.exec(c)[1]);
};
test('view column contract vs IC §6.7: quality.v_pub_qc_summary has exactly tenant_id, instrument_id, analyte_id, business_date, runs, accepted_runs, rejected_runs, warnings, last_in_control_run_at in that order (IC, spec §6 text, spec §8 and the migration agree)', () => {
  const ic = icCols(), got = viewSql(qSql()), exp = viewSql(specDdl());
  assert.deepEqual(ic, ['tenant_id', 'instrument_id', 'analyte_id', 'business_date', 'runs', 'accepted_runs', 'rejected_runs', 'warnings', 'last_in_control_run_at']);
  assert.ok(got, 'CREATE VIEW quality.v_pub_qc_summary missing from *_quality__*.sql');
  assert.deepEqual(finalSelectCols(exp), ic, 'spec §8 vs IC §6.7'); assert.deepEqual(finalSelectCols(got), ic, 'migration columns (names + order) vs IC §6.7');
  const s6 = between(specRaw(), S6, S7), m = /Columns exactly: `([^`]+)`/.exec(s6); assert.ok(m);
  assert.deepEqual(m[1].split(',').map((x) => x.trim().split(/\s+/)[0]), ic, 'spec §6 text vs IC §6.7');
});
test('view: definition equals §8 (Asia/Kathmandu business date, run status evaluated/closed, last_in_control via LATERAL), WITH (security_invoker = true), SELECT granted to lims_app only; the only view in quality; no BYPASSRLS function', () => {
  const sql = qSql(), got = viewSql(sql);
  assert.equal(norm(got), norm(viewSql(specDdl())), 'view text');
  assert.match(got, /WITH\s*\(\s*security_invoker\s*=\s*(true|on)\s*\)/i);
  assert.match(got, /Asia\/Kathmandu/); assert.match(got, /status IN \('evaluated', ?'closed'\)/i);
  assert.deepEqual([...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\s+(\w+\.\w+)/gi)].map((m) => `${m[1] ? 'M:' : ''}${m[2]}`), [VIEW]);
  const g = grantsOf(sql).get(VIEW); assert.ok(g, `GRANT on ${VIEW}`); assert.deepEqual([...g.keys()], ['lims_app']); assert.deepEqual([...g.get('lims_app').all], ['SELECT']);
});

// ================================================================ hygiene
test('C9 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of other schemas\' tables, no USING (true), no GRANT to PUBLIC', () => {
  const raw = qFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 25000, 'C9 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i); assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016'); assert.doesNotMatch(strip(raw), /\bTO\s+PUBLIC\b/i);
});
test('LD-202 scope: no wave-1 migration, db/bootstrap, spec, service or app file is changed by this task (only quality files + policies + meta + tests are new / edited)', () => {
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', 'db/migrations', 'db/bootstrap', 'spec', 'services', 'apps'], { cwd: repo, encoding: 'utf8' });
  const changed = r.stdout.split('\n').filter(Boolean).filter((f) => !/^db\/migrations\/\d{14}_quality__/.test(f));
  assert.deepEqual(changed, [], 'tracked files outside the quality migrations were modified');
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts, check-migrations.ts and check-fk-dag.ts exit 0 on the tree (quality -> core / catalog / frontdesk / lab / instruments only; nothing into quality)', () => {
  assert.ok(qFiles().length >= 1, 'C9 migrations missing');
  for (const t of ['check-registry.ts', 'check-migrations.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 23 tenant C9 tables, none for the 2 class G, and gen-isolation-probes --check is clean; _registry.sql lists all 25', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const q of G_T) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/quality/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-13\.C9_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/quality/T0B-13.C9_*.test.sql exist (tester-owned: writer must keep them) and cover the AC list by "-- AC-0B-x.y" markers and 16 checks by "-- C9 check N" markers; RLS never disabled; replica mode only for the FK-parent fixtures and reset to origin', () => {
  assert.ok(tapFiles().length >= 2, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 16; n++) assert.match(txt, new RegExp(`-- C9 check ${n}\\b`), `marker for C9 check ${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.1', '6.2', '6.3']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
    const rep = [...s.matchAll(/session_replication_role\s*=\s*replica/gi)].length, org = [...s.matchAll(/session_replication_role\s*=\s*origin/gi)].length;
    assert.ok(rep === 0 || (org >= rep && s.lastIndexOf('= origin') > s.lastIndexOf('= replica')), `${f}: every replica fixture block is reset to origin before assertions`);
  }
});
