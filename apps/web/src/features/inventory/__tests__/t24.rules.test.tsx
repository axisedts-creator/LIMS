// @vitest-environment jsdom
// C12.T-24 — S13 Consumption rules (04-UI-UX §3 S13). ACs: AC-12.1/.6 (preview shows the rule that applies: instrument-specific beats generic), AC-12.7 (no rule -> visible "no rule" outcome),
// AC-14.2 (QC rule with analyte empty warns it deducts once per analyte), TRD #69–#74 (list, create, supersede, deactivate, preview). The consumption deduction itself (AC-12.2–.5, .8) is server logic covered by C12 API tests.
// LD-140 (2026-11-13): kit components only, ONE primary button per page, every status shows tone + icon + word.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, IDEM_RE, ORIGIN, PERM_MANAGE, PERM_NONE, PERM_READ, api, hit, hits, isoAgo, page, problem, resetHits, router, rule, state } from './t24.harness';

vi.mock('next/navigation', async () => (await import('./t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t24.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_MANAGE; state.path = '/inventory/rules'; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/inventory/rules/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
/** Opens a kit Select (button) or types into a Combobox (input) and picks the option. */
const pick = async (scope: HTMLElement, label: RegExp, option: RegExp, typed = '') => {
  const combo = within(scope).queryByRole('combobox', { name: label });
  if (combo) await userEvent.type(combo, typed || ' '); else await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const openNew = async () => {
  await mount();
  await userEvent.click(await screen.findByRole('button', { name: /^new rule$/i }));
  return (await screen.findByRole('dialog', { name: /new consumption rule/i })) as HTMLElement;
};
const kindRadio = (dlg: HTMLElement, name: RegExp) => within(dlg).getByRole('radio', { name });
const creates = () => hit('POST', /^\/v1\/inventory\/consumption-rules$/);
const previews = () => hit('POST', /^\/v1\/inventory\/consumption-rules\/preview$/);
const fillPerTest = async (dlg: HTMLElement) => {
  await userEvent.click(kindRadio(dlg, /per test/i));
  await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
  await pick(dlg, /^analyser/i, /BIO-1|analyser 1/i, 'BIO');
  await pick(dlg, /^item/i, /GLU-R1/, 'GLU');
  await userEvent.type(within(dlg).getByRole('textbox', { name: /^quantity/i }), '2');
};

describe('S13 gating', () => {
  it('without inventory.item.read: permission-denied and no API call', async () => {
    state.permissions = PERM_NONE;
    await mount();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });
  it('read-only (no inventory.master.manage): the list shows, but New rule / Change quantity / Deactivate are hidden; Preview stays available', async () => {
    state.permissions = PERM_READ;
    await mount();
    const grid = await screen.findByRole('grid');
    expect(screen.queryByRole('button', { name: /^new rule$/i })).toBeNull();
    expect(within(grid).queryByRole('button', { name: /change quantity/i })).toBeNull();
    expect(within(grid).queryByRole('button', { name: /^deactivate$/i })).toBeNull();
  });
  it('with inventory.master.manage there is exactly one primary button on the page ("New rule")', async () => {
    await mount();
    await screen.findByRole('grid');
    expect(screen.getByRole('button', { name: /^new rule$/i })).toBeTruthy();
    expect(document.querySelectorAll('button[data-variant="primary"], button.lims-btn-primary, button[class*="primary"]').length).toBeLessThanOrEqual(1);
  });
});

describe('S13 list (TRD #69)', () => {
  it('columns Kind, Test, Analyte, Analyser, Item, Quantity, Effective from, Status; rows joined to names; null analyser reads "Any analyser"', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Kind', 'Test', 'Analyte', 'Analyser', 'Item', 'Quantity', 'Effective from', 'Status']) expect(heads, h).toContain(h);
    const r1 = (await within(grid).findByText(/per test/i)).closest('tr')!;
    expect(r1.textContent).toMatch(/GLU|glucose/i);
    expect(r1.textContent).toMatch(/BIO-1|analyser 1/i);
    expect(r1.textContent).toMatch(/GLU-R1/);
    const r2 = within(grid).getByText(/per analyte/i).closest('tr')!;
    expect(r2.textContent).toMatch(/Any analyser/);
    expect(r2.textContent).toMatch(/fasting glucose|GLU_F/i);
  });
  it('default list is current rules only; "Show history" asks for current_only=false', async () => {
    await mount();
    await screen.findByRole('grid');
    const first = new URLSearchParams(hit('GET', /^\/v1\/inventory\/consumption-rules$/)[0]!.search).get('current_only');
    expect([null, 'true']).toContain(first);
    cleanup(); resetHits();
    await mount({ history: '1' });
    await screen.findByRole('grid');
    expect(new URLSearchParams(hit('GET', /^\/v1\/inventory\/consumption-rules$/)[0]!.search).get('current_only')).toBe('false');
  });
  it.each([['kind', 'rule_kind', 'per_qc'], ['test', 'test_id', ID(70)], ['analyser', 'instrument_id', ID(950)], ['item', 'item_id', ID(11)]])('filter ?%s=… is sent as %s', async (q, api_, v) => {
    await mount({ [q]: v });
    await screen.findByRole('grid');
    expect(new URLSearchParams(hit('GET', /^\/v1\/inventory\/consumption-rules$/)[0]!.search).get(api_)).toBe(v);
  });
  it('status shows tone + icon + word: Current / Superseded / Inactive (E9: rules of inactive items are flagged)', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/consumption-rules`, () => page([
      rule(1), rule(2, { effective_to: isoAgo(1), supersedes_rule_id: undefined }), rule(3, { is_active: false }),
    ])));
    await mount({ history: '1' });
    const grid = await screen.findByRole('grid');
    for (const w of [/current/i, /superseded/i, /inactive/i]) {
      const badge = within(grid).getByText(w);
      const host = (badge.closest('[data-tone]') ?? badge.closest('[class*="badge"]') ?? badge.parentElement) as HTMLElement;
      expect(host.getAttribute('data-tone') ?? host.className, `${w} has a tone`).toBeTruthy();
      expect(host.querySelector('svg, [data-icon], [aria-hidden="true"]'), `${w} has an icon`).toBeTruthy();
    }
  });
  it('empty state: "No consumption rules. Automatic deduction does nothing until you add rules."', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/consumption-rules`, () => page([])));
    await mount();
    expect(await screen.findByText('No consumption rules. Automatic deduction does nothing until you add rules.')).toBeTruthy();
  });
  it('API failure shows an ErrorState/alert with the request id, not a blank page', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/consumption-rules`, () => problem('common.internal', 500)));
    await mount();
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0024');
  });
  it('the S13 page links to the consumption-model help (inventory.help.consumption_model)', async () => {
    await mount();
    await screen.findByRole('grid');
    expect(screen.getAllByRole('link').some((a) => /help|consumption model|how .*deduct/i.test(a.textContent ?? '') || /help/.test(a.getAttribute('href') ?? ''))).toBe(true);
  });
});

describe('S13 create form: kind guidance copy (04-UI-UX §3 S13) — verbatim', () => {
  const guidance: [RegExp, string][] = [
    [/per test/i, 'Deducted once for each test on an order when its first result is verified.'],
    [/per analyte result/i, 'Deducted once for each verified result of this analyte.'],
    [/per rerun/i, 'Deducted when the analyser reports a rerun. Not every analyser reports reruns.'],
    [/per qc observation/i, 'Deducted for each QC result received from the analyser. If you leave the analyte empty, this is deducted once for every analyte in every QC run.'],
    [/per calibration/i, 'Deducted when someone logs a calibration on the Bench page, or when the analyser reports a calibration (supported analysers only).'],
    [/per analyser-day/i, 'Deducted once per day for each day the analyser sent any results.'],
  ];
  it('Kind is a RadioGroup with the six kinds in spec order', async () => {
    const dlg = await openNew();
    const names = within(dlg).getAllByRole('radio').map((r) => (r as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? r.getAttribute('aria-label'));
    expect(names).toEqual(['Per test', 'Per analyte result', 'Per rerun', 'Per QC observation', 'Per calibration', 'Per analyser-day']);
  });
  it.each(guidance)('choosing %s shows ONLY its guidance text in an info Banner', async (radio, text) => {
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, radio));
    expect(within(dlg).getByText(text)).toBeTruthy();
    for (const [, other] of guidance) if (other !== text) expect(within(dlg).queryByText(other), other).toBeNull();
  });
  it('guidance changes when the kind changes', async () => {
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, /per rerun/i));
    await userEvent.click(kindRadio(dlg, /per calibration/i));
    expect(within(dlg).queryByText(guidance[2]![1])).toBeNull();
    expect(within(dlg).getByText(guidance[4]![1])).toBeTruthy();
  });
});

describe('S13 create form: conditional fields and validation', () => {
  it('Per analyser-day: Analyser is required and Test is not asked for', async () => {
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, /per analyser-day/i));
    expect(within(dlg).queryByRole('combobox', { name: /^test/i }) ?? within(dlg).queryByRole('button', { name: /^test/i })).toBeNull();
    await pick(dlg, /^item/i, /GLU-R1/, 'GLU');
    await userEvent.type(within(dlg).getByRole('textbox', { name: /^quantity/i }), '1');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    expect(creates()).toHaveLength(0); // analyser missing
  });
  it('Per analyte result: Analyte is required (nothing sent without it); options come from the chosen test', async () => {
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, /per analyte result/i));
    await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
    await pick(dlg, /^item/i, /GLU-R1/, 'GLU');
    await userEvent.type(within(dlg).getByRole('textbox', { name: /^quantity/i }), '1');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    expect(creates()).toHaveLength(0);
    await userEvent.click(within(dlg).getByRole('button', { name: /^analyte/i }));
    expect(await screen.findByRole('option', { name: /fasting glucose|GLU_F/i })).toBeTruthy();
    expect(hit('GET', new RegExp(`/v1/catalog/tests/${ID(70)}/analytes$`)).length).toBeGreaterThan(0);
  });
  it('Per QC observation: Analyte is optional and its empty option reads "Every QC result on this analyser"; the AC-14.2 warning is the kind guidance', async () => {
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, /per qc observation/i));
    await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
    await userEvent.click(within(dlg).getByRole('button', { name: /^analyte/i }));
    expect(await screen.findByRole('option', { name: 'Every QC result on this analyser' })).toBeTruthy();
  });
  it('Quantity must be a decimal > 0: "0", "-1", "abc" send nothing; Notes is capped at 500', async () => {
    const dlg = await openNew();
    expect(within(dlg).getByRole('textbox', { name: /^notes/i }).getAttribute('maxlength')).toBe('500');
    await userEvent.click(kindRadio(dlg, /per test/i));
    await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
    await pick(dlg, /^item/i, /GLU-R1/, 'GLU');
    const q = within(dlg).getByRole('textbox', { name: /^quantity/i });
    for (const bad of ['0', '-1', 'abc', '']) {
      await userEvent.clear(q);
      if (bad) await userEvent.type(q, bad);
      await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    }
    expect(creates()).toHaveLength(0);
  });
  it('Unit Select offers the base unit and the item\'s packs (pack_id sent only for a pack)', async () => {
    const dlg = await openNew();
    await pick(dlg, /^item/i, /GLU-R1/, 'GLU');
    await userEvent.click(within(dlg).getByRole('button', { name: /^unit/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(opts.some((o) => /test/i.test(o))).toBe(true);
    expect(opts.some((o) => /BOX/.test(o))).toBe(true);
  });
  it('"Any analyser" checkbox clears and disables the Analyser picker; the request then carries no instrument_id', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules`, () => HttpResponse.json(rule(9), { status: 201 })));
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, /per test/i));
    await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: /any analyser/i }));
    await pick(dlg, /^item/i, /GLU-R1/, 'GLU');
    await userEvent.type(within(dlg).getByRole('textbox', { name: /^quantity/i }), '1');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]!.json).not.toHaveProperty('instrument_id');
  });
});

describe('S13 create (TRD #70)', () => {
  it('POST /consumption-rules {rule_kind, test_id, instrument_id, item_id, qty} + Idempotency-Key; list refreshes; Drawer closes', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules`, () => HttpResponse.json(rule(9), { status: 201 })));
    const dlg = await openNew();
    await fillPerTest(dlg);
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]!.json).toMatchObject({ rule_kind: 'per_test', test_id: ID(70), instrument_id: ID(950), item_id: ID(11), qty: '2' });
    expect(creates()[0]!.json).not.toHaveProperty('pack_id'); // base unit chosen
    expect(creates()[0]!.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(creates()[0]!.headers.get('authorization')).toBeNull(); // the browser never sends a token; the BFF adds it
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /new consumption rule/i })).toBeNull());
  });
  it('a pack unit sends pack_id and the entered qty', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules`, () => HttpResponse.json(rule(9), { status: 201 })));
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, /per test/i));
    await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
    await pick(dlg, /^item/i, /GLU-R1/, 'GLU');
    await userEvent.type(within(dlg).getByRole('textbox', { name: /^quantity/i }), '1');
    await pick(dlg, /^unit/i, /BOX/);
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]!.json).toMatchObject({ qty: '1', pack_id: ID(101) });
  });
  it('inventory.rule_conflict -> Banner with the request id and a pointer to "Change quantity"; the form stays open with its values', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules`, () => problem('inventory.rule_conflict', 409)));
    const dlg = await openNew();
    await fillPerTest(dlg);
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    const alert = await within(dlg).findByRole('alert');
    expect(alert.textContent).toContain('req-syn-0024');
    expect(alert.textContent).toMatch(/already|change quantity|current rule/i);
    expect((within(dlg).getByRole('textbox', { name: /^quantity/i }) as HTMLInputElement).value).toBe('2');
  });
  it('inventory.uom_mismatch and common.validation_failed show an alert and keep the form open', async () => {
    for (const code of ['inventory.uom_mismatch', 'common.validation_failed']) {
      api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules`, () => problem(code, 400)));
      const dlg = await openNew();
      await fillPerTest(dlg);
      await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
      expect((await within(dlg).findByRole('alert')).textContent, code).toContain('req-syn-0024');
      cleanup(); api.resetHandlers(); resetHits();
    }
  });
  it('double-clicking Save sends one request (same Idempotency-Key semantics, no duplicate rule)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules`, async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(rule(9), { status: 201 }); }));
    const dlg = await openNew();
    await fillPerTest(dlg);
    const btn = within(dlg).getByRole('button', { name: /^save/i });
    await userEvent.dblClick(btn);
    await waitFor(() => expect(creates().length).toBeGreaterThan(0));
    expect(creates()).toHaveLength(1);
  });
});

describe('S13 preview (TRD #74; AC-12.1, AC-12.6, AC-12.7)', () => {
  const previewBody = (over: Record<string, unknown> = {}) => ({ store_id: ID(301), store_resolution_step: 1, lines: [{ rule_id: ID(801), item_id: ID(11), qty_base: '1', lot_id: ID(21) }], ...over });
  const runPreview = async (dlg: HTMLElement) => {
    await userEvent.click(within(dlg).getByRole('button', { name: /^preview$/i }));
    return (await screen.findByRole('dialog', { name: /preview/i })) as HTMLElement;
  };
  it('AC-12.1: Preview posts the dry-run request {fact_kind:"test", test_id, instrument_id} and shows the deduction lines (item, qty, store) in a Drawer; nothing is written', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules/preview`, () => HttpResponse.json(previewBody())));
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, /per test/i));
    await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
    await pick(dlg, /^analyser/i, /BIO-1|analyser 1/i, 'BIO');
    const out = await runPreview(dlg);
    await waitFor(() => expect(previews()).toHaveLength(1));
    expect(previews()[0]!.json).toMatchObject({ fact_kind: 'test', test_id: ID(70), instrument_id: ID(950) });
    expect(out.textContent).toMatch(/GLU-R1|glucose reagent/i);
    expect(out.textContent).toMatch(/\b1\b/);
    expect(out.textContent).toMatch(/store 1|BR1-ST1/i);
    expect(creates()).toHaveLength(0);
    expect(hits.filter((h) => h.method === 'POST' && !/preview$/.test(h.path))).toHaveLength(0);
  });
  it.each([
    [/per test/i, 'test'], [/per analyte result/i, 'analyte'], [/per rerun/i, 'rerun'], [/per qc observation/i, 'qc'], [/per calibration/i, 'calibration'], [/per analyser-day/i, 'fixed'],
  ])('kind %s previews as fact_kind "%s"', async (radio, factKind) => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules/preview`, () => HttpResponse.json(previewBody())));
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, radio));
    if (factKind !== 'fixed') await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
    if (factKind === 'analyte') { await userEvent.click(within(dlg).getByRole('button', { name: /^analyte/i })); await userEvent.click(await screen.findByRole('option', { name: /fasting glucose|GLU_F/i })); }
    if (factKind === 'fixed') await pick(dlg, /^analyser/i, /BIO-1|analyser 1/i, 'BIO');
    await runPreview(dlg);
    await waitFor(() => expect(previews()).toHaveLength(1));
    expect(previews()[0]!.json.fact_kind).toBe(factKind);
  });
  it('AC-12.6: with a generic and an instrument-specific rule the preview lists what the API says applies (one line), never both', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules/preview`, () => HttpResponse.json(previewBody({ lines: [{ rule_id: ID(802), item_id: ID(11), qty_base: '2' }] }))));
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, /per test/i));
    await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
    const out = await runPreview(dlg);
    expect(within(out).getAllByRole('row').filter((r) => /GLU-R1|glucose reagent/i.test(r.textContent ?? ''))).toHaveLength(1);
  });
  it('AC-12.7: no matching rule -> an explicit "No consumption rule matches" outcome (not an empty drawer)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules/preview`, () => HttpResponse.json({ store_resolution_step: 6, lines: [] })));
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, /per test/i));
    await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
    const out = await runPreview(dlg);
    expect(out.textContent).toMatch(/no consumption rule matches/i);
  });
  it('AC-12.9: no store resolved (step 6) -> the preview says the deduction would wait in "Waiting consumption"', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules/preview`, () => HttpResponse.json({ store_resolution_step: 6, lines: [{ rule_id: ID(801), item_id: ID(11), qty_base: '1' }] })));
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, /per test/i));
    await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
    const out = await runPreview(dlg);
    expect(out.textContent).toMatch(/waiting consumption|no store/i);
  });
  it('cost: the estimated value column only appears when the API sent est_value_paisa (needs inventory.cost.read); lakh format', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules/preview`, () => HttpResponse.json(previewBody({ lines: [{ rule_id: ID(801), item_id: ID(11), qty_base: '1', est_value_paisa: 12345600 }] }))));
    state.permissions = [...PERM_MANAGE, 'inventory.cost.read'];
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, /per test/i));
    await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
    const out = await runPreview(dlg);
    expect(out.textContent).toMatch(/1,23,456/);
  });
  it('preview failure shows an alert with the request id and does not close the form', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules/preview`, () => problem('common.validation_failed', 400)));
    const dlg = await openNew();
    await userEvent.click(kindRadio(dlg, /per test/i));
    await pick(dlg, /^test/i, /glucose|GLU/i, 'Glu');
    await userEvent.click(within(dlg).getByRole('button', { name: /^preview$/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0024');
    expect(screen.getByRole('dialog', { name: /new consumption rule/i })).toBeTruthy();
  });
});

describe('S13 change quantity / deactivate (TRD #72, #73)', () => {
  const row = async (text: RegExp) => ((await screen.findByRole('grid')) && (await within(await screen.findByRole('grid')).findByText(text)).closest('tr')) as HTMLElement;
  it('"Change quantity" opens a dialog with the supersede copy; submit POSTs /supersede {qty} with Idempotency-Key', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules/:id/supersede`, () => HttpResponse.json(rule(8, { qty_base: '3', entered_qty: '3' }), { status: 201 })));
    await mount();
    await userEvent.click(within(await row(/per test/i)).getByRole('button', { name: /change quantity/i }));
    const dlg = await screen.findByRole('dialog', { name: /change quantity/i });
    expect(within(dlg).getByText('The old rule stops now. Earlier deductions are not changed.')).toBeTruthy();
    const q = within(dlg).getByRole('textbox', { name: /^quantity/i });
    await userEvent.clear(q); await userEvent.type(q, '3');
    await userEvent.click(within(dlg).getByRole('button', { name: /^(save|change|confirm)/i }));
    const sup = await waitFor(() => { const h = hit('POST', new RegExp(`^/v1/inventory/consumption-rules/${ID(801)}/supersede$`)); expect(h).toHaveLength(1); return h[0]!; });
    expect(sup.json).toMatchObject({ qty: '3' });
    expect(sup.headers.get('idempotency-key')).toMatch(IDEM_RE);
  });
  it('Change quantity with 0 sends nothing', async () => {
    await mount();
    await userEvent.click(within(await row(/per test/i)).getByRole('button', { name: /change quantity/i }));
    const dlg = await screen.findByRole('dialog', { name: /change quantity/i });
    const q = within(dlg).getByRole('textbox', { name: /^quantity/i });
    await userEvent.clear(q); await userEvent.type(q, '0');
    await userEvent.click(within(dlg).getByRole('button', { name: /^(save|change|confirm)/i }));
    expect(hit('POST', /supersede$/)).toHaveLength(0);
  });
  it('a rule that is no longer current (inventory.document_invalid_transition) -> alert with request id', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules/:id/supersede`, () => problem('inventory.document_invalid_transition', 409)));
    await mount();
    await userEvent.click(within(await row(/per test/i)).getByRole('button', { name: /change quantity/i }));
    const dlg = await screen.findByRole('dialog', { name: /change quantity/i });
    await userEvent.type(within(dlg).getByRole('textbox', { name: /^quantity/i }), '1');
    await userEvent.click(within(dlg).getByRole('button', { name: /^(save|change|confirm)/i }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('req-syn-0024');
  });
  it('Deactivate asks to confirm, then POSTs /deactivate', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-rules/:id/deactivate`, () => HttpResponse.json(rule(1, { is_active: false }))));
    await mount();
    await userEvent.click(within(await row(/per test/i)).getByRole('button', { name: /^deactivate$/i }));
    expect(hit('POST', /deactivate$/)).toHaveLength(0); // not on the first click
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(dlg).getByRole('button', { name: /^deactivate/i }));
    await waitFor(() => expect(hit('POST', new RegExp(`^/v1/inventory/consumption-rules/${ID(801)}/deactivate$`))).toHaveLength(1));
  });
  it('superseded and inactive rows have no Change quantity / Deactivate', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/consumption-rules`, () => page([rule(1, { effective_to: isoAgo(1) }), rule(3, { is_active: false, rule_kind: 'per_rerun' })])));
    await mount({ history: '1' });
    const grid = await screen.findByRole('grid');
    expect(within(grid).queryByRole('button', { name: /change quantity/i })).toBeNull();
    expect(within(grid).queryByRole('button', { name: /^deactivate$/i })).toBeNull();
  });
});
