// T0B-10.C2 static checks of the Wave-1 identity DDL translation: db/migrations/*_identity__*.sql, db/policies/identity.sql, db/meta/tables.yaml.
// Spec: C2 05-SCHEMA §1-§11 (esp. §4 tables, §5 RLS, §6/§10.3 functions, §7 no views, §8 seeds, §10.1 DDL, §11 tests); C0 05-SCHEMA §3.8/§10; 08 A10.5, A12, A15,
// A17 P-16/P-18/P-19, A25 D-212/D-215/D-216, A28; AC-0B-2.1..2.4, 3.6 (probes), 4.1..4.3, 5.x, 6.x (static part).
// Run: node --test tests/db/T0B-10.C2.identity.test.mjs   (live assertions: db/tests/identity/T0B-10.C2_*.test.sql, pg_prove; generated probes: db/tests/isolation/identity.*.test.sql)
// Method (as T0B-05): the expected DDL is PARSED FROM C2 05-SCHEMA §10.1/§10.3 at test time and compared (whitespace/case-normalised) with the migrations,
// so a drifting column, constraint, index, trigger, policy, grant or seed row fails here. Function bodies are checked by property; behaviour is the pgTAP files' job.
// T0B10C2_ROOT (optional) points the checks at another tree (db/migrations, db/policies, db/meta, db/tests) — used for scratch validation of this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B10C2_ROOT ? resolve(process.env.T0B10C2_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const idFiles = () => files().filter((f) => /^\d{14}_identity__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const allSql = () => files().map(read).join('\n;\n');
const idSql = () => idFiles().map(read).join('\n;\n');
const polFile = polDir + 'identity.sql';
const polSql = () => (existsSync(polFile) ? strip(readFileSync(polFile, 'utf8')) : '');
const allPolSql = () => (existsSync(polDir) ? readdirSync(polDir).filter((f) => f.endsWith('.sql')).map((f) => strip(readFileSync(polDir + f, 'utf8'))).join('\n;\n') : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05)
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
function createTable(sql, name) {
  const m = new RegExp(`CREATE\\s+(UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name.replace('.', '\\.')}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  const segs = splitTop(balanced(sql, m.index + m[0].length));
  const cons = segs.filter((s) => /^CONSTRAINT\b/i.test(s));
  const cols = segs.filter((s) => !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(s));
  // constraints added later with ALTER TABLE <name> ADD CONSTRAINT <n> ...
  const added = stmts(sql).filter((s) => new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${name.replace('.', '\\.')}\\s+ADD\\s+CONSTRAINT\\b`, 'i').test(ws(s)))
    .map((s) => ws(s).replace(new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${name.replace('.', '\\.')}\\s+ADD\\s+`, 'i'), ''));
  const allCons = [...cons, ...added];
  return {
    cols, cons: allCons, colNames: cols.map((c) => c.split(/\s+/)[0]),
    colMap: new Map(cols.map((c) => [c.split(/\s+/)[0], norm(c)])),
    conMap: new Map(allCons.map((c) => [c.split(/\s+/)[1], norm(c)])),
  };
}
const idxName = (s) => /INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s)[1];
const createIndexes = (sql) => stmts(sql).filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s)).map(ws);
const createTriggers = (sql) => stmts(sql).filter((s) => /^CREATE\s+TRIGGER\b/i.test(s)).map(ws);
function policies(sql) {
  return stmts(sql).filter((s) => /^CREATE\s+POLICY\s+(?!%)/i.test(s)).map((s) => {   // "%I" = dynamic-SQL template inside a DO loop, not a policy
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
function columnGrants(sql) {         // list of {privs, cols, table, roles} for GRANT <priv> (c1, c2) ON t TO r
  const out = [];
  for (const s of stmts(sql)) {
    const m = /^GRANT\s+(SELECT|INSERT|UPDATE|REFERENCES)\s*\(([^)]*)\)\s+ON\s+(?:TABLE\s+)?([\w.]+)\s+TO\s+([\w, ]+)$/i.exec(ws(s));
    if (m) out.push({ priv: m[1].toUpperCase(), cols: m[2].split(',').map((c) => c.trim()).sort(), table: m[3], roles: m[4].split(',').map((r) => r.trim()) });
  }
  return out;
}
function fnExecGrants(sql) {         // Map "schema.fn" -> Set(role) from GRANT EXECUTE ON FUNCTION a(..), b(..) TO r1, r2
  const out = new Map();
  for (const s of stmts(sql)) {
    const m = /^GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([\s\S]+?)\s+TO\s+([\w, ]+)$/i.exec(ws(s));
    if (!m) continue;
    const roles = m[2].split(',').map((r) => r.trim());
    for (const f of splitTop(m[1])) { const n = /^([\w.]+)\s*\(/.exec(f.trim()); if (n) { if (!out.has(n[1])) out.set(n[1], new Set()); roles.forEach((r) => out.get(n[1]).add(r)); } }
  }
  return out;
}
function fnRevokedFromPublic(sql) {  // Set of "schema.fn" with REVOKE ALL|EXECUTE ON FUNCTION ... FROM PUBLIC
  const out = new Set();
  for (const s of stmts(sql)) {
    const m = /^REVOKE\s+(?:ALL|EXECUTE)(?:\s+PRIVILEGES)?\s+ON\s+FUNCTION\s+([\s\S]+?)\s+FROM\s+([\w, ]+)$/i.exec(ws(s));
    if (!m || !/\bPUBLIC\b/i.test(m[2])) continue;
    for (const f of splitTop(m[1])) { const n = /^([\w.]+)\s*\(/.exec(f.trim()); if (n) out.add(n[1]); }
  }
  return out;
}
function fnText(sql, qname) {
  const m = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${qname.replace('.', '\\.')}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  const open = /AS\s+(\$\w*\$)/i.exec(sql.slice(m.index));
  if (!open) return null;
  const bodyStart = m.index + open.index + open[0].length;
  const end = sql.indexOf(open[1], bodyStart);
  return end < 0 ? null : sql.slice(m.index, end + open[1].length);
}

// ---------------------------------------------------------------- spec extraction (C2 05-SCHEMA)
const specPath = repo + 'spec/chunks/C2-identity-admin/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = s.indexOf(b0, a + a0.length); assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const spec101Raw = () => between(specRaw(), '### 10.1 `identity` schema', '### 10.2 ');
const spec101 = () => strip(spec101Raw());
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const spec102 = () => strip(sqlBlocks(between(specRaw(), '### 10.2 ', '### 10.3 ')));
const spec103 = () => strip(between(specRaw(), '### 10.3 ', '## 11. Tests C0 must ship'));

const TENANT_TABLES = ['sessions', 'mfa_factors', 'auth_events', 'invitations', 'platform_staff', 'tenant_settings', 'feature_flags', 'branding_assets', 'support_sessions',
  'ird_annex_records', 'ird_annex_events', 'ird_annex_documents', 'audit_exports', 'access_reviews', 'platform_events', 'admin_notices'];
const G_TABLES = ['g_feature_flags', 'g_breached_passwords'];
const ALL18 = [...TENANT_TABLES, ...G_TABLES];
const APPEND_ONLY = ['auth_events', 'ird_annex_events', 'ird_annex_documents', 'access_reviews', 'platform_events'];   // §11 test 6
const AUDITED = ['tenant_settings', 'feature_flags', 'invitations', 'support_sessions', 'ird_annex_records', 'branding_assets', 'access_reviews', 'mfa_factors'];   // §3 line 53
const NOT_AUDITED_REQUIRED = ['sessions', 'platform_staff', 'platform_events'];   // 08 A12.5
const CLASS = { sessions: ['E'], mfa_factors: ['M'], auth_events: ['A'], invitations: ['M'], platform_staff: ['M'], tenant_settings: ['M'], feature_flags: ['M'],
  g_feature_flags: ['G'], g_breached_passwords: ['G'], branding_assets: ['M'], support_sessions: ['E', 'M'], ird_annex_records: ['M'], ird_annex_events: ['A'],
  ird_annex_documents: ['M'], audit_exports: ['E'], access_reviews: ['A'], platform_events: ['A'], admin_notices: ['E'] };
const FUNCS = ['identity_resolve_session', 'identity_session_by_token', 'identity_login_context', 'identity_user_exists', 'identity_record_auth_event', 'identity_bootstrap_platform_admin',
  'identity_purge_sessions', 'identity_expire_support_sessions', 'identity_expire_invitations', 'identity_expire_audit_exports', 'identity_purge_auth_events',
  'identity_load_breached_batch', 'identity_finish_breached_import', 'identity_platform_auth_write_session_insert', 'identity_platform_auth_write_session_update',
  'identity_platform_auth_write_mfa_factor', 'identity_platform_auth_write_invitation_accept', 'identity_platform_auth_write_staff_login', 'identity_notify_ip_throttle_hmacs',
  'identity_is_breached', 'identity_tenants_for_email_hmacs'];

const specTablesDdl = () => spec101();
const specMatrix = () => [...spec101().matchAll(/\('(\w+)',\s*ARRAY\[([^\]]*)\]\)/g)].map((m) => [m[1], [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1])]);
const PRED_T = 'tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())';
function expectedPolicies() {        // explicit CREATE POLICYs of §10.1 on identity.* + the generated __tenant set
  const explicit = policies(spec101()).filter((p) => p.table.startsWith('identity.'));
  const gen = [];
  for (const [t, cmds] of specMatrix()) for (const c of cmds) {
    gen.push({ name: `${t}__${c}__tenant`, table: `identity.${t}`, key: `${t}__${c}__tenant@identity.${t}`, cmd: c.toUpperCase(), roles: 'lims_app',
      using: c === 'insert' ? '' : norm(PRED_T), check: c === 'select' ? '' : norm(PRED_T) });
  }
  // 08 A28.1 DO-loop of §10.1 (05-SCHEMA.md:1267-1275): 6 policies {mfa_factors,invitations}__{select,insert,update}__platform
  const PRED_P = norm('tenant_id IS NULL AND (SELECT app.is_platform_actor())');
  for (const t of ['mfa_factors', 'invitations']) for (const c of ['select', 'insert', 'update']) {
    gen.push({ name: `${t}__${c}__platform`, table: `identity.${t}`, key: `${t}__${c}__platform@identity.${t}`, cmd: c.toUpperCase(), roles: 'lims_app',
      using: c === 'insert' ? '' : PRED_P, check: c === 'select' ? '' : PRED_P });
  }
  return { explicit, gen, all: [...explicit, ...gen] };
}

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: §10.1 yields 18 identity tables, 14-row tenant policy matrix, the §10.3 function set', () => {
  const ddl = specTablesDdl();
  for (const t of ALL18) assert.ok(createTable(ddl, `identity.${t}`), `spec has identity.${t}`);
  assert.equal(specMatrix().length, 14, 'tenant policy matrix rows');
  assert.equal(specMatrix().flatMap(([, c]) => c).length, 33, '33 generated __tenant policies');
  const names = [...spec103().matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+app\.(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(names)].sort(), [...FUNCS].sort(), 'function list in this test = §10.3');
  assert.ok(expectedPolicies().explicit.length >= 30, `explicit policies parsed (${expectedPolicies().explicit.length})`);
  assert.equal(stmts(spec101()).filter((x) => /^CREATE\s+POLICY\s+(?!%)/i.test(x)).length, policies(spec101()).length, 'every spec CREATE POLICY parsed');
  assert.equal(createTriggers(ddl).length, 4, '4 CREATE TRIGGER in §10.1 (2 mutable_columns + 2 check)');
  assert.ok(createIndexes(ddl).length >= 25);
});

// ================================================================ files
test('migration files: >= 1 db/migrations/<14 digits>_identity__<name>.sql, strictly after the C0 foundation migrations; db/policies/identity.sql exists', () => {
  assert.ok(idFiles().length >= 1, 'no db/migrations/*_identity__*.sql yet (T0B-10.C2 writer creates them)');
  const all = files();
  const stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  assert.ok(existsSync(polFile), 'db/policies/identity.sql missing (canonical CREATE POLICY copy, AC-0B-2.3)');
});

// ================================================================ tables
for (const t of ALL18) {
  test(`identity.${t}: columns, constraints (names + text) equal 05-SCHEMA §10.1`, () => {
    const sql = idSql();
    const exp = createTable(specTablesDdl(), `identity.${t}`);
    const got = createTable(sql, `identity.${t}`);
    assert.ok(got, `CREATE TABLE identity.${t} not found in *_identity__*.sql`);
    for (const [c, def] of exp.colMap) assert.equal(got.colMap.get(c), def, `identity.${t}.${c}`);
    assert.deepEqual([...got.colMap.keys()].sort(), [...exp.colMap.keys()].sort(), `identity.${t} column set`);
    for (const [c, def] of exp.conMap) assert.equal(got.conMap.get(c), def, `identity.${t} constraint ${c}`);
    assert.deepEqual([...got.conMap.keys()].sort(), [...exp.conMap.keys()].sort(), `identity.${t} constraint set (no extra, no missing)`);
  });
}
test('no ENUM types (CV §5.1); no identity table created outside the 18 (+ event_inbox of T0B-05)', () => {
  const sql = idSql();
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i);
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?identity\.(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALL18].sort(), 'exactly the 18 §4 tables');
});
test('indexes: every §10.1 CREATE INDEX present with identical definition', () => {
  const have = new Map(createIndexes(idSql()).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specTablesDdl());
  assert.ok(exp.length >= 25);
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  // partial / unique spot checks that matter for security
  assert.ok(have.has('sessions__previous_token_sha256__p_uq'), 'CR-C2-018 previous-token unique index');
  assert.match(have.get('sessions__previous_token_sha256__p_uq'), /unique/);
});
test('schema identity exists (AUTHORIZATION lims_owner) and USAGE granted to lims_app only', () => {
  const sql = allSql();
  assert.match(sql, /CREATE\s+SCHEMA\s+(IF\s+NOT\s+EXISTS\s+)?identity\b/i);
  const usage = stmts(sql).map(ws).filter((s) => /^GRANT\s+USAGE\s+ON\s+SCHEMA\s+identity\b/i.test(s));
  assert.ok(usage.some((s) => /\bTO\s+lims_app\b/i.test(s)), 'GRANT USAGE ON SCHEMA identity TO lims_app');
  assert.ok(usage.every((s) => !/\b(PUBLIC|anon|authenticated)\b/i.test(s)), usage.join('; '));
});

// ================================================================ RLS
test('ENABLE + FORCE ROW LEVEL SECURITY on the 16 non-g tables; none on g_* (AC-0B-2.1)', () => {
  const sql = idSql();
  for (const t of TENANT_TABLES) {
    const lit = (kw) => new RegExp(`ALTER\\s+TABLE\\s+identity\\.${t}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(sql);
    // either literal statements, or the spec's loop form: the table name listed in an array next to format('ALTER TABLE identity.%I ENABLE/FORCE ...')
    const loop = new RegExp(`'${t}'`).test(sql) && /ALTER\s+TABLE\s+identity\.%I\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql) && /ALTER\s+TABLE\s+identity\.%I\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql);
    assert.ok((lit('ENABLE') && lit('FORCE')) || loop, `identity.${t}: ENABLE and FORCE ROW LEVEL SECURITY`);
  }
  for (const t of G_TABLES) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+identity\\.${t}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${t} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i, 'RLS is never disabled (AC-0B-2.4)');
});
test('policies: db/policies/identity.sql holds EXACTLY the §10.1 policy set (name, command, role, USING, WITH CHECK); no extra policy', () => {
  const got = policies(polSql()).filter((p) => p.table.startsWith('identity.'));
  assert.ok(got.length > 0, 'db/policies/identity.sql has no CREATE POLICY');
  const byKey = new Map(got.map((p) => [p.key, p]));
  assert.equal(byKey.size, got.length, 'no duplicate policy name per table');
  const { all } = expectedPolicies();
  for (const e of all) {
    const g = byKey.get(e.key);
    assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`);
    assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(g.using, e.using, `${e.key} USING`);
    assert.equal(g.check, e.check, `${e.key} WITH CHECK`);
  }
  assert.deepEqual([...byKey.keys()].sort(), all.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access)');
});
test('every __tenant policy carries is_staff_or_system in USING and WITH CHECK (P-16); no uncast centre predicate; no policy TO PUBLIC/anon/authenticated', () => {
  const ps = policies(polSql()).filter((x) => x.table.startsWith('identity.'));
  assert.ok(ps.length >= 70, `db/policies/identity.sql has ${ps.length} identity policies, expected the full §10.1 set`);
  for (const p of ps) {
    if (/__tenant$/.test(p.name)) {
      if (p.cmd !== 'INSERT') assert.match(p.using, /app\.is_staff_or_system\(\)/, `${p.key} USING`);
      if (p.cmd !== 'SELECT') assert.match(p.check, /app\.is_staff_or_system\(\)/, `${p.key} WITH CHECK`);
    }
    assert.doesNotMatch(p.roles, /\b(public|anon|authenticated|service_role)\b/i, p.key);
    assert.match(p.roles, /^(lims_app|lims_owner)$/, `${p.key} roles`);
    if (/__owner_only$/.test(p.name)) assert.equal(p.roles, 'lims_owner', `${p.key} owner policy is TO lims_owner only`);
  }
});
test('GUC-bound policies (app.pre_* / app.maintenance) are TO lims_owner only, never lims_app (08 A12.1, A15.3)', () => {
  for (const p of policies(polSql() + '\n;\n' + idSql()).filter((x) => x.table.startsWith('identity.'))) {
    if (/app\.pre_|app\.maintenance/.test(p.using + p.check)) assert.equal(p.roles, 'lims_owner', `${p.key}: ${p.roles}`);
  }
});
test('platform-only tables keep the owner-only select/insert policies for app.is_platform_actor() / bootstrap (08 A10.5, A12.5)', () => {
  const keys = new Set(policies(polSql()).map((p) => p.key));
  for (const k of ['platform_staff__select__owner_only@identity.platform_staff', 'platform_staff__insert__owner_only@identity.platform_staff',
    'platform_events__insert__owner_only@identity.platform_events', 'platform_staff__update__owner_only@identity.platform_staff']) assert.ok(keys.has(k), k);
});
test('core.tenants __platform policies (C2 §10.2) exist as DDL and in db/policies', () => {
  const exp = policies(spec102()).filter((p) => p.table === 'core.tenants');
  assert.equal(exp.length, 3);
  const have = new Map([...policies(allSql()), ...policies(allPolSql())].map((p) => [p.key, p]));
  for (const e of exp) { const g = have.get(e.key); assert.ok(g, `missing ${e.key}`); assert.equal(g.using, e.using, e.key); assert.equal(g.check, e.check, e.key); }
  const inPolicies = new Map(policies(allPolSql()).map((p) => [p.key, p]));
  for (const e of exp) assert.ok(inPolicies.has(e.key), `${e.key} also in db/policies/*.sql (AC-0B-2.3 canonical copy)`);
});
test('policies in migrations (literal CREATE POLICY) are a subset of db/policies/identity.sql (AC-0B-2.3 copy)', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  for (const p of policies(idSql()).filter((x) => x.table.startsWith('identity.'))) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
});

// ================================================================ grants (AC-0B-4.2 / 4.3, §11 tests 5, 6, 29)
test('table grants: exactly the §10.1 set to lims_app; no DELETE/TRUNCATE/REFERENCES/TRIGGER anywhere; nothing to other roles', () => {
  const g = tableGrants(idSql());
  const want = (t) => (G_TABLES.includes(t) ? ['SELECT'] : APPEND_ONLY.includes(t) ? ['INSERT', 'SELECT'] : ['INSERT', 'SELECT', 'UPDATE']);
  for (const t of ALL18) {
    const rm = g.get(`identity.${t}`);
    assert.ok(rm, `no GRANT on identity.${t}`);
    assert.deepEqual([...rm.keys()], ['lims_app'], `identity.${t} granted to lims_app only`);
    assert.deepEqual([...rm.get('lims_app')].sort(), want(t), `identity.${t} privileges`);
  }
  for (const [t, rm] of g) if (t.startsWith('identity.')) for (const [r, ps] of rm) {
    for (const bad of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!ps.has(bad), `${t} ${r} must not hold ${bad}`);
  }
  assert.doesNotMatch(idSql(), /GRANT\s+ALL\b[^;]*\bidentity\./i);
  assert.doesNotMatch(idSql(), /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+identity\b/i);
  assert.doesNotMatch(idSql(), /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*identity/i);
});
test('column grant: lims_app holds UPDATE (scan_state) on identity.ird_annex_documents and nothing else column-wise (P-19)', () => {
  const cg = columnGrants(idSql()).filter((c) => c.table.startsWith('identity.'));
  assert.deepEqual(cg.map((c) => `${c.priv}:${c.table}:${c.cols.join(',')}:${c.roles.join(',')}`), ['UPDATE:identity.ird_annex_documents:scan_state:lims_app']);
});
test('no GRANT on identity tables/sequences/functions to PUBLIC, anon, authenticated, service_role', () => {
  for (const s of stmts(idSql()).map(ws)) if (/^GRANT\b/i.test(s) && /\bidentity\.|\bapp\.identity_/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role)\b/i, s);
});

// ================================================================ triggers
test('triggers: the four §10.1 triggers (2 mutable_columns, tenant_settings__check_arrays, feature_flags__check_approval) and their functions equal the spec', () => {
  const have = new Map(createTriggers(idSql()).map((s) => [/TRIGGER\s+(\w+)/i.exec(s)[1], norm(s)]));
  for (const s of createTriggers(specTablesDdl())) { const n = /TRIGGER\s+(\w+)/i.exec(s)[1]; assert.equal(have.get(n), norm(s), `trigger ${n}`); }
  for (const f of ['identity.tenant_settings__check_arrays', 'identity.feature_flags__check_approval']) {
    const exp = fnText(specTablesDdl(), f), got = fnText(idSql(), f);
    assert.ok(got, `${f} missing`); assert.equal(norm(got), norm(exp), f);
  }
});
test('immutability (AC-0B-4.1): branding_assets and ird_annex_documents are BEFORE UPDATE FOR EACH ROW with app.enforce_mutable_columns(...) naming only the mutable columns', () => {
  const trg = createTriggers(idSql());
  const b = trg.find((s) => /branding_assets__mutable_columns/.test(s)), d = trg.find((s) => /ird_annex_documents__mutable_columns/.test(s));
  assert.ok(b && d);
  for (const s of [b, d]) assert.match(s, /BEFORE\s+UPDATE\s+ON\s+identity\.\w+\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+FUNCTION\s+app\.enforce_mutable_columns\(/i);
  assert.match(d, /enforce_mutable_columns\(\s*'scan_state'\s*\)/i, 'ird_annex_documents: only scan_state mutable');
  assert.doesNotMatch(d, /DELETE|OR\s+INSERT/i);
});
test('audit triggers (app.tg_row_audit) on exactly the audited identity tables; none on sessions / platform_staff / platform_events (08 A12.5)', () => {
  const trg = createTriggers(idSql()).filter((s) => /app\.tg_row_audit\(\)/i.test(s));
  const onTable = (t) => trg.filter((s) => new RegExp(`\\bON\\s+identity\\.${t}\\b`, 'i').test(s));
  for (const t of AUDITED) {
    const hit = onTable(t);
    assert.equal(hit.length, 1, `identity.${t} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${t}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+identity\\.${t}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(\\)`, 'i'));
  }
  for (const t of NOT_AUDITED_REQUIRED) assert.equal(onTable(t).length, 0, `identity.${t} must NOT be audited`);
});

// ================================================================ seeds
test('migration seed: identity.g_feature_flags holds exactly the five §8 rows (values verbatim from §10.1)', () => {
  const rowsOf = (sql) => { const m = /INSERT\s+INTO\s+identity\.g_feature_flags\s*\([^)]*\)\s*VALUES([\s\S]*?)(?:ON\s+CONFLICT[\s\S]*)?$/i.exec(ws(stmts(sql).find((s) => /INSERT\s+INTO\s+identity\.g_feature_flags/i.test(s)) ?? '')); return m ? splitTop(m[1]).map(norm).sort() : null; };
  const exp = rowsOf(specTablesDdl()), got = rowsOf(idSql());
  assert.equal(exp.length, 5);
  assert.ok(got, 'no INSERT INTO identity.g_feature_flags in *_identity__*.sql');
  assert.deepEqual(got, exp);
  assert.doesNotMatch(idSql(), /INSERT\s+INTO\s+identity\.g_breached_passwords[^;]*\bVALUES\b/i, 'breached list is not in the repo (§8)');
});

// ================================================================ functions
test('§10.3 functions: all 21 exist in db/migrations; DEFINER ones pin search_path = \'\'; REVOKE ALL FROM PUBLIC; EXECUTE grants = spec; none to PUBLIC/anon/authenticated', () => {
  const sql = allSql(), spec = spec103();
  const grants = fnExecGrants(sql), expG = fnExecGrants(spec), revoked = fnRevokedFromPublic(sql);
  for (const f of FUNCS) {
    const q = `app.${f}`, got = fnText(sql, q), exp = fnText(spec, q);
    assert.ok(got, `${q} missing from db/migrations`);
    const definer = /SECURITY\s+DEFINER/i.test(exp);
    assert.equal(/SECURITY\s+DEFINER/i.test(got), definer, `${q} SECURITY DEFINER = ${definer}`);
    assert.match(got, /SET\s+search_path\s*=\s*''/i, `${q} pins search_path`);
    assert.ok(revoked.has(q), `${q}: REVOKE ... FROM PUBLIC`);
    assert.deepEqual([...(grants.get(q) ?? [])].sort(), [...(expG.get(q) ?? [])].sort(), `${q} EXECUTE grantees`);
    for (const r of grants.get(q) ?? []) assert.doesNotMatch(r, /^(public|anon|authenticated|service_role)$/i, q);
  }
});
test('app.identity_is_breached (new in C2; deferred from T0B-06 by CR-C0-T0B-06) equals §10.3, is INVOKER, and is not in the DEFINER inventory', () => {
  const got = fnText(allSql(), 'app.identity_is_breached'), exp = fnText(spec103(), 'app.identity_is_breached');
  assert.ok(got); assert.equal(norm(got), norm(exp)); assert.doesNotMatch(got, /SECURITY\s+DEFINER/i);
  const inv = readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8');
  assert.doesNotMatch(inv, /"app\.identity_is_breached"/);
});
test('every identity DEFINER in the spec is in db/meta/definer-inventory.yaml with owner lims_owner and the spec EXECUTE grantee', () => {
  const inv = JSON.parse(strip(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, ''))).definers;
  const expG = fnExecGrants(spec103());
  for (const f of FUNCS.filter((x) => x !== 'identity_is_breached')) {
    const e = inv[`app.${f}`]; assert.ok(e, `inventory entry app.${f}`);
    assert.equal(e.owner, 'lims_owner'); assert.deepEqual([...e.execute].sort(), [...(expG.get(`app.${f}`) ?? [])].sort(), `app.${f} execute`);
  }
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
test('tables.yaml: 18 identity tables registered with class, centre_scoped=false, audited, retention, phi_class P0-P3 per column = DDL columns (REQ-SEC-004)', () => {
  const y = tablesYaml();
  for (const t of ALL18) {
    const e = y[`identity.${t}`]; assert.ok(e, `identity.${t} in tables.yaml`);
    assert.ok(CLASS[t].includes(e.class), `identity.${t} class ${e.class} not in ${CLASS[t]}`);
    assert.equal(e.centre_scoped, false, `identity.${t} centre_scoped`);
    assert.equal(e.audited, AUDITED.includes(t), `identity.${t} audited`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `identity.${t} retention`);
    const cols = createTable(specTablesDdl(), `identity.${t}`).colNames;
    assert.deepEqual(Object.keys(e.columns).sort(), [...cols].sort(), `identity.${t} columns = DDL columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `identity.${t}.${c} phi_class`);
  }
  assert.ok(y['identity.event_inbox'], 'T0B-05 inbox entry kept');
});
test('tables.yaml: shared_with [partner] only on sessions and mfa_factors; rls_exempt only on g_*; tables without tenant_id list the exception (08 A19 D-101, A17 P-16)', () => {
  const y = tablesYaml();
  for (const t of ALL18) {
    const e = y[`identity.${t}`]; assert.ok(e, t);
    const sw = e.shared_with ?? [];
    if (t === 'sessions' || t === 'mfa_factors') assert.deepEqual(sw, ['partner'], `${t} shared_with`); else assert.deepEqual(sw, [], `${t} must not be shared`);
    if (G_TABLES.includes(t)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${t} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${t} must not be rls_exempt`);
    const ddlCols = createTable(specTablesDdl(), `identity.${t}`).colNames;
    if (!ddlCols.includes('tenant_id') && !G_TABLES.includes(t)) assert.ok((e.mandatory_column_exceptions ?? []).includes('tenant_id') && e.mandatory_column_exceptions_reason, `identity.${t} has no tenant_id: list it in mandatory_column_exceptions with a reason (gate 9)`);
  }
});
test('db/tests/rls_exempt.txt lists identity.g_feature_flags and identity.g_breached_passwords with a reason, and nothing else from identity (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const idl = lines.filter((l) => l.startsWith('identity.'));
  assert.deepEqual(idl.map((l) => l.split(/\s+/)[0]).sort(), ['identity.g_breached_passwords', 'identity.g_feature_flags']);
  for (const l of idl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ views (C2 publishes none: C2 05-SCHEMA §7; IC §6)
test('view contract vs IC §6: IC §6 has no identity/core section; no identity.v_pub_* / core.v_pub_* view is created anywhere', () => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8').replace(/\r\n?/g, '\n');
  const sec = ic.slice(ic.indexOf('## 6. Published read views'), ic.indexOf('\n## 7.', ic.indexOf('## 6. Published read views')));
  assert.ok(sec.length > 500, 'IC §6 located');
  assert.doesNotMatch(sec, /^###\s+6\.\d+\s+`(identity|core)`/m, 'IC §6 lists no identity/core views');
  assert.doesNotMatch(allSql() + allPolSql(), /CREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\s+(identity|core)\./i);
  assert.doesNotMatch(allSql(), /\b(identity|core)\.v_pub_/i);
  assert.match(readFileSync(specPath, 'utf8'), /C2 publishes none/);
});

// ================================================================ hygiene
test('identity migrations: no secrets/real data, no destructive DDL on other schemas, no BYPASSRLS/SUPERUSER, no dynamic-SQL concatenation of identifiers without %I', () => {
  const raw = idFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i);
  assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit)\./i, 'C2 migrations do not alter C0 tables (C0 wins on conflict)');
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\bformat\s*\([^)]*%s[^)]*identity\.%s/i);
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts and check-migrations.ts and check-fk-dag.ts exit 0 on the tree', () => {
  for (const t of ['check-registry.ts', 'check-migrations.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 16 non-g identity tables, and gen-isolation-probes --check is clean', () => {
  for (const t of TENANT_TABLES) assert.ok(existsSync(root + `db/tests/isolation/identity.${t}.test.sql`), `db/tests/isolation/identity.${t}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const t of G_TABLES) assert.ok(!existsSync(root + `db/tests/isolation/identity.${t}.test.sql`), `class G ${t} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const t of ALL18) assert.match(reg, new RegExp(`'identity\\.${t}'`), `_registry.sql lists identity.${t}`);
});
test('inbox present: identity.event_inbox migration + registry entry from T0B-05 intact (done_when)', () => {
  assert.match(allSql(), /CREATE\s+TABLE\s+identity\.event_inbox\b/i);
  assert.ok(existsSync(root + 'db/tests/isolation/identity.event_inbox.test.sql'));
});

// ================================================================ pgTAP suites present and complete
const T = root + 'db/tests/identity/';
const tapFiles = () => (existsSync(T) ? readdirSync(T).filter((f) => /^T0B-10\.C2_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/identity/T0B-10.C2_*.test.sql exist and cover every C2 05-SCHEMA §11 test (1-35) by a "-- §11 test N" marker', () => {
  assert.ok(tapFiles().length >= 4, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(T + f, 'utf8')).join('\n');
  for (let n = 1; n <= 35; n++) assert.match(txt, new RegExp(`-- §11 test ${n}\\b`), `marker for §11 test ${n}`);
  for (const f of tapFiles()) {
    const s = readFileSync(T + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY|session_replication_role/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
  }
});
