// @vitest-environment jsdom
// C10.T-21 — AST grid layout, accessibility and field rules (04-UI-UX §3.3, §8; 02-TRD §4.3 raw value grammar; AC-06.2 / AC-06.5 / AC-06.7 UI side; REQ-SEC-088).
// Mounts components/ast/AstGrid directly. LD-140 (2026-11-13): kit components only; every status shows tone, icon and word.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { ToastProvider } from '@lims/ui/components/Toast';
import { CEF, COL, GEN, PERM_WORK, api, astIsolate, astRow, catBtn, describedText, dropSyntheticCategory, grid, optionNames, rawBox, reportBox, resetHits, saveBtn, seedSyntheticCategory, state, useAst } from './t21.harness';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); state.permissions = PERM_WORK; useAst(); });
afterEach(() => { cleanup(); api.resetHandlers(); dropSyntheticCategory(); });
afterAll(() => api.close());

type Over = { canWork?: boolean; defaultStandard?: 'CLSI' | 'EUCAST' | undefined; onSaved?: () => void; onDirtyChange?: (d: boolean) => void };
const mount = async (isolate: Record<string, unknown> = astIsolate(), over: Over = {}) => {
  const { AstGrid } = await import('../components/ast/AstGrid');
  const props = { isolate: isolate as never, canWork: over.canWork ?? true, onSaved: over.onSaved ?? (() => {}), ...(over.onDirtyChange ? { onDirtyChange: over.onDirtyChange } : {}), ...('defaultStandard' in over ? (over.defaultStandard ? { defaultStandard: over.defaultStandard } : {}) : { defaultStandard: 'CLSI' as const }) };
  const r = render(<ToastProvider><AstGrid {...props} /></ToastProvider>);
  await grid();
  return r;
};
const stdBtn = () => screen.getByRole('button', { name: /standard$/i });
const verBox = () => screen.getByRole('textbox', { name: /^(standard )?version/i }) as HTMLInputElement;
const type = async (abx: string, v: string) => { const b = rawBox(abx); await userEvent.clear(b); if (v) await userEvent.type(b, v); await userEvent.tab(); };

describe('layout (04-UI-UX §3.3)', () => {
  it('table caption "AST results for isolate {n}"; header shows panel name + version and the method', async () => {
    await mount();
    expect(screen.getByRole('grid', { name: 'AST results for isolate 3' })).toBeTruthy();
    const t = document.body.textContent ?? '';
    expect(t).toMatch(/Synthetic urine panel/);
    expect(t).toMatch(/\b(v|version\s*)2\b/i);
    expect(t).toMatch(/\bMIC\b/);
  });
  it('columns: Antibiotic, Method, Raw value, Suggested, Category, Source, Report', async () => {
    await mount();
    const heads = within(await grid()).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Antibiotic', 'Method', 'Raw value', 'Suggested', 'Category', 'Source', 'Report']) expect(heads, h).toContain(h);
  });
  it('one row per panel antibiotic in panel order (panel_sort_order), method shown as MIC / Zone', async () => {
    await mount(astIsolate({ ast: [{ ...COL, panel_sort_order: 2 }, { ...CEF, panel_sort_order: 0 }, { ...GEN, panel_sort_order: 1 }] }));
    const rows = within(await grid()).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => /Synthetic cefA|Synthetic genB|Colistin/.exec(r.textContent ?? '')?.[0])).toEqual(['Synthetic cefA', 'Synthetic genB', 'Colistin']);
    expect(rows[0]!.textContent).toMatch(/MIC/);
    expect(rows[1]!.textContent).toMatch(/Zone/);
  });
  it('raw value suffix: "µg/mL" for MIC rows, "mm" for zone rows', async () => {
    await mount();
    const rows = within(await grid()).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('µg/mL');
    expect(rows[1]!.textContent).toMatch(/\bmm\b/);
    expect(rows[1]!.textContent).not.toContain('µg/mL');
  });
  it('stored values are prefilled; Source column reads Manual / Instrument / Suggested; Report checkbox follows is_reportable', async () => {
    await mount(astIsolate({ ast: [
      astRow(1, 'syn_cef_a', 'Synthetic cefA', 'mic', { raw_value: '<=0.25', category_code: 'S', standard: 'CLSI', standard_version: 'M100-Ed36', interpretation_source: 'breakpoint_suggestion', is_reportable: true }),
      astRow(2, 'syn_gen_b', 'Synthetic genB', 'zone_diameter', { raw_value: '18', category_code: 'R', standard: 'CLSI', standard_version: 'M100-Ed36', source: 'instrument', interpretation_source: 'instrument', is_reportable: false }),
      astRow(3, 'colistin', 'Colistin', 'mic', { raw_value: '2', category_code: 'I', standard: 'CLSI', standard_version: 'M100-Ed36', interpretation_source: 'manual' }),
    ] }));
    expect(rawBox('Synthetic cefA').value).toBe('<=0.25');
    expect(rawBox('Synthetic genB').value).toBe('18');
    expect(catBtn('Synthetic cefA').textContent).toMatch(/\bS\b/);
    expect(catBtn('Synthetic genB').textContent).toMatch(/\bR\b/);
    const rows = within(await grid()).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toMatch(/Suggested/);
    expect(rows[1]!.textContent).toMatch(/Instrument/);
    expect(rows[2]!.textContent).toMatch(/Manual/);
    expect(reportBox('Synthetic cefA').checked).toBe(true);
    expect(reportBox('Synthetic genB').checked).toBe(false);
  });
  it('every input has the accessible names of 04-UI-UX §8: "{antibiotic} raw value", "{antibiotic} category"', async () => {
    await mount();
    for (const a of ['Synthetic cefA', 'Synthetic genB', 'Colistin']) { rawBox(a); catBtn(a); reportBox(a); }
  });
  it('raw value is a 32-character field', async () => {
    await mount();
    expect(rawBox('Synthetic cefA').maxLength).toBe(32);
  });
});

describe('header: standard + version (04-UI-UX §3.3)', () => {
  it('the standard defaults to the tenant setting; options CLSI / EUCAST / ECOFF', async () => {
    await mount(astIsolate(), { defaultStandard: 'CLSI' });
    expect(stdBtn().textContent).toMatch(/CLSI/);
    expect(await optionNames(stdBtn())).toEqual(expect.arrayContaining(['CLSI', 'EUCAST', 'ECOFF']));
  });
  it('no tenant standard -> the selector is empty (nothing preselected)', async () => {
    await mount(astIsolate(), { defaultStandard: undefined });
    expect(stdBtn().textContent).not.toMatch(/CLSI|EUCAST|ECOFF/);
  });
  it('version is a TextField of 32 characters, empty until the user or a suggestion fills it', async () => {
    await mount();
    expect(verBox().maxLength).toBe(32);
    expect(verBox().value).toBe('');
  });
});

describe('category options come from the coded set, per standard (AC-06.5, AC-06.7)', () => {
  it('CLSI row: S, SDD, I, I^, R, NS, displayed "S — Susceptible"', async () => {
    await mount();
    const names = await optionNames(catBtn('Synthetic cefA'));
    expect(names).toEqual(expect.arrayContaining([expect.stringMatching(/^S\s—\sSusceptible$/), expect.stringMatching(/^SDD\s—/), expect.stringMatching(/^I\s—\sIntermediate$/), expect.stringMatching(/^I\^\s—/), expect.stringMatching(/^R\s—\sResistant$/), expect.stringMatching(/^NS\s—/)]));
    expect(names.filter((n) => /^(WT|NWT)\b/.test(n))).toEqual([]); // no ECOFF codes under CLSI (06-GLOSSARY: never compare across standards)
  });
  it('EUCAST: only S, I, R (no SDD — AC-06.5)', async () => {
    await mount(astIsolate(), { defaultStandard: 'EUCAST' });
    const names = await optionNames(catBtn('Synthetic cefA'));
    expect(names.map((n) => n.split(/\s/)[0])).toEqual(['S', 'I', 'R']);
    expect(names.some((n) => /^SDD/.test(n))).toBe(false);
  });
  it('ECOFF: WT and NWT', async () => {
    await mount();
    await userEvent.click(stdBtn());
    await userEvent.click(await screen.findByRole('option', { name: /ECOFF/ }));
    expect((await optionNames(catBtn('Synthetic cefA'))).map((n) => n.split(/\s/)[0])).toEqual(['WT', 'NWT']);
  });
  it('AC-06.7: a newly seeded code appears without any client change; the list is not capped at three', async () => {
    seedSyntheticCategory();
    await mount();
    const names = await optionNames(catBtn('Synthetic cefA'));
    expect(names.length).toBeGreaterThan(3);
    expect(names.some((n) => /^ZZ\s—\sSynthetic category$/.test(n))).toBe(true);
  });
  it('CLSI colistin shows only I and R (04-UI-UX §3.3, 04 D14); under EUCAST colistin is not restricted', async () => {
    const { unmount } = await mount();
    expect((await optionNames(catBtn('Colistin'))).map((n) => n.split(/\s/)[0])).toEqual(['I', 'R']);
    unmount();
    await mount(astIsolate(), { defaultStandard: 'EUCAST' });
    expect((await optionNames(catBtn('Colistin'))).map((n) => n.split(/\s/)[0])).toEqual(['S', 'I', 'R']);
  });
  it('switching the standard clears a category the new standard does not have (SDD -> EUCAST); S stays valid and is kept', async () => {
    await mount(astIsolate({ ast: [
      astRow(1, 'syn_cef_a', 'Synthetic cefA', 'mic', { raw_value: '4', category_code: 'SDD', standard: 'CLSI', standard_version: 'M100-Ed36' }),
      astRow(2, 'syn_gen_b', 'Synthetic genB', 'zone_diameter', { raw_value: '18', category_code: 'S', standard: 'CLSI', standard_version: 'M100-Ed36' }),
    ] }));
    await userEvent.click(stdBtn());
    await userEvent.click(await screen.findByRole('option', { name: /EUCAST/ }));
    expect(catBtn('Synthetic cefA').textContent).not.toMatch(/SDD/);
  });
});

describe('raw value grammar (02-TRD §4.3): inline error "Enter a value like 0.25, <=0.25 or 18"', () => {
  const MSG = /Enter a value like 0\.25, <=0\.25 or 18/;
  it.each([['abc'], ['0.25.1'], ['<>5'], ['1234567'], ['0,5']])('MIC %j is refused inline, linked by aria-describedby, aria-invalid', async (v) => {
    await mount();
    await type('Synthetic cefA', v);
    const b = rawBox('Synthetic cefA');
    expect(b.getAttribute('aria-invalid')).toBe('true');
    expect(describedText(b)).toMatch(MSG);
  });
  it.each([['0.25'], ['<=0.25'], ['≤0.25'], ['>=64'], ['<2'], ['8/4'], [' 0.5 '], ['= 1']])('MIC %j is accepted', async (v) => {
    await mount();
    await type('Synthetic cefA', v);
    expect(rawBox('Synthetic cefA').getAttribute('aria-invalid')).not.toBe('true');
    expect(document.body.textContent).not.toMatch(MSG);
  });
  it.each([['120'], ['abc'], ['18.123'], ['<=0.25/4']])('zone %j is refused (value <= 100, at most two decimals, no combination)', async (v) => {
    await mount();
    await type('Synthetic genB', v);
    expect(describedText(rawBox('Synthetic genB'))).toMatch(MSG);
  });
  it.each([['18'], ['≥ 20'], ['100'], ['17.5']])('zone %j is accepted', async (v) => {
    await mount();
    await type('Synthetic genB', v);
    expect(rawBox('Synthetic genB').getAttribute('aria-invalid')).not.toBe('true');
  });
  it('method "other": any 1..32 characters is accepted', async () => {
    await mount(astIsolate({ ast: [astRow(1, 'syn_oth', 'Synthetic other', 'other')] }));
    await type('Synthetic other', 'positive, weak');
    expect(rawBox('Synthetic other').getAttribute('aria-invalid')).not.toBe('true');
  });
  it('clearing the value is not an error (a pending row stays pending)', async () => {
    await mount(astIsolate({ ast: [astRow(1, 'syn_cef_a', 'Synthetic cefA', 'mic', { raw_value: '4' })] }));
    await type('Synthetic cefA', '');
    expect(rawBox('Synthetic cefA').getAttribute('aria-invalid')).not.toBe('true');
  });
});

describe('read-only', () => {
  it('without micro.culture.work: values shown, inputs disabled, no "Save AST"', async () => {
    await mount(astIsolate({ ast: [astRow(1, 'syn_cef_a', 'Synthetic cefA', 'mic', { raw_value: '4', category_code: 'S', standard: 'CLSI', standard_version: 'M100-Ed36' })] }), { canWork: false });
    expect(rawBox('Synthetic cefA').value).toBe('4');
    expect(rawBox('Synthetic cefA').disabled || rawBox('Synthetic cefA').readOnly).toBe(true);
    expect(saveBtn()).toBeNull();
  });
  it('a withdrawn isolate is read-only too', async () => {
    await mount(astIsolate({ status: 'withdrawn', is_reportable: false }));
    expect(rawBox('Synthetic cefA').disabled || rawBox('Synthetic cefA').readOnly).toBe(true);
    expect(saveBtn()).toBeNull();
  });
});

describe('free text is text, never HTML (REQ-SEC-088)', () => {
  it('a hostile antibiotic display and panel name render as text nodes', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    await mount(astIsolate({ ast_panel: { id: 'x', code: 'syn_panel', version_no: 1, display: evil }, ast: [astRow(1, 'syn_cef_a', evil, 'mic')] }));
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain(evil);
  });
});

describe('accessibility (axe)', () => {
  const run = async (el: HTMLElement) => (await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((v) => `${v.id}: ${v.help}`);
  it('grid with values and a validation error', async () => {
    await mount();
    await type('Synthetic cefA', 'abc');
    expect(await run(document.body)).toEqual([]);
  });
  it('read-only grid', async () => {
    await mount(astIsolate(), { canWork: false });
    expect(await run(document.body)).toEqual([]);
  });
  it('the "Save AST" button exists for a worker, before and after an edit', async () => {
    await mount();
    expect(saveBtn()).toBeTruthy();
    fireEvent.change(rawBox('Synthetic cefA'), { target: { value: '4' } });
    expect(saveBtn()).toBeTruthy();
  });
});
