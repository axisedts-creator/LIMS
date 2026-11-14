// BL-T12: service/release.service.ts — B14 createReleaseOverride and the eligibility read (B15 / BillingPort.getReleaseEligibility).
// Spec: 02-TRD §5 B14/B15, §6.2 (rules 1–6), 03-APP-FLOW "Override (B14): finance/tenant_admin at aal2 with reason -> release_overrides row -> eligibility `override`; never expires unless
// expires_at given [CONV]", PRD US-BL-07.2, 07-SECURITY REQ-SEC-062/067 (privileged), append-only table (05-SCHEMA: SELECT, INSERT only), activity action `override_created`.
// ASSUMED seam (writer: dispute via .orchestra/notes if wrong):
//   service/release.service.ts exports createReleaseService(deps: { repo?: BillingRepo }) -> { getEligibility(ctx, { orderId }) -> ReleaseEligibility (IC shape, camelCase),
//                                                                                              createOverride(ctx, { orderId, reasonCode, reasonText?, expiresAt? }) -> { overrideId, createdAt } }
//   Order existence/centre/tenant come from ctx.ports.FrontdeskPort.getOrderSummary (common.not_found otherwise); the overrider is ctx.actor.membershipId (never a body field);
//   repo.insertReleaseOverride + repo.insertActivity (action 'override_created', details without the free text); no event is published; no ledger / balance write.
// Fails now: ../release.service.js does not exist.
import { describe, expect, it } from 'vitest';
import { makeBillingPortWorld } from '../../__tests__/contract/billingPort.harness.js';
import { IDS, MEMBERSHIP, TENANT_A, USER, V7 } from './t11.helpers.js';

const O1 = V7('0000000e0a01'), O_OTHER = V7('0000000e0a02'), O_PAID = V7('0000000e0a03');
const npr = (amountPaisa: number) => ({ amountPaisa, currency: 'NPR' as const });
const seeded = (orderId: string, over: object = {}) => ({ orderId, tenantId: TENANT_A, invoicedPaisa: 100000, paidPaisa: 0, creditedPaisa: 0, hasInvoice: true, balanceVersion: 1, ...over });
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function boot() {
  const w: any = makeBillingPortWorld();
  w.seedOrder(seeded(O1)); w.seedOrder(seeded(O_PAID, { paidPaisa: 100000 })); w.seedOrder({ ...seeded(O_OTHER), tenantId: '0190a000-0000-7000-8000-0000000000ff' });
  const mod: any = await import('../release.service.js');
  const svc = mod.createReleaseService({ repo: w.repo });
  const ctx = (over: Record<string, unknown> = {}) => w.ctx({ ports: w.fakePorts, ...over });
  const writes = (from = 0) => w.repoCalls.slice(from).map((c: any) => c.name).filter((n: string) => ['insertReleaseOverride', 'insertActivity', 'insertLedgerEntry', 'upsertOrderBalance', 'insertFinanceReviewItem'].includes(n));
  return { w, svc, ctx, writes };
}
const fail = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e) => e);
const input = (over: Record<string, unknown> = {}) => ({ orderId: O1, reasonCode: 'SYN_REASON', ...over });

describe('B14 createOverride (US-BL-07.2)', () => {
  it('stores ONE append-only row for the caller\'s membership at the order\'s centre and returns {overrideId, createdAt}', async () => {
    const { w, svc, ctx } = await boot();
    const out = await svc.createOverride(ctx(), input({ reasonText: 'Synthetic reason text', expiresAt: '2026-12-01T00:00:00.000Z' }));
    expect(Object.keys(out).sort()).toEqual(['createdAt', 'overrideId']);
    expect(out.overrideId).toMatch(UUID_V7);
    expect(out.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    const ins = w.repoCalls.filter((c: any) => c.name === 'insertReleaseOverride');
    expect(ins).toHaveLength(1);
    expect(ins[0].args).toMatchObject({ id: out.overrideId, tenantId: TENANT_A, orderId: O1, centreId: IDS.centre, reasonCode: 'SYN_REASON', reasonText: 'Synthetic reason text',
      expiresAt: '2026-12-01T00:00:00.000Z', membershipId: MEMBERSHIP, userId: USER });
  });
  it('without optional fields: reason text and expiry are null (never expires unless given)', async () => {
    const { w, svc, ctx } = await boot();
    await svc.createOverride(ctx(), input());
    const a = w.repoCalls.find((c: any) => c.name === 'insertReleaseOverride').args;
    expect(a.reasonText ?? null).toBeNull();
    expect(a.expiresAt ?? null).toBeNull();
  });
  it('then the eligibility read says `override` with that id; a paid-in-full order also reports `override` (rule 3 before 5)', async () => {
    const { svc, ctx } = await boot();
    await expect(svc.getEligibility(ctx(), { orderId: O1 })).resolves.toMatchObject({ eligible: false, basis: 'due_outstanding' });
    const { overrideId } = await svc.createOverride(ctx(), input());
    await expect(svc.getEligibility(ctx(), { orderId: O1 })).resolves.toMatchObject({ orderId: O1, eligible: true, basis: 'override', overrideId, balanceDue: npr(100000) });
    const second = await svc.createOverride(ctx(), input({ orderId: O_PAID }));
    await expect(svc.getEligibility(ctx(), { orderId: O_PAID })).resolves.toMatchObject({ eligible: true, basis: 'override', overrideId: second.overrideId });
  });
  it('an override that has expired by the evaluation instant no longer releases', async () => {
    const { svc, ctx } = await boot();
    await svc.createOverride(ctx(), input({ expiresAt: '2026-11-09T00:00:00.000Z' }));
    await expect(svc.getEligibility(ctx({ now: () => '2026-11-10T00:00:00.000Z' }), { orderId: O1 })).resolves.toMatchObject({ eligible: false, basis: 'due_outstanding' });
    await expect(svc.getEligibility(ctx({ now: () => '2026-11-08T00:00:00.000Z' }), { orderId: O1 })).resolves.toMatchObject({ eligible: true, basis: 'override' });
  });
  it('audited: one activity row `override_created` with the actor and non-PHI details, never the free reason text; nothing else is written; no event', async () => {
    const { w, svc, ctx, writes } = await boot();
    const out = await svc.createOverride(ctx(), input({ reasonText: 'Synthetic secret free text' }));
    expect(writes()).toEqual(['insertReleaseOverride', 'insertActivity']);
    const act = w.s.activity.find((a: any) => a.action === 'override_created');
    expect(act).toMatchObject({ tenant_id: TENANT_A, actor_id: USER, actor_membership_id: MEMBERSHIP, actor_type: 'user' });
    expect(JSON.stringify(act.details)).not.toContain('Synthetic secret free text');
    expect(act.details).toMatchObject({ order_id: O1 });
    expect(JSON.stringify(act)).toContain(out.overrideId);
    expect(w.db.events).toHaveLength(0);
  });
  it('only a person can override: a system actor, a staff user without membership, or a patient -> auth.forbidden and nothing written', async () => {
    const { svc, ctx, writes } = await boot();
    for (const actor of [{ type: 'system', id: USER }, { type: 'user', id: USER }, { type: 'patient', id: USER }, { type: 'portal', id: USER }, { type: 'partner', id: USER, membershipId: MEMBERSHIP }]) {
      expect((await fail(svc.createOverride(ctx({ actor }), input()))).code, actor.type).toBe('auth.forbidden');
    }
    expect(writes()).toEqual([]);
  });
  it('the overrider is the caller: a body-supplied membership / tenant / centre is ignored', async () => {
    const { w, svc, ctx } = await boot();
    await svc.createOverride(ctx(), input({ membershipId: V7('0000000e0fff'), tenantId: '0190a000-0000-7000-8000-0000000000ff', centreId: V7('0000000e0ffe') })).catch(() => undefined);
    for (const c of w.repoCalls.filter((x: any) => x.name === 'insertReleaseOverride')) {
      expect(c.args).toMatchObject({ tenantId: TENANT_A, membershipId: MEMBERSHIP, centreId: IDS.centre });
    }
  });
  it('another tenant\'s order and an unknown order -> common.not_found, nothing written', async () => {
    const { svc, ctx, writes } = await boot();
    expect((await fail(svc.createOverride(ctx(), input({ orderId: O_OTHER })))).code).toBe('common.not_found');
    expect((await fail(svc.createOverride(ctx(), input({ orderId: V7('0000000e0aff') })))).code).toBe('common.not_found');
    expect(writes()).toEqual([]);
  });
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['orderId not a uuid', { orderId: 'nope' }], ['reason missing', { reasonCode: undefined }], ['reason empty', { reasonCode: '' }], ['reason over 64', { reasonCode: 'x'.repeat(65) }],
    ['reason with control char', { reasonCode: 'A\u0000B' }], ['reason text over 500', { reasonText: 'x'.repeat(501) }], ['reason text not a string', { reasonText: 5 }],
    ['expiresAt not an instant', { expiresAt: 'tomorrow' }], ['expiresAt not a string', { expiresAt: 12345 }],
  ];
  for (const [label, over] of BAD) {
    it(`validation: ${label} -> common.validation_failed, nothing written`, async () => {
      const { svc, ctx, writes } = await boot();
      expect((await fail(svc.createOverride(ctx(), input(over)))).code).toBe('common.validation_failed');
      expect(writes()).toEqual([]);
    });
  }
  it('reason text of exactly 500 characters is accepted', async () => {
    const { svc, ctx } = await boot();
    await expect(svc.createOverride(ctx(), input({ reasonText: 'x'.repeat(500) }))).resolves.toHaveProperty('overrideId');
  });
  it('fails closed without an authenticated context (no tenant / actor / tx) -> auth.unauthenticated', async () => {
    const { svc } = await boot();
    for (const bare of [{}, { tenantId: TENANT_A }, { tenantId: TENANT_A, actor: { type: 'user', id: USER, membershipId: MEMBERSHIP } }]) {
      expect((await fail(svc.createOverride(bare, input()))).code).toBe('auth.unauthenticated');
    }
  });
  it('every repo call is scoped to the caller\'s tenant', async () => {
    const { w, svc, ctx } = await boot();
    await svc.createOverride(ctx(), input());
    await svc.getEligibility(ctx(), { orderId: O1 });
    for (const c of w.repoCalls) expect(c.args.tenantId ?? c.args.tenant_id, c.name).toBe(TENANT_A);
  });
});

describe('getEligibility (B15) is the same decision the port gives', () => {
  it('another tenant\'s order -> common.not_found; bad id -> common.validation_failed; read only', async () => {
    const { svc, ctx, writes } = await boot();
    expect((await fail(svc.getEligibility(ctx(), { orderId: O_OTHER }))).code).toBe('common.not_found');
    expect((await fail(svc.getEligibility(ctx(), { orderId: 'nope' }))).code).toBe('common.validation_failed');
    await svc.getEligibility(ctx(), { orderId: O1 });
    expect(writes()).toEqual([]);
  });
});
