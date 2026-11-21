// T0B-SYNC-4 done_when (3) (LD-322 decision 2, LD-325 b; design C:/LIMS-state/offline-design-20261117.md sections 3 and 8): offline adapter of
// report.print_marker (reporting.report.print), entity_id = report_version_id. The print already happened on the device (watermark issued offline,
// pending sync): the server only RECORDS it, never prints again. The marker is stored pending with the results the report version shows; it is
// confirmed when no sign off it relied on was rejected and every result is final on the server, recall_required (+ an alert to the lab manager
// with the report id) when one was rejected (core/sync/offlineSignoffs.ts settleMarker; later sign offs settle it from result.verify). The access
// audit event of the print carries the device time and the op id.
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext } from '../../../core/module.js';
import { payloadShape, type SyncAdapter } from '../../../core/sync/engine.js';
import { settleMarker, syncAlerts, syncSignoffs, type Alerts, type ReadResult, type Signoffs } from '../../../core/sync/offlineSignoffs.js';
import { readResultState } from '../../lab/sync/resultEnter.adapter.js';

export type ResultsOfReport = (ctx: HandlerContext, reportVersionId: string) => Promise<string[] | undefined>;

/** Default seam: the reportable results of the order items the report version shows, under RLS (centre scope of reporting.report_versions:
 *  out of scope == unknown). A discarded version is unknown, as on the online print path. */
export const reportResults: ResultsOfReport = async (ctx, id) => {
  const tx = (ctx as any).tx;
  const v = (await tx.query(`SELECT order_item_ids FROM reporting.report_versions WHERE tenant_id = $1 AND id = $2 AND status <> 'discarded'`, [ctx.tenantId, id])).rows[0];
  if (!v) return undefined;
  const r = await tx.query(`SELECT id FROM lab.results WHERE tenant_id = $1 AND order_item_id = ANY($2::uuid[]) AND is_reportable AND status <> 'cancelled' ORDER BY id LIMIT 2000`,
    [ctx.tenantId, v.order_item_ids]);
  return r.rows.map((x: { id: string }) => x.id);
};

const validShape = payloadShape('reporting.yaml', 'CreateReportPrintRequest');

export function createReportPrintMarkerAdapter(deps: { resultsOfReport?: ResultsOfReport; readResult?: ReadResult; signoffs?: Signoffs; alerts?: Alerts } = {}): SyncAdapter {
  const resultsOfReport = deps.resultsOfReport ?? reportResults;
  const d = { readResult: deps.readResult ?? readResultState, signoffs: deps.signoffs ?? syncSignoffs, alerts: deps.alerts ?? syncAlerts };
  return {
    opType: 'report.print_marker', permission: 'reporting.report.print',
    validate(payload) {
      validShape(payload);
      const p = payload as Record<string, unknown>;
      if ((p['variant'] !== 'letterhead' && p['variant'] !== 'plain') || typeof p['copies'] !== 'number' || !Number.isInteger(p['copies']) || p['copies'] < 1 || p['copies'] > 5) {
        throw new LimsError('common.validation_failed');
      }
    },
    async execute(ctx, op) {
      const reportVersionId = op.entityId!;
      const resultIds = await resultsOfReport(ctx, reportVersionId);
      if (!resultIds) throw new LimsError('common.not_found');
      await d.signoffs.addMarker(ctx, { opId: op.opId, reportVersionId, resultIds, deviceId: op.deviceId, deviceCreatedAt: op.deviceCreatedAt });
      await (ctx as any).audit.access({ action: 'report.print', entityType: 'report_version', entityId: reportVersionId, outcome: 'allowed',
        detail: { offline: true, op_id: op.opId, device_created_at: op.deviceCreatedAt } });
      await settleMarker(ctx, d, { opId: op.opId, reportVersionId, deviceId: op.deviceId, resultIds, state: 'pending' });
      return { entityId: reportVersionId };
    },
  };
}

export const reportPrintMarkerAdapter: SyncAdapter = createReportPrintMarkerAdapter();
