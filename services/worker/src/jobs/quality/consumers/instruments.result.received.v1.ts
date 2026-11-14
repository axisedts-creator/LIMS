// instruments.result.received.v1 -> quality.qc_activity (02-TRD §10.2; AC-09.5). Reads ONLY payload.{instrument_id, analyte_id, mapping_status, received_at}:
// sample_barcode, values and flags are never stored or logged (03-IC §3.14, 07-SECURITY S-15/S-17). REQ-SEC-024: an event of another tenant is refused before any query.
// One statement: upsert the counter row of the ACTIVE plan of (tenant, instrument, analyte); no plan = no row. The inbox dedupes event ids before this handler.
// The row id is generated in SQL (app.uuidv7()) so a redelivery repeats the identical statement.
import type { ConsumerHandler } from '../../../core/manifest.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

const UPSERT_SQL = `INSERT INTO quality.qc_activity (id, tenant_id, plan_id, last_patient_result_at, patient_results_since_last_qc)
  SELECT app.uuidv7(), p.tenant_id, p.id, $4::timestamptz, 1
    FROM quality.qc_plans p WHERE p.tenant_id = $1 AND p.instrument_id = $2 AND p.analyte_id = $3 AND p.status = 'active'
  ON CONFLICT (tenant_id, plan_id) DO UPDATE SET
    last_patient_result_at = greatest(quality.qc_activity.last_patient_result_at, EXCLUDED.last_patient_result_at),
    patient_results_since_last_qc = CASE WHEN quality.qc_activity.last_qc_run_at IS NULL OR EXCLUDED.last_patient_result_at > quality.qc_activity.last_qc_run_at
      THEN quality.qc_activity.patient_results_since_last_qc + 1 ELSE quality.qc_activity.patient_results_since_last_qc END,
    updated_at = now()
  WHERE quality.qc_activity.tenant_id = $1`;

export const handle: ConsumerHandler = async (event, ctx) => {
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || !tenantId || event?.tenant_id !== tenantId) throw new Error('instruments.result.received.v1: event tenant does not match the job tenant');
  const p = (event as any).payload ?? {};
  if (p.mapping_status !== 'mapped' || p.analyte_id === undefined || p.analyte_id === null || p.analyte_id === '') return;   // unmapped results do not count
  const { instrument_id: instrumentId, analyte_id: analyteId, received_at: receivedAt } = p;
  if (typeof instrumentId !== 'string' || !UUID.test(instrumentId) || typeof analyteId !== 'string' || !UUID.test(analyteId)
    || typeof receivedAt !== 'string' || !ISO_UTC.test(receivedAt) || Number.isNaN(Date.parse(receivedAt))) {
    throw new Error('instruments.result.received.v1: malformed payload');   // fixed message: nothing of the payload is echoed
  }
  await ctx.tx.query(UPSERT_SQL, [tenantId, instrumentId, analyteId, receivedAt]);
};
