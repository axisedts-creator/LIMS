// settings.service.ensure (02-TRD §12.1 Bootstrap; 08 A17 D-56, P-22): the first ensure for a tenant fixes activated_at.
// INSERT ... ON CONFLICT (tenant_id) DO NOTHING, then read the row (race-safe: no check-then-insert), then ensure sync_state from THAT row's activated_at.
// Tenant and actor are explicit: the Tx facade carries neither. Runs in the caller's transaction; DB errors propagate.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { getSettings, insertSettingsDefaults, insertSyncState, type SettingsTx } from '../repository/settings.repo.js';

export interface QualitySettings {
  readonly id: string;
  readonly tenantId: string;
  readonly tatAlertsEnabled: boolean;
  readonly tatWarnPct: number;
  readonly tatEscalatePct: number;
  readonly tatOrphanCloseHours: number;
  readonly targetMinPoints: number;
  readonly simMinDays: number;
  readonly simMinDecisions: number;
  readonly reprocessWindowDays: number;
  readonly defaultPlanParams: Record<string, unknown>;
  readonly activatedAt: Date | string;
  readonly isActive: boolean;
  readonly version: number;
}

const toSettings = (r: Record<string, any>): QualitySettings => ({
  id: r['id'], tenantId: r['tenant_id'], tatAlertsEnabled: r['tat_alerts_enabled'], tatWarnPct: r['tat_warn_pct'], tatEscalatePct: r['tat_escalate_pct'],
  tatOrphanCloseHours: r['tat_orphan_close_hours'], targetMinPoints: r['target_min_points'], simMinDays: r['sim_min_days'],
  simMinDecisions: r['sim_min_decisions'], reprocessWindowDays: r['reprocess_window_days'], defaultPlanParams: r['default_plan_params'],
  activatedAt: r['activated_at'], isActive: r['is_active'], version: r['version'],
});

export function createSettingsService() {
  return {
    async ensure(tx: SettingsTx, who: { tenantId: string; actorId: string }): Promise<QualitySettings> {
      await insertSettingsDefaults(tx, { id: uuidv7(), tenantId: who.tenantId, actorId: who.actorId });
      const row = await getSettings(tx, who.tenantId);
      if (!row) throw new Error('quality.settings row missing after ensure'); // RLS / tenant FK problem: never fabricate defaults
      await insertSyncState(tx, { id: uuidv7(), tenantId: who.tenantId, activatedAt: row['activated_at'] });
      return toSettings(row);
    },
  };
}
