// T0B-13.C12 static checks of the Wave-2 inventory DDL translation: db/migrations/*_inventory__*.sql, db/policies/inventory.sql, db/meta/tables.yaml, 3 INVOKER trigger functions + app.purge_inventory_alerts(),
// 4 mutable_columns triggers, doc / line / uom-lock guards, 23 audit triggers, seed of the 3 global coded sets (g_cs_uom, g_cs_reasons, g_cs_tax_codes). No view, no DEFINER, no owner policy in this schema.
// Spec: C12 05-SCHEMA §1 (inventory/class/exceptions), §2 (columns), §3 (PHI), §4 (RLS template, command matrix, alerts DELETE policy, grants), §5 (triggers + functions), §6 (seeds), §7 (transitions), §8 (DDL), §9 (no published view),
// §10 (index map), §11 (retention); IC §6 (no inventory.v_pub_*); C0 05-SCHEMA §9 rule 1 (tenant FK + UNIQUE (tenant_id, id) added by C0), §10; 02-CV §5.2/§5.3; 08 A16.1, A17 P-16 / P-18 / D-71 / D-72 / D-74; LD-202 (translate exactly, a gap = blocking CR).
// AC-0B-2.1..2.4, 3.5 (composite FK), 3.6 (probes), 4.1..4.3, 5.x (audit triggers), 6.1..6.3 (static part: order, role switch, FK direction). AC-0B-6.4 is billing-only (T0B-11) and does not apply to inventory.
// Run: node --test tests/db/T0B-13.C12.inventory.test.mjs   (live: db/tests/inventory/T0B-13.C12_*.test.sql via pg_prove; generated probes: db/tests/isolation/inventory.*.test.sql)
// Method (as T0B-10.C2..C8, T0B-13.C9..C11): the expected DDL is PARSED FROM C12 05-SCHEMA §8 at test time and compared (whitespace/case-normalised) with the migrations. The spec's RLS is a per-table TEMPLATE (§4.1) plus the
// alerts DELETE policy (§4.3) and the grant list (§4.4): they are expanded here for the 32 tenant tables and the migrations must hold the expansion as LITERAL statements. §5 triggers/functions are PROSE (only the purge function has
// SQL): their existence, shape and the names/columns the prose gives are tested here, their behaviour in the pgTAP behaviour suite.
// T0B13C12_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B13C12_ROOT ? resolve(process.env.T0B13C12_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').replace(/\bcreate or replace function\b/gi, 'create function').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const iFiles = () => files().filter((f) => /^\d{14}_inventory__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const iSql = () => iFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'inventory.sql') ? strip(readFileSync(polDir + 'inventory.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C11)
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
// explicit table (cols + constraints, incl. constraints added by ALTER TABLE ... ADD CONSTRAINT); `like` is reported so a LIKE-created table can be refused
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

// ---------------------------------------------------------------- spec extraction (C12 05-SCHEMA)
const specPath = repo + 'spec/chunks/C12-inventory/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = b0 ? s.indexOf(b0, a + a0.length) : s.length; assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const S1 = '## 1. Table inventory', S2 = '## 2. Columns', S3 = '## 3. Data classification', S4 = '## 4. RLS policies', S5 = '## 5. Triggers and functions', S6 = '## 6. Coded sets', S7 = '## 7. Allowed status', S8 = '## 8. DDL', S9 = '## 9. Published views', S10 = '## 10. Query', S11 = '## 11. Retention';
const specDdl = () => strip(sqlBlocks(between(specRaw(), S8, S9)));        // §8: tables, indexes, the purge function
const spec1 = () => between(specRaw(), S1, S2);
const spec3 = () => between(specRaw(), S3, S4);
const spec4 = () => between(specRaw(), S4, S5);
const spec4rls = () => strip(sqlBlocks(between(specRaw(), '### 4.1 ', '### 4.2 ')));       // §4.1 template
const spec4del = () => strip(sqlBlocks(between(specRaw(), '### 4.3 ', '### 4.4 ')));       // §4.3 alerts DELETE policy
const spec4grants = () => strip(sqlBlocks(between(specRaw(), '### 4.4 ', S5)));            // §4.4 grants
const spec5 = () => between(specRaw(), S5, S6);
const spec6 = () => between(specRaw(), S6, S7);
const spec7 = () => between(specRaw(), S7, S8);
const spec9 = () => between(specRaw(), S9, S10);
const spec10 = () => between(specRaw(), S10, S11);
const spec11 = () => between(specRaw(), S11, '## 12.');

// ---- tables: the §8 DDL is the truth (35 CREATE TABLE = 3 G + 32 tenant; event_inbox is C0's); classes from §1 (hard-coded, sanity-checked against the spec rows)
const G_N = ['g_cs_uom', 'g_cs_reasons', 'g_cs_tax_codes'];
const CLS = {
  cs_reasons: 'M', cs_tax_codes: 'M', settings: 'M', number_counters: 'M', items: 'M', item_packs: 'M', item_barcodes: 'M', stores: 'M', store_item_settings: 'M', suppliers: 'M', supplier_items: 'M', lots: 'M', stock_balances: 'M',
  stock_movements: 'A', purchase_orders: 'C', purchase_order_lines: 'C', goods_receipts: 'C', goods_receipt_lines: 'C', transfers: 'C', transfer_lines: 'C', stock_documents: 'A', stock_document_lines: 'A', stock_counts: 'C', stock_count_lines: 'C',
  opened_containers: 'C', instrument_bindings: 'M', consumption_rules: 'M', consumption_facts: 'C', consumption_daily: 'M', test_counts_daily: 'M', instrument_qc_daily: 'M', alerts: 'E',
};   // the two counters are class M here: §1 "counter ... P-18(b) exception", precedent frontdesk.number_counters / lab.barcode_counters (mandatory-column exceptions in tables.yaml)
const T_N = Object.keys(CLS);
const G_T = G_N.map((t) => `inventory.${t}`), TENANT = T_N.map((t) => `inventory.${t}`), ALLT = [...G_T, ...TENANT];
const isG = (q) => /\.g_/.test(q);
const A_N = T_N.filter((t) => CLS[t] === 'A');                                       // the three append-only tables: SELECT + INSERT only
const NO_ID = ['number_counters', 'instrument_qc_daily'];                            // natural-key counters (P-18(b)): no id column
const PROJ = ['stock_balances', 'consumption_daily', 'test_counts_daily'];           // projections: M but not audited (§5 audit row)
const AUDITED_REQ = T_N.filter((t) => ['M', 'C'].includes(CLS[t]) && !PROJ.includes(t) && !NO_ID.includes(t)).map((t) => `inventory.${t}`);    // 13 M + 10 C
const AUDIT_OPTIONAL = ['inventory.number_counters', 'inventory.instrument_qc_daily', 'inventory.alerts'];       // §5: "all M and C tables" - counters (no id) and the class E table are not named either way
const AUDIT_FORBIDDEN = [...A_N, ...PROJ].map((t) => `inventory.${t}`);              // §5: not on stock_movements, stock_documents*, consumption_daily, test_counts_daily, stock_balances
const UPD_N = T_N.filter((t) => !A_N.includes(t));                                   // 29 tables with an UPDATE policy + grant
const FN_INV = ['inventory.tg_doc_guard', 'inventory.tg_line_guard', 'inventory.tg_item_base_uom_lock'];
const FN_PURGE = 'app.purge_inventory_alerts';
const DOC_T = ['purchase_orders', 'goods_receipts', 'transfers', 'stock_counts', 'opened_containers', 'consumption_facts'];
const LINE_T = ['purchase_order_lines', 'goods_receipt_lines', 'transfer_lines', 'stock_count_lines'];
const MUT = {       // §5 table row 1 (app.enforce_mutable_columns, frozen columns)
  item_packs: ['label', 'uom_code', 'is_purchase_default', 'is_active', 'updated_at', 'updated_by', 'version'],
  lots: ['expiry_on', 'manufactured_on', 'status', 'status_reason_code', 'last_receipt_qty_base', 'last_receipt_value_paisa', 'is_active', 'updated_at', 'updated_by', 'version'],
  consumption_rules: ['effective_to', 'is_active', 'notes', 'updated_at', 'updated_by', 'version'],
  stock_balances: ['qty_base', 'value_paisa', 'last_movement_at', 'updated_at', 'updated_by', 'version'],
};
const STAFF = /\(select app\.is_staff_or_system\(\)\)/;
const noGuard = (x) => x.replace(/and\(select app\.is_staff_or_system\(\)\)/g, '').replace(/\(select app\.is_staff_or_system\(\)\)and/g, '');
// Spec/gate conflict (as C5..C11): the §4.3 alerts DELETE policy has no is_staff_or_system() conjunct, but check-registry (P-16, gate 9) demands it on every __tenant policy of a non-shared table.
// The DELETE policy is compared modulo that one conjunct; the shape test REQUIRES it (the writer appends it; `current_actor_type() = 'system'` implies it, so behaviour is unchanged).

// ---- expected policies: §4.1 template instantiated per table (select + insert [+ update]) + the §4.3 alerts DELETE policy
function expectedPolicies() {
  const tpl = spec4rls(), out = [];
  for (const t of T_N) {
    const all = policies(tpl.replace(/<t>/g, t).replace(/inventory\.<t>/g, `inventory.${t}`));
    for (const p of all) if (p.cmd !== 'UPDATE' || UPD_N.includes(t)) out.push(p);
  }
  return [...out, ...policies(spec4del())];
}
const EXPECTED_POLICY_COUNT = 94;     // 32 select + 32 insert + 29 update + 1 delete (alerts)

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 35 CREATE TABLE in §8 (3 G + 32 tenant; no event_inbox), no LIKE, 1 function (app.purge_inventory_alerts), no view (§9), 94 expected policies, 29 UPDATE tables + 3 A tables, no DEFINER, the prose names resolve to real columns', () => {
  const ddl = specDdl();
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 35, '35 CREATE TABLE in §8');
  assert.equal(G_N.length, 3); assert.equal(T_N.length, 32); assert.equal(ALLT.length, 35);
  assert.deepEqual([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].map((m) => m[1]).sort(), [...ALLT].sort(), '§1 inventory (36 rows minus event_inbox) = §8 tables');
  for (const q of ALLT) { const t = createTable(ddl, q); assert.ok(t, `spec has ${q}`); assert.equal(t.like, null, `${q}: no LIKE in the spec`); }
  assert.doesNotMatch(ddl, /CREATE\s+TABLE\s+inventory\.event_inbox/i);
  assert.ok(createIndexes(ddl).length >= 60, `spec indexes: ${createIndexes(ddl).length}`);
  assert.deepEqual(fnNames(ddl), [FN_PURGE], 'the only SQL function in §8; the three tg_* functions are prose-only (§5)');
  assert.doesNotMatch(ddl + spec4rls() + spec4del() + spec4grants(), /SECURITY\s+DEFINER/i);
  assert.match(ddl, /SECURITY\s+INVOKER/i);
  assert.match(spec9(), /defines \*\*no\*\* `inventory\.v_pub_\*` view/, '§9: no published view');
  assert.doesNotMatch(ddl, /CREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW/i);
  const ps = expectedPolicies();
  assert.equal(new Set(ps.map((p) => p.key)).size, ps.length); assert.equal(ps.length, EXPECTED_POLICY_COUNT, `expected policies: ${ps.length}`);
  assert.equal(UPD_N.length, 29); assert.deepEqual(A_N.sort(), ['stock_document_lines', 'stock_documents', 'stock_movements']);
  assert.deepEqual(DOC_T.filter((t) => CLS[t] !== 'C'), []); assert.equal(T_N.filter((t) => CLS[t] === 'M').length, 18); assert.equal(T_N.filter((t) => CLS[t] === 'C').length, 10); assert.equal(AUDITED_REQ.length, 23);
  for (const [t, cs] of Object.entries(MUT)) for (const c of cs) { assert.ok(createTable(ddl, `inventory.${t}`).colMap.has(c), `§5 mutable column ${t}.${c} exists in §8`); assert.ok(new RegExp(`\\b${c}\\b`).test(spec5()), `${c} named in §5`); }
  for (const t of LINE_T) assert.ok(createTable(ddl, `inventory.${t}`), t);
  for (const c of ['removed_at', 'removed_by']) for (const t of LINE_T.filter((x) => x !== 'stock_count_lines')) assert.ok(createTable(ddl, `inventory.${t}`).colMap.has(c), `${t}.${c}`);
  for (const [t, c] of [['purchase_order_lines', 'received_qty_base'], ['purchase_order_lines', 'is_closed_short'], ['transfer_lines', 'received_qty_base'], ['transfer_lines', 'discrepancy_reason_code'], ['transfer_lines', 'dispatched_value_paisa'], ['stock_count_lines', 'book_qty_at_count'], ['stock_count_lines', 'reason_code']])
    assert.ok(createTable(ddl, `inventory.${t}`).colMap.has(c), `§5 lifecycle column ${t}.${c} exists in §8`);
  for (const t of NO_ID) assert.ok(!createTable(ddl, `inventory.${t}`).colMap.has('id'), `${t}: natural key, no id (§1 exceptions)`);
  for (const t of T_N.filter((x) => !NO_ID.includes(x))) assert.ok(createTable(ddl, `inventory.${t}`).colMap.has('id'), `${t} has id`);
  for (const c of ['contact_name', 'phone_display', 'email', 'address_text']) assert.ok(createTable(ddl, 'inventory.suppliers').colMap.has(c));
  for (const c of ['basis_key', 'source_event_id']) assert.ok(createTable(ddl, 'inventory.consumption_facts').colMap.has(c), `consumption_facts.${c}`);
  const refs = new Set([...ddl.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()).filter((x) => !x.startsWith('inventory.')));
  assert.ok(refs.has('core.tenants') && refs.has('core.branches') && refs.has('catalog.tests') && refs.has('instruments.instruments'), `cross-schema FK targets: ${[...refs]}`);
  for (const r of refs) assert.match(r, /^(core|catalog|instruments)\./, `cross-schema FK target ${r}`);
  assert.match(spec1(), /Mandatory-column exceptions/); assert.match(spec1(), /number_counters/); assert.match(spec1(), /instrument_qc_daily/);
});

// ================================================================ files, order, owner (AC-0B-6.1 / 6.3)
const WAVE2 = /_(quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection|migration_staging)__/;
test('migration files: >= 1 *_inventory__*.sql, timestamps strictly after 20261114120000 (LD-202), after every wave-1 migration and after the quality, micro and anatomic migrations (DAG: quality -> micro -> anatomic -> inventory), unique; db/policies/inventory.sql exists; schema creation IF NOT EXISTS', () => {
  assert.ok(iFiles().length >= 1, 'no db/migrations/*_inventory__*.sql yet (T0B-13.C12 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => !WAVE2.test(f)), before = all.filter((f) => /_(quality|micro|anatomic)__/.test(f));
  assert.ok(earlier.length >= 24, 'wave-1 migrations present'); assert.ok(before.length >= 3, 'quality + micro + anatomic migrations present');
  for (const f of iFiles()) {
    assert.ok(f.slice(0, 14) > '20261114120000', `${f} must be later than 20261114120000`);
    for (const e of [...earlier, ...before]) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (inventory follows analytics, quality, micro and anatomic in the DAG, C0 05-SCHEMA §4)`);
  }
  assert.ok(existsSync(polDir + 'inventory.sql'), 'db/policies/inventory.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(iSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)inventory\b/i, 'schema inventory exists since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every inventory migration is SET LOCAL ROLE lims_owner and it is the only role switch (all objects incl. app.purge_inventory_alerts owned by lims_owner); no standing CREATE grant, no role DDL, no CREATE EXTENSION', () => {
  assert.ok(iFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+|SET\s+SESSION\s+AUTHORIZATION)/gi)].map((m) => ws(m[1]).toUpperCase());
  for (const f of iFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch`);
  }
  assert.doesNotMatch(iSql(), /GRANT\s+CREATE\s+ON\s+(SCHEMA\s+app|DATABASE)/i); assert.doesNotMatch(iSql(), /CREATE\s+ROLE|ALTER\s+ROLE/i); assert.doesNotMatch(iSql(), /CREATE\s+EXTENSION/i);
});

// ================================================================ tables (columns + constraints = spec exactly; C0 may add only <t>__tenant__fk and UNIQUE (tenant_id, id), C0 05-SCHEMA §9 rule 1)
for (const q of ALLT) {
  test(`${q}: every spec column + constraint (name + text) present identically in the migration; no extra column; only <t>__tenant__fk and UNIQUE (tenant_id, id) may be added; not created with LIKE (05-SCHEMA §8; C0 §9 rule 1)`, () => {
    const exp = createTable(specDdl(), q); assert.ok(exp, `spec table ${q}`);
    const sql = iSql(), got = createTable(sql, q), t = q.split('.')[1];
    assert.ok(got, `CREATE TABLE ${q} not found in *_inventory__*.sql`);
    assert.equal(got.like, null, `${q}: LIKE is not used anywhere in this schema`);
    for (const [c, def] of exp.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    for (const c of got.colMap.keys()) assert.ok(exp.colMap.has(c), `${q}: extra column ${c} (the spec DDL is complete)`);
    for (const [c, def] of exp.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    for (const [c, def] of got.conMap) if (!exp.conMap.has(c)) {
      assert.ok(c === `${t}__tenant__fk` || /^unique\(tenant_id,id\)$/.test(def.replace(/^constraint\s+\w+\s+/, '')), `${q}: extra constraint ${c} (only the C0 tenant FK and UNIQUE (tenant_id, id) may be added)`);
      if (c === `${t}__tenant__fk`) assert.equal(def, `constraint ${t}__tenant__fk foreign key(tenant_id)references core.tenants(id)`, `${q}: tenant FK text`);
      else assert.ok(got.colMap.has('id') && got.colMap.has('tenant_id'), `${q}: UNIQUE (tenant_id, id) only on tables with an id`);
    }
    if (!isG(q)) assert.ok(got.conMap.has(`${t}__tenant__fk`), `${q}: ${t}__tenant__fk (spec §8 note: every tenant table has the tenant FK)`);
    if (!isG(q) && got.colMap.has('id')) assert.ok([...got.conMap.values()].some((d) => /unique\(tenant_id,id\)$/.test(d)), `${q}: UNIQUE (tenant_id, id) (04 D8)`);
  });
}
test('exactly the 35 §8 tables are created in inventory (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9); table count == spec count; every constraint is named <table>__*; the coded-set / status / kind CHECK value lists of §2 and §6.4 are present', () => {
  const sql = iSql(), bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.equal(made.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'migration CREATE TABLE count == spec CREATE TABLE count (impl note states both)');
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(bare, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /event_inbox/i, 'C12 migrations do not touch event_inbox (T0B-05 owns it)');
  for (const q of TENANT) for (const c of ['id', 'tenant_id']) { const def = createTable(sql, q)?.colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`); }
  for (const q of ALLT) { const t = q.split('.')[1]; for (const c of createTable(sql, q).conMap.keys()) assert.ok(c.startsWith(t + '__'), `${q}: constraint ${c} must be prefixed ${t}__`); }
  const sql2 = norm(sql);
  for (const v of ['draft,approved,sent,partially_received,received,closed,cancelled', 'below_reorder,expiry_soon,expired_on_hand,open_stability_exceeded,negative_stock,unresolved_consumption,expired_lot_in_use,balance_drift,reconciliation_gap', 'open,acknowledged,resolved',
    'receive,opening_balance,supplier_return,issue,return_to_store,transfer_out,transfer_in,consume_test,consume_analyte,consume_rerun,consume_qc,consume_calibration,consume_fixed,consume_reversal,wastage,expiry_writeoff,adjust_in,adjust_out,count_adjust_in,count_adjust_out',
    'goods_receipt,stock_document,transfer,stock_count,consumption_fact', 'wastage,adjustment,supplier_return,po_cancel,po_close,transfer_discrepancy,fact_dismiss,fact_reverse,lot_status,calibration,count_variance', 'po,grn,transfer,count,doc', 'available,quarantined,blocked'])
    assert.ok(sql2.includes(v.split(',').map((x) => `'${x}'`).join(',')), `§8 value list ${v}`);
});
test('cross-schema references (01-CM §5 R3): inventory -> inventory / core / catalog / instruments only, identical target set to the spec; NO FK into billing, frontdesk, lab, reporting, analytics, identity, quality, micro, anatomic (§8 / CV §5.4); nothing in an upstream schema references inventory (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(iSql()), exp = tgt(specDdl());
  for (const t of exp) got.has(t) || assert.fail(`FK target ${t} missing`);
  for (const t of [...got]) { assert.match(t, /^(inventory|core|catalog|instruments)\./, `inventory FK target ${t}`); exp.has(t) || assert.fail(`FK target ${t} is not in the spec`); }
  const upstream = files().filter((f) => /_(core|app|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics|storage|quality|micro|anatomic)__/.test(f));
  assert.doesNotMatch(upstream.map(read).join('\n'), /\bREFERENCES\s+inventory\./i, 'no FK into inventory from an upstream schema');
});
test('indexes: every §8 CREATE INDEX present with identical definition (partial predicates, DESC, text_pattern_ops, NULLS NOT DISTINCT after the column list); no extra index; every §10 index name exists as an index or a constraint; tenant_id leads every index and UNIQUE / PRIMARY KEY (except PRIMARY KEY (id))', () => {
  const sql = iSql(), have = new Map(createIndexes(sql).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].sort(), exp.map(idxName).sort(), 'no index beyond the spec');
  for (const n of ['stores__tenant_id_branch_id_default__p_uq', 'item_packs__tenant_id_item_id_default__p_uq', 'item_barcodes__tenant_id_value__p_uq', 'consumption_rules__current__p_uq', 'purchase_order_lines__tenant_id_po_line__p_uq', 'alerts__tenant_id_dedupe__p_uq', 'alerts__tenant_id_expires__p_idx', 'stock_balances__tenant_id_store_nonzero__p_idx', 'stock_movements__tenant_id_lot__p_idx'])
    assert.match(have.get(n) ?? '', /\bwhere\b/, `${n} is partial`);
  assert.match(have.get('consumption_rules__current__p_uq'), /\(tenant_id,rule_kind,test_id,analyte_id,instrument_id,item_id\)nulls not distinct where/, 'NULLS NOT DISTINCT after the column list (PG 15+ syntax, spec NOTE for C0)');
  assert.match(have.get('alerts__tenant_id_dedupe__p_uq'), /where status <> 'resolved'/); assert.match(have.get('stock_movements__tenant_id_store_item__idx'), /occurred_at desc/);
  const conNames = new Set(ALLT.flatMap((q) => [...createTable(sql, q).conMap.keys()]));
  const missing = [...new Set([...spec10().matchAll(/`([a-z_0-9]+__[a-z_0-9]*(?:uq|idx|pk))\b/g)].map((m) => m[1]))].filter((n) => !have.has(n) && !conNames.has(n) && !n.endsWith('__') );
  assert.deepEqual(missing, [], '§10 index names that exist neither as CREATE INDEX nor as a constraint');
  for (const s of createIndexes(sql)) assert.equal(/\bON\s+\w+\.\w+\s*(?:USING\s+\w+\s*)?\(\s*([^,)]+)/i.exec(s)[1].trim(), 'tenant_id', `index ${idxName(s)} leads with tenant_id`);
  for (const q of TENANT) for (const c of [...createTable(sql, q).conMap.values()].filter((x) => /\b(primary key|unique)\(/.test(x))) {
    const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1]; if (/primary key/.test(c) && k === 'id') continue;
    assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${c}`);
  }
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A16.1, A17 P-16, D-71, D-72, P-18(c))
test('ENABLE + FORCE ROW LEVEL SECURITY (literal statements, no DO block) on the 32 tenant tables; none on the 3 G tables; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = iSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of G_T) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(iSql(), /\bDO\s+\$/i, 'literal statements only (C0 expands the template; the policy dump / CI tools read the files)'); assert.doesNotMatch(polSql(), /\bDO\s+\$/i);
  assert.doesNotMatch(iSql() + polSql(), /EXECUTE\s+format\s*\(/i);
});
const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('inventory.') && !/\.event_inbox$/.test(p.table));
test('policies: db/policies/inventory.sql holds EXACTLY the expected 94 policies (§4.1 template x 32 tables, no UPDATE on the 3 A tables, + alerts__delete__tenant): name, command, role, USING, WITH CHECK (DELETE modulo the staff-guard conjunct); no policy on the G tables; only event_inbox may be extra', () => {
  const exp = expectedPolicies(), got = gotPolicies();
  assert.ok(got.length > 0, 'db/policies/inventory.sql has no CREATE POLICY');
  const byKey = new Map(got.map((p) => [p.key, p])); assert.equal(byKey.size, got.length, 'no duplicate policy');
  for (const e of exp) {
    const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(noGuard(g.using), noGuard(e.using), `${e.key} USING`); assert.equal(noGuard(g.check), noGuard(e.check), `${e.key} WITH CHECK`);
    if (e.cmd !== 'DELETE') { assert.equal(g.using, e.using, `${e.key} USING exact`); assert.equal(g.check, e.check, `${e.key} WITH CHECK exact`); }
  }
  assert.deepEqual([...byKey.keys()].sort(), exp.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access)');
  for (const p of policies(polSql()).filter((x) => /\.event_inbox$/.test(x.table))) assert.match(p.name, /^event_inbox__(select|insert|delete)__(tenant|owner_only)$/, `${p.key}: only the C0 inbox shapes may appear`);
});
test('policy shape: names <table>__<cmd>__tenant; all TO lims_app; tenant predicate + staff guard in every USING / WITH CHECK (P-16, gate 9); NOT centre scoped (§1: every table is the __tenant variant); no UPDATE policy on the 3 A tables (stock_movements, stock_documents, stock_document_lines); exactly ONE DELETE policy: alerts, system actor + expired only (D-72); no true / PUBLIC / anon / owner policy', () => {
  const ps = gotPolicies(); assert.equal(ps.length, EXPECTED_POLICY_COUNT, `policies: ${ps.length}`);
  for (const p of ps) {
    const tbl = p.table.split('.')[1], m = new RegExp(`^${tbl}__${p.cmd.toLowerCase()}__tenant$`).exec(p.name);
    assert.ok(m, `${p.key}: name <table>__<cmd>__tenant`); assert.equal(p.roles, 'lims_app', `${p.key} roles`);
    const t = p.using + ' ' + p.check;
    assert.match(t, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: tenant predicate`);
    assert.doesNotMatch(t, /current_centre_ids|has_all_centres/, `${p.key}: branch scope is app-enforced (§1), no centre predicate in RLS`);
    if (p.cmd !== 'INSERT') assert.match(p.using, STAFF, `${p.key} USING lacks the staff guard (P-16, gate 9 check-registry)`);
    if (p.cmd === 'INSERT' || p.cmd === 'UPDATE') assert.match(p.check, STAFF, `${p.key} WITH CHECK lacks the staff guard`);
    assert.doesNotMatch(t, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|is_platform_actor|app\.maintenance|app\.pre_|owner_only/, p.key);
    assert.ok(!isG(p.table), `${p.key}: G tables carry no policy`);
  }
  for (const t of A_N) assert.equal(ps.filter((p) => p.table === `inventory.${t}` && p.cmd !== 'SELECT' && p.cmd !== 'INSERT').length, 0, `inventory.${t}: only SELECT + INSERT policies (§4.2)`);
  const del = ps.filter((p) => p.cmd === 'DELETE'); assert.deepEqual(del.map((p) => p.key), ['alerts__delete__tenant@inventory.alerts'], 'the only DELETE policy in the schema (draft lines are soft-removed, D-71)');
  assert.match(del[0].using, /\(select app\.current_actor_type\(\)\)='system'/, 'DELETE: system actor only'); assert.match(del[0].using, /expires_at < now\(\)/, 'DELETE: expired rows only'); assert.match(del[0].using, STAFF, 'DELETE: staff guard (P-16 / gate 9; implied by actor_type = system)');
  assert.equal(del[0].check, '', 'DELETE has no WITH CHECK');
  for (const t of T_N.filter((x) => x !== 'alerts')) assert.equal(ps.filter((p) => p.table === `inventory.${t}` && p.cmd === 'DELETE').length, 0, `inventory.${t}: no DELETE policy`);
});
test('policies written literally in migrations are identical to db/policies/inventory.sql (AC-0B-2.3 copy)', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(iSql()).filter((x) => x.table.startsWith('inventory.') && !/\.event_inbox$/.test(x.table));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort(), 'every policy of the file is created by a migration and vice versa');
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §4.4 list parsed from the spec)
test('grants equal §4.4: lims_app SELECT+INSERT+UPDATE on the 29 UPDATE tables, SELECT+INSERT on the 3 A tables, SELECT on the 3 G tables, DELETE on alerts ONLY (class E purge), EXECUTE on app.purge_inventory_alerts(); no TRUNCATE / REFERENCES / TRIGGER; nothing to other roles; no view', () => {
  const sql = iSql() + '\n;\n' + polSql(), g = grantsOf(sql), exp = grantsOf(spec4grants());
  const privs = (m, q, r) => [...(m.get(q)?.get(r)?.all ?? [])].sort();
  for (const t of T_N) assert.deepEqual(privs(g, `inventory.${t}`, 'lims_app'), t === 'alerts' ? ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] : UPD_N.includes(t) ? ['INSERT', 'SELECT', 'UPDATE'] : ['INSERT', 'SELECT'], `inventory.${t} lims_app`);
  for (const q of G_T) assert.deepEqual(privs(g, q, 'lims_app'), ['SELECT'], `${q} lims_app`);
  for (const [q, rm] of exp) if (/^inventory\./.test(q)) for (const r of rm.keys()) assert.deepEqual(privs(g, q, r), privs(exp, q, r), `${q} ${r}: grants = spec §4.4`);
  assert.deepEqual([...g.entries()].filter(([, rm]) => [...rm.values()].some((p) => p.all.has('DELETE'))).map(([t]) => t), ['inventory.alerts'], '§4.4 CI assertion: alerts is the only table with DELETE');
  const expTargets = new Set(ALLT);
  for (const [t, rm] of g) if (/^inventory\./.test(t)) {
    assert.ok(expTargets.has(t), `${t}: unexpected grant target`);
    for (const [r, p] of rm) {
      assert.equal(r, 'lims_app', `${t}: unexpected grantee ${r}`);
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!p.all.has(bad) && !p.cols.has(bad), `${t}: ${r} must not hold ${bad}`);
      assert.equal(p.cols.size, 0, `${t}: whole-table grants only`);
    }
  }
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\binventory\./i); assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+inventory\b/i); assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\binventory\b/i);
  assert.doesNotMatch(sql, /GRANT\b[^;]*\bDELETE\b[^;]*\bON\b(?![^;]*\binventory\.alerts\s+TO\s+lims_app\s*(?:;|$))[^;]*\binventory\./i, 'DELETE is granted on inventory.alerts only');
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\binventory\./i.test(s) && !/FUNCTION/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner|lims_analytics)\b/i, s);
  assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+app\.purge_inventory_alerts\s*\(\s*\)\s+TO\s+lims_app\b/i, '§4.4: EXECUTE on the purge function for lims_app');
  for (const t of A_N) assert.ok(!privs(g, `inventory.${t}`, 'lims_app').includes('UPDATE'), `class A inventory.${t}: no UPDATE (AC-0B-4.3)`);
  for (const t of T_N.filter((x) => ['C', 'A'].includes(CLS[x]))) assert.ok(!privs(g, `inventory.${t}`, 'lims_app').includes('DELETE'), `C / A inventory.${t}: no DELETE (CV §5.6, draft-line tables included)`);
  assert.doesNotMatch(strip(iSql()), /\bCREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\b/i, '§9: C12 publishes no view in v1');
});

// ================================================================ functions + triggers (AC-0B-4.1; §5, §8)
test('app.purge_inventory_alerts(): text equals the §8 SQL (LANGUAGE sql, SECURITY INVOKER, search_path = \'\', LIMIT 10000, tenant + expires_at predicate, returns the deleted count); the 3 prose functions inventory.tg_doc_guard / tg_line_guard / tg_item_base_uom_lock are plpgsql RETURNS trigger, INVOKER, search_path = \'\', raise P0001 invalid_transition / immutable_row; no other function; no DEFINER', () => {
  const sql = iSql(), exp = specDdl();
  const got = fnText(sql, FN_PURGE); assert.ok(got, `${FN_PURGE} missing (05-SCHEMA §8)`);
  assert.equal(norm(got), norm(fnText(exp, FN_PURGE)), 'purge function text equals the spec');
  assert.match(got, /SECURITY\s+INVOKER/i); assert.match(got, /SET\s+search_path\s*=\s*''/i); assert.match(got, /LIMIT\s+10000/); assert.doesNotMatch(got, /SECURITY\s+DEFINER/i);
  for (const f of FN_INV) {
    const t = fnText(sql, f); assert.ok(t, `${f} missing (05-SCHEMA §5)`);
    assert.match(t, /RETURNS\s+trigger/i, f); assert.match(t, /LANGUAGE\s+plpgsql/i, f); assert.match(t, /SET\s+search_path\s*=\s*''/i, f); assert.doesNotMatch(t, /SECURITY\s+DEFINER/i, `${f} is INVOKER`);
    assert.match(t, /ERRCODE\s*=\s*'P0001'/i, f);
  }
  // tg_doc_guard: both error messages, every status literal of the §7 transition table, every lifecycle column of §7
  const doc = fnText(sql, 'inventory.tg_doc_guard'); assert.match(doc, /MESSAGE\s*=\s*'invalid_transition'/i); assert.match(doc, /MESSAGE\s*=\s*'immutable_row'/i);
  const statuses = new Set([...spec7().split('\n').filter((l) => /^\| (purchase_orders|goods_receipts|transfers|stock_counts|opened_containers|consumption_facts) \|/.test(l)).join('\n').matchAll(/\b([a-z_]+)→([a-z_]+)/g)].flatMap((m) => [m[1], m[2]]));
  assert.ok(statuses.size >= 12, `§7 status literals: ${[...statuses]}`);
  for (const s of statuses) assert.ok(doc.includes(`'${s}'`), `tg_doc_guard knows status '${s}' (§7)`);
  for (const c of ['approved_at', 'sent_channel', 'close_reason_code', 'dispatched_by', 'received_by', 'discard_document_id', 'finished_at', 'posted_by', 'cancelled_by']) assert.match(doc, new RegExp(`\\b${c}\\b`), `tg_doc_guard lifecycle column ${c} (§7)`);
  assert.match(doc, /'draft'/); assert.match(doc, /'open'/); assert.match(doc, /'unresolved'/);
  // tg_line_guard: soft removal D-71, parent draft, lifecycle columns of §5
  const line = fnText(sql, 'inventory.tg_line_guard'); assert.match(line, /MESSAGE\s*=\s*'immutable_row'/i); assert.match(line, /\bremoved_at\b/); assert.match(line, /\bremoved_by\b/); assert.match(line, /'draft'/);
  for (const c of ['received_qty_base', 'is_closed_short', 'discrepancy_reason_code', 'dispatched_value_paisa', 'book_qty_at_count', 'reason_code']) assert.match(line, new RegExp(`\\b${c}\\b`), `tg_line_guard lifecycle column ${c} (§5)`);
  for (const p of ['purchase_orders', 'goods_receipts', 'transfers', 'stock_counts']) assert.match(line, new RegExp(`inventory\\.${p}\\b`), `tg_line_guard reads the parent ${p}`);
  // tg_item_base_uom_lock: pack / rule / balance lookups (§5), immutable_row
  const lock = fnText(sql, 'inventory.tg_item_base_uom_lock'); assert.match(lock, /MESSAGE\s*=\s*'immutable_row'/i);
  for (const t of ['item_packs', 'consumption_rules', 'stock_balances']) assert.match(lock, new RegExp(`inventory\\.${t}\\b`), `uom lock looks in ${t} (§5: balances stand for movements)`);
  assert.deepEqual(fnNames(sql).sort(), [...FN_INV, FN_PURGE].sort(), 'no function beyond the three prose functions and the purge function');
  assert.doesNotMatch(sql, /SECURITY\s+DEFINER/i, 'C12 has no SECURITY DEFINER function (§11: "No DEFINER, no owner policy, no index exception")');
});
test('triggers: 4 app.enforce_mutable_columns triggers (item_packs, lots, consumption_rules, stock_balances) with EXACTLY the §5 column lists, BEFORE UPDATE; tg_doc_guard BEFORE UPDATE FOR EACH ROW on the 6 header tables; tg_line_guard BEFORE INSERT OR UPDATE on the 4 line tables; tg_item_base_uom_lock BEFORE UPDATE OF base_uom_code ON items; nothing else (audit aside); none disabled or dropped', () => {
  const sql = iSql(), all = createTriggers(sql), trg = all.filter((s) => !isAudit(s));
  const on = (fn) => trg.filter((s) => new RegExp(`EXECUTE\\s+(FUNCTION|PROCEDURE)\\s+${esc(fn)}\\s*\\(`, 'i').test(s));
  const tblOf = (s) => /\bON\s+inventory\.(\w+)/i.exec(s)[1];
  const mut = on('app.enforce_mutable_columns');
  for (const [t, cols] of Object.entries(MUT)) {
    const s = mut.find((x) => tblOf(x) === t); assert.ok(s, `inventory.${t}: app.enforce_mutable_columns trigger (§5)`);
    assert.match(s, /\bBEFORE\s+UPDATE\b/i, `${t}: BEFORE UPDATE`); assert.match(s, /FOR\s+EACH\s+ROW/i);
    assert.deepEqual(trgArgs(s, 'app\\.enforce_mutable_columns'), [...cols].sort(), `${t}: mutable column list = §5`);
  }
  for (const s of mut.filter((x) => !(tblOf(x) in MUT))) assert.match(trgName(s), /__mutable_columns$/, `extra enforce_mutable_columns trigger ${trgName(s)} must be named <table>__mutable_columns`);
  const doc = on('inventory.tg_doc_guard'); assert.deepEqual(doc.map(tblOf).sort(), [...DOC_T].sort(), 'tg_doc_guard on exactly the 6 header tables');
  for (const s of doc) assert.match(s, /^CREATE TRIGGER \w+ BEFORE UPDATE ON inventory\.\w+ FOR EACH ROW EXECUTE FUNCTION inventory\.tg_doc_guard\(\s*\)$/i, `doc guard: BEFORE UPDATE FOR EACH ROW: ${s}`);
  const line = on('inventory.tg_line_guard'); assert.deepEqual(line.map(tblOf).sort(), [...LINE_T].sort(), 'tg_line_guard on exactly the 4 line tables');
  for (const s of line) assert.match(s, /^CREATE TRIGGER \w+ BEFORE (INSERT OR UPDATE|UPDATE OR INSERT) ON inventory\.\w+ FOR EACH ROW EXECUTE FUNCTION inventory\.tg_line_guard\(\s*\)$/i, `line guard: BEFORE INSERT OR UPDATE FOR EACH ROW: ${s}`);
  const lock = on('inventory.tg_item_base_uom_lock'); assert.equal(lock.length, 1); assert.match(lock[0], /^CREATE TRIGGER \w+ BEFORE UPDATE OF base_uom_code ON inventory\.items FOR EACH ROW EXECUTE FUNCTION inventory\.tg_item_base_uom_lock\(\s*\)$/i);
  assert.equal(trg.length, mut.length + doc.length + line.length + lock.length, `no other non-audit trigger: ${trg.map(trgName).join(',')}`);
  for (const s of trg) { const n = trgName(s); assert.ok(n.startsWith(tblOf(s) + '__'), `trigger name ${n} is prefixed with its table`); }
  for (const c of ['qty_base', 'value_paisa', 'last_movement_at']) assert.ok(MUT.stock_balances.includes(c) && !['store_id', 'item_id', 'lot_id', 'tenant_id'].includes(c));
  for (const c of ['item_id', 'pack_code', 'qty_in_base', 'tenant_id', 'id']) assert.ok(!MUT.item_packs.includes(c), `item_packs.${c} stays frozen`);
  for (const c of ['item_id', 'lot_no', 'tenant_id']) assert.ok(!MUT.lots.includes(c), `lots.${c} stays frozen`);
  for (const c of ['rule_kind', 'item_id', 'qty_base', 'effective_from', 'supersedes_rule_id']) assert.ok(!MUT.consumption_rules.includes(c), `consumption_rules.${c} stays frozen (versioned by supersede)`);
  assert.doesNotMatch(sql, /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(sql, /DROP\s+TRIGGER\b/i);
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x; spec §5 "all M and C tables" minus the ledger, documents and the 3 projections): <t>__audit AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW on the 23 required tables (13 M, 10 C); none on stock_movements, stock_documents, stock_document_lines, stock_balances, consumption_daily, test_counts_daily or a G table; number_counters / instrument_qc_daily / alerts may carry one (no id / class E: spec silent)', () => {
  const trg = createTriggers(iSql()).filter(isAudit), onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  assert.equal(AUDITED_REQ.length, 23);
  for (const q of AUDITED_REQ) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(\\s*\\)$`, 'i'), q);
  }
  for (const q of AUDIT_FORBIDDEN) assert.equal(onTable(q).length, 0, `${q} must NOT be audited (§5: the ledger is the record; projections are derived)`);
  for (const q of G_T) assert.equal(onTable(q).length, 0, `${q}: G table`);
  for (const q of AUDIT_OPTIONAL) assert.ok(onTable(q).length <= 1, q);
  assert.equal(trg.length, AUDITED_REQ.length + AUDIT_OPTIONAL.filter((q) => onTable(q).length).length, 'no audit trigger beyond the listed tables');
});

// ================================================================ DEFINER inventory (none) + owner policies (none)
test('db/meta/definer-inventory.yaml has no inventory row (C12 adds no SECURITY DEFINER function: the purge function and the 3 guards are INVOKER, §11); no owner / lookup policy on inventory tables', () => {
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  assert.deepEqual(Object.keys(inv).filter((k) => /inventory/i.test(k)), []);
  assert.deepEqual(policies(polSql()).filter((p) => /\.(?!event_inbox)\w+$/.test(p.table) && /owner|lookup/i.test(p.name)), []);
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const MAND = { M: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'is_active'], C: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version'], A: ['id', 'tenant_id', 'created_at', 'created_by'],
  E: ['id', 'tenant_id', 'created_at', 'expires_at'], G: ['id', 'created_at', 'is_active'] };
const P2_COLS = { suppliers: ['contact_name', 'phone_display', 'email', 'address_text'] };      // §3 "P2-personal (non-patient)"
const P1_COLS = { consumption_facts: ['basis_key', 'source_event_id'] };                        // §3 "P1 (pseudonymous ids)"
test('tables.yaml: all 35 inventory tables registered (class G/M/C/A/E per §1, centre_scoped false everywhere, audited = trigger, retention, no shared_with, columns = the migration columns, phi_class P0..P2); the count equals the CREATE TABLE count; event_inbox entry untouched', () => {
  const y = tablesYaml(), regs = Object.keys(y).filter((k) => /^inventory\./.test(k) && !/\.event_inbox$/.test(k));
  assert.equal(regs.length, 35, 'tables.yaml inventory entries (ex event_inbox)'); assert.equal(regs.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'tables.yaml count == chunk DDL count');
  const trgAudited = (q) => createTriggers(iSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of ALLT) {
    const e = y[q], t = q.split('.')[1]; assert.ok(e && createTable(iSql(), q), `${q} in tables.yaml and migrations`);
    assert.equal(e.class, isG(q) ? 'G' : CLS[t], `${q} class (§1)`);
    assert.equal(e.centre_scoped, false, `${q} centre_scoped (§1: every table is __tenant)`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`);
    if (AUDITED_REQ.includes(q)) assert.equal(e.audited, true, `${q} audited (§5)`); if (AUDIT_FORBIDDEN.includes(q) || isG(q)) assert.equal(e.audited, false, `${q} not audited (§5)`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), [...createTable(iSql(), q).colNames.map((c) => c.replace(/"/g, ''))].sort(), `${q} columns = migration columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
    assert.deepEqual([...(e.shared_with ?? [])], [], `${q}: no inventory table is shared with partner / portal / patient actors (§4.1)`);
  }
  assert.ok(y['inventory.event_inbox'].class === 'A', 'inbox entry remains as C0 wrote it');
});
test('tables.yaml phi_class (§3): P2 exactly on suppliers.contact_name / phone_display / email / address_text (all required); P1 on consumption_facts.basis_key + source_event_id (required); no P3 anywhere; every other column P0..P1 (ids / _by P1 allowed, *_paisa P0 financial); created_by / updated_by P0..P1', () => {
  const y = tablesYaml();
  for (const q of ALLT) {
    const t = q.split('.')[1]; assert.ok(y[q], `${q} in tables.yaml`);
    for (const [c, p] of Object.entries(y[q].columns)) {
      assert.notEqual(p, 'P3', `${q}.${c}: inventory holds no health data (§3)`);
      if (p === 'P2') assert.ok((P2_COLS[t] ?? []).includes(c), `${q}.${c}: P2 only on ${JSON.stringify(P2_COLS)}`);
      if (['created_by', 'updated_by'].includes(c)) assert.ok(['P0', 'P1'].includes(p), `${q}.${c}`);
    }
    for (const c of P2_COLS[t] ?? []) assert.equal(y[q].columns[c], 'P2', `${q}.${c} must be P2 (§3)`);
    for (const c of P1_COLS[t] ?? []) assert.equal(y[q].columns[c], 'P1', `${q}.${c} must be P1 (§3)`);
    for (const c of ['id', 'tenant_id', 'version']) if (y[q].columns[c]) assert.ok(['P0', 'P1'].includes(y[q].columns[c]), `${q}.${c}`);
  }
  assert.equal(Object.values(y['inventory.event_inbox'].columns).filter((p) => p === 'P1').length >= 0, true);
  assert.match(spec3(), /basis_key/); assert.match(spec3(), /contact_name/);
});
test('tables.yaml: rls_exempt only on the 3 G tables (with a reason); mandatory_column_exceptions = exactly the class-mandatory columns the DDL lacks, with a reason (number_counters: id, version, is_active, created_at, created_by, updated_by; instrument_qc_daily: id, version, is_active; §1 / P-18(b)); every other table carries all of them (02-CV §5.2)', () => {
  const y = tablesYaml();
  for (const q of ALLT) {
    assert.ok(y[q] && createTable(iSql(), q), `${q} in tables.yaml and in the migrations`);
    const e = y[q], cls = isG(q) ? 'G' : CLS[q.split('.')[1]], cols = new Set(createTable(iSql(), q).colNames), t = q.split('.')[1];
    if (isG(q)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    const missing = MAND[cls].filter((c) => !cols.has(c)).sort(), got = [...(e.mandatory_column_exceptions ?? [])].sort();
    assert.deepEqual(got, missing, `${q}: mandatory_column_exceptions must list exactly the missing class-${cls} columns`);
    if (got.length) assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 5, `${q}: mandatory_column_exceptions_reason`);
    assert.equal(isG(q), !cols.has('tenant_id'));
    if (t === 'number_counters') assert.deepEqual(got, ['created_at', 'created_by', 'id', 'is_active', 'updated_by', 'version'], '§1 exception text: no id, version, is_active, created_*, updated_by');
    if (t === 'instrument_qc_daily') assert.deepEqual(got, ['id', 'is_active', 'version'], '§1 exception text: no id, version, is_active');
  }
  for (const q of TENANT.filter((x) => !NO_ID.includes(x.split('.')[1]))) assert.deepEqual(y[q].mandatory_column_exceptions ?? [], [], `${q}: no exception`);
});
test('tables.yaml retention (§11): ledger / documents / facts / projections / master data kept forever (floor: tenant retentionYears), never purged; alerts = resolved + 365 days via the per_tenant purge; G tables seed / permanent; event_inbox 90 days', () => {
  assert.match(spec11(), /alerts/); const r = (q) => { const e = tablesYaml()[`inventory.${q}`]; assert.ok(e, `inventory.${q} in tables.yaml`); return e.retention; };
  for (const q of T_N.filter((t) => t !== 'alerts')) assert.match(r(q), /forever|never deleted|kept|permanent|no purge|retention/i, q);
  assert.match(r('alerts'), /365|resolved|purge/i, 'alerts retention: resolved + 365 days, purge_inventory_alerts');
  for (const q of G_N) assert.match(r(q), /seed|permanent|never deleted|kept|forever|global/i, q);
  assert.match(tablesYaml()['inventory.event_inbox'].retention, /90 days/);
});
test('db/tests/rls_exempt.txt lists exactly the 3 inventory G tables with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^inventory\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), [...G_T].sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ seeds (§6.1 uom, §6.2 reasons, §6.3 tax code; "global vocabulary", seeded by migration)
const lit = (v) => /^'(.*)'$/.exec(v)?.[1];
function uomSpec() {
  const s = spec6().split('### 6.2')[0];
  const rows = [...s.matchAll(/`([a-z]+)`\s+"([^"]+)"/g)].map((m) => [m[1], m[2]]);
  const kind = (c) => (['ml', 'ul', 'l'].includes(c) ? 'volume' : ['g', 'mg'].includes(c) ? 'mass' : 'count');
  return rows.map(([c, d]) => [c, d, kind(c)]);
}
function reasonSpec() {
  const rows = [];
  for (const l of spec6().split('### 6.3')[0].split('\n').filter((x) => /^\| [a-z_]+ \| `/.test(x))) {
    const c = l.split('|'), grp = c[1].trim(); for (const m of c[2].matchAll(/`([a-z_]+)`/g)) rows.push([grp, m[1]]);
  }
  return rows;
}
test('seed rows: g_cs_uom (19 §6.1 units with spec displays and kinds), g_cs_reasons (50 §6.2 group/code pairs, display 1..80 chars) and g_cs_tax_codes (VAT / VAT, no rate column, §6.3) seeded by the migration; system = lims / system_version = 1 (explicit or by default); every row names its id; nothing else seeded (no cs_* tenant rows, no settings, no exempt tax row)', () => {
  const sql = iSql();
  const uom = uomSpec(); assert.equal(uom.length, 19, `§6.1 units: ${uom.length}`); assert.deepEqual(uom.slice(0, 3), [['test', 'test', 'count'], ['ml', 'mL', 'volume'], ['ul', 'µL', 'volume']]);
  const ur = insertRows(sql, 'inventory.g_cs_uom'); assert.equal(ur.length, 19, 'g_cs_uom: 19 seed rows');
  assert.deepEqual(ur.map((r) => [lit(r.code), lit(r.display), lit(r.uom_kind)]).sort(), uom.map((x) => [...x]).sort(), 'g_cs_uom seed = spec §6.1');
  const rs = reasonSpec(); assert.equal(rs.length, 50, `§6.2 reasons: ${rs.length}`); assert.equal(new Set(rs.map((x) => x[0])).size, 11);
  const rr = insertRows(sql, 'inventory.g_cs_reasons'); assert.equal(rr.length, 50, 'g_cs_reasons: 50 seed rows');
  assert.deepEqual(rr.map((r) => [lit(r.reason_group), lit(r.code)]).sort(), rs.map((x) => [...x]).sort(), 'g_cs_reasons seed = spec §6.2 (group, code)');
  for (const r of rr) { const d = lit(r.display); assert.ok(d && d.length >= 1 && d.length <= 80, `reason display ${r.display}`); }
  const tr = insertRows(sql, 'inventory.g_cs_tax_codes'); assert.deepEqual(tr.map((r) => [lit(r.code), lit(r.display)]), [['VAT', 'VAT']], 'g_cs_tax_codes seed = exactly VAT (§6.3; no exempt row, no rate)');
  for (const [t, rows] of [['g_cs_uom', ur], ['g_cs_reasons', rr], ['g_cs_tax_codes', tr]]) {
    for (const r of rows) { assert.ok('id' in r, `${t}: the G table has an id with no default: every seed row names it`); if ('system' in r) assert.equal(lit(r.system), 'lims'); if ('system_version' in r) assert.equal(lit(r.system_version), '1'); }
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, `${t}: seed ids are distinct`);
  }
  const tables = [...new Set(stmts(sql).map(ws).filter((s) => /^INSERT\s+INTO\b/i.test(s)).map((s) => /INTO\s+(\S+)/i.exec(s)[1]))].sort();
  assert.deepEqual(tables, ['inventory.g_cs_reasons', 'inventory.g_cs_tax_codes', 'inventory.g_cs_uom'], 'no other INSERT in the inventory migrations (settings / counters are created lazily, P-22; test seeds §6.5 belong to packages/test-fixtures)');
  assert.doesNotMatch(createTable(sql, 'inventory.g_cs_tax_codes').colNames.join(','), /rate/, 'no rate column (08 A2.2)');
});

// ================================================================ views: none (§9; IC §6)
test('no published view: IC §6 defines no inventory.v_pub_* view and C12 publishes none in v1 (§9) - the migrations create no view / materialized view and no view grant exists; the view column contract is therefore vacuous', () => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8');
  assert.doesNotMatch(ic, /\binventory\.v_pub_/, 'IC lists an inventory.v_pub_* view: this test (and the C12 DDL) must then add its column contract');
  assert.doesNotMatch(strip(iSql()) + polSql(), /\bCREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+|TEMP(?:ORARY)?\s+)?VIEW\b/i);
  assert.doesNotMatch(iSql() + polSql(), /\bv_pub_/i);
});

// ================================================================ hygiene
test('C12 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of other schemas\' tables, no USING (true), no GRANT to PUBLIC; no Storage SQL; no hard-coded tax rate / price data', () => {
  const raw = iFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 40000, 'C12 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i); assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics|quality|micro|anatomic)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016'); assert.doesNotMatch(strip(raw), /\bTO\s+PUBLIC\b/i);
  assert.doesNotMatch(strip(raw) + polSql(), /\bstorage\.(objects|buckets)\b/i, 'no Storage SQL (LD-54)');
  assert.doesNotMatch(strip(raw), /\b(INSERT\s+INTO\s+inventory\.(items|suppliers|stores|lots|settings|cs_))/i, 'no tenant data / fixtures in migrations (§6.5 belongs to packages/test-fixtures)');
});
test('LD-202 scope: no wave-1 migration, db/bootstrap, spec, service or app file is changed by this task (only inventory files + policies + meta + tests are new / edited)', () => {
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', 'db/migrations', 'db/bootstrap', 'spec', 'services', 'apps'], { cwd: repo, encoding: 'utf8' });
  const changed = r.stdout.split('\n').filter(Boolean).filter((f) => !/^db\/migrations\/\d{14}_inventory__/.test(f));
  assert.deepEqual(changed, [], 'tracked files outside the inventory migrations were modified');
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts, check-migrations.ts and check-fk-dag.ts exit 0 on the tree (inventory -> core / catalog / instruments only; nothing into inventory)', () => {
  assert.ok(iFiles().length >= 1, 'C12 migrations missing');
  for (const t of ['check-registry.ts', 'check-migrations.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 32 tenant C12 tables (number_counters and instrument_qc_daily have no id), none for the 3 class G tables, and gen-isolation-probes --check is clean; _registry.sql lists all 35', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const q of G_T) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/inventory/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-13\.C12_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/inventory/T0B-13.C12_*.test.sql exist (tester-owned: writer must keep them) and cover the AC list by "-- AC-0B-x.y" markers and 14 checks by "-- C12 check N" markers; RLS never disabled; replica mode (if used) reset to origin', () => {
  assert.ok(tapFiles().length >= 2, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 14; n++) assert.match(txt, new RegExp(`-- C12 check ${n}\\b`), `marker for C12 check ${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.1', '6.2', '6.3']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
    const rep = [...s.matchAll(/session_replication_role\s*=\s*replica/gi)].length, org = [...s.matchAll(/session_replication_role\s*=\s*origin/gi)].length;
    assert.ok(rep === 0 || (org >= rep && s.lastIndexOf('= origin') > s.lastIndexOf('= replica')), `${f}: every replica fixture block is reset to origin before assertions`);
  }
});
