// @vitest-environment jsdom
// C14.T20 — SR-04 Library editor shell + "Settings & score" + "Check & submit", app/(staff)/smartreport/library/[library_version_id]/page.tsx
// (04-UI-UX SR-04; 03-APP-FLOW §4 row SR-04; AC-02.5 UI side). done_when: "read-only when not draft".
// ASSUMED contract:
//   * default export = async server component `Page({ params })`. Order: malformed id -> notFound() (no API call); permission `smartreport.template.manage` (denied = notFound() or
//     PermissionDenied, no API call); then reads #3 version, #5 blocks, #9 rules, #13 analyte-groups, #16 groups, #35 organ_groups coded set. API 404 on the version -> notFound().
//   * kit Tabs (role=tab, in this order): "Settings & score", "Body systems", "Analyte mapping", "Texts", "Rules", "Check & submit". First tab selected on load.
//   * non-draft (approved / in_review / retired): Banner "This version is {status}; create a new draft to change it." (status as text, `_` shown as space allowed); every field is read-only
//     (kit isReadOnly => disabled controls), no Save/Add/Edit/Remove/Run-checks-submit controls, and NO write request can be sent.
//   * Settings & score = kit Form. Labels (regex): Language radios English / Nepali · Change summary · Show health score (switch) · "Credit: in range|borderline|out of range|critical" (%, value = bp / 100) ·
//     Minimum body systems · "Good" from · "Fair" from · Any critical result forces "Needs attention" · Borderline margin (help "0 means no borderline band.") · Minimum mapped results ·
//     Trends enabled (switch) · Max points · Look-back days · Stable change · Max trends · Max advice blocks · Max follow-up suggestions. Fixed info card mentions formula `hs-1`.
//     Save button /save/i -> PATCH #4 with If-Match "<version>" and body ⊆ {language, change_summary, params{LibraryParams keys}} (bp = % x 100). Success toast "Saved".
//     Client checks mirror the server (no request when they fail, role=alert error summary, focus inside it or on the first invalid field): credits non-increasing, fair < good, ranges of 04-UI-UX table.
//     409 library_invalid_transition -> Banner "This version is no longer a draft." + a /reload/i button that calls router.refresh().
//   * Check & submit: "Run checks" -> POST #18 -> grid /issues|checks/ (Severity · Code · Where · Detail; detail rendered as TEXT) with a row action (button) that selects the owning tab
//     (block_key -> Texts, rule_id -> Rules, otherwise -> Analyte mapping). "Submit for approval" disabled while an `error` issue exists; warnings do not block; success -> POST #19 with If-Match
//     "<version>" then router.push to /smartreport/library/…
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  EDITOR_PAGE, MANAGE, REPORT_OK, VER_APPROVED, VER_DRAFT, VER_REVIEW, VER_RETIRED, api, apiCalls, axeClean, bodyOf, callsTo, gridNamed, json, lastNav, mountEditorApi, norm, pageText, problem, resetApi,
  router, routes, rowTexts, showEditor, showOrThrown, versionDto, vp, PARAMS,
} from './sr-t20.harness';

vi.mock('next/navigation', async () => (await import('./sr-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./sr-t20.harness')).sessionMock);

const TABS = ['Settings & score', 'Body systems', 'Analyte mapping', 'Texts', 'Rules', 'Check & submit'];
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetApi(MANAGE); mountEditorApi(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const tab = (n: RegExp | string) => screen.getByRole('tab', { name: n });
const field = (re: RegExp) => screen.getByRole('spinbutton', { name: re }) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: /^save/i });
const patches = () => callsTo('PATCH', vp(VER_DRAFT));
async function setNum(re: RegExp, v: string) { const f = field(re); await userEvent.clear(f); await userEvent.type(f, v); }
const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'];

describe('access and loading', () => {
  it('denied without smartreport.template.manage: no API call', async () => {
    resetApi(['smartreport.summary.read']);
    const out = await showOrThrown(EDITOR_PAGE, { library_version_id: VER_DRAFT });
    if (out !== undefined) expect(out).toMatch(/NEXT_NOT_FOUND/);
    else expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(apiCalls()).toHaveLength(0);
  });
  it('a malformed id is a 404 with no API call', async () => {
    expect(await showOrThrown(EDITOR_PAGE, { library_version_id: "x'; drop table--" })).toMatch(/NEXT_NOT_FOUND/);
    expect(apiCalls()).toHaveLength(0);
  });
  it('API 404 on the version -> notFound()', async () => {
    routes[`GET ${vp(VER_DRAFT)}`] = () => problem('common.not_found', 404);
    expect(await showOrThrown(EDITOR_PAGE, { library_version_id: VER_DRAFT })).toMatch(/NEXT_NOT_FOUND/);
  });
  it('shows the six tabs in order, Settings & score selected; no raw ids in the DOM; axe-clean', async () => {
    await showEditor();
    expect(screen.getAllByRole('tab').map((t) => norm(t.textContent))).toEqual(TABS);
    expect(tab('Settings & score').getAttribute('aria-selected')).toBe('true');
    expect(pageText()).not.toContain(VER_DRAFT);
    await axeClean();
  });
});

describe('read-only when not draft (done_when)', () => {
  it.each([['approved', VER_APPROVED], ['in_review', VER_REVIEW], ['retired', VER_RETIRED]])('%s: banner, disabled fields, no write controls, no write request', async (status, v) => {
    mountEditorApi(v, versionDto({ id: v, status }));
    await showEditor(v);
    expect(pageText()).toMatch(new RegExp(`This version is ${status.replace('_', '[ _]')}; create a new draft to change it\\.`, 'i'));
    const live = [...screen.queryAllByRole('textbox'), ...screen.queryAllByRole('spinbutton'), ...screen.queryAllByRole('checkbox'), ...screen.queryAllByRole('switch'), ...screen.queryAllByRole('radio')]
      .filter((e) => !(e as HTMLInputElement).disabled && e.getAttribute('aria-disabled') !== 'true' && !(e as HTMLInputElement).readOnly && e.getAttribute('aria-readonly') !== 'true');
    expect(live.map((e) => e.getAttribute('aria-label') ?? e.id)).toEqual([]);
    expect(screen.queryByRole('button', { name: /^(save|add|new)/i })).toBeNull();
    for (const t of ['Body systems', 'Analyte mapping', 'Texts', 'Rules']) {
      await userEvent.click(tab(t));
      expect(screen.queryByRole('button', { name: /^(add|new|edit|remove|delete|deactivate)/i }), `${t} tab`).toBeNull();
    }
    expect(apiCalls().filter((c) => WRITES.includes(c.method))).toHaveLength(0);
  });

  it('a draft shows no read-only banner and an enabled Save', async () => {
    await showEditor();
    expect(pageText()).not.toMatch(/create a new draft to change it/i);
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('Settings & score (AC-02.5 UI; 04-UI-UX table)', () => {
  it('prefills from the version: credits as % (bp / 100), thresholds, language, change summary, hs-1 card, borderline help', async () => {
    await showEditor();
    expect(field(/credit.*in range/i).value).toBe('100');
    expect(field(/credit.*borderline/i).value).toBe('50');
    expect(field(/credit.*out of range/i).value).toBe('0');
    expect(field(/minimum body systems/i).value).toBe('2');
    expect(field(/good.*from/i).value).toBe('80');
    expect(field(/fair.*from/i).value).toBe('60');
    expect(field(/borderline margin/i).value).toBe('0');
    expect(field(/minimum mapped results/i).value).toBe('3');
    expect((screen.getByRole('radio', { name: /english/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('textbox', { name: /change summary/i }) as HTMLTextAreaElement).value).toBe('Synthetic wording update');
    expect(pageText()).toContain('hs-1');
    expect(pageText()).toContain('0 means no borderline band.');
  });

  it('Save sends PATCH with If-Match "<version>", bp = % x 100, only contract keys, then toasts "Saved"', async () => {
    routes[`PATCH ${vp(VER_DRAFT)}`] = json(versionDto({ version: 5 }));
    await showEditor();
    await setNum(/credit.*borderline/i, '40');
    await setNum(/borderline margin/i, '5');
    await userEvent.click(save());
    await waitFor(() => expect(patches()).toHaveLength(1));
    const p = patches()[0]!;
    expect(p.headers.get('if-match')).toBe('"4"');
    const body = bodyOf(p);
    expect(Object.keys(body).every((k) => ['language', 'change_summary', 'params'].includes(k))).toBe(true);
    expect(Object.keys(body.params).every((k) => k in PARAMS)).toBe(true);
    expect(body.params.credit_borderline_bp).toBe(4000);
    expect(body.params.borderline_fraction_bp).toBe(500);
    expect(body.params.credit_in_range_bp).toBe(10000);
    await waitFor(() => expect(pageText()).toMatch(/saved/i));
  });

  it.each([
    ['credit out of range above borderline (non-increasing order)', /credit.*out of range/i, '60'],
    ['fair >= good', /fair.*from/i, '90'],
    ['minimum body systems > 20', /minimum body systems/i, '21'],
    ['borderline margin > 25 %', /borderline margin/i, '26'],
    ['minimum mapped results 0', /minimum mapped results/i, '0'],
    ['max follow-up suggestions > 5', /max follow-up/i, '6'],
  ])('client check blocks Save: %s (no PATCH, error summary, focus inside it or on the field)', async (_n, label, value) => {
    await showEditor();
    await setNum(label, value);
    await userEvent.click(save());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(patches()).toHaveLength(0);
    const active = document.activeElement as HTMLElement;
    expect(active.closest('[role="alert"]') !== null || active.getAttribute('aria-invalid') === 'true' || active === field(label)).toBe(true);
  });

  it('a server 400 with errors[] is shown against the form (Form problem), not swallowed', async () => {
    routes[`PATCH ${vp(VER_DRAFT)}`] = () => problem('common.validation_failed', 400, { errors: [{ path: '/params/band_good_min', code: 'out_of_range', detail: 'must be between 1 and 100' }] });
    await showEditor();
    await userEvent.click(save());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(pageText()).toMatch(/must be between 1 and 100|good/i);
  });

  it('409 library_invalid_transition shows "This version is no longer a draft." and Reload calls router.refresh()', async () => {
    routes[`PATCH ${vp(VER_DRAFT)}`] = () => problem('smartreport.library_invalid_transition', 409);
    await showEditor();
    await userEvent.click(save());
    await waitFor(() => expect(pageText()).toContain('This version is no longer a draft.'));
    await userEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('409 version_conflict keeps the user on the form with an alert (no navigation)', async () => {
    routes[`PATCH ${vp(VER_DRAFT)}`] = () => problem('common.version_conflict', 409);
    await showEditor();
    await userEvent.click(save());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(lastNav()).toBeUndefined();
  });

  it('language = Nepali is sent as "ne"', async () => {
    routes[`PATCH ${vp(VER_DRAFT)}`] = json(versionDto({ language: 'ne', version: 5 }));
    await showEditor();
    await userEvent.click(screen.getByRole('radio', { name: /nepali/i }));
    await userEvent.click(save());
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(bodyOf(patches()[0]).language).toBe('ne');
  });
});

describe('Check & submit (AC-02.5)', () => {
  const VAL = vp(VER_DRAFT, '/validate');
  const SUB = vp(VER_DRAFT, '/submit');
  const issue = (over: Record<string, unknown> = {}) => ({ code: 'no_mappings', severity: 'error', detail: 'no mappings', ...over });
  const run = async () => { await userEvent.click(tab('Check & submit')); await userEvent.click(screen.getByRole('button', { name: /run checks/i })); };
  const submitBtn = () => screen.getByRole('button', { name: /submit for approval/i }) as HTMLButtonElement;

  it('fresh starter draft: the only issue listed is no_mappings; Submit is disabled', async () => {
    routes[`POST ${VAL}`] = json({ valid: false, issues: [issue()] });
    await showEditor();
    await run();
    const g = await waitFor(() => gridNamed(/issues|checks/i));
    expect(within(g).getAllByRole('columnheader').map((h) => norm(h.textContent)).slice(0, 4)).toEqual(['Severity', 'Code', 'Where', 'Detail']);
    const rows = rowTexts(g);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/error/i); expect(rows[0]).toContain('no_mappings');
    expect(submitBtn().disabled).toBe(true);
    expect(callsTo('POST', SUB)).toHaveLength(0);
  });

  it('warnings alone do not block; Submit sends POST #19 with If-Match then navigates', async () => {
    routes[`POST ${VAL}`] = json({ valid: true, issues: [issue({ code: 'group_unscored', severity: 'warning', detail: 'group unscored' })] });
    routes[`POST ${SUB}`] = json(versionDto({ status: 'in_review', version: 5 }));
    await showEditor();
    await run();
    await screen.findByRole('grid', { name: /issues|checks/i });
    expect(submitBtn().disabled).toBe(false);
    await userEvent.click(submitBtn());
    await waitFor(() => expect(callsTo('POST', SUB)).toHaveLength(1));
    expect(callsTo('POST', SUB)[0]!.headers.get('if-match')).toBe('"4"');
    await waitFor(() => expect(lastNav()).toMatch(/^\/smartreport\/library/));
  });

  it('a clean report says so and enables Submit', async () => {
    routes[`POST ${VAL}`] = json(REPORT_OK);
    await showEditor();
    await run();
    await waitFor(() => expect(submitBtn().disabled).toBe(false));
  });

  it('issue row actions jump to the owning tab (block_key -> Texts, rule_id -> Rules, else Analyte mapping)', async () => {
    routes[`POST ${VAL}`] = json({ valid: false, issues: [
      issue({ code: 'digits_not_allowed', block_key: 'deranged.alt.high', path: '/blocks/deranged.alt.high', detail: 'digits not allowed' }),
      issue({ code: 'followup_test_inactive', rule_id: '01940e00-0000-7000-8000-000000000021', path: '/rules/01940e00-0000-7000-8000-000000000021', detail: 'followup test inactive' }),
      issue(),
    ] });
    await showEditor();
    await run();
    await waitFor(() => gridNamed(/issues|checks/i));
    const acts = () => within(gridNamed(/issues|checks/i)).getAllByRole('button');
    await userEvent.click(acts()[0]!); expect(tab('Texts').getAttribute('aria-selected')).toBe('true');
    await userEvent.click(tab('Check & submit')); await userEvent.click(acts()[1]!); expect(tab('Rules').getAttribute('aria-selected')).toBe('true');
    await userEvent.click(tab('Check & submit')); await userEvent.click(acts()[2]!); expect(tab('Analyte mapping').getAttribute('aria-selected')).toBe('true');
  });

  it('issue detail is rendered as text (XSS corpus), never as markup', async () => {
    routes[`POST ${VAL}`] = json({ valid: false, issues: [issue({ detail: '<img src=x onerror=alert(1)><script>alert(2)</script>' })] });
    await showEditor();
    await run();
    const g = await waitFor(() => gridNamed(/issues|checks/i));
    expect(g.querySelector('img,script')).toBeNull();
    expect(g.textContent).toContain('<img src=x');
  });

  it('server 409 on Submit (no longer a draft) shows the banner', async () => {
    routes[`POST ${VAL}`] = json(REPORT_OK);
    routes[`POST ${SUB}`] = () => problem('smartreport.library_invalid_transition', 409);
    await showEditor();
    await run();
    await waitFor(() => expect(submitBtn().disabled).toBe(false));
    await userEvent.click(submitBtn());
    await waitFor(() => expect(pageText()).toContain('This version is no longer a draft.'));
  });
});
