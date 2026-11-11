// T-15 handlers: #35 listCriticalValues, #36 getCriticalValue, #37 logCriticalNotification (02-TRD §5.5, §11; REQ-SEC-099 no stub; S-19, P-01/P-02).
// Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from contracts/openapi/lab.yaml; these map request -> service -> DTO.
// Tenant and actor come from ctx only (body tenant_id / notified_by / created_by are never read, REQ-SEC-024). Store / ports / audit come from ctx;
// a ctx without them fails closed (common.internal) until the core pipeline wires the SQL store.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext } from '../../../core/module.js';
import { labStore } from '../store/labStore.js';
import { getCriticalValue, listCriticalValues, logCriticalNotification, type CriticalCtx, type EventRow, type ListQuery, type NotificationRow } from '../service/critical.service.js';

type Obj = Record<string, any>;
const DEFAULT_LIMIT = 50;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const present = (v: unknown): boolean => v !== null && v !== undefined;
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : undefined);
const put = (o: Obj, k: string, v: unknown): void => { if (present(v)) o[k] = v; };   // absent values are omitted, never null

function authed(h: HandlerContext): CriticalCtx {
  const c = h as Partial<CriticalCtx>;
  if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  if (!c.ports?.IdentityPort || !c.audit) throw new LimsError('common.internal');   // fail closed: port / audit wiring missing (no port is invented)
  return { ...c, store: c.store ?? labStore(c.tx, c as never) } as CriticalCtx;   // LD-124: ctx.store ?? labStore(ctx.tx)
}

const valueOf = (e: EventRow): string => String(e['value_numeric'] ?? e['value_text'] ?? e['ordinal_code'] ?? '');

/** lab.yaml CriticalValueDto (allowlist; tenant / patient / referrer ids, hash, actors and result_status are never copied). */
function toEventDto(e: EventRow): Obj {
  const d: Obj = {
    id: e['id'], result_id: e['result_id'], order_id: e['order_id'], analyte_code: e['analyte_code'], value: valueOf(e), direction: e['direction'], status: e['status'],
    detected_at: iso(e['detected_at']), value_changed_after_detection: Boolean(e['value_changed_after_detection']),
  };
  put(d, 'unit_code', e['unit_code']); put(d, 'flag', e['flag']);
  put(d, 'first_confirmed_notification_at', iso(e['first_confirmed_notification_at'])); put(d, 'closed_at', iso(e['closed_at']));
  put(d, 'centre_id', e['centre_id']);
  return d;
}

/** lab.yaml CriticalNotificationDto; recorded_at = created_at; notified_by is never exposed. */
function toNotificationDto(n: NotificationRow): Obj {
  const d: Obj = {
    id: n['id'], critical_event_id: n['critical_event_id'], notified_party_kind: n['notified_party_kind'], notified_party_name: n['notified_party_name'], contact_method: n['contact_method'],
    notified_at: iso(n['notified_at']), outcome: n['outcome'], read_back_confirmed: Boolean(n['read_back_confirmed']), recorded_at: iso(n['created_at']),
  };
  put(d, 'contact_detail', n['contact_detail']); put(d, 'read_back_text', n['read_back_text']); put(d, 'comment', n['comment']);
  return d;
}

const list: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const q = obj(req.query);
  const limit = Number(q['limit'] ?? DEFAULT_LIMIT);
  const query: ListQuery = {
    limit,
    ...(q['status'] === undefined ? {} : { status: q['status'] }),
    ...(q['detected_at_from'] === undefined ? {} : { detectedAtFrom: q['detected_at_from'] }),
    ...(q['detected_at_to'] === undefined ? {} : { detectedAtTo: q['detected_at_to'] }),
    ...(q['centre_id'] === undefined ? {} : { centreId: q['centre_id'] }),
    ...(q['cursor'] === undefined ? {} : { cursor: q['cursor'] }),
  };
  const out = await listCriticalValues(ctx, query);
  return { status: 200, body: { data: out.rows.map(toEventDto), page: { limit, ...(out.nextCursor === undefined ? {} : { next_cursor: out.nextCursor }) } } };
};

const get: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const out = await getCriticalValue(ctx, obj(req.params)['critical_event_id']);
  const body: Obj = { ...toEventDto(out.event), notifications: out.notifications.map(toNotificationDto) };
  if (out.referrerDisplayName !== undefined) body['referrer_display_name'] = out.referrerDisplayName;
  return { status: 200, body };
};

const log: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const b = obj(req.body);
  const row = await logCriticalNotification(ctx, obj(req.params)['critical_event_id'], {
    notifiedPartyKind: b['notified_party_kind'], notifiedPartyName: b['notified_party_name'], contactMethod: b['contact_method'], notifiedAt: b['notified_at'],
    outcome: b['outcome'], readBackConfirmed: b['read_back_confirmed'],
    ...(b['contact_detail'] === undefined ? {} : { contactDetail: b['contact_detail'] }),
    ...(b['read_back_text'] === undefined ? {} : { readBackText: b['read_back_text'] }),
    ...(b['comment'] === undefined ? {} : { comment: b['comment'] }),
  });
  return { status: 201, body: toNotificationDto(row) };
};

export const criticalHandlers: Readonly<Record<'listCriticalValues' | 'getCriticalValue' | 'logCriticalNotification', Handler>> = Object.freeze({
  listCriticalValues: list, getCriticalValue: get, logCriticalNotification: log,
});
