// T0D-UISCAN-1 shared helpers (tester-owned; not a test file). LD-353 template 3 SCAN, read from the DOM only.
// DOM contract (kit ScanPanel, T0D-UIKIT-1): div.lims-scan-panel > div.lims-scan-input (the one scan input), div.lims-scan-result[role=status] (only after a scan), div.lims-scan-queue (the queue table).
import { expect } from 'vitest';
import { filterBars, h1s, headerCells, menuLabel, norm } from '@/features/catalog/__tests__/uilist3.helpers';

export { filterBars, h1s, headerCells, menuLabel, norm };

export const panel = (root: ParentNode) => root.querySelector<HTMLElement>('.lims-scan-panel');
export const resultCard = (root: ParentNode) => root.querySelector<HTMLElement>('.lims-scan-result');
export const queue = (root: ParentNode) => root.querySelector<HTMLElement>('.lims-scan-queue');
const queueHeads = (root: ParentNode) => [...(queue(root)?.querySelectorAll('thead th, [role="columnheader"]') ?? [])].map((h) => norm(h.textContent));

/**
 * Template 3 SCAN for one rendered screen:
 *  - exactly one ScanPanel and one scan input, the input inside `.lims-scan-input` (kit.css: at most 28rem, light focus ring);
 *  - the scan input is the first child of the panel; the result card (when shown) comes before the queue;
 *  - with `queue`: the queue table sits in `.lims-scan-queue`, inside the kit scroll box, its header row is drawn also when empty;
 *  - with `title`: exactly one h1 and it equals the menu label; at most one FilterBar; no exclamation marks, no development copy.
 */
export function expectScanScreen(container: HTMLElement, opts: { title?: string; headers?: string[]; queue?: boolean; filterBar?: 1 | 'optional' }): void {
  expect(container.querySelectorAll('.lims-scan-panel'), 'exactly one ScanPanel').toHaveLength(1);
  const p = panel(container)!;
  expect(p.querySelectorAll('.lims-scan-input'), 'one scan input box').toHaveLength(1);
  expect(p.querySelectorAll('.lims-scan-input input[type="text"], .lims-scan-input input:not([type])').length, 'a text input in the scan box').toBeGreaterThan(0);
  expect(p.firstElementChild?.classList.contains('lims-scan-input'), 'the scan input comes first').toBe(true);
  const kids = [...p.children].map((c) => [...c.classList].find((x) => x.startsWith('lims-scan-')));
  const r = kids.indexOf('lims-scan-result');
  const q = kids.indexOf('lims-scan-queue');
  if (r >= 0 && q >= 0) expect(r, 'result card before the queue').toBeLessThan(q);
  if (opts.queue !== false) {
    expect(q, 'the queue sits in the panel').toBeGreaterThan(-1);
    const heads = queueHeads(container);
    expect(heads.length, 'queue header row is present, also when empty').toBeGreaterThan(0);
    for (const h of opts.headers ?? []) expect(heads, `queue column "${h}"`).toContain(h);
    expect(queue(container)!.querySelector('.lims-table-scroll table, .lims-table-scroll [role="grid"]'), 'queue table in the kit scroll box').toBeTruthy();
  }
  if (opts.title !== undefined) expect(h1s(container), 'one h1 = the menu label').toEqual([menuLabel(opts.title)]);
  const bars = filterBars(container);
  if (opts.filterBar === 1) expect(bars, 'exactly one FilterBar').toHaveLength(1);
  else expect(bars.length, 'at most one FilterBar').toBeLessThanOrEqual(1);
  const text = norm(container.textContent);
  expect(text, 'no exclamation marks').not.toMatch(/!/);
  expect(text, 'no development notes').not.toMatch(/\b(TODO|FIXME|lorem|WIP|placeholder|not implemented|T0D-|T-\d{2}\b|CR-C\d)/i);
}

/** The filter pills of a FilterBar: the innermost option, radio, tab, checkbox, button-like chip elements (never the Reset button). */
export function pills(root: ParentNode): HTMLElement[] {
  const bar = filterBars(root)[0];
  if (!bar) return [];
  const all = [...bar.querySelectorAll<HTMLElement>('[role="option"], [role="radio"], [role="tab"], [role="checkbox"], [role="menuitemradio"], .lims-chip')];
  return all.filter((e) => !all.some((o) => o !== e && e.contains(o)));
}
export const pillTexts = (root: ParentNode) => pills(root).map((e) => norm(e.textContent));
export const pill = (root: ParentNode, name: string): HTMLElement => {
  const hit = pills(root).find((e) => new RegExp(`^${name}\\b`).test(norm(e.textContent)));
  if (!hit) throw new Error(`no filter pill "${name}" in ${JSON.stringify(pillTexts(root))}`);
  return hit;
};
