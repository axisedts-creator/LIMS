// T0D-ACCT-1 reviewer item 1 (2026-11-17): listAccountSummaries must stay inside the `general` rate burst (02-CONVENTIONS §10.3: 10 req/s, burst 20),
// never drop a failed party silently, and say when it cut the list at 200. Contract asserted:
//   listAccountSummaries(parties) -> Promise<{ summaries: AccountSummary[]; failed: number; truncated: boolean }>, at most 5 requests in flight.
// Synthetic data only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Accountant', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/billing/accounts/summary',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;

let inFlight = 0;
let peak = 0;
let seen: string[] = [];
let failIds = new Set<string>();
const api = setupServer(
  http.get(`${ORIGIN}/v1/billing/account-summary`, async ({ request }) => {
    const u = new URL(request.url);
    const id = u.searchParams.get('party_id')!;
    seen.push(id);
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    if (failIds.has(id)) return HttpResponse.json({ code: 'common.rate_limited', title: 'Too many requests', status: 429 }, { status: 429 });
    return HttpResponse.json({ party_kind: u.searchParams.get('party_kind'), party_id: id, credit_limit_paisa: 0, outstanding_paisa: 100, outstanding_side: 'debit', is_blocked: false });
  }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { api.resetHandlers(); inFlight = 0; peak = 0; seen = []; failIds = new Set(); });
afterAll(() => api.close());

const parties = (n: number, kind: 'credit_party' | 'franchise' = 'credit_party') => Array.from({ length: n }, (_, i) => ({ id: U(1000 + i), kind, name: `Synthetic Party ${i}` }));
const load = async () => (await import('../server/accounts.server')).listAccountSummaries as (p: readonly unknown[]) => Promise<{ summaries: { party_id: string }[]; failed: number; truncated: boolean }>;

describe('listAccountSummaries (Account Summary BFF)', () => {
  it('returns { summaries, failed: 0, truncated: false } when every party loads', async () => {
    const list = await load();
    const r = await list(parties(3));
    expect(r.summaries.map((s) => s.party_id)).toEqual(parties(3).map((p) => p.id));
    expect(r.failed).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it('never has more than 5 requests in flight (30 parties stay inside the burst of 20)', async () => {
    const list = await load();
    const r = await list(parties(30));
    expect(r.summaries).toHaveLength(30);
    expect(peak).toBeGreaterThan(1); // still parallel, not a serial loop
    expect(peak).toBeLessThanOrEqual(5);
  });

  it('counts a refused party in failed instead of dropping it silently; the rest still load', async () => {
    failIds = new Set([U(1001), U(1004)]);
    const list = await load();
    const r = await list(parties(6));
    expect(r.failed).toBe(2);
    expect(r.summaries).toHaveLength(4);
    expect(r.summaries.map((s) => s.party_id)).not.toContain(U(1001));
    expect(r.truncated).toBe(false);
  }, 15000); // the 429 retries (3 attempts, 1000 ms waits) take about 2 s

  // Reviewer round 2 item 2: a 429 common.rate_limited waits 1000 ms and retries, at most 3 attempts per party, then counts as failed.
  it('retries a 429 once after the wait and then loads the party (failed 0)', async () => {
    const calls = new Map<string, number>();
    api.use(http.get(`${ORIGIN}/v1/billing/account-summary`, ({ request }) => {
      const u = new URL(request.url);
      const id = u.searchParams.get('party_id')!;
      const n = (calls.get(id) ?? 0) + 1;
      calls.set(id, n);
      if (id === U(1001) && n === 1) return HttpResponse.json({ code: 'common.rate_limited', title: 'Too many requests', status: 429 }, { status: 429 });
      return HttpResponse.json({ party_kind: u.searchParams.get('party_kind'), party_id: id, credit_limit_paisa: 0, outstanding_paisa: 100, outstanding_side: 'debit', is_blocked: false });
    }));
    const list = await load();
    const started = Date.now();
    const r = await list(parties(3));
    expect(r.failed).toBe(0);
    expect(r.summaries.map((s) => s.party_id).sort()).toEqual(parties(3).map((p) => p.id).sort());
    expect(calls.get(U(1001))).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900); // waited ~1000 ms before the retry
  }, 15000);

  it('gives up after 3 attempts on a party that is always 429 and counts it failed', async () => {
    const calls = new Map<string, number>();
    api.use(http.get(`${ORIGIN}/v1/billing/account-summary`, ({ request }) => {
      const u = new URL(request.url);
      const id = u.searchParams.get('party_id')!;
      calls.set(id, (calls.get(id) ?? 0) + 1);
      if (id === U(1001)) return HttpResponse.json({ code: 'common.rate_limited', title: 'Too many requests', status: 429 }, { status: 429 });
      return HttpResponse.json({ party_kind: u.searchParams.get('party_kind'), party_id: id, credit_limit_paisa: 0, outstanding_paisa: 100, outstanding_side: 'debit', is_blocked: false });
    }));
    const list = await load();
    const r = await list(parties(3));
    expect(r.failed).toBe(1);
    expect(r.summaries).toHaveLength(2);
    expect(calls.get(U(1001))).toBe(3);
  }, 15000);

  it('does not retry a non-429 refusal (403 counts failed after one attempt)', async () => {
    const calls = new Map<string, number>();
    api.use(http.get(`${ORIGIN}/v1/billing/account-summary`, ({ request }) => {
      const id = new URL(request.url).searchParams.get('party_id')!;
      calls.set(id, (calls.get(id) ?? 0) + 1);
      return HttpResponse.json({ code: 'common.forbidden', title: 'Forbidden', status: 403 }, { status: 403 });
    }));
    const list = await load();
    const r = await list(parties(2));
    expect(r.failed).toBe(2);
    expect(calls.get(U(1000))).toBe(1);
  });

  it('cuts at 200 clients and franchises, reports truncated, and skips pockets and laboratories', async () => {
    const list = await load();
    const input = [...parties(150), ...parties(80, 'franchise').map((p, i) => ({ ...p, id: U(5000 + i) })), { id: U(9001), kind: 'user_pocket', name: 'Synthetic Pocket' }, { id: U(9002), kind: 'laboratory', name: 'Synthetic Lab' }];
    const r = await list(input);
    expect(seen).toHaveLength(200);
    expect(seen).not.toContain(U(9001));
    expect(seen).not.toContain(U(9002));
    expect(r.truncated).toBe(true);
    expect(r.summaries.length + r.failed).toBe(200);
  });

  it('exactly 200 eligible parties is not truncated', async () => {
    const list = await load();
    const r = await list(parties(200));
    expect(r.truncated).toBe(false);
    expect(r.summaries).toHaveLength(200);
  });

  it('empty input makes no request', async () => {
    const list = await load();
    expect(await list([])).toEqual({ summaries: [], failed: 0, truncated: false });
    expect(seen).toHaveLength(0);
  });
});
