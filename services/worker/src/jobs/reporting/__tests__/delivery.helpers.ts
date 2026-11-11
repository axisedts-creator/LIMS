// C6-T23 test helpers (not a test file). Synthetic data only. Shared by the worker task tests (dispatch / send / fallback) and the API D1-D4 handler tests.
// World = release.helpers.releaseSetup() (T13: reports, versions, recording events/audit, single-transaction fake of consumers.helpers.makeDb) + the delivery tables:
//   reporting.deliveries / delivery_attempts / portal_links / channel_accounts / centre_contacts / message_template_texts / g_message_templates / qr_tokens / settings.
// The fake models SQL by CONTENT and only single-table statements (see consumers.helpers.ts). On top of it this file enforces the DDL rules of 05-SCHEMA that the
// fake does not model, so a buggy writer fails like Postgres would: CHECK sets, UNIQUE (idempotency key, one fallback per delivery, attempt_no per delivery,
// provider_message_id, global token hash), delivery_attempts = class A (no UPDATE/DELETE), deliveries immutable columns + the scrub-only params rule,
// status machine, portal_links token / ttl / purpose CHECKs. Also supports `params = params - 'url' - 'otp_code'` (jsonb minus) in UPDATE deliveries.
//
// ASSUMED job-runner semantics (repeated in .orchestra/notes/C6-T23-tests.md):
//   - a task that THROWS rolls back every write of its transaction (SAVEPOINT / ROLLBACK TO) EXCEPT when it called `ctx.commitOnError()` first; so "each attempt is
//     logged in delivery_attempts" (AC-09.1) holds either because the task resolves normally and re-enqueues itself, or because it calls ctx.commitOnError() before it throws.
//   - ctx = JobContext (+ ports, tx, events, audit, metrics, commitOnError); ports are the C0 shapes: ctx.ports.FrontdeskPort.getPatientDemographics,
//     ctx.ports.IdentityPort.getTenantSettings, ctx.ports.CatalogPort.getReferrer (system actor, purpose 'notification').
import { createHash } from 'node:crypto';
import { releaseSetup, released, rendered, V, USER, MEMBERSHIP, TENANT_A, TENANT_B, idN, I, LAB, PHONE, EMAIL, FULL_NAME, REG_NO, NOW, SYSTEM_ACTOR, rejection, settle, type Row } from './release.helpers.js';
import { pgError } from './consumers.helpers.js';
import { PORTAL_ORIGIN } from './assemble.helpers.js';
import { TransportError } from '../../../../../api/src/modules/reporting/delivery/transport.js';

export { released, rendered, V, USER, MEMBERSHIP, TENANT_A, TENANT_B, idN, I, LAB, PHONE, EMAIL, FULL_NAME, REG_NO, NOW, SYSTEM_ACTOR, rejection, settle, PORTAL_ORIGIN };
export type { Row };

export const LAB_NAME = 'Synthetic Lab';
export const LAB_PHONE = '+97714000000';
export const REFERRER_PHONE = '+9779800000077';
export const CENTRE_PHONE = '+9779800000088';
export const sha256buf = (s: string) => createHash('sha256').update(s, 'utf8').digest();
export const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const D = (n: number) => idN(0xd000 + n);            // delivery ids
export const LINK = (n: number) => idN(0x1100 + n);         // portal link ids
export const CONTACT = (n: number) => idN(0xcc00 + n);      // centre contact ids
export const ACC = { whatsapp: idN(0xacc1), sms: idN(0xacc2), email: idN(0xacc3) } as const;
export const DISPATCH = 'reporting.dispatch_release_deliveries';
export const SEND = 'reporting.send_delivery';
export const FALLBACK = 'reporting.check_whatsapp_fallback';
export const STATUS_EVENT = 'reporting.delivery.status_changed.v1';
export const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

const base = { tenant_id: TENANT_A, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR };

/** A `reporting.deliveries` row as the NotificationPort / dispatch writes it (queued WhatsApp report_ready, deferred link, no URL stored). */
export const dRow = (n: number, over: Row = {}): Row => ({
  ...base, id: D(n), centre_id: I.centre, channel: 'whatsapp', purpose: 'report_ready', template_code: 'reporting.report_ready', recipient_kind: 'patient', recipient_id: I.patient,
  destination_masked: '+97798•••••042', destination_sha256: sha256buf(PHONE), destination_e164: null, params: { lab_name: LAB_NAME }, language: 'en',
  idempotency_key: `${V(1)}:report_ready:patient:whatsapp:${n}`, related_entity_type: 'report', related_entity_id: LAB, report_id: LAB, report_version_no: 1,
  deferred_link: { report_id: LAB, version_no: 1, channel: 'whatsapp', recipient_kind: 'patient' }, link_id: null, status: 'queued', failure_code: null, attempt_no: 1,
  channel_account_id: null, provider_kind: null, provider_message_id: null, fallback_of_delivery_id: null, fallback_check_at: null,
  queued_at: minutesAgo(1), sent_at: null, delivered_at: null, read_at: null, failed_at: null, suppressed_at: null, version: 1,
  created_at: minutesAgo(1), updated_at: minutesAgo(1), ...over,
});
/** The same for a delivery already `sent` `minutes` ago (provider message id set). */
export const sentRow = (n: number, minutes: number, over: Row = {}): Row => dRow(n, {
  status: 'sent', sent_at: minutesAgo(minutes), queued_at: minutesAgo(minutes + 1), provider_kind: 'recording', provider_message_id: `rec-${n}`, channel_account_id: ACC.whatsapp, version: 2, ...over });
/** A live (unrevoked) portal link row of the report. */
export const linkRow = (n: number, over: Row = {}): Row => ({
  ...base, id: LINK(n), centre_id: I.centre, report_id: LAB, bound_version_no: 1, channel: 'whatsapp', recipient_kind: 'patient', recipient_ref_id: null, otp_channel: null,
  destination_masked: null, destination_sha256: null, patient_display_snapshot: 'T. P.', token_sha256: sha256buf(`seed-token-${n}`), expires_at: '2026-12-07T12:00:00.000Z',
  revoked_at: null, revoked_by: null, revoke_reason_code: null, delivery_id: null, reissued_from_link_id: null, last_used_at: null, use_count: 0, redeem_failures: 0, purpose: 'report',
  version: 1, created_at: minutesAgo(5), updated_at: minutesAgo(5), ...over });

const TEMPLATES: Row[] = [
  { code: 'reporting.report_ready', purpose: 'report_ready', channels: ['whatsapp', 'sms', 'email'], params: [{ name: 'lab_name', kind: 'short_text' }, { name: 'url', kind: 'url' }], is_active: true, default_texts: {} },
  { code: 'reporting.dues_due', purpose: 'dues_reminder', channels: ['sms', 'whatsapp'], params: [{ name: 'lab_name', kind: 'short_text' }, { name: 'amount_text', kind: 'short_text' }, { name: 'url', kind: 'url' }], is_active: true, default_texts: {} },
  { code: 'reporting.portal_otp', purpose: 'otp', channels: ['sms', 'email'], params: [{ name: 'otp_code', kind: 'otp_code' }, { name: 'lab_name', kind: 'short_text' }, { name: 'minutes', kind: 'minutes' }], is_active: true, default_texts: {} },
  { code: 'engagement.login_otp', purpose: 'otp', channels: ['sms'], params: [{ name: 'otp_code', kind: 'otp_code' }, { name: 'lab_name', kind: 'short_text' }, { name: 'minutes', kind: 'minutes' }], is_active: true, default_texts: {} },
  // C6-T24 (appended last: text-row ids derive from the index): 04-UI-UX §7, no url param (08 A13 D-35)
  { code: 'reporting.critical_value_alert', purpose: 'critical_value_alert', channels: ['sms', 'whatsapp'], params: [{ name: 'lab_name', kind: 'short_text' }, { name: 'lab_phone', kind: 'phone' }, { name: 'ref', kind: 'short_text' }], is_active: true, default_texts: {} },
];
const BODY: Record<string, string> = {
  'reporting.report_ready': 'Report ready from {lab_name}: {url}', 'reporting.dues_due': '{lab_name}: NPR due {amount_text}. Pay: {url}',
  'reporting.portal_otp': 'Your code {otp_code} for {lab_name} is valid {minutes} minutes.', 'engagement.login_otp': 'Your code {otp_code} for {lab_name} is valid {minutes} minutes.',
  'reporting.critical_value_alert': '{lab_name}: critical result for your patient. Please call {lab_phone} now. Ref {ref}.',
};
const textRows = (): Row[] => TEMPLATES.flatMap((t) => (t['channels'] as string[]).map((ch, i) => ({
  ...base, id: idN(0x7e00 + TEMPLATES.indexOf(t) * 10 + i), template_code: t['code'], channel: ch, language: 'en', body_text: BODY[t['code']], subject_text: ch === 'email' ? 'Your report from {lab_name}' : null,
  provider_template_name: ch === 'whatsapp' ? String(t['code']).replace('.', '_') : null, provider_template_language: ch === 'whatsapp' ? 'en' : null,
  provider_variable_order: ch === 'whatsapp' ? (t['params'] as any[]).map((p) => p.name) : null, approval_status: ch === 'whatsapp' ? 'approved' : 'not_required', version: 1 })));

// ------------------------------------------------------------------------------------------------ ports
export interface PortOpts {
  consent?: { sms?: boolean; whatsapp?: boolean; email?: boolean; shareWithReferrer?: boolean };
  phone?: string | null; email?: string | null;
  channels?: { smsEnabled?: boolean; whatsappEnabled?: boolean; emailEnabled?: boolean };
  referrer?: false | { phoneE164?: string | null; email?: string | null };
  frontdeskDown?: boolean;
}
export function makePorts(o: PortOpts = {}) {
  const consent = { sms: true, whatsapp: true, email: true, shareWithReferrer: true, ...o.consent };
  const channels = { smsEnabled: true, whatsappEnabled: true, emailEnabled: true, ...o.channels };
  const calls = { frontdesk: [] as Array<{ patientId: string; purpose: string; actorType: string }>, identity: [] as Array<{ keys: unknown; actorType: string }>, catalog: [] as Array<{ referrerId: string; purpose: string; actorType: string }>, forbidden: [] as string[] };
  const mutable = { consent, channels, phone: o.phone === undefined ? PHONE : o.phone, email: o.email === undefined ? EMAIL : o.email, referrer: o.referrer ?? { phoneE164: REFERRER_PHONE } };
  const ports = {
    FrontdeskPort: {
      async getPatientDemographics(ctx: any, i: { patientId: string; purpose: string }) {
        calls.frontdesk.push({ patientId: i.patientId, purpose: i.purpose, actorType: ctx?.actor?.type });
        if (o.frontdeskDown) throw Object.assign(new Error('frontdesk down'), { code: 'common.unavailable' });
        if (i.purpose !== 'notification') throw Object.assign(new Error('purpose not allowed'), { code: 'common.forbidden' });
        const sys = ctx?.actor?.type === 'system';   // CR-C6-015: only system actors read the raw contact
        return { patientId: i.patientId, patientCode: 'P0042', fullName: FULL_NAME, sex: 'female', status: 'active', consents: { ...mutable.consent, consentTextVersion: 'v1' },
          ...(sys && mutable.phone ? { phoneE164: mutable.phone } : {}), ...(sys && mutable.email ? { email: mutable.email } : {}), contactPresence: { phone: !!mutable.phone, email: !!mutable.email } };
      },
    },
    IdentityPort: {
      async getTenantSettings(ctx: any, i: { keys: unknown }) { calls.identity.push({ keys: i?.keys, actorType: ctx?.actor?.type }); return { channels: { ...mutable.channels }, reportLinkTtlDays: 30, labName: LAB_NAME,
        branding: { legalName: 'Synthetic Laboratory Pvt Ltd', displayName: LAB_NAME, addressLines: [], phones: [LAB_PHONE] } }; },   // IC 03 §IdentityPort.getTenantSettings branding (phones <= 3, each <= 40)
    },
    CatalogPort: {
      async getReferrer(ctx: any, i: { referrerId: string; purpose: string }) {
        calls.catalog.push({ referrerId: i.referrerId, purpose: i.purpose, actorType: ctx?.actor?.type });
        if (!mutable.referrer) throw Object.assign(new Error('not found'), { code: 'common.not_found' });
        const r = mutable.referrer;
        return { id: i.referrerId, referrerId: i.referrerId, name: 'Dr Synthetic', displayName: 'Dr Synthetic', ...(r.phoneE164 ? { phoneE164: r.phoneE164, phone: r.phoneE164 } : {}), ...(r.email ? { email: r.email } : {}) };
      },
    },
    // C6 never calls these while delivering (07-SECURITY: no billing / payment / smart-report access from the send path)
    BillingPort: new Proxy({}, { get: (_t, k) => async () => { calls.forbidden.push(`BillingPort.${String(k)}`); throw new Error('forbidden port call'); } }),
    PaymentProviderPort: new Proxy({}, { get: (_t, k) => async () => { calls.forbidden.push(`PaymentProviderPort.${String(k)}`); throw new Error('forbidden port call'); } }),
    SmartReportPort: new Proxy({}, { get: (_t, k) => async () => { calls.forbidden.push(`SmartReportPort.${String(k)}`); throw new Error('forbidden port call'); } }),
  };
  // both spellings exist in this module (NotificationPort.impl uses ctx.ports.FrontdeskPort, release.service uses ctx.ports.frontdesk): serve both
  const aliased = { ...ports, frontdesk: ports.FrontdeskPort, identity: ports.IdentityPort, catalog: ports.CatalogPort, billing: ports.BillingPort, payment: ports.PaymentProviderPort, smartReport: ports.SmartReportPort };
  return { ports: aliased as typeof ports & Record<string, any>, calls, mutable };
}

// ------------------------------------------------------------------------------------------------ transports (injected into the send task)
export interface SentMessage { providerKind: string; msg: any; creds: unknown; tenantTxRows: number }
export function makeTransport(providerKind: string, behaviour: (n: number, msg: any) => 'ok' | Error | Promise<'ok' | Error> = () => 'ok') {
  const sent: SentMessage[] = []; let n = 0;
  return {
    providerKind, sent,
    get calls() { return n; },
    async send(msg: any, creds: unknown) {
      n += 1; sent.push({ providerKind, msg: structuredClone(msg), creds, tenantTxRows: 0 });
      const r = await behaviour(n, msg);
      if (r !== 'ok') throw r;
      return { providerMessageId: `${providerKind}-msg-${n}`, acceptedAt: NOW };
    },
  };
}
/** The real TransportError of delivery/transport.ts (02-TRD §5.4). */
export async function transportError(retryable: boolean, failureCode: string): Promise<Error> {
  return new TransportError(retryable, failureCode);
}

// ------------------------------------------------------------------------------------------------ DDL rules + tx wrapper
const DSTATUS = ['queued', 'sent', 'delivered', 'read', 'failed', 'suppressed'];
const NEXT: Record<string, string[]> = { queued: ['sent', 'failed', 'suppressed'], sent: ['delivered', 'read', 'failed'], delivered: ['read', 'failed'], read: [], failed: ['queued'], suppressed: [] };
const DMUTABLE = new Set(['status', 'failure_code', 'attempt_no', 'channel_account_id', 'provider_kind', 'provider_message_id', 'link_id', 'fallback_check_at', 'queued_at', 'sent_at',
  'delivered_at', 'read_at', 'failed_at', 'suppressed_at', 'destination_masked', 'destination_sha256', 'params', 'destination_e164', 'updated_at', 'updated_by', 'version']);
const PURPOSES = ['registration_confirmation', 'report_ready', 'otp', 'dues_reminder', 'recollection_request', 'critical_value_alert', 'booking_confirmation', 'visit_assignment', 'follow_up_reminder',
  'scheduled_report_ready', 'booking_cancelled', 'booking_reminder'];
const JSONC: Record<string, string[]> = { deliveries: ['params', 'deferred_link'], delivery_attempts: [], portal_links: [] };
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);

export function delivered(db: ReturnType<typeof releaseSetup>['db'], clock: { t: string }) {
  const base = db.tx; const rows = (t: string) => db.store[`reporting.${t}`] ?? (db.store[`reporting.${t}`] = []);
  const sigs = new Map<string, string>(); const prms = new Map<string, any>(); const e164 = new Map<string, any>(); const stat = new Map<string, string>();
  const sig = (r: Row) => JSON.stringify(Object.keys(r).filter((k) => !DMUTABLE.has(k)).sort().map((k) => [k, r[k] instanceof Buffer ? r[k].toString('hex') : r[k]]));
  const remember = () => { for (const r of rows('deliveries')) if (!sigs.has(r['id'])) { sigs.set(r['id'], sig(r)); prms.set(r['id'], structuredClone(r['params'])); e164.set(r['id'], r['destination_e164']); stat.set(r['id'], r['status']); } };
  const normalise = (t: string) => { for (const r of rows(t)) { for (const k of Object.keys(r)) { r[k] = iso(r[k]); } for (const c of JSONC[t] ?? []) if (typeof r[c] === 'string') r[c] = JSON.parse(r[c]); } };
  const bad = (code: string, m: string) => { throw pgError(code, m); };
  const tx: any = {
    get startedAt() { return new Date(clock.t); },
    savepoint: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
    async query(text: string, values: unknown[] = []) {
      const verb = (/^\s*(select|insert|update|delete)/i.exec(text)?.[1] ?? 'other').toLowerCase();
      const T = /\b(?:into|update|from)\s+reporting\.(deliveries|delivery_attempts|portal_links)\b/i.exec(text)?.[1];
      remember();
      if (verb === 'select') {                              // the fake ignores ORDER BY / LIMIT: apply them here so keyset pagination and "newest first" are testable
        const res0 = await base.query(text, values); const flat = text.replace(/\s+/g, ' ');
        const ob = /\border by ([\w., ]+?)(?: nulls (?:first|last))?(?: limit (\$\d+|\d+)| for update|$)/i.exec(flat);
        if (ob) {
          const cols = ob[1]!.split(',').map((c) => c.trim().split(' ')); const rowsOut = [...res0.rows];
          rowsOut.sort((a, b) => { for (const [c, dir] of cols) { const k = c!.replace(/^\w+\./, ''); const x = a[k] ?? ''; const y = b[k] ?? ''; if (x < y) return /^desc$/i.test(dir ?? '') ? 1 : -1; if (x > y) return /^desc$/i.test(dir ?? '') ? -1 : 1; } return 0; });
          const lim = ob[2] ?? /\blimit (\$\d+|\d+)/i.exec(flat)?.[1];
          const n = lim === undefined ? undefined : /^\$/.test(lim) ? Number(values[Number(lim.slice(1)) - 1]) : Number(lim);
          return { rows: n === undefined ? rowsOut : rowsOut.slice(0, n) };
        }
        const lim = /\blimit (\$\d+|\d+)/i.exec(flat)?.[1];
        return lim === undefined ? res0 : { rows: res0.rows.slice(0, /^\$/.test(lim) ? Number(values[Number(lim.slice(1)) - 1]) : Number(lim)) };
      }
      if (T === 'delivery_attempts' && (verb === 'update' || verb === 'delete')) bad('42501', 'permission denied for table delivery_attempts (class A: no UPDATE/DELETE grant)');
      if (T && verb === 'delete') bad('42501', `permission denied for table ${T}`);
      let sql = text; let minus: { keys: string[]; ids: string[] } | undefined;
      if (T === 'deliveries' && verb === 'update') {      // params = params - 'url' - 'otp_code'  (jsonb minus)
        const norm = text.replace(/\s+/g, ' ');
        const m = /params = (?:\w+\.)?params((?: - '[a-z_]+')+)/i.exec(norm);
        if (m) {
          const where = /\bwhere\b([\s\S]*?)(?:\breturning\b[\s\S]*)?$/i.exec(norm)![1]!;
          const hit = (await base.query(`SELECT id FROM reporting.deliveries WHERE ${where}`, values)).rows.map((r: Row) => r['id']);
          minus = { keys: [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!), ids: hit };
          const rest = norm.replace(m[0], '__SCRUB__').replace(/__SCRUB__\s*,\s*/, '').replace(/\s*,\s*__SCRUB__/, '').replace('__SCRUB__', '');
          sql = /\bset\s+(where|returning)\b/i.test(rest) ? '' : rest;
        }
      }
      const before = T ? rows(T).length : 0;
      const snap = T && (verb === 'insert' || verb === 'update') ? structuredClone(rows(T)) : null;   // a failing statement leaves nothing behind (statement atomicity)
      const restore = () => { if (snap && T) rows(T).splice(0, rows(T).length, ...snap); };
      try {
      let res: { rows: Row[] } = sql === '' ? { rows: minus!.ids.map((id) => ({ id })) } : await base.query(sql, values);
      if (minus) for (const r of rows('deliveries')) if (minus.ids.includes(r['id'])) { const p = { ...(typeof r['params'] === 'string' ? JSON.parse(r['params']) : r['params']) }; for (const k of minus.keys) delete p[k]; r['params'] = p; }
      if (!T || (verb !== 'insert' && verb !== 'update')) return res;
      normalise(T);
      if (verb === 'insert') {
        const added = rows(T).slice(before);
        for (const r of added) {
          const drop = () => { rows(T).splice(rows(T).indexOf(r), 1); };
          const dupOf = (f: (e: Row) => boolean) => rows(T).some((e) => e !== r && f(e));
          const conflict = (code: string, msg: string) => { drop(); if (/\bon\s+conflict\b/i.test(text)) { res = { rows: [] }; return true; } return bad(code, msg); };
          if (T === 'deliveries') {
            Object.assign(r, { attempt_no: 1, version: 1, params: {}, language: 'en', failure_code: null, link_id: null, fallback_of_delivery_id: null, deferred_link: null, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) });
            const ck = (c: boolean, m: string) => { if (!c) { drop(); bad('23514', `deliveries check: ${m}`); } };
            ck(['whatsapp', 'sms', 'email', 'print', 'portal'].includes(r['channel']), 'channel'); ck(DSTATUS.includes(r['status']), 'status'); ck(PURPOSES.includes(r['purpose']), `purpose ${r['purpose']}`);
            ck(['patient', 'referrer', 'centre', 'partner', 'staff', 'phone_otp'].includes(r['recipient_kind']), 'recipient_kind');
            ck((['print', 'portal'].includes(r['channel'])) === (r['template_code'] == null), 'template_code NULL <=> print|portal');
            ck(r['destination_sha256'] == null || (Buffer.isBuffer(r['destination_sha256']) && r['destination_sha256'].length === 32), 'destination_sha256 32 bytes');
            ck(r['destination_e164'] == null || (r['recipient_kind'] === 'phone_otp' && /^\+[1-9][0-9]{7,14}$/.test(r['destination_e164'])), 'destination_e164 only phone_otp');
            ck(r['destination_masked'] == null || String(r['destination_masked']).length <= 40, 'destination_masked <= 40');
            ck(String(r['idempotency_key'] ?? '').length >= 1 && String(r['idempotency_key']).length <= 200, 'idempotency_key 1..200');
            ck(typeof r['params'] === 'object' && r['params'] !== null && !Array.isArray(r['params']) && JSON.stringify(r['params']).length <= 2048, 'params object <= 2048');
            ck(r['tenant_id'] != null && r['created_by'] != null && r['updated_by'] != null, 'tenant_id / created_by / updated_by NOT NULL');
            ck(r['template_code'] == null || TEMPLATES.some((t) => t['code'] === r['template_code']), 'template_code FK');
            if (dupOf((e) => e['tenant_id'] === r['tenant_id'] && e['idempotency_key'] === r['idempotency_key'])) { if (conflict('23505', 'deliveries__tenant_id_idempotency_key__uq')) continue; }
            if (r['fallback_of_delivery_id'] != null) {
              if (!rows('deliveries').some((e) => e !== r && e['id'] === r['fallback_of_delivery_id'] && e['tenant_id'] === r['tenant_id'])) { drop(); bad('23503', 'deliveries__fallback__fk'); }
              if (dupOf((e) => e['tenant_id'] === r['tenant_id'] && e['fallback_of_delivery_id'] === r['fallback_of_delivery_id'])) { if (conflict('23505', 'deliveries__tenant_id_fallback_of_delivery_id__p_uq')) continue; }
            }
            sigs.set(r['id'], sig(r)); prms.set(r['id'], structuredClone(r['params'])); e164.set(r['id'], r['destination_e164']); stat.set(r['id'], r['status']);
          } else if (T === 'delivery_attempts') {
            Object.assign(r, { finished_at: null, error_code: null, provider_status_raw: null, latency_ms: null, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) });
            if (!['accepted', 'retryable_error', 'permanent_error', 'suppressed', 'circuit_open'].includes(r['outcome'])) { drop(); bad('23514', 'delivery_attempts__outcome__ck'); }
            if (r['error_code'] != null && String(r['error_code']).length > 64) { drop(); bad('23514', 'delivery_attempts__len__ck'); }
            if (!rows('deliveries').some((e) => e['id'] === r['delivery_id'] && e['tenant_id'] === r['tenant_id'])) { drop(); bad('23503', 'delivery_attempts__delivery__fk'); }
            if (dupOf((e) => e['tenant_id'] === r['tenant_id'] && e['delivery_id'] === r['delivery_id'] && e['attempt_no'] === r['attempt_no'])) { if (conflict('23505', 'delivery_attempts__tenant_id_delivery_id_attempt_no__uq')) continue; }
          } else {
            Object.assign(r, { use_count: 0, redeem_failures: 0, reissue_count_day: 0, purpose: 'report', version: 1, revoked_at: null, revoke_reason_code: null, delivery_id: null, reissued_from_link_id: null, recipient_ref_id: null, destination_sha256: null, destination_masked: null, created_at: clock.t, updated_at: clock.t, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) });
            const ck = (c: boolean, m: string) => { if (!c) { drop(); bad('23514', `portal_links check: ${m}`); } };
            ck(Buffer.isBuffer(r['token_sha256']) && r['token_sha256'].length === 32, 'token_sha256 32 bytes');
            ck(['whatsapp', 'sms', 'email', 'print_qr', 'patient_app'].includes(r['channel']), 'channel'); ck(['patient', 'referrer', 'centre', 'partner'].includes(r['recipient_kind']), 'recipient_kind');
            ck(['report', 'dues'].includes(r['purpose']) && (r['purpose'] === 'report' || (r['recipient_kind'] === 'patient' && ['sms', 'whatsapp'].includes(r['channel']))), 'purpose');
            ck(r['patient_display_snapshot'] != null && String(r['patient_display_snapshot']).length <= 60, 'patient_display_snapshot <= 60');
            const exp = Date.parse(String(r['expires_at'])); const cr = Date.parse(String(r['created_at']));
            ck(Number.isFinite(exp) && exp > cr && exp <= cr + 90 * 86_400_000, 'expires_at within (created_at, +90d]');
            if (dupOf((e) => Buffer.isBuffer(e['token_sha256']) && e['token_sha256'].equals(r['token_sha256']))) conflict('23505', 'portal_links__token_sha256__uq');
          }
        }
      } else if (T === 'deliveries') {
        for (const r of rows('deliveries')) {
          const s0 = sigs.get(r['id']); if (s0 !== undefined && sig(r) !== s0) bad('P0001', 'immutable_row reporting.deliveries (non-mutable column changed)');
          const p0 = prms.get(r['id']);
          if (JSON.stringify(r['params']) !== JSON.stringify(p0)) { const scrubbed = { ...p0 }; delete scrubbed.url; delete scrubbed.otp_code; if (JSON.stringify(r['params']) !== JSON.stringify(scrubbed)) bad('P0001', 'immutable_row reporting.deliveries params (scrub-only)'); prms.set(r['id'], structuredClone(r['params'])); }
          const e0 = e164.get(r['id']); if (r['destination_e164'] !== e0 && r['destination_e164'] != null) bad('P0001', 'immutable_row reporting.deliveries destination'); e164.set(r['id'], r['destination_e164']);
          const st0 = stat.get(r['id']); if (st0 !== undefined && r['status'] !== st0) { if (!DSTATUS.includes(r['status'])) bad('23514', 'deliveries__status__ck'); if (!NEXT[st0]!.includes(r['status'])) bad('P0001', `forbidden delivery transition ${st0} -> ${r['status']}`); stat.set(r['id'], r['status']); }
        }
      }
      return res;
      } catch (e) { restore(); throw e; }
    },
  };
  return tx;
}

// ------------------------------------------------------------------------------------------------ the world
export interface DWorldOpts extends PortOpts {
  versions?: Row[];                                   // default: released v1 with audiences ['patient','centre']
  audiences?: string[];
  settings?: Row;                                     // overrides of the delivery columns of reporting.settings
  accounts?: Partial<Record<'whatsapp' | 'sms' | 'email', string | null>>;   // provider_kind per channel account (null = no account); default 'recording'
  centreContacts?: Row[]; deliveries?: Row[]; links?: Row[]; attempts?: Row[];
  extraSeed?: Record<string, Row[]>; rls?: boolean;
  env?: Record<string, string | undefined>;
}
export function deliveryWorld(o: DWorldOpts = {}) {
  const clock = { t: NOW };
  const versions = o.versions ?? [released(1, { audiences: o.audiences ?? ['patient', 'centre'] })];
  const accounts = { whatsapp: 'recording', sms: 'recording', email: 'recording', ...o.accounts } as Record<'whatsapp' | 'sms' | 'email', string | null>;
  const s = releaseSetup({
    versions, ...(o.rls === undefined ? {} : { rls: o.rls }),
    extraSeed: {
      'reporting.settings': [{ ...base, centre_id: I.centre, id: idN(0x5e7), narrative_report_mode: 'separate', auto_release: 'when_eligible', print_critical_label: false,
        patient_mobile_channel_order: ['whatsapp', 'sms'], patient_email_enabled: true, referrer_delivery_enabled: true, referrer_channels: ['sms'], centre_delivery_enabled: false,
        whatsapp_fallback_minutes: 30, dues_link_enabled: true, version: 1, ...o.settings }],
      'reporting.g_message_templates': TEMPLATES.map((t) => ({ ...t })), 'reporting.message_template_texts': textRows(),
      'reporting.channel_accounts': (['whatsapp', 'sms', 'email'] as const).filter((c) => accounts[c] !== null).map((c) => ({ ...base, id: ACC[c], channel: c, provider_kind: accounts[c], sender_id: 'SYN', secret_ref: `syn/${c}`, is_active: true, version: 1 })),
      'reporting.qr_tokens': [{ ...base, id: idN(0x9a10), centre_id: I.centre, report_id: LAB, report_version_id: V(1), token_sha256: sha256buf('seed-qr-1'), lab_name_snapshot: LAB_NAME, patient_display_snapshot: 'T. P.', panel_names_snapshot: [], issued_at: minutesAgo(30) }],
      'reporting.centre_contacts': (o.centreContacts ?? []).map((c) => ({ ...base, centre_id: I.centre, is_active: true, label: null, created_at: minutesAgo(60), ...c })),
      'reporting.deliveries': (o.deliveries ?? []).map((d) => ({ ...d })), 'reporting.delivery_attempts': (o.attempts ?? []).map((a) => ({ ...a })), 'reporting.portal_links': (o.links ?? []).map((l) => ({ ...l })),
      ...o.extraSeed,
    },
  });
  const tx = delivered(s.db, clock);
  const pr = makePorts(o);
  const env = { NODE_ENV: 'test', LIMS_ORIGIN_PORTAL: PORTAL_ORIGIN, ...o.env } as Record<string, string | undefined>;
  const flags = { commit: false };
  const ctx = (over: Row = {}): any => {
    const c = s.jobCtx();
    return Object.assign(c, { tx, ports: pr.ports, now: () => clock.t, attempt: 1, maxAttempts: 8, metrics: { inc() {}, observe() {} }, commitOnError: () => { flags.commit = true; }, ...over });
  };
  let sp = 0;
  /** Runs a task like the worker pipeline: a throw rolls back its writes (and published events / access-log rows) unless it called ctx.commitOnError(). Returns 'ok' or the thrown error. */
  async function run(task: (p: any, c: any) => Promise<void>, payload: any, over: Row = {}): Promise<'ok' | Error> {
    const name = `job_${++sp}`; const mark = { ev: s.published.length, au: s.accessLog.length, logs: 0 }; flags.commit = false;
    await tx.query(`SAVEPOINT ${name}`, []);
    try { await task(payload, ctx(over)); return 'ok'; } catch (e) {
      if (!flags.commit) { await tx.query(`ROLLBACK TO SAVEPOINT ${name}`, []); s.published.length = mark.ev; s.accessLog.length = mark.au; }
      return e as Error;
    }
  }
  const rows = (t: string) => s.db.all(`reporting.${t}`);
  const w = {
    ...s, clock, tx, env, ports: pr.ports, portCalls: pr.calls, portState: pr.mutable, ctx, run,
    deliveries: () => rows('deliveries'), delivery: (id: string) => rows('deliveries').find((r) => r['id'] === id)!,
    attempts: (id?: string) => rows('delivery_attempts').filter((a) => id === undefined || a['delivery_id'] === id).sort((a, b) => a['attempt_no'] - b['attempt_no']),
    portalLinks: () => rows('portal_links'), linksOf: (deliveryId: string) => rows('portal_links').filter((l) => l['delivery_id'] === deliveryId),
    statusEvents: () => s.published.filter((p) => p.type === STATUS_EVENT), sendJobs: () => s.db.jobs.filter((j) => j.identifier === SEND),
    fallbacksOf: (id: string) => rows('deliveries').filter((d) => d['fallback_of_delivery_id'] === id),
    everything: () => JSON.stringify({ db: s.db.store, jobs: s.db.jobs, ev: s.published, au: s.accessLog, logs: s.logs.text() }),
    /** everything EXCEPT the tables that legitimately hold the contact / hash (for "never stored in plaintext" scans). */
    leakText: () => JSON.stringify({ jobs: s.db.jobs, ev: s.published, au: s.accessLog, logs: s.logs.text() }),
  };
  return w;
}
export type DW = ReturnType<typeof deliveryWorld>;

/** The plaintext link token inside a message body `.../r/<22 base64url chars>` (what the provider received). */
export const tokenIn = (body: string): string | undefined => new RegExp(`${PORTAL_ORIGIN.replace(/[.]/g, '\\.')}/r/([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])`).exec(body)?.[1];
