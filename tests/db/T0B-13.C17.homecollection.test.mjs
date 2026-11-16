// T0B-13.C17 static checks of the Wave-3 homecollection DDL translation: db/migrations/*_homecollection__*.sql, db/policies/homecollection.sql, db/meta/tables.yaml, db/meta/definer-inventory.yaml, db/tests/rls_exempt.txt.
// Spec: C17 05-SCHEMA Part A: §1 (inventory, class, scope, mandatory columns, actor guard P-16), §2 (coded sets, CHECK values), §3 (columns, PHI), §4 (DDL), §4.1 (RLS DO block + literal policies + grants), §4.2 (the one DEFINER, 4 owner policies, T1..T5), §6 (retention), §7 (seeds = fixtures, not migrations);
// C0 05-SCHEMA §9 rule 1 (tenant FK + UNIQUE (tenant_id, id)); 03-IC §6 (no homecollection view); 08 A10.5, A12.2, A12.7, A16.1, A17 P-16 / P-18, A19 P-41 / D-125 / D-130; LD-202 (translate exactly, a gap = blocking CR).
// AC-0B-2.1..2.4, 3.1..3.7 (probes + pgTAP), 4.1..4.3, 5.1..5.3, 6.1..6.4 (6.4 = view column contract: the chunk publishes NO view, so the test proves there is none).
// Run: node --test tests/db/T0B-13.C17.homecollection.test.mjs   (live: db/tests/homecollection/T0B-13.C17_schema.test.sql and T0B-13.C17_anonymise.test.sql via pg_prove; generated probes: db/tests/isolation/homecollection.*.test.sql)
// Method (as T0B-13.C9..C16): the expected DDL is PARSED FROM C17 05-SCHEMA at test time and compared (whitespace/case-normalised) with the migrations. §4 holds literal SQL for every table, index and trigger; §4.1 the RLS as a DO/format() loop
// (expanded here from its own centre_tables / tenant_tables arrays and pred_c / pred_t text) plus 7 literal policies / 1 grant block; §4.2 the DEFINER + 4 owner policies verbatim.
// T0B13C17_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B13C17_ROOT ? resolve(process.env.T0B13C17_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').replace(/\bcreate or replace function\b/gi, 'create function').toLowerCase();
const flat = (x) => x.replace(/[()]/g, '');
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const hFiles = () => files().filter((f) => /^\d{14}_homecollection__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const hSql = () => hFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'homecollection.sql') ? strip(readFileSync(polDir + 'homecollection.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C16)
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
const isAudit = (s) => /app\.tg_row_audit\(/i.test(s);
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

// ---------------------------------------------------------------- spec extraction (C17 05-SCHEMA, Part A only: Part B is the device-local drift schema, owned by C17 itself)
const specPath = repo + 'spec/chunks/C17-home-collection/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = b0 ? s.indexOf(b0, a + a0.length) : s.length; assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const partA = () => between(specRaw(), '# Part A', '# Part B');
const specSec = (a, b) => between(partA(), a, b);
const specDdl = () => strip(sqlBlocks(specSec('## 4. DDL', '### 4.1 ')));        // §4: 16 tables, indexes, 6 mutable-column triggers
const specAll = () => strip(sqlBlocks(partA()));                                  // §4 + §4.1 (DO block, 7 literal policies, grants) + §4.2 (4 owner policies + the DEFINER)
const doBlock = () => specSec('### 4.1 ', '### 4.2 ');

// ---- tables: the §4 DDL is the truth (16 CREATE TABLE = 15 tenant + 1 G; event_inbox is C0's); classes from §1 (hard-coded, cross-checked against the spec rows)
const G_N = ['g_cs_reasons'];
const CLS = { settings: 'M', booking_refs: 'M', routes: 'M', visits: 'C', visit_transitions: 'A', visit_assignments: 'A', visit_specimens: 'C', devices: 'M', sync_batches: 'A', mutations: 'A', collections: 'C', handovers: 'C', handover_items: 'C', visit_flags: 'C', visit_locations: 'E' };
const T_N = Object.keys(CLS);
const G_T = G_N.map((t) => `homecollection.${t}`), TENANT = T_N.map((t) => `homecollection.${t}`), ALLT = [...G_T, ...TENANT];
const isG = (q) => /\.g_/.test(q);
const AUDIT_REQ = T_N.filter((t) => ['M', 'C'].includes(CLS[t])).map((t) => `homecollection.${t}`);   // C0 05-SCHEMA §2 default: every class M and C table is audited, A and E are not (C17 §1 declares nothing else)
const CENTRE_T = ['visits', 'routes', 'visit_specimens', 'collections', 'visit_flags', 'visit_transitions', 'visit_assignments', 'mutations', 'visit_locations'];   // §4.1 centre_tables ('u' = S I U, '-' = S I)
const CENTRE_U = ['visits', 'routes', 'visit_specimens', 'collections', 'visit_flags'];
const TENANT_T = ['settings', 'booking_refs', 'devices', 'sync_batches'];                                                       // §4.1 tenant_tables
const TENANT_U = ['settings', 'booking_refs', 'devices'];
const BOTH_T = ['handovers', 'handover_items'];                                                                                  // §4.1 (2): literal policies, visible from either side
const GR = Object.fromEntries([...CENTRE_T, ...TENANT_T, ...BOTH_T].map((t) => [t, [...'SI', ...([...CENTRE_U, ...TENANT_U, ...BOTH_T].includes(t) ? 'U' : ''), ...(t === 'visit_locations' ? 'D' : '')]]));   // §4.1 grants to lims_app
const PRIV = { S: 'SELECT', I: 'INSERT', U: 'UPDATE', D: 'DELETE' };
const MUT_TG = ['visits__mutable_columns', 'visit_specimens__mutable_columns', 'collections__mutable_columns', 'handovers__mutable_columns', 'handover_items__mutable_columns', 'visit_flags__mutable_columns'];   // the 6 literal §4 triggers
const FN_DEF = 'app.homecollection_anonymise_retired_visits';
const MAINT = 'homecollection_anonymise_retired_visits';
const OWNER_POL = ['handover_items__select__owner_only', 'handover_items__update__owner_only', 'visits__select__owner_only', 'visits__update__owner_only'];

const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('homecollection.') && !/\.event_inbox$/.test(p.table));
// the expected lims_app policies: the §4.1 DO block expanded from its own arrays + predicates, then the literal §4.1 statements (handovers, handover_items, visit_locations DELETE) and the 4 owner policies of §4.2
function expectedGenerated() {
  const blk = doBlock(), pc = /pred_c text := \$p\$([\s\S]*?)\$p\$/.exec(blk), pt = /pred_t text := \$p\$([\s\S]*?)\$p\$/.exec(blk);
  assert.ok(pc && pt, 'pred_c / pred_t in the §4.1 DO block');
  const arrs = (name) => { const m = new RegExp(`${name} text\\[\\]\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`).exec(blk); assert.ok(m, name); return [...m[1].matchAll(/\['(\w+)','([u-])'\]/g)].map((x) => [x[1], x[2]]); };
  const out = [];
  for (const [list, pred, scope] of [[arrs('centre_tables'), pc[1], 'tenant_centre'], [arrs('tenant_tables'), pt[1], 'tenant']]) for (const [t, k] of list) {
    const p = norm(pred);
    out.push({ key: `${t}__select__${scope}@homecollection.${t}`, cmd: 'SELECT', using: p, check: '' }, { key: `${t}__insert__${scope}@homecollection.${t}`, cmd: 'INSERT', using: '', check: p });
    if (k === 'u') out.push({ key: `${t}__update__${scope}@homecollection.${t}`, cmd: 'UPDATE', using: p, check: p });
  }
  return { out, centre: arrs('centre_tables'), tenant: arrs('tenant_tables'), predC: norm(pc[1]), predT: norm(pt[1]) };
}
// ---- the §1 inventory (class, scope) parsed from the spec
function inventory() {
  const out = new Map();
  for (const l of specSec('## 1. Table inventory', '**Mandatory columns.**').split('\n').filter((x) => /^\| `/.test(x))) {
    const c = l.split('|').map((x) => x.trim()); out.set(/`homecollection\.(\w+)`/.exec(c[1])[1], { cls: /^([A-Z])/.exec(c[2])[1], scope: c[3] });
  }
  return out;
}

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 16 CREATE TABLE in §4 (15 tenant + 1 G, no event_inbox), 6 literal mutable-column triggers (WHEN on handover_items), 1 DEFINER, 4 owner + 7 literal lims_app policies, DO block = 9 centre + 4 tenant tables -> 34 policies, no view, §1 classes match the hard-coded table, 40 seed rows', () => {
  const ddl = specDdl(), all = specAll();
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 16, '16 CREATE TABLE in §4 (the brief says "about 27"; the chunk DDL has 16)');
  assert.equal(G_N.length, 1); assert.equal(T_N.length, 15); assert.equal(ALLT.length, 16);
  assert.deepEqual([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].map((m) => m[1]).sort(), [...ALLT].sort(), '§1 homecollection rows (minus event_inbox) = §4 tables');
  for (const q of ALLT) assert.ok(createTable(ddl, q), `spec has ${q}`);
  assert.doesNotMatch(all, /CREATE\s+TABLE\s+homecollection\.event_inbox/i);
  assert.deepEqual(fnNames(all), [FN_DEF], 'the one function of the spec');
  assert.equal([...all.matchAll(/SECURITY\s+DEFINER/gi)].length, 1);
  assert.deepEqual(createTriggers(all).map(trgName).sort(), [...MUT_TG].sort(), '6 triggers, all app.enforce_mutable_columns');
  assert.match(createTriggers(all).find((s) => trgName(s) === 'handover_items__mutable_columns'), /\bWHEN\s*\(/i);
  assert.equal(createTriggers(all).filter(isAudit).length, 0, 'the spec writes no audit trigger (C0 adds them, C0 §9 rule 1)');
  const lit = policies(all); assert.equal(lit.length, 11, '4 owner + 6 handover(_items) + 1 visit_locations DELETE written out');
  assert.equal(lit.filter((p) => p.roles === 'lims_owner').length, 4); assert.deepEqual(lit.filter((p) => p.roles === 'lims_owner').map((p) => p.name).sort(), OWNER_POL);
  const g = expectedGenerated();
  assert.deepEqual(g.centre.map((x) => x[0]).sort(), [...CENTRE_T].sort()); assert.deepEqual(g.tenant.map((x) => x[0]).sort(), [...TENANT_T].sort());
  assert.deepEqual(g.centre.filter((x) => x[1] === 'u').map((x) => x[0]).sort(), [...CENTRE_U].sort()); assert.deepEqual(g.tenant.filter((x) => x[1] === 'u').map((x) => x[0]).sort(), [...TENANT_U].sort());
  assert.equal(g.out.length, 34, 'DO block: 5x3 + 4x2 centre + 3x3 + 1x2 tenant = 34'); assert.equal(g.out.length + lit.filter((p) => p.roles === 'lims_app').length, 41, '41 lims_app policies in total');
  assert.match(g.predT, /is_staff_or_system/); assert.match(g.predC, /uuid\[\]/);
  assert.deepEqual([...all.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(\w+\.\w+)/gi)], [], 'no view in the chunk DDL');
  assert.equal(createIndexes(ddl).length, 32, '32 CREATE INDEX in §4');
  const inv = inventory();
  for (const t of T_N) assert.equal(inv.get(t)?.cls, CLS[t], `§1 class of ${t}`);
  assert.equal(inv.get('g_cs_reasons')?.cls, 'G'); assert.equal(inv.get('event_inbox')?.cls, 'A');
  assert.deepEqual(Object.keys(GR).sort(), [...T_N].sort(), 'grant table covers the 15 tenant tables');
  assert.equal(seedSpec().length, 40, '§2: 40 seed rows in 8 sets');
  assert.match(specSec('## 1. Table inventory', '## 2. '), /There are no mandatory-column exceptions in this schema/);
  assert.match(specSec('## 1. Table inventory', '## 2. '), /publishes none/);
  assert.equal([...specSec('### 4.2 ', '## 5. ').matchAll(/^- \*\*T[1-5]\*\*/gm)].length, 5, '§4.2 lists the FORCE-RLS tests T1..T5');
});

// ================================================================ files, order, owner (AC-0B-6.1 / 6.3)
const WAVE = /_(quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection|migration_staging)__/;
const BEFORE = /_(quality|micro|anatomic|inventory|partners|smartreport|payments|engagement)__/;
test('migration files: >= 1 *_homecollection__*.sql, timestamps strictly after 20261114120000 (LD-202), after every wave-1 migration and after the quality, micro, anatomic, inventory, partners, smartreport, payments and engagement migrations (db/meta/dag.yaml: homecollection follows engagement), unique; db/policies/homecollection.sql exists; schema creation IF NOT EXISTS', () => {
  assert.ok(hFiles().length >= 1, 'no db/migrations/*_homecollection__*.sql yet (T0B-13.C17 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => !WAVE.test(f)), before = all.filter((f) => BEFORE.test(f));
  assert.ok(earlier.length >= 24, 'wave-1 migrations present'); assert.ok(before.length >= 8, 'quality ... engagement migrations present');
  for (const f of hFiles()) {
    assert.ok(f.slice(0, 14) > '20261114120000', `${f} must be later than 20261114120000`);
    for (const e of [...earlier, ...before]) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (homecollection follows engagement in the DAG)`);
  }
  assert.ok(existsSync(polDir + 'homecollection.sql'), 'db/policies/homecollection.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(hSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)homecollection\b/i, 'schema homecollection exists since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every homecollection migration is SET LOCAL ROLE lims_owner and it is the only role switch (all tables, the function and the policies owned by lims_owner); no standing CREATE grant, no role DDL, no CREATE EXTENSION', () => {
  assert.ok(hFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+|SET\s+SESSION\s+AUTHORIZATION)/gi)].map((m) => ws(m[1]).toUpperCase());
  for (const f of hFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch`);
  }
  assert.doesNotMatch(hSql(), /GRANT\s+CREATE\s+ON\s+(SCHEMA\s+app|DATABASE)/i); assert.doesNotMatch(hSql(), /CREATE\s+ROLE|ALTER\s+ROLE/i); assert.doesNotMatch(hSql(), /CREATE\s+EXTENSION/i);
});

// ================================================================ tables (columns + constraints = spec exactly; C0 may add only a tenant FK, UNIQUE (tenant_id, id), C0 05-SCHEMA §9 rule 1; plus the one deferred FK booking_refs -> visits written as a comment in the spec)
const EXTRA_REQ = { 'homecollection.booking_refs': { name: 'booking_refs__visit__fk', body: 'foreign key(tenant_id,visit_id)references homecollection.visits(tenant_id,id)' } };   // §4: "visit FK added after visits exists"
for (const q of ALLT) {
  test(`${q}: every spec column + constraint (name + text) present identically in the migration; no extra column; only a tenant FK (<t>__tenant__fk), UNIQUE (tenant_id, id)${EXTRA_REQ[q] ? ' and the booking_refs__visit__fk' : ''} may be added (05-SCHEMA §4; C0 §9 rule 1)`, () => {
    const specT = createTable(specDdl(), q); assert.ok(specT, `spec table ${q}`);
    const sql = hSql(), got = createTable(sql, q), t = q.split('.')[1];
    assert.ok(got, `CREATE TABLE ${q} not found in *_homecollection__*.sql`);
    for (const [c, def] of specT.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    for (const c of got.colMap.keys()) assert.ok(specT.colMap.has(c), `${q}: extra column ${c} (the spec DDL is complete; there are no mandatory-column exceptions)`);
    for (const [c, def] of specT.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    for (const [c, def] of got.conMap) if (!specT.conMap.has(c)) {
      const body = def.replace(/^constraint\s+\w+\s+/, '');
      if (EXTRA_REQ[q] && c === EXTRA_REQ[q].name) assert.equal(body, EXTRA_REQ[q].body, `${q}: ${c}`);
      else if (body === 'foreign key(tenant_id)references core.tenants(id)') assert.equal(c, `${t}__tenant__fk`, `${q}: added tenant FK name`);
      else { assert.match(body, /^unique\(tenant_id,id\)$/, `${q}: extra constraint ${c} (only the C0 tenant FK and UNIQUE (tenant_id, id) may be added)`); assert.ok(c.startsWith(`${t}__`), `${q}: ${c} prefixed ${t}__`); }
    }
    if (EXTRA_REQ[q]) assert.equal(got.conMap.has(EXTRA_REQ[q].name), true, `${q}: ${EXTRA_REQ[q].name} missing`);
    const bodies = [...got.conMap.values()].map((d) => d.replace(/^constraint\s+\w+\s+/, ''));
    if (isG(q)) { assert.ok(!got.colMap.has('tenant_id'), `${q}: global table, no tenant_id`); assert.ok(bodies.includes('primary key(id)') && bodies.includes('unique(set_code,code)'), 'g_cs_reasons: PK (id), UNIQUE (set_code, code)'); return; }
    assert.ok(bodies.includes('foreign key(tenant_id)references core.tenants(id)'), `${q}: tenant FK to core.tenants (C0 §9 rule 1)`);
    assert.ok(bodies.includes('unique(tenant_id,id)'), `${q}: UNIQUE (tenant_id, id) (04 D8, §1 "every tenant table has id + UNIQUE (tenant_id, id)")`);
    if (t === 'settings') assert.ok(bodies.includes('unique(tenant_id)'), 'settings: one row per tenant');
  });
}
test('exactly the 16 §4 tables are created in homecollection (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9); visit_specimens carries no barcode column (review #2); table count == spec count (the impl note states both)', () => {
  const sql = hSql(), bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.equal(made.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'migration CREATE TABLE count == spec CREATE TABLE count (16 == 16)');
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(bare, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /CREATE\s+TABLE[^;]*event_inbox/i, 'C17 migrations create no inbox (C0 owns homecollection.event_inbox)');
  for (const q of ALLT) for (const c of ['id', 'tenant_id']) { const def = createTable(sql, q)?.colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`); }
  assert.equal(createTable(sql, 'homecollection.visit_specimens').colMap.has('barcode'), false, 'visit_specimens never persists a barcode');
  assert.equal(createTable(sql, 'homecollection.handover_items').colMap.has('barcode'), true, 'handover_items carries its own barcode copy (D-125)');
});
test('cross-schema references (01-CM §5 R3): homecollection -> homecollection / core / frontdesk / lab only, identical target set to the spec; no FK into billing or engagement; every target schema is in db/meta/dag.yaml for homecollection; nothing in an upstream schema references homecollection (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(hSql()), exp = tgt(specDdl());
  for (const t of exp) got.has(t) || assert.fail(`FK target ${t} missing`);
  for (const t of [...got]) { assert.match(t, /^(homecollection|core|frontdesk|lab)\./, `homecollection FK target ${t}`); (exp.has(t) || t === 'homecollection.visits') || assert.fail(`FK target ${t} is not in the spec`); }
  const dag = readFileSync(root + 'db/meta/dag.yaml', 'utf8'), m = /"homecollection"\s*:\s*\[([^\]]*)\]/.exec(dag); assert.ok(m, 'dag.yaml row for homecollection');
  const allowed = new Set([...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]).concat('homecollection'));
  for (const t of got) assert.ok(allowed.has(t.split('.')[0]), `FK target ${t}: schema allowed by dag.yaml`);
  const upstream = files().filter((f) => !WAVE.test(f) || BEFORE.test(f));
  assert.doesNotMatch(upstream.map(read).join('\n'), /\bREFERENCES\s+homecollection\./i, 'no FK into homecollection from an upstream schema');
  assert.doesNotMatch(hSql(), /\bREFERENCES\s+(billing|engagement|reporting|identity|instruments|analytics|catalog|quality|micro|anatomic|inventory|partners|smartreport|payments)\./i, 'no FK into billing / engagement (§1: booking ids are plain uuid)');
});
test('indexes: every §4 CREATE INDEX present with identical definition, no other index; tenant_id leads every index and every UNIQUE / PRIMARY KEY of the tenant tables (except PRIMARY KEY (id)); every __p_ index is partial', () => {
  const sql = hSql(), have = new Map(createIndexes(sql).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].filter((n) => !exp.some((s) => idxName(s) === n)), [], 'no index beyond the spec DDL');
  for (const [n, s] of have) if (/__p_(uq|idx)$/.test(n)) assert.match(s, /\bwhere\b/, `${n} is a partial index`);
  for (const s of createIndexes(sql)) assert.equal(/\bON\s+\w+\.\w+\s*(?:USING\s+\w+\s*)?\(\s*([^,)]+)/i.exec(s)[1].trim(), 'tenant_id', `index ${idxName(s)} leads with tenant_id`);
  for (const q of TENANT) for (const [cn, c] of createTable(sql, q).conMap) if (/\b(primary key|unique)\(/.test(c)) {
    const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1]; if (/primary key/.test(c) && k === 'id') continue;
    assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${cn} ${c}`);
  }
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A2.3, A16.1, A17 P-16, A19 P-41)
test('ENABLE + FORCE ROW LEVEL SECURITY as literal statements (no DO block / format(): check-migrations.ts and the policy tools read statements; the spec DO block is expanded by C0) on the 15 tenant tables; none on the G table; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = hSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of G_T) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(hSql(), /\bDO\s+\$/i, 'literal statements only'); assert.doesNotMatch(polSql(), /\bDO\s+\$/i);
  assert.doesNotMatch(hSql() + polSql(), /EXECUTE\s+format\s*\(/i);
});
test('policies: the 34 DO-block policies (expanded from §4.1) and the 11 literal ones (6 handovers / handover_items, visit_locations DELETE, 4 owner) are present with identical name, command, role, USING and WITH CHECK; no other policy exists (41 lims_app + 4 lims_owner = 45); no FOR ALL; no policy on the G table', () => {
  const got = gotPolicies(), byKey = new Map(got.map((p) => [p.key, p])); assert.ok(got.length > 0, 'db/policies/homecollection.sql has no CREATE POLICY'); assert.equal(byKey.size, got.length, 'no duplicate policy');
  const gen = expectedGenerated().out;
  for (const e of gen) { const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`); assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, 'lims_app', `${e.key} role`); assert.equal(flat(g.using), flat(e.using), `${e.key} USING`); assert.equal(flat(g.check), flat(e.check), `${e.key} WITH CHECK`); }
  const lit = policies(specAll());
  for (const e of lit) { const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`); assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`); assert.equal(flat(g.using), flat(e.using), `${e.key} USING`); assert.equal(flat(g.check), flat(e.check), `${e.key} WITH CHECK`); }
  assert.deepEqual(got.map((p) => p.key).sort(), [...gen.map((e) => e.key), ...lit.map((e) => e.key)].sort(), 'no policy beyond the spec');
  assert.equal(got.filter((p) => p.roles === 'lims_app').length, 41); assert.equal(got.filter((p) => p.roles === 'lims_owner').length, 4); assert.equal(got.length, 45);
  assert.equal(got.filter((p) => p.cmd === 'ALL').length, 0, 'no FOR ALL policy'); assert.equal(got.filter((p) => G_T.includes(p.table)).length, 0, 'no policy on the G table');
});
test('policy shape (§4.1, 08 A17 P-16, A16.1): every lims_app policy carries the tenant predicate; tenant-scope policies (settings, booking_refs, devices, sync_batches) carry (SELECT app.is_staff_or_system()); centre-scope policies use has_all_centres() OR centre_id = ANY (current_centre_ids()::uuid[]) (A16.1 cast) and handovers / handover_items admit to_centre_id for SELECT / UPDATE but never for INSERT; DELETE only on visit_locations, system actor only, expires_at < now(); owner policies TO lims_owner only, gated by the maintenance GUC, no USING (true), no extra disjunct; names <table>__<cmd>__<scope>', () => {
  const ps = gotPolicies(), ten = ps.filter((p) => p.roles === 'lims_app'), own = ps.filter((p) => p.roles !== 'lims_app');
  for (const p of ten) {
    const t = `${p.using} ${p.check}`, tb = p.table.split('.')[1];
    assert.match(t, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: tenant predicate`);
    assert.doesNotMatch(t, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|current_partner_id|current_patient_id/, `${p.key}: no open predicate`);
    assert.match(p.name, new RegExp(`^${tb}__${p.cmd.toLowerCase()}__(tenant_centre|tenant)$`), `${p.key}: name <table>__<cmd>__<scope>`);
    if (TENANT_T.includes(tb)) { assert.match(t, /\(select app\.is_staff_or_system\(\)\)/, `${p.key}: P-16 staff guard`); assert.equal(p.name.endsWith('__tenant'), true); }
    else { assert.match(t, /\(select app\.has_all_centres\(\)\)or (?:centre_id|to_centre_id)=any\(\(select app\.current_centre_ids\(\)\)::uuid\[\]\)/, `${p.key}: centre predicate with the A16.1 cast`); assert.equal(p.name.endsWith('__tenant_centre'), true); }
    assert.doesNotMatch(t, /current_centre_ids\(\)\)(?!::uuid\[\])/, `${p.key}: every current_centre_ids() is cast to uuid[]`);
  }
  for (const b of BOTH_T) {
    const get = (c) => ten.find((p) => p.table === `homecollection.${b}` && p.cmd === c);
    assert.match(get('SELECT').using, /to_centre_id=any/, `${b} SELECT: visible from the receiving side`); assert.match(get('SELECT').using, /\bcentre_id=any/, `${b} SELECT: and from the sending side`);
    assert.doesNotMatch(get('INSERT').check, /to_centre_id/, `${b} INSERT: written by the from (centre_id) side only`);
    for (const x of ['using', 'check']) { assert.match(get('UPDATE')[x], /to_centre_id=any/, `${b} UPDATE ${x}: confirmed by the receiving side`); assert.doesNotMatch(get('UPDATE')[x], /\bcentre_id=any/,`${b} UPDATE ${x}: not by the from side`); }
  }
  const del = ten.filter((p) => p.cmd === 'DELETE'); assert.deepEqual(del.map((p) => p.key), ['visit_locations__delete__tenant_centre@homecollection.visit_locations'], 'DELETE policy only on visit_locations (the one class E table)');
  assert.match(del[0].using, /\(select app\.current_actor_type\(\)\)='system'/, 'system actor only'); assert.match(del[0].using, /expires_at\s*<\s*now\(\)/, 'only expired rows (P-18(c))');
  assert.equal(own.length, 4);
  for (const p of own) {
    assert.equal(p.roles, 'lims_owner', `${p.key} TO lims_owner`); assert.match(p.name, /^(visits|handover_items)__(select|update)__owner_only$/); const t = `${p.using} ${p.check}`;
    assert.match(t, new RegExp(`current_setting\\('app\\.maintenance',true\\)='${MAINT}'`), `${p.key}: maintenance GUC gate (08 A12.2)`); assert.match(t, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: one tenant per call`);
    assert.doesNotMatch(t, /\btrue\b\s*$|^true$|\bor\b/, `${p.key}: no open predicate, no OR disjunct`);
    if (p.table.endsWith('visits')) assert.match(t, /status in\('completed','failed','cancelled'\)/, `${p.key}: closed visits only`);
  }
  assert.match(own.find((p) => p.name === 'handover_items__update__owner_only').check, /barcode='anonymised'/, 'the only value an owner may write to a handover item barcode');
});
test('policies written literally in migrations are identical to db/policies/homecollection.sql (AC-0B-2.3 copy), including the 4 owner policies; every policy of the file is created by a migration and vice versa', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(hSql()).filter((x) => x.table.startsWith('homecollection.') && !/\.event_inbox$/.test(x.table));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort());
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §4.1 grants)
test('grants equal §4.1: lims_app SELECT / INSERT / UPDATE exactly (S I U on visits, routes, visit_specimens, collections, visit_flags, settings, booking_refs, devices, handovers, handover_items; S I on the 4 append-only tables; S I D on visit_locations; S on g_cs_reasons); DELETE only on visit_locations; no TRUNCATE / REFERENCES / TRIGGER, no column grants, nothing to other roles', () => {
  const sql = hSql() + '\n;\n' + polSql(), g = grantsOf(sql);
  const privs = (q, r) => [...(g.get(q)?.get(r)?.all ?? [])].sort();
  for (const t of T_N) assert.deepEqual(privs(`homecollection.${t}`, 'lims_app'), GR[t].map((x) => PRIV[x]).sort(), `homecollection.${t} lims_app`);
  assert.deepEqual(privs('homecollection.g_cs_reasons', 'lims_app'), ['SELECT']);
  assert.deepEqual(T_N.filter((t) => GR[t].includes('D')), ['visit_locations'], 'the only DELETE grant of the schema');
  for (const [q, rm] of g) if (/^homecollection\./.test(q)) {
    assert.ok(new Set(ALLT).has(q), `${q}: unexpected grant target`);
    for (const [r, p] of rm) {
      assert.equal(r, 'lims_app', `${q}: unexpected grantee ${r}`);
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!p.all.has(bad) && !p.cols.has(bad), `${q}: ${r} must not hold ${bad}`);
      assert.equal(p.cols.size, 0, `${q}: whole-table grants only`);
    }
  }
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\bhomecollection\./i); assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+homecollection\b/i); assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bhomecollection\b/i);
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\bhomecollection\./i.test(s) && !/\bFUNCTION\b/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner|lims_analytics)\b/i, s);
});

// ================================================================ functions + triggers (AC-0B-4.1; §4, §4.2; T1..T5)
test('the DEFINER app.homecollection_anonymise_retired_visits(timestamptz) equals the §4.2 text verbatim; SECURITY DEFINER, VOLATILE, search_path = \'\', REVOKE ALL FROM PUBLIC, EXECUTE to lims_worker only, OWNER lims_owner; it sets and resets app.maintenance (T3), checks tenant / actor / p_before (T4), writes only the P2 columns + the ANONYMISED barcode; it is the ONLY SECURITY DEFINER of the chunk (visit_locations purge is a policy, §4.1 (3))', () => {
  const sql = hSql(), exp = specAll(), st = stmts(sql).map(ws);
  const got = fnText(sql, FN_DEF); assert.ok(got, `${FN_DEF} missing (05-SCHEMA §4.2)`); assert.equal(norm(got), norm(fnText(exp, FN_DEF)), 'text equals the spec');
  assert.match(got, /SECURITY\s+DEFINER/i); assert.match(got, /\bVOLATILE\b/i); assert.match(got, /SET\s+search_path\s*=\s*''/i);
  assert.match(got, /RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'homecollection_anonymise_invalid_input'/, 'T4 error');
  assert.match(got, new RegExp(`set_config\\('app\\.maintenance',\\s*'${MAINT}',\\s*true\\)`)); assert.match(got, /set_config\('app\.maintenance',\s*'',\s*true\)/, 'T3: GUC reset before return');
  const sig = `${FN_DEF.replace('.', '\\.')}\\(timestamptz\\)`;
  assert.ok(st.some((s) => new RegExp(`^REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${sig}\\s+FROM\\s+PUBLIC$`, 'i').test(s)), 'REVOKE ALL ... FROM PUBLIC');
  assert.deepEqual(st.filter((s) => /^GRANT\b/i.test(s) && s.includes('homecollection_anonymise_retired_visits')).map((s) => /\bTO\s+(.+)$/i.exec(s)[1].replace(/\s+/g, '')), ['lims_worker'], 'EXECUTE to lims_worker only');
  for (const s of st.filter((x) => /^ALTER\s+FUNCTION\b/i.test(x) && x.includes('homecollection_anonymise'))) assert.match(s, /\bOWNER\s+TO\s+lims_owner$/i);
  assert.equal([...sql.matchAll(/SECURITY\s+DEFINER/gi)].length, 1, 'exactly one SECURITY DEFINER in the migrations');
  assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+app\.(?!homecollection_)/i, 'only app.homecollection_* objects are created in schema app');
  assert.doesNotMatch(sql, /\bpurge_locations\b|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+homecollection\.purge/i, 'no DEFINER purge of visit_locations (08 A19 P-41)');
});
test('triggers: the 6 §4 mutable-column triggers equal the spec statements (handover_items__mutable_columns keeps its WHEN clause: only the owner + maintenance GUC bypass); app.enforce_mutable_columns is the C0 function; C0 adds exactly two transition guards (visits, collections), BEFORE UPDATE FOR EACH ROW, SECURITY INVOKER, search_path = \'\'; nothing else besides the audit triggers; none disabled or dropped; no immutable column in any list (AC-0B-4.1)', () => {
  const sql = hSql(), all = createTriggers(sql), trg = all.filter((s) => !isAudit(s)), exp = createTriggers(specAll());
  for (const s of exp) { const hit = trg.find((x) => trgName(x) === trgName(s)); assert.ok(hit, `trigger ${trgName(s)} missing`); assert.equal(norm(hit), norm(s), `trigger ${trgName(s)}`); }
  const extra = trg.filter((s) => !MUT_TG.includes(trgName(s)));
  assert.deepEqual(extra.map(trgTable).sort(), ['homecollection.collections', 'homecollection.visits'], 'the two C0 transition triggers: visits (V5..V11 guard, 03-APP-FLOW §1.1) and collections (only held -> applied | discarded)');
  for (const s of trg) assert.match(s, /\bBEFORE UPDATE ON homecollection\.\w+ FOR EACH ROW\b/i, `${trgName(s)}: BEFORE UPDATE FOR EACH ROW`);
  for (const s of extra) {
    const fn = /EXECUTE FUNCTION ([\w.]+)\(/i.exec(s)[1], body = fnText(sql, fn); assert.ok(body, `${fn}: function of ${trgName(s)} missing`);
    assert.match(body, /SET\s+search_path\s*=\s*''/i, `${fn}: search_path = ''`); assert.doesNotMatch(body, /SECURITY\s+DEFINER/i, `${fn}: SECURITY INVOKER`); assert.match(body, /ERRCODE\s*=\s*'P0001'/, `${fn}: raises P0001 (02-CV §5.7)`); if (trgTable(s) === 'homecollection.visits') assert.match(body, /immutable_row/, `${fn}: P0001 immutable_row -> 409 homecollection.visit_closed (§4)`);
    if (trgTable(s) === 'homecollection.visits') {
      assert.equal(fn, 'homecollection.visits__transition_guard', 'named in §4 ("C0 adds homecollection.visits__transition_guard")');
      for (const k of ['order_id', 'unassigned', 'assigned', 'in_progress', 'completed', 'failed', 'cancelled', 'lims_owner', MAINT, 'address_text', 'landmark', 'latitude', 'longitude', 'note_for_phlebotomist', 'status_reason_text']) assert.ok(body.includes(k), `${fn} mentions ${k}`);
      assert.match(body, /current_user\s*=\s*'lims_owner'/, 'the retention bypass is the function OWNER AND the GUC, not the GUC alone (T2)');
    } else for (const k of ['held', 'applied', 'discarded']) assert.ok(body.includes(k), `${fn} mentions ${k}`);
  }
  assert.doesNotMatch(sql, /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(sql, /DROP\s+TRIGGER\b/i);
  assert.deepEqual(fnNames(sql).filter((n) => n !== FN_DEF).filter((n) => !n.startsWith('homecollection.')), [], 'every other function lives in schema homecollection (C0 audit / generic helpers are not re-created)');
  for (const s of trg.filter((x) => MUT_TG.includes(trgName(x)))) {
    const cols = [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((c) => !/anonymise/.test(c));
    for (const bad of ['id', 'tenant_id', 'created_at', 'created_by']) assert.ok(!cols.includes(bad), `${trgName(s)}: ${bad} stays immutable`);
  }
  const cols = (n) => [...exp.find((s) => trgName(s) === n).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((c) => c !== MAINT);
  for (const c of ['kind', 'booking_id', 'patient_id', 'centre_id', 'branch_id', 'parent_visit_id', 'recollection_of_specimen_id', 'orderable_ids']) assert.ok(!cols('visits__mutable_columns').includes(c), `visits.${c} immutable`);
  for (const c of ['scan_method', 'collected_at', 'specimen_id', 'visit_id', 'mutation_id', 'hold_code']) assert.ok(!cols('collections__mutable_columns').includes(c), `collections.${c} immutable`);
  for (const c of ['barcode', 'specimen_type_code', 'collection_id', 'handover_id']) assert.ok(!cols('handover_items__mutable_columns').includes(c), `handover_items.${c} is immutable to lims_app (only the owner maintenance path overwrites barcode)`);
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x; C0 §2 default: every class M and C table is audited, A and E are not): <t>__audit AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW on the 10 M / C tables; never on class A / E / G; any excluded column listed exists', () => {
  const trg = createTriggers(hSql()).filter(isAudit), onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  assert.equal(AUDIT_REQ.length, 10);
  for (const q of AUDIT_REQ) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(`, 'i'), q);
    const a = [...(/tg_row_audit\(([^)]*)\)/i.exec(hit[0])[1].matchAll(/'([a-z_0-9]+)'/g))].map((m) => m[1]), cols = createTable(hSql(), q).colNames;
    for (const c of a) assert.ok(cols.includes(c), `${q}: excluded column ${c} exists`);
  }
  for (const t of T_N.filter((x) => !['M', 'C'].includes(CLS[x]))) assert.equal(onTable(`homecollection.${t}`).length, 0, `homecollection.${t} (class ${CLS[t]}) must NOT be audited`);
  for (const q of G_T) assert.equal(onTable(q).length, 0, `${q} must NOT be audited`);
  assert.equal(trg.length, 10, 'no audit trigger beyond the 10');
});

// ================================================================ DEFINER inventory (08 A12.1, A12.7, A19 P-41; §4.2 inventory row)
test('db/meta/definer-inventory.yaml: exactly one homecollection row app.homecollection_anonymise_retired_visits (owner lims_owner, execute [lims_worker], why, touches visits + handover_items SELECT / UPDATE, policies = the 4 owner policies + the maintenance GUC, reviewer field); the 4 policies exist in db/policies/homecollection.sql; no foreign DEFINER touches homecollection', () => {
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  assert.deepEqual(Object.keys(inv).filter((k) => /homecollection/.test(k)), [FN_DEF], 'exactly one homecollection DEFINER row');
  const r = inv[FN_DEF]; assert.equal(r.owner, 'lims_owner'); assert.deepEqual(r.execute, ['lims_worker']); assert.ok(String(r.why ?? '').length > 10, 'why'); assert.ok('reviewer' in r, 'reviewer field');
  for (const x of ['homecollection.visits SELECT', 'homecollection.visits UPDATE', 'homecollection.handover_items SELECT', 'homecollection.handover_items UPDATE']) assert.ok(JSON.stringify(r.touches).includes(x), `touches ${x}`);
  for (const x of [...OWNER_POL, MAINT]) assert.ok(JSON.stringify(r.policies).includes(x), `policies ${x}`);
  const names = new Set(policies(polSql()).map((p) => p.name)); for (const n of OWNER_POL) assert.ok(names.has(n), `${n} exists in db/policies/homecollection.sql`);
  for (const [k, e] of Object.entries(inv)) if (!/homecollection/.test(k)) assert.doesNotMatch(JSON.stringify(e.touches ?? []), /homecollection\./, `${k}: no foreign DEFINER touches homecollection`);
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const MAND = { M: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'is_active'], C: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version'], A: ['id', 'tenant_id', 'created_at', 'created_by'], E: ['id', 'tenant_id', 'created_at', 'expires_at'] };
const P3 = ['visits.orderable_ids'];
const P2 = ['visits.address_text', 'visits.landmark', 'visits.latitude', 'visits.longitude', 'visits.note_for_phlebotomist', 'visits.status_reason_text', 'visit_transitions.reason_text', 'mutations.payload', 'collections.review_reason_text', 'handovers.note', 'handover_items.barcode', 'visit_flags.resolution_note', 'visit_locations.latitude', 'visit_locations.longitude', 'visit_locations.accuracy_m'];
test('tables.yaml: all 16 homecollection tables registered (class per §1, centre_scoped = the §4.1 centre / handover tables, audited = trigger (M / C), retention, shared_with [] everywhere: staff module, no partner / portal / patient actor, P-16, columns = the migration columns, phi_class P0..P3); the count equals the CREATE TABLE count; event_inbox entry untouched', () => {
  const y = tablesYaml(), regs = Object.keys(y).filter((k) => /^homecollection\./.test(k) && !/\.event_inbox$/.test(k));
  assert.equal(regs.length, 16, 'tables.yaml homecollection entries (ex event_inbox)'); assert.equal(regs.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'tables.yaml count == chunk DDL count (16 == 16)');
  const trgAudited = (q) => createTriggers(hSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of ALLT) {
    const e = y[q], t = q.split('.')[1]; assert.ok(e && createTable(hSql(), q), `${q} in tables.yaml and migrations`);
    assert.equal(e.class, isG(q) ? 'G' : CLS[t], `${q} class (§1)`);
    assert.equal(e.centre_scoped, [...CENTRE_T, ...BOTH_T].includes(t), `${q} centre_scoped`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`); assert.equal(e.audited, AUDIT_REQ.includes(q), `${q} audited (M and C tables only)`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), createTable(hSql(), q).colNames.map((c) => c.replace(/"/g, '')).sort(), `${q} columns = migration columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
    assert.deepEqual([...(e.shared_with ?? [])], [], `${q}: shared_with empty (§1 "no table is shared_with partner, portal or patient actors")`);
  }
  assert.equal(y['homecollection.event_inbox'].class, 'A', 'inbox entry remains as C0 wrote it'); assert.deepEqual(y['homecollection.event_inbox'].shared_with ?? [], []);
});
test('tables.yaml phi_class (§3): the 1 P3 and 15 P2 columns registered at exactly that class; settings, routes, devices, sync_batches (anchors), g_cs_reasons, booking_refs hold only P0 / P1; created_by / updated_by are P1; visit_locations.expires_at P0', () => {
  const y = tablesYaml();
  for (const k of P3) { const [t, c] = k.split('.'); assert.equal(y[`homecollection.${t}`].columns[c], 'P3', `${k}: P3`); }
  for (const k of P2) { const [t, c] = k.split('.'); assert.equal(y[`homecollection.${t}`].columns[c], 'P2', `${k}: P2`); }
  for (const t of ['settings', 'g_cs_reasons']) for (const [c, p] of Object.entries(y[`homecollection.${t}`].columns)) assert.match(p, /^P[01]$/, `homecollection.${t}.${c}: P0 / P1 only (§3.2: settings P0, no PHI)`);
  for (const c of ['payment_methods', 'collection_consent_text']) assert.equal(y['homecollection.settings'].columns[c], 'P0', `settings.${c} P0 (§3.2)`);
  assert.equal(y['homecollection.sync_batches'].columns.anchors, 'P0'); assert.equal(y['homecollection.devices'].columns.model, 'P0'); assert.equal(y['homecollection.visit_locations'].columns.expires_at, 'P0');
  for (const q of ALLT) for (const c of ['created_by', 'updated_by']) if (y[q].columns[c]) assert.equal(y[q].columns[c], 'P1', `${q}.${c}`);
});
test('tables.yaml: rls_exempt only on g_cs_reasons (with a reason); mandatory_column_exceptions EMPTY on every table (§1: "no mandatory-column exceptions in this schema", P-18(b)) and the DDL really carries every class-mandatory column (M id..is_active, C id..version, A id/tenant/created_*, E ... expires_at)', () => {
  const y = tablesYaml();
  for (const q of ALLT) {
    assert.ok(y[q] && createTable(hSql(), q), `${q} in tables.yaml and in the migrations`);
    const e = y[q], cols = new Set(createTable(hSql(), q).colNames);
    if (isG(q)) { assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); assert.deepEqual([...(e.mandatory_column_exceptions ?? [])], []); assert.ok(!cols.has('tenant_id')); continue; }
    assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    assert.deepEqual([...(e.mandatory_column_exceptions ?? [])], [], `${q}: no mandatory-column exception`);
    const cls = CLS[q.split('.')[1]]; assert.deepEqual(MAND[cls].filter((c) => !cols.has(c)), [], `${q}: carries every class-${cls} mandatory column`);
  }
});
test('tables.yaml retention (§6): visits ... sync_batches tenant retentionYears (5), read models (visit_specimens, routes, booking_refs) same as visits, visit_locations expires_at = captured_at + gps_retention_days then DELETE by the system actor, devices while active + 1 year after wiped / signed_off, g_cs_reasons / settings stated; event_inbox 90 days', () => {
  const y = tablesYaml(), r = (q) => { const e = y[`homecollection.${q}`]; assert.ok(e, `homecollection.${q} in tables.yaml`); return String(e.retention); };
  for (const q of ['visits', 'visit_transitions', 'visit_assignments', 'collections', 'handovers', 'handover_items', 'mutations', 'visit_flags', 'sync_batches', 'visit_specimens', 'routes', 'booking_refs']) assert.match(r(q), /retentionYears|5 years|tenant|visits/i, `${q}: tenant retention`);
  assert.match(r('visit_locations'), /gps_retention_days|expires_at/); assert.match(r('devices'), /1 year|wiped|signed_off/i);
  for (const q of ['settings', 'g_cs_reasons']) assert.ok(r(q).length > 3, `${q} retention text`);
  assert.match(y['homecollection.event_inbox'].retention, /90 days/);
  assert.match(specSec('## 6. Retention', '## 7. '), /anonymised by `app\.homecollection_anonymise_retired_visits`/);
});
test('db/tests/rls_exempt.txt lists exactly the 1 homecollection G table with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^homecollection\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]), ['homecollection.g_cs_reasons']);
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ seeds (§2: 8 sets, 40 rows; nothing else)
function seedSpec() {   // §2 table -> ["set|code|display|requires_text"]; display '' where the spec gives none (or only the note "(system)")
  const out = [];
  for (const l of specSec('## 2. Coded sets and seeds', 'Enumerated CHECK values').split('\n').filter((x) => /^\| `[a-z_]+` \| `/.test(x))) {
    const c = l.split('|').map((x) => x.trim()), set = c[1].replace(/`/g, '');
    for (const part of c[2].split(/,\s*(?=`)/)) {   // not splitTop: "can't" would open a quote
      const m = /^`([a-z_]+)`(†)?\s*(?:\(([^)]*)\))?\s*(†)?$/.exec(part.trim()); assert.ok(m, `seed cell ${part}`);
      out.push(`${set}|${m[1]}|${m[3] && m[3] !== 'system' ? m[3] : ''}|${m[2] || m[4] ? 'true' : 'false'}`);
    }
  }
  return out;
}
const lit = (v) => /^'(.*)'$/.exec(v)?.[1].replace(/''/g, "'");
test('seed rows: g_cs_reasons holds exactly the 40 §2 rows (set_code + code verbatim, display verbatim where the spec gives one, requires_text true exactly for the † codes, id / set_code / code / display / requires_text / sort_order named, sort_order distinct per set, ids distinct); NOTHING else is inserted (no settings, no tenant data: fixtures are packages/test-fixtures, §7)', () => {
  const sql = hSql(), rows = insertRows(sql, 'homecollection.g_cs_reasons'); assert.ok(rows.length > 0, 'g_cs_reasons: seeded');
  for (const k of ['id', 'set_code', 'code', 'display', 'requires_text', 'sort_order']) assert.ok(k in rows[0], `seed column list names ${k} (id has no DEFAULT)`);
  const got = rows.map((r) => `${lit(r.set_code)}|${lit(r.code)}|${lit(r.display)}|${r.requires_text.toLowerCase()}`), exp = seedSpec();
  assert.equal(got.length, 40); assert.deepEqual(got.map((g) => g.split('|').slice(0, 2).join('|')).sort(), exp.map((g) => g.split('|').slice(0, 2).join('|')).sort(), 'seed (set, code) = §2');
  const dis = new Map(got.map((g) => [g.split('|').slice(0, 2).join('|'), g.split('|')[2]]));
  for (const e of exp) { const [s, c, d, rt] = e.split('|'), g = got.find((x) => x.startsWith(`${s}|${c}|`)); assert.equal(g.split('|')[3], rt, `${s}.${c}: requires_text`); if (d) assert.equal(dis.get(`${s}|${c}`), d, `${s}.${c}: display verbatim`); else { const x = dis.get(`${s}|${c}`); assert.ok(x && x.length >= 1 && x.length <= 80, `${s}.${c}: display 1..80`); } }
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'ids distinct');
  for (const s of new Set(rows.map((r) => lit(r.set_code)))) { const so = rows.filter((r) => lit(r.set_code) === s).map((r) => r.sort_order); assert.equal(new Set(so).size, so.length, `${s}: sort_order distinct`); }
  for (const r of rows) assert.match(lit(r.code) ?? '', /^[a-z0-9_]{1,64}$/);
  assert.equal([...new Set(rows.map((r) => lit(r.set_code)))].length, 8, '8 sets (D-130: all sets, no tenant overrides)');
  const tables = [...new Set(stmts(sql).map(ws).filter((s) => /^INSERT\s+INTO\b/i.test(s)).map((s) => /INTO\s+(\S+)/i.exec(s)[1]))].sort();
  assert.deepEqual(tables, [...G_T].sort(), 'no other INSERT in the homecollection migrations');
});

// ================================================================ views (IC §6; AC-0B-6.4): the chunk publishes none
test('view column contract (AC-0B-6.4): 03-IC §6 defines no homecollection view and §1 says the chunk publishes none, so the migrations create no view (and no materialized view); no v_pub_* object, no grant on one; tables.yaml registers none', () => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8');
  assert.doesNotMatch(ic, /\|\s*`homecollection\.v_pub_/, 'IC §6 has no homecollection published view');
  assert.match(specSec('## 1. Table inventory', '## 2. '), /03-IC §6 defines none for `homecollection`; this chunk publishes none/);
  assert.doesNotMatch(hSql() + polSql(), /CREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\b/i, 'no view'); assert.doesNotMatch(hSql() + polSql(), /v_pub_/i);
  assert.deepEqual(Object.keys(tablesYaml()).filter((k) => /^homecollection\.v_/.test(k)), []);
});

// ================================================================ hygiene
test('C17 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of other schemas\' tables, no USING (true), no GRANT to PUBLIC; no Storage SQL; only app.homecollection_* objects are created in schema app; no auth.* reference; no fixtures', () => {
  const raw = hFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 25000, 'C17 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i); assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics|quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|app)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016'); assert.doesNotMatch(strip(raw), /\bTO\s+PUBLIC\b/i);
  assert.doesNotMatch(strip(raw) + polSql(), /\bstorage\.(objects|buckets)\b/i, 'no Storage SQL'); assert.doesNotMatch(strip(raw), /\bauth\./i, 'REQ-SEC-038');
  assert.doesNotMatch(strip(raw), /\b(Test Patient|Test Phlebo|SYN-|HC-A1|HC-B1)/, 'no fixtures in migrations (packages/test-fixtures, §7)');
  const bad = [...strip(raw).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TABLE|TRIGGER|INDEX|UNIQUE INDEX|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?app\.(\w+)/gi)].map((m) => m[1]).filter((n) => !/^homecollection_/.test(n));
  assert.deepEqual(bad, [], 'only app.homecollection_* objects are created in schema app');
});
test('LD-202 scope: no wave-1 migration, db/bootstrap, spec, service or app file is changed by this task (only homecollection files + policies + meta + tests are new / edited)', () => {
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', 'db/migrations', 'db/bootstrap', 'spec', 'services', 'apps'], { cwd: repo, encoding: 'utf8' });
  const changed = r.stdout.split('\n').filter(Boolean).filter((f) => !/^db\/migrations\/\d{14}_homecollection__/.test(f));
  assert.deepEqual(changed, [], 'tracked files outside the homecollection migrations were modified');
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-fk-dag.ts exits 0; check-migrations.ts exits 0 OR its ONLY violation is the pre-existing C13 one (partners.manifest_lines DELETE grant, blocking CR T0B-13.C13-manifest-lines-delete.md) and no line mentions homecollection; check-registry.ts exits 0 (the C17 policies carry the staff guard: no friction to tolerate)', () => {
  assert.ok(hFiles().length >= 1, 'C17 migrations missing');
  const f = tool('check-fk-dag.ts'); assert.equal(f.code, 0, `check-fk-dag.ts:\n${f.out}`);
  const m = tool('check-migrations.ts');
  if (m.code !== 0) {
    const bad = m.out.split('\n').filter((l) => /^check-migrations: /.test(l) && !/check-migrations: ok/.test(l));
    assert.ok(bad.length > 0 && bad.every((l) => /_partners__create_partners_schema\.sql: partners\.manifest_lines: GRANT DELETE to lims_app on a class C table is forbidden/.test(l)), `check-migrations (only the pre-existing C13 violation is tolerated):\n${m.out}`);
    assert.doesNotMatch(m.out, /homecollection/i, 'no check-migrations violation may mention homecollection'); assert.ok(existsSync(root + '.orchestra/cr/T0B-13.C13-manifest-lines-delete.md'));
  }
  const r = tool('check-registry.ts'); assert.equal(r.code, 0, `check-registry.ts:\n${r.out}`);
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 15 tenant C17 tables, none for the class G table, and gen-isolation-probes --check is clean; _registry.sql lists all 16', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const q of G_T) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/homecollection/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-13\.C17_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/homecollection/T0B-13.C17_schema.test.sql and T0B-13.C17_anonymise.test.sql exist (tester-owned: the writer must keep them), cover the AC list by "AC-0B-x.y" markers, the catalogue checks by "-- C17 check N" markers (1-8) and the 5 §4.2 FORCE-RLS tests by "-- C17 T<n>" markers; RLS never disabled; replica mode (if used) reset to origin; BEGIN / finish / ROLLBACK', () => {
  assert.deepEqual(tapFiles().sort(), ['T0B-13.C17_anonymise.test.sql', 'T0B-13.C17_schema.test.sql']);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 8; n++) assert.match(txt, new RegExp(`-- C17 check ${n}\\b`), `marker for C17 check ${n}`);
  for (let n = 1; n <= 5; n++) assert.match(txt, new RegExp(`-- C17 T${n}\\b`), `marker for the §4.2 test T${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.1', '6.2', '6.3', '6.4']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
    const rep = [...s.matchAll(/^\s*SET\s+LOCAL\s+session_replication_role\s*=\s*replica/gim)].length, org = [...s.matchAll(/^\s*SET\s+LOCAL\s+session_replication_role\s*=\s*origin/gim)].length;
    assert.ok(rep === 0 || (org >= rep && s.lastIndexOf('= origin') > s.lastIndexOf('= replica')), `${f}: every replica fixture block is reset to origin before assertions`);
  }
  const an = readFileSync(TD + 'T0B-13.C17_anonymise.test.sql', 'utf8');
  for (const k of ['homecollection_anonymise_retired_visits', 'homecollection_anonymise_invalid_input', 'immutable_row', 'ANONYMISED', 'visit_locations', 'app.maintenance']) assert.ok(an.includes(k), `anonymise suite covers ${k}`);
});
