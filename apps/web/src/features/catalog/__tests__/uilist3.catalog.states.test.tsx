// @vitest-environment jsdom
// T0D-UILIST-3 (2) catalog tests and comment codes pages, (5) price simulator. LD-353 rules 6 and 8, template 6 ENTRY FORM.
// (2) The server pages are called like Next does and their result rendered: an operation that is not built (501 operation_pending) shows NotAvailable with the
//     menu title and the header row; any other failure (500) must show an ErrorState INSIDE the page with the same title: today it throws to error.tsx.
// (5) The simulator contract (the spec fixes the kit, not the markup; the writer may dispute a name through the ruling flow):
//     form.lims-entry-form holds exactly two `.lims-entry-col` columns (inputs left, context right) and ends with `.lims-entry-footer` holding the submit button;
//     kit.css or catalog.css gives `.lims-entry-footer` position: sticky and `.lims-entry-form` two grid tracks (from 64rem). No FilterBar, one h1 = menu label.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ToastProvider } from '@lims/ui/components/Toast';
import { h1s, headerCells, hasNotAvailable, menuLabel, norm } from '@/features/catalog/__tests__/uilist3.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/catalog',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
const { stub, mode, fail } = vi.hoisted(() => {
  const mode = { v: 'pending' as 'pending' | 'internal' };
  return {
    mode,
    stub: () => new Proxy({}, { has: (_t, k) => typeof k !== 'symbol', get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }),
    /** What the BFF throws: ApiError(status, problem). Duck typed the same way core/shell/NotAvailable isPending reads it. */
    fail: async (): Promise<never> => {
      throw Object.assign(new Error('api'), mode.v === 'pending' ? { status: 501, problem: { code: 'operation_pending', title: 'Pending', status: 501 } } : { status: 500, problem: { code: 'common.internal', title: 'Internal', status: 500 } });
    },
  };
});
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['catalog.test.read', 'catalog.test.manage', 'catalog.price_list.read', 'catalog.price_list.manage'] } }),
  getRequestPathname: async () => '/catalog',
}));
vi.mock('@/features/catalog/server/listCommentCodes.server', () => ({ listCommentCodes: fail }));
vi.mock('@/features/catalog/server/listDepartments.server', () => ({ listDepartments: async () => ({ data: [] }) }));
vi.mock('@/features/catalog/server/listSpecimenTypes.server', () => ({ listSpecimenTypes: async () => ({ data: [] }) }));
vi.mock('@/features/catalog/server/listTests.server', () => ({ listAllTests: fail, testsWithSpecimen: async (x: unknown) => x }));
vi.mock('@/features/catalog/server/testMgmt.server', () => ({ listTestCategories: async () => [], allTestDetails: async () => [] }));
vi.mock('@/features/catalog/server/getTest.server', () => ({ getTest: async () => undefined }));
vi.mock('@/features/catalog/server/actions', stub);
vi.mock('@/features/catalog/server/catalogActions', stub);
vi.mock('@/features/catalog/server/testMgmtActions', stub);
vi.mock('@/features/catalog/server/pricingActions', stub);

import CommentCodesPage from '../../../app/(staff)/catalog/comment-codes/page';
import TestsPage from '../../../app/(staff)/catalog/tests/page';
import { PriceSimulator } from '@/features/catalog/components/PriceSimulator';

afterEach(() => { cleanup(); mode.v = 'pending'; });
const wrap = (el: React.ReactElement) => render(<ToastProvider>{el}</ToastProvider>);
const dangerState = (root: ParentNode) => root.querySelector('.lims-state.lims-tone-danger, .lims-error-state');
const noRaw = (text: string) => expect(text).not.toMatch(/operation_pending|common\.internal|\b50[01]\b|Unhandled|at \w+ \(/);

const PAGES = [
  { name: 'comment codes', path: '/catalog/comment-codes', heads: ['Code', 'Department', 'Text', 'Status', 'Version'], call: () => CommentCodesPage() },
  { name: 'tests', path: '/catalog/tests', heads: ['Code', 'Name', 'Department', 'Status'], call: () => TestsPage({ searchParams: Promise.resolve({}) }) },
] as const;

describe.each(PAGES)('catalog $name page — states stay inside the page (rule 6)', (p) => {
  it('501 operation_pending: NotAvailable, the page title = menu label, the header row stays, no red error', async () => {
    mode.v = 'pending';
    const { container } = wrap((await p.call()) as never);
    expect(h1s(container)).toEqual([menuLabel(p.path)]);
    expect(hasNotAvailable(container)).toBe(true);
    expect(headerCells(container)).toEqual(expect.arrayContaining([...p.heads]));
    expect(dangerState(container), 'a not built operation is not an error').toBeNull();
    noRaw(norm(container.textContent));
  });

  it('500: the page does not throw; ErrorState inside the page keeps the title and shows no raw problem text', async () => {
    mode.v = 'internal';
    const el = await p.call().catch((e: unknown) => { throw new Error(`the page threw to error.tsx (${(e as Error).message}); it must render an ErrorState with the page title`); });
    const { container } = wrap(el as never);
    expect(h1s(container), 'title kept').toEqual([menuLabel(p.path)]);
    expect(dangerState(container), 'ErrorState (kit .lims-state.lims-tone-danger) inside the page').toBeTruthy();
    noRaw(norm(container.textContent));
  });
});

// ---------------------------------------------------------------- price simulator (template 6 ENTRY FORM)
describe('catalog price simulator — entry form (template 6)', () => {
  const mount = () => wrap(<PriceSimulator permissions={['catalog.price_list.read', 'catalog.price_list.manage', 'identity.centre.read']} />);
  const form = (c: HTMLElement) => c.querySelector<HTMLElement>('.lims-entry-form');

  it('h1 = menu label, no FilterBar, one form', () => {
    const { container } = mount();
    expect(h1s(container)).toEqual([menuLabel('/catalog/price-simulator')]);
    expect(container.querySelectorAll('.lims-filter-bar')).toHaveLength(0);
    expect(container.querySelectorAll('form')).toHaveLength(1);
  });

  it('the form is `.lims-entry-form` with exactly two `.lims-entry-col` columns that together hold every field', () => {
    const { container } = mount();
    const f = form(container);
    expect(f, 'an element with class lims-entry-form').toBeTruthy();
    const cols = [...f!.querySelectorAll<HTMLElement>('.lims-entry-col')];
    expect(cols, 'two columns').toHaveLength(2);
    const fields = [...f!.querySelectorAll('input, select, [role="combobox"], [role="radiogroup"], [role="group"]')];
    expect(fields.length).toBeGreaterThan(3);
    for (const x of fields) expect(cols.some((c) => c.contains(x)), 'every field sits in a column').toBe(true);
    expect(cols[0]!.querySelectorAll('input, [role="combobox"]').length, 'left column not empty').toBeGreaterThan(0);
    expect(cols[1]!.querySelectorAll('input, [role="combobox"], [role="radiogroup"], [role="group"]').length, 'right column not empty').toBeGreaterThan(0);
  });

  it('the footer `.lims-entry-footer` is the last child of the form, comes after both columns and holds the one submit button "Get price"', () => {
    const { container } = mount();
    const f = form(container)!;
    const foot = f.querySelector<HTMLElement>('.lims-entry-footer');
    expect(foot, 'an element with class lims-entry-footer').toBeTruthy();
    expect(f.lastElementChild).toBe(foot);
    for (const c of f.querySelectorAll('.lims-entry-col')) expect(c.compareDocumentPosition(foot!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const submit = [...foot!.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.type === 'submit');
    expect(submit).toHaveLength(1);
    expect(norm(submit[0]!.textContent)).toBe('Get price');
    expect(f.querySelectorAll('button[type="submit"]'), 'the only submit button of the form').toHaveLength(1);
  });

  it('css: `.lims-entry-footer` is sticky at the bottom and `.lims-entry-form` has two grid tracks (kit.css or catalog.css, tokens only)', () => {
    const css = ['../../../../../../packages/ui/src/components/kit.css', '../components/catalog.css']
      .map((rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')).join('\n');
    const rule = (sel: string) => [...css.matchAll(new RegExp(`${sel.replace('.', '\\.')}\\b[^{}]*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(';');
    const foot = rule('.lims-entry-footer');
    expect(foot, 'position: sticky').toMatch(/position:\s*sticky/);
    expect(foot, 'bottom is set (0 or a token)').toMatch(/bottom:\s*(0(px|rem)?|var\([^)]+\))/);
    const grid = rule('.lims-entry-form');
    expect(grid, 'two tracks').toMatch(/grid-template-columns:\s*(repeat\(\s*2\s*,|[^;]+\s[^;]+)/);
  });
});
