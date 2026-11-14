// FD-T16 probe kit (helper, not a test): one request table for ALL 29 frontdesk operations (F1-F26 incl. F8b/F21a, 07-SECURITY §6.1), one universal HandlerContext over a REAL PG17 tx
// (lims_api, RLS on; same convention as ../admin/helpers.ts, ../approvals/helpers.ts, ../trf/helpers.ts, ../orders/helpers.ts) and the tenant/centre fixtures the probes share.
// Needs LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL (see ../integration/helpers.ts; tests/frontdesk/FD-T16.pg.sh boots PG17). Synthetic data only.
// ASSUMED (as every earlier suite): centre scope = IdentityPort.getActor().centreScope / assertRole({permission, centreId}); privileged permissions need aal2 (REQ-SEC-062/067);
// the core pipeline (schema, x-permission, Idempotency-Key replay, membership re-validation) is NOT re-run here: the IdentityPort fake models what it hands the handler.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { access } from '../../../../core/audit/access.js';
import { createCoreRepo } from '../../../../core/core-repo/index.js';
import { LimsError } from '../../../../core/errors.js';
import { createEvents } from '../../../../core/events/publish.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { createDownload } from '../../../../core/storage/download.js';
import { createUploads } from '../../../../core/uploads/index.js';
import { handlers } from '../../handlers/index.js';
import { rows } from '../integration/helpers.js';
import { sharedFakes } from '../orders/helpers.js';
import { BRANCH, CENTRE, NOW, SYS_ACTOR, TENANT_A, TENANT_B, TENANT_SETTINGS, appTx, consents, ownerRows, phone, seed, seedOrder, seedPatient, seedSettings, superTx, tag, uid } from '../patients/helpers.js';
import { O, bill, draft, seedLimits } from '../quote/helpers.js';
import { ensureTaskRegistry, rworld, type RWorld } from '../registration/helpers.js';
import { makeWorld, pdfBytes, seedTrf, type World as TrfWorld } from '../trf/helpers.js';

export { BRANCH, CENTRE, NOW, O, TENANT_A, TENANT_B, SYS_ACTOR, ownerRows, phone, seed, superTx, tag, uid };
export const T = 120_000;
export const CENTRE_A2 = '01a1a98a-ac40-7000-8000-00000000a202';
export const BRANCH_A2 = '01a1a98a-ac40-7000-8000-00000000a102';
export const mid = (side: 'a' | 'b', n: number): string => `01a1a98a-ac40-7000-8000-00000000${side}${n}`;

// ---------------------------------------------------------------- operations (from the contract, not from the handlers)
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/frontdesk.yaml'));
export interface OpInfo { id: string; method: string; path: string; permission: string; idempotency: string; pathParams: string[]; isList: boolean }
export const OPS: OpInfo[] = Object.entries<any>(spec.paths).flatMap(([path, item]) =>
  ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item?.[m]?.operationId).map((method) => {
    const op = item[method];
    const params: any[] = [...(item.parameters ?? []), ...(op.parameters ?? [])];
    return { id: op.operationId as string, method, path, permission: op['x-permission'] as string, idempotency: String(op['x-idempotency'] ?? ''),
      pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!), isList: method === 'get' && params.some((p) => p?.name === 'cursor' || p?.$ref?.endsWith('/Cursor')) } satisfies OpInfo;
  }));
export const opById = (id: string): OpInfo => OPS.find((o) => o.id === id)!;
export const fileText = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** The frontdesk permission codes (02-TRD §7) and which of them are privileged (aal2): contracts/permissions.yaml is the source, re-read here. */
export const PERMS = ['frontdesk.registration.create', 'frontdesk.patient.read', 'frontdesk.order.read', 'frontdesk.order.edit', 'frontdesk.order.cancel', 'frontdesk.discount.apply',
  'frontdesk.discount.approve', 'frontdesk.trf.upload', 'frontdesk.settings.manage', 'frontdesk.patient.anonymise'] as const;
export const PRIVILEGED: ReadonlySet<string> = new Set(['frontdesk.discount.approve', 'frontdesk.settings.manage', 'frontdesk.patient.anonymise']);
export const INVOICE_ISSUE = 'billing.invoice.issue';

// ---------------------------------------------------------------- actors
export interface Who {
  tenant: string; membershipId: string; grants: readonly string[]; mfa: 'aal1' | 'aal2'; centreIds: readonly string[]; allCentres?: boolean;
  /** IdentityPort refuses every assertRole with this code (locked account / revoked membership re-validation, §6.4) */ refuse?: string;
}
export const mk = (tenant: string, o: Partial<Who> = {}): Who => ({
  tenant, membershipId: mid(tenant === TENANT_B ? 'b' : 'a', 500), grants: [...PERMS, INVOICE_ISSUE], mfa: 'aal2', centreIds: [tenant === TENANT_B ? CENTRE.b : CENTRE.a], allCentres: false, ...o });
/** tenant A, every frontdesk permission at aal2, every centre. */
export const FULL_A: Who = mk(TENANT_A, { allCentres: true, centreIds: [CENTRE.a, CENTRE_A2] });
export const FULL_B: Who = mk(TENANT_B, { allCentres: true });
/** tenant A, same permissions, centre A1 ONLY (the cross-centre actor). */
export const A1_ONLY: Who = mk(TENANT_A, { centreIds: [CENTRE.a], allCentres: false, membershipId: mid('a', 501) });
export const as = (w: Who, o: Partial<Who>): Who => ({ ...w, ...o });

function identityOf(w: Who) {
  const calls: Array<{ permission: string; centreId?: string }> = [];
  return {
    calls,
    async assertRole(_c: unknown, r: { permission: string; centreId?: string }) {
      calls.push({ permission: r?.permission, ...(r?.centreId ? { centreId: r.centreId } : {}) });
      if (w.refuse) throw new LimsError(w.refuse as never);
      if (!w.grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
      if (PRIVILEGED.has(r.permission) && w.mfa !== 'aal2') throw new LimsError('auth.mfa_required');
      if (r.centreId && !w.allCentres && !w.centreIds.includes(r.centreId)) throw new LimsError('auth.forbidden');
    },
    async getActor() {
      return { actor: { type: 'user', id: SYS_ACTOR, membershipId: w.membershipId }, displayName: 'Synthetic Probe Actor (SYNTHETIC)', roles: [], permissions: [...w.grants],
        centreScope: { all: w.allCentres === true, centreIds: w.centreIds }, branchIds: [BRANCH.a], mfa: { enrolled: w.mfa === 'aal2', level: w.mfa }, isLocked: w.refuse === 'auth.account_locked' };
    },
    async getTenantSettings() { return { ...TENANT_SETTINGS, branding: { displayName: 'Synthetic Lab' } }; },
  };
}

// ---------------------------------------------------------------- one request
export interface Probe { logs: string[]; accessCalls: any[]; writes: string[]; requestId: string; identity: ReturnType<typeof identityOf>; w: RWorld; trf: TrfWorld; ctx: any }
export interface Outcome { reply?: { status: number; body?: any; headers?: Record<string, string> }; error?: any; probe: Probe }
export interface FireOpts { w?: RWorld; lab?: any; billing?: any; catalog?: any; trf?: TrfWorld; requestId?: string; uploads?: unknown; bypassRls?: boolean }
export const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const WRITE = /^\s*(insert|update|delete|truncate)\b/i;
const H = handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;

// FD-T16 ruling (1): §6.4 "nothing changes" is about the HANDLER, so the harness seeds (seedLimits UPDATEs frontdesk.settings) ONCE, before any snapshot() - never inside fire().
let readyP: Promise<void> | undefined;
export const ready = (): Promise<void> => (readyP ??= (async () => { await seedLimits(); await seedSettings(); await ensureTaskRegistry(); })());

/** One request = one committed tx under `who.tenant`'s claims (RLS on); on a throw the tx rolls back and the error is returned, never thrown. */
export async function fire(operationId: string, r: ReturnType<typeof req>, who: Who, o: FireOpts = {}): Promise<Outcome> {
  await ready();
  const side = who.tenant === TENANT_B ? 'b' : 'a';
  const w = o.w ?? rworld({ creditList: true });
  const trf = o.trf ?? makeWorld(who.tenant);
  const probe: Probe = { logs: [], accessCalls: [], writes: [], requestId: o.requestId ?? uid(), identity: identityOf(who), w, trf, ctx: undefined };
  const lab = o.lab ?? sharedFakes().lab;
  // FD-T16 ruling (3), as the FD-T11 ruling (contract/helpers.ts:50-52): the LabPort fake grants user actors only via fixtures.grants[actor.id]
  lab.__seed?.({ grants: { [SYS_ACTOR]: [...who.grants] } });
  const run = async (rawTx: any) => {
    rawTx.startedAt = NOW;                                                       // core events.publish stamps occurred_at from tx.startedAt
    const tx = { query: async (text: string, values?: unknown[]) => {
      // FD-T16 ruling: capture ONLY the frontdesk shape (trf.service.ts:103); core events FANOUT_SQL (identifier 'core.event_fanout', uuid args) and anything else passes through
      if (text.trim() === 'SELECT app.enqueue_job($1, $2::jsonb, $3)' && typeof values?.[0] === 'string') {   // the job registry is C0's: capture, do not run
        const parse = (v: unknown) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
        trf.jobs.push({ identifier: values[0], payload: parse(values[1]), jobKey: (values[2] as string | null) ?? null });
        return { rows: [{ enqueue_job: null }], rowCount: 1 };
      }
      if (WRITE.test(text)) probe.writes.push(text);
      return rawTx.query(text, values);
    }, startedAt: NOW };
    const log = (lvl: string) => (obj: unknown, msg?: string) => { probe.logs.push(`${lvl} ${typeof obj === 'string' ? obj : JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: probe.requestId, now: () => NOW, centreId: CENTRE[side],
      actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId },
      ports: { IdentityPort: probe.identity, CatalogPort: o.catalog ?? w.catalog, BillingCommandPort: o.billing ?? w.billing, NotificationPort: w.notif, LabPort: lab },
      events: createEvents({ producer: 'frontdesk' }), core: createCoreRepo({} as never), storage: trf.storage.adapter, files: { scan: trf.scanner.scan },
    };
    ctx.uploads = o.uploads ?? createUploads({ files: { scan: trf.scanner.scan }, storage: trf.storage.adapter as any, module: 'frontdesk', tenantId: who.tenant, log: { warn: (a: object, m?: string) => ctx.log.warn(a, m) } });
    ctx.audit = { access: async (e: any) => { probe.accessCalls.push(e); await access(ctx, e); } };
    ctx.download = createDownload({ storage: trf.storage.adapter as any, audit: ctx.audit });
    probe.ctx = ctx;
    return H[operationId]!(r, ctx);
  };
  try {
    const reply = await (o.bypassRls ? superTx(run, who.tenant) : appTx(who.tenant, run));
    return { reply, probe };
  } catch (error) {
    return { error, probe };
  }
}
export const codeOf = (o: Outcome): string | undefined => (o.error instanceof LimsError ? (o.error as any).code : undefined);

// ---------------------------------------------------------------- fixtures
export interface Objs {
  side: 'a' | 'b'; centre: string; name: string; patient: any; order: any; item: any; approval: any; discount: any; trf: any; flag: any; w: TrfWorld; at: string;
}
let seq = 0;
/** One full object graph of `side` at `centre`. `at` = a registered_at instant unique to this graph (so list probes can window on it). */
export async function objs(side: 'a' | 'b', o: { centre?: string; at?: string; patient?: any } = {}): Promise<Objs> {
  await ready();
  const centre = o.centre ?? CENTRE[side];
  const branch = centre === CENTRE_A2 ? BRANCH_A2 : BRANCH[side];
  const at = o.at ?? `2026-0${3 + (side === 'a' ? 0 : 1)}-0${1 + (++seq % 8)}T03:03:00.000Z`;
  const name = `Probe ${tag()} Sentinel`;
  const patient = o.patient ?? await seedPatient(side, { full_name: name, phone_e164: phone() });
  const order = await seedOrder(side, patient.id, { centre_id: centre, branch_id: branch, registered_at: at, registration_no: `FDT16-${Date.now() % 1e6}-${++seq}` });
  const item = rows.item(side, order.id, { centre_id: centre, orderable_id: O.cbc, code: 'CBC' }); await seed('frontdesk.order_items', item);
  const approval = rows.approval(side, patient.id, { centre_id: centre }); await seed('frontdesk.discount_approvals', approval);
  const discount = rows.discount(side, order.id, { centre_id: centre }); await seed('frontdesk.discounts', discount);
  const w = makeWorld(side === 'a' ? TENANT_A : TENANT_B);
  const trf = await seedTrf(w, { side, centre, orderId: order.id });
  const flag = rows.flag(side, order.id, { centre_id: centre }); await seed('frontdesk.order_flags', flag);
  return { side, centre, name: patient.full_name, patient, order, item, approval, discount, trf, flag, w, at };
}

/** The request each operation receives when it names `S`'s objects (path, query, body, arrays). */
export const FP = 'f'.repeat(64);
export function requestFor(id: string, S: Objs): ReturnType<typeof req> {
  const idem = { 'idempotency-key': uid() };
  const im = { ...idem, 'if-match': '"1"' };
  const pdf = { filename: 'probe-trf.pdf', mimeType: 'application/pdf', bytes: pdfBytes('probe') };
  const D = (extra: Record<string, unknown> = {}) => draft({ patient: { patient_id: S.patient.id }, centre_id: S.centre, ...extra });
  switch (id) {
    case 'searchPatients': return req({ body: { query: S.name, mode: 'name', limit: 20 } });
    case 'createPatient': return req({ headers: idem, body: { full_name: S.name, sex: 'female', age: { years: 43 }, phone_e164: S.patient.phone_e164, consents: consents() } });
    case 'listPossibleDuplicatePatients': return req({ query: { created_on: '2026-11-10' } });
    case 'getPatient': return req({ params: { patient_id: S.patient.id } });
    case 'updatePatient': return req({ params: { patient_id: S.patient.id }, headers: { 'if-match': '"1"' }, body: { full_name: 'Probe Renamed Person' } });
    case 'recordPatientConsent': return req({ params: { patient_id: S.patient.id }, headers: idem, body: consents() });
    case 'listPatientOrders': return req({ params: { patient_id: S.patient.id } });
    case 'anonymisePatient': return req({ params: { patient_id: S.patient.id }, headers: im, body: { reason_code: 'patient_request' } });
    case 'quoteRegistration': return req({ body: D() });
    case 'createRegistration': return req({ headers: idem, body: { ...D(), quote_fingerprint: FP, payments: [], trf_attachment_ids: [S.trf.id], discount_approval_id: S.approval.id } });
    case 'listOrders': return req({ query: { registered_at_from: S.at.slice(0, 10) + 'T00:00:00.000Z', registered_at_to: S.at.slice(0, 10) + 'T23:59:59.000Z' } });
    case 'getOrder': return req({ params: { order_id: S.order.id } });
    case 'quoteOrderItemsChange': return req({ params: { order_id: S.order.id }, body: { add: [{ orderable_id: O.cbc }] } });
    case 'confirmPreRegisteredOrder': return req({ params: { order_id: S.order.id }, headers: im, body: { quote_fingerprint: FP, payments: [] } });
    case 'changeOrderItems': return req({ params: { order_id: S.order.id }, headers: im, body: { remove: [{ order_item_id: S.item.id, reason_code: 'patient_request' }] } });
    case 'cancelOrder': return req({ params: { order_id: S.order.id }, headers: im, body: { reason_code: 'patient_request' } });
    case 'requestDiscountApproval': return req({ headers: idem, body: { centre_id: S.centre, base_fingerprint: FP, discounts: [bill({ kind: 'percent', percent_bp: 3000 })], reason_code: 'staff_family', patient_ref: { patient_id: S.patient.id } } });
    case 'listDiscountApprovals': return req({ query: { status: 'pending' } });
    case 'getDiscountApproval': return req({ params: { approval_id: S.approval.id } });
    case 'approveDiscount': return req({ params: { approval_id: S.approval.id }, headers: im, body: {} });
    case 'rejectDiscount': return req({ params: { approval_id: S.approval.id }, headers: im, body: { note: 'Synthetic rejection note' } });
    case 'uploadTrf': return req({ headers: idem, body: { file: pdf, centre_id: S.centre, order_id: S.order.id } });
    case 'getTrfAttachment': return req({ params: { attachment_id: S.trf.id } });
    case 'getTrfAttachmentContent': return req({ params: { attachment_id: S.trf.id } });
    case 'listOrderFlags': return req({ query: { status: 'open' } });
    case 'resolveOrderFlag': return req({ params: { flag_id: S.flag.id }, headers: im, body: { resolution_code: 'recollected' } });
    case 'getFrontdeskSettings': return req();
    case 'updateFrontdeskSettings': return req({ headers: { 'if-match': '"1"' }, body: { discount_self_limit_bp: 500, discount_self_limit_paisa: 100000, discount_absolute_max_bp: 2000, require_referrer: false, consent_text_version: 'v1',
      registration_sms_enabled: false, label_autoprint: false, buyer_pan_pattern: '^[0-9]{10}$', patient_search_min_chars: 4 } });
    case 'listFrontdeskCodes': return req({ params: { set_name: 'order_cancel_reasons' } });
    default: throw new Error(`no probe request for ${id}`);
  }
}

// ---------------------------------------------------------------- owner-side truth
export const TENANT_TABLES = ['settings', 'number_counters', 'patients', 'patient_consents', 'orders', 'order_items', 'discount_approvals', 'discounts', 'trf_attachments', 'order_flags',
  'booking_links', 'cs_reasons', 'event_inbox'] as const;
/** md5 over every row of every tenant table of `tenant` (superuser, no RLS): a probe that must not touch tenant B compares this before and after. */
export async function snapshot(tenant: string): Promise<Record<string, string>> {
  await ready();
  return superTx(async (tx) => {
    const out: Record<string, string> = {};
    for (const t of TENANT_TABLES) out[t] = (await tx.query(`SELECT coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') AS h FROM frontdesk.${t} x WHERE tenant_id = $1`, [tenant])).rows[0].h;
    out['access_log'] = (await tx.query(`SELECT count(*)::text AS h FROM audit.access_log WHERE tenant_id = $1`, [tenant])).rows[0].h;
    out['event_log'] = (await tx.query(`SELECT count(*)::text AS h FROM core.event_log WHERE tenant_id = $1`, [tenant])).rows[0].h;
    return out;
  }, tenant);
}
export type { RWorld };
