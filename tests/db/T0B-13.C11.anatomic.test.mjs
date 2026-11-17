// T0B-13.C11 static checks of the Wave-2 anatomic DDL translation: db/migrations/*_anatomic__*.sql, db/policies/anatomic.sql, db/meta/tables.yaml, v_pub_report_content,
// 4 guard functions + 7 spec triggers, 25 audit triggers, seed of the one global coded set (g_cs_cancel_reasons).
// Spec: C11 05-SCHEMA §1 (inventory/class/scope), §2 (CHECK values, seeds), §3 (PHI + audit rule), §4 (index map), §6 (DDL), §7 (RLS DO block + cases example + grants), §8 (published view), §9 (storage), §10 (retention), §11 (tests);
// IC §6.8; C0 05-SCHEMA §3.8 (audit), §9, §10; 02-CV §5.2/§5.3; 08 A16.1 (::uuid[] cast), A17 P-16 (staff guard), P-18 (class E counter), P-22; LD-54 (no Storage SQL); LD-202 (translate exactly, no redesign, a gap = blocking CR).
// AC-0B-2.1..2.4, 3.5 (composite FK), 3.6 (probes), 4.1..4.3, 5.x (audit triggers), 6.1..6.3 (static part: order, role switch, FK direction), view column contract vs IC §6.8. AC-0B-6.4 is billing-only (T0B-11) and does not apply to anatomic.
// Run: node --test tests/db/T0B-13.C11.anatomic.test.mjs   (live: db/tests/anatomic/T0B-13.C11_*.test.sql via pg_prove; generated probes: db/tests/isolation/anatomic.*.test.sql)
// Method (as T0B-10.C2..C8, T0B-13.C9, C10): the expected DDL is PARSED FROM C11 05-SCHEMA §6 at test time and compared (whitespace/case-normalised) with the migrations. The spec writes its RLS as a plpgsql DO block
// (format(...) loops over centre_tables / tenant_tables with pred_c / pred_t) plus one explicit example (cases): the block is expanded here from the predicates and the table lists the spec itself declares; the migrations must
// hold the expansion as literal statements. Anatomic has NO prose-only object: every function, trigger, index and view is spelled out in the spec (no `v_<set>` family, no purge function, one seed set).
// T0B13C11_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B13C11_ROOT ? resolve(process.env.T0B13C11_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').replace(/\bcreate or replace function\b/gi, 'create function').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const aFiles = () => files().filter((f) => /^\d{14}_anatomic__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const aSql = () => aFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'anatomic.sql') ? strip(readFileSync(polDir + 'anatomic.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C10)
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
// explicit table (cols + constraints, incl. constraints added by ALTER TABLE ... ADD CONSTRAINT [, ADD CONSTRAINT ...]); `like` is reported so a LIKE-created table can be refused
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
const trgArgs = (s, fn) => { const m = new RegExp(`${fn}\\s*\\(`, 'i').exec(s); return m ? splitTop(balanced(s, m.index + m[0].length)).map((a) => a.replace(/^'|'$/g, '')).sort() : null; };
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

// ---------------------------------------------------------------- spec extraction (C11 05-SCHEMA)
const specPath = repo + 'spec/chunks/C11-specialty-pathology/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = b0 ? s.indexOf(b0, a + a0.length) : s.length; assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const S1 = '## 1. Table inventory', S2 = '## 2. Coded sets', S3 = '## 3. Column classification', S4 = '## 4. Query', S5 = '## 5. JSON shapes', S6 = '## 6. DDL', S7 = '## 7. RLS policies', S8 = '## 8. Published view', S9 = '## 9. Storage', S10 = '## 10. Retention';
const specDdl = () => strip(sqlBlocks(between(specRaw(), S6, S7)));     // §6: tables, indexes, functions, triggers
const specRls = () => strip(sqlBlocks(between(specRaw(), S7, S8)));     // §7: cases example + DO block + grants
const specView = () => strip(sqlBlocks(between(specRaw(), S8, S9)));    // §8: published view + its GRANT
const spec1 = () => between(specRaw(), S1, S2);
const spec2 = () => between(specRaw(), S2, S3);
const spec4 = () => between(specRaw(), S4, S5);
const spec10 = () => between(specRaw(), S10, '## 11.');

// ---- §1 inventory: class / scope per table, parsed from the spec's table (several tables may share a row)
function inventory() {
  const inv = new Map();
  for (const l of spec1().split('\n').filter((x) => /^\| `anatomic\./.test(x))) {
    const c = l.split('|');
    const cls = /([A-Z])/.exec(c[2].replace(/\*/g, ''))[1], scope = c[3].trim();
    for (const m of c[1].matchAll(/`(?:anatomic\.)?([a-z_0-9]+)`/g)) inv.set(m[1], { cls, centre: /centre/.test(scope), global: scope === 'global' });
  }
  return inv;
}
const INV = inventory();
const G_N = [...INV].filter(([, v]) => v.cls === 'G').map(([k]) => k);
const T_N = [...INV].filter(([k, v]) => v.cls !== 'G' && k !== 'event_inbox').map(([k]) => k);
const CLS = Object.fromEntries(T_N.map((t) => [t, INV.get(t).cls]));
const G_T = G_N.map((t) => `anatomic.${t}`), TENANT = T_N.map((t) => `anatomic.${t}`), ALLT = [...G_T, ...TENANT];
const isG = (q) => /\.g_/.test(q);
const CENTRE_N = T_N.filter((t) => INV.get(t).centre), CENTRE_T = CENTRE_N.map((t) => `anatomic.${t}`);
// §3: "`audited: true` for every M and C table (C0 `tg_row_audit`)" -> class A (insert-only) and the class E counter are not audited
const AUDITED = T_N.filter((t) => ['M', 'C'].includes(CLS[t])).map((t) => `anatomic.${t}`);
const FN_GUARD = ['anatomic.guard_synoptic_template', 'anatomic.guard_case', 'anatomic.guard_report_draft', 'anatomic.guard_addendum'];
const SPEC_TRG = ['synoptic_templates__guard', 'cases__guard', 'blocks__mutable_columns', 'slides__mutable_columns', 'images__mutable_columns', 'report_drafts__guard', 'addenda__guard'];
const VIEW = 'anatomic.v_pub_report_content';
const COUNTER = 'accession_counters';

// ---- §7 DO block: centre_tables / tenant_tables ('u' = UPDATE policy + grant, '-' = INSERT + SELECT only) and the two predicates; `cases` is the explicit example above the block
function doBlock() {
  const d = specRls();
  const arr = (n) => { const m = new RegExp(`${n}\\s+text\\[\\]\\[\\]\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\];`).exec(d); assert.ok(m, `spec array ${n}`); return [...m[1].matchAll(/\['(\w+)','([u-])'\]/g)].map((x) => [x[1], x[2] === 'u']); };
  const pred = (n) => { const m = new RegExp(`${n}\\s+text\\s*:=\\s*\\$p\\$([\\s\\S]*?)\\$p\\$`).exec(d); assert.ok(m, `spec predicate ${n}`); return ws(m[1]); };
  return { centre: [['cases', true], ...arr('centre_tables')], tenant: arr('tenant_tables'), PC: pred('pred_c'), PT: pred('pred_t') };
}
const UPD_N = () => { const b = doBlock(); return [...b.centre, ...b.tenant].filter(([, u]) => u).map(([t]) => t); };
const NO_UPDATE_N = () => { const b = doBlock(); return [...b.centre, ...b.tenant].filter(([, u]) => !u).map(([t]) => t); };

// ---- expected policies: cases from the spec's explicit statements, every other table from the DO block expansion (3 or 2 policies per table)
const GUARD = '(SELECT app.is_staff_or_system())';
function expectedPolicies() {
  const b = doBlock(), out = [];
  const add = (tbl, cmd, scope, using, check) => {
    let s = `CREATE POLICY ${tbl}__${cmd.toLowerCase()}__${scope} ON anatomic.${tbl} FOR ${cmd} TO lims_app`;
    if (using) s += ` USING (${using})`; if (check) s += ` WITH CHECK (${check})`;
    out.push(...policies(s));
  };
  for (const [t, u] of b.centre.filter(([x]) => x !== 'cases')) { add(t, 'SELECT', 'tenant_centre', b.PC); add(t, 'INSERT', 'tenant_centre', null, b.PC); if (u) add(t, 'UPDATE', 'tenant_centre', b.PC, b.PC); }
  for (const [t, u] of b.tenant) { add(t, 'SELECT', 'tenant', b.PT); add(t, 'INSERT', 'tenant', null, b.PT); if (u) add(t, 'UPDATE', 'tenant', b.PT, b.PT); }
  return [...policies(specRls()).filter((p) => p.table === 'anatomic.cases'), ...out];
}
const EXPECTED_POLICY_COUNT = 86;       // centre: cases 3 + 15 x (select + insert) + 11 updates = 44; tenant: 14 x 3 = 42; no DELETE policy anywhere
const STAFF = /\(select app\.is_staff_or_system\(\)\)/;
// Spec/gate conflict (as C5..C10): spec pred_c carries no is_staff_or_system() guard, but check-registry (P-16, gate 9) demands it on every __tenant / __tenant_centre policy of a table that is not shared_with. Policy comparison is
// therefore modulo that one conjunct; the shape test demands it on every policy.
const noGuard = (x) => x.replace(/and\(select app\.is_staff_or_system\(\)\)/g, '').replace(/\(select app\.is_staff_or_system\(\)\)and/g, '');

// ================================================================ spec-side sanity (must pass now)
const P2_COLS = { cases: ['accession_no'], blocks: ['label'], slides: ['label'], batches: ['batch_no'], parts: ['letter'], images: ['object_path'] };
const P3_COLS = {      // §3 P3 column lists (names that exist in §6; "all content columns" of drafts / versions -> the narrative text, synoptic and diagnosis columns)
  cases: ['clinical_history_text'], parts: ['site_text', 'description_text'], gross_records: ['gross_text'], slides: ['finding_text', 'adequacy_code'], stain_orders: ['note'], object_movements: ['note', 'destination_text'],
  images: ['caption'], report_drafts: ['gross_text', 'microscopy_text', 'impression_text', 'comment_text'], report_versions: ['gross_text', 'microscopy_text', 'impression_text', 'comment_text', 'clinical_history_text', 'diagnosis_codes'],
  addenda: ['text'], molecular_results: ['result_code', 'value_decimal', 'comment_text'], case_items: ['order_item_id'],
};
const P3_OPTIONAL = ['item_submissions'];       // §3: "item_submissions (pseudonymous)" - whole table named, no column list: P3 allowed, not required
test('spec parsers sanity: 31 CREATE TABLE in §6 (1 G + 30 tenant; no event_inbox), no LIKE, 35 indexes, 7 triggers, 4 functions, 1 view (§8), 16 centre + 14 tenant RLS tables, 86 expected policies, 25 audited, no DEFINER', () => {
  const ddl = specDdl();
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 31, '31 CREATE TABLE in §6');
  assert.equal(G_N.length, 1); assert.equal(T_N.length, 30); assert.equal(INV.size, 32, '31 + event_inbox in §1');
  for (const q of ALLT) { const t = createTable(ddl, q); assert.ok(t, `spec has ${q}`); assert.equal(t.like, null, `${q}: no LIKE in the spec`); }
  assert.deepEqual([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].map((m) => m[1]).sort(), [...ALLT].sort(), '§1 inventory = §6 tables');
  assert.doesNotMatch(ddl, /CREATE\s+TABLE\s+anatomic\.event_inbox/i);
  assert.equal(createIndexes(ddl).length, 35, `spec indexes: ${createIndexes(ddl).length}`);
  assert.deepEqual(createTriggers(ddl).map(trgName).sort(), [...SPEC_TRG].sort());
  assert.deepEqual(fnNames(ddl).sort(), [...FN_GUARD].sort());
  assert.deepEqual([...specView().matchAll(/CREATE\s+VIEW\s+(\w+\.\w+)/gi)].map((m) => m[1]), [VIEW]);
  assert.doesNotMatch(ddl + specRls() + specView(), /SECURITY\s+DEFINER/i);
  const b = doBlock();
  assert.equal(b.centre.length, 16); assert.equal(b.tenant.length, 14);
  assert.deepEqual(b.centre.map(([t]) => t).sort(), [...CENTRE_N].sort(), 'cases + DO block centre tables = §1 "tenant + centre" rows');
  assert.deepEqual([...b.centre, ...b.tenant].map(([t]) => t).sort(), [...T_N].sort(), 'cases + DO block cover every tenant table exactly once (event_inbox is C0)');
  assert.ok(b.PC.includes('current_centre_ids())::uuid[]'), 'pred_c: ::uuid[] cast (08 A16.1)');
  assert.equal(b.PT, 'tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())');
  const ps = expectedPolicies();
  assert.equal(new Set(ps.map((p) => p.key)).size, ps.length); assert.equal(ps.length, EXPECTED_POLICY_COUNT, `expected policies: ${ps.length}`);
  assert.equal(AUDITED.length, 25, `§3 audited (M + C) tables: ${AUDITED.length}`);
  assert.deepEqual(T_N.filter((t) => CLS[t] === 'A').sort(), ['case_transitions', 'item_submissions', 'object_movements', 'report_versions'], '§1 class A rows');
  assert.equal(CLS[COUNTER], 'E', '§1: accession_counters is class E (P-18(a))');
  const refs = new Set([...ddl.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()).filter((x) => !x.startsWith('anatomic.')));
  assert.deepEqual([...refs].sort(), ['core.branches', 'core.collection_centres', 'core.memberships', 'core.tenants', 'frontdesk.order_items', 'frontdesk.orders', 'frontdesk.patients', 'lab.results', 'lab.specimens'], 'cross-schema FK list (no catalog FK: §1 FK direction)');
  for (const [t, cs] of Object.entries(P3_COLS)) for (const c of cs) assert.ok(createTable(ddl, `anatomic.${t}`).colMap.has(c), `§3 column ${t}.${c} exists in §6`);
  for (const [t, cs] of Object.entries(P2_COLS)) for (const c of cs) assert.ok(createTable(ddl, `anatomic.${t}`).colMap.has(c), `§3 P2 column ${t}.${c} exists in §6`);
  assert.deepEqual(spec2().match(/`g_cs_cancel_reasons`/g)?.length > 0, true);
});

// ================================================================ files, order, owner (AC-0B-6.1 / 6.3)
const WAVE2 = /_(quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection|migration_staging)__/;
test('migration files: >= 1 *_anatomic__*.sql, timestamps strictly after 20261114120000 (LD-202), after every wave-1 migration and after the quality and micro migrations (DAG: quality -> micro -> anatomic), unique; db/policies/anatomic.sql exists; schema creation IF NOT EXISTS', () => {
  assert.ok(aFiles().length >= 1, 'no db/migrations/*_anatomic__*.sql yet (T0B-13.C11 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => !WAVE2.test(f)), before = all.filter((f) => /_(quality|micro)__/.test(f));
  assert.ok(earlier.length >= 24, 'wave-1 migrations present'); assert.ok(before.length >= 2, 'quality + micro migrations present');
  for (const f of aFiles()) {
    assert.ok(f.slice(0, 14) > '20261114120000', `${f} must be later than 20261114120000`);
    for (const e of [...earlier, ...before]) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (anatomic follows analytics, quality and micro in the DAG, C0 05-SCHEMA §4 stage 5)`);
  }
  assert.ok(existsSync(polDir + 'anatomic.sql'), 'db/policies/anatomic.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(aSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)anatomic\b/i, 'schema anatomic exists since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every anatomic migration is SET LOCAL ROLE lims_owner and it is the only role switch (all objects owned by lims_owner); no standing CREATE grant, no role DDL, no CREATE EXTENSION (bootstrap owns pg_trgm / btree_gin)', () => {
  assert.ok(aFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+|SET\s+SESSION\s+AUTHORIZATION)/gi)].map((m) => ws(m[1]).toUpperCase());
  for (const f of aFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch`);
  }
  assert.doesNotMatch(aSql(), /GRANT\s+CREATE\s+ON\s+(SCHEMA\s+app|DATABASE)/i); assert.doesNotMatch(aSql(), /CREATE\s+ROLE|ALTER\s+ROLE/i); assert.doesNotMatch(aSql(), /CREATE\s+EXTENSION/i);
});

// ================================================================ tables (columns + constraints = spec exactly; only UNIQUE (tenant_id, id) may be added)
for (const q of ALLT) {
  test(`${q}: every spec column + constraint (name + text) present identically in the migration; no extra column; only UNIQUE (tenant_id, id) may be added; not created with LIKE (05-SCHEMA §6; C0 §9 rule 1)`, () => {
    const exp = createTable(specDdl(), q); assert.ok(exp, `spec table ${q}`);
    const sql = aSql(), got = createTable(sql, q);
    assert.ok(got, `CREATE TABLE ${q} not found in *_anatomic__*.sql`);
    assert.equal(got.like, null, `${q}: LIKE is not used anywhere in this schema`);
    for (const [c, def] of exp.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    for (const c of got.colMap.keys()) assert.ok(exp.colMap.has(c), `${q}: extra column ${c} (the spec DDL is complete)`);
    for (const [c, def] of exp.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    for (const [c, def] of got.conMap) if (!exp.conMap.has(c)) assert.match(def, /^constraint\s+\w+\s+unique\(tenant_id,id\)$/, `${q}: extra constraint ${c} (only UNIQUE (tenant_id, id) may be added)`);
  });
}
test('exactly the 31 §6 tables are created in anatomic (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9); table count == spec count; every constraint is named <table>__*; every cs_* table has <table>__tenant__fk; the three coded-set CHECK value lists of §2.1 are present', () => {
  const sql = aSql(), bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.equal(made.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'migration CREATE TABLE count == spec CREATE TABLE count (impl note states both)');
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(bare, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /event_inbox/i, 'C11 migrations do not touch event_inbox (T0B-05 owns it)');
  for (const q of TENANT) for (const c of ['id', 'tenant_id']) { const def = createTable(sql, q)?.colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`); }
  for (const q of ALLT) { const t = q.split('.')[1]; for (const c of createTable(sql, q).conMap.keys()) assert.ok(c.startsWith(t + '__'), `${q}: constraint ${c} must be prefixed ${t}__`); }
  for (const q of TENANT.filter((x) => /\.cs_/.test(x))) assert.ok(createTable(sql, q).conMap.has(`${q.split('.')[1]}__tenant__fk`), `${q}: <table>__tenant__fk`);
  const sql2 = norm(sql);
  for (const v of ['received,accessioned,in_processing,ready_for_reporting,signed_out,cancelled', 'histology,cytology,ihc,molecular', 'stored,retrieved,sent_out,returned,discarded', 'second_opinion,external_stain,consultation,retention_expired,other', 'pending,clean,infected,unavailable', 'part,addon,aliquot_ignored,not_anatomic'])
    assert.ok(sql2.includes(v.split(',').map((x) => `'${x}'`).join(',')), `§2.1 value list ${v}`);
});
test('cross-schema references (01-CM §5 R3): anatomic -> anatomic / core / frontdesk / lab only, identical target set to the spec; NO FK into catalog (§1: tests may be global rows, validated through CatalogPort), billing, reporting, analytics, identity, instruments, quality, micro; nothing in an upstream schema references anatomic (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(aSql()), exp = tgt(specDdl());
  assert.deepEqual([...got].sort(), [...exp].sort(), 'FK target tables equal the spec');
  for (const t of got) assert.match(t, /^(anatomic|core|frontdesk|lab)\./, `anatomic FK target ${t}`);
  const upstream = files().filter((f) => /_(core|app|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics|storage|quality|micro)__/.test(f));
  assert.doesNotMatch(upstream.map(read).join('\n'), /\bREFERENCES\s+anatomic\./i, 'no FK into anatomic from an upstream schema');
});
test('indexes: every §6 CREATE INDEX present with identical definition (partial predicates, DESC, GIN trigram with schema-qualified opclass); no extra index; every §4 index name exists as an index or a constraint; tenant_id leads every index and UNIQUE / PRIMARY KEY (except PRIMARY KEY (id))', () => {
  const sql = aSql(), have = new Map(createIndexes(sql).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  assert.equal(exp.length, 35);
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].sort(), exp.map(idxName).sort(), 'no index beyond the spec');
  for (const n of ['cases__tenant_id_accession_no__p_uq', 'cases__open_case__p_uq', 'cases__tenant_id_status_received__p_idx', 'slides__tenant_id_block_seq__p_uq', 'slides__tenant_id_part_seq__p_uq', 'slides__tenant_id_pending__p_idx', 'stain_orders__tenant_id_open__p_idx',
    'report_drafts__tenant_id_case_open__p_uq', 'report_drafts__tenant_id_case_initial__p_uq', 'molecular_results__tenant_id_case_target__p_uq', 'batch_members__tenant_id_batch_position__p_uq', 'batch_members__tenant_id_batch_case__p_uq', 'synoptic_templates__tenant_id_key_published__p_uq', 'images__tenant_id_case__idx'])
    assert.match(have.get(n) ?? '', /\bwhere\b/, `${n} is partial`);
  assert.match(have.get('cs_diagnoses__tenant_id_display__trgm_idx'), /using gin\(tenant_id,display extensions\.gin_trgm_ops\)/, 'tenant-leading trigram GIN, opclass schema-qualified (08 A31.1)');
  assert.match(have.get('cases__tenant_id_received__idx'), /received_at desc/); assert.match(have.get('cases__tenant_id_accessioned__idx'), /accessioned_at desc/); assert.match(have.get('report_versions__tenant_id_case__idx'), /version_no desc/);
  const conNames = new Set(ALLT.flatMap((q) => [...createTable(sql, q).conMap.keys()]));
  const missing = [...new Set([...spec4().matchAll(/`([a-z_0-9]+__[a-z_0-9]*(?:uq|idx|pk))\b/g)].map((m) => m[1]))].filter((n) => !have.has(n) && !conNames.has(n));
  assert.deepEqual(missing, [], '§4 index names that exist neither as CREATE INDEX nor as a constraint');
  for (const s of createIndexes(sql)) assert.equal(/\bON\s+\w+\.\w+\s*(?:USING\s+\w+\s*)?\(\s*([^,)]+)/i.exec(s)[1].trim(), 'tenant_id', `index ${idxName(s)} leads with tenant_id`);
  for (const q of TENANT) for (const c of [...createTable(sql, q).conMap.values()].filter((x) => /\b(primary key|unique)\(/.test(x))) {
    const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1]; if (/primary key/.test(c) && k === 'id') continue;
    assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${c}`);
  }
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A10.5, A16.1, A17 P-16)
test('ENABLE + FORCE ROW LEVEL SECURITY (literal statements, no DO block) on the 30 tenant tables; none on g_cs_cancel_reasons; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = aSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of G_T) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(aSql(), /\bDO\s+\$/i, 'literal statements only (C0 expands the spec DO block; the policy dump / CI tools read the files)'); assert.doesNotMatch(polSql(), /\bDO\s+\$/i);
  assert.doesNotMatch(aSql() + polSql(), /EXECUTE\s+format\s*\(/i);
});
const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('anatomic.') && !/\.event_inbox$/.test(p.table));
test('policies: db/policies/anatomic.sql holds EXACTLY the expected 86 policies (cases example + DO block expanded): name, command, role, USING, WITH CHECK (modulo the staff-guard conjunct); no policy on g_cs_cancel_reasons; no DELETE policy; only event_inbox may be extra', () => {
  const exp = expectedPolicies(), got = gotPolicies();
  assert.ok(got.length > 0, 'db/policies/anatomic.sql has no CREATE POLICY');
  const byKey = new Map(got.map((p) => [p.key, p])); assert.equal(byKey.size, got.length, 'no duplicate policy');
  for (const e of exp) {
    const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(noGuard(g.using), noGuard(e.using), `${e.key} USING`); assert.equal(noGuard(g.check), noGuard(e.check), `${e.key} WITH CHECK`);
  }
  assert.deepEqual([...byKey.keys()].sort(), exp.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access)');
  assert.deepEqual(got.filter((p) => p.cmd === 'DELETE').map((p) => p.key), [], 'no DELETE policy on any anatomic table (§6 immutability summary; counter is never purged)');
  for (const p of policies(polSql()).filter((x) => /\.event_inbox$/.test(x.table))) assert.match(p.name, /^event_inbox__(select|insert|delete)__(tenant|owner_only)$/, `${p.key}: only the C0 inbox shapes may appear`);
});
test('policy shape: names <table>__<cmd>__(tenant|tenant_centre); all TO lims_app; staff guard in USING and WITH CHECK of every policy (P-16, gate 9); centre tables: has_all_centres OR centre_id = ANY(...::uuid[]) (A16.1); tenant predicate everywhere; no true / PUBLIC / anon; no UPDATE policy on the 4 class A tables', () => {
  const ps = gotPolicies(); assert.equal(ps.length, EXPECTED_POLICY_COUNT, `policies: ${ps.length}`);
  const noUpd = NO_UPDATE_N(); assert.deepEqual([...noUpd].sort(), ['case_transitions', 'item_submissions', 'object_movements', 'report_versions'], 'DO block "-" tables = §1 class A rows');
  for (const p of ps) {
    const tbl = p.table.split('.')[1], m = new RegExp(`^${tbl}__${p.cmd.toLowerCase()}__(tenant|tenant_centre)$`).exec(p.name);
    assert.ok(m, `${p.key}: name <table>__<cmd>__<scope>`); assert.equal(p.roles, 'lims_app', `${p.key} roles`);
    const t = p.using + ' ' + p.check;
    assert.match(t, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: tenant predicate`);
    assert.equal(m[1] === 'tenant_centre', CENTRE_T.includes(p.table), `${p.key}: centre scope exactly on the 16 centre tables`);
    if (m[1] === 'tenant_centre') { assert.match(t, /has_all_centres/); assert.match(t, /any\(\(select app\.current_centre_ids\(\)\)::uuid\[\]\)/, `${p.key}: A16.1 cast`); }
    else assert.doesNotMatch(t, /current_centre_ids|has_all_centres/, `${p.key}: tenant tables (incl. batches, batch_members) are not centre scoped`);
    if (p.cmd !== 'INSERT') assert.match(p.using, STAFF, `${p.key} USING lacks the staff guard (P-16, gate 9 check-registry)`);
    if (p.cmd === 'INSERT' || p.cmd === 'UPDATE') assert.match(p.check, STAFF, `${p.key} WITH CHECK lacks the staff guard`);
    assert.doesNotMatch(t, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|is_platform_actor|app\.maintenance|app\.pre_/, p.key);
    assert.ok(!isG(p.table), `${p.key}: G tables carry no policy`);
  }
  for (const t of noUpd) assert.equal(ps.filter((p) => p.table === `anatomic.${t}` && p.cmd === 'UPDATE').length, 0, `anatomic.${t}: no UPDATE policy (§6 immutability summary)`);
  assert.equal(ps.filter((p) => p.table === 'anatomic.accession_counters').map((p) => p.cmd).sort().join(), 'INSERT,SELECT,UPDATE', 'counter: tenant-scoped select / insert / update, no delete (P-18(a))');
});
test('policies written literally in migrations are identical to db/policies/anatomic.sql (AC-0B-2.3 copy)', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(aSql()).filter((x) => x.table.startsWith('anatomic.') && !/\.event_inbox$/.test(x.table));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort(), 'every policy of the file is created by a migration and vice versa');
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §7 loops + cases example + view GRANT)
test('grants equal the §7 loops: lims_app SELECT+INSERT+UPDATE where marked u (cases, 11 centre, 14 tenant incl. accession_counters), SELECT+INSERT where marked - (the 4 class A tables); SELECT on g_cs_cancel_reasons; the view to lims_app + lims_analytics; NO DELETE anywhere; nothing to other roles', () => {
  const sql = aSql() + '\n;\n' + polSql(), g = grantsOf(sql), upd = UPD_N();
  const privs = (q, r) => [...(g.get(q)?.get(r)?.all ?? [])].sort();
  assert.equal(upd.length, 26, 'cases + 11 centre + 14 tenant UPDATE tables');
  for (const t of T_N) assert.deepEqual(privs(`anatomic.${t}`, 'lims_app'), upd.includes(t) ? ['INSERT', 'SELECT', 'UPDATE'] : ['INSERT', 'SELECT'], `anatomic.${t} lims_app`);
  for (const q of G_T) assert.deepEqual(privs(q, 'lims_app'), ['SELECT'], `${q} lims_app`);
  assert.deepEqual(privs(VIEW, 'lims_app'), ['SELECT']); assert.deepEqual(privs(VIEW, 'lims_analytics'), ['SELECT'], '§8 GRANT SELECT ... TO lims_app, lims_analytics (C0 §9 rule 3)');
  const expTargets = new Set([...ALLT, VIEW]); assert.equal(expTargets.size, 32);
  for (const [t, rm] of g) if (/^anatomic\./.test(t)) {
    assert.ok(expTargets.has(t), `${t}: unexpected grant target`);
    for (const [r, p] of rm) {
      assert.ok(t === VIEW ? ['lims_app', 'lims_analytics'].includes(r) : r === 'lims_app', `${t}: unexpected grantee ${r}`);
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL', 'DELETE']) assert.ok(!p.all.has(bad) && !p.cols.has(bad), `${t}: ${r} must not hold ${bad}`);
      assert.equal(p.cols.size, 0, `${t}: whole-table grants only`);
    }
  }
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\banatomic\./i); assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+anatomic\b/i); assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\banatomic\b/i);
  assert.doesNotMatch(sql, /GRANT\b[^;]*\bDELETE\b[^;]*\banatomic\./i, 'no DELETE grant in the schema (02-CV §5.6)');
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\banatomic\./i.test(s) && !/FUNCTION/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner)\b/i, s);
  for (const t of T_N.filter((x) => CLS[x] === 'A')) assert.ok(!privs(`anatomic.${t}`, 'lims_app').includes('UPDATE'), `class A anatomic.${t}: no UPDATE (AC-0B-4.3)`);
  assert.equal(T_N.filter((x) => CLS[x] === 'A').length, 4);
});

// ================================================================ functions + triggers (AC-0B-4.1; §6)
test('the 4 guard functions equal the §6 text (guard_synoptic_template, guard_case, guard_report_draft, guard_addendum): SECURITY INVOKER plpgsql RETURNS trigger with search_path = \'\', P0001 / immutable_row; no other function; no DEFINER, no inventory entry', () => {
  const sql = aSql(), exp = specDdl();
  for (const f of FN_GUARD) {
    const got = fnText(sql, f); assert.ok(got, `${f} missing (05-SCHEMA §6)`);
    assert.equal(norm(got), norm(fnText(exp, f)), `${f} body equals the spec`);
    assert.match(got, /RETURNS\s+trigger/i, f); assert.match(got, /LANGUAGE\s+plpgsql/i, f); assert.match(got, /SET\s+search_path\s*=\s*''/i, f); assert.doesNotMatch(got, /SECURITY\s+DEFINER/i, `${f} is INVOKER`);
    assert.match(got, /ERRCODE\s*=\s*'P0001'/i, f); assert.match(got, /MESSAGE\s*=\s*'immutable_row'/i, f);
  }
  assert.match(fnText(sql, 'anatomic.guard_case'), /accession_no/); assert.match(fnText(sql, 'anatomic.guard_addendum'), /'signed'/); assert.match(fnText(sql, 'anatomic.guard_report_draft'), /<>\s*'open'/); assert.match(fnText(sql, 'anatomic.guard_synoptic_template'), /'published'/);
  assert.deepEqual(fnNames(sql).sort(), [...FN_GUARD].sort(), 'no function beyond the four');
  assert.doesNotMatch(sql, /SECURITY\s+DEFINER/i, 'C11 has no SECURITY DEFINER function (§7: "Guard functions: owned by lims_owner, SECURITY INVOKER (not in the DEFINER inventory)")');
});
test('triggers: the 7 spec triggers equal the §6 text (3 mutable_columns lists on blocks / slides / images, 4 guard triggers); no other non-audit trigger; none disabled or dropped; blocks.label, slides.label and images.sha256 / object_path stay immutable (§11 item 4)', () => {
  const sql = aSql(), trg = createTriggers(sql).filter((s) => !isAudit(s)), exp = new Map(createTriggers(specDdl()).map((s) => [trgName(s), s]));
  assert.equal(trg.length, 7, `non-audit triggers: ${trg.map(trgName).join(',')}`);
  for (const n of SPEC_TRG) assert.equal(norm(trg.find((s) => trgName(s) === n) ?? ''), norm(exp.get(n)), `trigger ${n}`);
  const mut = (t) => trgArgs(trg.find((s) => trgName(s) === `${t}__mutable_columns`), 'app\\.enforce_mutable_columns');
  for (const [t, cols] of Object.entries({ blocks: mut('blocks'), slides: mut('slides'), images: mut('images') })) for (const c of cols) assert.ok(createTable(sql, `anatomic.${t}`).colMap.has(c), `${t}.${c} is a real column`);
  for (const c of ['label', 'case_id', 'part_id', 'seq', 'tenant_id', 'centre_id']) assert.ok(!mut('blocks').includes(c), `blocks.${c} stays immutable`);
  for (const c of ['label', 'case_id', 'part_id', 'block_id', 'seq', 'stain_id', 'tenant_id']) assert.ok(!mut('slides').includes(c), `slides.${c} stays immutable`);
  for (const c of ['sha256', 'object_path', 'bucket', 'mime_type', 'byte_size', 'width_px', 'height_px', 'case_id', 'tenant_id']) assert.ok(!mut('images').includes(c), `images.${c} stays immutable (written once from AcceptedUpload)`);
  for (const [t, f] of [['synoptic_templates', 'guard_synoptic_template'], ['cases', 'guard_case'], ['report_drafts', 'guard_report_draft'], ['addenda', 'guard_addendum']])
    assert.match(trg.find((s) => trgName(s) === `${t}__guard`), new RegExp(`^CREATE TRIGGER ${t}__guard BEFORE UPDATE ON anatomic\\.${t} FOR EACH ROW EXECUTE FUNCTION anatomic\\.${f}\\(\\s*\\)$`, 'i'), `${t} guard is BEFORE UPDATE FOR EACH ROW`);
  assert.doesNotMatch(sql, /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(sql, /DROP\s+TRIGGER\b/i);
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x; spec §3 "audited: true for every M and C table"): <t>__audit AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW on exactly the 25 audited tables (11 M, 14 C); none on the 4 class A tables, the class E counter or the G table', () => {
  const trg = createTriggers(aSql()).filter(isAudit), onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  assert.equal(AUDITED.length, 25); assert.equal(T_N.filter((t) => CLS[t] === 'M').length, 11); assert.equal(T_N.filter((t) => CLS[t] === 'C').length, 14);
  for (const q of AUDITED) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(\\s*\\)$`, 'i'), q);
  }
  for (const q of ALLT.filter((x) => !AUDITED.includes(x))) assert.equal(onTable(q).length, 0, `${q} must NOT be audited (§3: only M and C tables)`);
  assert.equal(trg.length, 25);
});

// ================================================================ DEFINER inventory (none)
test('db/meta/definer-inventory.yaml has no anatomic row (C11 adds no SECURITY DEFINER function; the 4 guard functions are INVOKER)', () => {
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  assert.deepEqual(Object.keys(inv).filter((k) => /anatomic/i.test(k)), []);
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const MAND = { M: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'is_active'], C: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version'], A: ['id', 'tenant_id', 'created_at', 'created_by'],
  E: ['id', 'tenant_id', 'created_at', 'expires_at'], G: ['id', 'created_at', 'is_active'] };
test('tables.yaml: all 31 anatomic tables registered (class G/M/C/A/E per §1, centre_scoped exactly the 16 centre tables, audited = §3 = trigger, retention, no shared_with, columns = the migration columns, phi_class P0..P3); the count equals the CREATE TABLE count; event_inbox entry untouched', () => {
  const y = tablesYaml(), regs = Object.keys(y).filter((k) => /^anatomic\./.test(k) && !/\.event_inbox$/.test(k));
  assert.equal(regs.length, 31, 'tables.yaml anatomic entries (ex event_inbox)'); assert.equal(regs.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'tables.yaml count == chunk DDL count');
  const trgAudited = (q) => createTriggers(aSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of ALLT) {
    const e = y[q], t = q.split('.')[1]; assert.ok(e, `${q} in tables.yaml`);
    assert.equal(e.class, isG(q) ? 'G' : CLS[t], `${q} class (§1)`);
    assert.equal(e.centre_scoped, CENTRE_T.includes(q), `${q} centre_scoped`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`); assert.equal(e.audited, AUDITED.includes(q), `${q} audited per §3`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), [...createTable(aSql(), q).colNames.map((c) => c.replace(/"/g, ''))].sort(), `${q} columns = migration columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
    assert.deepEqual([...(e.shared_with ?? [])], [], `${q}: nothing shared with partner / portal / patient (§7 "No anatomic table is shared")`);
  }
  assert.ok(y['anatomic.event_inbox'].class === 'A', 'inbox entry remains as C0 wrote it');
});
test('tables.yaml phi_class (§3): P2 only on cases.accession_no, blocks.label, slides.label, batches.batch_no, parts.letter, images.object_path (all required); P3 on the clinical tables with at least the §3 columns marked P3 (item_submissions optional); every other table P0..P1; created_by / updated_by P0..P1', () => {
  const y = tablesYaml();
  for (const q of ALLT) {
    const t = q.split('.')[1], cols = Object.entries(y[q].columns), has3 = cols.some(([, p]) => p === 'P3');
    if (t in P3_COLS) assert.ok(has3, `${q}: P3 required (§3)`); else if (!P3_OPTIONAL.includes(t)) assert.ok(!has3, `${q}: P3 forbidden (§3)`);
    for (const [c, p] of cols) {
      if (p === 'P2') assert.ok((P2_COLS[t] ?? []).includes(c), `${q}.${c}: P2 only on ${JSON.stringify(P2_COLS)}`);
      if (['created_by', 'updated_by'].includes(c)) assert.ok(['P0', 'P1'].includes(p), `${q}.${c}`);
    }
    for (const c of P3_COLS[t] ?? []) assert.equal(y[q].columns[c], 'P3', `${q}.${c} must be P3 (§3)`);
    for (const c of P2_COLS[t] ?? []) assert.equal(y[q].columns[c], 'P2', `${q}.${c} must be P2 (§3)`);
  }
  for (const q of ALLT.filter((x) => !(x.split('.')[1] in P3_COLS) && !P3_OPTIONAL.includes(x.split('.')[1]))) for (const [c, p] of Object.entries(y[q].columns)) assert.ok(p === 'P0' || p === 'P1' || (p === 'P2' && (P2_COLS[q.split('.')[1]] ?? []).includes(c)), `${q}.${c}: ${p}`);
  for (const t of ['id', 'tenant_id', 'status', 'version']) for (const q of TENANT) if (y[q].columns[t]) assert.equal(y[q].columns[t], 'P1', `${q}.${t} is P1 (§3: ids, version, status)`);
});
test('tables.yaml: rls_exempt only on g_cs_cancel_reasons (with a reason); mandatory_column_exceptions = exactly the class-mandatory columns the DDL lacks, with a reason (accession_counters, class E: must name id and expires_at, may add version / is_active per §1); every other table carries all of them (02-CV §5.2)', () => {
  const y = tablesYaml();
  assert.match(spec1(), /Mandatory-column exceptions/); assert.match(spec1(), /accession_counters/);
  for (const q of ALLT) {
    const e = y[q], cls = isG(q) ? 'G' : CLS[q.split('.')[1]], cols = new Set(createTable(aSql(), q).colNames);
    if (isG(q)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    const missing = MAND[cls].filter((c) => !cols.has(c)).sort(), got = [...(e.mandatory_column_exceptions ?? [])].sort();
    if (q === `anatomic.${COUNTER}`) {
      assert.deepEqual(missing, ['expires_at', 'id'], 'the DDL really lacks id and expires_at'); for (const c of missing) assert.ok(got.includes(c), `${q}: exception for ${c} (§1)`);
      for (const c of got) assert.ok(['id', 'expires_at', 'version', 'is_active'].includes(c), `${q}: unexpected exception ${c}`);
    } else assert.deepEqual(got, missing, `${q}: mandatory_column_exceptions must list exactly the missing class-${cls} columns`);
    if (got.length) assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 5, `${q}: mandatory_column_exceptions_reason`);
    assert.equal(isG(q), !cols.has('tenant_id'));
  }
  for (const q of TENANT.filter((x) => x !== `anatomic.${COUNTER}`)) assert.deepEqual(y[q].mandatory_column_exceptions ?? [], [], `${q}: no exception`);
  assert.deepEqual(y['anatomic.g_cs_cancel_reasons'].mandatory_column_exceptions ?? [], [], 'the G table has an id (unlike micro): no exception');
});
test('tables.yaml retention (§10): case-derived C/A rows + report versions + images: retention / no purge / never deleted; master data never deleted; accession_counters forever; g_cs_cancel_reasons seed / permanent; event_inbox 90 days', () => {
  assert.match(spec10(), /accession_counters/); const r = (q) => tablesYaml()[`anatomic.${q}`].retention;
  for (const q of T_N.filter((t) => ['C', 'A'].includes(CLS[t]))) assert.match(r(q), /never deleted|retention|year|no purge|kept/i, q);
  for (const q of T_N.filter((t) => CLS[t] === 'M')) assert.match(r(q), /never deleted|kept|forever|permanent|deactivate/i, q);
  assert.match(r(COUNTER), /forever|never deleted|kept/i);
  for (const q of G_N) assert.match(r(q), /seed|permanent|never deleted|kept|forever|global/i, q);
  assert.match(tablesYaml()['anatomic.event_inbox'].retention, /90 days/);
});
test('db/tests/rls_exempt.txt lists exactly anatomic.g_cs_cancel_reasons with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^anatomic\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), [...G_T].sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ seeds (§2.2; "seeded by migration, never edited by users")
const SEED = { g_cs_cancel_reasons: [['duplicate_case', 'Duplicate case'], ['entered_in_error', 'Entered in error'], ['specimen_not_received', 'Specimen not received'], ['order_cancelled', 'Order cancelled'], ['other', 'Other']] };
test('seed rows (§2.2): g_cs_cancel_reasons seeded by the migration with exactly the 5 spec codes + displays, system = lims / system_version = 1 (explicit or by column default); nothing else seeded (no diagnoses, adequacy, Bethesda, ICD-O, SNOMED, synoptic content; no change reasons); INSERTs name their columns; no other INSERT into anatomic', () => {
  const sql = aSql(), s2 = ws(spec2()), lit = (v) => /^'(.*)'$/.exec(v)?.[1];
  for (const [t, rows] of Object.entries(SEED)) for (const r of rows) for (const v of r) assert.ok(s2.includes(v), `seed value "${v}" of ${t} is in spec §2.2`);
  for (const [t, want] of Object.entries(SEED)) {
    const rows = insertRows(sql, `anatomic.${t}`); assert.equal(rows.length, want.length, `anatomic.${t}: ${want.length} seed rows`);
    assert.deepEqual(rows.map((r) => [lit(r.code), lit(r.display)]).sort(), want.map((x) => [...x]).sort(), `anatomic.${t} seed = spec §2.2`);
    for (const r of rows) {
      assert.ok('id' in r, `anatomic.${t}: the G table has an id with no default: every seed row names it`);
      assert.ok(lit(r.display)?.length >= 1 && lit(r.display).length <= 200, `${t} display`);
      if ('system' in r) assert.equal(lit(r.system), 'lims'); if ('system_version' in r) assert.equal(lit(r.system_version), '1');
    }
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'seed ids are distinct');
  }
  const tables = [...new Set(stmts(sql).map(ws).filter((s) => /^INSERT\s+INTO\b/i.test(s)).map((s) => /INTO\s+(\S+)/i.exec(s)[1]))].sort();
  assert.deepEqual(tables, ['anatomic.g_cs_cancel_reasons'], 'no other INSERT in the anatomic migrations (settings / H&E stain are created lazily by the service, P-22; fixtures belong to packages/test-fixtures)');
  assert.doesNotMatch(sql, /g_cs_change_reasons|cs_change_reasons/i, 'D-62: C11 keeps no change-reason coded set');
});

// ================================================================ view (IC §6.8; 05-SCHEMA §8)
const icCols = () => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8').replace(/\r\n?/g, '\n'), a = ic.indexOf('### 6.8 ');
  assert.ok(a >= 0, 'IC §6.8'); const row = ic.slice(a).split('\n').find((l) => l.startsWith('| `anatomic.v_pub_report_content`')); assert.ok(row, 'IC §6.8 anatomic row');
  return splitTop(row.split('|')[2]).map((c) => /^\s*`?(\w+)/.exec(c)[1]);
};
const viewStmt = (sql, name) => { const s = stmts(sql).find((x) => new RegExp(`^CREATE\\s+(OR\\s+REPLACE\\s+)?VIEW\\s+${esc(name)}\\b`, 'i').test(ws(x))); return s ? ws(s) : null; };
const firstSelectCols = (v) => {
  const m = /\bAS\s+SELECT\s+([\s\S]+?)\s+FROM\b/i.exec(v); assert.ok(m, `view select list: ${v.slice(0, 80)}`);
  return splitTop(m[1]).map((item) => { const a = /\bAS\s+(\w+)\s*$/i.exec(item.trim()); return a ? a[1] : item.trim().split('.').pop(); });
};
const PUB = ['tenant_id', 'entity_id', 'version_no', 'order_item_id', 'accession_no', 'case_kind', 'gross_text', 'microscopy_text', 'impression_text', 'synoptic', 'images', 'signed_by_membership_id', 'signed_at',
  'version_kind', 'scope', 'change_reason_code', 'clinical_history_text', 'comment_text', 'specimen_parts', 'slides', 'ancillary', 'molecular', 'addenda', 'diagnosis_codes'];
test('view column contract vs IC §6.8 (+ CR-C11-001): anatomic.v_pub_report_content has exactly the 24 columns tenant_id .. signed_at (13, IC) then version_kind .. diagnosis_codes (11, CR-C11-001) in that order; no report_phase column (always final)', () => {
  const ic = icCols(), got = viewStmt(aSql(), VIEW), exp = viewStmt(specView(), VIEW);
  assert.deepEqual(ic, PUB, 'IC §6.8'); assert.ok(got, 'CREATE VIEW anatomic.v_pub_report_content missing from *_anatomic__*.sql');
  assert.deepEqual(firstSelectCols(exp), ic, 'spec §8 SQL vs IC §6.8'); assert.deepEqual(firstSelectCols(got), ic, 'migration columns (names + order) vs IC §6.8');
  assert.ok(!firstSelectCols(got).includes('report_phase'), '03-IC §6.8 lists no report_phase for anatomic');
});
test('view v_pub_report_content: definition equals §8 (WITH (security_invoker = true), FROM item_submissions JOIN case_items / report_versions / cases on tenant_id + id), SELECT granted to lims_app and lims_analytics only; the only view; not materialized; no function / BYPASSRLS shortcut', () => {
  const sql = aSql(), got = viewStmt(sql, VIEW);
  assert.equal(norm(got), norm(viewStmt(specView(), VIEW)), 'view text');
  assert.match(got, /WITH\s*\(\s*security_invoker\s*=\s*(true|on)\s*\)/i); assert.match(got, /FROM anatomic\.item_submissions s JOIN anatomic\.case_items ci ON ci\.tenant_id = s\.tenant_id/i);
  for (const t of ['case_items', 'report_versions', 'cases']) assert.match(got, new RegExp(`JOIN anatomic\\.${t}\\s+\\w+\\s+ON \\w+\\.tenant_id\\s*=\\s*s\\.tenant_id`, 'i'), `join ${t} is tenant-scoped`);
  const g = grantsOf(sql).get(VIEW); assert.ok(g, `GRANT on ${VIEW}`); assert.deepEqual([...g.keys()].sort(), ['lims_analytics', 'lims_app']); for (const r of g.keys()) assert.deepEqual([...g.get(r).all], ['SELECT']);
  const made = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(MATERIALIZED\s+)?(?:TEMP(?:ORARY)?\s+)?VIEW\s+(\w+\.\w+)/gi)];
  assert.deepEqual(made.map((m) => `${m[1] ? 'M:' : ''}${m[2]}`), [VIEW], 'exactly one view in anatomic');
});

// ================================================================ hygiene
test('C11 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of other schemas\' tables, no USING (true), no GRANT to PUBLIC; no Storage SQL (LD-54: buckets by HTTP provisioning; §9 storage.objects policy only after SP-4); no clinical vocab seeds', () => {
  const raw = aFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 40000, 'C11 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i); assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics|quality|micro)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016'); assert.doesNotMatch(strip(raw), /\bTO\s+PUBLIC\b/i);
  assert.doesNotMatch(strip(raw) + polSql(), /\bstorage\.(objects|buckets)\b/i, 'LD-54 / §9: no storage.objects policy and no bucket row in SQL');
  assert.doesNotMatch(strip(raw), /\b(bethesda|icd-?o|snomed)\b/i, '§2.2 Not seeded (licensing UNVERIFIED)');
});
test('LD-202 scope: no wave-1 migration, db/bootstrap, spec, service or app file is changed by this task (only anatomic files + policies + meta + tests are new / edited)', () => {
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', 'db/migrations', 'db/bootstrap', 'spec', 'services', 'apps'], { cwd: repo, encoding: 'utf8' });
  const changed = r.stdout.split('\n').filter(Boolean).filter((f) => !/^db\/migrations\/\d{14}_anatomic__/.test(f));
  assert.deepEqual(changed, [], 'tracked files outside the anatomic migrations were modified');
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts, check-migrations.ts and check-fk-dag.ts exit 0 on the tree (anatomic -> core / frontdesk / lab only; nothing into anatomic)', () => {
  assert.ok(aFiles().length >= 1, 'C11 migrations missing');
  for (const t of ['check-registry.ts', 'check-migrations.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 30 tenant C11 tables, none for the class G table, and gen-isolation-probes --check is clean; _registry.sql lists all 31', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const q of G_T) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/anatomic/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-13\.C11_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/anatomic/T0B-13.C11_*.test.sql exist (tester-owned: writer must keep them) and cover the AC list by "-- AC-0B-x.y" markers and 15 checks by "-- C11 check N" markers; RLS never disabled; replica mode only for the FK-parent fixtures and reset to origin', () => {
  assert.ok(tapFiles().length >= 2, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 15; n++) assert.match(txt, new RegExp(`-- C11 check ${n}\\b`), `marker for C11 check ${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.1', '6.2', '6.3']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
    const rep = [...s.matchAll(/session_replication_role\s*=\s*replica/gi)].length, org = [...s.matchAll(/session_replication_role\s*=\s*origin/gi)].length;
    assert.ok(rep === 0 || (org >= rep && s.lastIndexOf('= origin') > s.lastIndexOf('= replica')), `${f}: every replica fixture block is reset to origin before assertions`);
  }
});
