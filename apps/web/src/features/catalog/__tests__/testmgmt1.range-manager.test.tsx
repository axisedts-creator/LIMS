// @vitest-environment jsdom
// T0D-TESTMGMT-1 item (5) — Reference range manager: grid, inline row editor, server validation messages, Draft / Published badge, publish button gate,
// live report preview. Route (no new route): /catalog/tests/{id}?tab=ranges&analyte=<analyte id>. Contract (catalog.yaml RangeBand, CriticalBand, RangeSet):
//   grid     : role=grid named /reference range/i; column headers IN THIS ORDER (a trailing status column from the kit is allowed): Range Name, Age From,
//              Age To, Age Unit, Sex, Laboratory, Instrument, Default, Normal Low, Normal High, Critical Low, Critical High, Auto Approved Low,
//              Auto Approved High, Display Text, Method. Drawn also when the analyte has no range set. Range Name is a derived label (LD: a LIMS band
//              has no stored name); it is read-only. Age From / Age To are numbers, Age Unit is hour|day|week|month|year, Sex any|male|female|third_gender.
//   edit     : kit interaction: Enter on a cell opens an input labelled "<column>, row <n>"; Enter commits. Draft sets only, catalog.test.manage.
//   save     : PUT /reference-range-sets/{id}/bands (If-Match = set version, decimals stay strings, sort_order = row order); Critical Low / High go to the
//              draft critical set of the analyte with PUT /critical-limit-sets/{id}/bands (no sort_order) when any is set.
//   badge    : text "Draft" or "Published" for the shown set. Publish button: only with catalog.reference_range.publish (absent otherwise).
//   preview  : region "Report preview" with the columns Test Name, Value, Unit, Reference Range; the reference range text follows Normal Low / High.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { A_HB, api, callsTo, ID, loadTests, MANAGE, PUBLISH, READ, reset, S, show, TM, testDetail } from './testmgmt1.harness';

const HB = testDetail(1, 'HB', 'Hemoglobin', { analytes: [A_HB] });
const COLS = ['Range Name', 'Age From', 'Age To', 'Age Unit', 'Sex', 'Laboratory', 'Instrument', 'Default', 'Normal Low', 'Normal High', 'Critical Low', 'Critical High', 'Auto Approved Low', 'Auto Approved High', 'Display Text', 'Method'];
const band = (o: Record<string, unknown> = {}) => ({ sex: 'male', age_low: { value: 18, unit: 'year' }, age_high: { value: 150, unit: 'year' }, kind: 'numeric', low: '13.0', high: '17.0', default_range: true, sort_order: 0, ...o });
const set = (o: Record<string, unknown> = {}) => ({ id: ID(300), analyte_id: A_HB.id, version_no: 2, status: 'draft', version: 4, bands: [band(), band({ sex: 'female', low: '12.0', high: '15.5', default_range: false, sort_order: 1 })], ...o });
const crit = (o: Record<string, unknown> = {}) => ({ id: ID(310), analyte_id: A_HB.id, version_no: 1, status: 'draft', version: 2, bands: [{ sex: 'male', age_low: { value: 18, unit: 'year' }, age_high: { value: 150, unit: 'year' }, low: '7.0', high: '20.0' }], ...o });

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => { reset(); loadTests(HB); S.rangeSets[A_HB.id] = [set()]; S.criticalSets[A_HB.id] = [crit()]; });
afterEach(() => { cleanup(); api.resetHandlers(); });

const open = async () => { await show('test', { params: { test_id: String(HB['id']) }, search: `tab=ranges&analyte=${A_HB.id}` }); return screen.findByRole('grid', { name: /reference range/i }); };
const heads = (g: HTMLElement) => within(g).getAllByRole('columnheader').map((h) => h.textContent?.trim());
const dataRows = (g: HTMLElement) => within(g).getAllByRole('row').slice(1);
const cellOf = (g: HTMLElement, row: number, col: string) => within(dataRows(g)[row]!).getAllByRole('gridcell')[COLS.indexOf(col)]!;
async function edit(g: HTMLElement, row: number, col: string, value: string) {
  const c = cellOf(g, row, col);
  await userEvent.click(c);
  await userEvent.keyboard('{Enter}');
  const inp = await within(g).findByLabelText(new RegExp(`^${col}, row ${row + 1}$`, 'i'));
  await userEvent.clear(inp);
  if (value) await userEvent.type(inp, value);
  await userEvent.keyboard('{Enter}');
}
const save = () => userEvent.click(screen.getByRole('button', { name: /^save/i }));
const puts = () => callsTo('PUT', /reference-range-sets\/[^/]+\/bands$/);

describe('grid and columns (item 5)', () => {
  it('draws the 16 columns in order, also when the analyte has no range set at all', async () => {
    S.rangeSets[A_HB.id] = []; S.criticalSets[A_HB.id] = [];
    const g = await open();
    expect(heads(g).filter(Boolean).slice(0, 16)).toEqual(COLS);
    expect(screen.getByText(/no reference ranges/i)).toBeTruthy();
  });
  it('shows the bands of the draft set under the same columns', async () => {
    const g = await open();
    expect(heads(g).slice(0, 16)).toEqual(COLS);
    expect(dataRows(g)).toHaveLength(2);
    expect(cellOf(g, 0, 'Age From').textContent).toMatch(/^18$/);
    expect(cellOf(g, 0, 'Age To').textContent).toMatch(/^150$/);
    expect(cellOf(g, 0, 'Age Unit').textContent).toMatch(/year/i);
    expect(cellOf(g, 0, 'Sex').textContent).toMatch(/male/i);
    expect(cellOf(g, 0, 'Normal Low').textContent).toBe('13.0');
    expect(cellOf(g, 0, 'Normal High').textContent).toBe('17.0');
    expect(cellOf(g, 0, 'Critical Low').textContent).toBe('7.0'); // matched from the critical set by sex + age
    expect(cellOf(g, 0, 'Critical High').textContent).toBe('20.0');
    expect(cellOf(g, 1, 'Critical Low').textContent).toBe('');
  });
  it('passes axe', async () => {
    await open();
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('Draft or Published badge and the publish button (item 5, 8)', () => {
  it('a draft set is labelled Draft; a published set Published (text, not colour only)', async () => {
    await open();
    expect(screen.getAllByText(/^draft$/i).length).toBeGreaterThan(0);
    cleanup();
    S.rangeSets[A_HB.id] = [set({ status: 'published', version: 5 })];
    await open();
    expect(screen.getAllByText(/^published$/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^draft$/i)).toBeNull();
  });
  it.each([
    ['catalog.reference_range.publish + manage', PUBLISH, true],
    ['manage only', MANAGE, false],
    ['read only', READ, false],
    ['publish only (no manage)', ['catalog.test.read', 'catalog.reference_range.publish'], false],
  ])('Publish button with %s -> present: %s', async (_n, perms, present) => {
    TM.session.permissions = perms as string[];
    await open();
    expect(!!screen.queryByRole('button', { name: /^publish/i })).toBe(present);
  });
  it('no Publish button on a published set (nothing to publish)', async () => {
    S.rangeSets[A_HB.id] = [set({ status: 'published' })];
    TM.session.permissions = PUBLISH;
    await open();
    expect(screen.queryByRole('button', { name: /^publish/i })).toBeNull();
  });
  it('a reader gets no Save, Add or Remove row buttons and the cells are not editable', async () => {
    TM.session.permissions = READ;
    const g = await open();
    for (const n of [/^save/i, /add (band|row|range)/i, /remove/i]) expect(screen.queryByRole('button', { name: n }), String(n)).toBeNull();
    await userEvent.click(cellOf(g, 0, 'Normal High'));
    await userEvent.keyboard('{Enter}');
    expect(within(g).queryByLabelText(/^normal high, row 1$/i)).toBeNull();
  });
});

describe('inline row editor and save (item 5)', () => {
  it('editing Normal High and saving sends the whole set: decimals as strings, sort_order by row, If-Match = set version', async () => {
    const g = await open();
    await edit(g, 0, 'Normal High', '18.5');
    await edit(g, 0, 'Auto Approved Low', '9.0');
    await edit(g, 0, 'Display Text', 'Adult male');
    await save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    const c = puts()[0]!;
    expect(c.path).toBe(`/v1/catalog/reference-range-sets/${ID(300)}/bands`);
    expect(c.headers.get('if-match')).toBe('"4"');
    expect(c.body.bands[0]).toMatchObject({ sex: 'male', low: '13.0', high: '18.5', auto_approved_low: '9.0', display_text: 'Adult male', default_range: true, age_low: { value: 18, unit: 'year' }, sort_order: 0 });
    expect(c.body.bands[1]).toMatchObject({ sex: 'female', default_range: false, sort_order: 1 });
  });
  it('editing Critical Low goes to the critical set (no sort_order), not to the reference set', async () => {
    const g = await open();
    await edit(g, 0, 'Critical Low', '6.5');
    await save();
    await waitFor(() => expect(callsTo('PUT', /critical-limit-sets\/[^/]+\/bands$/)).toHaveLength(1));
    const c = callsTo('PUT', /critical-limit-sets\/[^/]+\/bands$/)[0]!;
    expect(c.path).toBe(`/v1/catalog/critical-limit-sets/${ID(310)}/bands`);
    expect(c.body.bands[0]).toMatchObject({ sex: 'male', low: '6.5', high: '20.0' });
    for (const b of c.body.bands) expect(Object.keys(b)).not.toContain('sort_order');
    for (const b of puts()[0]?.body.bands ?? []) { expect(b).not.toHaveProperty('critical_low'); }
  });
  it.each([['third_gender'], ['any'], ['female']])('Sex accepts %s', async (v) => {
    const g = await open();
    await edit(g, 0, 'Sex', v);
    expect(within(g).queryAllByText(/sex must be/i)).toHaveLength(0);
    expect(cellOf(g, 0, 'Sex').textContent).toMatch(new RegExp(v.replace('_', '.?'), 'i'));
  });
  it.each([['hour'], ['day'], ['week'], ['month'], ['year']])('Age Unit accepts %s', async (v) => {
    const g = await open();
    await edit(g, 0, 'Age Unit', v);
    expect(cellOf(g, 0, 'Age Unit').textContent).toMatch(new RegExp(v, 'i'));
  });
  it('Sex "robot" and Age Unit "decade" are refused in the cell with a message', async () => {
    const g = await open();
    await edit(g, 0, 'Sex', 'robot');
    expect(await screen.findByText(/sex must be/i)).toBeTruthy();
    await edit(g, 0, 'Age Unit', 'decade');
    expect(await screen.findByText(/hour.*day.*week.*month.*year|age unit/i)).toBeTruthy();
  });
  it('Metro style whole life band: Age From 0, Age To 150 year, Sex any is a valid single row', async () => {
    S.rangeSets[A_HB.id] = [set({ bands: [band({ sex: 'any', age_low: { value: 0, unit: 'year' }, age_high: { value: 150, unit: 'year' }, low: '4.0', high: '11.0' })] })];
    const g = await open();
    await save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body.bands[0]).toMatchObject({ sex: 'any', age_low: { value: 0, unit: 'year' }, age_high: { value: 150, unit: 'year' } });
    expect(within(g).queryAllByText(/must|overlap/i)).toHaveLength(0);
  });
});

describe('validation messages: client rules show in the row, no request (item 5)', () => {
  it.each([
    ['Age To not after Age From', async (g: HTMLElement) => edit(g, 0, 'Age To', '10'), /age to.*(greater|after)/i],
    ['Normal Low above Normal High', async (g: HTMLElement) => edit(g, 0, 'Normal Low', '20.0'), /low.*(exceed|greater|above)/i],
    ['Critical limit inside the normal range', async (g: HTMLElement) => edit(g, 0, 'Critical Low', '14.0'), /critical.*(below|outside|inside|within)/i],
    ['Auto Approved Low above Auto Approved High', async (g: HTMLElement) => { await edit(g, 0, 'Auto Approved Low', '12.0'); await edit(g, 0, 'Auto Approved High', '9.0'); }, /auto approved.*(exceed|greater|above)|low.*high/i],
    ['a number that is not a decimal', async (g: HTMLElement) => edit(g, 0, 'Normal Low', '13,0'), /decimal/i],
  ])('%s', async (_n, act, msg) => {
    const g = await open();
    await act(g);
    await save();
    expect(await screen.findByText(msg)).toBeTruthy();
    expect(puts()).toHaveLength(0);
    expect(callsTo('PUT', /critical-limit-sets/)).toHaveLength(0);
  });
  it('two bands of the same sex that overlap are refused (both rows marked)', async () => {
    S.rangeSets[A_HB.id] = [set({ bands: [band(), band({ age_low: { value: 60, unit: 'year' }, sort_order: 1 })] })];
    const g = await open();
    await save();
    expect(await screen.findAllByText(/overlap/i)).toHaveLength(2);
    expect(puts()).toHaveLength(0);
    expect(dataRows(g).filter((r) => r.getAttribute('aria-invalid') === 'true' || r.getAttribute('data-status') === 'error' || r.querySelector('[aria-invalid="true"]')).length).toBeGreaterThanOrEqual(2);
  });
  it('overlap check is per sex, laboratory and instrument: male and female with the same ages are fine', async () => {
    await open();
    await save();
    await waitFor(() => expect(puts()).toHaveLength(1));
  });
});

describe('server validation messages land on the right row and cell (item 5)', () => {
  it('PUT 400 with /bands/1/auto_approved_low shows the server text on row 2 and no success toast', async () => {
    S.failNext = { method: 'PUT', re: /reference-range-sets\/[^/]+\/bands$/, status: 400, code: 'common.validation_failed', errors: [{ path: '/bands/1/auto_approved_low', code: 'catalog.band_invalid', message: 'Auto approved low must not be below critical low' }, { path: '/bands/0', code: 'catalog.band_overlap', message: 'Overlaps band 2' }] };
    const g = await open();
    await save();
    expect(await screen.findByText('Auto approved low must not be below critical low')).toBeTruthy();
    expect(screen.getByText('Overlaps band 2')).toBeTruthy();
    expect(within(dataRows(g)[1]!).queryByText(/must not be below critical low/)).toBeTruthy();
    expect(screen.queryByText(/saved/i)).toBeNull();
  });
});

describe('removing every band (review item 3)', () => {
  it('Remove last band down to zero rows, then Save: inline error, no request, no success toast', async () => {
    await open();
    const remove = screen.getByRole('button', { name: /^remove last band$/i });
    await userEvent.click(remove);
    await userEvent.click(remove);
    await save();
    expect(await screen.findByText(/at least one band/i)).toBeTruthy();
    expect(puts()).toHaveLength(0);
    expect(callsTo('PUT', /critical-limit-sets/)).toHaveLength(0);
    expect(screen.queryByText(/ranges saved/i)).toBeNull();
  });
});

describe('live report preview (item 5)', () => {
  it('shows Test Name, Value, Unit, Reference Range and follows the edited Normal High', async () => {
    const g = await open();
    const prev = screen.getByRole('region', { name: /report preview/i });
    expect(within(prev).getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual(['Test Name', 'Value', 'Unit', 'Reference Range']);
    expect(prev.textContent).toMatch(/Haemoglobin/);
    expect(prev.textContent).toMatch(/13\.0\s*[-–]\s*17\.0/);
    await edit(g, 0, 'Normal High', '18.5');
    await waitFor(() => expect(prev.textContent).toMatch(/13\.0\s*[-–]\s*18\.5/));
  });
});
void READ;
