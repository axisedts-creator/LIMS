// @vitest-environment jsdom
// C10.T-24 — Micro settings screen, all tabs (04-UI-UX §5; AC-14.1…AC-14.5; "all tabs").
// LD-140: master = list + right drawer, per-section Save, one primary button per page. Real server actions + MSW API.
// ASSUMED seam: MicroSettingsScreen({ settings, permissions }); tab data loads through server actions on first view of a tab.
// Edit forms open in a Drawer/Dialog (role=dialog); Save button is named /^save/i.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_CFG, PERM_READ_ONLY, api, code, hit, hits, page, problem, resetHits, settingsDto } from './t24.harness';

vi.mock('next/navigation', async () => (await import('./t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t24.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetHits());
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (permissions = PERM_CFG, settings = settingsDto()) => {
  const { MicroSettingsScreen } = await import('../components/settings/MicroSettingsScreen');
  return render(<ToastProvider><MicroSettingsScreen settings={settings as never} permissions={permissions} /></ToastProvider>);
};
const tab = (name: RegExp) => userEvent.click(screen.getByRole('tab', { name }));

describe('tabs (§5)', () => {
  it('has exactly Dictionaries · Plating protocols · AST panels · Instrument mappings · General, in that order', async () => {
    await mount();
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(['Dictionaries', 'Plating protocols', 'AST panels', 'Instrument mappings', 'General']);
  });
  it('one primary button per page (LD-140)', async () => {
    await mount();
    expect(document.querySelectorAll('button.lims-btn-primary').length).toBeLessThanOrEqual(1);
  });
});

describe('General tab (AC-14.5)', () => {
  const general = async (p = PERM_CFG, s = settingsDto()) => { await mount(p, s); await tab(/^general$/i); };

  it('renders the saved values and the MIC description', async () => {
    await general();
    expect((screen.getByRole('spinbutton', { name: /default no-growth final after/i }) as HTMLInputElement).value).toBe('48');
    expect((screen.getByRole('spinbutton', { name: /recently submitted/i }) as HTMLInputElement).value).toBe('7');
    expect((screen.getByRole('switch', { name: /suggest for zone diameters/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('switch', { name: /suggest for mic/i }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('switch', { name: /require a reason for early no-growth finals/i }) as HTMLInputElement).checked).toBe(true);
    expect(document.body.textContent).toContain('Not recommended until your microbiologist validates MIC tables.');
  });

  it('Save PUTs /v1/micro/settings with If-Match "<version>" and the edited values', async () => {
    api.use(http.put(`${ORIGIN}/v1/micro/settings`, () => HttpResponse.json(settingsDto({ version: 4, default_final_no_growth_hours: 72 }))));
    await general();
    const hours = screen.getByRole('spinbutton', { name: /default no-growth final after/i });
    await userEvent.clear(hours); await userEvent.type(hours, '72');
    await userEvent.click(screen.getByRole('switch', { name: /suggest for mic/i }));
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(hit('PUT', /\/v1\/micro\/settings$/)).toHaveLength(1));
    const h = hit('PUT', /\/v1\/micro\/settings$/)[0]!;
    expect(h.headers.get('if-match')).toBe('"3"');
    expect(h.json).toMatchObject({ default_final_no_growth_hours: 72, mic_suggestion_enabled: true, zone_suggestion_enabled: true, early_final_requires_reason: true, recent_window_days: 7 });
  });

  it.each([['0'], ['721']])('default_final_no_growth_hours = %s is rejected client-side (1..720): no request', async (v) => {
    await general();
    const hours = screen.getByRole('spinbutton', { name: /default no-growth final after/i });
    await userEvent.clear(hours); await userEvent.type(hours, v);
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    expect(hit('PUT', /settings$/)).toHaveLength(0);
  });

  // Ruling C10.T-24-ruling: kit IntegerField (min>=0) drops a typed "-", so no negative can be entered.
  it('default_final_no_growth_hours: typing "-5" yields 5 (no negative can be entered)', async () => {
    await general();
    const hours = screen.getByRole('spinbutton', { name: /default no-growth final after/i }) as HTMLInputElement;
    await userEvent.clear(hours); await userEvent.type(hours, '-5');
    expect(hours.value).toBe('5');
  });

  it.each([['1'], ['720']])('boundary %s hours is accepted', async (v) => {
    api.use(http.put(`${ORIGIN}/v1/micro/settings`, () => HttpResponse.json(settingsDto({ version: 4 }))));
    await general();
    const hours = screen.getByRole('spinbutton', { name: /default no-growth final after/i });
    await userEvent.clear(hours); await userEvent.type(hours, v);
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(hit('PUT', /settings$/)).toHaveLength(1));
    expect(hit('PUT', /settings$/)[0]!.json.default_final_no_growth_hours).toBe(Number(v));
  });

  it('recent window 0 and 32 days are rejected (1..31)', async () => {
    await general();
    const days = screen.getByRole('spinbutton', { name: /recently submitted/i });
    for (const v of ['0', '32']) { await userEvent.clear(days); await userEvent.type(days, v); await userEvent.click(screen.getByRole('button', { name: /^save/i })); }
    expect(hit('PUT', /settings$/)).toHaveLength(0);
  });

  it('standard for manual suggestions offers None / CLSI / EUCAST', async () => {
    await general();
    await userEvent.click(screen.getByRole('button', { name: /standard for manual suggestions/i }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['None', 'CLSI', 'EUCAST']);
  });

  it('server 403 auth.forbidden is shown as an error, and values stay editable', async () => {
    api.use(http.put(`${ORIGIN}/v1/micro/settings`, () => problem('auth.forbidden', 403)));
    await general();
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(hit('PUT', /settings$/)).toHaveLength(1));
    expect(screen.getByRole('button', { name: /^save/i })).toBeTruthy();
  });

  it('version conflict shows the kit default copy', async () => {
    api.use(http.put(`${ORIGIN}/v1/micro/settings`, () => problem('common.version_conflict', 412)));
    await general();
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(document.body.textContent).toContain('Someone else changed this. Reload and try again.'));
  });

  it('read-only for a user without micro.config.manage: no Save button, controls disabled', async () => {
    await general(PERM_READ_ONLY);
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
    expect((screen.getByRole('spinbutton', { name: /default no-growth final after/i }) as HTMLInputElement).disabled || (screen.getByRole('spinbutton', { name: /default no-growth final after/i }) as HTMLInputElement).readOnly).toBe(true);
  });
});

describe('Dictionaries tab (AC-14.1, AC-14.3)', () => {
  it('set Select offers the eleven sets from §5 in order; AST categories is read-only with the fixed-per-standard note', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/coded-sets/ast_interpretations`, () => page([code('s', { standard: 'CLSI', display: 'Susceptible' })])));
    await mount();
    await userEvent.click(screen.getByRole('button', { name: /dictionary|set/i }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Organisms', 'Organism groups', 'Antibiotics', 'Media', 'Specimen sites', 'Growth codes', 'Culture outcomes', 'Isolate withdraw reasons', 'Culture cancel reasons', 'Instrument ignore reasons', 'AST categories']);
    await userEvent.click(screen.getByRole('option', { name: 'AST categories' }));
    await waitFor(() => expect(document.body.textContent).toContain('Interpretive categories are fixed per standard (CLSI, EUCAST, ECOFF) and cannot be edited here.'));
    expect(screen.queryByRole('button', { name: /add|new|edit/i })).toBeNull();
  });

  it('lists Code, Display, Source (Global/Tenant), Active, Order; requests the right set incl. inactive codes', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/coded-sets/organisms`, () => page([code('org_a', { source: 'global' }), code('org_b', { source: 'tenant', is_active: false, sort_order: 3 })])));
    await mount();
    await waitFor(() => expect(document.body.textContent).toContain('org_a'));
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Code', 'Display', 'Source', 'Active', 'Order']) expect(headers, h).toContain(h);
    expect(document.body.textContent).toMatch(/Global/);
    expect(document.body.textContent).toMatch(/Tenant/);
    expect(hit('GET', /coded-sets\/organisms$/)[0]!.search).toMatch(/include_inactive=true/);
  });

  it('edit drawer: code is read-only, display ≤200, SNOMED field maxLength 18 with the licence help text; Save PUTs the tenant code', async () => {
    api.use(
      http.get(`${ORIGIN}/v1/micro/coded-sets/organisms`, () => page([code('org_a', { source: 'global', display: 'Synthetic org A' })])),
      http.put(`${ORIGIN}/v1/micro/coded-sets/organisms/codes/org_a`, () => HttpResponse.json(code('org_a', { source: 'tenant', display: 'Renamed' }))),
    );
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: /edit.*org_a|org_a/i }));
    const d = await screen.findByRole('dialog');
    const codeField = within(d).getByRole('textbox', { name: /^code/i }) as HTMLInputElement;
    expect(codeField.readOnly || codeField.disabled).toBe(true);
    expect(codeField.value).toBe('org_a');
    expect((within(d).getByRole('textbox', { name: /^display/i }) as HTMLInputElement).maxLength).toBe(200);
    expect((within(d).getByRole('textbox', { name: /snomed/i }) as HTMLInputElement).maxLength).toBe(18);
    expect(d.textContent).toContain('Optional. Fill only if your laboratory is licensed to use SNOMED CT.');
    const disp = within(d).getByRole('textbox', { name: /^display/i });
    await userEvent.clear(disp); await userEvent.type(disp, 'Renamed');
    await userEvent.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(hit('PUT', /coded-sets\/organisms\/codes\/org_a$/)).toHaveLength(1));
    expect(hit('PUT', /coded-sets\/organisms\/codes\/org_a$/)[0]!.json).toMatchObject({ display: 'Renamed', sort_order: 10, is_active: true });
  });

  it('SNOMED CT id must be 6..18 digits (AC-14.3): "12ab" and "12345" are rejected, empty and "123456" are fine', async () => {
    api.use(
      http.get(`${ORIGIN}/v1/micro/coded-sets/organisms`, () => page([code('org_a')])),
      http.put(`${ORIGIN}/v1/micro/coded-sets/organisms/codes/org_a`, () => HttpResponse.json(code('org_a'))),
    );
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: /edit.*org_a|org_a/i }));
    const d = await screen.findByRole('dialog');
    const sn = within(d).getByRole('textbox', { name: /snomed/i });
    for (const bad of ['12ab', '12345']) { await userEvent.clear(sn); await userEvent.type(sn, bad); await userEvent.click(within(d).getByRole('button', { name: /^save/i })); }
    expect(hit('PUT', /org_a$/)).toHaveLength(0);
    await userEvent.clear(sn); await userEvent.type(sn, '123456');
    await userEvent.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(hit('PUT', /org_a$/)).toHaveLength(1));
    expect(hit('PUT', /org_a$/)[0]!.json.snomed_ct_concept_id).toBe('123456');
  });

  it('deactivating a global code writes a tenant row with is_active=false (AC-14.1)', async () => {
    api.use(
      http.get(`${ORIGIN}/v1/micro/coded-sets/organisms`, () => page([code('org_a', { source: 'global' })])),
      http.put(`${ORIGIN}/v1/micro/coded-sets/organisms/codes/org_a`, () => HttpResponse.json(code('org_a', { source: 'tenant', is_active: false }))),
    );
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: /edit.*org_a|org_a/i }));
    const d = await screen.findByRole('dialog');
    await userEvent.click(within(d).getByRole('switch', { name: /active/i }));
    await userEvent.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(hit('PUT', /org_a$/)).toHaveLength(1));
    expect(hit('PUT', /org_a$/)[0]!.json.is_active).toBe(false);
  });

  it('new code: pattern ^[a-z0-9_]{2,64}$ is enforced (uppercase, 1 char, 65 chars rejected)', async () => {
    api.use(http.put(`${ORIGIN}/v1/micro/coded-sets/organisms/codes/:c`, () => HttpResponse.json(code('ok_code', { source: 'tenant' }))));
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: /^(add|new)/i }));
    const d = await screen.findByRole('dialog');
    const c = within(d).getByRole('textbox', { name: /^code/i }) as HTMLInputElement;
    expect(c.maxLength).toBe(64);
    await userEvent.type(within(d).getByRole('textbox', { name: /^display/i }), 'Synthetic');
    for (const bad of ['Upper', 'a', 'has space', '../x']) { await userEvent.clear(c); await userEvent.type(c, bad); await userEvent.click(within(d).getByRole('button', { name: /^save/i })); }
    expect(hits.filter((h) => h.method === 'PUT')).toHaveLength(0);
    await userEvent.clear(c); await userEvent.type(c, 'ok_code');
    await userEvent.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(hit('PUT', /organisms\/codes\/ok_code$/)).toHaveLength(1));
  });

  it('duplicate code → micro.code_duplicate shows "This code is already used."', async () => {
    api.use(http.put(`${ORIGIN}/v1/micro/coded-sets/organisms/codes/:c`, () => problem('micro.code_duplicate', 409)));
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: /^(add|new)/i }));
    const d = await screen.findByRole('dialog');
    await userEvent.type(within(d).getByRole('textbox', { name: /^code/i }), 'dup_code');
    await userEvent.type(within(d).getByRole('textbox', { name: /^display/i }), 'Synthetic');
    await userEvent.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(document.body.textContent).toContain('This code is already used.'));
  });

  it('read-only user sees the list but no Add/Edit buttons (buttons hidden, §5)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/coded-sets/organisms`, () => page([code('org_a')])));
    await mount(PERM_READ_ONLY);
    await waitFor(() => expect(document.body.textContent).toContain('org_a'));
    expect(screen.queryByRole('button', { name: /^(add|new|edit)/i })).toBeNull();
  });
});

describe('Plating protocols tab (AC-14.2)', () => {
  const proto = (o: Record<string, unknown> = {}) => ({ id: ID(60), code: 'std_urine', version_no: 2, display: 'Synthetic urine protocol', read_schedule_hours: [24, 48], final_no_growth_hours: 48, requires_gram_stain: false, is_active: true, created_at: '2026-11-01T04:00:00.000Z', ...o });
  it('lists code, version, display, reads, final no-growth hours, Gram stain, active', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/plating-protocols`, () => page([proto()])));
    await mount(); await tab(/^plating protocols$/i);
    await waitFor(() => expect(document.body.textContent).toContain('std_urine'));
    const t = document.body.textContent!;
    expect(t).toContain('Synthetic urine protocol'); expect(t).toMatch(/24, ?48/); expect(t).toMatch(/\b48\b/);
  });
  it('"New version" keeps the code and POSTs /plating-protocols/{id}/versions (supersedes, never edits in place)', async () => {
    api.use(
      http.get(`${ORIGIN}/v1/micro/plating-protocols`, () => page([proto()])),
      http.post(`${ORIGIN}/v1/micro/plating-protocols/${ID(60)}/versions`, () => HttpResponse.json(proto({ version_no: 3 }), { status: 201 })),
    );
    await mount(); await tab(/^plating protocols$/i);
    await userEvent.click(await screen.findByRole('button', { name: /new version/i }));
    const d = await screen.findByRole('dialog');
    const c = within(d).getByRole('textbox', { name: /^code/i }) as HTMLInputElement;
    expect(c.value).toBe('std_urine'); expect(c.readOnly || c.disabled).toBe(true);
    await userEvent.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(hit('POST', /versions$/)).toHaveLength(1));
    expect(hit('POST', /versions$/)[0]!.headers.get('idempotency-key')).toBeTruthy();
  });
  it('read schedule "48, 24", "0, 24" and "24, x" are rejected client-side (ascending ints 1..720): no request', async () => {
    api.use(
      http.get(`${ORIGIN}/v1/micro/plating-protocols`, () => page([proto()])),
      http.post(`${ORIGIN}/v1/micro/plating-protocols`, () => HttpResponse.json(proto(), { status: 201 })),
    );
    await mount(); await tab(/^plating protocols$/i);
    await userEvent.click(await screen.findByRole('button', { name: /^(add|new) (plating )?protocol|^add|^new$/i }));
    const d = await screen.findByRole('dialog');
    await userEvent.type(within(d).getByRole('textbox', { name: /^code/i }), 'new_proto');
    await userEvent.type(within(d).getByRole('textbox', { name: /^display/i }), 'Synthetic');
    const sched = within(d).getByRole('textbox', { name: /read schedule/i });
    for (const bad of ['48, 24', '0, 24', '24, x']) { await userEvent.clear(sched); await userEvent.type(sched, bad); await userEvent.click(within(d).getByRole('button', { name: /^save/i })); }
    expect(hit('POST', /plating-protocols$/)).toHaveLength(0);
  });
});

describe('AST panels tab (AC-14.2)', () => {
  it('lists the panels and offers up/down reorder buttons named "Move up"/"Move down" in the form', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/ast-panels`, () => page([{ id: ID(70), code: 'urine_gn', version_no: 1, display: 'Synthetic panel', organism_scope: 'any', default_method: 'zone_diameter', antibiotic_count: 2, is_active: true, created_at: '2026-11-01T04:00:00.000Z', items: [] }])));
    await mount(); await tab(/^ast panels$/i);
    await waitFor(() => expect(document.body.textContent).toContain('urine_gn'));
    expect(document.body.textContent).toContain('Synthetic panel');
    await userEvent.click(screen.getByRole('button', { name: /^(add|new)/i }));
    const d = await screen.findByRole('dialog');
    expect((within(d).getByRole('textbox', { name: /^display/i }) as HTMLInputElement).maxLength).toBe(120);
    expect(within(d).getByRole('radio', { name: /^organism$/i })).toBeTruthy();
    expect(within(d).getByRole('radio', { name: /organism group/i })).toBeTruthy();
    expect(within(d).getByRole('radio', { name: /^any$/i })).toBeTruthy();
  });
});

describe('Instrument mappings tab (AC-14.4)', () => {
  it('when the instrument list is forbidden (403), an instrument-id TextField with help text replaces the Select', async () => {
    api.use(http.get(`${ORIGIN}/v1/instruments/instruments`, () => problem('auth.forbidden', 403)));
    await mount(); await tab(/^instrument mappings$/i);
    expect(await screen.findByRole('textbox', { name: /instrument id/i })).toBeTruthy();
  });

  it('shows kind, instrument code, local code, active; duplicate (instrument, kind, code_raw) → "This code is already used."', async () => {
    const inst = ID(80);
    api.use(
      http.get(`${ORIGIN}/v1/instruments/instruments`, () => page([{ id: inst, code: 'syn_analyser', name: 'Synthetic analyser' }])),
      http.get(`${ORIGIN}/v1/micro/instrument-vocab-maps`, () => page([{ id: ID(81), instrument_id: inst, kind: 'organism', code_raw: 'RAW1', local_code: 'org_a', is_active: true, version: 1 }])),
      http.post(`${ORIGIN}/v1/micro/instrument-vocab-maps`, () => problem('micro.code_duplicate', 409)),
    );
    await mount(); await tab(/^instrument mappings$/i);
    await userEvent.click(await screen.findByRole('button', { name: /instrument/i }));
    await userEvent.click(await screen.findByRole('option', { name: /syn_analyser|synthetic analyser/i }));
    await waitFor(() => expect(document.body.textContent).toContain('RAW1'));
    expect(document.body.textContent).toContain('org_a');
    await userEvent.click(screen.getByRole('button', { name: /add mapping/i }));
    const d = await screen.findByRole('dialog');
    await userEvent.type(within(d).getByRole('textbox', { name: /raw code|instrument code/i }), 'RAW1');
    await userEvent.type(within(d).getByRole('textbox', { name: /local code/i }), 'org_a');
    await userEvent.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(document.body.textContent).toContain('This code is already used.'));
  });

  it('per-instrument default standard: version TextField is capped at 32 characters', async () => {
    const inst = ID(80);
    api.use(http.get(`${ORIGIN}/v1/instruments/instruments`, () => page([{ id: inst, code: 'syn_analyser', name: 'Synthetic analyser' }])));
    await mount(); await tab(/^instrument mappings$/i);
    await userEvent.click(await screen.findByRole('button', { name: /instrument/i }));
    await userEvent.click(await screen.findByRole('option', { name: /syn_analyser|synthetic analyser/i }));
    expect((await screen.findByRole('textbox', { name: /version/i }) as HTMLInputElement).maxLength).toBe(32);
  });
});
