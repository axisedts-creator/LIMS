// AN-T10 test helpers (not a test file). Synthetic data only. Builds on ./t09.helpers.ts (same ids, same volume emulator, same directory).
// Adds: the referrer-billing emulator (analytics.daily_referrer_billing), owner personas with/without aal2, the tenant flag, and a ctx.audit.access that
// runs the REAL core/audit/access.ts validator + INSERT on ctx.tx (so an entry the core would reject, or a row that is not written on the request tx, fails here).
//
// SEAMS pinned here (spec leaves repository signatures open; the writer may dispute through the reviewer). All take (tx, args):
//   rollups.repo.referrerVolumeRows(tx, { tenantId, from, to, scope, grain?: 'total'|'day' })   (AN-T09 signature + optional grain, default 'total')
//       -> [{ referrer_id: uuid|null, business_date: 'YYYY-MM-DD'|null (null when grain 'total'), orders, patient_visits, tests_ordered }]  RAW referrer id
//   rollups.repo.referrerBillingRows(tx, { tenantId, from, to, scope, grain?: 'total'|'day' })    (reads daily_referrer_billing ONLY; NEW in AN-T10)
//       -> [{ referrer_id: uuid, business_date: 'YYYY-MM-DD'|null, net_billed_paisa }]  RAW referrer id; billing rows always carry a referrer (no SELF row)
//   The service merges the two by canonical id (rollup=canonical) or raw id (none), per period for the *_month group_bys (the service groups B.S. months itself from 'day').
//   Flag: ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['referralIncentiveReportEnabled'] }) (02-TRD §5.2). Audit: ctx.audit.access(entry) (02-TRD §5.2, §9).
import { vi } from 'vitest';
import { createFakeIdentityPort, type MembershipRow } from '../../../../../../../packages/fakes/src/IdentityPort.fake';
import { TENANTS, actorIdFor, idFor } from '../../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { access as realAccess } from '../../../../core/audit/access.js';
import { A1, A2, B1, D0, D1, D2, D3, TA, TB, db } from './helpers.js';
import { R, REF_NAME, rollupsMock09, labelsRepoMock09, makeCtx09, rf, seed09, w, WINDOW, call09 } from './t09.helpers.js';

export { A1, A2, B1, D0, D1, D2, D3, TA, TB, db, R, REF_NAME, rf, w, WINDOW, seed09, call09 };
export { ADMIN, NO_PERM, PARTNER, LAB_MANAGER, FINANCE, contractErrors, expectLims, rejection, addDays, bsKey, golden } from './t09.helpers.js';

const SEED = 1;
export const R_ZETA = idFor(SEED, 0xf6);                      // referrer with billing in the window but no orders (credit-party charge on its charge date)
export const REF_ZETA = 'Dr. Test Zeta';
export const OWNER = 'A:user:refowner';                        // owner_viewer, all centres, aal2: holds analytics.referral_report.read
export const OWNER_A1 = 'A:user:refownera1';                   // owner_viewer restricted to {A1}, aal2
export const OWNER_AAL1 = 'A:user:refowneraal1';               // owner_viewer, aal1 (TOTP not done)
export const OWNER_REVOKED = 'A:user:refownerrevoked';         // owner_viewer, membership deactivated
const member = (persona: string, n: number, centreScope: MembershipRow['centreScope'], o: Partial<MembershipRow> = {}): MembershipRow => ({
  id: idFor(SEED, 0xb00 + n), tenantId: TENANTS.A, actorId: actorIdFor('A', 'user', persona), actorType: 'user', displayName: `Test User A-${persona}`,
  roles: ['owner_viewer'], extraPermissions: [], centreScope, branchIds: [], mfaLevel: 'aal2', isLocked: false, status: 'active', email: null, version: 1, ...o,
});
const MEMBERS = [
  member('refowner', 1, { all: true, centreIds: [] }), member('refownera1', 2, { all: false, centreIds: [A1] }),
  member('refowneraal1', 3, { all: true, centreIds: [] }, { mfaLevel: 'aal1' }), member('refownerrevoked', 4, { all: true, centreIds: [] }, { status: 'deactivated' }),
  member('finance', 5, { all: true, centreIds: [] }, { roles: ['finance'] }), member('labmanager', 6, { all: true, centreIds: [] }, { roles: ['lab_manager'] }),
];

// ------------------------------------------------------------------ billing world
export interface BillFact { tenantId: string; date: string; centreId: string | null; referrerId: string; net: number }
export const wb = { bill: [] as BillFact[] };
export const bf = (date: string, c: string, referrerId: string, net: number, tenantId = TA): BillFact => ({ tenantId, date, centreId: c, referrerId, net });

/**
 * Standard referral world, window [D1, D3), on top of seed09() volume (ALPHA 5 + merged GAMMA 4 = 9 orders / BETA 3 / SELF 2 / DELTA 1 inactive):
 *   billing  ALPHA D1 A1 5000 + D1 A2 3000 | GAMMA D2 A1 1000 (merged into ALPHA) | BETA D1 A1 2000 | DELTA D2 A1 400
 *            outliers: BETA D0 70000, BETA D3 80000, tenant B FOREIGN D1 999999
 *   canonical  ALPHA 9/9/18 net 9000 | BETA 3/3/3 net 2000 | SELF 2/2/2 (no net) | DELTA 1/1/1 net 400      totals 15/15/24 net 11400 (SELF has no net)
 *   none       ALPHA 5/5/10 net 8000 | GAMMA 4/4/8 net 1000 | BETA | SELF | DELTA
 *   centre {A1} canonical  ALPHA 7 (3 + GAMMA 4) net 6000 | BETA 3 net 2000 | SELF 2 | DELTA 1 net 400
 */
export function seed10(): void {
  seed09();
  wb.bill = [
    bf(D1, A1, R.ALPHA, 5000), bf(D1, A2, R.ALPHA, 3000), bf(D2, A1, R.GAMMA, 1000), bf(D1, A1, R.BETA, 2000), bf(D2, A1, R.DELTA, 400),
    bf(D0, A1, R.BETA, 70_000), bf(D3, A1, R.BETA, 80_000), bf(D1, B1, R.FOREIGN, 999_999, TB),
  ];
  w.referrers.push({ tenantId: TA, referrer_id: R_ZETA, display_name: REF_ZETA, is_active: true, canonical_referrer_id: null });
}

// ------------------------------------------------------------------ repo emulators
type Scope = { all: boolean; centreIds: readonly string[] };
type A = { tenantId: string; from: string; to: string; scope: Scope; grain?: 'total' | 'day' };
const inScope = (s: Scope, c: string | null) => s.all || (c !== null && s.centreIds.includes(c));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const keep = <T extends { tenantId: string; date: string; centreId: string | null }>(xs: T[], a: A) =>
  xs.filter((f) => f.tenantId === a.tenantId && f.date >= a.from && f.date < a.to && inScope(a.scope, f.centreId));
function groupBy<T>(xs: T[], keyOf: (x: T) => string): T[][] {
  const m = new Map<string, T[]>(); for (const x of xs) m.set(keyOf(x), [...(m.get(keyOf(x)) ?? []), x]);
  return [...m.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, g]) => g);
}

export const rollupsMock10 = {
  ...rollupsMock09,
  referrerVolumeRows: vi.fn(async (_tx: unknown, a: A) => {
    db.calls.push({ fn: 'referrerVolumeRows', args: a });
    if (db.fail) throw db.fail;
    const day = a.grain === 'day';
    return groupBy(keep(w.refs, a), (f) => `${day ? f.date : ''}|${f.referrerId ?? ''}`).map((g) => ({
      referrer_id: g[0]!.referrerId, business_date: day ? g[0]!.date : null,
      orders: sum(g.map((f) => f.orders)), patient_visits: sum(g.map((f) => f.pat)), tests_ordered: sum(g.map((f) => f.items)),
    }));
  }),
  referrerBillingRows: vi.fn(async (_tx: unknown, a: A) => {
    db.calls.push({ fn: 'referrerBillingRows', args: a });
    if (db.fail) throw db.fail;
    const day = a.grain === 'day';
    return groupBy(keep(wb.bill, a), (f) => `${day ? f.date : ''}|${f.referrerId}`).map((g) => ({
      referrer_id: g[0]!.referrerId, business_date: day ? g[0]!.date : null, net_billed_paisa: sum(g.map((f) => f.net)),
    }));
  }),
};
export { labelsRepoMock09 };

// ------------------------------------------------------------------ ctx
export interface Ctx10Opts { flag?: boolean; flagOtherTenant?: boolean; accessFails?: boolean }
export const SETTING_KEY = 'referralIncentiveReportEnabled';
/** A fresh request ctx. `flag` = tenant A's referralIncentiveReportEnabled (default false = C2 seed). Spies: identity.assertRole / getTenantSettings, audit.access, accessRows (INSERTs on ctx.tx). */
export async function makeCtx10(actorKey: string, o: Ctx10Opts = {}) {
  const settings: Record<string, Record<string, boolean>> = {};
  if (o.flag !== undefined) settings[TENANTS.A] = { [SETTING_KEY]: o.flag };
  if (o.flagOtherTenant !== undefined) settings[TENANTS.B] = { [SETTING_KEY]: o.flagOtherTenant };
  const identity = createFakeIdentityPort({ seed: SEED, fixtures: { memberships: MEMBERS, settings } as never }) as any;
  const assertRole = vi.spyOn(identity, 'assertRole');
  const getTenantSettings = vi.spyOn(identity, 'getTenantSettings');
  const { ctx: base, touched } = await makeCtx09(actorKey);
  const accessRows: unknown[][] = [];
  const entries: any[] = [];
  const ctx: any = base;
  ctx.ports = { IdentityPort: identity };
  ctx.requestId ??= idFor(SEED, 0x7e57);
  ctx.tx = {
    query: vi.fn(async (text: string, values: unknown[]) => {
      if (/insert\s+into\s+audit\.access_log/i.test(text)) { if (o.accessFails) throw new Error('synthetic access_log failure'); accessRows.push(values); return { rows: [] }; }
      touched.push('tx.query'); return { rows: [] };
    }),
  };
  ctx.audit = { access: vi.fn(async (e: unknown) => { entries.push(e); await realAccess(ctx, e as never); }) };
  return { ctx, touched, identity, assertRole, getTenantSettings, accessRows, entries };
}

export const getRef = (ctx: any, q: Record<string, unknown> = {}) => call09('getReferralIncentiveReport' as never, ctx, { ...WINDOW, ...q });
export async function okRef(ctx: any, q: Record<string, unknown> = {}): Promise<any> {
  const r = await getRef(ctx, q);
  if (r.status !== 200) throw new Error(`expected 200 from getReferralIncentiveReport, got ${r.status}`);
  return r.body;
}
