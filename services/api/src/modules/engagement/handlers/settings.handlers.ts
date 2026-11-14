// T1 getEngagementSettings, T2 updateEngagementSettings, T3a listEngagementCodedSet, T3b listMyCodedSet (02-TRD §5).
// Order: fail closed without request context -> IdentityPort.assertRole (before any query; T2 is privileged, aal1 -> auth.mfa_required) -> service.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import type { CodedSetName } from '../repository/codedsets.repo.js';
import { createSettingsService, type SettingsCtx, type SettingsService } from '../service/settings.service.js';

type Out = { status: number; body: unknown; version?: number };
type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(permission: string, fn: (svc: SettingsService, ctx: SettingsCtx, req: HandlerRequest) => Promise<Out>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<SettingsCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission });
    const out = await fn(createSettingsService(), c as SettingsCtx, req);
    return { status: out.status, body: out.body, ...(out.version === undefined ? {} : { headers: { etag: `"${out.version}"` } }) };
  };
}

const STAFF_SETS: readonly CodedSetName[] = ['booking_cancel_reasons', 'reminder_reasons', 'enquiry_categories'];
const PATIENT_SETS: readonly CodedSetName[] = ['booking_cancel_reasons', 'enquiry_categories']; // reminder_reasons is staff-only

export const settingsHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  getEngagementSettings: bind('engagement.booking.read', async (s, ctx) => { const b = await s.getSettings(ctx); return { status: 200, body: b, version: b['version'] as number }; }),
  updateEngagementSettings: bind('engagement.settings.manage', async (s, ctx, req) => {
    const b = await s.updateSettings(ctx, { headers: req.headers, body: req.body });
    return { status: 200, body: b, version: b['version'] as number };
  }),
  listEngagementCodedSet: bind('engagement.booking.read', async (s, ctx, req) => ({ status: 200, body: await s.listCodedSet(ctx, { setName: obj(req.params)['set_name'], allowed: STAFF_SETS }) })),
  listMyCodedSet: bind('engagement.self.read', async (s, ctx, req) => ({ status: 200, body: await s.listCodedSet(ctx, { setName: obj(req.params)['set_name'], allowed: PATIENT_SETS }) })),
});
