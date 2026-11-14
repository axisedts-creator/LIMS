// M1a listMembershipPlans, M1b create/updateMembershipPlan, M2 enrolMembership, M3 listPatientMemberships, M4 lookupMembershipCard, M5 cancelMembership,
// E47 listMyMemberships (02-TRD §5, §7). Order: fail closed without request context -> IdentityPort.assertRole (before any query; plan write is privileged,
// aal1 -> auth.mfa_required) -> service. Card data is PHI-adjacent: patient/lookup/enrol responses are never cacheable.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createMembershipService, type MembershipCtx, type MembershipService } from '../service/membership.service.js';

type Out = { status: number; body: unknown; version?: number; noStore?: boolean };
type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(permission: string, fn: (svc: MembershipService, ctx: MembershipCtx, req: HandlerRequest) => Promise<Out>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<MembershipCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission });
    const out = await fn(createMembershipService(), c as MembershipCtx, req);
    const headers = { ...(out.version === undefined ? {} : { etag: `"${out.version}"` }), ...(out.noStore ? { 'Cache-Control': 'no-store' } : {}) };
    return { status: out.status, body: out.body, ...(Object.keys(headers).length ? { headers } : {}) };
  };
}

export const membershipHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listMembershipPlans: bind('engagement.membership.read', async (s, ctx, req) => ({ status: 200, body: await s.listPlans(ctx, { query: req.query }) })),
  createMembershipPlan: bind('engagement.membership_plan.manage', async (s, ctx, req) => {
    const b = await s.createPlan(ctx, { body: req.body });
    return { status: 201, body: b, version: b.version as number };
  }),
  updateMembershipPlan: bind('engagement.membership_plan.manage', async (s, ctx, req) => {
    const b = await s.updatePlan(ctx, { planId: obj(req.params)['plan_id'], headers: req.headers, body: req.body });
    return { status: 200, body: b, version: b.version as number };
  }),
  enrolMembership: bind('engagement.membership.enrol', async (s, ctx, req) => {
    const b = await s.enrol(ctx, { body: req.body });
    return { status: 201, body: b, version: b.version as number, noStore: true };
  }),
  listPatientMemberships: bind('engagement.membership.read', async (s, ctx, req) => ({ status: 200, body: await s.listOfPatient(ctx, { patientId: obj(req.params)['patient_id'] }), noStore: true })),
  lookupMembershipCard: bind('engagement.membership.read', async (s, ctx, req) => ({ status: 200, body: await s.lookup(ctx, { body: req.body }), noStore: true })),
  cancelMembership: bind('engagement.membership.enrol', async (s, ctx, req) => {
    const b = await s.cancel(ctx, { membershipId: obj(req.params)['membership_id'], headers: req.headers, body: req.body });
    return { status: 200, body: b, version: b.version as number, noStore: true };
  }),
  listMyMemberships: bind('engagement.self.read', async (s, ctx) => ({ status: 200, body: await s.listMine(ctx), noStore: true })),
});
