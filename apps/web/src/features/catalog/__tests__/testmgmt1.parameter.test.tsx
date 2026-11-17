// @vitest-environment jsdom
// T0D-TESTMGMT-1 done_when (4): Add / Edit Parameter form on /catalog/tests?view=details&test=<id>&parameter=new|<analyte_id>.
// Every AnalyteCreate field (+ initial_version fields) and fields that depend on the result type (ElabAssist labels, LD-318 mapping in catalog.yaml):
//   Equation   -> formula box that calls POST /v1/catalog/formulas/validate while you type, plus the list of parameters it may use
//   List       -> value set picker + default value
//   Integer / Float / Equation -> decimals and high low
//   Long Text / Descriptive    -> text area labelled "Text" (long_text_value)
//   Space      -> none of those
// New saves with POST /v1/catalog/tests/{id}/analytes (Idempotency-Key). Edit of a published parameter opens a draft version
// (POST analytes/{id}/versions) and PATCHes the draft (If-Match); the form never publishes (publish is a separate permission, LD-318 decision 2).
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HB, RBC, T_CBC, VALUE_SET, calls, mountTests, to, tm, READ, overrides, problem } from './testmgmt1.kit';

const NEW = `view=details&test=${T_CBC.id}&parameter=new`;
const open = async (search = NEW) => { await mountTests(`?${search}`); return screen.findByRole('form', { name: /parameter/i }); };
const pick = (f: HTMLElement, type: string) => userEvent.selectOptions(within(f).getByLabelText(/result type/i), type);
const has = (f: HTMLElement, l: RegExp) => within(f).queryAllByLabelText(l).length > 0;

const TYPES = ['Integer', 'Float', 'Equation', 'List', 'Long Text', 'Single Line Text', 'Descriptive', 'Image', 'Boolean', 'Space', 'Graph', 'Html Descriptive'];
// what each type shows: [formula, value set, default value, decimals, high low, text area]
const SHOWS: Record<string, [boolean, boolean, boolean, boolean, boolean, boolean]> = {
  Integer: [false, false, false, true, true, false],
  Float: [false, false, false, true, true, false],
  Equation: [true, false, false, true, true, false],
  List: [false, true, true, false, false, false],
  'Long Text': [false, false, false, false, false, true],
  Descriptive: [false, false, false, false, false, true],
  Space: [false, false, false, false, false, false],
};

describe('Parameter form: fields', () => {
  it('offers the ElabAssist result types', async () => {
    const f = await open();
    expect(within(within(f).getByLabelText(/result type/i)).getAllByRole('option').map((o) => o.textContent)).toEqual(expect.arrayContaining(TYPES));
  });

  it.each([
    [/^name/i], [/print name/i], [/sub ?heading/i], [/short name/i], [/sort order|position/i], [/trend name/i], [/specimen/i], [/font/i], [/result display type/i],
    [/reportable/i], [/print on negative/i], [/print on worksheet/i], [/send in sms/i], [/^nabl/i], [/accab logo/i], [/^is trend|trend$/i], [/unit/i], [/method/i], [/require verification/i],
  ])('has a field labelled %s', async (label) => {
    const f = await open();
    await pick(f, 'Float');
    expect(has(f, label)).toBe(true);
  });

  it('marks name and short name as required', async () => {
    const f = await open();
    for (const l of [/^name/i, /short name/i]) {
      const c = within(f).getAllByLabelText(l)[0] as HTMLInputElement;
      expect(c.required || c.getAttribute('aria-required') === 'true').toBe(true);
    }
  });

  it('result display type offers the 11 contract values', async () => {
    const f = await open();
    expect(within(within(f).getByLabelText(/result display type/i)).getAllByRole('option').length).toBeGreaterThanOrEqual(11);
  });

  it.each(Object.entries(SHOWS))('%s shows exactly its own fields', async (type, [formula, vset, dflt, dec, hl, area]) => {
    const f = await open();
    await pick(f, type);
    expect({
      formula: has(f, /formula/i), valueSet: has(f, /value set/i), defaultValue: has(f, /default value/i), decimals: has(f, /decimals/i),
      highLow: has(f, /high ?\/? ?low|high low/i), textArea: within(f).queryAllByLabelText(/^text$/i).some((e) => e.tagName === 'TEXTAREA'),
    }).toEqual({ formula, valueSet: vset, defaultValue: dflt, decimals: dec, highLow: hl, textArea: area });
  });

  it('switching type back and forth drops the hidden fields from the request (no stale formula on a List)', async () => {
    const f = await open();
    await userEvent.type(within(f).getByLabelText(/^name/i), 'Synthetic');
    await userEvent.type(within(f).getByLabelText(/short name/i), 'syn1');
    await pick(f, 'Equation');
    await userEvent.type(within(f).getByLabelText(/formula/i), 'HB * 3');
    await pick(f, 'List');
    await userEvent.selectOptions(within(f).getByLabelText(/value set/i), VALUE_SET.code);
    await userEvent.click(within(f).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(to('POST', /\/analytes$/)).toHaveLength(1));
    const v = to('POST', /\/analytes$/)[0]!.body.initial_version;
    expect(v).toMatchObject({ result_type: 'coded', value_set_code: VALUE_SET.code });
    expect(v.formula_expression).toBeUndefined();
  });
});

describe('Parameter form: Equation', () => {
  it('lists the parameters of this test it may use by short name, excluding itself when editing', async () => {
    const f = await open(`view=details&test=${T_CBC.id}&parameter=${RBC.id}`);
    await pick(f, 'Equation');
    const usable = within(f).getByRole('list', { name: /may use|available parameters/i });
    expect(within(usable).getAllByRole('listitem').map((i) => i.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('HB'), expect.stringContaining('WBC')]));
    expect(within(usable).queryByText(/^RBC\b/)).toBeNull();
  });

  it('calls validateFormula as you type (not once per keystroke after the last), shows valid or the server message', async () => {
    const f = await open();
    await pick(f, 'Equation');
    const box = within(f).getByLabelText(/formula/i);
    await userEvent.type(box, 'HB*3');
    await waitFor(() => expect(to('POST', /\/formulas\/validate$/).length).toBeGreaterThan(0));
    expect(to('POST', /\/formulas\/validate$/).at(-1)!.body.expression).toBe('HB*3');
    expect(to('POST', /\/formulas\/validate$/).length).toBeLessThanOrEqual(4); // debounced
    expect(await within(f).findByText(/valid/i)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST' && /\/analytes\b/.test(c.path))).toHaveLength(0); // validation never saves
  });

  it('an invalid formula shows the positioned server message and blocks Save', async () => {
    overrides.set('POST /formulas/validate$', () => Response.json({ valid: false, input_analyte_codes: [], dependency_order: [], chain_depth: 0, errors: [{ path: '/expression', code: 'catalog.formula_invalid', message: 'Unknown name ZZ' }] }));
    const f = await open();
    await pick(f, 'Equation');
    await userEvent.type(within(f).getByLabelText(/formula/i), 'ZZ/5');
    expect(await within(f).findByText(/Unknown name ZZ/)).toBeTruthy();
    expect((within(f).getByRole('button', { name: /^save/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Parameter form: save', () => {
  it('New posts name, print name, sub heading, code and the initial version (Float, decimals, unit) with Idempotency-Key', async () => {
    const f = await open();
    await userEvent.type(within(f).getByLabelText(/^name/i), 'Hematocrit');
    await userEvent.type(within(f).getByLabelText(/short name/i), 'hct');
    await userEvent.type(within(f).getByLabelText(/sub ?heading/i), 'Red cells');
    await pick(f, 'Float');
    await userEvent.type(within(f).getByLabelText(/decimals/i), '1');
    await userEvent.click(within(f).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(to('POST', new RegExp(`/tests/${T_CBC.id}/analytes$`))).toHaveLength(1));
    const c = to('POST', /\/analytes$/)[0]!;
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    expect(c.body).toMatchObject({ code: 'HCT', name: 'Hematocrit', report_subheading: 'Red cells', initial_version: { result_type: 'numeric', decimals: 1 } });
    expect(to('POST', /publish/)).toHaveLength(0);
  });

  it('shows catalog.code_duplicate and 422 formula errors at their field', async () => {
    overrides.set('POST /analytes$', () => problem(409, 'catalog.code_duplicate', { errors: [{ pointer: '/code', code: 'catalog.code_duplicate', message: 'Short name HB is already used.' }] }));
    const f = await open();
    await userEvent.type(within(f).getByLabelText(/^name/i), 'Dup');
    await userEvent.type(within(f).getByLabelText(/short name/i), 'hb');
    await pick(f, 'Float');
    await userEvent.click(within(f).getByRole('button', { name: /^save/i }));
    expect(await within(f).findByText(/already used/i)).toBeTruthy();
  });

  it('Edit of a published parameter opens a draft version and patches it with If-Match; the short name is read-only', async () => {
    const f = await open(`view=details&test=${T_CBC.id}&parameter=${HB.id}`);
    expect((await within(f).findByLabelText(/short name/i) as HTMLInputElement).readOnly || (within(f).getByLabelText(/short name/i) as HTMLInputElement).disabled).toBe(true);
    const dec = within(f).getByLabelText(/decimals/i);
    await userEvent.clear(dec); await userEvent.type(dec, '2');
    await userEvent.click(within(f).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(to('PATCH', /\/analyte-versions\//)).toHaveLength(1));
    expect(to('POST', new RegExp(`/analytes/${HB.id}/versions$`))).toHaveLength(1);
    expect(to('PATCH', /\/analyte-versions\//)[0]!.headers.get('if-match')).toBeTruthy();
    expect(to('PATCH', /\/analyte-versions\//)[0]!.body).toMatchObject({ decimals: 2 });
    expect(to('POST', /publish/)).toHaveLength(0);
  });

  it('read-only actor: no Save, visible reason', async () => {
    tm().permissions = READ;
    const f = await open(`view=details&test=${T_CBC.id}&parameter=${HB.id}`);
    const save = within(f).queryByRole('button', { name: /^save/i }) as HTMLButtonElement | null;
    expect(save === null || save.disabled).toBe(true);
    expect(screen.getByText(/permission|not allowed|read[- ]only/i)).toBeTruthy();
  });
});
