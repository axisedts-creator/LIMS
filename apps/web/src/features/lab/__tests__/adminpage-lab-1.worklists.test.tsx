// @vitest-environment jsdom
// ADMINPAGE-LAB-1 — /lab/worklists department index (C5 04-UI-UX 1 + 3.4 "Picker: department cards", route permission lab.worklist.read, LD-255, LD-250).
// Tested through the real page (async server component) against a mocked API (msw):
//   page: apps/web/src/app/(staff)/lab/worklists/page.tsx, default export async ({searchParams?}) => element; session perms from getShellSession().
//   Operation: GET /v1/catalog/departments (C3 listDepartments, contracts/openapi/catalog.yaml, x-permission catalog.test.read, paged, limit <= 200).
//   lab.yaml has NO operation that lists departments or per-department counts, so the departments come from C3 and the "counts (open, urgent)" of the spec
//   are a SPEC GAP (see notes): the tests do not require counts, and GET /v1/lab/worklist-items is the only other call a page may make.
//   Every card links to the existing page /lab/worklists/{department_id}.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '@/core/i18n/messages';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';

const ORIGIN = 'http://api.test';
const READ = 'lab.worklist.read';
const DEPTS_URL = `${ORIGIN}/v1/catalog/departments`;
const ITEMS_URL = `${ORIGIN}/v1/lab/worklist-items`;
const U = (n: number) => `0d1d1d1d-ac40-7000-8000-${String(n).padStart(12, '0')}`;

const session = { perms: [] as string[] };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/worklists',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.perms, displayName: 'Synthetic Admin', tenantCode: 'syn', roles: [], membershipId: '01a1a98a-ac40-7000-8000-000000000090' } }),
  getRequestPathname: async () => '/lab/worklists',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const dept = (n: number, code: string, name: string, o: Record<string, unknown> = {}) => ({
  id: U(n), code, name, is_active: true, version: 1, created_at: '2026-11-05T04:15:00.000Z', updated_at: '2026-11-05T04:15:00.000Z', report_order: n * 10, ...o,
});
const DEPARTMENTS = [dept(1, 'HAEM', 'Haematology'), dept(2, 'BIOC', 'Biochemistry'), dept(3, 'MICRO', 'Microbiology')];
const problem = (status: number, code: string) =>
  HttpResponse.json({ type: 'about:blank', title: code, status, code, request_id: 'req-synthetic', }, { status, headers: { 'content-type': 'application/problem+json' } });

type Call = { method: string; url: URL; headers: Headers };
const calls: Call[] = [];
const rec = (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers }); };
let departments: unknown[] = DEPARTMENTS;
const deptsHandler = ({ request }: { request: Request }) => { rec(request); return HttpResponse.json({ data: departments, page: { limit: 200 } }); };
const api = setupServer(
  http.get(DEPTS_URL, deptsHandler),
  http.get(ITEMS_URL, ({ request }) => { rec(request); return HttpResponse.json({ data: [], page: { limit: 200 } }); }), // optional: counts
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' })); // any operation outside the two above fails the test (no invented operation)
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; session.perms = []; departments = DEPARTMENTS; });
afterAll(() => api.close());

const SEG = 'worklists'; // the page may not exist yet: resolved at run time so each test fails (page missing), not the collection
const pageModule = async () => (await import(/* @vite-ignore */ `../../../app/(staff)/lab/${SEG}/page`)) as { default: (p: any) => Promise<ReactNode> };
async function render_(perms: string[] = [READ], sp: Record<string, string> = {}) {
  session.perms = perms;
  const { default: Page } = await pageModule();
  render(await Page({ searchParams: Promise.resolve(sp) }));
  return userEvent.setup();
}
const deptCalls = () => calls.filter((c) => c.url.pathname === '/v1/catalog/departments');
const cardLinks = () => screen.getAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').startsWith('/lab/worklists/'));

describe('permission gate (lab.worklist.read)', () => {
  it.each([[[]], [['frontdesk.order.read', 'lab.critical_value.read', 'catalog.test.read']]])('perms %j: the API is never called and no department is shown (notFound or the permission-denied page)', async (perms) => {
    session.perms = perms as string[];
    const { default: Page } = await pageModule();
    let out: ReactNode | undefined;
    try { out = await Page({ searchParams: Promise.resolve({}) }); } catch (e) { expect(String((e as Error).message)).toBe('NEXT_NOT_FOUND'); }
    if (out !== undefined) {
      render(out);
      expect(screen.queryByText('Haematology')).toBeNull();
      expect(screen.queryAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').startsWith('/lab/worklists/'))).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });

  it('the session holds lab.worklist.read but the API answers 403 (the user lacks catalog.test.read): permission-denied state, no cards, no crash (not error.tsx)', async () => {
    api.use(http.get(DEPTS_URL, ({ request }) => { rec(request); return problem(403, 'auth.forbidden'); }));
    session.perms = [READ];
    const { default: Page } = await pageModule();
    let out: ReactNode | undefined;
    try { out = await Page({ searchParams: Promise.resolve({}) }); } catch (e) { expect(String((e as Error).message)).toBe('NEXT_NOT_FOUND'); }
    if (out !== undefined) { render(out); expect(screen.queryAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').startsWith('/lab/worklists/'))).toEqual([]); }
  });
});

describe('department index (listDepartments)', () => {
  it('reads the departments once with the bearer token, limit <= 200, active only, and shows the page title "Worklists"', async () => {
    await render_();
    expect(deptCalls()).toHaveLength(1);
    const c = deptCalls()[0]!;
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    const limit = Number(c.url.searchParams.get('limit') ?? '50');
    expect(limit).toBeGreaterThanOrEqual(1);
    expect(limit).toBeLessThanOrEqual(200);
    expect(['true', null]).toContain(c.url.searchParams.get('is_active')); // default true: never `all` or `false`
    expect(screen.getByRole('heading', { level: 1, name: t('lab.nav.worklists') })).toBeTruthy();
  });

  it('every department is one link to /lab/worklists/{department_id} showing its name and code, in the order the API returned', async () => {
    await render_();
    const links = cardLinks();
    expect(links.map((a) => a.getAttribute('href'))).toEqual(DEPARTMENTS.map((d) => `/lab/worklists/${d.id}`));
    DEPARTMENTS.forEach((d, i) => {
      expect(links[i]!.textContent).toContain(d.name);
      expect(within(links[i]!.closest('li,article,section,div') as HTMLElement).getByText((_c, el) => (el?.textContent ?? '').trim() === d.code && !Array.from(el?.children ?? []).some((k) => (k.textContent ?? '').trim() === d.code))).toBeTruthy();
    });
  });

  it('an inactive department the API still returns is not offered', async () => {
    departments = [...DEPARTMENTS, dept(9, 'OLD', 'Retired Section', { is_active: false })];
    await render_();
    expect(screen.queryByText('Retired Section')).toBeNull();
    expect(cardLinks()).toHaveLength(3);
  });

  it('a department name is rendered as text, never as markup', async () => {
    departments = [dept(7, 'XSS', '<img src=x onerror=alert(1)>Haem')];
    await render_();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>Haem');
  });

  it('makes no other call than the departments read and (optionally) the worklist-items read; no patient data is requested', async () => {
    await render_();
    for (const c of calls) {
      expect(c.method).toBe('GET');
      expect(['/v1/catalog/departments', '/v1/lab/worklist-items']).toContain(c.url.pathname);
      expect(c.url.search).not.toMatch(/patient|name=|registration|barcode/i);
    }
  });
});

describe('empty and failing states', () => {
  it('no department: an empty state names the missing departments and shows no card', async () => {
    departments = [];
    await render_();
    expect(screen.queryAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').startsWith('/lab/worklists/'))).toEqual([]);
    expect(document.body.textContent ?? '').toMatch(/no (active )?departments/i); // the spec gives no wording for the picker (gap in notes): any text naming departments
  });

  it('API 500: the page throws so error.tsx renders (no raw error text on screen)', async () => {
    api.use(http.get(DEPTS_URL, ({ request }) => { rec(request); return problem(500, 'common.internal'); }));
    session.perms = [READ];
    const { default: Page } = await pageModule();
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toBeTruthy();
  });
});

describe('accessibility and keyboard', () => {
  it('axe finds no violations (colour contrast comes from tokens and is checked elsewhere)', async () => {
    await render_();
    const v = (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })).violations.map((x) => `${x.id}: ${x.nodes[0]?.html}`);
    expect(v).toEqual([]);
  });

  it('keyboard only: Tab visits the department links in order, each link has a text name', async () => {
    const user = await render_();
    const links = cardLinks();
    const seen: Element[] = [];
    for (let i = 0; i < 12 && seen.length < links.length; i++) {
      await user.tab();
      if (links.includes(document.activeElement as HTMLAnchorElement)) seen.push(document.activeElement!);
    }
    expect(seen).toEqual(links);
    for (const a of links) expect((a.textContent ?? '').trim().length).toBeGreaterThan(0);
  });
});
