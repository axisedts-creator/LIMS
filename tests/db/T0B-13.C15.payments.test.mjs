// T0B-13.C15 static checks of the Wave-2 payments DDL translation: db/migrations/*_payments__*.sql, db/policies/payments.sql, db/meta/tables.yaml, db/meta/definer-inventory.yaml, db/tests/rls_exempt.txt.
// Spec: C15 05-SCHEMA §1 (inventory, class, exceptions, audit), §2.1 (intents columns + PHI), §3 (RLS, grants, owner policy P-41), §4 (indexes), §5 (coded sets), §6 (DDL), §7 (no view), §8 (seeds), §9 (retention), §10 (14 tests C0 adds);
// C0 05-SCHEMA §9 rule 1 (tenant FK + UNIQUE (tenant_id, id)); 08 A12.1 / A12.7 / A17 P-16, P-18, P-22 / A19 P-40, P-41; CR-C15-004, CR-C15-013; LD-202 (translate exactly, a gap = blocking CR).
// AC-0B-2.1..2.4, 3.1..3.7 (probes + pgTAP), 4.1..4.3, 5.1..5.3, 6.1..6.3 (static part). AC-0B-6.4 is billing-only (T0B-11) and does not apply to payments.
// Run: node --test tests/db/T0B-13.C15.payments.test.mjs   (live: db/tests/payments/T0B-13.C15_*.test.sql via pg_prove; generated probes: db/tests/isolation/payments.*.test.sql)
// Method (as T0B-13.C9..C14): the expected DDL is PARSED FROM C15 05-SCHEMA §6 at test time and compared (whitespace/case-normalised) with the migrations. §6 holds literal SQL for every table, index, function, trigger, policy and grant,
// so no shape has to be expanded here; the independent policy shape (§3: tenant predicate + is_staff_or_system, no centre clause, no actor-type list) and the P-41 owner policy are rebuilt below and compared with both.
// T0B13C15_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B13C15_ROOT ? resolve(process.env.T0B13C15_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').replace(/\bcreate or replace function\b/gi, 'create function').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const pFiles = () => files().filter((f) => /^\d{14}_payments__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const pSql = () => pFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'payments.sql') ? strip(readFileSync(polDir + 'payments.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C14)
function splitTop(body) {
  const out = []; let depth = 0, q = false, cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === "'") { if (body[i + 1] === "'") { cur += "'"; i++; } else q = false; } continue; }
    if (c === "'") { q = true; cur += c; continue; }
    if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth--;
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
  const cols = segs.filter((s) => !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|LIKE)\b/i.test(s));
  const likeSeg = segs.find((s) => /^LIKE\b/i.test(s));
  const added = [];
  for (const s of stmts(sql).map(ws)) {
    const a = new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${esc(name)}\\s+(ADD\\s+CONSTRAINT\\b[\\s\\S]*)$`, 'i').exec(s);
    if (a) for (const part of splitTop(a[1])) added.push(part.replace(/^ADD\s+/i, ''));
  }
  const allCons = [...cons, ...added];
  const nameOf = (c) => c.split(/\s+/)[0];
  return { like: likeSeg ?? null, cols, cons: allCons, colNames: cols.map(nameOf),
    colMap: new Map(cols.map((c) => [nameOf(c), norm(c)])), conMap: new Map(allCons.map((c) => [c.split(/\s+/)[1], norm(c)])) };
}
const idxName = (s) => /INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s)[1];
const createIndexes = (sql) => stmts(sql).filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s)).map(ws);
const createTriggers = (sql) => stmts(sql).filter((s) => /^CREATE\s+TRIGGER\b/i.test(s)).map(ws);
const trgName = (s) => /TRIGGER\s+(\w+)/i.exec(s)[1];
const isAudit = (s) => /app\.tg_row_audit\(/i.test(s);
function policies(sql) {
  return stmts(sql).filter((s) => /^CREATE\s+POLICY\s+(?!%)/i.test(ws(s))).map((s) => {
    const m = /^CREATE\s+POLICY\s+(\w+)\s+ON\s+([\w.]+)(?:\s+AS\s+(?:PERMISSIVE|RESTRICTIVE))?\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([\w, ]+?)\s+(?=USING|WITH)([\s\S]*)$/i.exec(ws(s));
    assert.ok(m, `parsable policy: ${ws(s).slice(0, 110)}`);
    const rest = m[5], wi = rest.search(/\bWITH\s+CHECK\b/i);
    const using = /^USING/i.test(rest) ? (wi < 0 ? rest : rest.slice(0, wi)).replace(/^\s*USING\s*/i, '').trim() : '';
    const check = wi < 0 ? '' : rest.slice(wi).replace(/^\s*WITH\s+CHECK\s*/i, '').trim();
    const unwrap = (x) => { x = x.trim(); if (x[0] === '(' && balanced(x, 1).length === x.length - 2) return x.slice(1, -1).trim(); return x; };
    return { name: m[1], table: m[2], key: `${m[1]}@${m[2]}`, cmd: m[3].toUpperCase(), roles: m[4].split(',').map((r) => r.trim()).sort().join(','), using: norm(unwrap(using)), check: norm(unwrap(check)), text: ws(s) };
  });
}
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
function insertRows(sql, table) {
  const rows = [];
  for (const s of stmts(sql).map(ws).filter((x) => new RegExp(`^INSERT\\s+INTO\\s+${esc(table)}\\b`, 'i').test(x))) {
    const m = new RegExp(`^INSERT\\s+INTO\\s+${esc(table)}\\s*\\(([^)]*)\\)\\s*VALUES\\s*([\\s\\S]*?)(?:\\s+ON\\s+CONFLICT[\\s\\S]*)?$`, 'i').exec(s);
    assert.ok(m, `seed INSERT INTO ${table} must name its columns and use VALUES: ${s.slice(0, 80)}`);
    const cols = m[1].split(',').map((c) => c.trim());
    for (const tup of splitTop(m[2])) {
      assert.match(tup, /^\(/, `tuple ${tup.slice(0, 40)}`);
      const vals = splitTop(balanced(tup, 1)); assert.equal(vals.length, cols.length, `${table}: tuple arity ${tup.slice(0, 60)}`);
      rows.push(Object.fromEntries(cols.map((c, i) => [c, vals[i]])));
    }
  }
  return rows;
}

// ---------------------------------------------------------------- spec extraction (C15 05-SCHEMA)
const specPath = repo + 'spec/chunks/C15-payment-gateways/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = b0 ? s.indexOf(b0, a + a0.length) : s.length; assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const S1 = '## 1. Tables', S2 = '## 2. Column specification', S3 = '## 3. RLS', S4 = '## 4. Indexes', S5 = '## 5. Coded sets', S6 = '## 6. DDL', S7 = '## 7. Published views', S8 = '## 8. Seeds', S9 = '## 9. Retention', S10 = '## 10. Tests';
const specDdl = () => strip(sqlBlocks(between(specRaw(), S6, S7)));
const specSec = (a, b) => between(specRaw(), a, b);

// ---- tables: the §6 DDL is the truth (12 CREATE TABLE = 1 G + 11 tenant; event_inbox is C0's); classes from §1 (hard-coded, sanity-checked against the spec rows)
const G_N = ['g_cs_reasons'];
const CLS = { settings: 'M', merchant_accounts: 'M', intents: 'C', intent_transitions: 'A', gateway_calls: 'A', callbacks: 'A', refunds: 'C', reconciliation_runs: 'C', reconciliation_findings: 'C', static_qr_reconciliations: 'C', cs_reasons: 'M' };
const T_N = Object.keys(CLS);
const G_T = G_N.map((t) => `payments.${t}`), TENANT = T_N.map((t) => `payments.${t}`), ALLT = [...G_T, ...TENANT];
const isG = (q) => /\.g_/.test(q);
const A_T = ['intent_transitions', 'gateway_calls', 'callbacks'];                                     // §3 table: SELECT, INSERT only
const UPD_T = T_N.filter((t) => !A_T.includes(t));                                                     // §3 table: SELECT, INSERT, UPDATE
const AUDIT_REQ = T_N.filter((t) => CLS[t] !== 'A').map((t) => `payments.${t}`);                         // §1 "Audited": every M and C table (8), A and G not
const FN_INV = ['payments.intents_transition_guard', 'payments.refunds_transition_guard'];            // SECURITY INVOKER trigger functions
const DEF_FN = 'app.payments_resolve_callback_token';                                                  // the one SECURITY DEFINER (CR-C15-004, P-41)
const TG_NAMES = ['intents__mutable_columns', 'intents__transition_guard', 'refunds__mutable_columns', 'refunds__transition_guard', 'reconciliation_findings__mutable_columns', 'static_qr__mutable_columns'];
const STAFF = /\(select app\.is_staff_or_system\(\)\)/;

// ---- independent policy shape (§3): tenant predicate + staff guard (P-16), no centre clause (A16.1 cast has no occurrence), no DELETE policy
const TEN = 'tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())';
function pol(t, cmd) {
  const c = cmd.toLowerCase();
  return `CREATE POLICY ${t}__${c}__tenant ON payments.${t} FOR ${cmd} TO lims_app ${cmd === 'INSERT' ? '' : `USING (${TEN}) `}${cmd === 'SELECT' ? '' : `WITH CHECK (${TEN})`}`;
}
const CMDS = (t) => (A_T.includes(t) ? ['SELECT', 'INSERT'] : ['SELECT', 'INSERT', 'UPDATE']);
const expectedPolicies = () => policies(T_N.flatMap((t) => CMDS(t).map((c) => pol(t, c))).join(';\n'));
const OWNER_POLICY = "CREATE POLICY intents__select__owner_only ON payments.intents FOR SELECT TO lims_owner USING (callback_token_sha256 = decode(current_setting('app.pre_payments_callback_token_sha256', true), 'hex'))";   // §3 P-41 (b); no other disjunct (m#14)
const EXPECTED_TENANT_POLICIES = 30;     // 8 x 3 + 3 x 2
const EXPECTED_POLICIES = 31;            // + the owner-only callback lookup policy

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 12 CREATE TABLE in §6 (1 G + 11 tenant; no event_inbox), no LIKE, 3 functions (2 INVOKER trigger guards + 1 DEFINER), 14 triggers (6 + 8 audit), 31 policies (30 tenant = independent §3 shape + 1 owner policy), 24 indexes, 55 coded-set rows in §5, no view (§7), §1 classes, §10 lists 14 tests', () => {
  const ddl = specDdl();
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 12, '12 CREATE TABLE in §6');
  assert.equal(G_N.length, 1); assert.equal(T_N.length, 11); assert.equal(ALLT.length, 12);
  assert.deepEqual([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].map((m) => m[1]).sort(), [...ALLT].sort(), '§1 payments (12 rows) = §6 tables');
  for (const q of ALLT) { const t = createTable(ddl, q); assert.ok(t, `spec has ${q}`); assert.equal(t.like, null, `${q}: no LIKE in the spec`); }
  assert.doesNotMatch(ddl, /CREATE\s+TABLE\s+payments\.event_inbox/i);
  assert.deepEqual(fnNames(ddl).sort(), [DEF_FN, ...FN_INV].sort(), 'the 3 functions of §6');
  assert.deepEqual([...ddl.matchAll(/CREATE\s+FUNCTION\s+([\w.]+)[^$]*?SECURITY\s+DEFINER/gi)].map((m) => m[1]), [DEF_FN], 'exactly one DEFINER (§10 tests 11-13)');
  assert.deepEqual(createTriggers(ddl).filter((s) => !isAudit(s)).map(trgName).sort(), [...TG_NAMES].sort(), '6 non-audit triggers in §6');
  assert.equal(createTriggers(ddl).filter(isAudit).length, 8, '8 audit triggers in §6 (every M and C table)');
  const lit = policies(ddl), exp = expectedPolicies();
  assert.equal(lit.length, EXPECTED_POLICIES, '31 policies written out in §6'); assert.equal(exp.length, EXPECTED_TENANT_POLICIES);
  for (const e of exp) { const l = lit.find((p) => p.key === e.key); assert.ok(l, `spec has ${e.key}`); assert.equal(l.cmd, e.cmd, e.key); assert.equal(l.roles, e.roles, e.key); assert.equal(l.using, e.using, `${e.key} USING`); assert.equal(l.check, e.check, `${e.key} WITH CHECK`); }
  const own = lit.filter((p) => !exp.some((e) => e.key === p.key)), ownExp = policies(OWNER_POLICY)[0];
  assert.equal(own.length, 1); assert.equal(own[0].key, ownExp.key); assert.equal(own[0].roles, 'lims_owner'); assert.equal(own[0].using, ownExp.using, 'P-41 (b): the owner policy text');
  assert.equal(createIndexes(ddl).length, 24, '24 CREATE INDEX in §6 (§4 lists the same)');
  assert.equal(codedSets().length, 55, '§5: 55 coded-set rows');
  assert.match(specSec(S7, S8), /None required by 03-IC for `payments`/, '§7: no published view'); assert.doesNotMatch(ddl, /CREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW/i);
  for (const [t, c] of Object.entries(CLS)) assert.match(specSec(S1, S2), new RegExp(`\\|\\s*\`payments\\.${t}\`\\s*\\|\\s*${c}\\b`), `§1 class of ${t} = ${c}`);
  assert.match(specSec(S1, S2), /\|\s*`payments\.g_cs_reasons`\s*\|\s*G\b/, '§1 class of g_cs_reasons = G');
  const refs = new Set([...ddl.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()).filter((x) => !x.startsWith('payments.')));
  assert.deepEqual([...refs].sort(), ['core.branches', 'core.collection_centres', 'core.tenants', 'frontdesk.orders'], 'cross-schema FK targets of §6 (core, frontdesk; no FK into billing, 02-CV §5.4)');
  assert.equal([...specSec(S10, undefined).matchAll(/^\d+\. /gm)].length, 14, '§10 lists 14 tests');
  assert.match(specSec(S1, S2), /No FK into `billing`/);
});

// ================================================================ files, order, owner (AC-0B-6.1 / 6.3)
const WAVE2 = /_(quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection|migration_staging)__/;
const BEFORE = /_(quality|micro|anatomic|inventory|partners|smartreport)__/;
test('migration files: >= 1 *_payments__*.sql, timestamps strictly after 20261114120000 (LD-202), after every wave-1 migration and after the quality, micro, anatomic, inventory, partners and smartreport migrations (DAG: ... smartreport -> payments, db/meta/dag.yaml), unique; db/policies/payments.sql exists; schema creation IF NOT EXISTS', () => {
  assert.ok(pFiles().length >= 1, 'no db/migrations/*_payments__*.sql yet (T0B-13.C15 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => !WAVE2.test(f)), before = all.filter((f) => BEFORE.test(f));
  assert.ok(earlier.length >= 24, 'wave-1 migrations present'); assert.ok(before.length >= 6, 'quality + micro + anatomic + inventory + partners + smartreport migrations present');
  for (const f of pFiles()) {
    assert.ok(f.slice(0, 14) > '20261114120000', `${f} must be later than 20261114120000`);
    for (const e of [...earlier, ...before]) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (payments follows smartreport in the DAG)`);
  }
  assert.ok(existsSync(polDir + 'payments.sql'), 'db/policies/payments.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(pSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)payments\b/i, 'schema payments exists since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every payments migration is SET LOCAL ROLE lims_owner and it is the only role switch (all objects incl. the 3 functions owned by lims_owner); no standing CREATE grant, no role DDL, no CREATE EXTENSION', () => {
  assert.ok(pFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+|SET\s+SESSION\s+AUTHORIZATION)/gi)].map((m) => ws(m[1]).toUpperCase());
  for (const f of pFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch`);
  }
  assert.doesNotMatch(pSql(), /GRANT\s+CREATE\s+ON\s+(SCHEMA\s+app|DATABASE)/i); assert.doesNotMatch(pSql(), /CREATE\s+ROLE|ALTER\s+ROLE/i); assert.doesNotMatch(pSql(), /CREATE\s+EXTENSION/i);
});

// ================================================================ tables (columns + constraints = spec exactly; C0 may add only a tenant FK and UNIQUE (tenant_id, id), C0 05-SCHEMA §9 rule 1)
for (const q of ALLT) {
  test(`${q}: every spec column + constraint (name + text) present identically in the migration; no extra column; only a tenant FK (<t>__tenant__fk) and UNIQUE (tenant_id, id) may be added; not created with LIKE (05-SCHEMA §6; C0 §9 rule 1)`, () => {
    const exp = createTable(specDdl(), q); assert.ok(exp, `spec table ${q}`);
    const sql = pSql(), got = createTable(sql, q), t = q.split('.')[1];
    assert.ok(got, `CREATE TABLE ${q} not found in *_payments__*.sql`);
    assert.equal(got.like, null, `${q}: LIKE is not used anywhere in this schema`);
    for (const [c, def] of exp.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    for (const c of got.colMap.keys()) assert.ok(exp.colMap.has(c), `${q}: extra column ${c} (the spec DDL is complete)`);
    for (const [c, def] of exp.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    for (const [c, def] of got.conMap) if (!exp.conMap.has(c)) {
      const body = def.replace(/^constraint\s+\w+\s+/, '');
      if (body === 'foreign key(tenant_id)references core.tenants(id)') assert.equal(c, `${t}__tenant__fk`, `${q}: added tenant FK name`);
      else { assert.match(body, /^unique\(tenant_id,id\)$/, `${q}: extra constraint ${c} (only the C0 tenant FK and UNIQUE (tenant_id, id) may be added)`); assert.ok(c.startsWith(`${t}__`), `${q}: ${c} prefixed ${t}__`); assert.ok(got.colMap.has('id') && got.colMap.has('tenant_id'), `${q}: UNIQUE (tenant_id, id) only on tables with an id`); }
    }
    const bodies = [...got.conMap.values()].map((d) => d.replace(/^constraint\s+\w+\s+/, ''));
    if (!isG(q)) assert.ok(bodies.includes('foreign key(tenant_id)references core.tenants(id)'), `${q}: tenant FK to core.tenants (C0 §9 rule 1)`);
    if (!isG(q) && t !== 'settings') assert.ok(bodies.includes('unique(tenant_id,id)'), `${q}: UNIQUE (tenant_id, id) (04 D8)`);
    if (t === 'settings') { assert.ok(!got.colMap.has('id'), 'settings omits id (§1 P-18(b))'); assert.ok(bodies.includes('primary key(tenant_id)')); assert.ok(!bodies.includes('unique(tenant_id,id)'), 'settings has no UNIQUE (tenant_id, id)'); }
  });
}
test('exactly the 12 §6 tables are created in payments (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9); table count == spec count; the CHECK value lists of §6 are present', () => {
  const sql = pSql(), bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.equal(made.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'migration CREATE TABLE count == spec CREATE TABLE count (impl note states both)');
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(bare, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /event_inbox/i, 'C15 migrations do not touch event_inbox (T0B-05 owns it; C15 consumes no events)');
  for (const q of TENANT) for (const c of ['id', 'tenant_id']) { const def = createTable(sql, q)?.colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`); }
  const sql2 = norm(sql);
  for (const v of ['esewa,khalti,fonepay', 'uat,production', 'created,initiated,pending,settled,failed,expired,held_for_review,refunded,partially_refunded', 'user,system', 'manual,api',
    'pending_approval,approved,rejected,requested,held_for_review,completed,failed', 'running,completed,failed', 'cron,manual', 'info,warning,critical', 'none,settled,held,ledger_repaired', 'open,resolved', 'matched,accepted_with_difference',
    'khalti_initiate,khalti_lookup,esewa_status,khalti_refund,credential_test', 'answer,service_unavailable,timeout,network_error,http_error,auth_error,not_found,invalid_response', 'esewa_success,esewa_failure,khalti_return,launch',
    'ok,payments.signature_invalid,payments.callback_mismatch,payments.callback_stale,rate_limited', 'reachable_key_valid,reachable_key_unverifiable,auth_failed,unreachable', 'esewa_status_check,khalti_lookup', 'refund_not_visible,refund_kind_mismatch,api_outcome_unknown',
    'create,callback,poll,verify_call,recheck,resolve,cancel,reconciliation,refund,sweep', 'hold_reasons,failure_reasons,cancel_reasons,resolution_reasons,refund_reasons,refund_reject_reasons,refund_fail_reasons,refund_hold_reasons,finding_kinds,finding_resolutions'])
    assert.ok(sql2.includes(v.split(',').map((x) => `'${x}'`).join(',')), `§6 value list ${v}`);
});
test('cross-schema references (01-CM §5 R3): payments -> payments / core / frontdesk only, identical target set to the spec; NO FK into billing, lab, reporting, catalog ... (CV §5.4: ledger_entry_id is a plain uuid); nothing in an upstream schema references payments (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(pSql()), exp = tgt(specDdl());
  for (const t of exp) got.has(t) || assert.fail(`FK target ${t} missing`);
  for (const t of [...got]) { assert.match(t, /^(payments|core|frontdesk)\./, `payments FK target ${t}`); exp.has(t) || assert.fail(`FK target ${t} is not in the spec`); }
  const upstream = files().filter((f) => !WAVE2.test(f) || BEFORE.test(f));
  assert.doesNotMatch(upstream.map(read).join('\n'), /\bREFERENCES\s+payments\./i, 'no FK into payments from an upstream schema');
  assert.doesNotMatch(pSql(), /\bREFERENCES\s+(billing|lab|reporting|identity|instruments|analytics|catalog|quality|micro|anatomic|inventory|partners|smartreport|engagement|homecollection)\./i, 'no FK into billing / lab / ... (02-CV §5.4)');
});
test('indexes: every §6 CREATE INDEX present with identical definition (24), no other index; every §4 index name exists; tenant_id leads every index and UNIQUE / PRIMARY KEY on the 11 tenant tables except PRIMARY KEY (id) and the one documented exception intents__callback_token_sha256__uq (CR-C15-004, with its tenant-leading companion); every __p_ index is partial', () => {
  const sql = pSql(), have = new Map(createIndexes(sql).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].filter((n) => !exp.some((s) => idxName(s) === n)), [], 'no index beyond the spec DDL (no trigram / extra index)');
  const conNames = new Set(ALLT.flatMap((q) => [...createTable(sql, q).conMap.keys()]));
  for (const n of new Set([...specSec(S4, S5).matchAll(/`([a-z][a-z_]*__[a-z0-9_]+__(?:p_uq|uq|idx|p_idx))`/g)].map((m) => m[1]))) assert.ok(have.has(n) || conNames.has(n), `§4 names ${n}: index or constraint exists`);
  for (const [n, s] of have) if (/__p_(uq|idx)$/.test(n)) assert.match(s, /\bwhere\b/, `${n} is a partial index`);
  assert.match(have.get('intents__tenant_id_order_id__open__p_uq'), /^create unique index .*\)where status in\('created','initiated','pending'\)$/, 'one open intent per order (REQ-SEC-053)');
  assert.match(have.get('refunds__tenant_id_intent_inflight__p_uq'), /^create unique index .*\)where status in\('pending_approval','approved','requested','held_for_review'\)$/, 'one refund in flight');
  assert.match(have.get('reconciliation_runs__tenant_id_running__p_uq'), /\(tenant_id\)where status='running'$/, 'one run at a time');
  assert.match(have.get('static_qr__tenant_id_date_centre__p_uq'), /where centre_id is not null$/); assert.match(have.get('static_qr__tenant_id_date_all__p_uq'), /where centre_id is null$/);
  for (const n of ['intents__tenant_id_idempotency_key__uq', 'refunds__tenant_id_idempotency_key__uq', 'intents__tenant_id_gateway_txn__p_uq', 'intents__callback_token_sha256__uq']) assert.match(have.get(n) ?? '', /^create unique index/, `${n} is unique`);
  assert.ok(have.has('intents__tenant_id_callback_token__idx'), 'the tenant-leading companion required by 03-IC §13.3');
  for (const s of createIndexes(sql)) {
    const lead = /\bON\s+\w+\.\w+\s*(?:USING\s+\w+\s*)?\(\s*([^,)]+)/i.exec(s)[1].trim();
    assert.equal(lead, idxName(s) === 'intents__callback_token_sha256__uq' ? 'callback_token_sha256' : 'tenant_id', `index ${idxName(s)} leads with ${idxName(s) === 'intents__callback_token_sha256__uq' ? 'callback_token_sha256 (documented exception)' : 'tenant_id'}`);
  }
  for (const q of TENANT) for (const c of [...createTable(sql, q).conMap.values()].filter((x) => /\b(primary key|unique)\(/.test(x))) {
    const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1]; if (/primary key/.test(c) && k === 'id') continue;
    assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${c}`);
  }
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A2.3, A17 P-16, A19 P-41)
test('ENABLE + FORCE ROW LEVEL SECURITY as literal statements (no DO block / format(): check-migrations.ts and the policy tools read statements) on the 11 tenant tables; none on g_cs_reasons; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = pSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of G_T) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(pSql(), /\bDO\s+\$/i, 'literal statements only'); assert.doesNotMatch(polSql(), /\bDO\s+\$/i);
  assert.doesNotMatch(pSql() + polSql(), /EXECUTE\s+format\s*\(/i);
});
const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('payments.') && !/\.event_inbox$/.test(p.table));
test('policies: db/policies/payments.sql holds EXACTLY the 31 policies of §6 (name, command, role, USING, WITH CHECK) = 30 tenant policies equal to the independent §3 shape + intents__select__owner_only (P-41 (b), the decode(current_setting(...)) text with no other disjunct, TO lims_owner); no policy on g_cs_reasons; only event_inbox may be extra; no dynamic SQL', () => {
  const spec = policies(specDdl()), got = gotPolicies(), exp = [...expectedPolicies(), ...policies(OWNER_POLICY)];
  assert.ok(got.length > 0, 'db/policies/payments.sql has no CREATE POLICY');
  const byKey = new Map(got.map((p) => [p.key, p])); assert.equal(byKey.size, got.length, 'no duplicate policy');
  for (const e of [...spec, ...exp]) {
    const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(g.using, e.using, `${e.key} USING`); assert.equal(g.check, e.check, `${e.key} WITH CHECK`);
  }
  assert.deepEqual([...byKey.keys()].sort(), spec.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access)');
  assert.equal(got.length, EXPECTED_POLICIES);
  for (const p of policies(polSql()).filter((x) => /\.event_inbox$/.test(x.table))) assert.match(p.name, /^event_inbox__(select|insert|delete)__(tenant|owner_only)$/, `${p.key}: only the C0 inbox shapes may appear`);
});
test('policy shape (§3, 08 A17 P-16): names <table>__<cmd>__tenant, all TO lims_app; every USING / WITH CHECK is exactly tenant_id = current_tenant_id AND is_staff_or_system (no centre clause, no actor-type list: §3); NO DELETE policy; the 3 class-A tables have no UPDATE policy; the only other policy is intents__select__owner_only TO lims_owner; no true / PUBLIC / anon; no policy on g_cs_reasons', () => {
  const ps = gotPolicies(), ten = ps.filter((p) => p.roles === 'lims_app'), own = ps.filter((p) => p.roles !== 'lims_app');
  assert.equal(ten.length, EXPECTED_TENANT_POLICIES, `tenant policies: ${ten.length}`);
  assert.deepEqual(own.map((p) => p.key), ['intents__select__owner_only@payments.intents'], 'the only non-lims_app policy is the P-41 owner policy');
  assert.equal(own[0].roles, 'lims_owner'); assert.equal(own[0].cmd, 'SELECT'); assert.equal(own[0].check, '');
  assert.doesNotMatch(own[0].using, /\bor\b|tenant_id=/, 'm#14: no other disjunct in the owner policy');
  assert.match(own[0].using, /^callback_token_sha256=decode\(current_setting\('app\.pre_payments_callback_token_sha256',true\),'hex'\)$/);
  for (const p of ten) {
    const tbl = p.table.split('.')[1], m = new RegExp(`^${tbl}__${p.cmd.toLowerCase()}__tenant$`).exec(p.name), t = p.using + ' ' + p.check;
    assert.ok(m, `${p.key}: name <table>__<cmd>__tenant`);
    assert.match(t, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: tenant predicate`); assert.match(t, STAFF, `${p.key}: P-16 staff guard`);
    assert.doesNotMatch(t, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|current_centre_ids|has_all_centres|current_partner_id|current_patient_id/, `${p.key}: tenant scope only`);
    assert.ok(!isG(p.table), `${p.key}: a G table carries no policy`);
  }
  assert.equal(ps.filter((p) => p.cmd === 'DELETE').length, 0, 'no DELETE policy on any payments table (money records, REQ-SEC-057 spirit)');
  for (const t of A_T) assert.deepEqual(ten.filter((p) => p.table === `payments.${t}`).map((p) => p.cmd).sort(), ['INSERT', 'SELECT'], `${t}: class A, select + insert only`);
  for (const t of UPD_T) assert.deepEqual(ten.filter((p) => p.table === `payments.${t}`).map((p) => p.cmd).sort(), ['INSERT', 'SELECT', 'UPDATE'], `${t}: select + insert + update`);
});
test('policies written literally in migrations are identical to db/policies/payments.sql (AC-0B-2.3 copy), including the owner policy', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(pSql()).filter((x) => x.table.startsWith('payments.') && !/\.event_inbox$/.test(x.table));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort(), 'every policy of the file is created by a migration and vice versa');
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §3 table + §6 GRANT statements parsed from the spec)
test('grants equal §6 / §3: lims_app SELECT+INSERT+UPDATE on the 8 mutable tables, SELECT+INSERT on intent_transitions / gateway_calls / callbacks, SELECT on g_cs_reasons; DELETE on NOTHING; no TRUNCATE / REFERENCES / TRIGGER; nothing to other roles; no view', () => {
  const sql = pSql() + '\n;\n' + polSql(), g = grantsOf(sql), exp = grantsOf(specDdl());
  const privs = (m, q, r) => [...(m.get(q)?.get(r)?.all ?? [])].sort();
  for (const t of T_N) assert.deepEqual(privs(g, `payments.${t}`, 'lims_app'), UPD_T.includes(t) ? ['INSERT', 'SELECT', 'UPDATE'] : ['INSERT', 'SELECT'], `payments.${t} lims_app`);
  for (const t of A_T) assert.ok(!privs(g, `payments.${t}`, 'lims_app').includes('UPDATE'), `payments.${t}: class A, no UPDATE grant (append-only)`);
  for (const q of G_T) assert.deepEqual(privs(g, q, 'lims_app'), ['SELECT'], `${q} lims_app`);
  for (const [q, rm] of exp) if (/^payments\./.test(q)) for (const r of rm.keys()) assert.deepEqual(privs(g, q, r), privs(exp, q, r), `${q} ${r}: grants = spec §6`);
  assert.deepEqual([...g.entries()].filter(([t, rm]) => /^payments\./.test(t) && [...rm.values()].some((p) => p.all.has('DELETE'))).map(([t]) => t), [], '§3: no DELETE grant on any payments table (C/A classes, money records)');
  for (const [t, rm] of g) if (/^payments\./.test(t)) {
    assert.ok(new Set(ALLT).has(t), `${t}: unexpected grant target`);
    for (const [r, p] of rm) {
      assert.equal(r, 'lims_app', `${t}: unexpected grantee ${r}`);
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL', 'DELETE']) assert.ok(!p.all.has(bad) && !p.cols.has(bad), `${t}: ${r} must not hold ${bad}`);
      assert.equal(p.cols.size, 0, `${t}: whole-table grants only (secret_* columns are protected by the service mappers, not by column grants)`);
    }
  }
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\bpayments\./i); assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+payments\b/i); assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bpayments\b/i);
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\bpayments\./i.test(s) && !/\bFUNCTION\b/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner|lims_analytics)\b/i, s);
  assert.doesNotMatch(strip(pSql()), /\bCREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\b/i, '§7: C15 publishes no view');
});

// ================================================================ functions + triggers (AC-0B-4.1; §6, §10 tests 3-5)
test('the 2 guard functions equal the spec text and are SECURITY INVOKER with search_path = \'\' (no inventory entry, 04 D7); SQLSTATE P0001 with messages immutable_row / invalid_transition (CV §5.7); the only other function is the DEFINER app.payments_resolve_callback_token (equal to the spec text, SECURITY DEFINER, search_path = \'\', plpgsql VOLATILE); no function beyond these 3', () => {
  const sql = pSql(), exp = specDdl();
  for (const f of FN_INV) {
    const got = fnText(sql, f); assert.ok(got, `${f} missing (05-SCHEMA §6)`);
    assert.equal(norm(got), norm(fnText(exp, f)), `${f}: text equals the spec`);
    assert.match(got, /SET\s+search_path\s*=\s*''/i, `${f}: search_path = ''`); assert.doesNotMatch(got, /SECURITY\s+DEFINER/i, `${f}: SECURITY INVOKER`);
    assert.match(got, /ERRCODE\s*=\s*'P0001'/); assert.match(got, /MESSAGE\s*=\s*'invalid_transition'/);
  }
  assert.match(fnText(sql, 'payments.intents_transition_guard'), /MESSAGE\s*=\s*'immutable_row'/, 'gateway_txn_ref / gateway_payment_url / expires_at change only from NULL');
  const d = fnText(sql, DEF_FN); assert.ok(d, `${DEF_FN} missing`);
  assert.equal(norm(d), norm(fnText(exp, DEF_FN)), 'DEFINER function text equals the spec');
  assert.match(d, /SECURITY\s+DEFINER/i); assert.match(d, /SET\s+search_path\s*=\s*''/i); assert.match(d, /octet_length\(p_token_sha256\)\s*<>\s*32/); assert.match(d, /interval\s+'30 days'/); assert.match(d, /set_config\('app\.pre_payments_callback_token_sha256',\s*'',\s*true\)/, 'GUC reset to empty before return (§10 test 13)');
  assert.deepEqual(fnNames(sql).sort(), [DEF_FN, ...FN_INV].sort(), 'no function beyond the spec');
  assert.equal([...sql.matchAll(/SECURITY\s+DEFINER/gi)].length, 1, 'one SECURITY DEFINER in the payments migrations');
  const st = stmts(sql).map(ws);
  assert.ok(st.some((s) => /^REVOKE\s+ALL\s+ON\s+FUNCTION\s+app\.payments_resolve_callback_token\(bytea\)\s+FROM\s+PUBLIC$/i.test(s)), 'REVOKE ALL ... FROM PUBLIC');
  assert.deepEqual(st.filter((s) => /^GRANT\b/i.test(s) && /payments_resolve_callback_token/i.test(s)).map(norm), [norm('GRANT EXECUTE ON FUNCTION app.payments_resolve_callback_token(bytea) TO lims_api')], 'EXECUTE for lims_api only (§3 (d))');
  for (const s of st.filter((x) => /^ALTER\s+FUNCTION\b/i.test(x))) assert.match(s, /^ALTER\s+FUNCTION\s+app\.payments_resolve_callback_token\(bytea\)\s+OWNER\s+TO\s+lims_owner$/i);
});
test('triggers: the 6 non-audit §6 triggers equal the spec statements (mutable_columns on intents / refunds / reconciliation_findings / static_qr, the two transition guards); the intents + refunds mutable-column lists equal the §2.1 "Immutable after insert, except" list and the refunds column set; nothing else besides the audit triggers; none disabled or dropped; app.enforce_mutable_columns is the C0 function', () => {
  const sql = pSql(), all = createTriggers(sql), trg = all.filter((s) => !isAudit(s)), exp = createTriggers(specDdl()).filter((s) => !isAudit(s));
  assert.equal(exp.length, 6);
  for (const s of exp) { const hit = trg.find((x) => trgName(x) === trgName(s)); assert.ok(hit, `trigger ${trgName(s)} missing`); assert.equal(norm(hit), norm(s), `trigger ${trgName(s)}`); }
  assert.deepEqual(trg.map(trgName).sort(), [...TG_NAMES].sort(), 'no trigger beyond the spec (audit aside)');
  assert.doesNotMatch(sql, /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(sql, /DROP\s+TRIGGER\b/i); assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+app\.(?!payments_resolve_callback_token\b)/i, 'app.* helpers are C0\'s');
  const except = /except: `([^`]+)`/.exec(specSec(S2, S3))[1].split(',').map((x) => x.trim()).sort(), args = (n) => [...trg.find((s) => trgName(s) === n).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.ok(except.length >= 25, `§2.1 except list: ${except.length}`); assert.deepEqual(args('intents__mutable_columns'), except, 'intents mutable columns = §2.1 "Immutable after insert, except"');
  for (const n of ['intents__mutable_columns', 'refunds__mutable_columns', 'reconciliation_findings__mutable_columns', 'static_qr__mutable_columns']) assert.match(trg.find((s) => trgName(s) === n), /BEFORE UPDATE ON payments\.\w+ FOR EACH ROW EXECUTE FUNCTION app\.enforce_mutable_columns\(/i, `${n}: BEFORE UPDATE FOR EACH ROW`);
  for (const n of ['intents__transition_guard', 'refunds__transition_guard']) assert.match(trg.find((s) => trgName(s) === n), /BEFORE UPDATE ON payments\.\w+ FOR EACH ROW EXECUTE FUNCTION payments\.\w+_transition_guard\(\)/i, `${n}: BEFORE UPDATE`);
  assert.ok(!args('refunds__mutable_columns').some((c) => ['amount_paisa', 'intent_id', 'order_id', 'centre_id', 'gateway', 'mode', 'idempotency_key', 'requested_by_membership_id', 'requested_at', 'reason_code', 'reason_text', 'tenant_id', 'id'].includes(c)), 'refund amount / intent / requester / reason stay immutable');
  assert.ok(!args('intents__mutable_columns').some((c) => ['amount_paisa', 'order_id', 'gateway', 'environment', 'merchant_account_id', 'idempotency_key', 'request_fingerprint', 'callback_token_sha256', 'currency', 'return_url', 'cancel_url', 'created_actor_type', 'tenant_id', 'id'].includes(c)), 'intent amount / order / gateway / token stay immutable');
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x; §1 "Audited"): <t>__audit AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW on the 8 class M / C tables, text equal to the spec; merchant_accounts excludes secret_ciphertext, secret_nonce, secret_auth_tag (CR-C15-013) and no other trigger passes arguments; none on the 3 class-A tables or g_cs_reasons', () => {
  const trg = createTriggers(pSql()).filter(isAudit), onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s)), spec = createTriggers(specDdl()).filter(isAudit);
  assert.equal(AUDIT_REQ.length, 8);
  for (const q of AUDIT_REQ) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(`, 'i'), q);
    assert.equal(norm(hit[0]), norm(spec.find((s) => trgName(s) === trgName(hit[0]))), `${q}: audit trigger text = spec`);
    const a = /tg_row_audit\(([^)]*)\)/i.exec(hit[0])[1].trim();
    if (q === 'payments.merchant_accounts') assert.equal(norm(a), "'secret_ciphertext','secret_nonce','secret_auth_tag'", 'CR-C15-013 excluded columns'); else assert.equal(a, '', `${q}: no audit arguments`);
  }
  for (const q of [...A_T.map((t) => `payments.${t}`), ...G_T]) assert.equal(onTable(q).length, 0, `${q} must NOT be audited`);
  assert.equal(trg.length, 8, 'no audit trigger beyond the 8');
});

// ================================================================ DEFINER inventory + owner policy (08 A12.1, A12.7, A19 P-41; CR-C15-004)
test('db/meta/definer-inventory.yaml: app.payments_resolve_callback_token row (owner lims_owner, execute [lims_api], why, touches payments.intents SELECT, policies names intents__select__owner_only which exists in db/policies/payments.sql, reviewer field); it is the only payments DEFINER row; the migrations create exactly this one DEFINER', () => {
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  const r = inv[DEF_FN]; assert.ok(r, `${DEF_FN} row (P-41 (d); 08 §4.7)`);
  assert.equal(r.owner, 'lims_owner'); assert.deepEqual(r.execute, ['lims_api']); assert.ok(String(r.why ?? '').length > 10, 'why');
  assert.match(JSON.stringify(r.touches), /payments\.intents SELECT/); assert.match(JSON.stringify(r.policies), /intents__select__owner_only/); assert.ok('reviewer' in r, 'reviewer field present (null until signed)');
  assert.ok(policies(polSql()).some((p) => p.name === 'intents__select__owner_only'), 'the inventory policy exists in db/policies/payments.sql');
  assert.deepEqual(Object.keys(inv).filter((k) => /^payments\./.test(k) || /payments/.test(k)), [DEF_FN], 'no other payments DEFINER row');
  for (const [k, e] of Object.entries(inv)) if (k !== DEF_FN) assert.doesNotMatch(JSON.stringify(e.touches ?? []), /payments\./, `${k}: no existing DEFINER touches payments`);
  assert.deepEqual([...pSql().matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)[^$]*?SECURITY\s+DEFINER/gi)].map((m) => m[1]), [DEF_FN]);
  assert.equal(policies(pSql()).filter((p) => /__owner_only$/.test(p.name)).length, 1, 'exactly one owner policy (A12.2: no purge / expiry DEFINER in v1, so none else)');
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const MAND = { M: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'is_active'], C: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version'], A: ['id', 'tenant_id', 'created_at', 'created_by'],
  E: ['id', 'tenant_id', 'created_at', 'expires_at'], G: ['id', 'created_at', 'is_active'] };
function phiRows() {   // §2.1: unambiguous column rows of payments.intents -> Map("intents.col" -> P-class); the name cell may list several columns (", ")
  const out = new Map();
  for (const l of specSec('### 2.1', '### 2.2').split('\n').filter((x) => x.startsWith('| '))) {
    const c = l.split('|').map((x) => x.trim()), phi = c[c.length - 2], m = /^(P[0-3])\b/.exec(phi ?? ''); if (!m) continue;
    for (const n of c[1].split(',').map((x) => x.trim())) if (/^[a-z][a-z0-9_]*$/.test(n)) out.set(`intents.${n}`, m[1]);
  }
  return out;
}
test('tables.yaml: all 12 payments tables registered (class per §1, centre_scoped false everywhere (no centre clause), audited = trigger, retention, NO shared_with (P-16), columns = the migration columns, phi_class P0..P1: no column holds P2/P3); the count equals the CREATE TABLE count; event_inbox entry untouched', () => {
  const y = tablesYaml(), regs = Object.keys(y).filter((k) => /^payments\./.test(k) && !/\.event_inbox$/.test(k));
  assert.equal(regs.length, 12, 'tables.yaml payments entries (ex event_inbox)'); assert.equal(regs.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'tables.yaml count == chunk DDL count');
  const trgAudited = (q) => createTriggers(pSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of ALLT) {
    const e = y[q], t = q.split('.')[1]; assert.ok(e && createTable(pSql(), q), `${q} in tables.yaml and migrations`);
    assert.equal(e.class, isG(q) ? 'G' : CLS[t], `${q} class (§1)`); assert.equal(e.centre_scoped, false, `${q} centre_scoped (no policy has a centre clause)`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`); assert.equal(e.audited, AUDIT_REQ.includes(q), `${q} audited (M and C tables only)`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), [...createTable(pSql(), q).colNames.map((c) => c.replace(/"/g, ''))].sort(), `${q} columns = migration columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[01]$/, `${q}.${c} phi_class: §2 "No column holds P2/P3 data"`);
    assert.deepEqual([...(e.shared_with ?? [])], [], `${q}: shared_with empty (§1 P-16: no payments table is shared with partner, portal or patient actors)`);
  }
  assert.ok(y['payments.event_inbox'].class === 'A', 'inbox entry remains as C0 wrote it');
});
test('tables.yaml phi_class (§2.1): every unambiguous column row of the intents table equals the registry value (id, order, amounts, refs P1; gateway / environment / status / currency / dates / reasons P0); the secret hash column is registered P0 or P1 (never P2/P3)', () => {
  const y = tablesYaml(), rows = phiRows(); assert.ok(rows.size >= 40, `parsed §2.1 phi rows: ${rows.size}`);
  for (const [k, p] of rows) { const [t, c] = k.split('.'); assert.equal(y[`payments.${t}`]?.columns?.[c], p, `${k}: phi_class = §2.1 (${p})`); }
  assert.match(y['payments.intents'].columns.callback_token_sha256, /^P[01]$/, 'callback_token_sha256 (Secret hash) is registered');
  for (const c of ['secret_ciphertext', 'secret_nonce', 'secret_auth_tag', 'secret_kek_id', 'secret_fingerprint']) assert.match(y['payments.merchant_accounts'].columns[c] ?? '', /^P[01]$/, `merchant_accounts.${c} registered`);
  for (const q of ALLT) for (const c of ['created_by', 'updated_by']) if (y[q].columns[c]) assert.equal(y[q].columns[c], 'P1', `${q}.${c}`);
  assert.match(specSec(S2, S3), /No column holds P2\/P3 data/);
});
test('tables.yaml: rls_exempt only on g_cs_reasons (with a reason); mandatory_column_exceptions = exactly the class-mandatory columns the DDL lacks (settings: id, §1 P-18(b), with a reason; every other table: none) ; each omitted column is absent from the DDL; every other table carries all of them', () => {
  const y = tablesYaml();
  for (const q of ALLT) {
    assert.ok(y[q] && createTable(pSql(), q), `${q} in tables.yaml and in the migrations`);
    const e = y[q], cls = isG(q) ? 'G' : CLS[q.split('.')[1]], cols = new Set(createTable(pSql(), q).colNames);
    if (isG(q)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    const missing = MAND[cls].filter((c) => !cols.has(c)).sort(), got = [...(e.mandatory_column_exceptions ?? [])].sort();
    assert.deepEqual(got, missing, `${q}: mandatory_column_exceptions must list exactly the missing class-${cls} columns`);
    assert.deepEqual(got, q === 'payments.settings' ? ['id'] : [], `${q}: exceptions per §1`);
    if (got.length) assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 5, `${q}: mandatory_column_exceptions_reason`);
    for (const c of got) assert.ok(!cols.has(c), `${q}: omitted column ${c} must really be absent`);
    assert.equal(isG(q), !cols.has('tenant_id'));
  }
});
test('tables.yaml retention (§9): intents, intent_transitions, refunds, reconciliation_runs / findings, static_qr_reconciliations, gateway_calls, callbacks >= 5 years (tenant retentionYears, no purge in v1); merchant_accounts while the tenant is active (secret columns overwritten on replacement, no secret in audit_log); settings / cs_reasons / g_cs_reasons carry a retention text; event_inbox 90 days', () => {
  const y = tablesYaml(), r = (q) => { const e = y[`payments.${q}`]; assert.ok(e, `payments.${q} in tables.yaml`); return e.retention; };
  assert.match(specSec(S9, S10), /5 years/);
  for (const q of ['intents', 'intent_transitions', 'refunds', 'reconciliation_runs', 'reconciliation_findings', 'static_qr_reconciliations', 'gateway_calls', 'callbacks']) assert.match(r(q), /5 y|years|retentionYears|retention/i, q);
  assert.match(r('merchant_accounts'), /tenant active|while|secret/i, 'merchant_accounts');
  for (const q of ['settings', 'cs_reasons', 'g_cs_reasons']) assert.ok(String(r(q)).length > 3, `${q} retention text`);
  assert.match(y['payments.event_inbox'].retention, /90 days/);
});
test('db/tests/rls_exempt.txt lists exactly payments.g_cs_reasons with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^payments\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), [...G_T].sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ seeds (§5, §8: the 55 coded-set rows; no settings, no merchant secret, nothing else)
function codedSets() {   // §5 table -> ["set|code|requires_text"]
  const out = [];
  for (const l of specSec(S5, S6).split('\n').filter((x) => /^\| `[a-z_]+` \|/.test(x))) {
    const c = l.split('|').map((x) => x.trim()), set = c[1].replace(/`/g, ''), cell = c[2].split(/ — /)[0];
    for (const tok of cell.split(', ')) { const m = /^([a-z0-9_]+)( \(requires_text\))?$/.exec(tok.trim()); assert.ok(m, `§5 token "${tok}" of ${set}`); out.push(`${set}|${m[1]}|${!!m[2]}`); }
  }
  return out;
}
const lit = (v) => /^'(.*)'$/.exec(v)?.[1];
test('seed rows: payments.g_cs_reasons holds the 55 §5 rows (set_name, code, requires_text true exactly for the "(requires_text)" codes; display 1..120 chars; ids present and distinct; column list named, VALUES form); every set_name of the table CHECK is seeded; NOTHING else is inserted (no settings row, no merchant account, no secret, no tenant data: §8, REQ-SEC-136)', () => {
  const sql = pSql(), rows = insertRows(sql, 'payments.g_cs_reasons');
  assert.equal(rows.length, 55, 'g_cs_reasons: 55 seed rows');
  for (const k of ['id', 'set_name', 'code', 'display']) assert.ok(k in rows[0], `seed column list names ${k}`);
  assert.deepEqual(rows.map((r) => `${lit(r.set_name)}|${lit(r.code)}|${r.requires_text === undefined ? false : r.requires_text.toLowerCase() === 'true'}`).sort(), codedSets().sort(), 'seed = §5 (set, code, requires_text)');
  for (const r of rows) { const d = lit(r.display); assert.ok(d !== undefined && d.length >= 1 && d.length <= 120, `display of ${r.code}: 1..120 chars`); assert.ok(r.id && !/^null$/i.test(r.id), `id of ${r.code}`); assert.match(lit(r.code), /^[a-z0-9_]{1,64}$/); }
  const ids = rows.map((r) => r.id).filter((x) => /^'/.test(x)); assert.equal(new Set(ids).size, ids.length, 'literal seed ids are distinct');
  assert.deepEqual([...new Set(rows.map((r) => lit(r.set_name)))].sort(), ['cancel_reasons', 'failure_reasons', 'finding_kinds', 'finding_resolutions', 'hold_reasons', 'refund_fail_reasons', 'refund_hold_reasons', 'refund_reasons', 'refund_reject_reasons', 'resolution_reasons'], '10 sets');
  const tables = [...new Set(stmts(sql).map(ws).filter((s) => /^INSERT\s+INTO\b/i.test(s)).map((s) => /INTO\s+(\S+)/i.exec(s)[1]))].sort();
  assert.deepEqual(tables, ['payments.g_cs_reasons'], 'no other INSERT in the payments migrations (settings rows are created lazily, P-22)');
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+payments\.(settings|merchant_accounts|cs_reasons)\b/i);
});

// ================================================================ views: none (§7; IC §6)
test('no published view: IC §6 defines no payments.v_pub_* view and C15 publishes none (§7) - the migrations create no view / materialized view and no view grant exists; the view column contract test is therefore vacuous', () => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8');
  assert.doesNotMatch(ic, /\bpayments\.v_pub_/, 'IC lists a payments.v_pub_* view: this test (and the C15 DDL) must then add its column contract');
  assert.doesNotMatch(strip(pSql()) + polSql(), /\bCREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+|TEMP(?:ORARY)?\s+)?VIEW\b/i); assert.doesNotMatch(pSql() + polSql(), /\bv_pub_/i);
  assert.match(specSec(S7, S8), /None required by 03-IC for `payments`/);
});

// ================================================================ hygiene
test('C15 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of other schemas\' tables, no USING (true), no GRANT to PUBLIC; no Storage SQL; the only app.* object created is app.payments_resolve_callback_token; no policy admits a non-staff actor (P-16)', () => {
  const raw = pFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 20000, 'C15 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i); assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics|quality|micro|anatomic|inventory|partners|smartreport|app)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016'); assert.doesNotMatch(strip(raw), /\bTO\s+PUBLIC\b/i);
  assert.doesNotMatch(strip(raw) + polSql(), /\bstorage\.(objects|buckets)\b/i, 'no Storage SQL');
  assert.doesNotMatch(polSql() + strip(raw), /current_actor_type\(\)\)\s*(=|IN\s*\()[^)]*'(device|patient|portal|partner)'/i, 'no policy names a non-staff actor');
  assert.doesNotMatch(strip(raw), /\b(Test Patient|SYN-)/, 'no fixtures in migrations');
  assert.deepEqual([...strip(raw).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TABLE|TRIGGER|INDEX|UNIQUE INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?app\./gi)].length, 1, 'only app.payments_resolve_callback_token is created in schema app');
});
test('LD-202 scope: no wave-1 migration, db/bootstrap, spec, service or app file is changed by this task (only payments files + policies + meta + tests are new / edited)', () => {
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', 'db/migrations', 'db/bootstrap', 'spec', 'services', 'apps'], { cwd: repo, encoding: 'utf8' });
  const changed = r.stdout.split('\n').filter(Boolean).filter((f) => !/^db\/migrations\/\d{14}_payments__/.test(f));
  assert.deepEqual(changed, [], 'tracked files outside the payments migrations were modified');
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts and check-fk-dag.ts exit 0 on the tree; check-migrations.ts exits 0 OR its ONLY violation is the pre-existing C13 one ("partners.manifest_lines: GRANT DELETE to lims_app on a class C table is forbidden", blocking CR .orchestra/cr/T0B-13.C13-manifest-lines-delete.md) - never a line about payments (a gate/spec conflict for C15 is a blocking CR, not a tolerated line)', () => {
  assert.ok(pFiles().length >= 1, 'C15 migrations missing');
  for (const t of ['check-registry.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
  const m = tool('check-migrations.ts');
  if (m.code !== 0) {
    const bad = m.out.split('\n').filter((l) => /^check-migrations: /.test(l) && !/check-migrations: ok/.test(l));
    assert.ok(bad.length > 0 && bad.every((l) => /_partners__create_partners_schema\.sql: partners\.manifest_lines: GRANT DELETE to lims_app on a class C table is forbidden/.test(l)), `check-migrations (only the pre-existing C13 violation is tolerated):\n${m.out}`);
    assert.doesNotMatch(m.out, /payments/i, 'no check-migrations violation may mention payments');
    assert.ok(existsSync(root + '.orchestra/cr/T0B-13.C13-manifest-lines-delete.md'), 'the C13 blocking CR documents the tolerated violation');
  }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 11 tenant C15 tables, none for the class G table, and gen-isolation-probes --check is clean; _registry.sql lists all 12', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const q of G_T) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/payments/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-13\.C15_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/payments/T0B-13.C15_*.test.sql exist (tester-owned: writer must keep them) and cover the AC list by "AC-0B-x.y" markers, the catalogue checks by "-- C15 check N" markers (1-8) and the 14 spec §10 tests by "-- C15 test N" markers; RLS never disabled; replica mode (if used) reset to origin', () => {
  assert.ok(tapFiles().length >= 2, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 8; n++) assert.match(txt, new RegExp(`-- C15 check ${n}\\b`), `marker for C15 check ${n}`);
  for (let n = 1; n <= 14; n++) assert.match(txt, new RegExp(`-- C15 test ${n}\\b`), `marker for 05-SCHEMA §10 test ${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.1', '6.2', '6.3']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
    const rep = [...s.matchAll(/session_replication_role\s*=\s*replica/gi)].length, org = [...s.matchAll(/session_replication_role\s*=\s*origin/gi)].length;
    assert.ok(rep === 0 || (org >= rep && s.lastIndexOf('= origin') > s.lastIndexOf('= replica')), `${f}: every replica fixture block is reset to origin before assertions`);
  }
});
