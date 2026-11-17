// C16.T-L2 test world (NOT a test file): in-memory engagement linking + read-model schema, the DEFINER functions of 05-SCHEMA §6.1, the three published views and port stubs, shared by the API redeem
// tests (E14) and the worker backfill_link task tests (02-TRD §4.3.2, §4.4; 05-SCHEMA account_patient_links, link_codes, number_counters, patient_orders/_order_specimens/_reports; §6.1; probe P-L9).
// Same convention as otp.world.ts: `tx.query` answers by statement TYPE + table (never by exact SQL). Supported SQL (anything else throws "fake: unsupported ..." - write plain SQL):
//   SELECT * | cols | count(*) FROM [schema.]table [alias] [WHERE a AND b ..] [ORDER BY col [DESC], ..] [LIMIT n|$n] [OFFSET n|$n] [FOR UPDATE]      (no JOIN / OR / sub-select)
//   INSERT INTO t (cols) VALUES (..)[, (..)] [ON CONFLICT [(cols)] DO NOTHING | DO UPDATE SET c = expr, .. [WHERE ..]] [RETURNING ..]       UPDATE t SET c = expr, .. WHERE .. [RETURNING ..]
//   expr: $n[::type] | 'lit' | NULL | true | false | int | now() | col | col + n | excluded.col | coalesce(a, b, ..)      WHERE term: col (= <> != < <= > >=) expr | col IN (..) | col = ANY($n) | col IS [NOT] NULL
//   SELECT * FROM app.engagement_redeem_link_code($1::bytea)  (DEFINER, bytea only - a text/hex parameter raises 42883)       SELECT app.engagement_code_redeemed_by_me($1, $2)      SELECT app.enqueue_job($1, $2::jsonb, $3)
//   DELETE FROM t WHERE tenant_id = $n AND .. [RETURNING ..]  (T-L5; system actor only; t in patient_orders / _order_specimens / _reports / smart_summaries / notifications; cascades orders -> specimens, reports -> smart_summaries)
//   Views are read-only and must be filtered by tenant_id (REQ-SEC-024): frontdesk.v_pub_order_status, lab.v_pub_specimen_timeline, billing.v_pub_order_balance.
// T-PAY1 adds `payment_requests` (05-SCHEMA: CHECKs, one open request per order, PAT_ACC select / PAT_ACC_PID insert; comparisons against a computed cutoff must bind it as a parameter: `expires_at < $2`, the fake has no interval arithmetic).
// DB rules emulated: tenant RLS; patient actor sees only its own account/links and has NO access to link_codes (42501: only the DEFINER reads it); the patient column guard on account_patient_links
// (05-SCHEMA §4: status suspended->active, visible_from, method, link_code_id by a patient UPDATE -> `immutable_row`, probe P-L9); PAT_LINK_INS (a link_code link needs a code redeemed by the caller,
// engagement_code_redeemed_by_me); CHECK / UNIQUE of the touched tables; number_counters__key__ck is read from the spec file; rollback on error unless ctx.commitOnError() was called (08 A19 P-42).
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { COUNTER_KEY_CK, ID, LAB_NAME, T0, TENANT_A, TENANT_B, SYSTEM_ACTOR, phoneHmac } from './otp.world.js';
import { normalizeLinkCode } from '../domain/linkCode.js';

export { COUNTER_KEY_CK, ID, LAB_NAME, T0, TENANT_A, TENANT_B, SYSTEM_ACTOR, phoneHmac };
export type Row = Record<string, any>;
export interface Stmt { text: string; values: unknown[] }

const pgErr = (code: string, message: string) => Object.assign(new Error(message), { code });
const bytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;
const ts = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
const isTs = (v: unknown) => v instanceof Date || (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v));
const eq = (a: unknown, b: unknown): boolean => (a == null || b == null ? a == null && b == null : bytes(a) && bytes(b) ? Buffer.from(a).equals(Buffer.from(b)) : isTs(a) && isTs(b) ? ts(a) === ts(b) : a === b);
const cmp = (a: unknown, b: unknown): number => { const [x, y]: any[] = isTs(a) && isTs(b) ? [ts(a), ts(b)] : [a, b]; return x < y ? -1 : x > y ? 1 : 0; };
const splitTop = (s: string): string[] => { const out: string[] = []; let d = 0, q = false, cur = ''; for (const ch of s) { if (ch === "'") q = !q; if (!q && ch === '(') d++; if (!q && ch === ')') d--; if (ch === ',' && d === 0 && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
const tuples = (s: string): string[] => { const out: string[] = []; let d = 0, q = false, cur = ''; for (const ch of s) { if (ch === "'") q = !q; if (!q && ch === '(') { if (d++ === 0) { cur = ''; continue; } } if (!q && ch === ')' && --d === 0) { out.push(cur); continue; } if (d > 0) cur += ch; } return out; };
const bare = (c: string) => c.trim().replace(/^\w+\./, '').replace(/"/g, '');

/** HMAC-SHA256(link key, tenant_id ‖ ':' ‖ normalised code), raw 32 bytes (02-TRD §4.3). */
export const linkCodeHmac = (tenantId: string, code: string): Buffer => createHmac('sha256', readFileSync(process.env['LIMS_ENGAGEMENT_LINK_HMAC_KEY_FILE']!)).update(`${tenantId}:${normalizeLinkCode(code)}`).digest();

// ---- table definitions (05-SCHEMA) -----------------------------------------------------------------------------------------------------------------------------
interface Def { unique: string[][]; conflictPartial?: boolean; check?: (r: Row, t: Record<string, Row[]>) => string | undefined; defaults?: () => Row; partial?: Array<{ cols: string[]; where: (r: Row) => boolean; name: string }> }
const LIVE = (r: Row) => ['active', 'suspended'].includes(r['status']);
const RELS = ['self', 'child', 'parent', 'spouse', 'sibling', 'other'];
const H32 = (v: unknown) => v == null || (bytes(v) && v.length === 32);
const SEX = (v: unknown) => v == null || ['male', 'female', 'other', 'unknown'].includes(String(v));
const defs = (now: () => string): Record<string, Def> => ({
  settings: { unique: [['id']] },
  accounts: { unique: [['id']] },
  link_codes: {
    unique: [['id'], ['tenant_id', 'code_hmac']],
    check: (r) => !['issued', 'redeemed', 'revoked'].includes(r['status']) ? 'link_codes__status__ck' : (r['status'] === 'redeemed') !== (r['redeemed_at'] != null && r['redeemed_account_id'] != null) ? 'link_codes__redeemed__ck'
      : !(bytes(r['code_hmac']) && r['code_hmac'].length === 32 && bytes(r['bound_phone_hmac']) && r['bound_phone_hmac'].length === 32 && H32(r['record_phone_hmac'])) ? 'link_codes__hash__ck' : undefined,
  },
  account_patient_links: {
    unique: [['id']],
    partial: [
      { cols: ['tenant_id', 'account_id', 'patient_id'], where: LIVE, name: 'account_patient_links__tenant_id_account_id_patient_id__p_uq' },
      { cols: ['tenant_id', 'account_id'], where: (r) => LIVE(r) && r['relationship'] === 'self', name: 'account_patient_links__tenant_id_account_self__p_uq' },
    ],
    defaults: () => ({ status: 'active', version: 1, is_active: true, visible_from: null, suspend_reason: null, suspended_at: null, revoked_by_kind: null, revoked_reason_code: null, revoked_at: null, created_at: now(), updated_at: now() }),
    check: (r, t) => !RELS.includes(r['relationship']) ? 'account_patient_links__relationship__ck' : !['link_code', 'report_link', 'self_registered'].includes(r['method']) ? 'account_patient_links__method__ck'
      : r['method'] === 'link_code' && r['link_code_id'] == null ? 'account_patient_links__method_code__ck' : !['active', 'suspended', 'revoked'].includes(r['status']) ? 'account_patient_links__status__ck'
      : (r['status'] === 'suspended') !== (r['suspend_reason'] != null && r['suspended_at'] != null) ? 'account_patient_links__suspend__ck'
      : r['suspend_reason'] != null && !['phone_mismatch', 'patient_merged', 'patient_anonymised', 'dormant'].includes(r['suspend_reason']) ? 'account_patient_links__suspend_reason__ck'
      : (r['status'] === 'revoked') !== (r['revoked_by_kind'] != null && r['revoked_at'] != null) ? 'account_patient_links__revoke__ck' : !SEX(r['sex_snapshot']) ? 'account_patient_links__sex__ck'
      : !(typeof r['display_name'] === 'string' && r['display_name'].length >= 1 && r['display_name'].length <= 200) ? 'account_patient_links__name__ck' : !H32(r['record_phone_hmac_at_link']) ? 'account_patient_links__phone_hmac__ck'
      : r['link_code_id'] != null && !t['link_codes']!.some((c) => c['id'] === r['link_code_id'] && c['tenant_id'] === r['tenant_id']) ? 'account_patient_links__code__fk' : undefined,
  },
  notifications: { // T-L5 (05-SCHEMA notifications): created by the system actor; dedupe key is NULLS NOT DISTINCT (null entity_id collides too)
    unique: [['id'], ['tenant_id', 'account_id', 'kind', 'entity_id', 'entity_seq']],
    defaults: () => ({ entity_seq: 0, read_at: null, patient_id: null, entity_type: null, entity_id: null, route_id: null, created_at: now() }),
    check: (r, t) => !['report_ready', 'sample_recollection', 'booking_confirmed', 'booking_cancelled', 'booking_reminder', 'payment_completed', 'follow_up_reminder', 'enquiry_reply', 'profile_paused'].includes(r['kind']) ? 'notifications__kind__ck'
      : r['entity_type'] != null && !['order', 'report', 'booking', 'enquiry', 'reminder', 'profile'].includes(r['entity_type']) ? 'notifications__entity__ck' : r['route_id'] != null && !['patient_app.report', 'patient_app.order', 'patient_app.booking'].includes(r['route_id']) ? 'notifications__route__ck'
      : ['id', 'account_id', 'created_by', 'expires_at'].some((c) => r[c] == null) ? 'notifications__not_null' : !t['accounts']!.some((a) => a['tenant_id'] === r['tenant_id'] && a['id'] === r['account_id']) ? 'notifications__account__fk' : undefined,
  },
  payment_requests: { // T-PAY1 (05-SCHEMA payment_requests): one OPEN (queued/ready) request per order; action_json only while ready; ready needs intent_id + amount_paisa
    unique: [['id']],
    partial: [{ cols: ['tenant_id', 'order_id'], where: (r) => ['queued', 'ready'].includes(r['status']), name: 'payment_requests__tenant_id_order_open__p_uq' }],
    defaults: () => ({ status: 'queued', review: false, intent_id: null, amount_paisa: null, action_json: null, failure_code: null, expires_at: null, version: 1, is_active: true, created_at: now(), updated_at: now() }),
    check: (r) => !['esewa', 'khalti'].includes(r['gateway']) ? 'payment_requests__gateway__ck' : !['queued', 'ready', 'completed', 'failed', 'expired'].includes(r['status']) ? 'payment_requests__status__ck'
      : r['status'] !== 'ready' && r['action_json'] != null ? 'payment_requests__action__ck' : r['status'] === 'ready' && (r['intent_id'] == null || r['amount_paisa'] == null) ? 'payment_requests__ready__ck'
      : r['failure_code'] != null && String(r['failure_code']).length > 64 ? 'payment_requests__failure__ck' : r['amount_paisa'] != null && !(Number(r['amount_paisa']) > 0) ? 'payment_requests__amount__ck'
      : ['id', 'account_id', 'order_id', 'patient_id', 'idempotency_key', 'created_by', 'updated_by'].some((c) => r[c] == null) ? 'payment_requests__not_null' : undefined,
  },
  booking_centres: { unique: [['id'], ['tenant_id', 'centre_id']] }, // T-P2: source of centre_display_name (02-TRD §4.4 / 08 A19 D-119)
  smart_summaries: { unique: [['id'], ['tenant_id', 'report_id', 'report_version_no']], defaults: () => ({ created_at: now() }) },
  reminders: { // T-P4 (05-SCHEMA reminders): follow_up rows scheduled from an approved summary; the partial unique (tenant_id, kind, source_ref_id, source_ref_seq) is honoured by a bare `ON CONFLICT DO NOTHING` too (no index-predicate target in this fake)
    unique: [['id']], conflictPartial: true,
    partial: [{ cols: ['tenant_id', 'kind', 'source_ref_id', 'source_ref_seq'], where: (r) => r['source_ref_id'] != null, name: 'reminders__tenant_id_source_ref__p_uq' }],
    defaults: () => ({ reason_code: null, source_ref_id: null, source_ref_seq: 0, status: 'scheduled', sent_at: null, delivery_id: null, failure_code: null, version: 1, is_active: true, created_at: now(), updated_at: now() }),
    check: (r) => !['custom', 'follow_up', 'booking'].includes(r['kind']) ? 'reminders__kind__ck' : !['staff', 'smart_report', 'booking'].includes(r['source']) ? 'reminders__source__ck' : !['scheduled', 'sent', 'suppressed', 'failed', 'cancelled'].includes(r['status']) ? 'reminders__status__ck'
      : (r['status'] === 'sent') !== (r['sent_at'] != null) ? 'reminders__sent__ck' : r['kind'] !== 'booking' && r['reason_code'] == null ? 'reminders__reason__ck' : ['patient_id', 'due_at', 'created_by', 'updated_by'].some((c) => r[c] == null) ? 'reminders__not_null' : undefined,
  },
  number_counters: {
    unique: [['tenant_id', 'counter_key']],
    check: (r) => !COUNTER_KEY_CK.test(String(r['counter_key'])) ? `number_counters__key__ck (${String(r['counter_key'])})` : !(r['last_value'] >= 0) ? 'number_counters__value__ck' : undefined,
    defaults: () => ({ last_value: 0, expires_at: null }),
  },
  patient_orders: {
    unique: [['tenant_id', 'order_id']],
    defaults: () => ({ status_version: 1, payment_due: false, booking_id: null, invoiced_paisa: null, paid_paisa: null, balance_due_paisa: null, balance_version: null, release_basis: null, created_at: now(), updated_at: now() }),
    check: (r) => !['front_desk', 'engagement_booking', 'home_collection', 'partner_manifest'].includes(r['source']) ? 'patient_orders__source__ck' : !['pre_registered', 'registered', 'in_progress', 'completed', 'cancelled'].includes(r['order_status']) ? 'patient_orders__status__ck'
      : !['registered', 'sample_collected', 'in_lab', 'partial_report', 'report_ready', 'recollection_needed', 'cancelled'].includes(r['stage']) ? 'patient_orders__stage__ck'
      : r['release_basis'] != null && !['paid_in_full', 'zero_balance', 'credit_party', 'override', 'policy_not_enforced', 'due_outstanding', 'no_invoice'].includes(r['release_basis']) ? 'patient_orders__basis__ck'
      : ['visible_at', 'synced_at', 'created_by', 'updated_by', 'centre_id', 'branch_id', 'patient_id'].some((c) => r[c] == null) ? 'patient_orders__not_null' : undefined,
  },
  patient_order_specimens: {
    unique: [['tenant_id', 'specimen_id']],
    defaults: () => ({ recollection_required: false, replaces_specimen_id: null, collected_at: null, received_at: null, rejected_at: null, rejection_reason_code: null, created_at: now(), updated_at: now() }),
    check: (r, t) => !(Number.isInteger(r['status_seq']) && r['status_seq'] >= 0) ? 'patient_order_specimens__seq__ck'
      : !['ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'rejected', 'recollection_ordered', 'stored', 'discarded'].includes(r['status']) ? 'patient_order_specimens__status__ck'
      : ['specimen_type_code', 'ordinal', 'patient_id', 'created_by', 'updated_by'].some((c) => r[c] == null) ? 'patient_order_specimens__not_null'
      : !t['patient_orders']!.some((o) => o['tenant_id'] === r['tenant_id'] && o['order_id'] === r['order_id']) ? 'patient_order_specimens__order__fk' : undefined,
  },
  patient_reports: {
    unique: [['tenant_id', 'report_id', 'version_no']],
    defaults: () => ({ supersedes_version_no: null, panel_names: [], smart_summary_available: false, created_at: now(), updated_at: now() }),
    check: (r) => !(typeof r['report_kind'] === 'string' && r['report_kind'].length >= 1 && r['report_kind'].length <= 32) ? 'patient_reports__kind__ck' : !['valid', 'superseded'].includes(r['status']) ? 'patient_reports__status__ck'
      : !(r['version_no'] >= 1) ? 'patient_reports__version__ck' : !(Array.isArray(r['panel_names']) && r['panel_names'].length <= 20) ? 'patient_reports__panels__ck'
      : ['released_at', 'order_id', 'patient_id', 'created_by', 'updated_by'].some((c) => r[c] == null) ? 'patient_reports__not_null' : undefined,
  },
});
const VIEWS: Record<string, string> = { v_pub_order_status: 'orders', v_pub_specimen_timeline: 'timeline', v_pub_order_balance: 'balances' };

export interface WorldOpts { maxProfiles?: number; maxAccountsPerPatient?: number; showPartnerOrders?: boolean; tenantId?: string }

export function makeLinkWorld(opts: WorldOpts = {}) {
  const tenantId = opts.tenantId ?? TENANT_A;
  const clock = { t: Date.parse(T0) };
  const now = () => new Date(clock.t).toISOString();
  const D = defs(now);
  const t: Record<string, Row[]> = { settings: [], accounts: [], link_codes: [], account_patient_links: [], number_counters: [], patient_orders: [], patient_order_specimens: [], patient_reports: [], notifications: [], smart_summaries: [], reminders: [], booking_centres: [], payment_requests: [], jobs: [], orders: [], timeline: [], balances: [] };
  const stmts: Stmt[] = [];
  const viewQueries: Array<{ view: string; text: string; values: unknown[]; limit?: number; offset?: number }> = [];
  const definerCalls: Array<{ fn: string; values: unknown[] }> = [];
  let seq = 0xb000; const newId = () => ID(++seq);
  t['settings']!.push({ id: newId(), tenant_id: tenantId, app_enabled: true, max_profiles_per_account: opts.maxProfiles ?? 8, max_accounts_per_patient: opts.maxAccountsPerPatient ?? 3, show_partner_orders: opts.showPartnerOrders ?? false,
    allowed_phone_prefixes: ['+990'], app_consent_text_version: 'v3', otp_daily_cap: 2000, version: 1 });

  // ---- expressions / predicates ----------------------------------------------------------------------------------------------------------------------------
  function ev(exprIn: string, values: unknown[], row?: Row, excluded?: Row): unknown {
    const e = exprIn.trim().replace(/::\w+(\[\])?/g, '').replace(/^\((.*)\)$/s, '$1').trim(); let m: RegExpExecArray | null;
    if ((m = /^excluded\.(\w+)$/i.exec(e))) return excluded?.[m[1]!];
    if ((m = /^\$(\d+)$/.exec(e))) { if (+m[1]! > values.length) throw new Error(`fake: placeholder $${m[1]} has no bound value`); return values[+m[1]! - 1]; }
    if ((m = /^'(.*)'$/s.exec(e))) return m[1]!.replace(/''/g, "'");
    if (/^null$/i.test(e)) return null; if (/^true$/i.test(e)) return true; if (/^false$/i.test(e)) return false;
    if (/^-?\d+$/.test(e)) return Number(e);
    if (/^(now|clock_timestamp|statement_timestamp|transaction_timestamp)\(\)$/i.test(e)) return now();
    if ((m = /^coalesce\((.*)\)$/is.exec(e))) { for (const p of splitTop(m[1]!)) { const v = ev(p, values, row, excluded); if (v != null) return v; } return null; }
    if (row && (m = /^(?:\w+\.)?(\w+)\s*\+\s*(\d+|\$\d+)$/.exec(e))) return Number(row[m[1]!] ?? 0) + Number(ev(m[2]!, values));
    if (row && /^(?:\w+\.)?\w+$/.test(e) && bare(e) in row) return row[bare(e)];
    throw new Error(`fake: unsupported expression: ${exprIn}`);
  }
  const strip = (s: string) => s.replace(/\b(?!excluded\.)[a-z_]\w*\.(?=[a-z_])/gi, '');
  function where(clause: string | undefined, values: unknown[]): (r: Row) => boolean {
    if (!clause) return () => true;
    if (/\bor\b/i.test(clause)) throw new Error(`fake: unsupported OR in WHERE: ${clause}`);
    const tests = strip(clause).split(/\s+and\s+/i).map((raw) => {
      const term = raw.trim().replace(/^\((.*)\)$/s, '$1'); let m: RegExpExecArray | null;
      if ((m = /^(\w+)\s+in\s*\((.*)\)$/is.exec(term))) { const list = splitTop(m[2]!).map((x) => ev(x, values)); return (r: Row) => list.some((v) => eq(r[m![1]!], v)); }
      if ((m = /^(\w+)\s*=\s*any\s*\((.*)\)$/is.exec(term))) { const arr = ev(m[2]!, values) as unknown[]; return (r: Row) => arr.some((v) => eq(r[m![1]!], v)); }
      if ((m = /^(\w+)\s+is\s+(not\s+)?null$/i.exec(term))) return (r: Row) => (r[m![1]!] == null) === !m![2];
      if ((m = /^(\w+)\s*(<=|>=|<>|!=|=|<|>)\s*(.+)$/s.exec(term))) { const [c, op, rhs] = [m[1]!, m[2]!, m[3]!]; return (r: Row) => { const v = ev(rhs, values, r); if (op === '=') return eq(r[c], v); if (op === '<>' || op === '!=') return !eq(r[c], v); if (r[c] == null || v == null) return false; const k = cmp(r[c], v); return op === '<' ? k < 0 : op === '<=' ? k <= 0 : op === '>' ? k > 0 : k >= 0; }; }
      throw new Error(`fake: unsupported WHERE term: ${term}`);
    });
    return (r) => tests.every((f) => f(r));
  }

  // ---- identity of the caller --------------------------------------------------------------------------------------------------------------------------------
  const accountOf = (ctx: any, tenant: string): Row | undefined => ctx.actor?.type === 'patient' && ctx.claims?.membership_id ? t['accounts']!.find((a) => a['tenant_id'] === tenant && a['membership_id'] === ctx.claims.membership_id && a['status'] !== 'deleted') : undefined;
  function visible(table: string, r: Row, ctx: any, tenant: string): boolean {
    if (r['tenant_id'] !== tenant) return false;
    if (ctx.actor?.type !== 'patient') return true;
    const a = accountOf(ctx, tenant); if (!a) return false;
    if (table === 'accounts') return r['id'] === a['id'];
    if (table === 'account_patient_links') return r['account_id'] === a['id'];
    if (table === 'link_codes') return false;
    if (table === 'payment_requests') return r['account_id'] === a['id']; // PAT_ACC (05-SCHEMA §5)
    return true;
  }
  const redeemedByMe = (ctx: any, tenant: string, codeId: unknown, patientId: unknown) => { const a = accountOf(ctx, tenant); return !!a && t['link_codes']!.some((c) => c['tenant_id'] === tenant && c['id'] === codeId && c['patient_id'] === patientId && c['status'] === 'redeemed' && c['redeemed_account_id'] === a['id']); };

  const GUARDED = ['status', 'visible_from', 'method', 'link_code_id', 'suspend_reason', 'suspended_at', 'account_id', 'patient_id', 'consent_id'];
  function finish(table: string, r: Row, prev: Row | null, definer = false) {
    const d = D[table]; if (!d) return;
    const bad = d.check?.(r, t); if (bad) throw pgErr('23514', `violates check ${bad}`);
    for (const u of d.unique) if (t[table]!.some((o) => o !== prev && u.every((c) => eq(o[c], r[c])))) throw pgErr('23505', `duplicate key ${table}__${u.join('_')}__uq`);
    for (const p of d.partial ?? []) if (p.where(r) && t[table]!.some((o) => o !== prev && p.where(o) && p.cols.every((c) => eq(o[c], r[c])))) throw pgErr('23505', `duplicate key ${p.name}`);
    void definer;
  }

  // ---- the DEFINER functions (05-SCHEMA §6.1), emulated 1:1 ---------------------------------------------------------------------------------------------------
  function redeemDefiner(ctx: any, tenant: string, arg: unknown): Row[] {
    if (!bytes(arg)) throw pgErr('42883', 'function app.engagement_redeem_link_code(text) does not exist (08 A2.4: the parameter is bytea)');
    const acct = accountOf(ctx, tenant); if (!acct) return [];
    const code = t['link_codes']!.find((c) => c['tenant_id'] === tenant && eq(c['code_hmac'], arg) && c['status'] === 'issued' && ts(c['expires_at']) > clock.t && eq(c['bound_phone_hmac'], acct['phone_hmac']));
    if (!code) return [];
    Object.assign(code, { status: 'redeemed', redeemed_at: now(), redeemed_account_id: acct['id'], updated_at: now(), updated_by: ctx.actor.id }); finish('link_codes', code, code);
    const link = t['account_patient_links']!.find((l) => l['tenant_id'] === tenant && l['account_id'] === acct['id'] && l['patient_id'] === code['patient_id'] && LIVE(l));
    if (link) {
      const was = link['status'];
      Object.assign(link, { status: 'active', suspend_reason: null, suspended_at: null, visible_from: null, method: 'link_code', link_code_id: code['id'], consent_id: code['consent_id'], record_phone_hmac_at_link: code['record_phone_hmac'] ?? null,
        sex_snapshot: code['sex_snapshot'] ?? link['sex_snapshot'], version: link['version'] + 1, updated_at: now(), updated_by: ctx.actor.id });
      finish('account_patient_links', link, link, true);
      return [{ link_code_id: code['id'], patient_id: code['patient_id'], relationship: code['relationship'], consent_id: code['consent_id'], display_name_snapshot: code['display_name_snapshot'], record_phone_hmac: code['record_phone_hmac'] ?? null, sex_snapshot: code['sex_snapshot'] ?? null, existing_link_id: link['id'], existing_link_was_suspended: was === 'suspended' }];
    }
    return [{ link_code_id: code['id'], patient_id: code['patient_id'], relationship: code['relationship'], consent_id: code['consent_id'], display_name_snapshot: code['display_name_snapshot'], record_phone_hmac: code['record_phone_hmac'] ?? null, sex_snapshot: code['sex_snapshot'] ?? null, existing_link_id: null, existing_link_was_suspended: false }];
  }

  // ---- statement execution ----------------------------------------------------------------------------------------------------------------------------------
  function exec(ctx: any, textIn: string, values: unknown[] = []): { rows: Row[]; rowCount: number } {
    stmts.push({ text: textIn, values });
    const sql = textIn.replace(/\s+/g, ' ').trim().replace(/;$/, ''); const tenant: string = ctx.tenantId; const verb = /^(select|insert|update|delete|with)\b/i.exec(sql)?.[1]?.toLowerCase();
    const ok = (rows: Row[], rowCount = rows.length) => ({ rows, rowCount });
    let m: RegExpExecArray | null;

    if (/app\.enqueue_job/i.test(sql)) {
      let payload: any = values[1]; if (typeof payload === 'string') payload = JSON.parse(payload);
      const job = { identifier: String(values[0]), payload, jobKey: values[2], tenant };
      if (job.jobKey != null && t['jobs']!.some((j) => j['identifier'] === job.identifier && j['jobKey'] === job.jobKey)) return ok([{ enqueue_job: 1 }]);
      t['jobs']!.push(job); return ok([{ enqueue_job: 1 }]);
    }
    if (/app\.engagement_redeem_link_code/i.test(sql)) { definerCalls.push({ fn: 'engagement_redeem_link_code', values }); return ok(redeemDefiner(ctx, tenant, values[0])); }
    if ((m = /app\.engagement_code_redeemed_by_me\s*\(/i.exec(sql))) { definerCalls.push({ fn: 'engagement_code_redeemed_by_me', values }); const alias = /\bas\s+(\w+)/i.exec(sql)?.[1] ?? 'engagement_code_redeemed_by_me'; return ok([{ [alias]: redeemedByMe(ctx, tenant, values[0], values[1]) }]); }
    if (!verb) return ok([]);
    if (/\bjoin\b|\(\s*select\b|\bunion\b/i.test(sql)) throw new Error(`fake: unsupported JOIN / sub-select / UNION: ${sql}`);

    const tm = /\b(?:from|into|update)\s+(?:(\w+)\.)?(\w+)/i.exec(sql); if (!tm) return ok([]);
    const schema = tm[1]?.toLowerCase(), name = tm[2]!.toLowerCase();

    if (VIEWS[name]) { // published views: read-only, tenant-filtered, paged with LIMIT / OFFSET
      if (verb !== 'select') throw pgErr('42501', `permission denied for view ${name}`);
      const rows = t[VIEWS[name]!]!;
      const w = /\bwhere (.+?)(?: order by | limit | offset |$)/i.exec(sql)?.[1];
      if (!w || !/\btenant_id\s*=\s*\$\d+/i.test(w)) throw new Error(`fake: view ${name} read without a tenant_id = $n predicate (REQ-SEC-024)`);
      const lim = /\blimit\s+(\$\d+|\d+)/i.exec(sql)?.[1], off = /\boffset\s+(\$\d+|\d+)/i.exec(sql)?.[1];
      let found = rows.filter(where(w, values));
      const ord = /\border by (.+?)(?: limit | offset |$)/i.exec(sql)?.[1];
      if (ord) { const keys = splitTop(strip(ord)).map((k) => { const p = k.trim().split(/\s+/); return { c: p[0]!, desc: /^desc$/i.test(p[1] ?? '') }; }); found = [...found].sort((a, b) => { for (const k of keys) { const x = cmp(a[k.c], b[k.c]); if (x) return k.desc ? -x : x; } return 0; }); }
      const o = off ? Number(ev(off, values)) : 0; const l = lim ? Number(ev(lim, values)) : undefined;
      viewQueries.push({ view: name, text: sql, values, ...(l !== undefined ? { limit: l } : {}), offset: o });
      found = found.slice(o, l === undefined ? undefined : o + l);
      return ok(found.map((r) => ({ ...r })));
    }
    if (!t[name] || !D[name]) { if (schema === 'engagement' || schema === 'core') throw new Error(`fake: table ${name} is not part of the T-L2 world`); return ok([]); }
    if (ctx.actor?.type === 'patient' && name === 'link_codes') throw pgErr('42501', 'permission denied for table link_codes (patient actors have no policy; use app.engagement_redeem_link_code)');
    if (verb === 'delete') { // T-L5: DELETE FROM t WHERE .. [RETURNING ..]; system actor only (policies *__delete__system, 05-SCHEMA §5; patient actors have no DELETE policy); FK ON DELETE CASCADE: orders -> specimens, reports -> smart_summaries
      const dm = /^delete\s+from\s+(?:\w+\.)?\w+(?:\s+(?:as\s+)?(?!where\b|returning\b)\w+)?\s*(?:where\s+(.+?))?(?:\s+returning\s+(.+))?$/i.exec(sql);
      if (!dm) throw new Error(`fake: unsupported DELETE: ${sql}`);
      if (!['patient_orders', 'patient_order_specimens', 'patient_reports', 'smart_summaries', 'notifications'].includes(name)) throw new Error(`fake: DELETE on ${name} is not part of the world`);
      if (ctx.actor?.type !== 'system') throw pgErr('42501', `permission denied for DELETE on ${name} (only the system actor has a DELETE policy)`);
      if (!dm[1] || !/\btenant_id\s*=\s*\$\d+/i.test(dm[1])) throw new Error(`fake: DELETE on ${name} without a tenant_id = $n predicate (REQ-SEC-024)`);
      const pred = where(dm[1], values); const gone = t[name]!.filter((r) => r['tenant_id'] === tenant && pred(r)); const drop = (tbl: string, f: (r: Row) => boolean) => { const keep = t[tbl]!.filter((r) => !f(r)); t[tbl]!.length = 0; t[tbl]!.push(...keep); }; // in place: tests keep array references
      drop(name, (r) => gone.includes(r));
      if (name === 'patient_orders') drop('patient_order_specimens', (s) => gone.some((o) => o['tenant_id'] === s['tenant_id'] && o['order_id'] === s['order_id']));
      if (name === 'patient_reports') drop('smart_summaries', (s) => gone.some((r) => r['tenant_id'] === s['tenant_id'] && r['report_id'] === s['report_id'] && r['version_no'] === s['report_version_no']));
      return ok(dm[2] ? gone.map((r) => ({ ...r })) : [], gone.length);
    }
    // ASSUMED (flagged in .orchestra/notes/T-L2-tests.md): the per-patient limit (TRD §4.3.2 step 4) needs the number of ACTIVE links of ALL accounts of the patient, which the patient policy PAT_ACC hides; the spec names no
    // DEFINER for it, so a `SELECT count(*)` on account_patient_links is answered tenant-wide here. The writer may use any mechanism that gives the same number (or raise a CR).
    const countAll = verb === 'select' && name === 'account_patient_links' && /^select\s+count\(\*\)/i.test(sql);
    const rows = t[name]!; const vis = (r: Row) => (countAll ? r['tenant_id'] === tenant : visible(name, r, ctx, tenant)); const copy = (r: Row) => ({ ...r });

    if (verb === 'select') {
      const sm = /^select\s+(.+?)\s+from\s+(?:\w+\.)?\w+(?:\s+(?:as\s+)?(?!where\b|order\b|limit\b|offset\b|for\b)(\w+))?\s*(?:where\s+(.+?))?\s*(?:order\s+by\s+(.+?))?\s*(?:limit\s+(\S+?))?\s*(?:offset\s+(\S+?))?\s*(for\s+update(?:\s+skip\s+locked)?)?$/i.exec(sql);
      if (!sm) throw new Error(`fake: unsupported SELECT: ${sql}`);
      let found = rows.filter((r) => vis(r) && where(sm[3], values)(r));
      if (sm[4]) { const keys = splitTop(strip(sm[4])).map((k) => { const p = k.trim().split(/\s+/); return { c: p[0]!, desc: /^desc$/i.test(p[1] ?? '') }; }); found = [...found].sort((a, b) => { for (const k of keys) { const x = cmp(a[k.c], b[k.c]); if (x) return k.desc ? -x : x; } return 0; }); }
      if (sm[6]) found = found.slice(Number(ev(sm[6], values)));
      if (sm[5]) found = found.slice(0, Number(ev(sm[5], values)));
      if (/^count\(\*\)/i.test(sm[1]!.trim())) { const alias = /\bas\s+(\w+)\s*$/i.exec(sm[1]!)?.[1]; return ok([{ count: found.length, ...(alias ? { [alias]: found.length } : {}) }]); }
      return ok(found.map(copy));
    }

    if (verb === 'insert') {
      const im = /^insert\s+into\s+(?:\w+\.)?\w+\s*\(([^)]*)\)\s*values\s*(.+?)(?:\s+on\s+conflict\s*(\([^)]*\))?\s*(do\s+nothing|do\s+update\s+set\s+(.+?)(?:\s+where\s+(.+?))?))?(?:\s+returning\s+(.+))?$/i.exec(sql);
      if (!im) throw new Error(`fake: cannot parse INSERT: ${sql}`);
      const cols = splitTop(im[1]!).map(bare); const out: Row[] = []; let n = 0;
      for (const tup of tuples(im[2]!)) {
        const exprs = splitTop(tup); if (exprs.length !== cols.length) throw new Error('fake: column/value count mismatch');
        const row: Row = { tenant_id: tenant, ...(D[name]!.defaults?.() ?? {}) }; cols.forEach((c, i) => { row[c] = ev(exprs[i]!, values); });
        if (row['tenant_id'] !== tenant) throw pgErr('42501', `RLS: ${name} WITH CHECK (tenant_id = session tenant)`);
        if (ctx.actor?.type === 'patient') {
          const a = accountOf(ctx, tenant);
          if (name === 'account_patient_links' && (!a || row['account_id'] !== a['id'])) throw pgErr('42501', 'RLS: account_patient_links PAT_LINK_INS (account_id = the caller\'s account)');
          if (name === 'account_patient_links' && row['method'] === 'link_code' && !redeemedByMe(ctx, tenant, row['link_code_id'], row['patient_id'])) throw pgErr('42501', 'RLS: PAT_LINK_INS (a link_code link needs a code redeemed by the caller for this patient)');
          if (name === 'account_patient_links' && (row['visible_from'] != null || row['status'] !== 'active') && row['method'] === 'link_code') throw pgErr('42501', 'RLS: PAT_LINK_INS (link_code: visible_from NULL, status active)');
          if (name === 'payment_requests' && (!a || row['account_id'] !== a['id'] || !t['account_patient_links']!.some((l) => l['tenant_id'] === tenant && l['account_id'] === a['id'] && l['patient_id'] === row['patient_id'] && l['status'] === 'active'))) throw pgErr('42501', 'RLS: payment_requests PAT_ACC_PID (account_id = the caller\'s account, patient_id = one of its active links)');
          if (name !== 'account_patient_links' && name !== 'number_counters' && name !== 'payment_requests') throw pgErr('42501', `RLS: patient actors cannot insert into ${name}`);
        }
        const d = D[name]!;
        const dup = rows.find((o) => d.unique.some((u) => u.every((c) => eq(o[c], row[c]))) || (d.conflictPartial && (d.partial ?? []).some((p) => p.where(row) && p.where(o) && p.cols.every((c) => eq(o[c], row[c])))));
        if (dup) {
          if (!im[4]) throw pgErr('23505', `duplicate key ${name}__pk`);
          if (/^do\s+nothing/i.test(im[4])) continue;
          if (im[6] && !where(im[6], values)({ ...dup })) continue;
          const next = { ...dup }; for (const a of splitTop(im[5]!)) { const i = a.indexOf('='); next[bare(a.slice(0, i))] = ev(strip(a.slice(i + 1)).replace(/\bexcluded\b\./gi, 'excluded.'), values, dup, row); }
          finish(name, next, dup); Object.assign(dup, next, { updated_at: now() }); out.push(copy(dup)); n++; continue;
        }
        finish(name, row, null); rows.push(row); out.push(copy(row)); n++;
      }
      return ok(im[7] ? out : [], n);
    }

    const um = /^update\s+(?:\w+\.)?\w+(?:\s+(?:as\s+)?(?!set\b)(\w+))?\s+set\s+(.+?)(?:\s+where\s+(.+?))?(?:\s+returning\s+(.+))?$/i.exec(sql);
    if (!um) throw new Error(`fake: unsupported UPDATE: ${sql}`);
    const pred = where(um[3], values); const sets = splitTop(strip(um[2]!)).map((a) => { const i = a.indexOf('='); return { c: bare(a.slice(0, i)), e: a.slice(i + 1) }; });
    const hit = rows.filter((r) => vis(r) && pred(r)); const out: Row[] = [];
    for (const r of hit) {
      const next = { ...r }; for (const s of sets) next[s.c] = ev(s.e, values, r);
      if (ctx.actor?.type === 'patient' && name === 'account_patient_links') { // 05-SCHEMA §4 patient column guard (probe P-L9): only relationship and revoke are allowed outside a DEFINER
        const bad = GUARDED.filter((c) => !eq(next[c], r[c]) && !(c === 'status' && next['status'] === 'revoked'));
        if (bad.length && !(next['status'] === 'revoked' && bad.every((c) => ['suspend_reason', 'suspended_at'].includes(c)))) throw pgErr('P0001', `immutable_row: ${bad.join(', ')}`);
      }
      Object.assign(next, { updated_at: next['updated_at'] === r['updated_at'] ? now() : next['updated_at'] }); finish(name, next, r); Object.assign(r, next); out.push(copy(r));
    }
    return ok(um[4] ? out : [], out.length);
  }

  // ---- ports & spies ----------------------------------------------------------------------------------------------------------------------------------------
  const demographics = new Map<string, Row>(); // patient id -> {fullName, sex, birthOn, phoneE164, status}
  const frontdesk = {
    calls: [] as Array<{ actor: string; input: Row }>, failNext: null as Error | null,
    async getPatientDemographics(ctx: any, input: Row) {
      frontdesk.calls.push({ actor: ctx.actor?.type, input: structuredClone(input) });
      if (frontdesk.failNext) { const e = frontdesk.failNext; frontdesk.failNext = null; throw e; }
      if (input['purpose'] !== 'patient_app_link') throw Object.assign(new Error('purpose'), { code: 'common.validation_failed' });
      const p = demographics.get(String(input['patientId'])); if (!p || p['tenantId'] !== ctx.tenantId) throw Object.assign(new Error('not found'), { code: 'common.not_found' });
      return { fullName: p['fullName'], sex: p['sex'], birthOn: p['birthOn'], phoneE164: p['phoneE164'], status: p['status'] ?? 'active' };
    },
  };
  const identity = {
    calls: [] as Array<{ permission: string; at: number }>, grants: null as null | string[],
    async assertRole(_c: unknown, r: { permission: string }) { identity.calls.push({ permission: r?.permission, at: stmts.length }); if (identity.grants && !identity.grants.includes(r?.permission)) throw Object.assign(new Error('auth.forbidden'), { code: 'auth.forbidden' }); },
    async getTenantSettings() { return { timezone: 'Asia/Kathmandu', calendarDisplay: 'AD_BS', branding: { legalName: LAB_NAME, displayName: LAB_NAME }, retentionYears: 7 }; },
  };
  const ports: Row = { IdentityPort: identity, FrontdeskPort: frontdesk };
  const logs: string[] = []; const logFn = (o: unknown, m?: unknown) => { logs.push(JSON.stringify({ o, m })); };
  const log: any = { info: logFn, warn: logFn, error: logFn, debug: logFn, child: () => log };
  const metricCalls: Array<{ name: string; labels: Record<string, string> }> = [];
  const metrics = { inc: (name: string, labels: Record<string, string> = {}) => { metricCalls.push({ name, labels }); }, set() {}, observe() {} };
  const audit: Row[] = [];
  const commit = { requested: false, calls: 0 };
  const base = (over: Row) => {
    const ref = { current: null as any };
    const ctx: any = { tenantId, requestId: ID(0xe1), clientIp: '203.0.113.7', now, ports, log, metrics, audit: { access: async (e: Row) => { audit.push(structuredClone(e)); }, event: async () => {} }, events: { publish: async () => {} }, ...over };
    ctx.tx = { async query(text: string, values: unknown[] = []) { return exec(ref.current, text, values); } }; ref.current = ctx; ctx.db = { tx: async (fn: any) => fn(ctx) };
    ctx.commitOnError = () => { commit.requested = true; commit.calls++; };
    return ctx;
  };
  const deep = (v: any): any => (v instanceof Uint8Array ? Buffer.from(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  /** Row OBJECT identity survives a rollback (tests keep references to seeded rows): rows are restored in place, rows inserted after the snapshot are dropped. */
  const snapshot = () => ({ tables: Object.fromEntries(Object.entries(t).map(([k, rows]) => [k, rows.map((r) => [r, deep(r)] as [Row, Row])])), auditLen: audit.length });
  const restore = (s: ReturnType<typeof snapshot>) => { for (const k of Object.keys(t)) { t[k]!.length = 0; for (const [ref, copy] of s.tables[k]!) { for (const c of Object.keys(ref)) delete ref[c]; Object.assign(ref, copy); t[k]!.push(ref); } } audit.length = s.auditLen; };
  /** One request transaction: DB state (incl. access-log rows) rolls back when the handler / task throws, UNLESS it called ctx.commitOnError() (08 A19 P-42). Port calls are not rolled back. */
  async function inTx<T>(f: () => Promise<T>): Promise<T> { const snap = snapshot(); commit.requested = false; try { return await f(); } catch (e) { if (!commit.requested) restore(snap); throw e; } }

  let userSeq = 0x5000;
  const api = {
    tenantId, t, stmts, now, advance: (ms: number) => { clock.t += ms; }, setNow: (iso: string) => { clock.t = Date.parse(iso); }, newId, ports, identity, frontdesk, logs, log, metricCalls, audit, commit, inTx, viewQueries, definerCalls,
    setSetting: (k: string, v: unknown) => { t['settings']![0]![k] = v; },
    demographics, setDemographics: (patientId: string, o: Row) => { demographics.set(patientId, { tenantId, status: 'active', sex: 'female', birthOn: '1990-01-01', phoneE164: '+99001000001', fullName: 'Synthetic Patient', ...o }); },
    seedAccount: (phone: string, over: Row = {}) => { const a: Row = { id: newId(), tenant_id: tenantId, membership_id: ID(++userSeq), user_id: ID(++userSeq), phone_e164: phone, phone_hmac: phoneHmac(tenantId, phone), status: 'active', reminders_opt_out: false, last_login_at: now(), version: 1, ...over }; t['accounts']!.push(a); return a; },
    seedCode: (patientId: string, over: Row = {}): Row => {
      const id = over['id'] ?? newId(); const consent = newId(); const plain: string = over['plain'] ?? 'ABCDE-FGH23'; const bound: string = over['boundPhone'] ?? '+99001000001';
      const { plain: _p, boundPhone: _b, ...rest } = over; void _p; void _b;
      const r: Row = { id, tenant_id: tenantId, patient_id: patientId, code_hmac: linkCodeHmac(tenantId, plain), bound_phone_hmac: phoneHmac(tenantId, bound), bound_phone_last2: bound.slice(-2), record_phone_hmac: phoneHmac(tenantId, '+99001000001'), relationship: 'self', consent_id: consent,
        display_name_snapshot: 'Synthetic Patient', sex_snapshot: 'female', issued_by_membership_id: ID(0x7aa), issued_centre_id: null, status: 'issued', revoke_reason: null, redeemed_at: null, redeemed_account_id: null, created_at: now(), created_by: ID(0x7aa),
        expires_at: new Date(clock.t + 72 * 3_600_000).toISOString(), updated_at: now(), updated_by: ID(0x7aa), ...rest };
      finish('link_codes', r, null); t['link_codes']!.push(r); return r;
    },
    seedLink: (accountId: string, patientId: string, over: Row = {}): Row => {
      const r: Row = { id: newId(), tenant_id: tenantId, account_id: accountId, patient_id: patientId, relationship: 'self', method: 'link_code', link_code_id: null, consent_id: null, display_name: 'Synthetic Patient', sex_snapshot: 'female', record_phone_hmac_at_link: null,
        created_by: ID(0x7aa), updated_by: ID(0x7aa), ...D['account_patient_links']!.defaults!(), ...over };
      if (r['method'] === 'link_code' && r['link_code_id'] == null) { // FK + CHECK method_code: a link_code link needs its (redeemed) code
        r['link_code_id'] = (api.seedCode(patientId, { plain: ('SEED' + String(++seq).padStart(6, '0')).slice(0, 10), status: 'redeemed', redeemed_at: now(), redeemed_account_id: accountId }) as Row)['id'];
      }
      finish('account_patient_links', r, null); t['account_patient_links']!.push(r); return r;
    },
    /** API RequestContext of a signed-in patient (02-TRD §4.1 step 4): actor {patient, user id}, claims {sub, tenant_id, membership_id, actor_type:'patient'}. */
    patientCtx: (account: Row, over: Row = {}) => base({ actor: { type: 'patient', id: account['user_id'] }, claims: { sub: account['user_id'], tenant_id: tenantId, membership_id: account['membership_id'], actor_type: 'patient', aal: 'aal1', session_state: 'active' }, ...over }),
    /** Worker JobContext (system actor). */
    jobCtx: (over: Row = {}) => base({ actor: { type: 'system', id: SYSTEM_ACTOR }, jobId: '1', attempt: 1, maxAttempts: 10, ...over }),
    jobs: (identifier?: string) => t['jobs']!.filter((j) => !identifier || j['identifier'] === identifier),
    writes: () => stmts.filter((s) => /^\s*(insert|update|delete)\b/i.test(s.text)),
    /** Everything an operator or attacker could read back: logs + audit rows + metric labels. */
    observed: () => JSON.stringify({ logs, audit, metricCalls }),
  };
  return api;
}
export type LinkWorld = ReturnType<typeof makeLinkWorld>;
