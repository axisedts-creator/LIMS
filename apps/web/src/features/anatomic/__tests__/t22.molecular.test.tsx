// @vitest-environment jsdom
// C11.T-22 — Case workspace "Molecular" tab (04-UI-UX §4.2.6, §3 Alt+S, §8; AC-11.1, AC-11.2, AC-11.3, AC-11.6 UI side; REQ-SEC-088/100).
// LD-140 (2026-11-13): kit components only, one primary button per page, every status shows tone + icon + word.
// ASSUMED (t22.harness.tsx header): reached through the T-19 CaseWorkspace seam by the tab name "Molecular" (molecular cases only); the tab loads GET /assays and GET /batches itself.
//   Editable rows are grid rows; each field is found by its column label inside the row (kit Select = button whose accessible name contains the label (not starts with it) + role=option; TextField/DecimalField = labelled textbox);
//   [Add row] / [Remove row] / [Save]; Save = PUT /cases/{id}/molecular-results with If-Match "<molecular_rev>" and the FULL result list; no Idempotency-Key is required (contract x-idempotency: none).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_READ, PERM_WORK, api, batch, detail, hit, molCase, molResult, problem, resetHits, router, t22Defaults } from './t22.harness';

vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); api.use(...t22Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (d: Record<string, unknown> = molCase(), permissions = PERM_WORK) => {
  const { CaseWorkspace } = await import('../components/CaseWorkspace');
  return render(<ToastProvider><CaseWorkspace detail={d as never} permissions={permissions} templates={[]} /></ToastProvider>);
};
const open = async (d: Record<string, unknown> = molCase(), permissions = PERM_WORK) => { await mount(d, permissions); await userEvent.click(screen.getByRole('tab', { name: /^molecular$/i })); };
const grid = () => screen.getByRole('grid');
const dataRows = () => within(grid()).getAllByRole('row').filter((r) => !within(r).queryAllByRole('columnheader').length);
const btn = (re: RegExp, scope: HTMLElement = document.body) => within(scope).getByRole('button', { name: re }) as HTMLButtonElement;
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const field = (scope: HTMLElement, label: RegExp) => within(scope).getByLabelText(label) as HTMLInputElement;
const addRow = async () => { await userEvent.click(btn(/^add row$/i)); return dataRows().at(-1)!; };
/** AC-11.1 happy row: SYN_PCR_A / T1 / detected. */
const fillT1 = async (row: HTMLElement) => {
  await choose(row, /assay/i, /Synthetic PCR A/);
  await choose(row, /target/i, /Target one/);
  await choose(row, /result/i, /^Detected/);
};
const puts = () => hit('PUT', /\/cases\/[^/]+\/molecular-results$/);
const text = () => document.body.textContent ?? '';

describe('tab visibility', () => {
  it('a molecular case has a "Molecular" tab; a histology case does not', async () => {
    await mount();
    expect(screen.getByRole('tab', { name: /^molecular$/i })).toBeTruthy();
    cleanup();
    await mount(detail());
    expect(screen.queryByRole('tab', { name: /^molecular$/i })).toBeNull();
  });
});

describe('table (§4.2.6)', () => {
  it('columns: Assay, Target, Result, Value, Unit, Method, Kit name, Kit lot, Kit expiry, Batch, Comment', async () => {
    await open();
    for (const h of ['Assay', 'Target', 'Result', 'Value', 'Unit', 'Method', 'Kit name', 'Kit lot', 'Kit expiry', 'Batch', 'Comment']) {
      expect(within(grid()).getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }), h).toBeTruthy();
    }
  });

  it('empty: "No results yet. Add a row for each assay target." and [Add row]', async () => {
    await open();
    expect(text()).toContain('No results yet. Add a row for each assay target.');
    expect(btn(/^add row$/i)).toBeTruthy();
    expect(dataRows()).toHaveLength(0);
  });

  it('saved results render display names, value + unit, and the word "Abnormal" next to abnormal results only (never colour only)', async () => {
    await open(molCase({
      molecular_results: [
        molResult(1),
        molResult(2, { target_code: 'T2', target_display: 'Target two', result_code: 'negative', result_display: 'Negative', is_abnormal: false, value_decimal: undefined, unit_code: undefined }),
      ],
    }));
    const [a, b] = dataRows();
    expect(a!.textContent).toContain('Detected');
    expect(a!.textContent).toContain('Abnormal');
    expect(a!.querySelector('[data-tone] svg, [data-tone] [aria-hidden=true]')).toBeTruthy(); // tone + icon + word
    expect(field(a!, /^value/i).value).toBe('1250');
    expect(a!.textContent).toContain('copies_per_ml');
    expect(b!.textContent).toContain('Negative');
    expect(b!.textContent).not.toContain('Abnormal');
  });

  it('server text (comment, kit name) renders as text, never HTML (REQ-SEC-088)', async () => {
    await open(molCase({ molecular_results: [molResult(1, { comment_text: '<img src=x onerror=alert(1)>', kit_name: '<script>alert(2)</script>' })] }));
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(field(dataRows()[0]!, /^kit name/i).value).toBe('<script>alert(2)</script>');
  });
});

describe('editing: pickers follow the assay definition (AC-11.2 UI side)', () => {
  it('Assay offers active assays only', async () => {
    await open();
    const row = await addRow();
    await userEvent.click(within(row).getByRole('button', { name: /assay/i }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names).toEqual(expect.arrayContaining([expect.stringMatching(/Synthetic PCR A/), expect.stringMatching(/Synthetic NGS B/)]));
    expect(names.join('|')).not.toContain('Retired assay');
  });

  it('Target is disabled until an assay is chosen, then lists the assay\'s active targets only', async () => {
    await open();
    const row = await addRow();
    expect(btn(/target/i, row).disabled).toBe(true);
    await choose(row, /assay/i, /Synthetic PCR A/);
    await userEvent.click(btn(/target/i, row));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(names.some((n) => /Target one/.test(n))).toBe(true);
    expect(names.some((n) => /Target two/.test(n))).toBe(true);
    expect(names.some((n) => /Retired target/.test(n))).toBe(false);
  });

  it('Result offers exactly the target\'s active result values (a code outside the set cannot be picked)', async () => {
    await open();
    const row = await addRow();
    await choose(row, /assay/i, /Synthetic PCR A/);
    await choose(row, /target/i, /Target one/);
    await userEvent.click(btn(/result/i, row));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(names).toHaveLength(3);
    for (const n of ['Detected', 'Not detected', 'Invalid']) expect(names.some((x) => x.includes(n)), n).toBe(true);
    expect(names.some((x) => /Equivocal/.test(x))).toBe(false); // inactive value
  });

  it('changing the assay clears target + result (no stale code is sent)', async () => {
    await open();
    const row = await addRow();
    await fillT1(row);
    await choose(row, /assay/i, /Synthetic NGS B/);
    expect(row.textContent).not.toContain('Target one');
    expect(row.textContent).not.toContain('Detected');
  });

  it('Method defaults to the assay method_text_default (editable, <=200)', async () => {
    await open();
    const row = await addRow();
    await choose(row, /assay/i, /Synthetic PCR A/);
    expect(field(row, /^method/i).value).toBe('Synthetic real-time PCR');
    expect(field(row, /^method/i).getAttribute('maxlength')).toBe('200');
  });

  it('text limits: kit name 120, kit lot 64, comment 1000', async () => {
    await open();
    const row = await addRow();
    expect(field(row, /^kit name/i).getAttribute('maxlength')).toBe('120');
    expect(field(row, /^kit lot/i).getAttribute('maxlength')).toBe('64');
    expect(field(row, /^comment/i).getAttribute('maxlength')).toBe('1000');
  });

  it('Unit is read-only text from the target (copies_per_ml for T1), not an input', async () => {
    await open();
    const row = await addRow();
    await fillT1(row);
    expect(row.textContent).toContain('copies_per_ml');
    expect(within(row).queryByLabelText(/^unit/i)?.tagName).not.toBe('INPUT');
  });

  it('Batch offers the batches of the chosen assay only, open and closed, with batch number + status word', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches`, () => HttpResponse.json({ data: [batch(1), batch(2, { status: 'closed' }), batch(3, { assay_code: 'SYN_NGS_B' })], page: { limit: 50 } })));
    await open();
    const row = await addRow();
    await choose(row, /assay/i, /Synthetic PCR A/);
    await userEvent.click(btn(/batch/i, row));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(names.some((n) => n.includes('MB260001') && /open/i.test(n))).toBe(true);
    expect(names.some((n) => n.includes('MB260002') && /closed/i.test(n))).toBe(true);
    expect(names.some((n) => n.includes('MB260003'))).toBe(false);
  });

  it('[Remove row] drops the row (and nothing is sent until Save)', async () => {
    await open(molCase({ molecular_results: [molResult(1), molResult(2, { target_code: 'T2', target_display: 'Target two', result_code: 'negative', result_display: 'Negative', is_abnormal: false, value_decimal: undefined, unit_code: undefined })] }));
    expect(dataRows()).toHaveLength(2);
    await userEvent.click(within(dataRows()[0]!).getByRole('button', { name: /^remove row/i }));
    expect(dataRows()).toHaveLength(1);
    expect(dataRows()[0]!.textContent).toContain('Negative');
    expect(puts()).toHaveLength(0);
  });
});

describe('AC-11.3 quantitative value', () => {
  it('Value is editable only for a target with allows_quantitative; T2 (qualitative) has no value input', async () => {
    await open();
    const row = await addRow();
    await choose(row, /assay/i, /Synthetic PCR A/);
    await choose(row, /target/i, /Target two/);
    const v = within(row).queryByLabelText(/^value/i) as HTMLInputElement | null;
    expect(v === null || v.disabled || v.readOnly).toBe(true);
  });

  it('T1 value 1250 is sent as the text decimal "1250" with unit copies_per_ml', async () => {
    await open();
    const row = await addRow();
    await fillT1(row);
    await userEvent.type(field(row, /^value/i), '1250');
    await userEvent.click(btn(/^save$/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const r = (puts()[0]!.json as { results: Record<string, unknown>[] }).results[0]!;
    expect(r['value_decimal']).toBe('1250');
    expect(typeof r['value_decimal']).toBe('string');
    expect(r['unit_code']).toBe('copies_per_ml');
  });

  it('a non-decimal value is never sent: the field refuses it or Save sends nothing', async () => {
    await open();
    const row = await addRow();
    await fillT1(row);
    await userEvent.type(field(row, /^value/i), '12abc');
    await userEvent.click(btn(/^save$/i));
    await new Promise((r) => setTimeout(r, 50));
    for (const p of puts()) for (const r of (p.json as { results: Record<string, unknown>[] }).results) expect(String(r['value_decimal'] ?? '0')).toMatch(/^-?\d+(\.\d+)?$/);
  });

  it('a row with a value but no result sends nothing (required: assay, target, result)', async () => {
    await open();
    await addRow();
    await userEvent.click(btn(/^save$/i));
    await new Promise((r) => setTimeout(r, 50));
    expect(puts()).toHaveLength(0);
  });
});

describe('AC-11.1 save', () => {
  it('PUT /cases/{id}/molecular-results with If-Match "<molecular_rev>" and a body of exactly the contract keys', async () => {
    await open();
    const row = await addRow();
    await fillT1(row);
    await userEvent.type(field(row, /^value/i), '1250');
    await userEvent.clear(field(row, /^method/i));
    await userEvent.type(field(row, /^method/i), 'Synthetic PCR method');
    await userEvent.type(field(row, /^kit name/i), 'Synthetic kit');
    await userEvent.type(field(row, /^kit lot/i), 'LOT-9');
    await userEvent.type(field(row, /^comment/i), 'Synthetic comment');
    await userEvent.click(btn(/^save$/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const p = puts()[0]!;
    expect(p.path).toBe(`/v1/anatomic/cases/${ID(1)}/molecular-results`);
    expect(p.headers.get('if-match')).toBe('"2"');
    const r = (p.json as { results: Record<string, unknown>[] }).results;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ assay_code: 'SYN_PCR_A', target_code: 'T1', result_code: 'detected', value_decimal: '1250', unit_code: 'copies_per_ml', method_text: 'Synthetic PCR method', kit_name: 'Synthetic kit', kit_lot: 'LOT-9', comment_text: 'Synthetic comment' });
    // schema is additionalProperties:false — display/id/is_abnormal fields from MolecularResult must not be echoed back
    const allowed = ['assay_code', 'target_code', 'result_code', 'value_decimal', 'unit_code', 'method_text', 'kit_name', 'kit_lot', 'kit_expiry_on', 'batch_id', 'comment_text'];
    for (const k of Object.keys(r[0]!)) expect(allowed, k).toContain(k);
    expect(Object.values(r[0]!).every((v) => v !== '' && v !== undefined)).toBe(true); // empty optional fields are omitted, not sent as ""
  });

  it('a batch picked for the row is sent as batch_id', async () => {
    await open();
    const row = await addRow();
    await fillT1(row);
    await choose(row, /batch/i, /MB260001/);
    await userEvent.click(btn(/^save$/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect((puts()[0]!.json as { results: Record<string, unknown>[] }).results[0]!['batch_id']).toBe(batch(1)['id']);
  });

  it('full replace: existing saved rows are sent again together with the new row', async () => {
    await open(molCase({ molecular_results: [molResult(1)] }));
    const row = await addRow();
    await choose(row, /assay/i, /Synthetic PCR A/);
    await choose(row, /target/i, /Target two/);
    await choose(row, /result/i, /^Negative/);
    await userEvent.click(btn(/^save$/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const r = (puts()[0]!.json as { results: Record<string, unknown>[] }).results;
    expect(r.map((x) => `${x['target_code']}:${x['result_code']}`)).toEqual(['T1:detected', 'T2:negative']);
  });

  it('a successful save shows a confirmation and refreshes the page (new molecular_rev comes with the new detail)', async () => {
    await open();
    await fillT1(await addRow());
    await userEvent.click(btn(/^save$/i));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(await screen.findByText(/saved/i)).toBeTruthy();
  });

  it('Alt+S saves (04-UI-UX §3)', async () => {
    await open();
    await fillT1(await addRow());
    const { shortcuts } = await import('@/core/shortcuts/registry');
    const s = shortcuts.list('staff.anatomic.case').find((x) => x.key === 'Alt+S');
    expect(s, 'Alt+S registered').toBeTruthy();
    act(() => s!.run());
    await waitFor(() => expect(puts()).toHaveLength(1));
  });

  it('a double click on [Save] sends one request (no duplicate write while pending)', async () => {
    await open();
    await fillT1(await addRow());
    const save = btn(/^save$/i);
    await userEvent.dblClick(save);
    await waitFor(() => expect(puts().length).toBeGreaterThan(0));
    expect(puts()).toHaveLength(1);
  });
});

describe('AC-11.2 / errors (04-UI-UX §2, §8)', () => {
  const fill = async () => { await fillT1(await addRow()); await userEvent.click(btn(/^save$/i)); };

  it('400 common.validation_failed -> "Check the values and try again." (no raw API message)', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/molecular-results`, () => problem('common.validation_failed', 400, { errors: [{ path: '/results/0/result_code', code: 'not_in_set', message: 'secret-internal' }] })));
    await open();
    await fill();
    expect(await screen.findByText('Check the values and try again.')).toBeTruthy();
    expect(text()).not.toContain('secret-internal');
  });

  it('the 400 error pointer /results/0/result_code marks the Result field of row 1 invalid', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/molecular-results`, () => problem('common.validation_failed', 400, { errors: [{ path: '/results/0/result_code', code: 'not_in_set', message: 'x' }] })));
    await open();
    await fill();
    await screen.findByText('Check the values and try again.');
    const row = dataRows()[0]!;
    expect(row.querySelector('[aria-invalid="true"]') ?? row.querySelector('[data-invalid]')).toBeTruthy();
  });

  it('409 common.version_conflict -> "changed by someone else" banner with [Reload]; the entered row is kept', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/molecular-results`, () => problem('common.version_conflict', 409)));
    await open();
    await fill();
    expect(await screen.findByText('This case was changed by someone else. Reload to see the latest version.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^reload$/i })).toBeTruthy();
    expect(dataRows()).toHaveLength(1);
  });

  it('428 common.precondition_required is shown as the same conflict copy', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/molecular-results`, () => problem('common.precondition_required', 428)));
    await open();
    await fill();
    expect(await screen.findByText('This case was changed by someone else. Reload to see the latest version.')).toBeTruthy();
  });

  it('409 anatomic.signout_locked -> "This case is signed out. Use Revise/Amend or add an addendum."', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/molecular-results`, () => problem('anatomic.signout_locked', 409)));
    await open();
    await fill();
    expect(await screen.findByText('This case is signed out. Use Revise/Amend or add an addendum.')).toBeTruthy();
  });

  it('409 anatomic.case_invalid_transition -> "That step isn\'t possible for a case in status in_processing."', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/molecular-results`, () => problem('anatomic.case_invalid_transition', 409)));
    await open();
    await fill();
    expect(await screen.findByText(/That step isn.t possible for a case in status in_processing\./)).toBeTruthy();
  });

  it('403 auth.mfa_required opens the step-up dialog with [Verify now]', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/molecular-results`, () => problem('auth.mfa_required', 403)));
    await open();
    await fill();
    expect(await screen.findByText('This action needs two-factor verification.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /verify now/i })).toBeTruthy();
  });

  it('a failing assay list leaves the pickers empty and does not crash the tab', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/assays`, () => problem('common.internal', 500)));
    await open();
    expect(btn(/^add row$/i)).toBeTruthy();
  });
});

describe('AC-11.6 mark ready needs a result', () => {
  it('a molecular case with no result: the stage button is still offered and a 409 case_invalid_transition is shown with the §8 copy', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/mark-ready`, () => problem('anatomic.case_invalid_transition', 409)));
    await mount();
    await userEvent.click(screen.getByRole('button', { name: /^mark ready for reporting$/i }));
    expect(await screen.findByText(/That step isn.t possible for a case in status in_processing\./)).toBeTruthy();
    expect(hit('POST', /\/mark-ready$/)).toHaveLength(1);
  });

  it('the Molecular tab says why while there are no results: "No results yet. Add a row for each assay target."', async () => {
    await open();
    expect(text()).toContain('No results yet. Add a row for each assay target.');
  });
});

describe('permissions and locked states', () => {
  it('a user without anatomic.case.work sees results read-only: no [Add row], [Remove row], [Save]; no editable inputs', async () => {
    await open(molCase({ molecular_results: [molResult(1)] }), PERM_READ);
    expect(screen.queryByRole('button', { name: /^add row$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^remove row/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
    expect(text()).toContain('Detected');
    expect(text()).toContain('1250');
    expect(document.querySelectorAll('input:not([disabled]):not([readonly]):not([type=checkbox])').length).toBe(0);
  });

  it('a signed-out case without an open change draft is read-only (writes would return anatomic.signout_locked)', async () => {
    await open(molCase({ status: 'signed_out', allowed_actions: [], molecular_results: [molResult(1)] }));
    expect(dataRows()).toHaveLength(1); // the tab really rendered (not the T-19 placeholder)
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^add row$/i })).toBeNull();
  });

  it('a signed-out case WITH an open revision draft can edit (D-66 (b))', async () => {
    await open(molCase({ status: 'signed_out', allowed_actions: [], open_draft: { kind: 'revision', version: 1, updated_at: '2026-11-11T08:00:00.000Z' }, molecular_results: [molResult(1)] }));
    expect(screen.getByRole('button', { name: /^save$/i })).toBeTruthy();
  });
});

describe('a11y and page rules', () => {
  const run = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);

  it('axe: empty tab, tab with rows, and read-only tab have no violations', async () => {
    await open();
    expect(await run()).toEqual([]);
    await fillT1(await addRow());
    expect(await run()).toEqual([]);
    cleanup();
    await open(molCase({ molecular_results: [molResult(1)] }), PERM_READ);
    expect(await run()).toEqual([]);
  });

  it('exactly one primary button on the page with this tab open (LD-140: the stage button; Save is secondary)', async () => {
    await open();
    await fillT1(await addRow());
    expect(dataRows()).toHaveLength(1); // the tab really rendered (not the T-19 placeholder)
    expect(document.querySelectorAll('.lims-btn-primary').length).toBeLessThanOrEqual(1);
  });
});
