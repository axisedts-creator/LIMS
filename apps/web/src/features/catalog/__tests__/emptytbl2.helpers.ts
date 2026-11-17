// T0D-EMPTYTBL-2 shared assertions (tester-owned). Same contract as emptytbl1.screens.test.tsx (T0D-EMPTYTBL-1, LD-310, LD-336), applied to one table at a time
// because several of the 11 screens hold two tables (AppAccess, InstrumentMappings, TaxScreen tabs).
import { expect } from 'vitest';
import { within } from '@testing-library/react';

export const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable]';
const TABLE = 'table, [role="grid"], [role="table"]';

/** Every table / kit grid under root, outermost only, in document order. */
export const tablesOf = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(TABLE)].filter((t) => !t.parentElement?.closest(TABLE));

export function tableOf(root: HTMLElement, index = 0): HTMLElement {
  const t = tablesOf(root)[index];
  if (!t) throw new Error(`no table / grid #${index} rendered: the column headers are hidden when there is no data`);
  return t;
}

export const headersOf = (t: HTMLElement) => [...t.querySelectorAll('th, [role="columnheader"]')].map((h) => (h.textContent ?? '').trim()).filter(Boolean);
export const placeholders = (t: HTMLElement) => [...t.querySelectorAll<HTMLElement>('.lims-row-placeholder')];
/** First visible body row with text: not a header row (th or role=columnheader), not aria-hidden, not a placeholder. */
export const messageRow = (t: HTMLElement) =>
  [...t.querySelectorAll<HTMLElement>('tbody tr, [role="rowgroup"] [role="row"], tr')].find(
    (r) => r.getAttribute('aria-hidden') !== 'true' && !r.closest('[aria-hidden="true"]') && !r.closest('thead') && !r.querySelector('th, [role="columnheader"]') && (r.textContent ?? '').trim() !== '',
  );

/** One empty table: >= 3 real column headers, the message as a body row INSIDE it, then exactly 4 inert placeholder rows below the message. */
export function expectEmptyTable(t: HTMLElement, message: RegExp | null, headers: readonly string[] = []) {
  const heads = headersOf(t);
  expect(heads.length, `column headers: ${heads.join(' | ')}`).toBeGreaterThanOrEqual(3);
  for (const h of headers) expect(heads, `header "${h}" missing`).toContain(h);
  const row = messageRow(t);
  expect(row, 'the empty message must be a row inside the table').toBeTruthy();
  if (message) expect(row!.textContent).toMatch(message);
  const ph = placeholders(t);
  expect(ph, 'four placeholder rows keep the table height').toHaveLength(4);
  for (const p of ph) {
    expect(p.getAttribute('aria-hidden')).toBe('true');
    expect(p.querySelector(FOCUSABLE), 'placeholder rows hold nothing focusable').toBeNull();
    expect(p.matches(FOCUSABLE), 'a placeholder row is not focusable itself').toBe(false);
    expect(t.contains(p)).toBe(true);
    expect(p.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_PRECEDING, 'placeholders come below the message row').toBeTruthy();
  }
}

/** The card form is gone: no EmptyState / lims-state outside every table of the screen. */
export function expectNoCardOutsideTables(root: HTMLElement) {
  const tables = tablesOf(root);
  const outside = [...root.querySelectorAll('.lims-empty-state, .lims-state')].filter((e) => !tables.some((t) => t.contains(e)));
  expect(outside, 'no empty-state card outside the table(s)').toHaveLength(0);
}

/** (create action) once in the page header (outside the table) and repeated inside the message row of `t`. */
export function expectCreateTwice(root: HTMLElement, t: HTMLElement, name: RegExp, role: 'button' | 'link' = 'button') {
  const inRow = within(t).queryAllByRole(role, { name });
  const all = within(root).getAllByRole(role, { name });
  expect(inRow.length, `"${name}" repeated in the message row`).toBeGreaterThanOrEqual(1);
  expect(all.length - inRow.length, `"${name}" stays in the page header`).toBeGreaterThanOrEqual(1);
}

/** Server-action modules are never called by an empty list; every export is an inert stub (`then` stays undefined or the module is awaited forever). */
export const stubModuleFactory = () =>
  new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) });
