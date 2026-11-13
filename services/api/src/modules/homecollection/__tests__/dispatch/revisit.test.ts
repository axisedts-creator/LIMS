// HC-T09 / H7 createHomeRevisit (02-TRD §5.1 H7; PRD US-11-3; review #4). Real PG17 tx, helpers.ts harness. Fails now: H7 is the HC-T01 stub.
// US-11-4 (expected specimens of a revisit at pull time) belongs to the snapshot (A2), not to this task. Parents come from assignedVisit (routes from 2028-05-01; H7 itself has no route rule).
import { describe, expect, it } from 'vitest';
import { DISPATCHER, DISPATCHER_B, NOBODY, PHLEBO, SYS_ACTOR, T, assignedVisit, bookingVisit, day, failure, q, revisit, schemaErrors, uid, viaPipeline, visitRow } from './helpers.js';

const BASE = '2028-05-01';
let n = 0;
const D = (): string => day(BASE, n++);
const parentOf = (status: string, extra: Record<string, unknown> = {}) =>
  assignedVisit({ date: D(), status, extra: { landmark: 'Opposite the synthetic bakery', latitude: '27.717200', longitude: '85.324000', ...extra } }).then((x) => x.visit);
const children = (parentId: string) => q('SELECT id FROM homecollection.visits WHERE parent_visit_id = $1', [parentId]);
const body = { reason_code: 'failed_visit', reason_text: 'Synthetic: patient was out' };

describe('US-11-3 revisit of a failed visit, or of a completed visit with outcome = partial', () => {
  it.each<[string, string, Record<string, unknown>, string]>([
    ['failed', 'failed', {}, 'failed_visit'],
    ['completed + partial', 'completed', { outcome: 'partial' }, 'partial_collection'],
  ])('%s parent -> 201, a NEW kind=revisit visit: same order, same patient/centre/branch, address copied, unassigned, parent untouched', { timeout: T }, async (_n, status, extra, reason) => {
    const p = await parentOf(status, extra);
    const r = await revisit({ visitId: p.id, version: p.version, body: { reason_code: reason, reason_text: 'Synthetic reason' } });
    expect(r.status).toBe(201);
    expect(schemaErrors('VisitDetailDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ kind: 'revisit', status: 'unassigned', parent_visit_id: p.id, order_id: p.order_id, patient_id: p.patient_id, centre_id: p.centre_id, branch_id: p.branch_id });
    expect(r.body.id).not.toBe(p.id);
    expect(r.body).not.toHaveProperty('route_id');
    const row = await visitRow(r.body.id);
    expect(row).toMatchObject({ kind: 'revisit', status: 'unassigned', parent_visit_id: p.id, order_id: p.order_id, booking_id: null, route_id: null, assigned_membership_id: null,
      address_text: p.address_text, landmark: 'Opposite the synthetic bakery' });
    expect([Number(row.latitude), Number(row.longitude)]).toEqual([27.7172, 85.324]);
    expect(await visitRow(p.id)).toMatchObject({ status, version: p.version });                 // the parent is history, never edited
    expect(await children(p.id)).toHaveLength(1);
  });
  it.each(['unassigned', 'assigned', 'in_progress', 'cancelled'] as const)('parent %s -> 409 homecollection.visit_closed, no visit created', { timeout: T }, async (status) => {
    const p = status === 'unassigned' ? await bookingVisit({}, 'a', '2026-11-12') : await parentOf(status);
    const e = await failure(revisit({ visitId: p.id, version: p.version, body }));
    expect(e.code).toBe('homecollection.visit_closed');
    expect(e.statusCode).toBe(409);
    expect(await children(p.id)).toEqual([]);
  });
  it.each([['collected'], ['none']])('completed with outcome %s -> 409 homecollection.visit_closed (only a partial completion may be revisited)', { timeout: T }, async (outcome) => {
    const p = await parentOf('completed', { outcome });
    const e = await failure(revisit({ visitId: p.id, version: p.version, body }));
    expect(e.code).toBe('homecollection.visit_closed');
    expect(await children(p.id)).toEqual([]);
  });
  it('H7 bad parent is the registered 409, NOT 400 common.validation_failed (review #4)', { timeout: T }, async () => {
    const p = await parentOf('assigned');
    const e = await failure(revisit({ visitId: p.id, version: p.version, body }));
    expect(e.code).not.toBe('common.validation_failed');
    expect(e.statusCode).toBe(409);
  });
  it('ASSUMED: parent whose order is cancelled (FrontdeskPort.getOrderSummary status) -> 409 homecollection.visit_closed', { timeout: T }, async () => {
    const p = await parentOf('failed');
    const e = await failure(revisit({ visitId: p.id, version: p.version, body, fx: { orderStatus: 'cancelled' } }));
    expect(e.code).toBe('homecollection.visit_closed');
    expect(await children(p.id)).toEqual([]);
  });
});

describe('idempotency (required on H7): same key replays the stored 201, one revisit only', () => {
  it('through the pipeline: second call is the stored response (Idempotent-Replayed: true); exactly one child visit', { timeout: T }, async () => {
    const p = await parentOf('failed'); const idem = `t09-${uid().replace(/-/g, '').slice(0, 20)}`;
    const a = { visitId: p.id, version: p.version, body, idem, routeTemplate: '/v1/homecollection/visits/{visit_id}/revisits' };
    const first = await viaPipeline('createHomeRevisit', a);
    expect(first).toMatchObject({ replay: false, status: 201 });
    const second = await viaPipeline('createHomeRevisit', a);
    expect(second).toMatchObject({ replay: true, status: 201 });
    expect(second.body).toEqual(JSON.parse(JSON.stringify(first.body)));
    expect(await children(p.id)).toHaveLength(1);
  });
});

describe('validation + security: nothing is created on refusal', () => {
  it.each<[string, unknown]>([
    ['reason_code missing', {}],
    ['reason_code outside revisit_reasons', { reason_code: 'patient_refused' }],
    ['reason_code of another set (visit_cancel_reasons)', { reason_code: 'duplicate' }],
    ["'other' without reason_text (requires_text)", { reason_code: 'other' }],
    ['reason_text 501 chars', { reason_code: 'failed_visit', reason_text: 'x'.repeat(501) }],
    ['unknown field order_id (the revisit always reuses the parent order)', { ...body, order_id: uid() }],
    ['unknown field tenant_id', { ...body, tenant_id: uid() }],
    ['body is an array', []],
  ])('400 common.validation_failed: %s', { timeout: T }, async (_n, b) => {
    const p = await parentOf('failed');
    const e = await failure(revisit({ visitId: p.id, version: p.version, body: b }));
    expect(e.code).toBe('common.validation_failed');
    expect(await children(p.id)).toEqual([]);
  });
  it.each([['phlebotomist (sync.upload only)', PHLEBO], ['no grants', NOBODY]])('403 auth.forbidden without homecollection.visit.assign: %s', { timeout: T }, async (_n, who) => {
    const p = await parentOf('failed');
    expect((await failure(revisit({ visitId: p.id, version: p.version, body, who }))).code).toBe('auth.forbidden');
    expect(await children(p.id)).toEqual([]);
  });
  it.each([[false], [true]])("another tenant's visit: 404 common.not_found (RLS %s)", { timeout: T }, async (bypass) => {
    const p = await parentOf('failed');
    const e = await failure(revisit({ visitId: p.id, version: p.version, body, who: DISPATCHER_B, bypassRls: bypass }));
    expect(e.code).toBe('common.not_found');
    expect(await children(p.id)).toEqual([]);
  });
  it('visit id not a uuid -> 400; unknown -> 404', { timeout: T }, async () => {
    expect((await failure(revisit({ visitId: "x'; --", version: 1, body }))).code).toBe('common.validation_failed');
    expect((await failure(revisit({ visitId: uid(), version: 1, body }))).code).toBe('common.not_found');
  });
  it('dispatcher identity comes from the claims: created_by of the new visit is the caller actor', { timeout: T }, async () => {
    const p = await parentOf('failed');
    const r = await revisit({ visitId: p.id, version: p.version, body, who: DISPATCHER });
    const [row] = await q('SELECT created_by::text AS created_by FROM homecollection.visits WHERE id = $1', [r.body.id]);
    expect(row.created_by).toBe(SYS_ACTOR);
  });
});
