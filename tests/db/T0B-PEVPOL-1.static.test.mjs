// T0B-PEVPOL-1 (C0, LD-257, CR-C0-T0B-REVIEW-1-001): static checks of db/migrations/20261116020000_reporting__narrow_provider_events_update_policy.sql and db/policies/reporting.sql.
// reporting.provider_events__update__tenant (lims_app, UPDATE) becomes
//   USING      tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system' AND applied_at IS NULL
//   WITH CHECK the same, with applied_at IS NOT NULL
// The migration holds the leading `SET LOCAL ROLE lims_owner` and exactly one ALTER POLICY, no other statement kind; db/policies/reporting.sql carries the same text; the UPDATE grant stays.
// NOT RUN in the lane: db/tests/reporting/T0B-PEVPOL-1_provider_events_update.test.sql (pgTAP) and the migration; the founder runs db/tests/run-suites.sh before push-cloud.ps1.
// Run: node --test tests/db/T0B-PEVPOL-1.static.test.mjs      (T0BPE1_ROOT=<dir> points the checks at another tree)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0BPE1_ROOT ? resolve(process.env.T0BPE1_ROOT) + '/' : repo;
const MIG = '20261116020000_reporting__narrow_provider_events_update_policy.sql';
const POL = 'provider_events__update__tenant', TBL = 'reporting.provider_events';
const BASE = "tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system'";
const USING = `${BASE} AND applied_at IS NULL`, CHECK = `${BASE} AND applied_at IS NOT NULL`;
const WIDE = 'tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())';   // the text the schema migration created

// ------------------------------------------------------------------------------------------------ helpers
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').toLowerCase();
function unwrap(x) {   // "( a AND (b) )" -> "a AND (b)" only when the first "(" closes at the very end
  x = x.trim();
  if (x[0] !== '(' || x.at(-1) !== ')') return x;
  let d = 0;
  for (let i = 0; i < x.length - 1; i++) { d += x[i] === '(' ? 1 : x[i] === ')' ? -1 : 0; if (d === 0) return x; }
  return x.slice(1, -1).trim();
}
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
// "USING (..) WITH CHECK (..)" tail -> { using, check } (normalised, outer parens removed)
function clauses(rest) {
  const wi = rest.search(/\bWITH\s+CHECK\b/i);
  const u = /^\s*USING\b/i.test(rest) ? (wi < 0 ? rest : rest.slice(0, wi)).replace(/^\s*USING\s*/i, '') : '';
  const c = wi < 0 ? '' : rest.slice(wi).replace(/^\s*WITH\s+CHECK\s*/i, '');
  return { using: u ? norm(unwrap(u)) : '', check: c ? norm(unwrap(c)) : '' };
}
const want = { using: norm(USING), check: norm(CHECK) };

// returns the list of defects of a migration text (empty = fine)
function migrationDefects(text) {
  const bad = [];
  const sts = splitStatements(strip(text)).map(ws);
  // 02-CONVENTIONS.md:717 + db/tools/check-migrations.ts: first statement is exactly one `SET LOCAL ROLE lims_owner`; a second SET/RESET ROLE falls through to the ALTER POLICY check below and is a defect.
  if (sts.length && /^SET LOCAL ROLE lims_owner$/i.test(sts[0])) sts.shift(); else bad.push('first statement must be SET LOCAL ROLE lims_owner');
  if (sts.length !== 1) bad.push(`expected exactly 1 statement after the role switch, found ${sts.length}`);
  for (const s of sts.slice(0, 1)) {
    const m = /^ALTER POLICY (\w+) ON ([\w.]+) (USING|WITH CHECK) ([\s\S]*)$/i.exec(s);
    if (!m) { bad.push(`not an ALTER POLICY .. USING/WITH CHECK: ${s.slice(0, 90)}`); continue; }
    if (m[1] !== POL) bad.push(`unexpected policy ${m[1]}`);
    if (m[2].toLowerCase() !== TBL) bad.push(`unexpected table ${m[2]}`);
    const got = clauses(`${m[3]} ${m[4]}`);
    if (got.using !== want.using) bad.push(`USING: ${got.using || '(none)'}`);
    if (got.check !== want.check) bad.push(`WITH CHECK: ${got.check || '(none)'}`);
  }
  return bad;
}

const migPath = root + 'db/migrations/' + MIG;
const migFiles = () => readdirSync(root + 'db/migrations').filter((f) => f.endsWith('.sql')).sort();
const polText = () => strip(readFileSync(root + 'db/policies/reporting.sql', 'utf8'));
// every CREATE POLICY of a text -> { name, table, cmd, roles, using, check }
function createPolicies(sql, only = /./) {
  return splitStatements(sql).map(ws).filter((s) => /^CREATE POLICY /i.test(s) && only.test(s)).map((s) => {
    const m = /^CREATE POLICY (\w+) ON ([\w.]+) FOR (\w+) TO ([\w, ]+?) (?=USING|WITH)([\s\S]*)$/i.exec(s);
    assert.ok(m, `parsable policy: ${s.slice(0, 100)}`);
    return { name: m[1], table: m[2], cmd: m[3].toUpperCase(), roles: m[4], ...clauses(m[5]) };
  });
}
const isPe = (p) => p.name === POL && p.table.toLowerCase() === TBL;

// ------------------------------------------------------------------------------------------------ the checker itself rejects wrong migrations (mutants of the expected text)
const GOOD = `-- LD-257
SET LOCAL ROLE lims_owner;
ALTER POLICY ${POL} ON ${TBL}
  USING      (${USING})
  WITH CHECK (${CHECK});
`;
test('checker self-test: the expected text passes, every mutant is rejected', () => {
  assert.deepEqual(migrationDefects(GOOD), [], 'expected text must pass');
  const mutants = {
    'USING without applied_at IS NULL': GOOD.replace(`${BASE} AND applied_at IS NULL`, BASE),
    'USING with applied_at IS NOT NULL': GOOD.replace('AND applied_at IS NULL', 'AND applied_at IS NOT NULL'),
    'WITH CHECK without applied_at IS NOT NULL': GOOD.replace(`${BASE} AND applied_at IS NOT NULL`, BASE),
    'WITH CHECK with applied_at IS NULL': GOOD.replace('AND applied_at IS NOT NULL', 'AND applied_at IS NULL'),
    'system test dropped from USING': GOOD.replace(" AND (SELECT app.current_actor_type()) = 'system' AND applied_at IS NULL", ' AND applied_at IS NULL'),
    'system test dropped from WITH CHECK': GOOD.replace(" AND (SELECT app.current_actor_type()) = 'system' AND applied_at IS NOT NULL", ' AND applied_at IS NOT NULL'),
    'device instead of system': GOOD.replace(/'system'/g, "'device'"),
    'user instead of system': GOOD.replace(/'system'/g, "'user'"),
    'actor type IN (system, user)': GOOD.replace(/\(SELECT app\.current_actor_type\(\)\) = 'system'/g, "(SELECT app.current_actor_type()) IN ('system','user')"),
    'actor type call not wrapped in (SELECT ...)': GOOD.replace(/\(SELECT app\.current_actor_type\(\)\)/g, 'app.current_actor_type()'),
    'tenant call not wrapped in (SELECT ...)': GOOD.replace(/\(SELECT app\.current_tenant_id\(\)\)/g, 'app.current_tenant_id()'),
    'staff guard not wrapped in (SELECT ...)': GOOD.replace(/\(SELECT app\.is_staff_or_system\(\)\)/g, 'app.is_staff_or_system()'),
    'staff guard dropped': GOOD.replace(/ AND \(SELECT app\.is_staff_or_system\(\)\)/g, ''),
    'tenant bound dropped': GOOD.replace(/tenant_id = \(SELECT app\.current_tenant_id\(\)\) AND /g, ''),
    'OR true in USING': GOOD.replace('AND applied_at IS NULL)', 'AND applied_at IS NULL OR true)'),
    'OR true in WITH CHECK': GOOD.replace('AND applied_at IS NOT NULL)', 'AND applied_at IS NOT NULL OR true)'),
    'USING only (no WITH CHECK)': GOOD.replace(/\n {2}WITH CHECK \([^\n]*\);\n$/, ';\n'),
    'WITH CHECK only (no USING)': GOOD.replace(/\n {2}USING {6}\([^\n]*\)\n/, '\n'),
    'other policy altered (insert)': GOOD.replace(`ALTER POLICY ${POL}`, 'ALTER POLICY provider_events__insert__tenant'),
    'other table': GOOD.replace(`ON ${TBL}`, 'ON reporting.delivery_attempts'),
    'second ALTER POLICY': GOOD + `ALTER POLICY provider_events__select__tenant ON ${TBL} USING (true);\n`,
    'extra DROP POLICY': GOOD + `DROP POLICY provider_events__insert__tenant ON ${TBL};\n`,
    'extra REVOKE': GOOD + `REVOKE UPDATE ON ${TBL} FROM lims_app;\n`,
    'extra GRANT': GOOD + `GRANT SELECT ON ${TBL} TO lims_app;\n`,
    'extra ALTER TABLE': GOOD + `ALTER TABLE ${TBL} ADD COLUMN x int;\n`,
    'extra CREATE POLICY': GOOD + `CREATE POLICY provider_events__update__x ON ${TBL} FOR UPDATE TO lims_app USING (true);\n`,
    'CREATE POLICY instead of ALTER': GOOD.replace(`ALTER POLICY ${POL} ON ${TBL}\n  USING     `, `CREATE POLICY ${POL} ON ${TBL} FOR UPDATE TO lims_app USING`),
    'missing SET LOCAL ROLE': GOOD.replace('SET LOCAL ROLE lims_owner;\n', ''),
    'role switch not first': GOOD.replace('SET LOCAL ROLE lims_owner;\n', '') + 'SET LOCAL ROLE lims_owner;\n',
    'second role switch': GOOD + 'RESET ROLE;\n',
    'other role': GOOD.replace('lims_owner', 'lims_app'),
    'empty migration': '-- nothing\n',
  };
  for (const [what, text] of Object.entries(mutants)) assert.notDeepEqual(migrationDefects(text), [], `mutant not rejected: ${what}`);
});

// ------------------------------------------------------------------------------------------------ the migration
test('migration file exists and sorts after every other migration (strictly newest)', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing (T0B-PEVPOL-1 writer creates it)`);
  const others = migFiles().filter((f) => f !== MIG);
  assert.ok(others.length > 0);
  for (const f of others) assert.ok(MIG > f, `${MIG} must sort after ${f}`);
  assert.equal(migFiles().at(-1), MIG, 'the new migration is the last file of db/migrations');
  assert.match(MIG, /^\d{14}_reporting__[a-z0-9_]+\.sql$/);
});
test('migration: leading SET LOCAL ROLE lims_owner, then exactly one ALTER POLICY provider_events__update__tenant with the narrowed USING and WITH CHECK; nothing else', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing`);
  assert.deepEqual(migrationDefects(readFileSync(migPath, 'utf8')), []);
});
test('migration: no DROP, REVOKE, GRANT, CREATE, table or column change anywhere in the text', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing`);
  const t = strip(readFileSync(migPath, 'utf8'));
  assert.doesNotMatch(t, /\b(DROP|REVOKE|GRANT|CREATE|TRUNCATE|DELETE|INSERT|UPDATE\s+\w+\.\w+\s+SET|ALTER\s+TABLE|ALTER\s+FUNCTION|RESET)\b/i);
  assert.equal([...t.matchAll(/\bALTER\s+POLICY\b/gi)].length, 1, 'exactly one ALTER POLICY');
  assert.equal([...t.matchAll(/\bSET\s+(LOCAL\s+)?ROLE\b/gi)].length, 1, 'exactly one role switch');
});
test('migration: applied_at IS NULL only in USING, applied_at IS NOT NULL only in WITH CHECK (explicit per clause)', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing`);
  const s = ws(strip(readFileSync(migPath, 'utf8')));
  const m = /ALTER POLICY \w+ ON [\w.]+ USING (.*) WITH CHECK (.*?);?$/i.exec(s.replace(/^SET LOCAL ROLE lims_owner;\s*/i, '').replace(/;$/, ''));
  assert.ok(m, 'USING ... WITH CHECK ... present');
  assert.match(m[1], /applied_at IS NULL/i); assert.doesNotMatch(m[1], /applied_at IS NOT NULL/i);
  assert.match(m[2], /applied_at IS NOT NULL/i); assert.doesNotMatch(m[2], /applied_at IS NULL/i);
  for (const c of [m[1], m[2]]) assert.match(c, /\(SELECT app\.current_actor_type\(\)\)\s*=\s*'system'/i);
});
test('migration is additive: the schema migration still CREATEs the wide policy once and keeps the UPDATE grant; no other migration touches the policy, the grant or the mutable-columns trigger of provider_events', () => {
  const others = migFiles().filter((f) => f !== MIG);
  const created = others.flatMap((f) => createPolicies(strip(readFileSync(root + 'db/migrations/' + f, 'utf8')), /\bON\s+reporting\.provider_events\b/i).filter(isPe).map((p) => ({ f, ...p })));
  assert.equal(created.length, 1, 'provider_events__update__tenant is created exactly once in the earlier migrations');
  assert.equal(created[0].using, norm(WIDE), 'earlier migration text stays as it was (history)');
  assert.equal(created[0].check, norm(WIDE));
  const all = others.map((f) => strip(readFileSync(root + 'db/migrations/' + f, 'utf8'))).join('\n;\n');
  assert.match(all, /GRANT\s+SELECT,\s*INSERT,\s*UPDATE\s+ON\s+reporting\.provider_events\s+TO\s+lims_app/i, 'the lims_app UPDATE grant is still granted');
  assert.doesNotMatch(all, /REVOKE\b[^;]*\breporting\.provider_events\b/i, 'no REVOKE on provider_events');
  assert.doesNotMatch(all, /(ALTER|DROP)\s+POLICY\s+provider_events__/i, 'no earlier ALTER/DROP of a provider_events policy');
  assert.match(all, /provider_events__mutable_columns[\s\S]{0,120}enforce_mutable_columns\('applied_at','delivery_id','ignored_reason'\)/i, 'the mutable-columns trigger on the three apply columns is still there');
  assert.doesNotMatch(all, /DROP\s+TRIGGER[^;]*provider_events__mutable_columns/i);
});

// ------------------------------------------------------------------------------------------------ db/policies/reporting.sql
test('db/policies/reporting.sql: provider_events__update__tenant carries the narrowed text, once, FOR UPDATE TO lims_app', () => {
  const ps = createPolicies(polText()).filter(isPe);
  assert.equal(ps.length, 1, 'exactly one definition of the policy');
  const p = ps[0];
  assert.equal(p.cmd, 'UPDATE'); assert.equal(p.roles, 'lims_app');
  assert.equal(p.using, want.using, 'USING'); assert.equal(p.check, want.check, 'WITH CHECK');
});
test('db/policies/reporting.sql: the other provider_events policies are untouched (select / insert tenant wide text, lookup policies present, no extra policy)', () => {
  const ps = createPolicies(polText()).filter((p) => p.table.toLowerCase() === TBL);
  const by = Object.fromEntries(ps.map((p) => [p.name, p]));
  assert.deepEqual(ps.map((p) => p.name).sort(), ['provider_events__insert__lookup', 'provider_events__insert__tenant', 'provider_events__select__lookup', 'provider_events__select__tenant', 'provider_events__update__tenant'], 'no extra, no missing policy');
  assert.deepEqual([by.provider_events__select__tenant.cmd, by.provider_events__select__tenant.roles, by.provider_events__select__tenant.using, by.provider_events__select__tenant.check], ['SELECT', 'lims_app', norm(WIDE), '']);
  assert.deepEqual([by.provider_events__insert__tenant.cmd, by.provider_events__insert__tenant.roles, by.provider_events__insert__tenant.using, by.provider_events__insert__tenant.check], ['INSERT', 'lims_app', '', norm(WIDE)]);
});
test('db/policies/reporting.sql: only provider_events__update__tenant differs from the schema migration text of the same policy (every other policy is still a verbatim copy)', () => {
  const file = new Map(createPolicies(polText()).map((p) => [`${p.name}@${p.table}`, JSON.stringify([p.cmd, p.roles, p.using, p.check])]));
  const diffs = [];
  for (const f of migFiles().filter((x) => x !== MIG && /_reporting__/.test(x))) {
    for (const p of createPolicies(strip(readFileSync(root + 'db/migrations/' + f, 'utf8')), /\bON\s+reporting\./i).filter((q) => q.table.startsWith('reporting.'))) {
      if (file.get(`${p.name}@${p.table}`) !== JSON.stringify([p.cmd, p.roles, p.using, p.check])) diffs.push(p.name);
    }
  }
  assert.deepEqual(diffs.filter((n) => !/^event_inbox__/.test(n)), [POL], 'the policy file differs from the earlier migrations in exactly this policy');
});

// ------------------------------------------------------------------------------------------------ the pgTAP file and the notes (reviewed by reading only; here: they exist and cover (a)..(e))
test('pgTAP file db/tests/reporting/T0B-PEVPOL-1_provider_events_update.test.sql covers (a) system stamp n=1, (b) second UPDATE n=0, (c) user / device n=0, (d) NULL applied_at 42501, (e) immutable_row', () => {
  const f = root + 'db/tests/reporting/T0B-PEVPOL-1_provider_events_update.test.sql';
  assert.ok(existsSync(f), 'pgTAP file missing');
  const t = readFileSync(f, 'utf8');
  for (const k of ['(a)', '(b)', '(c)', '(d)', '(e)']) assert.ok(t.includes(`'${k} `), `assertion ${k}`);
  assert.match(t, /'n=1'/); assert.match(t, /'n=0'/); assert.match(t, /E42501/); assert.match(t, /immutable_row/);
  assert.match(t, /'user'/); assert.match(t, /'device'/); assert.match(t, /applied_at = NULL/);
  assert.match(t, /provider_events__update__tenant/);
  assert.match(t, /NOT RUN in the lane/); assert.match(t, /run-suites\.sh/); assert.match(t, /push-cloud\.ps1/);
});
test('notes: T0B-PEVPOL-1-tests.md says the pgTAP file and the migration were NOT run, names run-suites.sh before push-cloud.ps1, the C6 05-SCHEMA s5 spec follow-up and test 462; verify.cmd is one line', () => {
  const n = root + '.orchestra/notes/T0B-PEVPOL-1-tests.md', v = root + '.orchestra/notes/T0B-PEVPOL-1-verify.cmd';
  assert.ok(existsSync(n) && existsSync(v), 'notes missing');
  const t = readFileSync(n, 'utf8');
  assert.match(t, /NOT run/i); assert.match(t, /run-suites\.sh/); assert.match(t, /push-cloud\.ps1/);
  assert.match(t, /05-SCHEMA/); assert.match(t, /applied_at IS NULL/); assert.match(t, /\b462\b/);
  assert.equal(readFileSync(v, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length, 1, 'verify.cmd is exactly one line');
});
