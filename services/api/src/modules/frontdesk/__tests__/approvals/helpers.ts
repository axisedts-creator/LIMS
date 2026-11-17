// FD-T07 harness (Discount approvals F15-F19 + F9 consumption). Handlers are driven with a request-shaped object + a HandlerContext over a REAL PG17 tx (lims_api, RLS on),
// same convention as ../registration/helpers.ts (FD-T06) and ../quote/helpers.ts. Ports: REAL fakes from packages/fakes (Catalog, BillingCommand, Notification) + a per-caller
// IdentityPort fake with an aal level (below). Synthetic data only.
// IdentityPort fake aal1/aal2: mirrors packages/fakes/src/IdentityPort.fake.ts `assertRole` (no grant -> auth.forbidden; privileged permission at aal1 -> auth.mfa_required;
//   centre outside the caller's scope -> auth.forbidden) and `getActor` (mfa.level, centreScope). `frontdesk.discount.approve` is privileged (03-IC §4.6; 07-SECURITY §6.4, REQ-SEC-062/067).
// Membership ids are the SEEDED core.memberships of db/seeds/010 (a500 admin, a501 front desk, a502 finance, a503 lab technologist; b501/b502 tenant B), so a display name
// resolved from core.users instead of IdentityPort.getActor is the same string the fake reports.
// ASSUMED (spec names no frontdesk ctx; 02-TRD §6.4/§6.8/§6.10): ctx.tenantId, tx, requestId, now() (Date), actor{type,id,membershipId}, centreId, audit.access,
//   ctx.ports.{IdentityPort,CatalogPort,BillingCommandPort,NotificationPort}, ctx.events = REAL core createEvents({producer:'frontdesk'}), ctx.core = REAL createCoreRepo.
//   Handlers return {status, body}; one request = one tx. If-Match is read by the handler from req.headers['if-match'] (same as F4 updatePatient).
import { access } from '../../../../core/audit/access.js';
import { LimsError } from '../../../../core/errors.js';
import { createCoreRepo } from '../../../../core/core-repo/index.js';
import { createEvents } from '../../../../core/events/publish.js';
import { handlers } from '../../handlers/index.js';
import { hex64 } from '../integration/helpers.js';
import { BRANCH, CENTRE, NOW, SYS_ACTOR, TENANT_A, TENANT_B, TENANT_SETTINGS, appTx, ownerRows, rejection, req, seedPatient, superTx, uid } from '../patients/helpers.js';
import { CENTRE_A2, INVOICE_PERM, PERM, T, ensureTaskRegistry, knowRecipient, prepare, rworld, seedLimits, type RWorld } from '../registration/helpers.js';
import { quote as quoteOnly } from '../quote/helpers.js';

export { CENTRE, CENTRE_A2, NOW, T, TENANT_A, TENANT_B, hex64, ownerRows, rejection, req, seedPatient, superTx, uid, prepare, rworld, knowRecipient };
export type { RWorld };

export const P = { apply: 'frontdesk.discount.apply', approve: 'frontdesk.discount.approve', reg: PERM, inv: INVOICE_PERM } as const;
const PRIVILEGED_HERE: ReadonlySet<string> = new Set([P.approve]);
export const mid = (side: 'a' | 'b', n: number): string => `01a1a98a-ac40-7000-8000-00000000${side}${n}`;
export const MIN = 60_000;

export interface Who { tenant: string; membershipId: string; displayName: string; grants: readonly string[]; mfa: 'aal1' | 'aal2'; centreIds: readonly string[] }
/** Front-desk operator: may request and register, may NOT approve. */
export const REQUESTER: Who = { tenant: TENANT_A, membershipId: mid('a', 501), displayName: 'Synthetic Lab Alpha Front desk (SYNTHETIC)', grants: [P.apply, P.reg, P.inv], mfa: 'aal1', centreIds: [CENTRE.a] };
/** Finance approver at aal2 (holds frontdesk.discount.approve). */
export const APPROVER: Who = { tenant: TENANT_A, membershipId: mid('a', 502), displayName: 'Synthetic Lab Alpha Finance (SYNTHETIC)', grants: [P.approve, P.apply], mfa: 'aal2', centreIds: [CENTRE.a] };
/** A second approver (tenant admin) for races. */
export const APPROVER2: Who = { tenant: TENANT_A, membershipId: mid('a', 500), displayName: 'Synthetic Lab Alpha Tenant admin (SYNTHETIC)', grants: [P.approve, P.apply], mfa: 'aal2', centreIds: [CENTRE.a] };
/** Another front-desk user: may request (so may call F17) but is not the requester of anything the tests create with REQUESTER. */
export const OTHER: Who = { tenant: TENANT_A, membershipId: mid('a', 503), displayName: 'Synthetic Lab Alpha Lab technologist (SYNTHETIC)', grants: [P.apply], mfa: 'aal1', centreIds: [CENTRE.a] };
export const REQUESTER_B: Who = { tenant: TENANT_B, membershipId: mid('b', 501), displayName: 'Synthetic Lab Beta Front desk (SYNTHETIC)', grants: [P.apply, P.reg, P.inv], mfa: 'aal1', centreIds: [CENTRE.b] };
export const APPROVER_B: Who = { tenant: TENANT_B, membershipId: mid('b', 502), displayName: 'Synthetic Lab Beta Finance (SYNTHETIC)', grants: [P.approve, P.apply], mfa: 'aal2', centreIds: [CENTRE.b] };
export const as = (w: Who, o: Partial<Who>): Who => ({ ...w, ...o });

function identityOf(w: Who) {
  const calls: Array<{ permission: string; centreId?: string }> = [];
  return {
    calls,
    async assertRole(_c: unknown, r: { permission: string; centreId?: string }) {
      calls.push({ permission: r?.permission, ...(r?.centreId ? { centreId: r.centreId } : {}) });
      if (!w.grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
      if (PRIVILEGED_HERE.has(r.permission) && w.mfa !== 'aal2') throw new LimsError('auth.mfa_required');
      if (r.centreId && !w.centreIds.includes(r.centreId)) throw new LimsError('auth.forbidden');
    },
    async getActor() {
      return { actor: { type: 'system', id: SYS_ACTOR, membershipId: w.membershipId }, displayName: w.displayName, roles: [], permissions: [...w.grants],
        centreScope: { all: false, centreIds: w.centreIds }, branchIds: [BRANCH.a], mfa: { enrolled: w.mfa === 'aal2', level: w.mfa }, isLocked: false };
    },
    async getTenantSettings() { return TENANT_SETTINGS; },
  };
}

export interface Reply { status: number; body: any; probe: { logs: string[]; accessCalls: any[]; identity: ReturnType<typeof identityOf> } }
export interface OpOpts { now?: Date; w?: RWorld; requestId?: string }

/** One request = one committed tx under RLS with `who.tenant`'s claims. */
export async function op(operationId: string, r: ReturnType<typeof req>, who: Who, o: OpOpts = {}): Promise<Reply> {
  await seedLimits();
  await ensureTaskRegistry();
  const w = o.w ?? rworld();
  const now = o.now ?? NOW;
  const probe: Reply['probe'] = { logs: [], accessCalls: [], identity: identityOf(who) };
  const out = await appTx(who.tenant, async (tx: any) => {
    tx.startedAt = now;                                       // core events.publish stamps occurred_at from tx.startedAt
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error') },
      tenantId: who.tenant, tx, requestId: o.requestId ?? uid(), now: () => now, centreId: who.centreIds[0],
      actor: { type: 'system', id: SYS_ACTOR, membershipId: who.membershipId },
      ports: { IdentityPort: probe.identity, CatalogPort: w.catalog, BillingCommandPort: w.billing, NotificationPort: w.notif },
      events: createEvents({ producer: 'frontdesk' }), core: createCoreRepo({} as never),
    };
    ctx.audit = { access: async (e: any) => { probe.accessCalls.push(e); await access(ctx, e); } };
    return (handlers as any)[operationId](r, ctx);
  });
  return { ...out, probe };
}
export const opFails = (operationId: string, r: ReturnType<typeof req>, who: Who, o: OpOpts = {}) => rejection(op(operationId, r, who, o));

// ---- F15-F19 wrappers ----
export const request = (body: unknown, who: Who = REQUESTER, o: OpOpts = {}) => op('requestDiscountApproval', req({ body }), who, o);
export const requestFails = (body: unknown, who: Who = REQUESTER, o: OpOpts = {}) => rejection(request(body, who, o));
export const listApprovals = (query: Record<string, unknown>, who: Who = APPROVER, o: OpOpts = {}) => op('listDiscountApprovals', req({ query }), who, o);
export const getApproval = (id: string, who: Who = REQUESTER, o: OpOpts = {}) => op('getDiscountApproval', req({ params: { approval_id: id } }), who, o);
const decideReq = (id: string, ifMatch: string | undefined, body: unknown) =>
  req({ params: { approval_id: id }, body, headers: ifMatch === undefined ? {} : { 'if-match': ifMatch } });
export const approve = (id: string, ifMatch: string | undefined, body: unknown = {}, who: Who = APPROVER, o: OpOpts = {}) => op('approveDiscount', decideReq(id, ifMatch, body), who, o);
export const reject = (id: string, ifMatch: string | undefined, body: unknown = { note: 'Synthetic rejection note' }, who: Who = APPROVER, o: OpOpts = {}) =>
  op('rejectDiscount', decideReq(id, ifMatch, body), who, o);
export const approveFails = (id: string, ifMatch: string | undefined, body: unknown = {}, who: Who = APPROVER, o: OpOpts = {}) => rejection(approve(id, ifMatch, body, who, o));
export const rejectFails = (id: string, ifMatch: string | undefined, body: unknown = { note: 'Synthetic rejection note' }, who: Who = APPROVER, o: OpOpts = {}) =>
  rejection(reject(id, ifMatch, body, who, o));

export const approvalRow = async (id: string) => (await ownerRows('frontdesk.discount_approvals', 'id = $1', [id]))[0];
export const bill30 = () => ({ scope: 'bill', kind: 'percent', percent_bp: 3000, reason_code: 'staff_family' });

/** F15 as `who` for a freshly seeded patient (or `o.patient`). Base fingerprint is random (F15 cannot check it against lines it does not have). */
export async function newApproval(o: { who?: Who; centreId?: string; patient?: any; over?: Record<string, unknown>; now?: Date } = {}) {
  const who = o.who ?? REQUESTER;
  const side = who.tenant === TENANT_B ? 'b' : 'a';
  const patient = o.patient ?? await seedPatient(side);
  const body = { centre_id: o.centreId ?? CENTRE[side], base_fingerprint: hex64(), discounts: [bill30()], reason_code: 'staff_family', patient_ref: { patient_id: patient.id }, ...(o.over ?? {}) };
  const r = await request(body, who, o.now ? { now: o.now } : {});
  return { r, body, patient, approval: r.body, id: r.body.id as string };
}
/** pending -> approved by APPROVER (aal2). */
export async function approvedApproval(o: Parameters<typeof newApproval>[0] = {}) {
  const a = await newApproval(o);
  await approve(a.id, '"1"', {}, o.who && o.who.tenant === TENANT_B ? APPROVER_B : APPROVER);
  return a;
}

// ---- F9 consumption fixtures ----
const draftOf = (body: Record<string, unknown>) => { const { quote_fingerprint: _q, payments: _p, discount_approval_id: _d, ...d } = body; return d; };
export const disc = (bp: number) => [{ scope: 'bill', kind: 'percent', percent_bp: bp, reason_code: 'staff_family' }];
export interface Discounted { patient: any; w: RWorld; body: any; fp: string; base: string; centreId: string }
/** A registration draft (CBC + GLU, gross 70000) with a bill discount above the self limit (10 %) and below the absolute max (50 %), quoted with the SAME world.
 *  `base` = Quote.base_fingerprint exactly as F8 returns it (what the UI sends to F15). Unpaid (payments []) so the net does not matter. */
export async function discounted(o: { bp?: number; items?: string[]; centreId?: string; w?: RWorld } = {}): Promise<Discounted> {
  const centreId = o.centreId ?? CENTRE.a;
  const p = await prepare({ d: { discounts: disc(o.bp ?? 3000), ...(o.items ? { items: o.items.map((orderable_id) => ({ orderable_id })) } : {}) }, payments: [],
    centreId, ...(o.w ? { w: o.w } : {}) });
  const q = await quoteOnly(draftOf(p.body), { w: p.w, centreIds: [centreId], grants: [PERM] });
  return { patient: p.patient, w: p.w, body: p.body, fp: p.fp, base: q.body.base_fingerprint as string, centreId };
}
/** F15 for `d` exactly as the UI does it: its base_fingerprint, its discounts, its patient. */
export const requestFor = (d: Discounted, who: Who = REQUESTER, o: OpOpts = {}) =>
  request({ centre_id: d.centreId, base_fingerprint: d.base, discounts: d.body.discounts, reason_code: 'staff_family', patient_ref: { patient_id: d.patient.id } }, who, o);
/** pending -> approved for `d`; returns the approval id. */
export async function approvalFor(d: Discounted, o: { requester?: Who; approver?: Who; now?: Date } = {}): Promise<string> {
  const r = await requestFor(d, o.requester ?? REQUESTER, o.now ? { now: o.now } : {});
  await approve(r.body.id, '"1"', {}, o.approver ?? APPROVER, o.now ? { now: o.now } : {});
  return r.body.id as string;
}
export const withApproval = (d: Discounted, id: string) => ({ ...d.body, discount_approval_id: id });
