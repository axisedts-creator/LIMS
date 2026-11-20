// T0D-UICONSOLE-1 test helpers (tester-owned, not a test file). LD-353 template 2 (CONSOLE) and rules 5, 6, 8 as DOM checks that run in jsdom.
// Kit classes read here are the ones the T0D-UIKIT-1 parts draw: .lims-page-title (h1), .lims-filter-bar, .lims-stat(-row), .lims-state (EmptyState / NotAvailable /
// ErrorState) and SplitConsole: .lims-console > .lims-console-list + .lims-console-detail > .lims-console-body + .lims-console-actions.
// CONSOLE ITEM CONTRACT (the brief names none; the writer follows it or files a dispute): every queue row has ONE focusable element inside `.lims-console-list` that carries
// `data-console-item="<record id>"` (the DTO id; SplitConsole j / k moves focus over these). A click on it, or Enter while it has focus, selects the record: the item or
// its row gets aria-selected="true" and the detail pane shows that record. Nothing is selected before the first click (no auto-select).
import { expect } from 'vitest';
import { fireEvent, within } from '@testing-library/react';

export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export const titles = (root: ParentNode) => [...root.querySelectorAll('h1')].map((h) => norm(h.textContent));
export const filterBars = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.lims-filter-bar')];
export const tileRows = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.lims-stat-row')];
export const tiles = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.lims-stat')];
export const tileLabel = (t: Element) => norm(t.querySelector('.lims-stat-label')?.textContent);
export const tileValue = (t: Element) => norm(t.querySelector('.lims-stat-value')?.textContent);
export const tileMap = (root: ParentNode) => Object.fromEntries(tiles(root).map((t) => [tileLabel(t), tileValue(t)]));

export const consoles = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.lims-console')];
export const listPane = (root: ParentNode) => root.querySelector<HTMLElement>('.lims-console-list');
export const detailPane = (root: ParentNode) => root.querySelector<HTMLElement>('.lims-console-detail');
export const actionBar = (root: ParentNode) => root.querySelector<HTMLElement>('.lims-console-actions');
/** Header cells of the queue list only (native th in thead, or react-aria columnheader). */
export const listHeaders = (root: ParentNode) =>
  [...(listPane(root)?.querySelectorAll('thead th, [role="columnheader"]') ?? [])].map((h) => norm(h.textContent));

export const items = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.lims-console-list [data-console-item]')];
export const itemOf = (root: ParentNode, id: string) => items(root).find((i) => i.getAttribute('data-console-item') === id);
export const isSelected = (el: HTMLElement) => el.getAttribute('aria-selected') === 'true' || !!el.closest('[aria-selected="true"]');
export const selected = (root: ParentNode) => items(root).filter(isSelected);
/** Selects a record by clicking its console item (sync: fireEvent.click is wrapped in act by Testing Library). */
export const pickItem = (root: ParentNode, id: string) => {
  const it = itemOf(root, id);
  expect(it, `console item for ${id}`).toBeTruthy();
  fireEvent.click(it!);
  return detailPane(root)!;
};
/** The actions of the selected record: buttons and links of the sticky bar. */
export const barActions = (root: ParentNode) => [...(actionBar(root)?.querySelectorAll<HTMLElement>('button, a[href]') ?? [])];
export const barButton = (root: ParentNode, name: RegExp) => (actionBar(root) ? within(actionBar(root)!).queryByRole('button', { name }) : null);

/** LD-353 rule 8 / template 2: the History block of the detail = a heading "History"; its parent holds one <li> per event, each starting with the event label. */
export const historyOf = (detail: HTMLElement) => {
  const h = [...detail.querySelectorAll('h2, h3, h4')].find((x) => /^history$/i.test(norm(x.textContent)));
  return h ? { heading: h, events: [...(h.parentElement?.querySelectorAll('li') ?? [])].map((li) => norm(li.textContent)) } : undefined;
};
export const historyLabels = (detail: HTMLElement) => (historyOf(detail)?.events ?? []).map((e) => e.split(/[\s:]/)[0]).sort();

/** The shown form of an age of `min` minutes: hh:mm (the TAT form used everywhere in the product) or, past a day, `2d 2h`. */
export const ageForms = (min: number) => {
  const h = Math.floor(min / 60), m = min % 60, d = Math.floor(h / 24), p = (n: number) => String(n).padStart(2, '0');
  return [`${p(h)}:${p(m)}`, `${h}:${p(m)}`, ...(d ? [`${d}d ${h % 24}h`, `${d} d ${h % 24} h`] : [`${h} h ${m} m`, `${h}h ${m}m`])];
};
export const hasAge = (text: string, min: number) => ageForms(min).some((f) => norm(text).includes(f));

/** The shortcut letter in the label of the first action: "Approve (A)". */
export const shortcutOf = (el: HTMLElement | undefined) => /\(([A-Za-z])\)\s*$/.exec(norm(el?.textContent))?.[1];
