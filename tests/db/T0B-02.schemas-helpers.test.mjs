// T0B-02 static checks of db/migrations/*_app__create_schemas.sql + *_app__create_context_helpers.sql
// (05-SCHEMA §2, §4.5, §10 schema test 21; 08 A15.6, A20.2, A25 D-201, A30.1; AC-0B-6.1, AC-0B-6.3).
// Run: node --test tests/db/T0B-02.schemas-helpers.test.mjs   (live-DB assertions: db/tests/app/T0B-02_helpers.test.sql)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const files = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : []);
const find = (suffix) => {
  const m = files().filter((f) => f.endsWith(`_${suffix}.sql`));
  assert.equal(m.length, 1, `exactly one db/migrations/*_${suffix}.sql (found ${m.length})`);
  assert.match(m[0], new RegExp(`^\\d{14}_${suffix}\\.sql$`), 'name = <14-digit timestamp>_<schema>__<verb>_<what>.sql');
  return m[0];
};
const strip = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const read = (f) => strip(readFileSync(dir + f, 'utf8'));
const schemas = () => read(find('app__create_schemas'));
const helpers = () => read(find('app__create_context_helpers'));
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const stmt = (s, re) => stmts(s).find((x) => re.test(x)) ?? '';
const fnStmt = (sql, n) => stmt(sql, new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+app\\.${n}\\s*\\(`, 'i'));
// $$ bodies contain ';'-free SQL here (single SELECT), so splitting on ';' keeps each CREATE FUNCTION whole.

const MODULES = ['identity', 'catalog', 'frontdesk', 'billing', 'lab', 'instruments', 'reporting', 'analytics', 'quality', 'micro',
  'anatomic', 'inventory', 'partners', 'smartreport', 'payments', 'engagement', 'homecollection'];
const ALL = ['app', 'core', 'audit', ...MODULES, 'migration_staging', 'api'];

test('first statement of each migration is the owner role switch (AC-0B-6.3)', () => {
  for (const f of [find('app__create_schemas'), find('app__create_context_helpers')]) {
    assert.match(stmts(read(f))[0], /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f} starts with SET LOCAL ROLE lims_owner`);
  }
});

test('schemas migration sorts before helpers migration (schema test 21 order)', () => {
  const s = find('app__create_schemas'), h = find('app__create_context_helpers');
  assert.ok(s < h, `${s} must sort before ${h}`);
});

test('migration order: nothing sorts before schemas; every helper user sorts after helpers (schema test 21)', () => {
  const s = find('app__create_schemas'), h = find('app__create_context_helpers');
  const used = /app\.(is_platform_actor|current_partner_id|engagement_(preauth_stage|account_id|patient_ids|patient_visible)|current_lims_session_id|uuidv7)\s*\(/;
  for (const f of files()) {
    assert.ok(f >= s, `${f} must not sort before ${s}`);
    if (f === s || f === h) continue;
    if (used.test(read(f))) assert.ok(f > h, `${f} references app helpers so must sort after ${h}`);
  }
});

test('every spec schema is created, and no other', () => {
  const sql = schemas();
  const created = [...sql.matchAll(/CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)].map((m) => m[1]).sort();
  // graphile_worker (owner lims_queue) and migrations_meta (owner lims_migrator) are NOT created by this file
  assert.deepEqual(created, [...ALL].sort());
  assert.doesNotMatch(sql, /AUTHORIZATION/i, 'owner is the current role lims_owner');
});

test('PUBLIC has nothing on any created schema', () => {
  const r = stmt(schemas(), /REVOKE\s+ALL\s+ON\s+SCHEMA/i);
  assert.ok(r, 'REVOKE ALL ON SCHEMA … FROM PUBLIC');
  assert.match(r, /FROM\s+PUBLIC$/i);
  for (const s of ALL) assert.match(r, new RegExp(`\\b${s}\\b`), `${s} revoked`);
  assert.doesNotMatch(schemas(), /GRANT\s+[^;]*\bTO\s+PUBLIC\b/i);
});

test('USAGE grants per §2 table', () => {
  const sql = schemas();
  const usage = (role) => stmts(sql)
    .filter((x) => new RegExp(`^GRANT\\s+USAGE\\s+ON\\s+SCHEMA\\b[^;]*\\bTO\\s+${role}$`, 'i').test(x)).join(' ; ');
  const app = usage('lims_app');
  for (const s of ['app', 'core', 'audit', ...MODULES]) assert.match(app, new RegExp(`\\b${s}\\b`), `lims_app USAGE ${s}`);
  for (const s of ['migration_staging', 'api', 'graphile_worker', 'migrations_meta']) {
    assert.doesNotMatch(app, new RegExp(`\\b${s}\\b`), `lims_app has no USAGE on ${s}`);
  }
  const q = usage('lims_queue');
  assert.match(q, /\bapp\b/); assert.match(q, /\bcore\b/); assert.doesNotMatch(q, /\baudit\b/);
  const rl = usage('lims_reporting_lookup');
  assert.match(rl, /\bapp\b/); assert.doesNotMatch(rl, /\b(core|reporting|audit)\b/, 'reporting usage comes from the C6 migration');
  const an = usage('lims_analytics');
  for (const s of MODULES) assert.match(an, new RegExp(`\\b${s}\\b`), `lims_analytics USAGE ${s}`);
  assert.doesNotMatch(an, /\b(app|core|audit|migration_staging|api)\b/);
});

test('no standing CREATE on any schema; nothing for supabase_auth_admin (D-201, R10)', () => {
  const sql = schemas();
  assert.doesNotMatch(sql, /GRANT\s+[^;]*\bCREATE\b[^;]*ON\s+SCHEMA/i);
  assert.doesNotMatch(sql, /supabase_auth_admin/i);
  assert.doesNotMatch(sql, /GRANT\s+ALL/i);
});

test('default privileges: lims_owner revokes PUBLIC EXECUTE and table rights', () => {
  const sql = schemas();
  assert.match(sql, /ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+lims_owner\s+REVOKE\s+EXECUTE\s+ON\s+FUNCTIONS\s+FROM\s+PUBLIC/i);
  assert.match(sql, /ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+lims_owner\s+REVOKE\s+ALL\s+ON\s+TABLES\s+FROM\s+PUBLIC/i);
});

test('lims_queue / lims_reporting_lookup set their OWN default privileges via SET LOCAL ROLE (no FOR ROLE)', () => {
  const sql = schemas();
  for (const r of ['lims_queue', 'lims_reporting_lookup']) {
    assert.doesNotMatch(sql, new RegExp(`ALTER\\s+DEFAULT\\s+PRIVILEGES\\s+FOR\\s+ROLE\\s+${r}`, 'i'), `${r}: FOR ROLE is denied to lims_owner`);
    const re = new RegExp(`RESET\\s+ROLE\\s*;\\s*SET\\s+LOCAL\\s+ROLE\\s+${r}\\s*;\\s*ALTER\\s+DEFAULT\\s+PRIVILEGES\\s+REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTIONS\\s+FROM\\s+PUBLIC\\s*;`, 'i');
    assert.match(sql, re, `${r}: switch, then ALTER DEFAULT PRIVILEGES REVOKE EXECUTE … FROM PUBLIC`);
  }
  assert.match(sql.trim(), /RESET\s+ROLE\s*;\s*SET\s+LOCAL\s+ROLE\s+lims_owner\s*;?$/i, 'file ends back as lims_owner');
});

test('context helpers: INVOKER, STABLE, claim sources, grants (CV §5.8, A20.2)', () => {
  const sql = helpers();
  for (const n of ['current_claims', 'current_tenant_id', 'current_actor_id', 'current_actor_type', 'current_membership_id',
    'is_staff_or_system', 'current_lims_session_id']) {
    const f = fnStmt(sql, n);
    assert.ok(f, `app.${n} created`);
    assert.match(f, /LANGUAGE\s+sql/i); assert.match(f, /\bSTABLE\b/i);
    assert.doesNotMatch(f, /SECURITY\s+DEFINER/i, `${n} is INVOKER`);
  }
  assert.match(fnStmt(sql, 'current_claims'), /request\.jwt\.claims/);
  assert.match(fnStmt(sql, 'current_lims_session_id'), /RETURNS\s+uuid/i);
  assert.match(fnStmt(sql, 'current_lims_session_id'), /lims_session_id/);
  const st = fnStmt(sql, 'is_staff_or_system');
  assert.match(st, /IN\s*\(\s*'user'\s*,\s*'system'\s*,\s*'device'\s*\)/i);
  assert.doesNotMatch(st, /'(partner|portal|patient)'/);
  assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+app\.current_lims_session_id\(\)\s+TO\s+lims_app\s*,\s*lims_api\s*,\s*lims_worker/i);
});

test('app.is_platform_actor: DEFINER, pinned search_path, REVOKE PUBLIC, GRANT lims_app, check_function_bodies off (A15.6)', () => {
  const sql = helpers();
  const f = fnStmt(sql, 'is_platform_actor');
  assert.ok(f, 'app.is_platform_actor created');
  assert.match(f, /RETURNS\s+boolean/i); assert.match(f, /SECURITY\s+DEFINER/i); assert.match(f, /\bSTABLE\b/i);
  assert.match(f, /SET\s+search_path\s*=\s*''/i);
  assert.match(f, /identity\.platform_staff/); assert.match(f, /'platform'/); assert.match(f, /'aal2'/); assert.match(f, /\bis_active\b/);
  assert.match(f, /coalesce\s*\(/i, 'fail-closed: never NULL');
  assert.match(sql, /SET\s+LOCAL\s+check_function_bodies\s*=\s*off\s*;\s*CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+app\.is_platform_actor/i,
    'check_function_bodies off immediately before the create (identity.platform_staff does not exist yet)');
  assert.match(sql, /FUNCTION\s+app\.is_platform_actor[\s\S]*?SET\s+LOCAL\s+check_function_bodies\s*=\s*on\s*;/i, 'switched back on');
  assert.match(sql, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+app\.is_platform_actor\(\)\s+FROM\s+PUBLIC/i);
  assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+app\.is_platform_actor\(\)\s+TO\s+lims_app\s*(;|$)/i);
  assert.doesNotMatch(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+app\.is_platform_actor\(\)\s+TO\s+[^;]*\b(PUBLIC|lims_owner|lims_queue|lims_analytics)\b/i);
  const at = (re) => sql.search(re);
  const c = at(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+app\.is_platform_actor/i);
  assert.ok(c < at(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+app\.is_platform_actor/i), 'REVOKE after CREATE');
  assert.ok(c < at(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+app\.is_platform_actor/i), 'GRANT after CREATE');
});

const POLICY = {
  current_partner_id: ['definer', /partners\.partner_users/, /RETURNS\s+uuid\b/i],
  engagement_preauth_stage: ['invoker', /patient_stage/, /RETURNS\s+text/i],
  engagement_account_id: ['definer', /engagement\.accounts/, /RETURNS\s+uuid\b/i],
  engagement_patient_ids: ['definer', /engagement\.account_patient_links/, /RETURNS\s+uuid\[\]/i],
  engagement_patient_visible: ['definer', /visible_from/, /RETURNS\s+boolean/i],
};

test('module policy helpers (A30.1): bodies, security mode, grants, check_function_bodies off', () => {
  const sql = helpers();
  for (const [n, [mode, body, ret]] of Object.entries(POLICY)) {
    const f = fnStmt(sql, n);
    assert.ok(f, `app.${n} created`);
    assert.match(f, body); assert.match(f, ret);
    if (mode === 'definer') {
      assert.match(f, /SECURITY\s+DEFINER/i, `${n} DEFINER`);
      assert.match(f, /SET\s+search_path\s*=\s*''/i, `${n} search_path pinned`);
    } else assert.doesNotMatch(f, /SECURITY\s+DEFINER/i, `${n} INVOKER`);
  }
  assert.match(fnStmt(sql, 'engagement_patient_visible'), /\(\s*p_patient_id\s+uuid\s*,\s*p_at\s+timestamptz\s*\)/i);
  assert.match(sql, /SET\s+LOCAL\s+check_function_bodies\s*=\s*off\s*;\s*CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+app\.current_partner_id/i);
  const rv = stmt(sql, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+app\.current_partner_id\(\)/i);
  const gr = stmt(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+app\.current_partner_id\(\)/i);
  assert.ok(rv && gr, 'REVOKE + GRANT cover the five policy helpers');
  for (const n of Object.keys(POLICY)) {
    assert.match(rv, new RegExp(`app\\.${n}\\(`), `REVOKE ${n}`);
    assert.match(gr, new RegExp(`app\\.${n}\\(`), `GRANT ${n}`);
  }
  assert.match(rv, /FROM\s+PUBLIC$/i); assert.match(gr, /TO\s+lims_app$/i);
  assert.ok(sql.search(/FUNCTION\s+app\.engagement_account_id/i) < sql.search(/FUNCTION\s+app\.engagement_patient_ids/i),
    'engagement_account_id before engagement_patient_ids (which calls it)');
});

test('app.uuidv7: VOLATILE sql, RFC 9562 construction, no extension dependency', () => {
  const sql = helpers();
  const f = fnStmt(sql, 'uuidv7');
  assert.ok(f, 'app.uuidv7 created');
  assert.match(f, /RETURNS\s+uuid/i); assert.match(f, /LANGUAGE\s+sql/i); assert.match(f, /\bVOLATILE\b/i);
  assert.match(f, /gen_random_uuid\(\)/); assert.match(f, /clock_timestamp\(\)/);
  assert.doesNotMatch(f, /uuid_generate|uuid-ossp|now\(\)|SECURITY\s+DEFINER/i);
  assert.match(f, /set_bit\(\s*set_bit\(/i, 'version-bit fix-up present');
  assert.doesNotMatch(sql, /GRANT[^;]*uuidv7[^;]*PUBLIC/i);
});

test('no destructive / privilege-escalating statements in either file', () => {
  for (const sql of [schemas(), helpers()]) {
    assert.doesNotMatch(sql, /DROP\s+(SCHEMA|FUNCTION|ROLE)/i);
    assert.doesNotMatch(sql, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|BYPASSRLS|SUPERUSER/i);
    assert.doesNotMatch(sql, /CREATE\s+EXTENSION/i);
  }
});

test('schemas file creates no functions; helpers file creates no schemas/tables', () => {
  assert.doesNotMatch(schemas(), /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
  assert.doesNotMatch(helpers(), /CREATE\s+(SCHEMA|TABLE)/i);
});
