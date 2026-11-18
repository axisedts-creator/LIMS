// @vitest-environment jsdom
// T0D-VERLEVEL-1 (LD-316, LD-318 follow-up 4, LD-353; founder 2026-11-17 08:39 NPT) — "Verification levels" section of /lab/settings.
// Contract: contracts/openapi/lab.yaml listVerificationPolicies (GET /v1/lab/verification-policies) and upsertVerificationPolicy (PUT, If-Match "<version>" when an active
// policy for the target exists, none when the target is new). Departments: GET /v1/catalog/departments. Tests: GET /v1/catalog/tests (no q parameter exists, so the search box filters
// the loaded list in the browser). Synthetic data only.
//
// ASSUMED module/UI contract (the brief fixes the screen, not the names; the writer matches them or disputes through the ruling flow):
//   LabSettingsPage({ permissions }) gets a fifth tab (role=tab) named "Verification levels", file components/settings/VerificationPolicyTab.tsx, export VerificationPolicyTab({ canManage }).
//   The tab is shown when permissions hold lab.verification_policy.read OR lab.verification_policy.manage, and only manage makes it editable (lab.config.manage does NOT).
//   Level: a segmented control = three radios named "Level 1", "Level 2", "Level 3" (arrow keys move the choice) + one plain line under it: level 1 "1 person ...", level 2 "2 different people ...", level 3 "3 different people ...".
//   Checkboxes "Require a pathologist" (default on) and "Let the person who entered a result also verify it" (default off) + an always visible warning that matches /accreditation/i.
//   Scope: three radios "Whole lab" (default), "One department" (shows a select labelled "Department", option value = department id), "One test" (shows a search box labelled "Search tests" and a clickable item per match).
//   Choosing a target that already has a policy loads that policy into the form; a target without one loads the defaults (level 2, pathologist on, enterer off).
//   Button "Save policy" -> PUT { scope, required_verifiers, require_pathologist, allow_enterer_verify, [department_id | test_id] }; success Toast /policy saved/i and the table reloads.
//   Table of OVERRIDES (department and test policies; the lab policy is the base, not an override) with columns Scope | Name | Level | Pathologist required | Entered-by may verify | Updated by | Updated at.
//   "Updated by" has no field in VerificationPolicy yet: the column shows a dash. Empty overrides = T0D-EMPTYTBL-1 shape (headers, message row, 4 placeholder rows).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
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
const MANAGE = ['lab.verification_policy.read', 'lab.verification_policy.manage', 'lab.worklist.read', 'lab.result.read'];
const READ = ['lab.verification_policy.read', 'lab.worklist.read', 'lab.result.read'];
const CONFIG_ONLY = ['lab.config.manage', 'lab.verification_policy.read'];
const problem = (status: number, code: string, title: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title, status, code, request_id: 'req-synthetic-verlevel' }, { status });

const D_BIO = U(0xd01), D_HEM = U(0xd02), T_CREA = U(0x701), T_HEMO = U(0x702), T_GLU = U(0x703);
const LAB = { id: U(0x901), scope: 'lab', required_verifiers: 2, require_pathologist: true, allow_enterer_verify: false, active: true, version: 1, updated_at: '2026-11-17T04:00:00.000Z' };
const DEPT = { id: U(0x902), scope: 'department', department_id: D_BIO, required_verifiers: 3, require_pathologist: true, allow_enterer_verify: false, active: true, version: 2, updated_at: '2026-11-17T05:30:00.000Z' };
const TEST = { id: U(0x903), scope: 'test', test_id: T_CREA, required_verifiers: 1, require_pathologist: false, allow_enterer_verify: true, active: true, version: 3, updated_at: '2026-11-17T06:45:00.000Z' };
const DEPARTMENTS = [{ id: D_BIO, code: 'BIO', name: 'Biochemistry', is_active: true }, { id: D_HEM, code: 'HEM', name: 'Hematology', is_active: true }];
const TESTS = [{ id: T_CREA, code: 'CREA', name: 'Creatinine' }, { id: T_HEMO, code: 'HB', name: 'Hemoglobin' }, { id: T_GLU, code: 'GLU', name: 'Glucose fasting' }];

interface Call { op: string; url: URL; headers: Headers; body?: any }
const calls: Call[] = [];
const rec = async (op: string, r: Request) => { calls.push({ op, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const ops = (op: string) => calls.filter((c) => c.op === op);
let listReply: () => Response, putReply: () => Response, deptReply: () => Response, testReply: () => Response;

const api = setupServer(
  http.get(`${ORIGIN}/v1/lab/verification-policies`, async ({ request }) => { await rec('list', request); return listReply(); }),
  http.put(`${ORIGIN}/v1/lab/verification-policies`, async ({ request }) => { await rec('put', request); return putReply(); }),
  http.get(`${ORIGIN}/v1/catalog/departments`, async ({ request }) => { await rec('depts', request); return deptReply(); }),
  http.get(`${ORIGIN}/v1/catalog/tests`, async ({ request }) => { await rec('tests', request); return testReply(); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  listReply = () => HttpResponse.json({ data: [LAB, DEPT, TEST] });
  putReply = () => HttpResponse.json({ ...LAB, version: 2 });
  deptReply = () => HttpResponse.json({ data: DEPARTMENTS });
  testReply = () => HttpResponse.json({ data: TESTS });
  Object.values(nav).forEach((f) => f.mockReset());
});
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; });
afterAll(() => api.close());

const load = async () => (await import(/* @vite-ignore */ '../components/settings/LabSettingsPage')) as { LabSettingsPage: (p: any) => any }; // a missing module fails each test, not the file
const open = async (permissions: readonly string[] = MANAGE) => {
  const { LabSettingsPage } = await load();
  const view = render(<ToastProvider><LabSettingsPage permissions={permissions} /></ToastProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: /verification levels/i }));
  await screen.findByRole('radio', { name: /^level 2$/i });
  return { user, ...view };
};
const on = (el: HTMLElement) => (el.tagName === 'INPUT' ? (el as HTMLInputElement).checked : el.getAttribute('aria-checked') === 'true');
const off = (el: HTMLElement) => !on(el);
const disabled = (el: HTMLElement) => (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('readonly');
const level = (n: number) => screen.getByRole('radio', { name: new RegExp(`^level ${n}$`, 'i') });
const scope = (name: RegExp) => screen.getByRole('radio', { name });
const pathologist = () => screen.getByRole('checkbox', { name: /require a pathologist/i });
const enterer = () => screen.getByRole('checkbox', { name: /let the person who entered a result also verify it/i });
const save = () => screen.getByRole('button', { name: /save policy/i });
const LINE = { 1: /\b1 (different )?person\b/i, 2: /\b2 different people\b/i, 3: /\b3 different people\b/i } as const;
const overrideRows = (t: HTMLElement) => [...t.querySelectorAll<HTMLElement>('tbody tr')].filter((r) => !r.closest('[aria-hidden="true"]') && r.getAttribute('aria-hidden') !== 'true' && !r.classList.contains('lims-row-placeholder') && !r.querySelector('th'));

describe('Verification levels tab — form (levels, flags, scope)', () => {
  it('the tab loads the policies and shows the lab policy: Level 2 chosen, a plain line "2 different people", pathologist on, enterer off, a warning about accreditation, scope Whole lab', async () => {
    await open();
    expect(ops('list')).toHaveLength(1);
    expect(ops('list')[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(on(level(2))).toBe(true);
    expect(off(level(1))).toBe(true);
    expect(off(level(3))).toBe(true);
    expect(screen.getByText(LINE[2])).toBeTruthy();
    expect(on(pathologist())).toBe(true);
    expect(off(enterer())).toBe(true);
    expect(screen.getByText(/accreditation/i)).toBeTruthy();
    expect(on(scope(/^whole lab$/i))).toBe(true);
  });

  it.each([[1, LINE[1]], [2, LINE[2]], [3, LINE[3]]] as const)('choosing Level %s changes the plain line to say how many different people must sign off', async (n, re) => {
    const { user } = await open();
    await user.click(level(n));
    expect(on(level(n))).toBe(true);
    expect(screen.getByText(re)).toBeTruthy();
    for (const other of [1, 2, 3].filter((x) => x !== n)) expect(screen.queryByText(LINE[other as 1 | 2 | 3])).toBeNull();
  });

  it('keyboard: the arrow keys move the level choice; the control is reachable with Tab and focus lands on the chosen level', async () => {
    const { user } = await open();
    level(2).focus();
    await user.keyboard('{ArrowRight}');
    expect(on(level(3))).toBe(true);
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(on(level(1))).toBe(true);
    expect(screen.getByText(LINE[1])).toBeTruthy();
  });

  it('level change on the lab policy: Save sends PUT with If-Match "1" and the lab body only (no department_id / test_id), then shows "policy saved" and reloads the table', async () => {
    const { user } = await open();
    await user.click(level(3));
    await user.click(save());
    expect(await screen.findByText(/policy saved/i)).toBeTruthy();
    expect(ops('put')).toHaveLength(1);
    const p = ops('put')[0]!;
    expect(p.headers.get('if-match')).toBe('"1"');
    expect(p.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(p.body).toMatchObject({ scope: 'lab', required_verifiers: 3, require_pathologist: true, allow_enterer_verify: false });
    expect(p.body).not.toHaveProperty('department_id');
    expect(p.body).not.toHaveProperty('test_id');
    await waitFor(() => expect(ops('list').length).toBeGreaterThanOrEqual(2));
  });

  it('both checkboxes travel in the body; the next Save uses the new version from the reloaded list as If-Match', async () => {
    const { user } = await open();
    await user.click(pathologist());
    await user.click(enterer());
    listReply = () => HttpResponse.json({ data: [{ ...LAB, require_pathologist: false, allow_enterer_verify: true, version: 2 }, DEPT, TEST] });
    await user.click(save());
    await screen.findByText(/policy saved/i);
    expect(ops('put')[0]!.body).toMatchObject({ scope: 'lab', require_pathologist: false, allow_enterer_verify: true });
    await waitFor(() => expect(ops('list')).toHaveLength(2));
    await user.click(save());
    await waitFor(() => expect(ops('put')).toHaveLength(2));
    expect(ops('put')[1]!.headers.get('if-match')).toBe('"2"');
  });

  it('scope change to One department: a "Department" select lists the departments; a department WITHOUT a policy starts from the defaults and is saved WITHOUT If-Match', async () => {
    const { user } = await open();
    await user.click(level(3));
    await user.click(scope(/^one department$/i));
    const sel = await screen.findByLabelText(/^department$/i);
    await user.selectOptions(sel, D_HEM);
    expect(on(level(2))).toBe(true);
    expect(on(pathologist())).toBe(true);
    expect(off(enterer())).toBe(true);
    await user.click(level(3));
    await user.click(save());
    await waitFor(() => expect(ops('put')).toHaveLength(1));
    const p = ops('put')[0]!;
    expect(p.headers.get('if-match')).toBeNull();
    expect(p.body).toMatchObject({ scope: 'department', department_id: D_HEM, required_verifiers: 3, require_pathologist: true, allow_enterer_verify: false });
    expect(p.body).not.toHaveProperty('test_id');
  });

  it('a department WITH an override loads it into the form (Level 3) and Save sends If-Match "2" (that row\'s version)', async () => {
    const { user } = await open();
    await user.click(scope(/^one department$/i));
    await user.selectOptions(await screen.findByLabelText(/^department$/i), D_BIO);
    expect(on(level(3))).toBe(true);
    expect(screen.getByText(LINE[3])).toBeTruthy();
    await user.click(level(2));
    await user.click(save());
    await waitFor(() => expect(ops('put')).toHaveLength(1));
    expect(ops('put')[0]!.headers.get('if-match')).toBe('"2"');
    expect(ops('put')[0]!.body).toMatchObject({ scope: 'department', department_id: D_BIO, required_verifiers: 2 });
  });

  it('One department with no department chosen: Save is refused with a visible message and NO request is sent', async () => {
    const { user } = await open();
    await user.click(scope(/^one department$/i));
    await screen.findByLabelText(/^department$/i);
    await user.click(save());
    expect(await screen.findByText(/choose a department|select a department|pick a department/i)).toBeTruthy();
    expect(ops('put')).toHaveLength(0);
  });

  it('scope One test: the search box filters the tests as you type; picking one and saving sends test_id (new target: no If-Match)', async () => {
    const { user } = await open();
    await user.click(scope(/^one test$/i));
    const box = await screen.findByLabelText(/search tests/i);
    expect(await screen.findByText(/hemoglobin/i)).toBeTruthy();
    await user.type(box, 'hemo');
    expect(screen.getByText(/hemoglobin/i)).toBeTruthy();
    expect(screen.queryByText(/glucose fasting/i)).toBeNull();
    await user.click(screen.getByText(/hemoglobin/i));
    await user.click(level(1));
    await user.click(save());
    await waitFor(() => expect(ops('put')).toHaveLength(1));
    const p = ops('put')[0]!;
    expect(p.headers.get('if-match')).toBeNull();
    expect(p.body).toMatchObject({ scope: 'test', test_id: T_HEMO, required_verifiers: 1 });
    expect(p.body).not.toHaveProperty('department_id');
  });

  it('One test with nothing picked: Save is refused with a message and NO request', async () => {
    const { user } = await open();
    await user.click(scope(/^one test$/i));
    await screen.findByLabelText(/search tests/i);
    await user.click(save());
    expect(await screen.findByText(/choose a test|select a test|pick a test/i)).toBeTruthy();
    expect(ops('put')).toHaveLength(0);
  });

  it('a failing catalog read does not break the tab: the form and the table still render, names fall back to the first 8 characters of the id', async () => {
    deptReply = () => problem(403, 'auth.forbidden', 'You do not have permission');
    testReply = () => problem(403, 'auth.forbidden', 'You do not have permission');
    await open();
    const t = screen.getByRole('table');
    expect(overrideRows(t)).toHaveLength(2);
    expect(t.textContent).toContain(D_BIO.slice(0, 8));
  });
});

describe('Verification levels tab — server answers (If-Match, error text)', () => {
  it('shows the server error text (title) in an alert and keeps the form values: 403 auth.forbidden', async () => {
    const { user } = await open();
    putReply = () => problem(403, 'auth.forbidden', 'You may not change the verification policy');
    await user.click(level(3));
    await user.click(save());
    expect(await within(await screen.findByRole('alert')).findByText(/may not change the verification policy/i)).toBeTruthy();
    expect(on(level(3))).toBe(true);
    expect(screen.queryByText(/policy saved/i)).toBeNull();
  });

  it('409 common.version_conflict shows its title and RELOADS the policies; 428 does the same', async () => {
    const { user } = await open();
    putReply = () => problem(409, 'common.version_conflict', 'This policy was changed by someone else');
    await user.click(level(3));
    await user.click(save());
    expect(await within(await screen.findByRole('alert')).findByText(/changed by someone else/i)).toBeTruthy();
    await waitFor(() => expect(ops('list')).toHaveLength(2));
    putReply = () => problem(428, 'common.precondition_required', 'Reload the policy and try again');
    await user.click(save());
    expect(await within(await screen.findByRole('alert')).findByText(/reload the policy/i)).toBeTruthy();
    await waitFor(() => expect(ops('list')).toHaveLength(3));
  });

  it('auth.mfa_required (aal1 session) shows the re-authentication hint, not a generic failure', async () => {
    const { user } = await open();
    putReply = () => problem(403, 'auth.mfa_required', 'Multi-factor authentication required');
    await user.click(level(1));
    await user.click(save());
    expect(await within(await screen.findByRole('alert')).findByText(/multi-factor|verify your identity|re-authenticate/i)).toBeTruthy();
  });

  it('a failing read (500) shows the error text in an alert, not an empty form, and no Save button', async () => {
    listReply = () => problem(500, 'common.internal', 'Something went wrong');
    const { LabSettingsPage } = await load();
    render(<ToastProvider><LabSettingsPage permissions={MANAGE} /></ToastProvider>);
    await userEvent.setup().click(await screen.findByRole('tab', { name: /verification levels/i }));
    expect(await within(await screen.findByRole('alert')).findByText(/something went wrong/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save policy/i })).toBeNull();
  });
});

describe('Verification levels tab — read only mode (REQ-SEC-062: the API still enforces lab.verification_policy.manage)', () => {
  it('with only lab.verification_policy.read: values shown, every control disabled, no Save button, no request but the reads', async () => {
    await open(READ);
    expect(on(level(2))).toBe(true);
    for (const n of [1, 2, 3]) expect(disabled(level(n))).toBe(true);
    expect(disabled(pathologist())).toBe(true);
    expect(disabled(enterer())).toBe(true);
    expect(screen.queryByRole('button', { name: /save policy/i })).toBeNull();
    expect(ops('put')).toHaveLength(0);
    expect(overrideRows(screen.getByRole('table'))).toHaveLength(2);
  });

  it('lab.config.manage alone does NOT make the policy editable', async () => {
    await open(CONFIG_ONLY);
    expect(disabled(level(2))).toBe(true);
    expect(screen.queryByRole('button', { name: /save policy/i })).toBeNull();
  });

  it('without lab.verification_policy.read or .manage the tab is not offered and nothing is requested', async () => {
    const { LabSettingsPage } = await load();
    render(<ToastProvider><LabSettingsPage permissions={['lab.config.manage', 'lab.result.read']} /></ToastProvider>);
    await screen.findByRole('tab', { name: /general/i });
    expect(screen.queryByRole('tab', { name: /verification levels/i })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('Verification levels tab — table of overrides (T0D-EMPTYTBL-1 rule)', () => {
  const HEADERS = ['Scope', 'Name', 'Level', 'Pathologist required', 'Entered-by may verify', 'Updated by', 'Updated at'];
  const heads = (t: HTMLElement) => [...t.querySelectorAll('th, [role="columnheader"]')].map((h) => (h.textContent ?? '').trim()).filter(Boolean);

  it('lists the department and test overrides (not the lab policy) with scope, resolved name, level, Yes/No flags and the update time', async () => {
    await open();
    const t = screen.getByRole('table');
    expect(heads(t)).toEqual(expect.arrayContaining(HEADERS));
    const [dept, test] = overrideRows(t);
    expect(overrideRows(t)).toHaveLength(2);
    expect(dept!.textContent).toMatch(/department/i);
    expect(dept!.textContent).toContain('Biochemistry');
    expect(dept!.textContent).toContain('3');
    expect(within(dept!).getAllByText(/^(yes|no)$/i).map((x) => x.textContent)).toEqual(['Yes', 'No']);
    expect(dept!.textContent).toContain('2026-11-17');
    expect(test!.textContent).toMatch(/test/i);
    expect(test!.textContent).toContain('Creatinine');
    expect(within(test!).getAllByText(/^(yes|no)$/i).map((x) => x.textContent)).toEqual(['No', 'Yes']);
  });

  it('empty overrides: the column names still show, one message row inside the table, four inert placeholder rows below it', async () => {
    listReply = () => HttpResponse.json({ data: [LAB] });
    await open();
    const t = screen.getByRole('table');
    expect(heads(t)).toEqual(expect.arrayContaining(HEADERS));
    expect(overrideRows(t)).toHaveLength(1); // the message row
    expect(overrideRows(t)[0]!.textContent).toMatch(/no overrides|no policies|nothing set/i);
    const ph = [...t.querySelectorAll<HTMLElement>('.lims-row-placeholder')];
    expect(ph).toHaveLength(4);
    for (const p of ph) {
      expect(p.getAttribute('aria-hidden')).toBe('true');
      expect(p.querySelector('a[href], button, input, select, textarea, [tabindex]')).toBeNull();
    }
  });

  it('an inactive override is not listed (deactivated policies no longer apply)', async () => {
    listReply = () => HttpResponse.json({ data: [LAB, { ...DEPT, active: false }, TEST] });
    await open();
    const rows = overrideRows(screen.getByRole('table'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Creatinine');
  });
});

describe('Verification levels tab — accessibility and compact density (T0D-DENSITY-1)', () => {
  it('axe: no violations (radios and checkboxes labelled, table with headers)', async () => {
    const { container } = await open();
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });

  it('the section does not override the 30 px / 13 px compact values and never removes the focus ring (static scan of the new file)', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const f = new URL('../components/settings/VerificationPolicyTab.tsx', import.meta.url);
    expect(existsSync(f), 'components/settings/VerificationPolicyTab.tsx must exist').toBe(true);
    const src = readFileSync(f, 'utf8');
    expect(src).not.toMatch(/outline\s*:\s*(none|0)\b/);
    expect(src).not.toMatch(/\b(height|minHeight|fontSize)\s*:\s*['"]?\d+(px)?/); // heights and text sizes come from the density tokens, not from the screen
    expect(src).not.toMatch(/font-size\s*:\s*\d+px|height\s*:\s*\d+px/);
  });
});
