// @vitest-environment jsdom
// T0D-TESTMGMT-1 item (4) — Add / Edit Parameter form with every field; the fields shown depend on the result type.
// Route (no new route): /catalog/tests/{id}?tab=analytes&analyte=new | <analyte id>. Contract from catalog.yaml (AnalyteCreate, AnalyteVersionDraftInput) and
// elabassist-testmgmt-20261117.md. Result type options (accessible names): Numeric, Equation, Ordinal, List, Text, Long text, Narrative, Space
// (Ordinal and Narrative keep the exact names web-t32 pins; List = coded, Equation = numeric + formula_expression, Long text = text + long_text_value).
//   Numeric  : Unit, Decimals (required), High low, Method, Default value. NO formula box, value set or text area.
//   Equation : same as Numeric plus a formula box (label /formula|equation/) that calls POST /v1/catalog/formulas/validate while typing (debounced) and
//              lists the other parameters of the test (their short names = codes) as the ones it may use. Diagnostics from the server are shown.
//   List     : Value set picker (required) and Default value. NO decimals, formula or text area.
//   Long text, Narrative : a text area (long_text_value, max 20000). No decimals, unit, formula.
//   Space    : none of unit, decimals, method, formula, value set, text area.
// Common fields (all types): Code (the short name equations use), Name, Print name, Sub heading, Trend report name, Font, Result display type, Display order,
// Require verification, Print on negative value, Print on worksheet, Send result in SMS, NABL, ACCAB logo, Trend report.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { A_HB, A_MCV, A_RBC, api, callsTo, loadTests, reset, S, show, testDetail } from './testmgmt1.harness';

const HB = testDetail(1, 'HB', 'Hemoglobin', { analytes: [A_HB, A_RBC, A_MCV] });

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => { reset(); loadTests(HB); });
afterEach(() => { cleanup(); api.resetHandlers(); });

const openNew = async () => { await show('test', { params: { test_id: String(HB['id']) }, search: 'tab=analytes&analyte=new' }); return screen.findByLabelText(/^result type/i); };
const type = async (name: RegExp) => { await userEvent.click(screen.getByLabelText(/^result type/i)); await userEvent.click(await screen.findByRole('option', { name })); };
const has = (re: RegExp) => screen.queryByLabelText(re) !== null;
const create = () => callsTo('POST', /\/tests\/[^/]+\/analytes$/);

const COMMON: [string, RegExp][] = [
  ['code', /^code/i], ['name', /^name/i], ['print name', /^print name/i], ['sub heading', /^sub.?heading/i], ['trend name', /^trend report name|^trend name/i], ['font', /^font/i],
  ['result display type', /^result display type/i], ['display order', /^display order/i], ['require verification', /^require verification/i], ['print on negative', /^print on negative/i],
  ['print on worksheet', /^print on work\s?sheet/i], ['send in SMS', /^send result in sms/i], ['NABL', /^nabl/i], ['ACCAB logo', /^accab logo/i], ['trend report', /^trend report$/i],
];

describe('every field of the parameter is on the form (item 4)', () => {
  it.each(COMMON)('common field: %s', async (_n, re) => { await openNew(); expect(has(re)).toBe(true); });
  it('Result type lists the types by name', async () => {
    await openNew();
    await userEvent.click(screen.getByLabelText(/^result type/i));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent?.trim());
    for (const n of ['Numeric', 'Equation', 'Ordinal', 'List', 'Text', 'Long text', 'Narrative', 'Space']) expect(names, n).toContain(n);
  });
  it('Print on negative value is ticked by default (the API default is true); the other flags are not', async () => {
    await openNew();
    expect((screen.getByLabelText(/^print on negative/i) as HTMLInputElement).checked).toBe(true);
    for (const re of [/^print on work\s?sheet/i, /^send result in sms/i, /^require verification/i, /^accab logo/i]) expect((screen.getByLabelText(re) as HTMLInputElement).checked, String(re)).toBe(false);
  });
  it('passes axe', async () => {
    await openNew();
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('the fields shown depend on the result type (item 4, 8)', () => {
  it('Numeric: unit, decimals, high low, method; no formula, value set or text area', async () => {
    await openNew();
    for (const re of [/^unit/i, /^decimals/i, /high\W*low/i, /^method/i, /^default value/i]) expect(has(re), String(re)).toBe(true);
    for (const re of [/formula|equation/i, /^value set/i, /^long text|text value/i]) expect(has(re), String(re)).toBe(false);
  });
  it('Equation: adds the formula box, keeps decimals', async () => {
    await openNew();
    await type(/^equation$/i);
    expect(has(/formula|equation/i)).toBe(true);
    expect(has(/^decimals/i)).toBe(true);
    expect(has(/^value set/i)).toBe(false);
  });
  it('List: value set picker and default value; no decimals, formula or text area', async () => {
    await openNew();
    await type(/^list$/i);
    expect(has(/^value set/i)).toBe(true);
    expect(has(/^default value/i)).toBe(true);
    for (const re of [/^decimals/i, /formula|equation/i, /^long text|text value/i, /high\W*low/i]) expect(has(re), String(re)).toBe(false);
  });
  it.each([[/^long text$/i], [/^narrative$/i]])('%s: a text area, no decimals, unit or formula', async (opt) => {
    await openNew();
    await type(opt);
    const ta = screen.getByLabelText(/^long text|text value|^text/i);
    expect(ta.tagName).toBe('TEXTAREA');
    for (const re of [/^decimals/i, /^unit/i, /formula|equation/i]) expect(has(re), String(re)).toBe(false);
  });
  it('Space: nothing clinical is asked', async () => {
    await openNew();
    await type(/^space$/i);
    for (const re of [/^unit/i, /^decimals/i, /^method/i, /formula|equation/i, /^value set/i, /^long text|text value/i, /^default value/i]) expect(has(re), String(re)).toBe(false);
    expect(has(/^name/i)).toBe(true);
  });
  it('switching type back and forth does not leave stale fields in the request', async () => {
    await openNew();
    await type(/^equation$/i);
    await userEvent.type(screen.getByLabelText(/formula|equation/i), 'HB/RBC');
    await type(/^space$/i);
    await userEvent.type(screen.getByLabelText(/^code/i), 'gap');
    await userEvent.type(screen.getByLabelText(/^name/i), 'Gap');
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(create()).toHaveLength(1));
    for (const k of ['unit_code', 'decimals', 'method_id', 'value_set_code', 'formula_expression', 'default_value', 'long_text_value', 'high_low']) expect(create()[0]!.body.initial_version, k).not.toHaveProperty(k);
    expect(create()[0]!.body.initial_version.result_type).toBe('space');
  });
});

describe('Equation: live validation against validateFormula (item 4)', () => {
  it('calls the API as you type, lists the parameters the formula may use, and shows server diagnostics', async () => {
    S.formula = (e) => (e.includes('NOPE')
      ? { valid: false, input_analyte_codes: [], dependency_order: [], chain_depth: 0, errors: [{ path: '/expression/3', code: 'catalog.formula_unknown_code', message: 'Unknown parameter NOPE' }] }
      : { valid: true, input_analyte_codes: ['HB', 'RBC'], dependency_order: ['HB', 'RBC'], chain_depth: 1, errors: [] });
    await openNew();
    await type(/^equation$/i);
    const box = screen.getByLabelText(/formula|equation/i);
    expect(screen.getByText(/parameters? .*(may|can) use|available parameters/i).closest('*')!.textContent).toMatch(/HB.*RBC|RBC.*HB/); // the other parameters of the test, by short name
    await userEvent.type(box, 'HB/RBC');
    await waitFor(() => expect(callsTo('POST', /formulas\/validate$/).length).toBeGreaterThan(0), { timeout: 3000 });
    expect(callsTo('POST', /formulas\/validate$/).at(-1)!.body.expression).toBe('HB/RBC');
    await userEvent.clear(box);
    await userEvent.type(box, 'NOPE*2');
    expect(await screen.findByText('Unknown parameter NOPE', {}, { timeout: 3000 })).toBeTruthy();
  });
  it('typing five characters does not send five requests (debounced)', async () => {
    await openNew();
    await type(/^equation$/i);
    await userEvent.type(screen.getByLabelText(/formula|equation/i), 'HB*10', { delay: 5 });
    await waitFor(() => expect(callsTo('POST', /formulas\/validate$/).length).toBeGreaterThan(0), { timeout: 3000 });
    expect(callsTo('POST', /formulas\/validate$/).length).toBeLessThanOrEqual(2);
  });
});

describe('create request per type (item 4)', () => {
  const base = async (codeText: string, nameText: string) => {
    await userEvent.type(screen.getByLabelText(/^code/i), codeText);
    await userEvent.type(screen.getByLabelText(/^name/i), nameText);
  };
  const save = () => userEvent.click(screen.getByRole('button', { name: /^save/i }));

  it('Equation -> numeric + formula_expression + decimals; flags are booleans; common fields at analyte level', async () => {
    await openNew();
    await type(/^equation$/i);
    await base('vldl', 'VLDL cholesterol');
    await userEvent.type(screen.getByLabelText(/formula|equation/i), 'HB/RBC');
    await userEvent.type(screen.getByLabelText(/^decimals/i), '1');
    await userEvent.type(screen.getByLabelText(/^trend report name|^trend name/i), 'VLDL trend');
    await userEvent.click(screen.getByLabelText(/^send result in sms/i));
    await userEvent.click(screen.getByLabelText(/^require verification/i));
    await save();
    await waitFor(() => expect(create()).toHaveLength(1));
    const b = create()[0]!.body;
    expect(create()[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(b).toMatchObject({ code: 'VLDL', name: 'VLDL cholesterol', trend_name: 'VLDL trend', send_in_sms: true });
    expect(b.initial_version).toMatchObject({ result_type: 'numeric', formula_expression: 'HB/RBC', decimals: 1, require_verification: true });
  });
  it('List -> coded + value_set_code + default_value', async () => {
    await openNew();
    await type(/^list$/i);
    await base('nit', 'Nitrite');
    await userEvent.click(screen.getByLabelText(/^value set/i));
    await userEvent.click(await screen.findByRole('option', { name: /positive\/negative/i }));
    await userEvent.type(screen.getByLabelText(/^default value/i), 'NEG');
    await save();
    await waitFor(() => expect(create()).toHaveLength(1));
    expect(create()[0]!.body.initial_version).toMatchObject({ result_type: 'coded', value_set_code: 'POSNEG', default_value: 'NEG' });
  });
  it('Long text -> text + long_text_value', async () => {
    await openNew();
    await type(/^long text$/i);
    await base('rem', 'Remarks');
    await userEvent.type(screen.getByLabelText(/^long text|text value/i), 'Fasting sample required.');
    await save();
    await waitFor(() => expect(create()).toHaveLength(1));
    expect(create()[0]!.body.initial_version).toMatchObject({ result_type: 'text', long_text_value: 'Fasting sample required.' });
  });
  it('Numeric with High low -> high_low is a decimal STRING (13.0 stays 13.0)', async () => {
    await openNew();
    await base('hb2', 'Haemoglobin B');
    await userEvent.type(screen.getByLabelText(/^decimals/i), '1');
    await userEvent.type(screen.getByLabelText(/high\W*low/i), '13.0');
    await save();
    await waitFor(() => expect(create()).toHaveLength(1));
    expect(create()[0]!.body.initial_version.high_low).toBe('13.0');
  });
  it.each([
    ['a code that breaks the pattern', 'x y!', /code/i],
  ])('%s -> field error and no request', async (_n, code) => {
    await openNew();
    await base(code, 'Bad');
    await userEvent.type(screen.getByLabelText(/^decimals/i), '1');
    await save();
    await new Promise((r) => setTimeout(r, 150));
    expect(create()).toEqual([]);
    expect(screen.getByLabelText(/^code/i).getAttribute('aria-invalid')).toBe('true');
  });
  it('a Long text longer than 20000 characters is refused before any request', async () => {
    await openNew();
    await type(/^long text$/i);
    await base('big', 'Big');
    const ta = screen.getByLabelText(/^long text|text value/i) as HTMLTextAreaElement;
    await userEvent.click(ta);
    await userEvent.paste('x'.repeat(20001));
    await save();
    await new Promise((r) => setTimeout(r, 150));
    expect(create()).toEqual([]);
  });
  it('server 400 /initial_version/formula_expression (cycle) is shown under the formula box', async () => {
    S.failNext = { method: 'POST', re: /\/analytes$/, status: 400, code: 'common.validation_failed', errors: [{ path: '/initial_version/formula_expression', code: 'catalog.formula_cycle', message: 'Formula refers to itself: VLDL -> VLDL' }] };
    await openNew();
    await type(/^equation$/i);
    await base('vldl', 'VLDL');
    await userEvent.type(screen.getByLabelText(/formula|equation/i), 'VLDL*2');
    await userEvent.type(screen.getByLabelText(/^decimals/i), '1');
    await save();
    expect(await screen.findByText('Formula refers to itself: VLDL -> VLDL')).toBeTruthy();
  });
});

describe('edit an existing parameter (item 4)', () => {
  it('opens with the right type: a version with formula_expression is shown as Equation; its formula is prefilled', async () => {
    await show('test', { params: { test_id: String(HB['id']) }, search: `tab=analytes&analyte=${A_MCV.id}` });
    const box = await screen.findByLabelText(/formula|equation/i);
    expect((box as HTMLInputElement | HTMLTextAreaElement).value).toBe('HB/RBC');
    expect(screen.getByLabelText(/^result type/i).textContent).toMatch(/equation/i);
  });
});
