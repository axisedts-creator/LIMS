// @vitest-environment jsdom
// T0D-TESTMGMT-1 done_when (5): reference range manager on the EXISTING route /catalog/tests/<id>?tab=ranges&analyte=<analyte_id>.
// Grid columns (visible even when empty): Range Name, Age From, Age To, Age Unit, Sex, Laboratory, Instrument, Default, Normal Low, Normal High,
// Critical Low, Critical High, Auto Approved Low, Auto Approved High, Display Text, Method. Inline row editor shows every server validation message.
// Draft / Published badge; the Publish button only for catalog.reference_range.publish and only on a draft.
// Writes: PUT /v1/catalog/reference-range-sets/{id}/bands (If-Match) and, for Critical Low/High, PUT /v1/catalog/critical-limit-sets/{id}/bands.
// API GAP (notes): RangeBand has no "range name"; Range Name is a derived label (sex + age span) shown read-only and never sent.
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BAND_F, BAND_M, HB, MANAGE, PUBLISH, READ, T_CBC, mountTest, overrides, problem, rangeSet, setSets, tm, to } from './testmgmt1.kit';

const COLS = ['Range Name', 'Age From', 'Age To', 'Age Unit', 'Sex', 'Laboratory', 'Instrument', 'Default', 'Normal Low', 'Normal High', 'Critical Low', 'Critical High', 'Auto Approved Low', 'Auto Approved High', 'Display Text', 'Method'];
const open = async () => { await mountTest(T_CBC.id, `?tab=ranges&analyte=${HB.id}`); return screen.findByRole('grid', { name: /reference range/i }); };
const draft = (bands: unknown[] = [BAND_M, BAND_F]) => rangeSet('draft', bands);

describe('Range manager: grid', () => {
  it('draws all 16 column headers when there is no range yet', async () => {
    setSets([]);
    const g = await open();
    expect(within(g).getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual(expect.arrayContaining(COLS));
    expect(within(g).getByText(/no ranges/i)).toBeTruthy();
  });

  it('shows the bands of the set with their values in the right columns', async () => {
    setSets([draft()]);
    const g = await open();
    const row = within(g).getAllByRole('row')[1]!;
    const cell = (col: string) => within(row).getAllByRole('gridcell')[COLS.indexOf(col)]!.textContent;
    expect(cell('Sex')).toMatch(/male/i);
    expect(cell('Age From')).toBe('18');
    expect(cell('Age Unit')).toMatch(/year/i);
    expect(cell('Normal Low')).toBe('13.0');
    expect(cell('Normal High')).toBe('17.0');
    expect(cell('Auto Approved Low')).toBe('12.0');
    expect(cell('Display Text')).toBe('Adult male');
    expect(cell('Default')).toMatch(/yes|✓|true/i);
  });

  it('age units offered are hour, day, week, month, year', async () => {
    setSets([draft()]);
    const g = await open();
    await userEvent.click(within(g).getAllByRole('row')[1]!);
    const unit = screen.getByLabelText(/age unit/i);
    expect(within(unit).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(expect.arrayContaining(['hour', 'day', 'week', 'month', 'year']));
    expect(within(screen.getByLabelText(/^sex/i)).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(expect.arrayContaining(['any', 'male', 'female', 'third_gender']));
  });
});

describe('Range manager: draft / published badge and Publish', () => {
  it('a draft set shows a Draft badge, a published set a Published badge', async () => {
    setSets([draft()]);
    await open();
    expect(screen.getByText(/^draft$/i)).toBeTruthy();
  });

  it('published set: Published badge, no Publish button, bands not editable until a new draft is started', async () => {
    setSets([rangeSet('published', [BAND_M])]);
    tm().permissions = PUBLISH;
    await open();
    expect(screen.getByText(/^published$/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^publish/i })).toBeNull();
    expect(screen.getByRole('button', { name: /new draft|edit as new draft/i })).toBeTruthy();
  });

  it('Publish is shown on a draft ONLY with catalog.reference_range.publish', async () => {
    setSets([draft()]);
    tm().permissions = PUBLISH;
    await open();
    expect(screen.getByRole('button', { name: /^publish/i })).toBeTruthy();
  });

  it.each([['catalog.test.read only', READ], ['catalog.test.manage without publish', MANAGE]])('%s: no Publish button at all (not just disabled)', async (_n, perms) => {
    setSets([draft()]);
    tm().permissions = perms;
    await open();
    expect(screen.getByText(/^draft$/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull();
  });

  it('Publish asks for a change reason and posts If-Match + Idempotency-Key', async () => {
    setSets([draft()]);
    tm().permissions = PUBLISH;
    await open();
    await userEvent.click(screen.getByRole('button', { name: /^publish/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText(/change reason|reason/i), 'Synthetic review');
    await userEvent.click(within(dlg).getByRole('button', { name: /^publish/i }));
    await waitFor(() => expect(to('POST', /\/reference-range-sets\/.*\/publish$/)).toHaveLength(1));
    const c = to('POST', /publish$/)[0]!;
    expect(c.body.change_reason).toBe('Synthetic review');
    expect(c.headers.get('if-match')).toBeTruthy();
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
  });
});

describe('Range manager: inline row editor', () => {
  it('Add range opens an inline editor with every column as a field; Save PUTs all bands with If-Match', async () => {
    setSets([draft([BAND_M])]);
    const g = await open();
    await userEvent.click(screen.getByRole('button', { name: /add range/i }));
    for (const l of [/age from/i, /age to/i, /age unit/i, /^sex/i, /laboratory/i, /instrument/i, /default/i, /normal low/i, /normal high/i, /critical low/i, /critical high/i, /auto approved low/i, /auto approved high/i, /display text/i, /method/i]) {
      expect(screen.getAllByLabelText(l).length).toBeGreaterThan(0);
    }
    await userEvent.selectOptions(screen.getByLabelText(/^sex/i), 'female');
    await userEvent.type(screen.getByLabelText(/age from/i), '18');
    await userEvent.type(screen.getByLabelText(/age to/i), '60');
    await userEvent.type(screen.getByLabelText(/normal low/i), '12.0');
    await userEvent.type(screen.getByLabelText(/normal high/i), '15.5');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(to('PUT', /reference-range-sets\/.*\/bands$/)).toHaveLength(1));
    const c = to('PUT', /bands$/)[0]!;
    expect(c.headers.get('if-match')).toBeTruthy();
    expect(c.body.bands).toHaveLength(2);
    expect(c.body.bands[1]).toMatchObject({ sex: 'female', age_low: { value: 18, unit: 'year' }, age_high: { value: 60, unit: 'year' }, low: '12.0', high: '15.5', kind: 'numeric' });
    expect(g).toBeTruthy();
  });

  it.each([
    ['/bands/0/low', 'Normal Low must be below Normal High.'],
    ['/bands/0/age_high', 'Age To must be greater than Age From.'],
    ['/bands/0/auto_approved_low', 'Auto approved range must lie inside the normal range.'],
    ['/bands/0/default_range', 'Only one default range per sex, instrument and laboratory.'],
  ])('shows the server message for %s next to the row, not just a banner', async (pointer, message) => {
    setSets([draft([BAND_M])]);
    overrides.set('PUT /bands$', () => problem(400, 'common.validation_failed', { errors: [{ pointer, code: 'invalid', message }] }));
    await open();
    await userEvent.click(within(screen.getByRole('grid', { name: /reference range/i })).getAllByRole('row')[1]!);
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    const msg = await screen.findByText(message);
    expect(msg.closest('[role="row"], [role="gridcell"], form')).not.toBeNull();
  });

  it('a 422 overlap or critical-inside-normal message from the server is listed in full', async () => {
    setSets([draft([BAND_M, BAND_F])]);
    overrides.set('PUT /bands$', () => problem(422, 'catalog.range_invalid', { errors: [{ pointer: '/bands/1', code: 'catalog.range_overlap', message: 'Overlaps band 1 for the same sex and laboratory.' }, { pointer: '/bands/1/low', code: 'catalog.critical_inside_normal', message: 'Critical limits must be outside the normal range.' }] }));
    await open();
    await userEvent.click(within(screen.getByRole('grid', { name: /reference range/i })).getAllByRole('row')[2]!);
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/Overlaps band 1/)).toBeTruthy();
    expect(screen.getByText(/outside the normal range/)).toBeTruthy();
  });

  it('Critical Low / High are written to the critical limit set (separate PUT), never into the reference band', async () => {
    setSets([draft([BAND_M])], [rangeSet('draft', [{ sex: 'male' }], { id: '01a1a98a-ac40-7000-8000-0000000f0700' })]);
    await open();
    await userEvent.click(within(screen.getByRole('grid', { name: /reference range/i })).getAllByRole('row')[1]!);
    await userEvent.type(screen.getByLabelText(/critical low/i), '7.0');
    await userEvent.type(screen.getByLabelText(/critical high/i), '20.0');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(to('PUT', /critical-limit-sets\/.*\/bands$/)).toHaveLength(1));
    expect(to('PUT', /critical-limit-sets/)[0]!.body.bands[0]).toMatchObject({ sex: 'male', low: '7.0', high: '20.0' });
    const refBand = to('PUT', /reference-range-sets\/.*\/bands$/)[0]?.body.bands[0] ?? {};
    expect(refBand).not.toHaveProperty('critical_low');
  });

  it('a read-only actor cannot edit: no Add range, rows not editable', async () => {
    setSets([draft()]);
    tm().permissions = READ;
    await open();
    const add = screen.queryByRole('button', { name: /add range/i }) as HTMLButtonElement | null;
    expect(add === null || add.disabled).toBe(true);
  });
});
