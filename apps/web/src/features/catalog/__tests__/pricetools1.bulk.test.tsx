// @vitest-environment jsdom
// T0D-PRICETOOLS-1 (LD-321 / LD-310 / LD-353): the Bulk update panel of the price list version editor (SCR-14, component PriceVersionEditor, props as in web-t34).
// done_when (2): "a Bulk Update panel (percent or fixed amount, rounding, scope, preview of the first 20 changed rows before applying)". The API has no preview
// operation, so the PREVIEW IS COMPUTED IN THE BROWSER from the draft's items with integer arithmetic (bigint or integer math, never floats), exactly as the server
// will apply it (bulkUpdatePriceListDraft: half up, rounding none = paisa, nearest_rupee / nearest_5 / nearest_10 = rupees, result below 0 refuses the whole request).
// CONTRACT pinned here (tester wording; the writer may dispute through the ruling flow):
//   button "Bulk update" in the editor toolbar: enabled for catalog.price_list.manage on a DRAFT version; for a reader DISABLED with a visible reason naming
//     catalog.price_list.manage; for a published version DISABLED with a visible reason that says "draft". It opens a role=dialog named "Bulk update".
//   dialog fields : radios "By percent" (default) / "By fixed amount"; textbox "Percent change" (percent, <= 2 decimals, -100..1000) or "Amount (NPR)" (rupees, <= 2
//     decimals, signed); radios "None" (default) / "Nearest rupee" / "Nearest 5" / "Nearest 10" (group "Rounding"); radios "All tests" (default) / "One department" /
//     "Listed tests"; Select "Department" (only for One department); textbox "Test codes" (comma or space separated, case-insensitive, de-duplicated, in typed order).
//   preview       : a table named "Preview" with the columns Code, Current price (NPR), New price (NPR), Change; ONLY changed rows, at most the first 20, plus the text
//     "Showing the first 20 of N" when N > 20; the summary "N prices change"; it updates while typing and NOTHING is sent until Apply.
//   Apply         : button "Apply", enabled only when the input is valid and at least one price changes; ONE POST price-list-versions/<version id>/bulk-update with exactly the
//     contract body (no stray keys) and an Idempotency-Key; success shows the server's changed count, closes the dialog and refreshes the page; 4xx detail verbatim in a
//     role=alert inside the open dialog. Cancel / Escape send nothing.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { headersOf, tableOf } from './emptytbl2.helpers';
import { API, ID, MANAGE, READ, TM, api, prob, ver } from './pricetools1.harness';

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => { API.reset(); TM.session.permissions = MANAGE; });
afterEach(() => { cleanup(); api.resetHandlers(); TM.refresh.mockReset(); });

const money = (amount_paisa: number) => ({ amount_paisa, currency: 'NPR' });
const dept = (n: number, name: string) => ({ id: ID(n), code: name.slice(0, 4).toUpperCase(), name, report_order: n, is_active: true, version: 1 });
const DEPTS = [dept(1, 'Hematology'), dept(2, 'Biochemistry')];
const ord = (n: number, code: string, name: string, d: number, o: Record<string, unknown> = {}) => ({ id: ID(n), kind: 'test', code, name, is_orderable: true, is_active: true, revision: 1, department_id: ID(d), ...o });
const CBC = ord(101, 'CBC', 'Complete blood count', 1);
const HB = ord(102, 'HB', 'Hemoglobin', 1);
const FBS = ord(103, 'FBS', 'Fasting blood sugar', 2);
const LIPID = ord(104, 'LIPID', 'Lipid profile', 2, { kind: 'panel', panel_kind: 'clinical' });
const ORDERABLES = [CBC, HB, FBS, LIPID];
const item = (o: Record<string, any>, paisa: number) => ({ orderable_id: o.id, orderable_code: o.code, orderable_kind: o.kind, unit_price: money(paisa) });
const ITEMS = [item(CBC, 90000), item(HB, 80000), item(FBS, 20000), item(LIPID, 12345)];
const PLREF = { id: ID(60), code: 'DEFAULT', name: 'Default price list' };

type Props = { version?: Record<string, unknown>; items?: unknown[]; orderables?: unknown[]; permissions?: string[] };
async function openEditor(o: Props = {}) {
  const { PriceVersionEditor } = await import('../components/PriceVersionEditor');
  const items = o.items ?? ITEMS;
  const Editor = PriceVersionEditor as unknown as React.ComponentType<Record<string, unknown>>;
  return render(<ToastProvider><Editor priceList={PLREF} version={o.version ?? ver(73, 3, 'draft', { item_count: items.length })} items={items} currentItems={items} orderables={o.orderables ?? ORDERABLES} departments={DEPTS} permissions={o.permissions ?? MANAGE} /></ToastProvider>);
}
const bulkBtn = () => screen.getByRole('button', { name: /^bulk update$/i }) as HTMLButtonElement;
const posts = () => API.find('POST', /bulk-update$/);
async function openPanel(o: Props = {}) { await openEditor(o); await userEvent.click(bulkBtn()); return screen.findByRole('dialog', { name: /bulk update/i }); }
const set = (el: HTMLElement, v: string) => fireEvent.change(el, { target: { value: v } });
const percent = (d: HTMLElement) => within(d).getByRole('textbox', { name: /^percent change/i });
const amount = (d: HTMLElement) => within(d).getByRole('textbox', { name: /^amount \(npr\)/i });
const apply = (d: HTMLElement) => within(d).getByRole('button', { name: /^apply$/i }) as HTMLButtonElement;
const radio = (d: HTMLElement, name: RegExp) => within(d).getByRole('radio', { name });
const preview = (d: HTMLElement) => tableOf(d);
const rowsOf = (t: HTMLElement) => [...t.querySelectorAll<HTMLElement>('tbody tr, [role="rowgroup"] [role="row"]')].filter((r) => r.getAttribute('aria-hidden') !== 'true' && !r.closest('thead') && !r.querySelector('th, [role="columnheader"]') && (r.textContent ?? '').trim() !== '').map((r) => [...r.querySelectorAll('td, [role="cell"], [role="gridcell"]')].map((c) => (c.textContent ?? '').trim()));
/** code -> [current, new] shown in the preview table. */
const shown = (d: HTMLElement) => Object.fromEntries(rowsOf(preview(d)).filter((r) => r.length >= 3).map((r) => [r[0], [r[1], r[2]]]));
const choose = async (scope: HTMLElement, label: RegExp, option: string | RegExp) => { await userEvent.click(within(scope).getByLabelText(label)); await userEvent.click(await screen.findByRole('option', { name: option })); };
const settle = () => new Promise((r) => setTimeout(r, 80));
const typePercent = async (d: HTMLElement, v: string) => { set(percent(d), v); };
const typeAmount = async (d: HTMLElement, v: string) => { await userEvent.click(radio(d, /^by fixed amount$/i)); set(amount(d), v); };

// =============================================================================================================================== the button
describe('the Bulk update button', () => {
  it('is enabled on a draft for a manager and opens a dialog named Bulk update', async () => {
    await openEditor();
    expect(bulkBtn().disabled).toBe(false);
    await userEvent.click(bulkBtn());
    expect(await screen.findByRole('dialog', { name: /bulk update/i })).toBeTruthy();
  });
  it('a reader sees it DISABLED with a visible reason naming catalog.price_list.manage', async () => {
    await openEditor({ permissions: READ });
    expect(bulkBtn().disabled).toBe(true);
    expect(document.body.textContent).toMatch(/catalog\.price_list\.manage/);
  });
  it('a published version has it DISABLED with a visible reason that says draft', async () => {
    await openEditor({ version: ver(70, 2, 'published') });
    expect(bulkBtn().disabled).toBe(true);
    expect(document.body.textContent).toMatch(/only a draft|draft/i);
  });
  it('the dialog holds the documented controls; By percent, None and All tests are the defaults', async () => {
    const d = await openPanel();
    expect((radio(d, /^by percent$/i) as HTMLInputElement).checked).toBe(true);
    expect((radio(d, /^none$/i) as HTMLInputElement).checked).toBe(true);
    expect((radio(d, /^all tests$/i) as HTMLInputElement).checked).toBe(true);
    for (const n of [/^by fixed amount$/i, /^nearest rupee$/i, /^nearest 5$/i, /^nearest 10$/i, /^one department$/i, /^listed tests$/i]) expect(radio(d, n), String(n)).toBeTruthy();
    expect(percent(d)).toBeTruthy();
  });
  it('Escape and Cancel close the dialog and send nothing; the focus is inside the dialog while it is open', async () => {
    const d = await openPanel();
    expect(d.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(bulkBtn());
    const d2 = await screen.findByRole('dialog', { name: /bulk update/i });
    await userEvent.click(within(d2).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toHaveLength(0);
  });
});

// =============================================================================================================================== preview maths (integer, half up)
describe('the preview is exact integer maths, as the server will apply it', () => {
  const CASES: { name: string; kind: 'pct' | 'amt'; value: string; rounding?: RegExp; expect: Record<string, string> }[] = [
    { name: '+10 %, no rounding (paisa half up: 123.45 -> 135.80)', kind: 'pct', value: '10', expect: { CBC: '990.00', HB: '880.00', FBS: '220.00', LIPID: '135.80' } },
    { name: '+10 %, nearest rupee (135.795 -> 136.00)', kind: 'pct', value: '10', rounding: /^nearest rupee$/i, expect: { CBC: '990.00', HB: '880.00', FBS: '220.00', LIPID: '136.00' } },
    { name: '+3 %, nearest 5 (927 -> 925, 824 -> 825, 206 -> 205, 127.15 -> 125)', kind: 'pct', value: '3', rounding: /^nearest 5$/i, expect: { CBC: '925.00', HB: '825.00', FBS: '205.00', LIPID: '125.00' } },
    { name: '+5.00 fixed, nearest 10 (ties go UP: 905 -> 910, 805 -> 810, 205 -> 210)', kind: 'amt', value: '5', rounding: /^nearest 10$/i, expect: { CBC: '910.00', HB: '810.00', FBS: '210.00', LIPID: '130.00' } },
    { name: '+2.50 fixed, nearest 5 (ties go UP: 902.5 -> 905, 802.5 -> 805, 202.5 -> 205)', kind: 'amt', value: '2.5', rounding: /^nearest 5$/i, expect: { CBC: '905.00', HB: '805.00', FBS: '205.00', LIPID: '125.00' } },
    { name: '-10 %, nearest 10', kind: 'pct', value: '-10', rounding: /^nearest 10$/i, expect: { CBC: '810.00', HB: '720.00', FBS: '180.00', LIPID: '110.00' } },
  ];
  it.each(CASES)('$name', async (c) => {
    const d = await openPanel();
    if (c.rounding) await userEvent.click(radio(d, c.rounding));
    if (c.kind === 'pct') await typePercent(d, c.value);
    else await typeAmount(d, c.value);
    await waitFor(() => expect(Object.keys(shown(d)).sort()).toEqual(Object.keys(c.expect).sort()));
    expect(Object.fromEntries(Object.entries(shown(d)).map(([k, v]) => [k, v[1]]))).toEqual(c.expect);
    expect(shown(d)['CBC']![0]).toBe('900.00'); // the current price column
    expect(posts()).toHaveLength(0);
  });
  it('the preview table has the columns Code, Current price (NPR), New price (NPR), Change and a Change cell with the difference', async () => {
    const d = await openPanel();
    await typePercent(d, '10');
    await waitFor(() => expect(rowsOf(preview(d)).length).toBeGreaterThan(0));
    expect(headersOf(preview(d)).slice(0, 4)).toEqual(['Code', 'Current price (NPR)', 'New price (NPR)', 'Change']);
    expect(rowsOf(preview(d)).find((r) => r[0] === 'CBC')![3]).toContain('90.00');
  });
  it('rows that do not change are NOT listed (a rounding that gives back the same price): -0.01 %, nearest 10 changes LIPID only', async () => {
    const d = await openPanel();
    await userEvent.click(radio(d, /^nearest 10$/i));
    await typePercent(d, '-0.01');
    await waitFor(() => expect(Object.keys(shown(d))).toEqual(['LIPID']));
    expect(shown(d)['LIPID']![1]).toBe('120.00');
    expect(d.textContent).toMatch(/\b1 price\b|\b1 prices\b|1 price changes/i);
  });
  it('0 % changes nothing: the preview says so and Apply stays disabled', async () => {
    const d = await openPanel();
    await typePercent(d, '0');
    await waitFor(() => expect(d.textContent).toMatch(/no prices? change|nothing (to|would) change/i));
    expect(apply(d).disabled).toBe(true);
  });
  it('shows the first 20 changed rows only, with "Showing the first 20 of 25"', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ code: `T${String(i).padStart(4, '0')}`, id: 3000 + i }));
    const orderables = many.map((m) => ord(m.id, m.code, `Synthetic test ${m.code}`, 1));
    const items = orderables.map((o) => item(o, 10000));
    const d = await openPanel({ items, orderables });
    await typePercent(d, '10');
    await waitFor(() => expect(rowsOf(preview(d))).toHaveLength(20));
    expect(rowsOf(preview(d))[0]![0]).toBe('T0000');
    expect(rowsOf(preview(d))[19]![0]).toBe('T0019');
    expect(d.textContent).toMatch(/showing the first 20 of 25/i);
    expect(d.textContent).toMatch(/25 prices change/i);
    expect(rowsOf(preview(d))[0]![2]).toBe('110.00');
  });
  it('with no input yet the preview table still shows its headers (and no rows)', async () => {
    const d = await openPanel();
    expect(headersOf(preview(d)).slice(0, 4)).toEqual(['Code', 'Current price (NPR)', 'New price (NPR)', 'Change']);
    expect(apply(d).disabled).toBe(true);
  });
  it('only IN-SCOPE rows are listed: One department Biochemistry +10 %', async () => {
    const d = await openPanel();
    await userEvent.click(radio(d, /^one department$/i));
    await choose(d, /^department$/i, /biochemistry/i);
    await typePercent(d, '10');
    await waitFor(() => expect(Object.keys(shown(d)).sort()).toEqual(['FBS', 'LIPID']));
  });
  it('Listed tests: "cbc, FBS fbs" lists CBC and FBS once each', async () => {
    const d = await openPanel();
    await userEvent.click(radio(d, /^listed tests$/i));
    set(within(d).getByRole('textbox', { name: /^test codes/i }), 'cbc, FBS fbs');
    await typePercent(d, '10');
    await waitFor(() => expect(Object.keys(shown(d)).sort()).toEqual(['CBC', 'FBS']));
  });
});

// =============================================================================================================================== input validation (no request)
describe('invalid input blocks Apply and sends nothing', () => {
  it.each(['', 'abc', '12.345', '1000.01', '-100.01', '1e2', '--5', '5%', '1,5', '10 10'])('percent "%s" is invalid', async (v) => {
    const d = await openPanel();
    await typePercent(d, v);
    await settle();
    expect(apply(d).disabled).toBe(true);
    if (v) expect(d.textContent).toMatch(/percent|decimals|between|number/i);
    expect(posts()).toHaveLength(0);
  });
  it.each(['1000', '-100', '0.05', '-12.5'])('percent "%s" is valid at the edges (bp %s x 100)', async (v) => {
    const d = await openPanel();
    await typePercent(d, v);
    await waitFor(() => expect(d.textContent).not.toMatch(/must be between|at most 2 decimals/i));
  });
  it.each(['', 'abc', '12.345', '1e3', '--5', '5,00', '99999999999'])('fixed amount "%s" is invalid', async (v) => {
    const d = await openPanel();
    await typeAmount(d, v);
    await settle();
    expect(apply(d).disabled).toBe(true);
    expect(posts()).toHaveLength(0);
  });
  it('a result below 0 inside the scope blocks Apply with an alert (the server would refuse the whole request): -200 fixed on all tests', async () => {
    const d = await openPanel();
    await typeAmount(d, '-200');
    await waitFor(() => expect(within(d).getAllByRole('alert').length).toBeGreaterThan(0));
    expect(d.textContent).toMatch(/below 0|below zero|negative/i);
    expect(d.textContent).toMatch(/LIPID/);
    expect(apply(d).disabled).toBe(true);
  });
  it('the same -200 on One department Hematology is fine (only the scope counts) and exactly 0.00 is allowed (-200 on FBS alone)', async () => {
    const d = await openPanel();
    await typeAmount(d, '-200');
    await userEvent.click(radio(d, /^one department$/i));
    await choose(d, /^department$/i, /hematology/i);
    await waitFor(() => expect(apply(d).disabled).toBe(false));
    expect(Object.keys(shown(d)).sort()).toEqual(['CBC', 'HB']);
    await userEvent.click(radio(d, /^listed tests$/i));
    set(within(d).getByRole('textbox', { name: /^test codes/i }), 'FBS');
    await waitFor(() => expect(shown(d)['FBS']).toEqual(['200.00', '0.00']));
    expect(apply(d).disabled).toBe(false);
  });
  it('-100 % sets every price to 0.00 and is allowed', async () => {
    const d = await openPanel();
    await typePercent(d, '-100');
    await waitFor(() => expect(shown(d)['CBC']).toEqual(['900.00', '0.00']));
    expect(apply(d).disabled).toBe(false);
  });
  it('Listed tests: an unknown code names itself, an empty list is invalid, and Apply is disabled', async () => {
    const d = await openPanel();
    await userEvent.click(radio(d, /^listed tests$/i));
    await typePercent(d, '10');
    expect(apply(d).disabled).toBe(true);
    set(within(d).getByRole('textbox', { name: /^test codes/i }), 'CBC, ZZZ99');
    await waitFor(() => expect(d.textContent).toMatch(/ZZZ99/));
    expect(apply(d).disabled).toBe(true);
    expect(posts()).toHaveLength(0);
  });
  it('One department without a department chosen keeps Apply disabled', async () => {
    const d = await openPanel();
    await userEvent.click(radio(d, /^one department$/i));
    await typePercent(d, '10');
    expect(apply(d).disabled).toBe(true);
  });
});

// =============================================================================================================================== Apply
describe('Apply sends the contract body, once', () => {
  const body = () => posts()[0]!.json;
  it('percent, all tests: {change_kind, percent_bp, rounding, scope} and nothing else', async () => {
    const d = await openPanel();
    await userEvent.click(radio(d, /^nearest 10$/i));
    await typePercent(d, '10');
    await waitFor(() => expect(apply(d).disabled).toBe(false));
    await userEvent.click(apply(d));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.path).toBe(`/v1/catalog/price-list-versions/${ID(73)}/bulk-update`);
    expect(body()).toEqual({ change_kind: 'percent', percent_bp: 1000, rounding: 'nearest_10', scope: 'all' });
    expect(posts()[0]!.headers.get('idempotency-key')).toBeTruthy();
  });
  it('fixed amount: amount_paisa signed integer, no percent_bp (a negative decimal -50.25 -> -5025)', async () => {
    const d = await openPanel();
    await typeAmount(d, '-50.25');
    await waitFor(() => expect(apply(d).disabled).toBe(false));
    await userEvent.click(apply(d));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(body()).toEqual({ change_kind: 'fixed_amount', amount_paisa: -5025, rounding: 'none', scope: 'all' });
  });
  it('negative percent in basis points: -12.5 -> -1250; 0.05 -> 5; 1000 -> 100000', async () => {
    for (const [v, bp] of [['-12.5', -1250], ['0.05', 5], ['1000', 100000]] as const) {
      cleanup();
      API.reset();
      const d = await openPanel();
      await typePercent(d, v);
      await waitFor(() => expect(apply(d).disabled).toBe(false));
      await userEvent.click(apply(d));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(body().percent_bp, v).toBe(bp);
    }
  });
  it('department scope: department_id of the chosen department, no orderable_ids', async () => {
    const d = await openPanel();
    await userEvent.click(radio(d, /^one department$/i));
    await choose(d, /^department$/i, /biochemistry/i);
    await typePercent(d, '10');
    await waitFor(() => expect(apply(d).disabled).toBe(false));
    await userEvent.click(apply(d));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(body()).toEqual({ change_kind: 'percent', percent_bp: 1000, rounding: 'none', scope: 'department', department_id: ID(2) });
  });
  it('listed tests scope: orderable_ids in typed order, each once, no department_id', async () => {
    const d = await openPanel();
    await userEvent.click(radio(d, /^listed tests$/i));
    set(within(d).getByRole('textbox', { name: /^test codes/i }), 'fbs CBC, FBS');
    await typePercent(d, '10');
    await waitFor(() => expect(apply(d).disabled).toBe(false));
    await userEvent.click(apply(d));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(body()).toEqual({ change_kind: 'percent', percent_bp: 1000, rounding: 'none', scope: 'listed_tests', orderable_ids: [ID(103), ID(101)] });
  });
  it('a double click on Apply posts once; success shows the server changed count, closes the dialog and refreshes the page', async () => {
    API.bulkDelayMs = 150;
    const d = await openPanel();
    await typePercent(d, '10');
    await waitFor(() => expect(apply(d).disabled).toBe(false));
    await userEvent.dblClick(apply(d));
    await waitFor(() => expect(document.body.textContent).toMatch(/\b98\b/));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toHaveLength(1);
    expect(TM.refresh.mock.calls.length).toBeGreaterThan(0);
  });
  it.each([
    [422, 'catalog.formula_invalid', 'Synthetic: the result for LIPID would be below 0.'],
    [409, 'catalog.version_in_use', 'Synthetic: this version is not a draft any more.'],
  ])('%s %s: the server detail is shown verbatim in a role=alert and the dialog stays open', async (status, code, detail) => {
    API.bulk = [() => prob(status, code, detail)];
    const d = await openPanel();
    await typePercent(d, '10');
    await waitFor(() => expect(apply(d).disabled).toBe(false));
    await userEvent.click(apply(d));
    const alerts = await within(d).findAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toContain(detail);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(apply(d).disabled).toBe(false);
  });
  it('a 5xx is retryable with the SAME Idempotency-Key (never a second change by a retry)', async () => {
    API.bulk = [() => prob(500, 'common.internal'), () => HttpResponse.json({ price_list_version_id: ID(73), changed_count: 4, unchanged_count: 0 })];
    const d = await openPanel();
    await typePercent(d, '10');
    await waitFor(() => expect(apply(d).disabled).toBe(false));
    await userEvent.click(apply(d));
    await within(d).findAllByRole('alert');
    await userEvent.click(apply(d));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0]!.headers.get('idempotency-key')).toBe(posts()[1]!.headers.get('idempotency-key'));
  });
});

// =============================================================================================================================== a11y
describe('accessibility', () => {
  it('axe: the open panel with a preview has no violations', async () => {
    const d = await openPanel();
    await typePercent(d, '10');
    await waitFor(() => expect(rowsOf(preview(d)).length).toBeGreaterThan(0));
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
  it('the preview table is regular density and scrolls inside its own box', async () => {
    const d = await openPanel();
    expect(preview(d).className).toMatch(/lims-table-regular/);
    expect(preview(d).className).not.toMatch(/lims-table-compact/);
    expect(preview(d).closest('[class*="lims-table-scroll"]')).toBeTruthy();
  });
});
