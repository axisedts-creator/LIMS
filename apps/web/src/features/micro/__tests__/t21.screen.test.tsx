// @vitest-environment jsdom
// C10.T-21 — the grid inside the culture page, tab "Isolates & AST" (04-UI-UX §3.3; 03-APP-FLOW §4.2, §4.5): selection, tenant standard, "Choose AST panel",
// Alt+A, the unsaved-changes ConfirmDialog "Discard unsaved AST changes?", permissions and culture states. LD-140 (2026-11-13): kit only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { CEF, GEN, ID, ORIGIN, PANEL, PERM_READ, PERM_WORK, api, astIsolate, bulkHandler, dialog, grid, hit, incubating, isolate, lastHit, panelHandler, pick, previewHandler, problem, rawBox, resetHits, router, rowAction, saveBtn, state } from './t21.harness';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.refresh.mockReset(); state.permissions = PERM_WORK; api.use(previewHandler(() => undefined), bulkHandler(), panelHandler()); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const A = ID(311);
const B = ID(312);
const two = (over: Record<string, unknown> = {}) => incubating({ isolates: [astIsolate({ id: A, isolate_seq: 1 }), astIsolate({ id: B, isolate_seq: 2, ast: [{ ...GEN, id: ID(499) }] })], ...over });
const mount = async (c: Record<string, unknown> = two(), permissions = PERM_WORK, tab: string | null = 'isolates') => {
  const { CultureScreen } = await import('../components/culture/CultureScreen');
  const r = render(<ToastProvider><CultureScreen culture={c as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={permissions} /></ToastProvider>);
  if (tab) await userEvent.click(screen.getByRole('tab', { name: /^isolates & ast/i }));
  return r;
};
const selectIsolate = async (n: number) => {
  const t = await screen.findByRole('grid', { name: /^isolates$/i });
  await userEvent.click(within(t).getAllByRole('row').slice(1).find((r) => new RegExp(`^${n}\\b`).test(r.textContent?.trim() ?? ''))!);
};
const astGrid = () => screen.queryByRole('grid', { name: /AST results for isolate/i });
const registered = async () => (await import('@/core/shortcuts/registry')).shortcuts.list('micro.culture');

describe('selection', () => {
  it('no isolate selected: no grid, a hint to select one', async () => {
    await mount();
    expect(astGrid()).toBeNull();
    expect(document.body.textContent).toMatch(/select an isolate/i);
  });
  it('selecting an isolate shows its grid ("AST results for isolate {isolate_seq}"); selecting another swaps the rows', async () => {
    await mount();
    await selectIsolate(1);
    expect(await screen.findByRole('grid', { name: 'AST results for isolate 1' })).toBeTruthy();
    expect(rawBox('Synthetic cefA')).toBeTruthy();
    await selectIsolate(2);
    expect(await screen.findByRole('grid', { name: 'AST results for isolate 2' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Synthetic cefA raw value/i })).toBeNull();
    expect(rawBox('Synthetic genB')).toBeTruthy();
  });
  it('values typed for isolate 1 do not leak into isolate 2 (and back)', async () => {
    await mount(two({ isolates: [astIsolate({ id: A, isolate_seq: 1 }), astIsolate({ id: B, isolate_seq: 2 })] }));
    await selectIsolate(1);
    await grid();
    fireEvent.change(rawBox('Synthetic cefA'), { target: { value: '4' } });
    await selectIsolate(2);
    await screen.findByRole('grid', { name: 'AST results for isolate 2' });
    expect(rawBox('Synthetic cefA').value).toBe('');
  });
  it('an isolate that is not identified has no grid (assignAstPanel needs an identified isolate)', async () => {
    await mount(incubating({ isolates: [isolate(1, { id: A, status: 'pending_id', organism_code: undefined, organism_display: undefined, organism_source: undefined })] }));
    await selectIsolate(1);
    expect(astGrid()).toBeNull();
  });
  it('an identified isolate without a panel: no grid, a "Choose AST panel" button in the pane (worker only)', async () => {
    await mount(incubating({ isolates: [isolate(1, { id: A })] }));
    await selectIsolate(1);
    expect(astGrid()).toBeNull();
    expect(screen.getAllByRole('button', { name: /choose ast panel/i }).length).toBeGreaterThan(0);
    cleanup();
    await mount(incubating({ isolates: [isolate(1, { id: A })] }), PERM_READ);
    await selectIsolate(1);
    expect(screen.queryAllByRole('button', { name: /choose ast panel/i })).toHaveLength(0);
  });
});

describe('tenant standard (settings.manual_ast_standard)', () => {
  it('the header standard defaults to the tenant setting, loaded through a server action (GET /v1/micro/settings)', async () => {
    await mount();
    await selectIsolate(1);
    await grid();
    await waitFor(() => expect(screen.getByRole('button', { name: /standard$/i }).textContent).toMatch(/CLSI/));
    expect(hit('GET', /\/v1\/micro\/settings$/).length).toBeGreaterThan(0);
  });
  it('no standard configured -> empty selector', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/settings`, () => HttpResponse.json({ id: ID(9), version: 1, zone_suggestion_enabled: true, mic_suggestion_enabled: false, default_final_no_growth_hours: 48, early_final_requires_reason: true, recent_window_days: 7, is_active: true })));
    await mount();
    await selectIsolate(1);
    await grid();
    await waitFor(() => expect(hit('GET', /\/v1\/micro\/settings$/).length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /standard$/i }).textContent).not.toMatch(/CLSI|EUCAST|ECOFF/);
  });
  it('a technologist who may not read settings (403) still gets a working grid with an empty standard', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/settings`, () => problem('auth.forbidden', 403)));
    await mount();
    await selectIsolate(1);
    await grid();
    await waitFor(() => expect(hit('GET', /\/v1\/micro\/settings$/).length).toBeGreaterThan(0));
    expect(rawBox('Synthetic cefA')).toBeTruthy();
    expect(screen.getByRole('button', { name: /standard$/i }).textContent).not.toMatch(/CLSI|EUCAST|ECOFF/);
  });
});

describe('after a save the culture is refreshed (the server owns the data)', () => {
  it('router.refresh() once when at least one entry was stored', async () => {
    await mount();
    await selectIsolate(1);
    await grid();
    fireEvent.change(rawBox('Synthetic cefA'), { target: { value: '4' } });
    await userEvent.click(saveBtn()!);
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });
});

describe('unsaved-changes guard: leaving the tab asks "Discard unsaved AST changes?"', () => {
  const dirty = async () => {
    await mount();
    await selectIsolate(1);
    await grid();
    fireEvent.change(rawBox('Synthetic cefA'), { target: { value: '4' } });
  };
  it('clean grid: leaving the tab is immediate, no dialog', async () => {
    await mount();
    await selectIsolate(1);
    await grid();
    await userEvent.click(screen.getByRole('tab', { name: /^setup & plates/i }));
    expect(screen.queryByText(/discard unsaved ast changes\?/i)).toBeNull();
    expect(screen.getByRole('tab', { name: /^setup & plates/i }).getAttribute('aria-selected')).toBe('true');
  });
  it('dirty grid: a ConfirmDialog appears and the tab does not change yet', async () => {
    await dirty();
    await userEvent.click(screen.getByRole('tab', { name: /^reads & stains/i }));
    expect(await screen.findByText(/discard unsaved ast changes\?/i)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^isolates & ast/i, hidden: true }).getAttribute('aria-selected')).toBe('true');
  });
  it('Cancel keeps the tab and the typed value', async () => {
    await dirty();
    await userEvent.click(screen.getByRole('tab', { name: /^reads & stains/i }));
    const d = await screen.findByRole('dialog');
    await userEvent.click(within(d).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText(/discard unsaved ast changes\?/i)).toBeNull());
    expect(screen.getByRole('tab', { name: /^isolates & ast/i }).getAttribute('aria-selected')).toBe('true');
    expect(rawBox('Synthetic cefA').value).toBe('4');
  });
  it('Discard leaves for the chosen tab; coming back shows the stored values, not the discarded edit', async () => {
    await dirty();
    await userEvent.click(screen.getByRole('tab', { name: /^reads & stains/i }));
    const d = await screen.findByRole('dialog');
    await userEvent.click(within(d).getByRole('button', { name: /^discard/i }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /^reads & stains/i }).getAttribute('aria-selected')).toBe('true'));
    await userEvent.click(screen.getByRole('tab', { name: /^isolates & ast/i }));
    await selectIsolate(1);
    await grid();
    expect(rawBox('Synthetic cefA').value).toBe('');
    expect(hit('POST', /bulk-record$/)).toHaveLength(0);
  });
  it('after a successful save the guard is gone', async () => {
    await dirty();
    await userEvent.click(saveBtn()!);
    await waitFor(() => expect(hit('POST', /bulk-record$/)).toHaveLength(1));
    await waitFor(() => expect(saveBtn()!.hasAttribute('disabled') || saveBtn()!.getAttribute('aria-disabled') === 'true').toBe(true));
    await userEvent.click(screen.getByRole('tab', { name: /^setup & plates/i }));
    expect(screen.queryByText(/discard unsaved ast changes\?/i)).toBeNull();
  });
});

describe('Alt+A: focus the AST grid of the selected isolate (04-UI-UX §3)', () => {
  const press = async () => { const s = (await registered()).find((x) => x.key === 'Alt+A'); expect(s).toBeTruthy(); act(() => s!.run()); };
  it('with an isolate selected: focus moves into the grid (first Raw value)', async () => {
    await mount();
    await selectIsolate(1);
    await grid();
    (document.activeElement as HTMLElement | null)?.blur();
    await press();
    await waitFor(() => expect(astGrid()!.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).toBe(rawBox('Synthetic cefA'));
  });
  it('from another tab: switches to Isolates & AST and focuses the grid of the selected isolate', async () => {
    await mount();
    await selectIsolate(1);
    await grid();
    await userEvent.click(screen.getByRole('tab', { name: /^setup & plates/i }));
    await press();
    await waitFor(() => expect(screen.getByRole('tab', { name: /^isolates & ast/i }).getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(document.activeElement).toBe(rawBox('Synthetic cefA')));
  });
  it('with nothing selected it opens the tab and does not throw', async () => {
    await mount(two(), PERM_WORK, null);
    await press();
    await waitFor(() => expect(screen.getByRole('tab', { name: /^isolates & ast/i }).getAttribute('aria-selected')).toBe('true'));
    expect(astGrid()).toBeNull();
  });
});

describe('permissions and culture state (03-APP-FLOW §4.2)', () => {
  it('read-only user: the grid shows values, no inputs are editable, no "Save AST"', async () => {
    await mount(two({ isolates: [astIsolate({ id: A, isolate_seq: 1, ast: [{ ...CEF, raw_value: '4' }] })] }), PERM_READ);
    await selectIsolate(1);
    await grid();
    expect(rawBox('Synthetic cefA').value).toBe('4');
    expect(rawBox('Synthetic cefA').disabled || rawBox('Synthetic cefA').readOnly).toBe(true);
    expect(saveBtn()).toBeNull();
    expect(screen.queryAllByRole('menuitem', { name: /choose ast panel/i })).toHaveLength(0);
  });
  it.each(['final_submitted', 'cancelled'])('culture %s: grid is view only (no edit, no "Save AST")', async (status) => {
    await mount(two({ status }));
    await selectIsolate(1);
    await grid();
    expect(rawBox('Synthetic cefA').disabled || rawBox('Synthetic cefA').readOnly).toBe(true);
    expect(saveBtn()).toBeNull();
  });
  it('one primary button on the page (LD-140): "Save AST" is not a second primary', async () => {
    await mount();
    await selectIsolate(1);
    await grid();
    const primary = screen.getAllByRole('button').filter((b) => /primary/.test(b.className) || b.getAttribute('data-variant') === 'primary');
    expect(primary.length).toBeLessThanOrEqual(1);
  });
});

describe('"Choose AST panel" (03-APP-FLOW §4.5 step 3; M11 assignAstPanel)', () => {
  const open = async (iso = isolate(1, { id: A, version: 3 })) => {
    await mount(incubating({ isolates: [iso] }));
    await screen.findByRole('grid', { name: /^isolates$/i });
    await rowAction(/Synthetic organism/, /choose ast panel/i);
    return dialog(/ast panel/i);
  };
  it('the panel list is read only when the dialog opens (GET /v1/micro/ast-panels), not at page load', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/ast-panels`, () => HttpResponse.json({ data: [{ id: ID(60), code: 'syn_panel', version_no: 2, display: 'Synthetic urine panel', default_method: 'mic', is_active: true }], page: { limit: 50 } })));
    await mount(incubating({ isolates: [isolate(1, { id: A, version: 3 })] }));
    expect(hit('GET', /\/ast-panels/)).toHaveLength(0);
    await rowAction(/Synthetic organism/, /choose ast panel/i);
    await dialog(/ast panel/i);
    await waitFor(() => expect(hit('GET', /\/ast-panels/).length).toBeGreaterThan(0));
  });
  it('Save without choosing: the server picks by precedence -> POST /ast-panel with {} body, Idempotency-Key and If-Match "<isolate version>"', async () => {
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /^save$/i }));
    const h = await lastHit('POST', PANEL);
    expect(h.path).toBe(`/v1/micro/isolates/${A}/ast-panel`);
    expect(h.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(h.headers.get('if-match')).toBe('"3"');
    expect(h.json ?? {}).toEqual({});
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('choosing a panel sends only { ast_panel_id } (S-05 strict body)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/ast-panels`, () => HttpResponse.json({ data: [{ id: ID(60), code: 'syn_panel', version_no: 2, display: 'Synthetic urine panel', default_method: 'mic', is_active: true }], page: { limit: 50 } })));
    const d = await open();
    await pick(d, /panel/i, /Synthetic urine panel/);
    await userEvent.click(within(d).getByRole('button', { name: /^save$/i }));
    const h = await lastHit('POST', PANEL);
    expect(h.json).toEqual({ ast_panel_id: ID(60) });
  });
  it('400 common.validation_failed (no panel matches, TRD §4.2): the dialog stays open with an alert and nothing is refreshed', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/isolates/:id/ast-panel`, () => problem('common.validation_failed', 400, { errors: [{ path: '/ast_panel_id', code: 'common.validation_failed', message: 'x' }] })));
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(hit('POST', PANEL)).toHaveLength(1));
    expect(await within(await dialog(/ast panel/i)).findByRole('alert')).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('409 micro.isolate_invalid_transition / micro.report_final_locked: dialog stays, copy from §10, no raw code', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/isolates/:id/ast-panel`, () => problem('micro.report_final_locked', 409)));
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /^save$/i }));
    expect(await within(await dialog(/ast panel/i)).findByText(/The final report has been sent\. Reopen the culture to make changes\./)).toBeTruthy();
    expect(document.body.textContent).not.toContain('micro.report_final_locked');
  });
  it('Cancel posts nothing; a double click on Save posts once', async () => {
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /cancel/i }));
    expect(hit('POST', PANEL)).toHaveLength(0);
    await rowAction(/Synthetic organism/, /choose ast panel/i);
    const d2 = await dialog(/ast panel/i);
    await userEvent.dblClick(within(d2).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(hit('POST', PANEL).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 300));
    expect(hit('POST', PANEL)).toHaveLength(1);
  });
  it('the row menu offers it for an identified isolate only (a pending isolate has no "Choose AST panel")', async () => {
    await mount(incubating({ isolates: [isolate(1, { id: A, status: 'pending_id', organism_code: undefined, organism_display: undefined, organism_source: undefined })] }));
    const t = await screen.findByRole('grid', { name: /^isolates$/i });
    const row = within(t).getAllByRole('row')[1]!;
    const btns = within(row).getAllByRole('button');
    await userEvent.click(btns[btns.length - 1]!);
    expect(screen.queryByRole('menuitem', { name: /choose ast panel/i })).toBeNull();
  });
});
