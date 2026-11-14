// @vitest-environment jsdom
// AN-T19 — the 11 report pages under app/(staff)/analytics/reports/** (04-UI-UX §2 frame, §4.1–4.12, §10), generic behaviour, table-driven.
// ACs (UI side): US-03.1/.6, US-04.1/.2, US-05.1, US-06.1, US-09.2/.3, US-10.3/.4, US-11.1, US-12.1/.2, US-13.1/.2, US-14.1/.2.
// ASSUMED contract (spec fixes only the paths + kit primitives; same style as AN-T18):
//   * each report page = default export async server component, either reports/<slug>/page.tsx or reports/[reportCode]/page.tsx (harness accepts both),
//     called `Page({ searchParams: Promise<…>, params?: Promise<{<key>: slug}> })`; it reads the API itself (serverFetch, Bearer from the session),
//     checks the session permission `analytics.dashboard.read` BEFORE any API call, and returns a tree that renders in a plain client render
//     (no nested async server components).  Pending tests reads …/pending-tests/items (main) and …/pending-tests/summary.
//   * only whitelisted, well-formed params reach the API (period, centre_id/branch_id comma-joined uuids ≤ 20, plus the per-report params of
//     contracts/openapi/analytics.yaml); malformed values are dropped.
//   * tables = kit DataTable (role=grid, aria-label = report title); totals = LAST row whose row header is "Total"; copy per 04-UI-UX §13.
//   * API 5xx/403 reject (analytics/error.tsx handles it); secondary reads (filter-options, freshness) failing must not break the page.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import {
  ALL, REPORTS, TOKEN, api, axeClean, bodies, calls, gridNamed, headersOf, lastRow, norm, pageText, problem, readCalls, resetApi, respond, rowTexts, session, show, showOrRefuse,
} from './an-t19.harness';

vi.mock('next/navigation', async () => (await import('./an-t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t19.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetApi());
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const HOSTILE = '<img src=x onerror=alert(1)>';
const main = (r: (typeof REPORTS)[number]) => r.paths[0]!;
const mainCalls = (r: (typeof REPORTS)[number]) => calls.filter((c) => c.method === 'GET' && c.url.pathname === main(r));

// Collections is its own page with its own permission: covered in an-t19.hub.test.tsx.
const GENERIC = REPORTS.filter((r) => r.slug !== 'collections');

describe.each(GENERIC)('report page $slug', (r) => {
  describe('request (07-SECURITY: BFF whitelist, Bearer from the session, nothing in the DOM)', () => {
    it('with no params sends no period params, uses the session Bearer token and never puts it in the DOM', async () => {
      const { container } = await show(r.slug);
      expect(mainCalls(r)).toHaveLength(1);
      const { url, headers } = mainCalls(r)[0]!;
      for (const p of ['business_date_from', 'business_date_to', 'bs_month', 'fiscal_year_bs']) expect(url.searchParams.has(p), p).toBe(false);
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(container.innerHTML).not.toContain(TOKEN);
    });

    it('forwards well-formed period/centre/branch params (comma-joined) and drops everything else', async () => {
      await show(r.slug, { bs_month: '2083-07', centre_id: '01a1a98a-ac40-7000-8000-000000000002,01a1a98a-ac40-7000-8000-000000000003', branch_id: ['01a1a98a-ac40-7000-8000-000000000004'], evil: '1', tenant_id: 'other' });
      const u = mainCalls(r)[0]!.url;
      // 04-UI-UX §4 / analytics.yaml: pending-tests has no period params; tests-done (getTestsDoneReport, :1304-1349) defines no centre_id/branch_id.
      if (r.slug === 'pending-tests') expect(u.searchParams.has('bs_month')).toBe(false);
      else expect(u.searchParams.get('bs_month')).toBe('2083-07');
      if (r.slug === 'tests-done') {
        expect(u.searchParams.has('centre_id')).toBe(false);
        expect(u.searchParams.has('branch_id')).toBe(false);
      } else {
        expect(u.searchParams.get('centre_id')).toBe('01a1a98a-ac40-7000-8000-000000000002,01a1a98a-ac40-7000-8000-000000000003');
        expect(u.searchParams.get('branch_id')).toBe('01a1a98a-ac40-7000-8000-000000000004');
      }
      expect(u.searchParams.has('evil')).toBe(false);
      expect(u.searchParams.has('tenant_id')).toBe(false);
    });

    it.each([['bs_month', '2083-07&centre_id=x'], ['fiscal_year_bs', '2082/83;drop'], ['business_date_from', '2026-1-5'], ['centre_id', 'not-a-uuid'], ['branch_id', '../../etc/passwd']])('does not forward a malformed %s (%s)', async (key, bad) => {
      await show(r.slug, { [key]: bad });
      for (const c of readCalls()) {
        expect(c.url.searchParams.get(key)).not.toBe(bad);
        expect(c.url.search).not.toMatch(/drop|passwd|centre_id=x/);
      }
    });

    it.skipIf(r.params.length === 0)('forwards each per-report param when valid and drops it when malformed', async () => {
      for (const [key, good, bad] of r.params) {
        await show(r.slug, { [key]: good });
        expect(mainCalls(r).at(-1)!.url.searchParams.get(key), `${key}=${good}`).toBe(good);
        cleanup(); calls.length = 0;
        await show(r.slug, { [key]: bad });
        const sent = mainCalls(r).at(-1)!.url.searchParams.get(key);
        expect(sent === null || sent !== bad, `${key}=${bad} must not be forwarded`).toBe(true);
        expect(mainCalls(r).at(-1)!.url.search).not.toContain('drop');
        cleanup(); calls.length = 0;
      }
    });

    it('reads nothing when the session lacks analytics.dashboard.read (finance-only user): no API call, no figures', async () => {
      session.permissions = ['analytics.collections.read'];
      const rendered = await showOrRefuse(r.slug);
      expect(readCalls(), 'report data must not be requested').toHaveLength(0);
      if (rendered) expect(pageText()).not.toMatch(/2,25,000|Synthetic|42 min/);
    });
  });

  describe('table (04-UI-UX §4 columns, common table rules)', () => {
    it('renders the spec captions and column headers, and the data rows with lakh money / % from bp / durations', async () => {
      await show(r.slug);
      for (const t of r.tables) {
        const g = gridNamed(t.name);
        const h = headersOf(g);
        expect(t.skipFirst ? h.slice(1) : h, `${t.name} headers`).toEqual(t.headers);
        if (t.skipFirst) expect(h[0]!.length).toBeGreaterThan(0);
        const text = rowTexts(g).join(' | ');
        for (const s of t.rowText) expect(text, `${t.name}: ${s}`).toContain(s);
      }
    });

    it('puts a "Total" row header on the LAST row with the totals (where the report has totals)', async () => {
      await show(r.slug);
      for (const t of r.tables.filter((x) => x.total)) {
        const g = gridNamed(t.name);
        const last = lastRow(g);
        expect(within(last).getAllByRole('rowheader').map((c) => norm(c.textContent)), `${t.name} total row header`).toContain('Total');
        for (const s of t.totalText ?? []) expect(norm(last.textContent), `${t.name} total ${s}`).toContain(s);
      }
    });

    it('shows the notes/labels of the page (copy catalogue, 04-UI-UX §13)', async () => {
      await show(r.slug);
      for (const s of r.texts) expect(pageText(), s).toContain(s);
    });

    it('keeps user-entered labels as text (REQ-SEC-088/089): a hostile label is not parsed as HTML', async () => {
      bodies[r.paths[0]!] = r.hostile(r.body, HOSTILE);
      const { container } = await show(r.slug);
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain(HOSTILE);
    });

    it('has no axe violations (WCAG 2.2 AA, §10)', async () => {
      await show(r.slug);
      await axeClean();
    });

    it('never uses the word "commission" (US-07.3 CI rule applies to all C8 copy)', async () => {
      const { container } = await show(r.slug);
      expect(container.innerHTML).not.toMatch(/commission/i);
    });
  });

  describe('frame (04-UI-UX §2)', () => {
    it('shows the period in A.D. and B.S. from the API labels, and "Updated …" freshness', async () => {
      await show(r.slug);
      const t = pageText();
      expect(t).toContain(r.slug === 'pending-tests' ? 'Updated' : '01 Jan – 15 Jan 2026');
      if (r.slug !== 'pending-tests') expect(t).toContain('2082-09-17 – 2082-10-01');
      expect(t).toMatch(/Updated /);
    });

    it('shows the report tab strip with this report selected', async () => {
      session.permissions = ['analytics.dashboard.read'];
      await show(r.slug);
      const tab = screen.getByRole('tab', { name: r.tab });
      expect(tab.getAttribute('aria-selected')).toBe('true');
    });

    it('stale data: marker as text (not colour only) with the reason, and the last figures stay visible', async () => {
      bodies[r.paths[0]!] = { ...r.body, freshness: [{ family: 'income', refreshed_at: '2026-01-15T03:45:00.000Z', is_stale: true, stale_reason: 'refresh_failed', live: false }] };
      if (r.slug === 'pending-tests') bodies[r.paths[1]!] = { ...r.extra![r.paths[1]!], freshness: [{ family: 'pending_items', refreshed_at: '2026-01-15T03:45:00.000Z', is_stale: true, stale_reason: 'refresh_failed', live: false }] };
      await show(r.slug);
      const t = pageText();
      expect(t).toContain('Data may be out of date');
      expect(t).toContain('Last update failed — the team has been alerted');
      expect(rowTexts(gridNamed(r.tables[0]!.name)).join(' ')).toContain(r.tables[0]!.rowText[0]!);
    });

    it('Export is offered only with analytics.data.export (menu behaviour: an-t19.hub.test)', async () => {
      await show(r.slug);
      expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
      cleanup();
      session.permissions = ['analytics.dashboard.read', 'analytics.data.export'];
      await show(r.slug);
      expect(screen.getByRole('button', { name: /export/i })).toBeTruthy();
    });

    it('a failing secondary read (filter options 503) does not break the page (X20)', async () => {
      respond['/v1/analytics/filter-options'] = () => problem('common.dependency_unavailable', 503);
      respond['/v1/analytics/freshness'] = () => problem('common.dependency_unavailable', 503);
      await show(r.slug);
      expect(gridNamed(r.tables[0]!.name)).toBeTruthy();
    });
  });

  describe('states', () => {
    it('empty: the table shows "No data for this period and filter"', async () => {
      bodies[r.paths[0]!] = r.empty;
      Object.assign(bodies, r.emptyExtra ?? {});
      await show(r.slug);
      expect(pageText()).toContain('No data for this period and filter');
      expect(screen.queryAllByRole('grid').length).toBeGreaterThan(0);
    });

    it.each([500, 503])('API %i rejects so analytics/error.tsx can show the reference (no half-rendered figures)', async (status) => {
      respond[main(r)] = () => problem(status === 500 ? 'common.internal' : 'common.dependency_unavailable', status);
      const p = show(r.slug);
      await expect(p).rejects.toBeTruthy();
      await expect(p).rejects.not.toThrow(/no page for report|Cannot find module/);
    });

    it('API 403 shows no figures', async () => {
      respond[main(r)] = () => problem('auth.forbidden', 403);
      const rendered = await showOrRefuse(r.slug);
      if (rendered) expect(pageText()).not.toContain(r.tables[0]!.rowText[0]!);
    });

    it('a malformed body (rows missing) never renders NaN/undefined/[object Object]', async () => {
      bodies[main(r)] = { ...r.body, rows: undefined };
      const rendered = await showOrRefuse(r.slug);
      if (rendered) expect(document.body.textContent).not.toMatch(/NaN|undefined|\[object Object\]/);
    });
  });
});

describe('every report page sends its read exactly once and is read-only (REQ-SEC)', () => {
  it.each(GENERIC)('$slug issues only GETs to /v1/analytics (no mutation on render)', async (r) => {
    session.permissions = ALL;
    await show(r.slug);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(calls.every((c) => c.url.origin === 'http://api.test')).toBe(true);
  });
});
