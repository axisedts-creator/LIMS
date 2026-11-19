// T0D-UILIST-1 shared assertions (tester-owned helper, not a test file). LD-353 template 1 LIST, UI rules 5, 6, 8.
// Each group test renders a page twice (no rows, one row) and calls these. Everything is read from the DOM the kit draws:
//   PageHeader        -> one `.lims-page-header`, one h1 (`.lims-page-title`), primary action inside `.lims-page-actions` (the Help button there is not an action)
//   FilterBar         -> `.lims-filter-bar` (role=search); a screen with filters has exactly ONE
//   DataTable / table -> `table` inside `.lims-table-scroll` (kit DataTable and NotAvailable `columns` both draw it), header cells `th`/columnheader, always, also when empty
//   EmptyState        -> `.lims-state` with `.lims-state-title`, optional `.lims-state-body`, at most ONE button
//   ErrorState        -> `.lims-state.lims-tone-danger` + Retry button + Reference line; the h1 stays
//   NotAvailable      -> `.lims-state` titled "Not available yet", no role=alert, the h1 stays
import { expect } from 'vitest';
import { navEntries } from '@/core/nav/generated';
import { t } from '@/core/i18n/messages';

/** The ElabAssist menu label of a route (LD-353 rule 8: the page title equals the menu name). */
export function menuLabel(path: string): string {
  const e = navEntries.find((n) => n.path === path);
  if (!e) throw new Error(`no sidebar entry for ${path}`);
  return t(e.label);
}

const txt = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const q = (root: ParentNode, sel: string) => [...root.querySelectorAll(sel)];

/** Visible buttons/links of the header action area, without the Help control every PageHeader draws. */
export function headerActions(root: ParentNode): string[] {
  return q(root, '.lims-page-header .lims-page-actions button, .lims-page-header .lims-page-actions a')
    .filter((el) => !el.closest('[data-help-key]'))
    .map((el) => txt(el));
}

/** (1) PageHeader with the menu title; the one primary action at right, drawn once on the whole page (not again in the empty state). */
export function expectHeader(root: ParentNode, path: string, o: { action?: string | RegExp; noAction?: boolean } = {}) {
  const h1 = q(root, 'h1');
  expect(h1.map(txt), `${path}: exactly one h1 and it is the menu label`).toEqual([menuLabel(path)]);
  expect(q(root, '.lims-page-header').length, `${path}: the title comes from one PageHeader`).toBe(1);
  expect(h1[0]!.closest('.lims-page-header'), `${path}: the h1 sits inside the PageHeader`).not.toBeNull();
  const acts = headerActions(root);
  if (o.noAction) expect(acts, `${path}: no primary action in the header`).toEqual([]);
  if (o.action) {
    const hit = acts.filter((a) => (typeof o.action === 'string' ? a === o.action : (o.action as RegExp).test(a)));
    expect(hit.length, `${path}: the primary action "${String(o.action)}" is in the header at right, found ${JSON.stringify(acts)}`).toBe(1);
    const everywhere = q(root, 'button, a').filter((el) => (typeof o.action === 'string' ? txt(el) === o.action : (o.action as RegExp).test(txt(el))));
    expect(everywhere.length, `${path}: "${String(o.action)}" appears once on the page (header only, not again in the body or empty state)`).toBe(1);
  }
}

/** (2) Exactly n FilterBar (one row). 0 means the screen has no filters and must not draw a bar. */
export function expectFilterBars(root: ParentNode, path: string, n: number) {
  expect(q(root, '.lims-filter-bar').length, `${path}: FilterBar count`).toBe(n);
  expect(q(root, '[role="search"]').length, `${path}: no second search row next to the FilterBar`).toBeLessThanOrEqual(Math.max(n, 0) + 0);
}

/** (7) Rule 5: the table is drawn with its header row (also when empty), inside the scroll box. `min` = least header cells. */
export function expectTable(root: ParentNode, path: string, o: { min?: number; headers?: readonly (string | RegExp)[] } = {}) {
  const tables = q(root, 'table');
  expect(tables.length, `${path}: a table is drawn`).toBeGreaterThanOrEqual(1);
  const table = tables[0]!;
  expect(table.closest('.lims-table-scroll'), `${path}: the table scrolls inside its own box (.lims-table-scroll), never the page`).not.toBeNull();
  const heads = q(table, 'thead th, [role="columnheader"]').map(txt).filter(Boolean);
  expect(heads.length, `${path}: header row is shown (${JSON.stringify(heads)})`).toBeGreaterThanOrEqual(o.min ?? 2);
  for (const h of o.headers ?? []) {
    expect(heads.some((x) => (typeof h === 'string' ? x.toLowerCase() === h.toLowerCase() : h.test(x))), `${path}: column "${String(h)}" in ${JSON.stringify(heads)}`).toBe(true);
  }
  return { table, heads };
}

/** (6) EmptyState: a title, one hint line at most, at most one button. Drawn inside the table body when a table exists. */
export function expectEmptyState(root: ParentNode, path: string, o: { title?: string | RegExp; inTable?: boolean } = {}) {
  const states = q(root, '.lims-state:not(.lims-tone-danger)');
  expect(states.length, `${path}: one EmptyState`).toBe(1);
  const s = states[0]!;
  const title = txt(s.querySelector('.lims-state-title'));
  expect(title.length, `${path}: empty title`).toBeGreaterThan(0);
  if (o.title) expect(title, `${path}: empty title text`).toMatch(o.title instanceof RegExp ? o.title : new RegExp(`^${o.title}$`, 'i'));
  expect(q(s, '.lims-state-body, p').filter((p) => !p.classList.contains('lims-state-title')).length, `${path}: at most one hint line`).toBeLessThanOrEqual(1);
  expect(q(s, 'button, a').length, `${path}: at most one button in the EmptyState`).toBeLessThanOrEqual(1);
  expect(s.closest('[role="alert"]'), `${path}: an empty list is not an alert`).toBeNull();
  if (o.inTable !== false && root.querySelector('table')) expect(s.closest('tbody, [role="rowgroup"]'), `${path}: the EmptyState sits in the table body, under the header row`).not.toBeNull();
}

/** No stand-in text rows or loose paragraphs instead of the EmptyState (the old "No x." <p> or EmptyRow text). */
export function expectNoLooseEmptyText(root: ParentNode, path: string, re: RegExp) {
  const loose = q(root, 'p, td, span, div').filter((el) => el.children.length === 0 && re.test(txt(el)) && !el.closest('.lims-state'));
  expect(loose.map(txt), `${path}: empty text belongs in the EmptyState, found loose ${JSON.stringify(loose.map(txt))}`).toEqual([]);
}

/** (6) API 501 operation_pending: the page keeps its title, shows "Not available yet", no red alert; list screens keep the header row. */
export function expectNotAvailable(root: ParentNode, path: string, o: { table?: boolean } = {}) {
  expect(q(root, 'h1').map(txt), `${path}: the title stays`).toEqual([menuLabel(path)]);
  expect(txt(root as Element), `${path}: not available yet`).toMatch(/not available yet/i);
  expect(q(root, '[role="alert"]').length, `${path}: no red alert`).toBe(0);
  expect(q(root, '.lims-tone-danger').length, `${path}: no danger tone`).toBe(0);
  expect(txt(root as Element)).not.toMatch(/something went wrong/i);
  if (o.table) expectTable(root, path);
}

/** (3) (6) A failed read: the page keeps its title (and, when given, its filters), ErrorState shows message + reference + Retry. */
export function expectErrorState(root: ParentNode, path: string, o: { filters?: number; slim?: boolean } = {}) {
  expect(q(root, 'h1').map(txt), `${path}: the title stays on error`).toEqual([menuLabel(path)]);
  const err = q(root, '.lims-state.lims-tone-danger');
  expect(err.length, `${path}: one ErrorState`).toBe(1);
  expect(txt(err[0]!.querySelector('.lims-state-ref')), `${path}: reference shown`).toMatch(/reference/i);
  expect(q(err[0]!, 'button').map(txt), `${path}: Retry`).toContain('Retry');
  expect(txt(root as Element)).not.toMatch(/something went wrong/i);
  if (o.filters !== undefined) expect(q(root, '.lims-filter-bar').length, `${path}: filters stay on error`).toBe(o.filters);
}
