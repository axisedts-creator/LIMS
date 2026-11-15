// T0B-13.C10 static checks of the Wave-2 micro DDL translation: db/migrations/*_micro__*.sql, db/policies/micro.sql, db/meta/tables.yaml, v_pub_report_content + 10 internal v_<set> views,
// 3 trigger functions, 6 spec triggers + 2 guard triggers, 24 audit triggers, seeds of the 12 global coded sets.
// Spec: C10 05-SCHEMA §1-§10 (§1 inventory/class/audit, §2 value lists, §3 seeds + views, §4 RLS, §5 immutability, §6 published view, §7 PHI + retention, §8 DDL incl. the RLS DO block, §10 tests); IC §6.8;
// C0 05-SCHEMA §3.8 (audit), §9, §10; 02-CV §5.2/§5.3; 08 A16.1 (::uuid[] cast), A17 P-16 (staff guard), P-18 (class follows write path; purge path), D-63, D-65; LD-202 (translate exactly, no redesign, a gap = blocking CR).
// AC-0B-2.1..2.4, 3.5 (composite FK), 3.6 (probes), 4.1..4.3, 5.x (audit triggers), 6.1..6.3 (static part: order, role switch, FK direction), view column contract vs IC §6.8. AC-0B-6.4 is billing-only (T0B-11) and does not apply to micro.
// Run: node --test tests/db/T0B-13.C10.micro.test.mjs   (live: db/tests/micro/T0B-13.C10_*.test.sql via pg_prove; generated probes: db/tests/isolation/micro.*.test.sql)
// Method (as T0B-10.C2..C8, T0B-13.C9): the expected DDL is PARSED FROM C10 05-SCHEMA §8 at test time and compared (whitespace/case-normalised) with the migrations. The spec writes its RLS as a plpgsql DO block
// (format(...) loops over centre_tables / tenant_tables with pred_c / pred_t): the block is expanded here from the predicates and the table lists the spec itself declares; the migrations must hold the expansion as literal
// statements. What the spec only describes in prose (internal views "same pattern", the 2 guard functions, seeds §3.2, audit column of §1) is rebuilt from the spec's own text and that rebuild is checked in the sanity test.
// T0B13C10_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B13C10_ROOT ? resolve(process.env.T0B13C10_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const mFiles = () => files().filter((f) => /^\d{14}_micro__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const mSql = () => mFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'micro.sql') ? strip(readFileSync(polDir + 'micro.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C9)
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
// explicit table (cols + constraints, incl. constraints added by ALTER TABLE ... ADD CONSTRAINT); `like` is reported so a LIKE-created table can be refused (spec: "no table here is created with LIKE")
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

// ---------------------------------------------------------------- spec extraction (C10 05-SCHEMA)
const specPath = repo + 'spec/chunks/C10-microbiology/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = b0 ? s.indexOf(b0, a + a0.length) : s.length; assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const S1 = '## 1. Table inventory', S2 = '## 2. Status values', S3 = '## 3. Coded sets', S4 = '## 4. RLS', S5 = '## 5. Immutability', S6 = '## 6. Published view', S7 = '## 7. Columns', S8 = '## 8. DDL', S9 = '## 9. Index';
const specDdl = () => strip(sqlBlocks(between(specRaw(), S8, S9)));
const spec1 = () => between(specRaw(), S1, S2);
const spec3 = () => between(specRaw(), S3, S4);
const spec5 = () => between(specRaw(), S5, S6);
const spec6 = () => between(specRaw(), S6, S7);
const spec9 = () => between(specRaw(), S9, '## 10. Tests');

// ---- §1 inventory: class / scope / audited per table, parsed from the spec's table
function inventory() {
  const inv = new Map();
  for (const l of spec1().split('\n').filter((x) => /^\| `micro\./.test(x))) {
    const c = l.split('|');
    const cls = /([A-Z])/.exec(c[2].replace(/\*/g, ''))[1], scope = c[3].trim(), audited = /^\s*yes/i.test(c[4]);
    for (const m of c[1].matchAll(/`(?:micro\.)?([a-z_0-9]+)`/g)) inv.set(m[1], { cls, centre: /centre/.test(scope), global: scope === 'global', audited });
  }
  return inv;
}
const INV = inventory();
const G_N = [...INV].filter(([, v]) => v.cls === 'G').map(([k]) => k);
const T_N = [...INV].filter(([k, v]) => v.cls !== 'G' && k !== 'event_inbox').map(([k]) => k);
const CLS = Object.fromEntries(T_N.map((t) => [t, INV.get(t).cls]));
const G_T = G_N.map((t) => `micro.${t}`), TENANT = T_N.map((t) => `micro.${t}`), ALLT = [...G_T, ...TENANT];
const isG = (q) => /\.g_/.test(q);
const CENTRE_N = T_N.filter((t) => INV.get(t).centre), CENTRE_T = CENTRE_N.map((t) => `micro.${t}`);
const AUDITED = T_N.filter((t) => INV.get(t).audited).map((t) => `micro.${t}`);                 // §1 "Audited (C0 trigger)": yes
const SETS = ['organisms', 'organism_groups', 'antibiotics', 'media', 'specimen_sites', 'growth_codes', 'culture_outcomes', 'isolate_withdraw_reasons', 'culture_cancel_reasons', 'record_ignore_reasons'];
const VIEWS = [...SETS.map((s) => `micro.v_${s}`), 'micro.v_pub_report_content'];
const FN_SPEC = 'micro.tg_child_final_lock', FN_GUARD = ['micro.cultures_guard', 'micro.breakpoint_sets_guard'];
const SPEC_TRG = ['breakpoint_sets__mutable_columns', 'cultures__mutable_columns', 'culture_plates__final_lock', 'culture_observations__final_lock', 'isolates__final_lock', 'ast_results__final_lock'];
const E_TABLE = 'instrument_records';

// ---- §8 DO block: centre_tables / tenant_tables ('u' = UPDATE policy + grant, '-' = INSERT + SELECT only) and the two predicates
function doBlock() {
  const d = specDdl();
  const arr = (n) => { const m = new RegExp(`${n}\\s+text\\[\\]\\[\\]\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\];`).exec(d); assert.ok(m, `spec array ${n}`); return [...m[1].matchAll(/\['(\w+)','([u-])'\]/g)].map((x) => [x[1], x[2] === 'u']); };
  const pred = (n) => { const m = new RegExp(`${n}\\s+text\\s*:=\\s*\\$p\\$([\\s\\S]*?)\\$p\\$`).exec(d); assert.ok(m, `spec predicate ${n}`); return ws(m[1]); };
  return { centre: arr('centre_tables'), tenant: arr('tenant_tables'), PC: pred('pred_c'), PT: pred('pred_t') };
}
const UPD_N = () => { const b = doBlock(); return [...b.centre, ...b.tenant].filter(([, u]) => u).map(([t]) => t); };
const NO_UPDATE_N = () => { const b = doBlock(); return [...b.centre, ...b.tenant].filter(([, u]) => !u).map(([t]) => t); };

// ---- expected policies: the DO block expanded (3 or 2 policies per table) + the literal DELETE policy of the class E table
const GUARD = '(SELECT app.is_staff_or_system())';
function expectedPolicies() {
  const b = doBlock(), out = [];
  const add = (tbl, cmd, scope, using, check) => {
    let s = `CREATE POLICY ${tbl}__${cmd.toLowerCase()}__${scope} ON micro.${tbl} FOR ${cmd} TO lims_app`;
    if (using) s += ` USING (${using})`; if (check) s += ` WITH CHECK (${check})`;
    out.push(...policies(s));
  };
  for (const [t, u] of b.centre) { add(t, 'SELECT', 'tenant_centre', b.PC); add(t, 'INSERT', 'tenant_centre', null, b.PC); if (u) add(t, 'UPDATE', 'tenant_centre', b.PC, b.PC); }
  for (const [t, u] of b.tenant) { add(t, 'SELECT', 'tenant', b.PT); add(t, 'INSERT', 'tenant', null, b.PT); if (u) add(t, 'UPDATE', 'tenant', b.PT, b.PT); }
  return [...out, ...policies(specDdl()).filter((p) => p.cmd === 'DELETE')];
}
const EXPECTED_POLICY_COUNT = 88;       // centre: 8 x (select + insert) + 5 updates = 21; tenant: 23 x 2 + 20 updates = 66; + instrument_records__delete__tenant_centre
const STAFF = /\(select app\.is_staff_or_system\(\)\)/;
// Spec/gate conflict (as C5..C9): spec pred_c (and the DELETE policy) carry no is_staff_or_system() guard, but check-registry (P-16, gate 9) demands it on every __tenant / __tenant_centre policy of a table that is not
// shared_with. Policy comparison is therefore modulo that one conjunct; the shape test demands it on every policy.
const noGuard = (x) => x.replace(/and\(select app\.is_staff_or_system\(\)\)/g, '').replace(/\(select app\.is_staff_or_system\(\)\)and/g, '');

// ---- internal coded-set views: the spec gives one example (v_organisms) + "same pattern"
const BASEC = ['code', 'display', 'system', 'system_version', 'sort_order', 'is_active', 'created_at'];
const extrasOf = (set) => createTable(specDdl(), `micro.g_cs_${set}`).colNames.filter((c) => !BASEC.includes(c));
const viewColsOf = (set) => ['code', 'display', 'sort_order', 'is_active', ...extrasOf(set), 'source'];
function viewText(set) {
  const sel = (a) => ['code', 'display', 'sort_order', 'is_active', ...extrasOf(set)].map((c) => `${a}.${c}`).join(', ');
  return `CREATE VIEW micro.v_${set} WITH (security_invoker = true) AS SELECT ${sel('t')}, 'tenant'::text AS source FROM micro.cs_${set} t WHERE t.tenant_id = (SELECT app.current_tenant_id()) `
    + `UNION ALL SELECT ${sel('g')}, 'global' FROM micro.g_cs_${set} g WHERE NOT EXISTS (SELECT 1 FROM micro.cs_${set} t2 WHERE t2.tenant_id = (SELECT app.current_tenant_id()) AND t2.code = g.code)`;
}
const viewStmt = (sql, name) => { const s = stmts(sql).find((x) => new RegExp(`^CREATE\\s+(OR\\s+REPLACE\\s+)?VIEW\\s+${esc(name)}\\b`, 'i').test(ws(x))); return s ? ws(s) : null; };
const firstSelectCols = (v) => {
  const m = /\bAS\s+SELECT\s+([\s\S]+?)\s+FROM\b/i.exec(v); assert.ok(m, `view select list: ${v.slice(0, 80)}`);
  return splitTop(m[1]).map((item) => { const a = /\bAS\s+(\w+)\s*$/i.exec(item.trim()); return a ? a[1] : item.trim().split('.').pop(); });
};

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 43 CREATE TABLE in §8 (12 G + 31 tenant; no event_inbox), no LIKE, 27 indexes, 6 triggers, 1 function, 1 view, 8 centre + 23 tenant RLS tables, 88 expected policies, 24 audited, internal view generator = spec example, no DEFINER', () => {
  const ddl = specDdl();
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 43, '43 CREATE TABLE in §8');
  assert.equal(G_N.length, 12); assert.equal(T_N.length, 31); assert.equal(INV.size, 44, '43 + event_inbox in §1');
  for (const q of ALLT) { const t = createTable(ddl, q); assert.ok(t, `spec has ${q}`); assert.equal(t.like, null, `${q}: no LIKE in the spec`); }
  assert.deepEqual([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].map((m) => m[1]).sort(), [...ALLT].sort(), '§1 inventory = §8 tables');
  assert.doesNotMatch(ddl, /CREATE\s+TABLE\s+micro\.event_inbox/i);
  assert.equal(createIndexes(ddl).length, 27, `spec indexes: ${createIndexes(ddl).length}`);
  assert.deepEqual(createTriggers(ddl).map(trgName).sort(), [...SPEC_TRG].sort());
  assert.deepEqual(fnNames(ddl), [FN_SPEC]);
  assert.deepEqual([...ddl.matchAll(/CREATE\s+VIEW\s+(\w+\.\w+)/gi)].map((m) => m[1]), ['micro.v_organisms'], '§8 spells out one internal view; §6 the published one');
  assert.doesNotMatch(ddl, /SECURITY\s+DEFINER/i);
  const b = doBlock();
  assert.equal(b.centre.length, 8); assert.equal(b.tenant.length, 23); assert.deepEqual([...b.centre.map(([t]) => t)].sort(), [...CENTRE_N].sort(), 'DO block centre tables = §1 "tenant + centre" rows');
  assert.deepEqual([...b.centre, ...b.tenant].map(([t]) => t).sort(), [...T_N].sort(), 'DO block covers every tenant table exactly once (event_inbox is C0)');
  assert.ok(b.PC.includes('current_centre_ids())::uuid[]') && /actor_type\(\)\) IN \('user','system'\)/.test(b.PC), 'pred_c: ::uuid[] cast + actor type');
  assert.equal(b.PT, 'tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())');
  const ps = expectedPolicies();
  assert.equal(new Set(ps.map((p) => p.key)).size, ps.length); assert.equal(ps.length, EXPECTED_POLICY_COUNT, `expected policies: ${ps.length}`);
  assert.equal(AUDITED.length, 24, `§1 audited tables: ${AUDITED.length}`);
  assert.deepEqual(T_N.filter((t) => !INV.get(t).audited).sort(), ['breakpoint_bands', 'breakpoint_import_issues', 'breakpoint_rows', 'culture_observations', 'culture_transitions', 'report_versions', 'specimen_isolate_counters'], '§1 "no" rows');
  assert.equal(norm(viewText('organisms')), norm(viewStmt(ddl, 'micro.v_organisms')), 'view generator reproduces the spec example');
  const refs = new Set([...ddl.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()).filter((x) => !x.startsWith('micro.')));
  assert.deepEqual([...refs].sort(), ['catalog.tests', 'core.collection_centres', 'core.tenants', 'frontdesk.order_items', 'frontdesk.orders', 'frontdesk.patients', 'instruments.instruments', 'lab.results', 'lab.specimens'], 'cross-schema FK list');
  // the P3 / P2 column names of §7 used below really exist in the DDL
  for (const [t, cs] of Object.entries(P3_COLS)) for (const c of cs) assert.ok(createTable(ddl, `micro.${t}`).colMap.has(c), `§7 column ${t}.${c} exists in §8`);
});

// ================================================================ files, order, owner (AC-0B-6.1 / 6.3)
const WAVE2 = /_(quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection|migration_staging)__/;
test('migration files: >= 1 *_micro__*.sql, timestamps strictly after 20261114120000 (LD-202), after every wave-1 migration and after the quality migrations (DAG: quality -> micro), unique; db/policies/micro.sql exists; schema creation IF NOT EXISTS', () => {
  assert.ok(mFiles().length >= 1, 'no db/migrations/*_micro__*.sql yet (T0B-13.C10 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => !WAVE2.test(f)), quality = all.filter((f) => /_quality__/.test(f));
  assert.ok(earlier.length >= 24, 'wave-1 migrations present');
  for (const f of mFiles()) {
    assert.ok(f.slice(0, 14) > '20261114120000', `${f} must be later than 20261114120000`);
    for (const e of [...earlier, ...quality]) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (micro follows analytics and quality in the DAG, C0 05-SCHEMA l.402)`);
  }
  assert.ok(existsSync(polDir + 'micro.sql'), 'db/policies/micro.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(mSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)micro\b/i, 'schema micro exists since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every micro migration is SET LOCAL ROLE lims_owner and it is the only role switch (all objects owned by lims_owner); no standing CREATE grant, no role DDL', () => {
  assert.ok(mFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+|SET\s+SESSION\s+AUTHORIZATION)/gi)].map((m) => ws(m[1]).toUpperCase());
  for (const f of mFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch`);
  }
  assert.doesNotMatch(mSql(), /GRANT\s+CREATE\s+ON\s+(SCHEMA\s+app|DATABASE)/i); assert.doesNotMatch(mSql(), /CREATE\s+ROLE|ALTER\s+ROLE/i);
});

// ================================================================ tables (columns + constraints = spec exactly; only UNIQUE (tenant_id, id) may be added)
for (const q of ALLT) {
  test(`${q}: every spec column + constraint (name + text) present identically in the migration; no extra column; only UNIQUE (tenant_id, id) may be added; not created with LIKE (05-SCHEMA §8, review C10 #9; C0 §9 rule 1)`, () => {
    const exp = createTable(specDdl(), q); assert.ok(exp, `spec table ${q}`);
    const sql = mSql(), got = createTable(sql, q);
    assert.ok(got, `CREATE TABLE ${q} not found in *_micro__*.sql`);
    assert.equal(got.like, null, `${q}: LIKE is not used anywhere in this schema (LIKE does not copy FKs and keeps the source CHECK names)`);
    for (const [c, def] of exp.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    for (const c of got.colMap.keys()) assert.ok(exp.colMap.has(c), `${q}: extra column ${c} (the spec DDL is complete)`);
    for (const [c, def] of exp.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    for (const [c, def] of got.conMap) if (!exp.conMap.has(c)) assert.match(def, /^constraint\s+\w+\s+unique\(tenant_id,id\)$/, `${q}: extra constraint ${c} (only UNIQUE (tenant_id, id) may be added)`);
  });
}
test('exactly the 43 §8 tables are created in micro (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9); table count == spec count; every constraint is named <table>__* and every cs_* table has <table>__tenant__fk (§10 item 12)', () => {
  const sql = mSql(), bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.equal(made.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'migration CREATE TABLE count == spec CREATE TABLE count (impl note states both)');
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(bare, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /event_inbox/i, 'C10 migrations do not touch event_inbox (T0B-05 owns it)');
  for (const q of TENANT) for (const c of ['id', 'tenant_id']) { const def = createTable(sql, q)?.colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`); }
  for (const q of ALLT) { const t = q.split('.')[1]; for (const c of createTable(sql, q).conMap.keys()) assert.ok(c.startsWith(t + '__'), `${q}: constraint ${c} must be prefixed ${t}__`); }
  for (const q of TENANT.filter((x) => /\.cs_/.test(x))) assert.ok(createTable(sql, q).conMap.has(`${q.split('.')[1]}__tenant__fk`), `${q}: <table>__tenant__fk`);
});
test('cross-schema references (01-CM §5 R3): micro -> micro / core / catalog / frontdesk / lab / instruments only, identical target set to the spec; NO FK into billing / reporting / analytics / identity / quality; nothing in an upstream schema references micro (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(mSql()), exp = tgt(specDdl());
  assert.deepEqual([...got].sort(), [...exp].sort(), 'FK target tables equal the spec');
  for (const t of got) assert.match(t, /^(micro|core|catalog|frontdesk|lab|instruments)\./, `micro FK target ${t}`);
  const upstream = files().filter((f) => /_(core|app|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics|storage)__/.test(f));
  assert.doesNotMatch(upstream.map(read).join('\n'), /\bREFERENCES\s+micro\./i, 'no FK into micro from an upstream schema');
});
test('indexes: every §8 CREATE INDEX present with identical definition (partial predicates, DESC, coalesce expressions); no extra index; every §9 index name exists as an index or a constraint; tenant_id leads every index and UNIQUE / PRIMARY KEY (except PRIMARY KEY (id))', () => {
  const sql = mSql(), have = new Map(createIndexes(sql).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  assert.equal(exp.length, 27);
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].sort(), exp.map(idxName).sort(), 'no index beyond the spec');
  for (const n of ['plating_protocols__tenant_id_code__p_uq', 'plating_protocol_keys__tenant_id_key__p_uq', 'ast_panels__tenant_id_code__p_uq', 'ast_panels__tenant_id_scope__p_idx', 'instrument_vocab_maps__tenant_id_key__p_uq', 'breakpoint_sets__tenant_id_standard_sha__p_uq',
    'breakpoint_sets__tenant_id_standard_effective__p_idx', 'cultures__tenant_id_status_received__p_idx', 'cultures__tenant_id_next_read__p_idx', 'cultures__tenant_id_barcode__p_idx', 'instrument_records__tenant_id_open__p_idx',
    'instrument_records__tenant_id_barcode__p_idx', 'instrument_records__tenant_id_expires__p_idx', 'instrument_records__tenant_id_culture__idx']) assert.match(have.get(n) ?? '', /\bwhere\b/, `${n} is partial`);
  assert.match(have.get('breakpoint_rows__tenant_id_key__uq'), /coalesce\(organism_code,''\)/); assert.match(have.get('cultures__tenant_id_updated__idx'), /updated_at desc/); assert.match(have.get('breakpoint_sets__tenant_id_created__idx'), /created_at desc/);
  const conNames = new Set(ALLT.flatMap((q) => [...createTable(sql, q).conMap.keys()]));
  const missing = [...new Set([...spec9().matchAll(/`([a-z_0-9]+__[a-z_0-9]*(?:uq|idx|pk))\b/g)].map((m) => m[1]))].filter((n) => !have.has(n) && !conNames.has(n));
  assert.deepEqual(missing, [], '§9 index names that exist neither as CREATE INDEX nor as a constraint');
  for (const s of createIndexes(sql)) assert.equal(/\bON\s+\w+\.\w+\s*\(\s*([^,)]+)/i.exec(s)[1].trim(), 'tenant_id', `index ${idxName(s)} leads with tenant_id`);
  for (const q of TENANT) for (const c of [...createTable(sql, q).conMap.values()].filter((x) => /\b(primary key|unique)\(/.test(x))) {
    const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1]; if (/primary key/.test(c) && k === 'id') continue;
    assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${c}`);
  }
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A10.5, A16.1, A17 P-16/P-18)
test('ENABLE + FORCE ROW LEVEL SECURITY (literal statements, no DO block) on the 31 tenant tables; none on the 12 g_* tables; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = mSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of G_T) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(mSql(), /\bDO\s+\$/i, 'literal statements only (C0 expands the spec DO block; the policy dump / CI tools read the files)'); assert.doesNotMatch(polSql(), /\bDO\s+\$/i);
  assert.doesNotMatch(mSql() + polSql(), /EXECUTE\s+format\s*\(/i);
});
const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('micro.') && !/\.event_inbox$/.test(p.table));
test('policies: db/policies/micro.sql holds EXACTLY the expected 88 policies (DO block expanded + the instrument_records DELETE): name, command, role, USING, WITH CHECK (modulo the staff-guard conjunct); G tables none; only event_inbox may be extra', () => {
  const exp = expectedPolicies(), got = gotPolicies();
  assert.ok(got.length > 0, 'db/policies/micro.sql has no CREATE POLICY');
  const byKey = new Map(got.map((p) => [p.key, p])); assert.equal(byKey.size, got.length, 'no duplicate policy');
  for (const e of exp) {
    const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(noGuard(g.using), noGuard(e.using), `${e.key} USING`); assert.equal(noGuard(g.check), noGuard(e.check), `${e.key} WITH CHECK`);
  }
  assert.deepEqual([...byKey.keys()].sort(), exp.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access)');
  assert.deepEqual(got.filter((p) => p.cmd === 'DELETE').map((p) => p.key), ['instrument_records__delete__tenant_centre@micro.instrument_records']);
  for (const p of policies(polSql()).filter((x) => /\.event_inbox$/.test(x.table))) assert.match(p.name, /^event_inbox__(select|insert|delete)__(tenant|owner_only)$/, `${p.key}: only the C0 inbox shapes may appear`);
});
test('policy shape: names <table>__<cmd>__(tenant|tenant_centre); all TO lims_app; staff guard in USING and WITH CHECK of every policy (P-16, gate 9); centre tables: actor type IN (user, system) + has_all_centres OR centre_id = ANY(...::uuid[]) (A16.1, review m#30); tenant predicate everywhere; no true / PUBLIC / anon; no UPDATE policy on A tables, event-less tables; instrument_records delete = system actor + expired rows only (P-18(c), D-65)', () => {
  const ps = gotPolicies(); assert.equal(ps.length, EXPECTED_POLICY_COUNT, `policies: ${ps.length}`);
  const noUpd = NO_UPDATE_N();
  for (const p of ps) {
    const tbl = p.table.split('.')[1], m = new RegExp(`^${tbl}__${p.cmd.toLowerCase()}__(tenant|tenant_centre)$`).exec(p.name);
    assert.ok(m, `${p.key}: name <table>__<cmd>__<scope>`); assert.equal(p.roles, 'lims_app', `${p.key} roles`);
    const t = p.using + ' ' + p.check;
    assert.match(t, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: tenant predicate`);
    assert.equal(m[1] === 'tenant_centre', CENTRE_T.includes(p.table), `${p.key}: centre scope exactly on the 8 centre tables (the purge DELETE keeps its spec name)`);
    if (m[1] === 'tenant_centre' && p.cmd !== 'DELETE') {
      assert.match(t, /has_all_centres/); assert.match(t, /any\(\(select app\.current_centre_ids\(\)\)::uuid\[\]\)/, `${p.key}: A16.1 cast`);
      assert.match(t, /\(select app\.current_actor_type\(\)\)in\('user','system'\)/, `${p.key}: pred_c refuses device / partner / portal / patient actors (review m#30)`);
    } else if (p.cmd !== 'DELETE') assert.doesNotMatch(t, /current_centre_ids|has_all_centres/, `${p.key}: tenant tables are not centre scoped`);
    if (p.cmd !== 'INSERT') assert.match(p.using, STAFF, `${p.key} USING lacks the staff guard (P-16, gate 9 check-registry)`);
    if (p.cmd === 'INSERT' || p.cmd === 'UPDATE') assert.match(p.check, STAFF, `${p.key} WITH CHECK lacks the staff guard`);
    assert.doesNotMatch(t, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|is_platform_actor|app\.maintenance|app\.pre_/, p.key);
    assert.ok(!isG(p.table), `${p.key}: G tables carry no policy`);
  }
  for (const t of noUpd) assert.equal(ps.filter((p) => p.table === `micro.${t}` && p.cmd === 'UPDATE').length, 0, `micro.${t}: no UPDATE policy (§5)`);
  const d = ps.find((p) => p.cmd === 'DELETE'); assert.match(d.using, /\(select app\.current_actor_type\(\)\)='system'/); assert.match(d.using, /expires_at ?< ?now\(\)/); assert.match(d.using, STAFF, 'gate 9 demands the guard on the purge policy too (spec gap, C5..C9 precedent)');
  assert.equal(ps.filter((p) => p.cmd === 'DELETE').length, 1, 'one DELETE policy in the schema');
});
test('policies written literally in migrations are identical to db/policies/micro.sql (AC-0B-2.3 copy)', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(mSql()).filter((x) => x.table.startsWith('micro.') && !/\.event_inbox$/.test(x.table));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort(), 'every policy of the file is created by a migration and vice versa');
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §4, §8 loops)
test('grants equal the §8 loops: lims_app SELECT+INSERT+UPDATE where marked u, SELECT+INSERT where marked -, DELETE on instrument_records only (class E, D-65); SELECT on the 12 g_* tables and the 11 views; nothing else, nothing to other roles; no DELETE on C/A/M', () => {
  const sql = mSql() + '\n;\n' + polSql(), g = grantsOf(sql), upd = UPD_N();
  const privs = (q, r) => [...(g.get(q)?.get(r)?.all ?? [])].sort();
  for (const t of T_N) {
    const want = t === E_TABLE ? ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] : upd.includes(t) ? ['INSERT', 'SELECT', 'UPDATE'] : ['INSERT', 'SELECT'];
    assert.deepEqual(privs(`micro.${t}`, 'lims_app'), want, `micro.${t} lims_app`);
  }
  for (const q of G_T) assert.deepEqual(privs(q, 'lims_app'), ['SELECT'], `${q} lims_app`);
  for (const v of VIEWS) assert.deepEqual(privs(v, 'lims_app'), ['SELECT'], `${v} lims_app`);
  const expTargets = new Set([...ALLT, ...VIEWS]); assert.equal(expTargets.size, 54);
  for (const [t, rm] of g) if (/^micro\./.test(t)) {
    assert.ok(expTargets.has(t), `${t}: unexpected grant target`);
    for (const [r, p] of rm) {
      assert.equal(r, 'lims_app', `${t}: unexpected grantee ${r}`);
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!p.all.has(bad) && !p.cols.has(bad), `${t}: ${r} must not hold ${bad}`);
      assert.equal(p.cols.size, 0, `${t}: whole-table grants only`);
    }
  }
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\bmicro\./i); assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+micro\b/i); assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bmicro\b/i);
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\bmicro\./i.test(s) && !/FUNCTION/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner|lims_analytics)\b/i, s);
  assert.match(spec9() + specDdl(), /GRANT DELETE ON micro\.instrument_records TO lims_app/, 'the spec grants the single DELETE');
  // AC-0B-4.3: class A tables are INSERT + SELECT only (the six A tables of §1; event_inbox is C0's)
  for (const t of T_N.filter((x) => CLS[x] === 'A')) assert.ok(!privs(`micro.${t}`, 'lims_app').includes('UPDATE'), `class A micro.${t}: no UPDATE`);
  assert.equal(T_N.filter((x) => CLS[x] === 'A').length, 6);
});

// ================================================================ functions + triggers (AC-0B-4.1; §5, §8)
test('micro.tg_child_final_lock() equals the spec text; micro.cultures_guard() and micro.breakpoint_sets_guard() exist (spec describes them in prose: §5, §8): all SECURITY INVOKER plpgsql RETURNS trigger with search_path = \'\', P0001 / immutable_row; no other function; no DEFINER, no inventory entry', () => {
  const sql = mSql(), exp = specDdl();
  const fl = fnText(sql, FN_SPEC); assert.ok(fl, `${FN_SPEC} missing (05-SCHEMA §8)`);
  assert.equal(norm(fl), norm(fnText(exp, FN_SPEC)), 'tg_child_final_lock body equals the spec'); assert.match(fl, /final_submitted/); assert.match(fl, /MESSAGE\s*=\s*'immutable_row'/i);
  for (const f of [FN_SPEC, ...FN_GUARD]) {
    const got = fnText(sql, f); assert.ok(got, `${f} missing`);
    assert.match(got, /RETURNS\s+trigger/i, f); assert.match(got, /LANGUAGE\s+plpgsql/i, f); assert.match(got, /SET\s+search_path\s*=\s*''/i, f); assert.doesNotMatch(got, /SECURITY\s+DEFINER/i, `${f} is INVOKER`);
    assert.match(got, /ERRCODE\s*=\s*'P0001'/i, f);
  }
  const cg = fnText(sql, 'micro.cultures_guard'), bg = fnText(sql, 'micro.breakpoint_sets_guard');
  assert.match(cg, /immutable_row/); assert.match(cg, /culture_invalid_transition/); assert.match(cg, /awaiting_setup/); assert.match(cg, /current_report_version_no/); assert.match(cg, /specimen_id/);
  for (const s of ['incubating', 'growth_detected', 'final_submitted', 'amending', 'cancelled']) assert.match(cg, new RegExp(s), `cultures_guard knows ${s} (03-APP-FLOW §2.1)`);
  assert.match(bg, /immutable_row/); assert.match(bg, /effective_from/);
  for (const s of ['uploaded', 'validating', 'validated', 'invalid', 'active', 'retired', 'discarded']) assert.match(bg, new RegExp(s), `breakpoint_sets_guard knows ${s} (03-APP-FLOW §2.5)`);
  assert.deepEqual(fnNames(sql).sort(), [FN_SPEC, ...FN_GUARD].sort(), 'no function beyond the three');
  assert.doesNotMatch(sql, /SECURITY\s+DEFINER/i, 'C10 has no SECURITY DEFINER function: micro.purge_instrument_records is a worker task under policy instrument_records__delete__tenant_centre (§8 "Purge", P-18(c))');
});
test('triggers: the 6 spec triggers equal the §8 text (cultures / breakpoint_sets mutable_columns lists, 4 final_lock); 2 guard triggers (BEFORE UPDATE FOR EACH ROW EXECUTE FUNCTION micro.cultures_guard() / micro.breakpoint_sets_guard()); no other non-audit trigger; none disabled or dropped', () => {
  const sql = mSql(), trg = createTriggers(sql).filter((s) => !isAudit(s)), exp = new Map(createTriggers(specDdl()).map((s) => [trgName(s), s]));
  const guards = trg.filter((s) => !SPEC_TRG.includes(trgName(s)));
  assert.equal(trg.length, 8, `non-audit triggers: ${trg.map(trgName).join(',')}`);
  for (const n of SPEC_TRG) assert.equal(norm(trg.find((s) => trgName(s) === n) ?? ''), norm(exp.get(n)), `trigger ${n}`);
  assert.equal(guards.length, 2);
  assert.ok(guards.some((s) => /^CREATE TRIGGER \w+ BEFORE UPDATE ON micro\.cultures FOR EACH ROW EXECUTE FUNCTION micro\.cultures_guard\(\s*\)$/i.test(s)), 'cultures guard trigger (BEFORE UPDATE)');
  assert.ok(guards.some((s) => /^CREATE TRIGGER \w+ BEFORE UPDATE ON micro\.breakpoint_sets FOR EACH ROW EXECUTE FUNCTION micro\.breakpoint_sets_guard\(\s*\)$/i.test(s)), 'breakpoint_sets guard trigger (BEFORE UPDATE)');
  const bpRow = spec5().split('\n').find((l) => l.startsWith('| `breakpoint_sets`')); assert.ok(bpRow, 'spec §5 breakpoint_sets row');
  const want = /enforce_mutable_columns\(([^)]*)\)/.exec(bpRow)[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).sort();
  assert.deepEqual(trgArgs(trg.find((s) => trgName(s) === 'breakpoint_sets__mutable_columns'), 'app\\.enforce_mutable_columns'), want, 'micro.breakpoint_sets: mutable columns = spec §5');
  const cuRow = spec5().split('\n').find((l) => l.startsWith('| `cultures`')); assert.ok(cuRow, 'spec §5 cultures row');
  const cuArgs = trgArgs(trg.find((s) => trgName(s) === 'cultures__mutable_columns'), 'app\\.enforce_mutable_columns');
  for (const c of cuArgs) { assert.ok(cuRow.includes('`' + c + '`'), `§5 names cultures.${c} as mutable`); assert.ok(createTable(sql, 'micro.cultures').colMap.has(c), `cultures.${c} is a real column`); }
  for (const c of ['id', 'tenant_id', 'centre_id', 'order_id', 'order_item_id', 'patient_id', 'test_id', 'specimen_type_code', 'received_at', 'created_at', 'created_by']) assert.ok(!cuArgs.includes(c), `cultures.${c} stays immutable`);
  for (const c of want) assert.ok(createTable(sql, 'micro.breakpoint_sets').colMap.has(c), `breakpoint_sets.${c} is a real column`);
  assert.doesNotMatch(sql, /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(sql, /DROP\s+TRIGGER\b/i);
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x; spec §1 "Audited (C0 trigger)"): <t>__audit AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW on exactly the 24 audited tables (19 M, 4 C, instrument_records E); none on A / counters / G', () => {
  const trg = createTriggers(mSql()).filter(isAudit), onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  assert.equal(AUDITED.length, 24);
  for (const q of AUDITED) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(\\s*\\)$`, 'i'), q);
  }
  for (const q of ALLT.filter((x) => !AUDITED.includes(x))) assert.equal(onTable(q).length, 0, `${q} must NOT be audited (§1: class A insert-only, counter, or global)`);
  assert.equal(trg.length, 24);
});

// ================================================================ DEFINER inventory (none)
test('db/meta/definer-inventory.yaml has no micro row (C10 adds no SECURITY DEFINER function; the 3 trigger functions are INVOKER; the purge is a worker task)', () => {
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  assert.deepEqual(Object.keys(inv).filter((k) => /micro/i.test(k)), []);
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const P2_COLS = { cultures: ['barcode_snapshot'], instrument_records: ['sample_barcode'] };
const P3_COLS = {      // §7 P3 column lists (only names that exist in §8; ast_results: "all value/category columns" -> the value + category ones)
  cultures: ['specimen_type_code', 'specimen_site_code', 'outcome_code', 'cancel_comment', 'amendment_reason_text'],
  culture_plates: ['media_code', 'incubation_text'],
  culture_observations: ['growth_code', 'quantity_text', 'finding_text'],
  isolates: ['organism_code', 'colony_description', 'quantity_text', 'withdraw_comment'],
  ast_results: ['raw_value', 'raw_numeric', 'category_code', 'interpretation_raw'],
  report_versions: ['culture_summary_text', 'isolates', 'ast', 'comments_text', 'outcome_code', 'amendment_reason_text', 'early_final_reason'],
  instrument_records: ['organism_code_raw', 'antibiotic_code_raw', 'organism_code', 'antibiotic_code', 'raw_value', 'interpretation_raw', 'ignore_comment'],
};
const MAND = { M: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'is_active'], C: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version'], A: ['id', 'tenant_id', 'created_at', 'created_by'],
  E: ['id', 'tenant_id', 'created_at', 'expires_at'], G: ['id', 'created_at', 'is_active'] };
test('tables.yaml: all 43 micro tables registered (class G/M/C/A/E per §1, centre_scoped exactly the 8 centre tables, audited = §1 = trigger, retention, no shared_with (P-16 note), columns = the migration columns, phi_class P0..P3); the count equals the CREATE TABLE count; event_inbox entry untouched', () => {
  const y = tablesYaml(), regs = Object.keys(y).filter((k) => /^micro\./.test(k) && !/\.event_inbox$/.test(k));
  assert.equal(regs.length, 43, 'tables.yaml micro entries (ex event_inbox)'); assert.equal(regs.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'tables.yaml count == chunk DDL count');
  const trgAudited = (q) => createTriggers(mSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of ALLT) {
    const e = y[q], t = q.split('.')[1]; assert.ok(e, `${q} in tables.yaml`);
    assert.equal(e.class, isG(q) ? 'G' : CLS[t], `${q} class (§1)`);
    assert.equal(e.centre_scoped, CENTRE_T.includes(q), `${q} centre_scoped`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`); assert.equal(e.audited, AUDITED.includes(q), `${q} audited per §1`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), [...createTable(mSql(), q).colNames.map((c) => c.replace(/"/g, ''))].sort(), `${q} columns = migration columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
    assert.deepEqual([...(e.shared_with ?? [])], [], `${q}: nothing shared with partner / portal / patient (§4 "No micro table is shared")`);
  }
  assert.ok(y['micro.event_inbox'].class === 'A', 'inbox entry remains as C0 wrote it');
});
test('tables.yaml phi_class (§7): P2 only on cultures.barcode_snapshot and instrument_records.sample_barcode; P3 only on the 7 clinical tables with exactly the §7 columns marked P3; every other micro table P0..P1 (configuration, breakpoint, coded-set); created_by / updated_by P0..P1', () => {
  const y = tablesYaml();
  for (const q of ALLT) {
    const t = q.split('.')[1], cols = Object.entries(y[q].columns), has3 = cols.some(([, p]) => p === 'P3');
    assert.equal(has3, t in P3_COLS, `${q}: P3 ${t in P3_COLS ? 'required' : 'forbidden'} (§7)`);
    for (const [c, p] of cols) {
      if (p === 'P2') assert.ok((P2_COLS[t] ?? []).includes(c), `${q}.${c}: P2 only on ${JSON.stringify(P2_COLS)}`);
      if (['created_by', 'updated_by'].includes(c)) assert.ok(['P0', 'P1'].includes(p), `${q}.${c}`);
    }
    for (const c of P3_COLS[t] ?? []) assert.equal(y[q].columns[c], 'P3', `${q}.${c} must be P3 (§7)`);
    for (const c of P2_COLS[t] ?? []) assert.equal(y[q].columns[c], 'P2', `${q}.${c} must be P2 (§7)`);
  }
  for (const q of ALLT.filter((x) => !(x.split('.')[1] in P3_COLS))) for (const [c, p] of Object.entries(y[q].columns)) assert.ok(['P0', 'P1'].includes(p), `${q}.${c}: ${p}`);
});
test('tables.yaml: rls_exempt only on the 12 g_* tables (with a reason); mandatory_column_exceptions = exactly the class-mandatory columns the DDL lacks (12 G tables: id; specimen_isolate_counters: id, version, is_active; §1 exceptions paragraph) with a reason; every other table carries all of them (02-CV §5.2)', () => {
  const y = tablesYaml();
  assert.match(spec1(), /Mandatory-column exceptions/); assert.match(spec1(), /specimen_isolate_counters/);
  for (const q of ALLT) {
    const e = y[q], cls = isG(q) ? 'G' : CLS[q.split('.')[1]], cols = new Set(createTable(mSql(), q).colNames);
    if (isG(q)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    const missing = MAND[cls].filter((c) => !cols.has(c)).sort(), got = [...(e.mandatory_column_exceptions ?? [])].sort();
    assert.deepEqual(got, missing, `${q}: mandatory_column_exceptions must list exactly the missing class-${cls} columns`);
    if (missing.length) assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 5, `${q}: mandatory_column_exceptions_reason`);
    assert.equal(isG(q), !cols.has('tenant_id'));
  }
  assert.deepEqual([...(y['micro.specimen_isolate_counters'].mandatory_column_exceptions ?? [])].sort(), ['id', 'is_active', 'version'], '§1: no id, no version / is_active');
  for (const q of G_T) assert.deepEqual(y[q].mandatory_column_exceptions, ['id'], `${q}: natural key = PK, no id (§1)`);
  for (const q of TENANT.filter((x) => x !== 'micro.specimen_isolate_counters')) assert.deepEqual(y[q].mandatory_column_exceptions ?? [], [], `${q}: no exception`);
});
test('tables.yaml retention (§7): clinical tables never deleted / retention; instrument_records cites expires_at + micro.purge_instrument_records + D-65; breakpoint sets / rows kept forever; event_inbox 90 days; g_* seed / permanent', () => {
  const r = (q) => tablesYaml()[`micro.${q}`].retention;
  for (const q of ['cultures', 'culture_transitions', 'culture_plates', 'culture_observations', 'isolates', 'ast_results', 'report_versions']) assert.match(r(q), /never deleted|retention|year/i, q);
  assert.match(r('instrument_records'), /expires_at/); assert.match(r('instrument_records'), /purge_instrument_records/); assert.match(r('instrument_records'), /D-65|retention|rawInstrumentYears/i);
  for (const q of ['breakpoint_sets', 'breakpoint_rows', 'breakpoint_bands']) assert.match(r(q), /forever|never deleted|kept/i, q);
  for (const q of G_N) assert.match(r(q), /seed|permanent|never deleted|kept|forever|global/i, q);
  assert.match(tablesYaml()['micro.event_inbox'].retention, /90 days/);
});
test('db/tests/rls_exempt.txt lists exactly the twelve micro g_* tables, each with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^micro\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), [...G_T].sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ seeds (§3.2; "seeded by migration, never edited by users")
const SEED = {
  g_cs_ast_interpretations: [['CLSI', 'S', 'Susceptible'], ['CLSI', 'SDD', 'Susceptible-dose dependent'], ['CLSI', 'I', 'Intermediate'], ['CLSI', 'I^', 'Intermediate (agent concentrated in urine)'], ['CLSI', 'R', 'Resistant'], ['CLSI', 'NS', 'Nonsusceptible'],
    ['EUCAST', 'S', 'Susceptible'], ['EUCAST', 'I', 'Susceptible, increased exposure'], ['EUCAST', 'R', 'Resistant'], ['ECOFF', 'WT', 'Wild type'], ['ECOFF', 'NWT', 'Non-wild type']],
  g_cs_organism_groups: [['enterobacterales', 'Enterobacterales'], ['pseudomonas', 'Pseudomonas spp.'], ['acinetobacter', 'Acinetobacter spp.'], ['staphylococcus', 'Staphylococcus spp.'], ['enterococcus', 'Enterococcus spp.'], ['streptococcus', 'Streptococcus spp.'], ['yeast', 'Yeasts'], ['other', 'Other']],
  g_cs_organisms: [['escherichia_coli', 'Escherichia coli', 'enterobacterales', 'gram_negative'], ['klebsiella_pneumoniae', 'Klebsiella pneumoniae', 'enterobacterales', 'gram_negative'], ['proteus_mirabilis', 'Proteus mirabilis', 'enterobacterales', 'gram_negative'],
    ['salmonella_typhi', 'Salmonella Typhi', 'enterobacterales', 'gram_negative'], ['pseudomonas_aeruginosa', 'Pseudomonas aeruginosa', 'pseudomonas', 'gram_negative'], ['acinetobacter_baumannii', 'Acinetobacter baumannii', 'acinetobacter', 'gram_negative'],
    ['staphylococcus_aureus', 'Staphylococcus aureus', 'staphylococcus', 'gram_positive'], ['enterococcus_faecalis', 'Enterococcus faecalis', 'enterococcus', 'gram_positive'], ['streptococcus_pneumoniae', 'Streptococcus pneumoniae', 'streptococcus', 'gram_positive'],
    ['candida_albicans', 'Candida albicans', 'yeast', 'yeast']],
  g_cs_antibiotics: ['ampicillin', 'amoxicillin_clavulanate', 'piperacillin_tazobactam', 'ceftriaxone', 'ceftazidime', 'cefepime', 'cefoxitin', 'imipenem', 'meropenem', 'gentamicin', 'amikacin', 'ciprofloxacin', 'levofloxacin', 'trimethoprim_sulfamethoxazole',
    'nitrofurantoin', 'azithromycin', 'vancomycin', 'linezolid', 'colistin', 'polymyxin_b'].map((c) => [c]),
  g_cs_media: [['blood_agar', 'Blood agar'], ['chocolate_agar', 'Chocolate agar'], ['macconkey_agar', 'MacConkey agar'], ['cled_agar', 'CLED agar'], ['sabouraud_dextrose_agar', 'Sabouraud dextrose agar'], ['mueller_hinton_agar', 'Mueller-Hinton agar']],
  g_cs_specimen_sites: ['urine', 'blood', 'csf', 'respiratory', 'wound', 'stool', 'genital', 'other'].map((c) => [c]),
  g_cs_growth_codes: [['no_growth', 'false'], ['scanty_growth', 'true'], ['moderate_growth', 'true'], ['heavy_growth', 'true'], ['growth', 'true']],
  g_cs_culture_outcomes: [['no_growth', 'No growth', 'N', 'false'], ['growth_reported', 'Growth — see isolates', 'A', 'true'], ['normal_flora', 'Normal flora only', 'N', 'false'], ['mixed_growth_contamination', 'Mixed growth, probable contamination', 'A', 'false']],
  g_cs_isolate_withdraw_reasons: ['contaminant', 'duplicate', 'entered_in_error', 'not_significant'].map((c) => [c]),
  g_cs_culture_cancel_reasons: ['specimen_rejected', 'order_item_cancelled', 'entered_in_error', 'not_processed'].map((c) => [c]),
  g_cs_record_ignore_reasons: ['kept_manual', 'wrong_sample', 'qc_or_test_run', 'duplicate', 'other'].map((c) => [c]),
};
test('seed rows (§3.2): the 11 dictionary / interpretation sets + g_ast_category_restrictions are seeded by the migration with exactly the spec codes (displays where the spec gives them), extra columns as specified; no SNOMED, no breakpoint, no is_alert = true; parents before children; INSERTs name their columns; no other INSERT into micro (tenant fixtures belong to packages/test-fixtures)', () => {
  const sql = mSql(), s3 = ws(spec3()), lit = (v) => /^'(.*)'$/.exec(v)?.[1];
  for (const [t, rows] of Object.entries(SEED)) for (const r of rows) for (const v of r) assert.ok(s3.includes(v.replace(/ — /g, ' — ')) || s3.includes(v), `seed value "${v}" of ${t} is in spec §3.2`);
  for (const [t, want] of Object.entries(SEED)) {
    const rows = insertRows(sql, `micro.${t}`); assert.equal(rows.length, want.length, `micro.${t}: ${want.length} seed rows`);
    const key = (r) => (t === 'g_cs_ast_interpretations' ? [lit(r.standard), lit(r.code), lit(r.display)] : t === 'g_cs_organisms' ? [lit(r.code), lit(r.display), lit(r.organism_group_code), lit(r.gram_class)]
      : t === 'g_cs_growth_codes' ? [lit(r.code), r.indicates_growth.toLowerCase()] : t === 'g_cs_culture_outcomes' ? [lit(r.code), lit(r.display), lit(r.result_flag), r.requires_isolate.toLowerCase()]
      : want[0].length === 1 ? [lit(r.code)] : [lit(r.code), lit(r.display)]);
    assert.deepEqual(rows.map(key).sort(), want.map((x) => x.map(String)).sort(), `micro.${t} seed = spec §3.2`);
    for (const r of rows) {
      assert.ok(!('id' in r), `micro.${t}: no id column (natural key, §1)`);
      if ('display' in r) assert.ok(lit(r.display)?.length >= 1 && lit(r.display).length <= 200, `${t} display`);
      if ('system' in r) assert.equal(lit(r.system), 'lims_micro'); if ('system_version' in r) assert.equal(lit(r.system_version), '1');
      if ('is_alert' in r) assert.equal(r.is_alert.toLowerCase(), 'false', 'all is_alert = false');
      if ('snomed_ct_concept_id' in r) assert.match(r.snomed_ct_concept_id, /^null$/i, 'SNOMED always NULL in seeds');
    }
  }
  const rs = insertRows(sql, 'micro.g_ast_category_restrictions');
  assert.deepEqual(rs.map((r) => [lit(r.standard), lit(r.antibiotic_code), r.allowed_codes.replace(/[^A-Za-z,]/g, '').split(',').sort().join()]).sort(), [['CLSI', 'colistin', 'I,R'], ['CLSI', 'polymyxin_b', 'I,R']], 'CLSI colistin / polymyxin B: I, R only (04 D14)');
  const tables = [...new Set(stmts(sql).map(ws).filter((s) => /^INSERT\s+INTO\b/i.test(s)).map((s) => /INTO\s+(\S+)/i.exec(s)[1]))].sort();
  assert.deepEqual(tables, [...Object.keys(SEED).map((t) => `micro.${t}`), 'micro.g_ast_category_restrictions'].sort(), 'no other INSERT in the micro migrations');
  const pos = (t) => sql.search(new RegExp(`INSERT\\s+INTO\\s+${esc('micro.' + t)}\\b`, 'i'));
  assert.ok(pos('g_cs_organism_groups') < pos('g_cs_organisms'), 'organism groups before organisms (FK)'); assert.ok(pos('g_cs_antibiotics') < pos('g_ast_category_restrictions'), 'antibiotics before restrictions (FK)');
  assert.doesNotMatch(sql.replace(/INSERT\s+INTO\s+micro\.g_cs_organisms[\s\S]*?;/gi, ''), /breakpoint_(rows|bands)\s*\([^)]*\)\s*VALUES/i, 'no seeded breakpoint (§3.2: "No seed carries a breakpoint")');
});

// ================================================================ views (IC §6.8; 05-SCHEMA §3.3, §6, §8)
const icCols = () => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8').replace(/\r\n?/g, '\n'), a = ic.indexOf('### 6.8 `micro`');
  assert.ok(a >= 0, 'IC §6.8'); const sec = ic.slice(a, ic.indexOf('\n### 6.9', a) < 0 ? undefined : ic.indexOf('\n### 6.9', a));
  const row = sec.split('\n').find((l) => l.startsWith('| `micro.v_pub_report_content`')); assert.ok(row, 'IC §6.8 row');
  return splitTop(row.split('|')[2]).map((c) => /^\s*`?(\w+)/.exec(c)[1]);
};
const PUB = ['tenant_id', 'entity_id', 'version_no', 'order_item_id', 'report_phase', 'culture_summary_text', 'isolates', 'ast', 'comments_text', 'signed_by_membership_id', 'signed_at'];
test('view column contract vs IC §6.8: micro.v_pub_report_content has exactly tenant_id, entity_id, version_no, order_item_id, report_phase, culture_summary_text, isolates, ast, comments_text, signed_by_membership_id, signed_at in that order (IC, spec §6 table, spec §6 SQL and the migration agree)', () => {
  const ic = icCols(), got = viewStmt(mSql(), 'micro.v_pub_report_content'), exp = viewStmt(strip(sqlBlocks(spec6())), 'micro.v_pub_report_content');
  assert.deepEqual(ic, PUB); assert.ok(got, 'CREATE VIEW micro.v_pub_report_content missing from *_micro__*.sql');
  assert.deepEqual(firstSelectCols(exp), ic, 'spec §6 SQL vs IC §6.8'); assert.deepEqual(firstSelectCols(got), ic, 'migration columns (names + order) vs IC §6.8');
  const rows = spec6().split('\n').map((l) => /^\| (\w+) \| (\w+) \| (yes|no) \|/.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.deepEqual(rows, ic, 'spec §6 column table vs IC §6.8');
});
test('view v_pub_report_content: definition equals §6 (WITH (security_invoker = true), FROM micro.report_versions), SELECT granted to lims_app only; no function / BYPASSRLS shortcut', () => {
  const sql = mSql(), got = viewStmt(sql, 'micro.v_pub_report_content');
  assert.equal(norm(got), norm(viewStmt(strip(sqlBlocks(spec6())), 'micro.v_pub_report_content')), 'view text');
  assert.match(got, /WITH\s*\(\s*security_invoker\s*=\s*(true|on)\s*\)/i); assert.match(got, /FROM micro\.report_versions rv$/i);
  const g = grantsOf(sql).get('micro.v_pub_report_content'); assert.ok(g, 'GRANT on micro.v_pub_report_content'); assert.deepEqual([...g.keys()], ['lims_app']); assert.deepEqual([...g.get('lims_app').all], ['SELECT']);
});
for (const set of SETS) {
  test(`internal view micro.v_${set} (§3.3: tenant rows UNION ALL global rows without a tenant row of the same code; source tenant / global; security_invoker = true; SELECT to lims_app)`, () => {
    const sql = mSql(), v = viewStmt(sql, `micro.v_${set}`); assert.ok(v, `CREATE VIEW micro.v_${set} missing (spec §8: "Same pattern: v_${set}")`);
    assert.deepEqual(firstSelectCols(v), viewColsOf(set), `micro.v_${set} columns (names + order)`);
    assert.match(v, /WITH\s*\(\s*security_invoker\s*=\s*(true|on)\s*\)/i);
    assert.ok(v.includes(`FROM micro.cs_${set}`) && v.includes(`FROM micro.g_cs_${set}`) && /UNION ALL/i.test(v), 'tenant + global branches');
    assert.match(norm(v), /tenant_id=\(select app\.current_tenant_id\(\)\)/); assert.match(norm(v), /not exists/); assert.match(v, /'tenant'::text AS source/i); assert.match(v, /'global'/);
    if (set === 'organisms') assert.equal(norm(v), norm(viewStmt(specDdl(), 'micro.v_organisms')), 'v_organisms equals the spec example');
    const g = grantsOf(sql).get(`micro.v_${set}`); assert.ok(g, `GRANT on micro.v_${set}`); assert.deepEqual([...g.keys()], ['lims_app']); assert.deepEqual([...g.get('lims_app').all], ['SELECT']);
  });
}
test('views: exactly the 11 micro views exist (10 internal + v_pub_report_content), none materialized, none WITHOUT security_invoker', () => {
  const sql = mSql(), made = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(MATERIALIZED\s+)?(?:TEMP(?:ORARY)?\s+)?VIEW\s+(\w+\.\w+)/gi)];
  assert.deepEqual(made.map((m) => `${m[1] ? 'M:' : ''}${m[2]}`).sort(), [...VIEWS].sort());
  for (const m of made) assert.match(viewStmt(sql, m[2]), /security_invoker\s*=\s*(true|on)/i, `${m[2]} security_invoker`);
});

// ================================================================ hygiene
test('C10 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of other schemas\' tables, no USING (true), no GRANT to PUBLIC, no SNOMED / breakpoint content', () => {
  const raw = mFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 60000, 'C10 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i); assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics|quality)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016'); assert.doesNotMatch(strip(raw), /\bTO\s+PUBLIC\b/i);
});
test('LD-202 scope: no wave-1 migration, db/bootstrap, spec, service or app file is changed by this task (only micro files + policies + meta + tests are new / edited)', () => {
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', 'db/migrations', 'db/bootstrap', 'spec', 'services', 'apps'], { cwd: repo, encoding: 'utf8' });
  const changed = r.stdout.split('\n').filter(Boolean).filter((f) => !/^db\/migrations\/\d{14}_micro__/.test(f));
  assert.deepEqual(changed, [], 'tracked files outside the micro migrations were modified');
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts, check-migrations.ts and check-fk-dag.ts exit 0 on the tree (micro -> core / catalog / frontdesk / lab / instruments only; nothing into micro)', () => {
  assert.ok(mFiles().length >= 1, 'C10 migrations missing');
  for (const t of ['check-registry.ts', 'check-migrations.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 31 tenant C10 tables, none for the 12 class G, and gen-isolation-probes --check is clean; _registry.sql lists all 43', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const q of G_T) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/micro/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-13\.C10_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/micro/T0B-13.C10_*.test.sql exist (tester-owned: writer must keep them) and cover the AC list by "-- AC-0B-x.y" markers and 16 checks by "-- C10 check N" markers; RLS never disabled; replica mode only for the FK-parent fixtures and reset to origin', () => {
  assert.ok(tapFiles().length >= 2, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 16; n++) assert.match(txt, new RegExp(`-- C10 check ${n}\\b`), `marker for C10 check ${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.1', '6.2', '6.3']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
    const rep = [...s.matchAll(/session_replication_role\s*=\s*replica/gi)].length, org = [...s.matchAll(/session_replication_role\s*=\s*origin/gi)].length;
    assert.ok(rep === 0 || (org >= rep && s.lastIndexOf('= origin') > s.lastIndexOf('= replica')), `${f}: every replica fixture block is reset to origin before assertions`);
  }
});
