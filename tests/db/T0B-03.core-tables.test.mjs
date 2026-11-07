// T0B-03 static checks of db/migrations/*_core__create_*.sql (+ audit tables, wherever the writer puts them) and db/policies/core.sql
// (05-SCHEMA §3.1-§3.4, §3.6-§3.7, §4.4, §5, §6, §7, §10; 08 A12.1, A12.5, A15.5, A17 P-16, A20.3, A23.3, A25 D-215, A28.3-A28.6;
//  AC-0B-2.2, 2.3, 2.4(static part), 5.3; schema tests 1-8, 17, 20, 24 (policy part), 25, 28, 32, 33 (static part)).
// Run: node --test tests/db/T0B-03.core-tables.test.mjs   (live-DB assertions: db/tests/core/T0B-03_*.test.sql, pg_prove)
// Scope notes: platform tables (event_log, dead_letters, idempotency_keys, g_task_registry, g_system_actors) are T0B-05 and
// membership_branches + tg_scope_user_only are T0B-06; those are checked here only when present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const migDir = root + 'db/migrations/';
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const strip = (s) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const helpersFile = () => files().find((f) => f.endsWith('_app__create_context_helpers.sql'));
const coreFiles = () => files().filter((f) => /^\d{14}_core__create_[a-z0-9_]+\.sql$/.test(f));
const auditFiles = () => files().filter((f) => /^\d{14}_audit__create_[a-z0-9_]+\.sql$/.test(f));
const mine = () => [...coreFiles(), ...auditFiles()];
const all = () => mine().map(read).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);

// extract "CREATE TABLE <name> ( ... )" with balanced parens
function tableBody(sql, name) {
  const m = new RegExp(`CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1;
  const start = i;
  while (i < sql.length && depth) { if (sql[i] === '(') depth++; else if (sql[i] === ')') depth--; i++; }
  return sql.slice(start, i - 1);
}
function fnText(sql, name) {
  const m = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+app\\.${name}\\s*\\([\\s\\S]*?(\\$\\w*\\$)[\\s\\S]*?\\1`, 'i').exec(sql);
  return m ? m[0] : null;
}
function policies(sql) {
  return stmts(sql).filter((s) => /^CREATE\s+POLICY\b/i.test(s)).map((s) => {
    const m = /^CREATE\s+POLICY\s+(\w+)\s+ON\s+([\w.]+)\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([\w, ]+?)\s+(?=USING|WITH)([\s\S]*)$/i.exec(ws(s));
    assert.ok(m, `parsable policy: ${ws(s).slice(0, 100)}`);
    const rest = m[5];
    const wi = rest.search(/\bWITH\s+CHECK\b/i);
    const using = (wi < 0 ? rest : rest.slice(0, wi)).replace(/^\s*USING\s*/i, '').trim();
    const check = wi < 0 ? '' : rest.slice(wi).replace(/^\s*WITH\s+CHECK\s*/i, '').trim();
    return { name: m[1], table: m[2], cmd: m[3].toUpperCase(), roles: m[4].split(',').map((r) => r.trim()), using: /^USING/i.test(rest) || wi > 0 ? using : '', check, text: ws(s) };
  });
}
const GUARD = /\(\s*SELECT\s+app\.is_staff_or_system\(\)\s*\)/i;
const TENANT_PRED = (col) => new RegExp(`${col}\\s*=\\s*\\(\\s*SELECT\\s+app\\.current_tenant_id\\(\\)\\s*\\)`, 'i');

const M_TABLES = ['branches', 'collection_centres', 'users', 'memberships', 'membership_centres', 'roles', 'role_permissions', 'membership_roles'];
const RLS_TABLES = ['core.tenants', ...M_TABLES.map((t) => `core.${t}`), 'audit.audit_log', 'audit.access_log'];
const G_TABLES = ['core.g_permissions', 'audit.g_cs_access_actions'];

test('migration files exist, are named per convention, sort after the helpers stage, and start with the owner switch', () => {
  assert.ok(helpersFile(), 'T0B-02 helpers migration present');
  assert.ok(coreFiles().length >= 1, 'at least one db/migrations/*_core__create_*.sql');
  for (const f of mine()) {
    assert.ok(f > helpersFile(), `${f} sorts after ${helpersFile()}`);
    assert.match(stmts(read(f))[0], /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is SET LOCAL ROLE lims_owner`);
  }
  assert.ok(existsSync(root + 'db/policies/core.sql'), 'db/policies/core.sql exists');
});

test('every C0 core/audit table is created; tenant tables have tenant_id uuid NOT NULL without default', () => {
  const sql = all();
  for (const t of ['core.tenants', ...M_TABLES.map((x) => 'core.' + x), ...G_TABLES, 'audit.audit_log', 'audit.access_log']) {
    assert.ok(tableBody(sql, t), `CREATE TABLE ${t}`);
  }
  for (const t of [...M_TABLES.map((x) => 'core.' + x), 'audit.audit_log', 'audit.access_log']) {
    const b = tableBody(sql, t);
    assert.match(b, /\btenant_id\s+uuid\s+NOT\s+NULL\s*(,|\n)/i, `${t}.tenant_id uuid NOT NULL`);
    assert.doesNotMatch(b, /\btenant_id\s+uuid\s+NOT\s+NULL\s+DEFAULT/i, `${t}.tenant_id has no default`);
  }
  assert.doesNotMatch(sql, /CREATE\s+TYPE\s+[\w.]+\s+AS\s+ENUM/i, 'no ENUM types (CV §5)');
  assert.doesNotMatch(sql, /REFERENCES\s+auth\./i, 'no FK into GoTrue auth (REQ-ARCH-014)');
});

test('columns per 05-SCHEMA §3.1-§3.4 / §3.6-§3.7', () => {
  const sql = all();
  const cols = {
    'core.tenants': ['id', 'tenant_code', 'legal_name', 'display_name', 'status', 'timezone', 'status_reason', 'activated_at', 'suspended_at', 'offboarded_at', 'billing_live_on', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    'core.branches': ['id', 'tenant_id', 'branch_code', 'name', 'address_text', 'phone_display', 'is_processing_lab', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    'core.collection_centres': ['id', 'tenant_id', 'branch_id', 'centre_code', 'name', 'centre_kind', 'address_text', 'phone_display', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    'core.users': ['tenant_id', 'id', 'display_name', 'staff_code', 'email_normalized', 'phone_e164', 'last_login_at', 'email_hmac', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    'core.memberships': ['id', 'tenant_id', 'user_id', 'actor_type', 'all_centres', 'status', 'invited_at', 'accepted_at', 'deactivated_at', 'deactivated_by', 'deactivation_reason_code', 'locked_at', 'locked_by', 'lock_reason_code', 'lock_reason_text', 'last_login_at', 'signatory_display_title', 'signatory_registration_no', 'signature_image_ref', 'partner_role', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    'core.membership_centres': ['tenant_id', 'membership_id', 'centre_id', 'created_at', 'created_by'],
    'core.g_permissions': ['code', 'module', 'privileged', 'phase', 'description', 'is_active', 'created_at'],
    'core.roles': ['id', 'tenant_id', 'role_code', 'display_name', 'description', 'is_system_default', 'mfa_required', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    'core.role_permissions': ['tenant_id', 'role_id', 'permission_code', 'created_at', 'created_by'],
    'core.membership_roles': ['tenant_id', 'membership_id', 'role_id', 'created_at', 'created_by'],
    'audit.audit_log': ['id', 'tenant_id', 'centre_id', 'schema_name', 'table_name', 'row_id', 'action', 'changed_columns', 'old_values', 'new_values', 'actor_id', 'actor_type', 'membership_id', 'support_session_id', 'request_id', 'client_ip', 'user_agent', 'detail', 'occurred_at', 'created_at', 'created_by'],
    'audit.access_log': ['id', 'tenant_id', 'centre_id', 'actor_id', 'actor_type', 'membership_id', 'support_session_id', 'action', 'entity_type', 'entity_id', 'purpose_code', 'outcome', 'detail', 'request_id', 'client_ip', 'user_agent', 'occurred_at', 'created_at', 'created_by'],
  };
  for (const [t, cs] of Object.entries(cols)) {
    const b = tableBody(sql, t);
    assert.ok(b, t);
    for (const c of cs) assert.match(b, new RegExp(`(^|[\\s,(])${c}\\s+[a-z]`, 'i'), `${t}.${c}`);
  }
  assert.doesNotMatch(tableBody(sql, 'core.memberships'), /\bis_locked\b/i, 'no is_locked column (locked <=> locked_at IS NOT NULL, 08 A3.4)');
  assert.match(tableBody(sql, 'core.users'), /email_hmac\s+bytea/i);
  assert.match(tableBody(sql, 'audit.audit_log'), /changed_columns\s+text\[\]\s+NOT\s+NULL/i);
});

test('memberships.is_active is GENERATED ALWAYS AS (status = \'active\') STORED; every other class-M is_active is a plain default (schema test 1)', () => {
  const sql = all();
  assert.match(ws(tableBody(sql, 'core.memberships')), /is_active\s+boolean\s+GENERATED\s+ALWAYS\s+AS\s*\(\s*status\s*=\s*'active'\s*\)\s+STORED/i);
  for (const t of ['core.tenants', 'core.branches', 'core.collection_centres', 'core.users', 'core.roles']) {
    assert.match(ws(tableBody(sql, t)), /is_active\s+boolean\s+NOT\s+NULL\s+DEFAULT\s+true/i, `${t}.is_active plain`);
  }
  // no trigger / policy / function body writes memberships.is_active (08 A3.4 + §4.4 last bullet)
  assert.doesNotMatch(sql, /UPDATE\s+core\.memberships\s+SET[^;]*\bis_active\b/i);
});

test('constraints verbatim (names + literal sets) — schema tests 2, 3, 5, 6, 33', () => {
  const sql = ws(all());
  const names = ['tenants__pk', 'tenants__tenant_code__ck', 'tenants__names__ck', 'tenants__status__ck', 'tenants__timezone__ck', 'tenants__status_reason__ck',
    'branches__pk', 'branches__tenant_id_id__uq', 'branches__tenant__fk', 'branches__branch_code__ck', 'branches__text__ck',
    'collection_centres__pk', 'collection_centres__tenant_id_id__uq', 'collection_centres__tenant__fk', 'collection_centres__branch__fk', 'collection_centres__centre_code__ck', 'collection_centres__kind__ck', 'collection_centres__text__ck',
    'users__pk', 'users__email_hmac__ck', 'users__tenant__fk', 'users__text__ck', 'users__email_normalized__ck', 'users__phone_e164__ck',
    'memberships__pk', 'memberships__tenant_id_id__uq', 'memberships__user__fk', 'memberships__actor_type__ck', 'memberships__all_centres_user_only__ck', 'memberships__lock__ck',
    'memberships__partner_role_presence__ck', 'memberships__partner_role__ck', 'memberships__status__ck', 'memberships__lock_reason__ck', 'memberships__deactivation_reason__ck', 'memberships__text__ck',
    'membership_centres__pk', 'membership_centres__membership__fk', 'membership_centres__centre__fk',
    'g_permissions__pk', 'g_permissions__code__ck', 'g_permissions__phase__ck',
    'roles__pk', 'roles__tenant_id_id__uq', 'roles__tenant__fk', 'roles__role_code__ck', 'roles__text__ck',
    'role_permissions__pk', 'role_permissions__role__fk', 'role_permissions__permission__fk', 'role_permissions__no_platform__ck',
    'membership_roles__pk', 'membership_roles__membership__fk', 'membership_roles__role__fk',
    'audit_log__pk', 'audit_log__action__ck', 'audit_log__actor__ck', 'audit_log__ua__ck',
    'access_log__pk', 'access_log__tenant__fk', 'access_log__action__fk', 'access_log__outcome__ck', 'access_log__text__ck', 'g_cs_access_actions__pk', 'g_cs_access_actions__code__ck'];
  for (const n of names) assert.match(sql, new RegExp(`CONSTRAINT ${n}\\b`), `constraint ${n}`);
  assert.match(sql, /memberships__status__ck CHECK \(status IN \('invited', ?'active', ?'deactivated'\)\)/);
  assert.match(sql, /memberships__actor_type__ck CHECK \(actor_type IN \('user', ?'patient', ?'partner'\)\)/);
  assert.match(sql, /memberships__all_centres_user_only__ck CHECK \(actor_type = 'user' OR NOT all_centres\)/);
  assert.match(sql, /memberships__partner_role_presence__ck CHECK \(\(actor_type = 'partner'\) = \(partner_role IS NOT NULL\)\)/);
  assert.match(sql, /memberships__partner_role__ck CHECK \(partner_role IN \('partner_admin', ?'partner_member'\)\)/);
  assert.match(sql, /memberships__lock_reason__ck CHECK \(lock_reason_code IN \('left_organisation', ?'security_concern', ?'policy_violation', ?'other'\)\)/);
  assert.match(sql, /memberships__deactivation_reason__ck CHECK \(deactivation_reason_code IN \('left_organisation', ?'security_concern', ?'policy_violation', ?'other'\)\)/);
  assert.match(sql, /users__email_hmac__ck CHECK \(octet_length\(email_hmac\) = 32\)/);
  assert.match(sql, /users__phone_e164__ck CHECK \(phone_e164 ~ '\^\\\+\[1-9\]\[0-9\]\{7,14\}\$'\)/);
  assert.match(sql, /tenants__status__ck CHECK \(status IN \('provisioning', ?'active', ?'suspended', ?'offboarded'\)\)/);
  assert.match(sql, /tenants__status_reason__ck CHECK \(coalesce\(char_length\(status_reason\), ?0\) <= 500\)/);
  assert.match(sql, /role_permissions__no_platform__ck CHECK \(permission_code NOT LIKE 'platform\.%'\)/);
  assert.match(sql, /audit_log__actor__ck CHECK \(\(actor_id IS NOT NULL AND created_by IS NOT NULL\) OR \(actor_id IS NULL AND created_by IS NULL AND actor_type = 'system' AND coalesce\(detail \? 'maintenance', false\)\)\)/);
  assert.match(sql, /audit_log__pk PRIMARY KEY \(tenant_id, occurred_at, id\)/);
  assert.match(sql, /users__pk PRIMARY KEY \(tenant_id, id\)/);
  assert.match(sql, /collection_centres__branch__fk FOREIGN KEY \(tenant_id, branch_id\) REFERENCES core\.branches \(tenant_id, id\)/, 'composite FK (AC-0B-3.5)');
  assert.match(sql, /memberships__user__fk FOREIGN KEY \(tenant_id, user_id\) REFERENCES core\.users \(tenant_id, id\)/);
});

test('indexes: names, partial predicates, tenant_id leads (schema tests 3, 4, 8, 33)', () => {
  const sql = ws(all());
  const idx = [...sql.matchAll(/CREATE (UNIQUE )?INDEX (\w+) ON ([\w.]+)(?: USING (\w+))? \(([^)]*)\)( WHERE [^;]*)?/gi)]
    .map((m) => ({ uq: !!m[1], name: m[2], table: m[3], using: m[4], cols: m[5].split(',').map((c) => c.trim().split(' ')[0]), where: (m[6] || '').trim() }));
  const by = Object.fromEntries(idx.map((i) => [i.name, i]));
  const NON_LEADING = new Set(['tenants__tenant_code__uq', 'memberships__user_id__p_uq', 'event_log__created_at__brin', 'event_inbox__received_at__brin',
    'dead_letters__state_dead_at__idx', 'idempotency_keys__expires_at__idx']);
  for (const i of idx) if (!NON_LEADING.has(i.name)) assert.equal(i.cols[0], 'tenant_id', `${i.name} leads with tenant_id`);
  for (const n of ['tenants__tenant_code__uq', 'branches__tenant_id_branch_code__uq', 'branches__tenant_id_is_active__idx', 'collection_centres__tenant_id_centre_code__uq',
    'collection_centres__tenant_id_branch_id__idx', 'users__tenant_id_email_normalized__uq', 'memberships__tenant_id_user_id_actor_type__p_uq', 'memberships__user_id__p_uq',
    'roles__tenant_id_role_code__uq', 'role_permissions__tenant_id_permission_code__idx', 'membership_roles__tenant_id_role_id__idx',
    'audit_log__tenant_id_id__idx', 'audit_log__tenant_id_table_row__idx', 'audit_log__tenant_id_actor__idx', 'audit_log__tenant_id_request_id__idx', 'audit_log__tenant_id_support_session__p_idx',
    'access_log__tenant_id_id__idx', 'access_log__tenant_id_entity__idx', 'access_log__tenant_id_actor__idx', 'access_log__tenant_id_action__idx', 'access_log__tenant_id_request_id__idx', 'access_log__tenant_id_support_session__p_idx']) {
    assert.ok(by[n], `index ${n}`);
  }
  assert.equal(by['tenants__tenant_code__uq'].uq, true);
  assert.deepEqual(by['memberships__tenant_id_user_id_actor_type__p_uq'].cols, ['tenant_id', 'user_id', 'actor_type']);
  assert.match(by['memberships__tenant_id_user_id_actor_type__p_uq'].where, /WHERE status IN \('invited', ?'active'\)/i);
  assert.deepEqual(by['memberships__user_id__p_uq'].cols, ['user_id']);
  assert.match(by['memberships__user_id__p_uq'].where, /WHERE actor_type = 'user' AND status IN \('invited', ?'active'\)/i, 'R27 predicate counts pending invites (08 A3.4)');
  assert.deepEqual(by['role_permissions__tenant_id_permission_code__idx'].cols, ['tenant_id', 'permission_code']);
  assert.deepEqual(by['membership_roles__tenant_id_role_id__idx'].cols, ['tenant_id', 'role_id']);
  assert.deepEqual(by['audit_log__tenant_id_request_id__idx'].cols, ['tenant_id', 'request_id']);
  assert.match(by['audit_log__tenant_id_support_session__p_idx'].where, /WHERE support_session_id IS NOT NULL/i);
  assert.match(by['access_log__tenant_id_support_session__p_idx'].where, /WHERE support_session_id IS NOT NULL/i);
  assert.match(sql, /audit_log__tenant_id_support_session__p_idx ON audit\.audit_log \(tenant_id, support_session_id, occurred_at DESC\)/);
});

test('ENABLE + FORCE RLS on every tenant/audit table; none on class-G tables (AC-0B-2.1)', () => {
  const sql = ws(all());
  for (const t of RLS_TABLES) {
    assert.match(sql, new RegExp(`ALTER TABLE ${t.replace('.', '\\.')} ENABLE ROW LEVEL SECURITY`, 'i'), `${t} ENABLE RLS`);
    assert.match(sql, new RegExp(`ALTER TABLE ${t.replace('.', '\\.')} FORCE ROW LEVEL SECURITY`, 'i'), `${t} FORCE RLS`);
  }
  for (const t of G_TABLES) assert.doesNotMatch(sql, new RegExp(`ALTER TABLE ${t.replace('.', '\\.')} (ENABLE|FORCE)`, 'i'), `${t} is RLS-exempt`);
  assert.doesNotMatch(sql, /DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i);
});

const EXPECT = {
  'core.tenants': ['select__tenant', 'insert__tenant', 'update__tenant', 'select__owner_only'],
  'core.branches': ['select__tenant', 'insert__tenant', 'update__tenant'],
  'core.collection_centres': ['select__tenant', 'insert__tenant', 'update__tenant'],
  'core.users': ['select__tenant', 'insert__tenant', 'update__tenant', 'select__owner_only'],
  'core.roles': ['select__tenant', 'insert__tenant', 'update__tenant', 'select__owner_only'],
  'core.memberships': ['select__tenant', 'insert__tenant', 'update__tenant', 'select__owner_only'],
  'core.membership_centres': ['select__tenant', 'insert__tenant', 'delete__tenant', 'select__owner_only'],
  'core.role_permissions': ['select__tenant', 'insert__tenant', 'delete__tenant'],
  'core.membership_roles': ['select__tenant', 'insert__tenant', 'delete__tenant', 'select__owner_only'],
  'audit.audit_log': ['select__tenant', 'insert__owner_only'],
  'audit.access_log': ['select__tenant', 'insert__tenant', 'insert__partner', 'insert__portal', 'insert__patient'],
};

test('policy inventory is exactly §6/§10 for the T0B-03 tables, named <table>__<cmd>__<scope>, no extras (AC-0B-2.2)', () => {
  const ps = policies(all());
  for (const [t, expect] of Object.entries(EXPECT)) {
    const short = t.split('.')[1];
    const got = ps.filter((p) => p.table === t).map((p) => p.name).sort();
    assert.deepEqual(got, expect.map((e) => `${short}__${e}`).sort(), `${t} policies`);
  }
  for (const p of ps) {
    assert.match(p.name, /^[a-z_]+__(select|insert|update|delete)__[a-z_]+$/, `${p.name} naming`);
    assert.equal(p.name.split('__')[1].toUpperCase(), p.cmd, `${p.name} command matches name`);
    assert.doesNotMatch(p.roles.join(','), /\b(public|anon|authenticated)\b/i, `${p.name} not to public/anon/authenticated`);
    assert.doesNotMatch(p.using + p.check, /^\s*\(?\s*true\s*\)?\s*$/i, `${p.name} is not USING (true)`);
  }
});

test('every __tenant policy: TO lims_app, tenant predicate + staff guard in USING and WITH CHECK (AC-0B-3.6a/b, schema test 24)', () => {
  const ps = policies(all()).filter((p) => p.name.endsWith('__tenant'));
  assert.ok(ps.length >= 25, `found ${ps.length} __tenant policies`);
  for (const p of ps) {
    assert.deepEqual(p.roles, ['lims_app'], `${p.name} TO lims_app`);
    const col = p.table === 'core.tenants' ? 'id' : 'tenant_id';
    if (p.cmd !== 'INSERT') { assert.match(p.using, TENANT_PRED(col), `${p.name} USING tenant`); assert.match(p.using, GUARD, `${p.name} USING guard`); }
    if (p.cmd === 'INSERT' || p.cmd === 'UPDATE') { assert.match(p.check, TENANT_PRED(col), `${p.name} CHECK tenant`); assert.match(p.check, GUARD, `${p.name} CHECK guard`); }
    if (p.cmd === 'INSERT') assert.equal(p.using, '', `${p.name} has no USING`);
  }
});

test('actor-specific policies exist only on the shared_with tables and bind own actor id + actor type (08 A23.3)', () => {
  const ps = policies(all()).filter((p) => /__(partner|portal|patient)$/.test(p.name));
  for (const p of ps) assert.ok(['core.event_log', 'core.idempotency_keys', 'audit.access_log'].includes(p.table), `${p.name} only on shared_with tables`);
  for (const t of ['partner', 'portal', 'patient']) {
    const p = ps.find((x) => x.name === `access_log__insert__${t}`);
    assert.ok(p, `access_log__insert__${t}`);
    assert.deepEqual(p.roles, ['lims_app']);
    assert.equal(p.cmd, 'INSERT');
    assert.match(p.check, TENANT_PRED('tenant_id'), 'own tenant');
    assert.match(p.check, /actor_id\s*=\s*\(\s*SELECT\s+app\.current_actor_id\(\)\s*\)/i, 'own actor id');
    assert.match(p.check, new RegExp(`\\(\\s*SELECT\\s+app\\.current_actor_type\\(\\)\\s*\\)\\s*=\\s*'${t}'`, 'i'), `actor_type = '${t}'`);
    assert.doesNotMatch(p.check, GUARD, 'actor policy does not use the staff guard');
  }
  assert.ok(!policies(all()).some((p) => p.table === 'audit.access_log' && p.cmd === 'SELECT' && /partner|portal|patient/.test(p.name)), 'no non-staff SELECT on access_log');
});

test('owner_only policies: TO lims_owner, GUC-bound branches per §6/§10 (schema test 17, 08 A12.1)', () => {
  const ps = policies(all());
  for (const p of ps.filter((x) => x.name.endsWith('__owner_only'))) assert.deepEqual(p.roles, ['lims_owner'], `${p.name} TO lims_owner`);
  for (const p of ps.filter((x) => /app\.pre_|app\.maintenance/.test(x.using + x.check))) assert.deepEqual(p.roles, ['lims_owner'], `${p.name} mentions a GUC so must be lims_owner only`);
  const get = (n) => { const p = ps.find((x) => x.name === n); assert.ok(p, n); return p.using + ' ' + p.check; };
  const m = get('memberships__select__owner_only');
  assert.match(m, TENANT_PRED('tenant_id'));
  assert.match(m, /user_id\s*=\s*nullif\(\s*current_setting\('app\.pre_user_id', ?true\), ?''\)::uuid/i);
  const u = get('users__select__owner_only');
  assert.match(u, /id\s*=\s*nullif\(\s*current_setting\('app\.pre_user_id', ?true\), ?''\)::uuid/i);
  assert.match(u, /current_setting\('app\.maintenance', ?true\)\s*=\s*'identity_tenants_for_email_hmacs'\s+AND\s+email_hmac\s+IS\s+NOT\s+NULL/i);
  const r = get('roles__select__owner_only');
  assert.match(r, /tenant_id\s*=\s*nullif\(\s*current_setting\('app\.pre_tenant_id', ?true\), ?''\)::uuid/i);
  const t = get('tenants__select__owner_only');
  assert.match(t, /id\s*=\s*nullif\(\s*current_setting\('app\.pre_tenant_id', ?true\), ?''\)::uuid/i);
  assert.match(t, /current_setting\('app\.maintenance', ?true\)\s*=\s*'platform_list_tenants'/i);
  assert.match(t, /current_setting\('app\.maintenance', ?true\)\s*=\s*'cron_tenant_ids'\s+AND\s+status\s+IN\s+\('active', ?'suspended'\)/i);
  assert.match(t, /tenant_code\s*=\s*nullif\(\s*current_setting\('app\.pre_tenant_code', ?true\), ?''\)/i);
  const mr = get('membership_roles__select__owner_only');
  assert.match(mr, /app\.pre_tenant_id/); assert.match(mr, /app\.pre_user_id/);
  assert.match(mr, /core\.memberships/i, 'membership_roles owner policy joins a membership of pre_user_id');
  const mc = get('membership_centres__select__owner_only');
  assert.ok(mc.length > 0);
});

test('audit.audit_log policies: staff guard + cast centre clause; owner INSERT with three branches; no UPDATE/DELETE policy (AC-0B-5.3, 08 A12.5, A16.1, A28.5, A28.6)', () => {
  const ps = policies(all());
  const sel = ps.find((p) => p.name === 'audit_log__select__tenant');
  assert.match(sel.using, GUARD);
  assert.match(sel.using, /centre_id IS NULL OR \(\s*SELECT\s+app\.has_all_centres\(\)\s*\) OR centre_id = ANY \(\(\s*SELECT\s+app\.current_centre_ids\(\)\s*\)::uuid\[\]\)/i);
  const sel2 = ps.find((p) => p.name === 'access_log__select__tenant');
  assert.match(sel2.using, /centre_id = ANY \(\(\s*SELECT\s+app\.current_centre_ids\(\)\s*\)::uuid\[\]\)/i);
  for (const p of ps) if (/current_centre_ids\(\)/.test(p.using + p.check)) assert.match(p.using + p.check, /current_centre_ids\(\)\s*\)\s*::uuid\[\]/, `${p.name}: cast form (A16.1)`);
  const ins = ps.find((p) => p.name === 'audit_log__insert__owner_only');
  assert.deepEqual(ins.roles, ['lims_owner']);
  assert.match(ins.check, TENANT_PRED('tenant_id'), 'branch 1: tenant claim');
  assert.match(ins.check, /schema_name = 'core' AND table_name = 'tenants' AND row_id = tenant_id/i, 'branch 2: platform-context core.tenants row');
  assert.match(ins.check, /app\.is_platform_actor\(\)/i);
  assert.match(ins.check, /actor_id IS NULL AND actor_type = 'system'/i, 'branch 3: maintenance');
  assert.match(ins.check, /detail ->> 'maintenance' = current_setting\('app\.maintenance', ?true\)/i);
  assert.ok(!ps.some((p) => p.table === 'audit.audit_log' && ['UPDATE', 'DELETE'].includes(p.cmd)), 'audit_log is append-only');
});

test('grants per §5; lims_app has no INSERT on audit_log (AC-0B-5.3); nothing to PUBLIC', () => {
  const sql = all();
  const g = {};
  for (const s of stmts(sql)) {
    const m = /^GRANT\s+([\w, ]+?)\s+ON\s+(?:TABLE\s+)?([\w., ]+?)\s+TO\s+([\w, ]+)$/i.exec(ws(s));
    if (!m || /^(EXECUTE|USAGE|CREATE)\b/i.test(m[1])) continue;
    for (const t of m[2].split(',').map((x) => x.trim())) for (const r of m[3].split(',').map((x) => x.trim()))
      (g[`${t}|${r}`] ??= new Set()), m[1].split(',').forEach((p) => g[`${t}|${r}`].add(p.trim().toUpperCase()));
  }
  const want = (t, ...p) => assert.deepEqual([...(g[`${t}|lims_app`] ?? [])].sort(), p.sort(), `lims_app on ${t}`);
  for (const t of ['tenants', 'branches', 'collection_centres', 'users', 'memberships', 'roles']) want(`core.${t}`, 'SELECT', 'INSERT', 'UPDATE');
  for (const t of ['membership_centres', 'role_permissions', 'membership_roles']) want(`core.${t}`, 'SELECT', 'INSERT', 'DELETE');
  want('core.g_permissions', 'SELECT'); want('audit.g_cs_access_actions', 'SELECT');
  want('audit.audit_log', 'SELECT'); want('audit.access_log', 'SELECT', 'INSERT');
  assert.ok(!g['audit.audit_log|lims_app'].has('INSERT'));
  for (const k of Object.keys(g)) assert.doesNotMatch(k, /\|(public|anon|authenticated|lims_api|lims_worker)$/i, `no direct grant ${k} (privileges go through lims_app)`);
  assert.doesNotMatch(sql, /GRANT\s+[^;]*\bTO\s+(PUBLIC|anon|authenticated)\b/i);
});

test('app.has_all_centres / app.current_centre_ids: DEFINER, pinned search_path, R3 CASE, is_active, grants (schema test 17 helpers-positive)', () => {
  const sql = all();
  const h = ws(fnText(sql, 'has_all_centres') ?? '');
  assert.ok(h, 'has_all_centres defined');
  assert.match(h, /RETURNS boolean/i); assert.match(h, /STABLE/i); assert.match(h, /SECURITY DEFINER/i); assert.match(h, /SET search_path = ''/i);
  assert.match(h, /CASE app\.current_actor_type\(\)/i);
  assert.match(h, /WHEN 'system' THEN app\.current_tenant_id\(\) IS NOT NULL/i);
  assert.match(h, /WHEN 'user' THEN coalesce\(\(SELECT m\.all_centres FROM core\.memberships m/i);
  assert.match(h, /m\.is_active/i); assert.match(h, /ELSE false/i);
  const c = ws(fnText(sql, 'current_centre_ids') ?? '');
  assert.ok(c, 'current_centre_ids defined');
  assert.match(c, /RETURNS uuid\[\]/i); assert.match(c, /SECURITY DEFINER/i); assert.match(c, /SET search_path = ''/i);
  assert.match(c, /WHEN 'device' THEN coalesce\(ARRAY\[nullif\(app\.current_claims\(\) ->> 'centre_id', ''\)::uuid\], '\{\}'\)/i);
  assert.match(c, /JOIN core\.membership_centres mc ON mc\.tenant_id = m\.tenant_id AND mc\.membership_id = m\.id/i);
  assert.match(c, /m\.is_active/i);
  assert.match(ws(sql), /GRANT EXECUTE ON FUNCTION [^;]*app\.has_all_centres\(\)[^;]*app\.current_centre_ids\(\)[^;]* TO lims_app, lims_queue/i);
  assert.doesNotMatch(ws(sql), /GRANT EXECUTE[^;]*app\.(has_all_centres|current_centre_ids)[^;]*TO [^;]*(PUBLIC|lims_analytics)/i);
});

test('app.enforce_mutable_columns: INVOKER, coalesce on TG_ARGV, immutable_row (schema test 25, 08 A20.3)', () => {
  const f = ws(fnText(all(), 'enforce_mutable_columns') ?? '');
  assert.ok(f, 'enforce_mutable_columns defined');
  assert.match(f, /RETURNS trigger/i);
  assert.doesNotMatch(f, /SECURITY DEFINER/i, 'INVOKER (CV §5.7)');
  assert.match(f, /SET search_path = ''/i);
  assert.equal((f.match(/coalesce\(\s*TG_ARGV::text\[\]\s*,\s*'\{\}'\s*\)/gi) ?? []).length, 2, 'coalesce on both OLD and NEW side');
  assert.match(f, /IS DISTINCT FROM/i);
  assert.match(f, /ERRCODE = 'P0001'/); assert.match(f, /MESSAGE = 'immutable_row'/);
  assert.doesNotMatch(f, /(?<!coalesce\()TG_ARGV::text\[\]\s*\)\s*IS DISTINCT/i);
});

test('app.tg_row_audit: DEFINER, coalesce TG_ARGV, NULL-tenant skip before the context check, maintenance branch, core.tenants own id (schema tests 18, 20, 28, 32)', () => {
  const f = ws(fnText(all(), 'tg_row_audit') ?? '');
  assert.ok(f, 'tg_row_audit defined');
  assert.match(f, /RETURNS trigger/i); assert.match(f, /SECURITY DEFINER/i); assert.match(f, /SET search_path = ''/i);
  assert.match(f, /coalesce\(\s*TG_ARGV::text\[\]\s*,\s*'\{\}'\s*\)/i, 'excluded list coalesced (08 A15.5)');
  const iSkip = f.search(/IS NULL THEN RETURN NULL/i), iCtx = f.search(/audit_context_missing/);
  assert.ok(iSkip > 0 && iCtx > 0 && iSkip < iCtx, 'NULL-tenant skip is checked before audit_context_missing can raise (D-215)');
  assert.match(f, /NOT \(TG_TABLE_SCHEMA = 'core' AND TG_TABLE_NAME = 'tenants'\)/i, 'core.tenants is never skipped');
  assert.match(f, /current_setting\('app\.maintenance', ?true\)/i);
  assert.match(f, /v_sub IS NULL AND v_maint IS NULL|IS NULL AND [\w_]+ IS NULL THEN RAISE EXCEPTION/i);
  assert.match(f, /ERRCODE = 'P0001'/); assert.match(f, /MESSAGE = 'audit_context_missing'/);
  assert.match(f, /jsonb_build_object\('maintenance'/i); assert.match(f, /'system'/);
  assert.match(f, /'tenants' THEN v_row ->> 'id'|TG_TABLE_NAME = 'tenants' THEN [\w_]+ ->> 'id'/i, 'core.tenants audited under its own id (A12.5)');
  assert.match(f, /'updated_at', ?'updated_by', ?'version'/i, 'bookkeeping columns excluded from changed_columns');
  for (const g of ['app.request_id', 'app.client_ip', 'app.user_agent']) assert.ok(f.includes(`'${g}'`), `${g} copied`);
  assert.match(f, /app\.uuidv7\(\)/);
  assert.doesNotMatch(f, /\bDISABLE\b/i);
});

test('tg_row_audit attached AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW with no arguments to the audited class-M tables, and nowhere else (08 A12.5)', () => {
  const sql = ws(all());
  for (const t of ['tenants', ...M_TABLES]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER \\w+ AFTER INSERT OR UPDATE OR DELETE ON core\\.${t} FOR EACH ROW EXECUTE (FUNCTION|PROCEDURE) app\\.tg_row_audit\\(\\)`, 'i'), `audit trigger on core.${t}`);
  }
  assert.match(sql, /CREATE TRIGGER tenants__audit AFTER INSERT OR UPDATE OR DELETE ON core\.tenants/i);
  const attached = [...sql.matchAll(/CREATE TRIGGER \w+ [^;]*? ON ([\w.]+) [^;]*?app\.tg_row_audit\(([^)]*)\)/gi)];
  for (const [, tbl, args] of attached) {
    assert.doesNotMatch(tbl, /^audit\./, `${tbl}: audit tables are not audited`);
    assert.doesNotMatch(tbl, /^core\.g_/, `${tbl}: class G not audited`);
    assert.doesNotMatch(tbl, /platform_(staff|events)/, `${tbl}: platform-only tables not audited`);
    assert.equal(args.trim(), '', `${tbl}: no trigger arguments (schema test 20 relies on the argument-less form)`);
  }
});

test('db/policies/core.sql contains exactly the CREATE POLICY statements of the core.* tables of the migrations (AC-0B-2.3)', () => {
  const norm = (p) => p.text.replace(/\s*([(),=])\s*/g, '$1').toLowerCase();
  const mig = policies(all()).filter((p) => p.table.startsWith('core.')).map(norm).sort();
  const pol = existsSync(root + 'db/policies/core.sql') ? policies(strip(readFileSync(root + 'db/policies/core.sql', 'utf8'))).map(norm).sort() : [];
  assert.ok(mig.length > 0, 'migrations create core policies');
  assert.deepEqual(pol, mig);
  if (existsSync(root + 'db/policies/audit.sql')) {
    const a = policies(strip(readFileSync(root + 'db/policies/audit.sql', 'utf8'))).map(norm).sort();
    assert.deepEqual(a, policies(all()).filter((p) => p.table.startsWith('audit.')).map(norm).sort());
  }
});

test('db/tests/** never disables RLS and every non-temp stand-in table has ENABLE + FORCE RLS (AC-0B-2.4, schema test 13)', () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + e.name + '/') : [d + e.name]));
  for (const f of walk(root + 'db/tests/').filter((x) => /\.(sql|mjs)$/.test(x) && !/spikes/.test(x))) {
    const s = strip(readFileSync(f, 'utf8'));
    if (f.endsWith('.mjs')) continue; // JS decision tests may mention the keywords as strings
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, `${f}`);
    for (const m of s.matchAll(/CREATE\s+(?!TEMP|TEMPORARY)(?:UNLOGGED\s+)?TABLE\s+([\w.]+)/gi)) {
      const t = m[1].replace('.', '\\.');
      assert.match(s, new RegExp(`ALTER\\s+TABLE\\s+${t}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${f}: ${m[1]} ENABLE RLS`);
      assert.match(s, new RegExp(`ALTER\\s+TABLE\\s+${t}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${f}: ${m[1]} FORCE RLS`);
    }
  }
});

test('migrations contain no real-looking secrets or PHI fixtures (CLAUDE.md: synthetic data only)', () => {
  const sql = all();
  assert.doesNotMatch(sql, /PASSWORD\s+'[^']+'/i);
  assert.doesNotMatch(sql, /\b\d{10}\b.*@/);
});
