// T0D-DASHCARDS-1 (LD-447, CR DEPLOY-AXIS-012; founder order 2026-11-22 13:36 NPT) getAnalyticsDashboard: two optional ADDITIVE tiles, outstanding_paisa and cash_in_drawer_paisa.
// In-memory world of AN-T14 (./helpers.t14.ts): handler + service + mapper are real, the fake tx answers `{ rows: [] }` for a statement it does not know, so a billing source read
// that finds no rows must give a 0 tile (empty data = 200, never 500). Equality with the real sources on one fixture is in ../../__tests__/dashcards1.live.test.ts (PG17).
// PINS the writer may dispute (say so in the ruling, do not bend them silently):
//  - outstanding_paisa is present iff the caller holds billing.account.read; OMITTED (never 403, never a null / 0 placeholder) otherwise, and a missing source permission means the source is not even read.
//  - REVIEW ITEM 2 (T0D-DASHCARDS-1-review.md): cash_in_drawer_paisa stays in the contract (optional, additive) but is NEVER emitted for now: an open session's billing.cash_sessions.expected is NULL
//    (only closeCashSession writes it) and getDailyCash has no live expected, so no figure can equal the source; the web cell stays on "Not available yet" (done_when 2, notes/T0D-DASHCARDS-1-left.md).
//  - a present tile is { value: integer paisa >= 0 as a safe integer, unit: 'paisa' } and the whole body stays valid against the DashboardDto schema. previous / delta are NOT pinned
//    (they are snapshots like reports_pending; the schema decides).
//  - the permission to see the dashboard is still asked first (analytics.dashboard.read): a caller with only a billing permission gets 403 and nothing is read.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADMIN, FINANCE, LAB_MANAGER, OWNER_ALL09, call14, contractErrors, dash, db, expectLims, makeCtx14, seedT14, w14, WINDOW } from './helpers.t14.js';
import { DASH_ACCT, DASH_BOTH, DASH_CASH } from './t09.helpers.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t14.js')).rollupsMock14);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t14.js')).labelsRepoMock14);

const OUT = 'outstanding_paisa', CASH = 'cash_in_drawer_paisa';
const billingSql = () => w14.log.filter((l) => /\bbilling\./i.test(l.text));

beforeAll(async () => { await import('../index.js'); contractErrors('DashboardDto', {}); }, 30_000);
beforeEach(() => { seedT14(); vi.clearAllMocks(); });

describe('contract (additive only): contracts/openapi/analytics.yaml', () => {
  const yaml = readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/analytics.yaml', import.meta.url)), 'utf8').split(String.fromCharCode(13)).join(''); // the file is CRLF
  const dto = /\n {4}DashboardDto:\n([\s\S]*?)\n {4}[A-Za-z0-9]+:\n/.exec(yaml)?.[1] ?? '';

  it('DashboardDto.tiles has the two new properties, each a $ref to the Tile schema like net_collected_paisa', () => {
    expect(dto.length, 'DashboardDto schema found').toBeGreaterThan(200);
    for (const k of [OUT, CASH]) expect(dto, k).toMatch(new RegExp(`\\n {12}${k}:\\n {14}\\$ref: "#/components/schemas/Tile"`));
  });

  it('they are optional: neither is in a required list of DashboardDto.tiles', () => {
    const tiles = /\n {8}tiles:\n([\s\S]*?)\n {8}series:/.exec(dto)?.[1] ?? '';
    expect(tiles.length).toBeGreaterThan(100);
    const required = /required:\n((?: {12}- .*\n)+)/.exec(tiles + '\n')?.[1] ?? '';
    expect(required).not.toContain(OUT);
    expect(required).not.toContain(CASH);
  });

  it('the operation description names both permissions and says omitted, not 403', () => {
    const op = /operationId: getAnalyticsDashboard\n([\s\S]*?)\n {6}security:/.exec(yaml)?.[1] ?? '';
    expect(op).toContain(OUT);
    expect(op).toContain(CASH);
    expect(op).toContain('billing.account.read');
    expect(op).toContain('billing.cash_report.read');
    expect(op).toMatch(/omitted/i);
  });

  it('the operation keeps its x-permission and its error list (no shape change of the existing operation)', () => {
    const op = /operationId: getAnalyticsDashboard\n([\s\S]*?)\n {6}parameters:/.exec(yaml)?.[1] ?? '';
    expect(op).toContain('x-permission: analytics.dashboard.read');
    expect(op).not.toMatch(/x-permission:\s*billing\./);
  });
});

describe('tiles present by the permission of their source (omitted, not 403)', () => {
  it('a holder of both billing permissions: outstanding (unit paisa, safe integer), cash in drawer omitted (no source figure), body contract-valid', async () => {
    const { ctx } = await makeCtx14(DASH_BOTH);
    const body = await dash(ctx);
    expect(body.tiles[OUT]).toBeDefined();
    expect(body.tiles[OUT].unit).toBe('paisa');
    expect(Number.isSafeInteger(body.tiles[OUT].value)).toBe(true);
    expect(body.tiles[OUT].value).toBeGreaterThanOrEqual(0);
    expect(CASH in body.tiles).toBe(false);
    expect(contractErrors('DashboardDto', body)).toEqual([]);
  });

  it('billing.account.read only: outstanding present, cash in drawer omitted', async () => {
    const { ctx } = await makeCtx14(DASH_ACCT);
    const body = await dash(ctx);
    expect(body.tiles[OUT]).toMatchObject({ unit: 'paisa' });
    expect(CASH in body.tiles).toBe(false);
    expect(JSON.stringify(body)).not.toContain(CASH);
    expect(contractErrors('DashboardDto', body)).toEqual([]);
  });

  it('billing.cash_report.read only: both omitted (cash has no source figure yet, outstanding needs account.read)', async () => {
    const { ctx } = await makeCtx14(DASH_CASH);
    const body = await dash(ctx);
    expect(CASH in body.tiles).toBe(false);
    expect(OUT in body.tiles).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/outstanding|cash_in_drawer/);
    expect(contractErrors('DashboardDto', body)).toEqual([]);
  });

  it('neither permission (lab_manager): both omitted, 200 not 403, and no statement touches billing.*', async () => {
    const { ctx } = await makeCtx14(LAB_MANAGER);
    const body = await dash(ctx);
    expect(OUT in body.tiles).toBe(false);
    expect(CASH in body.tiles).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/outstanding|cash_in_drawer/);
    expect(billingSql()).toEqual([]);
    expect(contractErrors('DashboardDto', body)).toEqual([]);
  });

  it('the source is not read without its permission: nobody triggers a statement over cash sessions (tile not emitted), a cash-only caller none over the account ledger / credit accounts', async () => {
    const a = await makeCtx14(DASH_BOTH); await dash(a.ctx);
    expect(w14.log.filter((l) => /cash_sessions/i.test(l.text)), 'both-holder').toEqual([]);
    w14.log.length = 0;
    const c = await makeCtx14(DASH_CASH); await dash(c.ctx);
    expect(w14.log.filter((l) => /account_ledger_entries|credit_accounts/i.test(l.text)), 'cash-only').toEqual([]);
  });

  it('every other tile is unchanged by the two new ones (a both-holder equals the lab_manager figures)', async () => {
    const plain = await dash((await makeCtx14(LAB_MANAGER)).ctx);
    const both = await dash((await makeCtx14(DASH_BOTH)).ctx);
    const { [OUT]: _o, [CASH]: _c, ...rest } = both.tiles;
    expect(rest).toEqual(plain.tiles);
    expect(both.series).toEqual(plain.series);
    expect(both.department_top).toEqual(plain.department_top);
  });

  it('a billing-only caller (finance: no analytics.dashboard.read) is still 403 and nothing is read', async () => {
    const { ctx, touched } = await makeCtx14(FINANCE);
    await expectLims(call14('getAnalyticsDashboard', ctx), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(db.calls).toEqual([]);
    expect(w14.log).toEqual([]);
  });
});

describe('empty data and bad input never 500', () => {
  it('a tenant with no ledger and no cash session: outstanding is 0, cash omitted, 200, contract-valid', async () => {
    const { ctx } = await makeCtx14(DASH_BOTH);
    const body = await dash(ctx, { business_date_from: '2030-01-01', business_date_to: '2030-01-08' });
    expect(body.tiles[OUT].value).toBe(0);
    expect(CASH in body.tiles).toBe(false);
    expect(contractErrors('DashboardDto', body)).toEqual([]);
  });

  it('outstanding does not depend on the period (snapshot): Today and a 2-day window give the same figure', async () => {
    const a = await dash((await makeCtx14(DASH_BOTH)).ctx);
    const b = await dash((await makeCtx14(DASH_BOTH)).ctx, WINDOW);
    expect(b.tiles[OUT]).toEqual(a.tiles[OUT]);
  });

  it('bad input still answers a typed 4xx before any billing read: two period selectors → 400, nothing over billing.*', async () => {
    const { ctx } = await makeCtx14(DASH_BOTH);
    await expectLims(call14('getAnalyticsDashboard', ctx, { query: { bs_month: '2083-07', business_date_from: '2026-11-05', business_date_to: '2026-11-06' } }), 'common.validation_failed', 400);
    expect(billingSql()).toEqual([]);
  });
});

describe('existing dashboard behaviour of the full-permission personas (tile key set)', () => {
  it('ADMIN (tenant_admin: holds both source permissions) gets outstanding next to the 13 existing ones, no cash tile', async () => {
    const body = await dash((await makeCtx14(ADMIN)).ctx);
    expect(OUT in body.tiles).toBe(true);
    expect(CASH in body.tiles).toBe(false);
    expect(Object.keys(body.tiles)).toHaveLength(14);
  });

  it('OWNER_ALL09 (owner_viewer: cash_report.read, no account.read): neither new tile', async () => {
    const body = await dash((await makeCtx14(OWNER_ALL09)).ctx);
    expect(CASH in body.tiles).toBe(false);
    expect(OUT in body.tiles).toBe(false);
  });
});
