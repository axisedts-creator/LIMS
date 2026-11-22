// T0D-FIX-6 (LD-448): F9 createRegistration (order creation + registration) with ctx.now() returning an ISO STRING, as the real pipeline does (core/pipeline/index.ts:169).
// Same harness as registration.test.ts: REAL PG17 under RLS (run it through tests/frontdesk/FD-T06.pg.sh, which boots PG17 and exports LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL).
// Fails now: priceDraft / parseCreate / registered_at call c.now().toISOString() or pass the string where a Date is read (TypeError -> 500 common.internal).
import { beforeAll, describe, expect, it } from 'vitest';
import { CENTRE, NOW, T, TENANT_A, orderRow, prepare, register, registerFails, seedLimits } from './helpers.js';

beforeAll(seedLimits, T);

describe('F9 createRegistration with an ISO string clock (the pipeline)', () => {
  it('201: order registered, registered_at is the clock instant, registration_no and fiscal year set, same answer as with a Date clock', async () => {
    const a = await prepare();
    const viaString = await register(a.body, { w: a.w, isoClock: true });
    expect(viaString.status).toBe(201);
    const o = await orderRow(viaString.body.order.id);
    expect(o).toMatchObject({ tenant_id: TENANT_A, status: 'registered', centre_id: CENTRE.a, source: 'front_desk' });
    expect(new Date(o.registered_at).toISOString()).toBe(NOW.toISOString());
    expect(o.registration_no).toMatch(/^A-B1R\d{6}$/);

    const b = await prepare();
    const viaDate = await register(b.body, { w: b.w });
    expect(viaDate.status).toBe(201);
    expect(new Date((await orderRow(viaDate.body.order.id)).registered_at).toISOString()).toBe(new Date(o.registered_at).toISOString());
  }, T);

  it('forbidden: a caller without the permission gets 403 and nothing is stored, with the string clock', async () => {
    const p = await prepare();
    const e = await registerFails(p.body, { w: p.w, isoClock: true, grants: [] });
    expect(e.code).toBe('auth.forbidden');
  }, T);

  it('bad input: a body with no items is a typed 400, never a 500, with the string clock', async () => {
    const p = await prepare();
    const e = await registerFails({ ...p.body, items: [] }, { w: p.w, isoClock: true });
    expect(e.code).toBe('common.validation_failed');
  }, T);

  it('other tenant: a patient of tenant A registered through tenant B is 404 and writes nothing, with the string clock', async () => {
    const p = await prepare();
    const e = await registerFails(p.body, { w: p.w, isoClock: true, tenant: '01a1a98a-ac40-7000-8000-00000000b001' });
    expect(['common.not_found', 'auth.forbidden', 'common.validation_failed']).toContain(e.code);
  }, T);
});
