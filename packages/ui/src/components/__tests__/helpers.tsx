// T0D-12 shared test helpers (tests only). Registers RTL cleanup, jsdom shims, axe runner, fixtures.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';

afterEach(cleanup);

// jsdom gaps that react-aria-components touches
const g = globalThis as any;
g.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.matchMedia ??= (q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
});
if (typeof HTMLElement !== 'undefined') (HTMLElement.prototype as any).scrollIntoView ??= () => {};

export const user = () => userEvent.setup();
/** Synthetic Devanagari (no real patient data). */
export const DEVANAGARI = 'सुनिता श्रेष्ठ — नमस्ते';
export const XSS = [
  '<img src=x onerror=alert(1)>',
  '<script>window.__xss=1</script>',
  '"><svg onload=alert(1)>',
  'javascript:alert(1)',
];

/**
 * critical+serious axe violations over the whole document (portals included).
 * color-contrast is covered by T0D-11 token tests; jsdom cannot compute it.
 */
export async function seriousViolations(root: Element = document.body): Promise<string[]> {
  const r = await axe.run(root, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id} [${v.impact}]: ${v.help} (${v.nodes.length} nodes)`);
}
