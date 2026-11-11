// CriticalStore (service/critical.service.ts) over lab.critical_value_log / lab.critical_notifications. LD-124: runs on ctx.tx only, tenant from the argument, RLS is the guard.
// The event row also carries analyte_code and the result's status (join lab.results) because the handler DTO and the amendment rule of logCriticalNotification read them.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { insertRow, isUuid, updateRow } from '../repository/base.repo.js';
import { CRITICAL_NOTIFICATIONS, CRITICAL_VALUE_LOG } from '../repository/results.repo.js';
import type { CriticalStore, ListQuery } from '../service/critical.service.js';
import { rcOf, sql } from './scope.js';

const MAX_PAGE = 200;
const EVENT_SELECT = `SELECT c.*, r.analyte_code, r.status AS result_status, r.unit_code AS result_unit_code
                        FROM lab.critical_value_log c JOIN lab.results r ON r.tenant_id = c.tenant_id AND r.id = c.result_id`;

const badCursor = () => new LimsError('common.validation_failed', undefined, [{ path: '/cursor', code: 'common.field_invalid', message: 'cursor is invalid' }]);
/** opaque keyset cursor: base64url("<detected_at iso>|<id>") of the last row of the page. */
const encode = (r: { detected_at: Date | string; id: string }): string => Buffer.from(`${new Date(r.detected_at).toISOString()}|${r.id}`).toString('base64url');
function decode(c: string): { at: string; id: string } {
  const [at, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  if (!at || !isUuid(id) || Number.isNaN(Date.parse(at))) throw badCursor();
  return { at: new Date(at).toISOString(), id };
}
const asEvent = (r: any) => ({ ...r, unit_code: r.unit_code ?? r.result_unit_code });

export const criticalStore = (): CriticalStore => ({
  async getCriticalEvent(tx, tenantId, id) {
    if (!isUuid(id)) return undefined;
    const r = (await sql(tx, tenantId, `${EVENT_SELECT} WHERE c.tenant_id = $1 AND c.id = $2`, [id]))[0];
    return r ? asEvent(r) : undefined;
  },

  async listCriticalEvents(tx, tenantId, q: ListQuery) {
    const limit = Math.min(Math.max(Number.isInteger(q.limit) ? q.limit : 50, 1), MAX_PAGE);
    const where = ['c.tenant_id = $1'];
    const args: unknown[] = [];
    const add = (frag: (n: number) => string, v: unknown) => { args.push(v); where.push(frag(args.length + 1)); };
    if (q.status !== undefined) add((n) => `c.status = $${n}`, q.status);
    if (q.detectedAtFrom !== undefined) add((n) => `c.detected_at >= $${n}::timestamptz`, q.detectedAtFrom);
    if (q.detectedAtTo !== undefined) add((n) => `c.detected_at < $${n}::timestamptz`, q.detectedAtTo);
    if (q.centreId !== undefined) { if (!isUuid(q.centreId)) return { rows: [] }; add((n) => `c.centre_id = $${n}`, q.centreId); }
    if (q.scopeCentreIds !== undefined) add((n) => `(c.centre_id = ANY($${n}::uuid[]) OR c.processing_centre_id = ANY($${n}::uuid[]))`, q.scopeCentreIds.filter(isUuid));
    if (q.cursor !== undefined) { const k = decode(q.cursor); args.push(k.at, k.id); where.push(`(c.detected_at, c.id) < ($${args.length}::timestamptz, $${args.length + 1})`); }
    const rows = await sql(tx, tenantId, `${EVENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.detected_at DESC, c.id DESC LIMIT ${limit + 1}`, args);
    const page = rows.slice(0, limit).map(asEvent);
    return { rows: page, ...(rows.length > limit ? { nextCursor: encode(page[page.length - 1]) } : {}) };
  },

  async listCriticalNotifications(tx, tenantId, eventId) {
    if (!isUuid(eventId)) return [];
    return sql(tx, tenantId, 'SELECT * FROM lab.critical_notifications WHERE tenant_id = $1 AND critical_event_id = $2 ORDER BY notified_at, created_at, id', [eventId]);
  },

  async insertCriticalNotification(tx, tenantId, a) {
    const rc = await rcOf(tx, tenantId);
    return insertRow(rc, CRITICAL_NOTIFICATIONS, {
      id: uuidv7(), critical_event_id: a['eventId'], centre_id: a['centreId'], notified_party_kind: a['notifiedPartyKind'], notified_party_name: a['notifiedPartyName'],
      contact_method: a['contactMethod'], contact_detail: a['contactDetail'] ?? null, notified_at: a['notifiedAt'], outcome: a['outcome'], read_back_confirmed: a['readBackConfirmed'],
      read_back_text: a['readBackText'] ?? null, comment: a['comment'] ?? null, notified_by_membership_id: a['notifiedByMembershipId'],
    });
  },

  async updateCriticalEvent(tx, tenantId, a) {
    await updateRow(await rcOf(tx, tenantId), CRITICAL_VALUE_LOG, a.eventId, a.expectedVersion, {
      status: a.status, ...(a.firstConfirmedNotificationAt === undefined ? {} : { first_confirmed_notification_at: a.firstConfirmedNotificationAt }),
      ...(a.closedAt === undefined ? {} : { closed_at: a.closedAt }),
    });
  },

  async closeOpenCriticalEvents(tx, tenantId, a) {
    const rc = await rcOf(tx, tenantId);
    const rows = await sql(tx, tenantId, `UPDATE lab.critical_value_log SET status = 'closed', closed_at = $3::timestamptz, version = version + 1, updated_at = now(), updated_by = $2
                                           WHERE tenant_id = $1 AND result_id = $4 AND status IN ('open','notified') RETURNING id`, [rc.actorId, a.closedAt, a.resultId]);
    return rows.map((r) => r.id as string);
  },
});
