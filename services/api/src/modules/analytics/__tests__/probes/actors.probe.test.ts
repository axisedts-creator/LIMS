// AN-T21 — P12 (handler half) and X1 over ALL 30 operations, generated from analytics.yaml (07-SECURITY §5).
//  P12: partner, portal and patient actors of tenant A (a misrouted token) are refused on every operation and nothing is read (no tx statement, no core port).
//  X1 : an actor that lacks an operation's permission gets 403 auth.forbidden before any read — finance (collections only), lab manager (dashboard only), no-role user.
// The permission list of each persona is taken from the IdentityPort fake, not hard-coded, so a role-grant change is judged against the spec's x-permission.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { FINANCE, LAB_MANAGER, NO_PERM, makeCtx09 } from '../../handlers/__tests__/t09.helpers.js';
import { OPS, type Op } from './spec.js';

const U = (n: number) => `01a1a98a-ac40-7000-8000-0000000f${String(n).padStart(4, '0')}`;
async function callOp(o: Op, ctx: any) {
  const { handlers } = await import('../../handlers/index.js');
  ctx.operationId = o.id;
  const params = Object.fromEntries(o.pathParams.map((p, i) => [p, U(i + 1)]));
  return (handlers as Record<string, any>)[o.id]({ params, query: {}, headers: { 'idempotency-key': 'k21-probe', ...(o.id.includes('update') || o.id.includes('deactivate') ? { 'if-match': '"1"' } : {}) }, body: o.hasBody ? {} : undefined }, ctx);
}
async function refused(o: Op, actorKey: string) {
  const { ctx, touched } = await makeCtx09(actorKey);
  const out = await callOp(o, ctx).then((v: unknown) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
  return { out, touched, ctx };
}

describe('P12 partner / portal / patient actors are refused on every operation, no read happens', () => {
  const actors = [['partner', 'A:partner:default'], ['portal', 'A:portal:default'], ['patient', 'A:patient:default']] as const;
  const cases = actors.flatMap(([label, key]) => OPS.map((o) => [label, key, o] as const));
  it.each(cases)('%s actor -> %s: %s refused (401/403), zero reads', async (_label, key, o) => {
    const { out, touched } = await refused(o, key);
    expect(out.ok, `${o.id} answered for a ${key} actor: ${JSON.stringify(out.ok ? out.v : '')}`).toBe(false);
    if (!out.ok) {
      const e = out.e as { statusCode?: number; code?: string };
      expect(isLimsError(e, 'auth.forbidden') || isLimsError(e, 'auth.unauthenticated'), `${o.id}: ${String(e?.code)}`).toBe(true);
      expect([401, 403]).toContain((e as any).statusCode);
    }
    expect(touched, `${o.id} read something before refusing`).toEqual([]);
  });
});

describe('X1 privilege escalation: lacking the operation permission -> 403 auth.forbidden before any read', () => {
  const personas = [['finance (collections.read only)', FINANCE], ['lab manager (dashboard.read only)', LAB_MANAGER], ['user without analytics permission', NO_PERM]] as const;
  const cases = personas.flatMap(([label, key]) => OPS.map((o) => [label, key, o] as const));
  it.each(cases)('%s: %s', async (_label, key, o) => {
    const { ctx } = await makeCtx09(key);
    const held: readonly string[] = (await ctx.ports.IdentityPort.getActor(ctx)).permissions;
    if (held.includes(o.permission)) return; // allowed by role: its result is the business of the per-operation tests
    const { out, touched } = await refused(o, key);
    expect(out.ok, `${o.id} answered for ${key} without ${o.permission}`).toBe(false);
    if (!out.ok) expect(isLimsError(out.e, 'auth.forbidden'), `${o.id}: ${String((out.e as any)?.code)}`).toBe(true);
    expect(touched, `${o.id} read something before refusing`).toEqual([]);
  });

  it('the personas really are what the matrix assumes (finance holds collections.read and not dashboard.read; lab manager the reverse)', async () => {
    const perms = async (k: string) => { const { ctx } = await makeCtx09(k); return (await ctx.ports.IdentityPort.getActor(ctx)).permissions as string[]; };
    const f = await perms(FINANCE), l = await perms(LAB_MANAGER);
    expect(f).toContain('analytics.collections.read'); expect(f).not.toContain('analytics.dashboard.read');
    expect(l).toContain('analytics.dashboard.read'); expect(l).not.toContain('analytics.collections.read');
  });
});
