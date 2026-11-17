// Task reporting.dispatch_release_deliveries (02-TRD §4.6 rules 4/6, §4.8, §9; 01-PRD AC-08.1, AC-09.4; 07-SECURITY REQ-SEC-006/070).
// Enqueued by the release transaction (job key dispatch:<version id>). For a still-`released` version it creates the report_ready deliveries of its audiences through the
// internal delivery service: patient (first usable mobile channel + e-mail in addition), referrer (REQ-SEC-006 consent), centre (one per active contact), partner (Phase 1: none).
// A recipient that cannot be reached creates nothing here (the send task / D3 write `suppressed` rows). Re-running is a no-op: deterministic idempotency keys.
// [CONV] key format: <version id>:report_ready:<kind>:<channel>[:<centre contact id>].
import type { TaskHandler } from '../../../core/manifest.js';
import { findQrSnapshot, findReferrerDisabledChannels, findReportMeta, findVersion, listActiveCentreContacts } from '../../../../../api/src/modules/reporting/repository/delivery.repo.js';
import { findSettings } from '../../../../../api/src/modules/reporting/repository/settings.repo.js';
import { labParam } from '../../../../../api/src/modules/reporting/domain/messages.js';
import { resolveRecipient, startDelivery, type FlowCtx } from '../../../../../api/src/modules/reporting/service/delivery.flow.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Ch = 'whatsapp' | 'sms' | 'email';
const DEFAULTS = { patient_mobile_channel_order: ['whatsapp', 'sms'], patient_email_enabled: true, referrer_delivery_enabled: true, referrer_channels: ['sms'], centre_delivery_enabled: false };

export const dispatchReleaseDeliveries: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as unknown as FlowCtx & { log?: any };
  const tenantId = ctx.tenantId; const versionId = payload?.['report_version_id'];
  if (typeof tenantId !== 'string' || payload?.['tenant_id'] !== tenantId || typeof versionId !== 'string' || !UUID.test(versionId)) {
    ctx.log?.warn?.({ event: 'dispatch_release_deliveries_skipped', reason: 'bad_payload' });
    return;
  }
  const tx = ctx.tx as any;
  const v = await findVersion(tx, tenantId, versionId);
  if (!v || v.status !== 'released') return;                        // not (or no longer) released: nothing to deliver
  const audiences = v.audiences ?? [];
  if (audiences.includes('print_only')) return;                     // suppress_notifications
  const report = await findReportMeta(tx, tenantId, v.report_id);
  if (!report) return;
  const s = { ...DEFAULTS, ...((await findSettings(tx, tenantId)) ?? {}) };
  const lab = labParam((await findQrSnapshot(tx, tenantId, v.report_id))?.lab_name_snapshot);

  const make = (channel: Ch, kind: string, recipientId: string | null, suffix = '') => startDelivery(ctx, {
    channel, purpose: 'report_ready', templateCode: 'reporting.report_ready', kind, recipientId, patientId: report.patient_id, centreId: report.centre_id,
    params: { lab_name: lab }, key: `${versionId}:report_ready:${kind}:${channel}${suffix}`, reportId: v.report_id, versionNo: v.version_no,
    deferredLink: { report_id: v.report_id, version_no: v.version_no, channel, recipient_kind: kind },
  }, true);
  const usable = (channel: Ch, kind: string, recipientId: string | null) => resolveRecipient(ctx, { channel, purpose: 'report_ready', kind, recipientId, patientId: report.patient_id });

  if (audiences.includes('patient')) {
    for (const ch of s.patient_mobile_channel_order as Ch[]) {
      if (ch !== 'whatsapp' && ch !== 'sms') continue;
      if ((await usable(ch, 'patient', report.patient_id)).ok) { await make(ch, 'patient', report.patient_id); break; }
    }
    if (s.patient_email_enabled && (await usable('email', 'patient', report.patient_id)).ok) await make('email', 'patient', report.patient_id);
  }

  if (audiences.includes('referrer') && s.referrer_delivery_enabled && report.referrer_id) {
    const disabled = await findReferrerDisabledChannels(tx, tenantId, report.referrer_id);
    for (const ch of (s.referrer_channels as Ch[]).filter((c) => !disabled.includes(c))) {
      if ((await usable(ch, 'referrer', report.referrer_id)).ok) { await make(ch, 'referrer', report.referrer_id); break; }
    }
  }

  if (audiences.includes('centre') && s.centre_delivery_enabled) {
    for (const c of await listActiveCentreContacts(tx, tenantId, report.centre_id)) {
      if ((c.channel === 'whatsapp' || c.channel === 'sms' || c.channel === 'email') && (await usable(c.channel, 'centre', c.id)).ok) await make(c.channel, 'centre', c.id, `:${c.id}`);
    }
  }
  // partner: Phase 1 sends nothing (no partner contact is resolvable, review fix #30)
};
