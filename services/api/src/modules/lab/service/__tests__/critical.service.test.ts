// C5 T-15 — critical.service: listCriticalValues (#35), getCriticalValue (#36), logCriticalNotification (#37), closeCriticalEventsForResult (R6/R8)
// (02-TRD §5.5 incl. the lifecycle paragraph, §11 audit table; 05-SCHEMA lab.critical_value_log / lab.critical_notifications; PRD AC-13.4, AC-13.5 (close side only), AC-13.6;
//  07-SECURITY S-05, S-06, P-01, P-02, P-07).
// Lifecycle under test: open --(first notification with outcome=reached AND read_back_confirmed)--> notified (+ first_confirmed_notification_at); other notifications append only;
//   closed (closed_at) when the result is approved (R6) or cancelled (R8), from open or notified; an AMENDMENT event (its result is already approved) goes open -> closed at its first confirmed notification.
// In-memory fake store / ports; no database (DB grants/triggers are covered by tests/db/T0B-10.C5.lab.test.mjs: NO_UPDATE critical_notifications, mutable-column trigger of critical_value_log).
//
// SEAM (spec fixes behaviour, not names) — ../critical.service.ts exports
//   listCriticalValues(ctx, { status?, detectedAtFrom?, detectedAtTo?, centreId?, cursor?, limit }): Promise<{ rows: EventRow[]; nextCursor?: string }>
//   getCriticalValue(ctx, criticalEventId): Promise<{ event: EventRow; notifications: NotificationRow[]; referrerDisplayName?: string }>
//   logCriticalNotification(ctx, criticalEventId, { notifiedPartyKind, notifiedPartyName, contactMethod, contactDetail?, notifiedAt: ISO string, outcome, readBackConfirmed, readBackText?, comment? }): Promise<NotificationRow>
//   closeCriticalEventsForResult(ctx, resultId, reason: 'approved' | 'cancelled'): Promise<{ closedEventIds: string[] }>      (called by T-16 approve and the cancel path)
//   ctx = { tenantId, actor{id, membershipId}, tx, now(), store, ports{ CatalogPort{getReferrer}, IdentityPort{assertRole} }, audit{ access(entry) } }
//   Rows are the snake_case column names of the tables (the handler maps them to the contract DTOs):
//     EventRow = lab.critical_value_log columns + joined { analyte_code, flag, result_status }  (timestamps are Date)
//     NotificationRow = lab.critical_notifications columns (created_at = recorded_at)
//   store (EVERY call takes (tx, tenantId, ...); tenant comes from ctx only; absent = unknown / other tenant / invisible by RLS):
//     getCriticalEvent(tx, tenantId, id): EventRow | undefined
//     listCriticalEvents(tx, tenantId, { status?, detectedAtFrom?, detectedAtTo?, centreId?, cursor?, limit }): { rows: EventRow[]; nextCursor?: string }
//     listCriticalNotifications(tx, tenantId, eventId): NotificationRow[]               (ascending notified_at)
//     insertCriticalNotification(tx, tenantId, { eventId, centreId, notifiedPartyKind, notifiedPartyName, contactMethod, contactDetail?, notifiedAt, outcome, readBackConfirmed, readBackText?, comment?, notifiedByMembershipId }): NotificationRow
//     updateCriticalEvent(tx, tenantId, { eventId, expectedVersion, status: 'notified' | 'closed', firstConfirmedNotificationAt?: string, closedAt?: string }): void   (optimistic: throws common.version_conflict on a lost race)
//     closeOpenCriticalEvents(tx, tenantId, { resultId, closedAt }): string[]            (every open|notified event of that result -> closed; returns their ids)
//   ASSUMPTION: the first_confirmed_notification_at value is not pinned when it differs from the server clock: the tests record notifications with notified_at = now.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { closeCriticalEventsForResult, getCriticalValue, listCriticalValues, logCriticalNotification } from '../critical.service.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', OTHER_TENANT = '01a1a98a-ac40-7000-8000-00000000b001';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5', MEMBERSHIP = '01a1b34e-2000-7eee-9d29-d7ca59a102b6';
const NOW = new Date('2026-06-15T05:00:00Z');
const MIN = 60_000;
const u = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
const EV = u(0xe1), RESULT = u(0xa1), ORDER = u(0xc1), CENTRE = u(0xa201), REFERRER = u(0xd1), NID = u(0xf9);
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const event = (over: Record<string, unknown> = {}) => ({
  id: EV, tenant_id: TENANT, centre_id: CENTRE, result_id: RESULT, result_version_no: 1, order_id: ORDER, patient_id: u(6), analyte_id: u(8), analyte_code: 'K', referrer_id: REFERRER,
  direction: 'high', value_sha256_prefix16: 'a'.repeat(16), value_numeric: '6.9', unit_code: 'mmol/L', flag: 'HH', detected_at: new Date(NOW.getTime() - 10 * MIN),
  status: 'open', first_confirmed_notification_at: null, value_changed_after_detection: false, closed_at: null, version: 3, result_status: 'resulted',
  created_by: u(0xc1), updated_by: u(0xc1), ...over,
});
const note = (n: number, over: Record<string, unknown> = {}) => ({
  id: u(0xf0 + n), tenant_id: TENANT, centre_id: CENTRE, critical_event_id: EV, notified_party_kind: 'clinician', notified_party_name: 'Dr Synthetic', contact_method: 'phone', contact_detail: null,
  notified_at: new Date(NOW.getTime() - (10 - n) * MIN), outcome: 'reached', read_back_confirmed: true, read_back_text: 'six point nine', comment: null,
  notified_by_membership_id: MEMBERSHIP, created_by: ACTOR, created_at: new Date(NOW.getTime() - (10 - n) * MIN), ...over,
});
const input = (over: Record<string, unknown> = {}) => ({
  notifiedPartyKind: 'clinician', notifiedPartyName: 'Dr Synthetic', contactMethod: 'phone', notifiedAt: NOW.toISOString(), outcome: 'reached', readBackConfirmed: true, readBackText: 'six point nine', ...over,
});

interface Over { events?: any[]; notes?: any[]; assertRole?: (r: any) => Promise<void>; getReferrer?: (i: any) => Promise<any>; closeIds?: string[]; page?: { nextCursor?: string } }
function ctxOf(over: Over = {}) {
  const calls: { fn: string; tenantId: unknown; arg: any }[] = [];
  const access: any[] = [], asked: any[] = [], referrerCalls: any[] = [], published: any[] = [];
  const rec = (fn: string, tenantId: unknown, arg: any) => calls.push({ fn, tenantId, arg });
  const events = new Map((over.events ?? [event()]).map((e) => [e.id, e]));
  const notes: any[] = [...(over.notes ?? [])];
  const store = {
    async getCriticalEvent(_t: unknown, tn: string, id: string) { rec('getCriticalEvent', tn, id); const e = events.get(id); return e && e.tenant_id === tn ? e : undefined; },
    async listCriticalEvents(_t: unknown, tn: string, q: any) { rec('listCriticalEvents', tn, q); return { rows: [...events.values()].filter((e) => e.tenant_id === tn), ...(over.page?.nextCursor === undefined ? {} : { nextCursor: over.page.nextCursor }) }; },
    async listCriticalNotifications(_t: unknown, tn: string, id: string) { rec('listCriticalNotifications', tn, id); return notes.filter((n) => n.critical_event_id === id && n.tenant_id === tn); },
    async insertCriticalNotification(_t: unknown, tn: string, a: any) {
      rec('insertCriticalNotification', tn, a);
      const row = { id: NID, tenant_id: tn, centre_id: a.centreId, critical_event_id: a.eventId, notified_party_kind: a.notifiedPartyKind, notified_party_name: a.notifiedPartyName, contact_method: a.contactMethod,
        contact_detail: a.contactDetail ?? null, notified_at: new Date(a.notifiedAt), outcome: a.outcome, read_back_confirmed: a.readBackConfirmed, read_back_text: a.readBackText ?? null, comment: a.comment ?? null,
        notified_by_membership_id: a.notifiedByMembershipId, created_by: ACTOR, created_at: NOW };
      notes.push(row); return row;
    },
    async updateCriticalEvent(_t: unknown, tn: string, a: any) { rec('updateCriticalEvent', tn, a); },
    async closeOpenCriticalEvents(_t: unknown, tn: string, a: any) { rec('closeOpenCriticalEvents', tn, a); return over.closeIds ?? []; },
  };
  const ctx = {
    operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    tenantId: TENANT, actor: { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, tx: { id: 'tx' }, now: () => NOW, store,
    events: { async publish(...a: unknown[]) { published.push(a); return { eventId: 'e', duplicate: false }; } },
    audit: { async access(e: unknown) { access.push(e); } },
    ports: {
      CatalogPort: { async getReferrer(_c: unknown, i: any) { referrerCalls.push(i); return over.getReferrer ? over.getReferrer(i) : { referrerId: i.referrerId, displayName: 'Dr. Test Referrer 0001', code: 'DR001' }; } },
      IdentityPort: { async assertRole(_c: unknown, r: any) { asked.push(r); await over.assertRole?.(r); } },
    },
  };
  const of = (fn: string) => calls.filter((c) => c.fn === fn);
  return { ctx: ctx as never, calls, of, access, asked, referrerCalls, published, notes };
}
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const forbidden = async () => { throw new LimsError('auth.forbidden'); };

describe('T-15 logCriticalNotification — append-only evidence (AC-13.4, S-05)', () => {
  it('appends one row: notified_by_membership_id = actor membership, centre = the event centre, tenant from ctx, all request fields stored; returns the row', async () => {
    const c = ctxOf();
    const row = await logCriticalNotification(c.ctx, EV, input({ contactDetail: '+977-0000', comment: 'called ward' }));
    expect(c.of('insertCriticalNotification')).toHaveLength(1);
    expect(c.of('insertCriticalNotification')[0]).toMatchObject({
      tenantId: TENANT,
      arg: { eventId: EV, centreId: CENTRE, notifiedPartyKind: 'clinician', notifiedPartyName: 'Dr Synthetic', contactMethod: 'phone', contactDetail: '+977-0000', outcome: 'reached', readBackConfirmed: true, readBackText: 'six point nine', comment: 'called ward', notifiedByMembershipId: MEMBERSHIP },
    });
    expect(new Date(c.of('insertCriticalNotification')[0]!.arg.notifiedAt).toISOString()).toBe(NOW.toISOString());
    expect(row).toMatchObject({ id: NID, critical_event_id: EV, notified_by_membership_id: MEMBERSHIP, outcome: 'reached' });
  });
  it('never updates or deletes notification rows: the store offers no such call and nothing but insert touches notifications', async () => {
    const c = ctxOf({ notes: [note(1, { outcome: 'not_reached', read_back_confirmed: false, read_back_text: null })] });
    await logCriticalNotification(c.ctx, EV, input());
    const fns = c.calls.map((x) => x.fn);
    expect(fns.filter((f) => /notification/i.test(f))).toEqual(['insertCriticalNotification']);
    expect(c.notes).toHaveLength(2);                                   // earlier row kept, new row appended
    expect(c.notes[0]).toMatchObject({ id: u(0xf1) });
  });
  it('a body-supplied notified_by / tenant / actor is not a service input: the actor is always the ctx membership', async () => {
    const c = ctxOf();
    await logCriticalNotification(c.ctx, EV, input({ notifiedByMembershipId: 'EVIL', tenantId: OTHER_TENANT, createdBy: 'EVIL' }));
    const a = c.of('insertCriticalNotification')[0]!;
    expect(a.arg.notifiedByMembershipId).toBe(MEMBERSHIP);
    expect(a.tenantId).toBe(TENANT);
    expect(JSON.stringify(c.calls)).not.toContain('EVIL');
  });
  it('all store calls carry the ctx tenant (REQ-SEC-024)', async () => {
    const c = ctxOf();
    await logCriticalNotification(c.ctx, EV, input());
    expect(c.calls.length).toBeGreaterThan(0);
    for (const x of c.calls) expect(x.tenantId, x.fn).toBe(TENANT);
  });
  it('notification evidence is not a domain event: nothing is published (C5 emits only lab.critical_value.detected.v1)', async () => {
    const c = ctxOf();
    await logCriticalNotification(c.ctx, EV, input());
    expect(c.published).toHaveLength(0);
  });
});

describe('T-15 logCriticalNotification — status transitions open -> notified (AC-13.6, 02-TRD §5.5 lifecycle)', () => {
  it('first reached + read-back confirmed: event open -> notified, first_confirmed_notification_at set, expected version = the loaded row version', async () => {
    const c = ctxOf();
    await logCriticalNotification(c.ctx, EV, input());
    expect(c.of('updateCriticalEvent')).toHaveLength(1);
    expect(c.of('updateCriticalEvent')[0]).toMatchObject({ tenantId: TENANT, arg: { eventId: EV, expectedVersion: 3, status: 'notified' } });
    expect(new Date(c.of('updateCriticalEvent')[0]!.arg.firstConfirmedNotificationAt).toISOString()).toBe(NOW.toISOString());
    expect(c.of('updateCriticalEvent')[0]!.arg.closedAt).toBeUndefined();
  });
  it('insert and status update happen after the event is loaded and authorised, insert first (same transaction)', async () => {
    const c = ctxOf();
    await logCriticalNotification(c.ctx, EV, input());
    const order = c.calls.map((x) => x.fn);
    expect(order.indexOf('getCriticalEvent')).toBeLessThan(order.indexOf('insertCriticalNotification'));
    expect(order.indexOf('insertCriticalNotification')).toBeLessThan(order.indexOf('updateCriticalEvent'));
  });
  for (const [label, over] of [
    ['not_reached', { outcome: 'not_reached', readBackConfirmed: false, readBackText: undefined }],
    ['left_message', { outcome: 'left_message', readBackConfirmed: false, readBackText: undefined }],
    ['reached without read-back', { outcome: 'reached', readBackConfirmed: false, readBackText: undefined }],
    ['not_reached even with a read-back flag set', { outcome: 'not_reached', readBackConfirmed: true, readBackText: 'x' }],
    ['left_message even with a read-back flag set', { outcome: 'left_message', readBackConfirmed: true, readBackText: 'x' }],
  ] as const)
    it(`${label}: row appended, status stays open, first_confirmed_notification_at untouched (no update)`, async () => {
      const c = ctxOf();
      await logCriticalNotification(c.ctx, EV, input(over));
      expect(c.of('insertCriticalNotification')).toHaveLength(1);
      expect(c.of('updateCriticalEvent')).toHaveLength(0);
    });
  it('second confirmed notification on a notified event: appended, no status change, first_confirmed_notification_at is not rewritten', async () => {
    const first = new Date(NOW.getTime() - 5 * MIN);
    const c = ctxOf({ events: [event({ status: 'notified', first_confirmed_notification_at: first, version: 4 })], notes: [note(1)] });
    await logCriticalNotification(c.ctx, EV, input());
    expect(c.of('insertCriticalNotification')).toHaveLength(1);
    expect(c.of('updateCriticalEvent')).toHaveLength(0);
  });
  it('a non-confirmed notification after the first confirmed one does not move the event back', async () => {
    const c = ctxOf({ events: [event({ status: 'notified', first_confirmed_notification_at: new Date(NOW.getTime() - 5 * MIN), version: 4 })] });
    await logCriticalNotification(c.ctx, EV, input({ outcome: 'not_reached', readBackConfirmed: false, readBackText: undefined }));
    expect(c.of('updateCriticalEvent')).toHaveLength(0);
  });
  it('closed event (approved/cancelled earlier): the late notification is still appended (evidence), status unchanged', async () => {
    const c = ctxOf({ events: [event({ status: 'closed', closed_at: new Date(NOW.getTime() - MIN), version: 5, result_status: 'approved' })] });
    await logCriticalNotification(c.ctx, EV, input());
    expect(c.of('insertCriticalNotification')).toHaveLength(1);
    expect(c.of('updateCriticalEvent')).toHaveLength(0);
  });
  it('lost race on the status update (store throws common.version_conflict) propagates, so the caller rolls the insert back', async () => {
    const c = ctxOf();
    (c.ctx as any).store.updateCriticalEvent = async () => { throw new LimsError('common.version_conflict'); };
    expect((await fail(logCriticalNotification(c.ctx, EV, input()))).code).toBe('common.version_conflict');
  });
});

describe('T-15 amendment events close at their first confirmed notification (02-TRD §5.5, [CONV] no later approval)', () => {
  const amendment = (over: Record<string, unknown> = {}) => event({ result_version_no: 2, result_status: 'approved', status: 'open', ...over });
  it('open event of an approved result + first reached/confirmed: open -> closed directly, closed_at = now, first_confirmed_notification_at set', async () => {
    const c = ctxOf({ events: [amendment()] });
    await logCriticalNotification(c.ctx, EV, input());
    expect(c.of('updateCriticalEvent')).toHaveLength(1);
    const a = c.of('updateCriticalEvent')[0]!.arg;
    expect(a).toMatchObject({ eventId: EV, expectedVersion: 3, status: 'closed' });
    expect(new Date(a.closedAt).toISOString()).toBe(NOW.toISOString());
    expect(new Date(a.firstConfirmedNotificationAt).toISOString()).toBe(NOW.toISOString());
  });
  it('a non-confirmed notification on an amendment event leaves it open', async () => {
    const c = ctxOf({ events: [amendment()] });
    await logCriticalNotification(c.ctx, EV, input({ outcome: 'left_message', readBackConfirmed: false, readBackText: undefined }));
    expect(c.of('updateCriticalEvent')).toHaveLength(0);
  });
  it('an event of a not-yet-approved result is never closed by a notification (only approve/cancel close it)', async () => {
    const c = ctxOf({ events: [event({ result_status: 'verified' })] });
    await logCriticalNotification(c.ctx, EV, input());
    expect(c.of('updateCriticalEvent')[0]!.arg.status).toBe('notified');
  });
});

describe('T-15 logCriticalNotification — validation (AC-13.4, S-06; mirrors critical_notifications__readback__ck)', () => {
  async function rejects(over: Record<string, unknown>, path: string, events?: any[]) {
    const c = ctxOf(events ? { events } : {});
    const e = await fail(logCriticalNotification(c.ctx, EV, input(over)));
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect((e.errors ?? []).map((x: any) => x.path)).toContain(path);
    expect(c.of('insertCriticalNotification')).toHaveLength(0);
    expect(c.of('updateCriticalEvent')).toHaveLength(0);
    return c;
  }
  it('read_back_confirmed = true without read_back_text -> 400 common.validation_failed at /read_back_text', () => rejects({ readBackText: undefined }, '/read_back_text'));
  it('read_back_confirmed = true with an empty read_back_text -> 400 at /read_back_text', () => rejects({ readBackText: '' }, '/read_back_text'));
  it('read_back_text longer than 300 -> 400 at /read_back_text', () => rejects({ readBackText: 'x'.repeat(301) }, '/read_back_text'));
  it('read_back_text of exactly 300 and exactly 1 characters is accepted', async () => {
    for (const t of ['x'.repeat(300), 'y']) {
      const c = ctxOf();
      await logCriticalNotification(c.ctx, EV, input({ readBackText: t }));
      expect(c.of('insertCriticalNotification')[0]!.arg.readBackText).toBe(t);
    }
  });
  it('read_back_confirmed = false: read_back_text is optional (absent and present both stored)', async () => {
    for (const t of [undefined, 'partial']) {
      const c = ctxOf();
      await logCriticalNotification(c.ctx, EV, input({ outcome: 'not_reached', readBackConfirmed: false, readBackText: t }));
      expect(c.of('insertCriticalNotification')).toHaveLength(1);
    }
  });
  it('S-06: notified_at later than now + 5 min -> 400 at /notified_at (no back-/forward-dating)', () => rejects({ notifiedAt: iso(5 * MIN + 1000) }, '/notified_at'));
  it('S-06: notified_at exactly now + 5 min is accepted (clock skew); in the past is accepted', async () => {
    for (const at of [iso(5 * MIN), iso(-3 * 3_600_000)]) {
      const c = ctxOf();
      await logCriticalNotification(c.ctx, EV, input({ notifiedAt: at }));
      expect(c.of('insertCriticalNotification')).toHaveLength(1);
    }
  });
  it('notified_at not an ISO instant -> 400 at /notified_at', () => rejects({ notifiedAt: 'tomorrow' }, '/notified_at'));
  it('a rejected request does not echo the read-back text or party name in the error (S-19)', async () => {
    const c = ctxOf();
    const e = await fail(logCriticalNotification(c.ctx, EV, input({ readBackText: 'x'.repeat(301), notifiedPartyName: 'Dr Secret Name' })));
    expect(JSON.stringify([e.message, e.errors ?? []])).not.toMatch(/Secret Name|xxxxxxxx/);
  });
});

describe('T-15 logCriticalNotification — tenant / centre isolation (P-01, P-02, P-07)', () => {
  it('P-01/P-07: unknown event or an event of another tenant -> 404 common.not_found, nothing inserted, no authorisation probe leaks', async () => {
    const c = ctxOf({ events: [event({ tenant_id: OTHER_TENANT })] });
    const e = await fail(logCriticalNotification(c.ctx, EV, input()));
    expect(e.code).toBe('common.not_found');
    expect(e.statusCode).toBe(404);
    expect(c.of('insertCriticalNotification')).toHaveLength(0);
    const e2 = await fail(logCriticalNotification(ctxOf().ctx, u(0xdead), input()));
    expect(e2.code).toBe('common.not_found');
  });
  it('P-02: lab.critical_value.log_notification is asserted for the EVENT centre after the load; auth.forbidden is reported as 404, nothing inserted', async () => {
    const c = ctxOf({ assertRole: forbidden });
    const e = await fail(logCriticalNotification(c.ctx, EV, input()));
    expect(e.code).toBe('common.not_found');
    expect(c.asked).toEqual([expect.objectContaining({ permission: 'lab.critical_value.log_notification', centreId: CENTRE })]);
    expect(c.of('insertCriticalNotification')).toHaveLength(0);
    expect(c.of('updateCriticalEvent')).toHaveLength(0);
  });
  it('another IdentityPort failure (not auth.forbidden) is not masked', async () => {
    const c = ctxOf({ assertRole: async () => { throw new LimsError('common.internal'); } });
    expect((await fail(logCriticalNotification(c.ctx, EV, input()))).code).toBe('common.internal');
  });
});

describe('T-15 getCriticalValue (#36)', () => {
  it('returns the event, its notifications (store order) and referrer_display_name via CatalogPort.getReferrer({ referrerId, purpose: "display" })', async () => {
    const c = ctxOf({ notes: [note(1, { outcome: 'not_reached', read_back_confirmed: false, read_back_text: null }), note(2)] });
    const r = await getCriticalValue(c.ctx, EV);
    expect(r.event).toMatchObject({ id: EV, status: 'open', analyte_code: 'K', flag: 'HH', direction: 'high' });
    expect(r.notifications.map((n: any) => n.id)).toEqual([u(0xf1), u(0xf2)]);
    expect(r.referrerDisplayName).toBe('Dr. Test Referrer 0001');
    expect(c.referrerCalls).toEqual([{ referrerId: REFERRER, purpose: 'display' }]);
    expect(c.of('listCriticalNotifications')[0]).toMatchObject({ tenantId: TENANT, arg: EV });
  });
  it('no referrer on the order: getReferrer is not called and referrerDisplayName is absent (not null / empty)', async () => {
    const c = ctxOf({ events: [event({ referrer_id: null })] });
    const r = await getCriticalValue(c.ctx, EV);
    expect(c.referrerCalls).toHaveLength(0);
    expect(r.referrerDisplayName).toBeUndefined();
    expect('referrerDisplayName' in r && r.referrerDisplayName !== undefined).toBe(false);
  });
  it('audit: one access row action critical_value.view, entityType critical_value, entityId = event id, centre, outcome allowed', async () => {
    const c = ctxOf();
    await getCriticalValue(c.ctx, EV);
    expect(c.access).toHaveLength(1);
    expect(c.access[0]).toMatchObject({ action: 'critical_value.view', entityType: 'critical_value', entityId: EV, centreId: CENTRE, outcome: 'allowed' });
    expect(JSON.stringify(c.access)).not.toContain('6.9');            // the audit row carries ids, never the value (REQ-SEC-006)
  });
  it('permission lab.critical_value.read asserted on the event centre; auth.forbidden -> 404 with no audit row and no notification read', async () => {
    const c = ctxOf({ assertRole: forbidden });
    const e = await fail(getCriticalValue(c.ctx, EV));
    expect(e.code).toBe('common.not_found');
    expect(c.asked).toEqual([expect.objectContaining({ permission: 'lab.critical_value.read', centreId: CENTRE })]);
    expect(c.access).toHaveLength(0);
    expect(c.of('listCriticalNotifications')).toHaveLength(0);
    expect(c.referrerCalls).toHaveLength(0);
  });
  it('P-01: unknown / other-tenant event -> 404 common.not_found, no audit, tenant from ctx', async () => {
    const c = ctxOf({ events: [event({ tenant_id: OTHER_TENANT })] });
    const e = await fail(getCriticalValue(c.ctx, EV));
    expect(e.code).toBe('common.not_found');
    expect(c.access).toHaveLength(0);
    for (const x of c.calls) expect(x.tenantId, x.fn).toBe(TENANT);
  });
});

describe('T-15 listCriticalValues (#35)', () => {
  it('forwards status / detected_at range / centre / cursor / limit with the ctx tenant and returns rows + nextCursor', async () => {
    const c = ctxOf({ page: { nextCursor: 'CUR2' } });
    const q = { status: 'open', detectedAtFrom: '2026-06-01T00:00:00.000Z', detectedAtTo: '2026-06-16T00:00:00.000Z', centreId: CENTRE, cursor: 'CUR1', limit: 25 };
    const r = await listCriticalValues(c.ctx, q);
    expect(c.of('listCriticalEvents')).toHaveLength(1);
    expect(c.of('listCriticalEvents')[0]).toMatchObject({ tenantId: TENANT, arg: q });
    expect(r.rows.map((x: any) => x.id)).toEqual([EV]);
    expect(r.nextCursor).toBe('CUR2');
  });
  it('P-03: rows of another tenant are never returned', async () => {
    const c = ctxOf({ events: [event(), event({ id: u(0xe2), tenant_id: OTHER_TENANT })] });
    const r = await listCriticalValues(c.ctx, { limit: 50 });
    expect(r.rows.map((x: any) => x.id)).toEqual([EV]);
  });
  it('audit: ONE critical_value.view row per call, entityType critical_value, no entityId, detail.count = number of rows (the list shows values)', async () => {
    const c = ctxOf({ events: [event(), event({ id: u(0xe2) })] });
    await listCriticalValues(c.ctx, { limit: 50 });
    expect(c.access).toHaveLength(1);
    expect(c.access[0]).toMatchObject({ action: 'critical_value.view', entityType: 'critical_value', outcome: 'allowed', detail: { count: 2 } });
    expect(c.access[0]).not.toHaveProperty('entityId');
  });
  it('an empty page is still audited once with count 0', async () => {
    const c = ctxOf({ events: [] });
    const r = await listCriticalValues(c.ctx, { limit: 50 });
    expect(r.rows).toEqual([]);
    expect(c.access).toHaveLength(1);
    expect(c.access[0]).toMatchObject({ detail: { count: 0 } });
  });
});

describe('T-15 closeCriticalEventsForResult — close on approve / cancel (R6 / R8)', () => {
  for (const reason of ['approved', 'cancelled'] as const)
    it(`${reason}: closes every open|notified event of the result in the same transaction, closed_at = now, tenant from ctx; returns the closed ids`, async () => {
      const c = ctxOf({ closeIds: [EV, u(0xe2)] });
      const r = await closeCriticalEventsForResult(c.ctx, RESULT, reason);
      expect(c.of('closeOpenCriticalEvents')).toHaveLength(1);
      expect(c.of('closeOpenCriticalEvents')[0]).toMatchObject({ tenantId: TENANT, arg: { resultId: RESULT } });
      expect(new Date(c.of('closeOpenCriticalEvents')[0]!.arg.closedAt).toISOString()).toBe(NOW.toISOString());
      expect(r.closedEventIds).toEqual([EV, u(0xe2)]);
    });
  it('no open event: returns an empty list and does not throw (a result without a critical value is approved all the time)', async () => {
    const c = ctxOf({ closeIds: [] });
    expect((await closeCriticalEventsForResult(c.ctx, RESULT, 'approved')).closedEventIds).toEqual([]);
  });
  it('closing is not a notification: no notification row is written and nothing is published', async () => {
    const c = ctxOf({ closeIds: [EV] });
    await closeCriticalEventsForResult(c.ctx, RESULT, 'approved');
    expect(c.of('insertCriticalNotification')).toHaveLength(0);
    expect(c.published).toHaveLength(0);
  });
  it('a malformed reason is refused (only approved | cancelled close an event)', async () => {
    const c = ctxOf();
    await expect(closeCriticalEventsForResult(c.ctx, RESULT, 'verified' as never)).rejects.toBeDefined();
    expect(c.of('closeOpenCriticalEvents')).toHaveLength(0);
  });
});
