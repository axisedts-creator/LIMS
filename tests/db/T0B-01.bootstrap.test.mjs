// T0B-01 static checks of db/bootstrap/00_roles.sql + 01_database.sql (05-SCHEMA §1; D-201; AC-0B-1.1/1.2).
// Run: node --test tests/db/T0B-01.bootstrap.test.mjs   (live-DB assertions: db/tests/roles/00_bootstrap_roles.test.sql)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rd = (f) => {
  const p = fileURLToPath(new URL(`../../db/bootstrap/${f}`, import.meta.url));
  assert.ok(existsSync(p), `db/bootstrap/${f} must exist`);
  return readFileSync(p, 'utf8').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n'); // strip comments
};
const roles = () => rd('00_roles.sql');
const db = () => rd('01_database.sql');
const stmt = (sql, re) => sql.split(';').find((s) => re.test(s)) ?? '';

const NOLOGIN = ['lims_owner', 'lims_app', 'lims_queue', 'lims_reporting_lookup', 'lims_analytics'];
const LOGIN = ['lims_migrator', 'lims_api', 'lims_worker', 'lims_monitor', 'lims_replicator', 'lims_audit_ship'];

test('every spec role is created with the exact attribute set', () => {
  const s = roles();
  for (const r of [...NOLOGIN, ...LOGIN]) {
    const c = stmt(s, new RegExp(`CREATE\\s+ROLE\\s+${r}\\b`, 'i'));
    assert.ok(c, `CREATE ROLE ${r}`);
    assert.match(c, /\bNOSUPERUSER\b/i, `${r} NOSUPERUSER`);
    assert.match(c, /\bNOBYPASSRLS\b/i, `${r} NOBYPASSRLS`);
    assert.match(c, /\bNOCREATEDB\b/i, `${r} NOCREATEDB`);
    assert.match(c, /\bNOCREATEROLE\b/i, `${r} NOCREATEROLE`);
    assert.match(c, NOLOGIN.includes(r) ? /\bNOLOGIN\b/i : /\bLOGIN\b/i, `${r} login flag`);
    assert.doesNotMatch(c, NOLOGIN.includes(r) ? /(?<!NO)\bLOGIN\b/i : /\bNOLOGIN\b/i);
    const repl = r === 'lims_replicator' || r === 'lims_audit_ship';
    assert.match(c, repl ? /(?<!NO)\bREPLICATION\b/i : /\bNOREPLICATION\b/i, `${r} replication flag`);
  }
});

test('no superuser/bypassrls/createdb/createrole anywhere; lims_migration not created; no other roles', () => {
  const s = roles();
  assert.doesNotMatch(s, /(?<!NO)\b(SUPERUSER|BYPASSRLS|CREATEDB|CREATEROLE)\b/i);
  assert.doesNotMatch(s, /lims_migration\b/);
  const created = [...s.matchAll(/CREATE\s+ROLE\s+(\w+)/gi)].map((m) => m[1]).sort();
  assert.deepEqual(created, [...NOLOGIN, ...LOGIN].sort());
});

test('login passwords come from psql variables, never literals', () => {
  const s = roles();
  for (const r of LOGIN) {
    assert.match(stmt(s, new RegExp(`CREATE\\s+ROLE\\s+${r}\\b`, 'i')), new RegExp(`PASSWORD\\s+:'${r}_pw'`), `${r} password var`);
  }
  assert.doesNotMatch(s, /PASSWORD\s+'/i, 'no literal password');
});

test('memberships carry the exact INHERIT/SET options', () => {
  const s = roles();
  const g = (grp, who, inh, set) =>
    assert.match(s, new RegExp(`GRANT\\s+${grp}\\s+TO\\s+${who}\\s+WITH\\s+INHERIT\\s+${inh}\\s*,\\s*SET\\s+${set}`, 'i'), `${grp} -> ${who}`);
  g('lims_owner', 'lims_migrator', 'FALSE', 'TRUE');
  g('lims_queue', 'lims_migrator', 'FALSE', 'TRUE');
  g('lims_reporting_lookup', 'lims_migrator', 'FALSE', 'TRUE');
  g('lims_app', 'lims_api', 'TRUE', 'FALSE');
  g('lims_app', 'lims_worker', 'TRUE', 'FALSE');
  g('lims_queue', 'lims_worker', 'TRUE', 'FALSE');
  assert.match(s, /GRANT\s+pg_monitor\s+TO\s+lims_monitor/i);
  assert.doesNotMatch(s, /GRANT\s+(lims_owner|lims_reporting_lookup)\s+TO\s+lims_(api|worker)\b/i, 'api/worker never reach owner/lookup');
  assert.doesNotMatch(s, /GRANT\s+lims_queue\s+TO\s+lims_api\b/i);
});

test('role session guards', () => {
  const s = roles();
  assert.match(s, /ALTER\s+ROLE\s+lims_api\s+SET\s+idle_in_transaction_session_timeout\s*=\s*'30s'/i);
  assert.match(s, /ALTER\s+ROLE\s+lims_worker\s+SET\s+idle_in_transaction_session_timeout\s*=\s*'120s'/i);
  assert.match(s, /ALTER\s+ROLE\s+lims_api\s+SET\s+search_path\s*=\s*''/i);
  assert.match(s, /ALTER\s+ROLE\s+lims_worker\s+SET\s+search_path\s*=\s*''/i);
});

test('D-201: CREATE on database to lims_owner WITH GRANT OPTION, and to nobody else', () => {
  const s = db();
  assert.match(s, /GRANT\s+CREATE\s+ON\s+DATABASE\s+:"dbname"\s+TO\s+lims_owner\s+WITH\s+GRANT\s+OPTION/i);
  const creates = s.split(';').filter((x) => /GRANT\b[^;]*\bCREATE\b[^;]*ON\s+(DATABASE|SCHEMA)/i.test(x));
  assert.equal(creates.length, 1, 'exactly one GRANT ... CREATE statement');
  assert.doesNotMatch(s, /GRANT\s+(ALL|CREATE)[^;]*\bTO\s+[^;]*\b(lims_queue|lims_reporting_lookup|lims_worker|lims_api|lims_app|lims_migrator)\b/i);
});

test('PUBLIC lockdown and CONNECT grants', () => {
  const s = db();
  assert.match(s, /REVOKE\s+CREATE\s+ON\s+SCHEMA\s+public\s+FROM\s+PUBLIC/i);
  assert.match(s, /REVOKE\s+ALL\s+ON\s+DATABASE\s+:"dbname"\s+FROM\s+PUBLIC/i);
  const conn = [...s.matchAll(/GRANT\s+CONNECT\s+ON\s+DATABASE\s+:"dbname"\s+TO\s+([^;]+)/gi)].flatMap((m) => m[1].split(',').map((x) => x.trim())).sort();
  assert.deepEqual(conn, ['lims_api', 'lims_audit_ship', 'lims_migrator', 'lims_monitor', 'lims_worker']);
});

test('extensions per spec; pgtap never created; USAGE on extensions', () => {
  const s = db();
  assert.match(s, /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+pg_trgm\s+WITH\s+SCHEMA\s+extensions/i);
  assert.match(s, /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+btree_gin\s+WITH\s+SCHEMA\s+extensions/i);
  assert.doesNotMatch(s, /pgtap/i);
  assert.match(s, /GRANT\s+USAGE\s+ON\s+SCHEMA\s+extensions\s+TO\s+lims_owner\s*,\s*lims_migrator/i);
});
