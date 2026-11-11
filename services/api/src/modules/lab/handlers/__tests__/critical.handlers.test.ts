// C5 T-15 handlers: #35 listCriticalValues, #36 getCriticalValue, #37 logCriticalNotification (02-TRD §5.5, §11; PRD AC-13.4–13.6; 07-SECURITY S-05/S-06/S-12/S-19, P-01/P-02/P-03/P-07; REQ-SEC-099 no stub).
// Fails now: handlers/index.ts maps all three to the T-01 stub (common.internal) and service/critical.service.ts does not exist.
// Handler contract as in resultEntry.handlers.test.ts: (req:{params,query,headers,body}, ctx) -> {status, body}; needs ctx.tenantId + ctx.actor.id + ctx.tx else auth.unauthenticated;
//   a ctx without store/ports fails closed with common.internal. Schema / auth / x-permission / Idempotency-Key are enforced by the core pipeline, NOT here (lab.yaml is read below to pin the contract).
// SEAM: store / ports / audit come from the ctx exactly as documented in service/__tests__/critical.service.test.ts (header). The handler maps snake_case body <-> camelCase service input and rows -> contract DTOs
//   (CriticalValueDto, CriticalValueDetail, CriticalNotificationDto of contracts/openapi/lab.yaml; timestamps as ISO strings; DTO keys only; #37 answers 201).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const spec: any = parse(readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/lab.yaml', import.meta.url)), 'utf8'));
const S = spec.components.schemas;
const keysOf = (n: string): string[] => Object.keys(S[n].properties);
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
  status: 'open', first_confirmed_notification_at: null, value_changed_after_detection: false, closed_at: null, version: 3, result_status: 'resulted', created_by: u(0xc1), updated_by: u(0xc1), ...over,
});
const note = (n: number, over: Record<string, unknown> = {}) => ({
  id: u(0xf0 + n), tenant_id: TENANT, centre_id: CENTRE, critical_event_id: EV, notified_party_kind: 'clinician', notified_party_name: 'Dr Synthetic', contact_method: 'phone', contact_detail: null,
  notified_at: new Date(NOW.getTime() - (10 - n) * MIN), outcome: 'reached', read_back_confirmed: true, read_back_text: 'six point nine', comment: null,
  notified_by_membership_id: MEMBERSHIP, created_by: ACTOR, created_at: new Date(NOW.getTime() - (10 - n) * MIN), ...over,
});

function ctxOf(over: { events?: any[]; notes?: any[]; assertRole?: (r: any) => Promise<void>; nextCursor?: string } = {}) {
  const calls: { fn: string; tenantId: unknown; arg: any }[] = [];
  const access: any[] = [], asked: any[] = [], referrerCalls: any[] = [];
  const rec = (fn: string, tenantId: unknown, arg: any) => calls.push({ fn, tenantId, arg });
  const events = new Map((over.events ?? [event()]).map((e) => [e.id, e]));
  const notes: any[] = [...(over.notes ?? [])];
  const store = {
    async getCriticalEvent(_t: unknown, tn: string, id: string) { rec('getCriticalEvent', tn, id); const e = events.get(id); return e && e.tenant_id === tn ? e : undefined; },
    async listCriticalEvents(_t: unknown, tn: string, q: any) { rec('listCriticalEvents', tn, q); return { rows: [...events.values()].filter((e) => e.tenant_id === tn), ...(over.nextCursor === undefined ? {} : { nextCursor: over.nextCursor }) }; },
    async listCriticalNotifications(_t: unknown, tn: string, id: string) { rec('listCriticalNotifications', tn, id); return notes.filter((n) => n.critical_event_id === id && n.tenant_id === tn); },
    async insertCriticalNotification(_t: unknown, tn: string, a: any) {
      rec('insertCriticalNotification', tn, a);
      return { id: NID, tenant_id: tn, centre_id: a.centreId, critical_event_id: a.eventId, notified_party_kind: a.notifiedPartyKind, notified_party_name: a.notifiedPartyName, contact_method: a.contactMethod,
        contact_detail: a.contactDetail ?? null, notified_at: new Date(a.notifiedAt), outcome: a.outcome, read_back_confirmed: a.readBackConfirmed, read_back_text: a.readBackText ?? null, comment: a.comment ?? null,
        notified_by_membership_id: a.notifiedByMembershipId, created_by: ACTOR, created_at: NOW };
    },
    async updateCriticalEvent(_t: unknown, tn: string, a: any) { rec('updateCriticalEvent', tn, a); },
    async closeOpenCriticalEvents() { return []; },
  };
  const ctx = {
    operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    tenantId: TENANT, actor: { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, tx: { id: 'tx' }, now: () => NOW, store,
    events: { async publish() { return { eventId: 'e', duplicate: false }; } },
    audit: { async access(e: unknown) { access.push(e); } },
    ports: {
      CatalogPort: { async getReferrer(_c: unknown, i: any) { referrerCalls.push(i); return { referrerId: i.referrerId, displayName: 'Dr. Test Referrer 0001', code: 'DR001' }; } },
      IdentityPort: { async assertRole(_c: unknown, r: any) { asked.push(r); await over.assertRole?.(r); } },
    },
  };
  return { ctx: ctx as never, calls, of: (fn: string) => calls.filter((c) => c.fn === fn), access, asked, referrerCalls };
}
const run = (op: string, req: unknown, c: unknown): Promise<any> => (handlers as any)[op](req, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const forbidden = async () => { throw new LimsError('auth.forbidden'); };
const getReq = (id: string) => ({ params: { critical_event_id: id }, query: {}, headers: {}, body: undefined }) as never;
const listReq = (query: Record<string, unknown> = {}) => ({ params: {}, query, headers: {}, body: undefined }) as never;
const postReq = (body: unknown, id = EV) => ({ params: { critical_event_id: id }, query: {}, headers: { 'idempotency-key': 't15-1' }, body }) as never;
const goodBody = (over: Record<string, unknown> = {}) => ({
  notified_party_kind: 'clinician', notified_party_name: 'Dr Synthetic', contact_method: 'phone', notified_at: NOW.toISOString(), outcome: 'reached', read_back_confirmed: true, read_back_text: 'six point nine', ...over,
});
const LEAK = /tenant_id|created_by|updated_by|patient_id|analyte_id|referrer_id|result_status|value_sha256|notified_by_membership_id|"version"|processing_centre/;

describe('T-15 contract of lab.yaml #35–#37 (the handlers must fit it)', () => {
  const op = (path: string, m: string) => spec.paths[path][m];
  it('permissions, idempotency and the 201 answer of #37', () => {
    expect(op('/v1/lab/critical-values', 'get')).toMatchObject({ operationId: 'listCriticalValues', 'x-permission': 'lab.critical_value.read' });
    expect(op('/v1/lab/critical-values/{critical_event_id}', 'get')).toMatchObject({ operationId: 'getCriticalValue', 'x-permission': 'lab.critical_value.read' });
    const post = op('/v1/lab/critical-values/{critical_event_id}/notifications', 'post');
    expect(post).toMatchObject({ operationId: 'logCriticalNotification', 'x-permission': 'lab.critical_value.log_notification', 'x-idempotency': 'required' });
    expect(Object.keys(post.responses)).toContain('201');
  });
  it('#37 body: closed object; no notified_by / tenant / created fields can be sent', () => {
    const b = op('/v1/lab/critical-values/{critical_event_id}/notifications', 'post').requestBody.content['application/json'].schema;
    expect(b.additionalProperties).toBe(false);
    expect(Object.keys(b.properties).sort()).toEqual(['comment', 'contact_detail', 'contact_method', 'notified_at', 'notified_party_kind', 'notified_party_name', 'outcome', 'read_back_confirmed', 'read_back_text']);
    expect(b.required.sort()).toEqual(['contact_method', 'notified_at', 'notified_party_kind', 'notified_party_name', 'outcome', 'read_back_confirmed']);
    expect(b.properties.outcome.enum).toEqual(['reached', 'not_reached', 'left_message']);
    expect(b.properties.notified_party_name).toMatchObject({ minLength: 1, maxLength: 120 });
    expect(b.properties.read_back_text.maxLength).toBe(300);
    expect(b.properties.comment.maxLength).toBe(500);
    expect(b.properties.contact_detail.maxLength).toBe(60);
  });
  it('response DTOs expose no actor / tenant / internal columns', () => {
    for (const n of ['CriticalValueDto', 'CriticalValueDetail', 'CriticalNotificationDto']) {
      for (const k of keysOf(n)) expect(k, `${n}.${k}`).not.toMatch(/tenant|created_by|notified_by|patient_id|referrer_id|sha256/);
    }
    expect(keysOf('CriticalValueDetail')).toEqual(expect.arrayContaining(['notifications', 'referrer_display_name']));
  });
});

describe('T-15 are real handlers, not the T-01 stub (REQ-SEC-099)', () => {
  const REQS: Record<string, unknown> = { listCriticalValues: listReq(), getCriticalValue: getReq(EV), logCriticalNotification: postReq(goodBody()) };
  for (const opId of Object.keys(REQS))
    it(`${opId}: ctx without tenantId/actor/tx -> auth.unauthenticated (the stub answers common.internal)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      expect((await fail(run(opId, REQS[opId], bare))).code).toBe('auth.unauthenticated');
    });
  it('mapped to functions distinct from the shared stub', () => {
    const stub = (handlers as any).getResultHistory;
    for (const opId of Object.keys(REQS)) expect((handlers as any)[opId], opId).not.toBe(stub);
  });
});

describe('T-15 logCriticalNotification (#37) request -> service -> response', () => {
  it('201 with a CriticalNotificationDto: snake_case allowlist keys, recorded_at = created_at, ISO strings, no actor/tenant internals', async () => {
    const c = ctxOf();
    const r = await run('logCriticalNotification', postReq(goodBody({ contact_detail: '+977-0000', comment: 'called ward' })), c.ctx);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: NID, critical_event_id: EV, notified_party_kind: 'clinician', notified_party_name: 'Dr Synthetic', contact_method: 'phone', contact_detail: '+977-0000', outcome: 'reached',
      read_back_confirmed: true, read_back_text: 'six point nine', comment: 'called ward', notified_at: NOW.toISOString(), recorded_at: NOW.toISOString() });
    for (const k of Object.keys(r.body)) expect(keysOf('CriticalNotificationDto'), k).toContain(k);
    for (const k of S.CriticalNotificationDto.required) expect(r.body, k).toHaveProperty(k);
    expect(JSON.stringify(r.body)).not.toMatch(LEAK);
  });
  it('snake_case body is mapped to the store call; notified_by = ctx membership; tenant/centre from ctx and the event (AC-13.4)', async () => {
    const c = ctxOf();
    await run('logCriticalNotification', postReq(goodBody({ contact_detail: 'x', comment: 'y' })), c.ctx);
    expect(c.of('insertCriticalNotification')[0]).toMatchObject({
      tenantId: TENANT,
      arg: { eventId: EV, centreId: CENTRE, notifiedPartyKind: 'clinician', notifiedPartyName: 'Dr Synthetic', contactMethod: 'phone', contactDetail: 'x', outcome: 'reached', readBackConfirmed: true, readBackText: 'six point nine', comment: 'y', notifiedByMembershipId: MEMBERSHIP },
    });
  });
  it('a notified_by_membership_id / tenant_id / created_by in the body is ignored (REQ-SEC-024)', async () => {
    const c = ctxOf();
    await run('logCriticalNotification', postReq(goodBody({ notified_by_membership_id: 'EVIL', tenant_id: 'EVIL', created_by: 'EVIL', centre_id: 'EVIL' })), c.ctx);
    expect(JSON.stringify(c.calls)).not.toContain('EVIL');
    expect(c.of('insertCriticalNotification')[0]!.arg.notifiedByMembershipId).toBe(MEMBERSHIP);
  });
  it('AC-13.6: first reached + read-back confirmed moves the event to notified with first_confirmed_notification_at', async () => {
    const c = ctxOf();
    await run('logCriticalNotification', postReq(goodBody()), c.ctx);
    expect(c.of('updateCriticalEvent')[0]).toMatchObject({ tenantId: TENANT, arg: { eventId: EV, status: 'notified', expectedVersion: 3 } });
  });
  it('not_reached notification: 201, status untouched', async () => {
    const c = ctxOf();
    const r = await run('logCriticalNotification', postReq(goodBody({ outcome: 'not_reached', read_back_confirmed: false, read_back_text: undefined })), c.ctx);
    expect(r.status).toBe(201);
    expect(r.body.read_back_confirmed).toBe(false);
    expect(c.of('updateCriticalEvent')).toHaveLength(0);
  });
  it('read_back_confirmed = true without read_back_text -> 400 common.validation_failed at /read_back_text, nothing written', async () => {
    const c = ctxOf();
    for (const b of [goodBody({ read_back_text: undefined }), goodBody({ read_back_text: '' })]) {
      const e = await fail(run('logCriticalNotification', postReq(b), c.ctx));
      expect(e.code).toBe('common.validation_failed');
      expect(e.statusCode).toBe(400);
      expect((e.errors ?? []).map((x: any) => x.path)).toContain('/read_back_text');
    }
    expect(c.of('insertCriticalNotification')).toHaveLength(0);
    expect(c.of('updateCriticalEvent')).toHaveLength(0);
  });
  it('S-06: notified_at > now + 5 min -> 400 at /notified_at; exactly now + 5 min is accepted', async () => {
    const c = ctxOf();
    const e = await fail(run('logCriticalNotification', postReq(goodBody({ notified_at: iso(5 * MIN + 1000) })), c.ctx));
    expect(e.code).toBe('common.validation_failed');
    expect((e.errors ?? []).map((x: any) => x.path)).toContain('/notified_at');
    expect(c.of('insertCriticalNotification')).toHaveLength(0);
    expect((await run('logCriticalNotification', postReq(goodBody({ notified_at: iso(5 * MIN) })), c.ctx)).status).toBe(201);
  });
  it('P-01/P-07: event of another tenant / unknown -> 404 common.not_found, nothing inserted', async () => {
    const c = ctxOf({ events: [event({ tenant_id: OTHER_TENANT })] });
    const e = await fail(run('logCriticalNotification', postReq(goodBody()), c.ctx));
    expect(e.code).toBe('common.not_found');
    expect(e.statusCode).toBe(404);
    expect(c.of('insertCriticalNotification')).toHaveLength(0);
  });
  it('P-02: a centre the caller lacks (assertRole auth.forbidden) -> 404, never 403; permission asked = lab.critical_value.log_notification on the event centre', async () => {
    const c = ctxOf({ assertRole: forbidden });
    const e = await fail(run('logCriticalNotification', postReq(goodBody()), c.ctx));
    expect(e.code).toBe('common.not_found');
    expect(c.asked).toEqual([expect.objectContaining({ permission: 'lab.critical_value.log_notification', centreId: CENTRE })]);
    expect(c.of('insertCriticalNotification')).toHaveLength(0);
  });
  it('S-19: validation errors never echo the read-back text or party name', async () => {
    const c = ctxOf();
    const e = await fail(run('logCriticalNotification', postReq(goodBody({ read_back_text: 'x'.repeat(301), notified_party_name: 'Dr Secret Name' })), c.ctx));
    expect(JSON.stringify([e.message, e.errors ?? []])).not.toMatch(/Secret Name|xxxxxxxx/);
  });
});

describe('T-15 getCriticalValue (#36)', () => {
  it('200 CriticalValueDetail: value as string, ISO timestamps, notifications (ordered), referrer_display_name; allowlisted keys only', async () => {
    const c = ctxOf({ notes: [note(1, { outcome: 'not_reached', read_back_confirmed: false, read_back_text: null }), note(2)], events: [event({ status: 'notified', first_confirmed_notification_at: new Date(NOW.getTime() - 8 * MIN) })] });
    const r = await run('getCriticalValue', getReq(EV), c.ctx);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: EV, result_id: RESULT, order_id: ORDER, analyte_code: 'K', value: '6.9', unit_code: 'mmol/L', flag: 'HH', direction: 'high', status: 'notified', centre_id: CENTRE,
      detected_at: iso(-10 * MIN), first_confirmed_notification_at: iso(-8 * MIN), value_changed_after_detection: false, referrer_display_name: 'Dr. Test Referrer 0001',
    });
    for (const k of Object.keys(r.body)) expect(keysOf('CriticalValueDetail'), k).toContain(k);
    for (const k of S.CriticalValueDetail.required) expect(r.body, k).toHaveProperty(k);
    expect(r.body.notifications.map((n: any) => [n.id, n.outcome, n.read_back_confirmed])).toEqual([[u(0xf1), 'not_reached', false], [u(0xf2), 'reached', true]]);
    for (const n of r.body.notifications) for (const k of Object.keys(n)) expect(keysOf('CriticalNotificationDto'), k).toContain(k);
    expect(r.body.notifications[1]).toMatchObject({ recorded_at: iso(-8 * MIN), notified_at: iso(-8 * MIN) });
    expect(JSON.stringify(r.body)).not.toMatch(LEAK);
    expect(c.referrerCalls).toEqual([{ referrerId: REFERRER, purpose: 'display' }]);
  });
  it('value_text and ordinal_code events are shown as the value string (abnormal direction)', async () => {
    for (const [over, shown] of [[{ value_numeric: null, value_text: 'gram-positive cocci', direction: 'abnormal', flag: 'A' }, 'gram-positive cocci'], [{ value_numeric: null, ordinal_code: 'POS', direction: 'abnormal', flag: 'A' }, 'POS']] as const) {
      const r = await run('getCriticalValue', getReq(EV), ctxOf({ events: [event(over)] }).ctx);
      expect(r.body.value).toBe(shown);
    }
  });
  it('no referrer on the order: referrer_display_name key is absent (not null), getReferrer not called', async () => {
    const c = ctxOf({ events: [event({ referrer_id: null })] });
    const r = await run('getCriticalValue', getReq(EV), c.ctx);
    expect(r.body).not.toHaveProperty('referrer_display_name');
    expect(c.referrerCalls).toHaveLength(0);
  });
  it('a closed event shows closed_at; an open one omits the unset optional timestamps (no null keys)', async () => {
    const closed = await run('getCriticalValue', getReq(EV), ctxOf({ events: [event({ status: 'closed', closed_at: new Date(NOW.getTime() - MIN) })] }).ctx);
    expect(closed.body).toMatchObject({ status: 'closed', closed_at: iso(-MIN) });
    const open = await run('getCriticalValue', getReq(EV), ctxOf().ctx);
    expect(open.body).not.toHaveProperty('closed_at');
    expect(open.body).not.toHaveProperty('first_confirmed_notification_at');
    for (const v of Object.values(open.body)) expect(v).not.toBeNull();
  });
  it('audit: critical_value.view / critical_value / event id', async () => {
    const c = ctxOf();
    await run('getCriticalValue', getReq(EV), c.ctx);
    expect(c.access).toEqual([expect.objectContaining({ action: 'critical_value.view', entityType: 'critical_value', entityId: EV, outcome: 'allowed' })]);
  });
  it('P-01: unknown / other-tenant event -> 404 common.not_found, no audit row', async () => {
    const c = ctxOf({ events: [event({ tenant_id: OTHER_TENANT })] });
    const e = await fail(run('getCriticalValue', getReq(EV), c.ctx));
    expect(e.code).toBe('common.not_found');
    expect(e.statusCode).toBe(404);
    expect(c.access).toHaveLength(0);
  });
  it('P-02: forbidden centre -> 404 with no event data and no audit row; permission asked = lab.critical_value.read', async () => {
    const c = ctxOf({ assertRole: forbidden });
    const e = await fail(run('getCriticalValue', getReq(EV), c.ctx));
    expect(e.code).toBe('common.not_found');
    expect(JSON.stringify(e.errors ?? [])).not.toContain('6.9');
    expect(c.asked[0]).toMatchObject({ permission: 'lab.critical_value.read', centreId: CENTRE });
    expect(c.access).toHaveLength(0);
  });
});

describe('T-15 listCriticalValues (#35)', () => {
  it('200 { data: CriticalValueDto[], page: { limit, next_cursor? } }; values included (staff authz); allowlisted keys only', async () => {
    const c = ctxOf({ events: [event(), event({ id: u(0xe2), status: 'closed', closed_at: new Date(NOW.getTime() - MIN) })], nextCursor: 'CUR2' });
    const r = await run('listCriticalValues', listReq({ limit: 2 }), c.ctx);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['data', 'page']);
    expect(r.body.data.map((x: any) => [x.id, x.status, x.value])).toEqual([[EV, 'open', '6.9'], [u(0xe2), 'closed', '6.9']]);
    for (const x of r.body.data) {
      for (const k of Object.keys(x)) expect(keysOf('CriticalValueDto'), k).toContain(k);
      for (const k of S.CriticalValueDto.required) expect(x, k).toHaveProperty(k);
      expect(x).not.toHaveProperty('notifications');
    }
    expect(r.body.page).toEqual({ next_cursor: 'CUR2', limit: 2 });
    expect(JSON.stringify(r.body)).not.toMatch(LEAK);
  });
  it('last page: page has no next_cursor key', async () => {
    const r = await run('listCriticalValues', listReq({ limit: 50 }), ctxOf().ctx);
    expect(r.body.page).not.toHaveProperty('next_cursor');
    expect(r.body.page.limit).toBe(50);
  });
  it('query filters are forwarded in camelCase with the ctx tenant (status, detected_at_from/_to, centre_id, cursor)', async () => {
    const c = ctxOf();
    await run('listCriticalValues', listReq({ status: 'notified', detected_at_from: iso(-86_400_000), detected_at_to: iso(0), centre_id: CENTRE, cursor: 'CUR1', limit: 10 }), c.ctx);
    expect(c.of('listCriticalEvents')[0]).toMatchObject({
      tenantId: TENANT, arg: { status: 'notified', detectedAtFrom: iso(-86_400_000), detectedAtTo: iso(0), centreId: CENTRE, cursor: 'CUR1', limit: 10 },
    });
  });
  it('P-03: another tenant\'s events never appear', async () => {
    const c = ctxOf({ events: [event(), event({ id: u(0xe2), tenant_id: OTHER_TENANT })] });
    const r = await run('listCriticalValues', listReq({ limit: 50 }), c.ctx);
    expect(r.body.data.map((x: any) => x.id)).toEqual([EV]);
  });
  it('audit: one critical_value.view row per call with detail.count and no entityId', async () => {
    const c = ctxOf({ events: [event(), event({ id: u(0xe2) })] });
    await run('listCriticalValues', listReq({ limit: 50 }), c.ctx);
    expect(c.access).toHaveLength(1);
    expect(c.access[0]).toMatchObject({ action: 'critical_value.view', entityType: 'critical_value', detail: { count: 2 } });
    expect(c.access[0]).not.toHaveProperty('entityId');
  });
});
