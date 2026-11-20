// T0D-UILIST-3 inventory helpers (tester-owned; not a test file). LD-353 rule 5: cut-off cells carry a title attribute.
import { expect } from 'vitest';
import { norm } from '@/features/catalog/__tests__/uilist3.helpers';

/** Some data cell whose text is `text` exposes it as a title attribute (on the cell or on a descendant), so a clipped value stays readable. */
export function expectCellTitled(container: HTMLElement, text: string): void {
  const cells = [...container.querySelectorAll<HTMLElement>('td, [role="gridcell"]')].filter((c) => norm(c.textContent).includes(text));
  expect(cells.length, `a cell showing "${text}"`).toBeGreaterThan(0);
  const titled = cells.some((c) => [c, ...c.querySelectorAll<HTMLElement>('[title]')].some((e) => (e.getAttribute('title') ?? '').includes(text)));
  expect(titled, `cell "${text}" has a title attribute`).toBe(true);
}
