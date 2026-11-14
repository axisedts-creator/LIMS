// @vitest-environment jsdom
// C10.T-21 — suggestions: debounced preview, "Use" sets fields, accept_suggestion round trip (03-APP-FLOW §4.5 steps 5-6; 04-UI-UX §3.3; 02-TRD M12/M13, §4.5; AC-07.5 UI side).
// done_when: "debounce preview, "Use" sets fields". Real timers: the debounce is 300 ms [CONV]; assertions use generous upper bounds.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { BAND_ID, ID, ISO, ORIGIN, PERM_WORK, PREVIEW, api, astIsolate, astRow, bulkHandler, catBtn, grid, hit, lastHit, panelHandler, pick, previewHandler, rawBox, resetHits, saveBtn, state, suggestion, useBtn } from './t21.harness';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); state.permissions = PERM_WORK; api.use(previewHandler(), bulkHandler(), panelHandler()); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (isolate: Record<string, unknown> = astIsolate(), standard: 'CLSI' | 'EUCAST' | undefined = 'CLSI') => {
  const { AstGrid } = await import('../components/ast/AstGrid');
  const r = render(<ToastProvider><AstGrid isolate={isolate as never} canWork onSaved={() => {}} {...(standard ? { defaultStandard: standard } : {})} /></ToastProvider>);
  await grid();
  return r;
};
const previews = () => hit('POST', PREVIEW);
const verBox = () => screen.getByRole('textbox', { name: /^(standard )?version/i }) as HTMLInputElement;
const type = async (abx: string, v: string, blur = true) => { const b = rawBox(abx); await userEvent.clear(b); if (v) await userEvent.type(b, v); if (blur) await userEvent.tab(); };
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

describe('debounced preview (AC-07.1 UI; 03-APP-FLOW §4.5 step 5)', () => {
  it('nothing is requested while typing; one request ~300 ms after the blur, not immediately', async () => {
    await mount();
    await type('Synthetic genB', '18', false);
    expect(previews()).toHaveLength(0);
    const t0 = Date.now();
    await userEvent.tab();
    expect(previews()).toHaveLength(0); // debounced, not synchronous
    await waitFor(() => expect(previews()).toHaveLength(1), { timeout: 3000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    await settle(500);
    expect(previews()).toHaveLength(1);
  });
  it('POST /v1/micro/isolates/{id}/ast-results/interpret with only declared fields: antibiotic_code, method, raw_value (+ qualifier_code)', async () => {
    await mount();
    await type('Synthetic genB', '18');
    const h = await lastHit('POST', PREVIEW);
    expect(h.path).toBe(`/v1/micro/isolates/${ISO}/ast-results/interpret`);
    expect(h.json.entries).toHaveLength(1);
    const e = h.json.entries[0];
    expect(e).toMatchObject({ antibiotic_code: 'syn_gen_b', method: 'zone_diameter', raw_value: '18' });
    expect(Object.keys(e).filter((k) => !['antibiotic_code', 'method', 'raw_value', 'qualifier_code'].includes(k))).toEqual([]);
    expect(Object.keys(h.json)).toEqual(['entries']);
  });
  it('only changed rows are previewed (a row nobody touched never appears)', async () => {
    await mount();
    await type('Synthetic genB', '18');
    await type('Synthetic cefA', '0.25');
    await waitFor(() => expect(previews().flatMap((h) => h.json.entries.map((e: { antibiotic_code: string }) => e.antibiotic_code)).sort()).toEqual(['syn_cef_a', 'syn_gen_b']), { timeout: 3000 });
    await settle(500);
    expect(previews().flatMap((h) => h.json.entries.map((e: { antibiotic_code: string }) => e.antibiotic_code))).not.toContain('colistin');
  });
  it('blurring without a change sends nothing; an empty or invalid value sends nothing', async () => {
    await mount(astIsolate({ ast: [astRow(1, 'syn_cef_a', 'Synthetic cefA', 'mic', { raw_value: '4' }), astRow(2, 'syn_gen_b', 'Synthetic genB', 'zone_diameter')] }));
    await userEvent.click(rawBox('Synthetic cefA'));
    await userEvent.tab();
    await type('Synthetic genB', 'abc'); // invalid grammar
    await type('Synthetic cefA', ''); // cleared
    await settle(800);
    expect(previews()).toHaveLength(0);
  });
  it('a preview failure (500) shows no suggestion, does not block editing or saving, and the next blur tries again', async () => {
    let calls = 0;
    api.use(http.post(`${ORIGIN}/v1/micro/isolates/:id/ast-results/interpret`, () => (++calls === 1 ? HttpResponse.json({ type: 'x', title: 'x', status: 500, code: 'common.internal' }, { status: 500 }) : HttpResponse.json({ results: [{ antibiotic_code: 'syn_gen_b', method: 'zone_diameter', suggestion: suggestion('S') }] }))));
    await mount();
    await type('Synthetic genB', '18');
    await waitFor(() => expect(calls).toBe(1), { timeout: 3000 });
    await settle(300);
    expect(useBtn('S', 'Synthetic genB')).toBeNull();
    expect(rawBox('Synthetic genB').value).toBe('18');
    expect(saveBtn()).toBeTruthy();
    await type('Synthetic genB', '18.5');
    await waitFor(() => expect(calls).toBe(2), { timeout: 3000 });
    expect(await screen.findByRole('button', { name: /use suggested category S for Synthetic genB/i }, { timeout: 3000 })).toBeTruthy();
  });
  it('the last response wins: a slow answer for an old value never overwrites the suggestion for the current value', async () => {
    api.use(previewHandler((e) => (e.raw_value === '18' ? suggestion('S') : e.raw_value === '6' ? suggestion('R', { breakpoint_band_id: ID(72) }) : undefined), (e) => (e.raw_value === '18' ? 1200 : 0)));
    await mount();
    await type('Synthetic genB', '18'); // slow
    await waitFor(() => expect(previews()).toHaveLength(1), { timeout: 3000 });
    await type('Synthetic genB', '6'); // fast, newer
    expect(await screen.findByRole('button', { name: /use suggested category R for Synthetic genB/i }, { timeout: 4000 })).toBeTruthy();
    await settle(1500); // the slow "S" answer has arrived by now
    expect(useBtn('S', 'Synthetic genB')).toBeNull();
    expect(useBtn('R', 'Synthetic genB')).toBeTruthy();
  });
});

describe('what a suggestion looks like (04-UI-UX §3.3, §8)', () => {
  it('"Suggested: S (CLSI M100-Ed36 …)" and a button named "Use suggested category S for {antibiotic}"', async () => {
    await mount();
    await type('Synthetic genB', '18');
    const b = await screen.findByRole('button', { name: /^use suggested category S for Synthetic genB$/i }, { timeout: 3000 });
    const row = b.closest('[role="row"]') as HTMLElement;
    expect(row.textContent).toMatch(/Suggested:?\s*S/);
    expect(row.textContent).toMatch(/CLSI/);
    expect(row.textContent).toMatch(/M100-Ed36/);
  });
  it.each(['no_active_set', 'no_row', 'indeterminate', 'disabled', 'value_invalid'])('reason %s: no suggestion text and no Use button', async (reason) => {
    api.use(http.post(`${ORIGIN}/v1/micro/isolates/:id/ast-results/interpret`, async ({ request }) => {
      const b = (await request.json()) as { entries: { antibiotic_code: string; method: string }[] };
      return HttpResponse.json({ results: b.entries.map((e) => ({ antibiotic_code: e.antibiotic_code, method: e.method, reason })) });
    }));
    await mount();
    await type('Synthetic genB', '18');
    await waitFor(() => expect(previews()).toHaveLength(1), { timeout: 3000 });
    await settle(300);
    expect(screen.queryAllByRole('button', { name: /use suggested category/i })).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Suggested:/);
  });
  it('a suggestion is never applied by itself: category, standard-version and report stay as the user left them', async () => {
    await mount();
    await type('Synthetic genB', '18');
    await screen.findByRole('button', { name: /use suggested category S for Synthetic genB/i }, { timeout: 3000 });
    expect(catBtn('Synthetic genB').textContent).not.toMatch(/\bS\b/);
    expect(verBox().value).toBe('');
  });
  it('the suggestion text for another row is not shown on a row without one (rows are independent)', async () => {
    await mount();
    await type('Synthetic genB', '18');
    await screen.findByRole('button', { name: /use suggested category S for Synthetic genB/i }, { timeout: 3000 });
    expect(useBtn('S', 'Synthetic cefA')).toBeNull();
    expect(useBtn('S', 'Colistin')).toBeNull();
  });
});

describe('"Use" sets the fields (done_when; AC-07.5)', () => {
  it('Use fills the row category, the standard and — when empty — the version of the suggestion; nothing is saved yet', async () => {
    await mount(astIsolate(), undefined); // no tenant standard: the suggestion supplies it
    await type('Synthetic genB', '18');
    await userEvent.click(await screen.findByRole('button', { name: /use suggested category S for Synthetic genB/i }, { timeout: 3000 }));
    expect(catBtn('Synthetic genB').textContent).toMatch(/\bS\b/);
    expect(screen.getByRole('button', { name: /standard$/i }).textContent).toMatch(/CLSI/);
    expect(verBox().value).toBe('M100-Ed36');
    expect(hit('POST', /bulk-record$/)).toHaveLength(0);
  });
  it('Use keeps a version the user already typed (no silent overwrite)', async () => {
    await mount();
    await userEvent.type(verBox(), 'my-own-version');
    await type('Synthetic genB', '18');
    await userEvent.click(await screen.findByRole('button', { name: /use suggested category S for Synthetic genB/i }, { timeout: 3000 }));
    expect(verBox().value).toBe('my-own-version');
  });
  it('AC-07.5: Use over a differing header version still saves accept_suggestion:true with the suggestion\'s version and band (per-row override)', async () => {
    await mount();
    await userEvent.type(verBox(), 'my-own-version');
    await type('Synthetic genB', '18');
    await userEvent.click(await screen.findByRole('button', { name: /use suggested category S for Synthetic genB/i }, { timeout: 3000 }));
    await userEvent.click(saveBtn()!);
    const e = (await lastHit('POST', /bulk-record$/)).json.entries[0];
    expect(e).toMatchObject({ category_code: 'S', standard: 'CLSI', standard_version: 'M100-Ed36', accept_suggestion: true, breakpoint_band_id: BAND_ID });
  });
  it('AC-07.5: Save after Use sends accept_suggestion:true with the same breakpoint_band_id, category, standard and version', async () => {
    await mount();
    await type('Synthetic genB', '18');
    await userEvent.click(await screen.findByRole('button', { name: /use suggested category S for Synthetic genB/i }, { timeout: 3000 }));
    await userEvent.click(saveBtn()!);
    const h = await lastHit('POST', /bulk-record$/);
    expect(h.json.entries).toHaveLength(1);
    expect(h.json.entries[0]).toMatchObject({ antibiotic_code: 'syn_gen_b', method: 'zone_diameter', raw_value: '18', category_code: 'S', standard: 'CLSI', standard_version: 'M100-Ed36', accept_suggestion: true, breakpoint_band_id: BAND_ID });
  });
  it('AC-07.5: a different category after Use is a manual entry: accept_suggestion is not true', async () => {
    await mount();
    await type('Synthetic genB', '18');
    await userEvent.click(await screen.findByRole('button', { name: /use suggested category S for Synthetic genB/i }, { timeout: 3000 }));
    await pick(undefined, /Synthetic genB category/i, /^R\s—/);
    await userEvent.click(saveBtn()!);
    const e = (await lastHit('POST', /bulk-record$/)).json.entries[0];
    expect(e.category_code).toBe('R');
    expect(e.accept_suggestion).not.toBe(true);
  });
  it('a manually picked category (no suggestion) never carries accept_suggestion or a band id', async () => {
    await mount();
    await type('Synthetic cefA', '4');
    await pick(undefined, /Synthetic cefA category/i, /^S\s—/);
    await userEvent.type(verBox(), 'M100-Ed36');
    await userEvent.click(saveBtn()!);
    const e = (await lastHit('POST', /bulk-record$/)).json.entries[0];
    expect(e).toMatchObject({ category_code: 'S', standard: 'CLSI', standard_version: 'M100-Ed36' });
    expect(e.accept_suggestion).not.toBe(true);
    expect(e.breakpoint_band_id).toBeUndefined();
  });
  it('editing the raw value after Use drops the acceptance: the band id belonged to the old value (server would answer common.validation_failed)', async () => {
    await mount();
    await type('Synthetic genB', '18');
    await userEvent.click(await screen.findByRole('button', { name: /use suggested category S for Synthetic genB/i }, { timeout: 3000 }));
    await type('Synthetic genB', '19'); // no suggestion for 19 (reason no_row)
    await waitFor(() => expect(previews().length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    await userEvent.click(saveBtn()!);
    const e = (await lastHit('POST', /bulk-record$/)).json.entries[0];
    expect(e.raw_value).toBe('19');
    expect(e.accept_suggestion).not.toBe(true);
    expect(e.breakpoint_band_id).toBeUndefined();
  });
  it('after a save the suggestion is gone and the next edit starts clean', async () => {
    await mount();
    await type('Synthetic genB', '18');
    await userEvent.click(await screen.findByRole('button', { name: /use suggested category S for Synthetic genB/i }, { timeout: 3000 }));
    await userEvent.click(saveBtn()!);
    await waitFor(() => expect(hit('POST', /bulk-record$/)).toHaveLength(1));
    await waitFor(() => expect(useBtn('S', 'Synthetic genB')).toBeNull());
  });
});
