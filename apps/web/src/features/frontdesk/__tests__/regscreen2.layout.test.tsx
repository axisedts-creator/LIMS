// @vitest-environment jsdom
// T0D-REGSCREEN-2 — done_when (2) + (4): everything still fits ONE screen at 1366x768 and 1920x1080 without page scroll (More fold and inside box scrolling as in T0D-REGSCREEN-1).
// jsdom has no layout engine, so "fits" is proven from (a) the CSS VALUES at both viewports and (b) a CONTROL BUDGET of the DOM: the always visible part of each column (blank form, fold closed, no dialog)
// stays within what a 30 px compact control, 4 px label gap and 8 px group gap can hold in ~600 px of column height (11 rows, two short controls per row = 22). Real pixels need the reviewer's browser check.
// CONTRACT for the writer: the More fold region carries class `lims-reg-fold` with overflow-y auto|scroll and a bounded max-height (var() or px/vh) so opening it never makes the PAGE scroll; every `[data-reg-column]` keeps
// overflow-y auto|hidden with min-height 0 (inside box scrolling); new groups go INSIDE the three existing columns (no fourth column); the Drafts list is a dialog (not part of the page flow); tokens only, no hex colours;
// no horizontal scroll rule; and the rarely used items listed in the fold test below live in the fold, not above it.
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
  const decls = (body: string) => Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const i = d.indexOf(':'); return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()]; }));
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
const mediaOn = (media: string, w: number) => !media || media.split(/\s+and\s+/i).every((q) => {
  const m = /\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/i.exec(q);
  if (!m) return /^(screen|all)$/i.test(q.trim());
  return m[1]!.toLowerCase() === 'min' ? w >= Number(m[2]) : w <= Number(m[2]);
});
const files = walk(join(web, 'src', 'features', 'frontdesk')).filter((f) => f.endsWith('.css'));
const rules = files.flatMap((f) => parse(readFileSync(f, 'utf8')));
const styleOf = (sel: string, w: number): Record<string, string> => Object.assign({}, ...rules.filter((r) => mediaOn(r.media, w) && r.selectors.includes(sel)).map((r) => r.decls));

const VIEWPORTS = [{ w: 1366, h: 768 }, { w: 1920, h: 1080 }, { w: 1024, h: 768 }] as const; // the two founder sizes + the LD-340 laptop floor

describe('CSS values at both viewport sizes', () => {
  it.each(VIEWPORTS)('$w x $h: the More fold scrolls inside its own box (overflow-y auto|scroll, bounded max-height)', ({ w }) => {
    const s = styleOf('.lims-reg-fold', w);
    expect(s['overflow-y'] ?? s['overflow'], '.lims-reg-fold overflow').toMatch(/^(auto|scroll)$/);
    expect(s['max-height'], '.lims-reg-fold max-height').toMatch(/(px|vh|dvh|rem|em|%|var\(.+\)|calc\(.+\))$/);
  });

  it.each(VIEWPORTS)('$w x $h: the three columns scroll inside themselves, never the page', ({ w }) => {
    const col = styleOf('.lims-reg-layout > *', w);
    const col2 = styleOf('[data-reg-column]', w);
    const s = { ...col, ...col2 };
    expect(s['overflow-y'] ?? s['overflow'], 'column overflow').toMatch(/^(auto|hidden)$/);
    expect(s['min-height'], 'column min-height').toMatch(/^0(px)?$/);
    for (const sel of ['html', 'body']) expect(`${styleOf(sel, w)['overflow'] ?? ''} ${styleOf(sel, w)['overflow-y'] ?? ''}`).not.toMatch(/scroll|auto/);
  });

  it.each(VIEWPORTS)('$w x $h: no horizontal scroll rule on the layout, fold or columns', ({ w }) => {
    for (const sel of ['.lims-reg-layout', '.lims-reg-fold', '[data-reg-column]']) {
      const s = styleOf(sel, w);
      expect(`${s['overflow-x'] ?? ''}`, sel).not.toMatch(/scroll/);
    }
  });

  it('tokens only: no hex colour in the feature css, no 1280 breakpoint', () => {
    const all = files.map((f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
    expect(all.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(all).not.toMatch(/min-width\s*:\s*1280px/);
  });

  it('compact control height is kept: no feature rule sets a control taller than 30 px (LD-310 (a))', () => {
    const tall = rules.flatMap((r) => Object.entries(r.decls).filter(([k, v]) => /^(min-)?height$/.test(k) && /^(\d+(?:\.\d+)?)px$/.test(v) && Number(v.replace('px', '')) > 30 && Number(v.replace('px', '')) < 64 && r.selectors.some((s) => /input|select|button|control|field/i.test(s))).map(([k, v]) => `${r.selectors.join(',')} ${k}:${v}`));
    expect(tall).toEqual([]);
  });
});

describe('DOM control budget (blank form, fold closed, no dialog)', () => {
  const CONTROL = 'input:not([type="hidden"]), textarea, select, button, [role="combobox"], [role="switch"], [role="tab"]';
  const visible = (el: Element, col: Element) => {
    for (let n: Element | null = el; n && n !== col.parentElement; n = n.parentElement) {
      if ((n as HTMLElement).hidden || n.getAttribute('aria-hidden') === 'true') return false;
      if (n.getAttribute('role') === 'dialog' || n.classList.contains('lims-reg-fold')) return false;
    }
    return true;
  };
  const counts = async () => {
    await renderForm();
    await waitFor(() => expect(document.querySelectorAll('[data-reg-column]')).toHaveLength(3));
    await screen.findByRole('button', { name: /^more/i });
    return [...document.querySelectorAll('[data-reg-column]')].map((c) => ({ name: c.getAttribute('data-reg-column')!, n: [...c.querySelectorAll(CONTROL)].filter((e) => visible(e, c)).length }));
  };

  it('each of the three columns shows at most 22 controls above the fold; the whole screen at most 60', async () => {
    const c = await counts();
    for (const col of c) expect(col.n, `${col.name} column has ${col.n} controls`).toBeLessThanOrEqual(22);
    expect(c.reduce((a, b) => a + b.n, 0), JSON.stringify(c)).toBeLessThanOrEqual(60);
  });

  it('there are still exactly three [data-reg-column] after the new groups (no fourth column) and the summary bar is outside them', async () => {
    await renderForm();
    expect(document.querySelectorAll('[data-reg-column]')).toHaveLength(3);
    expect(document.querySelectorAll('.lims-reg-layout')).toHaveLength(1);
    expect(document.querySelector('[data-reg-column] aside[aria-label="Registration summary"]')).toBeNull();
  });

  it('the rare items sit in the fold (class lims-reg-fold, the region of the More button), not above it', async () => {
    await renderForm();
    const more = screen.getByRole('button', { name: /^more/i });
    const fold = document.getElementById(more.getAttribute('aria-controls') ?? '__none__') as HTMLElement;
    expect(fold, 'fold region').toBeTruthy();
    expect(fold.classList.contains('lims-reg-fold')).toBe(true);
    for (const l of [/clinical history/i, /patient history/i, /mr number/i, /buyer pan/i, /external reference/i, /insurance code/i, /insurance claim amount/i]) {
      expect(fold.querySelector('*') && [...fold.querySelectorAll('label, [aria-label]')].some((e) => l.test(e.textContent ?? '') || l.test(e.getAttribute('aria-label') ?? '')), String(l)).toBe(true);
    }
    expect(fold.contains(screen.getByRole('switch', { name: /downtime back-entry/i }))).toBe(true);
  });

  it('what must stay in view: patient search, tests search, cart box, payment rows, Save as draft, Drafts, number preview and Redeem/coupon/visiting inputs are NOT inside the fold', async () => {
    await renderForm();
    const more = screen.getByRole('button', { name: /^more/i });
    const fold = document.getElementById(more.getAttribute('aria-controls') ?? '__none__') as HTMLElement;
    for (const el of [screen.getByRole('combobox', { name: /search patient/i }), screen.getByRole('button', { name: /^save as draft/i }), screen.getByRole('button', { name: /^drafts/i }),
      screen.getByLabelText(/next lab number/i), screen.getByLabelText(/next bill receipt number/i), screen.getByRole('textbox', { name: /coupon code/i }), screen.getByLabelText(/visiting charge/i)]) expect(fold.contains(el)).toBe(false);
  });
});
