// T0D-UILIST-2 shared assertions (tester-owned helper, not a test file). LD-353 template 1 LIST, UI rules 3 and 5, done_when (5) (7).
// Re-exports the UILIST-1 page assertions (PageHeader, FilterBar, table header, EmptyState, NotAvailable, ErrorState) and adds the table rules of this task.
import { expect } from 'vitest';
import { HttpResponse } from 'msw';

export * from './uilist1.helpers';

const txt = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const q = (root: ParentNode, sel: string) => [...root.querySelectorAll(sel)];

export const REF = 'req-synthetic-l2';
export const problem = (status: number, code: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: REF }, { status, headers: { 'content-type': 'application/problem+json' } });
export const page = (data: unknown[]) => HttpResponse.json({ data, page: { limit: 50 } });
export const props = { searchParams: Promise.resolve({}), params: Promise.resolve({}) } as never;
export const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
export const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });

const HEAD = 'thead th, [role="columnheader"]';
/** Header cell texts of the first table, in order. */
export const headerTexts = (root: ParentNode) => q(root.querySelector('table') ?? root, HEAD).map(txt);
/** Body rows of the first table (rows without a header cell of their own column header row). */
export const bodyRows = (root: ParentNode) => q(root.querySelector('table') ?? root, 'tbody tr, [role="row"]').filter((r) => !r.closest('thead') && !r.querySelector('[role="columnheader"]') && !r.classList.contains('lims-row-empty') && r.querySelector('td, [role="gridcell"], [role="rowheader"]'));

/** Cells of the column whose header matches `header` (RegExp on the header text), taken from the data rows. */
export function columnCells(root: ParentNode, header: RegExp): { head: Element; cells: Element[] } {
  const table = root.querySelector('table')!;
  const heads = q(table, HEAD);
  const i = heads.findIndex((h) => header.test(txt(h)));
  expect(i, `column ${header} among ${JSON.stringify(heads.map(txt))}`).toBeGreaterThanOrEqual(0);
  const cells = bodyRows(root).map((r) => [...r.children][i]).filter((c): c is Element => !!c);
  return { head: heads[i]!, cells };
}

/** LD-353 rule 3 + done_when (7): a money column has the currency in its header, is right aligned (header and cells) and shows two decimals; the cell never repeats the currency word. */
export function expectMoneyColumn(root: ParentNode, path: string, header: RegExp) {
  const { head, cells } = columnCells(root, header);
  expect(txt(head), `${path}: the currency is in the header of ${header}`).toMatch(/\b(NPR|Rs\.?)\b/);
  expect(head.className, `${path}: header of ${header} right aligned`).toMatch(/align-end/);
  expect(cells.length, `${path}: a data row under ${header}`).toBeGreaterThan(0);
  for (const c of cells) {
    const t = txt(c);
    if (t === '' || t === '—') continue; // an empty or absent amount stays a dash (or nothing)
    expect(c.className, `${path}: money cell "${t}" right aligned`).toMatch(/align-end/);
    expect(t, `${path}: money cell "${t}" shows two decimals and no currency word (the header carries it)`).toMatch(/^[-−]?[\d,]+\.\d{2}$/);
  }
}

/** Rule 5 (title attribute on cut off cells): every plain text cell of the column carries title = its text. */
export function expectCellTitles(root: ParentNode, path: string, header: RegExp) {
  const { cells } = columnCells(root, header);
  const texts = cells.filter((c) => txt(c).length > 0 && txt(c) !== '—' && c.children.length === 0);
  expect(texts.length, `${path}: a text cell under ${header}`).toBeGreaterThan(0);
  for (const c of texts) expect(c.getAttribute('title'), `${path}: cell "${txt(c)}" has title`).toBe(c.textContent);
}

/** done_when (2) + rule 5: more than 8 columns get a column chooser (a "Columns" button of the kit) and a sticky first column. */
export function expectWideTable(root: ParentNode, path: string, minCols: number) {
  const heads = q(root.querySelector('table')!, HEAD);
  expect(heads.length, `${path}: at least ${minCols} columns`).toBeGreaterThanOrEqual(minCols);
  expect(q(root, '.lims-colchooser button').map(txt), `${path}: column chooser above 8 columns`).toContain('Columns');
  expect(heads[0]!.className, `${path}: the first column is sticky`).toMatch(/lims-sticky-first/);
  const first = bodyRows(root)[0]?.children[0];
  if (first) expect(first.className, `${path}: the first cell of a row is sticky too`).toMatch(/lims-sticky-first/);
  expect(heads[0]!.closest('.lims-table-scroll'), `${path}: scrolls inside the table box`).not.toBeNull();
}

/** Controls (label + input/select/button) directly inside the one FilterBar, by visible label text. */
export function filterLabels(root: ParentNode): string[] {
  const bar = root.querySelector('.lims-filter-bar');
  return bar ? q(bar, '.lims-label, label, legend').map(txt) : [];
}
export function expectFilterLabels(root: ParentNode, path: string, labels: readonly RegExp[]) {
  const have = filterLabels(root);
  for (const l of labels) expect(have.some((x) => l.test(x)), `${path}: filter "${l}" in the FilterBar, have ${JSON.stringify(have)}`).toBe(true);
}
/** A button of the FilterBar (Reset, Show, Search ...). */
export function expectBarButton(root: ParentNode, path: string, name: RegExp) {
  const bar = root.querySelector('.lims-filter-bar')!;
  expect(q(bar, 'button').map(txt).some((x) => name.test(x)), `${path}: button ${name} inside the FilterBar`).toBe(true);
}
