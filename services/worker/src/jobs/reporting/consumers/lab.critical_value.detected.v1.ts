// lab.critical_value.detected.v1 -> critical_value_alert deliveries (02-TRD §8.2, §7.2 steps 4-5; AC-14.1, AC-14.2; 08 A13 D-35; review fix #16).
// Referrer: one sms (if critical_alert_referrer_enabled; consent shareWithReferrer checked by resolveRecipient, REQ-SEC-006). Staff: one row per critical_alert_recipient,
// Phase 1 always suppressed no_contact (02-TRD §7.2 step 5). No value, analyte or link is copied anywhere. Idempotent per recipient: key <critical_event_id>:<kind>:<recipient id>.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { UUID_RE } from '../../../../../api/src/modules/reporting/domain/messages.js';
import { findLabReportOfOrder } from '../../../../../api/src/modules/reporting/repository/delivery.repo.js';
import { findSettings, listStaffAssignments } from '../../../../../api/src/modules/reporting/repository/settings.repo.js';
import { tenantFor } from '../../../../../api/src/modules/reporting/service/reports.service.js';
import { labParam } from '../../../../../api/src/modules/reporting/domain/messages.js';
import { insertDelivery } from '../../../../../api/src/modules/reporting/service/delivery.service.js';
import { port, startDelivery, type FlowCtx } from '../../../../../api/src/modules/reporting/service/delivery.flow.service.js';

const PURPOSE = 'critical_value_alert';
const TEMPLATE = 'reporting.critical_value_alert';
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export const handle: ConsumerHandler = async (event, jobCtx) => {
  const ctx = jobCtx as unknown as FlowCtx;
  const tenantId = tenantFor(event, ctx);
  const p = event.payload as Record<string, unknown>;
  const ceId = p?.['critical_event_id']; const centreId = p?.['centre_id']; const orderId = p?.['order_id']; const patientId = p?.['patient_id']; const referrerId = p?.['referrer_id'];
  if (!uuid(ceId) || !uuid(centreId) || !uuid(orderId) || !uuid(patientId) || (referrerId != null && !uuid(referrerId))) return;   // malformed: nothing to alert

  const tx = ctx.tx as any;
  const settings = (await findSettings(tx, tenantId)) ?? {};
  const branding = (await port(ctx, 'IdentityPort', 'identity').getTenantSettings(ctx, { keys: ['branding'] }))?.branding;
  const phone = Array.isArray(branding?.phones) ? branding.phones[0] : undefined;
  const params: Record<string, string> = { lab_name: labParam(branding?.displayName), ...(typeof phone === 'string' && phone ? { lab_phone: phone } : {}), ref: ceId.slice(0, 8) };
  const reportId = (await findLabReportOfOrder(tx, tenantId, orderId))?.id ?? null;
  const common = { channel: 'sms' as const, purpose: PURPOSE, templateCode: TEMPLATE, centreId, params, reportId, relatedType: 'critical_event', relatedId: ceId };

  if (referrerId && settings.critical_alert_referrer_enabled !== false) {
    await startDelivery(ctx, { ...common, kind: 'referrer', recipientId: referrerId, patientId, key: `${ceId}:referrer:${referrerId}`, versionNo: null, deferredLink: null });
  }
  for (const a of await listStaffAssignments(tx, tenantId, 'critical_alert_recipient')) {
    if (a.is_active === false) continue;
    await insertDelivery(ctx, {
      ...common, id: uuidv7() as string, recipientKind: 'staff', recipientId: a.membership_id, destinationMasked: null, destinationSha256: null, destinationE164: null,
      idempotencyKey: `${ceId}:staff:${a.membership_id}`, reportVersionNo: null, status: 'suppressed', failureCode: 'no_contact', deferredLink: null,
    });
  }
};
