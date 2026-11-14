// @vitest-environment jsdom
// C10.T-21 — "Save AST": recordAstResults request shape, per-row errors, partial success, unsaved-changes tracking (03-APP-FLOW §4.5 step 6, §6 partial failure;
// 04-UI-UX §3.3, §10 copy; 02-TRD M12; AC-06.2 … AC-06.6 UI side; REQ-SEC-088/098). done_when: "per-row errors, unsaved-changes guard".
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { CEF, COL, GEN, ISO, ORIGIN, PERM_WORK, api, astIsolate, astRow, bulkHandler, catBtn, describedText, grid, hit, lastHit, pick, previewHandler, problem, rawBox, reportBox, resetHits, saveBtn, state } from './t21.harness';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); state.permissions = PERM_WORK; api.use(previewHandler(() => undefined)); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (isolate: Record<string, unknown> = astIsolate(), over: { onSaved?: () => void; onDirtyChange?: (d: boolean) => void } = {}) => {
  const { AstGrid } = await import('../components/ast/AstGrid');
  const r = render(<ToastProvider><AstGrid isolate={isolate as never} canWork defaultStandard="CLSI" onSaved={over.onSaved ?? (() => {})} {...(over.onDirtyChange ? { onDirtyChange: over.onDirtyChange } : {})} /></ToastProvider>);
  await grid();
  return r;
};
const bulk = () => hit('POST', /bulk-record$/);
const verBox = () => screen.getByRole('textbox', { name: /^(standard )?version/i }) as HTMLInputElement;
const edit = (abx: string, v: string) => fireEvent.change(rawBox(abx), { target: { value: v } });
const save = async () => userEvent.click(saveBtn()!);
const ALLOWED = ['antibiotic_code', 'method', 'raw_value', 'category_code', 'standard', 'standard_version', 'accept_suggestion', 'breakpoint_band_id', 'qualifier_code', 'is_reportable', 'add_to_isolate', 'version'];
const MSG = {
  value: /Enter a value like 0\.25, <=0\.25 or 18/,
  needValue: /Enter the measured value before choosing a category/,
  standard: /Choose the standard and version for this category/,
  category: /This category isn't allowed for this standard or antibiotic/,
  panel: /This antibiotic isn't in the panel\. Tick 'Add to isolate' to record it anyway/,
};

describe('request shape (M12; AC-06.2)', () => {
  it('"Save AST" is disabled until something changed', async () => {
    await mount();
    const b = saveBtn()!;
    expect(b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true').toBe(true);
    edit('Synthetic cefA', '4');
    await waitFor(() => expect(saveBtn()!.hasAttribute('disabled') || saveBtn()!.getAttribute('aria-disabled') === 'true').toBe(false));
  });
  it('POST /isolates/{id}/ast-results/bulk-record with an Idempotency-Key, no If-Match, only declared fields, only the changed rows, each with its stored version', async () => {
    api.use(bulkHandler());
    await mount(astIsolate({ ast: [{ ...CEF, version: 7 }, GEN, COL] }));
    edit('Synthetic cefA', '<=0.25');
    await save();
    const h = await lastHit('POST', /bulk-record$/);
    expect(h.path).toBe(`/v1/micro/isolates/${ISO}/ast-results/bulk-record`);
    expect(h.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(h.headers.get('if-match')).toBeNull();
    expect(Object.keys(h.json)).toEqual(['entries']);
    expect(h.json.entries).toHaveLength(1);
    expect(h.json.entries[0]).toMatchObject({ antibiotic_code: 'syn_cef_a', method: 'mic', raw_value: '<=0.25', version: 7 });
    expect(Object.keys(h.json.entries[0]).filter((k) => !ALLOWED.includes(k))).toEqual([]);
  });
  it('AC-06.2: the raw value goes out exactly as typed (qualifier kept, not parsed or normalised by the client); zone rows send method zone_diameter', async () => {
    api.use(bulkHandler());
    await mount();
    edit('Synthetic cefA', '≤0.25');
    edit('Synthetic genB', '18');
    await save();
    const e = (await lastHit('POST', /bulk-record$/)).json.entries;
    expect(e.find((x: { antibiotic_code: string }) => x.antibiotic_code === 'syn_cef_a')).toMatchObject({ raw_value: '≤0.25', method: 'mic' });
    expect(e.find((x: { antibiotic_code: string }) => x.antibiotic_code === 'syn_gen_b')).toMatchObject({ raw_value: '18', method: 'zone_diameter' });
    for (const x of e) { expect(x).not.toHaveProperty('raw_numeric'); expect(x).not.toHaveProperty('unit_code'); expect(x).not.toHaveProperty('raw_qualifier'); }
  });
  it('a category row carries standard and standard_version from the header; the Report checkbox goes out as is_reportable', async () => {
    api.use(bulkHandler());
    await mount();
    edit('Synthetic cefA', '4');
    await pick(undefined, /Synthetic cefA category/i, /^R\s—/);
    await userEvent.type(verBox(), 'M100-Ed36');
    await userEvent.click(reportBox('Synthetic cefA'));
    await save();
    expect((await lastHit('POST', /bulk-record$/)).json.entries[0]).toMatchObject({ antibiotic_code: 'syn_cef_a', raw_value: '4', category_code: 'R', standard: 'CLSI', standard_version: 'M100-Ed36', is_reportable: false });
  });
  it('a new Idempotency-Key per click (a second save is a new attempt)', async () => {
    api.use(bulkHandler());
    await mount();
    edit('Synthetic cefA', '4');
    await save();
    await waitFor(() => expect(bulk()).toHaveLength(1));
    edit('Synthetic cefA', '8');
    await waitFor(() => expect(saveBtn()!.hasAttribute('disabled')).toBe(false));
    await save();
    await waitFor(() => expect(bulk()).toHaveLength(2));
    expect(bulk()[0]!.headers.get('idempotency-key')).not.toBe(bulk()[1]!.headers.get('idempotency-key'));
  });
  it('a double click while the request is in flight sends one request', async () => {
    api.use(bulkHandler({}, 500));
    await mount();
    edit('Synthetic cefA', '4');
    const b = saveBtn()!;
    await userEvent.dblClick(b);
    await new Promise((r) => setTimeout(r, 800));
    expect(bulk()).toHaveLength(1);
  });
  it('more than 60 changed rows are sent as several requests of at most 60 entries (M12 cap), each with its own Idempotency-Key', async () => {
    api.use(bulkHandler());
    const ast = Array.from({ length: 65 }, (_, i) => astRow(i + 1, `syn_abx_${i + 1}`, `Synthetic abx ${i + 1}`, 'zone_diameter'));
    await mount(astIsolate({ ast }));
    for (let i = 1; i <= 65; i++) edit(`Synthetic abx ${i}`, String(10 + (i % 30)));
    await save();
    await waitFor(() => expect(bulk().length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(bulk().every((h) => h.json.entries.length >= 1 && h.json.entries.length <= 60)).toBe(true);
    expect(bulk().reduce((n, h) => n + h.json.entries.length, 0)).toBe(65);
    expect(new Set(bulk().map((h) => h.headers.get('idempotency-key'))).size).toBe(bulk().length);
  });
});

describe('success', () => {
  it('onSaved fires once, a status toast announces it, inputs keep their values and the grid is clean again', async () => {
    api.use(bulkHandler());
    const onSaved = vi.fn();
    const onDirtyChange = vi.fn();
    await mount(astIsolate(), { onSaved, onDirtyChange });
    edit('Synthetic cefA', '4');
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(rawBox('Synthetic cefA').value).toBe('4');
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
});

describe('per-row errors (03-APP-FLOW §4.5 step 6; 04-UI-UX §10): failed rows keep their input and show the error text inline', () => {
  const fail = async (code: string, field: string | undefined, setup?: () => Promise<void> | void, abx = 'syn_cef_a') => {
    api.use(bulkHandler({ [abx]: { code, ...(field ? { field } : {}) } }));
    const onSaved = vi.fn();
    const onDirtyChange = vi.fn();
    await mount(astIsolate(), { onSaved, onDirtyChange });
    edit('Synthetic cefA', '4');
    edit('Synthetic genB', '18'); // this row succeeds
    if (setup) await setup();
    await save();
    await waitFor(() => expect(bulk()).toHaveLength(1));
    return { onSaved, onDirtyChange };
  };
  const rowOf = (abx: string) => screen.getByRole('textbox', { name: new RegExp(`^${abx} raw value`, 'i') }).closest('[role="row"]') as HTMLElement;

  it('AC-06.2 micro.ast_value_invalid on a value: "Enter a value like 0.25, <=0.25 or 18." on that row, linked to its input; the other row is not marked', async () => {
    await fail('micro.ast_value_invalid', 'raw_value');
    await waitFor(() => expect(describedText(rawBox('Synthetic cefA'))).toMatch(MSG.value));
    expect(rawBox('Synthetic cefA').getAttribute('aria-invalid')).toBe('true');
    expect(rawBox('Synthetic cefA').value).toBe('4'); // input kept
    expect(rowOf('Synthetic genB').textContent).not.toMatch(MSG.value);
    expect(rawBox('Synthetic genB').getAttribute('aria-invalid')).not.toBe('true');
  });
  it('AC-06.3a micro.ast_value_invalid on a category (no raw value): "Enter the measured value before choosing a category."', async () => {
    api.use(bulkHandler({ syn_cef_a: { code: 'micro.ast_value_invalid', field: 'category_code' } }));
    await mount(astIsolate({ ast: [CEF, GEN, COL] }));
    await pick(undefined, /Synthetic cefA category/i, /^S\s—/);
    await userEvent.type(verBox(), 'M100-Ed36');
    await save();
    await waitFor(() => expect(bulk()).toHaveLength(1));
    await waitFor(() => expect(rowOf('Synthetic cefA').textContent).toMatch(MSG.needValue));
    expect(rowOf('Synthetic cefA').textContent).not.toMatch(MSG.value);
    expect(catBtn('Synthetic cefA').textContent).toMatch(/\bS\b/);
  });
  it('AC-06.3 micro.ast_standard_required: "Choose the standard and version for this category." linked to the category control', async () => {
    await fail('micro.ast_standard_required', 'category_code', async () => { await pick(undefined, /Synthetic cefA category/i, /^S\s—/); });
    await waitFor(() => expect(rowOf('Synthetic cefA').textContent).toMatch(MSG.standard));
    expect(describedText(catBtn('Synthetic cefA'))).toMatch(MSG.standard);
  });
  it('AC-06.4 / AC-06.5 micro.ast_category_not_allowed: "This category isn\'t allowed for this standard or antibiotic."', async () => {
    await fail('micro.ast_category_not_allowed', 'category_code', async () => { await pick(undefined, /Synthetic cefA category/i, /^S\s—/); });
    await waitFor(() => expect(rowOf('Synthetic cefA').textContent).toMatch(MSG.category));
    expect(describedText(catBtn('Synthetic cefA'))).toMatch(MSG.category);
  });
  it('AC-06.6 micro.antibiotic_not_in_panel: message names the way out; ticking "Add to isolate" and saving again sends add_to_isolate:true', async () => {
    await fail('micro.antibiotic_not_in_panel', 'antibiotic_code');
    await waitFor(() => expect(rowOf('Synthetic cefA').textContent).toMatch(MSG.panel));
    api.use(bulkHandler());
    const add = within(rowOf('Synthetic cefA')).getByRole('checkbox', { name: /add to isolate/i });
    await userEvent.click(add);
    await userEvent.click(saveBtn()!);
    await waitFor(() => expect(bulk()).toHaveLength(2));
    const e = bulk()[1]!.json.entries.find((x: { antibiotic_code: string }) => x.antibiotic_code === 'syn_cef_a');
    expect(e.add_to_isolate).toBe(true);
  });
  it('common.validation_failed (e.g. suggestion mismatch) -> "Check the values and try again." on that row', async () => {
    await fail('common.validation_failed', 'breakpoint_band_id');
    await waitFor(() => expect(rowOf('Synthetic cefA').textContent).toMatch(/Check the values and try again/));
  });
  it('common.version_conflict -> "Someone else changed this. Reload and try again." on that row', async () => {
    await fail('common.version_conflict', 'version');
    await waitFor(() => expect(rowOf('Synthetic cefA').textContent).toMatch(/Someone else changed this\. Reload and try again/));
  });
  it('an unknown per-entry code falls back to the generic text; the raw code is never shown', async () => {
    await fail('micro.something_new_and_internal', 'raw_value');
    await waitFor(() => expect(rowOf('Synthetic cefA').textContent).toMatch(/Something went wrong\. Try again\./));
    expect(document.body.textContent).not.toContain('micro.something_new_and_internal');
    expect(document.body.textContent).not.toContain('micro.ast_value_invalid');
  });
  it('partial success (03-APP-FLOW §6): the good row is committed (onSaved once, toast), the failed row keeps its input, the grid stays dirty', async () => {
    const { onSaved, onDirtyChange } = await fail('micro.ast_value_invalid', 'raw_value');
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(rawBox('Synthetic cefA').value).toBe('4');
    expect(rawBox('Synthetic genB').value).toBe('18');
    expect(onDirtyChange).not.toHaveBeenLastCalledWith(false);
  });
  it('fixing the failed value and saving again sends only that row, then the error is gone and the grid is clean', async () => {
    const { onDirtyChange } = await fail('micro.ast_value_invalid', 'raw_value');
    await waitFor(() => expect(describedText(rawBox('Synthetic cefA'))).toMatch(MSG.value));
    api.use(bulkHandler());
    edit('Synthetic cefA', '2');
    await waitFor(() => expect(describedText(rawBox('Synthetic cefA'))).not.toMatch(MSG.value)); // editing clears the stale error
    await userEvent.click(saveBtn()!);
    await waitFor(() => expect(bulk()).toHaveLength(2));
    expect(bulk()[1]!.json.entries.map((e: { antibiotic_code: string }) => e.antibiotic_code)).toEqual(['syn_cef_a']);
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });
  it('error text is plain text: a hostile code or path cannot inject markup', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/isolates/:id/ast-results/bulk-record`, () => HttpResponse.json({ results: [{ antibiotic_code: 'syn_cef_a', method: 'mic', outcome: 'error', code: '<img src=x onerror=alert(1)>', path: '/entries/0/raw_value' }] })));
    await mount();
    edit('Synthetic cefA', '4');
    await save();
    await waitFor(() => expect(bulk()).toHaveLength(1));
    await waitFor(() => expect(rowOf('Synthetic cefA').textContent).toMatch(/Something went wrong/));
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('whole-request failures keep every input', () => {
  const rejected = async (status: number, c: string) => {
    api.use(http.post(`${ORIGIN}/v1/micro/isolates/:id/ast-results/bulk-record`, () => problem(c, status)));
    const onSaved = vi.fn();
    const onDirtyChange = vi.fn();
    await mount(astIsolate(), { onSaved, onDirtyChange });
    edit('Synthetic cefA', '4');
    await save();
    await waitFor(() => expect(bulk()).toHaveLength(1));
    return { onSaved, onDirtyChange };
  };
  it('micro.report_final_locked -> "The final report has been sent. Reopen the culture to make changes."; input kept; nothing marked saved', async () => {
    const { onSaved, onDirtyChange } = await rejected(409, 'micro.report_final_locked');
    expect(await screen.findByText(/The final report has been sent\. Reopen the culture to make changes\./)).toBeTruthy();
    expect(rawBox('Synthetic cefA').value).toBe('4');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onDirtyChange).not.toHaveBeenLastCalledWith(false);
  });
  it('403 -> "You do not have permission to do this."; the button is usable again', async () => {
    await rejected(403, 'auth.forbidden');
    expect(await screen.findByText(/You do not have permission to do this\./)).toBeTruthy();
    await waitFor(() => expect(saveBtn()!.hasAttribute('disabled')).toBe(false));
  });
  it('500 -> generic text, no raw code, input kept, retry possible with a new Idempotency-Key', async () => {
    await rejected(500, 'common.internal');
    expect(await screen.findByText(/Something went wrong\. Try again\./)).toBeTruthy();
    expect(document.body.textContent).not.toContain('common.internal');
    expect(rawBox('Synthetic cefA').value).toBe('4');
    api.use(bulkHandler());
    await waitFor(() => expect(saveBtn()!.hasAttribute('disabled')).toBe(false));
    await userEvent.click(saveBtn()!);
    await waitFor(() => expect(bulk()).toHaveLength(2));
    expect(bulk()[0]!.headers.get('idempotency-key')).not.toBe(bulk()[1]!.headers.get('idempotency-key'));
  });
});

describe('unsaved-changes tracking (done_when: unsaved-changes guard; 03-APP-FLOW §6 Offline)', () => {
  it('onDirtyChange(true) on the first edit; back to the stored value -> onDirtyChange(false)', async () => {
    const onDirtyChange = vi.fn();
    await mount(astIsolate({ ast: [astRow(1, 'syn_cef_a', 'Synthetic cefA', 'mic', { raw_value: '4' })] }), { onDirtyChange });
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    edit('Synthetic cefA', '8');
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    edit('Synthetic cefA', '4');
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });
  it('a category pick and a Report toggle count as edits', async () => {
    const onDirtyChange = vi.fn();
    await mount(astIsolate(), { onDirtyChange });
    await userEvent.click(reportBox('Synthetic cefA'));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });
  it('the browser is warned on reload / close while dirty (beforeunload prevented), not when clean, and not after unmount', async () => {
    const { unmount } = await mount();
    const fire = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
    expect(fire()).toBe(false);
    edit('Synthetic cefA', '4');
    await waitFor(() => expect(fire()).toBe(true));
    unmount();
    expect(fire()).toBe(false);
  });
  it('editing never talks to the API by itself: no save, no preview for an unchanged blur', async () => {
    await mount();
    edit('Synthetic cefA', '4');
    await new Promise((r) => setTimeout(r, 500));
    expect(bulk()).toHaveLength(0);
  });
});

describe('REQ-SEC-098 / REQ-SEC-068', () => {
  it('no AST value or token reaches the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    api.use(bulkHandler({ syn_cef_a: { code: 'micro.ast_value_invalid' } }));
    await mount();
    edit('Synthetic cefA', '4');
    await save();
    await waitFor(() => expect(bulk()).toHaveLength(1));
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
    expect(logged).not.toMatch(/jwt-synthetic|Bearer|syn_cef_a/);
  });
});
