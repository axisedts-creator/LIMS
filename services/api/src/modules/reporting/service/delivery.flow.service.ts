// Shared delivery logic of the dispatch / send / fallback tasks and the D3 / D4 endpoints (02-TRD §4.8, §7.2 steps 4-5).
// resolveRecipient = tenant channel switch -> consent -> contact (the same rules at creation time and again at send time).
// startDelivery = resolve + insert (queued or suppressed). createSmsFallback = the single SMS fallback of a WhatsApp delivery.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { hasConsent, maskAddress, sha256, type MessageChannel } from '../domain/messages.js';
import { findCentreContact, findFallbackOf, findReportMeta } from '../repository/delivery.repo.js';
import type { Tx } from '../repository/settings.repo.js';
import { insertDelivery, type DeliveryCtx } from './delivery.service.js';

export type Failure = 'channel_disabled' | 'no_consent' | 'no_contact';
export type Resolved = { ok: true; address: string | null; recipientId: string | null } | { ok: false; failure: Failure };
export interface FlowCtx extends DeliveryCtx { readonly ports: Record<string, any> }

const SWITCH = { sms: 'smsEnabled', whatsapp: 'whatsappEnabled', email: 'emailEnabled' } as const;
/** Both spellings exist in this codebase (NotificationPort.impl: FrontdeskPort, release.service: frontdesk). */
export const port = (ctx: FlowCtx, a: string, b: string): any => ctx.ports[a] ?? ctx.ports[b];
const tx = (ctx: FlowCtx) => ctx.tx as Tx;

export interface Recipient {
  channel: MessageChannel; purpose: string; kind: string; recipientId: string | null;
  patientId?: string | null;          // owner of the consents (referrer deliveries need shareWithReferrer of this patient)
  e164?: string | null;               // phone_otp destination
  centreId?: string | null;           // centre contacts must belong to the delivery's centre (05-SCHEMA §2.8)
}

export async function resolveRecipient(ctx: FlowCtx, r: Recipient): Promise<Resolved> {
  const settings = await port(ctx, 'IdentityPort', 'identity').getTenantSettings(ctx, { keys: ['channels'] });
  if (settings?.channels?.[SWITCH[r.channel]] !== true) return { ok: false, failure: 'channel_disabled' };
  const phoneChannel = r.channel !== 'email';
  const fd = port(ctx, 'FrontdeskPort', 'frontdesk');
  switch (r.kind) {
    case 'patient': {
      if (!r.recipientId) return { ok: false, failure: 'no_contact' };
      const d = await fd.getPatientDemographics(ctx, { patientId: r.recipientId, purpose: 'notification' });
      if (!hasConsent(d?.consents, r.channel, r.purpose)) return { ok: false, failure: 'no_consent' };
      const raw = r.channel === 'email' ? d?.email : d?.phoneE164;
      // Non-system callers get contactPresence only (CR-C6-015); the send task re-reads the contact as the system actor.
      const present = d?.contactPresence ? (r.channel === 'email' ? d.contactPresence.email : d.contactPresence.phone) === true : typeof raw === 'string' && raw.length > 0;
      if (!present) return { ok: false, failure: 'no_contact' };
      return { ok: true, address: typeof raw === 'string' && raw ? raw : null, recipientId: r.recipientId };
    }
    case 'referrer': {
      if (!r.recipientId || !r.patientId) return { ok: false, failure: 'no_contact' };
      const d = await fd.getPatientDemographics(ctx, { patientId: r.patientId, purpose: 'notification' });
      if (d?.consents?.shareWithReferrer !== true) return { ok: false, failure: 'no_consent' };   // REQ-SEC-006
      let ref: any;
      try { ref = await port(ctx, 'CatalogPort', 'catalog').getReferrer(ctx, { referrerId: r.recipientId, purpose: 'notification' }); } catch (e) {
        if ((e as { code?: string })?.code === 'common.not_found') return { ok: false, failure: 'no_contact' };
        throw e;
      }
      const raw = phoneChannel ? (ref?.phoneE164 ?? ref?.phone) : ref?.email;
      return typeof raw === 'string' && raw ? { ok: true, address: raw, recipientId: r.recipientId } : { ok: false, failure: 'no_contact' };
    }
    case 'centre': {
      const c = r.recipientId ? await findCentreContact(tx(ctx), ctx.tenantId, r.recipientId) : undefined;
      return c && c.is_active && c.channel === r.channel && c.address && (!r.centreId || c.centre_id === r.centreId) ? { ok: true, address: c.address, recipientId: c.id } : { ok: false, failure: 'no_contact' };
    }
    case 'phone_otp':
      return r.e164 ? { ok: true, address: r.e164, recipientId: null } : { ok: false, failure: 'no_contact' };
    default:   // partner: Phase 1 sends nothing; staff contacts are re-resolved with a permission this task does not know (open point C6-T23-impl.md)
      return { ok: false, failure: 'no_contact' };
  }
}

export interface Start {
  channel: MessageChannel; purpose: string; templateCode: string; kind: string; recipientId: string | null; patientId?: string | null; centreId: string | null;
  params: Record<string, string>; key: string; reportId: string | null; versionNo: number | null; deferredLink: Record<string, unknown> | null;
  relatedType?: string | null; relatedId?: string | null; fallbackOf?: string | null; id?: string;
}
/** Resolves and inserts. `onlyIfOk`: a recipient that cannot be reached creates nothing (dispatch / fallback). Otherwise a suppressed row is written (D3 / D4). */
export async function startDelivery(ctx: FlowCtx, s: Start, onlyIfOk = false): Promise<{ id: string; status: string; inserted: boolean } | undefined> {
  const r = await resolveRecipient(ctx, { channel: s.channel, purpose: s.purpose, kind: s.kind, recipientId: s.recipientId, patientId: s.patientId ?? null, centreId: s.centreId });
  if (!r.ok && onlyIfOk) return undefined;
  const id = s.id ?? (uuidv7() as string);
  const address = r.ok ? r.address : null;
  const { row, inserted } = await insertDelivery(ctx, {
    id, centreId: s.centreId, channel: s.channel, purpose: s.purpose, templateCode: s.templateCode, recipientKind: s.kind, recipientId: r.ok ? r.recipientId : s.recipientId,
    destinationMasked: address ? maskAddress(address) : null, destinationSha256: address ? sha256(address) : null, destinationE164: null,
    params: s.params, idempotencyKey: s.key, relatedType: s.relatedType ?? (s.reportId ? 'report' : null), relatedId: s.relatedId ?? s.reportId,
    reportId: s.reportId, reportVersionNo: s.versionNo, status: r.ok ? 'queued' : 'suppressed', failureCode: r.ok ? null : r.failure,
    deferredLink: s.deferredLink, fallbackOfDeliveryId: s.fallbackOf ?? null,
  });
  return { id: row.id, status: row.status, inserted };
}

/** REQ-ARCH-085: at most one SMS fallback per WhatsApp delivery (never for a fallback itself); only if SMS is enabled + consented + a phone exists. */
export async function createSmsFallback(ctx: FlowCtx, o: Record<string, any>): Promise<void> {
  if (o['channel'] !== 'whatsapp' || o['fallback_of_delivery_id']) return;
  if (await findFallbackOf(tx(ctx), ctx.tenantId, o['id'])) return;
  const report = o['report_id'] ? await findReportMeta(tx(ctx), ctx.tenantId, o['report_id']) : undefined;
  const dl = o['deferred_link'] && typeof o['deferred_link'] === 'object' ? { ...o['deferred_link'], channel: 'sms' } : null;
  await startDelivery(ctx, {
    channel: 'sms', purpose: o['purpose'], templateCode: o['template_code'], kind: o['recipient_kind'], recipientId: o['recipient_id'], patientId: report?.patient_id ?? null,
    centreId: o['centre_id'], params: o['params'] ?? {}, key: `${o['id']}:fallback:sms`, reportId: o['report_id'], versionNo: o['report_version_no'], deferredLink: dl,
    relatedType: o['related_entity_type'], relatedId: o['related_entity_id'], fallbackOf: o['id'],
  }, true);
}

export const isFallbackFailure = (f: string): boolean => f === 'channel_disabled' || f === 'no_consent';
