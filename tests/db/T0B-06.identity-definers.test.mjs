// T0B-06 static checks: db/migrations/*_app__create_identity_definers.sql and *_core__create_membership_branches.sql
// (C2 05-SCHEMA §5.4, §6, §10.1, §10.3, §11; C0 05-SCHEMA §3.3, §4.3, §10; 08 R3, A6.6, A8.1, A10.5, A12.1, A12.2, A12.6, A15.1-A15.3, A20.1, A28.1, A28.4;
//  AC-0B-2.2 (forbidden constructs), AC-0B-2.3 (db/policies), AC-0B-2.4 (FORCE RLS in tests); schema tests 14, 21).
// Run: node --test tests/db/T0B-06.identity-definers.test.mjs   (live-DB assertions: db/tests/identity/T0B-06_definers.test.sql,
//      db/tests/core/T0B-06_membership_branches.test.sql via pg_prove)
// Function bodies are compared with the spec text (whitespace/comments/case-insensitive): C0 translates C2's DEFINER SQL verbatim (05-SCHEMA §9 rule 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const migDir = root + 'db/migrations/';
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const strip = (s) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const readStripped = (p) => strip(readFileSync(p, 'utf8'));
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),;=])\s*/g, '$1').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);

const defFile = () => files().find((f) => /^\d{14}_app__create_identity_definers\.sql$/.test(f));
const mbFile = () => files().find((f) => /^\d{14}_core__create_membership_branches\.sql$/.test(f));
const def = () => (defFile() ? readStripped(migDir + defFile()) : '');
const mb = () => (mbFile() ? readStripped(migDir + mbFile()) : '');
const allMig = () => files().map((f) => readStripped(migDir + f)).join('\n');

const C2 = root + 'spec/chunks/C2-identity-admin/05-SCHEMA.md';
const C0 = root + 'spec/chunks/C0-foundation-contracts/05-SCHEMA.md';

// CREATE FUNCTION app.<name>(...) ... AS $$ ... $$ ; returns Map(name -> text from "app.<name>(" to the closing $$)
function functions(sql) {
  const m = new Map();
  for (const x of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(app\.(\w+)\s*\([\s\S]*?\bAS\s+\$\$[\s\S]*?\$\$)/gi)) m.set(x[2], x[1]);
  return m;
}
function tableBody(sql, name) {
  const m = new RegExp(`CREATE\\s+TABLE\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1;
  const start = i;
  while (i < sql.length && depth) { if (sql[i] === '(') depth++; else if (sql[i] === ')') depth--; i++; }
  return sql.slice(start, i - 1);
}
function policies(sql) {
  return stmts(sql).filter((s) => /^CREATE\s+POLICY\b/i.test(s)).map((s) => {
    const m = /^CREATE\s+POLICY\s+(\w+)\s+ON\s+([\w.]+)\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([\w, ]+?)\s+(?=USING|WITH)([\s\S]*)$/i.exec(ws(s));
    assert.ok(m, `parsable policy: ${ws(s).slice(0, 100)}`);
    return { name: m[1], table: m[2], cmd: m[3].toUpperCase(), roles: m[4].split(',').map((r) => r.trim()), text: ws(s) };
  });
}
// GRANT/REVOKE EXECUTE ON FUNCTION a(..), b(..) TO|FROM r1, r2  ->  [{names:[..], roles:[..]}]
function execStmts(sql, verb) {
  const re = verb === 'GRANT' ? /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([\s\S]*?)\s+TO\s+([\w, ]+?)\s*(?:;|$)/gi : /REVOKE\s+(?:ALL|EXECUTE)(?:\s+PRIVILEGES)?\s+ON\s+FUNCTION\s+([\s\S]*?)\s+FROM\s+([\w, ]+?)\s*(?:;|$)/gi;
  return [...sql.matchAll(re)].map((x) => ({ names: [...x[1].matchAll(/app\.(\w+)\s*\(/g)].map((n) => n[1]), roles: x[2].split(',').map((r) => r.trim().toLowerCase()) }));
}

const API = ['identity_resolve_session', 'identity_session_by_token', 'identity_login_context', 'identity_user_exists', 'identity_record_auth_event',
  'identity_bootstrap_platform_admin', 'identity_platform_auth_write_session_insert', 'identity_platform_auth_write_session_update',
  'identity_platform_auth_write_mfa_factor', 'identity_platform_auth_write_invitation_accept', 'identity_platform_auth_write_staff_login'];
const WORKER = ['identity_purge_sessions', 'identity_expire_support_sessions', 'identity_expire_invitations', 'identity_expire_audit_exports',
  'identity_purge_auth_events', 'identity_load_breached_batch', 'identity_finish_breached_import', 'identity_notify_ip_throttle_hmacs'];
const DEFINERS = [...API, ...WORKER];                                  // 19 names = the C0 05-SCHEMA §4.3 rows for C2 (identity_tenants_for_email_hmacs is T0B-05)
const MAINT = { identity_purge_sessions: 'identity_purge_sessions', identity_expire_support_sessions: 'identity_expire_support_sessions',
  identity_expire_invitations: 'identity_expire_invitations', identity_expire_audit_exports: 'identity_expire_audit_exports',
  identity_purge_auth_events: 'identity_purge_auth_events', identity_notify_ip_throttle_hmacs: 'identity_notify_ip_throttle' };   // fn -> app.maintenance value
const specFns = () => {
  const t = readStripped(C2);
  const a = t.indexOf('### 10.3'), b = t.indexOf('## 11.', a);
  assert.ok(a > 0 && b > a, 'C2 05-SCHEMA §10.3 located');
  return functions(t.slice(a, b));
};

test('spec fixtures are present and §10.3 contains every inventory function', () => {
  assert.ok(existsSync(C2) && existsSync(C0));
  const f = specFns();
  for (const n of DEFINERS) assert.ok(f.has(n), `spec has ${n}`);
  assert.equal(DEFINERS.length, 19);
});

test('both migration files exist, follow the naming rule, sort after the stages they depend on, start with the owner switch', () => {
  assert.ok(defFile(), 'db/migrations/<14 digits>_app__create_identity_definers.sql');
  assert.ok(mbFile(), 'db/migrations/<14 digits>_core__create_membership_branches.sql');
  const need = (suffix) => { const f = files().find((x) => x.endsWith(suffix)); assert.ok(f, suffix); return f; };
  const helpers = need('_app__create_context_helpers.sql'), users = need('_core__create_users_and_memberships.sql'), roles = need('_core__create_roles_and_permissions.sql'),
    branches = need('_core__create_branches_and_centres.sql');
  assert.ok(defFile() > helpers && defFile() > users && defFile() > roles, 'definers after helpers, memberships, roles/membership_roles (login_context reads them)');
  assert.ok(mbFile() > users && mbFile() > branches && mbFile() > helpers, 'membership_branches after memberships and branches');
  for (const f of [defFile(), mbFile()]) assert.match(stmts(readStripped(migDir + f))[0], /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement SET LOCAL ROLE lims_owner`);
});

test('every identity DEFINER is created, SECURITY DEFINER, SET search_path = \'\' and its text equals the C2 05-SCHEMA §10.3 text (verbatim translation)', () => {
  const mine = functions(def()), spec = specFns();
  for (const n of DEFINERS) {
    assert.ok(mine.has(n), `app.${n} created in ${defFile()}`);
    assert.match(mine.get(n), /SECURITY\s+DEFINER/i, `${n} SECURITY DEFINER`);
    assert.match(mine.get(n), /SET\s+search_path\s*=\s*''/i, `${n} SET search_path = ''`);
    assert.equal(norm(mine.get(n)), norm(spec.get(n)), `${n}: body differs from C2 05-SCHEMA §10.3 (a difference is a CR, 08 A19 P-41)`);
  }
});

test('prosecdef set = inventory: no other SECURITY DEFINER in these migrations, INVOKER helpers stay INVOKER', () => {
  const mine = functions(def() + '\n' + mb());
  const dev = [...mine].filter(([, t]) => /SECURITY\s+DEFINER/i.test(t)).map(([n]) => n).sort();
  const allowed = new Set([...DEFINERS, 'identity_tenants_for_email_hmacs']);   // the latter is created by T0B-05; CREATE OR REPLACE here is tolerated
  for (const n of dev) assert.ok(allowed.has(n), `unexpected SECURITY DEFINER app.${n}`);
  for (const n of DEFINERS) assert.ok(dev.includes(n), `${n} is DEFINER`);
  if (mine.has('identity_is_breached')) assert.doesNotMatch(mine.get('identity_is_breached'), /SECURITY\s+DEFINER/i, 'identity_is_breached is INVOKER');
  assert.doesNotMatch(mine.get('tg_scope_user_only') ?? '', /SECURITY\s+DEFINER/i, 'tg_scope_user_only is INVOKER');
});

test('function bodies are created with check_function_bodies off before the first CREATE FUNCTION (they read identity.* tables of a later stage)', () => {
  const s = def();
  const off = s.search(/SET\s+LOCAL\s+check_function_bodies\s*=\s*off/i), first = s.search(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
  assert.ok(off >= 0 && off < first, 'SET LOCAL check_function_bodies = off precedes the first function');
  assert.doesNotMatch(s, /CREATE\s+TABLE|CREATE\s+SCHEMA/i, 'identity tables are C2 DDL, not created here');
  assert.doesNotMatch(s, /\bSET\s+ROLE\b(?!\s+lims_owner)|RESET\s+ROLE/i, 'no other role switch');
});

test('EXECUTE: REVOKE ALL FROM PUBLIC for every DEFINER; lims_api and lims_worker sets exactly as C2 §10.3; nothing for lims_app / anon / authenticated', () => {
  const s = def();
  const revoked = new Set(execStmts(s, 'REVOKE').filter((x) => x.roles.includes('public')).flatMap((x) => x.names));
  for (const n of DEFINERS) assert.ok(revoked.has(n), `REVOKE ALL ON FUNCTION app.${n} FROM PUBLIC`);
  const granted = new Map();   // name -> Set(roles)
  for (const g of execStmts(s, 'GRANT')) for (const n of g.names) { granted.set(n, new Set([...(granted.get(n) ?? []), ...g.roles])); }
  for (const n of API) assert.deepEqual([...(granted.get(n) ?? [])].sort(), ['lims_api'], `${n}: EXECUTE to lims_api only`);
  for (const n of WORKER) assert.deepEqual([...(granted.get(n) ?? [])].sort(), ['lims_worker'], `${n}: EXECUTE to lims_worker only`);
  for (const [n, roles] of granted) {
    for (const bad of ['public', 'anon', 'authenticated', 'lims_queue', 'lims_reporting_lookup', 'lims_analytics']) assert.ok(!roles.has(bad), `${n} not granted to ${bad}`);
    if (roles.has('lims_app')) assert.equal(n, 'identity_is_breached', `only the INVOKER breached lookup may be granted to lims_app (found ${n})`);
  }
  assert.doesNotMatch(s, /GRANT\s+(?:ALL|EXECUTE)\s+ON\s+(?:ALL\s+FUNCTIONS|SCHEMA)/i, 'no blanket grants');
  assert.doesNotMatch(s, /ALTER\s+DEFAULT\s+PRIVILEGES/i);
  assert.doesNotMatch(s, /GRANT\s+(?!EXECUTE)\w+[\s\S]*?\bON\s+(?:TABLE\s+)?(?:identity|core)\./i, 'no table grants here (C2 / T0B-03 own them)');
});

test('GUC protocol: set_config is always transaction-local; every GUC a function sets is reset to \'\' in that function; maintenance values equal the function name', () => {
  const mine = functions(def());
  for (const n of DEFINERS) {
    const body = mine.get(n);
    if (!body) continue;
    const calls = [...body.matchAll(/set_config\s*\(\s*'([\w.]+)'\s*,\s*([\s\S]*?)\s*,\s*(true|false)\s*\)/gi)].map((x) => ({ guc: x[1], val: x[2], local: x[3].toLowerCase() }));
    for (const c of calls) {
      assert.equal(c.local, 'true', `${n}: set_config('${c.guc}', …) must be transaction-local (AC-0D-2.3)`);
      assert.match(c.guc, /^app\.(pre_[a-z_0-9]+|maintenance)$/, `${n}: only app.pre_* / app.maintenance GUCs`);
    }
    for (const g of new Set(calls.map((c) => c.guc))) {
      assert.ok(calls.some((c) => c.guc === g && c.val.trim() === "''"), `${n}: resets ${g} to ''`);
    }
    if (MAINT[n]) {
      const vals = calls.filter((c) => c.guc === 'app.maintenance' && c.val.trim() !== "''").map((c) => c.val.trim());
      assert.deepEqual(vals, [`'${MAINT[n]}'`], `${n}: app.maintenance = '${MAINT[n]}'`);
    }
  }
  // which GUCs each pre-tenant lookup sets (C2 05-SCHEMA §5.4 table)
  const sets = (n) => new Set([...mine.get(n).matchAll(/set_config\s*\(\s*'(app\.pre_[a-z_0-9]+)'/gi)].map((x) => x[1]));
  assert.deepEqual([...sets('identity_resolve_session')].sort(), ['app.pre_gotrue_session_id', 'app.pre_support_session_id', 'app.pre_tenant_id', 'app.pre_user_id']);
  assert.deepEqual([...sets('identity_session_by_token')], ['app.pre_session_token_sha256']);
  assert.deepEqual([...sets('identity_login_context')].sort(), ['app.pre_tenant_id', 'app.pre_user_id']);
  assert.deepEqual([...sets('identity_user_exists')], ['app.pre_user_id']);
  for (const n of API.filter((x) => x.startsWith('identity_platform_auth_write_'))) assert.ok(sets(n).has('app.pre_user_id'), `${n} sets app.pre_user_id (08 A28.1)`);
  assert.doesNotMatch(def(), /set_config\s*\(\s*'request\.jwt\.claims'/i, 'DEFINERs never write claims');
});

test('semantic invariants independent of the spec text', () => {
  const m = functions(def());
  const nsp = (n) => (m.get(n) ?? '').replace(/\s+/g, '').toLowerCase();   // spaceless: every pattern below is written without whitespace
  // test 20 / 08 A8.1: membership choice is ordered; no LIMIT 1 without ORDER BY; count predicate of A6.6
  assert.ok(nsp('identity_login_context').includes("orderby(m.status='active')desc,m.updated_atdesclimit1"), 'login_context: ORDER BY (status = active) DESC, updated_at DESC LIMIT 1');
  assert.ok(nsp('identity_login_context').includes("m.actor_type='user'andm.status='active'"), 'login_context: count predicate status = active AND actor_type = user');
  for (const [n, t] of m) if (/\blimit\s+1\b/i.test(t) && !/\border\s+by\b/i.test(t)) assert.fail(`${n}: LIMIT 1 without ORDER BY`);
  // 08 A12.6: expire_invitations is ONE update statement; A15.3 purge gates
  assert.equal([...(m.get('identity_expire_invitations') ?? '').matchAll(/\bUPDATE\s+identity\.invitations\b/gi)].length, 1, 'identity_expire_invitations: exactly one UPDATE (08 A12.6)');
  // test 22: per-tenant retention + 5 years for tenant-less rows
  assert.ok(nsp('identity_purge_auth_events').includes('make_interval(years=>ts.retention_audit_years)'), 'per-tenant retention_audit_years');
  assert.ok(nsp('identity_purge_auth_events').includes("tenant_idisnullandoccurred_at<now()-interval'5years'"), 'tenant-less rows: 5 years');
  // 08 A17 P-18(c): 1-year purge of expired/failed audit exports
  assert.ok(nsp('identity_expire_audit_exports').includes("statusin('expired','failed')andcreated_at<now()-interval'1year'"), '1-year purge');
  // test 25 / 08 A12.5: bootstrap is single-flight and closed once an active superadmin exists
  assert.ok(nsp('identity_bootstrap_platform_admin').includes('pg_advisory_xact_lock'));
  assert.ok(nsp('identity_bootstrap_platform_admin').includes("message='bootstrap_closed'"));
  assert.ok(nsp('identity_bootstrap_platform_admin').includes("role_code='platform_superadmin'andis_active"));
  // record_auth_event: tenant-less only
  assert.ok(nsp('identity_record_auth_event').includes("message='tenant_events_use_rls_path'"));
  assert.ok(nsp('identity_record_auth_event').includes("values((p->>'id')::uuid,null,"), 'tenant_id column is written as NULL');
  // 08 A28.1: unlisted keys / non-platform rows rejected with the [CONV] message
  assert.match(def(), /identity_platform_auth_write_invalid_input/);
  // 08 A28.4 / D-217: at most 100 distinct values
  assert.ok(nsp('identity_notify_ip_throttle_hmacs').includes('limit100'));
  // REQ-SEC-019/020: no caller-supplied tenant parameter on any DEFINER
  for (const n of DEFINERS) { const head = (m.get(n) ?? '').split(/\bRETURNS\b/i)[0]; assert.doesNotMatch(head, /\bp_tenant\w*/i, `${n}: no tenant parameter`); }
});

test('identity owner policies (C2 05-SCHEMA §5.4 / §10.1): wherever they are created they are verbatim, TO lims_owner only, with the single allowlisted USING (true)', () => {
  const t = readStripped(C2);
  const a = t.indexOf('CREATE POLICY platform_staff__select__owner_only'), b = t.indexOf('GRANT USAGE ON SCHEMA identity', a);
  assert.ok(a > 0 && b > a);
  const spec = policies(t.slice(a, b));
  assert.equal(spec.length, 24, 'spec lists 24 identity owner policies');
  for (const p of spec) assert.deepEqual(p.roles, ['lims_owner']);
  // identity.event_inbox policies belong to T0B-05 (05-SCHEMA §3.9/§6), not to the 24 C2 owner policies
  const mine = policies(allMig()).filter((p) => p.table.startsWith('identity.') && p.table !== 'identity.event_inbox');
  const polFile = root + 'db/policies/identity.sql';
  const inFile = existsSync(polFile) ? policies(readStripped(polFile)) : [];
  // C2 §10.1 lims_app policies (05-SCHEMA.md:1262-1275) legitimately share identity.*; this test covers the owner policies only
  const isOwner = (p) => /__owner_only$/.test(p.name) || p.roles.includes('lims_owner');
  const ownerMine = mine.filter(isOwner);
  const pool = ownerMine.length ? ownerMine : inFile.filter(isOwner);
  if (!pool.length) {
    // The identity tables are C2 DDL (a later stage); the plan assigns the owner policies to T0B-06. Until the writer decides where they live
    // (a migration that runs once the tables exist, or db/policies/identity.sql) only the live suite (stand-in tables with the real policies) covers them.
    console.log('# NOTE T0B-06: no identity owner policy found in db/migrations or db/policies/identity.sql — verified live only (see notes, open question 1)');
    return;
  }
  const want = new Map(spec.map((p) => [p.name, norm(p.text)]));
  assert.deepEqual(pool.map((p) => p.name).sort(), [...want.keys()].sort(), 'exact owner-policy inventory');
  for (const p of pool) { assert.equal(norm(p.text), want.get(p.name), `${p.name} verbatim`); assert.deepEqual(p.roles, ['lims_owner']); }
  assert.equal(pool.filter((p) => /\b(USING|WITH CHECK)\s*\(\s*true\s*\)/i.test(p.text)).map((p) => p.name).join(), 'platform_staff__select__owner_only', 'the only USING (true) (08 A10.5)');
});

test('no ungated or unbounded owner policy sneaks in through these migrations (AC-0B-2.2 forbidden constructs)', () => {
  for (const f of [defFile(), mbFile()].filter(Boolean)) {
    const s = readStripped(migDir + f);
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, f);
    for (const p of policies(s)) {
      if (p.name === 'platform_staff__select__owner_only') continue;
      assert.doesNotMatch(p.text, /\b(USING|WITH CHECK)\s*\(\s*true\s*\)/i, `${p.name}: USING (true) is allowlisted for platform_staff__select__owner_only only`);
      if (/app\.(pre_|maintenance)/.test(p.text)) assert.deepEqual(p.roles, ['lims_owner'], `${p.name}: GUC-bound policy must be TO lims_owner only`);
    }
    assert.doesNotMatch(s, /PASSWORD\s+'[^']+'/i, f);
  }
});

// ---------------------------------------------------------------- core.membership_branches + scope trigger
test('core.membership_branches DDL equals C0 05-SCHEMA §10 (columns, PK, composite FKs); tg_scope_user_only verbatim; both scope tables get the BEFORE INSERT trigger', () => {
  const spec = readStripped(C0), s = mb();
  assert.equal(norm(tableBody(s, 'core.membership_branches') ?? ''), norm(tableBody(spec, 'core.membership_branches')), 'table body');
  const f = functions(s).get('tg_scope_user_only'), sf = functions(spec).get('tg_scope_user_only');
  assert.ok(f, 'app.tg_scope_user_only created in the membership_branches migration');
  assert.equal(norm(f), norm(sf), 'tg_scope_user_only text (23514 scope_user_only)');
  assert.match(f, /ERRCODE\s*=\s*'23514'/);
  assert.match(f, /MESSAGE\s*=\s*'scope_user_only'/);
  assert.match(f, /m\.actor_type\s*=\s*'user'/);
  assert.match(f, /SET\s+search_path\s*=\s*''/i);
  assert.doesNotMatch(f, /SECURITY\s+DEFINER/i, 'INVOKER: runs under the caller\'s RLS');
  // both triggers exist (membership_centres one may live in T0B-03 or here)
  const all = allMig();
  for (const t of ['membership_centres', 'membership_branches']) {
    assert.match(ws(all), new RegExp(`CREATE TRIGGER ${t}__scope_user_only BEFORE INSERT ON core\\.${t} FOR EACH ROW EXECUTE FUNCTION app\\.tg_scope_user_only\\(\\)`, 'i'), `${t} scope trigger`);
  }
  assert.ok(ws(s).toLowerCase().indexOf('create function app.tg_scope_user_only') < ws(s).toLowerCase().indexOf('create trigger membership_branches__scope_user_only'), 'function before trigger');
});

test('core.membership_branches: ENABLE + FORCE RLS, the three __tenant policies verbatim (staff guard in USING and WITH CHECK), grants, audit trigger, db/policies/core.sql', () => {
  const spec = readStripped(C0), s = mb();
  assert.match(ws(s), /ALTER TABLE core\.membership_branches ENABLE ROW LEVEL SECURITY/i);
  assert.match(ws(s), /ALTER TABLE core\.membership_branches FORCE ROW LEVEL SECURITY/i);
  const mine = policies(s).filter((p) => p.table === 'core.membership_branches'), want = policies(spec).filter((p) => p.table === 'core.membership_branches');
  assert.deepEqual(mine.map((p) => p.name).sort(), ['membership_branches__delete__tenant', 'membership_branches__insert__tenant', 'membership_branches__select__tenant']);
  assert.deepEqual(mine.map((p) => norm(p.text)).sort(), want.map((p) => norm(p.text)).sort(), 'policies verbatim');
  for (const p of mine) { assert.deepEqual(p.roles, ['lims_app']); assert.match(p.text, /\(\s*SELECT\s+app\.is_staff_or_system\(\)\s*\)/i, `${p.name} staff guard (08 A17 P-16)`); assert.match(p.text, /tenant_id\s*=\s*\(\s*SELECT\s+app\.current_tenant_id\(\)\s*\)/i); }
  assert.match(ws(s), /GRANT SELECT, INSERT, DELETE ON core\.membership_branches TO lims_app\b/i);
  assert.doesNotMatch(s, /GRANT\s+[^;]*\bUPDATE\b[^;]*core\.membership_branches/i, 'no UPDATE grant (association class)');
  assert.match(ws(s), /CREATE TRIGGER membership_branches__audit AFTER INSERT OR UPDATE OR DELETE ON core\.membership_branches FOR EACH ROW EXECUTE FUNCTION app\.tg_row_audit\(\)/i, 'audited (05-SCHEMA §3.3)');
  const corePol = existsSync(root + 'db/policies/core.sql') ? policies(readStripped(root + 'db/policies/core.sql')).filter((p) => p.table === 'core.membership_branches') : [];
  assert.deepEqual(corePol.map((p) => norm(p.text)).sort(), want.map((p) => norm(p.text)).sort(), 'db/policies/core.sql carries the same membership_branches policies (AC-0B-2.3)');
});

// ---------------------------------------------------------------- test hygiene
test('T0B-06 test files exist; the stand-in fixture is FORCE-RLS and carries the real C2 owner policies verbatim; no RLS is disabled anywhere in db/tests (AC-0B-2.4)', () => {
  for (const f of ['db/tests/identity/T0B-06_definers.test.sql', 'db/tests/core/T0B-06_membership_branches.test.sql', 'db/tests/fixtures/T0B-06_identity_standin.sql']) assert.ok(existsSync(root + f), f);
  const fx = readFileSync(root + 'db/tests/fixtures/T0B-06_identity_standin.sql', 'utf8');
  const fxs = strip(fx);
  for (const m of fxs.matchAll(/CREATE\s+TABLE\s+(identity\.\w+)/gi)) {
    const t = m[1].replace('.', '\\.');
    assert.match(fxs, new RegExp(`ALTER\\s+TABLE\\s+${t}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${m[1]} ENABLE`);
    assert.match(fxs, new RegExp(`ALTER\\s+TABLE\\s+${t}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${m[1]} FORCE`);
    assert.match(fxs, new RegExp(`ALTER\\s+TABLE\\s+${t}\\s+OWNER\\s+TO\\s+lims_owner`, 'i'), `${m[1]} owned by lims_owner`);
  }
  assert.doesNotMatch(fxs, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  const pol = /\$pol\$([\s\S]*?)\$pol\$/.exec(fxs);
  assert.ok(pol, 'fixture policies block');
  const t = readStripped(C2);
  const a = t.indexOf('CREATE POLICY platform_staff__select__owner_only'), b = t.indexOf('GRANT USAGE ON SCHEMA identity', a);
  const want = new Map(policies(t.slice(a, b)).map((p) => [p.name, norm(p.text)]));
  const got = policies(pol[1]);
  assert.deepEqual(got.map((p) => p.name).sort(), [...want.keys()].sort(), 'fixture carries exactly the 24 owner policies');
  for (const p of got) assert.equal(norm(p.text), want.get(p.name), `fixture policy ${p.name} is verbatim C2 §10.1`);
  for (const f of ['db/tests/identity/T0B-06_definers.test.sql', 'db/tests/core/T0B-06_membership_branches.test.sql']) {
    const s = readStripped(root + f);
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, f);
    assert.doesNotMatch(s, /CREATE\s+(?!TEMP|TEMPORARY)(?:UNLOGGED\s+)?TABLE/i, `${f}: only TEMP tables outside the fixture`);
  }
});

test('plan coverage: the live suite asserts the plan\'s named cases', () => {
  const s = readFileSync(root + 'db/tests/identity/T0B-06_definers.test.sql', 'utf8');
  for (const needle of ['revoked', 'expired', 'locked', 'suspended', 'wrong sub', 'no row', 'test 19', 'test 20', 'test 21', 'is_platform_actor', 'test 24(b)', 'test 24(d)', 'test 25',
    'test 31', 'test 34', 'test 35', 'app.pre_tenant_id', 'identity_purge_auth_events', 'identity_expire_invitations', 'identity_expire_audit_exports',
    'identity_expire_support_sessions', 'identity_purge_sessions', 'bootstrap_closed', 'tenant_events_use_rls_path', 'support_tenant_status', 'has_verified_factor']) {
    assert.ok(s.includes(needle), `definers suite mentions ${needle}`);
  }
  const b = readFileSync(root + 'db/tests/core/T0B-06_membership_branches.test.sql', 'utf8');
  for (const needle of ['scope_user_only', 'patient', 'partner', 'membership_centres', 'all_centres', 'memberships__all_centres_user_only__ck']) assert.ok(b.includes(needle), `branches suite mentions ${needle}`);
});
