// T0D-18 fixture module `frontdesk` (consumer of IdentityPort and CatalogPort per PORT_CONSUMERS). Writes to the scratch table
// public.t0d18_marks (created and dropped by the test through the admin connection; tenant_id defaults to app.current_tenant_id()).
// The test controls timing through globalThis.__t0d18 = { gate?: Promise<void>, during?: () => Promise<unknown>, handlerRuns: number }.
import { eventProducers } from '../../../../../../module.js';

const hooks = () => ((globalThis as any).__t0d18 ??= { handlerRuns: 0 });
const MEMBERS_OF = (ctx: any) => Object.keys(ctx).sort();

const probeContext = async (_req: any, ctx: any) => {
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'catalog.view' });
  const tenant = (await ctx.tx.query('SELECT app.current_tenant_id() AS t')).rows[0].t;
  return {
    status: 200,
    body: {
      tenant, ctxKeys: MEMBERS_OF(ctx), actor: ctx.actor, tenantId: ctx.tenantId, requestId: ctx.requestId, operationId: ctx.operationId,
      clientIp: ctx.clientIp, services: (ctx.services as any)?.tag ?? null, catalogPort: typeof ctx.ports.CatalogPort,
      nowIso: ctx.now(), txOpen: typeof ctx.tx?.query === 'function', during: await hooks().during?.(),
    },
  };
};

const publicProbe = async (_req: any, ctx: any) => ({
  status: 200,
  body: { tx: ctx.tx === undefined ? 'none' : 'present', tenantId: ctx.tenantId ?? null, during: await hooks().during?.(), ctxKeys: MEMBERS_OF(ctx), operationId: ctx.operationId },
});

const badShape = async (_req: any, ctx: any) => {
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'catalog.view' });
  return { status: 200, body: { id: 5 } };
};

const listMarks = async (_req: any, ctx: any) => {
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'catalog.view' });
  const rows = (await ctx.tx.query('SELECT note FROM public.t0d18_marks WHERE tenant_id = app.current_tenant_id() ORDER BY note')).rows;
  return { status: 200, body: { notes: rows.map((r: any) => r.note) } };
};

const createMark = async (req: any, ctx: any) => {
  const h = hooks();
  h.handlerRuns += 1;
  const { note, mode = 'ok' } = req.body as { note: string; mode?: string };
  if (mode !== 'no_assert') await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'catalog.test.manage' });
  await ctx.tx.query('INSERT INTO public.t0d18_marks (note) VALUES ($1)', [note]);
  if (mode === 'slow') await h.gate;
  if (mode === 'bad_request') return { status: 400, body: { code: 'common.validation_failed' } };
  if (mode === 'denied_commit') { ctx.commitOnError(); return { status: 403, body: { code: 'auth.forbidden' } }; }
  if (mode === 'boom') throw new Error('boom');
  return { status: 201, body: { note } };
};

export const manifest = {
  name: 'frontdesk',
  openapi: 'contracts/openapi/frontdesk.yaml',
  produces: eventProducers()['frontdesk'] ?? [],
  createServices: () => ({ tag: 'frontdesk-services' }),
  handlers: { probeContext, publicProbe, badShape, listMarks, createMark },
};
