// @vitest-environment jsdom
// C14.T20 — SR-04 tabs "Body systems", "Analyte mapping", "Rules" (04-UI-UX SR-04; AC-03.7, AC-04.1–AC-04.4, AC-05.1–AC-05.4 UI side). done_when: "follow-up banner".
// ASSUMED contract (same page/shell as sr-t20.editor.test.tsx; kit DataTable = role=grid, Drawer/Dialog = role=dialog, ConfirmDialog = role=alertdialog):
//   * Body systems: grid /body systems/i, columns Code · Display (English) · Display (Nepali) · Weight · Order · Shown (a switch per row, text "Shown"/"Hidden" allowed). Row "Edit" opens a form
//     (English display, Nepali display, Weight 0–10, Order, Shown switch) -> PUT #17 /groups/{code} with If-Match "<row version>", body {display_en, display_ne?, score_weight, sort_order, is_shown}.
//     English 1–60 required; Nepali required when the library language is Nepali.
//   * Analyte mapping: grid /analyte mapping/i, columns Analyte · Test · Body system · In score · Trend · Overrides · (actions). Body system shown as its display name (coded set organ_groups).
//     Names of analytes are resolved by the page from C3 and may be missing (the page must not break when /v1/catalog/* answers 503). Row "Edit" -> form with Body system (Select), "Include in score"
//     and "Show trend" checkboxes -> PUT #14 /analyte-groups/{analyte_id} with If-Match "<row version>", body {group_code, include_in_score, trend_enabled, …}. "Remove" -> alertdialog -> DELETE #15 (If-Match).
//     Empty: "No analytes mapped yet — summaries need at least {min_mapped_results} mapped results". NOT covered (no catalogue analyte search in contracts/openapi/catalog.yaml): the add-mapping combobox.
//   * Rules: sub-tabs (role=tab) Findings / Advice / Follow-up. A Banner (kit Banner, tone info) with the exact follow-up text is shown ONLY on the Follow-up sub-tab. Rows list trigger, direction,
//     priority, the block key and (follow-up) the interval in days. "Add rule" / row "Edit" / "Remove". Form: Trigger radios Analyte / Body system / Any finding / All in range (the last ONLY on the
//     Advice sub-tab); Body system Select (organ_groups); Direction; Minimum severity (hidden for All in range); Priority (default 100); Text Select = blocks of the SAME kind only;
//     Follow-up only: Suggested test + Interval in days (required, EMPTY by default). Create = POST #10 (Idempotency-Key), Edit = PUT #11 (If-Match "<rule version>"), Remove = DELETE #12 (If-Match).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ANALYTE_ALT, GROUPS, MANAGE, RULE_DERANGED, RULE_FOLLOWUP, TEST_CBC, VER_APPROVED, VER_DRAFT, api, axeClean, bodyOf, callsTo, gridNamed, json, mountEditorApi, norm, pageText, pick, problem, resetApi,
  router, routes, rowTexts, showEditor, versionDto, vp,
} from './sr-t20.harness';

vi.mock('next/navigation', async () => (await import('./sr-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./sr-t20.harness')).sessionMock);

const FOLLOWUP_BANNER = 'Follow-up suggestions are shown to patients. Keep them conservative; they must be justified by a finding. Prices and booking links are never shown.';
const G = vp(VER_DRAFT, '/groups'), A = vp(VER_DRAFT, '/analyte-groups'), R = vp(VER_DRAFT, '/rules');
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetApi(MANAGE); mountEditorApi(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const openTab = async (name: string) => { await showEditor(); await userEvent.click(screen.getByRole('tab', { name })); };
const rowOf = (text: RegExp) => within(screen.getAllByRole('grid')[0]!).getAllByRole('row').find((r) => text.test(r.textContent ?? ''))!;
const dlg = () => screen.findByRole('dialog');
const saveIn = (d: HTMLElement) => within(d).getByRole('button', { name: /^(save|create|add)/i });
const confirm = async () => userEvent.click(within(await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'))).getByRole('button', { name: /^(remove|delete|deactivate|confirm|yes)/i }));

describe('Body systems (AC-04.4 UI side)', () => {
  it('lists code, both display names, weight, order, shown state; the hidden group (iron) is shown as off', async () => {
    await openTab('Body systems');
    const g = gridNamed(/body systems/i);
    expect(within(g).getAllByRole('columnheader').map((h) => norm(h.textContent)).slice(0, 6)).toEqual(['Code', 'Display (English)', 'Display (Nepali)', 'Weight', 'Order', 'Shown']);
    const rows = rowTexts(g);
    expect(rows[0]).toMatch(/liver/); expect(rows[0]).toContain('कलेजो'); expect(rows[0]).toMatch(/3/);
    const sw = within(within(g).getAllByRole('row')[2]!).getByRole('switch') as HTMLInputElement;
    expect(sw.checked).toBe(false);
  });

  it('Edit -> PUT /groups/{code} with If-Match "<row version>" and the contract body', async () => {
    routes[`PUT ${G}/liver`] = json({ ...GROUPS[0], score_weight: 5, version: 3 });
    await openTab('Body systems');
    await userEvent.click(within(rowOf(/liver/i)).getByRole('button', { name: /^edit/i }));
    const d = await dlg();
    const w = within(d).getByRole('spinbutton', { name: /weight/i });
    await userEvent.clear(w); await userEvent.type(w, '5');
    await userEvent.click(saveIn(d));
    await waitFor(() => expect(callsTo('PUT', `${G}/liver`)).toHaveLength(1));
    const c = callsTo('PUT', `${G}/liver`)[0]!;
    expect(c.headers.get('if-match')).toBe('"2"');
    expect(bodyOf(c)).toMatchObject({ display_en: 'Liver', score_weight: 5, sort_order: 10, is_shown: true });
    expect(Object.keys(bodyOf(c)).every((k) => ['display_en', 'display_ne', 'score_weight', 'sort_order', 'is_shown'].includes(k))).toBe(true);
  });

  it.each([['weight 11', /weight/i, '11'], ['weight -1', /weight/i, '-1']])('client check: %s -> no PUT', async (_n, label, v) => {
    await openTab('Body systems');
    await userEvent.click(within(rowOf(/liver/i)).getByRole('button', { name: /^edit/i }));
    const d = await dlg();
    const w = within(d).getByRole('spinbutton', { name: label });
    await userEvent.clear(w); await userEvent.type(w, v);
    await userEvent.click(saveIn(d));
    await waitFor(() => expect(d.textContent).toMatch(/0.*10|between|at most|at least/i));
    expect(callsTo('PUT', `${G}/liver`)).toHaveLength(0);
  });

  it('English display is required (1–60) and 61 characters are refused', async () => {
    await openTab('Body systems');
    await userEvent.click(within(rowOf(/liver/i)).getByRole('button', { name: /^edit/i }));
    const d = await dlg();
    const en = within(d).getByRole('textbox', { name: /display.*english/i });
    await userEvent.clear(en); await userEvent.click(saveIn(d));
    await waitFor(() => expect(d.textContent).toMatch(/required/i));
    await userEvent.click(en); await userEvent.paste('x'.repeat(61)); await userEvent.click(saveIn(d));
    await waitFor(() => expect(d.textContent).toMatch(/60/));
    expect(callsTo('PUT', `${G}/liver`)).toHaveLength(0);
  });

  it('Nepali display is required when the library language is Nepali', async () => {
    mountEditorApi(VER_DRAFT, versionDto({ language: 'ne' }));
    await openTab('Body systems');
    await userEvent.click(within(rowOf(/iron/i)).getByRole('button', { name: /^edit/i }));
    const d = await dlg();
    await userEvent.click(saveIn(d));
    await waitFor(() => expect(d.textContent).toMatch(/required/i));
    expect(callsTo('PUT', `${G}/iron`)).toHaveLength(0);
  });
});

describe('Analyte mapping (AC-04.1–AC-04.3, AC-03.7)', () => {
  it('lists the mapping with the body system DISPLAY name and in-score / trend as text; survives C3 name lookup failures (503)', async () => {
    await openTab('Analyte mapping');
    const g = gridNamed(/analyte mapping/i);
    expect(within(g).getAllByRole('columnheader').map((h) => norm(h.textContent)).slice(0, 6)).toEqual(['Analyte', 'Test', 'Body system', 'In score', 'Trend', 'Overrides']);
    expect(rowTexts(g)[0]).toContain('Liver');
    expect(rowTexts(g)[0]).toMatch(/yes|included|on/i);
  });

  it('empty state shows the documented text with the version minimum', async () => {
    mountEditorApi(VER_DRAFT, versionDto(), { mappings: [] });
    await openTab('Analyte mapping');
    expect(pageText()).toContain('No analytes mapped yet — summaries need at least 3 mapped results');
  });

  it('AC-04.3: changing the body system PUTs the replacement with If-Match "<row version>"', async () => {
    routes[`PUT ${A}/${ANALYTE_ALT}`] = json({ analyte_id: ANALYTE_ALT, group_code: 'kidney', include_in_score: true, trend_enabled: false, sort_order: 10, version: 4 });
    await openTab('Analyte mapping');
    await userEvent.click(within(rowOf(/liver/i)).getByRole('button', { name: /^edit/i }));
    const d = await dlg();
    await pick(/body system/i, /kidney/i);
    await userEvent.click(saveIn(d));
    await waitFor(() => expect(callsTo('PUT', `${A}/${ANALYTE_ALT}`)).toHaveLength(1));
    const c = callsTo('PUT', `${A}/${ANALYTE_ALT}`)[0]!;
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(bodyOf(c)).toMatchObject({ group_code: 'kidney', include_in_score: true, trend_enabled: false });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('AC-04.1: Include in score / Show trend checkboxes are sent as chosen', async () => {
    routes[`PUT ${A}/${ANALYTE_ALT}`] = json({ analyte_id: ANALYTE_ALT, group_code: 'liver', include_in_score: false, trend_enabled: true, sort_order: 10, version: 4 });
    await openTab('Analyte mapping');
    await userEvent.click(within(rowOf(/liver/i)).getByRole('button', { name: /^edit/i }));
    const d = await dlg();
    await userEvent.click(within(d).getByRole('checkbox', { name: /include in score/i }));
    await userEvent.click(within(d).getByRole('checkbox', { name: /show trend/i }));
    await userEvent.click(saveIn(d));
    await waitFor(() => expect(callsTo('PUT', `${A}/${ANALYTE_ALT}`)).toHaveLength(1));
    expect(bodyOf(callsTo('PUT', `${A}/${ANALYTE_ALT}`)[0])).toMatchObject({ group_code: 'liver', include_in_score: false, trend_enabled: true });
  });

  it('AC-04.2: a 404 on the PUT (analyte of another tenant) is a generic not-found alert — no id, no raw text', async () => {
    routes[`PUT ${A}/${ANALYTE_ALT}`] = () => problem('common.not_found', 404, { detail: 'analyte 01940e00-0000-7000-8000-000000000031 belongs to tenant_b' });
    await openTab('Analyte mapping');
    await userEvent.click(within(rowOf(/liver/i)).getByRole('button', { name: /^edit/i }));
    const d = await dlg();
    await userEvent.click(saveIn(d));
    const a = await screen.findByRole('alert');
    expect(a.textContent).toMatch(/not found|no longer|unavailable/i);
    expect(pageText()).not.toMatch(/tenant_b|000000000031/);
  });

  it('AC-03.7: Remove asks first, then DELETEs with If-Match (deactivation) and refreshes', async () => {
    routes[`DELETE ${A}/${ANALYTE_ALT}`] = () => new Response(null, { status: 204 });
    await openTab('Analyte mapping');
    await userEvent.click(within(rowOf(/liver/i)).getByRole('button', { name: /^(remove|delete)/i }));
    expect(callsTo('DELETE', `${A}/${ANALYTE_ALT}`)).toHaveLength(0);
    await confirm();
    await waitFor(() => expect(callsTo('DELETE', `${A}/${ANALYTE_ALT}`)).toHaveLength(1));
    expect(callsTo('DELETE', `${A}/${ANALYTE_ALT}`)[0]!.headers.get('if-match')).toBe('"3"');
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('read-only version: no Edit / Remove', async () => {
    mountEditorApi(VER_APPROVED, versionDto({ id: VER_APPROVED, status: 'approved' }));
    await showEditor(VER_APPROVED);
    await userEvent.click(screen.getByRole('tab', { name: 'Analyte mapping' }));
    expect(screen.queryByRole('button', { name: /^(edit|remove|add)/i })).toBeNull();
  });
});

describe('Rules (AC-05.1–AC-05.4; done_when: follow-up banner)', () => {
  const sub = (n: RegExp) => screen.getByRole('tab', { name: n });
  const openRules = async (subtab: RegExp = /findings/i) => { await openTab('Rules'); await userEvent.click(sub(subtab)); };

  it('three sub-tabs; the follow-up banner appears ONLY on Follow-up, with the exact text, and is not alarm-styled', async () => {
    await openRules(/findings/i);
    expect(screen.getAllByRole('tab').filter((t) => /^(findings|advice|follow-up)$/i.test(norm(t.textContent)))).toHaveLength(3);
    expect(pageText()).not.toContain(FOLLOWUP_BANNER);
    await userEvent.click(sub(/advice/i)); expect(pageText()).not.toContain(FOLLOWUP_BANNER);
    await userEvent.click(sub(/follow-up/i));
    expect(pageText()).toContain(FOLLOWUP_BANNER);
    expect(screen.queryAllByRole('alert').some((a) => a.textContent?.includes(FOLLOWUP_BANNER))).toBe(false);
  });

  it('follow-up rows show the block key and the interval in days; findings rows do not leak follow-up rules', async () => {
    await openRules(/follow-up/i);
    const r = rowTexts(screen.getAllByRole('grid')[0]!);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain('followup.liver.retest'); expect(r[0]).toMatch(/90/);
    await userEvent.click(sub(/findings/i));
    expect(rowTexts(screen.getAllByRole('grid')[0]!).join(' ')).not.toContain('followup.liver.retest');
  });

  it('AC-05.3: "All in range" is offered for Advice only — never for Findings or Follow-up', async () => {
    for (const [s, expected] of [[/findings/i, false], [/advice/i, true], [/follow-up/i, false]] as const) {
      await openRules(s);
      await userEvent.click(screen.getByRole('button', { name: /add rule/i }));
      const d = await dlg();
      expect(!!within(d).queryByRole('radio', { name: /all in range/i }), String(s)).toBe(expected);
      expect(within(d).getByRole('radio', { name: /body system/i })).toBeTruthy();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      cleanup();
    }
  });

  it('Advice + "All in range" hides Minimum severity', async () => {
    await openRules(/advice/i);
    await userEvent.click(screen.getByRole('button', { name: /add rule/i }));
    const d = await dlg();
    await userEvent.click(within(d).getByRole('radio', { name: /all in range/i }));
    expect(within(d).queryByRole('button', { name: /minimum severity/i })).toBeNull();
  });

  it('AC-05.4: the Text select offers only blocks of the rule kind', async () => {
    await openRules(/follow-up/i);
    await userEvent.click(screen.getByRole('button', { name: /add rule/i }));
    const d = await dlg();
    await userEvent.click(within(d).getByRole('button', { name: /^text/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => norm(o.textContent));
    expect(opts.some((o) => o.includes('followup.liver.retest'))).toBe(true);
    expect(opts.some((o) => o.includes('deranged.alt.high') || o.includes('advice.liver.general'))).toBe(false);
  });

  it('AC-05.1: Interval in days is EMPTY by default (no default anywhere) and required: submitting without it sends nothing', async () => {
    await openRules(/follow-up/i);
    await userEvent.click(screen.getByRole('button', { name: /add rule/i }));
    const d = await dlg();
    const iv = within(d).getByRole('spinbutton', { name: /interval in days/i }) as HTMLInputElement;
    expect(iv.value).toBe('');
    await userEvent.click(within(d).getByRole('radio', { name: /body system/i }));
    await pick(/body system/i, /liver/i);
    await pick(/^text/i, /followup\.liver\.retest/i);
    await userEvent.click(saveIn(d));
    await waitFor(() => expect(d.textContent).toMatch(/interval/i));
    expect(callsTo('POST', R)).toHaveLength(0);
  });

  it.each([['0', 'below 1'], ['731', 'above 730']])('interval %s (%s) is refused client-side', async (v) => {
    await openRules(/follow-up/i);
    await userEvent.click(within(rowOf(/followup\.liver\.retest/)).getByRole('button', { name: /^edit/i }));
    const d = await dlg();
    const iv = within(d).getByRole('spinbutton', { name: /interval in days/i });
    await userEvent.clear(iv); await userEvent.type(iv, v);
    await userEvent.click(saveIn(d));
    await waitFor(() => expect(d.textContent).toMatch(/1.*730|between|at most|at least/i));
    expect(callsTo('PUT', `${R}/${RULE_FOLLOWUP}`)).toHaveLength(0);
  });

  it('Edit a follow-up rule: PUT with If-Match "<rule version>", the new interval, and the suggested test kept', async () => {
    routes[`PUT ${R}/${RULE_FOLLOWUP}`] = json({ ...RULE_FU, interval_days: 120, version: 2 });
    await openRules(/follow-up/i);
    await userEvent.click(within(rowOf(/followup\.liver\.retest/)).getByRole('button', { name: /^edit/i }));
    const d = await dlg();
    const iv = within(d).getByRole('spinbutton', { name: /interval in days/i });
    await userEvent.clear(iv); await userEvent.type(iv, '120');
    await userEvent.click(saveIn(d));
    await waitFor(() => expect(callsTo('PUT', `${R}/${RULE_FOLLOWUP}`)).toHaveLength(1));
    const c = callsTo('PUT', `${R}/${RULE_FOLLOWUP}`)[0]!;
    expect(c.headers.get('if-match')).toBe('"1"');
    expect(bodyOf(c)).toMatchObject({ rule_kind: 'followup', trigger_kind: 'group', group_code: 'liver', interval_days: 120, suggested_test_id: TEST_CBC });
    expect(bodyOf(c).trigger_kind).not.toBe('all_in_range');
  });

  it('server 400 on /block_id (kind mismatch) or /interval_days is shown, not swallowed', async () => {
    routes[`PUT ${R}/${RULE_FOLLOWUP}`] = () => problem('common.validation_failed', 400, { errors: [{ path: '/block_id', code: 'kind_mismatch', detail: 'block kind mismatch' }] });
    await openRules(/follow-up/i);
    await userEvent.click(within(rowOf(/followup\.liver\.retest/)).getByRole('button', { name: /^edit/i }));
    const d = await dlg();
    await userEvent.click(saveIn(d));
    await waitFor(() => expect(d.textContent).toMatch(/kind mismatch|text/i));
  });

  it('a validation report issue followup_test_inactive is visible in Check & submit as text (AC-05.2 UI side)', async () => {
    routes[`POST ${vp(VER_DRAFT, '/validate')}`] = json({ valid: false, issues: [{ code: 'followup_test_inactive', severity: 'error', rule_id: RULE_FOLLOWUP, path: `/rules/${RULE_FOLLOWUP}`, detail: 'followup test inactive' }] });
    await showEditor();
    await userEvent.click(screen.getByRole('tab', { name: 'Check & submit' }));
    await userEvent.click(screen.getByRole('button', { name: /run checks/i }));
    await waitFor(() => expect(pageText()).toContain('followup_test_inactive'));
  });

  it('AC-03.7: Remove a rule asks first, then DELETEs with If-Match and refreshes', async () => {
    routes[`DELETE ${R}/${RULE_DERANGED}`] = () => new Response(null, { status: 204 });
    await openRules(/findings/i);
    await userEvent.click(within(rowOf(/deranged\.alt\.high/)).getByRole('button', { name: /^(remove|delete)/i }));
    expect(callsTo('DELETE', `${R}/${RULE_DERANGED}`)).toHaveLength(0);
    await confirm();
    await waitFor(() => expect(callsTo('DELETE', `${R}/${RULE_DERANGED}`)).toHaveLength(1));
    expect(callsTo('DELETE', `${R}/${RULE_DERANGED}`)[0]!.headers.get('if-match')).toBe('"1"');
  });

  it('read-only version: rules visible, no add / edit / remove; banner still shown on Follow-up', async () => {
    mountEditorApi(VER_APPROVED, versionDto({ id: VER_APPROVED, status: 'approved' }));
    await showEditor(VER_APPROVED);
    await userEvent.click(screen.getByRole('tab', { name: 'Rules' }));
    await userEvent.click(sub(/follow-up/i));
    expect(screen.queryByRole('button', { name: /^(add|edit|remove)/i })).toBeNull();
    expect(pageText()).toContain(FOLLOWUP_BANNER);
  });

  it('axe-clean with a rule editor open', async () => {
    await openRules(/follow-up/i);
    await userEvent.click(screen.getByRole('button', { name: /add rule/i }));
    await dlg();
    await axeClean();
  });
});

const RULE_FU = { id: RULE_FOLLOWUP, rule_kind: 'followup', trigger_kind: 'group', group_code: 'liver', direction: 'high', priority: 100, block_id: '01940e00-0000-7000-8000-000000000012', suggested_test_id: TEST_CBC, interval_days: 90, version: 1 };
