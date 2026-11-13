// @vitest-environment jsdom
// C11.T-19 — Case workspace shell + Overview + Parts & gross tabs (04-UI-UX §2, §3, §4.2, §4.2.1, §4.2.2, §6, §8; 03-APP-FLOW §4.2; AC-13.4 (highlight), REQ-SEC-081/088).
// LD-140 (2026-11-13): kit components only, one primary button per page, every status shows tone + icon + word.
// ASSUMED seams: CaseWorkspace({ detail, permissions, templates? }) (t19.harness.tsx header). Mutations go through server actions to the real API paths with If-Match "<version>"
// (+ Idempotency-Key where x-idempotency: required). Menu = kit Menu (role=menu / menuitem). Dialogs have role=dialog; fields are found by their visible label.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_READ, PERM_WORK, api, detail, gross, hit, hits, part, problem, resetHits, router, template } from './t19.harness';

vi.mock('next/navigation', async () => (await import('./t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t19.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (d: Record<string, unknown> = detail(), permissions = PERM_WORK, templates: unknown[] = []) => {
  const { CaseWorkspace } = await import('../components/CaseWorkspace');
  return render(<ToastProvider><CaseWorkspace detail={d as never} permissions={permissions} templates={templates as never} /></ToastProvider>);
};
const tab = (name: RegExp) => userEvent.click(screen.getByRole('tab', { name }));
const received = (over: Record<string, unknown> = {}) => detail({ status: 'received', accession_no: undefined, accessioned_at: undefined, assigned_pathologist: undefined, allowed_actions: ['accessionAnatomicCase', 'cancelAnatomicCase'], parts: [part(1, { site_text: undefined, description_text: undefined })], ...over });
const banner = (re: RegExp) => Array.from(document.querySelectorAll('[data-tone]')).filter((e) => e.classList.contains('lims-banner') && re.test(e.textContent ?? ''));

describe('header (§4.2)', () => {
  it('breadcrumbs "Pathology cases › accession", h1 = accession, StatusChip with tone+icon+word', async () => {
    await mount(detail({ accession_no: 'SP26-000042' }));
    expect(screen.getByRole('heading', { level: 1, name: 'SP26-000042' })).toBeTruthy();
    const crumb = screen.getByRole('link', { name: /^pathology cases$/i }) as HTMLAnchorElement;
    expect(crumb.getAttribute('href')).toBe('/anatomic');
    const chip = screen.getAllByText('Accessioned').map((e) => e.closest('[data-tone]')).find(Boolean) as HTMLElement;
    expect(chip.getAttribute('data-tone')).toBe('info');
    expect(chip.querySelector('svg,[data-icon],[aria-hidden=true]')).toBeTruthy();
  });

  it('un-accessioned case: h1 "Not accessioned", breadcrumb leaf "Case"', async () => {
    await mount(received());
    expect(screen.getByRole('heading', { level: 1, name: 'Not accessioned' })).toBeTruthy();
    expect(document.body.textContent).toMatch(/Pathology cases\s*[›>\/]?\s*Case/);
  });

  it('DescriptionList: Patient (name, age/sex, code), Case kind, Priority, Centre, Received, Accessioned, Assigned pathologist, Tests, Current version', async () => {
    await mount();
    const terms = screen.getAllByRole('term').map((t) => t.textContent?.trim());
    for (const t of ['Patient', 'Case kind', 'Priority', 'Centre', 'Received', 'Accessioned', 'Assigned pathologist', 'Tests', 'Current version']) expect(terms, t).toContain(t);
    for (const s of ['Synthetic Patient 1', '41 y', 'PC-1', 'Synthetic Doctor', 'Synthetic biopsy']) expect(document.body.textContent, s).toContain(s);
  });

  it('each test shows its C5 chain status "Lab: pending" and the line is omitted when lab_status is absent (no lab.result.read)', async () => {
    const { unmount } = await mount();
    expect(document.body.textContent).toContain('Lab: pending');
    unmount();
    await mount(detail({ items: [{ case_item_id: ID(10), order_item_id: ID(11), test_id: ID(12), test_name: 'Synthetic biopsy', role: 'primary', is_active: true }] }));
    expect(document.body.textContent).not.toContain('Lab:');
  });

  it('patient block is omitted when the API omits `patient`; no "undefined"/"null" text anywhere', async () => {
    await mount(detail({ patient: undefined, assigned_pathologist: undefined }));
    expect(document.body.textContent).not.toMatch(/undefined|null|NaN/);
  });

  it('server free text (clinical history, part site, patient) renders as text, never HTML (REQ-SEC-088)', async () => {
    await mount(detail({ patient: { display_name: '<img src=x onerror=alert(1)>', sex: 'F', age_text: '1 y', patient_code: 'P' }, parts: [part(1, { site_text: '<script>alert(2)</script>' })] }));
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('?block=<id> / ?slide=<id> highlight props are inert on the Overview/Parts shell (no crash, no extra API call)', async () => {
    await mount(detail({ blocks: [{ id: ID(7), part_id: ID(101), label: 'SP26-000001-A1', seq: 1, location_status: 'in_lab', slide_count: 0, version: 1 }] }));
    expect(hits).toHaveLength(0);
  });
});

describe('banners (§4.2) — copy verbatim, tone per table', () => {
  it('profile_missing -> warning', async () => {
    await mount(detail({ flags: { profile_missing: true, specimen_rejected: false, open_change: false, pending_stain_orders: 0, parts_missing_site: false } }));
    expect(banner(/This test has no pathology profile\. Defaults were used\. Ask a lab manager to set it up in Pathology setup\./)[0]?.getAttribute('data-tone')).toBe('warning');
  });
  it('rejected part B -> danger, names the part letter', async () => {
    await mount(detail({ parts: [part(1), part(2, { specimen_state: 'rejected' })] }));
    expect(banner(/Specimen for part B was rejected in the lab\. A recollected specimen will be linked here when received\./)[0]?.getAttribute('data-tone')).toBe('danger');
  });
  it('inactive item -> danger with the test name and the sign-out-blocked sentence', async () => {
    await mount(detail({ items: [{ case_item_id: ID(10), order_item_id: ID(11), test_id: ID(12), test_name: 'Synthetic removed test', role: 'primary', is_active: false }] }));
    expect(banner(/Synthetic removed test was removed from the order\. Sign-out is blocked for this case until the order is corrected or the case is cancelled\./)[0]?.getAttribute('data-tone')).toBe('danger');
  });
  it('add-on item without a result -> warning', async () => {
    await mount(detail({ items: [{ case_item_id: ID(10), order_item_id: ID(11), test_id: ID(12), test_name: 'Synthetic add-on', role: 'addon', is_active: true }] }));
    expect(banner(/Billed add-on Synthetic add-on still needs a result \(sign an addendum linked to it\) or cancellation at front desk\./)[0]?.getAttribute('data-tone')).toBe('warning');
  });
  it.each(['revision', 'amendment'])('open %s draft -> info', async (kind) => {
    await mount(detail({ status: 'signed_out', open_draft: { kind, version: 1, updated_at: '2026-11-11T05:00:00.000Z' } }));
    expect(banner(/A (revision|amendment) is in progress/)[0]?.getAttribute('data-tone')).toBe('info');
    expect(banner(/in progress/)[0]!.textContent).toContain(kind);
  });
  it('a clean case shows no banner at all', async () => {
    await mount();
    expect(document.querySelectorAll('.lims-banner')).toHaveLength(0);
  });
});

describe('tab shell (§4.2) and keyboard (§3)', () => {
  it('tabs in order Overview · Parts & gross · Blocks & slides · Stains · Images · … · Report; Molecular only for molecular cases', async () => {
    const { unmount } = await mount();
    const names = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
    expect(names.slice(0, 5)).toEqual(['Overview', 'Parts & gross', 'Blocks & slides', 'Stains', 'Images']);
    expect(names.at(-1)).toBe('Report');
    expect(names).not.toContain('Molecular');
    unmount();
    await mount(detail({ case_kind: 'molecular' }));
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.trim())).toContain('Molecular');
  });

  it('Overview is selected first', async () => {
    await mount();
    expect(screen.getByRole('tab', { name: /^overview$/i }).getAttribute('aria-selected')).toBe('true');
  });

  it.each([['Alt+G', /^parts & gross$/i], ['Alt+B', /^blocks & slides$/i], ['Alt+T', /^stains$/i], ['Alt+I', /^images$/i], ['Alt+R', /^report$/i]])('%s selects the tab', async (key, name) => {
    const { shortcuts } = await import('@/core/shortcuts/registry');
    await mount();
    act(() => shortcuts.list('staff.anatomic.case').find((s) => s.key === key)!.run());
    await waitFor(() => expect(screen.getByRole('tab', { name }).getAttribute('aria-selected')).toBe('true'));
  });

  it('Alt+O returns to Overview', async () => {
    const { shortcuts } = await import('@/core/shortcuts/registry');
    await mount();
    await tab(/^parts & gross$/i);
    act(() => shortcuts.list('staff.anatomic.case').find((s) => s.key === 'Alt+O')!.run());
    await waitFor(() => expect(screen.getByRole('tab', { name: /^overview$/i }).getAttribute('aria-selected')).toBe('true'));
  });

  it('all keys are Alt+<letter>, unique, never a global key; each has a description; unregistered on unmount', async () => {
    const { shortcuts, GLOBAL_KEYS } = await import('@/core/shortcuts/registry');
    const { unmount } = await mount();
    const list = shortcuts.list('staff.anatomic.case');
    expect(list.length).toBeGreaterThanOrEqual(6);
    for (const s of list) { expect(s.key).toMatch(/^Alt\+[A-Z]$/); expect(s.description.trim()).not.toBe(''); expect(GLOBAL_KEYS as readonly string[]).not.toContain(s.key); }
    unmount();
    expect(shortcuts.list('staff.anatomic.case')).toHaveLength(0);
  });

  it('Alt+A is registered only when accessionAnatomicCase is allowed, and opens the Accession dialog', async () => {
    const { shortcuts } = await import('@/core/shortcuts/registry');
    const { unmount } = await mount();
    expect(shortcuts.list('staff.anatomic.case').some((s) => s.key === 'Alt+A')).toBe(false);
    unmount();
    await mount(received());
    const a = shortcuts.list('staff.anatomic.case').find((s) => s.key === 'Alt+A');
    expect(a).toBeTruthy();
    act(() => a!.run());
    expect(await screen.findByRole('dialog', { name: /accession case/i })).toBeTruthy();
  });

  it('tabs follow the kit arrow-key model', async () => {
    await mount();
    screen.getByRole('tab', { name: /^overview$/i }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^parts & gross$/i }));
  });
});

describe('Overview actions (§4.2, 03-APP-FLOW §4.2)', () => {
  const openActions = async () => { await userEvent.click(screen.getByRole('button', { name: /^actions$/i })); return screen.findByRole('menu'); };

  it('"Actions" menu lists exactly the items for allowed_actions (no accession / sign-out when not allowed)', async () => {
    await mount(detail({ allowed_actions: ['startAnatomicProcessing', 'cancelAnatomicCase'] }));
    const m = await openActions();
    const items = within(m).getAllByRole('menuitem').map((i) => i.textContent?.trim());
    expect(items).toContain('Start processing');
    expect(items).toContain('Cancel case');
    for (const no of ['Accession', 'Mark ready', 'Sign out', 'Add addendum', 'Revise/Amend']) expect(items.join('|'), no).not.toContain(no);
  });

  it.each([
    ['accessionAnatomicCase', 'Accession'], ['startAnatomicProcessing', 'Start processing'], ['markAnatomicCaseReady', 'Mark ready'],
    ['signOutAnatomicCase', 'Sign out'], ['startAnatomicCaseChange', 'Revise/Amend'], ['createAnatomicAddendum', 'Add addendum'], ['cancelAnatomicCase', 'Cancel case'],
  ])('allowed_actions %s -> menu item "%s"', async (op, label) => {
    await mount(detail({ allowed_actions: [op] }));
    const m = await openActions();
    expect(within(m).getAllByRole('menuitem').map((i) => i.textContent?.trim()).join('|')).toContain(label);
  });

  it('a user without anatomic.case.work / empty allowed_actions gets no mutating menu items or stage buttons', async () => {
    await mount(detail({ allowed_actions: [] }), PERM_READ);
    expect(screen.queryByRole('button', { name: /^start processing$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^mark ready for reporting$/i })).toBeNull();
    const actions = screen.queryByRole('button', { name: /^actions$/i });
    if (actions) { await userEvent.click(actions); expect(screen.queryAllByRole('menuitem').filter((i) => /accession|start|mark|cancel|sign/i.test(i.textContent ?? ''))).toHaveLength(0); }
  });

  it('"Start processing" button on Overview POSTs /start-processing with If-Match "<case version>" and an Idempotency-Key, then refreshes', async () => {
    await mount(detail({ version: 5 }));
    await userEvent.click(screen.getByRole('button', { name: /^start processing$/i }));
    await waitFor(() => expect(hit('POST', /\/start-processing$/)).toHaveLength(1));
    const h = hit('POST', /\/start-processing$/)[0]!;
    expect(h.path).toBe(`/v1/anatomic/cases/${ID(1)}/start-processing`);
    expect(h.headers.get('if-match')).toBe('"5"');
    expect(h.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('"Mark ready for reporting" POSTs /mark-ready', async () => {
    await mount(detail({ status: 'in_processing', allowed_actions: ['markAnatomicCaseReady', 'cancelAnatomicCase'] }));
    await userEvent.click(screen.getByRole('button', { name: /^mark ready for reporting$/i }));
    await waitFor(() => expect(hit('POST', /\/mark-ready$/)).toHaveLength(1));
  });

  it('a double click sends one request (button disabled while pending; same key not reused for a new intent)', async () => {
    await mount();
    const b = screen.getByRole('button', { name: /^start processing$/i });
    await userEvent.dblClick(b);
    await waitFor(() => expect(hit('POST', /\/start-processing$/).length).toBeGreaterThan(0));
    expect(hit('POST', /\/start-processing$/)).toHaveLength(1);
  });

  it('"Cancel case" opens a ConfirmDialog asking for a reason; opening sends nothing', async () => {
    await mount();
    await userEvent.click(screen.getByRole('button', { name: /^actions$/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^cancel case$/i }));
    const d = await screen.findByRole('dialog');
    expect(d.textContent).toMatch(/cancel/i);
    expect(d.textContent).toMatch(/reason/i);
    expect(hit('POST', /\/cancel$/)).toHaveLength(0);
  });

  it('409 common.version_conflict -> warning Banner "This case was changed by someone else. Reload to see the latest version." with [Reload] -> router.refresh', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/start-processing`, () => problem('common.version_conflict', 409)));
    await mount();
    await userEvent.click(screen.getByRole('button', { name: /^start processing$/i }));
    await waitFor(() => expect(banner(/This case was changed by someone else\. Reload to see the latest version\./)).toHaveLength(1));
    expect(banner(/changed by someone else/)[0]!.getAttribute('data-tone')).toBe('warning');
    router.refresh.mockReset();
    await userEvent.click(screen.getByRole('button', { name: /^reload$/i }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('anatomic.case_invalid_transition (409) shows "That step isn\'t possible for a case in status {status}." — never the raw problem JSON', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/start-processing`, () => problem('anatomic.case_invalid_transition', 409, { detail: 'internal-trace-xyz' })));
    await mount();
    await userEvent.click(screen.getByRole('button', { name: /^start processing$/i }));
    expect(await screen.findByText(/That step isn't possible for a case in status/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('internal-trace-xyz');
  });

  it('anatomic.signout_locked -> "This case is signed out. Use Revise/Amend or add an addendum."', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/start-processing`, () => problem('anatomic.signout_locked', 409)));
    await mount();
    await userEvent.click(screen.getByRole('button', { name: /^start processing$/i }));
    expect(await screen.findByText('This case is signed out. Use Revise/Amend or add an addendum.')).toBeTruthy();
  });

  it('403 auth.mfa_required -> Dialog "This action needs two-factor verification." with [Verify now] and [Cancel] (step-up, §2)', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/start-processing`, () => problem('auth.mfa_required', 403)));
    await mount();
    await userEvent.click(screen.getByRole('button', { name: /^start processing$/i }));
    const d = await screen.findByRole('dialog');
    expect(d.textContent).toContain('This action needs two-factor verification.');
    expect(within(d).getByRole('button', { name: /^verify now$/i })).toBeTruthy();
    expect(within(d).getByRole('button', { name: /^cancel$/i })).toBeTruthy();
  });

  it('exactly one primary button on the page (LD-140): "Accession" while received, otherwise at most one', async () => {
    const { unmount } = await mount(received());
    expect(Array.from(document.querySelectorAll('button.lims-btn-primary')).map((b) => b.textContent?.trim())).toEqual(['Accession']);
    unmount();
    await mount();
    expect(document.querySelectorAll('button.lims-btn-primary').length).toBeLessThanOrEqual(1);
  });
});

describe('Accession dialog (§4.2.1)', () => {
  const open = async (d = received({ parts: [part(1, { site_text: undefined, description_text: undefined }), part(2, { site_text: undefined, description_text: undefined })] })) => {
    await mount(d);
    await userEvent.click(screen.getByRole('button', { name: /^accession$/i }));
    return screen.findByRole('dialog', { name: /accession case/i });
  };

  it('has read-only letters, Site (required) / Description per part, Clinical history, Assigned pathologist, [Cancel] [Accession]', async () => {
    const d = await open();
    expect(within(d).getByText('A')).toBeTruthy();
    expect(within(d).getByText('B')).toBeTruthy();
    expect(within(d).getAllByRole('textbox', { name: /^site/i })).toHaveLength(2);
    expect(within(d).getAllByRole('textbox', { name: /^description/i })).toHaveLength(2);
    expect(within(d).getByRole('textbox', { name: /clinical history/i })).toBeTruthy();
    expect(within(d).getByRole('combobox', { name: /assigned pathologist/i })).toBeTruthy();
    expect(within(d).getByRole('button', { name: /^cancel$/i })).toBeTruthy();
    expect(within(d).getByRole('button', { name: /^accession$/i })).toBeTruthy();
    expect(d.textContent).toMatch(/\(required\)/i); // required marked with text, not colour (§6)
  });

  it('Site is required: empty Site blocks submit with a field error and sends nothing', async () => {
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /^accession$/i }));
    expect(hit('POST', /\/accession$/)).toHaveLength(0);
    expect(within(d).getAllByRole('textbox', { name: /^site/i })[0]!.getAttribute('aria-invalid')).toBe('true');
  });

  it('limits: Site ≤ 200, Description ≤ 1000, Clinical history ≤ 4000 (typing beyond the max is not accepted)', async () => {
    const d = await open();
    const site = within(d).getAllByRole('textbox', { name: /^site/i })[0] as HTMLInputElement;
    await userEvent.click(site);
    await userEvent.paste('x'.repeat(250));
    expect(site.value.length).toBeLessThanOrEqual(200);
    const hist = within(d).getByRole('textbox', { name: /clinical history/i }) as HTMLTextAreaElement;
    await userEvent.click(hist);
    await userEvent.paste('y'.repeat(4100));
    expect(hist.value.length).toBeLessThanOrEqual(4000);
  });

  it('submit POSTs /accession with If-Match "<version>", Idempotency-Key and EVERY part (part_id, site_text, description_text); toast "Accessioned as {accession_no}"', async () => {
    const d = await open();
    const sites = within(d).getAllByRole('textbox', { name: /^site/i });
    await userEvent.type(sites[0]!, 'Synthetic skin');
    await userEvent.type(sites[1]!, 'Synthetic lymph node');
    await userEvent.type(within(d).getAllByRole('textbox', { name: /^description/i })[1]!, 'Synthetic desc');
    await userEvent.type(within(d).getByRole('textbox', { name: /clinical history/i }), 'Synthetic history');
    await userEvent.click(within(d).getByRole('button', { name: /^accession$/i }));
    await waitFor(() => expect(hit('POST', /\/accession$/)).toHaveLength(1));
    const h = hit('POST', /\/accession$/)[0]!;
    expect(h.path).toBe(`/v1/anatomic/cases/${ID(1)}/accession`);
    expect(h.headers.get('if-match')).toBe('"1"');
    expect(h.headers.get('idempotency-key')).toBeTruthy();
    expect(h.json).toEqual({
      clinical_history_text: 'Synthetic history',
      parts: [{ part_id: ID(101), site_text: 'Synthetic skin' }, { part_id: ID(102), site_text: 'Synthetic lymph node', description_text: 'Synthetic desc' }],
    });
    expect(await screen.findByText('Accessioned as SP26-000777')).toBeTruthy();
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('Ctrl+Enter submits (kit Form)', async () => {
    const d = await open(received());
    await userEvent.type(within(d).getAllByRole('textbox', { name: /^site/i })[0]!, 'Synthetic skin{Control>}{Enter}{/Control}');
    await waitFor(() => expect(hit('POST', /\/accession$/)).toHaveLength(1));
  });

  it('anatomic.accession_pattern_invalid -> ErrorState in the dialog with the §8 text and a reference, dialog stays open', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/accession`, () => problem('anatomic.accession_pattern_invalid', 409, { request_id: 'REQ-ABCD-1' })));
    const d = await open(received());
    await userEvent.type(within(d).getAllByRole('textbox', { name: /^site/i })[0]!, 'Synthetic skin');
    await userEvent.click(within(d).getByRole('button', { name: /^accession$/i }));
    expect(await within(d).findByText(/Accession numbering is misconfigured\. Ask an administrator to check the accession pattern\./)).toBeTruthy();
    expect(d.textContent).toContain('REQ-ABCD-1');
    expect(screen.getByRole('dialog', { name: /accession case/i })).toBeTruthy();
  });

  it('anatomic.accession_duplicate -> "This accession number already exists. Ask an administrator to check the accession pattern."', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/accession`, () => problem('anatomic.accession_duplicate', 409)));
    const d = await open(received());
    await userEvent.type(within(d).getAllByRole('textbox', { name: /^site/i })[0]!, 'Synthetic skin');
    await userEvent.click(within(d).getByRole('button', { name: /^accession$/i }));
    expect(await within(d).findByText('This accession number already exists. Ask an administrator to check the accession pattern.')).toBeTruthy();
  });

  it('assignee Combobox loads options from GET /v1/anatomic/assignees with case_id and the typed query, and submits the membership id', async () => {
    const d = await open(received());
    await userEvent.type(within(d).getAllByRole('textbox', { name: /^site/i })[0]!, 'Synthetic skin');
    const cb = within(d).getByRole('combobox', { name: /assigned pathologist/i });
    await userEvent.type(cb, 'Syn');
    await userEvent.click(await screen.findByRole('option', { name: /synthetic doctor/i }));
    const call = hit('GET', /\/assignees$/).at(-1)!;
    const q = new URLSearchParams(call.search);
    expect(q.get('case_id')).toBe(ID(1));
    expect(q.get('q')).toMatch(/^Syn/);
    await userEvent.click(within(d).getByRole('button', { name: /^accession$/i }));
    await waitFor(() => expect(hit('POST', /\/accession$/)).toHaveLength(1));
    expect(hit('POST', /\/accession$/)[0]!.json.assigned_pathologist_membership_id).toBe(ID(5));
  });

  it('Cancel closes without a request; focus returns to the trigger (§6)', async () => {
    const d = await open(received());
    await userEvent.click(within(d).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(hit('POST', /accession$/)).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^accession$/i }));
  });

});

describe('Parts & gross tab (§4.2.2)', () => {
  const two = () => detail({ parts: [part(1, { gross: gross(1) }), part(2)] });
  const parts = async (d: Record<string, unknown> = two(), templates: unknown[] = []) => { await mount(d, PERM_WORK, templates); await tab(/^parts & gross$/i); };
  const card = (letter: string) => screen.getByRole('group', { name: new RegExp(`^part ${letter}\\b`, 'i') }) as HTMLElement;

  it('one Card per part titled "Part {letter} — {site}"', async () => {
    await parts();
    expect(screen.getByText(/Part A — Synthetic site 1/)).toBeTruthy();
    expect(screen.getByText(/Part B — Synthetic site 2/)).toBeTruthy();
  });

  it('fields per part: Site, Description, Gross description (+count), Pieces, Length/Width/Depth, Weight (g), Gross complete, Gross images', async () => {
    await parts();
    const c = within(card('A'));
    for (const re of [/^site/i, /^description$/i, /gross description/i, /^pieces/i, /^length/i, /^width/i, /^depth/i, /^weight \(g\)/i]) expect([...c.queryAllByRole('textbox', { name: re }), ...c.queryAllByRole('spinbutton', { name: re })].length, String(re)).toBeGreaterThan(0);
    expect(c.getByRole('switch', { name: /gross complete/i })).toBeTruthy();
    expect(card('A').querySelector('input[type=file]')).toBeTruthy();
  });

  it('populates the form from the GrossRecord (text, pieces, dimensions left to right, weight, complete) and shows "Grossed by {name}, {time}"', async () => {
    await parts(detail({ parts: [part(1, { gross: gross(1, { is_complete: true }) })] }));
    const c = within(card('A'));
    expect((c.getByRole('textbox', { name: /gross description/i }) as HTMLTextAreaElement).value).toBe('Synthetic gross text.');
    expect((c.getByRole('textbox', { name: /^length/i }) as HTMLInputElement).value).toBe('12.5');
    expect((c.getByRole('textbox', { name: /^width/i }) as HTMLInputElement).value).toMatch(/^8(\.0)?$/);
    expect((c.getByRole('textbox', { name: /^depth/i }) as HTMLInputElement).value).toBe('');
    expect((c.getByRole('textbox', { name: /^weight/i }) as HTMLInputElement).value).toBe('1.25');
    expect(c.getByRole('switch', { name: /gross complete/i }).getAttribute('aria-checked') ?? (c.getByRole('switch', { name: /gross complete/i }) as HTMLInputElement).checked).toBeTruthy();
    expect(card('A').textContent).toContain('Grossed by Synthetic Grosser');
  });

  it('Save part PUTs /parts/{id}/gross with If-Match "<gross version>" and a body of gross_text, pieces_count, dimensions_mm (filled only), weight_g, is_complete', async () => {
    await parts();
    const c = within(card('A'));
    const text = c.getByRole('textbox', { name: /gross description/i });
    await userEvent.clear(text);
    await userEvent.type(text, 'Edited gross.');
    await userEvent.type(c.getByRole('textbox', { name: /^depth/i }), '3.5');
    await userEvent.click(c.getByRole('switch', { name: /gross complete/i }));
    await userEvent.click(c.getByRole('button', { name: /^save part$/i }));
    await waitFor(() => expect(hit('PUT', /\/gross$/)).toHaveLength(1));
    const h = hit('PUT', /\/gross$/)[0]!;
    expect(h.path).toBe(`/v1/anatomic/cases/${ID(1)}/parts/${ID(101)}/gross`);
    expect(h.headers.get('if-match')).toBe('"2"');
    expect(h.json).toEqual({ gross_text: 'Edited gross.', pieces_count: 2, dimensions_mm: ['12.5', '8', '3.5'], weight_g: '1.25', is_complete: true });
  });

  it('editing Site/Description PUTs /parts/{id} with If-Match "<part version>" and {site_text, description_text}', async () => {
    await parts();
    const c = within(card('A'));
    const site = c.getByRole('textbox', { name: /^site/i });
    await userEvent.clear(site);
    await userEvent.type(site, 'Synthetic new site');
    await userEvent.click(c.getByRole('button', { name: /^save part$/i }));
    await waitFor(() => expect(hit('PUT', /\/parts\/[^/]+$/)).toHaveLength(1));
    const h = hit('PUT', /\/parts\/[^/]+$/)[0]!;
    expect(h.path).toBe(`/v1/anatomic/cases/${ID(1)}/parts/${ID(101)}`);
    expect(h.headers.get('if-match')).toBe('"3"');
    expect(h.json).toEqual({ site_text: 'Synthetic new site', description_text: 'Synthetic description 1' });
  });

  it('dimensions are filled left to right: Depth without Width is a field error and nothing is sent', async () => {
    await parts(detail({ parts: [part(1)] }));
    const c = within(card('A'));
    await userEvent.type(c.getByRole('textbox', { name: /gross description/i }), 'x');
    await userEvent.type(c.getByRole('textbox', { name: /^depth/i }), '4');
    await userEvent.click(c.getByRole('button', { name: /^save part$/i }));
    expect(hit('PUT', /\/gross$/)).toHaveLength(0);
    expect(c.getByRole('textbox', { name: /^width/i }).getAttribute('aria-invalid') === 'true' || c.getByRole('textbox', { name: /^depth/i }).getAttribute('aria-invalid') === 'true').toBe(true);
  });

  it.each([['Length', '10000'], ['Length', '0'], ['Weight (g)', '100000'], ['Weight (g)', '0']])('%s = %s is out of range (min 0.1 / 0.01, max 9999.9 / 99999.99) -> blocked client-side', async (label, value) => {
    await parts(detail({ parts: [part(1)] }));
    const c = within(card('A'));
    await userEvent.type(c.getByRole('textbox', { name: /gross description/i }), 'x');
    await userEvent.type(c.getByRole('textbox', { name: new RegExp(`^${label.replace(/[()]/g, '\\$&')}`, 'i') }), value);
    await userEvent.click(c.getByRole('button', { name: /^save part$/i }));
    expect(hit('PUT', /\/gross$/)).toHaveLength(0);
  });

  it('Pieces accepts integers 0–999 only (1000 and 1.5 are blocked)', async () => {
    await parts(detail({ parts: [part(1)] }));
    const c = within(card('A'));
    const pieces = [...c.queryAllByRole('textbox', { name: /^pieces/i }), ...c.queryAllByRole('spinbutton', { name: /^pieces/i })][0]!;
    await userEvent.type(c.getByRole('textbox', { name: /gross description/i }), 'x');
    await userEvent.type(pieces, '1000');
    await userEvent.click(c.getByRole('button', { name: /^save part$/i }));
    expect(hit('PUT', /\/gross$/)).toHaveLength(0);
  });

  it('gross text is plain text with a live count and a 20 000 character cap', async () => {
    await parts(detail({ parts: [part(1)] }));
    const c = within(card('A'));
    const text = c.getByRole('textbox', { name: /gross description/i }) as HTMLTextAreaElement;
    await userEvent.click(text);
    await userEvent.paste('z'.repeat(20100));
    expect(text.value.length).toBeLessThanOrEqual(20000);
    expect(card('A').textContent).toMatch(/20[ ,]?000/);
  });

  it(';code + Tab expands the matching active gross template; unknown code leaves the text and shows "No template ;zz9"', async () => {
    await parts(detail({ parts: [part(1)] }), [template('nm1', 'No macroscopic abnormality.'), template('old', 'Inactive body', { is_active: false })]);
    const text = within(card('A')).getByRole('textbox', { name: /gross description/i }) as HTMLTextAreaElement;
    await userEvent.click(text);
    await userEvent.keyboard(';nm1{Tab}');
    expect(text.value).toBe('No macroscopic abnormality.');
    await userEvent.clear(text);
    await userEvent.keyboard(';old{Tab}');
    expect(text.value).not.toContain('Inactive body');
    await userEvent.clear(text);
    await userEvent.keyboard(';zz9{Tab}');
    expect(text.value).toBe(';zz9');
    expect(card('A').textContent).toContain('No template ;zz9');
  });

  it('Alt+S saves the form on the current tab (Parts & gross)', async () => {
    const { shortcuts } = await import('@/core/shortcuts/registry');
    await parts();
    const c = within(card('A'));
    await userEvent.type(c.getByRole('textbox', { name: /gross description/i }), ' more');
    act(() => shortcuts.list('staff.anatomic.case').find((s) => s.key === 'Alt+S')!.run());
    await waitFor(() => expect(hit('PUT', /\/gross$/)).toHaveLength(1));
  });

  it('409 version_conflict on save -> the conflict banner; the user\'s text stays in the field', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/parts/:pid/gross`, () => problem('common.version_conflict', 409)));
    await parts();
    const c = within(card('A'));
    await userEvent.type(c.getByRole('textbox', { name: /gross description/i }), ' keep me');
    await userEvent.click(c.getByRole('button', { name: /^save part$/i }));
    await waitFor(() => expect(banner(/This case was changed by someone else/)).toHaveLength(1));
    expect((c.getByRole('textbox', { name: /gross description/i }) as HTMLTextAreaElement).value).toContain('keep me');
  });

  it('after sign-out: anatomic.signout_locked shows the §8 message', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/parts/:pid/gross`, () => problem('anatomic.signout_locked', 409)));
    await parts();
    await userEvent.type(within(card('A')).getByRole('textbox', { name: /gross description/i }), 'x');
    await userEvent.click(within(card('A')).getByRole('button', { name: /^save part$/i }));
    expect(await screen.findByText('This case is signed out. Use Revise/Amend or add an addendum.')).toBeTruthy();
  });

  it('[Add part] dialog: Site required (≤ 200), Description (≤ 1000); POSTs /parts', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/parts`, () => HttpResponse.json(part(3), { status: 201 })));
    await parts();
    await userEvent.click(screen.getByRole('button', { name: /^add part$/i }));
    const d = await screen.findByRole('dialog');
    await userEvent.click(within(d).getByRole('button', { name: /^add part$/i }));
    expect(hit('POST', /\/parts$/)).toHaveLength(0); // site required
    await userEvent.type(within(d).getByRole('textbox', { name: /^site/i }), 'Synthetic new part');
    await userEvent.click(within(d).getByRole('button', { name: /^add part$/i }));
    await waitFor(() => expect(hit('POST', /\/parts$/)).toHaveLength(1));
    expect(hit('POST', /\/parts$/)[0]!.json).toEqual({ site_text: 'Synthetic new part' });
  });

  it('empty: "No parts yet. Parts are created when specimens are received, or add one."', async () => {
    await parts(detail({ parts: [], part_count: 0 }));
    expect(document.body.textContent).toContain('No parts yet. Parts are created when specimens are received, or add one.');
  });

  it('read-only users (no anatomic.case.work) see values but no Save / Add part / editable fields', async () => {
    await mount(two(), PERM_READ);
    await tab(/^parts & gross$/i);
    expect(screen.queryByRole('button', { name: /^save part$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^add part$/i })).toBeNull();
    expect(document.body.textContent).toContain('Synthetic gross text.');
  });
});

describe('accessibility (axe) and states', () => {
  const run = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((v) => `${v.id}: ${v.help}`);
  it('Overview', async () => { await mount(); expect(await run()).toEqual([]); });
  it('Overview with every banner', async () => {
    await mount(detail({ flags: { profile_missing: true, specimen_rejected: true, open_change: false, pending_stain_orders: 0, parts_missing_site: false }, parts: [part(1, { specimen_state: 'rejected' })], open_draft: { kind: 'revision', version: 1, updated_at: '2026-11-11T05:00:00.000Z' }, status: 'signed_out' }));
    expect(await run()).toEqual([]);
  });
  it('Parts & gross', async () => { await mount(detail({ parts: [part(1, { gross: gross(1) }), part(2)] })); await tab(/^parts & gross$/i); expect(await run()).toEqual([]); });
  it('Accession dialog', async () => {
    await mount(received());
    await userEvent.click(screen.getByRole('button', { name: /^accession$/i }));
    await screen.findByRole('dialog');
    expect(await run()).toEqual([]);
  });
  it('cancelled case: neutral chip with the word "Cancelled" and no mutating actions', async () => {
    await mount(detail({ status: 'cancelled', allowed_actions: [] }));
    const chip = screen.getAllByText('Cancelled').map((e) => e.closest('[data-tone]')).find(Boolean) as HTMLElement;
    expect(chip.getAttribute('data-tone')).toBe('neutral');
    expect(screen.queryByRole('button', { name: /^start processing$/i })).toBeNull();
  });
});
