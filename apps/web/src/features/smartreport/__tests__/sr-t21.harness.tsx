// C14.T21 shared test harness (tester-owned; not a test file). Builds on the T20 harness (MSW as the API, session/navigation mocks, DOM helpers).
// Each T21 test file registers the same three mocks as T20:
//   vi.mock('next/navigation', async () => (await import('./sr-t20.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./sr-t20.harness')).sessionMock)
// Synthetic data only. Fixtures follow contracts/openapi/smartreport.yaml (LibraryVersion, DenyTerm, SmartSummaryPreview).
import { vi } from 'vitest';
import {
  BLOCK_ADVICE, BLOCK_DERANGED, BLOCK_FOLLOWUP, GROUPS, ORGAN_GROUPS, ANALYTE_ALT, MEMBER_PATH, SR, VER_APPROVED, VER_REVIEW, blockDto, json, routes, router, ruleDto, show, summaryDto, versionDto, vp,
} from './sr-t20.harness';

export * from './sr-t20.harness';

const uid = (n: number) => `01940e00-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const APPROVE = ['smartreport.template.manage', 'smartreport.template.approve'];
export const APPROVE_ONLY = ['smartreport.template.approve'];
export const MANAGE_ONLY = ['smartreport.template.manage'];
export const MANAGE_READ = ['smartreport.template.manage', 'lab.result.read'];
export const REVIEW_PAGE = 'library/[library_version_id]/review/page';
export const WORDING_PAGE = 'wording/page';
export const TERMS = '/v1/smartreport/wording-deny-terms';
export const ORDER_ID = uid(900);

// ---------------------------------------------------------------- SR-05 fixtures: base = active v3 (VER_APPROVED), candidate = v4 in review (VER_REVIEW)
const ALT_X = uid(32);
const ALT_Y = uid(33);
const TXT_A = '{analyte_name} is above the reference range of your laboratory.';
export const BASE_BLOCKS = [
  blockDto({ id: uid(101), block_key: 'deranged.alt.high', kind: 'deranged', text_en: TXT_A, placeholders: ['analyte_name'] }),
  blockDto({ id: uid(102), block_key: 'advice.liver.general', kind: 'advice', text_en: 'Discuss {group_name} results with your doctor.', placeholders: ['group_name'] }),
  blockDto({ id: uid(103), block_key: 'followup.liver.retest', kind: 'followup', text_en: 'Consider {test_name} again in {interval_days} days.', placeholders: ['test_name', 'interval_days'] }),
  blockDto({ id: uid(104), block_key: 'advice.old.removed', kind: 'advice', text_en: 'Old advice for {group_name}.', placeholders: ['group_name'] }),
];
export const CAND_BLOCKS = [
  blockDto({ id: uid(111), block_key: 'deranged.alt.high', kind: 'deranged', text_en: TXT_A, placeholders: ['analyte_name'] }), // unchanged
  blockDto({ id: uid(112), block_key: 'advice.liver.general', kind: 'advice', text_en: 'Please talk to your doctor about {group_name} results.', placeholders: ['group_name'] }), // changed
  blockDto({ id: uid(113), block_key: 'followup.liver.retest', kind: 'followup', text_en: 'Consider {test_name} again in {interval_days} days.', placeholders: ['test_name', 'interval_days'] }), // unchanged
  blockDto({ id: uid(114), block_key: 'advice.new.one', kind: 'advice', text_en: 'New advice one for {group_name}.', placeholders: ['group_name'] }), // added
  blockDto({ id: uid(115), block_key: 'advice.new.two', kind: 'advice', text_en: 'New advice two for {group_name}.', placeholders: ['group_name'] }), // added
];
// rule identity for the diff = (rule_kind, trigger_kind, analyte_id | group_code, direction, block_key of block_id); "changed" = same identity, any other field differs.
export const BASE_RULES = [
  ruleDto({ id: uid(201), rule_kind: 'deranged', group_code: 'liver', direction: 'high', priority: 100, block_id: uid(101) }),
  ruleDto({ id: uid(202), rule_kind: 'advice', group_code: 'liver', direction: 'high', priority: 50, block_id: uid(102) }),
];
export const CAND_RULES = [
  ruleDto({ id: uid(211), rule_kind: 'deranged', group_code: 'liver', direction: 'high', priority: 100, block_id: uid(111) }), // unchanged
  ruleDto({ id: uid(212), rule_kind: 'advice', group_code: 'liver', direction: 'high', priority: 60, block_id: uid(112) }), // changed (priority)
  ruleDto({ id: uid(213), rule_kind: 'advice', group_code: 'liver', direction: 'high', priority: 40, block_id: uid(114) }), // added
];
const map = (analyte_id: string, group_code: string, include_in_score: boolean) => ({ analyte_id, group_code, include_in_score, trend_enabled: false, sort_order: 10, version: 1 });
export const BASE_MAPS = [map(ANALYTE_ALT, 'liver', true), map(ALT_X, 'liver', true), map(ALT_Y, 'kidney', true)];
export const CAND_MAPS = [map(ANALYTE_ALT, 'liver', false), map(ALT_X, 'liver', true)]; // ALT changed, Y removed
/** Expected "Changes since active version" counts for the fixtures above. */
export const EXPECTED_DIFF = { texts: { added: 2, changed: 1, removed: 1 }, rules: { added: 1, changed: 1, removed: 0 }, mapping: { added: 0, changed: 1, removed: 1 } };

export const reviewVersion = (over: Record<string, unknown> = {}) => versionDto({
  id: VER_REVIEW, version_no: 4, status: 'in_review', source_version_id: VER_APPROVED, version: 7, change_summary: 'Synthetic wording update',
  counts: { blocks: 5, rules: 3, analyte_groups: 2, groups_shown: 2 }, submitted_at: '2026-01-15T04:30:00.000Z', submitted_by_membership_id: MEMBER_PATH, ...over,
});
export const baseVersion = () => versionDto({ id: VER_APPROVED, version_no: 3, status: 'approved', version: 5, source_version_id: undefined });

/** Registers every read the SR-05 page may make: candidate `v` and the active version's lists, plus the version list. */
export function mountReviewApi(over: Record<string, unknown> = {}, v = VER_REVIEW) {
  const cand = reviewVersion({ id: v, ...over });
  routes[`GET ${SR}`] = json({ data: [summaryDto(), summaryDto({ id: v, version_no: 4, status: cand['status'], approved_at: undefined, approved_by_display_name: undefined, approved_by_membership_id: undefined, version: 7 })], page: { limit: 50 } });
  routes[`GET ${vp(v)}`] = json(cand);
  routes[`GET ${vp(v, '/blocks')}`] = json({ data: CAND_BLOCKS });
  routes[`GET ${vp(v, '/rules')}`] = json({ data: CAND_RULES });
  routes[`GET ${vp(v, '/analyte-groups')}`] = json({ data: CAND_MAPS });
  routes[`GET ${vp(v, '/groups')}`] = json({ data: GROUPS });
  routes[`GET ${vp(VER_APPROVED)}`] = json(baseVersion());
  routes[`GET ${vp(VER_APPROVED, '/blocks')}`] = json({ data: BASE_BLOCKS });
  routes[`GET ${vp(VER_APPROVED, '/rules')}`] = json({ data: BASE_RULES });
  routes[`GET ${vp(VER_APPROVED, '/analyte-groups')}`] = json({ data: BASE_MAPS });
  routes[`GET ${vp(VER_APPROVED, '/groups')}`] = json({ data: GROUPS });
  routes['GET /v1/smartreport/library/coded-sets/organ_groups'] = json(ORGAN_GROUPS);
}
export const showReview = (v = VER_REVIEW) => show(REVIEW_PAGE, { library_version_id: v });

// ---------------------------------------------------------------- step-up observation (the shell flow is not specified beyond "handled by the shell on auth.mfa_required")
export const loc = { reload: vi.fn(), assign: vi.fn(), replace: vi.fn() };
export function stubLocation() {
  loc.reload.mockClear(); loc.assign.mockClear(); loc.replace.mockClear();
  vi.stubGlobal('location', { ...window.location, href: window.location.href, reload: loc.reload, assign: loc.assign, replace: loc.replace });
}
/** True once the UI handed control to the shell: a page reload / location change, or a client navigation to an /auth/ route. */
export const steppedUp = () =>
  loc.reload.mock.calls.length + loc.assign.mock.calls.length + loc.replace.mock.calls.length > 0 ||
  [...router.push.mock.calls, ...router.replace.mock.calls].some(([t]) => /^\/auth\//.test(String(t)));

// ---------------------------------------------------------------- SR-06 fixtures
export const termDto = (over: Record<string, unknown> = {}) => ({ id: uid(300), term: 'guaranteed cure', language: 'en', scope: 'tenant', reason: 'Synthetic wording rule', is_active: true, version: 1, ...over });
export const GLOBAL_TERMS = [
  { term: 'http', language: 'any', scope: 'global', reason: 'global wording rule (04 R8)', is_active: true },
  { term: 'miracle', language: 'any', scope: 'global', reason: 'global wording rule', is_active: true },
];
export const TENANT_TERMS = [
  termDto(),
  termDto({ id: uid(301), term: 'sure thing', language: 'ne', reason: 'Synthetic', version: 3 }),
  termDto({ id: uid(302), term: 'old banned phrase', language: 'any', reason: undefined, is_active: false, version: 2 }),
];
export const mountTerms = (data: unknown[] = [...GLOBAL_TERMS, ...TENANT_TERMS]) => { routes[`GET ${TERMS}`] = json({ data }); };
export const showWording = () => show(WORDING_PAGE, {});

// ---------------------------------------------------------------- preview fixture (SmartSummaryPreview example from the contract)
export const PREVIEW = {
  status: 'preview', library_version_id: uid(2), template_library_version: 3, formula_version: 'hs-1', language: 'en', built_at: '2026-01-15T04:30:00.000Z', report_version_nos: [1],
  health_score: { value: 81, band: 'good', formula_version: 'hs-1', panels_scored: 3, explanation_text: 'Synthetic explanation of the score.' },
  panels: [
    { panel_code: 'glucose', display_name: 'Blood sugar', status: 'out_of_range', result_ids: [uid(800)] },
    { panel_code: 'liver', display_name: 'Liver', status: 'in_range', result_ids: [uid(801)] },
  ],
  deranged: [{ result_id: uid(800), analyte_id: ANALYTE_ALT, analyte_name: 'Synthetic Glucose', direction: 'high', severity: 'out_of_range', template_block_id: BLOCK_DERANGED, text: 'Your Synthetic Glucose result is above the reference range.' }],
  advice: [{ template_block_id: BLOCK_ADVICE, text: 'Synthetic advice text.' }],
  follow_ups: [{ rule_id: uid(20), suggested_test_code: 'SYN-HBA1C', suggested_test_name: 'Synthetic HbA1c', interval_days: 90, text: 'Consider a repeat test in 90 days.' }],
  trends: [],
  disclaimer_block_id: BLOCK_FOLLOWUP, disclaimer_text: 'This summary is not a diagnosis. Discuss your results with your doctor.',
  counts: { deranged: 1, critical: 0, unmapped_results: 2, ignored_duplicates: 0 }, llm: { enabled: false, use_llm_text: false }, reviews: [], unmapped_result_count: 2, ignored_duplicate_count: 0,
};
