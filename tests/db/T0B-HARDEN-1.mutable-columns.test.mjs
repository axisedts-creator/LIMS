// T0B-HARDEN-1 (C0, LD-231, audit item 1, AC-0B-4.1): static checks of db/migrations/20261115200000_core__add_mutable_columns_triggers.sql.
// The 44 class C/B tables of LD-231 each get a BEFORE UPDATE FOR EACH ROW app.enforce_mutable_columns trigger, or are skipped with a non-blocking CR
// (.orchestra/cr/T0B-HARDEN-1.<table>.nonblocking.md). The SAFETY RULE of LD-231 is proven here: every UPDATE (and every INSERT .. ON CONFLICT DO UPDATE)
// in services/api, services/worker and the db functions/seeds that targets a trigger-covered table sets only columns that are in that table's list.
// NOT RUN in the lane: db/tests/immutability/T0B-08_immutability.test.sql test 1 (needs a real database; the founder runs it after merge, LD-231).
// Run: node --test tests/db/T0B-HARDEN-1.mutable-columns.test.mjs      (T0BH1_ROOT=<dir> points the checks at another tree; T0BH1_SURVEY=1 prints every scanned UPDATE site)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative, join } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0BH1_ROOT ? resolve(process.env.T0BH1_ROOT) + '/' : repo;
const MIG = '20261115200000_core__add_mutable_columns_triggers.sql';
const AFTER = '20261115192000';

// The 44 tables of LD-231 (verbatim).
const TABLES = `anatomic.addenda, anatomic.batch_members, anatomic.batches, anatomic.case_items, anatomic.cases, anatomic.gross_records, anatomic.molecular_results, anatomic.parts, anatomic.report_drafts, anatomic.specimen_links, anatomic.stain_orders, billing.credit_note_tasks, billing.finance_review_items, frontdesk.order_flags, inventory.consumption_facts, inventory.goods_receipt_lines, inventory.goods_receipts, inventory.opened_containers, inventory.purchase_order_lines, inventory.purchase_orders, inventory.stock_count_lines, inventory.stock_counts, inventory.transfer_lines, inventory.transfers, lab.ingest_exceptions, lab.order_readiness, lab.order_tests, lab.orders, lab.qc_holds, lab.results, lab.worksheets, micro.ast_results, micro.culture_plates, micro.isolates, partners.access_slips, partners.manifest_lines, partners.manifests, partners.pickup_request_manifests, partners.pickup_requests, payments.reconciliation_runs, quality.qc_runs, reporting.narrative_reports, reporting.narrative_versions, reporting.report_order_items`.split(/,\s*/);
const SCHEMAS = [...new Set(TABLES.map((t) => t.split('.')[0]))];
const IDENTITY_COLS = ['id', 'tenant_id', 'created_at', 'created_by'];   // never mutable on a class C/B row
const STAMPS = ['updated_at', 'updated_by', 'version'];                  // LD-231: always in the list where the table has them

// ------------------------------------------------------------------------------------------------ helpers
const nl = (s) => s.replace(/\r\n?/g, '\n');
const stripSql = (s) => nl(s).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '__tests__' || e === 'coverage') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const isSource = (p) => /\.(ts|mjs|js|sql)$/.test(p) && !/\.(test|spec)\.[a-z]+$/.test(p) && !/\.d\.ts$/.test(p);

function splitStatements(sql) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (q) { cur += c; if (c === "'") { if (sql[i + 1] === "'") { cur += "'"; i++; } else q = false; } continue; }
    if (c === "'") { q = true; cur += c; continue; }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// db/meta/tables.yaml: one flow-style JSON object per table line.
function loadTablesMeta() {
  const out = {};
  for (const line of nl(readFileSync(root + 'db/meta/tables.yaml', 'utf8')).split('\n')) {
    const m = /^\s*"([a-z0-9_]+\.[a-z0-9_]+)":\s*(\{.*\}),?\s*$/.exec(line);
    if (m) out[m[1]] = JSON.parse(m[2]);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ UPDATE scanner
// Placeholders `${...}` of a JS template literal are opaque tokens; `$${n}` is a literal `$` followed by a placeholder (a SQL parameter number).
function readPlaceholder(text, i) {          // text[i..i+1] === '${'; returns index after the matching '}' (nested braces and nested template strings handled)
  let depth = 1, j = i + 2;
  while (j < text.length && depth) {
    const c = text[j];
    if (c === '`') { j++; while (j < text.length && text[j] !== '`') { if (text[j] === '$' && text[j + 1] === '{') j = readPlaceholder(text, j); else j++; } j++; continue; }
    if (c === "'" || c === '"') { const qc = c; j++; while (j < text.length && text[j] !== qc) { if (text[j] === '\\') j++; j++; } j++; continue; }
    if (c === '{') depth++; else if (c === '}') depth--;
    j++;
  }
  return j;
}
// Parse an assignment list starting at `from` (just after SET / DO UPDATE SET). Returns { cols, dynamic:[placeholder source], end }.
function parseSetClause(text, from, stopQuote = '') {   // stopQuote: the JS string quote the statement sits in ('"' / "'"), '' for a template literal or a .sql file
  const cols = [], dynamic = [];
  let i = from, depth = 0, cur = '', hasPh = false;
  const flush = () => {
    const a = cur.trim(); cur = '';
    if (!a) { hasPh = false; return; }
    const ph = /^\u0001(\d+)\u0001/.exec(a);
    if (hasPh && (ph || !/^"?[a-z_][a-z0-9_]*"?\s*=/i.test(a))) { dynamic.push(...[...a.matchAll(/\u0001(\d+)\u0001/g)].map((m) => phs[Number(m[1])])); }
    else {
      const t = /^\(\s*([^)]*)\)\s*=/.exec(a);              // (a, b) = (...)
      if (t) cols.push(...t[1].split(',').map((x) => x.trim().replace(/"/g, '')).filter(Boolean));
      else { const m = /^"?([a-z_][a-z0-9_]*)"?\s*=/i.exec(a); if (m) cols.push(m[1].toLowerCase()); else dynamic.push(a); }
    }
    hasPh = false;
  };
  const phs = [];
  while (i < text.length) {
    const c = text[i];
    if (c === '$' && text[i + 1] === '{') { const e = readPlaceholder(text, i); phs.push(text.slice(i + 2, e - 1)); cur += `\u0001${phs.length - 1}\u0001`; hasPh = true; i = e; continue; }
    if (stopQuote && c === stopQuote) { const j = /^["']\s*\+\s*["']/.exec(text.slice(i, i + 40)); if (j) { cur += ' '; i += j[0].length; continue; } break; }   // "..." + "..." continues the statement
    if (c === "'") { cur += c; i++; while (i < text.length) { cur += text[i]; if (text[i] === "'") { if (text[i + 1] === "'") { cur += "'"; i += 2; continue; } i++; break; } i++; } continue; }
    if (c === '`' || c === ';') break;
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') { if (depth === 0) break; depth--; }
    if (depth === 0) {
      const rest = text.slice(i, i + 12);
      if (/^(WHERE|FROM|RETURNING)\b/i.test(rest) && /\W/.test(text[i - 1] || ' ')) break;
      if (c === ',') { flush(); i++; continue; }
    }
    cur += c; i++;
  }
  flush();
  return { cols, dynamic, end: i };
}
// Every UPDATE <schema.table> ... SET and INSERT INTO <schema.table> ... ON CONFLICT ... DO UPDATE SET that targets one of `schemas`.
function scanUpdates(text, file, kind) {
  const found = [];
  const sch = SCHEMAS.join('|');
  const upd = new RegExp(`\\bUPDATE\\s+(?:ONLY\\s+)?"?(${sch})"?\\s*\\.\\s*"?([a-z0-9_]+)"?(?:\\s+(?:AS\\s+)?(?!SET\\b)[a-z_][a-z0-9_]*)?\\s+SET\\b`, 'gi');
  const ins = new RegExp(`\\bINSERT\\s+INTO\\s+"?(${sch})"?\\s*\\.\\s*"?([a-z0-9_]+)"?`, 'gi');
  const lineStart = (idx) => text.lastIndexOf('\n', idx - 1) + 1;
  const commented = (idx) => kind === 'ts' && /^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart(idx), idx));
  let m;
  while ((m = upd.exec(text))) {
    if (commented(m.index)) continue;
    const prev = kind === 'ts' ? text[m.index - 1] : '';
    const r = parseSetClause(text, m.index + m[0].length, prev === '"' || prev === "'" ? prev : '');
    found.push({ table: `${m[1]}.${m[2]}`.toLowerCase(), kind: 'update', file, line: lineOf(text, m.index), idx: m.index, ...r, text });
  }
  while ((m = ins.exec(text))) {
    if (commented(m.index)) continue;
    // bounded to this statement: up to the first ';' or backtick that is not inside a placeholder
    let j = m.index + m[0].length, end = text.length;
    while (j < text.length) { if (text[j] === '$' && text[j + 1] === '{') { j = readPlaceholder(text, j); continue; } if (text[j] === ';' || text[j] === '`') { end = j; break; } j++; }
    const seg = text.slice(m.index, end);
    const d = /\bON\s+CONFLICT\b[\s\S]*?\bDO\s+UPDATE\s+SET\b/i.exec(seg);
    if (!d) continue;
    const r = parseSetClause(text, m.index + d.index + d[0].length);
    found.push({ table: `${m[1]}.${m[2]}`.toLowerCase(), kind: 'upsert', file, line: lineOf(text, m.index), idx: m.index, ...r, text });
  }
  return found;
}
// Resolve a placeholder that is a plain identifier bound by const/let in the same file to the `col =` assignments inside its initialiser.
function resolveIdentifier(text, ident) {
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return null;
  const m = new RegExp(`\\b(?:const|let|var)\\s+${ident.replace(/\$/g, '\\$')}\\b[^=\\n]*=\\s*`).exec(text);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 0, q = '';
  const start = i;
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q && text[i - 1] !== '\\') q = ''; continue; }
    if (c === '`' || c === "'" || c === '"') { q = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++; else if (c === ')' || c === '}' || c === ']') depth--;
    if (c === ';' && depth <= 0) break;
  }
  const init = text.slice(start, i);
  return [...init.matchAll(/(?:^|[\s,`'"(])([a-z_][a-z0-9_]*)\s*=\s*(?![=>])/gi)].map((x) => x[1].toLowerCase());
}

const colsIn = (s) => [...s.matchAll(/(?:^|[\s,`'"(])([a-z_][a-z0-9_]*)\s*=\s*(?![=>])/gi)].map((x) => x[1].toLowerCase());
// Resolve the columns a run-time SET fragment can assign, from the same file only: (1) `col =` literals inside the placeholder itself (ternary strings),
// (2) the const/let initialiser of its root identifier, (3) `<ident>.push('col = ..')` calls, (4) `[SET, ARGS] = setClause(x, <ALLOW>, n)` where <ALLOW> is a
// const object/array of the allowed columns in the same file. Anything else is unresolved (returns null) and forces a CR for the table.
function resolveDynamic(fullText, ph, at = fullText.length) {
  const text = fullText.slice(0, at), out = new Set(), src = ph.trim();   // only code before the statement: the nearest preceding binding wins
  colsIn(src).forEach((c) => out.add(c));
  let ok = out.size > 0;
  const root = /^([A-Za-z_$][\w$]*)\b(?!\s*\?)/.exec(src);   // root identifier (not the condition of a ternary)
  if (root) {
    const id = root[1];
    const r = resolveIdentifier(text, id) || [];
    if (r.length) { r.forEach((c) => out.add(c)); ok = true; }
    for (const p of text.matchAll(new RegExp(`\\b${id}\\.push\\(\\s*([\`'"])([^\\n]*?)\\1`, 'g'))) { colsIn(p[2]).forEach((c) => out.add(c)); ok = true; }
    const ds = [...text.matchAll(new RegExp(`\\b(?:const|let)\\s*\\[\\s*${id}\\b[^\\]]*\\]\\s*=\\s*\\w+\\([^)]*?\\b([A-Z][A-Z0-9_]+)\\b`, 'g'))];
    const d = ds[ds.length - 1];
    if (d) {
      const k = new RegExp(`\\bconst\\s+${d[1]}\\b[^=]*=\\s*([\\[{][\\s\\S]*?[\\]}])\\s*(?:as\\s+const)?\\s*;`).exec(fullText);
      if (k) {
        if (k[1][0] === '{') [...k[1].matchAll(/[{,]\s*['"]?([a-z_][a-z0-9_]*)['"]?\s*:/g)].forEach((x) => out.add(x[1]));
        else [...k[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].forEach((x) => out.add(x[1]));
        ok = true;
      }
    }
  }
  return ok ? [...out] : null;
}

// ------------------------------------------------------------------------------------------------ the migration
const migPath = root + 'db/migrations/' + MIG;
const migRaw = existsSync(migPath) ? nl(readFileSync(migPath, 'utf8')) : '';
const migSql = stripSql(migRaw);
const migStmts = splitStatements(migSql);
const TRG_RE = /^CREATE\s+TRIGGER\s+"?([a-z0-9_]+)"?\s+BEFORE\s+UPDATE\s+ON\s+"?([a-z0-9_]+)"?\s*\.\s*"?([a-z0-9_]+)"?\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+app\.enforce_mutable_columns\s*\(([\s\S]*)\)$/i;
function parseTriggers() {
  const out = [];
  for (const s of migStmts) {
    const m = TRG_RE.exec(s);
    if (!m) continue;
    const args = m[4];
    const cols = [...args.matchAll(/'([^']*)'/g)].map((x) => x[1]);
    const rest = args.replace(/'[^']*'/g, '').replace(/[\s,]/g, '');
    out.push({ name: m[1].toLowerCase(), table: `${m[2]}.${m[3]}`.toLowerCase(), cols, junk: rest, stmt: s });
  }
  return out;
}
const triggers = parseTriggers();
const byTable = new Map(triggers.map((t) => [t.table, t]));
const crPath = (t) => root + `.orchestra/cr/T0B-HARDEN-1.${t}.nonblocking.md`;
const skipped = TABLES.filter((t) => !byTable.has(t));
const meta = loadTablesMeta();

// ------------------------------------------------------------------------------------------------ 1. the migration file
test('migration exists, sorts after 20261115192000, core__ additive naming', () => {
  assert.ok(existsSync(migPath), `${MIG} must exist`);
  assert.match(MIG, /^\d{14}_core__[a-z0-9_]+\.sql$/);
  assert.ok(MIG.slice(0, 14) > AFTER, 'timestamp must sort after 20261115192000');
  const others = readdirSync(root + 'db/migrations').filter((f) => f.endsWith('.sql') && f !== MIG);
  assert.ok(others.length >= 39, 'sanity: the other migrations are present');
  assert.ok(!others.some((f) => f.slice(0, 14) === MIG.slice(0, 14)), 'no other migration shares the timestamp');
});

test('migration shape: SET LOCAL ROLE lims_owner first, no CREATE ROLE, only CREATE TRIGGER otherwise (additive; no existing object changes)', () => {
  assert.ok(migSql, 'migration must exist and be non-empty');
  assert.match(migRaw, /LD-231/, 'cites LD-231 in a comment');
  assert.doesNotMatch(migSql, /\b(CREATE|ALTER|DROP)\s+(USER|ROLE)\b/i, 'no CREATE ROLE');
  assert.ok(migStmts.length >= 2, 'role switch + triggers');
  assert.match(migStmts[0], /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, 'first statement is SET LOCAL ROLE lims_owner');
  for (const s of migStmts.slice(1)) {
    assert.ok(TRG_RE.test(s) || /^RESET\s+ROLE$/i.test(s), `only CREATE TRIGGER (BEFORE UPDATE FOR EACH ROW app.enforce_mutable_columns) / RESET ROLE allowed, got: ${s.slice(0, 100)}`);
  }
  assert.doesNotMatch(migSql, /\b(DROP|GRANT|REVOKE|CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TABLE|POLICY|INDEX|VIEW)|ALTER\s+(TABLE|POLICY|FUNCTION))/i, 'no other DDL');
  // LD-231 / arbiter ruling: "BEFORE UPDATE" is required, so anchor DML at statement start
  for (const s of migStmts) assert.doesNotMatch(s, /^\s*(UPDATE|DELETE|INSERT)\s/i, 'no DML');
});

test('each trigger parses: BEFORE UPDATE FOR EACH ROW, listed table only, one per table, unique names, <table>__mutable_columns', () => {
  assert.ok(triggers.length > 0, 'at least one trigger parsed');
  const names = triggers.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'trigger names unique within the migration');
  assert.equal(new Set(triggers.map((t) => t.table)).size, triggers.length, 'one trigger per table');
  for (const t of triggers) {
    assert.ok(TABLES.includes(t.table), `${t.table} is not one of the 44 tables of LD-231`);
    assert.match(t.name, /^[a-z0-9_]+__mutable_columns$/, `${t.name}: named like the existing triggers (<table>__mutable_columns)`);
    assert.ok(t.name.startsWith(t.table.split('.')[1].slice(0, 20).replace(/_+$/, '')) || t.name.length <= 63, `${t.name}: derived from the table name`);
    assert.ok(t.name.length <= 63, `${t.name}: identifier longer than 63 bytes`);
    assert.equal(t.junk, '', `${t.table}: arguments must be string literals only`);
    assert.ok(t.cols.length > 0, `${t.table}: empty list would freeze every column`);
    assert.equal(new Set(t.cols).size, t.cols.length, `${t.table}: duplicate column in list`);
  }
  // no clash with an existing trigger of the same name on the same table
  const existing = new Set();
  for (const f of readdirSync(root + 'db/migrations').filter((x) => x.endsWith('.sql') && x !== MIG)) {
    for (const s of splitStatements(stripSql(readFileSync(root + 'db/migrations/' + f, 'utf8')))) {
      const m = /^CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+"?([a-z0-9_]+)"?[\s\S]*?\bON\s+"?([a-z0-9_]+)"?\s*\.\s*"?([a-z0-9_]+)"?/i.exec(s);
      if (m) existing.add(`${m[2]}.${m[3]}.${m[1]}`.toLowerCase());
    }
  }
  for (const t of triggers) assert.ok(!existing.has(`${t.table}.${t.name}`), `${t.table}.${t.name} already exists in an earlier migration`);
});

// ------------------------------------------------------------------------------------------------ 2. coverage: trigger XOR non-blocking CR
test('every one of the 44 tables has a trigger or a non-blocking CR stating why (never both, never neither)', () => {
  assert.equal(TABLES.length, 44);
  assert.equal(new Set(TABLES).size, 44);
  assert.ok(migSql, 'migration must exist');
  for (const t of TABLES) {
    const hasCr = existsSync(crPath(t));
    const hasTrg = byTable.has(t);
    assert.ok(hasTrg || hasCr, `${t}: neither a trigger in ${MIG} nor .orchestra/cr/T0B-HARDEN-1.${t}.nonblocking.md`);
    assert.ok(!(hasTrg && hasCr), `${t}: has both a trigger and a skip CR`);
    if (hasCr) {
      const cr = readFileSync(crPath(t), 'utf8');
      assert.ok(cr.includes(t), `${t}: CR must name the table`);
      assert.ok(cr.trim().length >= 200, `${t}: CR must state why the table was skipped (too short)`);
      assert.match(cr, /spec|list|column/i, `${t}: CR must say what the spec lacks / which column is outside the list`);
    }
  }
});

// ------------------------------------------------------------------------------------------------ 3. lists against tables.yaml
test('each list: columns exist on the table, no identity column, includes updated_at/updated_by/version where the table has them', () => {
  assert.ok(Object.keys(meta).length > 100, 'db/meta/tables.yaml parsed');
  assert.ok(triggers.length > 0, 'triggers must exist');
  for (const t of triggers) {
    const cols = Object.keys((meta[t.table] || {}).columns || {});
    assert.ok(cols.length > 0, `${t.table} missing from db/meta/tables.yaml`);
    for (const c of t.cols) {
      assert.ok(cols.includes(c), `${t.table}: list column ${c} is not a column of the table`);
      assert.ok(!IDENTITY_COLS.includes(c), `${t.table}: ${c} is an identity column and must never be mutable`);
    }
    for (const s of STAMPS) if (cols.includes(s)) assert.ok(t.cols.includes(s), `${t.table}: has ${s} but the list omits it (LD-231 safety rule)`);
  }
});

// ------------------------------------------------------------------------------------------------ 4. the static UPDATE-statement test (LD-231 SAFETY RULE)
// A statement whose column set cannot be read statically (the SET list is built at run time) is resolved here, once, by reading the code.
// key: `<repo-relative file>|<table>` ; the columns are every column that code path can ever assign. A table with an unresolved statement
// must be skipped (CR), never widened.
const RESOLVED_DYNAMIC = {};
function allSources() {
  const files = [];
  for (const d of ['services/api/src', 'services/worker/src', 'db/migrations', 'db/seeds', 'db/provisioning', 'db/bootstrap']) walk(root + d, files);
  return files.filter(isSource).filter((p) => relative(root, p).replace(/\\/g, '/') !== 'db/migrations/' + MIG);
}
function scanAll() {
  const out = [];
  for (const p of allSources()) {
    const raw = nl(readFileSync(p, 'utf8'));
    const kind = p.endsWith('.sql') ? 'sql' : 'ts';
    const text = kind === 'sql' ? stripSql(raw) : raw;
    for (const u of scanUpdates(text, relative(root, p).replace(/\\/g, '/'), kind)) out.push(u);
  }
  return out;
}
let scanned = null;
const scan = () => (scanned ||= scanAll());

test('static UPDATE scan: every UPDATE / ON CONFLICT DO UPDATE of a trigger-covered table sets only columns in that table\'s list', () => {
  const sites = scan().filter((u) => TABLES.includes(u.table));
  if (process.env.T0BH1_SURVEY) for (const u of sites) console.log(`${u.table.padEnd(34)} ${u.kind.padEnd(6)} ${u.file}:${u.line} cols=[${u.cols.join(',')}] dyn=${u.dynamic.map((d) => d.slice(0, 40).replace(/\s+/g, ' ') + ' => ' + ((resolveDynamic(u.text, d, u.idx) ||['UNRESOLVED']).join('+'))).join(' ## ')}`);
  assert.ok(sites.length >= 20, `scanner sanity: expected many UPDATE sites on the 44 tables, found ${sites.length}`);
  assert.ok(triggers.length > 0, 'triggers must exist');
  const problems = [];
  for (const u of sites) {
    const t = byTable.get(u.table);
    if (!t) continue;                                         // skipped table: nothing enforced, nothing to prove
    for (const c of u.cols) if (!t.cols.includes(c)) problems.push(`${u.file}:${u.line} ${u.table} sets "${c}" which is not in the list (${t.cols.join(',')})`);
    for (const ph of u.dynamic) {
      const resolved = RESOLVED_DYNAMIC[`${u.file}|${u.table}`] || resolveDynamic(u.text, ph, u.idx);
      if (!resolved) { problems.push(`${u.file}:${u.line} ${u.table}: SET list built at run time (\${${ph.slice(0, 50)}}) and not resolved in this test; skip the table with a CR`); continue; }
      for (const c of resolved) if (!t.cols.includes(c)) problems.push(`${u.file}:${u.line} ${u.table} may set "${c}" (dynamic) which is not in the list`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('a table without a trigger is skipped only with its CR (the scan above proves nothing for it)', () => {
  assert.ok(migSql, 'migration must exist');
  for (const t of skipped) assert.ok(existsSync(crPath(t)), `${t}: skipped without a CR`);
});

// ------------------------------------------------------------------------------------------------ 5. the immutability test's query, re-expressed statically
// db/tests/immutability/T0B-08_immutability.test.sql test 1: class C/B tables on which lims_app holds UPDATE and that lack a BEFORE UPDATE FOR EACH ROW
// app.enforce_mutable_columns trigger. Here: tables.yaml class C/B, GRANT .. UPDATE .. TO lims_app (migrations in order), trigger statements of all migrations.
function remainingTables(includeNew) {
  const granted = new Set(), guarded = new Set();
  const files = readdirSync(root + 'db/migrations').filter((f) => f.endsWith('.sql') && (includeNew || f !== MIG)).sort();
  for (const f of files) {
    for (const s of splitStatements(stripSql(readFileSync(root + 'db/migrations/' + f, 'utf8')))) {
      let m = /^GRANT\s+([\s\S]+?)\s+ON\s+(?:TABLE\s+)?([\s\S]+?)\s+TO\s+([\s\S]+)$/i.exec(s);
      if (m && /\blims_app\b/.test(m[3]) && /\b(UPDATE|ALL)\b/i.test(m[1]) && !/\(/.test(m[1])) for (const t of m[2].split(',')) granted.add(t.trim().replace(/"/g, '').toLowerCase());
      m = /^REVOKE\s+([\s\S]+?)\s+ON\s+(?:TABLE\s+)?([\s\S]+?)\s+FROM\s+([\s\S]+)$/i.exec(s);
      if (m && /\blims_app\b/.test(m[3]) && /\b(UPDATE|ALL)\b/i.test(m[1])) for (const t of m[2].split(',')) granted.delete(t.trim().replace(/"/g, '').toLowerCase());
      if (/^CREATE\s+TRIGGER\b/i.test(s) && /app\.enforce_mutable_columns/i.test(s) && /\bBEFORE\b[\s\S]*?\bUPDATE\b/i.test(s) && /FOR\s+EACH\s+ROW/i.test(s)) {
        const o = /\bON\s+"?([a-z0-9_]+)"?\s*\.\s*"?([a-z0-9_]+)"?/i.exec(s);
        if (o) guarded.add(`${o[1]}.${o[2]}`.toLowerCase());
      }
    }
  }
  return Object.keys(meta).filter((t) => ['C', 'B'].includes(meta[t].class) && granted.has(t) && !guarded.has(t)).sort();
}
test('FACT: before the migration the static immutability query reports exactly the 44 tables of LD-231', () => {
  assert.deepEqual(remainingTables(false), [...TABLES].sort());
});
test('AC-0B-4.1 (static): with the migration, the immutability query reports no table except the CR-skipped ones', () => {
  assert.ok(migSql, 'migration must exist');
  assert.deepEqual(remainingTables(true), [...skipped].sort());
});

// ------------------------------------------------------------------------------------------------ 6. scanner self-tests (the proof above is only as good as the scanner)
test('scanner: static SET, tuple SET, alias, placeholders, comments, upsert', () => {
  const a = scanUpdates("UPDATE lab.orders SET status = 'x', version = version + 1, updated_at = now() WHERE id = $1", 'f.ts', 'ts');
  assert.deepEqual(a[0].cols, ['status', 'version', 'updated_at']);
  const b = scanUpdates('UPDATE lab.orders AS o SET (status, note) = ($1, $2), updated_by = $3 FROM x WHERE o.id = x.id', 'f.ts', 'ts');
  assert.deepEqual(b[0].cols, ['status', 'note', 'updated_by']);
  const c = scanUpdates('const q = `UPDATE lab.results SET ${keys.map((c, n) => `${c} = $${n + 4}`).join(\', \')}${stamp}, version = version + 1 WHERE id = $1`;', 'f.ts', 'ts');
  assert.deepEqual(c[0].cols, ['version']);
  assert.equal(c[0].dynamic.length, 2);
  const d = scanUpdates("// UPDATE lab.orders SET secret = 1\n  `UPDATE lab.orders SET status = $1`", 'f.ts', 'ts');
  assert.equal(d.length, 1);
  const e = scanUpdates("INSERT INTO micro.isolates (a, b) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET b = EXCLUDED.b, updated_at = now() WHERE x = 1;", 'f.sql', 'sql');
  assert.deepEqual(e[0].cols, ['b', 'updated_at']); assert.equal(e[0].kind, 'upsert');
  assert.equal(scanUpdates('UPDATE core.tenants SET a = 1', 'f.sql', 'sql').length, 0, 'other schemas ignored');
  assert.equal(scanUpdates('INSERT INTO lab.orders (a) VALUES (1) ON CONFLICT DO NOTHING', 'f.sql', 'sql').length, 0);
  assert.deepEqual(resolveIdentifier("const stamp = a.value ? `, resulted_at = now(), first_resulted_at = COALESCE(first_resulted_at, now())` : '';\nfoo", 'stamp'), ['resulted_at', 'first_resulted_at']);
});
test('scanner: the real tree is covered (sources found, update sites of the 44 tables found in api, worker-or-db)', () => {
  const all = allSources();
  assert.ok(all.some((f) => f.replace(/\\/g, '/').includes('services/api/src/modules/lab/')), 'lab sources scanned');
  assert.ok(all.some((f) => f.replace(/\\/g, '/').includes('db/migrations/')), 'migrations scanned');
  const tabs = new Set(scan().map((u) => u.table));
  for (const t of ['lab.results', 'micro.isolates']) assert.ok(tabs.has(t), `scanner finds UPDATEs of ${t}`);
});
