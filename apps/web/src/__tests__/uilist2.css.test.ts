// T0D-UILIST-2 (LD-353 rule 5, done_when 4 "headers on one line"): a table header cell never wraps. The rule lives in the kit (packages/ui kit.css) or the billing css and uses tokens only
// (web-style-3 checks the "no px, hex, rgb, url" part of the added css: run its config too). No header line break is possible in jsdom, so the CSS VALUE is pinned.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const web = fileURLToPath(new URL('../../', import.meta.url));
const read = (...p: string[]) => readFileSync(join(web, ...p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const kit = read('..', '..', 'packages', 'ui', 'src', 'components', 'kit.css');
const billing = read('src', 'features', 'billing', 'components', 'billing.css');

function rulesOf(css: string) {
  const out: { selectors: string[]; body: string }[] = [];
  for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) out.push({ selectors: m[1]!.split(',').map((s) => s.trim()), body: m[2]! });
  return out;
}

describe('table header cells stay on one line', () => {
  it('a kit or billing rule on th / .lims-col sets white-space: nowrap', () => {
    const hit = [...rulesOf(kit), ...rulesOf(billing)].filter((r) => r.selectors.some((s) => /(^|[\s>])th\b|\.lims-col\b(?!-)|columnheader/.test(s)) && /white-space\s*:\s*nowrap/.test(r.body));
    expect(hit.length, 'th / .lims-col with white-space: nowrap').toBeGreaterThan(0);
  });
});
