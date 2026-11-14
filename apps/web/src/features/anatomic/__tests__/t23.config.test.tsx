// @vitest-environment jsdom
// C11.T-23 — Configuration page /anatomic/config (04-UI-UX §4.7, §8; AC-08.3, AC-08.4 (list), AC-14.1, AC-14.2, AC-14.3, AC-14.4 UI side; REQ-SEC-062/067/081/088/100 — config writes need anatomic.config.manage at aal2).
// LD-140 (2026-11-13): kit components only, one primary button per page, every status shows tone + icon + word; masters = list + right Drawer + per-section Save.
// Page, tab ids, request shapes and error copy are pinned in the header of t23.harness.tsx. Kit Select = button whose name CONTAINS the label (ruling C11.T-22): selectors here are un-anchored and scoped with within().
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { IDEM_RE, ID, ORIGIN, PERM_CONFIG, PERM_WORK, TEST_X, TEST_Y, api, assayRow, hit, hits, page, problem, resetHits, router, state, stains, t23Defaults, tplSummary } from './t23.harness';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); state.permissions = PERM_CONFIG; api.use(...t23Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const configPage = async (sp: Record<string, string | string[] | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/anatomic/config/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const text = () => document.body.textContent ?? '';
const dialog = () => screen.getByRole('dialog');
const btn = (re: RegExp, scope: HTMLElement = document.body) => within(scope).getByRole('button', { name: re }) as HTMLButtonElement;
const rows = () => screen.getAllByRole('row').filter((r) => !within(r).queryAllByRole('columnheader').length);
const row = (re: RegExp) => screen.getAllByRole('row').find((r) => re.test(r.textContent ?? ''))!;
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
/** textbox / spinbutton / combobox-input by accessible name, or a labelled input. */
const input = (scope: HTMLElement, re: RegExp) => ([...within(scope).queryAllByRole('textbox', { name: re }), ...within(scope).queryAllByRole('spinbutton', { name: re })][0] ?? within(scope).getByLabelText(re)) as HTMLInputElement;
const type = async (scope: HTMLElement, re: RegExp, v: string) => { const el = input(scope, re); await userEvent.clear(el); if (v) await userEvent.type(el, v); };
const sw = (scope: HTMLElement, re: RegExp) => within(scope).getByRole('switch', { name: re }) as HTMLInputElement;
const checked = (el: HTMLElement) => (el.getAttribute('aria-checked') ?? String((el as HTMLInputElement).checked)) === 'true';
const sent = (method: string, re: RegExp) => hit(method, re);
const last = (method: string, re: RegExp) => { const h = sent(method, re); return h[h.length - 1]!; };
const nonGet = () => hits.filter((h) => h.method !== 'GET' && h.method !== 'HEAD');
const axeRun = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);

describe('access (AC-14.4 UI side)', () => {
  it('a lab technologist (anatomic.case.work, no anatomic.config.manage): no-access state, no tabs, no request that writes', async () => {
    state.permissions = PERM_WORK;
    await configPage();
    expect(text()).toMatch(/permission/i);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
    expect(nonGet()).toHaveLength(0);
  });

  it('with anatomic.config.manage: the seven tabs in spec order, Settings selected', async () => {
    await configPage();
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(['Settings', 'Stains', 'Test profiles', 'Assays', 'Coded lists', 'Synoptic templates', 'Text templates']);
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true');
  });

  it('the page is titled "Pathology setup" (nav label, 04-UI-UX §1)', async () => {
    await configPage();
    expect(screen.getByRole('heading', { level: 1, name: /pathology setup/i })).toBeTruthy();
  });

  it.each([['Stains', 'stains'], ['Test profiles', 'test-profiles'], ['Assays', 'assays'], ['Coded lists', 'coded-lists'], ['Synoptic templates', 'templates'], ['Text templates', 'text-templates']])('choosing "%s" -> /anatomic/config?tab=%s', async (name, id) => {
    await configPage();
    await userEvent.click(screen.getByRole('tab', { name }));
    expect(router.push).toHaveBeenCalledWith(`/anatomic/config?tab=${id}`);
  });

  it('?tab=<unknown / array> falls back to Settings (nothing user-controlled reaches the API)', async () => {
    await configPage({ tab: 'x/../../admin' });
    cleanup();
    await configPage({ tab: ['stains', 'assays'] });
    expect(hit('GET', /^\/v1\/anatomic\/settings$/).length).toBeGreaterThan(0);
    expect(hits.every((h) => /^\/v1\/(anatomic|catalog)\/(settings|stains)$/.test(h.path))).toBe(true);
  });

  it('403 from the API read -> no-access state: no tabs, no configuration data', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/settings`, () => problem('auth.forbidden', 403)));
    await configPage();
    expect(text()).toMatch(/permission/i);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it.each([500, 503])('%i from the API rejects so error.tsx renders (no partial form)', async (status) => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/settings`, () => problem('common.internal', status)));
    await expect(configPage()).rejects.toBeTruthy();
  });

  it('a 403 auth.forbidden on a write (direct call by a user who lost the permission) shows a permission message and keeps the form', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/settings`, () => problem('auth.forbidden', 403)));
    await configPage();
    await type(document.body, /max images per case/i, '25');
    await userEvent.click(btn(/^save$/i));
    expect(await screen.findByText(/permission/i)).toBeTruthy();
    expect(input(document.body, /max images per case/i).value).toBe('25');
  });
});

describe('settings tab (K1/K2; AC-14.2 default routine stain)', () => {
  it('shows the stored values in kit controls', async () => {
    await configPage();
    expect(checked(sw(document.body, /auto-accession/i))).toBe(true);
    expect(checked(sw(document.body, /complete gross/i))).toBe(true);
    expect(input(document.body, /max images per case/i).value).toBe('20');
    expect(input(document.body, /max images per report/i).value).toBe('4');
    expect(btn(/default routine stain/i).textContent).toContain('Synthetic HE');
  });

  it('the default routine stain list offers only ACTIVE ROUTINE stains (HE, PAP); special and inactive stains are absent', async () => {
    await configPage();
    await userEvent.click(btn(/default routine stain/i));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(expect.arrayContaining(['Synthetic HE', 'Synthetic PAP']));
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('[Save] sends PUT /settings with exactly the five contract fields, If-Match "3" and no Idempotency-Key', async () => {
    await configPage();
    await type(document.body, /max images per case/i, '30');
    await userEvent.click(sw(document.body, /auto-accession/i));
    await userEvent.click(btn(/^save$/i));
    const [h, ...rest] = sent('PUT', /^\/v1\/anatomic\/settings$/);
    expect(rest).toHaveLength(0);
    expect(h!.json).toEqual({ auto_accession_on_receipt: false, require_gross_complete_for_processing: true, default_routine_stain_code: 'HE', max_images_per_case: 30, max_report_images: 4 });
    expect(h!.headers.get('if-match')).toBe('"3"');
    expect(h!.headers.get('idempotency-key')).toBeNull();
    expect(await screen.findByText(/saved/i)).toBeTruthy();
  });

  it('changing the default routine stain sends its CODE (PAP), not the display text', async () => {
    await configPage();
    await choose(document.body, /default routine stain/i, /Synthetic PAP/);
    await userEvent.click(btn(/^save$/i));
    expect(last('PUT', /\/settings$/).json.default_routine_stain_code).toBe('PAP');
  });

  it('out-of-range numbers never reach the API: images per case 1-200, per report 0-24', async () => {
    await configPage();
    await type(document.body, /max images per case/i, '999');
    await type(document.body, /max images per report/i, '99');
    await userEvent.click(btn(/^save$/i));
    for (const h of sent('PUT', /\/settings$/)) {
      expect(h.json.max_images_per_case).toBeGreaterThanOrEqual(1);
      expect(h.json.max_images_per_case).toBeLessThanOrEqual(200);
      expect(h.json.max_report_images).toBeGreaterThanOrEqual(0);
      expect(h.json.max_report_images).toBeLessThanOrEqual(24);
    }
  });

  it('409 common.version_conflict -> warning Banner with [Reload] that refreshes the page', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/settings`, () => problem('common.version_conflict', 409)));
    await configPage();
    await type(document.body, /max images per case/i, '31');
    await userEvent.click(btn(/^save$/i));
    expect(await screen.findByText(/changed by someone else/i)).toBeTruthy();
    await userEvent.click(btn(/^reload$/i));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('403 auth.mfa_required (aal2 needed for config writes) -> step-up dialog with [Verify now]', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/settings`, () => problem('auth.mfa_required', 403)));
    await configPage();
    await type(document.body, /max images per case/i, '31');
    await userEvent.click(btn(/^save$/i));
    expect(await screen.findByText('This action needs two-factor verification.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /verify now/i })).toBeTruthy();
  });

  it('400 common.validation_failed shows the server message', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/settings`, () => problem('common.validation_failed', 400, { detail: 'Choose an active routine stain.', errors: [{ path: '/default_routine_stain_code', message: 'Choose an active routine stain.' }] })));
    await configPage();
    await type(document.body, /max images per case/i, '31');
    await userEvent.click(btn(/^save$/i));
    expect(await screen.findByText(/Choose an active routine stain\./)).toBeTruthy();
  });

  it('exactly one primary button on the page (LD-140) and no axe violations', async () => {
    await configPage();
    expect(document.querySelectorAll('.lims-btn-primary').length).toBe(1);
    expect(await axeRun()).toEqual([]);
  });
});

describe('stains tab (K3/K4/K5; AC-14.2)', () => {
  const open = () => configPage({ tab: 'stains' });

  it('columns Code, Name, Kind, Add-on test, Active; one row per stain incl. inactive ones; status = tone + icon + word', async () => {
    await open();
    for (const h of ['Code', 'Name', 'Kind', 'Add-on test', 'Active']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }), h).toBeTruthy();
    expect(rows()).toHaveLength(4);
    const ck7 = row(/CK7/);
    expect(ck7.textContent).toContain('Inactive');
    expect(ck7.querySelector('[data-tone] svg, [data-tone] [aria-hidden=true]')).toBeTruthy();
    expect(row(/PAS/).textContent).toContain('Active');
  });

  it('empty: "No stains yet." with an [Add stain] action', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/stains`, () => page([])));
    await open();
    expect(text()).toContain('No stains yet.');
    expect(btn(/add stain/i)).toBeTruthy();
  });

  it('[Add stain] -> right Drawer; Save POSTs {code, display, kind, sort_order} with an Idempotency-Key and no If-Match', async () => {
    await open();
    await userEvent.click(btn(/add stain/i));
    const d = dialog();
    expect(input(d, /^code/i).getAttribute('maxlength')).toBe('32');
    await type(d, /^code/i, 'MASSON');
    await type(d, /^name/i, 'Synthetic Masson');
    await choose(d, /kind/i, /^special/i);
    await type(d, /sort order/i, '7');
    await userEvent.click(btn(/^save$/i, d));
    const [h, ...rest] = sent('POST', /^\/v1\/anatomic\/stains$/);
    expect(rest).toHaveLength(0);
    expect(h!.json).toEqual({ code: 'MASSON', display: 'Synthetic Masson', kind: 'special', sort_order: 7 });
    expect(h!.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(h!.headers.get('if-match')).toBeNull();
  });

  it.each(['masson', 'MASS ON', 'MASS-ON'])('stain code %j is rejected in the form (^[A-Z0-9_]{1,32}$): nothing is sent', async (code) => {
    await open();
    await userEvent.click(btn(/add stain/i));
    const d = dialog();
    await type(d, /^code/i, code);
    await type(d, /^name/i, 'Synthetic');
    await userEvent.click(btn(/^save$/i, d));
    expect(sent('POST', /\/stains$/)).toHaveLength(0);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('edit: the code is read-only; Save PUTs {display, kind, sort_order, is_active} with If-Match "2" (no code, no id, no Idempotency-Key)', async () => {
    await open();
    await userEvent.click(btn(/edit/i, row(/PAS/)));
    const d = dialog();
    const code = within(d).queryAllByRole('textbox', { name: /^code/i })[0] as HTMLInputElement | undefined;
    if (code) expect(code.readOnly || code.disabled).toBe(true);
    await type(d, /^name/i, 'Synthetic PAS renamed');
    await userEvent.click(btn(/^save$/i, d));
    const h = last('PUT', /\/stains\/[^/]+$/);
    expect(h.json).toEqual({ display: 'Synthetic PAS renamed', kind: 'special', sort_order: 1, is_active: true });
    expect(h.headers.get('if-match')).toBe('"2"');
    expect(h.headers.get('idempotency-key')).toBeNull();
  });

  it('AC-14.2: deactivating the default routine stain -> 400 common.validation_failed: "Choose another default routine stain first" is shown and the drawer stays open', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/stains/:id`, () => problem('common.validation_failed', 400, { detail: 'Choose another default routine stain first', errors: [{ path: '/is_active', message: 'Choose another default routine stain first' }] })));
    await open();
    await userEvent.click(btn(/edit/i, row(/\bHE\b/)));
    const d = dialog();
    await userEvent.click(sw(d, /active/i));
    await userEvent.click(btn(/^save$/i, d));
    expect(await screen.findByText(/Choose another default routine stain first/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('403 auth.mfa_required on a stain write -> step-up dialog', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/stains`, () => problem('auth.mfa_required', 403)));
    await open();
    await userEvent.click(btn(/add stain/i));
    const d = dialog();
    await type(d, /^code/i, 'MASSON');
    await type(d, /^name/i, 'Synthetic Masson');
    await userEvent.click(btn(/^save$/i, d));
    expect(await screen.findByText('This action needs two-factor verification.')).toBeTruthy();
  });

  it('axe: list and open drawer have no violations', async () => {
    await open();
    expect(await axeRun()).toEqual([]);
    await userEvent.click(btn(/add stain/i));
    expect(await axeRun()).toEqual([]);
  });
});

describe('test profiles tab (K6/K7; AC-14.1)', () => {
  const open = () => configPage({ tab: 'test-profiles' });

  it('columns Test, Case kind, Add-on, Requires gross, Default stain, Default synoptic templates, Active', async () => {
    await open();
    for (const h of ['Test', 'Case kind', 'Add-on', 'Requires gross', 'Default stain', 'Default synoptic templates', 'Active']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }), h).toBeTruthy();
    expect(row(/Synthetic biopsy/).textContent).toMatch(/Histology/i);
    expect(row(/Synthetic biopsy/).textContent).toContain('syn_colon');
  });

  it('the catalog is asked for tests with workflow_type anatomic AND molecular (catalog.test.read); a test without a profile is listed as "Not configured"', async () => {
    await open();
    const wf = hit('GET', /^\/v1\/catalog\/tests$/).map((h) => new URLSearchParams(h.search).get('workflow_type')).sort();
    expect(wf).toEqual(['anatomic', 'molecular']);
    expect(row(/Synthetic panel/).textContent).toMatch(/Not configured/i);
  });

  it('AC-14.1: case kind -> Cytology, default stain -> PAS: PUT /test-profiles/{test_id} with the full body and If-Match "4"', async () => {
    await open();
    await userEvent.click(btn(/edit/i, row(/Synthetic biopsy/)));
    const d = dialog();
    await choose(d, /case kind/i, /^cytology/i);
    await choose(d, /default stain/i, /Synthetic PAS/);
    await userEvent.click(btn(/^save$/i, d));
    const h = last('PUT', new RegExp(`/test-profiles/${TEST_X}$`));
    expect(h.json).toEqual({ case_kind: 'cytology', is_addon: false, requires_gross: true, default_stain_code: 'PAS', default_synoptic_template_keys: ['syn_colon'], is_active: true });
    expect(h.headers.get('if-match')).toBe('"4"');
    expect(h.headers.get('idempotency-key')).toBeNull();
  });

  it('a test without a profile: Save creates it with If-Match "0"', async () => {
    await open();
    await userEvent.click(btn(/edit|configure|set up/i, row(/Synthetic panel/)));
    const d = dialog();
    await choose(d, /case kind/i, /^molecular/i);
    await userEvent.click(btn(/^save$/i, d));
    const h = last('PUT', new RegExp(`/test-profiles/${TEST_Y}$`));
    expect(h.headers.get('if-match')).toBe('"0"');
    expect(h.json.case_kind).toBe('molecular');
    expect(Object.keys(h.json).sort()).toEqual(expect.arrayContaining(['case_kind', 'is_active', 'is_addon', 'requires_gross']));
  });

  it('the default synoptic templates picker is fed by PUBLISHED templates only (GET /synoptic-templates?status=published)', async () => {
    await open();
    await userEvent.click(btn(/edit/i, row(/Synthetic biopsy/)));
    const g = hit('GET', /^\/v1\/anatomic\/synoptic-templates$/);
    expect(g.length).toBeGreaterThan(0);
    expect(new URLSearchParams(g[0]!.search).get('status')).toBe('published');
  });

  it('400 (catalog says the test is not anatomic/molecular) shows the server message and keeps the drawer', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/test-profiles/:id`, () => problem('common.validation_failed', 400, { detail: 'This test is not an anatomic or molecular test.' })));
    await open();
    await userEvent.click(btn(/edit/i, row(/Synthetic biopsy/)));
    await userEvent.click(btn(/^save$/i, dialog()));
    expect(await screen.findByText(/not an anatomic or molecular test/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a failing catalog call still lists the existing profiles (the tab does not crash)', async () => {
    api.use(http.get(`${ORIGIN}/v1/catalog/tests`, () => problem('auth.forbidden', 403)));
    await open();
    expect(row(/Synthetic biopsy/)).toBeTruthy();
  });
});

describe('assays tab (K8/K9/K10)', () => {
  const open = () => configPage({ tab: 'assays' });

  it('columns Code, Name, Targets, Active; a row per assay with the target count', async () => {
    await open();
    for (const h of ['Code', 'Name', 'Targets', 'Active']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }), h).toBeTruthy();
    expect(hit('GET', /\/assays$/).some((g) => new URLSearchParams(g.search).get('include_inactive') === 'true')).toBe(true);
    expect(row(/SYN_PCR_A/).textContent).toMatch(/\b2\b/);
  });

  it('editor Drawer: code is read-only, nested targets (T1, T2) and their result values are listed, and the copy says codes cannot be deleted', async () => {
    await open();
    await userEvent.click(btn(/edit/i, row(/SYN_PCR_A/)));
    const d = dialog();
    const code = within(d).queryAllByRole('textbox', { name: /^code/i })[0] as HTMLInputElement | undefined;
    if (code) expect(code.readOnly || code.disabled).toBe(true);
    for (const t of ['T1', 'T2']) expect(d.querySelector(`[data-target="${t}"]`), t).toBeTruthy();
    for (const v of ['detected', 'not_detected', 'positive']) expect(d.querySelector(`[data-value="${v}"]`), v).toBeTruthy();
    expect(d.textContent).toMatch(/can.t be deleted, only deactivated/i);
    expect(within(d).queryAllByRole('button', { name: /^(remove|delete)/i })).toHaveLength(0); // saved codes are never removed (TRD §5.6)
  });

  it('Save PUTs the whole assay (AssayInput: no ids, all saved target and value codes kept) with If-Match "5"', async () => {
    await open();
    await userEvent.click(btn(/edit/i, row(/SYN_PCR_A/)));
    const d = dialog();
    await type(d, /^name/i, 'Synthetic PCR A v2');
    await userEvent.click(btn(/^save$/i, d));
    const h = last('PUT', /\/assays\/[^/]+$/);
    expect(h.headers.get('if-match')).toBe('"5"');
    expect(h.headers.get('idempotency-key')).toBeNull();
    expect(h.json.display).toBe('Synthetic PCR A v2');
    expect(h.json.targets.map((t: { code: string }) => t.code)).toEqual(['T1', 'T2']);
    expect(h.json.targets[0].result_values.map((v: { code: string }) => v.code)).toEqual(['detected', 'not_detected']);
    expect(JSON.stringify(h.json)).not.toMatch(/"id"/);
    expect(h.json.targets[0]).toMatchObject({ allows_quantitative: true, unit_code: 'copies_per_ml', decimals: 0, is_active: true });
    expect(h.json.targets[1]).not.toHaveProperty('unit_code');
  });

  it('deactivating a target is allowed: its is_active=false is sent, the code is still in the body', async () => {
    await open();
    await userEvent.click(btn(/edit/i, row(/SYN_PCR_A/)));
    const d = dialog();
    const t2 = d.querySelector('[data-target="T2"]') as HTMLElement;
    await userEvent.click(within(t2).getAllByRole('switch', { name: /^active/i })[0]!); // the target's own switch precedes its values' switches
    await userEvent.click(btn(/^save$/i, d));
    const t = last('PUT', /\/assays\/[^/]+$/).json.targets.find((x: { code: string }) => x.code === 'T2');
    expect(t.is_active).toBe(false);
  });

  it('[Add assay]: POST /assays with Idempotency-Key and a body of Code, Name, Active and at least one target with at least one result value', async () => {
    await open();
    await userEvent.click(btn(/add assay/i));
    const d = dialog();
    await type(d, /^code/i, 'SYN_NEW');
    await type(d, /^name/i, 'Synthetic new assay');
    await userEvent.click(btn(/add target/i, d));
    await type(d, /target code/i, 'G1');
    await type(d, /target name/i, 'Gene one');
    await userEvent.click(btn(/add value/i, d));
    await type(d, /value code/i, 'variant');
    await type(d, /value display/i, 'Variant found');
    await userEvent.click(btn(/^save$/i, d));
    const [h, ...rest] = sent('POST', /^\/v1\/anatomic\/assays$/);
    expect(rest).toHaveLength(0);
    expect(h!.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(h!.headers.get('if-match')).toBeNull();
    expect(h!.json).toMatchObject({ code: 'SYN_NEW', display: 'Synthetic new assay', is_active: true });
    expect(h!.json.targets).toHaveLength(1);
    expect(h!.json.targets[0]).toMatchObject({ code: 'G1', display: 'Gene one', allows_quantitative: false });
    expect(h!.json.targets[0].result_values[0]).toMatchObject({ code: 'variant', display: 'Variant found', is_abnormal: false, is_active: true });
  });

  it('an assay without a target is not sent (AssayInput.targets minItems 1)', async () => {
    await open();
    await userEvent.click(btn(/add assay/i));
    const d = dialog();
    await type(d, /^code/i, 'SYN_NEW');
    await type(d, /^name/i, 'Synthetic new assay');
    await userEvent.click(btn(/^save$/i, d));
    expect(sent('POST', /\/assays$/)).toHaveLength(0);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a result value code with capitals or spaces is rejected in the form (^[a-z0-9_]{1,32}$)', async () => {
    await open();
    await userEvent.click(btn(/add assay/i));
    const d = dialog();
    await type(d, /^code/i, 'SYN_NEW');
    await type(d, /^name/i, 'Synthetic new assay');
    await userEvent.click(btn(/add target/i, d));
    await type(d, /target code/i, 'G1');
    await type(d, /target name/i, 'Gene one');
    await userEvent.click(btn(/add value/i, d));
    await type(d, /value code/i, 'Not Detected');
    await type(d, /value display/i, 'Not detected');
    await userEvent.click(btn(/^save$/i, d));
    expect(sent('POST', /\/assays$/)).toHaveLength(0);
  });
});

describe('coded lists tab (K11/K12; AC-14.3)', () => {
  const open = (sp: Record<string, string> = {}) => configPage({ tab: 'coded-lists', ...sp });

  it('default list is Diagnoses: GET /coded-sets/diagnoses/values?include_inactive=true, the licensing notice is shown, columns Code, Display, System, Version, Active', async () => {
    await open();
    const g = hit('GET', /^\/v1\/anatomic\/coded-sets\/diagnoses\/values$/);
    expect(g).toHaveLength(1);
    expect(new URLSearchParams(g[0]!.search).get('include_inactive')).toBe('true');
    expect(text()).toContain('Add only codes your lab is licensed to use. No external code sets are included.');
    for (const h of ['Code', 'Display', 'System', 'Version', 'Active']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }), h).toBeTruthy();
  });

  it('AC-14.3 (display side): deactivated codes stay in the list with the word "Inactive" and an icon', async () => {
    await open();
    const r = row(/LOC-0000/);
    expect(r.textContent).toContain('Inactive');
    expect(r.querySelector('[data-tone] svg, [data-tone] [aria-hidden=true]')).toBeTruthy();
    expect(row(/LOC-0002/).textContent).toContain('Active');
  });

  it('the list Select offers Diagnoses, Cytology adequacy, Cancellation reasons (change/amendment reasons are C5) and pushes ?set=', async () => {
    await open();
    await userEvent.click(btn(/list/i));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent?.trim())).toEqual(['Diagnoses', 'Cytology adequacy', 'Cancellation reasons']);
    await userEvent.click(screen.getByRole('option', { name: /cytology adequacy/i }));
    expect(router.push).toHaveBeenCalledWith('/anatomic/config?tab=coded-lists&set=cytology_adequacy');
  });

  it('?set=cytology_adequacy loads that set and hides the diagnoses notice; an unknown set falls back to diagnoses (no path injection)', async () => {
    await open({ set: 'cytology_adequacy' });
    expect(hit('GET', /\/coded-sets\/cytology_adequacy\/values$/)).toHaveLength(1);
    expect(text()).not.toContain('licensed to use');
    cleanup(); resetHits();
    await open({ set: '../../settings' });
    expect(hits.filter((h) => /coded-sets/.test(h.path)).map((h) => h.path)).toEqual(['/v1/anatomic/coded-sets/diagnoses/values']);
  });

  it('AC-14.3: add LOC-0001 (system local) -> PUT /coded-sets/diagnoses/values/LOC-0001 with If-Match "0" and {display, system, sort_order, is_active}', async () => {
    await open();
    await userEvent.click(btn(/add (code|value|diagnosis)/i));
    const d = dialog();
    expect(input(d, /^system$/i).value).toBe('local'); // default (04-UI-UX §4.7)
    expect(input(d, /^code/i).getAttribute('maxlength')).toBe('64');
    await type(d, /^code/i, 'LOC-0001');
    await type(d, /^display/i, 'Synthetic local diagnosis');
    await userEvent.click(btn(/^save$/i, d));
    const h = last('PUT', /\/coded-sets\/diagnoses\/values\/LOC-0001$/);
    expect(h.headers.get('if-match')).toBe('"0"');
    expect(h.headers.get('idempotency-key')).toBeNull();
    expect(h.json).toEqual({ display: 'Synthetic local diagnosis', system: 'local', sort_order: expect.any(Number), is_active: true });
  });

  it.each(['LOC/1', 'LOC 1', 'LOC?1', '../x'])('code %j is rejected in the form (^[A-Za-z0-9_.:-]{1,64}$): no request', async (code) => {
    await open();
    await userEvent.click(btn(/add (code|value|diagnosis)/i));
    const d = dialog();
    await type(d, /^code/i, code);
    await type(d, /^display/i, 'Synthetic');
    await userEvent.click(btn(/^save$/i, d));
    expect(sent('PUT', /coded-sets/)).toHaveLength(0);
  });

  it('edit: the code is read-only and the PUT carries If-Match "2"; deactivating sends is_active=false', async () => {
    await open();
    await userEvent.click(btn(/edit/i, row(/LOC-0002/)));
    const d = dialog();
    const code = within(d).queryAllByRole('textbox', { name: /^code/i })[0] as HTMLInputElement | undefined;
    if (code) expect(code.readOnly || code.disabled).toBe(true);
    await userEvent.click(sw(d, /active/i));
    await userEvent.click(btn(/^save$/i, d));
    const h = last('PUT', /\/coded-sets\/diagnoses\/values\/LOC-0002$/);
    expect(h.headers.get('if-match')).toBe('"2"');
    expect(h.json.is_active).toBe(false);
  });
});

describe('text templates tab (K20/K21/K22)', () => {
  const open = () => configPage({ tab: 'text-templates' });

  it('columns Short code, Section, Title, Active; inactive templates are listed with the word "Inactive"', async () => {
    await open();
    for (const h of ['Short code', 'Section', 'Title', 'Active']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }), h).toBeTruthy();
    expect(hit('GET', /\/text-templates$/).some((g) => new URLSearchParams(g.search).get('include_inactive') === 'true')).toBe(true);
    expect(row(/\bold\b/).textContent).toContain('Inactive');
  });

  it('[Add template]: POST {short_code, section, title, body} with an Idempotency-Key; Body is a counted TextArea (<= 8000)', async () => {
    await open();
    await userEvent.click(btn(/add (text )?template/i));
    const d = dialog();
    expect(input(d, /short code/i).getAttribute('maxlength')).toBe('16');
    expect(input(d, /^body/i).getAttribute('maxlength')).toBe('8000');
    await type(d, /short code/i, 'nad2');
    await choose(d, /section/i, /^microscopy/i);
    await type(d, /^title/i, 'Synthetic nad');
    await userEvent.click(input(d, /^body/i));
    await userEvent.paste('Synthetic body text.');
    await userEvent.click(btn(/^save$/i, d));
    const [h, ...rest] = sent('POST', /^\/v1\/anatomic\/text-templates$/);
    expect(rest).toHaveLength(0);
    expect(h!.json).toEqual({ short_code: 'nad2', section: 'microscopy', title: 'Synthetic nad', body: 'Synthetic body text.' });
    expect(h!.headers.get('idempotency-key')).toMatch(IDEM_RE);
  });

  it.each(['NAD', 'a b', 'a-b', 'x'.repeat(17)])('short code %j is rejected in the form (^[a-z0-9_]{1,16}$)', async (code) => {
    await open();
    await userEvent.click(btn(/add (text )?template/i));
    const d = dialog();
    await type(d, /short code/i, code);
    await type(d, /^title/i, 'Synthetic');
    await userEvent.click(input(d, /^body/i));
    await userEvent.paste('Synthetic body.');
    await userEvent.click(btn(/^save$/i, d));
    expect(sent('POST', /text-templates/)).toHaveLength(0);
  });

  it('edit: short code and section are fixed; PUT {title, body, is_active} with If-Match "2"', async () => {
    await open();
    await userEvent.click(btn(/edit/i, row(/\bnad\b/)));
    const d = dialog();
    const sc = within(d).queryAllByRole('textbox', { name: /short code/i })[0] as HTMLInputElement | undefined;
    if (sc) expect(sc.readOnly || sc.disabled).toBe(true);
    await type(d, /^title/i, 'Synthetic nad renamed');
    await userEvent.click(btn(/^save$/i, d));
    const h = last('PUT', /\/text-templates\/[^/]+$/);
    expect(h.json).toEqual({ title: 'Synthetic nad renamed', body: 'Synthetic body nad.', is_active: true });
    expect(h.headers.get('if-match')).toBe('"2"');
  });

  it('empty: "No text templates yet." with an [Add template] action', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/text-templates`, () => page([])));
    await open();
    expect(text()).toContain('No text templates yet.');
    expect(btn(/add (text )?template/i)).toBeTruthy();
  });
});

describe('synoptic templates tab (K13, K17-K19; AC-08.3, AC-08.4)', () => {
  const open = () => configPage({ tab: 'templates' });

  it('columns Key, Version, Title, Status, Case kinds, Published; status = tone + icon + word', async () => {
    await open();
    for (const h of ['Key', 'Version', 'Title', 'Status', 'Case kinds', 'Published']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }), h).toBeTruthy();
    expect(rows()).toHaveLength(3);
    for (const [key, word] of [['syn_colon', 'Draft'], ['syn_breast', 'Published'], ['syn_old', 'Retired']] as const) {
      const r = row(new RegExp(key));
      expect(r.textContent, key).toContain(word);
      expect(r.querySelector('[data-tone] svg, [data-tone] [aria-hidden=true]'), key).toBeTruthy();
    }
    expect(hit('GET', /\/synoptic-templates$/).every((g) => !new URLSearchParams(g.search).has('status'))).toBe(true); // all statuses
  });

  it('empty: "No templates yet." with a [New template] action', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/synoptic-templates`, () => page([])));
    await open();
    expect(text()).toContain('No templates yet.');
    expect(screen.getByRole('link', { name: /new template/i }).getAttribute('href')).toBe('/anatomic/config/templates/new');
  });

  it('[New template] links to the blank builder; the key links to the editor /anatomic/config/templates/{id}', async () => {
    await open();
    expect(screen.getByRole('link', { name: /new template/i }).getAttribute('href')).toBe('/anatomic/config/templates/new');
    expect(within(row(/syn_colon/)).getByRole('link', { name: /syn_colon|open/i }).getAttribute('href')).toBe(`/anatomic/config/templates/${ID(1700)}`);
  });

  it('actions follow the status: draft -> Publish; published -> New version and Retire; retired -> none of them', async () => {
    await open();
    const has = (key: RegExp, name: RegExp) => within(row(key)).queryAllByRole('button', { name }).length > 0;
    expect([has(/syn_colon/, /^publish/i), has(/syn_colon/, /^new version/i), has(/syn_colon/, /^retire/i)]).toEqual([true, false, false]);
    expect([has(/syn_breast/, /^publish/i), has(/syn_breast/, /^new version/i), has(/syn_breast/, /^retire/i)]).toEqual([false, true, true]);
    expect([has(/syn_old/, /^publish/i), has(/syn_old/, /^new version/i), has(/syn_old/, /^retire/i)]).toEqual([false, false, false]);
  });

  it('Publish asks for confirmation, reads the current version, then POSTs /publish with If-Match "<that version>" and an Idempotency-Key', async () => {
    await open();
    await userEvent.click(btn(/^publish/i, row(/syn_colon/)));
    expect(sent('POST', /publish$/)).toHaveLength(0); // nothing before the ConfirmDialog is confirmed
    await userEvent.click(btn(/^publish$/i, dialog()));
    const [h, ...rest] = sent('POST', new RegExp(`/synoptic-templates/${ID(1700)}/publish$`));
    expect(rest).toHaveLength(0);
    expect(h!.headers.get('if-match')).toBe('"6"'); // GET /synoptic-templates/{id} answers version 6 (the list rows carry no version)
    expect(h!.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(router.refresh).toHaveBeenCalled();
  });

  it('Publish cancelled in the ConfirmDialog sends nothing', async () => {
    await open();
    await userEvent.click(btn(/^publish/i, row(/syn_colon/)));
    await userEvent.click(btn(/^cancel$/i, dialog()));
    expect(sent('POST', /publish$/)).toHaveLength(0);
  });

  it('Retire: ConfirmDialog, then POST /retire with If-Match and an Idempotency-Key', async () => {
    await open();
    await userEvent.click(btn(/^retire/i, row(/syn_breast/)));
    await userEvent.click(btn(/^retire$/i, dialog()));
    const h = last('POST', new RegExp(`/synoptic-templates/${ID(1701)}/retire$`));
    expect(h.headers.get('if-match')).toBe('"6"');
    expect(h.headers.get('idempotency-key')).toMatch(IDEM_RE);
  });

  it('AC-08.3: [New version] on a published template POSTs /new-version (Idempotency-Key, no If-Match) and opens the new draft in the editor', async () => {
    await open();
    await userEvent.click(btn(/^new version/i, row(/syn_breast/)));
    const h = last('POST', new RegExp(`/synoptic-templates/${ID(1701)}/new-version$`));
    expect(h.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(h.headers.get('if-match')).toBeNull();
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith(`/anatomic/config/templates/${ID(1750)}`));
  });

  it('AC-08.4 (list side): v1 (published) and v2 (draft) of the same key are both listed with their version numbers', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/synoptic-templates`, () => page([tplSummary(1, 'syn_breast', 'published'), tplSummary(5, 'syn_breast', 'draft', { version_no: 2 })])));
    await open();
    const rs = rows().filter((r) => /syn_breast/.test(r.textContent ?? ''));
    expect(rs).toHaveLength(2);
    expect(rs.map((r) => /Published|Draft/.exec(r.textContent ?? '')![0]).sort()).toEqual(['Draft', 'Published']);
    expect(rs.map((r) => within(r).getAllByRole('gridcell')[1]!.textContent?.trim()).sort()).toEqual(['1', '2']);
  });

  it('409 common.immutable_record on a write shows the message and does not navigate', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/synoptic-templates/:id/new-version`, () => problem('common.immutable_record', 409)));
    await open();
    await userEvent.click(btn(/^new version/i, row(/syn_breast/)));
    expect(await screen.findByText(/can.t be changed|already|immutable/i)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('403 auth.mfa_required on Publish -> step-up dialog', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/synoptic-templates/:id/publish`, () => problem('auth.mfa_required', 403)));
    await open();
    await userEvent.click(btn(/^publish/i, row(/syn_colon/)));
    await userEvent.click(btn(/^publish$/i, dialog()));
    expect(await screen.findByText('This action needs two-factor verification.')).toBeTruthy();
  });

  it('a read of the template list that fails with 403 gives the no-access state', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/synoptic-templates`, () => problem('auth.forbidden', 403)));
    await open();
    expect(text()).toMatch(/permission/i);
  });
});

void [stains, assayRow];
