// @vitest-environment jsdom
// T0D-TESTMGMT-FIX-1 (LD-340): /catalog/tests showed the error boundary ("Something went wrong", Reference 4013850198) on staging with an EMPTY catalog,
// while /catalog and /catalog/panels rendered. Server page tests: every page is rendered through its default export (async server component) with MSW
// standing in for the API, exactly like cattests1 / testmgmt1. Synthetic data only. CONTRACT pinned here:
//   crash      : an empty catalog (all lists []) never throws on any view of /catalog/tests, whether the list answers {data:[],page:{limit}} or {data:[]}
//                (no `page` key) or {data:[],page:null}, and a failing API call is either shown as an inline warning or rethrown as the ApiError itself, NEVER a TypeError.
//   main list  : list / details / popular decide on GET /v1/catalog/tests, categories on GET /v1/catalog/test-categories: 403 -> the "no access" page
//                (CatalogForbidden, no throw); 500 or network -> PageError in the page (LD-353 rule 6, T0D-UILIST-3).
//   secondary  : departments, specimen types and categories (the list view's filter / form lists, the categories view's department names) are optional:
//                ANY failure of one (500, 403, network error) is caught; the page renders with that list empty and ONE small inline warning
//                (role alert|status|note) that names the list and says it "could not be loaded"; no status code, error code or stack in it.
//   empty list : /catalog/tests with no tests shows the 8 column headers of the Complete Test List, the "No tests yet" message as a table row,
//                four placeholder rows, and inside that row the two actions "New test" and "Import from Excel" (goes to /catalog/imports,
//                the starter workbook screen). Read-only users get no enabled action.
//   others     : /catalog/departments, specimens, units, methods, comment-codes render their empty headers + message on both list shapes; a failing
//                call is an ApiError or an inline warning, never a TypeError; comment-codes' departments (a dropdown source) is optional.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ApiError } from '@/core/api/server-fetch';
import { expectEmptyTable, expectCreateTwice, headersOf, messageRow, tableOf, tablesOf } from './emptytbl2.helpers';

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

type TMState = { nav: { search: string; path: string }; session: { permissions: string[] }; navLog: string[]; push: { mockClear: () => void; mock: { calls: unknown[][] } }; replace: { mockClear: () => void }; refresh: { mockReset: () => void } };
const TM = (globalThis as unknown as { __TM: TMState }).__TM;

const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000d${String(n).padStart(4, '0')}`;
const MANAGE = ['catalog.test.read', 'catalog.test.manage'];
const READ = ['catalog.test.read'];
const AT = '2026-11-06T09:30:00.000Z';
const base = (n: number, o: Record<string, unknown>) => ({ id: ID(n), is_active: true, version: 1, created_at: AT, updated_at: AT, ...o });
const HAEM = base(1, { code: 'HAEM', name: 'Hematology', report_order: 10 });
const EDTA = base(11, { code: 'EDTA_WB', name: 'EDTA whole blood', report_label: 'EDTA WHOLE BLOOD' });
const CAT = base(21, { department_id: HAEM.id, name: 'Routine haematology', display_order: 10, print_footer: false });
const summary = (n: number, code: string, name: string) => ({ id: ID(100 + n), kind: 'test', code, name, department_id: HAEM.id, department_code: 'HAEM', workflow_type: 'standard', is_orderable: true, is_active: true, revision: 1, short_name: code.toLowerCase(), is_popular: n === 1 });
const HB = summary(1, 'HB', 'Hemoglobin');
const CBC = summary(2, 'CBC', 'Complete blood count');

type Fail = 500 | 403 | 'network';
const API = {
  shape: 'paged' as 'paged' | 'bare' | 'nullpage',
  fail: new Map<string, Fail>(),
  data: {} as Record<string, unknown[]>,
  calls: [] as string[],
};
const P = { tests: '/v1/catalog/tests', departments: '/v1/catalog/departments', specimens: '/v1/catalog/specimen-types', categories: '/v1/catalog/test-categories' } as const;
const LIST_PATHS = [P.tests, P.departments, P.specimens, P.categories, '/v1/catalog/containers', '/v1/catalog/units', '/v1/catalog/value-sets', '/v1/catalog/methods', '/v1/catalog/comment-codes'];
const prob = (status: number, code: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code }, { status });

const api = setupServer(
  http.all(`${ORIGIN}/*`, ({ request }) => {
    const p = new URL(request.url).pathname;
    API.calls.push(`${request.method} ${p}`);
    const f = API.fail.get(p);
    if (f === 'network') return HttpResponse.error();
    if (f === 403) return prob(403, 'common.forbidden');
    if (f === 500) return prob(500, 'common.internal');
    const one = /^\/v1\/catalog\/tests\/([^/]+)$/.exec(p)?.[1];
    if (one) {
      const t = ((API.data[P.tests] ?? []) as { id: string }[]).find((x) => x.id === one);
      return t ? HttpResponse.json({ ...t, report_order: 100, uses_existing_material: false, version: 3, tags: [], specimen_requirements: [], analytes: [], tat_targets: [], stage_targets: [] }) : prob(404, 'common.not_found');
    }
    if (LIST_PATHS.includes(p)) {
      const data = API.data[p] ?? [];
      return HttpResponse.json(API.shape === 'bare' ? { data } : API.shape === 'nullpage' ? { data, page: null } : { data, page: { limit: 200 } });
    }
    return prob(500, 'test.unmocked');
  }),
);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterAll(() => api.close());
beforeEach(() => { API.shape = 'paged'; API.fail.clear(); API.data = {}; API.calls.length = 0; TM.session.permissions = MANAGE; TM.nav.search = ''; });
afterEach(() => { cleanup(); api.resetHandlers(); TM.push.mockClear(); TM.replace.mockClear(); TM.refresh.mockReset(); });

// ----------------------------------------------------------------------------------------------------------------------------- helpers
const PAGES = {
  tests: () => import('@/app/(staff)/catalog/tests/page'),
  departments: () => import('@/app/(staff)/catalog/departments/page'),
  specimens: () => import('@/app/(staff)/catalog/specimens/page'),
  units: () => import('@/app/(staff)/catalog/units/page'),
  methods: () => import('@/app/(staff)/catalog/methods/page'),
  'comment-codes': () => import('@/app/(staff)/catalog/comment-codes/page'),
} as const;
type Route = keyof typeof PAGES;
type Outcome = { ok: true; root: HTMLElement } | { ok: false; error: unknown };

/** Render /catalog/<route>?<search> like Next: the server page runs first (a throw = error.tsx), then the client parts render (a throw = error.tsx too). */
async function open(route: Route, search = '', perms: string[] = MANAGE): Promise<Outcome> {
  TM.session.permissions = perms;
  TM.nav.search = search;
  TM.nav.path = `/catalog/${route}`;
  try {
    const mod = (await PAGES[route]()) as { default: (p: unknown) => Promise<React.ReactNode> };
    const ui = await mod.default({ params: Promise.resolve({}), searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(search))) });
    return { ok: true, root: render(<ToastProvider>{ui}</ToastProvider>).container };
  } catch (error) {
    return { ok: false, error };
  }
}
const shown = (o: Outcome): HTMLElement => {
  if (!o.ok) throw new Error(`the page crashed: ${o.error instanceof Error ? `${o.error.name}: ${o.error.message}` : String(o.error)}`);
  return o.root;
};
const apiError = (o: Outcome, status?: number) => {
  expect(o.ok, 'the page must throw (error.tsx), not render').toBe(false);
  if (o.ok) return;
  expect(o.error, `a failing API call must surface as the ApiError itself, got ${o.error instanceof Error ? `${o.error.name}: ${o.error.message}` : String(o.error)}`).toBeInstanceOf(ApiError);
  if (status) expect((o.error as ApiError).status).toBe(status);
};
/** LD-353 rule 6 (T0D-UILIST-3): a failed list renders PageError in the page: title kept, message, Retry, no leak. */
const pageError = (o: Outcome, title: string, tabs: boolean) => {
  const root = shown(o);
  if (tabs) expect(within(root).getByRole('tablist', { name: /test management/i })).toBeTruthy();
  expect(within(root).getByRole('heading', { name: title })).toBeTruthy();
  expect(root.textContent).toContain('This page could not be loaded.');
  expect(within(root).getByRole('button', { name: /retry/i })).toBeTruthy();
  expect(root.textContent).not.toMatch(LEAK);
};
const forbidden = (o: Outcome) => expect(within(shown(o)).getByRole('heading', { name: /don.t have access to this part of the catalog/i })).toBeTruthy();
const noAccessText = () => /catalog\.test\.read permission/i;

/** Inline "could not be loaded" notes (role alert | status | note). */
const warnings = (root: HTMLElement) =>
  [...root.querySelectorAll('[role="alert"], [role="status"], [role="note"]')].map((e) => (e.textContent ?? '').trim()).filter((t) => /could not be loaded|unavailable|not available/i.test(t));
const LEAK = /\b500\b|\b403\b|common\.internal|common\.forbidden|urn:lims|ApiError|TypeError|stack|fetch failed|at .*\(.*:\d+:\d+\)/i;
const NAME = { [P.departments]: /department/i, [P.specimens]: /specimen/i, [P.categories]: /categor/i } as const;
const lc = (a: string[]) => a.map((s) => s.toLowerCase());

const VIEWS = [['list', ''], ['details', 'view=details'], ['categories', 'view=categories'], ['popular', 'view=popular']] as const;
type View = (typeof VIEWS)[number][0];
const MAIN: Record<View, string> = { list: P.tests, details: P.tests, categories: P.categories, popular: P.tests };
/** Lists the view reads on top of its main list (today). The warning is required for exactly these. */
const SECONDARY: Record<View, string[]> = { list: [P.departments, P.specimens, P.categories], details: [], categories: [P.departments], popular: [] };
const FAILS: Fail[] = [500, 403, 'network'];
const failName = (f: Fail) => (f === 'network' ? 'network error' : String(f));

// ----------------------------------------------------------------------------------------------------------------------------- (1) empty catalog never crashes
describe('/catalog/tests with an EMPTY catalog (0 tests, 0 departments, 0 specimen types, 0 categories) never crashes', () => {
  for (const shape of ['paged', 'bare', 'nullpage'] as const) {
    describe(`lists answer ${{ paged: '{data:[],page:{limit}}', bare: '{data:[]} (no page key)', nullpage: '{data:[],page:null}' }[shape]}`, () => {
      beforeEach(() => { API.shape = shape; });
      it.each(VIEWS)('view %s renders inside the Test management tab strip', async (view, search) => {
        const root = shown(await open('tests', search));
        const tabs = within(root).getByRole('tablist', { name: /test management/i });
        expect(within(tabs).getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(['Test details', 'Complete test list', 'Categories', 'Popular tests']);
        expect(within(tabs).getByRole('tab', { selected: true }).textContent?.trim()).toBe({ list: 'Complete test list', details: 'Test details', categories: 'Categories', popular: 'Popular tests' }[view]);
        expect(warnings(root), 'an empty catalog is not an error: no warning').toEqual([]);
      });
    });
  }

  it('details view with a test id that does not exist (404) renders the empty panes', async () => {
    const root = shown(await open('tests', `view=details&test=${ID(777)}`));
    expect(root.textContent).toMatch(/no tests yet/i);
    expect(root.textContent).toMatch(/select a test on the left/i);
  });
  it('?new=1&copy=<unknown id> on an empty catalog opens the empty form instead of crashing', async () => {
    const root = shown(await open('tests', `new=1&copy=${ID(777)}`));
    expect(await within(root.ownerDocument.body).findByRole('dialog', { name: /new test/i })).toBeTruthy();
  });
  it('a filter on an empty catalog says nothing matches (no crash on the unknown department id)', async () => {
    const root = shown(await open('tests', `department_id=${ID(1)}&q=zzz`));
    expect(messageRow(tableOf(root))?.textContent).toMatch(/no tests match/i);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- (4) the empty Complete Test List
describe('empty Complete Test List (done_when 4)', () => {
  it('draws the column headers, "No tests yet" inside the table, four placeholder rows', async () => {
    const root = shown(await open('tests'));
    const t = tableOf(root);
    expectEmptyTable(t, /no test details yet/i, ['Short name', 'Category', 'Price']); // LD-340: menu label "Test Details"
    const heads = lc(headersOf(t));
    for (const h of [/^code$/, /^name$/, /department/, /workflow/, /status/]) expect(heads.some((x) => h.test(x)), `header ${h}: ${heads.join(' | ')}`).toBe(true);
    expect(heads).toHaveLength(8);
    expect(tablesOf(root).length).toBe(1);
  });
  it('the row holds the two actions: New test (also in the header) and Import from Excel', async () => {
    const root = shown(await open('tests'));
    const t = tableOf(root);
    expectCreateTwice(root, t, /^new test$/i);
    const imp = within(t).queryAllByRole('button', { name: /import from excel/i }).concat(within(t).queryAllByRole('link', { name: /import from excel/i }));
    expect(imp.length, '"Import from Excel" inside the message row').toBeGreaterThanOrEqual(1);
    expect(messageRow(t)!.contains(imp[0]!)).toBe(true);
  });
  it('Import from Excel opens the import screen (/catalog/imports)', async () => {
    const root = shown(await open('tests'));
    const el = within(messageRow(tableOf(root))!).getByRole(within(messageRow(tableOf(root))!).queryByRole('link', { name: /import from excel/i }) ? 'link' : 'button', { name: /import from excel/i });
    let target = el instanceof HTMLAnchorElement ? el.getAttribute('href') : null;
    if (!target) {
      await userEvent.click(el);
      await waitFor(() => expect(TM.push.mock.calls.length).toBeGreaterThan(0));
      target = String(TM.push.mock.calls.at(-1)![0]);
    }
    expect(new URL(target!, 'http://x.test').pathname).toBe('/catalog/imports');
  });
  it('New test in the empty row opens the New test dialog even though there is no department or specimen type to choose', async () => {
    const root = shown(await open('tests'));
    await userEvent.click(within(messageRow(tableOf(root))!).getByRole('button', { name: /^new test$/i }));
    expect(await screen.findByRole('dialog', { name: /new test/i })).toBeTruthy();
  });
  it('a read-only user sees the headers and the message but no enabled New test / Import from Excel', async () => {
    const root = shown(await open('tests', '', READ));
    const t = tableOf(root);
    expectEmptyTable(t, /no test details yet/i);
    for (const b of within(root).queryAllByRole('button', { name: /^new test$|import from excel/i })) expect(b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true', `${b.textContent} must be disabled`).toBe(true);
    expect(within(root).queryAllByRole('link', { name: /import from excel/i })).toHaveLength(0);
  });
  it('a failing secondary list does not hide the empty table (headers, message and actions stay)', async () => {
    API.fail.set(P.departments, 500);
    const root = shown(await open('tests'));
    expectEmptyTable(tableOf(root), /no test details yet/i);
    expect(within(tableOf(root)).getAllByRole('button', { name: /^new test$/i }).length).toBeGreaterThanOrEqual(1);
    expect(warnings(root)).toHaveLength(1);
  });
  it('the other three views also draw their empty tables', async () => {
    let root = shown(await open('tests', 'view=categories'));
    expect(headersOf(tableOf(root))).toEqual(['Name', 'Department', 'Display order', 'Print footer', 'Footer text', 'Status']);
    expect(root.textContent).toMatch(/no test categories yet/i);
    cleanup();
    root = shown(await open('tests', 'view=popular'));
    expect(headersOf(tableOf(root))).toEqual(['Code', 'Name', 'Short name']);
    expect(root.textContent).toMatch(/no popular tests yet/i);
    cleanup();
    root = shown(await open('tests', 'view=details'));
    expect(tablesOf(root).map((t) => headersOf(t))).toEqual([['Test', 'Code'], ['Name', 'Sub heading', 'Short name']]);
    expect(root.textContent).toMatch(/no tests yet/i);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- (1)+(3) each call failing alone
describe('each of the four API calls failing alone, per view (done_when 1 and 3)', () => {
  const ALL = [P.tests, P.departments, P.specimens, P.categories];
  for (const [view, search] of VIEWS) {
    describe(`view ${view}`, () => {
      for (const path of ALL) {
        for (const f of FAILS) {
          const main = path === MAIN[view];
          const secondary = SECONDARY[view].includes(path);
          const label = main ? `MAIN list ${path} -> ${f === 403 ? 'no access page' : 'PageError in the page'}` : secondary ? `secondary ${path} -> page + inline warning` : `${path} (not needed by this view) -> page renders`;
          it(`${failName(f)}: ${label}`, async () => {
            API.fail.set(path, f);
            const o = await open('tests', search);
            if (main) {
              if (f === 403) return forbidden(o);
              return pageError(o, 'Test Details', true);
            }
            const root = shown(o);
            expect(within(root).getByRole('tablist', { name: /test management/i })).toBeTruthy();
            const w = warnings(root);
            if (secondary) {
              expect(w, `one warning naming the list: ${w.join(' / ')}`).toHaveLength(1);
              expect(w[0]).toMatch(NAME[path as keyof typeof NAME]);
              expect(w[0]).not.toMatch(LEAK);
            }
          });
        }
      }
    });
  }

  it('list view: every secondary list down at once still renders the table, three warnings, no throw', async () => {
    API.data[P.tests] = [HB, CBC];
    for (const p of SECONDARY.list) API.fail.set(p, 500);
    const root = shown(await open('tests'));
    expect(within(tableOf(root)).getByText('Hemoglobin')).toBeTruthy();
    expect(warnings(root)).toHaveLength(3);
  });
  it('list view with tests and the departments list down: rows still render, the department column falls back to the department code, only departments is warned', async () => {
    API.data[P.tests] = [HB, CBC];
    API.fail.set(P.departments, 500);
    const root = shown(await open('tests'));
    const row = within(tableOf(root)).getByText('Hemoglobin').closest('tr')!;
    expect(row.textContent).toContain('HAEM');
    const w = warnings(root);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/department/i);
  });
  it('categories view with categories and the departments list down: rows render with an empty Department cell', async () => {
    API.data[P.categories] = [CAT];
    API.fail.set(P.departments, 500);
    const root = shown(await open('tests', 'view=categories'));
    expect(within(tableOf(root)).getByText('Routine haematology')).toBeTruthy();
    expect(warnings(root)).toHaveLength(1);
  });
  it('no warning appears when every list answers', async () => {
    API.data = { [P.tests]: [HB], [P.departments]: [HAEM], [P.specimens]: [EDTA], [P.categories]: [CAT] };
    for (const [, search] of VIEWS) {
      const root = shown(await open('tests', search));
      expect(warnings(root), search).toEqual([]);
      cleanup();
    }
  });
  it('popular view with tests whose detail read answers renders (the N+1 detail reads stay inside the main list decision)', async () => {
    API.data[P.tests] = [HB, CBC];
    const root = shown(await open('tests', 'view=popular'));
    expect(within(tableOf(root)).getByText('Hemoglobin')).toBeTruthy();
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- permissions / leaks
describe('security (07-SECURITY): permissions and error leaks', () => {
  it.each(VIEWS)('view %s without catalog.test.read shows the no-access text and calls NO API', async (_v, search) => {
    const root = shown(await open('tests', search, []));
    expect(root.textContent).toMatch(noAccessText());
    expect(API.calls).toEqual([]);
  });
  it('a secondary list that fails with 403 is not shown as "no access" for the whole page', async () => {
    API.fail.set(P.specimens, 403);
    const root = shown(await open('tests'));
    expect(within(root).queryByRole('heading', { name: /don.t have access/i })).toBeNull();
    expect(tableOf(root)).toBeTruthy();
  });
  it('the inline warning never carries the API error code, the status or a stack', async () => {
    for (const f of FAILS) {
      API.fail.set(P.categories, f);
      API.fail.set(P.departments, f);
      const root = shown(await open('tests'));
      for (const w of warnings(root)) expect(w).not.toMatch(LEAK);
      expect(root.innerHTML).not.toMatch(/urn:lims|common\.internal|ApiError/);
      cleanup();
    }
  });
  it('a read-only user still gets only reads: no mutating request leaves the page render', async () => {
    shown(await open('tests', '', READ));
    expect(API.calls.filter((c) => !c.startsWith('GET '))).toEqual([]);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- (5) the five other screens
const SCREENS: { route: Route; main: string; label: string; others: string[]; optional?: { path: string; name: RegExp } }[] = [
  { route: 'departments', main: P.departments, label: 'Departments', others: [] },
  { route: 'specimens', main: P.specimens, label: 'Specimen types & containers', others: ['/v1/catalog/containers'] },
  { route: 'units', main: '/v1/catalog/units', label: 'Units & value sets', others: ['/v1/catalog/value-sets'] },
  { route: 'methods', main: '/v1/catalog/methods', label: 'Methods', others: [] },
  { route: 'comment-codes', main: '/v1/catalog/comment-codes', label: 'Comment codes', others: [P.departments], optional: { path: P.departments, name: /department/i } },
];

describe.each(SCREENS)('/catalog/$route (done_when 5)', ({ route, main, others, optional }) => {
  for (const shape of ['paged', 'bare', 'nullpage'] as const) {
    it(`empty (page key: ${shape}): renders its column headers and an empty message row, no crash`, async () => {
      API.shape = shape;
      const root = shown(await open(route));
      const t = tableOf(root);
      expect(headersOf(t).length, headersOf(t).join(' | ')).toBeGreaterThanOrEqual(3);
      expect(messageRow(t), 'an empty message row').toBeTruthy();
      expect(warnings(root)).toEqual([]);
    });
  }
  // LD-353 rule 6 / T0D-UILIST-3: only comment-codes renders PageError in the page; the other four keep the throw (checked: grep PageError app/(staff)/catalog/<route>/page.tsx).
  it(`${main} failing (500): ${route === 'comment-codes' ? 'PageError in the page (title, message, Retry)' : 'the page throws the ApiError (error.tsx)'}`, async () => {
    API.fail.set(main, 500);
    const o = await open(route);
    if (route === 'comment-codes') return pageError(o, 'Notes', false);
    apiError(o, 500);
  });
  it(`${main} failing (network error): ${route === 'comment-codes' ? 'PageError in the page (title, message, Retry)' : 'the page throws'}`, async () => {
    API.fail.set(main, 'network');
    const o = await open(route);
    if (route === 'comment-codes') return pageError(o, 'Notes', false);
    expect(o.ok).toBe(false);
  });
  it(`${main} answering 403: the "no access" page`, async () => {
    API.fail.set(main, 403);
    forbidden(await open(route));
  });
  for (const path of others) {
    for (const f of FAILS) {
      it(`${path} failing (${failName(f)}): renders, or throws the ApiError; never a TypeError`, async () => {
        API.fail.set(path, f);
        const o = await open(route);
        if (o.ok) {
          if (optional) expect(warnings(o.root)).toHaveLength(1);
          return;
        }
        if (optional) throw new Error(`${path} only feeds a dropdown here: it must be optional (warning, no crash). ${String(o.error)}`);
        if (f === 'network') return;
        expect(o.error, String(o.error)).toBeInstanceOf(ApiError);
      });
    }
  }
  if (optional) {
    it(`${optional.path} is optional: 500 renders the list and ONE warning naming it`, async () => {
      API.data['/v1/catalog/comment-codes'] = [];
      API.fail.set(optional.path, 500);
      const root = shown(await open(route));
      const w = warnings(root);
      expect(w).toHaveLength(1);
      expect(w[0]).toMatch(optional.name);
      expect(w[0]).not.toMatch(LEAK);
      expect(headersOf(tableOf(root)).length).toBeGreaterThanOrEqual(3);
    });
  }
});
