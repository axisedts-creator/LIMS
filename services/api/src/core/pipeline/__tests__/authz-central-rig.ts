// SEC-AUTHZ-2 shared rig for the stage 8a tests: the real pipeline over a fake pooler, a fake IdentityPort that models roles and session states.
import { createAuthzGuard } from '../../ports/authz-guard.js';
import { createDb } from '../../db/tx.js';
import { createFakePgBouncer, recorder, SUB, TENANT_A } from '../../db/__tests__/helpers.js';
import { createPipeline } from '../index.js';
export { SUB, TENANT_A };

const forbidden = () => Object.assign(new Error('forbidden'), { code: 'auth.forbidden', statusCode: 403 });
const mfa = () => Object.assign(new Error('mfa'), { code: 'auth.mfa_required', statusCode: 403 });
const supportNeeded = () => Object.assign(new Error('support'), { code: 'identity.support_session_required', statusCode: 403 });

export const REQ_ID = '0190a000-0000-7000-8000-0000000000f1';
export const DEVICE = '0190a000-0000-7000-8000-00000000d001';
export const staffOp = (over: Record<string, unknown> = {}) => ({
  module: 'frontdesk', operationId: 'createThing', method: 'POST', routeTemplate: '/v1/frontdesk/things',
  public: false, context: 'tenant', idempotency: 'none', rateLimitTier: 'general',
  permission: 'frontdesk.order.create', scheme: 'bearerJwt', ...over,
}) as any;
export const user = { sub: SUB, tenant_id: TENANT_A, actor_type: 'user', aal: 'aal1' } as any;

export interface Profile { permissions: string[]; state?: 'mfa_pending' | 'password_setup' | 'support_missing' }
export function rig(o: { env?: string; mode?: 'shadow' | 'enforce' | 'unset'; profile?: Profile; system?: Record<string, string[]>; exceptions?: any[]; handler?: any; devices?: Record<string, string[]> } = {}) {
  const fake = createFakePgBouncer(2);
  const rec = recorder();
  const incs: Array<[string, Record<string, string> | undefined]> = [];
  const metrics = { setGauge() {}, inc: (n: string, l?: Record<string, string>) => { incs.push([n, l]); } };
  const env = o.env ?? 'staging';
  const state = { profile: o.profile ?? { permissions: [] } as Profile };
  const asserted: Array<{ permission: string }> = [];
  const repoCalls: string[] = [];
  const handlerCalls: string[] = [];
  const identityPort = {
    async assertRole(_ctx: any, req: { permission: string }) {
      asserted.push({ permission: req.permission });
      // device actors: the real IdentityPort resolves the credential (device_kind) to its fixed permission set (IdentityPort.impl.ts resolve 'device'); here keyed by actor id
      if (_ctx.actor?.type === 'device') { if (!(o.devices?.[_ctx.actor.id] ?? []).includes(req.permission)) throw forbidden(); return; }
      const p = state.profile;
      if (p.state === 'mfa_pending') throw mfa();
      if (p.state === 'password_setup') throw forbidden();
      if (p.state === 'support_missing') throw supportNeeded();
      if (!p.permissions.includes(req.permission)) throw forbidden();
    },
    async getActor() { return {}; },
  };
  const db = createDb({ pool: fake.pool, log: rec.log as any, metrics: rec.metrics as any, sleep: async () => undefined, random: () => 0 } as any);
  const authz = createAuthzGuard({ env, log: rec.log as any, metrics: metrics as any });
  const idempotency = { async begin() { return { action: 'skip' as const }; }, async finish() {}, async release() {} };
  const rateLimiter = { async consume() {} };
  // the real pipeline passes d.services?.[op.module] (pipeline/index.ts:180): every module gets the same spying repo
  const spyServices = { repo: { read: () => { repoCalls.push('read'); return 1; } } };
  const services = new Proxy({}, { get: () => spyServices });
  const deps: Record<string, unknown> = {
    env, db, idempotency, rateLimiter, authz, services, log: rec.log, metrics,
    ports: { portsFor: () => ({ IdentityPort: identityPort }) },
    shared: { core: {}, events: {}, uploads: {}, files: {}, storage: {}, download: {} },
    ...(o.mode && o.mode !== 'unset' ? { authzMode: o.mode } : {}),
    ...(o.system ? { systemPermissions: o.system } : {}),
    ...(o.exceptions ? { authzExceptions: o.exceptions } : {}),
  };
  const pipeline = createPipeline(deps as any);
  const silent = async (_r: any, ctx: any) => { handlerCalls.push('handler'); (ctx.services as any).repo.read(); return { status: 200, body: { ok: true } }; };
  const asserting = (permission: string) => async (_r: any, ctx: any) => {
    handlerCalls.push('handler'); await ctx.ports.IdentityPort.assertRole(ctx, { permission }); (ctx.services as any).repo.read(); return { status: 200, body: { ok: true } };
  };
  const run = (over: Record<string, unknown> = {}) => pipeline.run({
    op: staffOp(), claims: user, requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'vitest',
    req: { params: {}, query: {}, headers: {}, body: { name: 'x' } },
    handler: (o.handler ?? silent) as any, log: rec.log, ...over,
  } as any);
  return { run, rec, incs, state, asserted, repoCalls, handlerCalls, silent, asserting, fake };
}
export async function rejects(p: Promise<unknown>): Promise<any> { try { await p; } catch (e) { return e; } throw new Error('expected a rejection, but it resolved'); }
export const denies = (r: ReturnType<typeof rig>) => r.rec.calls.filter((c) => c.obj?.event === 'authz_central_deny');
export const notAsserted = (r: ReturnType<typeof rig>) => r.rec.calls.filter((c) => c.obj?.event === 'authz_not_asserted');
