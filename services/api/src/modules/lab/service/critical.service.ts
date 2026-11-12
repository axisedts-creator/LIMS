// T-15 critical.service: #35 listCriticalValues, #36 getCriticalValue, #37 logCriticalNotification, closeCriticalEventsForResult (R6/R8).
// 02-TRD §5.5 (lifecycle paragraph), §11 audit table; 05-SCHEMA lab.critical_value_log / lab.critical_notifications; PRD AC-13.4/13.5 (close side)/13.6;
// 07-SECURITY S-05 (append-only), S-06 (notified_at <= now + 5 min), S-19 (no echo), P-01/P-02/P-07.
// Lifecycle: open --(first notification outcome=reached AND read_back_confirmed)--> notified (+ first_confirmed_notification_at); other notifications append only;
// closed on approve (R6) / cancel (R8) from open|notified; an AMENDMENT event (its result is already approved) goes open -> closed at its first confirmed notification [CONV].
// Tenant comes from ctx only; every store call takes (tx, tenantId, ...). The store is a seam wired with the core pipeline (open point, see C5.T-15-impl.md).
import { LimsError, type FieldError } from '../../../core/errors.js';

type Row = Record<string, any>;
export type EventRow = Row;
export type NotificationRow = Row;

const NOTIFIED_AT_SKEW_MS = 5 * 60_000;                 // S-06: clock skew allowance, no forward-dating beyond it
const READ_BACK_MAX = 300;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** scopeCentreIds: the caller's centre scope (absent = all centres); set by the service from IdentityPort.getActor, never from the request (P-02, REQ-SEC-017). */
export interface ListQuery { status?: string; detectedAtFrom?: string; detectedAtTo?: string; centreId?: string; cursor?: string; limit: number; scopeCentreIds?: readonly string[] }
export interface NotificationInput {
  notifiedPartyKind: string; notifiedPartyName: string; contactMethod: string; contactDetail?: string; notifiedAt: string;
  outcome: string; readBackConfirmed: boolean; readBackText?: string; comment?: string;
}
export interface CriticalStore {
  getCriticalEvent(tx: unknown, tenantId: string, id: string): Promise<EventRow | undefined>;
  listCriticalEvents(tx: unknown, tenantId: string, q: ListQuery): Promise<{ rows: EventRow[]; nextCursor?: string }>;
  listCriticalNotifications(tx: unknown, tenantId: string, eventId: string): Promise<NotificationRow[]>;
  insertCriticalNotification(tx: unknown, tenantId: string, a: Record<string, unknown>): Promise<NotificationRow>;
  updateCriticalEvent(tx: unknown, tenantId: string, a: { eventId: string; expectedVersion: number; status: 'notified' | 'closed'; firstConfirmedNotificationAt?: string; closedAt?: string }): Promise<void>;
  closeOpenCriticalEvents(tx: unknown, tenantId: string, a: { resultId: string; closedAt: string }): Promise<string[]>;
}
export interface CriticalCtx {
  tenantId: string; actor: { id: string; membershipId?: string }; tx: unknown; now(): Date; store: CriticalStore;
  ports: {
    CatalogPort: { getReferrer(ctx: unknown, i: { referrerId: string; purpose: 'display' }): Promise<{ displayName: string }> };
    IdentityPort: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<void>; getActor?(ctx: unknown): Promise<{ centreScope?: { all?: boolean; centreIds?: readonly string[] } }> };
  };
  audit: { access(e: Record<string, unknown>): Promise<void> };
}

/** P-02: a centre the caller lacks is reported as not found, never 403. */
async function assertAt(ctx: CriticalCtx, permission: string, centreId: string): Promise<void> {
  try { await ctx.ports.IdentityPort.assertRole(ctx, { permission, centreId }); }
  catch (e) { throw e instanceof LimsError && e.code === 'auth.forbidden' ? new LimsError('common.not_found') : e; }
}

const invalid = (path: string, message: string): FieldError => ({ path, code: 'common.field_invalid', message });   // messages never echo values (S-19)

function validate(i: NotificationInput, now: Date): void {
  const errors: FieldError[] = [];
  const t = typeof i.notifiedAt === 'string' && ISO_INSTANT.test(i.notifiedAt) ? Date.parse(i.notifiedAt) : Number.NaN;
  if (Number.isNaN(t)) errors.push(invalid('/notified_at', 'notified_at must be an ISO instant'));
  else if (t > now.getTime() + NOTIFIED_AT_SKEW_MS) errors.push(invalid('/notified_at', 'notified_at must not be later than now + 5 minutes'));
  const text = i.readBackText;
  if (text !== undefined && (typeof text !== 'string' || text.length > READ_BACK_MAX)) errors.push(invalid('/read_back_text', `read_back_text must be at most ${READ_BACK_MAX} characters`));
  else if (i.readBackConfirmed === true && (text === undefined || text.length < 1)) errors.push({ path: '/read_back_text', code: 'common.field_required', message: 'read_back_text is required when read_back_confirmed is true' });
  if (errors.length > 0) throw new LimsError('common.validation_failed', undefined, errors);
}

export async function listCriticalValues(ctx: CriticalCtx, q: ListQuery): Promise<{ rows: EventRow[]; nextCursor?: string }> {
  // P-02 (T-32): only events of the caller's centres; no getActor = no known scope = fail closed (500), never "all centres".
  if (typeof ctx.ports.IdentityPort.getActor !== 'function') throw new LimsError('common.internal');
  const s = (await ctx.ports.IdentityPort.getActor(ctx)).centreScope;
  const page = await ctx.store.listCriticalEvents(ctx.tx, ctx.tenantId, { ...q, ...(s?.all === true ? {} : { scopeCentreIds: [...(s?.centreIds ?? [])] }) });
  await ctx.audit.access({ action: 'critical_value.view', entityType: 'critical_value', outcome: 'allowed', detail: { count: page.rows.length } });   // one row per call, ids/counts only (REQ-SEC-006)
  return { rows: page.rows, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
}

export async function getCriticalValue(ctx: CriticalCtx, criticalEventId: string): Promise<{ event: EventRow; notifications: NotificationRow[]; referrerDisplayName?: string }> {
  const event = await ctx.store.getCriticalEvent(ctx.tx, ctx.tenantId, criticalEventId);
  if (!event) throw new LimsError('common.not_found');                                   // P-01: unknown / other tenant / invisible
  await assertAt(ctx, 'lab.critical_value.read', event['centre_id']);                    // P-02: after the object load
  const notifications = await ctx.store.listCriticalNotifications(ctx.tx, ctx.tenantId, criticalEventId);
  let referrerDisplayName: string | undefined;
  if (event['referrer_id'] !== null && event['referrer_id'] !== undefined) {
    referrerDisplayName = (await ctx.ports.CatalogPort.getReferrer(ctx, { referrerId: event['referrer_id'], purpose: 'display' })).displayName;   // finding C5 #45
  }
  await ctx.audit.access({ action: 'critical_value.view', entityType: 'critical_value', entityId: criticalEventId, centreId: event['centre_id'], outcome: 'allowed' });
  return { event, notifications, ...(referrerDisplayName === undefined ? {} : { referrerDisplayName }) };
}

export async function logCriticalNotification(ctx: CriticalCtx, criticalEventId: string, input: NotificationInput): Promise<NotificationRow> {
  const now = ctx.now();
  validate(input, now);
  const event = await ctx.store.getCriticalEvent(ctx.tx, ctx.tenantId, criticalEventId);
  if (!event) throw new LimsError('common.not_found');                                   // P-01 / P-07
  await assertAt(ctx, 'lab.critical_value.log_notification', event['centre_id']);        // P-02: the event's own centre
  const notifiedAt = new Date(input.notifiedAt).toISOString();
  // S-05: append-only evidence; actor is always the ctx membership, never a body field (REQ-SEC-024).
  const row = await ctx.store.insertCriticalNotification(ctx.tx, ctx.tenantId, {
    eventId: criticalEventId, centreId: event['centre_id'],
    notifiedPartyKind: input.notifiedPartyKind, notifiedPartyName: input.notifiedPartyName, contactMethod: input.contactMethod,
    ...(input.contactDetail === undefined ? {} : { contactDetail: input.contactDetail }),
    notifiedAt, outcome: input.outcome, readBackConfirmed: input.readBackConfirmed,
    ...(input.readBackText === undefined ? {} : { readBackText: input.readBackText }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
    notifiedByMembershipId: ctx.actor.membershipId,
  });
  // AC-13.6: only the first reached + read-back-confirmed notification moves an open event; closed / notified events just get the appended row.
  if (input.outcome === 'reached' && input.readBackConfirmed === true && event['status'] === 'open') {
    const amendment = event['result_status'] === 'approved';                              // [CONV] no later approval exists to close an amendment event
    await ctx.store.updateCriticalEvent(ctx.tx, ctx.tenantId, {
      eventId: criticalEventId, expectedVersion: event['version'], status: amendment ? 'closed' : 'notified',
      firstConfirmedNotificationAt: notifiedAt, ...(amendment ? { closedAt: now.toISOString() } : {}),
    });
  }
  return row;
}

/** R6 (approve) / R8 (cancel): closes every open|notified event of the result in the caller's transaction. Not a notification; nothing is published. */
export async function closeCriticalEventsForResult(ctx: CriticalCtx, resultId: string, reason: 'approved' | 'cancelled'): Promise<{ closedEventIds: string[] }> {
  if (reason !== 'approved' && reason !== 'cancelled') throw new LimsError('common.validation_failed', undefined, [invalid('/reason', 'reason must be approved or cancelled')]);
  const closedEventIds = await ctx.store.closeOpenCriticalEvents(ctx.tx, ctx.tenantId, { resultId, closedAt: ctx.now().toISOString() });
  return { closedEventIds };
}
