// In-app notification rows (02-TRD §4.9; 05-SCHEMA notifications): created by the system actor, no text stored (the app renders `patient_app.notification.<kind>`), expire after 180 days [CONV].
// One row per (account, kind, entity, entity_seq): INSERT .. ON CONFLICT DO NOTHING makes event redelivery a no-op. P1 data: nothing here logs a value.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

export interface NotificationIn {
  accountId: string; patientId: string | null; kind: 'report_ready' | 'sample_recollection'; entityType: 'order' | 'report'; entityId: string; entitySeq: number; routeId: 'patient_app.report' | 'patient_app.order';
}
const TTL_MS = 180 * 86_400_000; // [CONV]
const COLS = 11;

export function createNotificationService() {
  return {
    async create(ctx: { tx: any; tenantId: string; actor: { id: string }; now: () => string }, rows: readonly NotificationIn[]): Promise<void> {
      if (rows.length === 0) return;
      const expires = new Date(Date.parse(ctx.now()) + TTL_MS).toISOString();
      const values: unknown[] = [];
      for (const n of rows) values.push(uuidv7(), ctx.tenantId, n.accountId, n.patientId, n.kind, n.entityType, n.entityId, n.entitySeq, n.routeId, ctx.actor.id, expires);
      const tuples = rows.map((_, i) => `(${Array.from({ length: COLS }, (_, j) => `$${i * COLS + j + 1}`).join(', ')})`).join(', ');
      await ctx.tx.query(
        `INSERT INTO engagement.notifications (id, tenant_id, account_id, patient_id, kind, entity_type, entity_id, entity_seq, route_id, created_by, expires_at)
         VALUES ${tuples} ON CONFLICT (tenant_id, account_id, kind, entity_id, entity_seq) DO NOTHING`, values);
    },
  };
}
export type NotificationService = ReturnType<typeof createNotificationService>;
