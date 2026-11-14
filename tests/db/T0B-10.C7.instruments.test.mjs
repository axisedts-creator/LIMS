// T0B-10.C7 static checks of the Wave-1 instruments DDL translation: db/migrations/*_instruments__*.sql, db/policies/instruments.sql, db/meta/tables.yaml, definer-inventory.yaml,
// transition / mutable-column triggers, the three lims_owner DEFINERs (device-credential resolver, agent-state snapshot, archive purge), v_pub_* views.
// Spec: C7 05-SCHEMA §1-§8 (§2 columns, §3 indexes, §4 triggers/audit, §5 policies + grants + DEFINERs, §6 views, §7 DDL + seeds); IC §6.5; C0 05-SCHEMA §3.8/§9/§10; 08 A10.5, A12.1, A12.2, A12.7, A13 D-42, A16.1;
// AC-0B-2.1..2.4, 3.6 (probes), 4.1..4.3, 5.x (audit triggers), 6.1..6.3 (static part: order, role switch, FK direction).
// Run: node --test tests/db/T0B-10.C7.instruments.test.mjs   (live: db/tests/instruments/T0B-10.C7_*.test.sql via pg_prove; generated probes: db/tests/isolation/instruments.*.test.sql)
// Method (as T0B-10.C2..C6): the expected DDL is PARSED FROM C7 05-SCHEMA at test time and compared (whitespace/case-normalised) with the migrations, so a drifting column, constraint, index,
// trigger, function body, policy, grant, seed or view fails here. What the spec only describes (centre-table policy template, agents/instruments mutable-column complement lists, the five transition
// trigger functions whose bodies "follow 03-APP-FLOW §2") is derived or checked by property. T0B10C7_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B10C7_ROOT ? resolve(process.env.T0B10C7_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const insFiles = () => files().filter((f) => /^\d{14}_instruments__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const insSql = () => insFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'instruments.sql') ? strip(readFileSync(polDir + 'instruments.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C6)
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
const trgArgs = (s, fn) => { const m = new RegExp(`${fn}\\s*\\(`, 'i').exec(s); return m ? splitTop(balanced(s, m.index + m[0].length)).map((a) => a.replace(/^'|'$/g, '')).sort() : null; };
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
// GRANT ... ON table: Map "schema.table" -> Map role -> { all: Set(priv), cols: Map(priv -> Set(col)) }   (functions / schemas / sequences skipped)
function grantsOf(sql) {
  const g = new Map();
  for (const s of stmts(sql)) {
    const m = /^GRANT\s+(.+?)\s+ON\s+(?:TABLE\s+)?([\w., ]+?)\s+TO\s+([\w, ]+?)(\s+WITH\s+GRANT\s+OPTION)?$/i.exec(ws(s));
    if (!m || /\bFUNCTION\b|\bSCHEMA\b|\bSEQUENCE\b/i.test(s) || /^(EXECUTE|USAGE|CREATE)$/i.test(m[1].trim())) continue;
    const items = splitTop(m[1]).map((x) => /^(\w+)\s*(?:\(([^)]*)\))?$/.exec(x.trim())).filter(Boolean);
    for (const t of m[2].split(',').map((x) => x.trim())) for (const r of m[3].split(',').map((x) => x.trim())) {
      if (!g.has(t)) g.set(t, new Map());
      const rm = g.get(t); if (!rm.has(r)) rm.set(r, { all: new Set(), cols: new Map() });
      for (const [, p, cl] of items) {
        const P = p.toUpperCase();
        if (cl === undefined) rm.get(r).all.add(P);
        else { if (!rm.get(r).cols.has(P)) rm.get(r).cols.set(P, new Set()); for (const c of cl.split(',').map((x) => x.trim())) rm.get(r).cols.get(P).add(c); }
      }
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

// ---------------------------------------------------------------- spec extraction (C7 05-SCHEMA)
const specPath = repo + 'spec/chunks/C7-instrument-integration/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = s.indexOf(b0, a + a0.length); assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const S3 = '## 3. Indexes', S4 = '## 4. Immutability', S5 = '## 5. RLS policies', S6 = '## 6. Published views', S7 = '## 7. DDL', S8 = '## 8. Required DB tests';
const specDdl = () => strip(sqlBlocks(between(specRaw(), S7, S8)));
const spec5 = () => strip(sqlBlocks(between(specRaw(), S5, S6)));
const specView = () => strip(sqlBlocks(between(specRaw(), S6, S7)));
const spec3 = () => between(specRaw(), S3, S4);

const G_T = ['g_drivers', 'g_agent_releases', 'g_cs_revoke_reasons', 'g_cs_reprocess_reasons'].map((t) => `instruments.${t}`);
const TENANT = ['settings', 'agents', 'agent_credentials', 'agent_status', 'agent_health_transitions', 'agent_config_versions', 'agent_commands', 'agent_log_bundles', 'instruments', 'instrument_status',
  'messages', 'processing_runs', 'message_records', 'message_duplicates', 'message_rejections', 'attachments', 'observed_codes'].map((t) => `instruments.${t}`);   // 17 (event_inbox exists from T0B-05)
const ALLT = [...G_T, ...TENANT];                                                       // 21 new tables
const isG = (q) => /\.g_/.test(q);
const CENTRE_T = TENANT.filter((q) => q !== 'instruments.settings');                    // 16 (§1.1)
const UPD_T = ['agents', 'agent_credentials', 'agent_status', 'agent_commands', 'instruments', 'instrument_status', 'attachments', 'observed_codes'].map((t) => `instruments.${t}`);   // §5 UPDATE policy
const SIU_T = ['agents', 'instruments', 'agent_commands', 'attachments', 'agent_status', 'instrument_status', 'observed_codes', 'settings'].map((t) => `instruments.${t}`);          // §5 grants
const SI_T = ['agent_health_transitions', 'agent_config_versions', 'agent_log_bundles', 'messages', 'processing_runs', 'message_records', 'message_duplicates', 'message_rejections'].map((t) => `instruments.${t}`);
const PURGE_T = ['messages', 'processing_runs', 'message_records', 'message_duplicates', 'message_rejections', 'attachments', 'agent_log_bundles', 'agent_commands', 'agent_health_transitions', 'observed_codes'].map((t) => `instruments.${t}`);
const CLS = { agents: 'M', agent_credentials: 'M', agent_status: 'E', agent_health_transitions: 'A', agent_config_versions: 'A', agent_commands: 'E', agent_log_bundles: 'E', instruments: 'M', instrument_status: 'E',
  messages: 'A', processing_runs: 'A', message_records: 'A', message_duplicates: 'A', message_rejections: 'A', attachments: 'C', observed_codes: 'E', settings: 'M' };
const AUDITED = ['agents', 'agent_credentials', 'agent_commands', 'instruments', 'attachments', 'settings'].map((t) => `instruments.${t}`);
const PUB_VIEWS = ['v_pub_agent_status', 'v_pub_message_daily', 'v_pub_instrument_directory'].map((v) => `instruments.${v}`);
const DEFINERS = ['app.instruments_resolve_device_credential', 'app.instruments_agent_state_snapshot', 'app.purge_instruments_archive'];
const DEFINER_EXEC = { 'app.instruments_resolve_device_credential': 'lims_api', 'app.instruments_agent_state_snapshot': 'lims_worker', 'app.purge_instruments_archive': 'lims_worker' };
const TRG_FN = { 'instruments.tg_agent_transition': 'instruments.agents', 'instruments.tg_instrument_transition': 'instruments.instruments', 'instruments.tg_credential_transition': 'instruments.agent_credentials',
  'instruments.tg_command_transition': 'instruments.agent_commands', 'instruments.tg_attachment_transition': 'instruments.attachments' };
const GLOBAL_INDEXES = ['agent_credentials__secret_sha256__uq'];                        // §3: the only non-tenant-leading index (credential found before any tenant is known)
const MANDATORY = ['id', 'tenant_id', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'];

// ---- expected policies: literals from §5 (settings + owner_only) plus the centre template of §5 (rows 1-16) expanded per table
const T = 'tenant_id = (SELECT app.current_tenant_id())';
const CSP = '((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))';
function expectedPolicies() {
  const lit = policies(spec5()).filter((p) => p.table !== 'instruments.T');
  const have = new Set(lit.map((p) => p.key)), out = [];
  const add = (tbl, cmd, using, check) => {
    const name = `${tbl}__${cmd.toLowerCase()}__tenant_centre`, key = `${name}@instruments.${tbl}`; if (have.has(key)) return; have.add(key);
    const parts = [`CREATE POLICY ${name} ON instruments.${tbl} FOR ${cmd} TO lims_app`];
    if (using) parts.push(`USING (${using})`); if (check) parts.push(`WITH CHECK (${check})`);
    out.push(...policies(parts.join(' ')));
  };
  for (const q of CENTRE_T) {
    const t = q.split('.')[1], pred = `${T} AND (SELECT app.is_staff_or_system()) AND ${CSP}`;
    add(t, 'SELECT', pred); add(t, 'INSERT', null, pred); if (UPD_T.includes(q)) add(t, 'UPDATE', pred, pred);
  }
  return [...lit, ...out];
}
const EXPECTED_POLICY_COUNT = 66;                                                        // 40 centre-template + 3 settings + 3 resolver/snapshot owner_only + 20 purge owner_only

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 21 new instruments tables (4 G + 17 tenant), 3 DEFINERs, 3 views, 3 spec mutable-column triggers, 3 seeds, §3 index names, 66 expected policies derived', () => {
  const ddl = specDdl();
  for (const q of ALLT) assert.ok(createTable(ddl, q), `spec has ${q}`);
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 21, '21 CREATE TABLE in §7');
  assert.doesNotMatch(ddl, /CREATE\s+TABLE\s+instruments\.event_inbox/i);
  assert.deepEqual(fnNames(spec5()).sort(), [...DEFINERS].sort());
  assert.deepEqual([...specView().matchAll(/CREATE\s+VIEW\s+([\w.]+)/gi)].map((m) => m[1]), PUB_VIEWS);
  assert.equal(createTriggers(ddl).length, 3, 'spec §7 literal triggers: agent_credentials / attachments / agent_commands mutable_columns');
  assert.equal([...ddl.matchAll(/INSERT\s+INTO\s+instruments\.(g_\w+)/gi)].length, 3);
  const ps = expectedPolicies();
  assert.equal(new Set(ps.map((p) => p.key)).size, ps.length, 'no duplicate expected policy');
  assert.equal(ps.length, EXPECTED_POLICY_COUNT, `expected policies: ${ps.length}`);
  assert.deepEqual([...new Set(ps.map((p) => p.table))].sort(), [...TENANT].sort(), 'every tenant table (and no G table) has policies');
  assert.deepEqual([...new Set(ps.filter((p) => /__owner_only$/.test(p.name)).map((p) => p.roles))], ['lims_owner']);
  const refs = new Set([...ddl.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase().split('.')[0]));
  assert.deepEqual([...refs].sort(), ['core', 'instruments'], 'spec FK target schemas (§ header: only instruments -> core)');
  const names = [...spec3().matchAll(/`([a-z_0-9]+__[a-z_0-9]*(?:uq|idx))\b/g)].map((m) => m[1]);
  assert.ok(names.length >= 30, `§3 index names: ${names.length}`);
});

// ================================================================ files, order, owner (AC-0B-6.1 / 6.3)
test('migration files: >= 1 *_instruments__*.sql, unique timestamps, after the core + identity + catalog + frontdesk + billing + lab + reporting + event_inboxes migrations (stage order), db/policies/instruments.sql exists', () => {
  assert.ok(insFiles().length >= 1, 'no db/migrations/*_instruments__*.sql yet (T0B-10.C7 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => /_(core|catalog|frontdesk|billing|lab|identity|reporting)__/.test(f) || /core__create_event_inboxes|app__create_queue_wrapper/.test(f));
  assert.ok(earlier.length >= 8, 'earlier-stage migrations present');
  for (const f of insFiles()) for (const e of earlier) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (02-TRD §4.2 stage order)`);
  assert.ok(existsSync(polDir + 'instruments.sql'), 'db/policies/instruments.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(insSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)instruments\b/i, 'schema instruments exists since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every instruments migration is SET LOCAL ROLE lims_owner and it is the only role switch (all objects owned by lims_owner; no D-201 window: C7 has no lookup role)', () => {
  assert.ok(insFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+|SET\s+SESSION\s+AUTHORIZATION)/gi)].map((m) => ws(m[1]).toUpperCase());
  for (const f of insFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch`);
  }
  assert.doesNotMatch(insSql(), /GRANT\s+CREATE\s+ON\s+(SCHEMA\s+app|DATABASE)/i, 'no standing CREATE grants');
  assert.doesNotMatch(insSql(), /CREATE\s+ROLE|ALTER\s+ROLE/i, 'roles are C0 bootstrap');
});

// ================================================================ tables (columns + constraints = spec; only mandatory columns / UNIQUE (tenant_id, id) may be added by C0)
for (const q of ALLT) {
  test(`${q}: every spec column + constraint (name + text) present identically in the migration; only C0 mandatory columns / UNIQUE (tenant_id, id) may be extra (05-SCHEMA §7; C0 §9 rule 1)`, () => {
    const exp = createTable(specDdl(), q); assert.ok(exp, `spec table ${q}`);
    const got = createTable(insSql(), q);
    assert.ok(got, `CREATE TABLE ${q} not found in *_instruments__*.sql`);
    for (const [c, def] of exp.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    for (const c of got.colMap.keys()) if (!exp.colMap.has(c)) assert.ok(MANDATORY.includes(c), `${q}: extra column ${c} is not a mandatory column`);
    for (const [c, def] of exp.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    for (const [c, def] of got.conMap) if (!exp.conMap.has(c)) assert.match(def, /^constraint\s+\w+\s+unique\(tenant_id,id\)$/, `${q}: extra constraint ${c} (only UNIQUE (tenant_id, id) may be added)`);
  });
}
test('exactly the 21 §7 tables are created in instruments (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9); credential material only as sha256', () => {
  const sql = insSql(), bare = sql.replace(/'(?:[^']|'')*'/g, "''"); // string literals blanked: 'serial' is the required transport CHECK value
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(bare, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /event_inbox/i, 'C7 migrations do not touch event_inbox (T0B-05 owns it)');
  for (const q of ALLT) for (const c of ['id', 'tenant_id']) { const def = createTable(sql, q).colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`); }
  const cols = ALLT.flatMap((q) => createTable(sql, q).colNames.map((c) => `${q}.${c}`));
  assert.deepEqual(cols.filter((c) => /(secret|token|password|otp)/.test(c.split('.')[2])), ['instruments.agent_credentials.secret_sha256'], 'only the hashed device secret');
  assert.match(createTable(sql, 'instruments.agent_credentials').colMap.get('secret_sha256'), /^secret_sha256 bytea not null$/);
});
test('cross-schema references (01-CM §5 R3): instruments -> instruments / core.tenants / core.collection_centres only, identical target set to the spec; NO FK into lab / catalog / reporting; nothing outside instruments references instruments (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(insSql()), exp = tgt(specDdl());
  assert.deepEqual([...got].sort(), [...exp].sort(), 'FK target tables equal the spec');
  for (const t of got) assert.ok(/^instruments\./.test(t) || /^core\.(tenants|collection_centres)$/.test(t), `instruments FK target ${t}`);
  assert.doesNotMatch(files().filter((f) => !/_instruments__/.test(f)).map(read).join('\n'), /\bREFERENCES\s+instruments\./i, 'no FK into instruments from any other migration');
});
test('indexes: every §7 CREATE INDEX present with identical definition (partial predicates, DESC incl.); no extra index; every §3 index name exists as an index or a constraint', () => {
  const have = new Map(createIndexes(insSql()).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  assert.ok(exp.length >= 25, `spec indexes: ${exp.length}`);
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].sort(), exp.map(idxName).sort(), 'no index beyond the spec');
  for (const n of ['agent_credentials__secret_sha256__uq', 'agents__tenant_id_agent_code__uq', 'instruments__tenant_id_instrument_code__uq', 'messages__tenant_id_agent_id_agent_message_id__uq',
    'messages__tenant_id_instrument_id_message_key__uq', 'processing_runs__tenant_id_message_id_run_no__uq', 'agent_config_versions__tenant_id_agent_id_config_version__uq'])
    assert.match(have.get(n) ?? '', /^create unique index/, `${n} is UNIQUE`);
  const conNames = new Set(ALLT.flatMap((q) => [...createTable(insSql(), q).conMap.keys()]));
  const missing = [...new Set([...spec3().matchAll(/`([a-z_0-9]+__[a-z_0-9]*(?:uq|idx))\b/g)].map((m) => m[1]))].filter((n) => !have.has(n) && !conNames.has(n));
  assert.deepEqual(missing, [], '§3 index names that exist neither as CREATE INDEX nor as a constraint');
});
test('tenant_id leads every index and UNIQUE/PK constraint of a tenant table (except single-column PRIMARY KEY (id)); only agent_credentials.secret_sha256 is a global index (stated reason, C0 §9 rule 2)', () => {
  const sql = insSql();
  for (const s of createIndexes(sql)) {
    const m = /\bON\s+(\w+\.\w+)\s+(?:USING\s+\w+\s+)?\(\s*([^,)]+)/i.exec(s); assert.ok(m, s);
    if (GLOBAL_INDEXES.includes(idxName(s))) continue;
    assert.equal(m[2].trim(), 'tenant_id', `index ${idxName(s)} on ${m[1]} must lead with tenant_id`);
  }
  for (const n of GLOBAL_INDEXES) assert.ok(createIndexes(sql).some((s) => idxName(s) === n && /\(\s*secret_sha256\s*\)/i.test(s)), `global index ${n}`);
  for (const q of TENANT) {
    const t = createTable(sql, q);
    for (const c of [...t.conMap.values()].filter((x) => /\b(primary key|unique)\(/.test(x))) {
      const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1];
      if (/primary key/.test(c) && k === 'id') continue;
      assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${c}`);
    }
  }
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A10.5, A16.1)
test('ENABLE + FORCE ROW LEVEL SECURITY (literal statements) on the 17 tenant tables; none on the 4 g_* tables; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = insSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of G_T) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(insSql(), /\bDO\s+\$\$/i, 'literal statements only');
});
const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('instruments.') && !/\.event_inbox$/.test(p.table));
test('policies: db/policies/instruments.sql holds EXACTLY the expected 66 policies (§5 literals + centre template expanded): name, command, role, USING, WITH CHECK; G tables none; only event_inbox may be extra', () => {
  const exp = expectedPolicies(), got = gotPolicies();
  assert.ok(got.length > 0, 'db/policies/instruments.sql has no CREATE POLICY');
  const byKey = new Map(got.map((p) => [p.key, p])); assert.equal(byKey.size, got.length, 'no duplicate policy');
  for (const e of exp) {
    const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(g.using, e.using, `${e.key} USING`); assert.equal(g.check, e.check, `${e.key} WITH CHECK`);
  }
  assert.deepEqual([...byKey.keys()].sort(), exp.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access)');
  for (const p of policies(polSql()).filter((x) => /\.event_inbox$/.test(x.table))) assert.match(p.name, /^event_inbox__(select|insert|delete)__(tenant|owner_only)$/, `${p.key}: only the C0 inbox shapes may appear`);
});
test('policy shape: names <table>__<cmd>__<scope>; lims_app for tenant / tenant_centre, lims_owner for owner_only; ::uuid[] cast (A16.1); settings and every tenant_centre policy carry the staff guard (02-CV §5.8, 08 A17 P-16; is_staff_or_system() is true for device); NO DELETE for lims_app; owner_only DELETE exactly on the 10 purge tables, bound to app.maintenance = purge_instruments_archive AND the claim tenant; resolver policies bound to app.pre_* / app.maintenance GUCs', () => {
  const ps = gotPolicies();
  assert.equal(ps.length, EXPECTED_POLICY_COUNT, `policies: ${ps.length}`);
  for (const p of ps) {
    const tbl = p.table.split('.')[1], m = new RegExp(`^${tbl}__${p.cmd.toLowerCase()}__(tenant|tenant_centre|owner_only)$`).exec(p.name);
    assert.ok(m, `${p.key}: name <table>__<cmd>__<scope>`);
    assert.equal(p.roles, m[1] === 'owner_only' ? 'lims_owner' : 'lims_app', `${p.key} roles (owner_only policies are TO lims_owner ONLY, 08 A12.7)`);
    const t = p.using + ' ' + p.check;
    if (/current_centre_ids/.test(t)) assert.match(t, /any\(\(select app\.current_centre_ids\(\)\)::uuid\[\]\)/, `${p.key}: A16.1 cast`);
    if (m[1] === 'tenant_centre') { assert.match(t, /has_all_centres/, `${p.key}: all-centres escape`); for (const part of [p.using, p.check].filter(Boolean)) assert.match(part, /\(select app\.is_staff_or_system\(\)\)/, `${p.key}: staff guard in USING/WITH CHECK (02-CV §5.8; true for device, so §1.1 access unchanged)`); }
    if (m[1] === 'tenant') { assert.equal(p.table, 'instruments.settings'); assert.match(p.cmd === 'INSERT' ? p.check : p.using, /\(select app\.is_staff_or_system\(\)\)/, `${p.key} staff guard (review #15)`); }
    if (m[1] !== 'owner_only') assert.match(t, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: tenant predicate`);
    if (m[1] === 'owner_only') assert.match(p.using, /current_setting\('app\.(pre_device_secret_sha256|pre_device_agent_id|maintenance)',true\)/, `${p.key}: bound to an app.* GUC (08 A12.1/A12.2)`);
    assert.doesNotMatch(t, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|is_platform_actor/, p.key);
    assert.ok(!isG(p.table), `${p.key}: G tables carry no policy`);
  }
  assert.ok(!ps.some((p) => p.cmd === 'DELETE' && p.roles === 'lims_app'), 'no DELETE policy TO lims_app on any table (purge runs as lims_owner)');
  assert.deepEqual(ps.filter((p) => p.cmd === 'DELETE').map((p) => p.table).sort(), [...PURGE_T].sort());
  for (const p of ps.filter((x) => x.name.endsWith('__owner_only') && PURGE_T.includes(x.table) && x.cmd !== 'INSERT')) {
    if (p.name.endsWith('__select__owner_only') || p.cmd === 'DELETE') {
      assert.match(p.using, /current_setting\('app\.maintenance',true\)='purge_instruments_archive'/, `${p.key}`);
      assert.match(p.using, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: one tenant per call (08 A13 P-6)`);
    }
  }
  assert.deepEqual(ps.filter((p) => p.cmd === 'UPDATE').map((p) => p.table).sort(), [...UPD_T, 'instruments.settings'].sort(), 'UPDATE policies only where §5 lists them');
  assert.match(ps.find((p) => p.key === 'agent_credentials__select__owner_only@instruments.agent_credentials').using, /secret_sha256=decode\(nullif\(current_setting\('app\.pre_device_secret_sha256',true\),''\),'hex'\)/);
  assert.match(ps.find((p) => p.key === 'agent_status__select__owner_only@instruments.agent_status').using, /='instruments_agent_state_snapshot'/);
  const cen = new Set(ps.filter((p) => /current_centre_ids/.test(p.using + p.check)).map((p) => p.table));
  assert.deepEqual([...cen].sort(), [...CENTRE_T].sort(), 'centre predicates on exactly the 16 centre-scoped tables');
  assert.ok(!ps.some((p) => p.table === 'instruments.settings' && /centre/.test(p.using + p.check)), 'settings is tenant-only');
});
test('policies written literally in migrations are identical to db/policies/instruments.sql (AC-0B-2.3 copy)', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(insSql()).filter((x) => x.table.startsWith('instruments.') && !/\.event_inbox$/.test(x.table));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort(), 'every policy of the file is created by a migration and vice versa');
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §5 grants table; CR-C7-006 column grant)
test('grants equal §5: lims_app SIU on 8 tables, SI on 8 append tables, S on g_*; agent_credentials INSERT all columns + UPDATE lifecycle columns + SELECT every column EXCEPT secret_sha256 (column-level); views S to lims_app + lims_analytics; no DELETE / TRUNCATE / REFERENCES / TRIGGER / ALL anywhere', () => {
  const sql = insSql() + '\n;\n' + polSql(), g = grantsOf(sql);
  const privs = (q, r) => g.get(q)?.get(r)?.all ?? new Set();
  for (const q of SIU_T) assert.deepEqual([...privs(q, 'lims_app')].sort(), ['INSERT', 'SELECT', 'UPDATE'], `${q} lims_app`);
  for (const q of SI_T) assert.deepEqual([...privs(q, 'lims_app')].sort(), ['INSERT', 'SELECT'], `${q} lims_app (class A: no UPDATE, no DELETE)`);
  for (const q of G_T) assert.deepEqual([...privs(q, 'lims_app')].sort(), ['SELECT'], `${q} lims_app`);
  for (const v of PUB_VIEWS) for (const r of ['lims_app', 'lims_analytics']) assert.deepEqual([...privs(v, r)].sort(), ['SELECT'], `${v} ${r}`);
  const ac = g.get('instruments.agent_credentials')?.get('lims_app'); assert.ok(ac, 'GRANTs on agent_credentials');
  const cols = createTable(insSql(), 'instruments.agent_credentials').colNames;
  assert.ok(!ac.all.has('SELECT') && !ac.all.has('UPDATE'), 'no whole-table SELECT / UPDATE on agent_credentials (it would include secret_sha256)');
  assert.ok(ac.all.has('INSERT') || [...(ac.cols.get('INSERT') ?? [])].sort().join() === [...cols].sort().join(), 'INSERT on all columns');
  assert.deepEqual([...(ac.cols.get('SELECT') ?? [])].sort(), cols.filter((c) => c !== 'secret_sha256').sort(), 'column-level SELECT = every column except secret_sha256');
  assert.deepEqual([...(ac.cols.get('UPDATE') ?? [])].sort(), trgArgs(createTriggers(specDdl()).find((x) => /ON instruments\.agent_credentials/.test(x)), 'app\\.enforce_mutable_columns').sort(), 'column-level UPDATE = the mutable (lifecycle) columns');
  const expTargets = new Set([...SIU_T, ...SI_T, ...G_T, ...PUB_VIEWS, 'instruments.agent_credentials']);
  for (const [t, rm] of g) if (/^instruments\./.test(t)) {
    assert.ok(expTargets.has(t), `${t}: unexpected grant target`);
    for (const [r, p] of rm) {
      assert.ok(['lims_app', 'lims_analytics'].includes(r), `${t}: unexpected grantee ${r}`);
      for (const bad of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!p.all.has(bad) && !p.cols.has(bad), `${t}: ${r} must not hold ${bad} (02-CV §5.6; purge runs as lims_owner)`);
      for (const s of p.cols.get('SELECT') ?? []) assert.notEqual(s, 'secret_sha256', `${t}: SELECT on secret_sha256`);
    }
  }
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\binstruments\./i);
  assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+instruments\b/i);
  assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\binstruments\b/i);
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\binstruments\./i.test(s) && !/FUNCTION/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner)\b/i, s);
});

// ================================================================ functions + triggers (AC-0B-4.1; §4)
test('the 3 DEFINER functions equal §5 verbatim (SECURITY DEFINER, VOLATILE, search_path = \'\'; pre-tenant GUCs set_config(..., true) and reset to \'\' before returning); REVOKE ALL FROM PUBLIC; EXECUTE: resolver -> lims_api only, snapshot + purge -> lims_worker only (never lims_api / lims_app)', () => {
  const sql = insSql(), want = spec5();
  for (const f of DEFINERS) {
    const got = fnText(sql, f), exp = fnText(want, f); assert.ok(got, `${f} missing`); assert.equal(norm(got), norm(exp), `${f} body`);
    assert.match(got, /SECURITY\s+DEFINER/i); assert.match(got, /SET\s+search_path\s*=\s*''/i); assert.match(got, /\bVOLATILE\b/i);
  }
  const keep = (s) => /^(REVOKE ALL ON FUNCTION app\.(instruments_|purge_instruments)|GRANT EXECUTE ON FUNCTION app\.(instruments_|purge_instruments))/i.test(s);
  const g = stmts(sql).map(ws).filter(keep).map(norm).sort(), e = stmts(want).map(ws).filter(keep).map(norm).sort();
  assert.deepEqual(g, e, 'REVOKE / GRANT EXECUTE statements');
  assert.equal(g.length, 6);
  for (const [f, r] of Object.entries(DEFINER_EXEC)) assert.ok(g.some((s) => s.startsWith(`grant execute on function ${f}(`) && s.endsWith(`to ${r}`)), `${f} EXECUTE to ${r} only`);
});
test('the 5 transition trigger functions (instruments.tg_agent / instrument / credential / command / attachment _transition) exist as SECURITY INVOKER, search_path = \'\', RETURNS trigger, raising P0001 invalid_transition; they + the 3 DEFINERs are the only functions created', () => {
  const sql = insSql();
  for (const f of Object.keys(TRG_FN)) {
    const got = fnText(sql, f); assert.ok(got, `${f} missing (03-APP-FLOW §2; 05-SCHEMA §4)`);
    assert.match(got, /RETURNS\s+trigger/i); assert.match(got, /SET\s+search_path\s*=\s*''/i); assert.doesNotMatch(got, /SECURITY\s+DEFINER/i, `${f} is INVOKER`);
    assert.match(got, /ERRCODE\s*=\s*'P0001'/i, `${f}: SQLSTATE P0001`); assert.match(got, /invalid_transition/, `${f}: message invalid_transition`);
  }
  assert.deepEqual(fnNames(sql).sort(), [...Object.keys(TRG_FN), ...DEFINERS].sort(), 'no other function');
});
test('triggers: 3 spec mutable_columns triggers equal §7; agents / instruments mutable lists = complement of the frozen identity columns (§4); each transition function is attached BEFORE UPDATE FOR EACH ROW to its table; no other non-audit trigger; none disabled or dropped', () => {
  const sql = insSql(), trg = createTriggers(sql).filter((s) => !isAudit(s)), byName = new Map(trg.map((s) => [trgName(s), s]));
  for (const s of createTriggers(specDdl())) assert.equal(norm(byName.get(trgName(s)) ?? ''), norm(s), `trigger ${trgName(s)}`);
  const mutable = { 'instruments.agents': ['id', 'tenant_id', 'centre_id', 'agent_code', 'created_at', 'created_by'], 'instruments.instruments': ['id', 'tenant_id', 'centre_id', 'agent_id', 'instrument_code', 'protocol', 'created_at', 'created_by'] };
  for (const [q, frozen] of Object.entries(mutable)) {
    const t = q.split('.')[1], s = byName.get(`${t}__mutable_columns`); assert.ok(s, `${t}__mutable_columns missing`);
    assert.match(s, new RegExp(`^CREATE TRIGGER ${t}__mutable_columns BEFORE UPDATE ON ${esc(q)} FOR EACH ROW EXECUTE FUNCTION app\\.enforce_mutable_columns\\(`, 'i'));
    assert.deepEqual(trgArgs(s, 'app\\.enforce_mutable_columns'), createTable(sql, q).colNames.filter((c) => !frozen.includes(c)).sort(), `${q}: mutable columns = all columns except ${frozen.join(', ')}`);
  }
  for (const [f, q] of Object.entries(TRG_FN)) {
    const hit = trg.filter((s) => new RegExp(`EXECUTE\\s+FUNCTION\\s+${esc(f)}\\(\\s*\\)$`, 'i').test(s)); assert.equal(hit.length, 1, `exactly one trigger runs ${f}`);
    assert.match(hit[0], new RegExp(`^CREATE TRIGGER \\w+ BEFORE UPDATE\\b[^;]*\\bON ${esc(q)} FOR EACH ROW`, 'i'), `${f} attached BEFORE UPDATE ... ON ${q} FOR EACH ROW`);
  }
  assert.equal(trg.length, 5 + 5, 'no trigger beyond 5 mutable_columns + 5 transition triggers');
  assert.deepEqual(trg.filter((s) => /enforce_mutable_columns/i.test(s)).map((s) => /ON\s+(\w+\.\w+)/i.exec(s)[1]).sort(),
    ['agent_commands', 'agent_credentials', 'agents', 'attachments', 'instruments'].map((t) => `instruments.${t}`));
  assert.doesNotMatch(sql, /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(sql, /DROP\s+TRIGGER\b/i);
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x): <t>__audit AFTER INSERT OR UPDATE OR DELETE on the 6 audited tables; agent_credentials passes the excluded-column argument secret_sha256 (04 §4; the secret never reaches audit_log); none on E / A / G tables', () => {
  const trg = createTriggers(insSql()).filter(isAudit);
  const onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of AUDITED) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    const t = q.split('.')[1], re = q === 'instruments.agent_credentials' ? "\\(\\s*'secret_sha256'\\s*\\)" : '\\(\\s*\\)';
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${t}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit${re}$`, 'i'), q);
  }
  for (const q of ALLT.filter((x) => !AUDITED.includes(x))) assert.equal(onTable(q).length, 0, `${q} must NOT be audited (heartbeat-updated E tables, A archive, G)`);
  assert.equal(trg.length, 6);
});

// ================================================================ DEFINER inventory (db/meta/definer-inventory.yaml; 08 §4.7, REQ-SEC-020)
test('db/meta/definer-inventory.yaml: the 3 instruments DEFINERs registered with owner lims_owner, the right EXECUTE role, a why, the tables they touch and owner policies that exist in db/policies/instruments.sql', () => {
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  const touches = {
    'app.instruments_resolve_device_credential': ['instruments.agent_credentials SELECT', 'instruments.agents SELECT'],
    'app.instruments_agent_state_snapshot': ['instruments.agent_status SELECT', 'instruments.agents SELECT'],
    'app.purge_instruments_archive': [...PURGE_T.map((t) => `${t} DELETE`), 'instruments.messages SELECT'],
  };
  const pols = new Set(policies(polSql()).map((p) => p.name));
  for (const f of DEFINERS) {
    const e = inv[f]; assert.ok(e, `inventory entry ${f}`);
    assert.equal(e.owner, 'lims_owner', `${f} owner`); assert.deepEqual([...e.execute], [DEFINER_EXEC[f]], `${f} execute`);
    assert.ok(typeof e.why === 'string' && e.why.length > 5, `${f} why`);
    const flat = e.touches.map((x) => ws(x).toUpperCase());
    for (const t of touches[f]) { const [tbl, cmd] = t.split(' '); assert.ok(flat.some((x) => x.startsWith(tbl.toUpperCase()) && x.includes(cmd)), `${f} touches ${t}`); }
    assert.ok(e.policies.length >= 1, `${f} names its owner policies`);
    const expand = (n) => { const m = /^(.*)\{([^}]*)\}(.*)$/.exec(n); return m ? m[2].split(',').map((x) => m[1] + x.trim() + m[3]) : [n]; };
    for (const p of e.policies) for (const n of expand(p)) assert.ok(pols.has(n), `${f}: policy ${n} must exist in db/policies/instruments.sql`);
  }
  for (const g of Object.keys(TRG_FN)) assert.ok(!inv[g], `${g} is SECURITY INVOKER and not inventoried`);
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
test('tables.yaml: all 21 C7 tables registered (class, centre_scoped from the policies, audited = trigger, retention, no shared_with (no portal/partner/patient policy), phi_class for exactly the migration columns); event_inbox entry untouched', () => {
  const y = tablesYaml(), centre = new Set(expectedPolicies().filter((p) => /current_centre_ids/.test(p.using + p.check)).map((p) => p.table));
  const trgAudited = (q) => createTriggers(insSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of ALLT) {
    const e = y[q]; assert.ok(e, `${q} in tables.yaml`);
    assert.equal(e.class, isG(q) ? 'G' : CLS[q.split('.')[1]], `${q} class`);
    assert.equal(e.centre_scoped, centre.has(q), `${q} centre_scoped`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`);
    assert.equal(e.audited, AUDITED.includes(q), `${q} audited per spec §1`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), [...createTable(insSql(), q).colNames].sort(), `${q} columns = migration columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
    assert.deepEqual([...(e.shared_with ?? [])], [], `${q}: no actor-scoped policies, shared_with empty`);
  }
  assert.equal(centre.size, 16);
  assert.ok(y['instruments.event_inbox'] === undefined || y['instruments.event_inbox'].class === 'A', 'inbox entry remains as C0 wrote it');
  assert.deepEqual(Object.keys(y).filter((k) => /^instruments\./.test(k) && !/\.event_inbox$/.test(k)).sort(), [...ALLT].sort(), 'no extra instruments entry');
});
test('tables.yaml phi_class (§2): P3 raw_bytes (messages, message_rejections) / value_raw / ast; P2 sample_barcode / original_file_name; P1 ids, hashes, secret_sha256, host_fingerprint, last_ip, message keys; P0 codes / states / settings / g_*; created_by / updated_by never above P1', () => {
  const y = tablesYaml(), eq = (q, c, ps) => { const col = y[`instruments.${q}`].columns[c]; assert.ok(col !== undefined, `${q}.${c} registered`); assert.ok([].concat(ps).includes(col), `${q}.${c} is ${col}, want ${ps}`); };
  for (const [q, c] of [['messages', 'raw_bytes'], ['message_rejections', 'raw_bytes'], ['message_records', 'value_raw'], ['message_records', 'ast']]) eq(q, c, 'P3');
  for (const [q, c] of [['message_records', 'sample_barcode'], ['attachments', 'original_file_name']]) eq(q, c, 'P2');
  for (const [q, cs] of Object.entries({ agent_credentials: ['secret_sha256', 'agent_id'], agents: ['host_fingerprint_sha256', 'centre_id'], agent_status: ['last_ip'],
    messages: ['agent_message_id', 'message_key', 'message_control_id', 'raw_sha256', 'instrument_id'], attachments: ['sha256'], message_records: ['result_key_sha256'] })) for (const c of cs) eq(q, c, ['P1', 'P2']);
  for (const [q, cs] of Object.entries({ settings: ['default_backlog_threshold', 'clock_offset_warn_seconds'], agents: ['agent_code', 'display_name', 'status', 'update_channel'],
    instruments: ['instrument_code', 'vendor', 'model', 'protocol', 'transport', 'state'], agent_status: ['health_state', 'queue_depth'], agent_log_bundles: ['lines'], observed_codes: ['seen_count', 'last_mapping_status'] })) for (const c of cs) eq(q, c, 'P0');
  eq('agent_config_versions', 'document', ['P0', 'P1']);
  for (const q of G_T) for (const c of Object.keys(y[q].columns)) assert.equal(y[q].columns[c], 'P0', `${q}.${c}`);
  for (const q of ALLT) for (const c of ['created_by', 'updated_by']) if (y[q].columns[c]) assert.ok(['P0', 'P1'].includes(y[q].columns[c]), `${q}.${c}`);
});
test('tables.yaml: rls_exempt only on the 4 g_* tables (with a reason); mandatory-column exceptions are real (listed iff the migration table lacks the column) and carry a reason', () => {
  const y = tablesYaml();
  for (const q of ALLT) {
    const e = y[q], cols = new Set(createTable(insSql(), q).colNames);
    if (isG(q)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    const exc = [...(e.mandatory_column_exceptions ?? [])];
    if (!isG(q)) {
      const missing = MANDATORY.filter((c) => !cols.has(c));
      for (const c of exc) assert.ok(!cols.has(c), `${q}: exception ${c} but the table has that column`);
      assert.deepEqual(exc.filter((c) => MANDATORY.includes(c)).sort(), missing.sort(), `${q}: mandatory_column_exceptions must list exactly the mandatory columns the table lacks`);
    }
    if (exc.length) assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 5, `${q} needs mandatory_column_exceptions_reason`);
  }
});
test('tables.yaml retention (§1): raw archive follows TenantSettings.retention.rawInstrumentYears; records / duplicates / rejections 90 days; log bundles 30 days; commands 90 days after terminal; health transitions + observed_codes 400 days; agents / credentials / config / instruments / settings never deleted; g_* seed', () => {
  const r = (q) => tablesYaml()[`instruments.${q}`].retention;
  assert.match(r('messages'), /rawInstrumentYears|year/i); assert.match(r('processing_runs'), /message|rawInstrumentYears|year/i);
  for (const q of ['message_records', 'message_duplicates', 'message_rejections']) assert.match(r(q), /90/, q);
  assert.match(r('agent_log_bundles'), /30/); assert.match(r('agent_commands'), /90/);
  for (const q of ['agent_health_transitions', 'observed_codes']) assert.match(r(q), /400/, q);
  for (const q of ['agents', 'agent_credentials', 'agent_config_versions', 'instruments', 'settings']) assert.match(r(q), /never|retire|kept/i, q);
  assert.match(r('attachments'), /message|retention|year/i);
  for (const q of G_T) assert.match(tablesYaml()[q].retention, /seed|permanent|never deleted|kept|forever|global/i, q);
});
test('db/tests/rls_exempt.txt lists exactly the four instruments g_* tables, each with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^instruments\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), [...G_T].sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ seeds (§7 "seeds": 6 revoke reasons, 7 reprocess reasons, 5 drivers; synthetic vocabularies)
test('seed rows (§7): the three INSERT INTO instruments.g_cs_revoke_reasons / g_cs_reprocess_reasons / g_drivers statements are in the migrations, identical to the spec (g_agent_releases has no seed: CR-C7-012)', () => {
  const want = stmts(specDdl()).map(ws).filter((s) => /^INSERT\s+INTO\s+instruments\./i.test(s)), got = new Map(stmts(insSql()).map(ws).filter((s) => /^INSERT\s+INTO\s+instruments\./i.test(s)).map((s) => [/INTO\s+(\S+)/i.exec(s)[1], norm(s)]));
  assert.equal(want.length, 3);
  for (const s of want) assert.equal(got.get(/INTO\s+(\S+)/i.exec(s)[1]), norm(s), `seed ${/INTO\s+(\S+)/i.exec(s)[1]}`);
  assert.equal(got.size, 3, 'no other INSERT into instruments');
  const rows = (s) => (s.match(/\('[a-z0-9_]+',/g) ?? []).length;
  assert.deepEqual(want.map(rows), [6, 7, 5]);
  assert.match(want[2], /'mindray_bc5380_sketch'.*'sketch_blocked'/, 'sketch drivers are blocked (B2)');
});

// ================================================================ views (IC §6.5 column contract; C7 §6)
function outerCols(sql) {
  let body = ws(sql).replace(/^CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+[\w.]+\s+(WITH\s*\([^)]*\)\s+)?AS\s+/i, '');
  const topLevel = (b, from, re) => {           // first depth-0, out-of-string position >= from where re matches
    let depth = 0, q = false;
    for (let k = from; k < b.length; k++) {
      const c = b[k];
      if (q) { if (c === "'") q = false; continue; }
      if (c === "'") { q = true; continue; }
      if (c === '(') depth++; else if (c === ')') depth--;
      else if (depth === 0 && re.test(b.slice(k, k + 8))) return k;
    }
    return -1;
  };
  if (/^WITH\s/i.test(body)) { const s = topLevel(body, 4, /^\sSELECT\s/i); assert.ok(s > 0, 'view final SELECT after the CTEs'); body = body.slice(s + 1); }
  const start = /^SELECT\s+/i.exec(body); assert.ok(start, `view SELECT: ${body.slice(0, 40)}`);
  const end = topLevel(body, start[0].length, /^\sFROM\s/i); assert.ok(end > 0, 'view FROM');
  return splitTop(body.slice(start[0].length, end)).map((item) => { const a = /\bAS\s+(\w+)\s*$/i.exec(item.trim()); return a ? a[1] : item.trim().split('.').pop().replace(/\W/g, ''); });
}
const viewSql = (sql, qv) => { const s = stmts(sql).find((x) => new RegExp(`^CREATE\\s+(OR\\s+REPLACE\\s+)?VIEW\\s+${esc(qv)}\\b`, 'i').test(ws(x))); return s ? ws(s) : null; };
const icCols = (qv) => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8').replace(/\r\n?/g, '\n');
  const a = ic.indexOf('### 6.5 `instruments`'), b = ic.indexOf('### 6.6 `catalog`'); assert.ok(a > 0 && b > a, 'IC §6.5');
  const row = ic.slice(a, b).split('\n').find((l) => l.startsWith(`| \`${qv}\``)); assert.ok(row, `IC row for ${qv}`);
  let cell = row.split('|')[2]; while (/\([^()]*\)/.test(cell)) cell = cell.replace(/\([^()]*\)/g, '');
  return splitTop(cell).map((c) => /^\s*`?(\w+)/.exec(c)[1]);
};
test('view column contract vs IC §6.5: each of the 3 v_pub_* views has exactly the IC columns in IC order (spec §6 and the migration agree)', () => {
  for (const v of PUB_VIEWS) {
    const ic = icCols(v), got = viewSql(insSql(), v);
    assert.ok(got, `CREATE VIEW ${v} missing from the C7 migrations`);
    assert.deepEqual(outerCols(viewSql(specView(), v)), ic, `${v}: C7 05-SCHEMA §6 vs IC`);
    assert.deepEqual(outerCols(got), ic, `${v}: migration columns (names + order) vs IC`);
  }
  assert.deepEqual(icCols('instruments.v_pub_agent_status'), ['tenant_id', 'agent_id', 'centre_id', 'state', 'last_heartbeat_at', 'agent_version', 'queue_depth', 'clock_offset_seconds']);
  assert.equal(icCols('instruments.v_pub_message_daily').at(-1), 'duplicates');
});
test('views: the 3 definitions equal the spec, WITH (security_invoker = true), SELECT to lims_app + lims_analytics, no other view / matview in instruments, Asia/Kathmandu business_date, retired agents hidden, no raw / credential / personal column', () => {
  const sql = insSql();
  for (const v of PUB_VIEWS) { const got = viewSql(sql, v); assert.ok(got, v); assert.equal(norm(got), norm(viewSql(specView(), v)), v); assert.match(got, /WITH\s*\(\s*security_invoker\s*=\s*(true|on)\s*\)/i, `${v} security_invoker`); }
  assert.deepEqual([...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\s+(instruments\.\w+)/gi)].map((m) => `${m[1] ? 'M:' : ''}${m[2]}`).sort(), [...PUB_VIEWS].sort());
  assert.match(viewSql(sql, 'instruments.v_pub_message_daily'), /AT TIME ZONE 'Asia\/Kathmandu'/i, 'business_date zone (A13 P-15)');
  assert.match(viewSql(sql, 'instruments.v_pub_agent_status'), /status <> 'retired'/i, 'retired agents are not published');
  for (const v of PUB_VIEWS) assert.doesNotMatch(outerCols(viewSql(sql, v)).join(' '), /\b(raw_bytes|raw_sha256|secret|token|sample_barcode|value_raw|object_path|original_file_name|last_ip|host_fingerprint)\b/i, `${v} exposes no raw / credential / P2 / P3 column`);
});

// ================================================================ hygiene
test('C7 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of other schemas\' tables, no USING (true), no GRANT to PUBLIC', () => {
  const raw = insFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 12000, 'C7 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i);
  assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab|reporting)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016');
  assert.doesNotMatch(strip(raw), /\bTO\s+PUBLIC\b/i);
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts, check-migrations.ts and check-fk-dag.ts exit 0 on the tree (instruments -> core only; nothing into lab / catalog)', () => {
  assert.ok(insFiles().length >= 1, 'C7 migrations missing');
  for (const t of ['check-registry.ts', 'check-migrations.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 17 tenant C7 tables, none for the 4 class G, and gen-isolation-probes --check is clean', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const q of G_T) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/instruments/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-10\.C7_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/instruments/T0B-10.C7_*.test.sql exist (tester-owned: writer must keep them) and cover the AC list by "-- AC-0B-x.y" markers and the 12 spec §8 checks by "-- C7 check N" markers; RLS never disabled in them', () => {
  assert.ok(tapFiles().length >= 2, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 18; n++) assert.match(txt, new RegExp(`-- C7 check ${n}\\b`), `marker for C7 check ${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.2', '6.3']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY|session_replication_role/i, `${f}: RLS never disabled (AC-0B-2.4; 08 A10.5 purge tests keep FORCE RLS on)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
  }
});
