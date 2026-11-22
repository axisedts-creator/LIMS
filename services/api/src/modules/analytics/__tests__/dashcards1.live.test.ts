// T0D-DASHCARDS-1 (LD-447 ruling 2, CR DEPLOY-AXIS-012) done_when 2 + 5: ONE fixture on a real PG17 under RLS; each new dashboard tile equals its source, read through the real handlers.
//   outstanding_paisa    == sum of outstanding_paisa over EVERY row of listAccountSummaries (all pages, raw figure, side ignored) of the caller's tenant
//   cash_in_drawer_paisa == getDailyCash(business_date = today, centre_id = each centre of the caller) sessions with status 'open': sum of rows[method_code 'cash' (case-insensitive)].expected.amount_paisa
// Needs LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL (tests/analytics/T0D-DASHCARDS-1.pg.sh boots PG17 like tests/billing/T0D-BUILD-1.pg.sh). Synthetic data only.
// PINS the writer may dispute (say so in the ruling): the two formulas above; the closed session of today and the open session of another tenant never count; a caller restricted to a centre
// without sessions sees cash 0 while outstanding (party level, no centre) is unchanged; a caller without the permission of a source gets the tile OMITTED; the fixture is committed
// through the real billing handlers / the owner connection, the tile is asked through the real getAnalyticsDashboard handler.
import { describe, expect, it } from 'vitest';
import { handlers as analytics } from '../handlers/index.js';
import { CENTRE, NOW, T, TENANT_A, TENANT_B, appTx, fire, ok, post, req, seed, superTx, tag, uid, world } from '../../billing/__tests__/accounts/helpers.js';
import { person } from '../../billing/__tests__/finctrl/kit.js';

const OUT = 'outstanding_paisa', CASH = 'cash_in_drawer_paisa';
const DAY = '2026-11-17';
const ALL = ['billing.account.read', 'billing.cash_report.read'];

/** the real dashboard handler over a real tx of `tenant`; `perms` = the actor's permissions, `centreIds` undefined = all centres. */
async function dashboard(tenant: string, perms: string[], centreIds?: string[]): Promise<any> {
  const side = tenant === TENANT_B ? 'b' : 'a';
  const actorId = uid();
  return appTx(tenant, async (rawTx: any) => {
    const identity = {
      assertRole: async (_c: unknown, a: { permission: string }) => { if (!['analytics.dashboard.read', ...perms].includes(a.permission)) throw Object.assign(new Error('forbidden'), { code: 'auth.forbidden' }); },
      getActor: async () => ({
        actor: { type: 'user', id: actorId }, displayName: 'Synthetic Owner', roles: ['owner_viewer'], permissions: ['analytics.dashboard.read', ...perms],
        centreScope: { all: centreIds === undefined, centreIds: centreIds ?? [] }, branchIds: [], mfa: { enrolled: true, level: 'aal2' }, isLocked: false,
      }),
      getTenantSettings: async () => ({ timezone: 'Asia/Kathmandu', numbering: {}, channels: {}, featureFlags: {} }),
    };
    const log = () => undefined;
    const ctx: any = {
      operationId: 'getAnalyticsDashboard', tenantId: tenant, tx: rawTx, requestId: uid(), now: () => NOW.toISOString(), centreId: CENTRE[side], actor: { type: 'user', id: actorId },
      log: { info: log, warn: log, error: log, debug: log }, metrics: { inc: log }, ports: { IdentityPort: identity },
      core: { centres: async () => [{ id: CENTRE[side] }], branches: async () => [] },
    };
    const r = await (analytics as any).getAnalyticsDashboard({ params: {}, query: {}, headers: {}, body: undefined }, ctx);
    expect(r.status).toBe(200);
    return r.body;
  });
}

async function sumSummaries(tenant: string): Promise<number> {
  let total = 0, cursor: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const b = ok(await fire('listAccountSummaries', req({ query: { limit: 100, ...(cursor ? { cursor } : {}) } }), { tenant }));
    for (const r of b.data) total += r.outstanding_paisa;
    cursor = b.page?.next_cursor;
    if (!cursor) return total;
  }
  throw new Error('summaries did not end');
}
async function openCashToday(tenant: string, centres: string[]): Promise<number> {
  let total = 0;
  for (const centre of centres) {
    const b = ok(await fire('getDailyCash', req({ query: { business_date: DAY, centre_id: centre } }), { tenant }));
    for (const s of b.sessions) if (s.status === 'open') for (const r of s.rows) if (String(r.method_code).toLowerCase() === 'cash') total += r.expected.amount_paisa;
  }
  return total;
}
async function session(tenant: string, centre: string, status: 'open' | 'closed', cashPaisa: number): Promise<void> {
  const p = await person(tenant); const id = uid();
  await superTx(async (tx) => {
    const [b] = (await tx.query('SELECT id FROM core.branches WHERE tenant_id = $1 LIMIT 1', [tenant])).rows;
    const exp = JSON.stringify([{ method_code: 'cash', amount_paisa: cashPaisa }]);
    await tx.query(
      `INSERT INTO billing.cash_sessions (id, tenant_id, branch_id, centre_id, membership_id, status, opened_at, closed_at, expected, counted, variance_paisa, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-11-17T04:00:00Z',$7::timestamptz,$8::jsonb,$9::jsonb,$10,$5,$5)`,
      [id, tenant, b.id, centre, p.membershipId, status, status === 'closed' ? '2026-11-17T05:00:00Z' : null, exp, status === 'closed' ? exp : null, status === 'closed' ? 0 : null]);
  }, tenant);
}

describe('dashboard tiles equal their sources on one fixture (done_when 2)', () => {
  it('outstanding_paisa = the sum of listAccountSummaries; cash_in_drawer_paisa = the open sessions of getDailyCash today; a closed session does not count', async () => {
    const w = await world('a'); const tg = tag();
    const party = uid();
    await seed('billing.credit_accounts', { tenant_id: TENANT_A, credit_party_id: party, party_code: `CP_${tg}`, party_display_name: `Synthetic Dash ${tg}`, credit_limit_paisa: 9_000_000, is_locked: false, lock_reason_code: null });
    ok(await post(w, { party_id: party, entry_type: 'debit', amount_paisa: 345_600 }), 201);   // outstanding 3,456.00
    ok(await post(w, { entry_type: 'debit', amount_paisa: 120_000 }), 201);
    await session(TENANT_A, w.centre, 'open', 250_000);
    await session(TENANT_A, w.centre, 'open', 100_000);
    await session(TENANT_A, w.centre, 'closed', 777_700);                                       // closed: never in the drawer
    const wantOut = await sumSummaries(TENANT_A), wantCash = await openCashToday(TENANT_A, [w.centre]);
    expect(wantOut, 'fixture reaches the source').toBeGreaterThanOrEqual(465_600);
    expect(wantCash, 'fixture reaches the source').toBeGreaterThanOrEqual(350_000);
    const body = await dashboard(TENANT_A, ALL);
    expect(body.tiles[OUT]).toMatchObject({ value: wantOut, unit: 'paisa' });
    expect(body.tiles[CASH]).toMatchObject({ value: wantCash, unit: 'paisa' });
  }, T);

  it('omitted by permission on the real stack: account.read only → no cash tile; cash_report.read only → no outstanding tile; neither → none; never 403', async () => {
    const a = await dashboard(TENANT_A, ['billing.account.read']);
    expect(OUT in a.tiles).toBe(true); expect(CASH in a.tiles).toBe(false);
    const c = await dashboard(TENANT_A, ['billing.cash_report.read']);
    expect(CASH in c.tiles).toBe(true); expect(OUT in c.tiles).toBe(false);
    const n = await dashboard(TENANT_A, []);
    expect(OUT in n.tiles).toBe(false); expect(CASH in n.tiles).toBe(false);
  }, T);

  it('other tenant: tenant B figures never reach tenant A and each tenant equals its own sources', async () => {
    const wb = await world('b'); const wa = await world('a');
    await session(TENANT_B, wb.centre, 'open', 31_337_000);
    ok(await post(wb, { entry_type: 'debit', amount_paisa: 7_654_321 }, { tenant: TENANT_B }), 201);
    const a = await dashboard(TENANT_A, ALL), b = await dashboard(TENANT_B, ALL);
    expect(a.tiles[OUT].value).toBe(await sumSummaries(TENANT_A));
    expect(b.tiles[OUT].value).toBe(await sumSummaries(TENANT_B));
    expect(a.tiles[CASH].value).toBe(await openCashToday(TENANT_A, [wa.centre]));
    expect(b.tiles[CASH].value).toBe(await openCashToday(TENANT_B, [wb.centre]));
    expect(b.tiles[CASH].value).toBeGreaterThanOrEqual(31_337_000);
    expect(JSON.stringify(a)).not.toContain('31337000');
    expect(a.tiles[OUT].value).not.toBe(b.tiles[OUT].value);
  }, T);

  it('a caller restricted to a centre without sessions sees cash 0, outstanding unchanged (party level)', async () => {
    const w = await world('a');
    await session(TENANT_A, w.centre, 'open', 55_000);
    const all = await dashboard(TENANT_A, ALL);
    const other = await dashboard(TENANT_A, ALL, [uid()]);
    expect(all.tiles[CASH].value).toBeGreaterThanOrEqual(55_000);
    expect(other.tiles[CASH].value).toBe(0);
    expect(other.tiles[OUT].value).toBe(all.tiles[OUT].value);
  }, T);

  it('a tenant with no parties and no open session: both tiles 0, 200 (never 500)', async () => {
    // tenant B before any fixture of this file is not guaranteed empty on a shared DB: the contract is "0 or the source figure, never an error"
    const b = await dashboard(TENANT_B, ALL);
    expect(b.tiles[OUT].value).toBe(await sumSummaries(TENANT_B));
    expect(Number.isSafeInteger(b.tiles[OUT].value) && Number.isSafeInteger(b.tiles[CASH].value)).toBe(true);
  }, T);

  it('read only: the dashboard writes nothing in billing', async () => {
    const before = await superTx(async (tx) => (await tx.query('SELECT (SELECT count(*) FROM billing.cash_sessions WHERE tenant_id = $1)::int AS s, (SELECT count(*) FROM billing.account_ledger_entries WHERE tenant_id = $1)::int AS e', [TENANT_A])).rows[0], TENANT_A);
    await dashboard(TENANT_A, ALL);
    const after = await superTx(async (tx) => (await tx.query('SELECT (SELECT count(*) FROM billing.cash_sessions WHERE tenant_id = $1)::int AS s, (SELECT count(*) FROM billing.account_ledger_entries WHERE tenant_id = $1)::int AS e', [TENANT_A])).rows[0], TENANT_A);
    expect(after).toEqual(before);
  }, T);
});
