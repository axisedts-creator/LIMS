// D1-D4 (02-TRD §6.3; 01-PRD AC-09.6, AC-09.7). Tenant and actor come from ctx only; DTO = 02-TRD §6.1 `Delivery` (no body, full destination, link, params, hashes; no nulls).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import {
  findActiveChannelAccount, findCentreContact, findDelivery, findQrSnapshot, findReleasedVersion, findReportMeta, listAttempts, listDeliveries, revokeDeliveryLinks,
} from '../repository/delivery.repo.js';
import type { Tx } from '../repository/settings.repo.js';
import { labParam } from '../domain/messages.js';
import { startDelivery, type FlowCtx } from './delivery.flow.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed', 'suppressed'];
const CHANNELS = ['whatsapp', 'sms', 'email', 'print', 'portal'];
const PURPOSES = ['registration_confirmation', 'report_ready', 'otp', 'dues_reminder', 'recollection_request', 'critical_value_alert', 'booking_confirmation', 'visit_assignment',
  'follow_up_reminder', 'scheduled_report_ready', 'booking_cancelled', 'booking_reminder'];
const KINDS = ['patient', 'referrer', 'centre', 'partner', 'staff', 'phone_otp'];
const PAGE_DEFAULT = 50; const PAGE_MAX = 200;

export const bad = (path: string): LimsError => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const tx = (ctx: FlowCtx) => ctx.tx as Tx;

const TS = ['queued_at', 'sent_at', 'delivered_at', 'read_at', 'failed_at'] as const;
/** Delivery DTO (allow-list; absent instead of null). */
export function present(r: Record<string, any>, attempts?: Array<Record<string, any>>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of ['id', 'channel', 'purpose', 'recipient_kind', 'status', 'attempt_no', 'destination_masked', 'template_code', 'report_id', 'report_version_no', 'fallback_of_delivery_id', 'failure_code']) {
    if (r[k] !== null && r[k] !== undefined) o[k] = r[k];
  }
  for (const k of TS) if (r[k] !== null && r[k] !== undefined) o[k] = iso(r[k]);
  if (attempts) {
    o['attempts'] = attempts.map((a) => ({
      attempt_no: a['attempt_no'], started_at: iso(a['started_at']),
      ...(a['finished_at'] != null ? { finished_at: iso(a['finished_at']) } : {}), outcome: a['outcome'], ...(a['error_code'] != null ? { error_code: a['error_code'] } : {}),
    }));
  }
  return o;
}

const enc = (createdAt: string, id: string) => Buffer.from(JSON.stringify({ k: createdAt, i: id })).toString('base64url');
function dec(c: string): { k: string; i: string } {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (typeof v?.k === 'string' && ISO.test(v.k) && typeof v?.i === 'string' && UUID.test(v.i)) return v;
  } catch { /* fall through */ }
  throw bad('/cursor');
}
const oneOf = (v: unknown, set: string[], path: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !set.includes(v)) throw bad(path);
  return v;
};
const when = (v: unknown, path: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) throw bad(path);
  return new Date(v).toISOString();
};

export async function list(ctx: FlowCtx, q: Record<string, unknown>) {
  const f = {
    status: oneOf(q['status'], STATUSES, '/status'), channel: oneOf(q['channel'], CHANNELS, '/channel'), purpose: oneOf(q['purpose'], PURPOSES, '/purpose'),
    recipientKind: oneOf(q['recipient_kind'], KINDS, '/recipient_kind'), from: when(q['created_at_from'], '/created_at_from'), to: when(q['created_at_to'], '/created_at_to'),
  };
  if (q['report_id'] !== undefined && (typeof q['report_id'] !== 'string' || !UUID.test(q['report_id']))) throw bad('/report_id');
  if (q['sort'] !== undefined && q['sort'] !== '-created_at') throw bad('/sort');
  let limit = PAGE_DEFAULT;
  if (q['limit'] !== undefined) {
    const s = q['limit'];
    if (!(typeof s === 'number' || (typeof s === 'string' && /^\d{1,4}$/.test(s)))) throw bad('/limit');
    limit = Number(s);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw bad('/limit');
  }
  const cur = q['cursor'] === undefined ? undefined : typeof q['cursor'] === 'string' ? dec(q['cursor']) : (() => { throw bad('/cursor'); })();
  const rows = await listDeliveries(tx(ctx), ctx.tenantId, {
    ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)), ...(q['report_id'] !== undefined ? { reportId: q['report_id'] as string } : {}),
    ...(cur ? { afterCreatedAt: cur.k, afterId: cur.i } : {}),
  }, limit + 1);
  const page = rows.slice(0, limit); const last = page[page.length - 1];
  return { data: page.map((r) => present(r)), page: { limit, ...(rows.length > limit && last ? { next_cursor: enc(iso(last['created_at']), last['id']) } : {}) } };
}

export async function get(ctx: FlowCtx, id: unknown) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new LimsError('common.not_found');
  const r = await findDelivery(tx(ctx), ctx.tenantId, id);
  if (!r) throw new LimsError('common.not_found');
  return { body: present(r, await listAttempts(tx(ctx), ctx.tenantId, id)), version: r['version'] as number };
}

async function labName(ctx: FlowCtx, reportId: string): Promise<string> {
  const q = await findQrSnapshot(tx(ctx), ctx.tenantId, reportId);
  return labParam(q?.lab_name_snapshot);
}

/** D3 */
export async function send(ctx: FlowCtx, reportId: unknown, b: { recipientKind: string; channel: 'whatsapp' | 'sms' | 'email'; centreContactId?: string }) {
  if (typeof reportId !== 'string' || !UUID.test(reportId)) throw new LimsError('common.not_found');
  const report = await findReportMeta(tx(ctx), ctx.tenantId, reportId);
  if (!report) throw new LimsError('common.not_found');
  const version = await findReleasedVersion(tx(ctx), ctx.tenantId, reportId);
  if (!version) throw new LimsError('reporting.report_not_released');
  if (!(await findActiveChannelAccount(tx(ctx), ctx.tenantId, b.channel))) throw new LimsError('reporting.channel_not_configured');
  let recipientId: string | null = report.patient_id;
  if (b.recipientKind === 'referrer') recipientId = report.referrer_id;
  if (b.recipientKind === 'centre') {
    const c = await findCentreContact(tx(ctx), ctx.tenantId, b.centreContactId!);
    if (!c || !c.is_active || c.centre_id !== report.centre_id) throw new LimsError('common.not_found');   // no cross-centre disclosure (05-SCHEMA §2.8)
    recipientId = c.id;
  }
  const id = uuidv7() as string;
  const s = await startDelivery(ctx, {
    id, channel: b.channel, purpose: 'report_ready', templateCode: 'reporting.report_ready', kind: b.recipientKind, recipientId, patientId: report.patient_id, centreId: report.centre_id,
    params: { lab_name: await labName(ctx, reportId) }, key: `${reportId}:resend:${id}`, reportId, versionNo: version.version_no,
    deferredLink: { report_id: reportId, version_no: version.version_no, channel: b.channel, recipient_kind: b.recipientKind },
  });
  return present((await findDelivery(tx(ctx), ctx.tenantId, s!.id))!);
}

/** D4: clone a `failed` delivery into a NEW one (not a fallback); the failed original is kept, its unsent link is revoked. */
export async function retry(ctx: FlowCtx, id: unknown, expectedVersion: number) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new LimsError('common.not_found');
  const o = await findDelivery(tx(ctx), ctx.tenantId, id, true);
  if (!o) throw new LimsError('common.not_found');
  if (o['version'] !== expectedVersion) throw new LimsError('common.version_conflict');
  if (o['status'] !== 'failed') throw new LimsError('common.immutable_record');
  const report = o['report_id'] ? await findReportMeta(tx(ctx), ctx.tenantId, o['report_id']) : undefined;
  const nid = uuidv7() as string;
  const at = ((ctx.tx as { startedAt?: Date }).startedAt ?? new Date()).toISOString();
  await revokeDeliveryLinks(tx(ctx), ctx.tenantId, id, 'superseded_attempt', at, ctx.actor.id);
  const s = await startDelivery(ctx, {
    id: nid, channel: o['channel'], purpose: o['purpose'], templateCode: o['template_code'], kind: o['recipient_kind'], recipientId: o['recipient_id'], patientId: report?.patient_id ?? null,
    centreId: o['centre_id'], params: o['params'] ?? {}, key: `${id}:retry:${nid}`, reportId: o['report_id'], versionNo: o['report_version_no'], deferredLink: o['deferred_link'] ?? null,
    relatedType: o['related_entity_type'], relatedId: o['related_entity_id'],
  });
  return present((await findDelivery(tx(ctx), ctx.tenantId, s!.id))!);
}
