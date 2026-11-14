// C9.T-23 shared harness (tester-owned; not a test file). Re-uses the T-21 MSW server, session/navigation mocks and DOM helpers; adds auto-verify fixtures
// that follow contracts/openapi/quality.yaml (AutoverifyRuleSetDto, AutoverifyVersionDto, SimulationReportDto, AutoverifyDecisionDto, QualitySettingsDto). Synthetic data only.
// Each test file registers three mocks pointing here:
//   vi.mock('next/navigation', async () => (await import('./av-t23.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./av-t23.harness')).sessionMock)
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpResponse } from 'msw';
export * from '../../../../../features/quality/__tests__/quality-t21.harness';
import { state, routes, json } from '../../../../../features/quality/__tests__/quality-t21.harness';

const id = (n: number) => `01a1a98a-ac40-7000-8000-0000000c${String(n).padStart(4, '0')}`;
export const RULE_SET = id(5000);
export const V_RETIRED = id(5001);
export const V_STOPPED = id(5002);
export const V_ACTIVE = id(5003);
export const V_SIM = id(5004);
export const V_DRAFT = id(5005);
export const V_DISCARDED = id(5006);
export const V_NEW = id(5007);
export const TEST_K = id(5100);
export const AN_K = id(5101);
export const AN_NA = id(5102);
export const INST_A = id(5103);
export const RESULT_1 = id(5200);
export const ORDER_1 = id(5201);
export const DEC = (n: number) => id(5300 + n);
export const QC_RUN = id(5400);

export const AV_READ = ['quality.autoverify.read'];
export const AV_MANAGE = ['quality.autoverify.read', 'quality.autoverify.manage'];

export const AV = '/v1/quality/autoverify';
export const apiOf = (v: string, tail = '') => `${AV}/versions/${v}${tail}`;

export const rule = (over: Record<string, unknown> = {}) => ({
  key: 'K_ANY', test_id: TEST_K, analyte_id: AN_K, enabled: true, limits: { low: '3.5', high: '5.1' }, allowed_range_flags: ['N'],
  instrument_flags_allowed: [], qc_allow_warning: false, note: 'Synthetic potassium rule', ...over,
});
export const RULES = [
  rule(),
  rule({ key: 'NA_I1', analyte_id: AN_NA, instrument_id: INST_A, limits: { low: '135', high: '145' }, allowed_range_flags: ['N', 'L'], qc_allow_warning: true, note: undefined, instrument_flags_allowed: ['SYN_FLAG'] }),
];

export const versionDto = (over: Record<string, unknown> = {}) => ({
  id: V_DRAFT, rule_set_id: RULE_SET, version_no: 5, version: 3, status: 'draft', definition: { schema_version: 1, rules: RULES }, rule_count: 2,
  created_at: '2026-11-10T03:15:00.000Z', created_by_display: 'Synthetic Author', ...over,
});
const summary = (o: Record<string, unknown>) => ({ rule_count: 2, created_at: '2026-11-01T03:15:00.000Z', created_by_display: 'Synthetic Author', ...o });
export const ruleSetDto = (over: Record<string, unknown> = {}) => ({
  id: RULE_SET, version: 7, active_version_id: V_ACTIVE, simulating_version_id: V_SIM,
  versions: [
    summary({ id: V_DISCARDED, version_no: 6, status: 'discarded' }),
    summary({ id: V_DRAFT, version_no: 5, status: 'draft' }),
    summary({ id: V_SIM, version_no: 4, status: 'simulating', simulation_started_at: '2026-11-09T03:15:00.000Z' }),
    summary({ id: V_ACTIVE, version_no: 3, status: 'active', rule_count: 12, activated_at: '2026-11-05T04:00:00.000Z', activated_by_display: 'Synthetic Approver' }),
    summary({ id: V_STOPPED, version_no: 2, status: 'stopped', simulation_started_at: '2026-10-01T03:15:00.000Z', simulation_stopped_at: '2026-10-04T03:15:00.000Z' }),
    summary({ id: V_RETIRED, version_no: 1, status: 'retired', activated_at: '2026-09-01T04:00:00.000Z', activated_by_display: 'Synthetic Approver', retired_at: '2026-11-05T04:00:00.000Z' }),
  ],
  ...over,
});
export const settingsDto = (over: Record<string, unknown> = {}) => ({ sim_min_days: 7, sim_min_decisions: 100, auto_verification_enabled: true, westgard_mode: 'classic', ...over });
export const reportDto = (over: Record<string, unknown> = {}) => ({
  version_id: V_SIM, started_at: '2026-11-09T03:15:00.000Z', days_running: 8, decisions: 240, would_allow: 180, would_deny: 60,
  deny_by_reason: { outside_autoverify_limits: 40, qc_warning: 20 }, allow_later_manually_verified: 170, allow_not_verified_yet: 10,
  live_comparison: { both_allow: 0, live_only_allow: 0, shadow_only_allow: 180 },
  sample: [
    { decision_id: DEC(1), result_id: RESULT_1, order_id: ORDER_1, analyte_id: AN_K, decided_at: '2026-11-10T04:00:00.000Z', shadow_decision: 'allow', shadow_reasons: [], live_decision: 'deny', manually_verified_at: '2026-11-10T04:30:00.000Z' },
    { decision_id: DEC(2), result_id: id(5202), analyte_id: AN_NA, decided_at: '2026-11-10T05:00:00.000Z', shadow_decision: 'allow', shadow_reasons: [] },
  ],
  ...over,
});
export const decisionDto = (n: number, over: Record<string, unknown> = {}) => ({
  id: DEC(n), decided_at: '2026-11-14T04:00:00.000Z', mode: 'live', decision: 'allow', reasons: [], result_id: RESULT_1, analyte_id: AN_K, instrument_id: INST_A, version_id: V_ACTIVE,
  matched_rule_key: 'K_ANY', qc_status: 'in_control', qc_run_id: QC_RUN, ...over,
});
export const DECISIONS = [
  decisionDto(1),
  decisionDto(2, { mode: 'shadow', decision: 'deny', reasons: ['outside_autoverify_limits', 'qc_warning'], qc_status: 'warning', version_id: V_SIM }),
  decisionDto(3, { decision: 'deny', reasons: ['critical', 'delta_failure', 'instrument_flag', 'qc_out_of_control', 'qc_no_data', 'manual_origin', 'rule_missing'], qc_status: 'out_of_control', matched_rule_key: undefined, instrument_id: undefined }),
];
export const decisionDetail = (n: number) => ({
  ...DECISIONS[n - 1], inputs: { value_numeric: '5.2', range_flag: 'H', delta_check_failed: false, is_critical: false, instrument_flags: ['SYN_FLAG'], resulted_at: '2026-11-14T03:59:30.000Z' },
});

/** Standard routes for a signed-in reader/manager on the overview + editor pages. */
export function seedAv(version: Record<string, unknown> = versionDto()) {
  routes[`GET ${AV}/rule-set`] = json(ruleSetDto());
  routes['GET /v1/quality/settings'] = json(settingsDto());
  routes[`GET ${apiOf(String(version['id']))}`] = json(version);
  routes[`GET ${apiOf(V_SIM, '/simulation-report')}`] = json(reportDto());
  routes[`GET ${apiOf(V_STOPPED, '/simulation-report')}`] = json(reportDto({ version_id: V_STOPPED }));
  routes[`GET ${AV}/decisions`] = json({ data: DECISIONS, page: { limit: 50 } });
}
export { state };
export const mfa = () => HttpResponse.json({ type: 'urn:lims:error:auth.mfa_required', title: 'auth.mfa_required', status: 403, code: 'auth.mfa_required' }, { status: 403 });

// ---------------------------------------------------------------- source scan helpers
export const AV_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === '__tests__' ? [] : walk(p)) : [p]; }) : []);
export const srcOf = (f: string) => readFileSync(f, 'utf8');
