// T0B-13.C16 static checks of the Wave-3 engagement DDL translation: db/migrations/*_engagement__*.sql, db/policies/engagement.sql, db/meta/tables.yaml, db/meta/definer-inventory.yaml, db/tests/rls_exempt.txt.
// Spec: C16 05-SCHEMA §1 (inventory, class, grants, mandatory-column exceptions), §2.1 (settings, P0), §3 (DDL), §4 (guard triggers), §5 (RLS: predicates 5.1, matrix 5.2, literal SQL 5.3), §6 (helpers, resolvers, purges, owner policies, inventory 6.6, tests 6.6),
// §7 (2 published views), §8 (seeds), §9 (retention), §10 (PHI classes); C0 05-SCHEMA §9 rule 1 (tenant FK + UNIQUE (tenant_id, id)); 03-IC §6 (view columns); 08 A10.5, A12.1, A12.2, A12.7, A16.1, A17 P-16 / P-18, A19 P-41 / D-121; LD-202 (translate exactly, a gap = blocking CR).
// AC-0B-2.1..2.4, 3.1..3.7 (probes + pgTAP), 4.1..4.3, 5.1..5.3, 6.1..6.4 (6.4 = view column contract; the billing-only part does not apply).
// Run: node --test tests/db/T0B-13.C16.engagement.test.mjs   (live: db/tests/engagement/T0B-13.C16_schema.test.sql via pg_prove; the six FORCE-RLS tests of §6.6 are the existing db/tests/engagement/T-A2, T-A3, T-L2, T-Q3, T-OPS1, T-SEC1 suites; generated probes: db/tests/isolation/engagement.*.test.sql)
// Method (as T0B-13.C9..C15): the expected DDL is PARSED FROM C16 05-SCHEMA at test time and compared (whitespace/case-normalised) with the migrations. §3, §4 and §6 hold literal SQL for every table, index, function and trigger, §5.3 / §6.5 for 39 policies and §7 for both views.
// The remaining policies of §5.2 are not written out in the spec: the matrix is encoded below (MX) and every migration policy is CLASSIFIED by its predicate (STAFF / STAFF_C / SYS / PAT_* / PRE* / DISP / ANY_T of §5.1), so the check does not depend on a scope name the spec does not give.
// T0B13C16_ROOT (optional) points the checks at another tree (scratch validation of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0B13C16_ROOT ? resolve(process.env.T0B13C16_ROOT) + '/' : repo;
const migDir = root + 'db/migrations/';
const polDir = root + 'db/policies/';
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=])\s*/g, '$1').replace(/\s*::\s*/g, '::').replace(/\bif not exists\s+/gi, '').replace(/\bcreate or replace function\b/gi, 'create function').toLowerCase();
const stmts = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
const files = () => (existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort() : []);
const eFiles = () => files().filter((f) => /^\d{14}_engagement__[a-z0-9_]+\.sql$/.test(f));
const read = (f) => strip(readFileSync(migDir + f, 'utf8'));
const eSql = () => eFiles().map(read).join('\n;\n');
const polSql = () => (existsSync(polDir + 'engagement.sql') ? strip(readFileSync(polDir + 'engagement.sql', 'utf8')) : '');

// ---------------------------------------------------------------- SQL scanning helpers (same technique as T0B-05 / C2..C15)
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
    const m = /^CREATE\s+POLICY\s+(\w+)\s+ON\s+([\w.]+)\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([\w, ]+?)\s+(?=USING|WITH)([\s\S]*)$/i.exec(ws(s));
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

// ---------------------------------------------------------------- spec extraction (C16 05-SCHEMA)
const specPath = repo + 'spec/chunks/C16-patient-engagement/05-SCHEMA.md';
const specRaw = () => readFileSync(specPath, 'utf8').replace(/\r\n?/g, '\n');
function between(s, a0, b0) {
  const a = s.indexOf(a0); assert.ok(a >= 0, `spec marker ${a0}`);
  const b = b0 ? s.indexOf(b0, a + a0.length) : s.length; assert.ok(b > a, `spec marker ${b0}`);
  return s.slice(a, b);
}
const sqlBlocks = (md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n;\n');
const S1 = '## 1. Table inventory', S2 = '## 2. Notable columns and rules', S3 = '## 3. DDL', S4 = '## 4. Guard triggers', S5 = '## 5. RLS', S6 = '## 6. Helper, resolver and purge functions', S7 = '## 7. Published views', S8 = '## 8. Seeds', S9 = '## 9. Retention', S10 = '## 10. Data classification summary';
const specSec = (a, b) => between(specRaw(), a, b);
const specDdl = () => strip(sqlBlocks(specSec(S3, S4)));        // §3: tables, indexes, 4 triggers, settings guard function
const specAll = () => strip(sqlBlocks(specRaw()));              // §3 .. §7: everything written out as SQL

// ---- tables: the §3 DDL is the truth (39 CREATE TABLE = 36 tenant + 3 G; event_inbox is C0's); classes from §1 (hard-coded, cross-checked against the spec rows)
const G_N = ['g_cs_booking_cancel_reasons', 'g_cs_reminder_reasons', 'g_cs_enquiry_categories'];
const CLS = { settings: 'M', accounts: 'M', otp_challenges: 'E', link_codes: 'E', link_consents: 'A', account_patient_links: 'M', self_registrations: 'E', addresses: 'M', bookable_items: 'M', booking_centres: 'E', slot_templates: 'M', slot_blackouts: 'M', slot_occupancy: 'M',
  bookings: 'C', booking_items: 'A', booking_transitions: 'A', patient_orders: 'E', patient_order_specimens: 'E', patient_reports: 'E', smart_summaries: 'E', notifications: 'E', payment_requests: 'M', queue_definitions: 'M', queue_counters: 'M', queue_day_counters: 'M',
  queue_tokens: 'C', queue_displays: 'M', reminders: 'M', membership_plans: 'M', patient_memberships: 'M', number_counters: 'E', enquiries: 'M', enquiry_messages: 'A', cs_booking_cancel_reasons: 'M', cs_reminder_reasons: 'M', cs_enquiry_categories: 'M' };
const T_N = Object.keys(CLS);
const G_T = G_N.map((t) => `engagement.${t}`), TENANT = T_N.map((t) => `engagement.${t}`), ALLT = [...G_T, ...TENANT];
const isG = (q) => /\.g_/.test(q);
const AUDIT_REQ = T_N.filter((t) => ['M', 'C'].includes(CLS[t])).map((t) => `engagement.${t}`);              // C0 05-SCHEMA §2: default "every class M, C and B table is audited; A and E tables are not" (C16 §1 declares nothing else)
const AUDIT_ARGS = { 'engagement.queue_displays': ['token_sha256'], 'engagement.patient_memberships': ['card_token'], 'engagement.payment_requests': ['action_json'] };   // §10 "Secret (never logged)" columns of audited tables
const TG_NAMES = ['settings__consent_version', 'account_patient_links__mutable_columns', 'bookings__mutable_columns', 'queue_tokens__mutable_columns', 'slot_occupancy__patient_guard', 'queue_displays__device_guard', 'account_patient_links__patient_guard'];
const FN_INV = ['engagement.settings_consent_version_guard', 'engagement.guard_actor_columns', 'engagement.guard_patient_link_update'];   // SECURITY INVOKER trigger functions
const HELPERS = ['app.engagement_account_id', 'app.engagement_patient_ids', 'app.engagement_patient_visible'];                              // DEFINER, created by the C0 helpers stage (08 A30.1): re-creation here is optional, text = spec if present
const DEF_NEW = ['app.engagement_redeem_link_code', 'app.engagement_apply_report_link', 'app.engagement_code_redeemed_by_me', 'app.engagement_resolve_preauth', 'app.engagement_resolve_display', 'engagement.purge_payment_requests', 'engagement.purge_queue'];
const EXEC = { 'app.engagement_account_id': ['lims_app'], 'app.engagement_patient_ids': ['lims_app'], 'app.engagement_patient_visible': ['lims_app'], 'app.engagement_redeem_link_code': ['lims_app'], 'app.engagement_apply_report_link': ['lims_app'], 'app.engagement_code_redeemed_by_me': ['lims_app'],
  'app.engagement_resolve_preauth': ['lims_api'], 'app.engagement_resolve_display': ['lims_api'], 'engagement.purge_payment_requests': ['lims_worker'], 'engagement.purge_queue': ['lims_worker'] };
const SIG = { 'app.engagement_redeem_link_code': 'bytea', 'app.engagement_apply_report_link': 'uuid, timestamptz', 'app.engagement_code_redeemed_by_me': 'uuid, uuid', 'app.engagement_resolve_preauth': 'text, bytea', 'app.engagement_resolve_display': 'bytea', 'engagement.purge_payment_requests': '', 'engagement.purge_queue': '' };
const VIEWS = ['engagement.v_pub_booking_daily', 'engagement.v_pub_queue_daily'];

// ---- policy matrix of §5.2 (S/I/U/D = scopes of §5.1; PAT_ACC accepts PAT_ACC_PID, PAT_ACC_PID is strict). Cells '—' are absent keys.
const SYS_D = ['SYS'];
const MX = {
  settings: { S: ['ANY_T'], I: ['STAFF'], U: ['STAFF'] },
  accounts: { S: ['STAFF', 'PAT_ACC', 'PRE_ACC'], I: ['PRE_ACC'], U: ['PAT_ACC', 'SYS', 'PRE_ACC'] },
  otp_challenges: { S: ['PRE_TOK', 'SYS'], I: ['PRE'], U: ['PRE_TOK', 'SYS'], D: SYS_D },
  link_consents: { S: ['STAFF', 'PAT_ACC'], I: ['STAFF', 'PAT_ACC'] },
  link_codes: { S: ['STAFF'], I: ['STAFF'], U: ['STAFF'], D: SYS_D },
  account_patient_links: { S: ['STAFF', 'PAT_ACC'], I: ['PAT_ACC', 'SYS'], U: ['PAT_ACC', 'STAFF', 'SYS'] },
  self_registrations: { S: ['PAT_ACC', 'SYS'], I: ['PAT_ACC'], U: ['SYS'] },
  addresses: { S: ['PAT_ACC', 'STAFF'], I: ['PAT_ACC_PID', 'STAFF'], U: ['PAT_ACC_PID', 'STAFF'] },
  bookable_items: { S: ['STAFF', 'PAT_ANY'], I: ['STAFF'], U: ['STAFF'] },
  booking_centres: { S: ['STAFF', 'PAT_ANY', 'DISP'], I: ['SYS'], U: ['SYS'] },
  slot_templates: { S: ['STAFF_C', 'PAT_ANY'], I: ['STAFF_C'], U: ['STAFF_C'] },
  slot_blackouts: { S: ['STAFF_C', 'PAT_ANY'], I: ['STAFF_C'], U: ['STAFF_C'] },
  slot_occupancy: { S: ['STAFF_C', 'PAT_ANY'], I: ['STAFF_C', 'PAT_ANY'], U: ['STAFF_C', 'PAT_ANY'] },
  bookings: { S: ['STAFF_C', 'PAT_ACC'], I: ['STAFF_C', 'PAT_ACC'], U: ['STAFF_C', 'PAT_ACC'] },
  booking_items: { S: ['STAFF_C', 'PAT_ACC'], I: ['STAFF_C', 'PAT_ACC'] },
  booking_transitions: { S: ['STAFF_C', 'PAT_ACC'], I: ['STAFF_C', 'PAT_ACC'] },
  patient_orders: { S: ['PAT_VIS', 'SYS'], I: ['SYS'], U: ['SYS'], D: SYS_D },
  patient_order_specimens: { S: ['PAT_PID', 'SYS'], I: ['SYS'], U: ['SYS'], D: SYS_D },
  patient_reports: { S: ['PAT_VIS', 'SYS'], I: ['SYS'], U: ['SYS'], D: SYS_D },
  smart_summaries: { S: ['PAT_PID', 'SYS'], I: ['SYS'], U: ['SYS'], D: SYS_D },
  notifications: { S: ['PAT_ACC', 'SYS'], I: ['SYS'], U: ['PAT_ACC', 'SYS'], D: SYS_D },
  payment_requests: { S: ['PAT_ACC', 'SYS'], I: ['PAT_ACC_PID'], U: ['PAT_ACC', 'SYS'] },
  queue_definitions: { S: ['STAFF_C', 'DISP'], I: ['STAFF_C'], U: ['STAFF_C'] },
  queue_counters: { S: ['STAFF_C', 'DISP'], I: ['STAFF_C'], U: ['STAFF_C'] },
  queue_day_counters: { S: ['STAFF_C'], I: ['STAFF_C'], U: ['STAFF_C'] },
  queue_tokens: { S: ['STAFF_C', 'DISP'], I: ['STAFF_C'], U: ['STAFF_C'] },
  queue_displays: { S: ['STAFF_C', 'DISP'], I: ['STAFF_C'], U: ['STAFF_C', 'DISP'] },
  reminders: { S: ['STAFF'], I: ['STAFF'], U: ['STAFF'] },
  membership_plans: { S: ['STAFF', 'PAT_ANY'], I: ['STAFF'], U: ['STAFF'] },
  patient_memberships: { S: ['STAFF', 'PAT_PID'], I: ['STAFF'], U: ['STAFF'] },
  number_counters: { S: ['ANY_T'], I: ['ANY_T'], U: ['ANY_T'], D: SYS_D },
  enquiries: { S: ['STAFF', 'PAT_ACC'], I: ['PAT_ACC'], U: ['STAFF', 'PAT_ACC'] },
  enquiry_messages: { S: ['STAFF', 'PAT_ACC'], I: ['STAFF', 'PAT_ACC'] },
  cs_booking_cancel_reasons: { S: ['ANY_T'], I: ['STAFF'], U: ['STAFF'] },
  cs_reminder_reasons: { S: ['ANY_T'], I: ['STAFF'], U: ['STAFF'] },
  cs_enquiry_categories: { S: ['ANY_T'], I: ['STAFF'], U: ['STAFF'] },
};
const CMD = { S: 'SELECT', I: 'INSERT', U: 'UPDATE', D: 'DELETE' };
const PATSET = new Set(['PAT_ACC', 'PAT_ACC_PID', 'PAT_PID', 'PAT_VIS', 'PAT_ANY', 'PRE', 'PRE_TOK', 'PRE_ACC']);
const STAFFSET = new Set(['STAFF', 'STAFF_C', 'SYS']);
const scopesOf = (t) => new Set(Object.values(MX[t]).flat());
const MX_COUNT = Object.values(MX).reduce((n, m) => n + Object.values(m).reduce((k, a) => k + a.length, 0), 0);
// classify a lims_app policy by its predicate (normalised: no blanks around ( ) , = ::, lower case)
function scopeOf(p) {
  const t = `${p.using} ${p.check}`;
  if (/current_actor_type\(\)\)='device'/.test(t)) return 'DISP';
  if (/in\('user','system','patient','device'\)/.test(t)) return 'ANY_T';
  if (/engagement_preauth_stage\(\)\)='pre_auth'/.test(t)) return /from engagement\.otp_challenges/.test(t) && /phone_e164=/.test(t) ? 'PRE_ACC' : /otp_token_sha256/.test(t) ? 'PRE_TOK' : 'PRE';
  if (/current_actor_type\(\)\)='patient'/.test(t)) {
    if (/engagement_patient_visible\(/.test(t)) return 'PAT_VIS';
    const acc = /\b(?:account_)?id=\(select app\.engagement_account_id\(\)\)/.test(t), pid = /engagement_patient_ids\(\)\)::uuid\[\]/.test(t);
    if (acc) return pid ? 'PAT_ACC_PID' : 'PAT_ACC';
    if (pid) return 'PAT_PID';
    if (/engagement_account_id\(\)\)\s*is not null/.test(t)) return 'PAT_ANY';
    return 'PAT_?';
  }
  if (/current_actor_type\(\)\)in\('user','system'\)/.test(t)) return /has_all_centres\(\)/.test(t) ? 'STAFF_C' : 'STAFF';
  if (/current_actor_type\(\)\)='system'/.test(t)) return 'SYS';
  return '?';
}
const matchScopes = (exp, got) => {                  // expected scope list vs classified policies of one (table, cmd): PAT_ACC also accepts PAT_ACC_PID
  const g = got.map((s) => (s === 'PAT_ACC_PID' && exp.includes('PAT_ACC') && !exp.includes('PAT_ACC_PID') ? 'PAT_ACC' : s));
  return JSON.stringify([...g].sort()) === JSON.stringify([...exp].sort());
};
const tenantPol = (ps) => ps.filter((p) => p.roles === 'lims_app');
const gotPolicies = () => policies(polSql()).filter((p) => p.table.startsWith('engagement.') && !/\.event_inbox$/.test(p.table));

// ---- the inventory of §1 (class, grants) parsed from the spec
function inventory() {
  const out = new Map();
  for (const l of specSec(S1, S2).split('\n').filter((x) => /^\| `/.test(x))) {
    const c = l.split('|').map((x) => x.trim()), grants = c[5].split(/\s+/).filter((x) => /^[SIUD]$/.test(x));
    for (const n of [...c[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1])) out.set(n, { cls: /^([A-Z])/.exec(c[2])[1], grants });
  }
  return out;
}
const PRIV = { S: 'SELECT', I: 'INSERT', U: 'UPDATE', D: 'DELETE' };

// ================================================================ spec-side sanity (must pass now)
test('spec parsers sanity: 39 CREATE TABLE in §3 (36 tenant + 3 G, no event_inbox), 7 non-audit triggers, 14 functions (3 INVOKER guards + app.engagement_preauth_stage INVOKER + 10 DEFINER), 26 lims_app + 13 owner policies written out in §5.3 / §6.5, 2 views, 14 coded-set rows, §1 classes + grants match the hard-coded tables, 6 FORCE-RLS tests in §6.6', () => {
  const ddl = specDdl(), all = specAll();
  assert.equal([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].length, 39, '39 CREATE TABLE in §3');
  assert.equal(G_N.length, 3); assert.equal(T_N.length, 36); assert.equal(ALLT.length, 39);
  assert.deepEqual([...ddl.matchAll(/CREATE\s+TABLE\s+(\w+\.\w+)/gi)].map((m) => m[1]).sort(), [...ALLT].sort(), '§1 engagement rows = §3 tables');
  for (const q of ALLT) assert.ok(createTable(ddl, q), `spec has ${q}`);
  assert.deepEqual(['g_cs_reminder_reasons', 'g_cs_enquiry_categories'].map((t) => norm(createTable(ddl, `engagement.${t}`).like)), Array(2).fill('like engagement.g_cs_booking_cancel_reasons including all'), 'two G tables are LIKE copies');
  assert.doesNotMatch(all, /CREATE\s+TABLE\s+engagement\.event_inbox/i);
  assert.deepEqual(fnNames(all).sort(), [...FN_INV, 'app.engagement_preauth_stage', ...HELPERS, ...DEF_NEW].sort(), 'the 14 functions');
  assert.deepEqual([...all.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)[^$]*?SECURITY\s+DEFINER/gi)].map((m) => m[1]).sort(), [...HELPERS, ...DEF_NEW].sort(), 'exactly 10 DEFINER functions (§6.6 inventory rows)');
  assert.deepEqual(createTriggers(all).filter((s) => !isAudit(s)).map(trgName).sort(), [...TG_NAMES].sort(), '7 non-audit triggers (§3, §4)');
  assert.equal(createTriggers(all).filter(isAudit).length, 0, 'the spec writes no audit trigger (C0 adds them for class M / C, C0 §9 rule 1)');
  const lit = policies(all); assert.equal(lit.length, 39); assert.equal(lit.filter((p) => p.roles === 'lims_owner').length, 13, '13 owner policies in §6.5'); assert.equal(lit.filter((p) => p.roles === 'lims_app').length, 26, '26 lims_app policies in §5.3');
  assert.deepEqual([...all.matchAll(/CREATE\s+VIEW\s+(\w+\.\w+)/gi)].map((m) => m[1]), VIEWS);
  assert.equal(createIndexes(ddl).length, 46, '46 CREATE INDEX in §3');
  assert.equal(seedSpec().length, 14, '§8: 14 coded-set rows'); assert.equal(MX_COUNT, Object.keys(MX).length === 36 ? MX_COUNT : -1, 'matrix covers 36 tenant tables');
  const inv = inventory();
  for (const t of T_N) assert.equal(inv.get(t)?.cls, CLS[t], `§1 class of ${t}`);
  for (const t of G_N) assert.equal(inv.get(t)?.cls, 'G', `§1 class of ${t}`);
  for (const t of T_N) assert.deepEqual(inv.get(t).grants.filter((g) => g !== 'D'), MX[t].U ? ['S', 'I', 'U'] : ['S', 'I'], `§1 grants of ${t} (S I U, or S I when no UPDATE policy)`);
  assert.deepEqual(T_N.filter((t) => inv.get(t).grants.includes('D')).sort(), ['notifications', 'number_counters', 'otp_challenges', 'link_codes', 'patient_orders', 'patient_order_specimens', 'patient_reports', 'smart_summaries'].sort(), '§1: D only on 8 class E tables');
  assert.deepEqual(T_N.filter((t) => MX[t].D).sort(), T_N.filter((t) => inv.get(t).grants.includes('D')).sort(), 'DELETE policy exactly where DELETE is granted');
  for (const t of G_N) assert.deepEqual(inv.get(t).grants, ['S']);
  assert.equal([...specSec('FORCE-RLS contract tests', '## 7. Published views').matchAll(/^\d\. /gm)].length, 6, '§6.6 lists 6 tests');
  assert.match(specSec(S2, S3), /One non-deleted account per \(tenant, phone\)/);
});

// ================================================================ files, order, owner (AC-0B-6.1 / 6.3)
const WAVE = /_(quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection|migration_staging)__/;
const BEFORE = /_(quality|micro|anatomic|inventory|partners|smartreport|payments)__/;
test('migration files: >= 1 *_engagement__*.sql, timestamps strictly after 20261114120000 (LD-202), after every wave-1 migration and after the quality, micro, anatomic, inventory, partners, smartreport and payments migrations (db/meta/dag.yaml: engagement follows payments), unique; db/policies/engagement.sql exists; schema creation IF NOT EXISTS', () => {
  assert.ok(eFiles().length >= 1, 'no db/migrations/*_engagement__*.sql yet (T0B-13.C16 writer creates them)');
  const all = files(), stamps = all.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'migration timestamps unique');
  const earlier = all.filter((f) => !WAVE.test(f)), before = all.filter((f) => BEFORE.test(f));
  assert.ok(earlier.length >= 24, 'wave-1 migrations present'); assert.ok(before.length >= 7, 'quality ... payments migrations present');
  for (const f of eFiles()) {
    assert.ok(f.slice(0, 14) > '20261114120000', `${f} must be later than 20261114120000`);
    for (const e of [...earlier, ...before]) assert.ok(f.slice(0, 14) > e.slice(0, 14), `${f} must sort after ${e} (engagement follows payments in the DAG)`);
  }
  assert.ok(existsSync(polDir + 'engagement.sql'), 'db/policies/engagement.sql missing (AC-0B-2.3)');
  assert.doesNotMatch(eSql(), /CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)engagement\b/i, 'schema engagement exists since T0B-01; CREATE SCHEMA must be IF NOT EXISTS');
});
test('AC-0B-6.3: the first statement of every engagement migration is SET LOCAL ROLE lims_owner and it is the only role switch (all tables, functions and views owned by lims_owner); no standing CREATE grant, no role DDL, no CREATE EXTENSION', () => {
  assert.ok(eFiles().length >= 1, 'migrations missing');
  const sw = (s) => [...s.matchAll(/\b(RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+\w+|SET\s+SESSION\s+AUTHORIZATION)/gi)].map((m) => ws(m[1]).toUpperCase());
  for (const f of eFiles()) {
    const s = read(f), first = stmts(s)[0] ?? '';
    assert.match(ws(first), /^SET\s+LOCAL\s+ROLE\s+lims_owner$/i, `${f}: first statement is "${ws(first).slice(0, 60)}"`);
    assert.deepEqual(sw(s), ['SET LOCAL ROLE LIMS_OWNER'], `${f}: no later role switch`);
  }
  assert.doesNotMatch(eSql(), /GRANT\s+CREATE\s+ON\s+(SCHEMA\s+app|DATABASE)/i); assert.doesNotMatch(eSql(), /CREATE\s+ROLE|ALTER\s+ROLE/i); assert.doesNotMatch(eSql(), /CREATE\s+EXTENSION/i);
});

// ================================================================ tables (columns + constraints = spec exactly; C0 may add only a tenant FK and UNIQUE (tenant_id, id), C0 05-SCHEMA §9 rule 1)
const colsOf = (sql, q) => { const t = createTable(sql, q); if (t && t.like && !t.colNames.length) return createTable(sql, 'engagement.g_cs_booking_cancel_reasons'); return t; };
for (const q of ALLT) {
  test(`${q}: every spec column + constraint (name + text) present identically in the migration; no extra column; only a tenant FK (<t>__tenant__fk) and UNIQUE (tenant_id, id) may be added (05-SCHEMA §3; C0 §9 rule 1)`, () => {
    const specT = createTable(specDdl(), q); assert.ok(specT, `spec table ${q}`);
    const sql = eSql(), got = createTable(sql, q), t = q.split('.')[1];
    assert.ok(got, `CREATE TABLE ${q} not found in *_engagement__*.sql`);
    if (specT.like) {                                         // g_cs_reminder_reasons / g_cs_enquiry_categories are LIKE copies of g_cs_booking_cancel_reasons INCLUDING ALL
      if (got.like) assert.equal(norm(got.like), norm(specT.like), `${q}: LIKE clause`);
      else {
        const base = createTable(specDdl(), 'engagement.g_cs_booking_cancel_reasons');
        for (const [c, def] of base.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c} (expanded LIKE)`);
        assert.deepEqual([...got.colMap.keys()].sort(), [...base.colMap.keys()].sort(), `${q}: columns = those of g_cs_booking_cancel_reasons`);
        assert.ok([...got.conMap.values()].some((d) => /primary key\(code\)/.test(d)) || [...got.colMap.values()].some((d) => /primary key/.test(d)), `${q}: PRIMARY KEY (code)`);
      }
      return;
    }
    for (const [c, def] of specT.colMap) assert.equal(got.colMap.get(c), def, `${q}.${c}`);
    for (const c of got.colMap.keys()) assert.ok(specT.colMap.has(c), `${q}: extra column ${c} (the spec DDL is complete; absent mandatory columns are registry exceptions)`);
    for (const [c, def] of specT.conMap) assert.equal(got.conMap.get(c), def, `${q} constraint ${c}`);
    for (const [c, def] of got.conMap) if (!specT.conMap.has(c)) {
      const body = def.replace(/^constraint\s+\w+\s+/, '');
      if (body === 'foreign key(tenant_id)references core.tenants(id)') assert.equal(c, `${t}__tenant__fk`, `${q}: added tenant FK name`);
      else { assert.match(body, /^unique\(tenant_id,id\)$/, `${q}: extra constraint ${c} (only the C0 tenant FK and UNIQUE (tenant_id, id) may be added)`); assert.ok(c.startsWith(`${t}__`), `${q}: ${c} prefixed ${t}__`); assert.ok(got.colMap.has('id'), `${q}: UNIQUE (tenant_id, id) only on tables with an id`); }
    }
    const bodies = [...got.conMap.values()].map((d) => d.replace(/^constraint\s+\w+\s+/, ''));
    assert.ok(bodies.includes('foreign key(tenant_id)references core.tenants(id)'), `${q}: tenant FK to core.tenants (C0 §9 rule 1)`);
    if (got.colMap.has('id')) assert.ok(bodies.includes('unique(tenant_id,id)'), `${q}: UNIQUE (tenant_id, id) (04 D8)`); else assert.ok(!bodies.includes('unique(tenant_id,id)'), `${q}: no id column, so no UNIQUE (tenant_id, id)`);
    if (t === 'settings') assert.ok(bodies.includes('unique(tenant_id)'), 'settings: one row per tenant');
  });
}
test('exactly the 39 §3 tables are created in engagement (no event_inbox: C0 created it in T0B-05); no ENUM; no sequence / serial / identity; no DEFAULT on id / tenant_id (04 D9); table count == spec count (the impl note states both)', () => {
  const sql = eSql(), bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const made = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+\.\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(made.sort(), [...ALLT].sort());
  assert.equal(made.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'migration CREATE TABLE count == spec CREATE TABLE count (39 == 39)');
  assert.doesNotMatch(sql, /CREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i, 'no ENUM (02-CV §5.5)');
  assert.doesNotMatch(bare, /\bCREATE\s+SEQUENCE\b|\bbigserial\b|\bserial\b|\bsmallserial\b|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i);
  assert.doesNotMatch(sql, /CREATE\s+TABLE[^;]*event_inbox/i, 'C16 migrations create no inbox (C0 owns engagement.event_inbox)');
  for (const q of TENANT) for (const c of ['id', 'tenant_id']) { const def = createTable(sql, q)?.colMap.get(c); if (def) assert.doesNotMatch(def, /\bdefault\b/, `${q}.${c} must have no DEFAULT (UUIDv7 in app code)`); }
});
test('cross-schema references (01-CM §5 R3): engagement -> engagement / core / frontdesk only, identical target set to the spec; every target schema is in db/meta/dag.yaml for engagement; nothing in an upstream schema references engagement (AC-0B-6.2)', () => {
  const tgt = (sql) => new Set([...sql.matchAll(/\bREFERENCES\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
  const got = tgt(eSql()), exp = tgt(specDdl());
  for (const t of exp) got.has(t) || assert.fail(`FK target ${t} missing`);
  for (const t of [...got]) { assert.match(t, /^(engagement|core|frontdesk)\./, `engagement FK target ${t}`); exp.has(t) || assert.fail(`FK target ${t} is not in the spec`); }
  const dag = readFileSync(root + 'db/meta/dag.yaml', 'utf8'), m = /"engagement"\s*:\s*\[([^\]]*)\]/.exec(dag); assert.ok(m, 'dag.yaml row for engagement');
  const allowed = new Set([...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]).concat('engagement'));
  for (const t of got) assert.ok(allowed.has(t.split('.')[0]), `FK target ${t}: schema allowed by dag.yaml`);
  const upstream = files().filter((f) => !WAVE.test(f) || BEFORE.test(f));
  assert.doesNotMatch(upstream.map(read).join('\n'), /\bREFERENCES\s+engagement\./i, 'no FK into engagement from an upstream schema');
  assert.doesNotMatch(eSql(), /\bREFERENCES\s+(billing|lab|reporting|identity|instruments|analytics|catalog|quality|micro|anatomic|inventory|partners|smartreport|payments|homecollection)\./i);
});
test('indexes: every §3 CREATE INDEX present with identical definition, no other index; tenant_id leads every index and every UNIQUE / PRIMARY KEY except PRIMARY KEY (id), the natural-key PKs (which lead with tenant_id), G tables and the one documented exception queue_displays__token__uq UNIQUE (token_sha256) (§2.2 rule 9); every __p_ index is partial', () => {
  const sql = eSql(), have = new Map(createIndexes(sql).map((s) => [idxName(s), norm(s)]));
  const exp = createIndexes(specDdl());
  for (const s of exp) assert.equal(have.get(idxName(s)), norm(s), `index ${idxName(s)}`);
  assert.deepEqual([...have.keys()].filter((n) => !exp.some((s) => idxName(s) === n)), [], 'no index beyond the spec DDL');
  for (const [n, s] of have) if (/__p_(uq|idx)$/.test(n)) assert.match(s, /\bwhere\b/, `${n} is a partial index`);
  for (const s of createIndexes(sql)) assert.equal(/\bON\s+\w+\.\w+\s*(?:USING\s+\w+\s*)?\(\s*([^,)]+)/i.exec(s)[1].trim(), 'tenant_id', `index ${idxName(s)} leads with tenant_id`);
  for (const q of TENANT) for (const [cn, c] of createTable(sql, q).conMap) if (/\b(primary key|unique)\(/.test(c)) {
    const k = /\b(?:primary key|unique)\(([^)]*)\)/.exec(c)[1]; if (/primary key/.test(c) && k === 'id') continue;
    if (cn === 'queue_displays__token__uq') { assert.equal(k, 'token_sha256', 'the documented exception (pre-tenant resolver lookup, CR-C16-006)'); continue; }
    assert.equal(k.split(',')[0], 'tenant_id', `${q}: ${cn} ${c}`);
  }
  assert.ok(createTable(sql, 'engagement.queue_displays').conMap.has('queue_displays__token__uq'), 'the exception constraint exists');
});

// ================================================================ RLS + policies (AC-0B-2.1..2.4; 08 A2.3, A17 P-16, A19 P-41)
test('ENABLE + FORCE ROW LEVEL SECURITY as literal statements (no DO block / format(): check-migrations.ts and the policy tools read statements) on the 36 tenant tables; none on the 3 G tables; RLS never disabled (AC-0B-2.1/2.4)', () => {
  const sql = eSql() + '\n;\n' + polSql();
  for (const q of TENANT) for (const kw of ['ENABLE', 'FORCE']) assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+${kw}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${q}: ${kw} ROW LEVEL SECURITY`);
  for (const q of G_T) assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+${esc(q)}\\s+(ENABLE|FORCE)\\s+ROW`, 'i'), `${q} is RLS-exempt`);
  assert.doesNotMatch(sql, /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(eSql(), /\bDO\s+\$/i, 'literal statements only'); assert.doesNotMatch(polSql(), /\bDO\s+\$/i);
  assert.doesNotMatch(eSql() + polSql(), /EXECUTE\s+format\s*\(/i);
});
test('policies written out in the spec (§5.3 26 lims_app + §6.5 13 owner): present with identical name, command, role, USING and WITH CHECK (link_codes__delete__tenant additionally carries the NOT EXISTS link filter of the §5.3 note)', () => {
  const spec = policies(specAll()), got = gotPolicies(), byKey = new Map(got.map((p) => [p.key, p])); assert.ok(got.length > 0, 'db/policies/engagement.sql has no CREATE POLICY'); assert.equal(byKey.size, got.length, 'no duplicate policy');
  const flat = (x) => x.replace(/[()]/g, '');
  for (const e of spec) {
    const g = byKey.get(e.key); assert.ok(g, `missing policy ${e.key}`); assert.equal(g.cmd, e.cmd, `${e.key} command`); assert.equal(g.roles, e.roles, `${e.key} roles`);
    if (e.name === 'link_codes__delete__tenant') {
      assert.ok(flat(g.using).includes(flat(e.using)), `${e.key} USING contains the §5.3 text`);
      assert.match(g.using, /not exists\(select 1 from engagement\.account_patient_links l where l\.tenant_id=link_codes\.tenant_id and l\.link_code_id=link_codes\.id\)/, 'a code referenced by a link is kept (§5.3 note)');
    } else { assert.equal(g.using, e.using, `${e.key} USING`); assert.equal(g.check, e.check, `${e.key} WITH CHECK`); }
  }
});
test('policy matrix (§5.2): per (table, command) the lims_app policies are exactly the listed scopes (classified by predicate), one policy per scope; no policy where the cell is "—"; DELETE only on the 8 class E tables, system actor only, with the P-18(c) expiry predicates (24 h, 90 days, now(), expires_at IS NOT NULL); policy names <table>__<cmd>__<scope>; no policy on a G table; total = matrix + 13 owner', () => {
  const ps = gotPolicies(), ten = tenantPol(ps), own = ps.filter((p) => p.roles !== 'lims_app');
  assert.equal(ten.length, MX_COUNT, `lims_app policies: ${ten.length} vs matrix ${MX_COUNT}`); assert.equal(own.length, 13, 'owner policies'); assert.equal(ps.length, MX_COUNT + 13);
  for (const t of T_N) for (const k of ['S', 'I', 'U', 'D']) {
    const mine = ten.filter((p) => p.table === `engagement.${t}` && p.cmd === CMD[k]), exp = MX[t][k] ?? [];
    assert.ok(matchScopes(exp, mine.map(scopeOf)), `${t} ${CMD[k]}: expected scopes [${exp}] got [${mine.map((p) => `${p.name}:${scopeOf(p)}`)}]`);
    for (const p of mine) assert.match(p.name, new RegExp(`^${t}__${CMD[k].toLowerCase()}__[a-z_]+$`), `${p.key}: name <table>__<cmd>__<scope>`);
  }
  for (const p of ten) assert.ok(T_N.includes(p.table.split('.')[1]), `${p.key}: policy on a G table`);
  assert.equal(ten.filter((p) => p.cmd === 'ALL').length, 0, 'no FOR ALL policy');
  const del = ten.filter((p) => p.cmd === 'DELETE'); assert.equal(del.length, 8);
  for (const p of del) { assert.match(`${p.using}`, /current_actor_type\(\)\)='system'/, `${p.key}: system actor only`); assert.match(p.using, /is_staff_or_system/); }
  const d = (t) => del.find((p) => p.table === `engagement.${t}`).using;
  assert.match(d('otp_challenges'), /expires_at<now\(\)-interval '24 hours'/); assert.match(d('link_codes'), /expires_at<now\(\)-interval '90 days'/); assert.match(d('notifications'), /expires_at<now\(\)/); assert.match(d('number_counters'), /expires_at is not null and expires_at<now\(\)/);
});
test('policy shape (§5.1, 08 A17 P-16, A16.1): every lims_app policy carries the tenant predicate; STAFF / STAFF_C / SYS predicates carry app.is_staff_or_system(); STAFF / STAFF_C list user + system (never device / patient); centre predicates use the ::uuid[] cast; patient / pre-auth / display predicates never admit staff; no true / PUBLIC / anon; the owner policies are TO lims_owner only, no USING (true)', () => {
  const ps = gotPolicies(), ten = tenantPol(ps), own = ps.filter((p) => p.roles !== 'lims_app');
  for (const p of ten) {
    const t = `${p.using} ${p.check}`, s = scopeOf(p);
    assert.notEqual(s, '?', `${p.key}: classifiable predicate`); assert.doesNotMatch(s, /\?$/, `${p.key}: classifiable patient predicate`);
    assert.match(t, /tenant_id=\(select app\.current_tenant_id\(\)\)/, `${p.key}: tenant predicate`);
    assert.doesNotMatch(t, /\btrue\b\s*$|\bpublic\b|\banon\b|\bauthenticated\b|current_partner_id|current_patient_id/, `${p.key}: no open predicate`);
    if (STAFFSET.has(s)) assert.match(t, /\(select app\.is_staff_or_system\(\)\)/, `${p.key}: P-16 staff guard`);
    if (PATSET.has(s) || s === 'DISP') assert.doesNotMatch(t, /current_actor_type\(\)\)in\('user','system'\)|current_actor_type\(\)\)='system'/, `${p.key}: actor policy never admits staff`);
    if (s === 'STAFF' || s === 'STAFF_C') assert.match(t, /current_actor_type\(\)\)in\('user','system'\)/, `${p.key}: positive actor list (08 A19 D-109)`);
    if (s === 'STAFF_C') assert.match(t, /\(select app\.has_all_centres\(\)\)or centre_id=any\(\(select app\.current_centre_ids\(\)\)::uuid\[\]\)/, `${p.key}: centre predicate with the A16.1 cast`);
    if (s === 'DISP') assert.match(t, /device_kind'\)='queue_display'/, `${p.key}: display kind claim`), assert.match(t, /centre_id=any\(\(select app\.current_centre_ids\(\)\)::uuid\[\]\)/);
    if (s === 'PRE_TOK') assert.match(t, /token_sha256=\(select decode\(app\.current_claims\(\)->>'otp_token_sha256','hex'\)\)/, `${p.key}: PRE_TOK token claim`);
  }
  assert.ok(ten.some((p) => scopeOf(p) === 'DISP' && /\bid=app\.current_actor_id\(\)/.test(p.using)), 'queue_displays: DISP policy limited to id = app.current_actor_id()');
  for (const p of own) { assert.equal(p.roles, 'lims_owner', `${p.key} TO lims_owner`); assert.doesNotMatch(`${p.using} ${p.check}`, /\btrue\b\s*$|^true$/, `${p.key}: no open predicate`); assert.match(p.name, /^[a-z_]+__(select|update|delete)__owner_only$/); }
  assert.deepEqual(own.map((p) => p.name).sort(), ['account_patient_links__select__owner_only', 'account_patient_links__update__owner_only', 'accounts__select__owner_only', 'link_codes__select__owner_only', 'link_codes__update__owner_only', 'otp_challenges__select__owner_only', 'payment_requests__delete__owner_only',
    'payment_requests__select__owner_only', 'queue_day_counters__delete__owner_only', 'queue_day_counters__select__owner_only', 'queue_displays__select__owner_only', 'queue_tokens__delete__owner_only', 'queue_tokens__select__owner_only'].sort(), 'the 13 §6.5 owner policies, no more (08 A12.2: no purge DEFINER for non-E rows beyond these two)');
  for (const t of ['otp_challenges', 'queue_displays']) assert.match(own.find((p) => p.name === `${t}__select__owner_only`).using, /^token_sha256=decode\(current_setting\('app\.pre_engagement_(otp|display)_token_sha256',true\),'hex'\)$/, `${t}: pre-tenant GUC owner policy, no other disjunct`);
  for (const p of own.filter((x) => /^(payment_requests|queue_tokens|queue_day_counters)__/.test(x.name))) assert.match(p.using, /current_setting\('app\.maintenance',true\)='engagement_purge_(payment_requests|queue)'/, `${p.key}: maintenance GUC gate`);
});
test('policies written literally in migrations are identical to db/policies/engagement.sql (AC-0B-2.3 copy), including the 13 owner policies; every policy of the file is created by a migration and vice versa', () => {
  const inFile = new Map(policies(polSql()).map((p) => [p.key, p.text]));
  const inMig = policies(eSql()).filter((x) => x.table.startsWith('engagement.') && !/\.event_inbox$/.test(x.table));
  assert.ok(inMig.length > 0, 'policies must be created in the migrations (the policy file is a copy)');
  for (const p of inMig) assert.equal(norm(inFile.get(p.key) ?? ''), norm(p.text), p.key);
  assert.deepEqual(inMig.map((p) => p.key).sort(), gotPolicies().map((p) => p.key).sort());
});

// ================================================================ grants (AC-0B-4.2 / 4.3; §1 "Grants to lims_app" column parsed from the spec, §5.3 GRANT statements)
test('grants equal §1: lims_app SELECT / INSERT / UPDATE / DELETE exactly as the §1 column says (DELETE only on the 8 class E tables, S only on the 3 G tables); no TRUNCATE / REFERENCES / TRIGGER, no column grants, nothing to other roles; the 2 views SELECT to lims_app only', () => {
  const sql = eSql() + '\n;\n' + polSql(), g = grantsOf(sql), inv = inventory();
  const privs = (q, r) => [...(g.get(q)?.get(r)?.all ?? [])].sort();
  for (const t of [...T_N, ...G_N]) assert.deepEqual(privs(`engagement.${t}`, 'lims_app'), inv.get(t).grants.map((x) => PRIV[x]).sort(), `engagement.${t} lims_app`);
  for (const [q, rm] of g) if (/^engagement\./.test(q)) {
    assert.ok(new Set([...ALLT, ...VIEWS]).has(q), `${q}: unexpected grant target`);
    for (const [r, p] of rm) {
      assert.equal(r, 'lims_app', `${q}: unexpected grantee ${r}`);
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']) assert.ok(!p.all.has(bad) && !p.cols.has(bad), `${q}: ${r} must not hold ${bad}`);
      assert.equal(p.cols.size, 0, `${q}: whole-table grants only`);
      if (VIEWS.includes(q)) assert.deepEqual([...p.all], ['SELECT'], `${q}: SELECT only`);
    }
  }
  for (const v of VIEWS) assert.ok(g.get(v)?.get('lims_app')?.all.has('SELECT'), `GRANT SELECT ON ${v} TO lims_app`);
  assert.doesNotMatch(sql, /GRANT\s+ALL\b[^;]*\bengagement\./i); assert.doesNotMatch(sql, /GRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+engagement\b/i); assert.doesNotMatch(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bengagement\b/i);
  for (const s of stmts(sql).map(ws)) if (/^GRANT\b/i.test(s) && /\bengagement\./i.test(s) && !/\bFUNCTION\b/i.test(s)) assert.doesNotMatch(s, /\bTO\b[^;]*\b(PUBLIC|anon|authenticated|service_role|lims_api|lims_worker|lims_owner|lims_analytics)\b/i, s);
});

// ================================================================ functions + triggers (AC-0B-4.1; §3, §4, §6; §6.6 tests 1-6)
const specFns = () => specAll();
test('the 3 INVOKER trigger functions: settings_consent_version_guard and guard_patient_link_update equal the spec text; guard_actor_columns keeps its contract (TG_ARGV[0] actor, P0001 immutable_row, jsonb diff; the TG_ARGV[1:] slice may be expressed as a loop, §4 note); all SECURITY INVOKER with search_path = \'\' (no inventory entry, 04 D7); SQLSTATE per CV §5.7', () => {
  const sql = eSql(), exp = specFns();
  for (const f of ['engagement.settings_consent_version_guard', 'engagement.guard_patient_link_update']) {
    const got = fnText(sql, f); assert.ok(got, `${f} missing (05-SCHEMA §3 / §4)`); assert.equal(norm(got), norm(fnText(exp, f)), `${f}: text equals the spec`);
    assert.match(got, /SET\s+search_path\s*=\s*''/i); assert.doesNotMatch(got, /SECURITY\s+DEFINER/i, `${f}: SECURITY INVOKER`);
  }
  assert.match(fnText(sql, 'engagement.settings_consent_version_guard'), /ERRCODE\s*=\s*'23514'[\s\S]*MESSAGE\s*=\s*'consent_version_required'/);
  assert.match(fnText(sql, 'engagement.guard_patient_link_update'), /current_user\s*<>\s*'lims_owner'/, 'the DEFINER bypass is the function owner, not a GUC (§4)');
  const g = fnText(sql, 'engagement.guard_actor_columns'); assert.ok(g, 'engagement.guard_actor_columns missing');
  assert.match(g, /SET\s+search_path\s*=\s*''/i); assert.doesNotMatch(g, /SECURITY\s+DEFINER/i); assert.match(g, /ERRCODE\s*=\s*'P0001'/); assert.match(g, /MESSAGE\s*=\s*'immutable_row'/); assert.match(g, /TG_ARGV\s*\[\s*0\s*\]/); assert.match(g, /to_jsonb\s*\(\s*OLD\s*\)/); assert.match(g, /to_jsonb\s*\(\s*NEW\s*\)/); assert.match(g, /app\.current_actor_type\(\)/);
});
test('the DEFINER functions: the 7 new ones equal the spec text verbatim (§6.1 / §6.3 / §6.4), each SECURITY DEFINER, VOLATILE where it writes or sets a GUC, search_path = \'\', REVOKE ALL FROM PUBLIC, EXECUTE only to the §6.6 role, OWNER lims_owner; the 3 helper DEFINERs and app.engagement_preauth_stage, if re-created here, equal the spec text; no function beyond the spec set', () => {
  const sql = eSql(), exp = specFns(), st = stmts(sql).map(ws);
  for (const f of DEF_NEW) {
    const got = fnText(sql, f); assert.ok(got, `${f} missing (05-SCHEMA §6)`); assert.equal(norm(got), norm(fnText(exp, f)), `${f}: text equals the spec`);
    assert.match(got, /SECURITY\s+DEFINER/i, `${f}: SECURITY DEFINER`); assert.match(got, /SET\s+search_path\s*=\s*''/i, `${f}: search_path = ''`);
    const sig = `${f.replace('.', '\\.')}\\(${SIG[f].replace(/,\s*/g, ',\\s*')}\\)`, rx = (kw) => new RegExp(`^${kw}`, 'i');
    assert.ok(st.some((s) => new RegExp(`^REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${sig}\\s+FROM\\s+PUBLIC$`, 'i').test(s)), `${f}: REVOKE ALL ... FROM PUBLIC`);
    assert.deepEqual(st.filter((s) => rx('GRANT').test(s) && new RegExp(`\\b${f.replace('.', '\\.')}\\b`, 'i').test(s)).map((s) => /\bTO\s+(.+)$/i.exec(s)[1].replace(/\s+/g, '').split(',').sort().join(',')), [EXEC[f].join(',')], `${f}: EXECUTE to ${EXEC[f]} only (§6.6)`);
    for (const s of st.filter((x) => /^ALTER\s+FUNCTION\b/i.test(x) && x.includes(f.split('.')[1]))) assert.match(s, /\bOWNER\s+TO\s+lims_owner$/i);
  }
  for (const f of ['app.engagement_resolve_preauth', 'app.engagement_resolve_display']) {
    const got = fnText(sql, f); assert.match(got, /VOLATILE/i, `${f}: VOLATILE (set_config)`); assert.match(got, /octet_length\(p_token_sha256\)\s*<>\s*32/); assert.match(got, /set_config\('app\.pre_tenant_id',\s*'',\s*true\)/, `${f}: app.pre_tenant_id reset before return (§6.6 test 4c)`);
    assert.match(got, new RegExp(`set_config\\('app\\.pre_engagement_${f.endsWith('preauth') ? 'otp' : 'display'}_token_sha256',\\s*'',\\s*true\\)`), `${f}: GUC reset to '' before return`);
  }
  for (const f of ['engagement.purge_payment_requests', 'engagement.purge_queue']) { const got = fnText(sql, f); assert.match(got, /purge_requires_system_tenant_claims/); assert.match(got, /set_config\('app\.maintenance',\s*'',\s*true\)/, `${f}: app.maintenance reset (§6.6 test 5)`); }
  for (const f of [...HELPERS, 'app.engagement_preauth_stage']) { const got = fnText(sql, f); if (got) assert.equal(norm(got), norm(fnText(exp, f)), `${f}: re-created text equals the spec (CREATE OR REPLACE, C0 helpers stage)`); }
  const allowed = new Set([...FN_INV, ...HELPERS, ...DEF_NEW, 'app.engagement_preauth_stage']);
  assert.deepEqual(fnNames(sql).filter((n) => !allowed.has(n)), [], 'no function beyond the spec (audit / generic helpers are C0\'s)');
  assert.equal([...sql.matchAll(/SECURITY\s+DEFINER/gi)].length >= 7, true);
  assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+app\.(?!engagement_)/i, 'only app.engagement_* helpers are created in schema app');
  assert.equal(fnNames(sql).includes('app.engagement_resolve_tenant_code'), false, 'removed by D-121 (resolved by C0 app.core_resolve_tenant_code)');
});
test('triggers: the 7 non-audit §3 / §4 triggers equal the spec statements (settings consent version, 3 mutable-column triggers on account_patient_links / bookings / queue_tokens, 3 actor guards); nothing else besides the audit triggers; none disabled or dropped; app.enforce_mutable_columns is the C0 function; guards are BEFORE UPDATE FOR EACH ROW', () => {
  const sql = eSql(), all = createTriggers(sql), trg = all.filter((s) => !isAudit(s)), exp = createTriggers(specAll()).filter((s) => !isAudit(s));
  assert.equal(exp.length, 7);
  for (const s of exp) { const hit = trg.find((x) => trgName(x) === trgName(s)); assert.ok(hit, `trigger ${trgName(s)} missing`); assert.equal(norm(hit), norm(s), `trigger ${trgName(s)}`); }
  assert.deepEqual(trg.map(trgName).sort(), [...TG_NAMES].sort(), 'no trigger beyond the spec (audit aside)');
  assert.doesNotMatch(sql, /\b(DISABLE|ENABLE\s+REPLICA|ENABLE\s+ALWAYS)\s+TRIGGER\b/i); assert.doesNotMatch(sql, /DROP\s+TRIGGER\b/i);
  for (const n of TG_NAMES) assert.match(trg.find((s) => trgName(s) === n), /\bBEFORE UPDATE ON engagement\.\w+ FOR EACH ROW EXECUTE FUNCTION (app\.enforce_mutable_columns|engagement\.\w+)\(/i, `${n}: BEFORE UPDATE FOR EACH ROW`);
  const args = (n) => [...trg.find((s) => trgName(s) === n).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(!args('bookings__mutable_columns').some((c) => ['tenant_id', 'id', 'account_id', 'patient_id', 'slot_start', 'slot_end', 'centre_id', 'booking_no', 'created_via'].includes(c)), 'booking identity / slot / owner columns stay immutable (§2.2 rule 7)');
  assert.ok(!args('account_patient_links__mutable_columns').some((c) => ['account_id', 'patient_id', 'tenant_id', 'id'].includes(c)), 'account_id and patient_id never change (§3)');
  assert.deepEqual(args('slot_occupancy__patient_guard'), ['patient', 'booked', 'version', 'updated_at', 'updated_by']); assert.deepEqual(args('queue_displays__device_guard'), ['device', 'last_seen_at', 'updated_at', 'updated_by']);
});
test('audit triggers (app.tg_row_audit, AC-0B-5.x; C0 §2 default: every class M and C table is audited, A and E are not): <t>__audit AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW on the 22 M / C tables; never on class A / E / G; the Secret columns of §10 on audited tables (queue_displays.token_sha256, patient_memberships.card_token, payment_requests.action_json) are in the excluded-column list; any listed column exists', () => {
  const trg = createTriggers(eSql()).filter(isAudit), onTable = (q) => trg.filter((s) => new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  assert.equal(AUDIT_REQ.length, 22);
  for (const q of AUDIT_REQ) {
    const hit = onTable(q); assert.equal(hit.length, 1, `${q} audit trigger`);
    assert.match(hit[0], new RegExp(`TRIGGER\\s+${q.split('.')[1]}__audit\\s+AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${esc(q)}\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+app\\.tg_row_audit\\(`, 'i'), q);
    const a = [...(/tg_row_audit\(([^)]*)\)/i.exec(hit[0])[1].matchAll(/'([a-z_0-9]+)'/g))].map((m) => m[1]), cols = createTable(eSql(), q).colNames;
    for (const c of a) assert.ok(cols.includes(c), `${q}: excluded column ${c} exists`);
    for (const c of AUDIT_ARGS[q] ?? []) assert.ok(a.includes(c), `${q}: Secret column ${c} excluded from audit_log (§10 never logged)`);
  }
  for (const t of T_N.filter((x) => !['M', 'C'].includes(CLS[x]))) assert.equal(onTable(`engagement.${t}`).length, 0, `engagement.${t} (class ${CLS[t]}) must NOT be audited`);
  for (const q of G_T) assert.equal(onTable(q).length, 0, `${q} must NOT be audited`);
  assert.equal(trg.length, 22, 'no audit trigger beyond the 22');
});

// ================================================================ DEFINER inventory (08 A12.1, A12.7, A19 P-41; §6.6)
test('db/meta/definer-inventory.yaml: the 3 helper rows stay; 7 rows added for the new DEFINERs (owner lims_owner, execute per §6.6, why, touches, policies incl. the maintenance GUC for the purges, reviewer field); every listed engagement owner policy exists in db/policies/engagement.sql; exactly 10 engagement rows; the migrations create exactly the 7 new DEFINERs (+ the helper re-creation, if any)', () => {
  const inv = JSON.parse(readFileSync(root + 'db/meta/definer-inventory.yaml', 'utf8').replace(/^\s*#.*$/gm, '')).definers;
  assert.deepEqual(Object.keys(inv).filter((k) => /engagement/.test(k)).sort(), Object.keys(EXEC).sort(), 'exactly the 10 engagement DEFINER rows');
  const T = { 'app.engagement_redeem_link_code': ['engagement.link_codes UPDATE', 'engagement.accounts SELECT', 'engagement.account_patient_links SELECT', 'engagement.account_patient_links UPDATE'],
    'app.engagement_apply_report_link': ['engagement.account_patient_links SELECT', 'engagement.account_patient_links UPDATE', 'engagement.accounts SELECT'], 'app.engagement_code_redeemed_by_me': ['engagement.link_codes SELECT'],
    'app.engagement_resolve_preauth': ['engagement.otp_challenges SELECT', 'core.tenants SELECT'], 'app.engagement_resolve_display': ['engagement.queue_displays SELECT', 'core.tenants SELECT'],
    'engagement.purge_payment_requests': ['engagement.payment_requests SELECT', 'engagement.payment_requests DELETE'], 'engagement.purge_queue': ['engagement.queue_tokens SELECT', 'engagement.queue_tokens DELETE', 'engagement.queue_day_counters SELECT', 'engagement.queue_day_counters DELETE'] };
  const P = { 'app.engagement_redeem_link_code': ['link_codes__select__owner_only', 'link_codes__update__owner_only', 'accounts__select__owner_only', 'account_patient_links__select__owner_only', 'account_patient_links__update__owner_only'],
    'app.engagement_apply_report_link': ['account_patient_links__select__owner_only', 'account_patient_links__update__owner_only', 'accounts__select__owner_only'], 'app.engagement_code_redeemed_by_me': ['link_codes__select__owner_only'],
    'app.engagement_resolve_preauth': ['otp_challenges__select__owner_only', 'app.pre_engagement_otp_token_sha256'], 'app.engagement_resolve_display': ['queue_displays__select__owner_only', 'app.pre_engagement_display_token_sha256'],
    'engagement.purge_payment_requests': ['payment_requests__select__owner_only', 'payment_requests__delete__owner_only', 'engagement_purge_payment_requests'], 'engagement.purge_queue': ['queue_tokens__select__owner_only', 'queue_tokens__delete__owner_only', 'queue_day_counters__select__owner_only', 'queue_day_counters__delete__owner_only', 'engagement_purge_queue'] };
  for (const [f, ex] of Object.entries(EXEC)) {
    const r = inv[f]; assert.ok(r, `${f} row`); assert.equal(r.owner, 'lims_owner', `${f} owner`); assert.deepEqual(r.execute, ex, `${f} execute`); assert.ok(String(r.why ?? '').length > 10, `${f} why`); assert.ok('reviewer' in r, `${f} reviewer field`);
    for (const x of T[f] ?? []) assert.ok(JSON.stringify(r.touches).includes(x), `${f} touches ${x}`);
    for (const x of P[f] ?? []) assert.ok(JSON.stringify(r.policies).includes(x), `${f} policies ${x}`);
  }
  const names = new Set(policies(polSql()).map((p) => p.name));
  for (const [f, r] of Object.entries(inv)) if (/engagement/.test(f)) for (const n of r.policies) if (/^[a-z_]+__owner_only$/.test(n) && n !== 'memberships__select__owner_only' && n !== 'tenants__select__owner_only') assert.ok(names.has(n), `${f}: ${n} exists in db/policies/engagement.sql`);
  const made = [...eSql().matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)[^$]*?SECURITY\s+DEFINER/gi)].map((m) => m[1]).filter((n) => !HELPERS.includes(n)).sort();
  assert.deepEqual(made, [...DEF_NEW].sort(), 'the migrations create exactly the 7 new DEFINER functions');
  for (const [k, e] of Object.entries(inv)) if (!/engagement/.test(k)) assert.doesNotMatch(JSON.stringify(e.touches ?? []), /engagement\./, `${k}: no foreign DEFINER touches engagement`);
});

// ================================================================ registry (db/meta/tables.yaml)
const tablesYaml = () => JSON.parse(readFileSync(root + 'db/meta/tables.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).tables;
const MAND = { M: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'is_active'], C: ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version'], A: ['id', 'tenant_id', 'created_at', 'created_by'], E: ['id', 'tenant_id', 'created_at', 'expires_at'] };
const P3 = ['booking_items.orderable_id', 'patient_reports.panel_names', 'smart_summaries.summary', 'enquiries.subject', 'enquiry_messages.body'];
const P2 = ['accounts.phone_e164', 'otp_challenges.phone_e164', 'addresses.contact_phone_e164', 'account_patient_links.display_name', 'link_codes.display_name_snapshot', 'self_registrations.full_name', 'bookings.booking_no', 'patient_memberships.card_no', 'link_codes.bound_phone_last2'];
const SECRET = ['otp_challenges.code_hmac', 'otp_challenges.code_ciphertext', 'otp_challenges.token_sha256', 'link_codes.code_hmac', 'queue_displays.token_sha256', 'patient_memberships.card_token', 'payment_requests.action_json'];
const P0_T = ['slot_templates', 'slot_blackouts', 'slot_occupancy', 'queue_definitions', 'queue_counters', 'queue_day_counters', 'queue_tokens', 'membership_plans', 'bookable_items', 'booking_centres', 'cs_booking_cancel_reasons', 'cs_reminder_reasons', 'cs_enquiry_categories', ...G_N];
function settingsPhi() { const out = []; for (const l of specSec('### 2.1', '### 2.2').split('\n').filter((x) => x.startsWith('| '))) { const c = l.split('|').map((x) => x.trim()), p = c[c.length - 2]; if (!/^P[0-3]$/.test(p ?? '')) continue; for (const n of c[1].split(',').map((x) => x.trim())) if (/^[a-z][a-z0-9_]*$/.test(n)) out.push([n, p]); } return out; }
test('tables.yaml: all 39 engagement tables registered (class per §1, centre_scoped = the STAFF_C policies of the matrix, audited = trigger (M / C), retention, shared_with [patient] on every table with a PAT_* / PRE* policy and none elsewhere (ANY_T-only tables may add it), columns = the migration columns, phi_class P0..P3); the count equals the CREATE TABLE count; event_inbox entry untouched', () => {
  const y = tablesYaml(), regs = Object.keys(y).filter((k) => /^engagement\./.test(k) && !/\.event_inbox$/.test(k));
  assert.equal(regs.length, 39, 'tables.yaml engagement entries (ex event_inbox)'); assert.equal(regs.length, [...specDdl().matchAll(/CREATE\s+TABLE\s+\w+\.\w+/gi)].length, 'tables.yaml count == chunk DDL count (39 == 39)');
  const trgAudited = (q) => createTriggers(eSql()).some((s) => isAudit(s) && new RegExp(`\\bON\\s+${esc(q)}\\s`, 'i').test(s));
  for (const q of ALLT) {
    const e = y[q], t = q.split('.')[1]; assert.ok(e && createTable(eSql(), q), `${q} in tables.yaml and migrations`);
    assert.equal(e.class, isG(q) ? 'G' : CLS[t], `${q} class (§1)`);
    assert.equal(e.centre_scoped, isG(q) ? false : [...scopesOf(t)].includes('STAFF_C'), `${q} centre_scoped (= has a STAFF_C policy)`);
    assert.equal(e.audited, trgAudited(q), `${q} audited must match the audit trigger`); assert.equal(e.audited, AUDIT_REQ.includes(q), `${q} audited (M and C tables only)`);
    assert.ok(typeof e.retention === 'string' && e.retention.length > 3, `${q} retention`);
    assert.deepEqual(Object.keys(e.columns).sort(), [...colsOf(eSql(), q).colNames.map((c) => c.replace(/"/g, ''))].sort(), `${q} columns = migration columns`);
    for (const [c, p] of Object.entries(e.columns)) assert.match(p, /^P[0-3]$/, `${q}.${c} phi_class`);
    const sw = [...(e.shared_with ?? [])], pat = !isG(q) && [...scopesOf(t)].some((s) => PATSET.has(s)), any = !isG(q) && scopesOf(t).has('ANY_T');
    if (pat) assert.deepEqual(sw, ['patient'], `${q}: shared_with [patient] (§5.1: tables with a PAT_* / PRE* policy)`);
    else if (any) assert.ok(sw.length === 0 || (sw.length === 1 && sw[0] === 'patient'), `${q}: ANY_T-only table, shared_with [] or [patient]`);
    else assert.deepEqual(sw, [], `${q}: shared_with empty`);
  }
  assert.ok(y['engagement.event_inbox'].class === 'A', 'inbox entry remains as C0 wrote it'); assert.deepEqual(y['engagement.event_inbox'].shared_with ?? [], []);
});
test('tables.yaml phi_class (§2.1, §10): every settings column P0 (the §2.1 rows); the 5 P3 and 9 P2 columns of §10 registered at exactly that class; the Secret columns at P1 or higher (never P0); the P0 tables (templates, blackouts, occupancy, queues, counters, tokens, plans, coded sets, bookable items, booking centres) hold no P2 / P3; created_by / updated_by are P1', () => {
  const y = tablesYaml(), rows = settingsPhi(); assert.ok(rows.length >= 28, `parsed §2.1 settings rows: ${rows.length}`);
  for (const [c, p] of rows) assert.equal(y['engagement.settings'].columns[c], p, `settings.${c} = ${p} (§2.1)`);
  for (const k of P3) { const [t, c] = k.split('.'); assert.equal(y[`engagement.${t}`].columns[c], 'P3', `${k}: P3 (§10)`); }
  for (const k of P2) { const [t, c] = k.split('.'); assert.equal(y[`engagement.${t}`].columns[c], 'P2', `${k}: P2 (§10)`); }
  for (const k of SECRET) { const [t, c] = k.split('.'); assert.match(y[`engagement.${t}`].columns[c] ?? '', /^P[1-3]$/, `${k}: Secret column registered above P0`); }
  for (const t of P0_T) for (const [c, p] of Object.entries(y[`engagement.${t}`].columns)) assert.match(p, /^P[01]$/, `engagement.${t}.${c}: P0 table holds no P2 / P3`);
  for (const q of ALLT) for (const c of ['created_by', 'updated_by']) if (y[q].columns[c]) assert.equal(y[q].columns[c], 'P1', `${q}.${c}`);
});
test('tables.yaml: rls_exempt only on the 3 G tables (with a reason); mandatory_column_exceptions = exactly the class-mandatory columns the DDL lacks (copied from the §1 paragraph, P-18(b)) with a reason, each omitted column really absent; the §1 named exceptions hold (read models and counters have no id; booking_centres / smart_summaries / read models no expires_at); every other table carries all of them', () => {
  const y = tablesYaml();
  for (const q of ALLT) {
    assert.ok(y[q] && createTable(eSql(), q), `${q} in tables.yaml and in the migrations`);
    const e = y[q], cols = new Set(colsOf(eSql(), q).colNames);
    if (isG(q)) { assert.ok(e.rls_exempt && String(e.rls_exempt).length > 3, `${q} rls_exempt reason`); assert.deepEqual([...(e.mandatory_column_exceptions ?? [])], [], `${q}: G tables carry no exception (as every other g_cs_*)`); assert.ok(!cols.has('tenant_id')); continue; }
    assert.ok(!e.rls_exempt, `${q} must not be rls_exempt`);
    const cls = CLS[q.split('.')[1]], missing = MAND[cls].filter((c) => !cols.has(c)).sort(), got = [...(e.mandatory_column_exceptions ?? [])].sort();
    assert.deepEqual(got, missing, `${q}: mandatory_column_exceptions must list exactly the missing class-${cls} columns`);
    if (got.length) assert.ok(String(e.mandatory_column_exceptions_reason ?? '').length > 5, `${q}: mandatory_column_exceptions_reason`);
    for (const c of got) assert.ok(!cols.has(c), `${q}: omitted column ${c} must really be absent`);
  }
  const exc = (t) => [...(y[`engagement.${t}`].mandatory_column_exceptions ?? [])];
  for (const t of ['patient_orders', 'patient_order_specimens', 'patient_reports', 'queue_day_counters', 'number_counters']) assert.ok(exc(t).includes('id'), `${t}: natural-key PK, no id (§1)`);
  for (const t of ['patient_orders', 'patient_order_specimens', 'patient_reports', 'smart_summaries', 'booking_centres']) assert.ok(exc(t).includes('expires_at'), `${t}: no expires_at (§1)`);
  for (const t of ['settings', 'accounts', 'bookings', 'queue_tokens', 'bookable_items']) assert.deepEqual(exc(t), [], `${t}: carries every mandatory column`);
});
test('tables.yaml retention (§9): otp_challenges expiry + 24 h, link_codes expired + 90 days, notifications 180 days, payment_requests terminal + 90 days, queue_tokens / queue_day_counters 1 year, read models while a link exists, booking_centres never deleted, bookings / links / consents ... tenant retentionYears, number_counters rate keys expire; event_inbox 90 days', () => {
  const y = tablesYaml(), r = (q) => { const e = y[`engagement.${q}`]; assert.ok(e, `engagement.${q} in tables.yaml`); return String(e.retention); };
  assert.match(r('otp_challenges'), /24 ?h/i); assert.match(r('link_codes'), /90 days/); assert.match(r('notifications'), /180 days/); assert.match(r('payment_requests'), /90 days/);
  assert.match(r('queue_tokens'), /1 year|365|one year/i); assert.match(r('queue_day_counters'), /1 year|365|one year/i);
  for (const q of ['patient_orders', 'patient_order_specimens', 'patient_reports', 'smart_summaries']) assert.match(r(q), /link|patient/i, `${q}: while a link to the patient exists`);
  assert.match(r('booking_centres'), /never|deactivat|kept/i); assert.match(r('number_counters'), /expir|rate/i);
  for (const q of ['bookings', 'booking_items', 'booking_transitions', 'link_consents', 'accounts', 'account_patient_links', 'reminders', 'patient_memberships', 'enquiries', 'enquiry_messages', 'addresses', 'self_registrations']) assert.match(r(q), /retentionYears|5 years|tenant|B15|kept/i, `${q}: tenant retention`);
  for (const q of ['settings', 'slot_templates', 'slot_blackouts', 'slot_occupancy', 'bookable_items', 'queue_definitions', 'queue_counters', 'queue_displays', 'membership_plans', 'cs_booking_cancel_reasons', 'cs_reminder_reasons', 'cs_enquiry_categories', ...G_N]) assert.ok(r(q).length > 3, `${q} retention text`);
  assert.match(y['engagement.event_inbox'].retention, /90 days/); assert.match(specSec(S9, S10), /not built in v1/);
});
test('db/tests/rls_exempt.txt lists exactly the 3 engagement G tables with a reason (AC-0B-2.1)', () => {
  const lines = readFileSync(root + 'db/tests/rls_exempt.txt', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cl = lines.filter((l) => /^engagement\./.test(l));
  assert.deepEqual(cl.map((l) => l.split(/\s+/)[0]).sort(), [...G_T].sort());
  for (const l of cl) assert.ok(l.split(/\s+/).slice(1).join(' ').length > 5, `reason: ${l}`);
});

// ================================================================ seeds (§8: 14 coded-set rows; nothing else)
function seedSpec() {   // §8 table -> ["g_set|code|display"]
  const out = [];
  for (const l of specSec(S8, S9).split('\n').filter((x) => /^\| `g_cs_/.test(x))) {
    const c = l.split('|').map((x) => x.trim()), set = c[1].replace(/`/g, ''), cell = c[2].split(/ — /)[0];
    for (const m of cell.matchAll(/`([a-z_]+)` \(([^)]+)\)/g)) out.push(`${set}|${m[1]}|${m[2]}`);
  }
  return out;
}
const lit = (v) => /^'(.*)'$/.exec(v)?.[1];
test('seed rows: the 3 g_cs_* tables hold exactly the 14 §8 rows (code + display verbatim, sort_order present and distinct per set, column list named, VALUES form); NOTHING else is inserted (no settings, no account, no tenant data: fixtures are packages/test-fixtures, §8)', () => {
  const sql = eSql(), got = [];
  for (const t of G_N) {
    const rows = insertRows(sql, `engagement.${t}`); assert.ok(rows.length > 0, `${t}: seeded`);
    for (const k of ['code', 'display', 'sort_order']) assert.ok(k in rows[0], `${t}: seed column list names ${k}`);
    const so = rows.map((r) => r.sort_order); assert.equal(new Set(so).size, so.length, `${t}: sort_order distinct`);
    for (const r of rows) { assert.match(lit(r.code) ?? '', /^[a-z0-9_]{1,64}$/); got.push(`${t}|${lit(r.code)}|${lit(r.display)}`); }
  }
  assert.deepEqual(got.sort(), seedSpec().sort(), 'seed = §8 (set, code, display)'); assert.equal(got.length, 14);
  const tables = [...new Set(stmts(sql).map(ws).filter((s) => /^INSERT\s+INTO\b/i.test(s)).map((s) => /INTO\s+(\S+)/i.exec(s)[1]))].sort();
  assert.deepEqual(tables, [...G_T].sort(), 'no other INSERT in the engagement migrations');
});

// ================================================================ views (IC §6; §7; AC-0B-6.4 column contract)
const viewSql = (sql, v) => { const s = stmts(sql).find((x) => new RegExp(`^CREATE\\s+(OR\\s+REPLACE\\s+)?VIEW\\s+${esc(v)}\\b`, 'i').test(ws(x))); return s ? ws(s) : null; };
const selectCols = (v) => {                      // the select list between the first SELECT and the last " FROM engagement." (a FROM inside extract(...) is nested)
  const a = /\bAS\s+SELECT\s+/i.exec(v), b = v.lastIndexOf(' FROM engagement.'); assert.ok(a && b > a.index, 'view shape');
  return splitTop(v.slice(a.index + a[0].length, b)).map((it) => { const m = /\bAS\s+(\w+)\s*$/i.exec(it.trim()); return m ? m[1] : it.trim().split('.').pop(); });
};
const icCols = (v) => {
  const ic = readFileSync(repo + 'spec/program/03-INTERFACE-CATALOG.md', 'utf8').replace(/\r\n?/g, '\n'), row = ic.split('\n').find((l) => l.startsWith(`| \`${v}\``)); assert.ok(row, `IC row of ${v}`);
  return splitTop(row.split('|')[2]).map((c) => /^\s*`?(\w+)/.exec(c)[1]);
};
test('view column contract vs IC §6 (AC-0B-6.4): v_pub_booking_daily and v_pub_queue_daily have exactly the IC columns in order (IC, spec §7 and the migration agree); definitions equal §7; WITH (security_invoker = true); SELECT to lims_app only; no other view; the CR-C16-012 address / membership views are not created (08 R25)', () => {
  const sql = eSql(), exp = specAll();
  assert.deepEqual(icCols('engagement.v_pub_booking_daily'), ['tenant_id', 'centre_id', 'business_date', 'booking_kind', 'created_via', 'bookings', 'completed', 'no_shows', 'cancelled']);
  assert.deepEqual(icCols('engagement.v_pub_queue_daily'), ['tenant_id', 'centre_id', 'queue_id', 'business_date', 'tokens_issued', 'tokens_completed', 'tokens_not_served', 'median_wait_seconds', 'p90_wait_seconds']);
  for (const v of VIEWS) {
    const got = viewSql(sql, v), e = viewSql(exp, v); assert.ok(got, `CREATE VIEW ${v} missing from *_engagement__*.sql`);
    assert.deepEqual(selectCols(e), icCols(v), `${v}: spec §7 vs IC`); assert.deepEqual(selectCols(got), icCols(v), `${v}: migration columns (names + order) vs IC`);
    assert.equal(norm(got), norm(e), `${v}: definition text`); assert.match(got, /WITH\s*\(\s*security_invoker\s*=\s*(true|on)\s*\)/i); assert.match(got, /Asia\/Kathmandu/);
  }
  assert.deepEqual([...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\s+(\w+\.\w+)/gi)].map((m) => `${m[1] ? 'M:' : ''}${m[2]}`).sort(), [...VIEWS].sort(), 'only the two views');
  assert.match(specSec(S7, S8), /NOT created \(08 R25\)/); assert.doesNotMatch(sql, /v_pub_(booking_address|home_address|patient_membership|membership)/i);
});

// ================================================================ hygiene
test('C16 migrations: no secrets / real data, no destructive DDL, no BYPASSRLS/SUPERUSER, no edits of other schemas\' tables, no USING (true), no GRANT to PUBLIC; no Storage SQL; only app.engagement_* objects are created in schema app; no policy admits a non-staff actor through a staff scope; no auth.* reference', () => {
  const raw = eFiles().map((f) => readFileSync(migDir + f, 'utf8')).join('\n');
  assert.ok(raw.length > 60000, 'C16 migrations missing');
  assert.doesNotMatch(raw, /\b(BYPASSRLS|SUPERUSER)\b/i); assert.doesNotMatch(raw, /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i);
  assert.doesNotMatch(raw, /\bALTER\s+TABLE\s+(core|audit|identity|catalog|frontdesk|billing|lab|reporting|instruments|analytics|quality|micro|anatomic|inventory|partners|smartreport|payments|app)\./i);
  assert.doesNotMatch(raw, /(password|secret|api[_-]?key)\s*[:=]\s*'[^']{6,}'/i);
  assert.doesNotMatch(raw, /\b(USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i, 'REQ-SEC-016'); assert.doesNotMatch(strip(raw), /\bTO\s+PUBLIC\b/i);
  assert.doesNotMatch(strip(raw) + polSql(), /\bstorage\.(objects|buckets)\b/i, 'no Storage SQL'); assert.doesNotMatch(strip(raw), /\bauth\./i, 'REQ-SEC-038');
  assert.doesNotMatch(strip(raw), /\b(Test Patient|SYN-)/, 'no fixtures in migrations (packages/test-fixtures, §8)');
  const bad = [...strip(raw).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TABLE|TRIGGER|INDEX|UNIQUE INDEX|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?app\.(\w+)/gi)].map((m) => m[1]).filter((n) => !/^engagement_/.test(n));
  assert.deepEqual(bad, [], 'only app.engagement_* objects are created in schema app');
});
test('LD-202 scope: no wave-1 migration, db/bootstrap, spec, service or app file is changed by this task (only engagement files + policies + meta + tests are new / edited)', () => {
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', 'db/migrations', 'db/bootstrap', 'spec', 'services', 'apps'], { cwd: repo, encoding: 'utf8' });
  const changed = r.stdout.split('\n').filter(Boolean).filter((f) => !/^db\/migrations\/\d{14}_engagement__/.test(f));
  assert.deepEqual(changed, [], 'tracked files outside the engagement migrations were modified');
});

// ================================================================ gates (run the real tools; AC-0B-3.6 / gate 9 / gate 10)
function tool(name, args = []) {
  const r = spawnSync(process.execPath, [repo + `db/tools/${name}`, '--root', root.replace(/\/$/, ''), ...args], { cwd: repo, encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)|SyntaxError|TypeError|ReferenceError/, `tool crashed:\n${out}`);
  return { code: r.status, out };
}
test('gate 9: check-fk-dag.ts exits 0; check-migrations.ts exits 0 OR its ONLY violation is the pre-existing C13 one (partners.manifest_lines DELETE grant, blocking CR T0B-13.C13-manifest-lines-delete.md); check-registry.ts exits 0 OR every violation is the known spec/gate friction "lacks the staff guard" on an ANY_T policy of §5.2 (settings S, number_counters S/I/U, cs_* S: no is_staff_or_system by spec) AND a blocking CR .orchestra/cr/T0B-13.C16-*.md exists - never a line about any other engagement policy, table or column', () => {
  assert.ok(eFiles().length >= 1, 'C16 migrations missing');
  const f = tool('check-fk-dag.ts'); assert.equal(f.code, 0, `check-fk-dag.ts:\n${f.out}`);
  const m = tool('check-migrations.ts');
  if (m.code !== 0) {
    const bad = m.out.split('\n').filter((l) => /^check-migrations: /.test(l) && !/check-migrations: ok/.test(l));
    assert.ok(bad.length > 0 && bad.every((l) => /_partners__create_partners_schema\.sql: partners\.manifest_lines: GRANT DELETE to lims_app on a class C table is forbidden/.test(l)), `check-migrations (only the pre-existing C13 violation is tolerated):\n${m.out}`);
    assert.doesNotMatch(m.out, /engagement/i, 'no check-migrations violation may mention engagement'); assert.ok(existsSync(root + '.orchestra/cr/T0B-13.C13-manifest-lines-delete.md'));
  }
  const r = tool('check-registry.ts');
  if (r.code !== 0) {
    const bad = r.out.split('\n').filter((l) => /^check-registry: /.test(l) && !/check-registry: ok/.test(l));
    const anyT = (l) => /engagement\.sql: (settings__select__tenant|number_counters__(select|insert|update)__\w+|cs_(booking_cancel_reasons|reminder_reasons|enquiry_categories)__select__\w+) on engagement\.\w+: (USING|WITH CHECK|USING and WITH CHECK) lacks the staff guard/.test(l);
    assert.ok(bad.length > 0 && bad.every(anyT), `check-registry (only the ANY_T no-guard friction is tolerated):\n${r.out}`);
    const cr = existsSync(root + '.orchestra/cr') ? readdirSync(root + '.orchestra/cr').filter((x) => /^T0B-13\.C16-.*\.md$/.test(x)) : [];
    assert.ok(cr.length >= 1, 'a blocking CR .orchestra/cr/T0B-13.C16-*.md must document the check-registry friction (08 A17 P-16 vs §5.2 ANY_T)');
  }
});
test('AC-0B-3.6 / gate 10: a generated isolation probe exists for each of the 36 tenant C16 tables, none for the 3 class G tables, and gen-isolation-probes --check is clean; _registry.sql lists all 39', () => {
  for (const q of TENANT) assert.ok(existsSync(root + `db/tests/isolation/${q}.test.sql`), `db/tests/isolation/${q}.test.sql (run: node db/tools/gen-isolation-probes.ts)`);
  for (const q of G_T) assert.ok(!existsSync(root + `db/tests/isolation/${q}.test.sql`), `class G ${q} has no probe`);
  const r = tool('gen-isolation-probes.ts', ['--check']); assert.equal(r.code, 0, r.out);
  const reg = readFileSync(root + 'db/tests/isolation/_registry.sql', 'utf8');
  for (const q of ALLT) assert.match(reg, new RegExp(`'${esc(q)}'`), `_registry.sql lists ${q}`);
});

// ================================================================ pgTAP suites present and complete
const TD = root + 'db/tests/engagement/';
const tapFiles = () => (existsSync(TD) ? readdirSync(TD).filter((f) => /^T0B-13\.C16_.*\.test\.sql$/.test(f)) : []);
test('pgTAP file db/tests/engagement/T0B-13.C16_schema.test.sql exists (tester-owned: the writer must keep it), covers the AC list by "AC-0B-x.y" markers and the catalogue checks by "-- C16 check N" markers (1-8); RLS never disabled; replica mode (if used) reset to origin; BEGIN / finish / ROLLBACK', () => {
  assert.ok(tapFiles().length >= 1, `pgTAP files: ${tapFiles().join(', ')}`);
  const txt = tapFiles().map((f) => readFileSync(TD + f, 'utf8')).join('\n');
  for (let n = 1; n <= 8; n++) assert.match(txt, new RegExp(`-- C16 check ${n}\\b`), `marker for C16 check ${n}`);
  for (const ac of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '6.1', '6.2', '6.3', '6.4']) assert.match(txt, new RegExp(`AC-0B-${ac.replace('.', '\\.')}\\b`), `AC-0B-${ac} referenced`);
  for (const f of tapFiles()) {
    const s = readFileSync(TD + f, 'utf8');
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, `${f}: RLS never disabled (AC-0B-2.4)`);
    assert.match(s, /^BEGIN;/m); assert.match(s, /ROLLBACK;\s*$/); assert.match(s, /finish\(\)/);
    const rep = [...s.matchAll(/session_replication_role\s*=\s*replica/gi)].length, org = [...s.matchAll(/session_replication_role\s*=\s*origin/gi)].length;
    assert.ok(rep === 0 || (org >= rep && s.lastIndexOf('= origin') > s.lastIndexOf('= replica')), `${f}: every replica fixture block is reset to origin before assertions`);
  }
});
test('the six FORCE-RLS contract tests of 05-SCHEMA §6.6 (08 A12.7) are covered by the existing C16 suites in db/tests/engagement (T-A2 resolve_preauth, T-A3 PRE_ACC, T-L2 redeem / apply_report_link / patient guard P-L9, T-Q3 resolve_display, T-OPS1 purges, T-SEC1 per-table probes): files present, each exercises its function(s), RLS never disabled in them', () => {
  const need = { 'T-A2_resolve_preauth.test.sql': ['engagement_resolve_preauth', 'pre_engagement_otp_token_sha256'], 'T-A3_pre_acc.test.sql': ['phone_e164', 'otp_challenges'], 'T-L2_redeem_link_code.test.sql': ['engagement_redeem_link_code', 'engagement_apply_report_link', 'immutable_row'],
    'T-Q3_resolve_display.test.sql': ['engagement_resolve_display', 'pre_engagement_display_token_sha256'], 'T-OPS1_purge.test.sql': ['purge_payment_requests', 'purge_queue', 'purge_requires_system_tenant_claims'], 'T-SEC1_table_probes.test.sql': ['engagement.'] };
  for (const [f, kws] of Object.entries(need)) {
    assert.ok(existsSync(TD + f), `${f} present`); const s = readFileSync(TD + f, 'utf8');
    for (const k of kws) assert.ok(s.includes(k), `${f} covers ${k}`);
    assert.doesNotMatch(s, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, `${f}: RLS never disabled`);
  }
});
