// T0D-UIDASH-1 test helpers (tester-owned, not a test file). LD-353 rules 5, 6, 8, 10 and templates 1 / 5 as DOM checks that run in jsdom.
// Kit classes read here are the ones the T0D-UIKIT-1 parts draw: .lims-page-title (h1), .lims-filter-bar, .lims-stat(-row), .lims-chart-card/-frame/-empty,
// .lims-data-table / .lims-table, .lims-state (EmptyState / NotAvailable / ErrorState).
export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** The single page title. LD-353 rule 8: it equals the menu label. */
export const titles = (root: ParentNode) => [...root.querySelectorAll('h1')].map((h) => norm(h.textContent));

/** FilterBars as the kit draws them (role="search" .lims-filter-bar). The old status board used a role="group" .lims-filter-bar: it counts too. */
export const filterBars = (root: ParentNode) => [...root.querySelectorAll('.lims-filter-bar')];

/** Header cells of every table on the page (native th in thead, or react-aria columnheader). */
export const headerCells = (root: ParentNode) =>
  [...root.querySelectorAll('thead th, [role="columnheader"]')].filter((h) => !h.closest('.lims-chart-card')).map((h) => norm(h.textContent));

/** The page's data tables: the kit charts carry a hidden data table (CV 14) that is NOT one of them. */
export const dataTables = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('table, [role="grid"]')].filter((t) => !t.closest('.lims-chart-card'));
/** Value cell text of the chart's hidden data table for one category (BarChart: th scope=row = category, td = value). */
export const barValue = (card: Element, category: string | RegExp) => {
  const th = [...card.querySelectorAll('tbody th[scope="row"]')].find((h) => (typeof category === 'string' ? norm(h.textContent) === category : category.test(norm(h.textContent))));
  return th ? norm(th.parentElement?.querySelector('td')?.textContent) : undefined;
};

export const tiles = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.lims-stat')];
export const tileLabel = (t: Element) => norm(t.querySelector('.lims-stat-label')?.textContent);
export const tileValue = (t: Element) => norm(t.querySelector('.lims-stat-value')?.textContent);
export const tileRows = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.lims-stat-row')];

export const cards = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.lims-chart-card')];
export const cardTitle = (c: Element) => norm(c.querySelector('.lims-chart-card-title')?.textContent);
export const cardByTitle = (root: ParentNode, title: string | RegExp) =>
  cards(root).find((c) => (typeof title === 'string' ? cardTitle(c) === title : title.test(cardTitle(c))));
/** LD-353 rule 10: the frame ALWAYS draws something other than the "No data yet" line. */
export const frameDraws = (c: Element) => !!c.querySelector('.lims-chart-frame > :not(.lims-chart-empty)');
export const frameSaysNoData = (c: Element) => /^no data yet$/i.test(norm(c.querySelector('.lims-chart-empty')?.textContent));
/** NotAvailable inside a ChartCard (done_when 7): the calm state text, no alert. */
export const cardNotAvailable = (c: Element) => /not available yet/i.test(norm(c.textContent)) && !c.querySelector('[role="alert"]');

/** LD-353 rule 6: no red error page for an operation that is not built yet. */
export const hasAlert = (root: ParentNode) => !!root.querySelector('[role="alert"]');
