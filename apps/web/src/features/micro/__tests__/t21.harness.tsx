// C10.T-21 shared test harness (tester-owned; not a test file). Builds on t20.harness (MSW fake C10 API, session/navigation mocks, kit helpers) and adds the AST fixtures
// and the AST endpoints (contracts/openapi/micro.yaml: previewAstInterpretation M13, recordAstResults M12, assignAstPanel M11). Each test file registers:
//   vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock)
// CONTRACT PINNED BY THESE TESTS (writer: make these exports exist; names are mine, data shapes are the spec's):
//   features/micro/components/ast/AstGrid.tsx   export function AstGrid(props)   (04-UI-UX §3.3 right half; 03-APP-FLOW §4.5 steps 4-6)
//        props: { isolate: IsolateDto (now with ast_panel?, ast_method?, ast: AstResultDto[]); defaultStandard?: 'CLSI'|'EUCAST'; canWork: boolean;
//                 onSaved: () => void  (called once per save click when >= 1 entry was stored);  onDirtyChange?: (dirty: boolean) => void }
//        Read-only (inputs disabled, no "Save AST") when !canWork or the isolate is withdrawn.  Labels: "{antibiotic} raw value", "{antibiotic} category", "{antibiotic} report"
//        (04-UI-UX §8), header Select "Standard" + TextField "Version", button "Save AST", suggestion button "Use suggested category {code} for {antibiotic}".
//   CultureScreen (T-20) mounts the grid for the selected isolate on tab "Isolates & AST", loads the tenant standard from GET /v1/micro/settings (a failure -> empty standard),
//        guards leaving the tab with ConfirmDialog "Discard unsaved AST changes?" (confirm "Discard", cancel "Cancel"), and offers "Choose AST panel" (dialog, buttons "Save"/"Cancel").
//   Server actions (a 'use server' file under features/micro/server): previewAst -> POST /v1/micro/isolates/{id}/ast-results/interpret (no idempotency),
//        recordAst -> POST .../ast-results/bulk-record (Idempotency-Key per click, no If-Match), assignAstPanel -> POST .../ast-panel (Idempotency-Key + If-Match "<isolate.version>").
// Synthetic data only.
import { http, HttpResponse } from 'msw';
import { screen, within } from '@testing-library/react';
import { CODED, ID, ORIGIN, api, code, isolate, problem } from './t20.harness';

export * from './t20.harness';

export const ISO = ID(303);
export const SET_ID = ID(70);
export const BAND_ID = ID(71);
export const PREVIEW = /\/v1\/micro\/isolates\/[^/]+\/ast-results\/interpret$/;
export const BULK = /\/v1\/micro\/isolates\/[^/]+\/ast-results\/bulk-record$/;
export const PANEL = /\/v1\/micro\/isolates\/[^/]+\/ast-panel$/;

// ---- coded set ast_interpretations: key (standard, code); displays from 05-SCHEMA §3 (g_cs_ast_interpretations)
const cat = (standard: string, c: string, display: string, n: number) => code(c, { display, standard, sort_order: n * 10 });
CODED['ast_interpretations'] = [
  cat('CLSI', 'S', 'Susceptible', 1), cat('CLSI', 'SDD', 'Susceptible-dose dependent', 2), cat('CLSI', 'I', 'Intermediate', 3),
  cat('CLSI', 'I^', 'Intermediate (agent concentrated in urine)', 4), cat('CLSI', 'R', 'Resistant', 5), cat('CLSI', 'NS', 'Nonsusceptible', 6),
  cat('EUCAST', 'S', 'Susceptible', 1), cat('EUCAST', 'I', 'Susceptible, increased exposure', 2), cat('EUCAST', 'R', 'Resistant', 3),
  cat('ECOFF', 'WT', 'Wild type', 1), cat('ECOFF', 'NWT', 'Non-wild type', 2),
];
/** AC-06.7: a newly seeded synthetic code must show up without any client change. */
export const seedSyntheticCategory = () => { CODED['ast_interpretations']!.push(cat('CLSI', 'ZZ', 'Synthetic category', 9)); };
export const dropSyntheticCategory = () => { CODED['ast_interpretations'] = CODED['ast_interpretations']!.filter((c) => c.code !== 'ZZ'); };

// ---- fixtures
export const astRow = (n: number, antibioticCode: string, display: string, method: 'mic' | 'zone_diameter' | 'other' = 'mic', over: Record<string, unknown> = {}) => ({
  id: ID(400 + n), version: 1, antibiotic_code: antibioticCode, antibiotic_display: display, method, suggestion_overridden: false, source: 'manual', is_reportable: true,
  report_visibility: 'shown', off_panel: false, panel_sort_order: n, ...over,
});
export const CEF = astRow(1, 'syn_cef_a', 'Synthetic cefA', 'mic');
export const GEN = astRow(2, 'syn_gen_b', 'Synthetic genB', 'zone_diameter');
export const COL = astRow(3, 'colistin', 'Colistin', 'mic');
export const astIsolate = (over: Record<string, unknown> = {}) => isolate(3, {
  id: ISO, version: 4, ast_panel: { id: ID(60), code: 'syn_panel', version_no: 2, display: 'Synthetic urine panel' }, ast_method: 'mic', ast: [CEF, GEN, COL], ...over,
});
export const suggestion = (category = 'S', over: Record<string, unknown> = {}) => ({
  category_code: category, standard: 'CLSI', standard_version: 'M100-Ed36', breakpoint_set_id: SET_ID, breakpoint_band_id: BAND_ID, ...over,
});

// ---- fake AST endpoints
export type Entry = { antibiotic_code: string; method: string; raw_value?: string; category_code?: string; standard?: string; standard_version?: string; is_reportable?: boolean; version?: number };
export const defaultSuggest = (e: Entry) => (e.raw_value === '0.25' || e.raw_value === '18' ? suggestion('S') : e.raw_value === '6' ? suggestion('R', { breakpoint_band_id: ID(72) }) : undefined);
/** previewAstInterpretation: `pickFn` decides per entry (default: 0.25 and 18 -> S, 6 -> R, everything else reason no_row). */
export const previewHandler = (pickFn: (e: Entry) => Record<string, unknown> | undefined = defaultSuggest, delayMs: (e: Entry) => number = () => 0) =>
  http.post(`${ORIGIN}/v1/micro/isolates/:id/ast-results/interpret`, async ({ request }) => {
    const b = (await request.json()) as { entries: Entry[] };
    await new Promise((r) => setTimeout(r, Math.max(0, ...b.entries.map(delayMs))));
    return HttpResponse.json({
      results: b.entries.map((e) => {
        const s = pickFn(e);
        return s ? { antibiotic_code: e.antibiotic_code, method: e.method, suggestion: s } : { antibiotic_code: e.antibiotic_code, method: e.method, reason: 'no_row' };
      }),
    });
  });
/** recordAstResults: stores every entry (`fail` maps an antibiotic code to a per-entry problem code + JSON pointer field). */
export const bulkHandler = (fail: Record<string, { code: string; field?: string }> = {}, delayMs = 0) =>
  http.post(`${ORIGIN}/v1/micro/isolates/:id/ast-results/bulk-record`, async ({ request }) => {
    const b = (await request.json()) as { entries: Entry[] };
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return HttpResponse.json({
      results: b.entries.map((e, i) => {
        const f = fail[e.antibiotic_code];
        return f
          ? { antibiotic_code: e.antibiotic_code, method: e.method, outcome: 'error', code: f.code, path: `/entries/${i}/${f.field ?? 'raw_value'}` }
          : { antibiotic_code: e.antibiotic_code, method: e.method, outcome: 'ok', ast_result: astRow(1, e.antibiotic_code, e.antibiotic_code, e.method as 'mic', { raw_value: e.raw_value, category_code: e.category_code, version: (e.version ?? 0) + 1 }) };
      }),
    });
  });
export const panelHandler = () => http.post(`${ORIGIN}/v1/micro/isolates/:id/ast-panel`, () => HttpResponse.json(astIsolate({ version: 5 })));
export const useAst = () => api.use(previewHandler(), bulkHandler(), panelHandler());
export { problem };

// ---- UI helpers (names from 04-UI-UX §8)
export const grid = () => screen.findByRole('grid', { name: /AST results for isolate/i });
export const rawBox = (abx: string) => screen.getByRole('textbox', { name: new RegExp(`^${abx} raw value`, 'i') }) as HTMLInputElement;
export const catBtn = (abx: string) => screen.getByRole('button', { name: new RegExp(`${abx} category`, 'i') });
export const reportBox = (abx: string) => screen.getByRole('checkbox', { name: new RegExp(`${abx}.*report`, 'i') }) as HTMLInputElement;
export const useBtn = (category: string, abx: string) => screen.queryByRole('button', { name: new RegExp(`use suggested category ${category.replace('^', '\\^')} for ${abx}`, 'i') });
export const saveBtn = () => screen.queryByRole('button', { name: /^save ast$/i });
export const describedText = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
export const optionNames = async (trigger: HTMLElement) => {
  const { default: userEvent } = await import('@testing-library/user-event');
  await userEvent.click(trigger);
  const list = await screen.findByRole('listbox');
  const names = within(list).getAllByRole('option').map((o) => o.textContent?.trim() ?? '');
  await userEvent.keyboard('{Escape}');
  return names;
};
