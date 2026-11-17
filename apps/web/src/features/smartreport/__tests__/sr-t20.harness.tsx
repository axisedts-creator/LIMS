// C14.T20 shared test harness (tester-owned; not a test file). MSW plays the API (method-aware, key = "METHOD /path"); fixtures follow
// contracts/openapi/smartreport.yaml (LibraryVersionSummary, LibraryVersion, TemplateBlock, Rule, AnalyteGroup, GroupSetting, ValidationReport, CodedSet). Synthetic data only.
// Each test file registers three mocks pointing here:
//   vi.mock('next/navigation', async () => (await import('./sr-t20.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./sr-t20.harness')).sessionMock)
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
export const TOKEN = 'jwt-synthetic';
export const MANAGE = ['smartreport.template.manage'];

const id = (n: number) => `01940e00-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const VER_APPROVED = id(1);
export const VER_DRAFT = id(2);
export const VER_REVIEW = id(3);
export const VER_RETIRED = id(4);
export const BLOCK_DERANGED = id(10);
export const BLOCK_ADVICE = id(11);
export const BLOCK_FOLLOWUP = id(12);
export const RULE_DERANGED = id(20);
export const RULE_FOLLOWUP = id(21);
export const ANALYTE_ALT = id(30);
export const ANALYTE_OTHER_TENANT = id(31);
export const TEST_CBC = id(40);
export const MEMBER_PATH = id(50);

// ---------------------------------------------------------------- mocks
export const state = { permissions: [] as string[], token: TOKEN as string | undefined };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Pathologist', membershipId: MEMBER_PATH, tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/smartreport/library',
};
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const navigationMock = {
  useRouter: () => router,
  usePathname: () => '/smartreport/library',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};
export const lastNav = () => {
  const t = [...router.push.mock.calls, ...router.replace.mock.calls].at(-1)?.[0];
  return t === undefined ? undefined : String(t);
};

// ---------------------------------------------------------------- fixtures
export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });

export const PARAMS = {
  score_enabled: true, credit_in_range_bp: 10000, credit_borderline_bp: 5000, credit_out_of_range_bp: 0, credit_critical_bp: 0, min_groups_scored: 2,
  band_good_min: 80, band_fair_min: 60, critical_forces_needs_attention: true, borderline_fraction_bp: 0, min_mapped_results: 3, trend_enabled: true,
  trend_max_points: 4, trend_lookback_days: 730, trend_stable_bp: 1000, trends_max: 6, advice_max_blocks: 5, followup_max: 3,
};
export const summaryDto = (over: Record<string, unknown> = {}) => ({
  id: VER_APPROVED, version_no: 2, status: 'approved', language: 'en', approved_at: '2026-01-15T05:10:00.000Z', approved_by_membership_id: MEMBER_PATH,
  approved_by_display_name: 'Synthetic Pathologist', updated_at: '2026-01-15T05:10:00.000Z', version: 5, ...over,
});
export const versionDto = (over: Record<string, unknown> = {}) => ({
  id: VER_DRAFT, version_no: 3, status: 'draft', language: 'en', formula_version: 'hs-1', params: { ...PARAMS }, source_version_id: VER_APPROVED,
  change_summary: 'Synthetic wording update', counts: { blocks: 3, rules: 2, analyte_groups: 1, groups_shown: 2 }, version: 4,
  created_at: '2026-01-15T04:30:00.000Z', updated_at: '2026-01-15T05:10:00.000Z', ...over,
});
export const blockDto = (over: Record<string, unknown> = {}) => ({
  id: BLOCK_DERANGED, block_key: 'deranged.alt.high', kind: 'deranged', text_en: '{analyte_name} is above the reference range of your laboratory.',
  placeholders: ['analyte_name'], version: 2, updated_at: '2026-01-15T05:10:00.000Z', ...over,
});
export const BLOCKS = [
  blockDto(),
  blockDto({ id: BLOCK_ADVICE, block_key: 'advice.liver.general', kind: 'advice', text_en: 'Discuss {group_name} results with your doctor.', placeholders: ['group_name'] }),
  blockDto({ id: BLOCK_FOLLOWUP, block_key: 'followup.liver.retest', kind: 'followup', text_en: 'Consider {test_name} again in {interval_days} days.', placeholders: ['test_name', 'interval_days'] }),
];
export const ruleDto = (over: Record<string, unknown> = {}) => ({
  id: RULE_DERANGED, rule_kind: 'deranged', trigger_kind: 'group', group_code: 'liver', direction: 'high', min_severity: 'out_of_range', priority: 100, block_id: BLOCK_DERANGED, version: 1, ...over,
});
export const RULES = [
  ruleDto(),
  ruleDto({ id: RULE_FOLLOWUP, rule_kind: 'followup', trigger_kind: 'group', group_code: 'liver', direction: 'high', block_id: BLOCK_FOLLOWUP, suggested_test_id: TEST_CBC, interval_days: 90 }),
];
export const MAPPINGS = [{ analyte_id: ANALYTE_ALT, group_code: 'liver', include_in_score: true, trend_enabled: false, sort_order: 10, version: 3 }];
export const GROUPS = [
  { group_code: 'liver', display_en: 'Liver', display_ne: 'कलेजो', score_weight: 3, sort_order: 10, is_shown: true, version: 2 },
  { group_code: 'iron', display_en: 'Iron', score_weight: 1, sort_order: 20, is_shown: false, version: 1 },
];
export const ORGAN_GROUPS = { set_code: 'smartreport.organ_groups', items: [
  { code: 'liver', display: 'Liver', sort_order: 10, is_active: true }, { code: 'kidney', display: 'Kidney', sort_order: 20, is_active: true }, { code: 'iron', display: 'Iron', sort_order: 30, is_active: true },
] };
export const REPORT_OK = { valid: true, issues: [] as unknown[] };

// ---------------------------------------------------------------- MSW
export interface Call { method: string; url: URL; headers: Headers; body?: string }
export const calls: Call[] = [];
export const routes: Record<string, (c: Call) => Response | Promise<Response>> = {};
export const api = setupServer(
  http.all(`${ORIGIN}/v1/*`, async ({ request }) => {
    const url = new URL(request.url);
    const call: Call = { method: request.method, url, headers: request.headers, ...(request.method !== 'GET' ? { body: await request.clone().text() } : {}) };
    calls.push(call);
    const h = routes[`${request.method} ${url.pathname}`];
    return h ? h(call) : problem('common.dependency_unavailable', 503); // an unregistered read never looks like data
  }),
);
export const json = (b: unknown, status = 200) => () => HttpResponse.json(b as never, { status });
export const SR = '/v1/smartreport/library-versions';
export const vp = (v: string, tail = '') => `${SR}/${v}${tail}`;

/** Registers the reads the editor page makes for version `v` (override single routes afterwards). */
export function mountEditorApi(v = VER_DRAFT, ver: Record<string, unknown> = versionDto(), extra: { blocks?: unknown[]; rules?: unknown[]; mappings?: unknown[]; groups?: unknown[] } = {}) {
  routes[`GET ${vp(v)}`] = json({ ...ver, id: v });
  routes[`GET ${vp(v, '/blocks')}`] = json({ data: extra.blocks ?? BLOCKS });
  routes[`GET ${vp(v, '/rules')}`] = json({ data: extra.rules ?? RULES });
  routes[`GET ${vp(v, '/analyte-groups')}`] = json({ data: extra.mappings ?? MAPPINGS });
  routes[`GET ${vp(v, '/groups')}`] = json({ data: extra.groups ?? GROUPS });
  routes['GET /v1/smartreport/library/coded-sets/organ_groups'] = json(ORGAN_GROUPS);
}
export function resetApi(permissions: string[] = MANAGE) {
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  state.permissions = permissions; state.token = TOKEN;
  router.push.mockClear(); router.replace.mockClear(); router.refresh.mockClear();
}
export const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.pathname === path);
export const bodyOf = (c: Call | undefined) => JSON.parse(c?.body ?? 'null');
export const apiCalls = () => calls.filter((c) => c.url.pathname.startsWith('/v1/'));

// ---------------------------------------------------------------- pages
const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'app', '(staff)', 'smartreport');
export const appFile = (...p: string[]) => join(APP, ...p);
/** Imports app/(staff)/smartreport/<rel> (no extension). */
export const importPage = async (rel: string) => (await import(/* @vite-ignore */ `../../../app/(staff)/smartreport/${rel}`)) as { default: (p: any) => Promise<any> };
export const LIST_PAGE = 'library/page';
export const EDITOR_PAGE = 'library/[library_version_id]/page';
export async function show(rel: string, params: Record<string, string> = {}, searchParams: Record<string, string> = {}) {
  const { default: Page } = await importPage(rel);
  const el = await Page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) });
  return render(<ToastProvider>{el}</ToastProvider>);
}
export const showEditor = (v = VER_DRAFT) => show(EDITOR_PAGE, { library_version_id: v });
/** Renders, or returns the thrown message when the page refuses. A MISSING module is never a "refusal": it rethrows. */
export async function showOrThrown(rel: string, params: Record<string, string> = {}): Promise<string | undefined> {
  try { await show(rel, params); return undefined; } catch (e) {
    const m = String((e as Error)?.message);
    if (/Cannot find module|Failed to (load|resolve)|does not exist/.test(m)) throw e;
    return m;
  }
}

// ---------------------------------------------------------------- DOM helpers
export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export const pageText = () => norm(document.body.textContent);
export async function axeClean() {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
}
export function gridNamed(re: RegExp) {
  const g = screen.queryAllByRole('grid', { name: re });
  if (!g.length) throw new Error(`no table named ${re}; tables: ${JSON.stringify(screen.queryAllByRole('grid').map((x) => x.getAttribute('aria-label')))}`);
  return g[0]!;
}
export const headersOf = (g: HTMLElement) => within(g).getAllByRole('columnheader').map((h) => norm(h.textContent));
export const rowTexts = (g: HTMLElement) => within(g).getAllByRole('row').slice(1).map((r) => norm(r.textContent));

/** Kit Select (react-aria): trigger is a button named "<label> <value>", options render in a listbox. */
export async function pick(label: RegExp, option: RegExp) {
  const { default: userEvent } = await import('@testing-library/user-event');
  await userEvent.click(screen.getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}
