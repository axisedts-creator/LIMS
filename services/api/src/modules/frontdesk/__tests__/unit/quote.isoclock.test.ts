// T0D-FIX-6 (LD-448): frontdesk order pricing (F8 quote; priceDraft is the same code F9 registration runs inside its transaction) with a ctx whose now() returns an ISO STRING,
// exactly like core/pipeline/index.ts:169. Each scenario runs with a Date clock too (control: valid fake) and then with the string; before the fix the string rows fail with
// `c.now(...).toISOString is not a function`. No database (the tx answers every query with no rows = settings defaults), real fakes of CatalogPort and BillingCommandPort, synthetic data only.
// The DB-backed registration run with a string clock is ../registration/registration.isoclock.test.ts (needs PG17, like its neighbours).
import { describe, expect, it } from 'vitest';
import { createFakeBillingCommandPort } from '../../../../../../../packages/fakes/src/BillingCommandPort.fake';
import { createFakeCatalogPort } from '../../../../../../../packages/fakes/src/CatalogPort.fake';
import { idFor } from '../../../../../../../packages/fakes/src/base';
import { LimsError } from '../../../../core/errors.js';
import { quote } from '../../service/registration.service.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const OTHER_TENANT = '01a1a98a-ac40-7000-8000-00000000b001';
const CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const OTHER_CENTRE = '01a1a98a-ac40-7000-8000-00000000a299';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const PERMISSION = 'frontdesk.registration.create';
const CBC = idFor(1, 100), GLU = idFor(1, 101);
const NOW = new Date('2026-11-22T06:00:00.000Z');
const CLOCKS: [string, () => unknown][] = [['Date clock', () => NOW], ['ISO string clock (the pipeline)', () => NOW.toISOString()]];

const world = () => ({
  catalog: createFakeCatalogPort({ seed: 1, fixtures: { catalogRevision: 1, priceLists: [{ id: idFor(1, 1000), tenantId: TENANT, code: 'TD', isActive: true, scope: 'tenant_default',
    versions: [{ version: 1, status: 'published', effectiveFrom: '2026-01-01T00:00:00.000Z' }], prices: [{ orderableId: CBC, unitPricePaisa: 50000 }, { orderableId: GLU, unitPricePaisa: 20000 }] }],
    taxRules: [{ id: idFor(1, 812), tenantId: null, orderableId: GLU, vat: 'taxable' }] as any } as any }),
  billing: createFakeBillingCommandPort({ seed: 1, fixtures: { creditParties: [] } }),
});

function ctxOf(clock: () => unknown, o: { grants?: readonly string[]; tenant?: string } = {}) {
  const w = world();
  const grants = o.grants ?? [PERMISSION];
  const sql: string[] = [];
  const ctx: any = {
    tenantId: o.tenant ?? TENANT, actor: { type: 'system', id: ACTOR, membershipId: ACTOR }, requestId: 'req-1', now: clock, centreId: CENTRE,
    tx: { async query(text: string) { sql.push(text); return { rows: [] }; } },
    audit: { async access() {} }, log: { info() {}, warn() {}, error() {} },
    ports: { CatalogPort: w.catalog, BillingCommandPort: w.billing, IdentityPort: {
      async assertRole(_c: unknown, r: { permission: string }) { if (!grants.includes(r.permission)) throw new LimsError('auth.forbidden'); },
      async getActor() { return { centreScope: { all: false, centreIds: [CENTRE] } }; },
      async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
    } },
  };
  return { ctx, sql };
}
const body = (over: Record<string, unknown> = {}) => ({ patient: { patient_id: idFor(1, 5000) }, centre_id: CENTRE, visit_type: 'opd', billing_mode: 'cash', items: [{ orderable_id: CBC }, { orderable_id: GLU }], ...over });
const fail = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection'); };

describe.each(CLOCKS)('frontdesk quote (order pricing), %s', (_n, clock) => {
  it('200 with lines, totals, a fingerprint and the B.S. fiscal year of the clock instant (22 Nov 2026 = Mangsir 2083, FY 2083/84)', async () => {
    const { ctx } = ctxOf(clock);
    const r: any = await quote(ctx, body());
    expect(r.status).toBe(200);
    expect(r.body.lines.length).toBeGreaterThan(0);
    expect(r.body.totals.gross.amount_paisa).toBe(70000);
    expect(r.body.quote_fingerprint).toMatch(/\S/);
    expect(r.body.fiscal_year_bs).toBe('2083/84');
  });
  it('the same body gives the same fingerprint on a second call (the clock is not part of it)', async () => {
    const a: any = await quote(ctxOf(clock).ctx, body());
    const b: any = await quote(ctxOf(clock).ctx, body());
    expect(a.body.quote_fingerprint).toBe(b.body.quote_fingerprint);
  });
  it('forbidden: no frontdesk.registration.create -> 403 auth.forbidden before the clock or any SQL is used', async () => {
    const { ctx, sql } = ctxOf(clock, { grants: [] });
    expect((await fail(quote(ctx, body()))).code).toBe('auth.forbidden');
    expect(sql).toEqual([]);
  });
  it('another centre than the actor\'s scope -> 404 common.not_found (not 403, not a TypeError)', async () => {
    const e = await fail(quote(ctxOf(clock).ctx, body({ centre_id: OTHER_CENTRE })));
    expect(e.code).toBe('common.not_found');
  });
  it('bad input (no items) -> typed 400 common.validation_failed, never a 500', async () => {
    const e = await fail(quote(ctxOf(clock).ctx, body({ items: [] })));
    expect(e.code).toBe('common.validation_failed');
  });
  it('other tenant\'s orderable (unknown to this tenant\'s catalog) -> a typed LimsError, not a TypeError from the clock', async () => {
    const e = await fail(quote(ctxOf(clock, { tenant: OTHER_TENANT }).ctx, body()));
    expect(e.name === 'LimsError' || typeof e.code === 'string', String(e?.message)).toBe(true);
  });
});

describe('frontdesk quote: a clock value that is not a date', () => {
  it('ctx.now() returning garbage -> a typed LimsError (never "toISOString is not a function")', async () => {
    const e = await fail(quote(ctxOf(() => 'garbage').ctx, body()));
    expect(e.name).toBe('LimsError');
  });
});
