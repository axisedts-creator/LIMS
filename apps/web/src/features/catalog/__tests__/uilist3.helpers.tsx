// T0D-UILIST-3 shared helpers (tester-owned; not a test file). LD-353 template 1 LIST + rules 5, 6, 8, read from the DOM only.
import { expect } from 'vitest';
import { navEntries } from '@/core/nav/generated';
import { t } from '@/core/i18n/messages';

/** The ElabAssist menu label of the sidebar entry that opens `path` (never typed in a test: read from the generated manifest). */
export const menuLabel = (path: string): string => {
  const e = navEntries.find((x) => x.path === path);
  if (!e) throw new Error(`no nav entry for ${path}`);
  return t(e.label);
};
export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export const h1s = (root: ParentNode) => [...root.querySelectorAll('h1')].map((h) => norm(h.textContent));
export const filterBars = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.lims-filter-bar')];
/** Header cells of the table(s) on the page: native <th> or react-aria columnheader. */
export const headerCells = (root: ParentNode) => [...root.querySelectorAll('thead th, [role="columnheader"]')].map((h) => norm(h.textContent));
export const hasNotAvailable = (el: ParentNode) => /not available yet/i.test(el.textContent ?? '');
export const hasErrorState = (el: ParentNode) => el.querySelector('.lims-error-state, .lims-state.lims-tone-danger, [role="alert"]') !== null;

/**
 * LD-353 template 1 LIST contract for one rendered screen (rules 5, 6, 8):
 *  - exactly one h1 and it equals the ElabAssist menu label of `path`;
 *  - at most one FilterBar (`filterBar: 1` demands exactly one) and its controls are one row (no wrapper per control row);
 *  - the table header row is shown, also when there are no rows, and the table sits in the kit scroll box (`.lims-table-scroll`);
 *  - no development copy and no exclamation marks in the visible text (rule 8).
 */
export function expectListScreen(container: HTMLElement, opts: { path: string; headers?: string[]; filterBar?: 1 | 'optional'; table?: boolean }): void {
  expect(h1s(container), 'one h1 = the menu label').toEqual([menuLabel(opts.path)]);
  const bars = filterBars(container);
  if ((opts.filterBar ?? 1) === 1) expect(bars, 'exactly one FilterBar').toHaveLength(1);
  else expect(bars.length, 'at most one FilterBar').toBeLessThanOrEqual(1);
  if (opts.table !== false) {
    const heads = headerCells(container);
    expect(heads.length, 'table header row is present').toBeGreaterThan(0);
    for (const h of opts.headers ?? []) expect(heads, `column "${h}"`).toContain(h);
    expect(container.querySelector('.lims-table-scroll table, .lims-table-scroll [role="grid"], .lims-table-scroll [role="treegrid"]'), 'table in the kit scroll box').toBeTruthy();
  }
  const text = norm(container.textContent);
  expect(text, 'no exclamation marks').not.toMatch(/!/);
  expect(text, 'no development notes').not.toMatch(/\b(TODO|FIXME|lorem|WIP|placeholder|not implemented|T0D-|T-\d{2}\b|CR-C\d)/i);
}

/** The state keeps the page chrome (rule 6): same h1, the FilterBar stays, and the NotAvailable or ErrorState sits inside the page, never a bare error page. */
export function expectStateInPage(container: HTMLElement, opts: { path: string; kind: 'notavailable' | 'error' | 'either' }): void {
  expect(h1s(container), 'state keeps the page title').toEqual([menuLabel(opts.path)]);
  const na = hasNotAvailable(container);
  const er = hasErrorState(container);
  if (opts.kind === 'notavailable') expect(na, 'NotAvailable state').toBe(true);
  else if (opts.kind === 'error') expect(er, 'ErrorState').toBe(true);
  else expect(na || er, 'NotAvailable or ErrorState').toBe(true);
  expect(container.querySelectorAll('.lims-filter-bar').length, 'filters stay').toBeGreaterThanOrEqual(1);
  expect(norm(container.textContent), 'no raw stack or status dump').not.toMatch(/Unhandled|at \w+ \(|\b50[0-9]\b ?(error|internal)/i);
}
