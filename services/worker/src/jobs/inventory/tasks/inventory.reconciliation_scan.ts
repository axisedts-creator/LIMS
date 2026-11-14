// inventory.reconciliation_scan (02-TRD §9; PRD AC-21.7 alert part; 08 A13 P-6 per_tenant, A17 D-74): yesterday's reconciliation, TEST BLOCK ONLY. Per test: C12 verified_result_events
// (test_counts_daily, summed over instruments) vs lab.v_pub_result_daily.results_verified (summed). A gap above settings.reconciliation_gap_alert_bp on a day with >= 50 events raises ONE open
// `reconciliation_gap` alert carrying test_id. The instrument QC block (instrument_qc_daily vs qc_records) is report-only: it raises no alert [CONV, D-74]. Reads as the system actor.
// [CONV] events = greatest(c12, lab); diff_bp = round(abs(c12 - lab) * 10000 / events).
import type { TaskHandler } from '../../../core/manifest.js';
import { addDaysYmd, ymdIn } from '../../../../../api/src/modules/inventory/domain/tenantTime.js';
import { query } from '../../../../../api/src/modules/inventory/repository/_base.js';
import { getSettings } from '../../../../../api/src/modules/inventory/repository/settings.repo.js';
import { jobScope, raiseAlerts, tenantClock } from './_shared.js';

export const RECONCILIATION_SCAN = 'inventory.reconciliation_scan';
const DEFAULT_GAP_BP = 200;
const MIN_EVENTS = 50;

const GAPS = `WITH c AS (SELECT test_id, sum(verified_result_events)::bigint AS n FROM inventory.test_counts_daily WHERE tenant_id = $1 AND business_date = $2::date GROUP BY test_id),
  l AS (SELECT test_id, sum(results_verified)::bigint AS n FROM lab.v_pub_result_daily WHERE tenant_id = $1 AND business_date = $2::date GROUP BY test_id),
  g AS (SELECT coalesce(c.test_id, l.test_id) AS test_id, coalesce(c.n, 0) AS c12, coalesce(l.n, 0) AS lab FROM c FULL JOIN l ON l.test_id = c.test_id)
SELECT test_id, c12, lab, round(abs(c12 - lab) * 10000.0 / greatest(c12, lab))::int AS diff_bp FROM g
 WHERE test_id IS NOT NULL AND greatest(c12, lab) >= $3::int AND round(abs(c12 - lab) * 10000.0 / greatest(c12, lab)) > $4::int ORDER BY test_id`;

export const reconciliationScan: TaskHandler = async (payload, jobCtx) => {
  const rc = jobScope('reconciliation_scan', payload, jobCtx);
  if (rc === null) return;
  const clock = await tenantClock(jobCtx);
  const day = addDaysYmd(ymdIn(clock.nowMs, clock.tz), -1);
  const bp = Number((await getSettings(rc))?.['reconciliation_gap_alert_bp'] ?? DEFAULT_GAP_BP);
  const gaps = await query(rc, GAPS, [day, MIN_EVENTS, bp]);
  await raiseAlerts(rc, 'reconciliation_gap', gaps.map((g) => ({
    test_id: g['test_id'], key: `reconciliation_gap:${g['test_id']}:${day}`, details: { business_date: day, c12_verified_result_events: Number(g['c12']), lab_results_verified: Number(g['lab']), diff_bp: g['diff_bp'] },
  })));
};
