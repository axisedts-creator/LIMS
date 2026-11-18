// T0D-UIDASH-1 shared helpers (tester-owned; not a test file). LD-353 template 5 REPORT contracts, read from the DOM only.
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
export const stats = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.lims-stat')];
export const statLabels = (root: ParentNode) => stats(root).map((s) => norm(s.querySelector('.lims-stat-label')?.textContent));
export const statOf = (root: ParentNode, label: string) => stats(root).find((s) => norm(s.querySelector('.lims-stat-label')?.textContent) === label);
export const cards = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.lims-chart-card')];
export const cardTitled = (root: ParentNode, title: string) => cards(root).find((c) => norm(c.querySelector('.lims-chart-card-title')?.textContent) === title);
export const filterBars = (root: ParentNode) => [...root.querySelectorAll('.lims-filter-bar')];
/** Header cells of the table(s) on the page: native <th> or react-aria columnheader. */
export const headerCells = (root: ParentNode) => [...root.querySelectorAll('thead th, [role="columnheader"]')].map((h) => norm(h.textContent));
/** Both stat tiles of a row share one parent that holds only tiles (LD-353 template 5: a row of equal tiles). */
export function oneTileRow(root: ParentNode): boolean {
  const tiles = stats(root);
  const parents = new Set(tiles.map((x) => x.parentElement));
  return tiles.length > 0 && parents.size === 1 && [...[...parents][0]!.children].every((c) => tiles.includes(c as HTMLElement));
}
/** category -> value text, read from the kit chart's hidden data table (BarChart / TimeSeriesChart carry the same numbers, CV §14). */
export const chartRows = (card: ParentNode) => new Map([...card.querySelectorAll('table tbody tr')].map((tr) => [norm(tr.querySelector('th')?.textContent), norm(tr.querySelector('td')?.textContent)] as const));
export const num = (s: string | undefined) => Number((s ?? '').replace(/[^0-9.\-]/g, ''));
export const hasNotAvailable = (el: ParentNode) => /not available yet/i.test(el.textContent ?? '');
