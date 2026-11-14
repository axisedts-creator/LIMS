// @vitest-environment jsdom
// C10.T-22 — report compose drawer "Preliminary report" / "Final report" (04-UI-UX §3.4; 03-APP-FLOW §4.6; AC-09.1/09.2/09.3/09.6, AC-10.1/10.3/10.4/10.5, AC-11.2/11.3/11.6 UI side).
// Real server actions + MSW (M14 submitCultureReport). Seam: CultureScreen — see t22.harness.tsx. LD-140: kit only, one primary button per page.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import {
  CODED, ID, ORIGIN, PERM_AMEND, PERM_WORK, SUBMIT, amending, api, approvedPreliminary, code, describedText, growth, headerBtn, hit, incubating, isoAt, isolate, obs, optionNames, pick, problem, resetHits,
  router, state, submitBtn, submitFail, submitOk, useReports, astResult,
} from './t22.harness';

vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.refresh.mockReset(); state.permissions = PERM_WORK; useReports(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (c: Record<string, unknown> = growth(), permissions: string[] = PERM_WORK) => {
  const { CultureScreen } = await import('../components/culture/CultureScreen');
  return render(<ToastProvider><CultureScreen culture={c as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={permissions} /></ToastProvider>);
};
const open = async (phase: 'preliminary' | 'final', c: Record<string, unknown> = growth(), permissions: string[] = PERM_WORK) => {
  await mount(c, permissions);
  await userEvent.click(headerBtn(new RegExp(`^${phase} report$`, 'i')));
  return screen.findByRole('dialog', { name: new RegExp(`^${phase} report$`, 'i') });
};
const summary = (d: HTMLElement) => within(d).getByRole('textbox', { name: /^summary/i }) as HTMLTextAreaElement;
const comments = (d: HTMLElement) => within(d).getByRole('textbox', { name: /^comments/i }) as HTMLTextAreaElement;
const critical = (d: HTMLElement) => within(d).getByRole('checkbox', { name: /notify as critical/i }) as HTMLInputElement;
const early = (d: HTMLElement) => within(d).queryByRole('textbox', { name: /reason for early final/i }) as HTMLTextAreaElement | null;
const outcomeBtn = (d: HTMLElement) => within(d).getByRole('button', { name: /outcome/i });
const posts = () => hit('POST', SUBMIT);
const lastPost = async () => { await waitFor(() => expect(posts().length).toBeGreaterThan(0)); return posts().at(-1)!; };
const send = (d: HTMLElement) => userEvent.click(submitBtn(d));
const setValue = (el: HTMLElement, v: string) => fireEvent.change(el, { target: { value: v } });
const finalReady = async (c: Record<string, unknown> = growth(), permissions: string[] = PERM_WORK) => {
  const d = await open('final', c, permissions);
  await pick(d, /outcome/i, /growth — see isolates/i);
  return d;
};

describe('opening (04-UI-UX §3.4 drawer table)', () => {
  it('"Preliminary report" drawer: Summary (4000, generated), Comments (4000), Notify as critical, Regenerate, Send for verification; no Outcome, no early-final, no amendment reason', async () => {
    const d = await open('preliminary');
    expect(summary(d).maxLength).toBe(4000);
    expect(summary(d).value.length).toBeGreaterThan(0);
    expect(comments(d).maxLength).toBe(4000);
    expect(comments(d).value).toBe('');
    expect(critical(d).checked).toBe(false);
    expect(within(d).getByRole('button', { name: /^regenerate$/i })).toBeTruthy();
    expect(submitBtn(d)).toBeTruthy();
    expect(within(d).queryByRole('button', { name: /outcome/i })).toBeNull();
    expect(early(d)).toBeNull();
    expect(d.textContent).not.toMatch(/amendment reason/i);
  });
  it('"Final report" drawer: Outcome select over culture_outcomes (display names), required', async () => {
    const d = await open('final');
    expect(await optionNames(outcomeBtn(d))).toEqual(['No growth', 'Growth — see isolates', 'Normal flora only']);
  });
  it('is a right Drawer, not a Dialog (kit Drawer: width lg)', async () => {
    const d = await open('preliminary');
    expect(d.closest('.lims-drawer.lims-drawer-lg')).not.toBeNull();
  });
  it('the header buttons: enabled per T-20 table; "Preliminary report" not offered for awaiting_setup, "Final report" not for awaiting_setup', async () => {
    await mount(incubating({ status: 'awaiting_setup' }));
    expect(screen.queryByRole('button', { name: /^(preliminary|final) report$/i })).toBeNull();
  });
  it('Alt+P opens the preliminary drawer and Alt+F the final one (04-UI-UX §3 shortcut table)', async () => {
    await mount();
    const press = async (key: string) => { const s = (await (await import('@/core/shortcuts/registry')).shortcuts.list('micro.culture')).find((x) => x.key === key)!; act(() => s.run()); };
    await press('Alt+P');
    expect(await screen.findByRole('dialog', { name: /^preliminary report$/i })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await press('Alt+F');
    expect(await screen.findByRole('dialog', { name: /^final report$/i })).toBeTruthy();
  });
  it('Alt+P / Alt+F do nothing on a final_submitted culture', async () => {
    const { finalCulture } = await import('./t22.harness');
    await mount(finalCulture());
    const list = (await import('@/core/shortcuts/registry')).shortcuts.list('micro.culture');
    for (const k of ['Alt+P', 'Alt+F']) act(() => (list as { key: string; run: () => void }[]).find((x) => x.key === k)!.run());
    expect(screen.queryByRole('dialog', { name: /(preliminary|final) report/i })).toBeNull();
  });
});

describe('included isolates and AST (client-side preview of what the server snapshots; AC-10.5, AC-10.2 highlight)', () => {
  const rich = () => growth({
    isolates: [
      isolate(1, { organism_display: 'Synthetic organism', ast: [astResult(1, 'syn_cef_a', 'Synthetic cefA', { raw_value: '0.25', category_code: 'S', standard: 'CLSI', standard_version: 'M100-Ed36' }), astResult(2, 'syn_gen_b', 'Synthetic genB', { raw_value: '18' }),
        astResult(3, 'syn_hid_c', 'Synthetic hiddenC', { raw_value: '1', category_code: 'S', is_reportable: false }), astResult(4, 'syn_sup_d', 'Synthetic suppressedD', { raw_value: '1', category_code: 'S', report_visibility: 'suppressed_by_rule' })] }),
      isolate(2, { status: 'withdrawn', is_reportable: false, organism_display: 'Withdrawn organism' }),
      isolate(3, { status: 'pending_id', organism_code: undefined, organism_display: undefined }),
      isolate(4, { is_reportable: false, organism_display: 'Unreportable organism' }),
    ],
  });
  it('lists only identified, reportable, non-withdrawn isolates and only reportable, shown AST rows', async () => {
    const d = await open('preliminary', rich());
    expect(d.textContent).toContain('Synthetic organism');
    expect(d.textContent).toContain('Synthetic cefA');
    expect(d.textContent).toContain('Synthetic genB');
    for (const hidden of ['Withdrawn organism', 'Unreportable organism', 'Synthetic hiddenC', 'Synthetic suppressedD', 'Not identified']) expect(d.textContent, hidden).not.toContain(hidden);
  });
  it('a reportable row without a category is highlighted with the text "Category missing" (once); complete rows are not', async () => {
    const d = await open('final', rich());
    expect((d.textContent?.match(/category missing/gi) ?? []).length).toBe(1);
    const row = within(d).getAllByRole('row').find((r) => /synthetic genB/i.test(r.textContent ?? ''))!;
    expect(row.textContent).toMatch(/category missing/i);
    const ok = within(d).getAllByRole('row').find((r) => /synthetic cefA/i.test(r.textContent ?? ''))!;
    expect(ok.textContent).not.toMatch(/category missing/i);
    expect(ok.textContent).toMatch(/S/);
  });
  it('the AST table shows the raw value with the method unit and the standard + version', async () => {
    const d = await open('preliminary', rich());
    const row = within(d).getAllByRole('row').find((r) => /synthetic cefA/i.test(r.textContent ?? ''))!;
    expect(row.textContent).toMatch(/0\.25/);
    expect(row.textContent).toMatch(/CLSI/);
    expect(row.textContent).toMatch(/M100-Ed36/);
  });
  it('organism names are rendered as text, never as HTML (REQ-SEC-088)', async () => {
    const d = await open('preliminary', growth({ isolates: [isolate(1, { organism_display: '<img src=x onerror=alert(1)>Synthetic', ast: [] })] }));
    expect(d.querySelector('img')).toBeNull();
    expect(d.textContent).toContain('<img src=x onerror=alert(1)>Synthetic');
  });
});

describe('generated summary and Regenerate (02-TRD §4.6 [CONV])', () => {
  it('preliminary: starts "Preliminary report", then Gram stain (latest), then one line per isolate "Isolate {seq}: {organism} — {growth}"', async () => {
    const c = growth({ observations: [obs(1), obs(2, { kind: 'gram_stain', finding_text: 'Synthetic old gram', plate_id: undefined }), obs(3, { kind: 'gram_stain', finding_text: 'Synthetic newest gram', plate_id: undefined })] });
    const d = await open('preliminary', c);
    const lines = summary(d).value.split('\n');
    expect(lines[0]).toBe('Preliminary report');
    expect(lines).toContain('Gram stain: Synthetic newest gram');
    expect(summary(d).value).not.toContain('Synthetic old gram');
    expect(lines).toContain('Isolate 1: Synthetic organism — ≥10^5 CFU/mL');
  });
  it('final: after choosing the outcome, Regenerate starts the text with "Final: {outcome display}"', async () => {
    const d = await finalReady();
    await userEvent.click(within(d).getByRole('button', { name: /^regenerate$/i }));
    expect(summary(d).value.split('\n')[0]).toBe('Final: Growth — see isolates');
  });
  it('Regenerate replaces edits with the generated text; edits are kept otherwise', async () => {
    const d = await open('preliminary');
    const generated = summary(d).value;
    await userEvent.type(summary(d), ' extra words');
    expect(summary(d).value).toBe(`${generated} extra words`);
    await userEvent.click(within(d).getByRole('button', { name: /^regenerate$/i }));
    expect(summary(d).value).toBe(generated);
  });
  it('a summary of more than 4000 characters is truncated to 4000 with an ellipsis, as the server does', async () => {
    const many = Array.from({ length: 20 }, (_, i) => isolate(i + 1, { organism_display: `Synthetic organism ${'x'.repeat(300)} ${i}`, ast: [] }));
    const d = await open('preliminary', growth({ isolates: many }));
    expect(summary(d).value.length).toBeLessThanOrEqual(4000);
    expect(summary(d).value.endsWith('…')).toBe(true);
  });
});

describe('Notify as critical (pre-ticked when an alert organism is in the snapshot)', () => {
  it('ticked for an organism with is_alert = true, unticked otherwise; the user can change it and the choice is sent', async () => {
    CODED['organisms']!.push(code('synthetic_alert_org', { display: 'Synthetic alert organism', is_alert: true, organism_group_code: 'synthetic_group' }));
    try {
      const d = await open('preliminary', growth({ isolates: [isolate(1, { organism_code: 'synthetic_alert_org', organism_display: 'Synthetic alert organism', ast: [] })] }));
      await waitFor(() => expect(critical(d).checked).toBe(true));
      await userEvent.click(critical(d));
      await send(d);
      expect((await lastPost()).json.is_critical).toBe(false);
    } finally { CODED['organisms'] = CODED['organisms']!.filter((c) => c.code !== 'synthetic_alert_org'); }
  });
  it('not ticked for a non-alert organism', async () => {
    const d = await open('preliminary');
    await new Promise((r) => setTimeout(r, 100));
    expect(critical(d).checked).toBe(false);
  });
  it('a withdrawn alert organism does not tick it', async () => {
    CODED['organisms']!.push(code('synthetic_alert_org', { display: 'Synthetic alert organism', is_alert: true }));
    try {
      const d = await open('preliminary', growth({ isolates: [isolate(1, { status: 'withdrawn', is_reportable: false, organism_code: 'synthetic_alert_org', organism_display: 'Synthetic alert organism' })] }));
      await new Promise((r) => setTimeout(r, 100));
      expect(critical(d).checked).toBe(false);
    } finally { CODED['organisms'] = CODED['organisms']!.filter((c) => c.code !== 'synthetic_alert_org'); }
  });
});

describe('submitting a preliminary (AC-09.1; S-05 strict body)', () => {
  it('POST /report-versions with an Idempotency-Key, no If-Match, exactly { report_phase, is_critical, culture_summary_text }', async () => {
    const d = await open('preliminary');
    await send(d);
    const h = await lastPost();
    expect(h.path).toMatch(/\/v1\/micro\/cultures\/[^/]+\/report-versions$/);
    expect(h.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(h.headers.get('if-match')).toBeNull();
    expect(Object.keys(h.json).sort()).toEqual(['culture_summary_text', 'is_critical', 'report_phase']);
    expect(h.json.report_phase).toBe('preliminary');
    expect(h.json.is_critical).toBe(false);
    expect(h.json.culture_summary_text).toMatch(/^Preliminary report/);
  });
  it('the typed summary and comments are sent; empty comments are omitted', async () => {
    const d = await open('preliminary');
    setValue(summary(d), 'Synthetic edited summary');
    await send(d);
    expect(Object.keys((await lastPost()).json)).not.toContain('comments_text');
    cleanup(); resetHits();
    const d2 = await open('preliminary');
    setValue(summary(d2), 'Synthetic edited summary');
    setValue(comments(d2), 'Synthetic comment line');
    await send(d2);
    const h = await lastPost();
    expect(h.json.culture_summary_text).toBe('Synthetic edited summary');
    expect(h.json.comments_text).toBe('Synthetic comment line');
  });
  it('the amendment fields and outcome are never sent for a preliminary (the server decides amendments, AC-09.6)', async () => {
    const d = await open('preliminary', approvedPreliminary({ permissions_hint: { can_amend_approved: true } }), PERM_AMEND);
    await send(d);
    const keys = Object.keys((await lastPost()).json);
    for (const k of ['amendment', 'amendment_reason_code', 'amendment_reason_text', 'outcome_code', 'early_final_reason']) expect(keys, k).not.toContain(k);
  });
  it('success: toast "Report version {n} sent for verification", the drawer closes, the page refreshes and the Reports tab is shown', async () => {
    api.use(submitOk(3));
    const d = await open('preliminary');
    await send(d);
    expect(await screen.findByText(/report version 3 sent for verification/i)).toBeTruthy();
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: /preliminary report/i })).toBeNull();
    expect(screen.getByRole('tab', { name: /^reports/i }).getAttribute('aria-selected')).toBe('true');
  });
  it('Ctrl+Enter submits', async () => {
    const d = await open('preliminary');
    await userEvent.click(summary(d));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(posts()).toHaveLength(1));
  });
  it('a double click sends one request', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/report-versions`, async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json({}, { status: 201 }); }));
    const d = await open('preliminary');
    await userEvent.dblClick(submitBtn(d));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(posts()).toHaveLength(1);
  });
  it('an empty summary is refused client-side (1..4000): no request, field marked invalid', async () => {
    const d = await open('preliminary');
    setValue(summary(d), '');
    await send(d);
    expect(posts()).toHaveLength(0);
    expect(summary(d).getAttribute('aria-invalid')).toBe('true');
  });
  it('a failed attempt retried from the same drawer keeps the Idempotency-Key (AC-09.3); a re-opened drawer gets a new one', async () => {
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/report-versions`, () => (++n === 1 ? problem('common.internal', 500) : HttpResponse.json({ version_no: 1 }, { status: 201 }))));
    const d = await open('preliminary');
    await send(d);
    await waitFor(() => expect(posts()).toHaveLength(1));
    await within(screen.getByRole('dialog', { name: /preliminary report/i })).findByText(/something went wrong/i);
    await send(screen.getByRole('dialog', { name: /preliminary report/i }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.headers.get('idempotency-key')).toBe(posts()[0]!.headers.get('idempotency-key'));
    cleanup(); resetHits(); api.resetHandlers(); useReports();
    const a = await open('preliminary'); await send(a); await lastPost();
    const k1 = posts()[0]!.headers.get('idempotency-key');
    cleanup(); resetHits();
    const b = await open('preliminary'); await send(b); await lastPost();
    expect(posts()[0]!.headers.get('idempotency-key')).not.toBe(k1);
  });
});

describe('submitting a final (AC-10.1, AC-10.4)', () => {
  it('Outcome is required: no request and the drawer shows an invalid field', async () => {
    const d = await open('final');
    await send(d);
    expect(posts()).toHaveLength(0);
    expect(d.querySelector('[data-invalid]')).not.toBeNull();
    expect(d.querySelector('.lims-error')?.textContent ?? '').toMatch(/outcome/i);
  });
  it('POST sends outcome_code with report_phase "final", is_critical and the summary', async () => {
    const d = await finalReady();
    await send(d);
    const h = await lastPost();
    expect(Object.keys(h.json).sort()).toEqual(['culture_summary_text', 'is_critical', 'outcome_code', 'report_phase']);
    expect(h.json.report_phase).toBe('final');
    expect(h.json.outcome_code).toBe('growth_reported');
  });
  it('a final from an amending culture sends no amendment object or reason: C10 takes it from the reopen (AC-11.2)', async () => {
    const d = await finalReady(amending());
    await send(d);
    const keys = Object.keys((await lastPost()).json);
    expect(keys.filter((k) => /amend/i.test(k))).toEqual([]);
  });
  it('an amending culture shows the amendment reason read-only (AC-11.2)', async () => {
    const d = await open('final', amending());
    expect(d.textContent).toMatch(/amendment reason/i);
    expect(d.textContent).toContain('Synthetic wrong isolate number');
    expect(within(d).queryByRole('textbox', { name: /amendment reason/i })).toBeNull();
    expect(within(d).queryByRole('button', { name: /amendment reason/i })).toBeNull();
  });
});

describe('early final reason (AC-10.3)', () => {
  const noGrowth = (over: Record<string, unknown> = {}) => growth({ isolates: [], final_due_at: isoAt(12), ...over });
  it('no_growth before the final-due time: the field shows (max 500) and is required when the setting is on (default)', async () => {
    const d = await open('final', noGrowth());
    await pick(d, /outcome/i, /^no growth$/i);
    expect(early(d)).toBeTruthy();
    expect(early(d)!.maxLength).toBe(500);
    await send(d);
    expect(posts()).toHaveLength(0);
    expect(early(d)!.getAttribute('aria-invalid')).toBe('true');
  });
  it('a typed reason is sent as early_final_reason', async () => {
    const d = await open('final', noGrowth());
    await pick(d, /outcome/i, /^no growth$/i);
    await userEvent.type(early(d)!, 'Synthetic early reason');
    await send(d);
    expect((await lastPost()).json.early_final_reason).toBe('Synthetic early reason');
  });
  it('after the final-due time, or for another outcome, the field is absent and not sent', async () => {
    const d = await open('final', noGrowth({ final_due_at: isoAt(-1) }));
    await pick(d, /outcome/i, /^no growth$/i);
    expect(early(d)).toBeNull();
    await send(d);
    expect(Object.keys((await lastPost()).json)).not.toContain('early_final_reason');
    cleanup();
    const d2 = await open('final', noGrowth());
    await pick(d2, /outcome/i, /normal flora only/i);
    expect(early(d2)).toBeNull();
  });
  it('with early_final_requires_reason = false the submission goes without a reason', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/settings`, () => HttpResponse.json({ id: ID(9), version: 1, manual_ast_standard: 'CLSI', zone_suggestion_enabled: true, mic_suggestion_enabled: false, default_final_no_growth_hours: 48, early_final_requires_reason: false, recent_window_days: 7, is_active: true })));
    const d = await open('final', noGrowth());
    await pick(d, /outcome/i, /^no growth$/i);
    await new Promise((r) => setTimeout(r, 100));
    await send(d);
    const h = await lastPost();
    expect(Object.keys(h.json)).not.toContain('early_final_reason');
  });
});

describe('disabled-state explanation (AC-09.6; 08 A17 D-61; 03-APP-FLOW §4.6 step 3)', () => {
  const FINAL_TEXT = /the preliminary report is already approved\. a pathologist must submit the final\./i;
  const PRELIM_TEXT = /the preliminary report is already approved\. a pathologist must submit an updated preliminary\./i;
  it('approved preliminary + no lab.result.amend (final drawer): submit disabled, the explanation is shown and linked to the button', async () => {
    const d = await open('final', approvedPreliminary());
    expect(d.textContent).toMatch(FINAL_TEXT);
    expect(d.textContent).not.toMatch(PRELIM_TEXT);
    const b = submitBtn(d) as HTMLButtonElement;
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(describedText(b)).toMatch(FINAL_TEXT);
  });
  it('approved preliminary + no lab.result.amend (preliminary drawer): the "updated preliminary" explanation', async () => {
    const d = await open('preliminary', approvedPreliminary());
    expect(d.textContent).toMatch(PRELIM_TEXT);
    expect(d.textContent).not.toMatch(FINAL_TEXT);
    const b = submitBtn(d) as HTMLButtonElement;
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
  });
  it('a click and Ctrl+Enter on the disabled submit send nothing', async () => {
    const d = await open('preliminary', approvedPreliminary());
    await send(d);
    await userEvent.click(summary(d));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await new Promise((r) => setTimeout(r, 100));
    expect(posts()).toHaveLength(0);
  });
  it('with can_amend_approved (lab.result.amend) the submit is enabled, no explanation, and the request goes out', async () => {
    const d = await open('preliminary', approvedPreliminary({ permissions_hint: { can_amend_approved: true } }), PERM_AMEND);
    expect(d.textContent).not.toMatch(/already approved/i);
    await send(d);
    await waitFor(() => expect(posts()).toHaveLength(1));
  });
  it('lab status not approved (resulted): enabled, no explanation (AC-11.3 ordinary re-submission)', async () => {
    const d = await open('final', approvedPreliminary({ lab_result: { result_id: ID(80), status: 'resulted', version_no: 1 } }));
    expect(d.textContent).not.toMatch(/already approved/i);
    expect((submitBtn(d) as HTMLButtonElement).disabled).toBe(false);
  });
  it('no lab_result at all: enabled', async () => {
    const d = await open('preliminary');
    expect((submitBtn(d) as HTMLButtonElement).disabled).toBe(false);
  });
  it('amending + approved C5 line + no amend permission: submit disabled (the pre-check applies to a final too)', async () => {
    const d = await open('final', amending({ lab_result: { result_id: ID(80), status: 'approved', version_no: 1 }, permissions_hint: { can_amend_approved: false } }));
    const b = submitBtn(d) as HTMLButtonElement;
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
  });
});

describe('error copy (04-UI-UX §10; 03-APP-FLOW §4.6 step 5): the drawer stays open, the input is kept, the raw code is never shown', () => {
  const cases: [string, number, RegExp][] = [
    ['micro.report_incomplete', 422, /some required information is missing\. see the highlighted items\./i],
    ['micro.ast_standard_required', 422, /choose the standard and version for this category\./i],
    ['micro.report_final_locked', 409, /the final report has been sent\. reopen the culture to make changes\./i],
    ['micro.culture_invalid_transition', 409, /this culture has changed\. reload to see its current state\./i],
    ['micro.amendment_reason_required', 422, /choose a reason for the amendment\./i],
    ['lab.result_locked', 409, /only a pathologist can submit a change to an approved result\./i],
    ['lab.result_invalid_transition', 409, /the lab has cancelled or changed this test\. reload the culture\./i],
    ['lab.module_result_stale', 409, /a newer report version already exists\. reload the culture\./i],
    ['lab.module_result_invalid', 422, /the lab did not accept this report \(for example, the amendment reason is not valid\)\. check the reason and try again\./i],
    ['common.version_conflict', 409, /someone else changed this\. reload and try again\./i],
    ['common.internal', 500, /something went wrong/i],
  ];
  it.each(cases)('%s (%i)', async (c, status, copy) => {
    api.use(submitFail(c, status));
    const d = await open('preliminary');
    setValue(summary(d), 'Synthetic kept summary');
    await send(d);
    const dd = await screen.findByRole('dialog', { name: /preliminary report/i });
    await within(dd).findByText(copy);
    expect(document.body.textContent).not.toContain(c);
    expect(summary(dd).value).toBe('Synthetic kept summary');
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.queryByText(/sent for verification/i)).toBeNull();
  });
  it('the message is announced (role alert)', async () => {
    api.use(submitFail('lab.result_locked', 409));
    const d = await open('preliminary');
    await send(d);
    expect((await within(await screen.findByRole('dialog', { name: /preliminary report/i })).findByRole('alert')).textContent).toMatch(/only a pathologist/i);
  });
  it('AC-11.6: an amending culture whose reason C5 rejects: 422 lab.module_result_invalid is shown unchanged, nothing refreshes, the culture is still amending', async () => {
    api.use(submitFail('lab.module_result_invalid', 422));
    const d = await finalReady(amending());
    await send(d);
    await within(await screen.findByRole('dialog', { name: /final report/i })).findByText(/the lab did not accept this report/i);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/amendment in progress/i);
  });
  it('AC-09.2: lab.result_invalid_transition (C5 cancelled the item) is returned as is, nothing else is attempted', async () => {
    api.use(submitFail('lab.result_invalid_transition', 409));
    const d = await open('preliminary');
    await send(d);
    await within(await screen.findByRole('dialog', { name: /preliminary report/i })).findByText(/cancelled or changed this test/i);
    expect(posts()).toHaveLength(1);
  });
  it('conflict-type errors offer Reload, which refreshes the page', async () => {
    api.use(submitFail('lab.module_result_stale', 409));
    const d = await open('preliminary');
    await send(d);
    await userEvent.click(await within(await screen.findByRole('dialog', { name: /preliminary report/i })).findByRole('button', { name: /^reload$/i }));
    expect(router.refresh).toHaveBeenCalled();
  });
  it('auth.mfa_required is left to the shell: no error text in the drawer', async () => {
    api.use(submitFail('auth.mfa_required', 401));
    const d = await open('preliminary');
    await send(d);
    await waitFor(() => expect(posts()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(within(screen.getByRole('dialog', { name: /preliminary report/i })).queryByRole('alert')).toBeNull();
  });
  it('an unknown problem code shows the generic text, never the code or the server title', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/report-versions`, () => HttpResponse.json({ type: 'x', title: 'SECRET-SERVER-TITLE', status: 418, code: 'lab.some_new_code' }, { status: 418 })));
    const d = await open('preliminary');
    await send(d);
    await within(await screen.findByRole('dialog', { name: /preliminary report/i })).findByText(/something went wrong/i);
    expect(document.body.textContent).not.toMatch(/SECRET-SERVER-TITLE|lab\.some_new_code/);
  });
});

describe('permissions, layout, a11y', () => {
  it('without micro.culture.work there are no report buttons at all', async () => {
    await mount(growth(), ['micro.culture.read']);
    expect(screen.queryByRole('button', { name: /^(preliminary|final) report$/i })).toBeNull();
  });
  it('one primary button per page while the drawer is open (LD-140)', async () => {
    await open('preliminary');
    expect(document.querySelectorAll('button.lims-btn-primary').length).toBeLessThanOrEqual(2); // the page header's own + the drawer's submit; the header one is inert behind the drawer
    expect(screen.getByRole('dialog').querySelectorAll('button.lims-btn-primary')).toHaveLength(1);
  });
  it('Escape closes the drawer without a request', async () => {
    await open('preliminary');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /preliminary report/i })).toBeNull());
    expect(posts()).toHaveLength(0);
  });
  it('the drawer is accessible (axe)', async () => {
    const d = await open('final', growth());
    const v = (await axe.run(d, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);
    expect(v).toEqual([]);
  });
  it('typed free text is posted verbatim and never interpreted (REQ-SEC-088)', async () => {
    const d = await open('preliminary');
    setValue(summary(d), '<script>alert(1)</script> Synthetic');
    await send(d);
    expect((await lastPost()).json.culture_summary_text).toBe('<script>alert(1)</script> Synthetic');
    expect(document.querySelector('script')).toBeNull();
  });
});
