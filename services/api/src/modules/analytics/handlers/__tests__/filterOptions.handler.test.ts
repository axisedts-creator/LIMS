// C8 AN-T09 — getAnalyticsFilterOptions (#16) and getCollectionsFilterOptions (#30). PRD US-08.6, 08 A17 D-46 / D-47, P-10 (conditional `recipients`),
// 02-TRD §5 #16/#30, schemas AnalyticsFilterOptions / CollectionsFilterOptions; 07-SECURITY REQ-SEC-013/017/081, P1, P4, P5, P12.
// Done_when: "recipients filter option only with analytics.schedule.manage (D-47)"; "finance user: #30 200, #16 403". Emulators: ./t09.helpers.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, A3, B1, BR1, BR2, BRB, ADMIN, NO_PERM, PARTNER, OWNER_A1, OWNER_ALL, FINANCE, FINANCE_A1, LAB_MANAGER, COLL_NO_CASH, M1, M2, M3, M4, S1, S2,
  DEPT_NAMES, BRANCH_NAME, CENTRE_NAME, call09, contractErrors, db, expectLims, makeCtx09, ok09, seed09, seedCollections, w,
} from './t09.helpers.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./t09.helpers.js')).rollupsMock09);
vi.mock('../../repository/labels.repo.js', async () => (await import('./t09.helpers.js')).labelsRepoMock09);

const opts = (ctx: any) => ok09('getAnalyticsFilterOptions', ctx);
const copts = (ctx: any) => ok09('getCollectionsFilterOptions', ctx);
const ids = (xs: any[], k = 'id') => xs.map((x) => x[k]).sort();

beforeEach(() => { seed09(); seedCollections(); vi.clearAllMocks(); });

describe('getAnalyticsFilterOptions (#16) — content for an all-centre caller', () => {
  it('centres (incl. the deactivated one, flagged), branches, departments (incl. inactive), payment methods, specimen types — own tenant only; contract-valid', async () => {
    const body = await opts((await makeCtx09(ADMIN)).ctx);
    expect(ids(body.centres)).toEqual([A1, A2, A3].sort());
    expect(body.centres.find((c: any) => c.id === A1)).toEqual({ id: A1, label: CENTRE_NAME(A1), branch_id: BR1, is_active: true });
    expect(body.centres.find((c: any) => c.id === A3)).toMatchObject({ is_active: false, branch_id: BR2 });
    expect(ids(body.branches)).toEqual([BR1, BR2].sort());
    expect(body.branches.find((b: any) => b.id === BR1)).toEqual({ id: BR1, label: BRANCH_NAME(BR1), is_active: true });
    expect(body.departments.map((d: any) => d.label).sort()).toEqual(DEPT_NAMES.sort());
    expect(body.departments.find((d: any) => d.label === 'Legacy Serology').is_active).toBe(false);
    expect(ids(body.payment_methods, 'code')).toEqual(['bank_transfer', 'cash', 'esewa']);
    for (const p of body.payment_methods) { expect(typeof p.display).toBe('string'); expect(p.display).toBeTruthy(); expect(Object.keys(p).sort()).toEqual(['code', 'display']); }
    expect(ids(body.specimen_types, 'code')).toEqual(['edta_blood', 'serum', 'swab_a3_only', 'urine']);
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`tenant_b|Tenant B|${BRB}|${B1}`));
    expect(contractErrors('AnalyticsFilterOptions', body)).toEqual([]);
  });

  it('objects carry exactly the contract keys (no extra field leaks from the core rows)', async () => {
    const body = await opts((await makeCtx09(ADMIN)).ctx);
    expect(Object.keys(body.centres[0]).sort()).toEqual(['branch_id', 'id', 'is_active', 'label']);
    expect(Object.keys(body.branches[0]).sort()).toEqual(['id', 'is_active', 'label']);
    expect(Object.keys(body.departments[0]).sort()).toEqual(['id', 'is_active', 'label']);
    expect(Object.keys(body.specimen_types[0])).toEqual(['code']);
  });

  it('no data → empty arrays, not missing keys', async () => {
    db.departments = []; w.coll = []; w.specimens = [];
    const body = await opts((await makeCtx09(ADMIN)).ctx);
    expect(body.payment_methods).toEqual([]);
    expect(body.specimen_types).toEqual([]);
    expect(body.departments).toEqual([]);
    expect(contractErrors('AnalyticsFilterOptions', body)).toEqual([]);
  });
});

describe('getAnalyticsFilterOptions — centre scope (P4/P5)', () => {
  it('centre-restricted {A1}: only A1, only its branch, only codes seen at A1 — no name, id or code of another centre', async () => {
    const body = await opts((await makeCtx09(OWNER_A1)).ctx);
    expect(ids(body.centres)).toEqual([A1]);
    expect(ids(body.branches)).toEqual([BR1]);
    expect(ids(body.specimen_types, 'code')).toEqual(['edta_blood', 'serum']);
    expect(ids(body.payment_methods, 'code')).toEqual(['cash', 'esewa']);
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${A2}|${A3}|${BR2}|${CENTRE_NAME(A2)}|${CENTRE_NAME(A3)}|bank_transfer|urine|swab_a3_only`));
  });

  it('the scope passed to the repositories is the caller\'s (never {all:true} for a restricted caller)', async () => {
    await opts((await makeCtx09(OWNER_A1)).ctx);
    for (const fn of ['paymentMethodCodes', 'specimenTypeCodes']) {
      expect(db.calls.find((c) => c.fn === fn)?.args.scope, fn).toEqual({ all: false, centreIds: [A1] });
    }
  });
});

describe('getAnalyticsFilterOptions — `recipients` is a P-10 conditional on analytics.schedule.manage (D-47)', () => {
  it('holder (tenant_admin / owner_viewer): recipients = active user memberships holding dashboard.read, as {membership_id, display_name} only', async () => {
    for (const actor of [ADMIN, OWNER_ALL]) {
      const { ctx } = await makeCtx09(actor);
      const body = await opts(ctx);
      expect(ids(body.recipients, 'membership_id'), actor).toEqual([M1, M2].sort());
      for (const r of body.recipients) expect(Object.keys(r).sort()).toEqual(['display_name', 'membership_id']);
      expect(body.recipients.find((r: any) => r.membership_id === M1).display_name).toBe('Test Manager One');
      expect(JSON.stringify(body.recipients)).not.toMatch(new RegExp(`${M3}|${M4}|${S1}|${S2}|roleCodes|allCentres|finance`));
      expect(contractErrors('AnalyticsFilterOptions', body)).toEqual([]);
      const list = db.calls.filter((c) => c.fn === 'memberships.list');
      expect(list).toHaveLength(1);
      expect(list[0]!.args).toMatchObject({ permission: 'analytics.dashboard.read' });
      db.calls.length = 0;
    }
  });

  it('non-holder (lab_manager: dashboard.read without schedule.manage): the key is OMITTED, 200 not 403, and the directory is never queried', async () => {
    const { ctx, touched } = await makeCtx09(LAB_MANAGER);
    const body = await opts(ctx);
    expect('recipients' in body).toBe(false);
    expect(ids(body.centres)).toEqual([A1, A2, A3].sort());
    expect(db.calls.filter((c) => c.fn === 'memberships.list')).toEqual([]);
    expect(touched).not.toContain('core.memberships');
    expect(contractErrors('AnalyticsFilterOptions', body)).toEqual([]);
  });

  it('dashboard.read via owner_viewer restricted to {A1} that also holds schedule.manage still gets recipients (permission, not centre, decides)', async () => {
    const body = await opts((await makeCtx09(OWNER_A1)).ctx);
    expect(ids(body.recipients, 'membership_id')).toEqual([M1, M2].sort());
  });

  it('a failing directory lookup for a holder fails the request (no silent empty recipient list)', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    ctx.core.memberships.list = vi.fn(async () => { throw new Error('directory down'); });
    await expect(call09('getAnalyticsFilterOptions', ctx)).rejects.toThrow('directory down');
  });

  it('request-memoised: one directory call per request even when the handler is asked twice on the same ctx', async () => {
    const { ctx } = await makeCtx09(ADMIN);
    await call09('getAnalyticsFilterOptions', ctx);
    await call09('getAnalyticsFilterOptions', ctx);
    expect(db.calls.filter((c) => c.fn === 'memberships.list').length).toBeLessThanOrEqual(1);
  });
});

describe('getAnalyticsFilterOptions — authz (done_when: finance user #16 → 403)', () => {
  it.each([['finance (collections.read only)', FINANCE], ['finance restricted', FINANCE_A1], ['no analytics permission', NO_PERM], ['partner', PARTNER]])(
    '%s → 403 auth.forbidden before anything is read', async (_n, actor) => {
      const { ctx, touched } = await makeCtx09(actor);
      await expectLims(call09('getAnalyticsFilterOptions', ctx), 'auth.forbidden', 403);
      expect(touched).toEqual([]);
      expect(db.calls).toEqual([]);
    });
});

// ================================================================================================================ #30
describe('getCollectionsFilterOptions (#30, D-46) — finance reaches collections history', () => {
  it('finance (collections.read, NO dashboard.read): 200 with exactly { centres, branches, payment_methods } — same shapes as #16', async () => {
    const body = await copts((await makeCtx09(FINANCE)).ctx);
    expect(Object.keys(body).sort()).toEqual(['branches', 'centres', 'payment_methods']);
    expect(ids(body.centres)).toEqual([A1, A2, A3].sort());
    expect(ids(body.branches)).toEqual([BR1, BR2].sort());
    expect(ids(body.payment_methods, 'code')).toEqual(['bank_transfer', 'cash', 'esewa']);
    expect(body.centres.find((c: any) => c.id === A3).is_active).toBe(false);
    expect(contractErrors('CollectionsFilterOptions', body)).toEqual([]);
    const full = await opts((await makeCtx09(ADMIN)).ctx);
    expect(body.centres).toEqual(full.centres);
    expect(body.branches).toEqual(full.branches);
    expect(body.payment_methods).toEqual(full.payment_methods);
  });

  it('done_when pair on the SAME finance actor: #30 → 200 and #16 → 403', async () => {
    expect((await call09('getCollectionsFilterOptions', (await makeCtx09(FINANCE)).ctx)).status).toBe(200);
    await expectLims(call09('getAnalyticsFilterOptions', (await makeCtx09(FINANCE)).ctx), 'auth.forbidden', 403);
  });

  it('reads nothing the collections page does not need: no departments, specimen types or membership directory', async () => {
    const { ctx, touched } = await makeCtx09(FINANCE);
    await copts(ctx);
    expect(db.calls.map((c) => c.fn)).not.toEqual(expect.arrayContaining(['specimenTypeCodes']));
    expect(db.calls.filter((c) => /specimen|memberships|Department/i.test(c.fn))).toEqual([]);
    expect(touched).not.toContain('core.memberships');
  });

  it('finance restricted to {A1}: only A1, its branch, its payment methods (no NULL-centre bank_transfer, no A2 data)', async () => {
    const body = await copts((await makeCtx09(FINANCE_A1)).ctx);
    expect(ids(body.centres)).toEqual([A1]);
    expect(ids(body.branches)).toEqual([BR1]);
    expect(ids(body.payment_methods, 'code')).toEqual(['cash', 'esewa']);
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${A2}|${A3}|${BR2}|bank_transfer`));
    expect(db.calls.find((c) => c.fn === 'paymentMethodCodes')?.args.scope).toEqual({ all: false, centreIds: [A1] });
  });

  it.each([['owner_viewer', OWNER_ALL], ['tenant_admin', ADMIN], ['collections.read without cash report', COLL_NO_CASH]])('%s (holds collections.read) → 200', async (_n, actor) => {
    expect((await call09('getCollectionsFilterOptions', (await makeCtx09(actor)).ctx)).status).toBe(200);
  });

  it.each([['dashboard.read only (lab_manager)', LAB_MANAGER], ['no analytics permission', NO_PERM], ['partner', PARTNER]])(
    '%s → 403 auth.forbidden before anything is read', async (_n, actor) => {
      const { ctx, touched } = await makeCtx09(actor);
      await expectLims(call09('getCollectionsFilterOptions', ctx), 'auth.forbidden', 403);
      expect(touched).toEqual([]);
      expect(db.calls).toEqual([]);
    });

  it('never carries a recipients key even for a schedule.manage holder', async () => {
    const body = await copts((await makeCtx09(ADMIN)).ctx);
    expect('recipients' in body).toBe(false);
    expect(db.calls.filter((c) => c.fn === 'memberships.list')).toEqual([]);
  });
});
