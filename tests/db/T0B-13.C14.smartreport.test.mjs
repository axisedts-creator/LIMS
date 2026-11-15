// T0B-13.C14 static checks of the Wave-2 smartreport DDL translation: db/migrations/*_smartreport__*.sql, db/policies/smartreport.sql, db/meta/tables.yaml, db/meta/definer-inventory.yaml, db/tests/rls_exempt.txt.
// Spec: C14 05-SCHEMA §1 (inventory, class), §2 (columns, PHI), §3 (G tables + seeds), §4 (immutability), §5 (indexes), §6 (RLS, grants, staff/system-only), §7 (retention), §8 (no published view), §9 (DDL), §10 (13 tests C0 adds);
// C0 05-SCHEMA §9 rule 1 (tenant FK + UNIQUE (tenant_id, id)); 08 A2.3 / A16.1 / A17 P-16, P-18 / A19 D-107, D-109; LD-202 (translate exactly, a gap = blocking CR).
// AC-0B-2.1..2.4, 3.1..3.7 (probes + pgTAP), 4.1..4.3, 5.1..5.3, 6.1..6.3 (static part). AC-0B-6.4 is billing-only (T0B-11) and does not apply to smartreport.
// Run: node --test tests/db/T0B-13.C14.smartreport.test.mjs   (live: db/tests/smartreport/T0B-13.C14_*.test.sql via pg_prove; generated probes: db/tests/isolation/smartreport.*.test.sql)
// Method (as T0B-13.C9..C13): the expected DDL is PARSED FROM C14 05-SCHEMA §9 at test time and compared (whitespace/case-normalised) with the migrations. §9 holds literal SQL for every table, index, function, trigger and policy
// (29 policies are written out in full), so no shape has to be expanded here; the independent policy shape (§6 prose: staff + actor-type list, centre predicate with ::uuid[]) is rebuilt below and compared with both.
// T0B13C14_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B13C14_ROOT ? resolve(process.env.T0B13C14_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').replace(/\bcreate or replace function\b/gi, 'create function').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const sFiles = () => files().filter((f) => /^\d{14}_smartreport__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const sSql = () => sFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'smartreport.sql') ? strip(readFileSync(polDir + 'smartreport.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C13)
function splitTop(body) {
  const out = []; let depth = 0, q = false, cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === "'") { if (body[i + 1] === "'") { cur += "'"; i++; } else q = false; } continue; }
    if (c === "'") { q = true; cur += c; continue; }
    if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth--;
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
  const cols = segs.filter((s) => !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|LIKE)\b/i.test(s));
  const likeSeg = segs.find((s) => /^LIKE\b/i.test(s));
  const added = [];
  for (const s of stmts(sql).map(ws)) {
    const a = new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${esc(name)}\\s+(ADD\\s+CONSTRAINT\\b[\\s\\S]*)$`, 'i').exec(s);
    if (a) for (const part of splitTop(a[1])) added.push(part.replace(/^ADD\s+/i, ''));
  }
  const allCons = [...cons, ...added];
  const nameOf = (c) => c.split(/\s+/)[0];
  return { like: likeSeg ?? null, cols, cons: allCons, colNames: cols.map(nameOf),
    colMap: new Map(cols.map((c) => [nameOf(c), norm(c)])), conMap: new Map(allCons.map((c) => [c.split(/\s+/)[1], norm(c)])) };
}
const idxName = (s) => /INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s)[1];
const createIndexes = (sql) => stmts(sql).filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s)).map(ws);
const createTriggers = (sql) => stmts(sql).filter((s) => /^CREATE\s+TRIGGER\b/i.test(s)).map(ws);
const trgName = (s) => /TRIGGER\s+(\w+)/i.exec(s)[1];
const isAudit = (s) => /app\.tg_row_audit\(/i.test(s);
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
    assert.ok(m, `seed INSERT INTO ${table} must name its columns and use VALUES: ${s.slice(0, 80)}`);
    const cols = m[1].split(',').map((c) => c.trim());
    for (const tup of splitTop(m[2])) {
      assert.match(tup, /^\(/, `tuple ${tup.slice(0, 40)}`);
      const vals = splitTop(balanced(tup, 1)); assert.equal(vals.length, cols.length, `${table}: tuple arity ${tup.slice(0, 60)}`);
      rows.push(Object.fromEntries(cols.map((c, i) => [c, vals[i]])));
    }
  }
  return rows;
}

// ---------------------------------------------------------------- spec extraction (C14 05-SCHEMA)
const specPath = repo + 'spec/chunks/C14-smart-report/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = b0 ? s.indexOf(b0, a + a0.length) : s.length; assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const S1 = '## 1. Table inventory', S2 = '## 2. Tenant tables', S3 = '## 3. Global tables and seeds', S4 = '## 4. Immutability', S5 = '## 5. Indexes', S6 = '## 6. RLS and grants', S7 = '## 7. Retention', S8 = '## 8. Published views', S9 = '## 9. DDL', S10 = '## 10. Tests';
const specDdl = () => strip(sqlBlocks(between(specRaw(), S9, S10)));
const spec1 = () => between(specRaw(), S1, S2);
const spec2 = () => between(specRaw(), S2, S3);
const spec3 = () => between(specRaw(), S3, S4);
const spec6 = () => between(specRaw(), S6, S7);
const spec7 = () => between(specRaw(), S7, S8);
const spec8 = () => between(specRaw(), S8, S9);
const spec10 = () => between(specRaw(), S10, undefined);

// ---- tables: the §9 DDL is the truth (14 CREATE TABLE = 3 G + 11 tenant; event_inbox is C0's); classes from §1 (hard-coded, sanity-checked against the spec rows)
const G_N = ['g_cs_organ_groups', 'g_cs_summary_reject_reasons', 'g_cs_wording_deny_terms'];
const CLS = { library_versions: 'M', template_blocks: 'M', rules: 'M', analyte_groups: 'M', group_settings: 'M', wording_deny_terms: 'M', library_reviews: 'A', summaries: 'C', summary_report_bindings: 'A', summary_reviews: 'A', llm_runs: 'A' };
const T_N = Object.keys(CLS);
const G_T = G_N.map((t) => `smartreport.${t}`), TENANT = T_N.map((t) => `smartreport.${t}`), ALLT = [...G_T, ...TENANT];
const isG = (q) => /\.g_/.test(q);
const CENTRE_T = ['summaries', 'summary_report_bindings', 'summary_reviews', 'llm_runs'];                  // §6: __tenant_centre
const CHILD_T = ['template_blocks', 'rules', 'analyte_groups', 'group_settings'];                           // §4: draft-only children, deactivated never deleted
const UPD_T = ['library_versions', 'wording_deny_terms', 'summaries', ...CHILD_T];                          // §6 grants: SELECT, INSERT, UPDATE
const A_T = ['library_reviews', 'summary_report_bindings', 'summary_reviews', 'llm_runs'];                  // §6 grants: SELECT, INSERT only
const AUDIT_REQ = T_N.filter((t) => CLS[t] !== 'A').map((t) => `smartreport.${t}`);                         // DDL comment: generic audit trigger on every table except class A and event_inbox
const FN_SPEC = ['smartreport.assert_library_draft', 'smartreport.check_library_transition', 'smartreport.check_summary_transition'];
const TG_NAMES = ['library_versions__transition', 'library_versions__mutable_columns', 'template_blocks__draft_only', 'rules__draft_only', 'analyte_groups__draft_only', 'group_settings__draft_only', 'summaries__transition', 'summaries__mutable_columns', 'summaries__llm_draft_only'];
const STAFF = /\(select app\.is_staff_or_system\(\)\)/;

// ---- independent policy shape (§6): staff/system only, actor type positive list, centre predicate with the A16.1 cast
const TEN = "tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')";
const CEN = `${TEN} AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))`;
function pol(t, cmd, scope) {
  const p = scope === 'tenant' ? TEN : CEN, c = cmd.toLowerCase();
  return `CREATE POLICY ${t}__${c}__${scope} ON smartreport.${t} FOR ${cmd} TO lims_app ${cmd === 'INSERT' ? '' : `USING (${p}) `}${cmd === 'SELECT' ? '' : `WITH CHECK (${p})`}`;
}
const CMDS = { library_versions: 'SIU', template_blocks: 'SIU', rules: 'SIU', analyte_groups: 'SIU', group_settings: 'SIU', wording_deny_terms: 'SIU', library_reviews: 'SI', summaries: 'SIU', summary_report_bindings: 'SI', summary_reviews: 'SI', llm_runs: 'SI' };
function expectedPolicies() {
  const out = [];
  for (const t of T_N) for (const ch of CMDS[t]) out.push(pol(t, { S: 'SELECT', I: 'INSERT', U: 'UPDATE' }[ch], CENTRE_T.includes(t) ? 'tenant_centre' : 'tenant'));
  return policies(out.join(';\n'));
}
const EXPECTED_POLICY_COUNT = 29;     // 6 x 3 + 2 tenant-only; summaries 3 + 3 x 2 centre-scoped (§9 writes all 29 out)

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 14 CREATE TABLE in §9 (3 G + 11 tenant; no event_inbox), no LIKE, 3 INVOKER functions, 9 triggers, 29 policies equal the independent §6 shape, no DEFINER, no view (§8), §1 classes, 16 + 5 + 23 seeds, §10 lists 13 tests', () => {
  const ddl = specDdl();
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 14, '14 CREATE TABLE in §9');
  assert.equal(G_N.length, 3); assert.equal(T_N.length, 11); assert.equal(ALLT.length, 14);
  assert.deepEqual([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].map((m) => m[1]).sort(), [...ALLT].sort(), '§1 smartreport (15 rows minus event_inbox) = §9 tables');
  for (const q of ALLT) { const t = createTable(ddl, q); assert.ok(t, `spec has ${q}`); assert.equal(t.like, null, `${q}: no LIKE in the spec`); }
  assert.doesNotMatch(ddl, /CREATE\s+TABLE\s+smartreport\.event_inbox/i);
  assert.deepEqual(fnNames(ddl).sort(), [...FN_SPEC].sort(), 'the 3 trigger functions of §9');
  assert.doesNotMatch(ddl, /SECURITY\s+DEFINER/i, '§4: the three functions are SECURITY INVOKER, no inventory entry (04 D7)');
  assert.deepEqual(createTriggers(ddl).map(trgName).sort(), [...TG_NAMES].sort(), '9 triggers in §9');
  const lit = policies(ddl), exp = expectedPolicies();
  assert.equal(lit.length, EXPECTED_POLICY_COUNT, '29 policies written out in §9'); assert.equal(exp.length, EXPECTED_POLICY_COUNT);
  assert.deepEqual(lit.map((p) => p.key).sort(), exp.map((p) => p.key).sort(), 'the independent §6 shape names the same 29 policies');
  for (const e of exp) { const l = lit.find((p) => p.key === e.key); assert.equal(l.cmd, e.cmd, e.key); assert.equal(l.roles, e.roles, e.key); assert.equal(l.using, e.using, `${e.key} USING`); assert.equal(l.check, e.check, `${e.key} WITH CHECK`); }
  assert.match(spec8(), /None\./, '§8: no published view');
  assert.doesNotMatch(ddl, /CREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW/i);
  for (const [t, c] of Object.entries(CLS)) assert.match(spec1(), new RegExp(`\\|\\s*\`smartreport\\.${t}\`\\s*\\|\\s*${c}\\b`), `§1 class of ${t} = ${c}`);
  for (const t of G_N) assert.match(spec1(), new RegExp(`\\|\\s*\`smartreport\\.${t}\`\\s*\\|\\s*G\\b`), `§1 class of ${t} = G`);
  assert.match(spec1(), /Mandatory-column exceptions \(08 A17 P-18\(b\)\): none/, '§1: no mandatory-column exceptions for tenant tables');
  const refs = new Set([...ddl.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()).filter((x) => !x.startsWith('smartreport.')));
  assert.deepEqual([...refs].sort(), ['catalog.analytes', 'catalog.tests', 'core.collection_centres', 'core.memberships', 'core.tenants', 'frontdesk.orders', 'frontdesk.patients'], 'cross-schema FK targets of §9 (core, catalog, frontdesk)');
  assert.equal(insertRows(ddl, 'smartreport.g_cs_organ_groups').length, 16); assert.equal(insertRows(ddl, 'smartreport.g_cs_summary_reject_reasons').length, 5); assert.equal(denyTermsSpec().length, 23);
  assert.equal([...spec10().matchAll(/^\d+\. /gm)].length, 13, '§10 lists 13 tests');
  assert.match(spec6(), /No policy on any `smartreport\.\*` table admits patient, portal, partner or device actors/);
});

// ================================================================ files, order, owner (AC-0B-6.1 / 6.3)
const WAVE2 = /_(quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection|migration_staging)__/;
test('migration files: >= 1 *_smartreport__*.sql, timestamps strictly after 20261114120000 (LD-202), after every wave-1 migration and after the quality, micro, anatomic, inventory and partners migrations (DAG: ... partners -> smartreport, db/meta/dag.yaml), unique; db/policies/smartreport.sql exists; schema creation IF NOT EXISTS', () => {
  assert.ok(sFiles().length >= 1, 'no db/migrations/*_smartreport__*.sql yet (T0B-13.C14 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => !WAVE2.test(f)), before = all.filter((f) => /_(quality|micro|anatomic|inventory|partners)__/.test(f));
  assert.ok(earlier.length >= 24, 'wave-1 migrations present'); assert.ok(before.length >= 5, 'quality + micro + anatomic + inventory + partners migrations present');
  for (const f of sFiles()) {
    assert.ok(f.slice(0, 14) > '20261114120000', `${f} must be later than 20261114120000`);
    for (const e of [...earlier, ...before]) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (smartreport follows partners in the DAG)`);
  }
  assert.ok(existsSync(polDir + 'smartreport.sql'), 'db/policies/smartreport.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(sSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)smartreport\b/i, 'schema smartreport exists since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every smartreport migration is SET LOCAL ROLE lims_owner and it is the only role switch (all objects incl. the 3 functions owned by lims_owner); no standing CREATE grant, no role DDL, no CREATE EXTENSION', () => {
  assert.ok(sFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+|SET\s+SESSION\s+AUTHORIZATION)/gi)].map((m) => ws(m[1]).toUpperCase());
  for (const f of sFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch`);
  }
  assert.doesNotMatch(sSql(), /GRANT\s+CREATE\s+ON\s+(SCHEMA\s+app|DATABASE)/i); assert.doesNotMatch(sSql(), /CREATE\s+ROLE|ALTER\s+ROLE/i); assert.doesNotMatch(sSql(), /CREATE\s+EXTENSION/i);
});

// ================================================================ tables (columns + constraints = spec exactly; C0 may add only <t>__tenant__fk and UNIQUE (tenant_id, id), C0 05-SCHEMA §9 rule 1)
for (const q of ALLT) {
  test(`${q}: every spec column + constraint (name + text) present identically in the migration; no extra column; only <t>__tenant__fk and UNIQUE (tenant_id, id) may be added; not created with LIKE (05-SCHEMA §9; C0 §9 rule 1)`, () => {
    const exp = createTable(specDdl(), q); assert.ok(exp, `spec table ${q}`);
    const sql = sSql(), got = createTable(sql, q), t = q.split('.')[1];
    assert.ok(got, `CREATE TABLE ${q} not found in *_smartreport__*.sql`);
    assert.equal(got.like, null, `${q}: LIKE is not used anywhere in this schema`);
    for (const [c, def] of exp.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    for (const c of got.colMap.keys()) assert.ok(exp.colMap.has(c), `${q}: extra column ${c} (the spec DDL is complete)`);
    for (const [c, def] of exp.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    for (const [c, def] of got.conMap) if (!exp.conMap.has(c)) {
      assert.ok(c === `${t}__tenant__fk` || /^unique\(tenant_id,id\)$/.test(def.replace(/^constraint\s+\w+\s+/, '')), `${q}: extra constraint ${c} (only the C0 tenant FK and UNIQUE (tenant_id, id) may be added)`);
      if (c === `${t}__tenant__fk`) assert.equal(def, `constraint ${t}__tenant__fk foreign key(tenant_id)references core.tenants(id)`, `${q}: tenant FK text`);
      else assert.ok(got.colMap.has('id') && got.colMap.has('tenant_id'), `${q}: UNIQUE (tenant_id, id) only on tables with an id`);
    }
    if (!isG(q)) assert.ok(got.conMap.has(`${t}__tenant__fk`), `${q}: ${t}__tenant__fk (C0 §9 rule 1: every tenant table has the tenant FK)`);
    if (!isG(q)) assert.ok([...got.conMap.values()].some((d) => /unique\(tenant_id,id\)$/.test(d)), `${q}: UNIQUE (tenant_id, id) (04 D8)`);
  });
}
test('exactly the 14 §9 tables are created in smartreport (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9); table count == spec count; every constraint is named <table>__*; the CHECK value lists of §2 are present', () => {
  const sql = sSql(), bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.equal(made.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'migration CREATE TABLE count == spec CREATE TABLE count (impl note states both)');
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(bare, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /event_inbox/i, 'C14 migrations do not touch event_inbox (T0B-05 owns it)');
  for (const q of TENANT) for (const c of ['id', 'tenant_id']) { const def = createTable(sql, q)?.colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`); }
  for (const q of ALLT) { const t = q.split('.')[1]; for (const c of createTable(sql, q).conMap.keys()) assert.ok(c.startsWith(t + '__'), `${q}: constraint ${c} must be prefixed ${t}__`); }
  const sql2 = norm(sql);
  for (const v of ['draft,in_review,approved,retired', 'draft,approved,rejected,superseded', 'deranged,advice,followup,disclaimer,score_explanation', 'deranged,advice,followup', 'analyte,group,any,all_in_range', 'low,high,abnormal,any', 'borderline,out_of_range,critical',
    'submitted,returned,approved,retired', 'approved,rejected,superseded,llm_rephrase_requested', 'succeeded,partially_passed,validator_failed,failed', 'results_changed,library_rebuild', 'good,fair,needs_attention', 'en,ne,any', 'en,ne', 'hs-1'])
    assert.ok(sql2.includes(v.split(',').map((x) => `'${x}'`).join(',')) || (v.indexOf(',') < 0 && sql2.includes(`'${v}'`)), `§9 value list ${v}`);
});
test('cross-schema references (01-CM §5 R3): smartreport -> smartreport / core / catalog / frontdesk only, identical target set to the spec; NO FK into billing, lab, reporting, partners ... (CV §5.4); nothing in an upstream schema references smartreport (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(sSql()), exp = tgt(specDdl());
  for (const t of exp) got.has(t) || assert.fail(`FK target ${t} missing`);
  for (const t of [...got]) { assert.match(t, /^(smartreport|core|catalog|frontdesk)\./, `smartreport FK target ${t}`); exp.has(t) || assert.fail(`FK target ${t} is not in the spec`); }
  const upstream = files().filter((f) => !WAVE2.test(f) || /_(quality|micro|anatomic|inventory|partners)__/.test(f));
  assert.doesNotMatch(upstream.map(read).join('\n'), /\bREFERENCES\s+smartreport\./i, 'no FK into smartreport from an upstream schema');
  assert.doesNotMatch(sSql(), /\bREFERENCES\s+(billing|lab|reporting|identity|instruments|analytics|quality|micro|anatomic|inventory|partners)\./i, 'no FK into billing / lab / ... (02-CV §5.4)');
});
test('indexes: every §9 CREATE INDEX present with identical definition (14), no other index; every §5 index name exists; tenant_id leads every index and UNIQUE / PRIMARY KEY on the 11 tenant tables (except PRIMARY KEY (id)); the partial-unique indexes are partial', () => {
  const sql = sSql(), have = new Map(createIndexes(sql).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  assert.equal(exp.length, 14, `spec indexes: ${exp.length}`);
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].filter((n) => !exp.some((s) => idxName(s) === n)), [], 'no index beyond the spec DDL (no trigram / extra index is offered for smartreport)');
  const conNames = new Set(ALLT.flatMap((q) => [...createTable(sql, q).conMap.keys()]));
  const s5 = between(specRaw(), S5, S6);
  for (const n of new Set([...s5.matchAll(/`([a-z_]+__[a-z0-9_]+(?:__p_uq|__uq|__idx))`/g)].map((m) => m[1]))) assert.ok(have.has(n) || conNames.has(n), `§5 names ${n}: index or constraint exists`);
  for (const n of ['library_versions__tenant_id__open__p_uq', 'library_versions__tenant_id__approved__p_uq', 'template_blocks__tenant_id_lib_key__p_uq', 'analyte_groups__tenant_id_lib_analyte__p_uq', 'summaries__tenant_id_order_id__live__p_uq', 'wording_deny_terms__tenant_id_term_folded_language__p_uq'])
    assert.match(have.get(n) ?? '', /^create unique index .*\bwhere\b/, `${n} is a partial unique index`);
  assert.match(have.get('template_blocks__tenant_id_lib_key__p_uq'), /where is_active$/, 'P-18(a): key unique among ACTIVE rows');
  assert.match(have.get('analyte_groups__tenant_id_lib_analyte__p_uq'), /where is_active$/, 'P-18(a): one ACTIVE mapping per analyte per version');
  assert.match(have.get('summaries__tenant_id_order_id__live__p_uq'), /where status in\('draft','approved','rejected'\)$/, 'one live summary per order');
  assert.ok(conNames.has('summaries__tenant_id_order_id_hash_library__uq') && conNames.has('library_versions__tenant_id_version_no__uq') && conNames.has('summary_report_bindings__tenant_id_summary_id_version_no__uq'), '§5 unique keys');
  for (const s of createIndexes(sql)) assert.equal(/\bON\s+\w+\.\w+\s*(?:USING\s+\w+\s*)?\(\s*([^,)]+)/i.exec(s)[1].trim(), 'tenant_id', `index ${idxName(s)} leads with tenant_id`);
  for (const q of TENANT) for (const c of [...createTable(sql, q).conMap.values()].filter((x) => /\b(primary key|unique)\(/.test(x))) {
    const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1]; if (/primary key/.test(c) && k === 'id') continue;
    assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${c}`);
  }
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A2.3, A16.1, A17 P-16, A19 D-109)
test('ENABLE + FORCE ROW LEVEL SECURITY as literal statements (no DO block / format(): check-migrations.ts and the policy tools read statements) on the 11 tenant tables; none on the 3 G tables; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = sSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of G_T) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(sSql(), /\bDO\s+\$/i, 'literal statements only'); assert.doesNotMatch(polSql(), /\bDO\s+\$/i);
  assert.doesNotMatch(sSql() + polSql(), /EXECUTE\s+format\s*\(/i);
});
const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('smartreport.') && !/\.event_inbox$/.test(p.table));
test('policies: db/policies/smartreport.sql holds EXACTLY the 29 policies of §9 (name, command, role, USING, WITH CHECK, exact text modulo whitespace) and they equal the independent §6 shape; no policy on a G table; only event_inbox may be extra; no dynamic SQL', () => {
  const spec = policies(specDdl()), got = gotPolicies(), exp = expectedPolicies();
  assert.ok(got.length > 0, 'db/policies/smartreport.sql has no CREATE POLICY');
  const byKey = new Map(got.map((p) => [p.key, p])); assert.equal(byKey.size, got.length, 'no duplicate policy');
  for (const e of [...spec, ...exp]) {
    const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(g.using, e.using, `${e.key} USING`); assert.equal(g.check, e.check, `${e.key} WITH CHECK`);
  }
  assert.deepEqual([...byKey.keys()].sort(), spec.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access)');
  for (const p of policies(polSql()).filter((x) => /\.event_inbox$/.test(x.table))) assert.match(p.name, /^event_inbox__(select|insert|delete)__(tenant|owner_only)$/, `${p.key}: only the C0 inbox shapes may appear`);
});
test('policy shape (§6, 08 A2.3, D-109): names <table>__<cmd>__(tenant|tenant_centre), all TO lims_app; every USING / WITH CHECK has the tenant predicate AND (SELECT app.is_staff_or_system()) AND actor_type IN (user, system) (no device / patient / portal / partner); tenant_centre = exactly the 4 centre tables with has_all_centres OR centre_id = ANY (...::uuid[]); NO DELETE policy anywhere; library_reviews + the 3 other A tables have no UPDATE policy; no true / PUBLIC / anon', () => {
  const ps = gotPolicies(); assert.equal(ps.length, EXPECTED_POLICY_COUNT, `policies: ${ps.length}`);
  for (const p of ps) {
    const tbl = p.table.split('.')[1], m = new RegExp(`^${tbl}__${p.cmd.toLowerCase()}__(tenant|tenant_centre)$`).exec(p.name);
    assert.ok(m, `${p.key}: name <table>__<cmd>__(tenant|tenant_centre)`); const sc = m[1], t = p.using + ' ' + p.check;
    assert.equal(p.roles, 'lims_app', `${p.key} roles`);
    assert.match(t, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: tenant predicate`);
    assert.match(t, STAFF, `${p.key}: P-16 staff guard`);
    assert.match(t, /\(select app\.current_actor_type\(\)\)in\('user','system'\)/, `${p.key}: positive actor list (D-109)`);
    assert.doesNotMatch(t, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|'device'|'patient'|'portal'|'partner'|current_partner_id|current_patient_id/, `${p.key}: no non-staff actor is admitted`);
    assert.ok(!isG(p.table), `${p.key}: a G table carries no policy`);
    if (sc === 'tenant_centre') { assert.ok(CENTRE_T.includes(tbl), `${p.key}: centre scope only on the 4 centre tables`); assert.match(t, /\(select app\.has_all_centres\(\)\)or centre_id=any\(\(select app\.current_centre_ids\(\)\)::uuid\[\]\)/, `${p.key}: A16.1 cast`); }
    else { assert.ok(!CENTRE_T.includes(tbl), `${p.key}: centre tables use tenant_centre`); assert.doesNotMatch(t, /current_centre_ids|has_all_centres/, `${p.key}: no centre predicate on a tenant-only table`); }
  }
  for (const t of CENTRE_T) assert.ok(ps.some((p) => p.table === `smartreport.${t}` && p.name.endsWith('__tenant_centre')), `${t}: centre-scoped policy`);
  assert.equal(ps.filter((p) => p.cmd === 'DELETE').length, 0, 'no DELETE policy on any smartreport table (REQ-SEC-016 default deny; class M rows are deactivated)');
  for (const t of A_T.concat(['library_reviews'])) assert.equal(ps.filter((p) => p.table === `smartreport.${t}` && p.cmd === 'UPDATE').length, 0, `${t}: class A, no UPDATE policy`);
  for (const t of T_N.filter((x) => !A_T.includes(x))) assert.equal(ps.filter((p) => p.table === `smartreport.${t}`).map((p) => p.cmd).sort().join(), 'INSERT,SELECT,UPDATE', `${t}: select + insert + update`);
});
test('policies written literally in migrations are identical to db/policies/smartreport.sql (AC-0B-2.3 copy)', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(sSql()).filter((x) => x.table.startsWith('smartreport.') && !/\.event_inbox$/.test(x.table));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort(), 'every policy of the file is created by a migration and vice versa');
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §6 table + §9 GRANT statements parsed from the spec)
test('grants equal §9 / §6: lims_app SELECT+INSERT+UPDATE on library_versions, wording_deny_terms, summaries and the 4 draft-only children; SELECT+INSERT on the 4 class-A tables; SELECT on the 3 g_cs_* tables; DELETE on NOTHING; no TRUNCATE / REFERENCES / TRIGGER; nothing to other roles; no view', () => {
  const sql = sSql() + '\n;\n' + polSql(), g = grantsOf(sql), exp = grantsOf(specDdl());
  const privs = (m, q, r) => [...(m.get(q)?.get(r)?.all ?? [])].sort();
  for (const t of T_N) assert.deepEqual(privs(g, `smartreport.${t}`, 'lims_app'), UPD_T.includes(t) ? ['INSERT', 'SELECT', 'UPDATE'] : ['INSERT', 'SELECT'], `smartreport.${t} lims_app`);
  for (const t of A_T) assert.ok(!privs(g, `smartreport.${t}`, 'lims_app').includes('UPDATE'), `smartreport.${t}: class A, no UPDATE grant (immutable, §4)`);
  for (const q of G_T) assert.deepEqual(privs(g, q, 'lims_app'), ['SELECT'], `${q} lims_app`);
  for (const [q, rm] of exp) if (/^smartreport\./.test(q)) for (const r of rm.keys()) assert.deepEqual(privs(g, q, r), privs(exp, q, r), `${q} ${r}: grants = spec §9`);
  assert.deepEqual([...g.entries()].filter(([t, rm]) => /^smartreport\./.test(t) && [...rm.values()].some((p) => p.all.has('DELETE'))).map(([t]) => t), [], '§6: no DELETE grant on any smartreport table (P-18(a), CV §5.6)');
  for (const [t, rm] of g) if (/^smartreport\./.test(t)) {
    assert.ok(new Set(ALLT).has(t), `${t}: unexpected grant target`);
    for (const [r, p] of rm) {
      assert.equal(r, 'lims_app', `${t}: unexpected grantee ${r}`);
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL', 'DELETE']) assert.ok(!p.all.has(bad) && !p.cols.has(bad), `${t}: ${r} must not hold ${bad}`);
      assert.equal(p.cols.size, 0, `${t}: whole-table grants only`);
    }
  }
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\bsmartreport\./i); assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+smartreport\b/i); assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bsmartreport\b/i);
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\bsmartreport\./i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner|lims_analytics)\b/i, s);
  assert.doesNotMatch(strip(sSql()), /\bCREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\b/i, '§8: C14 publishes no view');
});

// ================================================================ functions + triggers (AC-0B-4.1; §4, §9, D-107)
test('the 3 §9 functions equal the spec text and are SECURITY INVOKER with search_path = \'\' (no DEFINER, no inventory entry, 04 D7); no function beyond the spec; SQLSTATE P0001 with messages immutable_row / invalid_transition (CV §5.7)', () => {
  const sql = sSql(), exp = specDdl();
  for (const f of FN_SPEC) {
    const got = fnText(sql, f); assert.ok(got, `${f} missing (05-SCHEMA §9)`);
    assert.equal(norm(got), norm(fnText(exp, f)), `${f}: text equals the spec`);
    assert.match(got, /SET\s+search_path\s*=\s*''/i, `${f}: search_path = ''`); assert.doesNotMatch(got, /SECURITY\s+DEFINER/i, `${f}: SECURITY INVOKER`);
    assert.match(got, /ERRCODE\s*=\s*'P0001'/); assert.match(got, /MESSAGE\s*=\s*'(immutable_row|invalid_transition)'/);
  }
  assert.deepEqual(fnNames(sql).sort(), [...FN_SPEC].sort(), 'no function beyond the spec');
  assert.doesNotMatch(sql, /SECURITY\s+DEFINER/i, 'no DEFINER function in the smartreport migrations');
  const sum = fnText(sql, 'smartreport.check_summary_transition');
  assert.match(sum, /superseded_by_summary_id/); assert.match(sum, /'updated_at','updated_by','version'/, 'D-107: only superseded_by_summary_id (NULL -> id) + audit columns may change');
});
test('triggers: the 9 §9 triggers equal the spec statements (library_versions transition + mutable_columns WHEN (OLD.status <> draft), 4 draft_only INSERT OR UPDATE OR DELETE, summaries transition + mutable_columns + llm_draft_only); nothing else besides the audit triggers; none disabled or dropped; app.enforce_mutable_columns is the C0 function', () => {
  const sql = sSql(), all = createTriggers(sql), trg = all.filter((s) => !isAudit(s));
  const exp = createTriggers(specDdl());
  assert.equal(exp.length, 9);
  for (const s of exp) { const hit = trg.find((x) => trgName(x) === trgName(s)); assert.ok(hit, `trigger ${trgName(s)} missing`); assert.equal(norm(hit), norm(s), `trigger ${trgName(s)}`); }
  assert.deepEqual(trg.map(trgName).sort(), [...TG_NAMES].sort(), 'no trigger beyond the spec (audit aside)');
  assert.doesNotMatch(sql, /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(sql, /DROP\s+TRIGGER\b/i); assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+app\./i, 'app.* helpers are C0\'s');
  const llm = trg.find((s) => trgName(s) === 'summaries__llm_draft_only'), mut = trg.find((s) => trgName(s) === 'summaries__mutable_columns');
  assert.doesNotMatch(llm, /'llm_overlay'|'use_llm_text'/, '§4: the second trigger omits the two LLM columns (they change only while draft)'); assert.match(mut, /'llm_overlay'/); assert.match(mut, /'use_llm_text'/);
  assert.match(llm, /WHEN\s*\(\s*OLD\.status\s*<>\s*'draft'\s*\)/i);
  for (const t of CHILD_T) assert.match(trg.find((s) => trgName(s) === `${t}__draft_only`), /BEFORE INSERT OR UPDATE OR DELETE ON/i, `${t}: draft_only also fires on DELETE (defence in depth)`);
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x): <t>__audit AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW on the 7 class M / C tables (library_versions, template_blocks, rules, analyte_groups, group_settings, wording_deny_terms, summaries); none on the 4 class-A tables or the 3 G tables ("every table above except the class-A tables and event_inbox", global tables carry no tenant audit)', () => {
  const trg = createTriggers(sSql()).filter(isAudit), onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  assert.equal(AUDIT_REQ.length, 7);
  for (const q of AUDIT_REQ) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(\\s*\\)$`, 'i'), q);
  }
  for (const q of [...A_T.map((t) => `smartreport.${t}`), ...G_T]) assert.equal(onTable(q).length, 0, `${q} must NOT be audited`);
  assert.equal(trg.length, 7, 'no audit trigger beyond the 7');
});

// ================================================================ DEFINER inventory: none (04 D7)
test('db/meta/definer-inventory.yaml has no smartreport row and the smartreport migrations create no SECURITY DEFINER function (the three trigger functions are INVOKER, §4); no owner policy (__owner_only) in smartreport', () => {
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  assert.deepEqual(Object.keys(inv).filter((k) => /^smartreport\./.test(k)), [], 'no smartreport DEFINER row');
  for (const e of Object.values(inv)) assert.doesNotMatch(JSON.stringify(e.touches ?? []) + JSON.stringify(e.policies ?? []), /smartreport\./, 'no existing DEFINER row touches smartreport');
  assert.doesNotMatch(sSql(), /SECURITY\s+DEFINER/i); assert.doesNotMatch(sSql() + polSql(), /__owner_only/);
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const MAND = { M: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'is_active'], C: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version'], A: ['id', 'tenant_id', 'created_at', 'created_by'],
  E: ['id', 'tenant_id', 'created_at', 'expires_at'], G: ['id', 'created_at', 'is_active'] };
function phiRows() {   // §2.1-2.6, 2.8: unambiguous column rows -> Map("table.col" -> P-class); name cell may list several columns (", " or " / ")
  const out = new Map(), secs = [['library_versions', '### 2.1', '### 2.2'], ['template_blocks', '### 2.2', '### 2.3'], ['rules', '### 2.3', '### 2.4'], ['analyte_groups', '### 2.4', '### 2.5'], ['group_settings', '### 2.5', '### 2.6'],
    ['wording_deny_terms', '### 2.6', '### 2.7'], ['summaries', '### 2.8', '### 2.9']];
  for (const [t, a, b] of secs) for (const l of between(spec2(), a, b).split('\n').filter((x) => x.startsWith('| '))) {
    const c = l.split('|').map((x) => x.trim()), phi = c[c.length - 2], m = /^\*{0,2}(P[0-3])\*{0,2}/.exec(phi ?? ''); if (!m) continue;
    for (const n of c[1].split(/,|\s\/\s/).map((x) => x.trim())) if (/^[a-z][a-z0-9_]*$/.test(n)) out.set(`${t}.${n}`, m[1]);
  }
  return out;
}
test('tables.yaml: all 14 smartreport tables registered (class per §1, centre_scoped = the 4 tenant_centre tables, audited = trigger, retention, NO shared_with (staff/system-only, 08 A2.3), columns = the migration columns, phi_class P0..P3); the count equals the CREATE TABLE count; event_inbox entry untouched', () => {
  const y = tablesYaml(), regs = Object.keys(y).filter((k) => /^smartreport\./.test(k) && !/\.event_inbox$/.test(k));
  assert.equal(regs.length, 14, 'tables.yaml smartreport entries (ex event_inbox)'); assert.equal(regs.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'tables.yaml count == chunk DDL count');
  const trgAudited = (q) => createTriggers(sSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s)), pols = gotPolicies();
  for (const q of ALLT) {
    const e = y[q], t = q.split('.')[1]; assert.ok(e && createTable(sSql(), q), `${q} in tables.yaml and migrations`);
    assert.equal(e.class, isG(q) ? 'G' : CLS[t], `${q} class (§1)`);
    assert.equal(e.centre_scoped, pols.some((p) => p.table === q && /current_centre_ids/.test(p.using + p.check)), `${q} centre_scoped = has a tenant_centre policy`); assert.equal(e.centre_scoped, CENTRE_T.includes(t), `${q} centre_scoped (§6)`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`); assert.equal(e.audited, AUDIT_REQ.includes(q), `${q} audited (M and C tables only)`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), [...createTable(sSql(), q).colNames.map((c) => c.replace(/"/g, ''))].sort(), `${q} columns = migration columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
    assert.deepEqual([...(e.shared_with ?? [])], [], `${q}: shared_with empty (08 A2.3: no policy admits patient, portal or partner actors; summaries reach them only as the approved snapshot C6 stores)`);
  }
  assert.ok(y['smartreport.event_inbox'].class === 'A', 'inbox entry remains as C0 wrote it');
});
test('tables.yaml phi_class (§2): every unambiguous column row of §2.1-2.6 and 2.8 equals the registry value; library tables all P0; summaries content / llm_overlay / status / health_score_* / the 5 counts / reject_comment P3, ids P1; llm_runs.items P3 (by linkage); summary_reviews.comment P3; library_reviews / bindings P0..P1', () => {
  const y = tablesYaml(), rows = phiRows(); assert.ok(rows.size >= 100, `parsed §2 phi rows: ${rows.size}`);
  for (const [k, p] of rows) { const [t, c] = k.split('.'); assert.equal(y[`smartreport.${t}`]?.columns?.[c], p, `${k}: phi_class = §2 (${p})`); }
  for (const t of ['library_versions', 'template_blocks', 'rules', 'analyte_groups', 'group_settings', 'wording_deny_terms', 'library_reviews']) for (const [c, p] of Object.entries(y[`smartreport.${t}`].columns)) assert.equal(p, 'P0', `${t}.${c}: P0 (template / library data, no patient data; §2.7 P0)`);
  const s = y['smartreport.summaries'].columns;
  for (const c of ['content', 'llm_overlay', 'status', 'health_score_value', 'health_score_band', 'panels_scored', 'deranged_count', 'critical_count', 'unmapped_result_count', 'ignored_duplicate_count', 'reject_comment']) assert.equal(s[c], 'P3', `summaries.${c}`);
  for (const c of ['id', 'tenant_id', 'centre_id', 'order_id', 'patient_id', 'approved_set_hash', 'input_result_versions', 'content_sha256']) assert.equal(s[c], 'P1', `summaries.${c}`);
  assert.equal(y['smartreport.llm_runs'].columns.items, 'P3', '§2.11: items P3 by linkage'); assert.equal(y['smartreport.summary_reviews'].columns.comment, 'P3', '§2.10: comment P3');
  for (const q of ['smartreport.summary_report_bindings', 'smartreport.summary_reviews', 'smartreport.llm_runs']) for (const [c, p] of Object.entries(y[q].columns)) if (!['items', 'comment'].includes(c)) assert.ok(['P0', 'P1'].includes(p), `${q}.${c} P0..P1 (only items / comment are health data)`);
  for (const q of ALLT) for (const c of ['created_by', 'updated_by']) if (y[q].columns[c]) assert.ok(['P0', 'P1'].includes(y[q].columns[c]), `${q}.${c}`);
  assert.match(spec2(), /P3 \(status of a health summary\)/);
});
test('tables.yaml: rls_exempt only on the 3 g_cs_* tables (with a reason); mandatory_column_exceptions = exactly the class-mandatory columns the DDL lacks (the 3 G tables: id; tenant tables: none, §1 P-18(b)) with a reason; each omitted column is absent from the DDL; every other table carries all of them', () => {
  const y = tablesYaml();
  for (const q of ALLT) {
    assert.ok(y[q] && createTable(sSql(), q), `${q} in tables.yaml and in the migrations`);
    const e = y[q], cls = isG(q) ? 'G' : CLS[q.split('.')[1]], cols = new Set(createTable(sSql(), q).colNames);
    if (isG(q)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    const missing = MAND[cls].filter((c) => !cols.has(c)).sort(), got = [...(e.mandatory_column_exceptions ?? [])].sort();
    assert.deepEqual(got, missing, `${q}: mandatory_column_exceptions must list exactly the missing class-${cls} columns`);
    if (isG(q)) assert.deepEqual(got, ['id'], `${q}: natural key = PK, no id (as micro.g_*)`); else assert.deepEqual(got, [], `${q}: no exception (§1)`);
    if (got.length) assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 5, `${q}: mandatory_column_exceptions_reason`);
    for (const c of got) assert.ok(!cols.has(c), `${q}: omitted column ${c} must really be absent`);
    assert.equal(isG(q), !cols.has('tenant_id'));
  }
});
test('tables.yaml retention (§7): summaries / bindings / reviews / llm_runs = tenant clinical retention (clinicalYears, default 5 y, no purge in v1); library tables + library_reviews kept for the life of the tenant, never deleted; G tables seed / permanent; event_inbox 90 days', () => {
  const y = tablesYaml(), r = (q) => { const e = y[`smartreport.${q}`]; assert.ok(e, `smartreport.${q} in tables.yaml`); return e.retention; };
  assert.match(spec7(), /clinicalYears/);
  for (const q of ['summaries', 'summary_report_bindings', 'summary_reviews', 'llm_runs']) assert.match(r(q), /clinical|clinicalYears|5 y|retention/i, q);
  for (const q of ['library_versions', 'template_blocks', 'rules', 'analyte_groups', 'group_settings', 'wording_deny_terms', 'library_reviews']) assert.match(r(q), /life of the tenant|never deleted|kept|forever|permanent|no purge/i, q);
  for (const q of G_N) assert.match(r(q), /seed|permanent|never deleted|kept|forever|global/i, q);
  assert.match(y['smartreport.event_inbox'].retention, /90 days/);
});
test('db/tests/rls_exempt.txt lists exactly the 3 smartreport G tables with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^smartreport\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), [...G_T].sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ seeds (§3: 16 organ groups, 5 reject reasons, 23 deny terms; nothing else)
function denyTermsSpec() { const m = /FROM unnest\(ARRAY\[([\s\S]*?)\]\)/.exec(specDdl()); assert.ok(m, 'spec deny-term array'); return [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]); }
const lit = (v) => /^'(.*)'$/.exec(v)?.[1];
test('seed rows: g_cs_organ_groups holds the 16 §3.1 (code, display, sort_order) rows, g_cs_summary_reject_reasons the 5 §3.2 rows, g_cs_wording_deny_terms the 23 terms of 02-TRD §9.5 (language any for http / www., else en, reason "global wording rule (04 R8)"); equal to the §9 INSERTs; no other INSERT in the smartreport migrations (no library, no tenant data)', () => {
  const sql = sSql(), spec = specDdl();
  for (const t of ['smartreport.g_cs_organ_groups', 'smartreport.g_cs_summary_reject_reasons']) {
    const got = insertRows(sql, t), exp = insertRows(spec, t);
    assert.deepEqual(got.map((r) => Object.values(r).join('|')).sort(), exp.map((r) => Object.values(r).join('|')).sort(), `${t}: seed = spec §9`);
  }
  const og = insertRows(sql, 'smartreport.g_cs_organ_groups'); assert.equal(og.length, 16);
  const tab31 = [...between(spec3(), '### 3.1', '### 3.2').matchAll(/^\| ([a-z_]+) \| ([^|]+) \| (\d+) \|$/gm)].map((m) => `'${m[1]}'|'${m[2].trim()}'|${m[3]}`).sort();
  assert.deepEqual(og.map((r) => [r.code, r.display, r.sort_order].join('|')).sort(), tab31, 'organ groups = §3.1 table');
  const rr = insertRows(sql, 'smartreport.g_cs_summary_reject_reasons'); assert.equal(rr.length, 5);
  assert.deepEqual(rr.map((r) => lit(r.code)).sort(), ['library_error', 'not_appropriate_for_patient', 'other', 'results_under_review', 'wording_problem']);
  // deny terms: either the spec INSERT ... SELECT unnest form (identical text) or 23 literal VALUES rows
  const want = denyTermsSpec(), st = stmts(sql).map(ws).filter((s) => /^INSERT\s+INTO\s+smartreport\.g_cs_wording_deny_terms\b/i.test(s));
  assert.ok(st.length >= 1, 'deny-term seed missing');
  const trd = readFileSync(repo + 'spec/chunks/C14-smart-report/02-TRD.md', 'utf8'), para = /Global seed \(`smartreport\.g_cs_wording_deny_terms`[\s\S]*?Rationale/.exec(trd)[0];
  assert.deepEqual([...para.matchAll(/`([^`]+)`/g)].map((m) => m[1]).slice(1), want, '02-TRD §9.5 list = §9 seed list (23 terms)');
  if (st.length === 1 && /unnest\s*\(\s*ARRAY/i.test(st[0])) assert.equal(norm(st[0]), norm(ws(stmts(specDdl()).find((s) => /INSERT\s+INTO\s+smartreport\.g_cs_wording_deny_terms/i.test(s)))), 'deny-term seed text = spec');
  else {
    const rows = insertRows(sql, 'smartreport.g_cs_wording_deny_terms'); assert.equal(rows.length, 23);
    assert.deepEqual(rows.map((r) => lit(r.term_folded)).sort(), [...want].sort());
    for (const r of rows) { assert.equal(lit(r.term), lit(r.term_folded)); assert.equal(lit(r.language), ['http', 'www.'].includes(lit(r.term_folded)) ? 'any' : 'en'); assert.equal(lit(r.reason), 'global wording rule (04 R8)'); }
  }
  const tables = [...new Set(stmts(sql).map(ws).filter((s) => /^INSERT\s+INTO\b/i.test(s)).map((s) => /INTO\s+(\S+)/i.exec(s)[1]))].sort();
  assert.deepEqual(tables, ['smartreport.g_cs_organ_groups', 'smartreport.g_cs_summary_reject_reasons', 'smartreport.g_cs_wording_deny_terms'], 'no other INSERT in the smartreport migrations');
});

// ================================================================ views: none (§8; IC §6)
test('no published view: IC §6 defines no smartreport.v_pub_* view and C14 publishes none (§8) - the migrations create no view / materialized view and no view grant exists; the view column contract test is therefore vacuous', () => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8');
  assert.doesNotMatch(ic, /\bsmartreport\.v_pub_/, 'IC lists a smartreport.v_pub_* view: this test (and the C14 DDL) must then add its column contract');
  assert.doesNotMatch(strip(sSql()) + polSql(), /\bCREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+|TEMP(?:ORARY)?\s+)?VIEW\b/i); assert.doesNotMatch(sSql() + polSql(), /\bv_pub_/i);
  assert.match(spec8(), /03-IC §6 defines no `smartreport\.v_pub_\*` view/);
});

// ================================================================ hygiene
test('C14 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of other schemas\' tables, no USING (true), no GRANT to PUBLIC; no Storage SQL; no policy admitting patient / portal / partner / device actors (08 A2.3, D-109)', () => {
  const raw = sFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 25000, 'C14 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i); assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics|quality|micro|anatomic|inventory|partners)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016'); assert.doesNotMatch(strip(raw), /\bTO\s+PUBLIC\b/i);
  assert.doesNotMatch(strip(raw) + polSql(), /\bstorage\.(objects|buckets)\b/i, 'no Storage SQL');
  assert.doesNotMatch(polSql() + strip(raw), /current_actor_type\(\)\)\s*(=|IN\s*\()[^)]*'(device|patient|portal|partner)'/i, 'no policy names a non-staff actor');
  assert.doesNotMatch(strip(raw), /\b(Test Patient|SYN-)/, 'no fixtures in migrations');
});
test('LD-202 scope: no wave-1 migration, db/bootstrap, spec, service or app file is changed by this task (only smartreport files + policies + meta + tests are new / edited)', () => {
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', 'db/migrations', 'db/bootstrap', 'spec', 'services', 'apps'], { cwd: repo, encoding: 'utf8' });
  const changed = r.stdout.split('\n').filter(Boolean).filter((f) => !/^db\/migrations\/\d{14}_smartreport__/.test(f));
  assert.deepEqual(changed, [], 'tracked files outside the smartreport migrations were modified');
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts and check-fk-dag.ts exit 0 on the tree; check-migrations.ts exits 0 OR its ONLY violation is the pre-existing C13 one ("partners.manifest_lines: GRANT DELETE to lims_app on a class C table is forbidden", blocking CR .orchestra/cr/T0B-13.C13-manifest-lines-delete.md) - never a line about smartreport (no known spec / gate conflict for C14: no DELETE grant, every __tenant policy carries the staff guard)', () => {
  assert.ok(sFiles().length >= 1, 'C14 migrations missing');
  for (const t of ['check-registry.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
  const m = tool('check-migrations.ts');
  if (m.code !== 0) {
    const bad = m.out.split('\n').filter((l) => /^check-migrations: /.test(l) && !/check-migrations: ok/.test(l));
    assert.ok(bad.length > 0 && bad.every((l) => /_partners__create_partners_schema\.sql: partners\.manifest_lines: GRANT DELETE to lims_app on a class C table is forbidden/.test(l)), `check-migrations (only the pre-existing C13 violation is tolerated):\n${m.out}`);
    assert.doesNotMatch(m.out, /smartreport/i, 'no check-migrations violation may mention smartreport');
    assert.ok(existsSync(root + '.orchestra/cr/T0B-13.C13-manifest-lines-delete.md'), 'the C13 blocking CR documents the tolerated violation');
  }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 11 tenant C14 tables, none for the 3 class G tables, and gen-isolation-probes --check is clean; _registry.sql lists all 14', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const q of G_T) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/smartreport/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-13\.C14_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/smartreport/T0B-13.C14_*.test.sql exist (tester-owned: writer must keep them) and cover the AC list by "AC-0B-x.y" markers, the catalogue checks by "-- C14 check N" markers (1-8) and the 13 spec §10 tests by "-- C14 test N" markers; RLS never disabled; replica mode (if used) reset to origin', () => {
  assert.ok(tapFiles().length >= 2, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 8; n++) assert.match(txt, new RegExp(`-- C14 check ${n}\\b`), `marker for C14 check ${n}`);
  for (let n = 1; n <= 13; n++) assert.match(txt, new RegExp(`-- C14 test ${n}\\b`), `marker for 05-SCHEMA §10 test ${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.1', '6.2', '6.3']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
    const rep = [...s.matchAll(/session_replication_role\s*=\s*replica/gi)].length, org = [...s.matchAll(/session_replication_role\s*=\s*origin/gi)].length;
    assert.ok(rep === 0 || (org >= rep && s.lastIndexOf('= origin') > s.lastIndexOf('= replica')), `${f}: every replica fixture block is reset to origin before assertions`);
  }
});
