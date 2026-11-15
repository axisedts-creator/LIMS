// T0B-13.C13 static checks of the Wave-2 partners DDL translation: db/migrations/*_partners__*.sql, db/policies/partners.sql, db/meta/tables.yaml, db/meta/definer-inventory.yaml, db/tests/rls_exempt.txt.
// Spec: C13 05-SCHEMA §1 (inventory, class, mandatory-column exceptions), §2 (RLS predicates PT/ST/SC/SY), §3 (columns, PHI), §4 (indexes), §5 (grants), §6 (audit, retention), §7 (coded sets), §8 (DDL, the 4 policy shapes,
// owner policies, DEFINER tests), §9 (no published view); C0 05-SCHEMA §9 rule 1 (tenant FK + UNIQUE (tenant_id, id)), §4.5 (helpers stage: app.current_partner_id is created there, C13 uses CREATE OR REPLACE);
// 08 A10.5 / A12.2 / A19 P-41 (owner policies, maintenance GUC), A16.1 (::uuid[] cast), A17 P-16 / P-18, A19 D-103 (partner guards), A31.1 (tenant-leading trigram index); LD-202 (translate exactly, a gap = blocking CR).
// AC-0B-2.1..2.4, 3.1..3.7 (probes + pgTAP), 4.1..4.3, 5.1..5.3, 6.1..6.3 (static part). AC-0B-6.4 is billing-only (T0B-11) and does not apply to partners.
// Run: node --test tests/db/T0B-13.C13.partners.test.mjs   (live: db/tests/partners/T0B-13.C13_*.test.sql via pg_prove; generated probes: db/tests/isolation/partners.*.test.sql)
// Method (as T0B-10.C2..C8, T0B-13.C9..C12): the expected DDL is PARSED FROM C13 05-SCHEMA at test time and compared (whitespace/case-normalised) with the migrations. §8 holds literal SQL for tables, indexes, 10 functions,
// 14 triggers, 7 owner policies and ~20 policies; the other policies are 4 SHAPES (A-D, §8 table) over the §2 predicates, expanded here and required as LITERAL statements. Behaviour of the guards is in the pgTAP suite.
// T0B13C13_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B13C13_ROOT ? resolve(process.env.T0B13C13_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').replace(/\bcreate or replace function\b/gi, 'create function').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const pFiles = () => files().filter((f) => /^\d{14}_partners__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const pSql = () => pFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'partners.sql') ? strip(readFileSync(polDir + 'partners.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C12)
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

// ---------------------------------------------------------------- spec extraction (C13 05-SCHEMA)
const specPath = repo + 'spec/chunks/C13-b2b-partner-portal/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = b0 ? s.indexOf(b0, a + a0.length) : s.length; assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const S1 = '## 1. Table inventory', S2 = '## 2. RLS predicates', S3 = '## 3. Column specifications', S4 = '## 4. Indexes', S5 = '## 5. Immutability', S6 = '## 6. Data classification', S7 = '## 7. Coded sets', S8 = '## 8. DDL', S9 = '## 9. Foreign views';
const specDdl = () => strip(sqlBlocks(between(specRaw(), S8, S9)));
const specDdlRaw = () => sqlBlocks(between(specRaw(), S8, S9));
const spec1 = () => between(specRaw(), S1, S2);
const spec2 = () => between(specRaw(), S2, S3);
const spec3 = () => between(specRaw(), S3, S4);
const spec5 = () => between(specRaw(), S5, S6);
const spec6 = () => between(specRaw(), S6, S7);
const spec7 = () => between(specRaw(), S7, S8);
const spec8 = () => between(specRaw(), S8, S9);
const spec9 = () => between(specRaw(), S9, '## 10.');

// ---- tables: the §8 DDL is the truth (18 CREATE TABLE = 1 G + 17 tenant; event_inbox is C0's); classes from §1 (hard-coded, sanity-checked against the spec rows)
const G_N = ['g_cs_reasons'];
const CLS = {
  settings: 'M', partners: 'M', partner_users: 'M', partner_referrers: 'M', manifest_counters: 'E', manifests: 'C', manifest_lines: 'C', pickup_requests: 'C', pickup_request_manifests: 'C',
  order_tracking: 'E', tracked_specimens: 'E', order_reports: 'E', price_list_items: 'E', price_list_syncs: 'E', statement_months: 'E', download_counters: 'E', access_slips: 'C',
};
const T_N = Object.keys(CLS);
const G_T = G_N.map((t) => `partners.${t}`), TENANT = T_N.map((t) => `partners.${t}`), ALLT = [...G_T, ...TENANT];
const isG = (q) => /\.g_/.test(q);
const NO_ID = ['settings', 'manifest_counters', 'pickup_request_manifests', 'order_tracking', 'tracked_specimens', 'order_reports', 'price_list_items', 'price_list_syncs', 'statement_months', 'download_counters'];
const DEL_T = ['manifest_lines', 'price_list_items', 'download_counters'];                // §5: the only tables with a lims_app DELETE grant (+ policy)
const CENTRE_T = ['manifests', 'manifest_lines', 'pickup_requests', 'pickup_request_manifests', 'order_tracking', 'tracked_specimens', 'order_reports'];     // SC (receiving-centre) scope
const AUDIT_REQ = ['partners', 'partner_users', 'partner_referrers', 'manifests', 'manifest_lines', 'pickup_requests', 'settings', 'access_slips'].map((t) => `partners.${t}`);     // §6
const AUDIT_FORBIDDEN = ['order_tracking', 'tracked_specimens', 'order_reports', 'price_list_items', 'price_list_syncs', 'statement_months'].map((t) => `partners.${t}`);          // §6 "Not on projections"
const AUDIT_OPTIONAL = ['partners.manifest_counters', 'partners.pickup_request_manifests', 'partners.download_counters'];    // §6 silent: counter / link row / daily counter
const FN_SPEC = ['app.current_partner_id', 'partners.guard_manifest_update', 'partners.guard_line_update', 'partners.check_line_parent', 'partners.redact_lines', 'partners.guard_report_seen', 'partners.guard_access_slip_update',
  'partners.guard_partner_transitions', 'partners.guard_partner_columns', 'partners.guard_partner_users'];
const DEFINERS = ['app.current_partner_id', 'partners.redact_lines'];
const STAFF = /\(select app\.is_staff_or_system\(\)\)/;

// ---- expected policies: explicit §8 statements + the four shapes (§8 table) over the §2 predicates
const pred = (n) => { const l = spec2().split('\n').find((x) => x.startsWith(`| **${n}**`)); assert.ok(l, `§2 row ${n}`); return /`([^`]+)`/.exec(l)[1]; };
function pol(name, tbl, cmd, using, check, role = 'lims_app') {
  return `CREATE POLICY ${name} ON partners.${tbl} FOR ${cmd} TO ${role} ${using ? `USING (${using}) ` : ''}${check ? `WITH CHECK (${check})` : ''}`;
}
function shape(kind, t) {
  const PT = pred('PT'), ST = pred('ST'), SC = pred('SC'), SY = pred('SY'), P = [];
  if (kind === 'A' || kind === 'B') {
    const [sc, S] = kind === 'A' ? ['staff', ST] : ['staff_centre', SC];
    P.push(pol(`${t}__select__${sc}`, t, 'SELECT', S), pol(`${t}__insert__${sc}`, t, 'INSERT', '', S), pol(`${t}__update__${sc}`, t, 'UPDATE', S, S),
      pol(`${t}__select__partner`, t, 'SELECT', PT), pol(`${t}__insert__partner`, t, 'INSERT', '', PT), pol(`${t}__update__partner`, t, 'UPDATE', PT, PT));
  } else {
    P.push(pol(`${t}__select__${kind === 'C' ? 'staff_centre' : 'staff'}`, t, 'SELECT', kind === 'C' ? SC : ST), pol(`${t}__select__partner`, t, 'SELECT', PT),
      pol(`${t}__insert__system`, t, 'INSERT', '', SY), pol(`${t}__update__system`, t, 'UPDATE', SY, SY));
  }
  return P;
}
const SHAPE_OF = { partner_users: 'A', partner_referrers: 'A', manifest_counters: 'A', manifests: 'B', manifest_lines: 'B', pickup_requests: 'B', pickup_request_manifests: 'B', order_tracking: 'C', tracked_specimens: 'C', order_reports: 'C',
  price_list_items: 'D', price_list_syncs: 'D', statement_months: 'D' };
function expectedPolicies() {
  const PT = pred('PT'), ST = pred('ST'), SY = pred('SY');
  const explicit = policies(specDdl());
  const gen = [];
  for (const [t, k] of Object.entries(SHAPE_OF)) gen.push(...shape(k, t));
  gen.push(pol('order_reports__update__partner', 'order_reports', 'UPDATE', PT, PT), pol('price_list_items__delete__system', 'price_list_items', 'DELETE', SY));
  const own = `${PT} AND partner_user_id = (SELECT pu.id FROM partners.partner_users pu WHERE pu.tenant_id = (SELECT app.current_tenant_id()) AND pu.membership_id = nullif((SELECT app.current_claims()) ->> 'membership_id','')::uuid)`;
  gen.push(pol('download_counters__select__staff', 'download_counters', 'SELECT', ST), pol('download_counters__select__partner', 'download_counters', 'SELECT', own),
    pol('download_counters__insert__partner', 'download_counters', 'INSERT', '', own), pol('download_counters__update__partner', 'download_counters', 'UPDATE', own, own));
  const out = new Map(explicit.map((p) => [p.key, p]));
  for (const p of policies(gen.join(';\n'))) if (!out.has(p.key)) out.set(p.key, p);
  return [...out.values()];
}
const EXPECTED_POLICY_COUNT = 93;     // 27 explicit in §8 + 66 from shapes A-D and the §8 table "Extra" column
const OWNER_NAMES = ['partner_users__select__owner_only', 'partners__select__owner_only', 'manifest_lines__select__owner_only', 'manifest_lines__update__owner_only', 'order_reports__select__owner_only', 'order_reports__update__owner_only', 'order_tracking__select__owner_only'];

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 18 CREATE TABLE in §8 (1 G + 17 tenant; no event_inbox), no LIKE, 10 functions (2 DEFINER), 14 triggers, 93 expected policies (27 explicit + shapes A-D), 7 owner policies, §2 predicates parse, no view (§9), 29 coded-set rows', () => {
  const ddl = specDdl();
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 18, '18 CREATE TABLE in §8');
  assert.equal(G_N.length, 1); assert.equal(T_N.length, 17); assert.equal(ALLT.length, 18);
  assert.deepEqual([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].map((m) => m[1]).sort(), [...ALLT].sort(), '§1 partners (19 rows minus event_inbox) = §8 tables');
  for (const q of ALLT) { const t = createTable(ddl, q); assert.ok(t, `spec has ${q}`); assert.equal(t.like, null, `${q}: no LIKE in the spec`); }
  assert.doesNotMatch(ddl, /CREATE\s+TABLE\s+partners\.event_inbox/i);
  assert.deepEqual(fnNames(ddl).sort(), [...FN_SPEC].sort(), 'the 10 functions of §8');
  assert.deepEqual([...ddl.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)[^$]*?SECURITY\s+DEFINER/gi)].map((m) => m[1]).sort(), [...DEFINERS].sort(), 'exactly two DEFINERs (§8 DEFINER tests 1, 2)');
  assert.equal(createTriggers(ddl).length, 14, '14 triggers in §8');
  assert.equal(policies(ddl).filter((p) => /__owner_only$/.test(p.name)).map((p) => p.name).sort().join(), [...OWNER_NAMES].sort().join());
  assert.equal(policies(ddl).length, 27, '27 explicit policies in §8');
  const ps = expectedPolicies();
  assert.equal(new Set(ps.map((p) => p.key)).size, ps.length); assert.equal(ps.length, EXPECTED_POLICY_COUNT, `expected policies: ${ps.length}`);
  const sc = pred('SC'); assert.match(sc, /::uuid\[\]/, '§2 SC carries the A16.1 cast'); assert.match(pred('PT'), /current_partner_id/); assert.match(pred('SY'), /= 'system'/); assert.match(pred('ST'), /IN \('user','system'\)/);
  for (const p of policies(ddl).filter((x) => x.table === 'partners.manifests')) { const g = ps.find((x) => x.key === p.key); assert.ok(g, p.key); assert.equal(g.using, p.using); assert.equal(g.check, p.check); }
  for (const p of shape('B', 'manifests')) { const q = policies(p)[0], e = policies(ddl).find((x) => x.key === q.key); assert.ok(e, `shape B template = the written-out manifests policy ${q.key}`); assert.equal(q.using, e.using); assert.equal(q.check, e.check); }
  const arr = /FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([^\]]+)\]/i.exec(ddl)[1].split(',').map((x) => x.trim().replace(/'/g, '')).sort();
  assert.deepEqual(arr, [...T_N].sort(), '§8 RLS DO block lists the 17 tenant tables');
  assert.match(spec9(), /C13 publishes \*\*no\*\* `v_pub_\*` view/, '§9: no published view'); assert.doesNotMatch(ddl, /CREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW/i);
  assert.equal(coded().length, 29, '§7 coded-set rows');
  for (const t of NO_ID) assert.ok(!createTable(ddl, `partners.${t}`).colMap.has('id'), `${t}: natural key, no id (§1 exceptions)`);
  for (const t of T_N.filter((x) => !NO_ID.includes(x))) assert.ok(createTable(ddl, `partners.${t}`).colMap.has('id'), `${t} has id`);
  for (const t of T_N) assert.equal(CLS[t], /^\|\s*`partners\.([a-z_]+)`\s*\|\s*([A-Z])/m.test('') ? '' : CLS[t]);
  for (const [t, c] of Object.entries(CLS)) assert.match(spec1(), new RegExp(`\\|\\s*\`partners\\.${t}\`\\s*\\|\\s*${c}\\b`), `§1 class of ${t} = ${c}`);
  const refs = new Set([...ddl.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()).filter((x) => !x.startsWith('partners.')));
  assert.deepEqual([...refs].sort(), ['catalog.credit_parties', 'catalog.doctors', 'core.branches', 'core.collection_centres', 'core.memberships', 'core.tenants', 'frontdesk.orders'], 'cross-schema FK targets of §8');
  assert.match(spec1(), /Mandatory-column exceptions/); assert.equal(omits().size, 10, '§1 exception rows cover the 10 id-less tables'); assert.deepEqual([...omits().keys()].sort(), [...NO_ID].sort());
});

// ================================================================ files, order, owner (AC-0B-6.1 / 6.3)
const WAVE2 = /_(quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection|migration_staging)__/;
test('migration files: >= 1 *_partners__*.sql, timestamps strictly after 20261114120000 (LD-202), after every wave-1 migration and after the quality, micro, anatomic and inventory migrations (DAG: ... inventory -> partners, db/meta/dag.yaml), unique; db/policies/partners.sql exists; schema creation IF NOT EXISTS', () => {
  assert.ok(pFiles().length >= 1, 'no db/migrations/*_partners__*.sql yet (T0B-13.C13 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => !WAVE2.test(f)), before = all.filter((f) => /_(quality|micro|anatomic|inventory)__/.test(f));
  assert.ok(earlier.length >= 24, 'wave-1 migrations present'); assert.ok(before.length >= 4, 'quality + micro + anatomic + inventory migrations present');
  for (const f of pFiles()) {
    assert.ok(f.slice(0, 14) > '20261114120000', `${f} must be later than 20261114120000`);
    for (const e of [...earlier, ...before]) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (partners follows inventory in the DAG)`);
  }
  assert.ok(existsSync(polDir + 'partners.sql'), 'db/policies/partners.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(pSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)partners\b/i, 'schema partners exists since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every partners migration is SET LOCAL ROLE lims_owner and it is the only role switch (all objects incl. the 10 functions owned by lims_owner); no standing CREATE grant, no role DDL, no CREATE EXTENSION', () => {
  assert.ok(pFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+|SET\s+SESSION\s+AUTHORIZATION)/gi)].map((m) => ws(m[1]).toUpperCase());
  for (const f of pFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch`);
  }
  assert.doesNotMatch(pSql(), /GRANT\s+CREATE\s+ON\s+(SCHEMA\s+app|DATABASE)/i); assert.doesNotMatch(pSql(), /CREATE\s+ROLE|ALTER\s+ROLE/i); assert.doesNotMatch(pSql(), /CREATE\s+EXTENSION/i);
});

// ================================================================ tables (columns + constraints = spec exactly; C0 may add only <t>__tenant__fk and UNIQUE (tenant_id, id), C0 05-SCHEMA §9 rule 1)
for (const q of ALLT) {
  test(`${q}: every spec column + constraint (name + text) present identically in the migration; no extra column; only <t>__tenant__fk and UNIQUE (tenant_id, id) may be added; not created with LIKE (05-SCHEMA §8; C0 §9 rule 1)`, () => {
    const exp = createTable(specDdl(), q); assert.ok(exp, `spec table ${q}`);
    const sql = pSql(), got = createTable(sql, q), t = q.split('.')[1];
    assert.ok(got, `CREATE TABLE ${q} not found in *_partners__*.sql`);
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
    if (!isG(q) && got.colMap.has('id')) assert.ok([...got.conMap.values()].some((d) => /unique\(tenant_id,id\)$/.test(d)), `${q}: UNIQUE (tenant_id, id) (04 D8)`);
  });
}
test('exactly the 18 §8 tables are created in partners (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9); table count == spec count; every constraint is named <table>__*; the state / status / mode CHECK value lists of §3 are present', () => {
  const sql = pSql(), bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.equal(made.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'migration CREATE TABLE count == spec CREATE TABLE count (impl note states both)');
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(bare, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /event_inbox/i, 'C13 migrations do not touch event_inbox (T0B-05 owns it)');
  for (const q of TENANT) for (const c of ['id', 'tenant_id']) { const def = createTable(sql, q)?.colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`); }
  for (const q of ALLT) { const t = q.split('.')[1]; for (const c of createTable(sql, q).conMap.keys()) assert.ok(c.startsWith(t + '__'), `${q}: constraint ${c} must be prefixed ${t}__`); }
  const sql2 = norm(sql);
  for (const v of ['draft,submitted,partially_received,received,withdrawn,discarded', 'draft,submitted,converting,converted,conversion_failed,not_received,withdrawn,discarded,cancelled', 'requested,scheduled,picked_up,cancelled,rejected', 'registered,in_transit,in_lab,action_needed,partially_reported,reported,cancelled',
    'requested,issued,failed,expired', 'invited,active,deactivated', 'partner_admin,partner_member', 'unmapped,mapped,rejected', 'on_receipt,on_submit', 'valid,superseded', 'routine,urgent', 'male,female,other,unknown', 'test,panel', 'partner,standard', 'active,suspended',
    'ordered,collected,in_transit,received,aliquoted,in_process,resulted,verified,approved,reported,rejected,recollection_ordered,stored,discarded', 'pre_registered,registered,cancelled', 'user,partner'])
    assert.ok(sql2.includes(v.split(',').map((x) => `'${x}'`).join(',')), `§8 value list ${v}`);
});
test('cross-schema references (01-CM §5 R3): partners -> partners / core / catalog / frontdesk only, identical target set to the spec; NO FK into billing, reporting, lab, identity, inventory ... (CV §5.4); nothing in an upstream schema references partners (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(pSql()), exp = tgt(specDdl());
  for (const t of exp) got.has(t) || assert.fail(`FK target ${t} missing`);
  for (const t of [...got]) { assert.match(t, /^(partners|core|catalog|frontdesk)\./, `partners FK target ${t}`); exp.has(t) || assert.fail(`FK target ${t} is not in the spec`); }
  const upstream = files().filter((f) => !WAVE2.test(f) || /_(quality|micro|anatomic|inventory)__/.test(f));
  assert.doesNotMatch(upstream.map(read).join('\n'), /\bREFERENCES\s+partners\./i, 'no FK into partners from an upstream schema');
});
test('indexes: every §8 CREATE INDEX present with identical definition, plus exactly ONE name-search index chosen by C0 (pg_trgm IS installed by db/bootstrap/01_database.sql: manifest_lines__patient_name_trgm__idx, tenant-leading per 08 A31.1 / REQ-SEC-023; the btree fallback is not used); no other index; tenant_id leads every index and UNIQUE / PRIMARY KEY (except PRIMARY KEY (id))', () => {
  const sql = pSql(), have = new Map(createIndexes(sql).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  assert.ok(exp.length >= 30, `spec indexes: ${exp.length}`);
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  const extra = [...have.keys()].filter((n) => !exp.some((s) => idxName(s) === n));
  assert.deepEqual(extra, ['manifest_lines__patient_name_trgm__idx'], 'exactly the trigram name-search index beyond the spec DDL (REQ-ARCH-023: pg_trgm is enabled, option (a))');
  assert.match(have.get('manifest_lines__patient_name_trgm__idx'), /^create index manifest_lines__patient_name_trgm__idx on partners\.manifest_lines using gin\(tenant_id,patient_full_name extensions\.gin_trgm_ops\)/, 'tenant-leading trigram GIN, opclass schema-qualified (08 A31.1; spec option (a) with tenant_id leading per CV §5.3 / REQ-SEC-023)');
  assert.match(specRaw(), /-- \(a\) CREATE INDEX manifest_lines__patient_name_trgm__idx/, 'spec still offers option (a)');
  for (const n of ['partner_referrers__tenant_id_partner_id_name_regno__p_uq', 'manifest_lines__tenant_id_manifest_id_ref__p_uq', 'manifest_lines__tenant_id_order_id__p_uq', 'pickup_request_manifests__tenant_id_manifest_id__p_uq', 'access_slips__tenant_id_state_link_expires_at__p_idx', 'manifests__tenant_id_state_updated_at__p_idx', 'manifest_lines__tenant_id_receiving_centre_id__missing__p_idx'])
    assert.match(have.get(n) ?? '', /\bwhere\b/, `${n} is partial`);
  assert.match(have.get('pickup_request_manifests__tenant_id_manifest_id__p_uq'), /^create unique index/, 'one open pickup per manifest'); assert.match(have.get('partner_referrers__tenant_id_partner_id_name_regno__p_uq'), /coalesce\(registration_no,''\)/);
  assert.match(have.get('manifest_lines__tenant_id_receiving_centre_id__missing__p_idx'), /where sample_missing and state='converted'/, '08 A19 D-104');
  assert.match(have.get('price_list_items__tenant_id_partner_id_name__idx'), /lower\(name\)\s*text_pattern_ops/);
  const conNames = new Set(ALLT.flatMap((q) => [...createTable(sql, q).conMap.keys()]));
  for (const n of ['partner_users__tenant_id_membership_id__uq', 'partner_users__tenant_id_id_partner_id__uq', 'partner_referrers__tenant_id_id_partner_id__uq', 'manifests__tenant_id_id_partner_id__uq', 'pickup_requests__tenant_id_id_partner_id__uq', 'order_tracking__tenant_id_order_id_partner_id__uq', 'order_reports__tenant_id_report_id_version_no_partner_id__uq', 'manifest_lines__tenant_id_manifest_id_line_no__uq'])
    assert.ok(conNames.has(n) || have.has(n), `§4 FK-target / hot-path uniqueness ${n} exists (07-SECURITY ST7)`);
  for (const s of createIndexes(sql)) assert.equal(/\bON\s+\w+\.\w+\s*(?:USING\s+\w+\s*)?\(\s*([^,)]+)/i.exec(s)[1].trim(), 'tenant_id', `index ${idxName(s)} leads with tenant_id`);
  for (const q of TENANT) for (const c of [...createTable(sql, q).conMap.values()].filter((x) => /\b(primary key|unique)\(/.test(x))) {
    const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1]; if (/primary key/.test(c) && k === 'id') continue;
    assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${c}`);
  }
  assert.doesNotMatch(sql, /manifest_lines__tenant_id_partner_id_name__idx/, 'btree fallback (b) must not be created in addition');
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A16.1, A17 P-16, A19 D-103, A10.5)
test('ENABLE + FORCE ROW LEVEL SECURITY as literal statements (no DO block / format(): check-migrations.ts and the policy tools read statements) on the 17 tenant tables; none on the G table; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = pSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of G_T) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(pSql(), /\bDO\s+\$/i, 'literal statements only (spec DO block expanded by C0)'); assert.doesNotMatch(polSql(), /\bDO\s+\$/i);
  assert.doesNotMatch(pSql() + polSql(), /EXECUTE\s+format\s*\(/i);
});
const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('partners.') && !/\.event_inbox$/.test(p.table));
test('policies: db/policies/partners.sql holds EXACTLY the expected 93 policies (27 written out in §8 + shapes A-D + extras of the §8 table): name, command, role, USING, WITH CHECK, exact text modulo whitespace; no policy on the G table; only event_inbox may be extra; no dynamic SQL', () => {
  const exp = expectedPolicies(), got = gotPolicies();
  assert.ok(got.length > 0, 'db/policies/partners.sql has no CREATE POLICY');
  const byKey = new Map(got.map((p) => [p.key, p])); assert.equal(byKey.size, got.length, 'no duplicate policy');
  for (const e of exp) {
    const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(g.using, e.using, `${e.key} USING`); assert.equal(g.check, e.check, `${e.key} WITH CHECK`);
  }
  assert.deepEqual([...byKey.keys()].sort(), exp.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access)');
  for (const p of policies(polSql()).filter((x) => /\.event_inbox$/.test(x.table))) assert.match(p.name, /^event_inbox__(select|insert|delete)__(tenant|owner_only)$/, `${p.key}: only the C0 inbox shapes may appear`);
});
test('policy shape: names <table>__<cmd>__(staff|staff_centre|partner|system|tenant|owner_only); lims_app except owner_only (TO lims_owner); every USING / WITH CHECK has the tenant predicate; staff = actor_type IN (user, system), staff_centre adds the ::uuid[] centre predicate on exactly the 7 SC tables; partner = actor_type partner + current_partner_id; system = actor_type system; exactly 3 DELETE policies (manifest_lines partner draft-only, price_list_items system, download_counters system + expired); the only __tenant policy carries the staff guard; no true / PUBLIC / anon; commands without policy stay denied (access_slips: no partner UPDATE, no DELETE)', () => {
  const ps = gotPolicies(); assert.equal(ps.length, EXPECTED_POLICY_COUNT, `policies: ${ps.length}`);
  for (const p of ps) {
    const tbl = p.table.split('.')[1], m = new RegExp(`^${tbl}__${p.cmd.toLowerCase()}__(staff|staff_centre|partner|system|tenant|owner_only)$`).exec(p.name);
    assert.ok(m, `${p.key}: name <table>__<cmd>__<scope>`); const sc = m[1], t = p.using + ' ' + p.check;
    assert.equal(p.roles, sc === 'owner_only' ? 'lims_owner' : 'lims_app', `${p.key} roles`);
    assert.match(t, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: tenant predicate`);
    assert.doesNotMatch(t, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|\bcurrent_setting\('app\.pre_/, p.key);
    assert.ok(!isG(p.table), `${p.key}: the G table carries no policy`);
    if (sc === 'staff' || sc === 'staff_centre') assert.match(t, /\(select app\.current_actor_type\(\)\)in\('user','system'\)/, `${p.key}: positive list (user, system), stricter than is_staff_or_system (§1)`);
    if (sc === 'staff_centre') { assert.match(t, /\(select app\.has_all_centres\(\)\)or receiving_centre_id=any\(\(select app\.current_centre_ids\(\)\)::uuid\[\]\)/, `${p.key}: A16.1 cast`); assert.ok(CENTRE_T.includes(tbl), `${p.key}: SC only on the receiving-centre tables`); }
    else assert.doesNotMatch(t, /current_centre_ids|has_all_centres/, `${p.key}: no centre predicate outside staff_centre`);
    if (sc === 'partner') assert.match(t, /\(select app\.current_actor_type\(\)\)='partner'/, `${p.key}: partner actor`);
    if (sc === 'partner') assert.match(t, /app\.current_partner_id\(\)/, `${p.key}: partner scope helper`);
    if (sc === 'system') assert.match(t, /\(select app\.current_actor_type\(\)\)='system'/, `${p.key}: system actor`);
    if (sc === 'owner_only') assert.ok(OWNER_NAMES.includes(p.name), `${p.key}: one of the 7 owner policies of §8`);
    if (sc === 'tenant') { assert.equal(p.name, 'download_counters__delete__tenant'); assert.match(t, STAFF, 'P-16 / gate 9: staff guard'); }
  }
  for (const t of CENTRE_T) assert.ok(ps.some((p) => p.table === `partners.${t}` && p.name.endsWith('__staff_centre')), `${t}: centre-scoped staff policy`);
  for (const t of T_N.filter((x) => !CENTRE_T.includes(x))) assert.ok(!ps.some((p) => p.table === `partners.${t}` && p.name.endsWith('__staff_centre')), `${t}: not centre-scoped`);
  const del = ps.filter((p) => p.cmd === 'DELETE').map((p) => p.key).sort();
  assert.deepEqual(del, ['download_counters__delete__tenant@partners.download_counters', 'manifest_lines__delete__partner@partners.manifest_lines', 'price_list_items__delete__system@partners.price_list_items'], 'the only DELETE policies (§5)');
  const dc = ps.find((p) => p.name === 'download_counters__delete__tenant'); assert.match(dc.using, /\(select app\.current_actor_type\(\)\)='system'/); assert.match(dc.using, /expires_at < now\(\)/, 'P-18(c): expired rows only');
  const ml = ps.find((p) => p.name === 'manifest_lines__delete__partner'); assert.match(ml.using, /state='draft'/, 'partner deletes draft lines only'); assert.match(ml.using, /partner_id=\(select app\.current_partner_id\(\)\)/);
  for (const p of ps.filter((x) => x.table === 'partners.access_slips')) assert.ok(!(p.cmd === 'UPDATE' && p.name.endsWith('__partner')), 'access_slips: no partner UPDATE');
  assert.match(ps.find((p) => p.name === 'access_slips__insert__partner').check, /state='requested'/, 'partner may only insert state requested');
  for (const t of ['order_tracking', 'tracked_specimens', 'price_list_items', 'price_list_syncs', 'statement_months'])
    for (const p of ps.filter((x) => x.table === `partners.${t}` && /^(INSERT|UPDATE|DELETE)$/.test(x.cmd))) assert.match(p.name, /__system$/, `${p.key}: projections are written by the system actor only`);
  for (const p of ps.filter((x) => x.table === 'partners.order_reports' && x.cmd !== 'SELECT' && !x.name.endsWith('__owner_only'))) assert.match(p.name, /__(system|partner)$/, p.key);
  for (const p of ps.filter((x) => x.name.endsWith('__owner_only'))) { assert.match(p.using + p.check, /current_setting\('app\.maintenance',true\)='partners_redact_lines'|membership_id=nullif\(app\.current_claims\(\)->>\s*'membership_id',''\)::uuid|^tenant_id=\(select app\.current_tenant_id\(\)\)$/, `${p.key}: gating`); }
  for (const n of ['manifest_lines__select__owner_only', 'manifest_lines__update__owner_only', 'order_reports__select__owner_only', 'order_reports__update__owner_only', 'order_tracking__select__owner_only'])
    assert.match((ps.find((p) => p.name === n).using + ps.find((p) => p.name === n).check), /current_setting\('app\.maintenance',true\)='partners_redact_lines'/, `${n}: maintenance GUC (A12.2 / P-41)`);
});
test('policies written literally in migrations are identical to db/policies/partners.sql (AC-0B-2.3 copy)', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(pSql()).filter((x) => x.table.startsWith('partners.') && !/\.event_inbox$/.test(x.table));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort(), 'every policy of the file is created by a migration and vice versa');
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §5 table + §8 GRANT statements parsed from the spec)
test('grants equal §8: lims_app SELECT+INSERT+UPDATE on 14 tables, SELECT+INSERT+UPDATE+DELETE on manifest_lines / price_list_items / download_counters only, SELECT on g_cs_reasons; EXECUTE app.current_partner_id() to lims_app and partners.redact_lines to lims_worker (REVOKE ALL FROM PUBLIC, OWNER lims_owner); no TRUNCATE / REFERENCES / TRIGGER; nothing to other roles; no view', () => {
  const sql = pSql() + '\n;\n' + polSql(), g = grantsOf(sql), exp = grantsOf(specDdl());
  const privs = (m, q, r) => [...(m.get(q)?.get(r)?.all ?? [])].sort();
  for (const t of T_N) assert.deepEqual(privs(g, `partners.${t}`, 'lims_app'), DEL_T.includes(t) ? ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] : ['INSERT', 'SELECT', 'UPDATE'], `partners.${t} lims_app`);
  assert.deepEqual(privs(g, 'partners.g_cs_reasons', 'lims_app'), ['SELECT']);
  for (const [q, rm] of exp) if (/^partners\./.test(q)) for (const r of rm.keys()) assert.deepEqual(privs(g, q, r), privs(exp, q, r), `${q} ${r}: grants = spec §8`);
  assert.deepEqual([...g.entries()].filter(([t, rm]) => /^partners\./.test(t) && [...rm.values()].some((p) => p.all.has('DELETE'))).map(([t]) => t).sort(), DEL_T.map((t) => `partners.${t}`).sort(), '§5 CI assertion: DELETE only on the 3 tables');
  for (const [t, rm] of g) if (/^partners\./.test(t)) {
    assert.ok(new Set(ALLT).has(t), `${t}: unexpected grant target`);
    for (const [r, p] of rm) {
      assert.equal(r, 'lims_app', `${t}: unexpected grantee ${r}`);
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!p.all.has(bad) && !p.cols.has(bad), `${t}: ${r} must not hold ${bad}`);
      assert.equal(p.cols.size, 0, `${t}: whole-table grants only`);
    }
  }
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\bpartners\./i); assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+partners\b/i); assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bpartners\b/i);
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\bpartners\./i.test(s) && !/FUNCTION/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner|lims_analytics)\b/i, s);
  assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+app\.current_partner_id\s*\(\s*\)\s+TO\s+lims_app\b/i);
  assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+partners\.redact_lines\s*\(\s*uuid\s*,\s*timestamptz\s*\)\s+TO\s+lims_worker\b/i);
  assert.doesNotMatch(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+partners\.redact_lines[^;]*\b(lims_app|lims_api|PUBLIC)\b/i, 'redact_lines: lims_worker only (task partners.redact_expired_lines)');
  for (const f of ['app.current_partner_id\\s*\\(\\s*\\)', 'partners.redact_lines\\s*\\(\\s*uuid\\s*,\\s*timestamptz\\s*\\)']) {
    assert.match(sql, new RegExp(`ALTER\\s+FUNCTION\\s+${f}\\s+OWNER\\s+TO\\s+lims_owner`, 'i'), `${f}: OWNER lims_owner`);
    assert.match(sql, new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${f}\\s+FROM\\s+PUBLIC`, 'i'), `${f}: REVOKE ALL FROM PUBLIC`);
  }
  for (const t of ['manifests', 'manifest_counters', 'order_tracking', 'access_slips', 'settings', 'partners']) assert.ok(!privs(g, `partners.${t}`, 'lims_app').includes('DELETE'), `partners.${t}: no DELETE (CV §5.6)`);
  assert.doesNotMatch(strip(pSql()), /\bCREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\b/i, '§9: C13 publishes no view');
});

// ================================================================ functions + triggers (AC-0B-4.1; §8, D-103)
test('the 10 §8 functions equal the spec text (app.current_partner_id via CREATE OR REPLACE with the helpers-stage text, partners.redact_lines, 7 INVOKER trigger functions with search_path = \'\'); exactly 2 SECURITY DEFINER (current_partner_id, redact_lines), both search_path = \'\'; no other function', () => {
  const sql = pSql(), exp = specDdl();
  for (const f of FN_SPEC) {
    const got = fnText(sql, f); assert.ok(got, `${f} missing (05-SCHEMA §8)`);
    assert.equal(norm(got), norm(fnText(exp, f)), `${f}: text equals the spec`);
    assert.match(got, /SET\s+search_path\s*=\s*''/i, `${f}: search_path = ''`);
    assert.equal(/SECURITY\s+DEFINER/i.test(got), DEFINERS.includes(f), `${f}: SECURITY DEFINER = ${DEFINERS.includes(f)}`);
  }
  assert.match(fnText(sql, 'app.current_partner_id'), /^CREATE\s+OR\s+REPLACE\s+FUNCTION/i, 'helpers stage created it (C0 §4.5): C13 uses CREATE OR REPLACE with the same text');
  assert.deepEqual(fnNames(sql).sort(), [...FN_SPEC].sort(), 'no function beyond the spec');
  assert.equal([...sql.matchAll(/SECURITY\s+DEFINER/gi)].length, 2, 'two DEFINER functions only');
  const red = fnText(sql, 'partners.redact_lines'); assert.match(red, /app\.current_tenant_id\(\)/); assert.match(red, /set_config\('app\.maintenance',\s*'partners_redact_lines',\s*true\)/); assert.match(red, /set_config\('app\.maintenance',\s*'',\s*true\)/, '§8 test 2(c): GUC reset');
  assert.match(red, /42501/); assert.match(red, /redaction_scope/);
});
test('triggers: the 14 §8 triggers equal the spec statements (manifests / manifest_lines / pickup_requests transitions + columns, partner_users / partner_referrers columns, partner_users guard BEFORE INSERT OR UPDATE, line parent BEFORE INSERT, report seen, access slip guard); nothing else besides the audit triggers; none disabled or dropped', () => {
  const sql = pSql(), all = createTriggers(sql), trg = all.filter((s) => !isAudit(s));
  const exp = createTriggers(specDdl());
  assert.equal(exp.length, 14);
  for (const s of exp) { const hit = trg.find((x) => trgName(x) === trgName(s)); assert.ok(hit, `trigger ${trgName(s)} missing`); assert.equal(norm(hit), norm(s), `trigger ${trgName(s)}`); }
  assert.deepEqual(trg.map(trgName).sort(), exp.map(trgName).sort(), 'no trigger beyond the spec (audit aside)');
  assert.doesNotMatch(sql, /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(sql, /DROP\s+TRIGGER\b/i);
  for (const [t, fn] of [['manifests', 'guard_partner_columns'], ['manifest_lines', 'guard_partner_columns'], ['pickup_requests', 'guard_partner_columns'], ['partner_users', 'guard_partner_columns'], ['partner_referrers', 'guard_partner_columns'], ['manifests', 'guard_partner_transitions'], ['manifest_lines', 'guard_partner_transitions'], ['pickup_requests', 'guard_partner_transitions']])
    assert.ok(trg.some((s) => new RegExp(`\\bBEFORE\\s+UPDATE\\s+ON\\s+partners\\.${t}\\b[^;]*partners\\.${fn}\\(`, 'i').test(s)), `D-103: ${t} has ${fn}`);
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x; §6): <t>__audit AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW on the 8 listed tables (partners, partner_users, partner_referrers, manifests, manifest_lines, pickup_requests, settings, access_slips); none on the 6 projections or the G table; counters / link row / daily counter: spec silent', () => {
  const trg = createTriggers(pSql()).filter(isAudit), onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of AUDIT_REQ) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(\\s*\\)$`, 'i'), q);
  }
  for (const q of [...AUDIT_FORBIDDEN, ...G_T]) assert.equal(onTable(q).length, 0, `${q} must NOT be audited (§6: projections are rebuildable)`);
  for (const q of AUDIT_OPTIONAL) assert.ok(onTable(q).length <= 1, q);
  assert.equal(trg.length, AUDIT_REQ.length + AUDIT_OPTIONAL.filter((q) => onTable(q).length).length, 'no audit trigger beyond the listed tables');
});

// ================================================================ DEFINER inventory + owner policies (08 A10.5, A12.2, A19 P-41)
test('db/meta/definer-inventory.yaml: app.current_partner_id stays (owner lims_owner, execute [lims_app]); partners.redact_lines is added (owner lims_owner, execute [lims_worker], why, touches manifest_lines / order_reports / order_tracking, policies = the 5 owner policies + maintenance GUC partners_redact_lines); every policy named in a row exists in db/policies/partners.sql; the two partners DEFINERs are the only DEFINERs of the partners migrations', () => {
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  const cp = inv['app.current_partner_id']; assert.ok(cp, 'app.current_partner_id row');
  assert.equal(cp.owner, 'lims_owner'); assert.deepEqual(cp.execute, ['lims_app']); assert.match(JSON.stringify(cp.touches), /partners\.partner_users/); assert.match(JSON.stringify(cp.touches), /partners\.partners/);
  assert.match(JSON.stringify(cp.policies), /partner_users__select__owner_only/, 'inventory row names the real owner policies (not the placeholder)'); assert.match(JSON.stringify(cp.policies), /\bpartners__select__owner_only/);
  const rl = inv['partners.redact_lines']; assert.ok(rl, 'partners.redact_lines row (§8 inventory hand-off)');
  assert.equal(rl.owner, 'lims_owner'); assert.deepEqual(rl.execute, ['lims_worker']); assert.ok(String(rl.why).length > 10);
  for (const t of ['manifest_lines', 'order_reports', 'order_tracking']) assert.match(JSON.stringify(rl.touches), new RegExp(`partners\\.${t}`), `touches ${t}`);
  for (const n of OWNER_NAMES.filter((x) => !/^(partner_users|partners)__/.test(x))) assert.match(JSON.stringify(rl.policies), new RegExp(n), `policies names ${n}`);
  assert.match(JSON.stringify(rl.policies), /partners_redact_lines/, 'maintenance GUC named');
  const names = new Set(policies(polSql()).map((p) => p.name));
  for (const e of [cp, rl]) for (const n of JSON.stringify(e.policies).match(/\b\w+__(?:select|insert|update|delete)__owner_only\b/g) ?? []) assert.ok(names.has(n), `inventory policy ${n} exists in db/policies/partners.sql`);
  const keys = Object.keys(inv).filter((k) => /^partners\./.test(k)); assert.deepEqual(keys, ['partners.redact_lines'], 'no other partners DEFINER row');
  assert.deepEqual([...pSql().matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)[^$]*?SECURITY\s+DEFINER/gi)].map((m) => m[1]).sort(), [...DEFINERS].sort());
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const MAND = { M: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'is_active'], C: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version'], A: ['id', 'tenant_id', 'created_at', 'created_by'],
  E: ['id', 'tenant_id', 'created_at', 'expires_at'], G: ['id', 'created_at', 'is_active'] };
function omits() {   // §1 "Mandatory-column exceptions" table: Map(table -> sorted omitted columns)
  const m = new Map();
  for (const l of between(spec1(), '**Mandatory-column exceptions', undefined).split('\n').filter((x) => /^\|\s*`/.test(x))) {
    const c = l.split('|'); const tabs = [...c[1].matchAll(/`([a-z_]+)`/g)].map((x) => x[1]), cols = [...c[2].matchAll(/`([a-z_]+)`/g)].map((x) => x[1]).sort();
    for (const t of tabs) m.set(t, cols);
  }
  return m;
}
function phiRows() {   // §3.1-3.5: single-column rows with an unambiguous PHI cell -> Map("table.col" -> P-class)
  const out = new Map(), secs = [['partners', '### 3.1', '### 3.2'], ['partner_users', '### 3.2', '### 3.3'], ['partner_referrers', '### 3.3', '### 3.4'], ['manifests', '### 3.4', '### 3.5'], ['manifest_lines', '### 3.5', '### 3.6']];
  for (const [t, a, b] of secs) for (const l of between(spec3(), a, b).split('\n').filter((x) => x.startsWith('| '))) {
    const c = l.split('|').map((x) => x.trim()); if (c.length < 7) continue;
    const names = c[1].split(',').map((x) => x.trim()); if (names.length !== 1 || !/^[a-z][a-z0-9_]*$/.test(names[0])) continue;
    const m = /^\*{0,2}(P[0-3])\*{0,2}(?:-personal(?:\/business)?)?(?:\s*\([^)]*\))?$/.exec(c[5]); if (m) out.set(`${t}.${names[0]}`, m[1]);
  }
  return out;
}
test('tables.yaml: all 18 partners tables registered (class per §1, centre_scoped = the SC policies, audited = trigger, retention, shared_with [partner] on the 17 tenant tables, columns = the migration columns, phi_class P0..P3); the count equals the CREATE TABLE count; event_inbox entry untouched', () => {
  const y = tablesYaml(), regs = Object.keys(y).filter((k) => /^partners\./.test(k) && !/\.event_inbox$/.test(k));
  assert.equal(regs.length, 18, 'tables.yaml partners entries (ex event_inbox)'); assert.equal(regs.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'tables.yaml count == chunk DDL count');
  const trgAudited = (q) => createTriggers(pSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s)), pols = gotPolicies();
  for (const q of ALLT) {
    const e = y[q], t = q.split('.')[1]; assert.ok(e && createTable(pSql(), q), `${q} in tables.yaml and migrations`);
    assert.equal(e.class, isG(q) ? 'G' : CLS[t], `${q} class (§1)`);
    assert.equal(e.centre_scoped, pols.some((p) => p.table === q && /current_centre_ids/.test(p.using + p.check)), `${q} centre_scoped = has an SC policy`); assert.equal(e.centre_scoped, CENTRE_T.includes(t), `${q} centre_scoped (§2 SC tables)`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`);
    if (AUDIT_REQ.includes(q)) assert.equal(e.audited, true, `${q} audited (§6)`); if (AUDIT_FORBIDDEN.includes(q) || isG(q)) assert.equal(e.audited, false, `${q} not audited (§6)`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), [...createTable(pSql(), q).colNames.map((c) => c.replace(/"/g, ''))].sort(), `${q} columns = migration columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
    assert.deepEqual([...(e.shared_with ?? [])], isG(q) ? [] : ['partner'], `${q}: shared_with (§1: every tenant table except event_inbox is shared_with [partner], A17 P-16 exception)`);
  }
  assert.ok(y['partners.event_inbox'].class === 'A', 'inbox entry remains as C0 wrote it'); assert.deepEqual(y['partners.event_inbox'].shared_with ?? [], [], 'event_inbox is not shared');
});
test('tables.yaml phi_class (§3): every unambiguous single-column §3.1-3.5 cell equals the registry value; patient block P2 (name, sex, birth_on, age_years, phone), clinical_note / orderable_ids / orderables_snapshot / order_reports.panel_names P3; organisation + membership ids P0..P1; created_by / updated_by P0..P1; no column above its spec class', () => {
  const y = tablesYaml(), rows = phiRows(); assert.ok(rows.size >= 50, `parsed §3 phi rows: ${rows.size}`);
  for (const [k, p] of rows) { const [t, c] = k.split('.'); assert.equal(y[`partners.${t}`]?.columns?.[c], p, `${k}: phi_class = §3 (${p})`); }
  for (const c of ['patient_full_name', 'patient_sex', 'patient_birth_on', 'patient_age_years', 'patient_phone_e164']) assert.equal(y['partners.manifest_lines'].columns[c], 'P2', c);
  for (const c of ['clinical_note', 'orderable_ids', 'orderables_snapshot']) assert.equal(y['partners.manifest_lines'].columns[c], 'P3', c);
  assert.equal(y['partners.order_reports'].columns.panel_names, 'P3', '§3.7 / §6: panel names P3');
  assert.ok(['P2', 'P3'].includes(y['partners.manifests'].columns.notes), 'manifests.notes free text to lab: P2 or P3');
  for (const q of ALLT) for (const c of ['created_by', 'updated_by']) if (y[q].columns[c]) assert.ok(['P0', 'P1'].includes(y[q].columns[c]), `${q}.${c}`);
  for (const c of ['partner_id', 'membership_id']) assert.ok(['P0', 'P1'].includes(y['partners.partner_users'].columns[c]));
  assert.match(spec6(), /P2/);
});
test('tables.yaml: rls_exempt only on g_cs_reasons (with a reason); mandatory_column_exceptions = exactly the §1 "Omits" lists (copied, A17 P-18(b)) with a reason; each omitted column is absent from the DDL and every class-mandatory column the DDL lacks is excepted (02-CV §5.2); every other table carries all of them', () => {
  const y = tablesYaml(), om = omits(); assert.equal(om.size, 10, `§1 exception rows: ${[...om.keys()]}`);
  for (const q of ALLT) {
    assert.ok(y[q] && createTable(pSql(), q), `${q} in tables.yaml and in the migrations`);
    const e = y[q], t = q.split('.')[1], cls = isG(q) ? 'G' : CLS[t], cols = new Set(createTable(pSql(), q).colNames);
    if (isG(q)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    const got = [...(e.mandatory_column_exceptions ?? [])].sort(), want = om.get(t) ?? [];
    assert.deepEqual(got, want, `${q}: mandatory_column_exceptions = §1 Omits list`);
    for (const c of want) assert.ok(!cols.has(c), `${q}: omitted column ${c} must really be absent`);
    for (const c of MAND[cls].filter((x) => !cols.has(x))) assert.ok(got.includes(c), `${q}: class-${cls} mandatory column ${c} is missing and not excepted`);
    if (got.length) assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 5, `${q}: mandatory_column_exceptions_reason`);
    assert.equal(isG(q), !cols.has('tenant_id'));
  }
  for (const t of ['settings', 'manifest_counters', 'order_tracking', 'download_counters', 'price_list_items']) assert.ok(NO_ID.includes(t));
  for (const t of T_N.filter((x) => !om.has(x))) assert.deepEqual(y[`partners.${t}`].mandatory_column_exceptions ?? [], [], `partners.${t}: no exception`);
});
test('tables.yaml retention (§6): partner / manifest / line / projection data kept (floor retentionYears; lines redacted by partners.redact_lines after retentionYears, 5 default); download_counters 30 days via expires_at (P-18(c)); access_slips life of the line; G table seed / permanent; event_inbox 90 days', () => {
  const y = tablesYaml(), r = (q) => { const e = y[`partners.${q}`]; assert.ok(e, `partners.${q} in tables.yaml`); return e.retention; };
  for (const q of T_N.filter((t) => !['download_counters', 'access_slips', 'manifest_lines'].includes(t))) assert.match(r(q), /forever|never deleted|kept|permanent|no purge|retention|life of|while the line|master data/i, q);
  assert.match(r('download_counters'), /30 days|expires_at/i); assert.match(r('access_slips'), /life of the line|line/i); assert.match(r('manifest_lines'), /redact|retention|5/i);
  assert.match(r('g_cs_reasons'), /seed|permanent|never deleted|kept|forever|global/i); assert.match(y['partners.event_inbox'].retention, /90 days/); assert.match(spec6(), /redact_expired_lines/);
});
test('db/tests/rls_exempt.txt lists exactly the partners G table with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^partners\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), [...G_T].sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ seeds (§7: 7 sets, 29 codes; [CONV] seeds; migration like the other G tables)
function coded() {
  const rows = [];
  for (const l of spec7().split('\n').filter((x) => /^\| `[a-z_]+` \| `/.test(x))) {
    const c = l.split('|'), set = /`([a-z_]+)`/.exec(c[1])[1];
    for (const m of c[2].matchAll(/`([a-z_]+)`\s+"([^"]+)"/g)) rows.push([set, m[1], m[2]]);
  }
  return rows;
}
const lit = (v) => /^'(.*)'$/.exec(v)?.[1];
test('seed rows: partners.g_cs_reasons holds the 29 §7 (set_name, code, display) rows, requires_text = true exactly for code other, ids named and distinct, system rows only; nothing else is seeded (no settings, counters or partner data; §10 fixtures belong to packages/test-fixtures)', () => {
  const sql = pSql(), sp = coded(); assert.equal(sp.length, 29); assert.equal(new Set(sp.map((x) => x[0])).size, 7);
  const rr = insertRows(sql, 'partners.g_cs_reasons'); assert.equal(rr.length, 29, 'g_cs_reasons: 29 seed rows');
  assert.deepEqual(rr.map((r) => [lit(r.set_name), lit(r.code), lit(r.display)]).sort(), sp.map((x) => [...x]).sort(), 'seed = spec §7');
  for (const r of rr) { assert.ok('id' in r, 'the G table has an id with no default: every seed row names it'); if ('requires_text' in r) assert.equal(r.requires_text.toLowerCase(), lit(r.code) === 'other' ? 'true' : 'false', `requires_text for ${r.code}`); }
  assert.equal(new Set(rr.map((r) => r.id)).size, rr.length, 'seed ids are distinct');
  assert.equal(rr.filter((r) => lit(r.code) === 'other').length, 7, 'every one of the 7 sets ends with other (requires_text)');
  const tables = [...new Set(stmts(sql).map(ws).filter((s) => /^INSERT\s+INTO\b/i.test(s)).map((s) => /INTO\s+(\S+)/i.exec(s)[1]))].sort();
  assert.deepEqual(tables, ['partners.g_cs_reasons'], 'no other INSERT in the partners migrations');
});

// ================================================================ views: none (§9; IC §6)
test('no published view: IC §6 defines no partners.v_pub_* view and C13 publishes none (§9) - the migrations create no view / materialized view and no view grant exists; the view column contract test is therefore vacuous (the foreign views of §9 are read-only inputs owned by C4/C5/C3/C6 migrations that already exist)', () => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8');
  assert.doesNotMatch(ic, /\bpartners\.v_pub_/, 'IC lists a partners.v_pub_* view: this test (and the C13 DDL) must then add its column contract');
  assert.doesNotMatch(strip(pSql()) + polSql(), /\bCREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+|TEMP(?:ORARY)?\s+)?VIEW\b/i); assert.doesNotMatch(pSql() + polSql(), /\bv_pub_/i);
  for (const v of ['frontdesk.v_pub_order_status', 'catalog.v_pub_price_list_items']) assert.ok(ic.includes(v), `IC has the foreign view ${v}`);
});

// ================================================================ hygiene
test('C13 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of other schemas\' tables, no USING (true), no GRANT to PUBLIC; no Storage SQL (the partners-slips bucket is provisioned over HTTP, LD-54); no link token / URL column', () => {
  const raw = pFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 30000, 'C13 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i); assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics|quality|micro|anatomic|inventory)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016'); assert.doesNotMatch(strip(raw), /\bTO\s+PUBLIC\b/i);
  assert.doesNotMatch(strip(raw) + polSql(), /\bstorage\.(objects|buckets)\b/i, 'no Storage SQL (LD-54)');
  assert.doesNotMatch(Object.keys(Object.fromEntries(createTable(pSql(), 'partners.access_slips').colMap)).join(','), /token|url/i, '08 A2.1: no column holds the link token or URL');
  assert.doesNotMatch(strip(raw), /\b(@partner-x\.invalid|SYN-PARTNER|Test Patient)\b/, '§10 fixtures belong to packages/test-fixtures');
});
test('LD-202 scope: no wave-1 migration, db/bootstrap, spec, service or app file is changed by this task (only partners files + policies + meta + tests are new / edited)', () => {
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', 'db/migrations', 'db/bootstrap', 'spec', 'services', 'apps'], { cwd: repo, encoding: 'utf8' });
  const changed = r.stdout.split('\n').filter(Boolean).filter((f) => !/^db\/migrations\/\d{14}_partners__/.test(f));
  assert.deepEqual(changed, [], 'tracked files outside the partners migrations were modified');
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts and check-fk-dag.ts exit 0 on the tree; check-migrations.ts exits 0, OR its only violation is "partners.manifest_lines: GRANT DELETE to lims_app on a class C table is forbidden" AND a blocking CR .orchestra/cr/T0B-13.C13*.md documents it (SPEC/GATE CONFLICT: §1 class C + §5 DELETE grant on draft lines vs CV §5.6 / check-migrations NO_DELETE; see the tests note)', () => {
  assert.ok(pFiles().length >= 1, 'C13 migrations missing');
  for (const t of ['check-registry.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
  const m = tool('check-migrations.ts');
  if (m.code !== 0) {
    const bad = m.out.split('\n').filter((l) => /^check-migrations: /.test(l) && !/check-migrations: ok/.test(l));
    assert.ok(bad.length > 0 && bad.every((l) => /manifest_lines: GRANT DELETE to lims_app on a class C table is forbidden/.test(l)), `check-migrations:\n${m.out}`);
    const crDir = root + '.orchestra/cr/', cr = existsSync(crDir) ? readdirSync(crDir).filter((f) => /^T0B-13\.C13.*\.md$/.test(f)) : [];
    assert.ok(cr.length >= 1, 'a blocking CR .orchestra/cr/T0B-13.C13*.md must document the manifest_lines DELETE-grant vs class-C gate conflict');
    assert.match(cr.map((f) => readFileSync(crDir + f, 'utf8')).join('\n'), /manifest_lines/);
  }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 17 tenant C13 tables, none for the class G table, and gen-isolation-probes --check is clean; _registry.sql lists all 18', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const q of G_T) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/partners/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-13\.C13_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/partners/T0B-13.C13_*.test.sql exist (tester-owned: writer must keep them) and cover the AC list by "-- AC-0B-x.y" markers, the 14 checks by "-- C13 check N" markers and the 4 §8 DEFINER-test groups by "-- DEFINER test N" markers; RLS never disabled; replica mode (if used) reset to origin', () => {
  assert.ok(tapFiles().length >= 2, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 14; n++) assert.match(txt, new RegExp(`-- C13 check ${n}\\b`), `marker for C13 check ${n}`);
  for (let n = 1; n <= 4; n++) assert.match(txt, new RegExp(`-- DEFINER test ${n}\\b`), `marker for §8 DEFINER test ${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.1', '6.2', '6.3']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
    const rep = [...s.matchAll(/session_replication_role\s*=\s*replica/gi)].length, org = [...s.matchAll(/session_replication_role\s*=\s*origin/gi)].length;
    assert.ok(rep === 0 || (org >= rep && s.lastIndexOf('= origin') > s.lastIndexOf('= replica')), `${f}: every replica fixture block is reset to origin before assertions`);
  }
});
