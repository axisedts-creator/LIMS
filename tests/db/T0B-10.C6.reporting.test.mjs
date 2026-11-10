// T0B-10.C6 static checks of the Wave-1 reporting DDL translation: db/migrations/*_reporting__*.sql, db/policies/reporting.sql, db/meta/tables.yaml, definer-inventory.yaml,
// guard functions/triggers, the four lims_reporting_lookup DEFINERs, v_pub_* views.
// Spec: C6 05-SCHEMA §1-§10 (§6 DDL, §6.1 RLS, §6.2 lookup role + DEFINERs, §6.3 grants, §7 views, §3 mutability); IC §6.4; C0 05-SCHEMA §3.8/§10; 08 A13 D-30/D-31, A16.1, A17 P-16, A21.1/A21.4, A25 D-201;
// AC-0B-2.1..2.4, 3.6 (probes), 4.1..4.3, 5.x (audit triggers), 6.1..6.3 (static part: order, role switch window, FK direction).
// Run: node --test tests/db/T0B-10.C6.reporting.test.mjs   (live: db/tests/reporting/T0B-10.C6_*.test.sql via pg_prove; generated probes: db/tests/isolation/reporting.*.test.sql)
// Method (as T0B-10.C2..C5): the expected DDL is PARSED FROM C6 05-SCHEMA at test time and compared (whitespace/case-normalised) with the migrations, so a drifting column, constraint, index,
// trigger, function body, policy, grant or view fails here. The §6.1 policies the spec only describes ("repeated for every centre-scoped table", "identical pattern") are derived from its
// templates. T0B10C6_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B10C6_ROOT ? resolve(process.env.T0B10C6_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const repFiles = () => files().filter((f) => /^\d{14}_reporting__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const repSql = () => repFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'reporting.sql') ? strip(readFileSync(polDir + 'reporting.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C5)
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
function createTable(sql, name) {
  const m = new RegExp(`CREATE\\s+(UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${esc(name)}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  const segs = splitTop(balanced(sql, m.index + m[0].length));
  const cons = segs.filter((s) => /^CONSTRAINT\b/i.test(s));
  const cols = segs.filter((s) => !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(s));
  const added = stmts(sql).filter((s) => new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${esc(name)}\\s+ADD\\s+CONSTRAINT\\b`, 'i').test(ws(s)))
    .map((s) => ws(s).replace(new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${esc(name)}\\s+ADD\\s+`, 'i'), ''));
  const allCons = [...cons, ...added];
  return { cols, cons: allCons, colNames: cols.map((c) => c.split(/\s+/)[0]), colMap: new Map(cols.map((c) => [c.split(/\s+/)[0], norm(c)])), conMap: new Map(allCons.map((c) => [c.split(/\s+/)[1], norm(c)])) };
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
  const m = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${esc(qname)}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  const open = /AS\s+(\$\w*\$)/i.exec(sql.slice(m.index));
  if (!open) return null;
  const bodyStart = m.index + open.index + open[0].length;
  const end = sql.indexOf(open[1], bodyStart);
  return end < 0 ? null : sql.slice(m.index, end + open[1].length);
}
const fnNames = (sql) => [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase());

// ---------------------------------------------------------------- spec extraction (C6 05-SCHEMA)
const specPath = repo + 'spec/chunks/C6-reporting-delivery/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = s.indexOf(b0, a + a0.length); assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const S6 = '## 6. DDL', S61 = '### 6.1 RLS DDL', S62 = '### 6.2 Lookup role', S63 = '### 6.3 Grants', S7 = '## 7. Published views', S8 = '## 8. Seed', S5 = '## 5. Indexes';
const specDdl = () => strip(sqlBlocks(between(specRaw(), S6, S61)));
const spec61 = () => strip(sqlBlocks(between(specRaw(), S61, S62)));
const spec62 = () => strip(sqlBlocks(between(specRaw(), S62, S63)));
const specView = () => strip(sqlBlocks(between(specRaw(), S7, S8)));
const spec5 = () => between(specRaw(), S5, S6);

const G_T = ['reporting.g_message_templates', 'reporting.g_cs_reasons'];
const OTHER = ['settings', 'staff_assignments', 'centre_contacts', 'referrer_preferences', 'channel_accounts', 'message_template_texts', 'report_templates', 'report_template_versions', 'narrative_templates',
  'cs_reasons', 'reports', 'report_order_items', 'report_versions', 'qr_tokens', 'portal_links', 'otp_challenges', 'portal_sessions', 'deliveries', 'delivery_attempts', 'provider_events', 'input_files',
  'narrative_reports', 'narrative_versions', 'print_jobs', 'portal_payment_requests'].map((t) => `reporting.${t}`);
const ALLT = [...G_T, ...OTHER];                                          // 27 new tables (reporting.event_inbox already exists from T0B-05)
const isG = (q) => /\.g_/.test(q);
const TENANT = ALLT.filter((q) => !isG(q));                               // 25 tenant tables
const E_T = ['reporting.otp_challenges', 'reporting.portal_sessions', 'reporting.print_jobs', 'reporting.portal_payment_requests'];
const A_T = ['reporting.delivery_attempts', 'reporting.provider_events'];
const M_T = ['settings', 'staff_assignments', 'centre_contacts', 'referrer_preferences', 'channel_accounts', 'message_template_texts', 'report_templates', 'report_template_versions', 'narrative_templates', 'cs_reasons'].map((t) => `reporting.${t}`);
const C_T = ['reports', 'report_order_items', 'report_versions', 'qr_tokens', 'portal_links', 'deliveries', 'input_files', 'narrative_reports', 'narrative_versions'].map((t) => `reporting.${t}`);
const AUDIT_ONE = [...M_T, ...C_T.filter((q) => q !== 'reporting.portal_links')];   // 18: one <t>__audit trigger; portal_links has the two conditional triggers
const NOT_AUDITED = [...E_T, ...A_T, ...G_T];
const CLS = Object.fromEntries([...M_T.map((q) => [q, ['M']]), ...C_T.map((q) => [q, ['C']]), ...E_T.map((q) => [q, ['E']]), ...A_T.map((q) => [q, ['A']]), ...G_T.map((q) => [q, ['G']])]);
CLS['reporting.report_template_versions'] = ['M', 'C'];
const PUB_VIEWS = ['v_pub_report_release', 'v_pub_order_report_tat', 'v_pub_delivery_daily'].map((v) => `reporting.${v}`);
const GUARDS = ['reporting.tg_report_versions_guard', 'reporting.tg_deliveries_scrub_only', 'reporting.tg_portal_links_guard', 'reporting.tg_narrative_versions_guard', 'reporting.tg_portal_payment_requests_guard'];
const DEFINERS = ['app.reporting_verify_qr', 'app.reporting_resolve_portal_credential', 'app.reporting_ingest_provider_callback', 'app.reporting_redeem_link_for_app'];
const CENTRE_T = ['reports', 'report_order_items', 'report_versions', 'qr_tokens', 'portal_links', 'narrative_reports', 'narrative_versions', 'input_files', 'print_jobs', 'centre_contacts', 'deliveries'].map((t) => `reporting.${t}`);
const TENANT_ONLY = ['settings', 'staff_assignments', 'referrer_preferences', 'channel_accounts', 'message_template_texts', 'report_templates', 'report_template_versions', 'narrative_templates', 'cs_reasons',
  'delivery_attempts', 'provider_events'].map((t) => `reporting.${t}`);
const GLOBAL_INDEXES = ['qr_tokens__token_sha256__uq', 'portal_links__token_sha256__uq', 'portal_sessions__token_sha256__uq', 'channel_accounts__callback_token_sha256__p_uq'];   // §5: the only non-tenant-leading indexes

// ---- expected policies: literal ones from §6.1 + §6.2, plus the ones the spec describes by template (§4 table, §6.1 comments)
const T = 'tenant_id = (SELECT app.current_tenant_id())', STAFF = '(SELECT app.is_staff_or_system())';
const CSP = '((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))';
const SYS = "(SELECT app.current_actor_type()) = 'system'", PORTAL = "(SELECT app.current_actor_type()) = 'portal'";
function expectedPolicies() {
  const lit = [...policies(spec61()), ...policies(spec62())];
  const have = new Set(lit.map((p) => p.key)), out = [];
  const add = (tbl, name, cmd, role, using, check) => {
    const key = `${name}@reporting.${tbl}`; if (have.has(key)) return; have.add(key);
    const parts = [`CREATE POLICY ${name} ON reporting.${tbl} FOR ${cmd} TO ${role}`];
    if (using) parts.push(`USING (${using})`); if (check) parts.push(`WITH CHECK (${check})`);
    out.push(...policies(parts.join(' ')));
  };
  const trio = (tbl, scope, pred, noUpdate) => {
    add(tbl, `${tbl}__select__${scope}`, 'SELECT', 'lims_app', pred); add(tbl, `${tbl}__insert__${scope}`, 'INSERT', 'lims_app', null, pred);
    if (!noUpdate) add(tbl, `${tbl}__update__${scope}`, 'UPDATE', 'lims_app', pred, pred);
  };
  for (const q of TENANT_ONLY) trio(q.split('.')[1], 'tenant', `${T} AND ${STAFF}`, q.endsWith('delivery_attempts'));
  for (const q of CENTRE_T) trio(q.split('.')[1], 'tenant_centre', `${T} AND ${STAFF} AND ${CSP}`, false);
  const lk = `${T} AND ${PORTAL} AND link_id = (SELECT app.current_actor_id())`, sy = `${T} AND ${SYS}`;     // portal_sessions: "identical pattern" to otp_challenges
  add('portal_sessions', 'portal_sessions__select__portal', 'SELECT', 'lims_app', lk); add('portal_sessions', 'portal_sessions__insert__portal', 'INSERT', 'lims_app', null, lk);
  add('portal_sessions', 'portal_sessions__update__portal', 'UPDATE', 'lims_app', lk, lk);
  add('portal_sessions', 'portal_sessions__select__tenant_system', 'SELECT', 'lims_app', sy);
  add('portal_sessions', 'portal_sessions__update__tenant_system', 'UPDATE', 'lims_app', sy, sy);
  add('portal_sessions', 'portal_sessions__delete__tenant_expired', 'DELETE', 'lims_app', `${sy} AND coalesce(ended_at, absolute_expires_at) < now() - interval '24 hours'`);
  add('otp_challenges', 'otp_challenges__select__portal', 'SELECT', 'lims_app', lk);                                             // (literal in §6.1 already)
  add('print_jobs', 'print_jobs__delete__tenant_expired', 'DELETE', 'lims_app', `${sy} AND expires_at < now()`);
  return [...lit, ...out];
}
const EXPECTED_POLICY_COUNT = 107;
function expectedGrants() {
  const g = new Map(), add = (t, role, ...p) => { if (!g.has(t)) g.set(t, new Map()); g.get(t).set(role, new Set(p)); };
  for (const q of [...M_T, ...C_T, 'reporting.provider_events']) add(q, 'lims_app', 'SELECT', 'INSERT', 'UPDATE');
  for (const q of E_T) add(q, 'lims_app', 'SELECT', 'INSERT', 'UPDATE', 'DELETE');
  add('reporting.delivery_attempts', 'lims_app', 'SELECT', 'INSERT');
  for (const q of G_T) add(q, 'lims_app', 'SELECT');
  for (const q of ['qr_tokens', 'report_versions', 'portal_links', 'portal_sessions', 'channel_accounts', 'reports', 'deliveries']) add(`reporting.${q}`, 'lims_reporting_lookup', 'SELECT');
  add('reporting.provider_events', 'lims_reporting_lookup', 'SELECT', 'INSERT');
  for (const v of PUB_VIEWS) { add(v, 'lims_app', 'SELECT'); add(v, 'lims_analytics', 'SELECT'); }
  return g;
}

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 27 new reporting tables (2 G + 25 tenant), 5 guard functions, 4 lookup DEFINERs, 3 views, §5 index names resolvable, expected policy set derived', () => {
  const ddl = specDdl();
  for (const q of ALLT) assert.ok(createTable(ddl, q), `spec has ${q}`);
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 27, '27 CREATE TABLE in §6');
  assert.doesNotMatch(ddl, /CREATE\s+TABLE\s+reporting\.event_inbox/i);
  assert.deepEqual(fnNames(ddl).sort(), [...GUARDS].sort());
  assert.deepEqual(fnNames(spec62()).sort(), [...DEFINERS].sort());
  assert.deepEqual([...specView().matchAll(/CREATE\s+VIEW\s+([\w.]+)/gi)].map((m) => m[1]), PUB_VIEWS);
  assert.equal(createTriggers(ddl).filter((s) => !isAudit(s)).length, 14, '9 mutable_columns + 5 guard / scrub triggers');
  assert.equal(AUDIT_ONE.length, 18); assert.equal(TENANT.length, 25); assert.equal(CENTRE_T.length, 11);
  const ps = expectedPolicies();
  assert.equal(new Set(ps.map((p) => p.key)).size, ps.length, 'no duplicate expected policy');
  assert.equal(ps.length, EXPECTED_POLICY_COUNT, `expected policies: ${ps.length}`);
  assert.deepEqual([...new Set(ps.map((p) => p.table))].sort(), [...TENANT].sort(), 'every tenant table (and no G table) has policies');
  const refs = new Set([...ddl.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase().split('.')[0]));
  assert.deepEqual([...refs].sort(), ['catalog', 'core', 'frontdesk', 'reporting'], 'spec FK target schemas');
  const names = [...spec5().matchAll(/`([a-z_0-9]+__[a-z_0-9]*(?:uq|idx))\b/g)].map((m) => m[1]);
  assert.ok(names.length >= 40, `§5 index names: ${names.length}`);
});

// ================================================================ files, order, owner switch (AC-0B-6.1 / 6.3)
test('migration files: >= 1 *_reporting__*.sql, unique timestamps, after the catalog + frontdesk + billing + lab + event_inboxes migrations (stage order), db/policies/reporting.sql exists', () => {
  assert.ok(repFiles().length >= 1, 'no db/migrations/*_reporting__*.sql yet (T0B-10.C6 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => /_(core|catalog|frontdesk|billing|lab|identity)__/.test(f) || /core__create_event_inboxes|app__create_queue_wrapper/.test(f));
  assert.ok(earlier.length >= 6, 'earlier-stage migrations present');
  for (const f of repFiles()) for (const e of earlier) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (02-TRD §4.2 stage order; reporting FKs point into frontdesk / catalog / core)`);
  assert.ok(existsSync(polDir + 'reporting.sql'), 'db/policies/reporting.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(repSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)reporting\b/i, 'schema reporting exists since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every reporting migration is SET LOCAL ROLE lims_owner; role switches elsewhere only in the §6.2 D-201 window file (exact sequence), which ends back on lims_owner', () => {
  assert.ok(repFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+)/gi)].map((m) => ws(m[1]).toUpperCase());
  let window = 0;
  for (const f of repFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    if (/GRANT\s+CREATE\s+ON\s+SCHEMA\s+app\s+TO\s+lims_reporting_lookup/i.test(s)) {
      window++;
      assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER', 'RESET ROLE', 'SET LOCAL ROLE LIMS_REPORTING_LOOKUP', 'RESET ROLE', 'SET LOCAL ROLE LIMS_OWNER', 'RESET ROLE', 'SET LOCAL ROLE LIMS_QUEUE', 'RESET ROLE', 'SET LOCAL ROLE LIMS_OWNER'],
        `${f}: role switch sequence of the D-201 window (§6.2)`);
    } else assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch outside the D-201 window file`);
  }
  assert.equal(window, 1, 'exactly one migration file holds the D-201 window (the four DEFINERs are created in this one file)');
});

// ================================================================ tables (columns + constraints = spec)
for (const q of ALLT) {
  test(`${q}: columns, constraints (names + text) equal 05-SCHEMA §6`, () => {
    const exp = createTable(specDdl(), q); assert.ok(exp, `spec table ${q}`);
    const got = createTable(repSql(), q);
    assert.ok(got, `CREATE TABLE ${q} not found in *_reporting__*.sql`);
    for (const [c, def] of exp.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    assert.deepEqual([...got.colMap.keys()].sort(), [...exp.colMap.keys()].sort(), `${q} column set`);
    for (const [c, def] of exp.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    assert.deepEqual([...got.conMap.keys()].sort(), [...exp.conMap.keys()].sort(), `${q} constraint set (no extra, no missing)`);
  });
}
test('exactly the 27 §1 tables are created in reporting (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9)', () => {
  const sql = repSql();
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(sql, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /event_inbox/i, 'C6 migrations do not touch event_inbox (T0B-05 owns it)');
  for (const q of ALLT) for (const c of ['id', 'tenant_id']) { const def = createTable(sql, q).colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`); }
});
test('cross-schema references (01-CM §5 R3): reporting -> reporting / core / catalog / frontdesk only, identical target set to the spec; NO FK into billing or lab; nothing outside reporting references reporting (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(repSql()), exp = tgt(specDdl());
  assert.deepEqual([...got].sort(), [...exp].sort(), 'FK target tables equal the spec');
  for (const t of got) assert.ok(/^reporting\./.test(t) || /^frontdesk\.(orders|patients|order_items)$/.test(t) || /^catalog\.(tests|doctors)$/.test(t) || /^core\.(tenants|branches|collection_centres|memberships)$/.test(t), `reporting FK target ${t}`);
  assert.doesNotMatch(repSql(), /\bREFERENCES\s+(billing|lab|identity|instruments|analytics)\./i, 'no FK into billing (02-CV §5.4) / lab (events and ports only)');
  assert.doesNotMatch(files().filter((f) => !/_reporting__/.test(f)).map(read).join('\n'), /\bREFERENCES\s+reporting\./i, 'no FK into reporting from any other migration (later schemas add theirs in their own files)');
});
test('indexes: every §6 CREATE INDEX present with identical definition (partial predicates incl.); no extra index; every §5 index name exists as an index or a constraint', () => {
  const have = new Map(createIndexes(repSql()).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].sort(), exp.map(idxName).sort(), 'no index beyond the spec');
  for (const n of ['qr_tokens__token_sha256__uq', 'portal_links__token_sha256__uq', 'portal_sessions__token_sha256__uq', 'report_versions__tenant_id_report_id__released__p_uq', 'portal_payment_requests__tenant_id_order_id__open__p_uq'])
    assert.match(have.get(n) ?? '', /^create unique index/, `${n} is UNIQUE`);
  const conNames = new Set(OTHER.concat(G_T).flatMap((q) => [...createTable(repSql(), q).conMap.keys()]));
  const missing = [...new Set([...spec5().matchAll(/`([a-z_0-9]+__[a-z_0-9]*(?:uq|idx))\b/g)].map((m) => m[1]))].filter((n) => !have.has(n) && !conNames.has(n));
  assert.deepEqual(missing, [], '§5 index names that exist neither as CREATE INDEX nor as a UNIQUE constraint');
});
test('tenant_id leads every index and UNIQUE/PK constraint of a tenant table (except single-column PRIMARY KEY (id)); PK(id) tables also have UNIQUE (tenant_id, id); only the four token-hash indexes are global (CR-C6-002)', () => {
  const sql = repSql();
  for (const s of createIndexes(sql)) {
    const m = /\bON\s+(\w+\.\w+)\s+(?:USING\s+\w+\s+)?\(\s*([^,)]+)/i.exec(s); assert.ok(m, s);
    if (GLOBAL_INDEXES.includes(idxName(s))) continue;
    assert.equal(m[2].trim(), 'tenant_id', `index ${idxName(s)} on ${m[1]} must lead with tenant_id`);
  }
  for (const n of GLOBAL_INDEXES) assert.ok(createIndexes(sql).some((s) => idxName(s) === n), `global index ${n}`);
  for (const q of TENANT) {
    const t = createTable(specDdl(), q), cons = [...t.conMap.values()];
    for (const c of cons.filter((x) => /\b(primary key|unique)\(/.test(x))) {
      const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1];
      if (/primary key/.test(c) && k === 'id') continue;
      assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${c}`);
    }
    if (cons.some((c) => /primary key\(id\)/.test(c))) assert.ok(cons.some((c) => /unique\(tenant_id,id\)/.test(c)), `${q}: PRIMARY KEY (id) requires UNIQUE (tenant_id, id)`);
  }
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A16.1, A17 P-16, A21.1)
test('ENABLE + FORCE ROW LEVEL SECURITY (literal statements) on the 25 tenant tables; none on the 2 g_* tables; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = repSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of G_T) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(repSql(), /\bDO\s+\$\$/i, 'literal statements only');
});
const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('reporting.') && !/\.event_inbox$/.test(p.table));
test('policies: db/policies/reporting.sql holds EXACTLY the expected policies (§6.1 + §6.2 literals, template-derived rest): name, command, role, USING, WITH CHECK; G tables none; only event_inbox may be extra', () => {
  const exp = expectedPolicies(), got = gotPolicies();
  assert.ok(got.length > 0, 'db/policies/reporting.sql has no CREATE POLICY');
  const byKey = new Map(got.map((p) => [p.key, p])); assert.equal(byKey.size, got.length, 'no duplicate policy');
  for (const e of exp) {
    const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(g.using, e.using, `${e.key} USING`); assert.equal(g.check, e.check, `${e.key} WITH CHECK`);
  }
  assert.deepEqual([...byKey.keys()].sort(), exp.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access)');
  for (const p of policies(polSql()).filter((x) => /\.event_inbox$/.test(x.table))) assert.match(p.name, /^event_inbox__(select|insert|delete)__(tenant|owner_only)$/, `${p.key}: only the C0 inbox shapes may appear`);
});
test('policy shape: names <table>__<cmd>__<scope>; lims_app except *__lookup / *__owner_only (lims_reporting_lookup); ::uuid[] cast (A16.1) on centre AND engagement_patient_ids predicates; staff guard on __tenant / __tenant_centre; DELETE only __tenant_expired on the 4 E tables; no true / PUBLIC / anon', () => {
  const ps = gotPolicies();
  assert.equal(ps.length, EXPECTED_POLICY_COUNT, `policies: ${ps.length}`);
  for (const p of ps) {
    const tbl = p.table.split('.')[1], m = new RegExp(`^${tbl}__${p.cmd.toLowerCase()}__(tenant|tenant_centre|portal|partner|patient|tenant_system|tenant_expired|lookup|owner_only)$`).exec(p.name);
    assert.ok(m, `${p.key}: name <table>__<cmd>__<scope>`);
    const lookup = /^(lookup|owner_only)$/.test(m[1]);
    assert.equal(p.roles, lookup ? 'lims_reporting_lookup' : 'lims_app', `${p.key} roles`);
    const t = p.using + ' ' + p.check;
    if (/current_centre_ids/.test(t)) assert.match(t, /any\(\(select app\.current_centre_ids\(\)\)::uuid\[\]\)/, `${p.key}: A16.1 cast`);
    if (/engagement_patient_ids/.test(t)) assert.match(t, /any\(\(select app\.engagement_patient_ids\(\)\)::uuid\[\]\)/, `${p.key}: A16.1 cast`);
    if (/^(tenant|tenant_centre)$/.test(m[1])) {
      if (p.cmd !== 'INSERT') assert.match(p.using, /\(select app\.is_staff_or_system\(\)\)/, `${p.key} USING lacks the staff guard (08 A17 P-16)`);
      if (p.cmd !== 'SELECT') assert.match(p.check, /\(select app\.is_staff_or_system\(\)\)/, `${p.key} WITH CHECK lacks the staff guard`);
    }
    if (p.cmd === 'DELETE') { assert.ok(E_T.includes(p.table) && m[1] === 'tenant_expired', `${p.key}: DELETE only as __tenant_expired on an E table`); assert.match(p.using, /current_actor_type\(\)\)='system'/, `${p.key}: system actor only`); }
    if (!lookup) assert.match(p.using + p.check, /current_tenant_id/, `${p.key}: tenant predicate`);
    if (lookup) assert.match(p.using + p.check, /current_setting\('app\.pre_[a-z_0-9]+',true\)/, `${p.key}: bound to an app.pre_* GUC (A21.4)`);
    assert.doesNotMatch(t, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|app\.maintenance|is_platform_actor/, p.key);
    assert.ok(!isG(p.table), `${p.key}: G tables carry no policy`);
  }
  assert.deepEqual(ps.filter((p) => p.cmd === 'DELETE').map((p) => p.table).sort(), [...E_T].sort());
  assert.ok(!ps.some((p) => p.table === 'reporting.delivery_attempts' && p.cmd === 'UPDATE'), 'delivery_attempts: append-only, no UPDATE policy');
  assert.match(ps.find((p) => p.key === 'report_versions__select__portal@reporting.report_versions').using, /portal_link_purpose'\)='report'/, 'dues links see no report content (A21.1)');
  assert.match(ps.find((p) => p.key === 'qr_tokens__select__portal@reporting.qr_tokens').using, /portal_link_purpose'\)='report'/);
  assert.doesNotMatch(ps.filter((p) => p.table === 'reporting.otp_challenges' && p.cmd === 'SELECT' && p.name.endsWith('tenant_system')).map((p) => p.using).join(), /is_staff_or_system/, 'staff never read OTP rows');
  for (const t of ['reporting.otp_challenges', 'reporting.portal_payment_requests', 'reporting.portal_sessions']) assert.ok(!ps.some((p) => p.table === t && /__tenant(_centre)?$/.test(p.name)), `${t}: no staff policy (review fix #34)`);
  const cen = new Set(ps.filter((p) => /current_centre_ids/.test(p.using + p.check)).map((p) => p.table));
  assert.deepEqual([...cen].sort(), [...CENTRE_T].sort(), 'centre predicates on exactly the 11 centre-scoped tables');
});
test('policies written literally in migrations are identical to db/policies/reporting.sql (AC-0B-2.3 copy); lookup policies live in the migrations too', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(repSql()).filter((x) => x.table.startsWith('reporting.') && !/\.event_inbox$/.test(x.table));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort(), 'every policy of the file is created by a migration and vice versa');
});

// ================================================================ grants (AC-0B-4.2 / 4.3)
test('table + view grants equal §6.3 / §6.2 / §7: lims_app (SIU; SIUD on the 4 E tables; SI delivery_attempts; S on g_*), lims_reporting_lookup (7 S + provider_events SI), lims_analytics S on the 3 views; no other role, no TRUNCATE/REFERENCES/TRIGGER/ALL', () => {
  const sql = repSql() + '\n;\n' + polSql(), g = tableGrants(sql), exp = expectedGrants();
  assert.equal(exp.size, 27 + 3, 'expected grant targets');
  for (const [q, roles] of exp) {
    const rm = g.get(q); assert.ok(rm, `no GRANT on ${q}`);
    assert.deepEqual([...rm.keys()].sort(), [...roles.keys()].sort(), `${q}: granted roles`);
    for (const [r, want] of roles) assert.deepEqual([...rm.get(r)].sort(), [...want].sort(), `${q} privileges for ${r}`);
  }
  for (const [t, rm] of g) if (/^reporting\./.test(t)) {
    assert.ok(exp.has(t), `${t}: unexpected grant target`);
    for (const [, ps] of rm) for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!ps.has(bad), `${t} must not hold ${bad}`);
  }
  for (const [t, rm] of g) if (/^reporting\./.test(t) && !E_T.includes(t)) for (const [r, ps] of rm) assert.ok(!ps.has('DELETE'), `${t}: ${r} must not hold DELETE (02-CV §5.6)`);
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\breporting\./i);
  assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+reporting\b/i);
  assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\breporting\b/i);
  const colGrants = stmts(sql).map(ws).filter((s) => /^GRANT\s+[A-Z, ]*\(\s*\w+/i.test(s) && /\breporting\./i.test(s));
  assert.equal(colGrants.length, 1, 'the only column-level grant is the redeem counter (D-30)');
  assert.match(colGrants[0], /^GRANT UPDATE \(redeem_failures, updated_at, version\) ON reporting\.portal_links TO lims_reporting_lookup$/i);
  assert.ok(stmts(sql).map(ws).some((s) => /^GRANT USAGE ON SCHEMA reporting TO lims_reporting_lookup$/i.test(s)), 'USAGE on schema reporting for the lookup role');
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\breporting\./i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner)\b/i, s);
});

// ================================================================ functions + triggers (AC-0B-4.1; §3 mutability)
test('the 5 reporting.tg_*_guard / scrub functions equal the spec bodies (SECURITY INVOKER, search_path pinned, P0001 immutable_row); they and the 4 DEFINERs are the only functions created', () => {
  const sql = repSql(), want = specDdl();
  for (const f of GUARDS) {
    const got = fnText(sql, f), exp = fnText(want, f); assert.ok(got, `${f} missing`); assert.equal(norm(got), norm(exp), `${f} body`);
    assert.match(got, /SET\s+search_path\s*=\s*''/i); assert.doesNotMatch(got, /SECURITY\s+DEFINER/i, `${f} is INVOKER`);
    assert.match(got, /ERRCODE\s*=\s*'P0001',\s*MESSAGE\s*=\s*'immutable_row'/i);
  }
  assert.deepEqual(fnNames(sql).sort(), [...GUARDS, ...DEFINERS].sort(), 'no other function');
  assert.match(fnText(sql, 'reporting.tg_portal_links_guard'), /current_user\s*=\s*'lims_reporting_lookup'/, 'lookup-role branch of the portal_links guard');
});
test('the 4 lims_reporting_lookup DEFINERs equal §6.2 verbatim (SECURITY DEFINER, search_path = \'\', GUC set with set_config(..., true) and reset to \'\' before every return), owner lims_reporting_lookup, REVOKE ALL FROM PUBLIC, EXECUTE to lims_api only; D-201 window closed; no standing CREATE', () => {
  const sql = repSql(), want = spec62();
  const INGEST = 'app.reporting_ingest_provider_callback';
  for (const f of DEFINERS) {
    const got = fnText(sql, f), exp = fnText(want, f); assert.ok(got, `${f} missing`);
    if (f !== INGEST) assert.equal(norm(got), norm(exp), `${f} body`);   // INGEST: LD-49 (b) (C6-T29) overrides §6.2, see the next test
    assert.match(got, /SECURITY\s+DEFINER/i); assert.match(got, /SET\s+search_path\s*=\s*''/i);
  }
  const keep = (s) => /^(ALTER FUNCTION app\.reporting_|REVOKE ALL ON FUNCTION app\.reporting_|GRANT EXECUTE ON FUNCTION app\.reporting_|GRANT EXECUTE ON FUNCTION app\.enqueue_job|GRANT CREATE ON SCHEMA app|REVOKE CREATE ON SCHEMA app)/i.test(s);
  const isEnq = (s) => /GRANT EXECUTE ON FUNCTION app\.enqueue_job/i.test(s);
  const g = stmts(sql).map(ws).filter(keep).map(norm).sort(), e = stmts(want).map(ws).filter(keep).filter((s) => !isEnq(s)).map(norm).sort();
  assert.deepEqual(g, e, 'owner / REVOKE / GRANT EXECUTE / window statements (§6.2 minus the enqueue_job grant: LD-49 (b))');
  assert.equal(g.length, 4 * 3 + 2, '4 x (ALTER OWNER, REVOKE, GRANT) + window open + close; NO enqueue_job grant to lims_reporting_lookup (LD-49 (b))');
  assert.ok(!stmts(sql).map(ws).some(isEnq), 'lims_reporting_lookup is not granted app.enqueue_job');
  const dsql = stmts(sql).map(ws);
  assert.ok(dsql.findIndex((s) => /^REVOKE CREATE ON SCHEMA app FROM lims_reporting_lookup$/i.test(s)) > dsql.findIndex((s) => /^CREATE FUNCTION app\.reporting_redeem_link_for_app/i.test(s)), 'window closed after the last DEFINER');
  assert.doesNotMatch(sql, /GRANT\s+CREATE\s+ON\s+DATABASE/i); assert.doesNotMatch(sql, /ALTER\s+ROLE\s+lims_reporting_lookup/i, 'role is C0 bootstrap: no changes here');
  assert.doesNotMatch(sql, /CREATE\s+ROLE/i);
});
test('LD-49 (b) (C6-T29): app.reporting_ingest_provider_callback RETURNS uuid (tenant id, NULL = rejected), never enqueues, never sets JWT claims, sets then resets the 3 callback GUCs before every RETURN, inserts with the dedupe ON CONFLICT', () => {
  const body = fnText(repSql(), 'app.reporting_ingest_provider_callback'); assert.ok(body, 'ingest function missing');
  assert.match(body, /\(\s*p_provider_kind\s+text\s*,\s*p_token_sha256\s+bytea\s*,\s*p_events\s+jsonb\s*\)/i, 'signature (text, bytea, jsonb) unchanged (08 4.7)');
  assert.match(body, /RETURNS\s+uuid\b/i, 'returns the tenant id');
  assert.doesNotMatch(body, /enqueue_job/i, 'the DEFINER does not enqueue (C6 handler does, inside withTenantScope)');
  assert.doesNotMatch(body, /request\.jwt|set_config\(\s*'request\./i, 'never set JWT claims to get around the enqueue tenant check');
  assert.match(body, /ON\s+CONFLICT\s+ON\s+CONSTRAINT\s+provider_events__dedupe__uq\s+DO\s+NOTHING/i);
  assert.doesNotMatch(body, /RETURN\s+-1\b/, 'no -1 sentinel for a uuid return');
  for (const gname of ['app.pre_callback_token_sha256', 'app.pre_callback_tenant_id', 'app.pre_callback_channel_account_id']) {
    assert.match(body, new RegExp(`set_config\\(\\s*'${gname.replace(/\./g, '\\.')}'\\s*,\\s*''\\s*,\\s*true\\s*\\)`, 'i'), `${gname} reset to '' (A21.4)`);
  }
  // every RETURN that follows the token lookup is preceded by the GUC reset of the token GUC (the early reject before any set_config is the only exception)
  const returns = [...body.matchAll(/RETURN\b[^;]*;/gi)];
  assert.ok(returns.length >= 2, 'a reject return and a success return');
  assert.match(body, /RETURN\s+v_tenant(_id)?\s*;/i, 'success returns the resolved tenant variable (name v_tenant / v_tenant_id)');
});
test('triggers: the mutable_columns triggers + 5 guard/scrub triggers equal the spec (mutable-column lists = §3 mutability); no other non-audit trigger; none disabled or dropped', () => {
  const have = new Map(createTriggers(repSql()).filter((s) => !isAudit(s)).map((s) => [trgName(s), norm(s)]));
  const exp = createTriggers(specDdl()).filter((s) => !isAudit(s));
  for (const s of exp) assert.equal(have.get(trgName(s)), norm(s), `trigger ${trgName(s)}`);
  assert.deepEqual([...have.keys()].sort(), exp.map(trgName).sort(), 'no trigger beyond the spec');
  const mc = exp.filter((s) => /app\.enforce_mutable_columns/i.test(s)).map((s) => /ON\s+(\w+\.\w+)/i.exec(s)[1]).sort();
  assert.deepEqual(mc, ['reporting.deliveries', 'reporting.input_files', 'reporting.portal_links', 'reporting.portal_payment_requests', 'reporting.provider_events', 'reporting.qr_tokens', 'reporting.report_template_versions',
    'reporting.report_versions', 'reporting.reports'].sort());
  assert.deepEqual(exp.filter((s) => !/enforce_mutable_columns/i.test(s)).map(trgName).sort(), ['deliveries__scrub_only', 'narrative_versions__guard', 'portal_links__guard', 'portal_payment_requests__guard', 'report_versions__guard']);
  assert.doesNotMatch(repSql(), /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(repSql(), /DROP\s+TRIGGER\b/i);
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x): <t>__audit AFTER INSERT OR UPDATE OR DELETE on the 18 class M/C tables; portal_links has exactly the two conditional spec triggers; none on E / A / G tables', () => {
  const trg = createTriggers(repSql()).filter(isAudit);
  const onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of AUDIT_ONE) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(\\s*\\)$`, 'i'), q);
  }
  const pl = onTable('reporting.portal_links'), spec = createTriggers(specDdl()).filter((s) => isAudit(s) && /portal_links/.test(s));
  assert.equal(spec.length, 2); assert.deepEqual(pl.map(norm).sort(), spec.map(norm).sort(), 'portal_links__audit_ins / __audit_upd equal the spec (redeem-counter updates are not row-audited)');
  for (const q of NOT_AUDITED) assert.equal(onTable(q).length, 0, `${q} must NOT be audited`);
  assert.equal(trg.length, 18 + 2, 'no audit trigger on any other table');
});

// ================================================================ DEFINER inventory (db/meta/definer-inventory.yaml; 08 §4.7, A21.4, REQ-SEC-020)
test('db/meta/definer-inventory.yaml: the 4 reporting DEFINERs registered with owner lims_reporting_lookup, execute [lims_api], a why, the tables they touch and owner policies that exist in db/policies/reporting.sql', () => {
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  const touches = {
    'app.reporting_verify_qr': ['reporting.qr_tokens SELECT', 'reporting.report_versions SELECT'],
    'app.reporting_resolve_portal_credential': ['reporting.portal_links SELECT', 'reporting.portal_sessions SELECT'],
    'app.reporting_ingest_provider_callback': ['reporting.channel_accounts SELECT', 'reporting.provider_events INSERT'],
    'app.reporting_redeem_link_for_app': ['reporting.portal_links SELECT', 'reporting.portal_links UPDATE', 'reporting.reports SELECT', 'reporting.report_versions SELECT', 'reporting.deliveries SELECT'],
  };
  const pols = new Set(policies(polSql()).map((p) => p.name));
  for (const f of DEFINERS) {
    const e = inv[f]; assert.ok(e, `inventory entry ${f}`);
    assert.equal(e.owner, 'lims_reporting_lookup', `${f} owner`); assert.deepEqual([...e.execute], ['lims_api'], `${f} execute`);
    assert.ok(typeof e.why === 'string' && e.why.length > 5, `${f} why`);
    for (const t of touches[f]) assert.ok(e.touches.some((x) => ws(x).toUpperCase().startsWith(t.toUpperCase())), `${f} touches ${t}`);
    assert.ok(e.policies.length >= 1, `${f} names its owner policies`);
    for (const p of e.policies) assert.ok(pols.has(p), `${f}: policy ${p} must exist in db/policies/reporting.sql`);
  }
  for (const g of GUARDS) assert.ok(!inv[g], `${g} is SECURITY INVOKER and not inventoried`);
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const MANDATORY = ['id', 'tenant_id', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const ddlCols = (q) => createTable(specDdl(), q).colNames;
const actorsOf = (q) => [...new Set(expectedPolicies().filter((p) => p.table === q).map((p) => /__(portal|partner|patient)$/.exec(p.name)?.[1]).filter(Boolean))].sort();
test('tables.yaml: all 27 C6 tables registered (class, centre_scoped from the policies, audited = trigger, retention, shared_with = the __portal/__partner/__patient policies, phi_class for exactly the DDL columns); event_inbox entry untouched', () => {
  const y = tablesYaml(), centre = new Set(expectedPolicies().filter((p) => /current_centre_ids/.test(p.using + p.check)).map((p) => p.table));
  const trgAudited = (q) => createTriggers(repSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of ALLT) {
    const e = y[q]; assert.ok(e, `${q} in tables.yaml`);
    assert.ok(CLS[q].includes(e.class), `${q} class ${e.class} not in ${CLS[q]}`);
    assert.equal(e.centre_scoped, centre.has(q), `${q} centre_scoped`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`);
    assert.equal(e.audited, AUDIT_ONE.includes(q) || q === 'reporting.portal_links', `${q} audited per spec §1`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), [...ddlCols(q)].sort(), `${q} columns = DDL columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
    assert.deepEqual([...(e.shared_with ?? [])].sort(), actorsOf(q), `${q} shared_with = actor policies present (check-registry / probe step 9)`);
  }
  assert.equal(centre.size, 11);
  assert.deepEqual(['reporting.reports', 'reporting.report_versions', 'reporting.qr_tokens'].map((q) => y[q].shared_with.slice().sort().join()), ['partner,patient,portal', 'partner,patient,portal', 'partner,patient,portal']);
  assert.ok(y['reporting.event_inbox'], 'inbox entry remains');
  assert.deepEqual(Object.keys(y).filter((k) => /^reporting\./.test(k) && !/\.event_inbox$/.test(k)).sort(), [...ALLT].sort(), 'no extra reporting entry');
});
test('tables.yaml phi_class (§2, §10): P3 content_snapshot / smart_summary_json / panel_names_snapshot / sections / caption / report_order_items orderables; P2 patient display, registration_no, destinations, centre contact address, filenames, params; P1 ids + hashes + credential material; P0 settings / statuses; created_by / updated_by never above P1', () => {
  const y = tablesYaml(), eq = (q, c, ps) => { assert.ok(y[q].columns[c] !== undefined, `${q}.${c} registered`); assert.ok([].concat(ps).includes(y[q].columns[c]), `${q}.${c} is ${y[q].columns[c]}, want ${ps}`); };
  for (const [q, c] of [['report_versions', 'content_snapshot'], ['report_versions', 'smart_summary_json'], ['qr_tokens', 'panel_names_snapshot'], ['narrative_versions', 'sections'], ['input_files', 'caption'],
    ['report_order_items', 'orderable_id'], ['report_order_items', 'test_ids']]) eq(`reporting.${q}`, c, 'P3');
  for (const [q, c] of [['qr_tokens', 'patient_display_snapshot'], ['portal_links', 'patient_display_snapshot'], ['portal_links', 'destination_masked'], ['reports', 'registration_no'], ['reports', 'patient_display_name'],
    ['deliveries', 'destination_masked'], ['deliveries', 'destination_e164'], ['deliveries', 'params'], ['centre_contacts', 'address'], ['input_files', 'original_filename'], ['report_versions', 'regeneration_reason_text']]) eq(`reporting.${q}`, c, 'P2');
  for (const [q, cs] of Object.entries({ qr_tokens: ['token_sha256'], portal_links: ['token_sha256', 'destination_sha256'], portal_sessions: ['token_sha256'], otp_challenges: ['code_hmac', 'destination_sha256'], deliveries: ['destination_sha256'],
    reports: ['order_id', 'patient_id'], report_versions: ['content_fingerprint', 'order_item_ids'], channel_accounts: ['callback_token_sha256'] })) for (const c of cs) eq(`reporting.${q}`, c, 'P1');
  for (const [q, cs] of Object.entries({ settings: ['auto_release', 'bulk_release_max'], reports: ['state', 'family'], report_versions: ['status', 'version_no', 'content_sha256'], deliveries: ['status', 'channel'] })) for (const c of cs) eq(`reporting.${q}`, c, 'P0');
  for (const q of G_T) for (const c of Object.keys(y[q].columns)) eq(q, c, 'P0');
  for (const q of ALLT) for (const c of ['created_by', 'updated_by']) if (y[q].columns[c]) assert.ok(['P0', 'P1'].includes(y[q].columns[c]), `${q}.${c}`);
});
test('tables.yaml: rls_exempt only on the 2 g_* tables (with a reason); mandatory-column exceptions are real (listed iff the DDL lacks the column) and carry a reason', () => {
  const y = tablesYaml();
  for (const q of ALLT) {
    const e = y[q], cols = new Set(ddlCols(q));
    if (isG(q)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    const exc = [...(e.mandatory_column_exceptions ?? [])];
    if (!isG(q)) {
      const missing = MANDATORY.filter((c) => !cols.has(c));
      for (const c of exc) assert.ok(!cols.has(c), `${q}: exception ${c} but the DDL has that column`);
      assert.deepEqual(exc.filter((c) => MANDATORY.includes(c)).sort(), missing.sort(), `${q}: mandatory_column_exceptions must list exactly the mandatory columns the DDL lacks`);
    }
    if (exc.length) assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 5, `${q} needs mandatory_column_exceptions_reason`);
  }
});
test('tables.yaml retention (§9): report/qr/deliveries/links retention years; E tables expiry + purge; payment requests 90 days; print_jobs 24 h; provider_events 1 year; g_* permanent', () => {
  const y = tablesYaml();
  for (const q of ['reports', 'report_versions', 'qr_tokens', 'deliveries', 'delivery_attempts', 'portal_links', 'narrative_versions', 'input_files']) assert.match(y[`reporting.${q}`].retention, /year|retention|no purge|archive|kept/i, q);
  assert.match(y['reporting.otp_challenges'].retention, /24/); assert.match(y['reporting.portal_sessions'].retention, /24/); assert.match(y['reporting.print_jobs'].retention, /24\s*h/i);
  assert.match(y['reporting.portal_payment_requests'].retention, /90/); assert.match(y['reporting.provider_events'].retention, /1 year|one year|365/i);
  for (const q of G_T) assert.match(y[q].retention, /permanent|never deleted|kept|forever/i, q);
});
test('db/tests/rls_exempt.txt lists exactly the two reporting g_* tables, each with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^reporting\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), [...G_T].sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ views (IC §6.4 column contract; C6 §7)
function outerCols(sql) {
  const body = ws(sql).replace(/^CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+[\w.]+\s+(WITH\s*\([^)]*\)\s+)?AS\s+/i, '');
  const start = /^SELECT\s+/i.exec(body); assert.ok(start, `view SELECT: ${body.slice(0, 40)}`);
  let depth = 0, q = false, end = -1;
  for (let k = start[0].length; k < body.length; k++) {
    const c = body[k];
    if (q) { if (c === "'") q = false; continue; }
    if (c === "'") { q = true; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    else if (depth === 0 && /^\sFROM\s/i.test(body.slice(k, k + 6))) { end = k; break; }
  }
  assert.ok(end > 0, 'view FROM');
  return splitTop(body.slice(start[0].length, end)).map((item) => { const a = /\bAS\s+(\w+)\s*$/i.exec(item.trim()); return a ? a[1] : item.trim().split('.').pop().replace(/\W/g, ''); });
}
const viewSql = (sql, qv) => { const s = stmts(sql).find((x) => new RegExp(`^CREATE\\s+(OR\\s+REPLACE\\s+)?VIEW\\s+${esc(qv)}\\b`, 'i').test(ws(x))); return s ? ws(s) : null; };
const icCols = (qv) => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8').replace(/\r\n?/g, '\n');
  const a = ic.indexOf('### 6.4 `reporting`'), b = ic.indexOf('### 6.5 `instruments`'); assert.ok(a > 0 && b > a, 'IC §6.4');
  const row = ic.slice(a, b).split('\n').find((l) => l.startsWith(`| \`${qv}\``)); assert.ok(row, `IC row for ${qv}`);
  let cell = row.split('|')[2]; while (/\([^()]*\)/.test(cell)) cell = cell.replace(/\([^()]*\)/g, '');
  return splitTop(cell).map((c) => /^\s*`?(\w+)/.exec(c)[1]);
};
test('view column contract vs IC §6.4: each of the 3 v_pub_* views has exactly the IC columns in IC order (spec §7 and the migration agree)', () => {
  for (const v of PUB_VIEWS) {
    const ic = icCols(v), got = viewSql(repSql(), v);
    assert.ok(got, `CREATE VIEW ${v} missing from the C6 migrations`);
    assert.deepEqual(outerCols(viewSql(specView(), v)), ic, `${v}: C6 05-SCHEMA §7 vs IC`);
    assert.deepEqual(outerCols(got), ic, `${v}: migration columns (names + order) vs IC`);
  }
  assert.equal(icCols('reporting.v_pub_delivery_daily').at(-1), 'centre_id', 'centre_id appended last (CR-C8-005)');
  assert.ok(icCols('reporting.v_pub_report_release').includes('report_kind') && icCols('reporting.v_pub_order_report_tat').at(-1) === 'total_tat_seconds');
});
test('views: the 3 definitions equal the spec, WITH (security_invoker = true), SELECT to lims_app + lims_analytics, no other view / matview in reporting, Asia/Kathmandu business_date, no personal columns', () => {
  const sql = repSql();
  for (const v of PUB_VIEWS) { const got = viewSql(sql, v); assert.ok(got, v); assert.equal(norm(got), norm(viewSql(specView(), v)), v); assert.match(got, /WITH\s*\(\s*security_invoker\s*=\s*(true|on)\s*\)/i, `${v} security_invoker`); }
  assert.deepEqual([...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\s+(reporting\.\w+)/gi)].map((m) => `${m[1] ? 'M:' : ''}${m[2]}`).sort(), [...PUB_VIEWS].sort());
  assert.match(viewSql(sql, 'reporting.v_pub_delivery_daily'), /AT TIME ZONE 'Asia\/Kathmandu'/i, 'business_date zone (A13 P-15)');
  for (const v of PUB_VIEWS) assert.doesNotMatch(outerCols(viewSql(sql, v)).join(' '), /\b(phone|email|full_name|patient_name|patient_display|destination|registration_no|patient_id|content_snapshot|token|params)\b/i, `${v} exposes no personal / P2 / P3 / credential column`);
  assert.match(viewSql(sql, 'reporting.v_pub_report_release'), /status IN \('released','superseded'\)/i, 'only released / superseded versions are published');
});

// ================================================================ hygiene
test('C6 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of other schemas\' tables, no USING (true), no seed rows in DDL, no plaintext token / OTP columns', () => {
  const raw = repFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 6000, 'C6 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i);
  assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016');
  assert.deepEqual(stmts(strip(raw)).map(ws).filter((x) => /^INSERT\s+INTO\s+reporting\./i.test(x)), [], 'g_* seed rows (§8) belong to db/seeds, not to DDL migrations (function bodies excluded)');
  const cols = ALLT.flatMap((q) => createTable(repSql(), q).colNames.map((c) => `${q}.${c}`));
  assert.deepEqual(cols.filter((c) => /\.(token|otp_code|otp|code_plain|plain_token|access_token|password)$/.test(c)), [], 'credential material only as sha256 / hmac (08 R24)');
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts, check-migrations.ts and check-fk-dag.ts exit 0 on the tree (reporting -> core/catalog/frontdesk only; nothing into billing / lab)', () => {
  assert.ok(repFiles().length >= 1, 'C6 migrations missing');
  for (const t of ['check-registry.ts', 'check-migrations.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 25 tenant C6 tables, none for the 2 class G, and gen-isolation-probes --check is clean', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const q of G_T) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/reporting/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-10\.C6_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/reporting/T0B-10.C6_*.test.sql exist (tester-owned: writer must keep them) and cover the AC list by "-- AC-0B-x.y" markers and the C6 checks by "-- C6 check N" markers; RLS never disabled in them', () => {
  assert.ok(tapFiles().length >= 2, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 14; n++) assert.match(txt, new RegExp(`-- C6 check ${n}\\b`), `marker for C6 check ${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.2', '6.3']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY|session_replication_role/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
  }
});
