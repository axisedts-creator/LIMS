// @vitest-environment jsdom
// T0D-UILIST-2 (LD-353 rules 2 and 3, template 6 spirit; done_when 6) — /frontdesk/registrations/new, display only.
// (a) every control of the registration screen is ONE height, 30 px (1.875rem): the 26 px buttons (1.625rem), 28 px inputs and selects (1.75rem) become 30; no rule keeps the old heights;
// (b) one label style in the Billing column: the loose labels ("Balance after payment") and every dt carry the kit label class `lims-label` like the field labels;
// (c) the three columns have equal height: each column card fills its column (flex-grow or height 100%) inside the stretched grid;
// (d) the sticky footer is kept (.lims-reg-summary sticky at bottom 0, outside the three columns).
// jsdom has no layout engine: (a) (c) (d) are read from the CSS VALUES, (b) from the DOM. The existing regscreen2.layout tests stay (30 px ceiling, columns, fold, no hex).
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderForm, setup } from './fd-t13.harness';
import { walk, web } from './rs-c4.signature';

setup();
type Rule = { media: string; selectors: string[]; decls: Record<string, string> };
function parse(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const block = (s: string, from: number): number => { let d = 0; for (let i = from; i < s.length; i++) { if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) return i; } return s.length; };
  const decls = (body: string) => Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const i = d.indexOf(':'); return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).replace(/!important/i, '').trim()]; }));
  const run = (s: string, media: string) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open < 0) break;
      const head = s.slice(i, open).trim();
      const close = block(s, open);
      const body = s.slice(open + 1, close);
      if (head.startsWith('@media')) run(body, head.slice(6).trim());
      else if (!head.startsWith('@')) out.push({ media, selectors: head.split(',').map((x) => x.trim()), decls: decls(body) });
      i = close + 1;
    }
  };
  run(src, '');
  return out;
}
const files = walk(join(web, 'src', 'features', 'frontdesk')).filter((f) => f.endsWith('.css'));
const rules = files.flatMap((f) => parse(readFileSync(f, 'utf8')));
const heightsOf = (re: RegExp) => rules.filter((r) => r.selectors.some((s) => re.test(s))).flatMap((r) => ['height', 'min-height'].map((k) => r.decls[k]).filter((v): v is string => !!v));
const THIRTY = /^(1\.875rem|30px|var\(--lims-control-height[\w-]*\))$/;
const OLD = /^(1\.625rem|1\.75rem|0\.9375rem|26px|28px|15px)$/;

describe('(a) one control height: 30 px', () => {
  it('no rule of the frontdesk css keeps a 26, 28 or 15 px control height', () => {
    const old = rules.flatMap((r) => ['height', 'min-height', 'max-height'].map((k) => [r.selectors.join(','), k, r.decls[k]] as const).filter(([sel, , v]) => v && OLD.test(v) && /input|select|\.lims-btn|\.lims-input|\.lims-select|control|field|checkbox|radio|icon/i.test(sel)).map(([sel, k, v]) => `${sel} ${k}:${v}`));
    expect(old).toEqual([]);
  });

  it.each([['inputs', /\.lims-reg\b.*(input|\.lims-input)/], ['selects', /\.lims-reg\b.*(select|\.lims-select)/], ['buttons', /\.lims-reg\b.*\.lims-btn\b/]] as const)('registration %s are 30 px high (1.875rem)', (_n, re) => {
    const hs = heightsOf(re);
    expect(hs.length, 'a height rule exists').toBeGreaterThan(0);
    for (const h of hs) expect(h, `height ${h}`).toMatch(THIRTY);
  });
});

describe('(c) (d) columns and footer', () => {
  it('each column card fills its column: a .lims-reg-col rule with flex-grow, flex 1 or height 100% on the child', () => {
    const fills = rules.filter((r) => r.selectors.some((s) => /\.lims-reg-col\s*>|\.lims-reg-col\s+\.lims-card|\[data-reg-column\]\s*>|\[data-reg-column\]\s+\.lims-card/.test(s)) && (/^(1|1 1 (auto|0|0%))/.test(r.decls['flex'] ?? '') || r.decls['flex-grow'] === '1' || r.decls['height'] === '100%'));
    expect(fills.length, 'the child of each .lims-reg-col grows to the column height').toBeGreaterThan(0);
    const grid = rules.filter((r) => r.selectors.includes('.lims-reg-layout')).map((r) => r.decls['align-items']).filter(Boolean);
    expect(grid, 'the grid stretches its columns').toContain('stretch');
  });

  it('the footer stays sticky at the bottom, outside the three columns', async () => {
    const s = Object.assign({}, ...rules.filter((r) => r.selectors.includes('.lims-reg-summary')).map((r) => r.decls));
    expect(s['position']).toBe('sticky');
    expect(s['bottom']).toMatch(/^0(px)?$/);
    await renderForm();
    await waitFor(() => expect(document.querySelectorAll('[data-reg-column]')).toHaveLength(3));
    expect(document.querySelector('[data-reg-column] aside[aria-label="Registration summary"]')).toBeNull();
    expect(document.querySelector('aside[aria-label="Registration summary"]')).not.toBeNull();
  });
});

describe('(b) one label style in the Billing column', () => {
  it('the field labels, the radio label, the loose "Balance after payment" label and any dt all carry lims-label', async () => {
    await renderForm();
    await screen.findByRole('button', { name: /^more/i });
    const col = document.querySelector('[data-reg-column="payment"]')!;
    const labels = [...col.querySelectorAll('label, legend, dt, .lims-label')];
    expect(labels.length).toBeGreaterThan(5);
    const loose = [...col.querySelectorAll('span, p, dt, strong')].filter((e) => /^(balance after payment|change|credit limit|consumed|reward points)$/i.test((e.firstChild?.textContent ?? e.textContent ?? '').trim().replace(/:$/, '')) && e.children.length === 0);
    expect(loose.map((e) => e.textContent), 'the loose label "Balance after payment" is drawn').toContain('Balance after payment');
    for (const e of [...col.querySelectorAll('dt'), ...loose]) expect(e.classList.contains('lims-label'), `"${e.textContent}" uses the kit label class lims-label (<${e.tagName.toLowerCase()} class="${e.className}">)`).toBe(true);
    const styles = new Set([...col.querySelectorAll('label, legend')].map((e) => e.classList.contains('lims-label') ? 'label' : e.tagName.toLowerCase()));
    expect([...styles], 'every <label> and <legend> of the column uses the kit label class').toEqual(['label']);
  });
});
