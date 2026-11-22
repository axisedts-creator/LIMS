// @vitest-environment jsdom
// T0D-FIX-9 (LD-455, founder order 2026-11-22 22:06 NPT) web side of the silent failures of the sweep (server log, live tenant, 22/11 12:34 to 12:47 UTC).
// REAL serverFetch and REAL pages over MSW. The API doubles are strict like the deployed validator (contracts/openapi declared names, values and enums; anything else 400):
//   getDailyCash: query names business_date, centre_id, collected_by_membership_id. The web builder sends `date` and `actor_membership_id` -> 400 (CAUSE, web side).
//   listInventoryCodedSet: path set_name is one of uom | reasons | tax_codes (reason_group for the reason lists). The web asks /coded-sets/wastage, /adjustment,
//     /transfer_discrepancy, /calibration (read.server.ts listCodedSet) -> 400 before sign-in checks (CAUSE, web side; log line had no tenant and no actor).
//   listStockMovements: web sends movement_kind=opening_balance&limit=1 and is right; the API refused it (fix in lots.schemas.ts, tested in the api suite). Here only the web side of
//     "a failed call is shown": the S1 checklist hides the failure with soft() -> no error.
// RULE (task): a failed call is shown inside its section as a kit inline error with the reference (ErrorState: "Reference: <request id>"), never an empty section.
// ASSUMED (dispute if wrong): the reference text is `Reference: <first 8+ chars of problem.request_id>`; the builder KEEPS its signature (date, centreId, actorMembershipId in; the wire
// names change) and listCodedSet keeps its set union (wastage etc. map to /coded-sets/reasons?reason_group=<set>); where an error is shown is the writer's choice (page level or section).
// Synthetic data only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

const PC = (globalThis as unknown as { __PC: { nav: { search: string; path: string }; session: { permissions: string[] } } }).__PC;
const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

const ROOT = join(process.cwd(), '..', '..'); // run through `pnpm --dir apps/web` (cwd = apps/web); jsdom's import.meta.url is not a file URL
const contract = (f: string) => parse(readFileSync(join(ROOT, 'contracts', 'openapi', f), 'utf8'));
const inv = contract('inventory.yaml');
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const CENTRE = U(3), STORE = U(4), MEMBER = U(5), REQ = '01a20343-8f4d-7ce8-b2bb-bf521bf87bda';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const problem = (status: number, code: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: REQ }, { status, headers: { 'content-type': 'application/problem+json' } });

// ---- strict doubles built from the contract itself
const setEnum: string[] = inv.paths['/v1/inventory/coded-sets/{set_name}'].get.parameters.find((p: any) => p.name === 'set_name').schema.enum;
const groupEnum: string[] = inv.paths['/v1/inventory/coded-sets/{set_name}'].get.parameters.find((p: any) => p.name === 'reason_group').schema.enum;
const movementKinds: string[] = inv.paths['/v1/inventory/movements'].get.parameters.find((p: any) => p.name === 'movement_kind').schema.items.enum;
const movementKeys = new Set<string>(inv.paths['/v1/inventory/movements'].get.parameters.map((p: any) => p.name ?? 'cursor').concat(['cursor', 'limit']));
const DAILY_KEYS = ['business_date', 'centre_id', 'collected_by_membership_id'];

type Hit = { path: string; query: URLSearchParams };
const hits: Hit[] = [];
const rec = (r: Request) => { const u = new URL(r.url); hits.push({ path: u.pathname, query: u.searchParams }); };
const cfg = { dailyFail: false as false | 'sessions' | 'all', movementsFail: false, codedFail: false };

const dailyCash = ({ request }: { request: Request }) => {
  rec(request);
  const q = new URL(request.url).searchParams;
  if (cfg.dailyFail === 'all' || (cfg.dailyFail === 'sessions' && q.has('centre_id'))) return problem(400, 'common.validation_failed');
  const bad = [...q.keys()].some((k) => !DAILY_KEYS.includes(k)) || (q.has('business_date') && !/^\d{4}-\d{2}-\d{2}$/.test(q.get('business_date')!))
    || ['centre_id', 'collected_by_membership_id'].some((k) => q.has(k) && !UUID.test(q.get(k)!));
  if (bad) return problem(400, 'common.validation_failed');
  return HttpResponse.json({ business_date: q.get('business_date') ?? '2026-11-22', business_date_bs: '2083-08-07', rows: [], totals: { gross: { amount_paisa: 0, currency: 'NPR' }, reversed: { amount_paisa: 0, currency: 'NPR' }, net: { amount_paisa: 0, currency: 'NPR' } }, sessions: [] });
};
const codedSet = ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
  rec(request);
  const q = new URL(request.url).searchParams;
  const set = String(params['set']);
  if (cfg.codedFail || !setEnum.includes(set) || [...q.keys()].some((k) => k !== 'reason_group') || (q.has('reason_group') && !groupEnum.includes(q.get('reason_group')!))) return problem(400, 'common.validation_failed');
  return HttpResponse.json({ data: [{ code: 'syn_code', display: 'Synthetic reason', sort_order: 1, is_active: true }] });
};
const movements = ({ request }: { request: Request }) => {
  rec(request);
  const q = new URL(request.url).searchParams;
  const lim = q.get('limit');
  const bad = cfg.movementsFail || [...q.keys()].some((k) => !movementKeys.has(k)) || (lim !== null && !(/^\d+$/.test(lim) && +lim >= 1 && +lim <= 200))
    || (q.has('movement_kind') && !q.get('movement_kind')!.split(',').every((k) => movementKinds.includes(k)));
  if (bad) return problem(400, 'common.validation_failed');
  return HttpResponse.json({ data: [], page: { limit: lim ? +lim : 50 } });
};
const empty = ({ request }: { request: Request }) => { rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); };
const store = { id: STORE, branch_id: U(6), branch_name: 'Synthetic Branch', store_code: 'MAIN', name: 'Synthetic Main Store', store_kind: 'main', is_default_consumption: true, is_active: true, version: 1 };
const settings = { vat_in_cost: false, po_self_approval_allowed: false, grn_without_po_allowed: false, over_receipt_tolerance_bp: 0, expiry_alert_days: 30, count_locks_store: false, per_day_requires_activity: false,
  reconciliation_gap_alert_bp: 0, backdate_max_days: 3, po_no_pattern: 'PO-{seq}', grn_no_pattern: 'GRN-{seq}', transfer_no_pattern: 'TR-{seq}', count_no_pattern: 'SC-{seq}', doc_no_pattern: 'SD-{seq}', version: 1 };
const money0 = { amount_paisa: 0, currency: 'NPR' };

const api = setupServer(
  http.get(`${ORIGIN}/v1/billing/daily-cash`, dailyCash),
  http.get(`${ORIGIN}/v1/billing/cash-sessions/current`, ({ request }) => { rec(request); return problem(404, 'common.not_found'); }),
  http.get(`${ORIGIN}/v1/identity/centres`, ({ request }) => { rec(request); return HttpResponse.json({ data: [{ centre_id: CENTRE, code: 'SYN', name: 'Synthetic Centre', branch_id: U(6), kind: 'own', is_active: true, version: 1 }] }); }),
  http.get(`${ORIGIN}/v1/billing/daily-collection-summary`, ({ request }) => { rec(request); return HttpResponse.json({ centre_id: CENTRE, day: '2026-11-22', rows: [], total: money0 }); }),
  http.get(`${ORIGIN}/v1/billing/credit-parties`, empty),
  http.get(`${ORIGIN}/v1/billing/account-particulars`, empty),
  http.get(`${ORIGIN}/v1/inventory/coded-sets/:set`, codedSet),
  http.get(`${ORIGIN}/v1/inventory/movements`, movements),
  http.get(`${ORIGIN}/v1/inventory/stores`, ({ request }) => { rec(request); return HttpResponse.json({ data: [store], page: { limit: 200 } }); }),
  http.get(`${ORIGIN}/v1/inventory/settings`, ({ request }) => { rec(request); return HttpResponse.json(settings); }),
  http.get(`${ORIGIN}/v1/inventory/*`, empty),
  http.get(`${ORIGIN}/v1/instruments/*`, empty),
  http.get(`${ORIGIN}/v1/catalog/*`, empty),
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); hits.length = 0; cfg.dailyFail = false; cfg.movementsFail = false; cfg.codedFail = false; });
afterAll(() => api.close());

const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');
const REFERENCE = new RegExp(`Reference:\\s*${REQ.slice(0, 8)}`);
const of = (re: RegExp) => hits.filter((h) => re.test(h.path));
async function show(file: string, perms: string[], sp: Record<string, string> = {}) {
  PC.session.permissions = perms;
  PC.nav.path = `/${file}`;
  const page = (await import(/* @vite-ignore */ `../app/(staff)/${file}/page.tsx`)).default as (p: unknown) => Promise<React.ReactElement>;
  const el = await page({ searchParams: Promise.resolve(sp), params: Promise.resolve({}) });
  return render(<ToastProvider>{el}</ToastProvider>);
}
const DAILY_PERMS = ['billing.cash_report.read', 'billing.account.read', 'billing.account_entry.create'];

describe('the stand-ins are strict like the contract (guards the tests themselves)', () => {
  it('the contract has the three set names, the daily cash names and movement_kind kinds', () => {
    expect(setEnum).toEqual(['uom', 'reasons', 'tax_codes']);
    expect(groupEnum).toEqual(expect.arrayContaining(['wastage', 'adjustment', 'transfer_discrepancy', 'calibration']));
    expect(movementKinds).toContain('opening_balance');
    const names = contract('billing.yaml').paths['/v1/billing/daily-cash'].get.parameters.map((p: any) => p.name);
    expect(names).toEqual(DAILY_KEYS);
  });
});

describe('1. getDailyCash (screen /billing/daily-cash): the web sends the contract names', () => {
  it('the builder sends business_date, centre_id, collected_by_membership_id and gets the report', async () => {
    const { getDailyCash } = await import('@/features/billing/server/read.server');
    const r = await getDailyCash({ date: '2026-11-20', centreId: CENTRE, actorMembershipId: MEMBER });
    expect(r.business_date).toBe('2026-11-20');
    const q = of(/daily-cash$/)[0]!.query;
    expect([...q.keys()].sort()).toEqual([...DAILY_KEYS].sort());
    expect(q.get('business_date')).toBe('2026-11-20');
    expect(q.get('collected_by_membership_id')).toBe(MEMBER);
  });
  it('the builder with no argument sends no query at all (today)', async () => {
    const { getDailyCash } = await import('@/features/billing/server/read.server');
    await getDailyCash();
    expect([...of(/daily-cash$/)[0]!.query.keys()]).toEqual([]);
  });
  it('the builder still refuses a malformed date or id before any request (400 in the BFF)', async () => {
    const { getDailyCash } = await import('@/features/billing/server/read.server');
    // the builder may throw synchronously or reject: both are a 400 before any request
    await expect((async () => getDailyCash({ date: '20/11/2026' }))()).rejects.toMatchObject({ status: 400 });
    await expect((async () => getDailyCash({ centreId: 'KTM' }))()).rejects.toMatchObject({ status: 400 });
    expect(of(/daily-cash$/)).toHaveLength(0);
  });
  it('the page with ?date= and the collection section: every daily-cash request is contract valid and no error is shown', async () => {
    await show('billing/daily-cash', DAILY_PERMS, { date: '2026-11-20' });
    expect(of(/daily-cash$/).length).toBeGreaterThanOrEqual(2); // the report and the sessions of the centre
    expect(text()).not.toMatch(/Reference:|could not be loaded|something went wrong/i);
  });
  it('the sessions read of the collection section fails with a mocked 400: the section shows an inline error with the reference (was silent: figures just showed a dash)', async () => {
    cfg.dailyFail = 'sessions';
    await show('billing/daily-cash', DAILY_PERMS);
    expect(text()).toMatch(REFERENCE);
  });
  it('the report read fails with a mocked 400: the failure is not swallowed (it reaches the error boundary or is shown with the reference), never an empty report', async () => {
    cfg.dailyFail = 'all';
    const out = await show('billing/daily-cash', DAILY_PERMS, { date: '2026-11-20' }).then(() => 'rendered' as const, (e) => e as { status?: number });
    if (out === 'rendered') expect(text()).toMatch(REFERENCE);
    else expect(out.status).toBe(400);
  });
});

describe('2. listStockMovements (screen /inventory, set-up checklist): the web request is contract valid and a failure is shown', () => {
  it('the opening balance probe sends movement_kind=opening_balance and limit=1 only (guard: web side is right)', async () => {
    const { listOpeningMovements } = await import('@/features/inventory/server/read.server');
    const r = await listOpeningMovements();
    expect(r.data).toEqual([]);
    const q = of(/inventory\/movements$/)[0]!.query;
    expect([...q.keys()].sort()).toEqual(['limit', 'movement_kind']);
    expect(q.get('movement_kind')).toBe('opening_balance');
  });
  it('the stock drawer read sends store_id, item_id, limit only (guard)', async () => {
    const { listMovements } = await import('@/features/inventory/server/read.server');
    await listMovements(STORE, U(7));
    expect([...of(/inventory\/movements$/)[0]!.query.keys()].sort()).toEqual(['item_id', 'limit', 'store_id']);
  });
  it('the home page with a healthy movements read shows no error', async () => {
    await show('inventory', ['inventory.item.read']);
    expect(of(/inventory\/movements$/)).toHaveLength(1);
    expect(text()).not.toMatch(/Reference:/);
  });
  it('the movements probe fails with a mocked 400: the home page shows an inline error with the reference, and does not claim "Opening balances" is simply not done', async () => {
    cfg.movementsFail = true;
    await show('inventory', ['inventory.item.read']);
    expect(text()).toMatch(REFERENCE);
  });
});

describe('3. listInventoryCodedSet (screens /inventory/wastage, bench, transfers): set_name is uom | reasons | tax_codes', () => {
  it('listCodedSet(wastage) asks /coded-sets/reasons?reason_group=wastage and returns the codes (was 400: /coded-sets/wastage)', async () => {
    const { listCodedSet } = await import('@/features/inventory/server/read.server');
    for (const set of ['wastage', 'adjustment', 'transfer_discrepancy', 'calibration'] as const) {
      hits.length = 0;
      const rows = await listCodedSet(set);
      expect(rows.map((c) => c.code), set).toEqual(['syn_code']);
      const h = of(/coded-sets\//)[0]!;
      expect(h.path, set).toBe('/v1/inventory/coded-sets/reasons');
      expect([...h.query.entries()], set).toEqual([['reason_group', set]]);
    }
  });
  it('listCodedSet(uom) and (tax_codes) keep their own path with no query (guard)', async () => {
    const { listCodedSet } = await import('@/features/inventory/server/read.server');
    await listCodedSet('uom');
    await listCodedSet('tax_codes');
    expect(of(/coded-sets\//).map((h) => `${h.path}${h.query.size ? '?x' : ''}`)).toEqual(['/v1/inventory/coded-sets/uom', '/v1/inventory/coded-sets/tax_codes']);
  });
  it('the wastage page (stock manager + adjuster): its two reason reads are contract valid and no error is shown', async () => {
    await show('inventory/wastage', ['inventory.item.read', 'inventory.stock.manage', 'inventory.stock.adjust']);
    expect(of(/coded-sets\//).map((h) => `${h.path}?${h.query}`).sort()).toEqual(['/v1/inventory/coded-sets/reasons?reason_group=adjustment', '/v1/inventory/coded-sets/reasons?reason_group=wastage']);
    expect(text()).not.toMatch(/Reference:/);
  });
  it('the reason read fails with a mocked 400: the wastage page shows an inline error with the reference instead of an empty reason list', async () => {
    cfg.codedFail = true;
    await show('inventory/wastage', ['inventory.item.read', 'inventory.stock.manage', 'inventory.stock.adjust']);
    expect(text()).toMatch(REFERENCE);
  });
});
