// T0B-05 static checks of the platform-table migrations (db/migrations/*_core__create_event_log.sql, *_core__create_*.sql, <m>.event_inbox
// migrations, wherever the writer puts them) and db/policies/core.sql.
// Spec: 05-SCHEMA §3.5, §3.8, §3.9, §4.3, §4.4, §5, §6, §7, §10 (platform tables, event_inbox template, triggers, queue wrapper, rate limit,
// purges, dead letters, tenant list, cron fan-out, tenant-code resolver, throttled-IP lookup, RLS); 08 A8.4, A9.4, A10.1, A10.4, A10.5, A12.3, A15.3,
// A19 D-121, A23.1-A23.3, A25 D-200, D-201, D-213, D-217, A31.4; AC-0B-2.4 (static part), AC-0B-4.2/4.3 (grant part), AC-0D-5.3 (dedupe key),
// schema tests 7, 9-12, 14, 15, 22, 23, 26, 27, 29, 31 (static part).
// Run: node --test tests/db/T0B-05.platform-tables.test.mjs   (live-DB assertions: db/tests/core/T0B-05_platform.test.sql, pg_prove)
// Method: the expected DDL is PARSED FROM 05-SCHEMA §10 at test time and compared (whitespace/case-normalised) with the migrations, so a
// drifting column, constraint, index, policy or grant fails here. Function bodies are checked by property (SECURITY DEFINER, search_path,
// GUC set/reset, 4-minute cap, batch size, grants); their behaviour is the pgTAP file's job.
// T0B05_ROOT (optional) points the checks at another tree that has db/migrations (used for the scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B05_ROOT ? resolve(process.env.T0B05_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const strip = (s) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const allSql = () => files().map(read).join('\n;\n');
const helpersFile = () => files().find((f) => f.endsWith('_app__create_context_helpers.sql'));
const tenantsFile = () => files().find((f) => f.endsWith('_core__create_tenants.sql'));
const eventLogFile = () => files().find((f) => /^\d{14}_core__create_event_log\.sql$/.test(f));

// ---------------------------------------------------------------- SQL scanning helpers
function splitTop(body) {            // split on commas at paren depth 0, outside single-quoted strings
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
function balanced(sql, from) {       // text inside the paren group that opens at sql[from-1]
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
  return { unlogged: !!m[1], segs, cols, cons, colNames: cols.map((c) => c.split(/\s+/)[0]), conNames: cons.map((c) => c.split(/\s+/)[1]) };
}
function createIndexes(sql) { return stmts(sql).filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s)).map(ws); }
const idxName = (s) => /INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s)[1];
function policies(sql) {
  return stmts(sql).filter((s) => /^CREATE\s+POLICY\b/i.test(s)).map((s) => {
    const m = /^CREATE\s+POLICY\s+(\w+)\s+ON\s+([\w.]+)\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([\w, ]+?)\s+(?=USING|WITH)([\s\S]*)$/i.exec(ws(s));
    assert.ok(m, `parsable policy: ${ws(s).slice(0, 110)}`);
    const rest = m[5], wi = rest.search(/\bWITH\s+CHECK\b/i);
    const using = /^USING/i.test(rest) ? (wi < 0 ? rest : rest.slice(0, wi)).replace(/^\s*USING\s*/i, '').trim() : '';
    const check = wi < 0 ? '' : rest.slice(wi).replace(/^\s*WITH\s+CHECK\s*/i, '').trim();
    const unwrap = (x) => { x = x.trim(); if (x[0] === '(' && balanced(x, 1).length === x.length - 2) return x.slice(1, -1).trim(); return x; };   // USING (<pred>) -> <pred>
    return { name: m[1], table: m[2], key: `${m[1]}@${m[2]}`, cmd: m[3].toUpperCase(), roles: m[4].split(',').map((r) => r.trim()).sort().join(','), using: norm(unwrap(using)), check: norm(unwrap(check)), text: ws(s) };
  });
}
function grants(sql) {               // table privileges: Map "schema.table" -> Map role -> Set(priv)
  const g = new Map();
  for (const s of stmts(sql)) {
    const m = /^GRANT\s+([A-Z, ]+?)\s+ON\s+(?:TABLE\s+)?([\w., ]+?)\s+TO\s+([\w, ]+?)(\s+WITH\s+GRANT\s+OPTION)?$/i.exec(ws(s));
    if (!m || /^(EXECUTE|USAGE|CREATE|ALL)\b/i.test(m[1]) && /\bFUNCTION\b/i.test(s)) continue;
    if (/^(EXECUTE|USAGE|CREATE)$/i.test(m[1].trim())) continue;
    for (const t of m[2].split(',').map((x) => x.trim())) for (const r of m[3].split(',').map((x) => x.trim())) {
      if (!g.has(t)) g.set(t, new Map());
      const rm = g.get(t); if (!rm.has(r)) rm.set(r, new Set());
      for (const p of m[1].split(',').map((x) => x.trim().toUpperCase())) rm.get(r).add(p);
    }
  }
  return g;
}
function fnExecGrants(sql) {         // Map function name -> Set(role) from GRANT EXECUTE ON FUNCTION a(..), b(..) TO r1, r2
  const out = new Map();
  for (const s of stmts(sql)) {
    const m = /^GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([\s\S]+?)\s+TO\s+([\w, ]+)$/i.exec(ws(s));
    if (!m) continue;
    const roles = m[2].split(',').map((r) => r.trim());
    for (const f of splitTop(m[1])) { const n = /^([\w.]+)\s*\(/.exec(f.trim()); if (n) { if (!out.has(n[1])) out.set(n[1], new Set()); roles.forEach((r) => out.get(n[1]).add(r)); } }
  }
  return out;
}
function fnText(sql, qname) {        // CREATE [OR REPLACE] FUNCTION <qname>( ... ) ... AS $tag$ ... $tag$
  const m = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${qname.replace('.', '\\.')}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  const open = /AS\s+(\$\w*\$)/i.exec(sql.slice(m.index));
  if (!open) return null;
  const bodyStart = m.index + open.index + open[0].length;
  const end = sql.indexOf(open[1], bodyStart);
  return end < 0 ? null : sql.slice(m.index, end + open[1].length);
}

// ---------------------------------------------------------------- spec extraction (05-SCHEMA §10)
const specPath = repo + 'spec/chunks/C0-foundation-contracts/05-SCHEMA.md';
const specText = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function section10() {
  const s = specText(), a = s.indexOf('## 10. DDL'), b = s.indexOf('## 11. Seeds and coded sets');
  assert.ok(a > 0 && b > a, '05-SCHEMA §10 bounds');
  return s.slice(a, b);
}
function between(s, startMarker, endMarker) {
  const a = s.indexOf(startMarker); assert.ok(a >= 0, `marker ${startMarker}`);
  const b = s.indexOf(endMarker, a + startMarker.length); assert.ok(b > a, `marker ${endMarker}`);
  return s.slice(a, b);
}
const specPlatformDdl = () => strip(between(section10(), '-- ===================================================================== platform tables (IC §12)', '-- ===================================================================== audit'));
const specInboxTemplate = () => strip(between(section10(), '-- ===================================================================== event_inbox (template', '-- ===================================================================== DEFINER helpers'));
const specPolicies = () => policies(strip(section10()));

const INBOX_SCHEMAS = ['identity', 'frontdesk', 'billing', 'lab', 'instruments', 'reporting', 'analytics', 'quality', 'micro', 'anatomic', 'inventory', 'partners', 'smartreport', 'payments', 'engagement', 'homecollection'];
const TABLES = ['core.event_log', 'core.dead_letters', 'core.idempotency_keys', 'core.rate_limit_counters'];
const POLICY_TABLES = ['core.event_log', 'core.dead_letters', 'core.idempotency_keys'];

// ================================================================ parsers sanity (spec side)
test('spec parsers sanity: §10 yields the 4 platform tables, 7+9+? policies, 16-schema inbox list matches §3.9', () => {
  const ddl = specPlatformDdl();
  for (const t of TABLES) assert.ok(createTable(ddl, t), `spec has ${t}`);
  assert.equal(createTable(ddl, 'core.idempotency_keys').conNames.includes('idempotency_keys__tenant_id_actor_id_key__uq'), true);
  assert.equal(createTable(ddl, 'core.rate_limit_counters').unlogged, true);
  const byTable = (t) => specPolicies().filter((p) => p.table === t);
  assert.equal(byTable('core.event_log').length, 7, 'event_log: select/insert tenant, 3 actor inserts, 2 owner');
  assert.equal(byTable('core.dead_letters').length, 9, 'dead_letters: 3 tenant + 4 owner + 2 platform');
  assert.ok(byTable('core.idempotency_keys').length >= 22, 'idempotency_keys: staff 4 + partner/portal/patient 12 + platform 4 + owner 2');
  assert.equal(byTable('lab.event_inbox').length, 4, 'event_inbox template: select/insert tenant + select/delete owner');
  const s = specText();
  const sec39 = s.slice(s.indexOf('### 3.9 `event_inbox` schema list'), s.indexOf('## 4. `app` helper functions'));
  const listed = [...sec39.slice(sec39.indexOf('Created in:'), sec39.indexOf('(16;')).matchAll(/`(\w+)`/g)].map((m) => m[1]);
  assert.deepEqual(listed, INBOX_SCHEMAS, '§3.9 list == the 16 schemas used here (no catalog, 08 A31.4)');
});

// ================================================================ migrations: files, order, role switch
test('migration files exist: *_core__create_event_log.sql after the helpers stage and after core.tenants; every platform file starts SET LOCAL ROLE lims_owner', () => {
  assert.ok(helpersFile(), 'T0B-02 helpers migration present');
  assert.ok(tenantsFile(), 'T0B-03 tenants migration present');
  const f = eventLogFile();
  assert.ok(f, 'db/migrations/<ts>_core__create_event_log.sql exists (06-IMPLEMENTATION-PLAN T0B-05)');
  assert.ok(f > helpersFile() && f > tenantsFile(), `${f} sorts after helpers and tenants (FK to core.tenants, policies use app.is_platform_actor())`);
  assert.match(stmts(read(f))[0], /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is SET LOCAL ROLE lims_owner`);
  assert.ok(existsSync(root + 'db/policies/core.sql'), 'db/policies/core.sql exists');
});

// ================================================================ tables: columns, constraints, indexes verbatim (§10)
for (const t of TABLES) {
  test(`${t}: columns, constraints and indexes equal the 05-SCHEMA §10 DDL (names, types, nulls, defaults, CHECK text)`, () => {
    const spec = createTable(specPlatformDdl(), t), got = createTable(allSql(), t);
    assert.ok(got, `CREATE TABLE ${t} in a migration`);
    assert.equal(got.unlogged, spec.unlogged, `${t} UNLOGGED = ${spec.unlogged}`);
    assert.deepEqual([...got.colNames].sort(), [...spec.colNames].sort(), `${t} column names`);
    const gotCols = new Set(got.cols.map(norm)), gotCons = new Set(got.cons.map(norm));
    for (const c of spec.cols) assert.ok(gotCols.has(norm(c)), `${t} column: ${ws(c)}`);
    assert.deepEqual([...got.conNames].sort(), [...spec.conNames].sort(), `${t} constraint names`);
    for (const c of spec.cons) assert.ok(gotCons.has(norm(c)), `${t} constraint: ${ws(c)}`);
    const wantIdx = createIndexes(specPlatformDdl()).filter((i) => new RegExp(`\\bON\\s+${t.replace('.', '\\.')}\\b`, 'i').test(i));
    const gotIdx = new Map(createIndexes(allSql()).map((i) => [idxName(i), norm(i)]));
    for (const i of wantIdx) assert.equal(gotIdx.get(idxName(i)), norm(i), `${t} index ${idxName(i)}`);
    const mine = createIndexes(allSql()).filter((i) => new RegExp(`\\bON\\s+${t.replace('.', '\\.')}\\b`, 'i').test(i)).map(idxName).sort();
    assert.deepEqual(mine, wantIdx.map(idxName).sort(), `${t}: no index beyond §7 (every index serves a spec query)`);
  });
}

test('AC-0D-5.3 / schema test 27: dedupe keys — event_log unique (tenant_id, event_type, idempotency_key); idempotency_keys UNIQUE NULLS NOT DISTINCT replaces the PK', () => {
  const sql = ws(allSql());
  assert.match(sql, /CREATE UNIQUE INDEX event_log__tenant_id_event_type_idempotency_key__uq ON core\.event_log \(tenant_id, event_type, idempotency_key\)/i);
  assert.match(sql, /CONSTRAINT idempotency_keys__tenant_id_actor_id_key__uq UNIQUE NULLS NOT DISTINCT \(tenant_id, actor_id, key\)/i);
  const ik = createTable(allSql(), 'core.idempotency_keys');
  assert.ok(!ik.segs.some((s) => /PRIMARY\s+KEY/i.test(s)), 'idempotency_keys has no PRIMARY KEY (NULL tenant, D-213)');
  assert.match(ws(ik.cols.find((c) => /^tenant_id\b/.test(c))), /^tenant_id uuid$/i, 'tenant_id is nullable (platform-context rows)');
  assert.match(ws(createTable(allSql(), 'core.event_log').cols.find((c) => /^tenant_id\b/.test(c))), /^tenant_id uuid NOT NULL$/i);
});

test('schema tests 7, 9: dead_letters carries resolution_note / job_key / version and the verbatim CHECKs (1-500, 1-400)', () => {
  const sql = ws(allSql());
  assert.match(sql, /CONSTRAINT dead_letters__resolution_note__ck CHECK \(char_length\(resolution_note\) BETWEEN 1 AND 500\)/i);
  assert.match(sql, /CONSTRAINT dead_letters__job_key__ck CHECK \(char_length\(job_key\) BETWEEN 1 AND 400\)/i);
  assert.match(sql, /CONSTRAINT dead_letters__state__ck CHECK \(state IN \('open', ?'replayed', ?'discarded'\)\)/i);
  assert.match(sql, /version integer NOT NULL DEFAULT 1/i);
});

// ---------------------------------------------------------------- g_task_registry, g_system_actors (§3.5; prose spec -> literal sets)
test('core.g_task_registry / core.g_system_actors: columns, PK/UNIQUE, literal CHECK sets, class G (no RLS, SELECT to lims_app, lims_queue SELECT on the registry)', () => {
  const all = allSql(), reg = createTable(all, 'core.g_task_registry'), act = createTable(all, 'core.g_system_actors');
  assert.ok(reg, 'CREATE TABLE core.g_task_registry'); assert.ok(act, 'CREATE TABLE core.g_system_actors');
  assert.deepEqual([...reg.colNames].sort(), ['created_at', 'identifier', 'is_active', 'kind', 'max_attempts', 'module', 'registered_at', 'scope']);
  assert.deepEqual([...act.colNames].sort(), ['actor_id', 'created_at', 'is_active', 'module']);
  const r = ws(all);
  assert.match(r, /identifier text (NOT NULL )?PRIMARY KEY|PRIMARY KEY \(identifier\)/i, 'registry PK identifier');
  assert.match(r, /kind IN \('task', ?'consumer', ?'core'\)/i);
  assert.match(r, /scope IN \('per_tenant', ?'platform'\)/i);
  assert.match(r, /module text (NOT NULL )?PRIMARY KEY|PRIMARY KEY \(module\)/i, 'actors PK module');
  assert.match(ws(act.cols.find((c) => /^actor_id\b/.test(c))), /^actor_id uuid (NOT NULL UNIQUE|UNIQUE NOT NULL)/i, 'actor_id uuid UNIQUE NOT NULL');
  assert.match(ws(reg.cols.find((c) => /^max_attempts\b/.test(c))), /^max_attempts (int|integer)\b/i);
  const g = grants(all);
  assert.ok(g.get('core.g_task_registry')?.get('lims_app')?.has('SELECT'), 'lims_app SELECT on g_task_registry');
  assert.ok(g.get('core.g_system_actors')?.get('lims_app')?.has('SELECT'), 'lims_app SELECT on g_system_actors');
  assert.ok(g.get('core.g_task_registry')?.get('lims_queue')?.has('SELECT'), 'lims_queue SELECT on g_task_registry (enqueue_job reads it as lims_queue)');
  for (const t of ['core.g_task_registry', 'core.g_system_actors']) {
    assert.doesNotMatch(all, new RegExp(`ALTER\\s+TABLE\\s+${t.replace('.', '\\.')}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${t} is class G: no RLS`);
    for (const p of ['INSERT', 'UPDATE', 'DELETE']) assert.ok(!g.get(t)?.get('lims_app')?.has(p), `lims_app has no ${p} on ${t}`);
  }
});

test('core.rate_limit_counters: UNLOGGED, RLS-exempt, no table grant to anyone (access only via app.ratelimit_hit)', () => {
  const all = allSql(), t = 'core\\.rate_limit_counters';
  assert.ok(createTable(all, 'core.rate_limit_counters').unlogged);
  assert.doesNotMatch(all, new RegExp(`ALTER\\s+TABLE\\s+${t}\\s+(ENABLE|FORCE)`, 'i'), 'RLS-exempt (rls_exempt.txt)');
  assert.doesNotMatch(all, new RegExp(`CREATE\\s+POLICY\\s+\\w+\\s+ON\\s+${t}\\b`, 'i'));
  const g = grants(all).get('core.rate_limit_counters');
  assert.ok(!g || [...g.values()].every((s) => s.size === 0), 'no GRANT on core.rate_limit_counters');
  assert.ok(existsSync(root + 'db/tests/rls_exempt.txt') && /rate_limit_counters/.test(readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8')), 'listed in db/tests/rls_exempt.txt');
});

// ================================================================ event_inbox: exactly 16 schemas, template verbatim
test('§3.9 / 08 A31.4: event_inbox exists in exactly the 16 listed schemas, none in core/audit/catalog/migration_staging/api', () => {
  const found = [...allSql().matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\.event_inbox\b/gi)].map((m) => m[1]);
  assert.deepEqual([...found].sort(), [...INBOX_SCHEMAS].sort(), 'exactly one event_inbox per §3.9 schema');
  for (const s of ['core', 'audit', 'catalog', 'migration_staging', 'api', 'app']) assert.ok(!found.includes(s), `no ${s}.event_inbox`);
});

test('every <m>.event_inbox equals the §10 template (columns, pk, tenant fk, brin index, 4 policies, ENABLE+FORCE RLS, SELECT+INSERT only)', () => {
  const tpl = createTable(specInboxTemplate(), 'lab.event_inbox'), tplPol = specPolicies().filter((p) => p.table === 'lab.event_inbox');
  const tplIdx = createIndexes(specInboxTemplate()).filter((i) => /lab\.event_inbox/.test(i));
  assert.ok(tpl && tplPol.length === 4 && tplIdx.length === 1, 'template parsed');
  const all = allSql(), g = grants(all), gotPol = policies(all), gotIdx = createIndexes(all);
  for (const s of INBOX_SCHEMAS) {
    const t = `${s}.event_inbox`, got = createTable(all, t);
    assert.ok(got, `CREATE TABLE ${t}`);
    assert.deepEqual([...got.colNames].sort(), [...tpl.colNames].sort(), `${t} columns`);
    const gc = new Set(got.cols.map(norm)), gk = new Set(got.cons.map(norm).map((x) => x.replace(`${s}.`, 'lab.')));
    for (const c of tpl.cols) assert.ok(gc.has(norm(c)), `${t}: ${ws(c)}`);
    for (const c of tpl.cons) assert.ok(gk.has(norm(c)), `${t}: ${ws(c)}`);
    assert.ok(gotIdx.some((i) => norm(i) === norm(tplIdx[0]).replace(/lab\./g, `${s}.`)), `${t} brin index event_inbox__received_at__brin`);
    assert.match(allSql(), new RegExp(`ALTER\\s+TABLE\\s+${s}\\.event_inbox\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${t} ENABLE RLS`);
    assert.match(allSql(), new RegExp(`ALTER\\s+TABLE\\s+${s}\\.event_inbox\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${t} FORCE RLS`);
    const mine = gotPol.filter((p) => p.table === t);
    assert.deepEqual(mine.map((p) => p.name).sort(), tplPol.map((p) => p.name).sort(), `${t} policy names`);
    for (const p of tplPol) {
      const q = mine.find((x) => x.name === p.name);
      assert.ok(q, `${t} ${p.name}`);
      assert.deepEqual([q.cmd, q.roles, q.using, q.check], [p.cmd, p.roles, p.using, p.check], `${t} ${p.name} text`);
    }
    const priv = g.get(t)?.get('lims_app');
    assert.deepEqual([...(priv ?? [])].sort(), ['INSERT', 'SELECT'], `${t}: lims_app SELECT, INSERT only (AC-0B-4.2/4.3: no UPDATE, no DELETE)`);
  }
});

// ================================================================ policies: equal to §10, nothing extra, mirrored in db/policies/core.sql
test('policies on core.event_log / dead_letters / idempotency_keys equal the §10 set exactly (name, command, roles, USING, WITH CHECK); no extra policy', () => {
  const want = specPolicies().filter((p) => POLICY_TABLES.includes(p.table)), got = policies(allSql()).filter((p) => POLICY_TABLES.includes(p.table));
  assert.deepEqual(got.map((p) => p.key).sort(), want.map((p) => p.key).sort(), 'policy names per table');
  for (const p of want) {
    const q = got.find((x) => x.key === p.key);
    assert.deepEqual([q.cmd, q.roles, q.using, q.check], [p.cmd, p.roles, p.using, p.check], `${p.key}`);
  }
  for (const t of POLICY_TABLES) {
    assert.match(allSql(), new RegExp(`ALTER\\s+TABLE\\s+${t.replace('.', '\\.')}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${t} ENABLE RLS`);
    assert.match(allSql(), new RegExp(`ALTER\\s+TABLE\\s+${t.replace('.', '\\.')}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${t} FORCE RLS`);
  }
});

test('08 A23.3 / schema test 24: every __tenant policy keeps the staff guard in USING and WITH CHECK; actor policies exist only on the shared_with tables', () => {
  const scoped = policies(allSql()).filter((x) => POLICY_TABLES.includes(x.table) || /\.event_inbox$/.test(x.table));
  assert.ok(scoped.length >= 20 + 4 * 16, `platform policies exist (got ${scoped.length}); not vacuous`);
  for (const p of scoped) {
    if (/__tenant$/.test(p.name)) {
      if (p.using) assert.match(p.using, /\(select app\.is_staff_or_system\(\)\)/, `${p.key} USING has the guard`);
      if (p.check) assert.match(p.check, /\(select app\.is_staff_or_system\(\)\)/, `${p.key} WITH CHECK has the guard`);
    }
    if (/__(partner|portal|patient)$/.test(p.name)) assert.ok(['core.event_log', 'core.idempotency_keys'].includes(p.table), `${p.key}: actor policy only on shared_with tables`);
    if (/__(partner|portal|patient)$/.test(p.name) && p.table === 'core.event_log') assert.equal(p.cmd, 'INSERT', `${p.key}: non-staff may INSERT event_log, never SELECT`);
  }
});

test('schema tests 15 / 17 (static): every TO lims_owner policy on the platform tables is gated on app.maintenance (or tenant_id IS NULL for app.dl_*); no USING (true); no owner policy for non-owner roles mentions app.maintenance', () => {
  const pols = policies(allSql());
  assert.ok(pols.filter((p) => p.roles === 'lims_owner' && (POLICY_TABLES.includes(p.table) || /\.event_inbox$/.test(p.table))).length >= 8 + 2 * 16, 'owner policies of the platform tables exist; not vacuous');
  for (const p of pols) {
    if (!(POLICY_TABLES.includes(p.table) || /\.event_inbox$/.test(p.table))) continue;
    assert.ok(!/^true$/i.test(p.using) && !/^true$/i.test(p.check), `${p.key} is not USING (true)`);
    if (p.roles === 'lims_owner') {
      if (p.table === 'core.dead_letters' && /__(insert|update)__owner_only$/.test(p.name)) assert.match(p.using + p.check, /tenant_id is null/, `${p.key}: tenant_id IS NULL`);
      else if (p.table === 'core.dead_letters' && p.name === 'dead_letters__select__owner_only') {
        assert.equal(p.using, norm("tenant_id IS NULL OR (current_setting('app.maintenance', true) = 'purge_dead_letters' AND state <> 'open' AND resolved_at < now() - interval '90 days')"));
      } else assert.match(p.using, /current_setting\('app\.maintenance',true\)='purge_[a-z_]+'/, `${p.key}: gated on app.maintenance = the purge name`);
    } else assert.doesNotMatch(p.using + p.check, /app\.maintenance|app\.pre_/, `${p.key}: GUC predicates only TO lims_owner (08 A12.7)`);
  }
  const gate = (t, name, pred) => pols.filter((p) => p.table === t && /__(select|delete)__owner_only$/.test(p.name))
    .forEach((p) => assert.equal(p.using, norm(`current_setting('app.maintenance', true) = '${name}' AND ${pred}`), `${p.key}`));
  gate('core.event_log', 'purge_event_log', "created_at < now() - interval '90 days'");
  gate('core.idempotency_keys', 'purge_idempotency_keys', 'expires_at < now()');
});

test('AC-0B-2.3 style: db/policies/core.sql mirrors every CREATE POLICY on core.* tables in the migrations (incl. the T0B-05 tables)', () => {
  const mig = policies(allSql()).filter((p) => p.table.startsWith('core.')), file = policies(strip(readFileSync(root + 'db/policies/core.sql', 'utf8')));
  const fk = new Map(file.map((p) => [p.key, p]));
  for (const k of ['event_log__select__tenant@core.event_log', 'dead_letters__select__platform@core.dead_letters', 'idempotency_keys__select__platform@core.idempotency_keys']) assert.ok(fk.has(k), `db/policies/core.sql has ${k}`);
  for (const p of mig) {
    const q = fk.get(p.key);
    assert.ok(q, `db/policies/core.sql has ${p.key}`);
    assert.deepEqual([q.cmd, q.roles, q.using, q.check], [p.cmd, p.roles, p.using, p.check], `${p.key} identical in core.sql`);
  }
  assert.deepEqual([...fk.keys()].filter((k) => k.includes('@core.')).sort(), mig.map((p) => p.key).sort(), 'core.sql has no policy absent from the migrations');
});

// ================================================================ grants on the T0B-05 tables (AC-0B-4.2 / 4.3)
test('AC-0B-4.2 / 4.3 / §5: lims_app grants — event_log SELECT,INSERT; dead_letters SELECT,INSERT,UPDATE; idempotency_keys SELECT,INSERT,UPDATE,DELETE; nothing to PUBLIC or lims_api/lims_worker directly', () => {
  const g = grants(allSql());
  const want = { 'core.event_log': ['INSERT', 'SELECT'], 'core.dead_letters': ['INSERT', 'SELECT', 'UPDATE'], 'core.idempotency_keys': ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] };
  for (const [t, ps] of Object.entries(want)) {
    assert.deepEqual([...(g.get(t)?.get('lims_app') ?? [])].sort(), ps, `${t} lims_app`);
    for (const r of ['public', 'PUBLIC', 'lims_api', 'lims_worker', 'lims_monitor', 'lims_analytics']) assert.ok(!g.get(t)?.has(r), `${t}: no direct grant to ${r}`);
  }
  assert.ok(!g.get('core.event_log').get('lims_app').has('UPDATE') && !g.get('core.event_log').get('lims_app').has('DELETE'), 'class A: no UPDATE/DELETE (AC-0B-4.2, 4.3)');
  assert.ok(!g.get('core.dead_letters').get('lims_app').has('DELETE'), 'class E dead_letters: no DELETE for lims_app (purge is DEFINER-only)');
});

// ================================================================ triggers
test('schema tests 7, 9: app.tg_dead_letter_transition + trigger dead_letters__transition (BEFORE UPDATE, FOR EACH ROW); allowed-change list incl. resolution_note and version', () => {
  const all = allSql(), f = fnText(all, 'app.tg_dead_letter_transition');
  assert.ok(f, 'function present (05-SCHEMA §4.4 / §10 triggers)');
  const t = ws(f);
  assert.match(t, /RETURNS trigger/i); assert.match(t, /SET search_path = ''/i);
  for (const c of ['state', 'resolved_by', 'resolved_at', 'resolution_note', 'version']) assert.match(t, new RegExp(`'${c}'`), `allowed-change list has ${c}`);
  assert.match(t, /OLD\.state = 'open' AND NEW\.state IN \('replayed', ?'discarded'\)/i, 'open -> replayed|discarded only');
  assert.match(t, /ERRCODE = 'P0001'/); assert.match(t, /MESSAGE = 'immutable_row'/); assert.match(t, /DETAIL = 'core\.dead_letters'/);
  assert.match(ws(all), /CREATE TRIGGER dead_letters__transition BEFORE UPDATE ON core\.dead_letters FOR EACH ROW EXECUTE FUNCTION app\.tg_dead_letter_transition\(\)/i);
});

// ================================================================ queue wrapper (D-201 window)
test('D-201 / schema test 30: app.enqueue_job + app.queue_depth are created as lims_queue inside a CREATE-grant window that is closed again; no standing CREATE', () => {
  const all = allSql();
  const enq = all.search(/CREATE\s+FUNCTION\s+app\.enqueue_job\s*\(/i), depth = all.search(/CREATE\s+FUNCTION\s+app\.queue_depth\s*\(/i);
  assert.ok(enq > 0 && depth > 0, 'both wrapper functions are created');
  const gA = all.search(/GRANT\s+CREATE\s+ON\s+SCHEMA\s+app\s+TO\s+lims_queue/i), rA = all.search(/REVOKE\s+CREATE\s+ON\s+SCHEMA\s+app\s+FROM\s+lims_queue/i);
  const gD = all.search(/GRANT CREATE ON DATABASE %I TO lims_queue|GRANT\s+CREATE\s+ON\s+DATABASE\s+\S+\s+TO\s+lims_queue/i), rD = all.search(/REVOKE CREATE ON DATABASE %I FROM lims_queue|REVOKE\s+CREATE\s+ON\s+DATABASE\s+\S+\s+FROM\s+lims_queue/i);
  assert.ok(gA >= 0 && gA < enq && enq < rA && depth < rA, 'schema CREATE granted before the wrapper, revoked after both functions');
  assert.ok(gD >= 0 && gD < enq && enq < rD && depth < rD, 'database CREATE granted before the wrapper, revoked after both functions');
  assert.equal([...all.matchAll(/GRANT\s+CREATE\s+ON\s+SCHEMA\s+app\s+TO\s+lims_queue/gi)].length, [...all.matchAll(/REVOKE\s+CREATE\s+ON\s+SCHEMA\s+app\s+FROM\s+lims_queue/gi)].length, 'every CREATE grant to lims_queue is revoked');
  // role switch around the creation: SET [LOCAL] ROLE lims_queue before, back to lims_owner after
  const before = all.slice(0, enq), sw = [...before.matchAll(/SET\s+(?:LOCAL\s+)?ROLE\s+(\w+)/gi)].pop();
  assert.equal(sw?.[1], 'lims_queue', 'last role switch before enqueue_job is SET ROLE lims_queue (function owner lims_queue, 05-SCHEMA §4.3)');
  const between = all.slice(depth), back = /(RESET\s+ROLE|SET\s+(?:LOCAL\s+)?ROLE\s+lims_owner)/i.exec(between);
  assert.ok(back && depth + back.index < rA, 'role is reset to lims_owner before the REVOKEs run');
});

test('app.enqueue_job: SECURITY DEFINER, search_path empty, registry lookup (is_active), per_tenant tenant-claim match, unsafe_dedupe, run_at/max_attempts defaults (schema tests 22, 23; AC-0D-5.14/5.15)', () => {
  const f = fnText(allSql(), 'app.enqueue_job'); assert.ok(f, 'app.enqueue_job present');
  const t = ws(f);
  assert.match(t, /\(\s*identifier text, payload jsonb, job_key text DEFAULT NULL, run_at timestamptz DEFAULT NULL, max_attempts (int|integer) DEFAULT NULL\s*\)/i, 'signature (text, jsonb, text, timestamptz, int) with defaults');
  assert.match(t, /RETURNS void/i); assert.match(t, /SECURITY DEFINER/i); assert.match(t, /SET search_path = ''/i);
  assert.match(t, /FROM core\.g_task_registry/i); assert.match(t, /is_active/i);
  assert.match(t, /MESSAGE = 'unknown_task_identifier'/); assert.match(t, /MESSAGE = 'job_tenant_mismatch'/);
  assert.match(t, /scope = 'per_tenant'/i); assert.match(t, /app\.current_tenant_id\(\) IS NULL/i);
  assert.match(t, /payload ->> 'tenant_id'[^;]*IS DISTINCT FROM app\.current_tenant_id\(\)/i, 'payload tenant_id must equal the tenant claim');
  assert.match(t, /graphile_worker\.add_job/i); assert.match(t, /job_key_mode\s*=>\s*'unsafe_dedupe'/i);
  assert.match(t, /coalesce\(\s*enqueue_job\.run_at, now\(\)\s*\)/i); assert.match(t, /coalesce\(\s*enqueue_job\.max_attempts, v_reg\.max_attempts\)/i);
  assert.doesNotMatch(t, /\btenant_id\s+uuid\b/i, 'no caller-supplied tenant parameter (REQ-SEC-019)');
});

test('app.queue_depth: SQL STABLE SECURITY DEFINER, counts only (no payload/key/last_error), grouped by task_identifier', () => {
  const t = ws(fnText(allSql(), 'app.queue_depth') ?? '');
  assert.ok(t, 'app.queue_depth present');
  assert.match(t, /RETURNS TABLE \(task_identifier text, ready bigint, locked bigint, failed bigint\)/i);
  assert.match(t, /LANGUAGE sql/i); assert.match(t, /STABLE/i); assert.match(t, /SECURITY DEFINER/i); assert.match(t, /SET search_path = ''/i);
  assert.match(t, /FROM graphile_worker\.jobs/i); assert.match(t, /GROUP BY [a-z.]*task_identifier/i);
  assert.doesNotMatch(t, /payload|last_error|\bkey\b|job_key/i, 'never payloads, keys or errors (review C0 m#37)');
});

// ================================================================ rate limit
test('app.ratelimit_hit(text,int,int, OUT allowed boolean, OUT retry_after_seconds int): DEFINER, sliding window over two windows, upsert, grants lims_api + lims_worker only', () => {
  const t = ws(fnText(allSql(), 'app.ratelimit_hit') ?? '');
  assert.ok(t, 'app.ratelimit_hit present');
  assert.match(t, /p_key_hash text, p_window_seconds (int|integer), p_limit (int|integer), OUT allowed boolean, OUT retry_after_seconds (int|integer)/i);
  assert.match(t, /SECURITY DEFINER/i); assert.match(t, /SET search_path = ''/i);
  assert.match(t, /INSERT INTO core\.rate_limit_counters/i); assert.match(t, /ON CONFLICT \(key_hash, window_start\) DO UPDATE SET hits = c\.hits \+ 1/i);
  assert.match(t, /clock_timestamp\(\)/i); assert.match(t, /v_prev_hits \* \(1 - v_elapsed \/ p_window_seconds\) \+ v_cur_hits/i, 'sliding-window estimate (REQ-SEC-079)');
  assert.match(t, /allowed := v_estimate <= p_limit/i);
  assert.deepEqual([...(fnExecGrants(allSql()).get('app.ratelimit_hit') ?? [])].sort(), ['lims_api', 'lims_worker']);
});

// ================================================================ purges
const PURGES = {
  purge_event_log: { gate: 'purge_event_log', cap: true }, purge_event_inboxes: { gate: 'purge_event_inboxes', cap: true },
  purge_idempotency_keys: { gate: 'purge_idempotency_keys', cap: true }, purge_dead_letters: { gate: 'purge_dead_letters', cap: true },
  purge_ratelimit_counters: { gate: null, cap: true },
};
for (const [fn, { gate }] of Object.entries(PURGES)) {
  test(`app.${fn}(OUT deleted bigint, OUT capped boolean): DEFINER, search_path empty, 4-minute cap (D-200), 10,000-row batches, GUC set+reset${gate ? '' : ' (none: RLS-exempt table)'}, EXECUTE lims_worker only`, () => {
    const t = ws(fnText(allSql(), `app.${fn}`) ?? '');
    assert.ok(t, `app.${fn} present`);
    assert.match(t, new RegExp(`${fn}\\(\\s*OUT deleted bigint, OUT capped boolean\\s*\\)`, 'i'));
    assert.match(t, /SECURITY DEFINER/i); assert.match(t, /SET search_path = ''/i); assert.match(t, /VOLATILE/i);
    assert.match(t, /clock_timestamp\(\) - now\(\) > interval '4 minutes'/i, '4-minute loop cap (D-200)');
    assert.match(t, /capped := true/i); assert.match(t, /deleted := 0; capped := false/i);
    assert.match(t, /LIMIT 10000/i, 'batches of 10,000');
    assert.match(t, /GET DIAGNOSTICS v_n = ROW_COUNT/i);
    if (gate) {
      assert.ok(t.indexOf(`set_config('app.maintenance', '${gate}', true)`) > 0, `sets app.maintenance = '${gate}'`);
      assert.ok(t.lastIndexOf(`set_config('app.maintenance', '', true)`) > t.lastIndexOf('END LOOP'), `resets app.maintenance to '' after the loop`);
    } else assert.doesNotMatch(t, /app\.maintenance/, 'no maintenance GUC for the RLS-exempt counters');
    assert.deepEqual([...(fnExecGrants(allSql()).get(`app.${fn}`) ?? [])].sort(), ['lims_worker'], 'EXECUTE lims_worker only');
  });
}
test('purge predicates: 90 days (event_log created_at, inbox received_at, dead_letters resolved_at & state<>open), expires_at < now() (idempotency), 48 hours (rate-limit); inbox purge loops exactly the 16 schemas via format(%I)', () => {
  const all = allSql(), g = (n) => ws(fnText(all, `app.${n}`) ?? '');
  assert.match(g('purge_event_log'), /x\.created_at < now\(\) - interval '90 days'/i);
  assert.match(g('purge_idempotency_keys'), /x\.expires_at < now\(\)/i);
  assert.match(g('purge_idempotency_keys'), /ctid/i, 'NULL-tenant rows: batch addressed by ctid (D-213)');
  assert.match(g('purge_dead_letters'), /x\.state <> 'open' AND x\.resolved_at < now\(\) - interval '90 days'/i);
  assert.match(g('purge_ratelimit_counters'), /x\.window_start < now\(\) - interval '48 hours'/i);
  const inbox = g('purge_event_inboxes');
  assert.match(inbox, /received_at < now\(\) - interval ''90 days''/i);
  const list = /FOREACH v_s IN ARRAY ARRAY\[([^\]]+)\]/i.exec(inbox);
  assert.ok(list, 'FOREACH over a fixed ARRAY');
  assert.deepEqual([...list[1].matchAll(/'(\w+)'/g)].map((m) => m[1]), INBOX_SCHEMAS, 'fixed schema list == §3.9 (no catalog), in order');
  assert.match(inbox, /format\(/i); assert.match(inbox, /%I\.event_inbox/);
  assert.doesNotMatch(inbox, /\|\|\s*v_s|quote_literal/i, 'identifiers only through %I (REQ-SEC-082)');
});

// ================================================================ platform dead letters
const DL_FNS = {
  dl_insert_platform: { args: 'uuid, text, jsonb, text, text, integer, timestamptz, text', to: ['lims_worker'] },
  dl_list_platform: { args: 'text, text, timestamptz, timestamptz, timestamptz, uuid, integer, uuid', to: ['lims_api'] },
  dl_resolve: { args: 'uuid, integer, text, text', to: ['lims_api'] },
};
test('app.dl_insert_platform / dl_list_platform / dl_resolve: DEFINER, search_path empty, exact signature, EXECUTE grants (schema test 12), no PUBLIC', () => {
  const all = allSql(), eg = fnExecGrants(all);
  for (const [fn, { to }] of Object.entries(DL_FNS)) {
    const t = ws(fnText(all, `app.${fn}`) ?? '');
    assert.ok(t, `app.${fn} present`);
    assert.match(t, /SECURITY DEFINER/i); assert.match(t, /SET search_path = ''/i);
    assert.deepEqual([...(eg.get(`app.${fn}`) ?? [])].sort(), to, `${fn} EXECUTE`);
    assert.doesNotMatch(all, new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+app\\.${fn}\\([^;]*TO\\s+(PUBLIC|lims_app)\\b`, 'i'), `${fn} not granted to PUBLIC / lims_app`);
  }
  const ins = ws(fnText(all, 'app.dl_insert_platform'));
  assert.match(ins, /p_id uuid, p_task_identifier text, p_job_payload jsonb, p_last_error_code text, p_last_error_message_redacted text, p_attempts integer, p_first_failed_at timestamptz, p_job_key text DEFAULT NULL/i);
  assert.match(ins, /MESSAGE = 'unknown_task_identifier'/); assert.match(ins, /MESSAGE = 'job_tenant_mismatch'/);
  assert.match(ins, /v_scope <> 'platform'/i); assert.match(ins, /VALUES \(p_id, NULL, p_task_identifier, p_job_payload[\s\S]*?'open', p_job_key, app\.current_actor_id\(\)\)/i);
});
test('app.dl_list_platform (schema test 10): platform context only, tenant_id IS NULL, filters, keyset on (dead_at, id) DESC, limit cap 201, NO job_payload / job_key in the result', () => {
  const t = ws(fnText(allSql(), 'app.dl_list_platform') ?? '');
  assert.ok(t);
  assert.match(t, /RETURNS TABLE \(id uuid, tenant_id uuid, task_identifier text, last_error_code text, last_error_message_redacted text, attempts integer, first_failed_at timestamptz, dead_at timestamptz, state text, resolved_by uuid, resolved_at timestamptz, resolution_note text, version integer\)/i);
  assert.doesNotMatch(t.slice(0, t.search(/\$\w*\$/i)), /job_payload|job_key/i, 'result carries no job_payload / job_key (08 A8.5, A9.4)');
  assert.match(t, /d\.tenant_id IS NULL/i); assert.match(t, /\(SELECT app\.is_platform_actor\(\)\)/i);
  assert.match(t, /d\.dead_at >= p_dead_at_from/i, 'dead_at_from inclusive'); assert.match(t, /d\.dead_at < p_dead_at_to/i, 'dead_at_to exclusive');
  assert.match(t, /\(d\.dead_at, d\.id\) < \(p_after_dead_at, p_after_id\)/i); assert.match(t, /ORDER BY d\.dead_at DESC, d\.id DESC/i);
  assert.match(t, /least\(greatest\(coalesce\(p_limit, 51\), 1\), 201\)/i);
});
test('app.dl_resolve (schema test 11; 08 A6.4, A8.4, A10.1, A23.2): version guard, open-only, tenant_id IS NULL, platform only, invalid-input guard, job_payload for replayed only, job_key returned', () => {
  const t = ws(fnText(allSql(), 'app.dl_resolve') ?? '');
  assert.ok(t);
  assert.match(t, /p_dead_letter_id uuid, p_expected_version integer, p_state text, p_resolution_note text DEFAULT NULL/i);
  assert.match(t, /MESSAGE = 'dl_resolve_invalid_input'/);
  assert.match(t, /p_state NOT IN \('replayed', ?'discarded'\)/i); assert.match(t, /p_state = 'discarded' AND p_resolution_note IS NULL/i);
  assert.match(t, /d\.tenant_id IS NULL AND d\.state = 'open' AND d\.version = p_expected_version AND \(SELECT app\.is_platform_actor\(\)\)/i);
  assert.match(t, /version\s*=\s*d\.version \+ 1/i); assert.match(t, /resolved_by\s*=\s*app\.current_actor_id\(\)/i); assert.match(t, /resolution_note\s*=\s*p_resolution_note/i);
  assert.match(t, /CASE WHEN p_state = 'replayed' THEN d\.job_payload END/i, 'job_payload only for replayed (08 A10.1)');
  assert.match(t, /job_payload jsonb,\s*job_key text\)/i, 'result ends with job_payload, job_key');
  assert.match(t, /d\.job_key/i);
});

// ================================================================ tenant list / cron / resolvers
const MAINT = {
  platform_list_tenants: { gate: 'platform_list_tenants', to: ['lims_api'] },
  cron_tenant_ids: { gate: 'cron_tenant_ids', to: ['lims_worker'] },
  identity_tenants_for_email_hmacs: { gate: 'identity_tenants_for_email_hmacs', to: ['lims_worker'] },
};
for (const [fn, { gate, to }] of Object.entries(MAINT)) {
  test(`app.${fn}: DEFINER, search_path empty, sets app.maintenance='${gate}' and resets it to '', EXECUTE ${to.join(',')} only`, () => {
    const t = ws(fnText(allSql(), `app.${fn}`) ?? '');
    assert.ok(t, `app.${fn} present`);
    assert.match(t, /SECURITY DEFINER/i); assert.match(t, /SET search_path = ''/i); assert.match(t, /VOLATILE/i);
    assert.ok(t.indexOf(`set_config('app.maintenance', '${gate}', true)`) > 0, `sets ${gate}`);
    assert.ok(t.lastIndexOf(`set_config('app.maintenance', '', true)`) > t.indexOf(`'${gate}'`), 'reset to empty string after the read');
    assert.deepEqual([...(fnExecGrants(allSql()).get(`app.${fn}`) ?? [])].sort(), to);
  });
}
test('app.platform_list_tenants (schema test 16): signature, platform-actor fail-closed, sort whitelist, no status_reason/created_by/updated_by in the output, limit cap 201', () => {
  const t = ws(fnText(allSql(), 'app.platform_list_tenants') ?? '');
  assert.match(t, /p_sort text, p_status text DEFAULT NULL, p_after_tenant_code text DEFAULT NULL, p_after_created_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51/i);
  assert.match(t, /RETURNS TABLE \(id uuid, tenant_code text, legal_name text, display_name text, status text, timezone text, activated_at timestamptz, suspended_at timestamptz, offboarded_at timestamptz, billing_live_on date, is_active boolean, version integer, created_at timestamptz, updated_at timestamptz\)/i);
  assert.match(t, /p_sort NOT IN \('code', ?'-created_at'\)/i); assert.match(t, /MESSAGE = 'platform_list_tenants_invalid_input'/);
  assert.match(t, /NOT coalesce\(\(SELECT app\.is_platform_actor\(\)\), false\) THEN\s*RETURN/i, 'no row unless platform actor');
  assert.match(t, /ORDER BY t\.tenant_code/i); assert.match(t, /ORDER BY t\.created_at DESC, t\.id DESC/i); assert.match(t, /least\(greatest\(coalesce\(p_limit, 51\), 1\), 201\)/i);
  assert.doesNotMatch(t.slice(0, t.search(/\$\w*\$/i)), /status_reason|created_by|updated_by/i);
});
test('app.cron_tenant_ids (schema test 22): returns uuids of active+suspended tenants only; app.core_resolve_tenant_code (test 29): sets/reset app.pre_tenant_code, TABLE (tenant_id uuid, status text), lims_api only; email-hmac lookup: <=100 values guard', () => {
  const all = allSql(), f = (n) => ws(fnText(all, `app.${n}`) ?? ''), c = f('cron_tenant_ids'), r = f('core_resolve_tenant_code'), e = f('identity_tenants_for_email_hmacs');
  assert.match(c, /RETURNS SETOF uuid/i); assert.match(c, /t\.status IN \('active', ?'suspended'\)/i);
  assert.match(r, /\(p_code text\) RETURNS TABLE \(tenant_id uuid, status text\)/i);
  assert.ok(r.indexOf(`set_config('app.pre_tenant_code', coalesce(p_code, ''), true)`) > 0, 'sets app.pre_tenant_code');
  assert.ok(r.lastIndexOf(`set_config('app.pre_tenant_code', '', true)`) > r.indexOf('RETURN QUERY'), 'resets app.pre_tenant_code');
  assert.deepEqual([...(fnExecGrants(all).get('app.core_resolve_tenant_code') ?? [])], ['lims_api']);
  assert.match(e, /\(p_hmacs bytea\[\]\) RETURNS SETOF uuid/i); assert.match(e, /cardinality\(p_hmacs\), 0\) > 100/i);
  assert.match(e, /MESSAGE = 'identity_tenants_for_email_hmacs_invalid_input'/); assert.match(e, /u\.email_hmac = ANY \(p_hmacs\)/i);
});

// ================================================================ GUC-bound owner policies extended by T0B-05 are still lims_owner-only (08 A12.7)
test('tenants__select__owner_only / users__select__owner_only keep every GUC branch the T0B-05 DEFINERs need and stay TO lims_owner (last definition wins)', () => {
  const pols = policies(allSql());
  const last = (n) => pols.filter((p) => p.name === n).pop();
  const t = last('tenants__select__owner_only'), u = last('users__select__owner_only');
  assert.ok(t && u);
  assert.equal(t.roles, 'lims_owner'); assert.equal(u.roles, 'lims_owner');
  for (const frag of ["current_setting('app.maintenance',true)='platform_list_tenants'", "current_setting('app.maintenance',true)='cron_tenant_ids'", "status in ('active','suspended')", "tenant_code=nullif(current_setting('app.pre_tenant_code',true),'')", "id=nullif(current_setting('app.pre_tenant_id',true),'')::uuid"]) {
    assert.ok(t.using.includes(norm(frag)), `tenants__select__owner_only has ${frag}`);
  }
  assert.ok(u.using.includes(norm("current_setting('app.maintenance', true) = 'identity_tenants_for_email_hmacs' AND email_hmac IS NOT NULL")), 'users__select__owner_only has the D-217 branch');
});

// ================================================================ schema test 26 (static): uncast centre predicate anywhere in the platform migrations
test('schema test 26 (static): no policy in the T0B-05 migrations uses current_centre_ids() without the ::uuid[] cast (08 A16.1)', () => {
  for (const p of policies(allSql())) {
    for (const part of [p.using, p.check]) if (/current_centre_ids\(\)/.test(part)) assert.match(part, /current_centre_ids\(\)\)::uuid\[\]/, `${p.key}`);
  }
});

// ================================================================ hygiene
test('hygiene: platform migrations never disable/relax RLS, never add ENUM types, never use SECURITY DEFINER without an empty search_path, synthetic data only', () => {
  const all = allSql();
  assert.doesNotMatch(all, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(all, /CREATE\s+TYPE\s+[\w.]+\s+AS\s+ENUM/i);
  for (const m of all.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\(/gi)) {
    const t = fnText(all, m[1]); if (!t || !/SECURITY\s+DEFINER/i.test(t)) continue;
    assert.match(t, /SET\s+search_path\s*=\s*''/i, `${m[1]}: SECURITY DEFINER must SET search_path = ''`);
  }
});
