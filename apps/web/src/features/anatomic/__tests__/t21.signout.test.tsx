// @vitest-environment jsdom
// C11.T-21 — Sign-out dialog, step-up and error mapping (04-UI-UX §2 step-up, §4.2.7 Sign-out Dialog, §8 copy; 03-APP-FLOW §4.2 sign-out flow steps 1-8; AC-09.2 (UI); TRD R3; REQ-SEC-062/067/095/098).
// ASSUMED (t21.harness.tsx header): [Sign out] on the Report tab (primary, privileged) is shown only with anatomic.case.signout AND allowed_actions containing signOutAnatomicCase;
//   the dialog (role=dialog, title "Sign out report") has the attestation Checkbox and a [Sign out] confirm; 422 anatomic.report_incomplete closes the dialog and shows the kit ErrorSummary
//   (data-testid="error-summary", one anchor per `errors[]` entry whose JSON Pointer maps to a field; anchors focus the field) inside the Report editor form.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { IDEM_RE, ORIGIN, PERM_SIGN, PERM_WORK, api, draft, hit, problem, reportCase, resetHits, router, signResult, synInstance, t21Defaults } from './t21.harness';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); api.use(...t21Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const open = async (d: Record<string, unknown> = reportCase(), permissions = PERM_SIGN) => {
  const { CaseWorkspace } = await import('../components/CaseWorkspace');
  render(<ToastProvider><CaseWorkspace detail={d as never} permissions={permissions} templates={[]} /></ToastProvider>);
  await userEvent.click(screen.getByRole('tab', { name: /^report$/i }));
  await waitFor(() => expect(screen.queryByLabelText(/^gross/i)).toBeTruthy());
};
const signBtn = () => screen.getByRole('button', { name: /^sign out$/i }) as HTMLButtonElement;
const dialog = () => screen.findByRole('dialog');
const confirmIn = (d: HTMLElement) => within(d).getByRole('button', { name: /^sign out$/i }) as HTMLButtonElement;
const attest = (d: HTMLElement) => within(d).getByRole('checkbox', { name: /i have reviewed this report and its images/i });
const signs = () => hit('POST', /\/cases\/[^/]+\/sign-out$/);
const puts = () => hit('PUT', /\/cases\/[^/]+\/report-draft$/);
const failWith = (code: string, status: number, extra: Record<string, unknown> = {}) => api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/sign-out`, () => problem(code, status, extra)));
const dialog_open = async () => { await userEvent.click(signBtn()); return dialog(); };
const confirmSign = async () => { const d = await dialog_open(); await userEvent.click(attest(d)); await userEvent.click(confirmIn(d)); return d; };

describe('visibility (privileged action)', () => {
  it('hidden without anatomic.case.signout even when the case is ready; hidden when signOutAnatomicCase is not allowed (e.g. status signed_out)', async () => {
    await open(reportCase(), PERM_WORK);
    expect(screen.queryByRole('button', { name: /^sign out$/i })).toBeNull();
    cleanup();
    await open(reportCase({ allowed_actions: ['cancelAnatomicCase'] }), PERM_SIGN);
    expect(screen.queryByRole('button', { name: /^sign out$/i })).toBeNull();
  });

  it('shown with the permission and the allowed action', async () => {
    await open();
    expect(signBtn()).toBeTruthy();
  });
});

describe('dialog (§4.2.7)', () => {
  it('title "Sign out report"; "Version 1 will be created and sent to lab verification for: {tests}."; "Critical finding: No"; attestation required; opening sends nothing', async () => {
    await open();
    await userEvent.click(signBtn());
    const d = await dialog();
    expect(d.textContent).toMatch(/sign out report/i);
    expect(d.textContent).toContain('Version 1 will be created and sent to lab verification for: Synthetic biopsy');
    expect(d.textContent).toMatch(/critical finding:\s*no/i);
    expect(attest(d)).toBeTruthy();
    expect(d.textContent).toMatch(/required/i);
    expect(signs()).toHaveLength(0);
  });

  it('the version number is current_version_no + 1; critical draft shows "Critical finding: Yes"; draft kind shown', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => HttpResponse.json(draft({ kind: 'revision', is_critical: true, change_reason_code: 'transcription_error' }))));
    await open(reportCase({ current_version_no: 3 }));
    await userEvent.click(signBtn());
    const d = await dialog();
    expect(d.textContent).toContain('Version 4 will be created');
    expect(d.textContent).toMatch(/critical finding:\s*yes/i);
  });

  it('lists only ACTIVE tests that will be submitted (removed order items are not listed)', async () => {
    const items = [
      { case_item_id: 'a', order_item_id: 'b', test_id: 'c', test_name: 'Synthetic biopsy', role: 'primary', is_active: true, lab_status: 'pending' },
      { case_item_id: 'd', order_item_id: 'e', test_id: 'f', test_name: 'Synthetic cancelled test', role: 'primary', is_active: false, lab_status: 'cancelled' },
    ];
    await open(reportCase({ items }));
    await userEvent.click(signBtn());
    const d = await dialog();
    expect(d.textContent).toContain('Synthetic biopsy');
    expect(d.textContent).not.toContain('Synthetic cancelled test');
  });

  it('without the attestation ticked: no request, an error asks for it in words', async () => {
    await open();
    await userEvent.click(signBtn());
    const d = await dialog();
    await userEvent.click(confirmIn(d));
    expect(signs()).toHaveLength(0);
    expect(d.textContent).toMatch(/required|confirm|tick|review/i);
  });

  it('[Cancel] closes it; focus returns to [Sign out]', async () => {
    await open();
    await userEvent.click(signBtn());
    const d = await dialog();
    await userEvent.click(within(d).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(signBtn());
  });

  it('Alt+U opens it (04-UI-UX §3); so does the header Actions menu item "Sign out"', async () => {
    await open();
    fireEvent.keyDown(document, { key: 'u', code: 'KeyU', altKey: true });
    expect(await dialog()).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: /^actions$/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^sign out$/i }));
    expect(await dialog()).toBeTruthy();
  });

  it('Alt+U is ignored without the permission', async () => {
    await open(reportCase(), PERM_WORK);
    fireEvent.keyDown(document, { key: 'u', code: 'KeyU', altKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('submit (R3)', () => {
  it('POST /cases/{id}/sign-out with If-Match = the DRAFT version, Idempotency-Key, body {attest:true} exactly; toast "Signed out as version 1. Sent to lab verification."; page refreshes', async () => {
    await open();
    await confirmSign();
    await waitFor(() => expect(signs()).toHaveLength(1));
    const p = signs()[0]!;
    expect(p.headers.get('if-match')).toBe('"2"');
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(p.json).toEqual({ attest: true });
    expect(await screen.findByText('Signed out as version 1. Sent to lab verification.')).toBeTruthy();
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('flow step 1: unsaved edits are saved FIRST (PUT, then POST with the new draft version as If-Match)', async () => {
    await open();
    await userEvent.click(screen.getByLabelText(/diagnosis \/ impression/i));
    await userEvent.paste('Synthetic impression');
    await userEvent.click(signBtn());
    const d = await dialog();
    await userEvent.click(attest(d));
    await userEvent.click(confirmIn(d));
    await waitFor(() => expect(signs()).toHaveLength(1));
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.json.impression_text).toBe('Synthetic impression');
    expect(signs()[0]!.headers.get('if-match')).toBe('"3"');
    expect(JSON.stringify(hit('PUT', /report-draft/).concat(signs()).map((h) => h.method))).toBe('["PUT","POST"]');
  });

  it('a failing save-before-sign stops the sign-out (no POST) and shows the failure', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => problem('common.version_conflict', 409)));
    await open();
    await userEvent.click(screen.getByLabelText(/diagnosis \/ impression/i));
    await userEvent.paste('Synthetic impression');
    await userEvent.click(signBtn());
    const d = await dialog();
    await userEvent.click(attest(d));
    await userEvent.click(confirmIn(d));
    expect(await screen.findByText('This case was changed by someone else. Reload to see the latest version.')).toBeTruthy();
    expect(signs()).toHaveLength(0);
  });

  it('double click on the confirm button sends ONE request (race / many clicks)', async () => {
    await open();
    const d = await dialog_open();
    await userEvent.click(attest(d));
    await userEvent.dblClick(confirmIn(d));
    await waitFor(() => expect(signs()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(signs()).toHaveLength(1);
  });
});

describe('step-up (AC-09.2 UI, 04-UI-UX §2, 03-APP-FLOW §4.2 step 4)', () => {
  it('403 auth.mfa_required -> two-factor dialog with [Verify now] and [Cancel]; nothing changes: no success toast, no refresh, the draft text is still in the editor', async () => {
    failWith('auth.mfa_required', 403);
    await open();
    await userEvent.click(screen.getByLabelText(/diagnosis \/ impression/i));
    await userEvent.paste('Synthetic keep me');
    await userEvent.click(signBtn());
    const d1 = await dialog();
    await userEvent.click(attest(d1));
    await userEvent.click(confirmIn(d1));
    await waitFor(() => expect(signs()).toHaveLength(1));
    const d = await screen.findByText(/two-factor verification/i);
    const dlg = d.closest('[role="dialog"]') as HTMLElement;
    expect(within(dlg).getByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: /^cancel$/i })).toBeTruthy();
    expect(screen.queryByText(/signed out as version/i)).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    await userEvent.click(within(dlg).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((screen.getByLabelText(/diagnosis \/ impression/i) as HTMLTextAreaElement).value).toBe('Synthetic keep me');
    expect(document.body.textContent).not.toContain('auth.mfa_required');
  });

  it('after Cancel the user can try again; a second attempt that succeeds (session now aal2) signs out', async () => {
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/sign-out`, () => (++n === 1 ? problem('auth.mfa_required', 403) : HttpResponse.json(signResult()))));
    await open();
    const d1 = await dialog_open();
    await userEvent.click(attest(d1));
    await userEvent.click(confirmIn(d1));
    const dlg = (await screen.findByText(/two-factor verification/i)).closest('[role="dialog"]') as HTMLElement;
    await userEvent.click(within(dlg).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const d2 = await dialog_open();
    if (!(attest(d2) as HTMLInputElement).checked) await userEvent.click(attest(d2));
    await userEvent.click(confirmIn(d2));
    expect(await screen.findByText(/signed out as version 1/i)).toBeTruthy();
  });
});

describe('422 anatomic.report_incomplete -> ErrorSummary (done_when, 03-APP-FLOW §4.2 step 5, E12)', () => {
  const incomplete = (errors: { path: string; code?: string; message: string }[]) => failWith('anatomic.report_incomplete', 422, { errors });
  const draftWithSyn = () => api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => HttpResponse.json(draft({ synoptic: [synInstance(1, {})], image_ids: ['01950c11-0000-7000-8000-000000000501', '01950c11-0000-7000-8000-000000000502'] }))));
  const summary = () => screen.getByTestId('error-summary');

  it('the dialog closes; the §8 sentence is shown; the summary has one entry per error, each naming the FIELD (JSON Pointer -> label), as links', async () => {
    draftWithSyn();
    incomplete([
      { path: '/impression_text', code: 'required', message: 'is required' },
      { path: '/gross_text', code: 'required', message: 'is required' },
      { path: '/synoptic/0/values/site', code: 'required', message: 'is required' },
      { path: '/synoptic/0/values/grade', code: 'required', message: 'is required' },
      { path: '/image_ids/1', code: 'image_not_ready', message: 'Image is still processing' },
    ]);
    await open();
    await confirmSign();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).toContain('Complete the highlighted fields before signing out.');
    const s = summary();
    const links = within(s).getAllByRole('link');
    expect(links).toHaveLength(5);
    const t = links.map((l) => l.textContent ?? '');
    expect(t.some((x) => /diagnosis \/ impression/i.test(x))).toBe(true);
    expect(t.some((x) => /^gross|gross\b/i.test(x))).toBe(true);
    expect(t.some((x) => /tumour site/i.test(x))).toBe(true);
    expect(t.some((x) => /grade/i.test(x))).toBe(true);
    expect(t.some((x) => /image/i.test(x) && /still processing/i.test(x))).toBe(true);
    expect(s.getAttribute('role')).toBe('alert');
  });

  it('clicking an entry focuses its field; the fields are marked invalid (highlighted)', async () => {
    draftWithSyn();
    incomplete([{ path: '/impression_text', code: 'required', message: 'is required' }, { path: '/synoptic/0/values/grade', code: 'required', message: 'is required' }]);
    await open();
    await confirmSign();
    const s = await screen.findByTestId('error-summary');
    await userEvent.click(within(s).getByRole('link', { name: /diagnosis \/ impression/i }));
    expect(document.activeElement).toBe(screen.getByLabelText(/diagnosis \/ impression/i));
    expect(screen.getByLabelText(/diagnosis \/ impression/i).getAttribute('aria-invalid')).toBe('true');
    await userEvent.click(within(s).getByRole('link', { name: /grade/i }));
    expect((document.activeElement as HTMLElement).textContent + (document.activeElement as HTMLElement).getAttribute('aria-label')).toMatch(/grade/i);
  });

  it('an error whose pointer maps to no field is still listed (as plain text), never dropped; the server message is shown without markup', async () => {
    incomplete([{ path: '/nowhere/0', code: 'x', message: '<b>Synthetic unmapped</b>' }]);
    await open();
    await confirmSign();
    const s = await screen.findByTestId('error-summary');
    expect(s.textContent).toContain('<b>Synthetic unmapped</b>');
    expect(s.querySelector('b')).toBeNull();
  });

  it('no `errors` array at all: still the §8 sentence, no crash', async () => {
    failWith('anatomic.report_incomplete', 422);
    await open();
    await confirmSign();
    await waitFor(() => expect(document.body.textContent).toContain('Complete the highlighted fields before signing out.'));
  });

  it('nothing is refreshed or toasted as success, and the editor text is untouched', async () => {
    incomplete([{ path: '/impression_text', code: 'required', message: 'is required' }]);
    await open();
    await confirmSign();
    await screen.findByTestId('error-summary');
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.queryByText(/signed out as version/i)).toBeNull();
  });
});

describe('other sign-out errors (03-APP-FLOW steps 6-7, §8 copy)', () => {
  it('409 anatomic.order_item_inactive -> banner NAMING the removed test (from the case items, not from the server detail)', async () => {
    failWith('anatomic.order_item_inactive', 409, { detail: 'internal-trace-xyz' });
    const items = [
      { case_item_id: 'a', order_item_id: 'b', test_id: 'c', test_name: 'Synthetic biopsy', role: 'primary', is_active: true, lab_status: 'pending' },
      { case_item_id: 'd', order_item_id: 'e', test_id: 'f', test_name: 'Synthetic removed test', role: 'addon', is_active: false, lab_status: 'cancelled' },
    ];
    await open(reportCase({ items }));
    await confirmSign();
    const a = await screen.findAllByRole('alert');
    const t = a.map((x) => x.textContent).join(' ');
    expect(t).toContain('The test Synthetic removed test was removed from the order. Ask front desk, or cancel the case.');
    expect(document.body.textContent).not.toContain('internal-trace-xyz');
  });

  it.each([
    ['lab.result_locked', 409, 'The lab result is approved and locked. Use Amend.'],
    ['lab.module_result_stale', 409, 'A newer version was already sent to the lab. Reload the case.'],
    ['lab.module_result_invalid', 422, "The lab did not accept this result for this test. Check the test's setup."],
    ['lab.result_invalid_transition', 409, "The lab result can't accept a new version now (it may be cancelled)."],
    ['lab.amendment_reason_required', 422, 'An amendment needs a reason.'],
    ['anatomic.case_invalid_transition', 409, "That step isn't possible for a case in status ready_for_reporting."],
    ['common.version_conflict', 409, 'This case was changed by someone else. Reload to see the latest version.'],
  ])('%s -> "%s" in a banner (role=alert) with the support reference; never the raw code or server detail', async (code, status, copy) => {
    failWith(code, status, { request_id: 'REQ-ABCD-1', detail: 'internal-trace-xyz', title: 'Synthetic C5 title' });
    await open();
    await confirmSign();
    const alerts = await screen.findAllByRole('alert');
    const t = alerts.map((x) => x.textContent).join(' ');
    expect(t).toContain(copy);
    if (code.startsWith('lab.')) expect(t).toContain('REQ-ABCD-1'); // lab errors show the reference (flow step 7)
    expect(document.body.textContent).not.toContain('internal-trace-xyz');
    expect(document.body.textContent).not.toContain(code);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('an unknown code falls back to a generic message (no raw code)', async () => {
    failWith('lab.something_new', 409);
    await open();
    await confirmSign();
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toContain('lab.something_new');
  });

  it('403 auth.forbidden -> permission message; the button state does not change', async () => {
    failWith('auth.forbidden', 403);
    await open();
    await confirmSign();
    expect(await screen.findByText('You do not have permission to do this.')).toBeTruthy();
  });
});

describe('security (REQ-SEC-088/095/098)', () => {
  it('the page never renders the JWT', async () => {
    await open();
    await confirmSign();
    await waitFor(() => expect(signs()).toHaveLength(1));
    expect(document.body.innerHTML).not.toContain('jwt-synthetic');
    expect(document.body.innerHTML).not.toMatch(/Bearer /);
  });
});
