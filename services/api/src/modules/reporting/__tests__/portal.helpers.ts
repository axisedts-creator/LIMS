// C6-T20 test helpers (not a test file). Synthetic data only.
// makePortalWorld(): everything the portal handlers (manifest.handlers.createPortalOtpChallenge .. endPortalSession), the portalSession AuthResolver
// (manifest.authResolvers.portalSession), service/portal.service.ts and the worker task send_portal_otp need, with NO network and NO real DB.
//   - db: in-memory fake of Postgres for reporting.{reports,report_versions,qr_tokens,portal_links,otp_challenges,portal_sessions,settings} plus
//     `SELECT * FROM app.reporting_resolve_portal_credential($1,$2)` (the DEFINER of CR-C6-002, same rules as the migration) and `app.enqueue_job`.
//     SQL is modelled by CONTENT: single-table statements, WHERE = AND-ed terms `col op x` (op = <> != >= <= > < =), `col IS [NOT] NULL`,
//     `col IN ('a','b')`; x = $n[::type] | now() | 'lit' | number | true/false. OR / sub-selects / joins are NOT modelled (terms are ignored).
//     SET terms: `col = x`, `col = col + N`, `col = NULL`, `col = now()`. Timestamps the code writes must come from ctx.now() as parameters or now().
//     INSERT ... VALUES ($n, ...) [RETURNING ..]. `SELECT count(*)` answers {count,n,c}. Bytea comparisons are byte-wise (Buffer / Uint8Array alike).
//     READ COMMITTED row locks: UPDATE and SELECT ... FOR UPDATE wait for rows locked by another open transaction and re-evaluate the WHERE afterwards.
//     A transaction ends in run(): handler error => journal rolled back, unless the handler called ctx.commitOnError() (08 A19 P-42).
//   - ctx.rateLimit = the REAL core createRateLimiter over an in-memory backend that honours the injected clock (key grammar is STRICT: an unknown
//     tier/prefix throws exactly as in production), ctx.audit.access = spy, ctx.storage.read = in-memory object store (spy).
//   - ctx.ports: FrontdeskPort = the REAL C0 fake, IdentityPort = {getTenantSettings}, NotificationPort = spy; BillingPort / PaymentProviderPort /
//     SmartReportPort record ANY call (portal paths must make zero calls: 07-SECURITY 4, 8a, 8f).
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRateLimiter } from '../../../core/ratelimit/index.js';
import { createAuthResolverRegistry } from '../../../core/auth/resolvers.js';
import { LimsError } from '../../../core/errors.js';
import { createFakeFrontdeskPort } from '../../../../../../packages/fakes/src/FrontdeskPort.fake.js';
import { createEventSpy } from '../../../../../../packages/fakes/src/event-spy.js';
import { TENANTS, FIXED_NOW } from '../../../../../../packages/fakes/src/base.js';
import { issueToken, hashToken } from '../domain/tokens.js';
import { otpHmac } from '../domain/otp.js';

export const TENANT_A: string = TENANTS.A;
export const TENANT_B: string = TENANTS.B;
export const NOW: string = FIXED_NOW;
export type Row = Record<string, any>;
export const PORTAL_ORIGIN = 'https://portal.lims.invalid';
export const idN = (n: number) => `0190c000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const sha256hex = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export const sha256buf = (s: string) => createHash('sha256').update(s).digest();
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
export const errShape = (e: any) => JSON.stringify({ name: e?.name, code: e?.code, message: e?.message, statusCode: e?.statusCode, fields: e?.fields ?? e?.details ?? null });
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

// ------------------------------------------------------------------------------------------------ fixtures
export const PATIENT_A = idN(0x101);
export const CENTRE_A = idN(0x102);
export const BRANCH_A = idN(0x103);
export const ORDER_A = idN(0x104);
export const REPORT_A = idN(0x201);        // released v1
export const REPORT_A2 = idN(0x202);       // second report, same tenant (A5 cross-report probe)
export const REPORT_B = idN(0x2b1);        // tenant B
export const VER_A1 = idN(0x301);          // REPORT_A v1
export const VER_A2 = idN(0x302);          // REPORT_A v2 (only released after amend())
export const VER_A2R = idN(0x311);         // REPORT_A2 v1
export const VER_B1 = idN(0x3b1);
export const PHONE = '+9779800000010';
export const LAB_NAME = 'Test Lab 0001';
export const PATIENT_MASKED = 'T*** P*** 0001';
export const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 synthetic portal report v1');
export const PDF_BYTES_V2 = new TextEncoder().encode('%PDF-1.7 synthetic portal report v2');
export const pdfPath = (tenant: string, report: string, v: number) => `${tenant}/reports/${report}/v${v}.pdf`;

const COLS: Record<string, string[]> = {
  reports: ['id', 'tenant_id', 'centre_id', 'branch_id', 'order_id', 'patient_id', 'family', 'state', 'latest_version_no', 'released_version_no', 'billing_balance_due_paisa', 'patient_display_name', 'registration_no', 'version'],
  report_versions: ['id', 'tenant_id', 'centre_id', 'report_id', 'order_id', 'patient_id', 'version_no', 'status', 'report_kind', 'completeness', 'pdf_object_path', 'pdf_sha256', 'pdf_bytes', 'released_at', 'reported_at', 'superseded_at', 'superseded_by_version_no', 'smart_summary_json', 'version'],
  qr_tokens: ['id', 'tenant_id', 'report_id', 'report_version_id', 'lab_name_snapshot', 'patient_display_snapshot', 'panel_names_snapshot', 'issued_at', 'revoked_at'],
  portal_links: ['id', 'tenant_id', 'centre_id', 'report_id', 'bound_version_no', 'channel', 'recipient_kind', 'recipient_ref_id', 'otp_channel', 'destination_masked', 'destination_sha256', 'patient_display_snapshot', 'token_sha256', 'expires_at', 'revoked_at', 'delivery_id', 'reissued_from_link_id', 'last_used_at', 'use_count', 'reissue_count_day', 'reissue_day', 'redeem_failures', 'purpose', 'version', 'created_at'],
  otp_challenges: ['id', 'tenant_id', 'link_id', 'channel', 'destination_sha256', 'code_hmac', 'status', 'attempts', 'failure_code', 'expires_at', 'verified_at', 'delivery_id', 'created_at', 'created_by'],
  portal_sessions: ['id', 'tenant_id', 'link_id', 'report_id', 'token_sha256', 'last_seen_at', 'idle_expires_at', 'absolute_expires_at', 'ended_at', 'user_agent_sha256', 'link_purpose', 'created_at', 'created_by'],
  settings: ['tenant_id', 'link_reissue_max_per_day', 'dues_link_enabled', 'portal_payment_gateways'],
  // C6-T42 (05-SCHEMA §2.15): portal dues payment requests
  portal_payment_requests: ['id', 'tenant_id', 'link_id', 'report_id', 'order_id', 'gateway', 'status', 'review', 'intent_id', 'amount_paisa', 'action_json', 'failure_code', 'intent_expires_at', 'last_checked_at', 'completed_at', 'expires_at', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'],
};
const DEFAULTS: Record<string, Row> = {
  reports: { state: 'open', latest_version_no: 1, released_version_no: 1, billing_balance_due_paisa: null, family: 'laboratory', version: 1 },
  report_versions: { status: 'released', report_kind: 'final', completeness: 'complete', smart_summary_json: null, superseded_at: null, superseded_by_version_no: null, version: 1 },
  qr_tokens: { revoked_at: null, panel_names_snapshot: ['Complete Blood Count'] },
  portal_links: { channel: 'sms', recipient_kind: 'patient', recipient_ref_id: null, otp_channel: null, destination_masked: null, destination_sha256: null, revoked_at: null, delivery_id: null, reissued_from_link_id: null, last_used_at: null, use_count: 0, reissue_count_day: 0, reissue_day: null, redeem_failures: 0, purpose: 'report', version: 1 },
  otp_challenges: { destination_sha256: null, code_hmac: null, status: 'pending_send', attempts: 0, failure_code: null, verified_at: null, delivery_id: null },
  portal_sessions: { ended_at: null, user_agent_sha256: null, link_purpose: 'report' },
  settings: { link_reissue_max_per_day: 3, dues_link_enabled: true, portal_payment_gateways: [] },
  portal_payment_requests: { status: 'queued', review: false, version: 1 },
};
const UNIQUE: Record<string, string[][]> = { portal_links: [['token_sha256']], portal_sessions: [['token_sha256']] };
const JSON_COLS = new Set(['smart_summary_json', 'portal_payment_gateways', 'panel_names_snapshot', 'action_json']);

// C6-T42: the CHECKs / guard trigger / partial unique index of reporting.portal_payment_requests (05-SCHEMA §2.15), so a buggy writer trips them here as it would in PostgreSQL.
const PPR_TERMINAL = ['completed', 'failed', 'expired'];
function pprChecks(row: Row, bad: (why: string) => never) {
  if (!['esewa', 'khalti'].includes(row['gateway'])) bad('gateway');
  if (!['queued', 'ready', 'completed', 'failed', 'expired'].includes(row['status'])) bad('status');
  if (!((row['status'] === 'ready' && !row['review']) || row['action_json'] == null)) bad('action_json only while ready and not review');
  if (row['action_json'] != null && (typeof row['action_json'] !== 'object' || typeof row['action_json'].url !== 'string')) bad('action_shape');
  if (['ready', 'completed'].includes(row['status']) && (row['intent_id'] == null || row['amount_paisa'] == null)) bad('ready needs intent_id + amount_paisa');
  if (row['amount_paisa'] != null && !(Number(row['amount_paisa']) > 0)) bad('amount > 0');
  if (row['status'] === 'failed' && !row['failure_code']) bad('failed needs failure_code');
  if (row['failure_code'] != null && !(String(row['failure_code']).length >= 1 && String(row['failure_code']).length <= 64)) bad('failure_code length');
  if (row['status'] === 'completed' && row['completed_at'] == null) bad('completed needs completed_at');
}

// ------------------------------------------------------------------------------------------------ fake transaction engine
const norm = (v: any) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v instanceof Date ? v.toISOString() : v);
const isTime = (v: any) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v);
const same = (a: any, b: any) => { a = norm(a); b = norm(b); if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b); if (isTime(a) && isTime(b)) return Date.parse(a) === Date.parse(b); return a === b; };
const order = (a: any, b: any): number => { a = norm(a); b = norm(b); if (isTime(a) && isTime(b)) return Date.parse(a) - Date.parse(b); return a < b ? -1 : a > b ? 1 : 0; };
function splitComma(s: string): string[] { const out: string[] = []; let d = 0; let q = false; let cur = ''; for (const ch of s) { if (ch === "'") q = !q; if (!q && ch === '(') d++; if (!q && ch === ')') d--; if (!q && d === 0 && ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
function groups(s: string): string[] { const out: string[] = []; let d = 0; let cur = ''; for (const ch of s) { if (ch === '(') { if (d++ === 0) { cur = ''; continue; } } else if (ch === ')') { if (--d === 0) { out.push(cur); continue; } } if (d > 0) cur += ch; } return out; }

export interface Stmt { readonly text: string; readonly values: readonly unknown[]; readonly verb: string }
export interface Job { identifier: string; payload: any; jobKey: unknown; tx: unknown }

export function makePortalDb(nowIso: () => string) {
  const store: Record<string, Row[]> = Object.fromEntries(Object.keys(COLS).map((t) => [t, [] as Row[]]));
  const stmts: Stmt[] = []; const jobs: Job[] = []; const journal = new Map<unknown, Array<() => void>>();
  const locks = new Map<Row, { tx: unknown; done: Promise<void>; release: () => void }>();
  let seq = 0x9000;
  const newId = () => idN(++seq);
  const undo = (tx: unknown, fn: () => void) => { (journal.get(tx) ?? journal.set(tx, []).get(tx)!).push(fn); };
  const fullRow = (table: string, over: Row): Row => { const r: Row = {}; for (const c of COLS[table]!) r[c] = null; return Object.assign(r, DEFAULTS[table], over); };

  const val = (t: string, values: readonly unknown[]): unknown => {
    const p = /^\$(\d+)/.exec(t)?.[1]; if (p) return norm(values[Number(p) - 1]);
    if (/^now\(\)$/i.test(t) || /^clock_timestamp\(\)$/i.test(t)) return nowIso();
    if (/^null$/i.test(t)) return null; if (/^true$/i.test(t)) return true; if (/^false$/i.test(t)) return false;
    if (/^-?\d+$/.test(t)) return Number(t); return t.replace(/^'|'$/g, '');
  };
  const X = String.raw`(\$\d+(?:::\w+)?|now\(\)|'[^']*'|-?\d+|true|false)`;
  function predicate(where: string, values: readonly unknown[]): (r: Row) => boolean {
    const fs: Array<(r: Row) => boolean> = [];
    for (const m of where.matchAll(new RegExp(String.raw`(?:\b\w+\.)?(\w+)\s*(<>|!=|>=|<=|>|<|=)\s*${X}`, 'gi'))) {
      const [, c, op, t] = m as unknown as [string, string, string, string]; const v = val(t, values);
      if (v === null || v === undefined) continue;                                  // optional filter with a NULL argument does not narrow
      fs.push((r) => { const x = r[c]; if (x === null || x === undefined) return op === '<>' || op === '!='; return op === '=' ? same(x, v) : op === '<>' || op === '!=' ? !same(x, v) : op === '>' ? order(x, v) > 0 : op === '>=' ? order(x, v) >= 0 : op === '<' ? order(x, v) < 0 : order(x, v) <= 0; });
    }
    for (const m of where.matchAll(/(?:\b\w+\.)?(\w+)\s+is\s+(not\s+)?null\b/gi)) { const c = m[1]!; const neg = !!m[2]; fs.push((r) => ((r[c] === null || r[c] === undefined) !== neg)); }
    for (const m of where.matchAll(/(?:\b\w+\.)?(\w+)\s+in\s*\(([^)]*)\)/gi)) { const c = m[1]!; const set = splitComma(m[2]!).map((t) => val(t, values)); fs.push((r) => set.some((v) => same(r[c], v))); }
    return (r) => fs.every((f) => f(r));
  }
  function applySet(r: Row, set: string, values: readonly unknown[]) {
    for (const a of splitComma(set)) {
      const m = /^(?:\w+\.)?(\w+)\s*=\s*([\s\S]+)$/.exec(a); if (!m) continue; const col = m[1]!; const rhs = m[2]!.trim().replace(/::\w+(\[\])?$/, '');
      const plus = /^(?:\w+\.)?(\w+)\s*\+\s*(\$\d+|\d+)$/.exec(rhs);
      if (plus) r[col] = Number(r[plus[1]!] ?? 0) + Number(val(plus[2]!, values));
      else if (!/\(/.test(rhs) || /^now\(\)$/i.test(rhs) || /^\$\d+/.test(rhs)) { const v = val(rhs, values); r[col] = JSON_COLS.has(col) && typeof v === 'string' ? JSON.parse(v) : v; }
    }
  }
  async function claim(tx: unknown, pick: () => Row[]): Promise<Row[]> {
    for (;;) {
      const rows = pick(); const blocker = rows.map((r) => locks.get(r)).find((l) => l && l.tx !== tx);
      if (!blocker) { for (const r of rows) if (!locks.has(r)) { let release!: () => void; const done = new Promise<void>((res) => { release = res; }); locks.set(r, { tx, done, release }); } return rows; }
      await blocker.done;
    }
  }
  function definer(values: readonly unknown[]): Row[] {
    const [kind, sha] = values as [string, unknown]; const h = norm(sha); const out: Row[] = [];
    if (!Buffer.isBuffer(h) || h.length !== 32 || !['link', 'session'].includes(kind)) return out;
    const now = nowIso();
    if (kind === 'link') for (const l of store['portal_links']!) { if (same(l['token_sha256'], h) && l['revoked_at'] == null) out.push({ tenant_id: l['tenant_id'], link_id: l['id'], report_id: l['report_id'], stage: order(l['expires_at'], now) > 0 ? 'link' : 'expired_link', session_id: null, purpose: l['purpose'] }); }
    else for (const s of store['portal_sessions']!) { if (same(s['token_sha256'], h) && s['ended_at'] == null && order(s['idle_expires_at'], now) > 0 && order(s['absolute_expires_at'], now) > 0) out.push({ tenant_id: s['tenant_id'], link_id: s['link_id'], report_id: s['report_id'], stage: 'session', session_id: s['id'], purpose: s['link_purpose'] }); }
    return out;
  }
  async function exec(tx: unknown, text: string, values: readonly unknown[]): Promise<Row[]> {
    if (/\bapp\.enqueue_job\s*\(/i.test(text)) {
      let payload: any = values[1]; if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { /* keep */ } }
      const j: Job = { identifier: String(values[0]), payload, jobKey: values[2], tx };
      // same job key twice collapses (graphile-worker job_key semantics)
      if (j.jobKey != null && jobs.some((x) => x.jobKey === j.jobKey && x.identifier === j.identifier)) return [{ enqueue_job: 1 }];
      jobs.push(j); undo(tx, () => { jobs.splice(jobs.indexOf(j), 1); }); return [{ enqueue_job: 1 }];
    }
    if (/\bapp\.reporting_resolve_portal_credential\s*\(/i.test(text)) return definer(values);
    const verb = (/^\s*(select|insert|update|delete)/i.exec(text)?.[1] ?? 'other').toLowerCase();
    const table = /(?:from|into|update)\s+reporting\.(\w+)/i.exec(text)?.[1];
    if (!table || !(table in store)) return [];
    const rows = store[table]!;
    if (verb === 'delete') {
      if (!['portal_payment_requests', 'otp_challenges', 'portal_sessions'].includes(table)) throw pgError('42501', 'permission denied: no DELETE grant');   // only the system purge (reporting.purge_ephemeral, policies __delete__tenant_expired) deletes these
      const where = /\bwhere\b([\s\S]*?)(?:\breturning\b|$)/i.exec(text)?.[1]; if (!where) throw new Error('FAKE-UNSUPPORTED-SQL: DELETE without WHERE');
      const gone = rows.filter(predicate(where, values));
      for (const r of gone) { rows.splice(rows.indexOf(r), 1); undo(tx, () => { rows.push(r); }); }
      return /\breturning\b/i.test(text) ? gone.map((r) => ({ ...r })) : [];
    }
    if (verb === 'select') {
      const where = /\bwhere\b([\s\S]*?)(?:\border\s+by\b|\blimit\b|\bfor\s+update\b|$)/i.exec(text)?.[1] ?? '';
      const forUpdate = /\bfor\s+update\b/i.test(text);
      const pick = () => { const p = predicate(where, values); let hit = rows.filter(p); const ob = /\border\s+by\s+([\s\S]+?)(?:\blimit\b|\bfor\s+update\b|$)/i.exec(text)?.[1];
        if (ob) { const keys = ob.split(',').map((c) => { const [col, dir] = c.trim().split(/\s+/); return [col!.replace(/^\w+\./, ''), /^desc$/i.test(dir ?? '')] as const; });
          hit = [...hit].sort((a, b) => { for (const [c, desc] of keys) { const d = order(a[c] ?? '', b[c] ?? ''); if (d) return desc ? -d : d; } return 0; }); }
        const lim = /\blimit\s+(\$\d+|\d+)/i.exec(text)?.[1]; if (lim) hit = hit.slice(0, Number(val(lim, values))); return hit; };
      const hit = forUpdate ? await claim(tx, pick) : pick();
      if (/select\s+count\(\*\)/i.test(text)) return [{ count: hit.length, n: hit.length, c: hit.length }];
      return hit.map((r) => ({ ...r }));
    }
    if (verb === 'update') {
      const m = /\bset\b([\s\S]*?)\bwhere\b([\s\S]*?)(?:\breturning\b|$)/i.exec(text); if (!m) throw new Error('FAKE-UNSUPPORTED-SQL: UPDATE without WHERE');
      const hit = await claim(tx, () => rows.filter(predicate(m[2]!, values)));
      for (const r of hit) {
        const before = { ...r }; applySet(r, m[1]!, values); undo(tx, () => { Object.assign(r, before); });
        if (table === 'portal_payment_requests') {
          const bad = (why: string): never => { throw pgError('23514', `portal_payment_requests check violated: ${why}`); };
          const guard = (why: string): never => { throw pgError('P0001', `immutable_row: ${why}`); };
          if (PPR_TERMINAL.includes(before['status']) && ['status', 'review', 'intent_id', 'amount_paisa', 'action_json', 'failure_code', 'intent_expires_at', 'last_checked_at', 'completed_at'].some((c) => JSON.stringify(before[c]) !== JSON.stringify(r[c]))) guard('terminal');
          if (r['status'] !== before['status'] && !((before['status'] === 'queued' && ['ready', 'failed'].includes(r['status'])) || (before['status'] === 'ready' && ['completed', 'failed', 'expired'].includes(r['status'])))) guard('status');
          if ((before['intent_id'] != null && r['intent_id'] !== before['intent_id']) || (before['amount_paisa'] != null && r['amount_paisa'] !== before['amount_paisa'])) guard('intent');
          pprChecks(r, bad);
        }
      }
      return /\breturning\b/i.test(text) ? hit.map((r) => ({ ...r })) : [];
    }
    if (verb === 'insert') {
      const m = /into\s+reporting\.\w+\s*\(([^)]*)\)\s*values\s*([\s\S]*?)(?:\bon\s+conflict\b([\s\S]*?))?(?:\breturning\b[\s\S]*)?$/i.exec(text);
      if (!m) throw new Error('FAKE-UNSUPPORTED-SQL: INSERT must be `INSERT INTO reporting.t (cols) VALUES ($1, ...)`');
      const cols = m[1]!.split(',').map((c) => c.trim()); const out: Row[] = [];
      for (const g of groups(m[2]!)) {
        const toks = splitComma(g); const over: Row = {};
        cols.forEach((c, i) => { const t = toks[i]!; if (/^default$/i.test(t)) return; const v = val(t.replace(/::\w+(\[\])?$/, ''), values); over[c] = JSON_COLS.has(c) && typeof v === 'string' ? JSON.parse(v) : v; });
        const row = fullRow(table, over); if (row['id'] == null && 'id' in row) row['id'] = newId(); if ('created_at' in row && row['created_at'] == null) row['created_at'] = nowIso();
        for (const [c, v] of Object.entries(row)) if (v instanceof Uint8Array) row[c] = Buffer.from(v);
        // CHECKs of 05-SCHEMA §2.6 that a buggy writer could trip
        const bad = (why: string) => { throw pgError('23514', `${table} check violated: ${why}`); };
        if (table === 'otp_challenges') {
          if (row['code_hmac'] != null && !(Buffer.isBuffer(row['code_hmac']) && row['code_hmac'].length === 32)) bad('code_hmac 32 bytes');
          if (row['destination_sha256'] != null && !(Buffer.isBuffer(row['destination_sha256']) && row['destination_sha256'].length === 32)) bad('destination_sha256 32 bytes');
          if (!['sms', 'email'].includes(row['channel'])) bad('channel');
          if (!['pending_send', 'pending', 'verified', 'exhausted', 'expired', 'superseded', 'failed'].includes(row['status'])) bad('status');
          if (order(row['expires_at'], new Date(Date.parse(row['created_at']) + 600_000).toISOString()) > 0) bad('ttl <= 10 minutes');
        }
        if (table === 'portal_sessions') {
          if (!(Buffer.isBuffer(row['token_sha256']) && row['token_sha256'].length === 32)) bad('token_sha256 32 bytes');
          if (order(row['absolute_expires_at'], new Date(Date.parse(row['created_at']) + 12 * 3600_000).toISOString()) > 0) bad('absolute <= 12 hours');
        }
        if (table === 'portal_links') {
          if (!(Buffer.isBuffer(row['token_sha256']) && row['token_sha256'].length === 32)) bad('token_sha256 32 bytes');
          if (String(row['patient_display_snapshot'] ?? '').length > 60 || row['patient_display_snapshot'] == null) bad('patient_display_snapshot 1..60');
          if (order(row['expires_at'], new Date(Date.parse(row['created_at']) + 90 * 86400_000).toISOString()) > 0) bad('ttl <= 90 days');
        }
        if (table === 'portal_payment_requests') {
          pprChecks(row, bad);
          if (order(row['expires_at'], new Date(Date.parse(row['created_at']) + 120 * 86400_000).toISOString()) > 0 || order(row['expires_at'], row['created_at']) <= 0) bad('ttl');
        }
        // partial unique index: one open (queued/ready) request per order
        const open = table === 'portal_payment_requests' && ['queued', 'ready'].includes(row['status']) && rows.some((e) => e['tenant_id'] === row['tenant_id'] && e['order_id'] === row['order_id'] && ['queued', 'ready'].includes(e['status']));
        if (open) { if (!m[3]) throw pgError('23505', 'duplicate key value violates unique constraint "portal_payment_requests__tenant_id_order_id__open__p_uq"'); continue; }
        const dup = rows.find((e) => (UNIQUE[table] ?? []).some((u) => u.every((c) => same(e[c], row[c]))));
        if (dup) { if (!m[3]) throw pgError('23505', 'duplicate key'); continue; }
        rows.push(row); undo(tx, () => { rows.splice(rows.indexOf(row), 1); }); out.push({ ...row });
      }
      return /\breturning\b/i.test(text) ? out : [];
    }
    return [];
  }
  function newTx() {
    const tx: any = {
      startedAt: new Date(nowIso()),
      async query(text: string, values: unknown[] = []) { const verb = (/^\s*(select|insert|update|delete)/i.exec(text)?.[1] ?? 'other').toLowerCase(); stmts.push({ text, values: [...values], verb }); return { rows: await exec(tx, text, values) }; },
      savepoint: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
    };
    return tx;
  }
  const endTx = (tx: unknown, rollback: boolean) => {
    if (rollback) { const j = journal.get(tx) ?? []; for (const f of [...j].reverse()) f(); }
    journal.delete(tx); for (const [r, l] of locks) if (l.tx === tx) { locks.delete(r); l.release(); }
  };
  return {
    store, stmts, jobs, newTx, endTx, fullRow, newId,
    insert: (table: string, over: Row) => { const r = fullRow(table, { id: newId(), created_at: nowIso(), ...over }); for (const [c, v] of Object.entries(r)) if (v instanceof Uint8Array) r[c] = Buffer.from(v); store[table]!.push(r); return r; },
    jobsOf: (identifier: string) => jobs.filter((j) => j.identifier === identifier),
    writes: () => stmts.filter((s) => ['insert', 'update', 'delete'].includes(s.verb)),
    where: (table: string, f: (r: Row) => boolean) => store[table]!.filter(f),
  };
}
export type PortalDb = ReturnType<typeof makePortalDb>;

// ------------------------------------------------------------------------------------------------ the world
const FORBIDDEN_PORTS = ['BillingPort', 'PaymentProviderPort', 'SmartReportPort', 'LabPort', 'CatalogPort'] as const;

export function makePortalWorld(opts: { rng?: never } = {}) {
  void opts;
  const clock = { t: Date.parse(NOW) };
  const now = () => new Date(clock.t).toISOString();
  const db = makePortalDb(now);
  const hmacKey = new Uint8Array(readFileSync(process.env['LIMS_REPORTING_OTP_HMAC_KEY_FILE']!));
  const logs: string[] = [];
  const log = { info: (o: object, m?: string) => logs.push(JSON.stringify({ o, m })), warn: (o: object, m?: string) => logs.push(JSON.stringify({ o, m })), error: (o: object, m?: string) => logs.push(JSON.stringify({ o, m })) };

  // rate limiter: real core grammar, backend honours the injected clock
  const windows = new Map<string, number[]>(); const counters = new Map<string, { n: number; until: number }>();
  const limiter = createRateLimiter({
    hmacKey: 'test-only-key',
    backend: {
      async slidingWindow(h, w, limit) { const hits = (windows.get(h) ?? []).filter((t) => t > clock.t - w * 1000); if (hits.length >= limit) { windows.set(h, hits); return { allowed: false, retryAfterSeconds: 60 }; } hits.push(clock.t); windows.set(h, hits); return { allowed: true, retryAfterSeconds: 0 }; },
      async tokenBucket() { return { allowed: true, retryAfterSeconds: 0 }; },
      async counter(h, limit, ttl) { const c = counters.get(h); const cur = c && c.until > clock.t ? c : { n: 0, until: clock.t + ttl * 1000 }; cur.n++; counters.set(h, cur); return cur.n > limit ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true, retryAfterSeconds: 0 }; },
    },
  });
  const rateCalls: Array<{ tier: string; key: string }> = [];
  const rateLimit = { async consume(tier: any, key: string) { rateCalls.push({ tier, key }); return limiter.consume(tier, key); } };

  const audit: Array<Row> = [];
  const objects = new Map<string, Uint8Array>(); const storageReads: Array<{ bucket: string; path: string }> = [];
  const storage = { async read(bucket: string, path: string) { storageReads.push({ bucket, path }); const o = objects.get(`${bucket}/${path}`); if (!o) throw new LimsError('common.not_found'); return o; } };

  const events = createEventSpy();
  const frontdesk: any = createFakeFrontdeskPort({ seed: 1, events });
  frontdesk.__seed({ patients: [{ id: PATIENT_A, tenantId: TENANT_A, patientCode: 'P-A-0001', fullName: 'Test Patient 0001', sex: 'female', phoneE164: PHONE, email: 'patient0@example.com',
    consents: { sms: true, whatsapp: false, email: true, shareWithReferrer: false, consentTextVersion: 'v1' }, status: 'active' }] });
  const forbiddenCalls: string[] = [];
  const forbidden = Object.fromEntries(FORBIDDEN_PORTS.map((p) => [p, new Proxy({}, { get: (_t, m) => (...a: unknown[]) => { void a; forbiddenCalls.push(`${p}.${String(m)}`); throw new Error(`portal path called ${p}.${String(m)}`); } })]));
  const sent: Array<{ method: string; ctxActor: string; input: any; code: string | undefined }> = []; const sends = new Map<string, number>();
  const notif = {
    behaviour: { status: 'queued' as string },
    async send(method: string, ctx: any, input: any) {
      const dest = input.recipient?.phoneE164 ?? input.recipient?.patientId ?? input.recipient?.kind;
      const n = (sends.get(String(dest)) ?? 0) + 1;
      if (n > 3) throw new LimsError('common.rate_limited');                       // NotificationPort per-destination key otp:p:<hex> (3 per hour), simulated
      sends.set(String(dest), n);
      sent.push({ method, ctxActor: ctx.actor?.type, input, code: input.params?.otp_code });
      return { deliveryId: db.newId(), status: notif.behaviour.status, replayed: false };
    },
    sendSms(ctx: any, input: any) { return notif.send('sendSms', ctx, input); },
    sendEmailLink(ctx: any, input: any) { return notif.send('sendEmailLink', ctx, input); },
    sendWhatsAppTemplate(ctx: any, input: any) { return notif.send('sendWhatsAppTemplate', ctx, input); },
  };
  const identity = { async getTenantSettings(_c: any, _i: any) { return { reportLinkTtlDays: 45 }; } };
  const ports: any = { FrontdeskPort: frontdesk, IdentityPort: identity, NotificationPort: notif, ...forbidden };

  // --- seed: tenant A report released v1 (+ qr snapshot + pdf), a second report, a tenant B report, settings
  const seedReport = (tenant: string, reportId: string, versionId: string, pdfTag: Uint8Array) => {
    db.insert('reports', { id: reportId, tenant_id: tenant, centre_id: CENTRE_A, branch_id: BRANCH_A, order_id: ORDER_A, patient_id: PATIENT_A, patient_display_name: PATIENT_MASKED, registration_no: '0001SY000001' });
    const path = pdfPath(tenant, reportId, 1); objects.set(`reports/${path}`, pdfTag);
    db.insert('report_versions', { id: versionId, tenant_id: tenant, centre_id: CENTRE_A, report_id: reportId, order_id: ORDER_A, patient_id: PATIENT_A, version_no: 1, pdf_object_path: path, pdf_sha256: sha256hex(pdfTag), pdf_bytes: pdfTag.length, released_at: now(), reported_at: now() });
    db.insert('qr_tokens', { tenant_id: tenant, report_id: reportId, report_version_id: versionId, lab_name_snapshot: LAB_NAME, patient_display_snapshot: PATIENT_MASKED, issued_at: now(), token_sha256: sha256buf(versionId) });
  };
  seedReport(TENANT_A, REPORT_A, VER_A1, PDF_BYTES); seedReport(TENANT_A, REPORT_A2, VER_A2R, new TextEncoder().encode('%PDF-1.7 other report'));
  seedReport(TENANT_B, REPORT_B, VER_B1, new TextEncoder().encode('%PDF-1.7 tenant B'));
  db.insert('settings', { tenant_id: TENANT_A }); db.insert('settings', { tenant_id: TENANT_B });

  /** Amendment: version 2 of REPORT_A is released, version 1 superseded (AC-11.7). */
  function amend(smart?: object) {
    const v1 = db.store['report_versions']!.find((v) => v['id'] === VER_A1)!; v1['status'] = 'superseded'; v1['superseded_at'] = now(); v1['superseded_by_version_no'] = 2;
    const path = pdfPath(TENANT_A, REPORT_A, 2); objects.set(`reports/${path}`, PDF_BYTES_V2);
    db.insert('report_versions', { id: VER_A2, tenant_id: TENANT_A, centre_id: CENTRE_A, report_id: REPORT_A, order_id: ORDER_A, patient_id: PATIENT_A, version_no: 2, report_kind: 'amended', pdf_object_path: path, pdf_sha256: sha256hex(PDF_BYTES_V2), pdf_bytes: PDF_BYTES_V2.length, released_at: now(), reported_at: now(), smart_summary_json: smart ?? null });
    db.insert('qr_tokens', { tenant_id: TENANT_A, report_id: REPORT_A, report_version_id: VER_A2, lab_name_snapshot: LAB_NAME, patient_display_snapshot: PATIENT_MASKED, issued_at: now(), token_sha256: sha256buf(VER_A2), panel_names_snapshot: ['Complete Blood Count', 'Liver Function Test'] });
    const rep = db.store['reports']!.find((r) => r['id'] === REPORT_A)!; rep['latest_version_no'] = 2; rep['released_version_no'] = 2;
  }

  /** A portal link row + its plaintext token (the test keeps the only copy). */
  let linkSeq = 0;
  function mkLink(over: Row = {}): { token: string; row: Row; cred: string } {
    const { token, tokenSha256 } = issueToken('link');
    const row = db.insert('portal_links', { tenant_id: TENANT_A, centre_id: CENTRE_A, report_id: REPORT_A, bound_version_no: 1, channel: 'sms', recipient_kind: 'patient', patient_display_snapshot: PATIENT_MASKED,
      token_sha256: Buffer.from(tokenSha256), expires_at: new Date(clock.t + 30 * 86400_000).toISOString(), created_by: idN(0x4001 + ++linkSeq), ...over });
    return { token, row, cred: `link.${token}` };
  }
  /** A live portal session row for a link (skips OTP): returns the plaintext session token. */
  function mkSession(link: Row, over: Row = {}): { token: string; row: Row; cred: string } {
    const { token, tokenSha256 } = issueToken('session');
    const row = db.insert('portal_sessions', { tenant_id: link['tenant_id'], link_id: link['id'], report_id: link['report_id'], token_sha256: Buffer.from(tokenSha256), last_seen_at: now(),
      idle_expires_at: new Date(clock.t + 15 * 60_000).toISOString(), absolute_expires_at: new Date(clock.t + 60 * 60_000).toISOString(), link_purpose: link['purpose'], created_by: link['id'], ...over });
    return { token, row, cred: `session.${token}` };
  }

  const mod = () => import('../index.js');
  let resolverRegistry: Promise<ReturnType<typeof createAuthResolverRegistry>> | undefined;
  const registry = () => (resolverRegistry ??= mod().then((m) => createAuthResolverRegistry([{ name: 'reporting', authResolvers: m.manifest.authResolvers! }])));
  /** The REAL core path: credential -> manifest.authResolvers.portalSession -> claims. Rejects with the resolver's/core's error. */
  async function authenticate(credential: string) { const tx = db.newTx(); try { return await (await registry()).authenticate('portalSession', credential, tx); } finally { db.endTx(tx, false); } }

  function baseCtx(over: Row = {}): any {
    const state = { commit: false };
    const tx = db.newTx();
    return { tenantId: TENANT_A, requestId: '01900000-0000-7000-8000-0000000000e1', clientIp: '203.0.113.7', operationId: 'x', tx, now, log, ports, rateLimit, audit: { access: async (e: Row) => { audit.push(e); } }, storage,
      events: undefined, commitOnError: () => { state.commit = true; }, __state: state, ...over };
  }
  /** ctx for a portal request authenticated from a credential through the real resolver (claims -> ctx.actor / ctx.claims / ctx.tenantId). */
  async function portalCtx(credential: string): Promise<any> {
    const claims = await authenticate(credential);
    return baseCtx({ tenantId: claims.tenant_id, actor: { type: claims.actor_type, id: claims.sub }, claims });
  }
  /** Run a manifest handler as a transaction: rolled back on error unless the handler called ctx.commitOnError(). */
  async function run(op: string, credentialOrCtx: string | any, req: { params?: any; query?: any; headers?: any; body?: any } = {}): Promise<{ status: number; body?: any; headers?: Record<string, string> }> {
    const ctx = typeof credentialOrCtx === 'string' ? await portalCtx(credentialOrCtx) : credentialOrCtx;
    ctx.operationId = op;
    const handler = (await mod()).manifest.handlers[op]; if (typeof handler !== 'function') throw new Error(`no handler ${op}`);
    try { const out = await handler({ params: req.params ?? {}, query: req.query ?? {}, headers: req.headers ?? {}, body: req.body ?? {} } as any, ctx); db.endTx(ctx.tx, false); return out as any; }
    catch (e) { db.endTx(ctx.tx, !ctx.__state.commit); throw e; }
  }
  const call = {
    p1: (cred: string) => run('createPortalOtpChallenge', cred),
    p2: (cred: string, challengeId: string, code: string) => run('verifyPortalOtp', cred, { params: { challenge_id: challengeId }, body: { code } }),
    p3: (cred: string) => run('getPortalReport', cred),
    p4: (cred: string, versionId: string) => run('downloadPortalReportPdf', cred, { params: { report_version_id: versionId } }),
    p5: (cred: string) => run('requestPortalLinkReissue', cred),
    p6: (cred: string) => run('endPortalSession', cred),
  };

  /** Worker-style system ctx (JobContext shape) over the same db / ports. */
  function jobCtx(over: Row = {}): any {
    const tx = db.newTx();
    const ctx: any = { tenantId: TENANT_A, actor: { type: 'system', id: idN(0x5001) }, requestId: '01900000-0000-7000-8000-0000000000e2', tx, now, log, ports, audit: { access: async (e: Row) => { audit.push(e); } }, rateLimit,
      attempt: 1, maxAttempts: 8, jobId: 'job-1', events: undefined, ...over };
    ctx.db = { tx: async (fn: (c: any) => Promise<any>) => fn(ctx) };
    return ctx;
  }
  /** Run a worker task like the queue does: one transaction, rolled back when the task throws. */
  async function runTask(task: (payload: any, ctx: any) => Promise<void>, payload: any, over: Row = {}) {
    const ctx = jobCtx(over);
    try { await task(payload, ctx); db.endTx(ctx.tx, false); } catch (e) { db.endTx(ctx.tx, true); throw e; }
  }

  /** P1 + send task + read the code the task handed to NotificationPort: returns { challengeId, code }. Needs the real task (importer passes it). */
  async function issueCode(cred: string, task: (payload: any, ctx: any) => Promise<void>) {
    const out = await call.p1(cred); const challengeId = out.body.challenge_id as string;
    const before = sent.length; await runTask(task, { tenant_id: TENANT_A, challenge_id: challengeId });
    const s = sent.slice(before).at(-1);
    return { challengeId, code: s?.code as string | undefined, sent: s };
  }
  const wrongCode = (right: string) => String((Number(right) + 1) % 1_000_000).padStart(6, '0');
  const hmacOf = (challengeId: string, code: string) => Buffer.from(otpHmac(hmacKey, challengeId, code));

  return {
    db, clock, now, advance: (ms: number) => { clock.t += ms; }, hmacKey, hmacOf, wrongCode, logs, log, rateCalls, audit, objects, storageReads, ports, notif, sent, forbiddenCalls, frontdesk, identity,
    mkLink, mkSession, amend, authenticate, portalCtx, baseCtx, run, call, jobCtx, runTask, issueCode, hashToken, hmacLike: (k: Uint8Array, id: string, c: string) => createHmac('sha256', k).update(`${id}:${c}`).digest(),
    link: (id: string) => db.store['portal_links']!.find((l) => l['id'] === id)!,
    challenges: (linkId?: string) => db.store['otp_challenges']!.filter((c) => !linkId || c['link_id'] === linkId),
    sessions: (linkId?: string) => db.store['portal_sessions']!.filter((s) => !linkId || s['link_id'] === linkId),
    allText: () => JSON.stringify([db.stmts, logs, audit, db.jobs.map((j) => [j.identifier, j.payload, j.jobKey])]),
  };
}
export type PortalWorld = ReturnType<typeof makePortalWorld>;
