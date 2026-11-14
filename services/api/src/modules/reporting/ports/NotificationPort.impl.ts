// NotificationPort (03-IC §4.8) — real C6 implementation of 02-TRD §7.2 steps 1-8. Outbox only: no provider is ever called here (REQ-SEC-136);
// the reporting.send_delivery task does the network I/O. All writes go through ctx.tx, so a rolled-back caller leaves nothing (AC-16.3).
// LD-26 (training tenant → recording adapter only) is enforced by the send task's adapter choice; no IdentityPort method exposes
// `tenant.training_mode` yet → CR filed (.orchestra/cr/C6-T19.md); nothing here reads C2 tables.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import {
  E164_RE, FAILURE_OF, IDEMPOTENCY_KEY_RE, TEMPLATE_CODE_RE, UUID_RE, hasConsent, maskAddress, sha256, statusOfRow, validateParams,
  type MessageChannel, type SendStatus,
} from '../domain/messages.js';
import { findActiveTemplate, findDeliveryByKey, insertDelivery, oldestCentreContact, type DeliveryCtx } from '../service/delivery.service.js';

type Env = Record<string, string | undefined>;
interface Ctx extends DeliveryCtx {
  readonly ports: { readonly FrontdeskPort: any; readonly IdentityPort: any };
  readonly rateLimit: { consume(tier: 'otp_request', key: string): Promise<void> };
}
interface SendInput {
  recipient: any; templateCode: unknown; purpose: unknown; params: unknown; idempotencyKey: unknown; linkUrl?: unknown;
  related?: { entityType: string; entityId: string };
}
export interface SendResult { deliveryId: string; status: SendStatus; replayed: boolean }

const invalid = (d: string) => new LimsError('common.validation_failed', d);
const paramsInvalid = () => new LimsError('reporting.notification_params_invalid');   // never echoes a key or value (PHI-safe)
const RECIPIENT_ID: Record<string, string> = { patient: 'patientId', referrer: 'referrerId', centre: 'centreId', partner: 'partnerId', staff: 'membershipId' };
const RELATED = new Set(['order', 'report', 'specimen', 'booking', 'visit', 'critical_event', 'report_run']);
const SWITCH = { sms: 'smsEnabled', whatsapp: 'whatsappEnabled', email: 'emailEnabled' } as const;

/** Recipient shape check (before any write): unknown kind, bad id, bad E.164 or phone_otp outside purpose otp → common.validation_failed. */
function recipientOf(r: any, purpose: string): { kind: string; id: string | null; phone: string | null } {
  if (typeof r !== 'object' || r === null) throw invalid('recipient_invalid');
  if (r.kind === 'phone_otp') {
    if (purpose !== 'otp' || typeof r.phoneE164 !== 'string' || !E164_RE.test(r.phoneE164)) throw invalid('recipient_invalid');
    return { kind: 'phone_otp', id: null, phone: r.phoneE164 };
  }
  const key = Object.hasOwn(RECIPIENT_ID, r.kind) ? RECIPIENT_ID[r.kind]! : undefined;
  if (!key || typeof r[key] !== 'string' || !UUID_RE.test(r[key])) throw invalid('recipient_invalid');
  return { kind: r.kind, id: r[key], phone: null };
}

export function createNotificationPort(deps: { env: Env }) {
  const origins = () => ({ portal: deps.env['LIMS_ORIGIN_PORTAL'], staffWeb: deps.env['LIMS_ORIGIN_STAFF_WEB'] });   // read at call time

  const send = (channel: MessageChannel) => async (ctx: Ctx, input: SendInput): Promise<SendResult> => {
    const key = input?.idempotencyKey;
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY_RE.test(key)) throw invalid('idempotency_key_invalid');   // P-40 first
    // 1. Replay wins before any validation of the new call; the stored row is never touched.
    const prior = await findDeliveryByKey(ctx, key);
    if (prior) return { deliveryId: prior.id, status: statusOfRow(prior), replayed: true };

    // 2. Template.
    const { templateCode: code, purpose } = input;
    if (typeof code !== 'string' || !TEMPLATE_CODE_RE.test(code) || typeof purpose !== 'string') throw new LimsError('reporting.notification_template_unknown');
    const tpl = await findActiveTemplate(ctx, code);
    if (!tpl || tpl.purpose !== purpose || !tpl.channels.includes(channel)) throw new LimsError('reporting.notification_template_unknown');
    const rcp = recipientOf(input.recipient, purpose);

    // 3. Params; linkUrl is validated as the template's `url` param and kept in params.url until a terminal status (02-TRD §7.2 closing para).
    const staffLink = purpose === 'scheduled_report_ready' && rcp.kind === 'staff';
    const declared = tpl.params;
    const urlParam = declared.find((p) => p.name === 'url');
    if (urlParam?.kind === 'staff_url' && !staffLink) throw paramsInvalid();          // staff_url only for scheduled_report_ready → staff (D-29)
    const params = validateParams(declared, input.params, origins(), staffLink);
    if (!params) throw paramsInvalid();
    if (input.linkUrl !== undefined || channel === 'email') {
      const link = validateParams([urlParam ?? { name: 'url', kind: 'url' }], { url: input.linkUrl }, origins(), staffLink);
      if (!link) throw paramsInvalid();
      if (urlParam) params['url'] = link['url']!;                                    // a template without {url} ignores it (review fix #29)
    }
    let related: { type: string; id: string } | null = null;
    if (input.related !== undefined) {
      const r = input.related;
      if (!r || !RELATED.has(r.entityType) || typeof r.entityId !== 'string' || !UUID_RE.test(r.entityId)) throw invalid('related_invalid');
      related = { type: r.entityType, id: r.entityId };
    }

    const base = { id: uuidv7() as string, channel, purpose, templateCode: code, recipientKind: rcp.kind, params, idempotencyKey: key,
      relatedType: related?.type ?? null, relatedId: related?.id ?? null };
    let centreId: string | null = rcp.kind === 'centre' ? rcp.id : null;
    let recipientId: string | null = rcp.kind === 'centre' ? null : rcp.id;
    let address: string | null = null;
    const finish = async (status: SendStatus): Promise<SendResult> => {
      const suppressed = status !== 'queued';
      const { row, inserted } = await insertDelivery(ctx, {
        ...base, centreId, recipientId, status: suppressed ? 'suppressed' : 'queued', failureCode: suppressed ? FAILURE_OF[status] : null,
        destinationMasked: address ? maskAddress(address) : null, destinationSha256: address ? sha256(address) : null,
        destinationE164: rcp.kind === 'phone_otp' ? rcp.phone : null,
      });
      return inserted ? { deliveryId: row.id, status, replayed: false } : { deliveryId: row.id, status: statusOfRow(row), replayed: true };
    };

    // 4. Tenant channel switch (before recipient resolution and before any OTP quota).
    const settings = await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['channels'] });
    if (settings?.channels?.[SWITCH[channel]] !== true) return finish('suppressed_channel_disabled');

    // 5. Recipient resolution + consent. Raw contacts never reach SQL values, events or jobs (P2).
    switch (rcp.kind) {
      case 'patient': {
        const d = await ctx.ports.FrontdeskPort.getPatientDemographics(ctx, { patientId: rcp.id, purpose: 'notification' });
        if (!hasConsent(d?.consents, channel, purpose)) return finish('suppressed_no_consent');
        const raw = channel === 'email' ? d?.email : d?.phoneE164;
        // Non-system callers get contactPresence only (CR-C6-015); the send task re-reads the contact as the system actor.
        const present = d?.contactPresence ? (channel === 'email' ? d.contactPresence.email : d.contactPresence.phone) === true : typeof raw === 'string' && raw.length > 0;
        if (!present) return finish('suppressed_no_contact');
        if (typeof raw === 'string' && raw) address = raw;
        return finish('queued');
      }
      case 'staff': {
        // Phase-1 staff suppression, lifted only for scheduled_report_ready via getStaffNotificationContact (08 A4.2; contract 9-11).
        const perm = input.recipient.requiredPermission;
        if (!staffLink || typeof perm !== 'string' || !perm) return finish('suppressed_no_contact');
        const c = await ctx.ports.IdentityPort.getStaffNotificationContact(ctx, { membershipId: rcp.id, requiredPermission: perm });
        if (c?.eligible !== true || typeof c.email !== 'string' || !c.email) return finish('suppressed_no_contact');
        address = c.email;
        return finish('queued');
      }
      case 'centre': {
        const c = await oldestCentreContact(ctx, rcp.id!, channel);
        if (!c) return finish('suppressed_no_contact');
        recipientId = c.id; address = c.address;
        return finish('queued');
      }
      case 'phone_otp': {
        address = rcp.phone;
        // 6. OTP limit: 3/hour/phone (04 A9). Core grammar accepts tier otp_request + prefix `p:` only → key `p:<hex sha256(E.164)>`
        // (TRD text `otp:p:<hex>`; spec conflict flagged in .orchestra/notes/C6-T19-impl.md). Consumed once per NEW send (replays returned above).
        await ctx.rateLimit.consume('otp_request', `p:${sha256(rcp.phone!).toString('hex')}`);
        return finish('queued');
      }
      default:
        // referrer (CatalogPort contact + shareWithReferrer, REQ-SEC-006) not wired yet; partner: Phase 1 → no contact (review fix #30).
        // ponytail: referrer suppressed until CatalogPort.getReferrer wiring lands (open point in C6-T19-impl.md).
        return finish('suppressed_no_contact');
    }
  };

  return { sendSms: send('sms'), sendWhatsAppTemplate: send('whatsapp'), sendEmailLink: send('email') };
}
