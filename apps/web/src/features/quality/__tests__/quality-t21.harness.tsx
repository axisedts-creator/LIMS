// C9.T-21 shared test harness (tester-owned; not a test file). MSW plays the API; fixtures follow contracts/openapi/quality.yaml
// (QcStatusRowDto, QcRunSummaryDto, QcRunDto, QcObservationDto, LjChartDto, QualityCode). Synthetic data only.
// Each test file registers three mocks pointing here:
//   vi.mock('next/navigation', async () => (await import('./quality-t21.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./quality-t21.harness')).sessionMock)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
process.env['LIMS_QUALITY_ENABLED'] = 'true';

export const TOKEN = 'jwt-synthetic';
const id = (n: number) => `01a1a98a-ac40-7000-8000-0000000c${String(n).padStart(4, '0')}`;
export const INST_1 = id(1000);
export const INST_2 = id(1001);
export const ANALYTE_1 = id(1002);
export const ANALYTE_2 = id(1003);
export const LEVEL_1 = id(1004);
export const LEVEL_2 = id(1005);
export const LOT_1 = id(1006);
export const LOT_2 = id(1007);
export const PLAN_1 = id(1008);
export const PLAN_2 = id(1009);
export const RUN_1 = id(1010);
export const RUN_2 = id(1011);
export const RUN_3 = id(1012);
export const obsId = (n: number) => id(2000 + n);

export const PERM_READ = ['quality.qc_run.read'];
export const PERM_REVIEW = ['quality.qc_run.read', 'quality.qc_run.review'];
export const PERM_MANAGE = ['quality.qc_run.read', 'quality.qc_run.review', 'quality.qc.manage'];

// ---------------------------------------------------------------- mocks
export const state = { permissions: [] as string[], token: TOKEN as string | undefined };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Reviewer', membershipId: id(9001), tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/quality',
};
export const router: Record<'push' | 'replace' | 'refresh' | 'back', ReturnType<typeof vi.fn>> = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const navigationMock: { useRouter: () => typeof router; usePathname: () => string; useSearchParams: () => URLSearchParams; notFound: () => never; redirect: (to: string) => never } = {
  useRouter: () => router,
  usePathname: () => '/quality',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};
export const lastNav = () => {
  const all = [...router.push.mock.calls, ...router.replace.mock.calls];
  const t = all.at(-1)?.[0];
  return typeof t === 'string' ? t : t === undefined ? undefined : String(t);
};

// ---------------------------------------------------------------- fixtures
export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });

export const statusRow = (over: Record<string, unknown> = {}) => ({
  plan_id: PLAN_1, instrument_id: INST_1, instrument_label: 'SYN-CHEM-01 Synthetic Chemistry Analyser', analyte_id: ANALYTE_1, analyte_code: 'GLU',
  status: 'in_control', last_in_control_run_at: '2026-11-14T03:10:00.000Z', violated_rules: [], open_rejected_run_ids: [], qc_overdue: false,
  patient_results_since_last_qc: 0, ...over,
});
export const STATUS_ROWS = [
  statusRow(),
  statusRow({ plan_id: PLAN_2, instrument_id: INST_2, instrument_label: 'SYN-IMM-02 Synthetic Immunoassay', analyte_id: ANALYTE_2, analyte_code: 'TSH', status: 'out_of_control', violated_rules: ['1-3s'], open_rejected_run_ids: [RUN_2, RUN_3], current_run_id: RUN_2, qc_overdue: true, patient_results_since_last_qc: 37, last_in_control_run_at: '2026-11-13T09:00:00.000Z' }),
  statusRow({ plan_id: id(1020), analyte_code: 'CRE', status: 'warning', violated_rules: ['1-2s'] }),
  statusRow({ plan_id: id(1021), analyte_code: 'NAK', status: 'no_qc_data', last_in_control_run_at: undefined }),
];

export const runSummary = (over: Record<string, unknown> = {}) => ({
  id: RUN_1, version: 2, plan_id: PLAN_1, instrument_id: INST_1, analyte_id: ANALYTE_1, run_at: '2026-11-14T03:00:00.000Z', status: 'evaluated', outcome: 'accepted',
  is_complete: true, observation_count: 2, controls_per_run: 2, rule_mode: 'classic', warning_rules: ['1-2s'], rules_violated: [], needs_action: false, ...over,
});

export const runObs = (n: number, over: Record<string, unknown> = {}) => ({
  id: obsId(n), version: 1, plan_id: PLAN_1, instrument_id: INST_1, analyte_id: ANALYTE_1, level_id: n % 2 ? LEVEL_1 : LEVEL_2, lot_id: LOT_1,
  control_id_raw: `QC-L${n}`, control_lot_raw: 'SYN-LOT-001', control_level_raw: String(n), value: n % 2 ? '106.4' : '151.0', unit_code: 'mg_dl',
  observed_at: '2026-11-14T03:00:00.000Z', received_at: '2026-11-14T03:00:05.000Z', observed_at_basis: 'instrument', source: 'instrument', status: 'assigned',
  qc_run_id: RUN_1, z: n % 2 ? '3.200' : '0.100', target_id: id(1030), rule_hits: n % 2 ? ['1-3s'] : [], ...over,
});

export const runDto = (over: Record<string, unknown> = {}) => ({
  ...runSummary({ id: RUN_1, status: 'evaluated', outcome: 'rejected', rules_violated: ['1-3s'], needs_action: true, needs_action_reason: 'corrective_action' }),
  plan_version_no: 3, observations: [runObs(1), runObs(2)], rule_detail: [{ rule: '1-3s', observation_ids: [obsId(1)] }],
  hold: { hold_since: '2026-11-14T03:00:30.000Z', last_in_control_run_at: '2026-11-13T09:00:00.000Z', event_id: id(3000) },
  corrective_actions: [], reviews: [], evaluated_at: '2026-11-14T03:00:30.000Z', evaluated_by: 'system', ...over,
});

export const obsRow = (n: number, status: string, over: Record<string, unknown> = {}) => ({
  id: obsId(100 + n), version: 1, instrument_id: INST_1, control_id_raw: `RAW-CTRL-${n}`, control_lot_raw: `RAW-LOT-${n}`, control_level_raw: `RAW-LVL-${n}`, value: '99.5', unit_code: 'mg_dl',
  observed_at: '2026-11-14T02:00:00.000Z', received_at: '2026-11-14T02:00:01.000Z', observed_at_basis: 'instrument', source: 'instrument', status, ...over,
});

export const pt = (n: number, status: string, over: Record<string, unknown> = {}) => ({
  observation_id: obsId(300 + n), observed_at: `2026-11-${String(10 + n).padStart(2, '0')}T03:00:00.000Z`, value: '100.0', z: '0.000', status, qc_run_id: RUN_1, rule_hits: [], ...over,
});
export const ljDto = (over: Record<string, unknown> = {}) => ({
  plan: { id: PLAN_1, instrument_id: INST_1, analyte_id: ANALYTE_1, analyte_code: 'GLU', unit_code: 'mg_dl', decimals: 1 },
  view: 'level', truncated: false,
  series: [{
    level_id: LEVEL_1, level_code: 'L1', lot_id: LOT_1, lot_no: 'SYN-LOT-001',
    points: [pt(0, 'accepted'), pt(1, 'warning', { value: '104.4', z: '2.200', rule_hits: ['1-2s'] }), pt(2, 'rejected', { value: '106.4', z: '3.200', rule_hits: ['1-3s'] }),
      pt(3, 'excluded', { value: '120.0', z: '10.000' }), pt(4, 'unevaluated', { qc_run_id: undefined }), pt(5, 'collecting')],
    targets: [
      { target_id: id(1030), effective_from: '2026-11-01T00:00:00.000Z', effective_to: '2026-11-12T00:00:00.000Z', mean: '98.0', sd: '2.5', source: 'manufacturer' },
      { target_id: id(1031), effective_from: '2026-11-12T00:00:00.000Z', mean: '100.0', sd: '2.0', source: 'established' },
    ],
  }],
  ...over,
});

export const CODED_CORRECTIVE = { data: [{ code: 'recalibrated', display: 'Recalibrated', sort_order: 1, is_active: true, source: 'global' }, { code: 'new_reagent', display: 'New reagent opened', sort_order: 2, is_active: true, source: 'global' }], page: { limit: 50 } };
export const CODED_EXCLUSION = { data: [{ code: 'sample_error', display: 'Sample handling error', sort_order: 1, is_active: true, source: 'global' }], page: { limit: 50 } };

// ---------------------------------------------------------------- MSW (key = "METHOD /path"; unknown routes answer 503 so a missing read never looks like data)
export interface Call { method: string; url: URL; headers: Headers; body?: string }
export const calls: Call[] = [];
export const routes: Record<string, (c: Call) => Response | Promise<Response>> = {};
export const api = setupServer(
  http.all(`${ORIGIN}/v1/*`, async ({ request }) => {
    const url = new URL(request.url);
    const call: Call = { method: request.method, url, headers: request.headers, ...(request.method !== 'GET' ? { body: await request.clone().text() } : {}) };
    calls.push(call);
    const h = routes[`${request.method} ${url.pathname}`];
    return h ? h(call) : problem('common.dependency_unavailable', 503);
  }),
);
export function resetApi(permissions: string[] = PERM_READ) {
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  state.permissions = permissions;
  state.token = TOKEN;
  router.push.mockClear(); router.replace.mockClear(); router.refresh.mockClear();
  routes['GET /v1/quality/coded-sets/corrective_actions'] = () => HttpResponse.json(CODED_CORRECTIVE);
  routes['GET /v1/quality/coded-sets/exclusion_reasons'] = () => HttpResponse.json(CODED_EXCLUSION);
}
export const json = (b: unknown, status = 200) => () => HttpResponse.json(b as never, { status });
export const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.pathname === path);
export const bodyOf = (c: Call | undefined) => JSON.parse(c?.body ?? 'null');

// ---------------------------------------------------------------- pages
type SP = Record<string, string | string[] | undefined>;
export const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'app', '(staff)', 'quality');
export const FEATURE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'packages', 'ui', 'src', 'components');
export const appFile = (...p: string[]) => join(APP, ...p);
export async function importPage(rel: string) {
  return (await import(/* @vite-ignore */ `../../../app/(staff)/quality/${rel}`)) as { default: (p: any) => Promise<any> };
}
export async function show(rel: string, props: { searchParams?: SP; params?: Record<string, string> } = {}): Promise<ReturnType<typeof render>> {
  const { default: Page } = await importPage(rel);
  const el = await Page({ searchParams: Promise.resolve(props.searchParams ?? {}), params: Promise.resolve(props.params ?? {}) });
  return render(<ToastProvider>{el}</ToastProvider>);
}
/** Renders, or returns the error message when the page refuses by throwing. A MISSING module is never a "refusal": it rethrows. */
export async function showOrThrown(rel: string, props: Parameters<typeof show>[1] = {}): Promise<string | undefined> {
  try { await show(rel, props); return undefined; } catch (e) {
    const m = String((e as Error)?.message);
    if (/Cannot find module|Failed to (load|resolve)|does not exist/.test(m)) throw e;
    return m;
  }
}
export const read = (...p: string[]) => readFileSync(appFile(...p), 'utf8');
export const has = (...p: string[]) => existsSync(appFile(...p));

// ---------------------------------------------------------------- DOM helpers
export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export function gridNamed(re: RegExp) {
  const g = screen.queryAllByRole('grid', { name: re });
  if (!g.length) throw new Error(`no table named ${re}; tables: ${JSON.stringify(screen.queryAllByRole('grid').map((x) => x.getAttribute('aria-label')))}`);
  return g[0]!;
}
export const headersOf = (g: HTMLElement) => within(g).getAllByRole('columnheader').map((h) => norm(h.textContent));
export const dataRows = (g: HTMLElement) => within(g).getAllByRole('row').slice(1);
export const rowTexts = (g: HTMLElement) => dataRows(g).map((r) => norm(r.textContent));
export const pageText = () => norm(document.body.textContent) + ' ' + [...document.body.querySelectorAll('[title],[aria-label]')].map((e) => `${e.getAttribute('title') ?? ''} ${e.getAttribute('aria-label') ?? ''}`).join(' ');
export const hrefs = () => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
export async function axeClean() {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
}
