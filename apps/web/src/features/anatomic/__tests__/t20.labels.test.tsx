// @vitest-environment jsdom
// C11.T-20 — Labels page /anatomic/cases/{case_id}/labels (04-UI-UX §4.3, §6; AC-13.3; REQ-SEC-096/098/100; 07-SECURITY labels row) + print CSS contract (plan row T-20 "print CSS snapshot").
// AC-13.3: 3 blocks -> 3 labels with label text and a Code 128 symbol (CR-C11-007 has merged: BarcodeSymbol exists in @lims/ui); the access_log row `anatomic_label.print` is written BY THE API
//          when GET /cases/{id}/labels is served (spec 08 A17 D-53), so the UI contract is: exactly one such GET per page render, ids-only URL, labels text only (no patient data).
// LD-140 (2026-11-13): kit components only; print rules live in a .css file, not inline style objects.
// ASSUMED seams (t20.harness.tsx header): async Page({ params, searchParams }); toolbar/chrome elements that must vanish when printing carry `data-print-hide`; the sheet's CSS is a *.css file next to the page or in features/anatomic/components/material.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_NONE, PERM_READ, PERM_WORK, api, hit, hits, labelsFor, problem, resetHits, router, state, t20Defaults } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); state.permissions = PERM_WORK; api.use(...t20Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const CASE = ID(1);
const BLOCKS = ['SP26-000042-A1', 'SP26-000042-A2', 'SP26-000042-A3'];
const open = async (sp: Record<string, string | string[] | undefined> = {}, case_id = CASE) => {
  const mod = await import('../../../app/(staff)/anatomic/cases/[case_id]/labels/page');
  const el = await mod.default({ params: Promise.resolve({ case_id }), searchParams: Promise.resolve(sp) } as never);
  return render(<ToastProvider>{el}</ToastProvider>);
};
const labelCalls = () => hit('GET', /^\/v1\/anatomic\/cases\/[^/]+\/labels$/);
const serve = (kind: 'block' | 'slide', labels: string[]) => api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/labels`, () => HttpResponse.json(labelsFor(kind, labels))));

describe('AC-13.3 labels page for blocks', () => {
  it('3 blocks -> GET labels?kind=blocks once, and 3 labels each with its label text and a Code 128 symbol', async () => {
    serve('block', BLOCKS);
    await open();
    const [c, ...rest] = labelCalls();
    expect(rest).toHaveLength(0); // one fetch = one access_log row `anatomic_label.print` (no polling, no double render)
    expect(c!.path).toBe(`/v1/anatomic/cases/${CASE}/labels`);
    expect(new URLSearchParams(c!.search).get('kind')).toBe('blocks'); // default kind
    for (const l of BLOCKS) expect(screen.getAllByText(l, { exact: false }).length, l).toBeGreaterThan(0); // real text (screen readers + fallback when barcodes are not printed)
    const symbols = screen.getAllByRole('img').filter((e) => e.tagName.toLowerCase() === 'svg' && BLOCKS.includes(e.getAttribute('aria-label') ?? ''));
    expect(symbols.map((s) => s.getAttribute('aria-label'))).toEqual(BLOCKS); // BarcodeSymbol: svg role=img aria-label=value, one per label, same order as the API
    expect(document.body.textContent).not.toMatch(/Barcode symbols not yet available/i); // the CR-C11-007 fallback note is only for "until C0-0D ships it"
  });

  it('line 2 (API `line2`) is printed under the label text; label text is mono + bold (line 1)', async () => {
    serve('block', BLOCKS);
    await open();
    for (const i of [1, 2, 3]) expect(document.body.textContent).toContain(`Synthetic line ${i}`);
    const first = screen.getAllByText(BLOCKS[0]!, { exact: true }).find((e) => !e.closest('svg'));
    expect(first, 'label text node outside the svg').toBeTruthy();
  });

  it('labels carry only label text and line2: no patient name, no accession-derived extras beyond the API values (R7)', async () => {
    serve('block', BLOCKS);
    await open();
    expect(document.body.textContent).not.toMatch(/Synthetic Patient|PC-\d/);
  });

  it('REQ-SEC-098: the URL sent to the API has no label text; only kind (+ ids) are query params', async () => {
    serve('block', BLOCKS);
    await open({ kind: 'blocks' });
    const c = labelCalls()[0]!;
    expect(c.path + c.search).not.toContain('SP26-000042');
    expect([...new URLSearchParams(c.search).keys()].sort()).toEqual(['kind']);
  });
});

describe('kind and ids (REQ-SEC-100: <=200 per call; nothing user-controlled reaches the API unvalidated)', () => {
  it('?kind=slides is forwarded and renders slide labels', async () => {
    serve('slide', ['SP26-000042-A1-S1', 'SP26-000042-A1-S2']);
    await open({ kind: 'slides' });
    expect(new URLSearchParams(labelCalls()[0]!.search).get('kind')).toBe('slides');
    expect(screen.getAllByRole('img').filter((e) => e.tagName.toLowerCase() === 'svg')).toHaveLength(2);
  });

  it.each([['evil'], ['BLOCKS'], ['blocks,slides'], [['slides', 'blocks']]])('unknown kind %j falls back to blocks', async (kind) => {
    await open({ kind: kind as never });
    expect(new URLSearchParams(labelCalls()[0]!.search).get('kind')).toBe('blocks');
  });

  it('ids (csv of UUIDs) is forwarded for a subset print (Blocks tab "Print labels" with a selection)', async () => {
    const ids = `${ID(201)},${ID(203)}`;
    await open({ kind: 'blocks', ids });
    expect(new URLSearchParams(labelCalls()[0]!.search).get('ids')).toBe(ids);
  });

  it.each([['not-a-uuid'], [`${ID(201)},zzz`], [`${ID(201)},`], ['<script>'], [Array.from({ length: 201 }, (_, i) => ID(i + 1)).join(',')]])('malformed or >200 ids %#: dropped, never forwarded', async (ids) => {
    await open({ kind: 'blocks', ids });
    const c = labelCalls();
    if (c.length) expect(new URLSearchParams(c[0]!.search).has('ids')).toBe(false);
  });

  it('a non-UUID case_id is a 404 before any API call (REQ-SEC-026/027)', async () => {
    await expect(open({}, '../../etc/passwd')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(hits).toHaveLength(0);
  });
});

describe('screen toolbar (screen only)', () => {
  it('kind toggle Blocks/Slides, [Print] and [Back to case]', async () => {
    serve('block', BLOCKS);
    await open();
    expect(screen.getByRole('link', { name: /back to case/i }).getAttribute('href')).toBe(`/anatomic/cases/${CASE}`);
    expect(screen.getByRole('button', { name: /^print$/i })).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: /^slides$/i }));
    expect(router.push).toHaveBeenCalledWith(`/anatomic/cases/${CASE}/labels?kind=slides`);
  });

  it('[Print] calls window.print() once and is the only primary button (LD-140)', async () => {
    serve('block', BLOCKS);
    const spy = vi.spyOn(window, 'print').mockImplementation(() => {});
    await open();
    await userEvent.click(screen.getByRole('button', { name: /^print$/i }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.lims-btn-primary')).toHaveLength(1);
  });

  it('toolbar and every non-label element are marked data-print-hide; the labels themselves are not', async () => {
    serve('block', BLOCKS);
    await open();
    const toolbar = screen.getByRole('button', { name: /^print$/i }).closest('[data-print-hide]');
    expect(toolbar, 'toolbar wrapper carries data-print-hide').toBeTruthy();
    for (const l of BLOCKS) expect(screen.getAllByText(l, { exact: false })[0]!.closest('[data-print-hide]'), l).toBeNull();
  });

  it('empty result: "No blocks yet." state, no symbols, Print disabled', async () => {
    await open();
    expect(screen.getByText(/no blocks yet/i)).toBeTruthy();
    expect(screen.queryAllByRole('img').filter((e) => e.tagName.toLowerCase() === 'svg')).toHaveLength(0);
    expect((screen.getByRole('button', { name: /^print$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('axe: no violations (label text is real text)', async () => {
    serve('block', BLOCKS);
    await open();
    const v = (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations;
    expect(v.map((x) => `${x.id}: ${x.help}`)).toEqual([]);
  });
});

describe('page states (permission anatomic.case.work, x-permission of getAnatomicLabels)', () => {
  it('without anatomic.case.work: no-access state, no API call, no labels', async () => {
    state.permissions = PERM_READ;
    await open();
    expect(labelCalls()).toHaveLength(0);
    expect(screen.queryAllByRole('img').filter((e) => e.tagName.toLowerCase() === 'svg')).toHaveLength(0);
    expect(document.body.textContent).toMatch(/don.t have access|not allowed|no access|permission/i);
  });

  it('no permissions at all: same', async () => {
    state.permissions = PERM_NONE;
    await open();
    expect(labelCalls()).toHaveLength(0);
  });

  it('API 403 -> no-access state without leaking the problem body', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/labels`, () => problem('auth.forbidden', 403, { detail: 'secret-internal' })));
    await open();
    expect(document.body.textContent).not.toContain('secret-internal');
    expect(document.body.textContent).toMatch(/don.t have access|not allowed|no access|permission/i);
  });

  it('API 404 (other tenant / other centre) -> notFound()', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/labels`, () => problem('common.not_found', 404)));
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('API 500 rejects (error boundary), nothing rendered from the body', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/labels`, () => problem('common.internal', 500, { detail: 'secret-internal' })));
    await expect(open()).rejects.toThrow();
  });
});

describe('BarcodeSymbol safety (a wrong barcode is a misidentification risk)', () => {
  it('a label value the symbol rejects (outside A-Z0-9-) is not rendered as a symbol and does not crash the sheet; the other labels still render', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/labels`, () => HttpResponse.json(labelsFor('block', ['SP26-000042-A1', 'bad value!', 'SP26-000042-A3']))));
    await open();
    const aria = screen.getAllByRole('img').filter((e) => e.tagName.toLowerCase() === 'svg').map((e) => e.getAttribute('aria-label'));
    expect(aria).toEqual(['SP26-000042-A1', 'SP26-000042-A3']);
    expect(document.body.textContent).not.toMatch(/undefined|NaN/);
  });
});

// ---------------------------------------------------------------- print CSS (plan row T-20 "print CSS snapshot"; 04-UI-UX §4.3, §7)
const web = join(fileURLToPath(import.meta.url), '../../../../../');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; }) : []);
const cssFiles = [...walk(join(web, 'src/app/(staff)/anatomic/cases/[case_id]/labels')), ...walk(join(web, 'src/features/anatomic/components/material'))].filter((f) => f.endsWith('.css'));
const css = cssFiles.map((f) => readFileSync(f, 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('print CSS contract', () => {
  it('a stylesheet for the label sheet exists (labels page dir or components/material)', () => expect(cssFiles.length).toBeGreaterThan(0));

  it('@page is the default label size 50 x 25 mm with no margin (04-UI-UX §4.3 [CONV]: prints at the configured size regardless of screen width)', () => {
    const m = /@page\s*\{([^}]*)\}/.exec(css);
    expect(m, '@page rule').toBeTruthy();
    expect(squash(m![1]!)).toMatch(/size:\s*50mm 25mm/);
    expect(squash(m![1]!)).toMatch(/margin:\s*0(mm)?\s*;?/);
  });

  it('@media print hides the shell chrome and every [data-print-hide] element', () => {
    const print = [...css.matchAll(/@media\s+print\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((x) => squash(x[1]!)).join(' ');
    expect(print, '@media print block').toBeTruthy();
    expect(print).toMatch(/\[data-print-hide\][^{]*\{[^}]*display:\s*none/);
    expect(print).toMatch(/(header|nav|aside|\.lims-[a-z-]*(shell|sidebar|nav|header)[a-z-]*)[^{]*\{[^}]*display:\s*none/i); // no shell chrome when printing
  });

  it('one label per page: each label breaks after itself and never splits (break-after: page / break-inside: avoid)', () => {
    const s = squash(css);
    expect(s).toMatch(/break-after:\s*page|page-break-after:\s*always/);
    expect(s).toMatch(/break-inside:\s*avoid|page-break-inside:\s*avoid/);
  });

  it('label text is mono + bold with a cap height >= 3 mm (font-size in mm/pt big enough: >= 4.2mm or >= 12pt)', () => {
    const s = squash(css);
    expect(s).toMatch(/font-weight:\s*(bold|[6-9]00)/);
    expect(s).toMatch(/mono/i);
    const sizes = [...s.matchAll(/font-size:\s*([\d.]+)(mm|pt)/g)].map((m) => (m[2] === 'mm' ? Number(m[1]) : Number(m[1]) * 0.3528));
    expect(sizes.length, 'font-size in mm or pt').toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(4.2); // cap height ~0.7 em -> 3 mm
  });

  it('LD-140: no hex colours, no px radii in the print CSS (tokens / system colours only; BarcodeSymbol carries its own black-on-white)', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/border-radius:\s*[\d.]+px/);
  });

  // The "snapshot" of plan row T-20 is the explicit rule assertions above, on purpose: a stored .snap would be written by the first implementation run and then bless itself.
  it('the print layout is exactly: one @page rule + at least one @media print block', () => {
    expect([...css.matchAll(/@page\b/g)]).toHaveLength(1);
    expect([...css.matchAll(/@media\s+print\b/g)].length).toBeGreaterThanOrEqual(1);
  });
});
