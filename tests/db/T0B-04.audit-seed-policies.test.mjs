// T0B-04 static checks: access-action seed equality (05-SCHEMA §3.7; 08 A13 P-3), db/policies/audit.sql (AC-0B-2.3 style),
// request-id / support-session indexes + CR-C2-010 centre clause (08 A28.6), class-A grants (AC-0B-4.3, AC-0B-5.3).
// Run: node --test tests/db/T0B-04.audit-seed-policies.test.mjs   (live-DB assertions: db/tests/audit/T0B-04_audit.test.sql, pg_prove)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const strip = (s) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').toLowerCase();
const CODE = /^[a-z_]+\.[a-z_]+$/;

const migDir = root + 'db/migrations/';
const auditMigs = () => readdirSync(migDir).filter((f) => /^\d{14}_audit__create_[a-z0-9_]+\.sql$/.test(f)).sort();
const migSql = () => auditMigs().map((f) => strip(readFileSync(migDir + f, 'utf8'))).join('\n');
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const policyStmts = (sql) => stmts(sql).filter((s) => /^CREATE\s+POLICY\b/i.test(s)).map(ws);
const policyName = (p) => /^CREATE\s+POLICY\s+(\w+)\s+ON\s+([\w.]+)/i.exec(p).slice(1, 3).join('@');
const auditPolicyFile = () => {
  assert.ok(existsSync(root + 'db/policies/audit.sql'), 'db/policies/audit.sql exists');
  return policyStmts(strip(readFileSync(root + 'db/policies/audit.sql', 'utf8')));
};

// ---------- expected seed = C0 base list (05-SCHEMA §3.7) ∪ 03-IC §13.1 YAML block ----------
function baseList() {
  const s = readFileSync(root + 'spec/chunks/C0-foundation-contracts/05-SCHEMA.md', 'utf8');
  const i = s.indexOf('C0 base list [CONV; chunks add codes by CR]:');
  assert.ok(i > 0, 'base list marker in 05-SCHEMA §3.7');
  const j = s.indexOf('Additions (08', i);
  assert.ok(j > i, 'end of base list');
  return [...s.slice(i, j).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}
function ic131() {
  const s = readFileSync(root + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8').replace(/\r\n?/g, '\n');
  const i = s.indexOf('### 13.1 Access-log action codes');
  assert.ok(i > 0, '03-IC §13.1 heading');
  const a = s.indexOf('```yaml', i), b = s.indexOf('```', a + 7);
  assert.ok(a > i && b > a, '§13.1 yaml block');
  return s.slice(a, b).split('\n').map((l) => /^-\s+(\S+)\s*(#.*)?$/.exec(l)).filter(Boolean).map((m) => m[1]);
}
const expected = () => new Set([...baseList(), ...ic131()]);

const seedPath = root + 'db/seeds/003_audit__g_cs_access_actions.sql';
const seedSql = () => { assert.ok(existsSync(seedPath), 'db/seeds/003_audit__g_cs_access_actions.sql exists'); return strip(readFileSync(seedPath, 'utf8')); };
const seedRows = (sql) => [...sql.matchAll(/\(\s*'([^']*)'\s*,\s*'((?:[^']|'')*)'/g)].map((m) => ({ code: m[1], display: m[2] }));

test('spec parsers sanity: base list and §13.1 block parse into valid codes; removed/reserved/commented codes are excluded', () => {
  const b = baseList(), y = ic131();
  assert.ok(b.length >= 27 && y.length >= 60, `parsed ${b.length} base + ${y.length} yaml codes`);
  for (const c of [...b, ...y]) assert.match(c, CODE, c);
  assert.ok(b.includes('report.view') && b.includes('dead_letter.discard'));
  assert.ok(y.includes('home_visit.view') && y.includes('audit_entry.view'));
  const e = expected();
  for (const c of ['patient.demographics_access', 'tenant_egress_ip.change', 'legacy_document.download']) assert.ok(!e.has(c), `${c} is not seeded`);
});

test('db/seeds/003 seed == base list ∪ 03-IC §13.1 block, exactly (equality test, 08 A13 P-3)', () => {
  const got = seedRows(seedSql()).map((r) => r.code);
  assert.equal(new Set(got).size, got.length, 'no duplicate code in the seed');
  assert.deepEqual([...new Set(got)].sort(), [...expected()].sort());
});

test('seed rows: valid codes, non-empty display, idempotent upsert, owner role, insert-only', () => {
  const sql = seedSql();
  for (const r of seedRows(sql)) { assert.match(r.code, CODE, r.code); assert.ok(r.display.trim().length > 0, `${r.code} display`); }
  assert.match(sql, /SET\s+LOCAL\s+ROLE\s+lims_owner/i, 'seeds run SET LOCAL ROLE lims_owner (02-TRD §4.6)');
  assert.match(sql, /INSERT\s+INTO\s+audit\.g_cs_access_actions\b/i);
  assert.match(sql, /ON\s+CONFLICT\s*(\(\s*code\s*\))?\s*DO\s+NOTHING/i, 'idempotent: ON CONFLICT DO NOTHING');
  const noLiterals = sql.replace(/'(?:[^']|'')*'/g, "''"); // codes such as patient.update are data, not statements
  assert.doesNotMatch(noLiterals, /\b(DELETE|TRUNCATE|DROP|UPDATE|ALTER|GRANT)\b/i, 'seed only inserts');
  assert.doesNotMatch(sql, /DISABLE\s+ROW\s+LEVEL|session_replication_role/i);
});

test('seed header names the generator gen-access-actions (hand edits are caught by the equality test)', () => {
  assert.ok(existsSync(seedPath), 'seed exists');
  assert.match(readFileSync(seedPath, 'utf8').slice(0, 600), /gen-access-actions/);
});

test('003_* is the access-action seed only and sorts after 001/002', () => {
  const f = readdirSync(root + 'db/seeds/').filter((x) => x.endsWith('.sql'));
  assert.deepEqual(f.filter((x) => x.startsWith('003_')), ['003_audit__g_cs_access_actions.sql']);
});

// ---------- db/policies/audit.sql ----------
test('db/policies/audit.sql == the CREATE POLICY statements of audit.* in the migrations (02-TRD §4.2 step 9)', () => {
  const pol = auditPolicyFile();
  const mig = policyStmts(migSql()).filter((p) => /\bON\s+audit\./i.test(p));
  assert.ok(mig.length >= 7, `migrations hold the audit policies (${mig.length})`);
  assert.deepEqual(pol.map(norm).sort(), mig.map(norm).sort());
  assert.equal(new Set(pol.map(policyName)).size, pol.length, 'no duplicate policy');
  assert.ok(!pol.some((p) => /\bON\s+core\./i.test(p)), 'audit.sql holds no core.* policy');
});

test('audit policy inventory: append-only (no UPDATE/DELETE/ALL policy), only lims_owner inserts audit_log, no non-staff SELECT', () => {
  const pol = auditPolicyFile();
  assert.deepEqual(pol.map(policyName).sort(), [
    'access_log__insert__partner@audit.access_log', 'access_log__insert__patient@audit.access_log', 'access_log__insert__portal@audit.access_log',
    'access_log__insert__tenant@audit.access_log', 'access_log__select__tenant@audit.access_log',
    'audit_log__insert__owner_only@audit.audit_log', 'audit_log__select__tenant@audit.audit_log'].sort());
  for (const p of pol) assert.doesNotMatch(p, /\bFOR\s+(UPDATE|DELETE|ALL)\b/i, `append-only: ${policyName(p)}`);
  assert.match(pol.find((p) => p.includes('audit_log__insert__owner_only')), /\bTO\s+lims_owner\b/i);
  assert.doesNotMatch(pol.filter((p) => /\bFOR\s+SELECT\b/i.test(p)).join(' '), /\b(partner|portal|patient)\b/i);
});

test('CR-C2-010 centre clause (cast form) + staff guard + tenant bind in both SELECT policies (08 A28.6, A16.1)', () => {
  const pol = auditPolicyFile();
  for (const n of ['audit_log__select__tenant', 'access_log__select__tenant']) {
    const raw = pol.find((x) => x.includes(n));
    assert.ok(raw, n);
    const p = norm(raw);
    assert.ok(p.includes('tenant_id=(select app.current_tenant_id())'), `${n} tenant bind`);
    assert.ok(p.includes('(select app.is_staff_or_system())'), `${n} staff guard`);
    assert.ok(p.includes(norm('centre_id IS NULL OR (SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])')), `${n} centre clause`);
    assert.doesNotMatch(p, /using\s*\(\s*true\s*\)/, `${n} not USING (true)`);
  }
});

// ---------- indexes (08 A28.6) ----------
test('request-id and support-session partial indexes exist on both audit tables', () => {
  const sql = ws(migSql());
  for (const t of ['audit_log', 'access_log']) {
    assert.match(sql, new RegExp(`CREATE INDEX ${t}__tenant_id_request_id__idx ON audit\\.${t} \\(tenant_id, request_id\\)`, 'i'), `${t} request_id idx`);
    assert.match(sql, new RegExp(`CREATE INDEX ${t}__tenant_id_support_session__p_idx ON audit\\.${t} \\(tenant_id, support_session_id, occurred_at DESC\\) WHERE support_session_id IS NOT NULL`, 'i'), `${t} support_session partial idx`);
  }
});

// ---------- grants (AC-0B-4.3, AC-0B-5.3) ----------
test('class-A grants: lims_app has no INSERT on audit_log, no UPDATE/DELETE/TRUNCATE on either table, no other grantee', () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + e.name + '/') : [d + e.name]));
  const sql = walk(root + 'db/').filter((f) => /\/(migrations|policies|seeds)\/[^/]*\.sql$/.test(f)).map((f) => strip(readFileSync(f, 'utf8'))).join('\n');
  const grants = stmts(sql).map(ws).filter((s) => /^GRANT\b/i.test(s) && /audit\.(audit_log|access_log)\b/i.test(s));
  assert.ok(grants.some((g) => /^GRANT SELECT ON audit\.audit_log TO lims_app$/i.test(g)), 'GRANT SELECT ON audit.audit_log TO lims_app');
  for (const g of grants) {
    assert.doesNotMatch(g, /\b(UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)\b/i, `no mutating privilege: ${g}`);
    assert.match(g, /\bTO\s+lims_app$/i, `grant only to lims_app: ${g}`);
    if (/audit\.audit_log\b/i.test(g)) assert.doesNotMatch(g, /\bINSERT\b/i, `AC-0B-5.3 no INSERT on audit_log: ${g}`);
  }
  assert.doesNotMatch(sql, /GRANT\s+[^;]*ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+audit\b/i, 'no schema-wide grant on audit');
  assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\baudit\b[^;]*\bTO\s+(lims_app|PUBLIC)\b/i, 'no default privileges onto audit');
  assert.match(sql, /GRANT\s+SELECT\s+ON\s+audit\.g_cs_access_actions\s+TO\s+lims_app/i, 'coded set readable by lims_app');
});
