// C9.T-24 shared test harness (tester-owned; not a test file). Builds on the T-22 harness (MSW, session/navigation mocks, DOM + dialog helpers).
// Fixtures follow contracts/openapi/quality.yaml (TatAlertDto, QualitySettingsDto, QualityCode). Synthetic data only.
// Each test file registers the same three mocks as T-21 (see quality-t21.harness.tsx header), pointing at ./quality-t24.harness.
import { HttpResponse } from 'msw';
import { resetApi as resetT22, routes } from './quality-t22.harness';

export * from './quality-t22.harness';

const id = (n: number) => `01a1a98a-ac40-7000-8000-0000000c${String(n).padStart(4, '0')}`;
export const TAT_1 = id(6000);
export const TAT_2 = id(6001);
export const TAT_3 = id(6002);
export const TAT_4 = id(6003);
export const DEPT_1 = id(6100);
export const CENTRE_1 = id(6200);
export const CENTRE_2 = id(6201);
export const SPEC_1 = id(6300);

export const PERM_TAT_READ = ['quality.tat_alert.read'];
export const PERM_TAT_ACK = ['quality.tat_alert.read', 'quality.tat_alert.ack'];
export const PERM_CFG_READ = ['quality.qc_run.read'];
export const PERM_CFG_WRITE = ['quality.qc_run.read', 'quality.config.manage'];

export const TAT = '/v1/quality/tat-alerts';
export const SETTINGS = '/v1/quality/settings';
export const WITHIN_LAB = 'Within lab: received → first verified result';
export const TOTAL = 'Total: registration → report released';

export const tatAlert = (over: Record<string, unknown> = {}) => ({
  tat_item_id: TAT_1, version: 5, order_id: id(6400), order_item_id: id(6401), test_id: id(6402), test_code: 'GLU', department_id: DEPT_1, specimen_id: SPEC_1, centre_id: CENTRE_1,
  priority: 'urgent', segment: 'within_lab', segment_label: WITHIN_LAB, start_basis: 'specimen_received_at', target_seconds: 14400, started_at: '2026-11-14T00:00:00.000Z',
  elapsed_seconds: 15120, pct_of_target: 105, alert_level: 'breached', state: 'running', ...over,
});
export const TAT_ROWS = [
  tatAlert(), // breached, urgent, within_lab, 4 h 12 min / 4 h, 105 %
  tatAlert({ tat_item_id: TAT_2, version: 2, test_code: 'TSH', priority: 'routine', segment: 'total', segment_label: TOTAL, start_basis: 'registered_at', target_seconds: 86400, elapsed_seconds: 90000, pct_of_target: 104, alert_level: 'escalated', centre_id: CENTRE_2, specimen_id: undefined }),
  tatAlert({ tat_item_id: TAT_3, version: 1, test_code: 'CRE', priority: 'routine', target_seconds: 7200, elapsed_seconds: 5760, pct_of_target: 80, alert_level: 'warning' }),
  tatAlert({ tat_item_id: TAT_4, version: 4, test_code: 'NAK', priority: 'routine', alert_level: 'breached', acknowledged_level: 'warning', acknowledged_at: '2026-11-14T03:10:00.000Z', acknowledged_by_display: 'Synthetic Supervisor' }),
];
export const tatPage = (rows: unknown[] = TAT_ROWS, extra: Record<string, unknown> = {}) => ({ data: rows, page: { limit: 50 }, generated_at: '2026-11-14T04:00:00.000Z', ...extra });

export const settingsDto = (over: Record<string, unknown> = {}) => ({
  version: 7, tat_alerts_enabled: true, tat_warn_pct: 80, tat_escalate_pct: 150, tat_orphan_close_hours: 72, target_min_points: 20, sim_min_days: 14, sim_min_decisions: 500,
  reprocess_window_days: 7, default_plan_params: { mean_rule: '10x', run_window_minutes: 30 }, activated_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-10T00:00:00.000Z',
  updated_by_display: 'Synthetic Manager', westgard_mode: 'classic', auto_verification_enabled: false, ...over,
});
export const codedSet = (rows: Record<string, unknown>[]) => ({ data: rows, page: { limit: 50 } });
export const CORRECTIVE = [
  { code: 'recalibrated', display: 'Recalibrated', sort_order: 1, is_active: true, source: 'global' },
  { code: 'new_reagent', display: 'New reagent opened', sort_order: 2, is_active: false, source: 'tenant' },
];
export const EXCLUSION = [{ code: 'sample_error', display: 'Sample handling error', sort_order: 1, is_active: true, source: 'global' }];

export function resetApi(permissions: string[] = PERM_TAT_READ) {
  resetT22(permissions);
  routes[`GET ${TAT}`] = () => HttpResponse.json(tatPage());
  routes[`GET ${SETTINGS}`] = () => HttpResponse.json(settingsDto());
  routes['GET /v1/quality/coded-sets/corrective_actions'] = () => HttpResponse.json(codedSet(CORRECTIVE));
  routes['GET /v1/quality/coded-sets/exclusion_reasons'] = () => HttpResponse.json(codedSet(EXCLUSION));
}
