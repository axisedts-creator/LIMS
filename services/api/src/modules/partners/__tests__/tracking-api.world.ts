// C13 T13 test fixture (tester-owned, not a test file): request-context world for the partner tracking + report API (O1-O3, R1-R3).
// Builds on the T17/T12 SQL world (projection.world.ts + TRACKING_DEFS of tracking.world.ts): SAME SQL subset (single-table SELECT / INSERT .. ON CONFLICT / UPDATE / DELETE,
// bound $n only, no joins, no sub-selects, no aggregates). Writable here: partners.order_reports, order_tracking, tracked_specimens, manifest_lines, download_counters.
// Read-only: partners.manifests, partner_referrers, settings, partners, partner_users. The world runs with rls=false: the handler must scope by tenant_id AND partner_id itself.
// Request ctx emulates the pipeline: IdentityPort.assertRole, ReportingPort fake (openReleasedReportFile), ctx.audit.access (validates like core/audit/access.ts),
// ctx.commitOnError, ctx.rateLimit.consume (stateful sliding counter), ctx.metrics (SEAM). `run` emulates pipeline stage 11: an error rolls the tables AND the access log back
// unless the handler called ctx.commitOnError().
// All data synthetic. Report bytes are fake PDFs; the signed URL carries a marker (SECRETSIG) that must never be seen anywhere but in the fetch call.
import { createHash } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import { TRACKING_DEFS } from './tracking.world.js';
import { id, makeWorld, NOW, P, SYSTEM, T_A, T_B, type Def, type Row, type World } from './projection.world.js';

export { id, P, SYSTEM, T_A, T_B };
export type { Row, World };

export const NOW13 = '2026-11-13T06:00:00.000Z'; // 11:45 in Asia/Kathmandu: same calendar day as UTC
export const TODAY = '2026-11-13';
export const iso = (v: unknown) => new Date(v as string).toISOString();
const at = (s: string) => new Date(s);

export const U = { adminX: id(500), memberX: id(501), adminY: id(502), adminZ: id(503), adminB: id(504) };
const M = { adminX: id(510), memberX: id(511), adminY: id(512), adminZ: id(513), adminB: id(514) };
export type Who = keyof typeof U;
export const ORD = { new: id(601), lab: id(602), rep: id(603), act: id(604), canc: id(605), y: id(606), b: id(607) };
export const LINE = { new: id(611), lab: id(612), rep: id(613), act: id(614), canc: id(615), y: id(616), b: id(617) };
export const MAN = { m1: id(621), m2: id(622), y: id(623), b: id(624) };
export const REF = { r1: id(631), y: id(632) };
export const RPT = { a: id(641), b: id(642), c: id(643), d: id(644), y: id(645), bb: id(646), unknown: id(649) };
export const SPEC = { a: id(651), b: id(652), repl: id(653) };
export const CENTRE = id(60);

/** planted PHI / lab-linked identifiers that must never reach a log, an access-log detail, an SQL text or a response they do not belong in */
export const PHI = { phone: '+15555550142', note: 'SYN planted clinical note', dob: '1990-04-12' };

const DL: Def = {
  pk: ['tenant_id', 'partner_user_id', 'day'], fk: true, bigint: [], notNull: ['tenant_id', 'partner_user_id', 'day', 'partner_id', 'count', 'created_by', 'updated_by'],
  defaults: { created_at: () => NOW, updated_at: () => NOW, count: () => 0, expires_at: () => new Date(NOW.getTime() + 30 * 86_400_000) },
  check: (r) => (r.count >= 0 ? null : 'download_counters__count__ck'),
};
export const makeWorld13 = () => makeWorld({ defs: { ...TRACKING_DEFS, 'partners.download_counters': DL }, tables: ['partners.manifests', 'partners.partner_referrers'] });

// ------------------------------------------------------------------ report files (port + storage fakes)
export const pdf = (key: string) => Buffer.from(`%PDF-1.4\n% synthetic report ${key}\n%%EOF`);
export const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const rkey = (report: string, v: number) => `${report}:${v}`;
export const signedUrl = (report: string, v: number) => `https://storage.internal.invalid/o/${report}/${v}?X-Sig=SECRETSIG-${v}`;
export const MARKERS = ['SECRETSIG', 'storage.internal.invalid'];
const FILE_KEYS: Array<[string, number, 'valid' | 'superseded']> = [[RPT.a, 1, 'superseded'], [RPT.a, 2, 'valid'], [RPT.b, 1, 'valid'], [RPT.c, 1, 'valid'], [RPT.d, 1, 'valid'], [RPT.y, 1, 'valid'], [RPT.bb, 1, 'valid']];
let vid = 700;
/** ReleasedReportFile (03-IC §4.7) per (report, version). */
export const FILES: Record<string, any> = Object.fromEntries(FILE_KEYS.map(([r, v, status]) => {
  const bytes = pdf(rkey(r, v));
  return [rkey(r, v), { reportVersionId: id(++vid), reportId: r, versionNo: v, status, contentType: 'application/pdf', byteSize: bytes.length, sha256: sha(bytes), signedUrl: signedUrl(r, v), expiresAt: '2026-11-13T06:05:00.000Z' }];
}));

// ------------------------------------------------------------------ seed
const tracking = (o: Row): Row => ({ tenant_id: T_A, partner_id: P.x, manifest_id: MAN.m1, receiving_centre_id: CENTRE, tracking_status: 'registered', cancelled_at: null, report_count: 0, stored_order_status: null,
  reconciled_at: null, version: 1, created_at: at('2026-11-05T00:00:00Z'), created_by: SYSTEM, updated_at: at('2026-11-12T00:00:00Z'), updated_by: SYSTEM, ...o });
const line = (o: Row): Row => ({ tenant_id: T_A, partner_id: P.x, manifest_id: MAN.m1, receiving_centre_id: CENTRE, state: 'converted', patient_sex: 'female', patient_age_years: 34, patient_birth_on: null, patient_phone_e164: PHI.phone,
  clinical_note: PHI.note, consent_attested: true, consent_sms: true, consent_whatsapp: true, consent_email: true, consent_share_with_referrer: true, consent_text_version: 'partner-v1', priority: 'routine', referrer_id: null,
  failure_code: null, failed_at: null, is_redacted: false, version: 1, orderables_snapshot: [{ orderable_id: id(801), kind: 'test', code: 'SYN-T1', name: 'Synthetic Hemogram' }], updated_at: at('2026-11-12T00:00:00Z'), ...o });
const report = (o: Row): Row => ({ tenant_id: T_A, partner_id: P.x, receiving_centre_id: CENTRE, status: 'valid', kind: 'final', panel_names: null, is_new: false, seen_at: at('2026-11-12T09:00:00Z'), seen_by: U.adminX, enriched_at: null,
  created_at: at('2026-11-12T00:00:00Z'), created_by: SYSTEM, updated_at: at('2026-11-12T00:00:00Z'), updated_by: SYSTEM, ...o });
const spec = (o: Row): Row => ({ tenant_id: T_A, partner_id: P.x, order_id: ORD.lab, receiving_centre_id: CENTRE, specimen_type_code: 'EDTA_WB', last_seq: 3, collected_at: null, in_transit_at: null, received_at: null, rejected_at: null,
  reported_at: null, rejection_reason_code: null, replaces_specimen_id: null, parent_specimen_id: null, created_at: at('2026-11-09T00:00:00Z'), created_by: SYSTEM, updated_at: at('2026-11-10T00:00:00Z'), updated_by: SYSTEM, ...o });

/**
 * Tenant A: partner X owns 5 orders (registered_at newest first: new, lab, rep, act, canc), partner Y owns ORD.y, tenant B (partner B) owns ORD.b.
 * Partner Y's order shares X's sample ref SYN-REF-002; tenant B's order shares X's patient name and registration number SYN-0001 (scoping probes).
 * Reports: A v1 superseded + A v2 valid (new) on ORD.rep, B v1 (partial, seen) on ORD.lab, C v1 (new) on ORD.new, D v1 (seen) on ORD.canc; Y and B each own one newer report.
 */
export function seed13(w: World, o: { cap?: number } = {}) {
  const T = w.t;
  T['partners.partners']!.push(
    { id: P.x, tenant_id: T_A, partner_code: 'SYN-X', name: 'Synthetic Partner X', status: 'active', conversion_mode: 'on_receipt' },
    { id: P.y, tenant_id: T_A, partner_code: 'SYN-Y', name: 'Synthetic Partner Y', status: 'active', conversion_mode: 'on_receipt' },
    { id: P.z, tenant_id: T_A, partner_code: 'SYN-Z', name: 'Synthetic Partner Z', status: 'suspended', conversion_mode: 'on_receipt' },
    { id: P.b, tenant_id: T_B, partner_code: 'SYN-B', name: 'Synthetic Partner B', status: 'active', conversion_mode: 'on_receipt' });
  const user = (k: Who, tenant: string, partner: string, role: string) => ({ id: U[k], tenant_id: tenant, partner_id: partner, membership_id: M[k], partner_role: role, status: 'active', display_name: `Synthetic ${k}` });
  T['partners.partner_users']!.push(user('adminX', T_A, P.x, 'partner_admin'), user('memberX', T_A, P.x, 'partner_member'), user('adminY', T_A, P.y, 'partner_admin'),
    user('adminZ', T_A, P.z, 'partner_admin'), user('adminB', T_B, P.b, 'partner_admin'));
  if (o.cap !== undefined) T['partners.settings']!.push({ tenant_id: T_A, access_slip_enabled: false, include_default_price_list: true, report_download_daily_cap_per_user: o.cap });
  T['partners.manifests']!.push(
    { id: MAN.m1, tenant_id: T_A, partner_id: P.x, manifest_no: 'SYN-MF-0001', state: 'received' }, { id: MAN.m2, tenant_id: T_A, partner_id: P.x, manifest_no: 'SYN-MF-0002', state: 'received' },
    { id: MAN.y, tenant_id: T_A, partner_id: P.y, manifest_no: 'SYN-MF-0101', state: 'received' }, { id: MAN.b, tenant_id: T_B, partner_id: P.b, manifest_no: 'SYN-MF-0201', state: 'received' });
  T['partners.partner_referrers']!.push(
    { id: REF.r1, tenant_id: T_A, partner_id: P.x, display_name: 'Dr Synthetic Referrer One', is_active: true }, { id: REF.y, tenant_id: T_A, partner_id: P.y, display_name: 'Dr Synthetic Referrer Y', is_active: true });
  const snap2 = [{ orderable_id: id(801), kind: 'test', code: 'SYN-T1', name: 'Synthetic Hemogram' }, { orderable_id: id(802), kind: 'panel', code: 'SYN-P1', name: 'Synthetic Lipid Package' }];
  T['partners.manifest_lines']!.push(
    line({ id: LINE.new, order_id: ORD.new, registration_no: 'SYN-0001', partner_sample_ref: 'SYN-REF-001', patient_full_name: 'Synthetic Aarav Test', referrer_id: REF.r1, line_no: 1 }),
    line({ id: LINE.lab, order_id: ORD.lab, registration_no: 'SYN-0002', partner_sample_ref: 'SYN-REF-002', patient_full_name: 'Synthetic Binita Test', priority: 'urgent', orderables_snapshot: snap2, line_no: 2 }),
    line({ id: LINE.rep, order_id: ORD.rep, manifest_id: MAN.m2, registration_no: 'SYN-0003', partner_sample_ref: 'SYN-REF-003', patient_full_name: 'Synthetic Chandra Test', patient_sex: 'male', referrer_id: REF.r1, line_no: 1 }),
    line({ id: LINE.act, order_id: ORD.act, manifest_id: MAN.m2, registration_no: 'SYN-0004', partner_sample_ref: null, patient_full_name: 'Synthetic Dipesh Test', patient_sex: 'male', patient_age_years: null, patient_birth_on: PHI.dob, line_no: 2 }),
    line({ id: LINE.canc, order_id: ORD.canc, registration_no: 'SYN-0005', partner_sample_ref: 'SYN-REF-005', patient_full_name: 'Synthetic Esha Test', line_no: 3 }),
    line({ id: LINE.y, partner_id: P.y, manifest_id: MAN.y, order_id: ORD.y, registration_no: 'SYN-Y001', partner_sample_ref: 'SYN-REF-002', patient_full_name: 'Synthetic Yogesh Test', referrer_id: REF.y, line_no: 1 }),
    line({ id: LINE.b, tenant_id: T_B, partner_id: P.b, manifest_id: MAN.b, order_id: ORD.b, registration_no: 'SYN-0001', partner_sample_ref: 'SYN-REF-001', patient_full_name: 'Synthetic Aarav Test', line_no: 1 }));
  const trk = (order: string, ln: string, regNo: string, status: string, reg: string, last: string, count: number, extra: Row = {}) =>
    tracking({ order_id: order, line_id: ln, registration_no: regNo, tracking_status: status, registered_at: at(reg), last_event_at: at(last), report_count: count, ...extra });
  T['partners.order_tracking']!.push(
    trk(ORD.new, LINE.new, 'SYN-0001', 'registered', '2026-11-10T02:00:00Z', '2026-11-10T02:00:00Z', 1),
    trk(ORD.lab, LINE.lab, 'SYN-0002', 'in_lab', '2026-11-09T02:00:00Z', '2026-11-12T10:00:00Z', 1),
    trk(ORD.rep, LINE.rep, 'SYN-0003', 'reported', '2026-11-08T02:00:00Z', '2026-11-11T10:00:00Z', 1, { manifest_id: MAN.m2 }),
    trk(ORD.act, LINE.act, 'SYN-0004', 'action_needed', '2026-11-07T02:00:00Z', '2026-11-09T10:00:00Z', 0, { manifest_id: MAN.m2 }),
    trk(ORD.canc, LINE.canc, 'SYN-0005', 'cancelled', '2026-11-06T02:00:00Z', '2026-11-06T10:00:00Z', 1, { cancelled_at: at('2026-11-06T10:00:00Z') }),
    trk(ORD.y, LINE.y, 'SYN-Y001', 'registered', '2026-11-11T02:00:00Z', '2026-11-12T11:00:00Z', 1, { partner_id: P.y, manifest_id: MAN.y }),
    trk(ORD.b, LINE.b, 'SYN-0001', 'registered', '2026-11-11T03:00:00Z', '2026-11-12T12:00:00Z', 1, { tenant_id: T_B, partner_id: P.b, manifest_id: MAN.b }));
  T['partners.tracked_specimens']!.push(
    spec({ specimen_id: SPEC.a, status: 'received', collected_at: at('2026-11-09T03:00:00Z'), in_transit_at: at('2026-11-09T04:00:00Z'), received_at: at('2026-11-09T06:00:00Z') }),
    spec({ specimen_id: SPEC.b, status: 'rejected', collected_at: at('2026-11-09T03:00:00Z'), in_transit_at: at('2026-11-09T04:00:00Z'), received_at: at('2026-11-09T06:30:00Z'), rejected_at: at('2026-11-09T07:00:00Z'), rejection_reason_code: 'haemolysed' }),
    spec({ specimen_id: SPEC.repl, status: 'in_transit', replaces_specimen_id: SPEC.b, collected_at: at('2026-11-10T03:00:00Z'), in_transit_at: at('2026-11-10T04:00:00Z') }));
  T['partners.order_reports']!.push(
    report({ report_id: RPT.a, version_no: 1, order_id: ORD.rep, status: 'superseded', released_at: at('2026-11-08T05:00:00Z'), panel_names: ['Synthetic Lipid Package'] }),
    report({ report_id: RPT.a, version_no: 2, order_id: ORD.rep, kind: 'amended', released_at: at('2026-11-12T05:00:00Z'), is_new: true, seen_at: null, seen_by: null, panel_names: ['Synthetic Lipid Package', 'Synthetic Renal Package'] }),
    report({ report_id: RPT.b, version_no: 1, order_id: ORD.lab, kind: 'partial', released_at: at('2026-11-10T05:00:00Z') }),
    report({ report_id: RPT.c, version_no: 1, order_id: ORD.new, released_at: at('2026-11-11T05:00:00Z'), is_new: true, seen_at: null, seen_by: null, panel_names: ['Synthetic Hemogram Panel'] }),
    report({ report_id: RPT.d, version_no: 1, order_id: ORD.canc, released_at: at('2026-11-09T05:00:00Z') }),
    report({ report_id: RPT.y, version_no: 1, order_id: ORD.y, partner_id: P.y, released_at: at('2026-11-12T07:00:00Z'), is_new: true, seen_at: null, seen_by: null }),
    report({ report_id: RPT.bb, version_no: 1, order_id: ORD.b, tenant_id: T_B, partner_id: P.b, released_at: at('2026-11-12T08:00:00Z'), is_new: true, seen_at: null, seen_by: null }));
}

// ------------------------------------------------------------------ request context
/** pg-style 23505 etc. are not needed here; validates an access-log entry like core/audit/access.ts. */
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validEntry(e: any): boolean {
  if (typeof e?.action !== 'string' || !/^[a-z_]+\.[a-z_]+$/.test(e.action) || e.action.length > 64) return false;
  if (typeof e.entityType !== 'string' || e.entityType.length < 1 || e.entityType.length > 40) return false;
  if (e.outcome !== 'allowed' && e.outcome !== 'denied') return false;
  if (e.entityId !== undefined && !UUIDV7.test(e.entityId)) return false;
  if (e.centreId !== undefined && !UUIDV7.test(e.centreId)) return false;
  if (e.detail !== undefined && (typeof e.detail !== 'object' || e.detail === null || Array.isArray(e.detail) || !Object.values(e.detail).every((v) => ['string', 'number', 'boolean'].includes(typeof v)))) return false;
  return true;
}

export interface Opts {
  now?: string;
  actorType?: string;
  /** IdentityPort.assertRole throws this */
  assertRoleError?: Error;
  /** ReportingPort.openReleasedReportFile throws this (instead of looking the file up) */
  portError?: Error;
  /** the port also knows these (foreign) report versions, as if partner RLS were not applied (a handler that asks the port for a foreign report would be served) */
  portKnowsForeign?: boolean;
  /** tier -> sliding window max per key (default report_download: 20 per hour, as 04 §4) */
  limits?: Record<string, number>;
}
export interface Metric { name: string; labels: Row; by: number }

/** One request context + its recorders. `run(op, req)` calls the handler and emulates the pipeline's rollback on error. */
export function makeCtx(w: World, who: Who, handlers: Record<string, (req: any, ctx: any) => Promise<any>>, o: Opts = {}) {
  const u = w.t['partners.partner_users']!.find((x) => x.id === U[who])!;
  const roles: string[] = [], portCalls: Array<{ ctx: any; input: any }> = [], limiterCalls: Array<{ tier: string; key: string }> = [], metrics: Metric[] = [], logs: string[] = [];
  const state = { committed: false };
  const windows = new Map<string, number>();
  const limits = { report_download: 20, ...(o.limits ?? {}) } as Record<string, number>;
  const ctx: any = {
    tenantId: u.tenant_id, actor: { type: o.actorType ?? 'partner', id: u.id, membershipId: u.membership_id }, requestId: id(99), tx: w.tx, now: () => o.now ?? NOW13, operationId: 'x', clientIp: '203.0.113.9',
    db: {}, core: {}, events: {}, uploads: {}, files: {}, storage: {}, services: {}, download: {}, noRetry() {},
    commitOnError: () => { state.committed = true; },
    audit: { async access(e: any) { if (!validEntry(e)) throw new LimsError('common.internal'); w.audit.push(structuredClone(e)); } },
    rateLimit: { async consume(tier: string, key: string) {
      limiterCalls.push({ tier, key });
      const max = limits[tier]; if (max === undefined) return;
      const k = `${tier}|${key}`; const n = (windows.get(k) ?? 0) + 1; windows.set(k, n);
      if (n > max) throw new LimsError('common.rate_limited');
    } },
    metrics: { inc: (name: string, labels: Row = {}, by = 1) => { metrics.push({ name, labels, by }); }, observe: () => undefined, set: () => undefined },
    log: { info: (x: object) => logs.push(JSON.stringify(x)), warn: (x: object) => logs.push(JSON.stringify(x)), error: (x: object) => logs.push(JSON.stringify(x)), debug: (x: object) => logs.push(JSON.stringify(x)), child: () => ctx.log },
    ports: {
      IdentityPort: { async assertRole(_c: unknown, r: { permission: string }) { roles.push(r.permission); if (o.assertRoleError) throw o.assertRoleError; } },
      ReportingPort: { async openReleasedReportFile(c: any, input: any) {
        portCalls.push({ ctx: c, input });
        if (o.portError) throw o.portError;
        const k = rkey(input.reportId, input.versionNo);
        // not_found = unknown / unreleased / FOREIGN for THIS caller (02-TRD.md:238, 03 §4.7): decide by the caller's tenant + partner
        const owner = w.t['partners.order_reports']!.find((x) => x.report_id === input.reportId);
        if (owner && (owner.tenant_id !== c.tenantId || owner.partner_id !== u.partner_id) && !o.portKnowsForeign) throw new LimsError('common.not_found');
        const f = FILES[k]; if (!f) throw new LimsError('common.not_found');
        return f;
      } },
    },
  };
  async function run(op: string, req: Partial<{ params: object; query: object; headers: object; body: unknown }> = {}) {
    const snap = w.snapshot(); const n = w.audit.length;
    try { return (await handlers[op]!({ params: {}, query: {}, headers: {}, body: undefined, ...req }, ctx)) as { status: number; body?: any; headers?: Record<string, string> }; }
    catch (e) { if (!state.committed) { w.restore(snap); w.audit.length = n; } throw e; }
  }
  return { ctx, run, roles, portCalls, limiterCalls, metrics, logs, state };
}
