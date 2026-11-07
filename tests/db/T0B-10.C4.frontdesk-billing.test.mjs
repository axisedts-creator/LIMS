// T0B-10.C4 static checks of the Wave-1 frontdesk + billing DDL translation: db/migrations/*_frontdesk__*.sql, *_billing__*.sql, db/policies/{frontdesk,billing}.sql,
// db/meta/tables.yaml, definer-inventory.yaml, v_pub_* views.
// Spec: C4 05-SCHEMA §0-§9 (§3/§4 DDL, §4a RLS+grants, §5 immutability, §6 views, §9 tests); IC §6.1/§6.2; C0 05-SCHEMA §3.8/§10; 08 A10.5, A13 P-7/D-27a, A16.1, A17 P-16/P-18;
// AC-0B-2.1..2.4, 3.6 (probes), 4.1..4.3, 5.x (audit triggers), 6.1..6.4 (static part: order, role switch, FK direction, billing self-contained).
// Run: node --test tests/db/T0B-10.C4.frontdesk-billing.test.mjs   (live: db/tests/frontdesk_billing/T0B-10.C4_*.test.sql via pg_prove; generated probes: db/tests/isolation/{frontdesk,billing}.*.test.sql)
// Method (as T0B-10.C2/C3): the expected DDL is PARSED FROM C4 05-SCHEMA at test time and compared (whitespace/case-normalised) with the migrations, so a drifting column,
// constraint, index, trigger, function body, policy, grant or view fails here. T0B10C4_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B10C4_ROOT ? resolve(process.env.T0B10C4_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const fdFiles = () => files().filter((f) => /^\d{14}_frontdesk__[a-z0-9_]+\.sql$/.test(f));
const blFiles = () => files().filter((f) => /^\d{14}_billing__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const allSql = () => files().map(read).join('\n;\n');
const fdSql = () => fdFiles().map(read).join('\n;\n');
const blSql = () => blFiles().map(read).join('\n;\n');
const c4Sql = () => fdSql() + '\n;\n' + blSql();
const polSql = (schema) => (existsSync(polDir + schema + '.sql') ? strip(readFileSync(polDir + schema + '.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2 / C3)
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
function createTable(sql, name) {
  const m = new RegExp(`CREATE\\s+(UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name.replace('.', '\\.')}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  const segs = splitTop(balanced(sql, m.index + m[0].length));
  const cons = segs.filter((s) => /^CONSTRAINT\b/i.test(s));
  const cols = segs.filter((s) => !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(s));
  const added = stmts(sql).filter((s) => new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${name.replace('.', '\\.')}\\s+ADD\\s+CONSTRAINT\\b`, 'i').test(ws(s)))
    .map((s) => ws(s).replace(new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${name.replace('.', '\\.')}\\s+ADD\\s+`, 'i'), ''));
  const allCons = [...cons, ...added];
  return {
    cols, cons: allCons, colNames: cols.map((c) => c.split(/\s+/)[0]),
    colMap: new Map(cols.map((c) => [c.split(/\s+/)[0], norm(c)])),
    conMap: new Map(allCons.map((c) => [c.split(/\s+/)[1], norm(c)])),
  };
}
const idxName = (s) => /INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s)[1];
const createIndexes = (sql) => stmts(sql).filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s)).map(ws);
const createTriggers = (sql) => stmts(sql).filter((s) => /^CREATE\s+TRIGGER\b/i.test(s)).map(ws);
const trgName = (s) => /TRIGGER\s+(\w+)/i.exec(s)[1];
function policies(sql) {
  return stmts(sql).filter((s) => /^CREATE\s+POLICY\s+(?!%)/i.test(s)).map((s) => {
    const m = /^CREATE\s+POLICY\s+(\w+)\s+ON\s+([\w.]+)\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([\w, ]+?)\s+(?=USING|WITH)([\s\S]*)$/i.exec(ws(s));
    assert.ok(m, `parsable policy: ${ws(s).slice(0, 110)}`);
    const rest = m[5], wi = rest.search(/\bWITH\s+CHECK\b/i);
    const using = /^USING/i.test(rest) ? (wi < 0 ? rest : rest.slice(0, wi)).replace(/^\s*USING\s*/i, '').trim() : '';
    const check = wi < 0 ? '' : rest.slice(wi).replace(/^\s*WITH\s+CHECK\s*/i, '').trim();
    const unwrap = (x) => { x = x.trim(); if (x[0] === '(' && balanced(x, 1).length === x.length - 2) return x.slice(1, -1).trim(); return x; };
    return { name: m[1], table: m[2], key: `${m[1]}@${m[2]}`, cmd: m[3].toUpperCase(), roles: m[4].split(',').map((r) => r.trim()).sort().join(','), using: norm(unwrap(using)), check: norm(unwrap(check)), text: ws(s) };
  });
}
function tableGrants(sql) {          // Map "schema.table" -> Map role -> Set(priv); whole-table grants only
  const g = new Map();
  for (const s of stmts(sql)) {
    const m = /^GRANT\s+([A-Z, ]+?)\s+ON\s+(?:TABLE\s+)?([\w., ]+?)\s+TO\s+([\w, ]+?)(\s+WITH\s+GRANT\s+OPTION)?$/i.exec(ws(s));
    if (!m || /\bFUNCTION\b|\bSCHEMA\b|\bSEQUENCE\b/i.test(s)) continue;
    if (/^(EXECUTE|USAGE|CREATE)$/i.test(m[1].trim())) continue;
    for (const t of m[2].split(',').map((x) => x.trim())) for (const r of m[3].split(',').map((x) => x.trim())) {
      if (!g.has(t)) g.set(t, new Map());
      const rm = g.get(t); if (!rm.has(r)) rm.set(r, new Set());
      for (const p of m[1].split(',').map((x) => x.trim().toUpperCase())) rm.get(r).add(p);
    }
  }
  return g;
}
function fnText(sql, qname) {
  const m = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${qname.replace('.', '\\.')}\\s*\\(`, 'i').exec(sql);
  if (!m) return null;
  const open = /AS\s+(\$\w*\$)/i.exec(sql.slice(m.index));
  if (!open) return null;
  const bodyStart = m.index + open.index + open[0].length;
  const end = sql.indexOf(open[1], bodyStart);
  return end < 0 ? null : sql.slice(m.index, end + open[1].length);
}

// ---------------------------------------------------------------- spec extraction (C4 05-SCHEMA)
const specPath = repo + 'spec/chunks/C4-frontdesk-billing/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = s.indexOf(b0, a + a0.length); assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const S3 = '## 3. DDL — schema `frontdesk`', S4 = '## 4. DDL — schema `billing`', S4A = '## 4a. RLS, policies and grants', S5 = '## 5. Immutability and grants summary', S6 = '## 6. Published views', S7 = '## 7. Coded sets';
const rawFd = () => sqlBlocks(between(specRaw(), S3, S4));
const rawBl = () => sqlBlocks(between(specRaw(), S4, S4A));
const specFd = () => strip(rawFd());
const specBl = () => strip(rawBl());
const specPol = () => strip(sqlBlocks(between(specRaw(), S4A, S5)));   // §4a literal RLS + grants
const specView = () => strip(sqlBlocks(between(specRaw(), S6, S7)));
const specDdl = () => specFd() + '\n;\n' + specBl();

const FD = ['settings', 'number_counters', 'patients', 'patient_consents', 'orders', 'order_items', 'discount_approvals', 'discounts', 'trf_attachments', 'order_flags', 'booking_links', 'g_cs_reasons', 'cs_reasons'];
const BL = ['settings', 'fiscal_counters', 'invoices', 'invoice_lines', 'credit_notes', 'credit_note_lines', 'cash_sessions', 'ledger_entries', 'order_balances', 'release_overrides', 'credit_accounts', 'credit_charges',
  'credit_note_tasks', 'finance_review_items', 'refund_requests', 'payment_intent_refs', 'print_log', 'activity_log', 'cbms_submissions', 'export_jobs', 'g_cs_payment_methods', 'cs_payment_methods', 'g_cs_reasons', 'cs_reasons'];
const ALLT = [...FD.map((t) => `frontdesk.${t}`), ...BL.map((t) => `billing.${t}`)];          // 37 tables (event_inbox tables already exist from T0B-05)
const isG = (q) => /\.g_/.test(q);
const TENANT = ALLT.filter((q) => !isG(q));                                                    // 34 tenant tables
const GTAB = ALLT.filter(isG);                                                                 // 3 class G
const UPDATE_FREE = ['billing.invoice_lines', 'billing.credit_note_lines', 'billing.ledger_entries', 'billing.print_log', 'billing.activity_log', 'billing.cbms_submissions', 'billing.release_overrides',
  'billing.payment_intent_refs', 'frontdesk.patient_consents'];                                // §9 test 4 / §5
const NOT_AUDITED = ['frontdesk.patient_consents', 'billing.release_overrides', 'billing.payment_intent_refs', 'billing.print_log', 'billing.activity_log', 'billing.cbms_submissions'];   // class A (§0.6)
const AUDIT_EITHER = ['billing.ledger_entries', 'billing.order_balances', 'frontdesk.number_counters', 'billing.export_jobs'];   // §0.6 vs §1 wording ambiguous (A+B, projection, counter, E): trigger and registry must agree
const AUDITED_MUST = TENANT.filter((q) => !NOT_AUDITED.includes(q) && !AUDIT_EITHER.includes(q));
const CLS = {
  'frontdesk.settings': ['M'], 'frontdesk.number_counters': ['M'], 'frontdesk.patients': ['M'], 'frontdesk.patient_consents': ['A'], 'frontdesk.orders': ['C'], 'frontdesk.order_items': ['C'],
  'frontdesk.discounts': ['C'], 'frontdesk.discount_approvals': ['C'], 'frontdesk.trf_attachments': ['C', 'E'], 'frontdesk.order_flags': ['C'], 'frontdesk.booking_links': ['M'], 'frontdesk.cs_reasons': ['M'],
  'frontdesk.g_cs_reasons': ['G'], 'billing.settings': ['M'], 'billing.fiscal_counters': ['B'], 'billing.invoices': ['B'], 'billing.invoice_lines': ['B'], 'billing.credit_notes': ['B'], 'billing.credit_note_lines': ['B'],
  'billing.ledger_entries': ['A', 'B'], 'billing.cash_sessions': ['B'], 'billing.order_balances': ['M', 'C', 'B', 'E'], 'billing.release_overrides': ['A'], 'billing.credit_accounts': ['M'], 'billing.credit_charges': ['B'],
  'billing.credit_note_tasks': ['C'], 'billing.finance_review_items': ['C'], 'billing.refund_requests': ['C'], 'billing.payment_intent_refs': ['A'], 'billing.print_log': ['A'], 'billing.activity_log': ['A'],
  'billing.cbms_submissions': ['A'], 'billing.export_jobs': ['E'], 'billing.cs_payment_methods': ['M'], 'billing.cs_reasons': ['M'], 'billing.g_cs_payment_methods': ['G'], 'billing.g_cs_reasons': ['G'],
};
const FN_FD = ['orders_lifecycle_guard', 'order_items_lifecycle_guard', 'discount_approvals_lifecycle_guard', 'trf_attachments_lifecycle_guard', 'purge_trf_drafts'];
const FN_BL = ['fiscal_counters_guard', 'invoices_lifecycle_guard', 'invoices_chronology_guard', 'credit_notes_chronology_guard', 'credit_note_lines_guard', 'cash_sessions_lifecycle_guard', 'ledger_reversal_guard',
  'order_balances_guard', 'credit_charges_lifecycle_guard', 'refund_requests_guard'];
const FNS = [...FN_FD.map((f) => `frontdesk.${f}`), ...FN_BL.map((f) => `billing.${f}`)];
const FD_VIEWS = ['v_pub_order_daily', 'v_pub_referrer_volume', 'v_pub_centre_volume', 'v_pub_order_status'];
const BL_VIEWS = ['v_pub_invoice_daily', 'v_pub_department_income', 'v_pub_payment_collection', 'v_pub_referrer_billing', 'v_pub_credit_party_statement', 'v_pub_order_balance'];
const VIEWS = [...FD_VIEWS.map((v) => `frontdesk.${v}`), ...BL_VIEWS.map((v) => `billing.${v}`)];
const PATIENT_AUDIT = /CREATE TRIGGER patients__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk\.patients FOR EACH ROW EXECUTE FUNCTION app\.tg_row_audit\('full_name', ?'name_search', ?'birth_on', ?'phone_e164', ?'email', ?'address_text'\)/i;

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 13 frontdesk + 24 billing tables, 15 functions, view/policy/grant extraction, no event_inbox DDL in C4 (C0 owns it)', () => {
  const ddl = specDdl();
  for (const q of ALLT) assert.ok(createTable(ddl, q), `spec has ${q}`);
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 37, '37 CREATE TABLE in §3/§4');
  assert.equal(ALLT.length, 37); assert.equal(TENANT.length, 34); assert.equal(GTAB.length, 3);
  assert.doesNotMatch(ddl, /CREATE\s+TABLE\s+\w+\.event_inbox/i);
  for (const f of FNS) assert.ok(fnText(ddl, f), `spec function ${f}`);
  assert.equal([...ddl.matchAll(/CREATE\s+FUNCTION\s+([\w.]+)/gi)].length, FNS.length, 'only those 15 functions');
  assert.equal([...specView().matchAll(/CREATE\s+VIEW\s+([\w.]+)/gi)].map((m) => m[1]).join(), VIEWS.join());
  const ps = policies(specPol() + '\n;\n' + specFd());
  assert.equal(ps.filter((p) => /__owner_only$/.test(p.name)).length, 2, 'two trf_attachments owner policies in §3');
  assert.ok(ps.length >= 34 * 3 - 20, `policies parsed from §4a: ${ps.length}`);
  assert.ok(createIndexes(ddl).length >= 50, `indexes: ${createIndexes(ddl).length}`);
  const refs = new Set([...ddl.matchAll(/REFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase().split('.')[0]));
  assert.deepEqual([...refs].sort(), ['billing', 'core', 'frontdesk'], 'spec FK target schemas');
  const bl2fd = [...specBl().matchAll(/REFERENCES\s+frontdesk\./gi)];
  assert.equal(bl2fd.length, 0, 'spec: no FK from billing to frontdesk (§0.5)');
});

// ================================================================ files, order, owner switch (AC-0B-6.1 / 6.3)
test('migration files: >= 1 *_frontdesk__*.sql and >= 1 *_billing__*.sql, unique timestamps, after the catalog migration (stage order), db/policies/{frontdesk,billing}.sql exist', () => {
  assert.ok(fdFiles().length >= 1, 'no db/migrations/*_frontdesk__*.sql yet (T0B-10.C4 writer creates them)');
  assert.ok(blFiles().length >= 1, 'no db/migrations/*_billing__*.sql yet (T0B-10.C4 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const catStamp = all.find((f) => /catalog__/.test(f))?.slice(0, 14), inboxStamp = all.find((f) => /core__create_event_inboxes/.test(f))?.slice(0, 14);
  assert.ok(catStamp && inboxStamp, 'catalog and event_inboxes migrations present');
  for (const f of [...fdFiles(), ...blFiles()]) {
    assert.ok(f.slice(0, 14) > catStamp, `${f} must sort after the catalog migration (02-TRD §4.2 stage order)`);
    assert.ok(f.slice(0, 14) > inboxStamp, `${f} must sort after core event_inboxes`);
  }
  assert.ok(existsSync(polDir + 'frontdesk.sql'), 'db/policies/frontdesk.sql missing (AC-0B-2.3)');
  assert.ok(existsSync(polDir + 'billing.sql'), 'db/policies/billing.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(c4Sql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)(frontdesk|billing)\b/i, 'schemas exist since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every frontdesk/billing migration is the owner role switch SET LOCAL ROLE lims_owner', () => {
  assert.ok(fdFiles().length + blFiles().length >= 2, 'migrations missing');
  for (const f of [...fdFiles(), ...blFiles()]) {
    const first = stmts(read(f))[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.doesNotMatch(readFileSync(migDir + f, 'utf8'), /\bRESET\s+ROLE\b|\bSET\s+(SESSION\s+)?ROLE\b|SET\s+LOCAL\s+ROLE\s+(?!lims_owner)/i, `${f}: no later role switch`);
  }
});

// ================================================================ tables (columns + constraints = spec)
for (const q of ALLT) {
  test(`${q}: columns, constraints (names + text) equal 05-SCHEMA §3/§4`, () => {
    const exp = createTable(specDdl(), q); assert.ok(exp, `spec table ${q}`);
    const got = createTable(q.startsWith('frontdesk.') ? fdSql() : blSql(), q);
    assert.ok(got, `CREATE TABLE ${q} not found in *_${q.split('.')[0]}__*.sql (a table belongs to its own schema's migrations)`);
    for (const [c, def] of exp.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    assert.deepEqual([...got.colMap.keys()].sort(), [...exp.colMap.keys()].sort(), `${q} column set`);
    for (const [c, def] of exp.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    assert.deepEqual([...got.conMap.keys()].sort(), [...exp.conMap.keys()].sort(), `${q} constraint set (no extra, no missing)`);
  });
}
test('exactly the 37 §1 tables are created in frontdesk/billing (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity (§0.2); no DEFAULT on id / tenant_id (04 D9)', () => {
  const sql = c4Sql();
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:frontdesk|billing)\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (§0.3)');
  assert.doesNotMatch(sql, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i, 'no SEQUENCE objects in frontdesk / billing (§0.2, §9 test 1)');
  assert.doesNotMatch(sql, /event_inbox/i, 'C4 migrations do not touch event_inbox (T0B-05 owns it)');
  assert.doesNotMatch(sql, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?!frontdesk\.|billing\.)\w+\./i, 'C4 migrations create only frontdesk.* / billing.* tables');
  for (const q of TENANT) for (const c of ['id', 'tenant_id']) {
    const def = createTable(q.startsWith('frontdesk.') ? fdSql() : blSql(), q)?.colMap.get(c);
    if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`);
  }
});
test('cross-schema references (§0.5, 01-CM §5 R3): frontdesk -> frontdesk/core only; billing -> billing/core only; NO FK billing -> frontdesk; nothing outside billing references billing (AC-0B-6.2/6.4 relocatability)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/REFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  for (const t of tgt(fdSql())) assert.ok(/^frontdesk\./.test(t) || /^core\.(tenants|branches|collection_centres|memberships|users)$/.test(t), `frontdesk FK target ${t}`);
  for (const t of tgt(blSql())) { assert.ok(/^billing\./.test(t) || /^core\.(tenants|branches|collection_centres|memberships|users)$/.test(t), `billing FK target ${t}`); assert.doesNotMatch(t, /^frontdesk\./, 'billing must not reference frontdesk (TRD §4 rule 3)'); }
  assert.ok(tgt(fdSql()).has('core.tenants') && tgt(blSql()).has('core.tenants'));
  assert.doesNotMatch(fdSql() + files().filter((f) => !/_billing__/.test(f)).map(read).join('\n'), /REFERENCES\s+billing\./i, 'no FK into billing from any other migration');
  for (const q of ['frontdesk.orders', 'billing.invoices']) assert.doesNotMatch(createTable(q.startsWith('frontdesk.') ? fdSql() : blSql(), q).cons.join(' '), /REFERENCES\s+catalog\./i, `${q}: catalog ids are plain uuid snapshots`);
});
test('indexes: every §3/§4 CREATE INDEX present with identical definition (incl. the tenant-leading trigram GIN on patients); no extra index', () => {
  const have = new Map(createIndexes(c4Sql()).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].sort(), exp.map(idxName).sort(), 'no index beyond the spec (§4 query->index map is complete)');
  assert.match(have.get('patients__tenant_id_name_search__trgm_idx') ?? '', /using gin\(tenant_id,name_search extensions\.gin_trgm_ops\)\s*where anonymised_at is null/, 'btree_gin is installed by db/bootstrap/01_database.sql: no trigram fallback');
  for (const n of ['orders__tenant_id_source_ref__p_uq', 'order_flags__tenant_id_kind_specimen__p_uq', 'invoices__tenant_id_order_registration__p_uq', 'ledger_entries__tenant_id_gateway_txn__p_uq', 'ledger_entries__tenant_id_idem__p_uq']) {
    assert.match(have.get(n) ?? '', /^create unique index/, `${n} is UNIQUE`);
  }
});
test('§0.1 / §9 test 2 (static): every index and UNIQUE/PK constraint of a tenant table has tenant_id as first key except the single-column PRIMARY KEY (id); every PK(id) table also has UNIQUE (tenant_id, id)', () => {
  const sql = c4Sql();
  for (const s of createIndexes(sql)) {
    const m = /\bON\s+(\w+\.\w+)\s+(?:USING\s+\w+\s+)?\(\s*([^,)]+)/i.exec(s); assert.ok(m, s);
    if (isG(m[1])) continue;
    assert.equal(m[2].trim(), 'tenant_id', `index ${idxName(s)} on ${m[1]} must lead with tenant_id (REQ-SEC-023)`);
  }
  for (const q of TENANT) {
    const t = createTable(q.startsWith('frontdesk.') ? fdSql() : blSql(), q); assert.ok(t, q);
    const cons = [...t.conMap.values()];
    for (const c of cons.filter((x) => /\b(primary key|unique)\(/.test(x))) {
      const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1];
      if (/primary key/.test(c) && k === 'id') continue;
      assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${c}`);
    }
    if (cons.some((c) => /primary key\(id\)/.test(c))) assert.ok(cons.some((c) => /unique\(tenant_id,id\)/.test(c)), `${q}: PRIMARY KEY (id) requires UNIQUE (tenant_id, id)`);
  }
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A10.5, A16.1, P-16)
test('ENABLE + FORCE ROW LEVEL SECURITY (literal statements) on the 34 tenant tables; none on the 3 g_* tables; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = c4Sql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${q.replace('.', '\\.')}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of GTAB) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${q.replace('.', '\\.')}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
});
const wantedPolicies = () => policies(specPol() + '\n;\n' + specFd()).filter((p) => ALLT.includes(p.table));
const gotPolicies = (schema) => policies(polSql(schema)).filter((p) => p.table.startsWith(schema + '.'));
test('policies: db/policies/{frontdesk,billing}.sql hold EXACTLY the §4a policies + the 2 trf_attachments owner policies (name, command, role, USING, WITH CHECK); only event_inbox may be extra', () => {
  const exp = wantedPolicies(), got = [...gotPolicies('frontdesk'), ...gotPolicies('billing')].filter((p) => !/\.event_inbox$/.test(p.table));
  assert.ok(got.length > 0, 'db/policies/frontdesk.sql / billing.sql have no CREATE POLICY');
  const byKey = new Map(got.map((p) => [p.key, p])); assert.equal(byKey.size, got.length, 'no duplicate policy');
  for (const e of exp) {
    const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`);
    assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`);
    assert.equal(g.using, e.using, `${e.key} USING`); assert.equal(g.check, e.check, `${e.key} WITH CHECK`);
  }
  assert.deepEqual([...byKey.keys()].sort(), exp.map((e) => e.key).sort(), 'no policy beyond the spec (an extra policy widens access; G tables have none)');
  assert.ok(exp.some((p) => p.table === 'billing.export_jobs' && p.cmd === 'DELETE'), 'spec has the export_jobs DELETE policy');
  for (const sch of ['frontdesk', 'billing']) for (const p of policies(polSql(sch)).filter((x) => /\.event_inbox$/.test(x.table))) assert.match(p.name, /^event_inbox__(select|insert|delete)__(tenant|owner_only)$/, `${p.key}: only the C0 inbox shapes may appear`);
});
test('policy shape: TO lims_app (owner_only TO lims_owner), staff guard in every __tenant*/ policy (P-16), ::uuid[] cast in TC/TCN (A16.1), TCN excludes NULL centre, DELETE only on export_jobs, no true / PUBLIC / anon', () => {
  const ps = [...gotPolicies('frontdesk'), ...gotPolicies('billing')].filter((p) => !/\.event_inbox$/.test(p.table));
  assert.equal(ps.length, wantedPolicies().length, `policies: ${ps.length}`);
  const centreTables = new Set(wantedPolicies().filter((p) => /current_centre_ids/.test(p.using + p.check)).map((p) => p.table));
  const tcn = new Set(wantedPolicies().filter((p) => /centre_id is not null/.test(p.using + p.check)).map((p) => p.table));
  for (const t of ['billing.invoices', 'billing.credit_notes', 'billing.invoice_lines', 'billing.credit_note_lines', 'billing.ledger_entries', 'billing.print_log']) assert.ok(tcn.has(t), `${t} is TCN`);
  for (const t of ['frontdesk.orders', 'frontdesk.order_items', 'frontdesk.discounts', 'frontdesk.discount_approvals', 'frontdesk.trf_attachments', 'frontdesk.order_flags', 'billing.cash_sessions', 'billing.order_balances',
    'billing.credit_charges', 'billing.credit_note_tasks', 'billing.finance_review_items', 'billing.refund_requests', 'billing.release_overrides']) assert.ok(centreTables.has(t) && !tcn.has(t), `${t} is TC`);
  for (const p of ps) {
    if (p.name.endsWith('__owner_only')) { assert.equal(p.roles, 'lims_owner', p.key); assert.match(p.using, /current_setting\('app\.maintenance', ?true\)='frontdesk_purge_trf_drafts'/, p.key); assert.match(p.using, /order_id is null/, p.key); continue; }
    assert.equal(p.roles, 'lims_app', `${p.key} roles`);
    assert.match(p.name, new RegExp(`^${p.table.split('.')[1]}__${p.cmd.toLowerCase()}__(tenant|tenant_centre)$`), `${p.key}: name <table>__<cmd>__<scope>`);
    if (p.cmd !== 'INSERT') assert.match(p.using, /app\.is_staff_or_system\(\)/, `${p.key} USING`);
    if (p.cmd === 'INSERT' || p.cmd === 'UPDATE') assert.match(p.check, /app\.is_staff_or_system\(\)/, `${p.key} WITH CHECK`);
    if (centreTables.has(p.table) || tcn.has(p.table)) assert.match(p.using + p.check, /any\(\(select app\.current_centre_ids\(\)\)::uuid\[\]\)/, `${p.key}: A16.1 cast`);
    if (tcn.has(p.table)) assert.match(p.using + p.check, /\(select app\.has_all_centres\(\)\)\s*or\s*\(centre_id is not null and centre_id=any/, `${p.key}: TCN predicate`);
    assert.doesNotMatch(p.using + p.check, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|app\.maintenance|is_platform_actor/, p.key);
    if (p.cmd === 'DELETE') assert.equal(p.table, 'billing.export_jobs', `${p.key}: DELETE policy only on billing.export_jobs`);
    assert.ok(!GTAB.includes(p.table), `${p.key}: G tables carry no policy`);
  }
  for (const t of ['frontdesk.patient_consents', 'billing.invoice_lines', 'billing.credit_note_lines', 'billing.ledger_entries', 'billing.print_log', 'billing.release_overrides', 'billing.payment_intent_refs', 'billing.activity_log', 'billing.cbms_submissions'])
    assert.ok(!ps.some((p) => p.table === t && p.cmd === 'UPDATE'), `${t}: no UPDATE policy (append-only)`);
});
test('policies written literally in migrations are identical to db/policies/*.sql (AC-0B-2.3 copy); the trf_attachments owner policies are created in the same migration as the DEFINER', () => {
  for (const sch of ['frontdesk', 'billing']) {
    const inFile = new Map(policies(polSql(sch)).map((p) => [p.key, p.text]));
    for (const p of policies(sch === 'frontdesk' ? fdSql() : blSql()).filter((x) => x.table.startsWith(sch + '.') && !/\.event_inbox$/.test(x.table))) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  }
  assert.equal(policies(fdSql()).filter((p) => /__owner_only$/.test(p.name) && p.table === 'frontdesk.trf_attachments').length, 2);
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §9 tests 3, 4)
test('table + view grants equal §4a / §6: lims_app only; G tables SELECT only; DELETE only on billing.export_jobs; no UPDATE on the 9 append-only tables; no TRUNCATE/REFERENCES/TRIGGER/ALL; no column grants', () => {
  const sql = c4Sql(), g = tableGrants(sql), exp = tableGrants(specPol() + '\n;\n' + specView());
  for (const q of [...ALLT, ...VIEWS]) {
    const want = exp.get(q)?.get('lims_app'); assert.ok(want, `spec grants ${q}`);
    const rm = g.get(q); assert.ok(rm, `no GRANT on ${q}`);
    assert.deepEqual([...rm.keys()], ['lims_app'], `${q} granted to lims_app only`);
    assert.deepEqual([...rm.get('lims_app')].sort(), [...want].sort(), `${q} privileges`);
  }
  for (const [t, rm] of g) if (/^(frontdesk|billing)\./.test(t)) for (const [r, ps] of rm) {
    assert.equal(r, 'lims_app', `${t}: grant to ${r}`);
    for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!ps.has(bad), `${t} must not hold ${bad}`);
    assert.equal(ps.has('DELETE'), t === 'billing.export_jobs', `${t}: DELETE only on billing.export_jobs`);
  }
  for (const t of UPDATE_FREE) assert.ok(!g.get(t).get('lims_app').has('UPDATE'), `${t}: no UPDATE (class A / no-UPDATE lines)`);
  for (const t of GTAB) assert.deepEqual([...g.get(t).get('lims_app')], ['SELECT']);
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\b(frontdesk|billing)\./i);
  assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+(frontdesk|billing)\b/i);
  assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*(frontdesk|billing)/i);
  assert.doesNotMatch(sql, /GRANT\s*[A-Z, ]*\(\s*\w+/i, 'no column-level grants');
  for (const s of stmts(sql).map(ws)) {
    if (/^GRANT\b/i.test(s) && /\b(frontdesk|billing)\./i.test(s) && !/\bFUNCTION\b/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner)\b/i, s);
    if (/^GRANT\s+USAGE\s+ON\s+SCHEMA\b/i.test(s)) assert.match(s, /\bTO\s+lims_app\s*$/i, s);
  }
});

// ================================================================ functions, DEFINER, triggers (AC-0B-4.1; §3 header, §5, §9 test 6)
test('the 15 guard / DEFINER functions equal the spec bodies (SECURITY INVOKER, search_path pinned, P0001 messages) and are the only functions created; purge_trf_drafts is the single DEFINER', () => {
  const sql = c4Sql(), exp = specDdl();
  for (const f of FNS) {
    const got = fnText(sql, f), want = fnText(exp, f);
    assert.ok(got, `${f} missing`); assert.equal(norm(got), norm(want), `${f} body`);
    assert.match(got, /SET\s+search_path\s*=\s*''/i, `${f} search_path`);
    if (f === 'frontdesk.purge_trf_drafts') assert.match(got, /SECURITY\s+DEFINER/i); else assert.doesNotMatch(got, /SECURITY\s+DEFINER/i, `${f} must be INVOKER`);
  }
  const made = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase());
  assert.deepEqual(made.sort(), [...FNS].sort(), 'no other function');
  assert.equal([...sql.matchAll(/SECURITY\s+DEFINER/gi)].length, 1, 'exactly one DEFINER in C4');
  assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+app\./i, 'C4 adds no app.* function');
  for (const f of ['billing.invoices_lifecycle_guard', 'billing.fiscal_counters_guard', 'frontdesk.orders_lifecycle_guard']) assert.match(fnText(sql, f), /ERRCODE\s*=\s*'P0001',\s*MESSAGE\s*=\s*'immutable_row'/i, `${f} raises P0001 immutable_row`);
  assert.match(fnText(sql, 'billing.invoices_chronology_guard'), /MESSAGE\s*=\s*'chronology_violation'/i);
  assert.match(fnText(sql, 'billing.credit_note_lines_guard'), /MESSAGE\s*=\s*'credit_exceeds_invoice_line'/i);
  assert.match(fnText(sql, 'billing.ledger_reversal_guard'), /MESSAGE\s*=\s*'reversal_mismatch'/i);
});
test('frontdesk.purge_trf_drafts: owner lims_owner, REVOKE ALL FROM PUBLIC, EXECUTE to lims_worker only, maintenance flag set+cleared, two owner_only policies; entry in db/meta/definer-inventory.yaml (AC-0B-2.4, 08 A10.5)', () => {
  const sql = fdSql(), s = stmts(sql).map(ws);
  assert.ok(s.some((x) => /^ALTER FUNCTION frontdesk\.purge_trf_drafts\(interval, ?uuid\[\]\) OWNER TO lims_owner$/i.test(x)) || /^SET LOCAL ROLE lims_owner$/i.test(s[0]), 'owned by lims_owner');
  assert.ok(s.some((x) => /^REVOKE ALL ON FUNCTION frontdesk\.purge_trf_drafts\(interval, ?uuid\[\]\) FROM PUBLIC$/i.test(x)), 'REVOKE ALL FROM PUBLIC');
  const ex = s.filter((x) => /^GRANT EXECUTE ON FUNCTION frontdesk\.purge_trf_drafts/i.test(x)); assert.equal(ex.length, 1); assert.match(ex[0], /\bTO lims_worker$/i);
  assert.doesNotMatch(c4Sql(), /GRANT\s+EXECUTE[^;]*\bTO\b[^;]*\b(lims_app|lims_api|PUBLIC|anon|authenticated)\b/i);
  const body = fnText(sql, 'frontdesk.purge_trf_drafts');
  assert.match(body, /set_config\('app\.maintenance', ?'frontdesk_purge_trf_drafts', ?true\)/i); assert.match(body, /set_config\('app\.maintenance', ?'', ?true\)/i);
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  const e = inv['frontdesk.purge_trf_drafts']; assert.ok(e, 'definer-inventory.yaml needs "frontdesk.purge_trf_drafts"');
  assert.equal(e.owner, 'lims_owner'); assert.deepEqual(e.execute, ['lims_worker']);
  assert.match(JSON.stringify(e.touches), /frontdesk\.trf_attachments/); assert.match(JSON.stringify(e.policies), /trf_attachments__.*owner_only/);
  for (const k of Object.keys(inv)) if (/^billing\./.test(k) || (/^frontdesk\./.test(k) && k !== 'frontdesk.purge_trf_drafts')) assert.fail(`unexpected DEFINER inventory entry ${k}`);
});
test('triggers: every non-audit trigger of §3/§4 present and equal to the spec (incl. mutable_columns lists = §5 immutability); no other non-audit trigger; none disabled or dropped', () => {
  const have = new Map(createTriggers(c4Sql()).filter((s) => !/app\.tg_row_audit\(/i.test(s)).map((s) => [trgName(s), norm(s)]));
  const exp = createTriggers(specDdl()); assert.ok(exp.length >= 20, `spec triggers: ${exp.length}`);
  for (const s of exp) assert.equal(have.get(trgName(s)), norm(s), `trigger ${trgName(s)}`);
  assert.deepEqual([...have.keys()].sort(), exp.map(trgName).sort(), 'no trigger beyond the spec');
  const mc = exp.filter((s) => /app\.enforce_mutable_columns/i.test(s)).map((s) => /ON\s+(\w+\.\w+)/i.exec(s)[1]).sort();
  assert.deepEqual(mc, ['billing.cash_sessions', 'billing.credit_charges', 'billing.credit_notes', 'billing.fiscal_counters', 'billing.invoices', 'billing.refund_requests', 'frontdesk.discount_approvals',
    'frontdesk.discounts', 'frontdesk.order_items', 'frontdesk.orders', 'frontdesk.trf_attachments'], 'C/B tables with a mutable-columns whitelist');
  assert.doesNotMatch(c4Sql(), /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(c4Sql(), /DROP\s+TRIGGER\b/i);
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x): <t>__audit on every audited table, patients with the 6 excluded demographic columns (08 A13 D-27a); none on class A tables / g_* / event_inbox (§0.6)', () => {
  const trg = createTriggers(c4Sql()).filter((s) => /app\.tg_row_audit\(/i.test(s));
  const onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${q.replace('.', '\\.')}\\s`, 'i').test(s));
  for (const q of AUDITED_MUST) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${q.replace('.', '\\.')}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(`, 'i'));
    if (q !== 'frontdesk.patients') assert.match(hit[0], /tg_row_audit\(\s*\)$/i, `${q}: no excluded-column argument`);
  }
  assert.match(onTable('frontdesk.patients')[0] ?? '', PATIENT_AUDIT, 'patients: excluded columns full_name, name_search, birth_on, phone_e164, email, address_text (in that order)');
  for (const q of [...NOT_AUDITED, ...GTAB]) assert.equal(onTable(q).length, 0, `${q} must NOT be audited`);
  for (const q of AUDIT_EITHER) assert.ok(onTable(q).length <= 1, `${q}`);
  assert.equal(trg.length, AUDITED_MUST.length + AUDIT_EITHER.filter((q) => onTable(q).length).length, 'no audit trigger on any other table');
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const MANDATORY = ['id', 'tenant_id', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'];
function specPhi(q) {   // RAW spec table: a trailing "-- P<n>" comment applies to EVERY column declared on that line; "-- reason text P3-possible" -> P3 on the *_reason_text column (review T0B-10.C4 item 8)
  const raw = rawFd() + '\n' + rawBl(), m = new RegExp(`CREATE\\s+TABLE\\s+${q.replace('.', '\\.')}\\s*\\(`, 'i').exec(raw);
  const body = balanced(raw, m.index + m[0].length), out = {};
  for (const line of body.split('\n')) {
    const pm = /--\s*(P[0-3])\b/.exec(line), rt = /--\s*reason text (P3)-possible/.exec(line); if (!pm && !rt) continue;
    const code = line.replace(/--.*$/, '').trim();
    for (const seg of splitTop(code)) {
      const s = seg.trim(); if (!s || /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(s)) continue;
      const col = s.split(/\s+/)[0];
      if (pm) out[col] = pm[1]; else if (/reason_text$/.test(col)) out[col] = rt[1];
    }
  }
  return out;
}
test('tables.yaml: all 37 C4 tables registered (class, centre_scoped from the §4a policies, audited = trigger, retention, phi_class for exactly the DDL columns); event_inbox entries untouched', () => {
  const y = tablesYaml(), centre = new Set(wantedPolicies().filter((p) => /current_centre_ids/.test(p.using + p.check)).map((p) => p.table));
  const trgAudited = (q) => createTriggers(c4Sql()).some((s) => /app\.tg_row_audit\(/i.test(s) && new RegExp(`\\bON\\s+${q.replace('.', '\\.')}\\s`, 'i').test(s));
  for (const q of ALLT) {
    const e = y[q]; assert.ok(e, `${q} in tables.yaml`);
    assert.ok(CLS[q].includes(e.class), `${q} class ${e.class} not in ${CLS[q]}`);
    assert.equal(e.centre_scoped, centre.has(q), `${q} centre_scoped`);
    assert.equal(e.audited, AUDITED_MUST.includes(q) ? true : trgAudited(q), `${q} audited must match the audit trigger`);
    if (AUDITED_MUST.includes(q)) assert.equal(e.audited, true); if (NOT_AUDITED.includes(q) || isG(q)) assert.equal(e.audited, false, `${q} audited`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), [...createTable(specDdl(), q).colNames].sort(), `${q} columns = DDL columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
  }
  assert.ok(y['frontdesk.event_inbox'] && y['billing.event_inbox'], 'inbox entries remain');
  assert.deepEqual(Object.keys(y).filter((k) => /^(frontdesk|billing)\./.test(k) && !/\.event_inbox$/.test(k)).sort(), [...ALLT].sort(), 'no extra frontdesk/billing entry');
  assert.equal(y['billing.activity_log'].class, 'A'); assert.equal(y['frontdesk.patient_consents'].class, 'A');
});
test('tables.yaml phi_class: every "-- P<n>" annotation of the spec DDL is honoured; patient demographics P2; order_items P3 snapshot columns; created_by / updated_by never above P1', () => {
  const y = tablesYaml();
  for (const q of ALLT) for (const [c, p] of Object.entries(specPhi(q))) assert.equal(y[q].columns[c], p, `${q}.${c} is ${p} per the spec DDL comment`);
  const sp = (q, cs, p) => cs.forEach((c) => assert.equal(specPhi(q)[c], p, `spec extraction: ${q}.${c} ${p}`));   // multi-column comment lines are really parsed
  sp('frontdesk.orders', ['age_years', 'age_months', 'age_days'], 'P2'); sp('frontdesk.orders', ['cancel_reason_text'], 'P3');
  sp('billing.invoices', ['buyer_name', 'buyer_pan', 'buyer_address'], 'P2'); sp('billing.invoice_lines', ['order_item_id', 'orderable_id', 'orderable_kind', 'code', 'name'], 'P3');
  sp('billing.credit_notes', ['buyer_name', 'buyer_pan'], 'P2'); sp('billing.ledger_entries', ['order_id', 'invoice_id', 'credit_party_id'], 'P1');
  sp('billing.credit_charges', ['line_kind', 'orderable_id', 'code', 'name', 'department_id'], 'P3'); sp('billing.refund_requests', ['id', 'tenant_id', 'branch_id', 'centre_id', 'order_id'], 'P1');
  for (const c of ['patient_code', 'full_name', 'name_search', 'sex', 'birth_on', 'phone_e164', 'email', 'address_text']) assert.equal(y['frontdesk.patients'].columns[c], 'P2', `frontdesk.patients.${c}`);
  for (const c of ['orderable_id', 'code', 'name', 'test_ids']) assert.equal(y['frontdesk.order_items'].columns[c], 'P3', `frontdesk.order_items.${c}`);
  for (const q of ALLT) for (const c of ['created_by', 'updated_by']) if (y[q].columns[c]) assert.ok(['P0', 'P1'].includes(y[q].columns[c]), `${q}.${c}`);
});
test('tables.yaml: nothing shared with partner/portal/patient (CR-C13-011, P-16); rls_exempt only on the 3 g_* tables; mandatory-column exceptions are real (listed iff the DDL lacks the column) and carry a reason', () => {
  const y = tablesYaml();
  for (const q of ALLT) {
    const e = y[q], cols = new Set(createTable(specDdl(), q).colNames);
    assert.deepEqual(e.shared_with ?? [], [], `${q} must not be shared`);
    if (isG(q)) assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); else assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    const exc = [...(e.mandatory_column_exceptions ?? [])];
    if (!isG(q)) {
      const missing = MANDATORY.filter((c) => !cols.has(c));
      for (const c of exc) assert.ok(!cols.has(c), `${q}: exception ${c} but the DDL has that column`);
      assert.deepEqual(exc.filter((c) => MANDATORY.includes(c)).sort(), missing.sort(), `${q}: mandatory_column_exceptions must list exactly the mandatory columns the DDL lacks`);
    }
    if (exc.length) assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 5, `${q} needs mandatory_column_exceptions_reason`);
  }
});
test('tables.yaml retention (§8): fiscal records "indefinitely"; patients/orders end by anonymisation; TRF drafts 24 h; export_jobs 24 h / 90 days', () => {
  const y = tablesYaml();
  for (const q of ['billing.invoices', 'billing.invoice_lines', 'billing.credit_notes', 'billing.ledger_entries', 'billing.fiscal_counters', 'billing.print_log', 'billing.activity_log', 'billing.cbms_submissions', 'billing.refund_requests'])
    assert.match(y[q].retention, /indefinite|forever|never deleted|kept/i, q);
  for (const q of ['frontdesk.patients', 'frontdesk.orders']) assert.match(y[q].retention, /anonymi|retention|never deleted|year/i, q);
  assert.match(y['frontdesk.trf_attachments'].retention, /24 ?h|draft/i); assert.match(y['billing.export_jobs'].retention, /24 ?h|90 ?d/i);
});
test('db/tests/rls_exempt.txt lists exactly the three C4 g_* tables, each with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^(frontdesk|billing)\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), [...GTAB].sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ views (IC §6.1 / §6.2 column contract; C4 §6)
function outerCols(sql) {   // column names of the outermost SELECT of a view definition (skips WITH ... CTEs and FROM-subqueries)
  let body = ws(sql).replace(/^CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+[\w.]+\s+(WITH\s*\([^)]*\)\s+)?AS\s+/i, '');
  if (/^WITH\b/i.test(body)) {
    let i = 4;
    for (;;) {
      const m = /^\s*(\w+)\s+AS\s*\(/i.exec(body.slice(i)); if (!m) break;
      const open = i + m[0].length; i = open + balanced(body, open).length + 1;
      const c = /^\s*,/.exec(body.slice(i)); if (!c) break; i += c[0].length;
    }
    body = body.slice(i).trim();
  }
  const start = /^SELECT\s+/i.exec(body); assert.ok(start, `view SELECT: ${body.slice(0, 40)}`);
  let depth = 0, q = false, end = -1;
  for (let k = start[0].length; k < body.length; k++) {
    const c = body[k];
    if (q) { if (c === "'") q = false; continue; }
    if (c === "'") { q = true; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    else if (depth === 0 && /^\sFROM\s/i.test(body.slice(k, k + 6))) { end = k; break; }
  }
  assert.ok(end > 0, 'view FROM');
  return splitTop(body.slice(start[0].length, end)).map((item) => { const a = /\bAS\s+(\w+)\s*$/i.exec(item.trim()); return a ? a[1] : item.trim().split('.').pop().replace(/\W/g, ''); });
}
const viewSql = (sql, qv) => { const s = stmts(sql).find((x) => new RegExp(`^CREATE\\s+(OR\\s+REPLACE\\s+)?VIEW\\s+${qv.replace('.', '\\.')}\\b`, 'i').test(ws(x))); return s ? ws(s) : null; };
const icCols = (qv) => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8').replace(/\r\n?/g, '\n');
  const a = ic.indexOf('### 6.1 `frontdesk`'), b = ic.indexOf('### 6.3 `lab`'); assert.ok(a > 0 && b > a, 'IC §6.1-6.2');
  const row = ic.slice(a, b).split('\n').find((l) => l.startsWith(`| \`${qv}\``)); assert.ok(row, `IC row for ${qv}`);
  return splitTop(row.split('|')[2]).map((c) => /^\s*`?(\w+)/.exec(c)[1]);
};
test('view column contract vs IC §6.1/§6.2: each of the 10 v_pub_* views has exactly the IC columns in IC order (spec §6 and the migration agree)', () => {
  for (const v of VIEWS) {
    const ic = icCols(v), got = viewSql(c4Sql(), v);
    assert.ok(got, `CREATE VIEW ${v} missing from the C4 migrations`);
    assert.deepEqual(outerCols(viewSql(specView(), v)), ic, `${v}: C4 05-SCHEMA §6 vs IC`);
    assert.deepEqual(outerCols(got), ic, `${v}: migration columns (names + order) vs IC`);
  }
  assert.deepEqual(icCols('billing.v_pub_payment_collection').slice(5, 6), ['payment_method_code'], '08 R4');
  assert.ok(icCols('frontdesk.v_pub_order_status').includes('partner_id'));
});
test('views: definitions equal §6, WITH (security_invoker = true), SELECT to lims_app only, no other view / matview in frontdesk or billing, Asia/Kathmandu business_date, no "commission", no contact/PAN columns', () => {
  const sql = c4Sql();
  for (const v of VIEWS) {
    const got = viewSql(sql, v); assert.ok(got, v);
    assert.equal(norm(got), norm(viewSql(specView(), v)), v);
    assert.match(got, /WITH\s*\(\s*security_invoker\s*=\s*(true|on)\s*\)/i, `${v} security_invoker`);
  }
  assert.deepEqual([...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\s+((?:frontdesk|billing)\.\w+)/gi)].map((m) => `${m[1] ? 'M:' : ''}${m[2]}`).sort(), [...VIEWS].sort());
  assert.doesNotMatch(blSql(), /commission/i, 'no column may say "commission" (§6, 04 L19)');
  for (const v of ['billing.v_pub_invoice_daily', 'billing.v_pub_department_income', 'frontdesk.v_pub_order_daily']) assert.match(viewSql(sql, v), /AT TIME ZONE 'Asia\/Kathmandu'/i, `${v} business_date zone`);
  for (const v of VIEWS) assert.doesNotMatch(outerCols(viewSql(sql, v)).join(' '), /\b(phone|email|full_name|buyer_name|buyer_pan|address|name_search|birth_on)\b/i, `${v} exposes no personal column`);
  assert.match(viewSql(sql, 'billing.v_pub_payment_collection'), /method_code AS payment_method_code/i);
});

// ================================================================ hygiene
test('C4 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of C0/C2/C3 tables, no USING (true), no seed rows in DDL', () => {
  const raw = [...fdFiles(), ...blFiles()].map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 1000, 'C4 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i);
  assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016');
  assert.doesNotMatch(raw, /\bINSERT\s+INTO\s+(frontdesk|billing)\./i, 'g_* seed rows (§7) belong to db/seeds, not to DDL migrations');
  assert.doesNotMatch(raw, /\bformat\s*\([^)]*%s[^)]*(frontdesk|billing)\.%s/i);
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 90000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-registry.ts, check-migrations.ts and check-fk-dag.ts exit 0 on the tree (frontdesk -> core/catalog only; nothing into billing)', () => {
  assert.ok(fdFiles().length >= 1 && blFiles().length >= 1, 'C4 migrations missing');
  for (const t of ['check-registry.ts', 'check-migrations.ts', 'check-fk-dag.ts']) { const r = tool(t); assert.equal(r.code, 0, `${t}:\n${r.out}`); }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 34 tenant C4 tables, none for the 3 class G, and gen-isolation-probes --check is clean', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const q of GTAB) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${q.replace('.', '\\.')}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const T = root + 'db/tests/frontdesk_billing/';
const tapFiles = () => (existsSync(T) ? readdirSync(T).filter((f) => /^T0B-10\.C4_.*\.test\.sql$/.test(f)) : []);
test('pgTAP files db/tests/frontdesk_billing/T0B-10.C4_*.test.sql exist (writer must keep them: tester-owned) and cover C4 05-SCHEMA §9 tests 1-9 by "-- §9 test N" markers; RLS never disabled in them', () => {
  assert.ok(tapFiles().length >= 2, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(T + f, 'utf8')).join('\n');
  for (let n = 1; n <= 9; n++) assert.match(txt, new RegExp(`-- §9 test ${n}\\b`), `marker for §9 test ${n}`);
  for (const ac of ['2.1', '2.2', '3.1', '3.2', '3.3', '3.4', '3.5', '3.7', '4.1', '4.2', '4.3', '5.1', '5.3', '6.2', '6.4']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(T + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY|session_replication_role/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
  }
});
