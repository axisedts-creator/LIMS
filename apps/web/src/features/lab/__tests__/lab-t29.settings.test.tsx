// @vitest-environment jsdom
// C5 T-29 — Lab settings screen `/lab/settings` (04-UI-UX §1 nav row `lab.config.manage` CR-C5-004, §3.13 tabs General / Delta rules / Reason codes; 02-TRD §5.8 rows 47-54, §9.1; PRD AC-12.4; 07-SECURITY S-15).
// Real HTTP goes to LIMS_ORIGIN_API (MSW); `onUnhandledRequest: 'error'` => any call outside the handlers below fails the test.
// ASSUMED module/prop contract (the spec fixes the screen, not the names; the writer matches them or disputes):
//   apps/web/src/features/lab/components/settings/LabSettingsPage.tsx   export LabSettingsPage({ permissions })   client component; `permissions: readonly string[]` — every write control needs `lab.config.manage`
//   Tabs (role="tab"): "General" (default), "Delta rules", "Reason codes". (The "QC holds" tab belongs to the QC task and is not pinned here.)
//   General: labelled controls "Label width (mm)", "Label height (mm)", "Copies per specimen" (label_copies_default), "History (days)", "Label renderer" (select, only html_svg), checkboxes "Host query requires received specimen",
//     "Auto-receive instrument results", "Critical notification blocks approval", "Pre-tick recollection on reject", "Delta check enabled"; button "Save settings" -> PUT /v1/lab/settings with If-Match "<version>" and the ten
//     LabSettingsUpdate keys only; success Toast "Settings saved".
//   Delta rules: table columns Analyte (IdText = first 8 chars), Window, Abs, Pct, Unit, Version, Effective from, Active ("Active" / "Inactive" TEXT); buttons "New rule", per row "New version" and (active rows only) "Deactivate" (confirm dialog with a
//     "Deactivate" confirm button). Rule form fields "Analyte ID", "Window (hours)" (-> window_seconds = hours x 3600), "Absolute threshold", "Percent threshold", "Unit", "Effective from" (datetime-local, optional), submit "Save rule".
//     POST /v1/lab/delta-check-rules (Idempotency-Key) / POST .../{id}/versions (If-Match "<row version>", Idempotency-Key, no analyte_id) / POST .../{id}/deactivate (If-Match, body {}).
//   Reason codes: a "Code set" select (rejection_reasons, return_reasons, amendment_reasons, exception_discard_reasons; default rejection_reasons) -> GET /v1/lab/coded-sets/{set}; columns Code, Display, Order, Active ("Active"/"Inactive" text), Source
//     ("Global"/"Tenant" text); per row "Edit" (display, order, active; saves PUT .../codes/{code}); "Add code" (fields "Code", "Display", "Order", "Active") -> PUT without If-Match.
//   Errors: a problem+json shows its title text in role="alert"; 409 common.version_conflict and 428 reload the data; auth.mfa_required shows a re-authentication hint (text matches /multi-factor|verify your identity|re-authenticate/i).
// SPEC GAP (notes file): LabCodeDto has no `version`, yet #54 needs If-Match for an EXISTING tenant row; the UI cannot know it. Not pinned: editing an existing tenant row. Pinned: overriding a global row and adding a new code (no If-Match).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const nav = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/lab/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Lab Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/settings',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const MANAGE = ['lab.config.manage', 'lab.worklist.read', 'lab.result.read', 'lab.specimen.read'];
const READ_ONLY = ['lab.worklist.read', 'lab.result.read', 'lab.specimen.read'];
const problem = (status: number, code: string, title: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title, status, code, request_id: 'req-synthetic-29' }, { status });

const SETTINGS = { version: 3, label_width_mm: 50, label_height_mm: 25, label_copies_default: 1, label_renderer: 'html_svg', host_query_requires_received: true, ingest_auto_receive: false,
  critical_notification_blocks_approval: true, recollection_default: true, delta_check_enabled: true, history_days: 730 };
const KEYS = Object.keys(SETTINGS).filter((k) => k !== 'version').sort();
const rule = (n: number, o: Record<string, unknown> = {}) => ({ id: U(0x800 + n), version: 2, analyte_id: `${(0xa0 + n).toString(16).padStart(2, '0')}c4a0${n}0-ac40-7000-8000-000000000${n}00`, rule_version: 1, window_seconds: 7 * 86400, abs_threshold: '1.0',
  unit_code: 'mmol_l', effective_from: '2026-11-05T04:15:00.000Z', is_active: true, ...o });
const code = (c: string, o: Record<string, unknown> = {}) => ({ code: c, display: `${c} display`, sort_order: 1, is_active: true, source: 'global', ...o });

interface Call { op: string; url: URL; headers: Headers; body?: any }
const calls: Call[] = [];
const rec = async (op: string, r: Request) => { calls.push({ op, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const ops = (op: string) => calls.filter((c) => c.op === op);
let settingsReply: () => Response, putReply: () => Response, rulesReply: () => Response, createRuleReply: () => Response, versionReply: () => Response, deactivateReply: () => Response,
  setReply: (set: string) => Response, upsertReply: () => Response;

const api = setupServer(
  http.get(`${ORIGIN}/v1/lab/settings`, async ({ request }) => { await rec('getSettings', request); return settingsReply(); }),
  http.put(`${ORIGIN}/v1/lab/settings`, async ({ request }) => { await rec('putSettings', request); return putReply(); }),
  http.get(`${ORIGIN}/v1/lab/delta-check-rules`, async ({ request }) => { await rec('listRules', request); return rulesReply(); }),
  http.post(`${ORIGIN}/v1/lab/delta-check-rules`, async ({ request }) => { await rec('createRule', request); return createRuleReply(); }),
  http.post(`${ORIGIN}/v1/lab/delta-check-rules/:id/versions`, async ({ request }) => { await rec('versionRule', request); return versionReply(); }),
  http.post(`${ORIGIN}/v1/lab/delta-check-rules/:id/deactivate`, async ({ request }) => { await rec('deactivateRule', request); return deactivateReply(); }),
  http.get(`${ORIGIN}/v1/lab/coded-sets/:set`, async ({ request, params }) => { await rec('listSet', request); return setReply(String(params['set'])); }),
  http.put(`${ORIGIN}/v1/lab/coded-sets/:set/codes/:code`, async ({ request }) => { await rec('upsertCode', request); return upsertReply(); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  settingsReply = () => HttpResponse.json(SETTINGS);
  putReply = () => HttpResponse.json({ ...SETTINGS, version: 4 });
  rulesReply = () => HttpResponse.json({ data: [rule(1), rule(2, { is_active: false, rule_version: 3, pct_threshold: '20', abs_threshold: undefined, effective_to: '2026-11-06T04:15:00.000Z' })] });
  createRuleReply = () => HttpResponse.json(rule(3), { status: 201 });
  versionReply = () => HttpResponse.json(rule(1, { rule_version: 2, version: 1 }), { status: 201 });
  deactivateReply = () => HttpResponse.json(rule(1, { is_active: false, version: 3 }));
  setReply = (set) => HttpResponse.json({ data: [code(`${set}_glob`), code('haemolysed', { source: 'tenant', display: 'Haemolysed (lab wording)', sort_order: 2 }), code('old_reason', { is_active: false, sort_order: 3 })] });
  upsertReply = () => HttpResponse.json(code('x', { source: 'tenant' }));
  Object.values(nav).forEach((f) => f.mockReset());
});
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; });
afterAll(() => api.close());

const load = async (name = 'LabSettingsPage') => (await import(/* @vite-ignore */ `../components/settings/${name}`)) as Record<string, (p: any) => ReactNode>; // variable path: a missing module fails each test, not the file
const open = async (permissions: readonly string[] = MANAGE) => {
  const { LabSettingsPage } = await load();
  return render(<ToastProvider><LabSettingsPage permissions={permissions} /></ToastProvider>);
};
const tab = async (name: RegExp) => { const user = userEvent.setup(); await user.click(await screen.findByRole('tab', { name })); return user; };
const rowsOf = () => screen.getAllByRole('row').slice(1);
const type = async (user: ReturnType<typeof userEvent.setup>, label: RegExp, value: string) => { const el = await screen.findByLabelText(label); await user.clear(el); if (value) await user.type(el, value); return el; };

describe('General tab — #47 / #48 (02-TRD §9.1)', () => {
  it('loads GET /v1/lab/settings with the bearer token and shows every §9.1 value in labelled controls; General is the default tab', async () => {
    await open();
    expect(Number(((await screen.findByLabelText(/label width/i)) as HTMLInputElement).value)).toBe(50);
    expect(ops('getSettings')).toHaveLength(1);
    expect(ops('getSettings')[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(screen.getByRole('tab', { name: /general/i }).getAttribute('aria-selected')).toBe('true');
    expect(Number((screen.getByLabelText(/label height/i) as HTMLInputElement).value)).toBe(25);
    expect(Number((screen.getByLabelText(/copies per specimen/i) as HTMLInputElement).value)).toBe(1);
    expect(Number((screen.getByLabelText(/history \(days\)/i) as HTMLInputElement).value)).toBe(730);
    expect((screen.getByLabelText(/label renderer/i) as HTMLSelectElement).value).toBe('html_svg');
    expect((screen.getByLabelText(/host query requires received/i) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/auto-receive/i) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/critical notification blocks approval/i) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/recollection/i) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/delta check enabled/i) as HTMLInputElement).checked).toBe(true);
  });

  it('Save sends PUT with If-Match "<version>" and exactly the ten update keys (no version, no tenant); success shows "Settings saved"', async () => {
    await open();
    const user = userEvent.setup();
    await type(user, /label width/i, '60');
    await user.click(screen.getByLabelText(/auto-receive/i));
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    expect(await screen.findByText(/settings saved/i)).toBeTruthy();
    expect(ops('putSettings')).toHaveLength(1);
    const put = ops('putSettings')[0]!;
    expect(put.headers.get('if-match')).toBe('"3"');
    expect(Object.keys(put.body).sort()).toEqual(KEYS);
    expect(put.body).toMatchObject({ label_width_mm: 60, ingest_auto_receive: true, label_height_mm: 25, history_days: 730, label_renderer: 'html_svg' });
    expect(put.headers.get('authorization')).toBe('Bearer jwt-synthetic');
  });

  it('the next Save after a success uses the NEW version from the response (If-Match "4")', async () => {
    await open();
    const user = userEvent.setup();
    await screen.findByLabelText(/label width/i);
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    await screen.findByText(/settings saved/i);
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(ops('putSettings')).toHaveLength(2));
    expect(ops('putSettings')[1]!.headers.get('if-match')).toBe('"4"');
  });

  it.each([
    [/label width/i, '19', /20.*100|between 20/i], [/label width/i, '101', /20.*100|between 20/i], [/label height/i, '9', /10.*60|between 10/i], [/label height/i, '61', /10.*60|between 10/i],
    [/copies per specimen/i, '0', /1.*5|between 1/i], [/copies per specimen/i, '6', /1.*5|between 1/i], [/history \(days\)/i, '29', /30.*3650|between 30/i], [/history \(days\)/i, '3651', /30.*3650|between 30/i],
  ])('out-of-range %s = %s is refused client-side with a visible message, aria-invalid, and NO request (§9.1 ranges as validation)', async (label, value, msg) => {
    await open();
    const user = userEvent.setup();
    const el = await type(user, label, value);
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(ops('putSettings')).toHaveLength(0);
  });

  it('the renderer select offers only html_svg (no ZPL until a CR exists)', async () => {
    await open();
    const sel = await screen.findByLabelText(/label renderer/i);
    expect(within(sel).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['html_svg']);
  });

  it('409 version_conflict shows the problem title and reloads the settings (the user sees the newer values); the form is not left half-saved', async () => {
    await open();
    const user = userEvent.setup();
    await screen.findByLabelText(/label width/i);
    putReply = () => problem(409, 'common.version_conflict', 'The settings were changed by someone else');
    settingsReply = () => HttpResponse.json({ ...SETTINGS, version: 5, label_width_mm: 70 });
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    expect(await within(await screen.findByRole('alert')).findByText(/changed by someone else/i)).toBeTruthy();
    await waitFor(() => expect(Number((screen.getByLabelText(/label width/i) as HTMLInputElement).value)).toBe(70));
    expect(ops('getSettings')).toHaveLength(2);
  });

  it('S-15: auth.mfa_required (aal1 session) shows a re-authentication hint, not a generic failure; the form keeps its values', async () => {
    await open();
    const user = userEvent.setup();
    await type(user, /label width/i, '60');
    putReply = () => problem(403, 'auth.mfa_required', 'Multi-factor authentication required');
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    expect(await within(await screen.findByRole('alert')).findByText(/multi-factor|verify your identity|re-authenticate/i)).toBeTruthy();
    expect(Number((screen.getByLabelText(/label width/i) as HTMLInputElement).value)).toBe(60);
  });

  it('without lab.config.manage the values are shown read-only: no Save button, inputs disabled or readonly (S-15, REQ-SEC-062)', async () => {
    await open(READ_ONLY);
    const w = await screen.findByLabelText(/label width/i);
    expect(Number((w as HTMLInputElement).value)).toBe(50);
    expect(screen.queryByRole('button', { name: /save settings/i })).toBeNull();
    expect(w.hasAttribute('disabled') || w.hasAttribute('readonly')).toBe(true);
  });

  it('a failing read (403) shows the error text in an alert, not an empty form, and no Save button', async () => {
    settingsReply = () => problem(403, 'auth.forbidden', 'You do not have permission');
    await open();
    expect(await within(await screen.findByRole('alert')).findByText(/do not have permission/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save settings/i })).toBeNull();
  });

  it('axe: the General tab has no accessibility violations (every control labelled)', async () => {
    const { container } = await open();
    await screen.findByLabelText(/label width/i);
    const r = await axe.run(container);
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('Delta rules tab — #49-#52 (AC-12.4: versioned rules, effective_from)', () => {
  it('lists the tenant\'s rules (all versions) with analyte IdText, window, thresholds, unit, rule version, effective from and "Active" / "Inactive" as TEXT', async () => {
    await open();
    await tab(/delta rules/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    expect(ops('listRules')).toHaveLength(1);
    const [active, inactive] = rowsOf();
    expect(active!.textContent).toContain(rule(1).analyte_id.slice(0, 8));
    expect(active!.textContent).not.toContain(rule(1).analyte_id);              // IdText: first 8 chars only
    expect(active!.textContent).toContain('mmol_l');
    expect(within(active!).getByText(/^active$/i)).toBeTruthy();
    expect(within(inactive!).getByText(/^inactive$/i)).toBeTruthy();
    expect(inactive!.textContent).toContain('20');                              // pct threshold of the second rule
    expect(active!.textContent).toMatch(/1\.0/);
    expect(active!.textContent).toMatch(/7\s*(d|days)|168\s*(h|hours)/i);       // 604800 s shown as a human duration, not raw seconds
    expect(active!.textContent).not.toContain('604800');
  });

  it('write controls need lab.config.manage: without it there is no New rule / New version / Deactivate', async () => {
    await open(READ_ONLY);
    await tab(/delta rules/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /new rule/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /new version/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /deactivate/i })).toBeNull();
  });

  it('"Deactivate" is offered on active rows only', async () => {
    await open();
    await tab(/delta rules/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    const [active, inactive] = rowsOf();
    expect(within(active!).getByRole('button', { name: /deactivate/i })).toBeTruthy();
    expect(within(inactive!).queryByRole('button', { name: /deactivate/i })).toBeNull();
  });

  it('New rule: POST with an Idempotency-Key and { analyte_id, window_seconds = hours x 3600, abs_threshold, unit_code }; no pct / effective_from keys when left empty; the list reloads', async () => {
    await open();
    const user = await tab(/delta rules/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: /new rule/i }));
    await type(user, /analyte id/i, U(0xa11));
    await type(user, /window \(hours\)/i, '168');
    await type(user, /absolute threshold/i, '1.5');
    await type(user, /^unit/i, 'mmol_l');
    await user.click(screen.getByRole('button', { name: /save rule/i }));
    await waitFor(() => expect(ops('createRule')).toHaveLength(1));
    const c = ops('createRule')[0]!;
    expect(c.body).toEqual({ analyte_id: U(0xa11), window_seconds: 168 * 3600, abs_threshold: '1.5', unit_code: 'mmol_l' });
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(ops('listRules').length).toBeGreaterThanOrEqual(2));
  });

  it.each([
    ['no threshold', { abs: '', pct: '' }, /at least one threshold/i],
    ['absolute threshold 0', { abs: '0', pct: '' }, /greater than 0|more than 0|> ?0/i],
    ['percent threshold 1000.01', { abs: '', pct: '1000.01' }, /1000/],
  ])('New rule with %s is refused client-side with a message and NO request (mirrors delta_check_rules__*__ck)', async (_t, v, msg) => {
    await open();
    const user = await tab(/delta rules/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: /new rule/i }));
    await type(user, /analyte id/i, U(0xa12));
    await type(user, /window \(hours\)/i, '168');
    await type(user, /^unit/i, 'mmol_l');
    if (v.abs) await type(user, /absolute threshold/i, v.abs);
    if (v.pct) await type(user, /percent threshold/i, v.pct);
    await user.click(screen.getByRole('button', { name: /save rule/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
    expect(ops('createRule')).toHaveLength(0);
  });

  it('window outside 1..8760 hours (3600..31536000 s) is refused client-side, no request', async () => {
    await open();
    const user = await tab(/delta rules/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: /new rule/i }));
    await type(user, /analyte id/i, U(0xa13));
    await type(user, /absolute threshold/i, '1');
    await type(user, /^unit/i, 'mmol_l');
    for (const bad of ['0', '8761']) {
      await type(user, /window \(hours\)/i, bad);
      await user.click(screen.getByRole('button', { name: /save rule/i }));
      expect(await screen.findByText(/1.*8760|between 1/i)).toBeTruthy();
    }
    expect(ops('createRule')).toHaveLength(0);
  });

  it('New version on a row: POST /delta-check-rules/{id}/versions with If-Match "<row version>", an Idempotency-Key, the form\'s fields and NO analyte_id; effective_from is sent as an ISO UTC instant when given', async () => {
    await open();
    const user = await tab(/delta rules/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /new version/i }));
    await type(user, /window \(hours\)/i, '336');
    await type(user, /percent threshold/i, '20');
    await type(user, /^unit/i, 'mmol_l');
    await type(user, /effective from/i, '2026-12-01T08:00');
    await user.click(screen.getByRole('button', { name: /save rule/i }));
    await waitFor(() => expect(ops('versionRule')).toHaveLength(1));
    const v = ops('versionRule')[0]!;
    expect(v.url.pathname).toBe(`/v1/lab/delta-check-rules/${rule(1).id}/versions`);
    expect(v.headers.get('if-match')).toBe('"2"');
    expect(v.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    expect(v.body).not.toHaveProperty('analyte_id');
    expect(v.body).toMatchObject({ window_seconds: 336 * 3600, pct_threshold: '20', unit_code: 'mmol_l' });
    expect(v.body.effective_from).toMatch(/^2026-1[12]-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z$/);
  });

  it('Deactivate asks for confirmation first (nothing sent on Cancel); Confirm posts to /deactivate with If-Match "<row version>" and body {}', async () => {
    await open();
    const user = await tab(/delta rules/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /deactivate/i }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /cancel/i }));
    expect(ops('deactivateRule')).toHaveLength(0);
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /deactivate/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^deactivate$/i }));
    await waitFor(() => expect(ops('deactivateRule')).toHaveLength(1));
    const d = ops('deactivateRule')[0]!;
    expect(d.url.pathname).toBe(`/v1/lab/delta-check-rules/${rule(1).id}/deactivate`);
    expect(d.headers.get('if-match')).toBe('"2"');
    expect(d.body).toEqual({});
  });

  it('409 / 428 on a rule action show the problem title and reload the list; auth.mfa_required shows the re-authentication hint', async () => {
    await open();
    const user = await tab(/delta rules/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    deactivateReply = () => problem(409, 'common.version_conflict', 'This rule was changed by someone else');
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /deactivate/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^deactivate$/i }));
    expect(await screen.findByText(/changed by someone else/i)).toBeTruthy();
    await waitFor(() => expect(ops('listRules').length).toBeGreaterThanOrEqual(2));
    deactivateReply = () => problem(403, 'auth.mfa_required', 'Multi-factor authentication required');
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /deactivate/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^deactivate$/i }));
    expect(await screen.findByText(/multi-factor|verify your identity|re-authenticate/i)).toBeTruthy();
  });

  it('an empty list shows "No delta rules." and, with the permission, still offers New rule', async () => {
    rulesReply = () => HttpResponse.json({ data: [] });
    await open();
    await tab(/delta rules/i);
    expect(await screen.findByText(/no delta rules/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /new rule/i })).toBeTruthy();
  });
});

describe('Reason codes tab — #53 / #54 (global rows shadowed by tenant rows)', () => {
  it('lists the default set (rejection_reasons) with code, display, order, Active/Inactive TEXT and Source text; the set selector offers exactly the four sets', async () => {
    await open();
    await tab(/reason codes/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(3));
    expect(ops('listSet')[0]!.url.pathname).toBe('/v1/lab/coded-sets/rejection_reasons');
    const sel = screen.getByLabelText(/code set/i);
    expect(within(sel).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['rejection_reasons', 'return_reasons', 'amendment_reasons', 'exception_discard_reasons']);
    const [glob, tenant, off] = rowsOf();
    expect(glob!.textContent).toContain('rejection_reasons_glob');
    expect(within(glob!).getByText(/^global$/i)).toBeTruthy();
    expect(tenant!.textContent).toContain('Haemolysed (lab wording)');
    expect(within(tenant!).getByText(/^tenant$/i)).toBeTruthy();
    expect(within(off!).getByText(/^inactive$/i)).toBeTruthy();
    expect(within(glob!).getByText(/^active$/i)).toBeTruthy();
  });

  it('switching the set loads that set\'s codes (GET /coded-sets/amendment_reasons)', async () => {
    await open();
    const user = await tab(/reason codes/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(3));
    await user.selectOptions(screen.getByLabelText(/code set/i), 'amendment_reasons');
    await waitFor(() => expect(ops('listSet').map((c) => c.url.pathname)).toContain('/v1/lab/coded-sets/amendment_reasons'));
    expect(await screen.findByText('amendment_reasons_glob')).toBeTruthy();
  });

  it('overriding a GLOBAL row: Edit -> PUT /coded-sets/{set}/codes/{code} with { display, sort_order, is_active } only, NO If-Match (creates the tenant row); the list reloads', async () => {
    await open();
    const user = await tab(/reason codes/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(3));
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /edit/i }));
    await type(user, /display/i, 'Lab wording for global');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(ops('upsertCode')).toHaveLength(1));
    const p = ops('upsertCode')[0]!;
    expect(p.url.pathname).toBe('/v1/lab/coded-sets/rejection_reasons/codes/rejection_reasons_glob');
    expect(p.headers.get('if-match')).toBeNull();
    expect(p.body).toEqual({ display: 'Lab wording for global', sort_order: 1, is_active: true });
    await waitFor(() => expect(ops('listSet').length).toBeGreaterThanOrEqual(2));
  });

  it('Add code: PUT without If-Match; a code outside ^[a-z0-9_]{1,64}$ is refused client-side (message, no request); an empty / 121-char display too', async () => {
    await open();
    const user = await tab(/reason codes/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(3));
    await user.click(screen.getByRole('button', { name: /add code/i }));
    await type(user, /^code$/i, 'Bad Code!');
    await type(user, /display/i, 'Shown to staff');
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/lowercase|a-z0-9_|letters, digits/i)).toBeTruthy();
    await type(user, /^code$/i, 'clotted');
    await type(user, /display/i, '');
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/display.*required|required|1.*120/i)).toBeTruthy();
    expect(ops('upsertCode')).toHaveLength(0);
    await type(user, /display/i, 'Clotted sample');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(ops('upsertCode')).toHaveLength(1));
    expect(ops('upsertCode')[0]!.url.pathname).toBe('/v1/lab/coded-sets/rejection_reasons/codes/clotted');
    expect(ops('upsertCode')[0]!.headers.get('if-match')).toBeNull();
    expect(ops('upsertCode')[0]!.body).toEqual({ display: 'Clotted sample', sort_order: expect.any(Number), is_active: true });
  });

  it('write controls need lab.config.manage: read-only users see the list but no Edit / Add code', async () => {
    await open(READ_ONLY);
    await tab(/reason codes/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(3));
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /add code/i })).toBeNull();
  });

  it('a 403 / 500 on the list shows the problem text in an alert; auth.mfa_required on save shows the re-authentication hint', async () => {
    setReply = () => problem(500, 'common.internal', 'Something went wrong');
    await open();
    await tab(/reason codes/i);
    expect(await within(await screen.findByRole('alert')).findByText(/something went wrong/i)).toBeTruthy();
    cleanup(); calls.length = 0;
    setReply = (set) => HttpResponse.json({ data: [code(`${set}_glob`)] });
    upsertReply = () => problem(403, 'auth.mfa_required', 'Multi-factor authentication required');
    await open();
    const user = await tab(/reason codes/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /edit/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/multi-factor|verify your identity|re-authenticate/i)).toBeTruthy();
  });

  it('axe: the Reason codes tab has no accessibility violations (status as text, labelled select)', async () => {
    const { container } = await open();
    await tab(/reason codes/i);
    await waitFor(() => expect(rowsOf()).toHaveLength(3));
    const r = await axe.run(container);
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
