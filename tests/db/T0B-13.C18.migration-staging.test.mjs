// T0B-13.C18 static checks of the Wave-3 migration_staging DDL translation: db/migrations/*_migration_staging__*.sql, db/policies/migration_staging.sql, db/meta/tables.yaml, db/tests/rls_exempt.txt.
// Spec: C18 05-SCHEMA §1 (rules, PROPOSED EXCEPTIONS 2/5/6/7/8), §2 (migration part of the role + grants), §3 (inventory, classes), §4 (DDL + 3 mutability triggers + runs_lifecycle_guard), §5 (RLS (a)..(e)), §6 (PHI), §9 (retention), §10 (no view), §11 (no seeds), §12 (11 DB tests);
// C0 05-SCHEMA §9 rule 1 (tenant FK + UNIQUE (tenant_id, id)); 08 A17 P-16 / P-18, A19 D-133 / D-134 / D-136; LD-202 (translate exactly; Appendix B and bootstrap are NOT translated; a gap = blocking CR).
// AC-0B-2.1..2.4, 3.1..3.7 (probes + pgTAP), 4.1..4.3, 5.1..5.3, 6.1..6.4 (6.4 = view column contract: the chunk publishes NO view, so the test proves there is none).
// Run: node --test tests/db/T0B-13.C18.migration-staging.test.mjs   (live: db/tests/migration_staging/T0B-13.C18_schema.test.sql and T0B-13.C18_behaviour.test.sql via pg_prove; generated probes: db/tests/isolation/migration_staging.*.test.sql)
// Method (as T0B-13.C9..C17): the expected DDL is PARSED FROM C18 05-SCHEMA at test time and compared (whitespace/case-normalised) with the migrations. §4 holds literal SQL for every table, index, grant and trigger; §5 holds the policy TEMPLATES (<t>) which are expanded here.
// T0B13C18_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B13C18_ROOT ? resolve(process.env.T0B13C18_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=<>])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').replace(/\bcreate or replace function\b/gi, 'create function').toLowerCase();
const flat = (x) => x.replace(/[()]/g, '');
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const sFiles = () => files().filter((f) => /^\d{14}_migration_staging__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const sSql = () => sFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'migration_staging.sql') ? strip(readFileSync(polDir + 'migration_staging.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C17)
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
  const added = [];
  for (const s of stmts(sql).map(ws)) {
    const a = new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${esc(name)}\\s+(ADD\\s+CONSTRAINT\\b[\\s\\S]*)$`, 'i').exec(s);
    if (a) for (const part of splitTop(a[1])) added.push(part.replace(/^ADD\s+/i, ''));
  }
  const allCons = [...cons, ...added];
  const nameOf = (c) => c.split(/\s+/)[0];
  return { cols, cons: allCons, colNames: cols.map(nameOf), colMap: new Map(cols.map((c) => [nameOf(c), norm(c)])), conMap: new Map(allCons.map((c) => [c.split(/\s+/)[1], norm(c)])) };
}
const idxName = (s) => /INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s)[1];
const createIndexes = (sql) => stmts(sql).filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s)).map(ws);
const createTriggers = (sql) => stmts(sql).filter((s) => /^CREATE\s+TRIGGER\b/i.test(s)).map(ws);
const trgName = (s) => /TRIGGER\s+(\w+)/i.exec(s)[1];
const trgTable = (s) => /\bON\s+([\w.]+)/i.exec(s)[1];
const isAudit = (s) => /(app|audit)\.tg_row_audit\(/i.test(s);
function policies(sql) {
  return stmts(sql).filter((s) => /^CREATE\s+POLICY\s+(?!%)/i.test(ws(s))).map((s) => {
    const m = /^CREATE\s+POLICY\s+(\w+)\s+ON\s+([\w.]+)(?:\s+AS\s+(?:PERMISSIVE|RESTRICTIVE))?\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([\w, ]+?)\s+(?=USING|WITH)([\s\S]*)$/i.exec(ws(s));
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

// ---------------------------------------------------------------- spec extraction (C18 05-SCHEMA)
const specPath = repo + 'spec/chunks/C18-legacy-migration/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = b0 ? s.indexOf(b0, a + a0.length) : s.length; assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const specSec = (a, b) => between(specRaw(), a, b);
const ddlRaw = () => sqlBlocks(specSec('## 4. DDL', '## 5. RLS'));            // §4: 16 tables, 30 indexes, grants, 3 mutability triggers (raw: keeps the PHI comments)
const specDdl = () => strip(ddlRaw());
const rlsRaw = () => sqlBlocks(specSec('## 5. RLS', '## 6. '));                // §5: the (a)..(e) templates

// ---- tables (§3 classes; §4 is the truth for the list)
const CLS = { runs: 'M', run_events: 'A', run_files: 'M', crosswalk_entries: 'M', batches: 'M', reports: 'A', signoffs: 'A', stg_patients: 'E', stg_visits: 'E', stg_results: 'E', stg_documents: 'E', stg_financial: 'E', stg_masters: 'E', match_pairs: 'E', issues: 'E', samples: 'E' };
const T_N = Object.keys(CLS), TENANT = T_N.map((t) => `migration_staging.${t}`);
const NO_UPD = ['run_events', 'reports', 'signoffs', 'issues'];                                                       // §5 (b): append-only + issues
const DEL_RUN = ['stg_patients', 'stg_visits', 'stg_results', 'stg_documents', 'stg_financial', 'stg_masters', 'match_pairs', 'samples'];   // §5 (c): stg_*, match_pairs, samples
const AUDIT_REQ = ['runs', 'run_files', 'crosswalk_entries', 'batches'].map((t) => `migration_staging.${t}`);        // §4 closing comment; §12.8
const NO_AUDIT = [...T_N.filter((t) => CLS[t] === 'E'), 'run_events', 'reports'].map((t) => `migration_staging.${t}`);   // §1.5 + class A; signoffs is left open (§1.5 lists it as audited, §3 and §4 do not)
const MUT_TG = ['runs__mutable_columns', 'batches__mutable_columns', 'run_files__mutable_columns'];
const GUARD = 'migration_staging.runs_lifecycle_guard';
const ROLE = 'lims_migration';
const ALL_STATUS = ['created', 'staging', 'staged', 'validating', 'validated', 'validation_failed', 'dry_running', 'dry_run_passed', 'dry_run_failed', 'approved_for_load', 'loading', 'loaded', 'load_failed', 'verifying', 'verified', 'verify_failed', 'signed_off', 'voiding', 'voided', 'voided_partial', 'abandoned', 'purged'];

// expected policies: the §5 templates expanded per table (53 = 16 select + 16 insert + 12 update + 8 delete + issues delete)
function expectedPolicies() {
  const raw = rlsRaw(), listM = /--\s*\(a\)\s*for each <t> in([\s\S]*?):\s*\n/.exec(raw), lst = listM[1].replace(/--/g, ' ').split(',').map((x) => x.trim()).filter(Boolean);
  assert.deepEqual([...lst].sort(), [...T_N].sort(), '§5 (a) list = the 16 tables of §4');
  const st = stmts(strip(raw)).filter((s) => /^CREATE\s+POLICY/i.test(ws(s)));
  const out = [];
  for (const s of st) {
    const nm = /^CREATE\s+POLICY\s+(\S+)/i.exec(ws(s))[1];
    if (nm.startsWith('<t>')) {
      const cmd = /FOR\s+(SELECT|INSERT|UPDATE|DELETE)/i.exec(ws(s))[1].toUpperCase();
      const tabs = cmd === 'UPDATE' ? T_N.filter((t) => !NO_UPD.includes(t)) : cmd === 'DELETE' ? DEL_RUN : T_N;
      for (const t of tabs) out.push(...policies(s.replace(/<t>/g, t)));
    } else out.push(...policies(s));
  }
  return out;
}
const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('migration_staging.'));

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 16 CREATE TABLE in §4 (all tenant tables, no G, no event_inbox), 30 indexes, 3 mutable-column triggers, no DEFINER, 53 expanded policies (all TO lims_migration), no view, §3 classes match the hard-coded table', () => {
  const ddl = specDdl();
  assert.deepEqual([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].map((m) => m[1]).sort(), [...TENANT].sort(), '§3 inventory rows = §4 tables (16; the brief says "about 20")');
  for (const q of TENANT) assert.ok(createTable(ddl, q), `spec has ${q}`);
  assert.equal(createIndexes(ddl).length, 30, '30 CREATE INDEX in §4');
  assert.deepEqual(createTriggers(ddl).map(trgName).sort(), [...MUT_TG].sort());
  assert.equal(createTriggers(ddl).filter(isAudit).length, 0, 'the spec writes no audit trigger (C0 adds them, closing comment of §4)');
  assert.equal([...ddl.matchAll(/SECURITY\s+DEFINER/gi)].length, 0, 'no DEFINER function in C18 05-SCHEMA (the two DEFINERs used by the tool are C0\'s)');
  const pol = expectedPolicies(); assert.equal(pol.length, 53, '32 select/insert + 12 update + 8 delete + issues delete'); assert.ok(pol.every((p) => p.roles === ROLE && /is_staff_or_system/.test(p.using + p.check)), 'every policy TO lims_migration with the P-16 guard');
  assert.equal(pol.filter((p) => p.cmd === 'UPDATE').length, 12); assert.equal(pol.filter((p) => p.cmd === 'DELETE').length, 9);
  const inv = specSec('## 3. Table inventory', '## 4. DDL').split('\n').filter((x) => /^\| `/.test(x)).map((l) => l.split('|').map((x) => x.trim()));
  assert.equal(inv.length, 16); for (const c of inv) assert.equal(c[2][0], CLS[/`(\w+)`/.exec(c[1])[1]], `§3 class of ${c[1]}`);
  assert.deepEqual([...ddl.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\b/gi)], [], 'no view in the chunk DDL');
  assert.match(specSec('## 10. ', '## 11. '), /None\./); assert.match(specSec('## 11. ', '## 12. '), /None in production/);
  assert.equal(specSec('## 12. ', '## Appendix A').split('\n').filter((l) => /^\d+\. /.test(l)).length, 11, '§12 lists 11 DB tests');
});

// ================================================================ files, order (AC-0B-6.1 / 6.3)
const WAVE = /_(quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection|migration_staging)__/;
const BEFORE = /_(quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection)__/;
test('migration files: >= 1 *_migration_staging__*.sql, timestamps strictly after 20261114120000 (LD-202), after every wave-1 migration and after the quality ... homecollection migrations (db/meta/dag.yaml: migration_staging is last), unique; db/policies/migration_staging.sql exists; schema creation IF NOT EXISTS', () => {
  assert.ok(sFiles().length >= 1, 'no db/migrations/*_migration_staging__*.sql yet (T0B-13.C18 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => !WAVE.test(f)), before = all.filter((f) => BEFORE.test(f));
  assert.ok(earlier.length >= 24, 'wave-1 migrations present'); assert.ok(before.length >= 9, 'quality ... homecollection migrations present');
  for (const f of sFiles()) {
    assert.ok(f.slice(0, 14) > '20261114120000', `${f} must be later than 20261114120000`);
    for (const e of [...earlier, ...before]) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (migration_staging comes last in the DAG)`);
  }
  assert.ok(existsSync(polDir + 'migration_staging.sql'), 'db/policies/migration_staging.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(sSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)migration_staging\b/i, 'schema migration_staging exists since T0B-01');
});
test('AC-0B-6.3: the first statement of every migration_staging migration is SET LOCAL ROLE lims_owner and it is the only role switch; no CREATE ROLE / ALTER ROLE (the role is bootstrap, §2; LD-202 (c)), no CREATE EXTENSION, no standing CREATE grant', () => {
  assert.ok(sFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+|SET\s+SESSION\s+AUTHORIZATION)/gi)].map((m) => ws(m[1]).toUpperCase());
  for (const f of sFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch`);
  }
  assert.doesNotMatch(sSql(), /GRANT\s+CREATE\s+ON\s+(SCHEMA\s+app|DATABASE)/i); assert.doesNotMatch(sSql(), /CREATE\s+ROLE|ALTER\s+ROLE|GRANT\s+lims_app\s+TO/i); assert.doesNotMatch(sSql(), /CREATE\s+EXTENSION/i);
});
test('LD-202 (a): the role prerequisite is explicit. db/bootstrap/00_roles.sql still reserves lims_migration (CR-C18-001 DEFER B4), so either a founder-resolved bootstrap creates it or a blocking CR .orchestra/cr/T0B-13.C18*.md exists (migrations cannot create it: policies TO lims_migration fail on an empty database without the role)', () => {
  const boot = readFileSync(root + 'db/bootstrap/00_roles.sql', 'utf8');
  const created = /CREATE\s+ROLE\s+lims_migration\b/i.test(strip(boot));
  const cr = existsSync(root + '.orchestra/cr') && readdirSync(root + '.orchestra/cr').some((f) => /^T0B-13\.C18.*\.md$/.test(f));
  assert.ok(created || cr, 'lims_migration is not created in db/bootstrap and no .orchestra/cr/T0B-13.C18*.md blocking CR exists (LD-202 (a): write the CR using the template of spec/program/04-CHANGE-REQUESTS.md)');
});

// ================================================================ tables (columns + constraints = spec exactly; C0 may add only a tenant FK, C0 05-SCHEMA §9 rule 1)
for (const q of TENANT) {
  test(`${q}: every spec column + constraint (name + text) present identically in the migration (incl. the ALTER ... ADD CONSTRAINT of match_pairs); no extra column; only a tenant FK (<t>__tenant__fk) may be added (§4; C0 §9 rule 1)`, () => {
    const specT = createTable(specDdl(), q); assert.ok(specT, `spec table ${q}`);
    const sql = sSql(), got = createTable(sql, q), t = q.split('.')[1];
    assert.ok(got, `CREATE TABLE ${q} not found in *_migration_staging__*.sql`);
    for (const [c, def] of specT.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    for (const c of got.colMap.keys()) assert.ok(specT.colMap.has(c), `${q}: extra column ${c} (the spec DDL is complete)`);
    for (const [c, def] of specT.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    for (const [c, def] of got.conMap) if (!specT.conMap.has(c)) {
      assert.equal(def.replace(/^constraint\s+\w+\s+/, ''), 'foreign key(tenant_id)references core.tenants(id)', `${q}: extra constraint ${c} (only the C0 tenant FK may be added)`);
      assert.equal(c, `${t}__tenant__fk`, `${q}: added tenant FK name`);
    }
    const bodies = [...got.conMap.values()].map((d) => d.replace(/^constraint\s+\w+\s+/, ''));
    assert.ok(bodies.includes('foreign key(tenant_id)references core.tenants(id)'), `${q}: tenant FK to core.tenants (C0 §9 rule 1)`);
    assert.ok(bodies.includes('unique(tenant_id,id)'), `${q}: UNIQUE (tenant_id, id) (04 D8)`);
    assert.match(got.colMap.get('tenant_id'), /^tenant_id uuid not null$/, `${q}.tenant_id: uuid NOT NULL, no default (§1.1)`);
  });
}
test('exactly the 16 §4 tables are created in migration_staging (no event_inbox: §1.9); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9); table count == spec count (the impl note states both); Appendix B owner tables are NOT created and no owner schema is altered (§1.7, LD-202 (b))', () => {
  const sql = sSql(), bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...TENANT].sort());
  assert.equal(made.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'migration CREATE TABLE count == spec CREATE TABLE count (16 == 16)');
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(bare, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /event_inbox/i, 'no event_inbox (§1.9)');
  assert.doesNotMatch(sql, /patient_legacy_refs|legacy_results|legacy_documents/i, 'Appendix B (proposed owner DDL) is not translated');
  for (const q of TENANT) for (const c of ['id', 'tenant_id']) { const def = createTable(sql, q)?.colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT`); }
});
test('cross-schema references (§1.8, 01-CM §5 R3): migration_staging FKs point only into migration_staging, core.tenants and core.collection_centres (identical to the spec); no FK into any module schema; nothing upstream references migration_staging; plain-uuid target ids carry no FK (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(sSql()), exp = tgt(specDdl());
  for (const t of exp) got.has(t) || assert.fail(`FK target ${t} missing`);
  for (const t of got) assert.match(t, /^(migration_staging\.\w+|core\.tenants|core\.collection_centres)$/, `FK target ${t}`);
  const dag = readFileSync(root + 'db/meta/dag.yaml', 'utf8'), m = /"migration_staging"\s*:\s*\[([^\]]*)\]/.exec(dag); assert.ok(m, 'dag.yaml row for migration_staging');
  const allowed = new Set([...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]).concat('migration_staging'));
  for (const t of got) assert.ok(allowed.has(t.split('.')[0]), `FK target ${t}: schema allowed by dag.yaml`);
  assert.doesNotMatch(files().filter((f) => !/_migration_staging__/.test(f)).map(read).join('\n'), /\bREFERENCES\s+migration_staging\./i, 'no FK into migration_staging from another schema');
  const t2 = createTable(sSql(), 'migration_staging.stg_patients').colNames; assert.ok(t2.includes('target_patient_id')); assert.doesNotMatch(createTable(sSql(), 'migration_staging.stg_patients').cons.join(' '), /target_patient_id/);
});
test('indexes: every §4 CREATE INDEX present with identical definition (30), no other index; tenant_id leads every index and every UNIQUE / PRIMARY KEY (except PRIMARY KEY (id)); every __p_ index is partial; runs__tenant_id_active_writer__p_uq is UNIQUE on (tenant_id) WHERE status IN (loading, voiding)', () => {
  const sql = sSql(), have = new Map(createIndexes(sql).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].filter((n) => !exp.some((s) => idxName(s) === n)), [], 'no index beyond the spec DDL');
  for (const [n, s] of have) if (/__p_(uq|idx)$/.test(n)) assert.match(s, /\bwhere\b/, `${n} is a partial index`);
  for (const s of createIndexes(sql)) assert.equal(/\bON\s+\w+\.\w+\s*(?:USING\s+\w+\s*)?\(\s*([^,)]+)/i.exec(s)[1].trim(), 'tenant_id', `index ${idxName(s)} leads with tenant_id`);
  for (const q of TENANT) for (const [cn, c] of createTable(sql, q).conMap) if (/\b(primary key|unique)\(/.test(c)) {
    const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1]; if (/primary key/.test(c) && k === 'id') continue;
    assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${cn} ${c}`);
  }
  assert.match(have.get('runs__tenant_id_active_writer__p_uq'), /^create unique index runs__tenant_id_active_writer__p_uq on migration_staging\.runs\(tenant_id\) ?where status in\('loading','voiding'\)$/);
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; §1.2, §5; 08 A17 P-16)
test('ENABLE + FORCE ROW LEVEL SECURITY as literal statements (no DO block / format()) on all 16 tables; no exempt table; RLS never disabled (AC-0B-2.1 / 2.4)', () => {
  const sql = sSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(sSql(), /\bDO\s+\$/i, 'literal statements only'); assert.doesNotMatch(polSql(), /\bDO\s+\$/i); assert.doesNotMatch(sSql() + polSql(), /EXECUTE\s+format\s*\(/i);
});
test('policies: the 53 policies of §5 (a)..(e) expanded per table (select + insert on 16, update on 12 (not run_events / reports / signoffs / issues), delete on stg_* / match_pairs / samples with the run-state + purge_not_before + early_purge_approval condition, issues delete without it) are present with identical name, command, role lims_migration, USING and WITH CHECK; no other policy exists; no FOR ALL', () => {
  const got = gotPolicies(), byKey = new Map(got.map((p) => [p.key, p])); assert.ok(got.length > 0, 'db/policies/migration_staging.sql has no CREATE POLICY'); assert.equal(byKey.size, got.length, 'no duplicate policy');
  const exp = expectedPolicies();
  for (const e of exp) { const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`); assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, ROLE, `${e.key} role`); assert.equal(flat(g.using), flat(e.using), `${e.key} USING`); assert.equal(flat(g.check), flat(e.check), `${e.key} WITH CHECK`); }
  assert.deepEqual(got.map((p) => p.key).sort(), exp.map((e) => e.key).sort(), 'no policy beyond the spec'); assert.equal(got.length, 53);
  assert.equal(got.filter((p) => p.cmd === 'ALL').length, 0, 'no FOR ALL policy');
  for (const t of NO_UPD) assert.equal(got.filter((p) => p.table === `migration_staging.${t}` && p.cmd === 'UPDATE').length, 0, `${t}: no UPDATE policy (append-only / recomputed)`);
  for (const t of T_N.filter((x) => !DEL_RUN.includes(x) && x !== 'issues')) assert.equal(got.filter((p) => p.table === `migration_staging.${t}` && p.cmd === 'DELETE').length, 0, `${t}: no DELETE policy (permanent)`);
});
test('policy shape (§1.2, §5, 08 A17 P-16): every policy is TO lims_migration only (never lims_app / PUBLIC), carries tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) in each USING / WITH CHECK, no centre predicate, no open predicate; the 8 purge DELETE policies bind to the run state (signed_off / voided / voided_partial / abandoned), purge_not_before and the early_purge_approval signoff; names <table>__<cmd>__tenant', () => {
  const ps = gotPolicies();
  for (const p of ps) {
    assert.equal(p.roles, ROLE, `${p.key}: TO lims_migration only`);
    assert.match(p.name, new RegExp(`^${p.table.split('.')[1]}__${p.cmd.toLowerCase()}__tenant$`), `${p.key}: name <table>__<cmd>__tenant`);
    for (const x of [p.using, p.check].filter(Boolean)) {
      assert.match(x, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: tenant predicate`); assert.match(x, /\(select app\.is_staff_or_system\(\)\)/, `${p.key}: P-16 staff guard in each clause`);
      assert.doesNotMatch(x, /current_centre_ids|has_all_centres|\btrue\b\s*$|^true$|\bpublic\b|\banon\b|\bauthenticated\b|current_partner_id|current_patient_id/, `${p.key}: no centre / open predicate`);
    }
    if (p.cmd === 'UPDATE') assert.ok(p.using && p.check, `${p.key}: USING and WITH CHECK`);
  }
  for (const t of DEL_RUN) {
    const d = ps.find((p) => p.key === `${t}__delete__tenant@migration_staging.${t}`); assert.ok(d, `${t} DELETE policy`);
    for (const k of ['migration_staging.runs', `r.id=${t}.run_id`, `r.tenant_id=${t}.tenant_id`, "'signed_off','voided','voided_partial','abandoned'", 'r.purge_not_before is null', 'r.purge_not_before<=now()', 'migration_staging.signoffs', "s.kind='early_purge_approval'"]) assert.ok(d.using.includes(k), `${t} DELETE mentions ${k}`);
    assert.doesNotMatch(d.using, /'loaded'|'loading'|'verified'/, `${t}: DELETE never admits a run in loaded / loading / verified`);
  }
  const iss = ps.find((p) => p.key === 'issues__delete__tenant@migration_staging.issues'); assert.ok(iss); assert.doesNotMatch(iss.using, /\bruns\b|purge_not_before/, 'issues DELETE has no run-state condition (validate recomputes the issues, §5 (d))');
});
test('policies written literally in migrations are identical to db/policies/migration_staging.sql (AC-0B-2.3 copy); every policy of the file is created by a migration and vice versa', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(sSql()).filter((x) => x.table.startsWith('migration_staging.'));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort());
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §2, §4 grant lines)
test('table grants equal the §4 grant lines exactly (runs, run_files, crosswalk_entries, batches S I U; run_events, reports, signoffs S I; stg_* , match_pairs, samples S I U D; issues S I D) and go to lims_migration ONLY; no TRUNCATE / REFERENCES / TRIGGER, no column grants, nothing to lims_app / lims_api / lims_worker / lims_analytics / anon / authenticated / PUBLIC (AC-0B-4.2 / 4.3, §1.1)', () => {
  const sql = sSql() + '\n;\n' + polSql(), g = grantsOf(sql), exp = grantsOf(specDdl());
  assert.equal(exp.size, 16, 'spec has 16 table grant lines');
  for (const [q, rm] of exp) assert.deepEqual([...(g.get(q)?.get(ROLE)?.all ?? [])].sort(), [...rm.get(ROLE).all].sort(), `${q}: ${ROLE} privileges = §4`);
  for (const [q, rm] of g) if (/^migration_staging\./.test(q)) {
    assert.ok(new Set(TENANT).has(q), `${q}: unexpected grant target`);
    for (const [r, p] of rm) {
      assert.equal(r, ROLE, `${q}: unexpected grantee ${r}`);
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!p.all.has(bad) && !p.cols.has(bad), `${q}: ${r} must not hold ${bad}`);
      assert.equal(p.cols.size, 0, `${q}: whole-table grants only`);
    }
  }
  for (const t of NO_UPD) assert.ok(!g.get(`migration_staging.${t}`).get(ROLE).all.has('UPDATE'), `${t}: no UPDATE grant (append-only, §12.4)`);
  for (const t of T_N.filter((x) => !DEL_RUN.includes(x) && x !== 'issues')) assert.ok(!g.get(`migration_staging.${t}`).get(ROLE).all.has('DELETE'), `${t}: no DELETE grant (permanent)`);
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\bmigration_staging\./i); assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+migration_staging\b/i); assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bmigration_staging\b/i);
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\bmigration_staging\b/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_app|lims_api|lims_worker|lims_owner|lims_analytics)\b/i, s);
});
test('schema + function grants of §2 (migration part): GRANT USAGE ON SCHEMA migration_staging TO lims_migration; GRANT EXECUTE ON app.core_resolve_tenant_code(text) and app.cron_tenant_ids() TO lims_migration; no other EXECUTE / schema grant to lims_migration (§12.11 "and no other DEFINER"); definer-inventory.yaml execute lists contain lims_migration iff the migration grants it (D-134)', () => {
  const st = stmts(sSql() + '\n;\n' + polSql()).map(ws), toMig = st.filter((s) => /^GRANT\b/i.test(s) && new RegExp(`\\bTO\\s+${ROLE}\\b`, 'i').test(s) && !/\bON\s+(TABLE\s+)?migration_staging\.\w+\s+TO\b/i.test(s));
  assert.deepEqual(toMig.map((s) => s.replace(/;$/, '')).sort(), ['GRANT EXECUTE ON FUNCTION app.core_resolve_tenant_code(text) TO lims_migration', 'GRANT EXECUTE ON FUNCTION app.cron_tenant_ids() TO lims_migration', 'GRANT USAGE ON SCHEMA migration_staging TO lims_migration'].sort(), 'exactly the 3 non-table grants of §2');
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  for (const f of ['app.core_resolve_tenant_code', 'app.cron_tenant_ids']) assert.ok(inv[f].execute.includes(ROLE), `${f}: definer-inventory execute list includes ${ROLE} (D-134, added with the grant)`);
  assert.ok(!sSql().includes('app.maintenance'), 'no new maintenance GUC / owner policy in C18');
});

// ================================================================ functions + triggers (AC-0B-4.1; §4 triggers, runs_lifecycle_guard, §12.5 / 12.6)
test('no SECURITY DEFINER function and no new function in schema app is created by the C18 migrations; the only function created is migration_staging.runs_lifecycle_guard (C0-written, SECURITY INVOKER, search_path = \'\', RAISE P0001); no DEFINER-inventory row for migration_staging (the chunk has no DEFINER)', () => {
  const sql = sSql();
  assert.equal([...sql.matchAll(/SECURITY\s+DEFINER/gi)].length, 0, 'no SECURITY DEFINER');
  assert.deepEqual(fnNames(sql), [GUARD], 'only the lifecycle guard is created');
  const body = fnText(sql, GUARD); assert.ok(body, `${GUARD} missing (05-SCHEMA §4 closing paragraph)`);
  assert.match(body, /SET\s+search_path\s*=\s*''/i); assert.doesNotMatch(body, /SECURITY\s+DEFINER/i); assert.match(body, /ERRCODE\s*=\s*'P0001'/, 'raises P0001 (02-CV §5.7)'); assert.match(body, /RETURNS\s+trigger/i);
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  assert.deepEqual(Object.keys(inv).filter((k) => /migration_staging/.test(k)), [], 'no migration_staging DEFINER row');
  for (const [k, e] of Object.entries(inv)) assert.doesNotMatch(JSON.stringify(e.touches ?? []), /migration_staging\./, `${k}: no DEFINER touches migration_staging`);
});
test('triggers: the 3 §4 mutable-column triggers equal the spec statements (runs, batches, run_files; the immutable columns tenant_id / kind / run_id / created_* are in no list); one C0 BEFORE UPDATE FOR EACH ROW lifecycle trigger on runs calling migration_staging.runs_lifecycle_guard() that knows the 22 statuses and the T1..T22 targets; nothing else besides the audit triggers; none disabled or dropped (AC-0B-4.1, §12.5, §12.6)', () => {
  const sql = sSql(), all = createTriggers(sql), trg = all.filter((s) => !isAudit(s)), exp = createTriggers(specDdl());
  for (const s of exp) { const hit = trg.find((x) => trgName(x) === trgName(s)); assert.ok(hit, `trigger ${trgName(s)} missing`); assert.equal(norm(hit), norm(s), `trigger ${trgName(s)}`); }
  const extra = trg.filter((s) => !MUT_TG.includes(trgName(s)));
  assert.equal(extra.length, 1, 'exactly one extra trigger: the runs lifecycle guard'); assert.equal(trgTable(extra[0]), 'migration_staging.runs');
  assert.match(extra[0], /\bBEFORE UPDATE\b[^;]*\bON migration_staging\.runs FOR EACH ROW EXECUTE FUNCTION migration_staging\.runs_lifecycle_guard\(\)/i);
  const body = fnText(sql, GUARD) ?? ''; for (const s of ALL_STATUS) assert.ok(body.includes(`'${s}'`), `guard mentions status ${s}`);
  for (const t of all) assert.match(t, /\bON migration_staging\.\w+\b/i);
  assert.doesNotMatch(sql, /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(sql, /DROP\s+TRIGGER\b/i);
  const cols = (n) => [...exp.find((s) => trgName(s) === n).matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
  for (const c of ['id', 'tenant_id', 'run_code', 'source_system', 'kind', 'is_rehearsal', 'parent_run_id', 'created_at', 'created_by']) assert.ok(!cols('runs__mutable_columns').includes(c), `runs.${c} immutable`);
  for (const c of ['id', 'tenant_id', 'run_id', 'entity', 'seq', 'row_count', 'content_sha256', 'created_at', 'created_by']) assert.ok(!cols('batches__mutable_columns').includes(c), `batches.${c} immutable`);
  for (const c of ['id', 'tenant_id', 'run_id', 'path', 'file_kind', 'sha256', 'rows_expected', 'created_at', 'created_by']) assert.ok(!cols('run_files__mutable_columns').includes(c), `run_files.${c} immutable`);
});
test('audit triggers (§1.5, §4 closing comment, §12.8): <t>__audit AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit() on runs, run_files, crosswalk_entries, batches; NEVER on stg_*, match_pairs, issues, samples (PROPOSED EXCEPTION §1.5) nor run_events / reports; signoffs is open (§1.5 lists it audited, §3 / §4 / class A say not) but tables.yaml must agree with the DDL', () => {
  const trg = createTriggers(sSql()).filter(isAudit), onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of AUDIT_REQ) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+(app|audit)\\.tg_row_audit\\(`, 'i'), q);
    const a = [...(/tg_row_audit\(([^)]*)\)/i.exec(hit[0])[1].matchAll(/'([a-z_0-9]+)'/g))].map((m) => m[1]), cols = createTable(sSql(), q).colNames;
    for (const c of a) assert.ok(cols.includes(c), `${q}: excluded column ${c} exists`);
  }
  for (const q of NO_AUDIT) assert.equal(onTable(q).length, 0, `${q} must NOT be audited (§1.5 / class A)`);
  assert.ok(trg.length === 4 || (trg.length === 5 && onTable('migration_staging.signoffs').length === 1), 'no audit trigger beyond the 4 (signoffs aside)');
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const MAND = { M: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'is_active'], A: ['id', 'tenant_id', 'created_at', 'created_by'], E: ['id', 'tenant_id', 'created_at', 'expires_at'] };
function phiSpec() {   // column -> max P class named in the column's trailing comment of the §4 DDL (single-column or two-column lines); e.g. "-- P0; P2 for kind 'doctor'" -> P2
  const out = new Map(); let table = null;
  for (const l of ddlRaw().split('\n')) {
    const t = /CREATE\s+TABLE\s+migration_staging\.(\w+)/i.exec(l); if (t) { table = t[1]; continue; }
    const m = /^\s*([a-z_0-9]+\s+[^-]*?)\s*(?:--\s*(.*))?$/.exec(l); if (!table || !m || !m[2] || /^\s*CONSTRAINT/i.test(l)) continue;
    const ps = [...m[2].matchAll(/\bP([0-3])\b/g)].map((x) => +x[1]); if (!ps.length) continue;
    const names = splitTop(m[1].replace(/,\s*$/, '')).map((d) => /^([a-z_0-9]+)\s+(uuid|text|jsonb|date|numeric|bigint|integer|boolean|timestamptz|smallint)/i.exec(d)?.[1]).filter(Boolean);
    for (const n of names) out.set(`${table}.${n}`, `P${Math.max(...ps)}`);
  }
  return out;
}
test('tables.yaml: all 16 migration_staging tables registered (class per §3, centre_scoped false, audited = trigger, retention, shared_with [] everywhere (P-16: no partner / portal / patient actor), columns = the migration columns, phi_class P0..P3, created_by / updated_by P1); the count equals the CREATE TABLE count; no rls_exempt; policy_role (if recorded) = lims_migration', () => {
  const y = tablesYaml(), regs = Object.keys(y).filter((k) => /^migration_staging\./.test(k));
  assert.equal(regs.length, 16, 'tables.yaml migration_staging entries'); assert.equal(regs.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'tables.yaml count == chunk DDL count (16 == 16)');
  const trgAudited = (q) => createTriggers(sSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of TENANT) {
    const e = y[q], t = q.split('.')[1]; assert.ok(e && createTable(sSql(), q), `${q} in tables.yaml and migrations`);
    assert.equal(e.class, CLS[t], `${q} class (§3)`); assert.equal(e.centre_scoped, false, `${q} centre_scoped (§5: no centre-scoped policy)`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), createTable(sSql(), q).colNames.sort(), `${q} columns = migration columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
    for (const c of ['created_by', 'updated_by']) if (e.columns[c]) assert.equal(e.columns[c], 'P1', `${q}.${c}`);
    assert.deepEqual([...(e.shared_with ?? [])], [], `${q}: shared_with empty (§1.2: no staging table is shared with partner / portal / patient actors)`);
    assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    if ('policy_role' in e) assert.equal(e.policy_role, ROLE, `${q}: policy_role (§1.2)`);
  }
  for (const q of AUDIT_REQ) assert.equal(y[q].audited, true);
});
test('tables.yaml phi_class (§6): every column that §4 labels P0..P3 in its comment is registered at exactly that class (max class of the comment: legacy keys / names / phones P2, results values + titles P3, ids P1); stg_results value columns P3; stg_documents.title P3; crosswalk_entries.legacy_display P2; stg_masters.payload P2', () => {
  const y = tablesYaml(), spec = phiSpec(); assert.ok(spec.size > 60, `spec comment classes parsed (${spec.size})`);
  for (const [k, p] of spec) { const [t, c] = k.split('.'); assert.equal(y[`migration_staging.${t}`]?.columns?.[c], p, `${k}: ${p} (§4 comment / §6)`); }
  for (const c of ['legacy_test_code', 'legacy_analyte_code', 'analyte_display_name', 'value_raw', 'value_numeric', 'value_text', 'ordinal_raw', 'ref_low', 'ref_high', 'ref_text', 'flag_raw', 'comment_text', 'ref_low_target', 'ref_high_target']) assert.match(y['migration_staging.stg_results'].columns[c], /^P3$|^P[0-3]$/, `stg_results.${c}`);
  for (const c of ['legacy_test_code', 'legacy_analyte_code', 'analyte_display_name', 'value_raw', 'value_numeric', 'value_text', 'ordinal_raw', 'ref_low', 'ref_high', 'ref_text', 'flag_raw', 'comment_text']) assert.equal(y['migration_staging.stg_results'].columns[c], 'P3', `stg_results.${c} P3 (§6)`);
  assert.equal(y['migration_staging.stg_documents'].columns.title, 'P3'); assert.equal(y['migration_staging.crosswalk_entries'].columns.legacy_display, 'P2'); assert.equal(y['migration_staging.stg_masters'].columns.payload, 'P2');
  for (const c of ['legacy_patient_key', 'legacy_patient_code', 'full_name', 'name_norm', 'phone_e164_norm', 'birth_on_effective']) assert.equal(y['migration_staging.stg_patients'].columns[c], 'P2', `stg_patients.${c} P2 (§6)`);
  assert.equal(y['migration_staging.stg_documents'].columns.file_path, 'P2'); assert.equal(y['migration_staging.signoffs'].columns.lab_signatory_display, 'P2');
  for (const c of ['amount_paisa', 'gross_paisa']) assert.match(y['migration_staging.stg_financial'].columns[c], /^P[2-3]$/, `stg_financial.${c}: financial, restricted (>= P2)`);
  for (const c of ['target_patient_id', 'batch_id']) assert.equal(y['migration_staging.stg_patients'].columns[c], 'P1', `stg_patients.${c} P1 (§6 ids)`);
});
test('tables.yaml mandatory-column exceptions (§1.6, P-18(b)): the 9 class-E tables list exactly expires_at (with a reason: expiry per run, purge_not_before); the 7 class M / A tables have none; the DDL carries every other class-mandatory column (M id..is_active, A id / tenant / created_*, E id / tenant_id / created_at)', () => {
  const y = tablesYaml();
  for (const q of TENANT) {
    const e = y[q], t = q.split('.')[1], cls = CLS[t], cols = new Set(createTable(sSql(), q).colNames);
    if (cls === 'E') { assert.deepEqual([...(e.mandatory_column_exceptions ?? [])], ['expires_at'], `${q}: exception expires_at only`); assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 10, `${q}: exception reason`); assert.ok(!cols.has('expires_at'), `${q}: no expires_at column (§1.6)`); }
    else assert.deepEqual([...(e.mandatory_column_exceptions ?? [])], [], `${q}: no mandatory-column exception`);
    assert.deepEqual(MAND[cls].filter((c) => !cols.has(c) && !(e.mandatory_column_exceptions ?? []).includes(c)), [], `${q}: carries every class-${cls} mandatory column`);
  }
});
test('tables.yaml retention (§3, §9): the 9 class-E tables are purged with their run (purge), the 7 permanent tables stay (permanent / audit retention); db/tests/rls_exempt.txt lists NO migration_staging table (all 16 are tenant tables with RLS)', () => {
  const y = tablesYaml(), r = (q) => String(y[`migration_staging.${q}`].retention);
  for (const t of T_N.filter((x) => CLS[x] === 'E')) assert.match(r(t), /purge/i, `${t}: purged with the run`);
  for (const t of T_N.filter((x) => CLS[x] !== 'E')) assert.match(r(t), /permanent|never|audit|5 years|forever/i, `${t}: permanent`);
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines.filter((l) => /^migration_staging\./.test(l)), []);
});

// ================================================================ seeds, views (§10, §11; AC-0B-6.4)
test('no seed data and no view (§10 "None. Nothing outside C18 reads migration_staging", §11 "None in production"): no INSERT in the migrations, no CREATE VIEW / MATERIALIZED VIEW, no v_pub_*; 03-IC §6 lists no migration_staging view; tables.yaml registers none (AC-0B-6.4: the view column contract is vacuous)', () => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8');
  assert.doesNotMatch(ic, /\|\s*`migration_staging\.v_pub_/, 'IC §6 has no migration_staging published view');
  const sql = sSql() + polSql();
  assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\b/i, 'no view'); assert.doesNotMatch(sql, /v_pub_/i);
  assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i, 'no seed rows (the migration system actor row of CR-C18-001 is not part of this task)');
  assert.deepEqual(Object.keys(tablesYaml()).filter((k) => /^migration_staging\.v_/.test(k)), []);
});

// ================================================================ hygiene
test('C18 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS / SUPERUSER, no edits of other schemas\' tables, no USING (true), no GRANT to PUBLIC, no Storage SQL, no auth.* reference; nothing created in schema app', () => {
  const raw = sFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 25000, 'C18 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i); assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics|quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection|app)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016'); assert.doesNotMatch(strip(raw), /\bTO\s+PUBLIC\b/i);
  assert.doesNotMatch(strip(raw) + polSql(), /\bstorage\.(objects|buckets)\b/i); assert.doesNotMatch(strip(raw), /\bauth\./i, 'REQ-SEC-038');
  assert.deepEqual([...strip(raw).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TABLE|TRIGGER|INDEX|UNIQUE INDEX|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?app\.(\w+)/gi)].map((m) => m[1]), [], 'nothing is created in schema app');
});
test('LD-202 scope: no wave-1 migration, db/bootstrap, spec, service or app file is changed by this task (only migration_staging files + policies + meta + tests are new / edited)', () => {
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', 'db/migrations', 'db/bootstrap', 'spec', 'services', 'apps'], { cwd: repo, encoding: 'utf8' });
  const changed = r.stdout.split('\n').filter(Boolean).filter((f) => !/^db\/migrations\/\d{14}_migration_staging__/.test(f));
  assert.deepEqual(changed, [], 'tracked files outside the migration_staging migrations were modified');
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-fk-dag.ts exits 0; check-migrations.ts exits 0 OR its ONLY violation is the pre-existing C13 one (partners.manifest_lines DELETE grant, blocking CR T0B-13.C13-manifest-lines-delete.md) and no line mentions migration_staging; check-registry.ts exits 0 (every C18 policy carries the staff guard, so no friction is tolerated)', () => {
  assert.ok(sFiles().length >= 1, 'C18 migrations missing');
  const f = tool('check-fk-dag.ts'); assert.equal(f.code, 0, `check-fk-dag.ts:\n${f.out}`);
  const m = tool('check-migrations.ts');
  if (m.code !== 0) {
    const bad = m.out.split('\n').filter((l) => /^check-migrations: /.test(l) && !/check-migrations: ok/.test(l));
    assert.ok(bad.length > 0 && bad.every((l) => /_partners__create_partners_schema\.sql: partners\.manifest_lines: GRANT DELETE to lims_app on a class C table is forbidden/.test(l)), `check-migrations (only the pre-existing C13 violation is tolerated):\n${m.out}`);
    assert.doesNotMatch(m.out, /migration_staging/i, 'no check-migrations violation may mention migration_staging'); assert.ok(existsSync(root + '.orchestra/cr/T0B-13.C13-manifest-lines-delete.md'));
  }
  const r = tool('check-registry.ts'); assert.equal(r.code, 0, `check-registry.ts:\n${r.out}`);
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 16 C18 tables and gen-isolation-probes --check is clean; _registry.sql lists all 16', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of TENANT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/migration_staging/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-13\.C18_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/migration_staging/T0B-13.C18_schema.test.sql and T0B-13.C18_behaviour.test.sql exist (tester-owned: the writer must keep them), cover the AC list by "AC-0B-x.y" markers, the catalogue checks by "-- C18 check N" markers (1-8) and the 11 §12 tests by "-- C18 T<n>" markers; RLS never disabled; replica mode (statements only) reset to origin; BEGIN / finish / ROLLBACK', () => {
  assert.deepEqual(tapFiles().sort(), ['T0B-13.C18_behaviour.test.sql', 'T0B-13.C18_schema.test.sql']);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 8; n++) assert.match(txt, new RegExp(`-- C18 check ${n}\\b`), `marker for C18 check ${n}`);
  for (let n = 1; n <= 11; n++) assert.match(txt, new RegExp(`-- C18 T${n}\\b`), `marker for the §12 test ${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.1', '6.2', '6.3', '6.4']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8'), stmtsOnly = s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    assert.doesNotMatch(stmtsOnly, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
    const rep = [...stmtsOnly.matchAll(/^\s*SET\s+LOCAL\s+session_replication_role\s*=\s*replica/gim)].length, org = [...stmtsOnly.matchAll(/^\s*SET\s+LOCAL\s+session_replication_role\s*=\s*origin/gim)].length;
    assert.ok(rep === 0 || (org >= rep && stmtsOnly.lastIndexOf('= origin') > stmtsOnly.lastIndexOf('= replica')), `${f}: every replica fixture block is reset to origin before assertions`);
  }
  const bh = readFileSync(TD + 'T0B-13.C18_behaviour.test.sql', 'utf8');
  for (const k of ['lims_migration', 'early_purge_approval', 'immutable_row', 'runs_lifecycle_guard', 'lab_form_reference', 'core_resolve_tenant_code', 'cron_tenant_ids', 'partner', 'portal', 'patient', 'purge_not_before']) assert.ok(bh.includes(k), `behaviour suite covers ${k}`);
});
