// T0B-MFAPOL-1 (C0, LD-252, CR-C0-T0B-REVIEW-1-003): static checks of db/migrations/20261116010000_identity__narrow_mfa_factors_own_policies.sql and db/policies/identity.sql.
// The three identity.mfa_factors __own policies (select USING, insert WITH CHECK, update USING + WITH CHECK) become
//   user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id())      -- the tenant-less IS NOT DISTINCT FROM branch is removed, nothing else.
// The migration holds exactly those three ALTER POLICY statements and no other statement kind; db/policies/identity.sql carries the same three definitions.
// NOT RUN in the lane: db/tests/identity/T0B-MFAPOL-1_mfa_factors_own.test.sql (pgTAP) and the migration; the founder runs db/tests/run-suites.sh before push-cloud.ps1.
// Run: node --test tests/db/T0B-MFAPOL-1.static.test.mjs      (T0BMP1_ROOT=<dir> points the checks at another tree)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0BMP1_ROOT ? resolve(process.env.T0BMP1_ROOT) + '/' : repo;
const MIG = '20261116010000_identity__narrow_mfa_factors_own_policies.sql';
const OWN = ['mfa_factors__select__own', 'mfa_factors__insert__own', 'mfa_factors__update__own'];
const PRED = 'user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id())';
const CMD = { mfa_factors__select__own: 'SELECT', mfa_factors__insert__own: 'INSERT', mfa_factors__update__own: 'UPDATE' };

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
const wantClauses = (name) => ({ using: name === 'mfa_factors__insert__own' ? '' : norm(PRED), check: name === 'mfa_factors__select__own' ? '' : norm(PRED) });

// returns the list of defects of a migration text (empty = fine)
function migrationDefects(text) {
  const bad = [];
  const sts = splitStatements(strip(text)).map(ws);
  // 02-CONVENTIONS.md:717 + db/tools/check-migrations.ts:35-36: first statement is exactly one `SET LOCAL ROLE lims_owner`; a second SET/RESET ROLE falls through to the ALTER POLICY check below and is a defect.
  if (sts.length && /^SET LOCAL ROLE lims_owner$/i.test(sts[0])) sts.shift(); else bad.push('first statement must be SET LOCAL ROLE lims_owner');
  if (sts.length !== 3) bad.push(`expected exactly 3 statements, found ${sts.length}`);
  const seen = new Set();
  for (const s of sts) {
    const m = /^ALTER POLICY (\w+) ON identity\.mfa_factors (USING|WITH CHECK) ([\s\S]*)$/i.exec(s);
    if (!m) { bad.push(`not an ALTER POLICY .. ON identity.mfa_factors USING/WITH CHECK: ${s.slice(0, 90)}`); continue; }
    const name = m[1];
    if (!OWN.includes(name)) { bad.push(`unexpected policy ${name}`); continue; }
    if (seen.has(name)) bad.push(`${name} altered twice`);
    seen.add(name);
    const got = clauses(`${m[2]} ${m[3]}`), want = wantClauses(name);
    if (got.using !== want.using) bad.push(`${name} USING: ${got.using || '(none)'}`);
    if (got.check !== want.check) bad.push(`${name} WITH CHECK: ${got.check || '(none)'}`);
  }
  for (const n of OWN) if (!seen.has(n)) bad.push(`missing ALTER POLICY ${n}`);
  if (/\bis\s+not\s+distinct\s+from\b|\btenant_id\s+is\s+null\b/i.test(strip(text))) bad.push('tenant-less branch still present');
  return bad;
}

const migPath = root + 'db/migrations/' + MIG;
const migFiles = () => readdirSync(root + 'db/migrations').filter((f) => f.endsWith('.sql')).sort();
const polText = () => strip(readFileSync(root + 'db/policies/identity.sql', 'utf8'));
function ownPolicies(sql) {
  return splitStatements(sql).map(ws).filter((s) => /^CREATE POLICY mfa_factors__(select|insert|update)__own\b/i.test(s)).map((s) => {
    const m = /^CREATE POLICY (\w+) ON ([\w.]+) FOR (\w+) TO ([\w, ]+?) (?=USING|WITH)([\s\S]*)$/i.exec(s);
    assert.ok(m, `parsable policy: ${s.slice(0, 100)}`);
    return { name: m[1], table: m[2], cmd: m[3].toUpperCase(), roles: m[4], ...clauses(m[5]) };
  });
}

// ------------------------------------------------------------------------------------------------ the checker itself rejects wrong migrations (mutants of the expected text)
const GOOD = `-- LD-252
SET LOCAL ROLE lims_owner;
ALTER POLICY mfa_factors__select__own ON identity.mfa_factors
  USING (${PRED});
ALTER POLICY mfa_factors__insert__own ON identity.mfa_factors
  WITH CHECK (${PRED});
ALTER POLICY mfa_factors__update__own ON identity.mfa_factors
  USING (${PRED})
  WITH CHECK (${PRED});
`;
test('checker self-test: the expected text passes, every mutant is rejected', () => {
  assert.deepEqual(migrationDefects(GOOD), [], 'expected text must pass');
  const OLD = 'tenant_id = (SELECT app.current_tenant_id())';
  const mutants = {
    'tenant-less branch kept (select)': GOOD.replace(OLD, 'tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id())'),
    'user_id bound dropped': GOOD.replace('user_id = (SELECT app.current_actor_id()) AND ', ''),
    'extra DROP POLICY': GOOD + 'DROP POLICY mfa_factors__select__tenant ON identity.mfa_factors;\n',
    'extra REVOKE': GOOD + 'REVOKE UPDATE ON identity.mfa_factors FROM lims_app;\n',
    'extra GRANT': GOOD + 'GRANT SELECT ON identity.mfa_factors TO lims_app;\n',
    'extra policy altered': GOOD + 'ALTER POLICY mfa_factors__select__tenant ON identity.mfa_factors USING (true);\n',
    'insert has USING': GOOD.replace('WITH CHECK (user', 'USING (user'),
    'update lacks WITH CHECK': GOOD.replace(/\n {2}WITH CHECK \(user_id[^\n]*\);\n$/, ';\n'),
    'missing update policy': GOOD.slice(0, GOOD.indexOf('ALTER POLICY mfa_factors__update__own')),
    'CREATE POLICY instead of ALTER': GOOD.replace('ALTER POLICY mfa_factors__select__own ON identity.mfa_factors\n  USING', 'CREATE POLICY mfa_factors__select__own ON identity.mfa_factors FOR SELECT TO lims_app USING'),
    'OR true': GOOD.replace(`USING (${PRED});`, `USING (${PRED} OR true);`),
    'missing SET LOCAL ROLE': GOOD.replace('SET LOCAL ROLE lims_owner;\n', ''),
    'role switch not first': GOOD.replace('SET LOCAL ROLE lims_owner;\n', '').replace(/(ALTER POLICY mfa_factors__select__own ON identity\.mfa_factors\n {2}USING \([^\n]*\);\n)/, '$1SET LOCAL ROLE lims_owner;\n'),
    'second role switch': GOOD + 'RESET ROLE;\n',
  };
  for (const [what, text] of Object.entries(mutants)) assert.notDeepEqual(migrationDefects(text), [], `mutant not rejected: ${what}`);
});

// ------------------------------------------------------------------------------------------------ the migration
test('migration file exists and sorts after every migration that precedes it (20261116010000 or earlier) and has a unique timestamp', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing (T0B-MFAPOL-1 writer creates it)`);
  const others = migFiles().filter((f) => f !== MIG);
  assert.ok(others.length > 0);
  const ts = (f) => f.slice(0, 14);
  for (const f of others.filter((x) => ts(x) < ts(MIG))) assert.ok(MIG > f, `${MIG} must sort after ${f}`);
  assert.deepEqual(others.filter((x) => ts(x) === ts(MIG)), [], 'no other migration shares the 14-digit timestamp');
  assert.match(MIG, /^\d{14}_identity__[a-z0-9_]+\.sql$/);
});
test('migration: exactly the three ALTER POLICY statements, each equal to user_id = actor AND tenant_id = current tenant; nothing else', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing`);
  assert.deepEqual(migrationDefects(readFileSync(migPath, 'utf8')), []);
});
test('migration: select USING only, insert WITH CHECK only, update USING and WITH CHECK (explicit per statement)', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing`);
  const sts = splitStatements(strip(readFileSync(migPath, 'utf8'))).map(ws).filter((s) => !/^SET LOCAL ROLE lims_owner$/i.test(s));
  const by = Object.fromEntries(sts.map((s) => [/^ALTER POLICY (\w+)/i.exec(s)?.[1], s]));
  assert.match(by.mfa_factors__select__own ?? '', /^ALTER POLICY mfa_factors__select__own ON identity\.mfa_factors USING \(/i);
  assert.doesNotMatch(by.mfa_factors__select__own ?? '', /WITH CHECK/i);
  assert.match(by.mfa_factors__insert__own ?? '', /^ALTER POLICY mfa_factors__insert__own ON identity\.mfa_factors WITH CHECK \(/i);
  assert.doesNotMatch(by.mfa_factors__insert__own ?? '', /\bUSING\b/i);
  assert.match(by.mfa_factors__update__own ?? '', /^ALTER POLICY mfa_factors__update__own ON identity\.mfa_factors USING \(.*\) WITH CHECK \(/i);
});
test('migration is additive: the earlier CREATE POLICY of the three __own policies is not rewritten (history keeps the IS NOT DISTINCT FROM text)', () => {
  const hits = migFiles().filter((f) => f !== MIG).flatMap((f) => ownPolicies(strip(readFileSync(root + 'db/migrations/' + f, 'utf8'))).map((p) => ({ f, ...p })));
  assert.deepEqual(hits.map((h) => h.name).sort(), [...OWN].sort(), 'each __own policy is created exactly once in the earlier migrations');
  for (const h of hits) assert.match(h.using + h.check, /is not distinct from/, `${h.f} ${h.name}: earlier migration text must stay as it was`);
});

// ------------------------------------------------------------------------------------------------ db/policies/identity.sql
test('db/policies/identity.sql: the three __own policies carry the narrowed text, once each, TO lims_app, right command', () => {
  const ps = ownPolicies(polText());
  assert.deepEqual(ps.map((p) => p.name).sort(), [...OWN].sort(), 'exactly one definition of each __own policy');
  for (const p of ps) {
    assert.equal(p.table, 'identity.mfa_factors', p.name);
    assert.equal(p.cmd, CMD[p.name], `${p.name} command`);
    assert.equal(p.roles, 'lims_app', `${p.name} role`);
    const want = wantClauses(p.name);
    assert.equal(p.using, want.using, `${p.name} USING`);
    assert.equal(p.check, want.check, `${p.name} WITH CHECK`);
    assert.doesNotMatch(p.using + p.check, /distinct|is null/, `${p.name}: no tenant-less branch`);
  }
});
test('db/policies/identity.sql: the other identity.mfa_factors policies are untouched (tenant, platform, owner_only still present, no extra policy)', () => {
  const names = splitStatements(polText()).map(ws).filter((s) => /^CREATE POLICY mfa_factors__/i.test(s) && /ON identity\.mfa_factors\b/i.test(s)).map((s) => /^CREATE POLICY (\w+)/i.exec(s)[1]).sort();
  const want = [...OWN, 'mfa_factors__select__tenant', 'mfa_factors__insert__tenant', 'mfa_factors__update__tenant',
    'mfa_factors__select__platform', 'mfa_factors__insert__platform', 'mfa_factors__update__platform',
    'mfa_factors__select__owner_only', 'mfa_factors__insert__owner_only', 'mfa_factors__update__owner_only'];
  for (const n of want) if (!names.includes(n)) assert.ok(false, `policy ${n} missing from db/policies/identity.sql (found: ${names.join(', ')})`);
  assert.equal(names.length, new Set(names).size, 'no duplicate policy');
  assert.deepEqual(names.filter((n) => !want.includes(n)), [], 'no extra mfa_factors policy');
});
test('migration text and db/policies/identity.sql agree: same three predicates', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing`);
  const mig = Object.fromEntries(splitStatements(strip(readFileSync(migPath, 'utf8'))).map(ws).filter((s) => !/^SET LOCAL ROLE lims_owner$/i.test(s)).map((s) => {
    const m = /^ALTER POLICY (\w+) ON identity\.mfa_factors ([\s\S]*)$/i.exec(s);
    return [m?.[1], m ? clauses(m[2]) : null];
  }));
  for (const p of ownPolicies(polText())) assert.deepEqual(mig[p.name], { using: p.using, check: p.check }, p.name);
});

// ------------------------------------------------------------------------------------------------ the pgTAP file and the notes (reviewed by reading only; here: they exist and cover (a)..(e))
test('pgTAP file db/tests/identity/T0B-MFAPOL-1_mfa_factors_own.test.sql covers (a) 0 rows at aal1, (b) UPDATE 0 rows, (c) INSERT 42501, (d) own tenant row, (e) aal2 platform read', () => {
  const f = root + 'db/tests/identity/T0B-MFAPOL-1_mfa_factors_own.test.sql';
  assert.ok(existsSync(f), 'pgTAP file missing');
  const t = readFileSync(f, 'utf8');
  for (const k of ['(a)', '(b)', '(c)', '(d)', '(e)']) assert.ok(t.includes(`'${k} `), `assertion ${k}`);
  assert.match(t, /'aal1'/); assert.match(t, /'platform'/); assert.match(t, /'E42501'/); assert.match(t, /'n=0'/); assert.match(t, /'n=1'/);
  assert.match(t, /mfa_factors__select__platform/);
  assert.match(t, /NOT RUN in the lane/);
  assert.match(t, /run-suites\.sh/);
  assert.match(t, /push-cloud\.ps1/);
});
test('notes: T0B-MFAPOL-1-tests.md says the pgTAP file and the migration were NOT run and names run-suites.sh before push-cloud.ps1; verify.cmd is one line', () => {
  const n = root + '.orchestra/notes/T0B-MFAPOL-1-tests.md', v = root + '.orchestra/notes/T0B-MFAPOL-1-verify.cmd';
  assert.ok(existsSync(n) && existsSync(v), 'notes missing');
  const t = readFileSync(n, 'utf8');
  assert.match(t, /NOT run/i); assert.match(t, /run-suites\.sh/); assert.match(t, /push-cloud\.ps1/);
  assert.match(t, /T0B-10\.C2_policies/); assert.match(t, /AUTH-MFA-COMPLETE-1/);
  assert.equal(readFileSync(v, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length, 1, 'verify.cmd is exactly one line');
});
