// T0D-FIX-1 item 5a (LD-446, CR DEPLOY-AXIS-012 items 4 and 5): ctx.now() is an ISO STRING in the real pipeline. listPendingItems called
// `now.getTime()` on it and /lab/pending answered 500. The service must normalise the clock and compute the same ages for a string and for a Date.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlers } from '../index.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const u = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW_MS = Date.parse('2026-11-22T06:00:00.000Z');
const MIN = 60_000;

const rows = [
  { id: u(1), tenant_id: TENANT, order_id: u(11), specimen_id: u(21), barcode: 'E2600000001', registration_no: 'R2600001', patient_id: u(77), test_id: u(700), test_code: 'CBC', catalog_revision: 1,
    priority: 'routine', status: 'in_process', received_at: new Date(NOW_MS - 30 * MIN), registered_at: new Date(NOW_MS - 180 * MIN), ordered_at: new Date(NOW_MS - 180 * MIN),
    tat_target_seconds: 600, centre_id: u(0xa1), department_id: u(0xd1) },
  { id: u(2), tenant_id: TENANT, order_id: u(12), specimen_id: null, barcode: null, registration_no: 'R2600002', patient_id: u(77), test_id: u(700), test_code: 'CBC', catalog_revision: 1,
    priority: 'routine', status: 'awaiting_collection', received_at: null, registered_at: new Date(NOW_MS - 120 * MIN), ordered_at: new Date(NOW_MS - 120 * MIN),
    tat_target_seconds: null, centre_id: u(0xa1), department_id: u(0xd1) },
];

function ctxWith(now: unknown) {
  const listPendingRows = vi.fn(async (..._a: unknown[]) => rows);
  const ctx = {
    operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    tenantId: TENANT, actor: { type: 'user', id: ACTOR }, tx: { id: 'tx' }, now,
    audit: { async access() {} },
    store: { listPendingRows },
    ports: {
      IdentityPort: { async assertRole() {}, async getActor() { return { centreScope: { all: true, centreIds: [] } }; } },
      FrontdeskPort: { async getPatientDemographicsBatch(_c: unknown, i: any) { return i.patientIds.map((id: string) => ({ patientId: id, patientCode: 'PC1', fullName: 'Synthetic Patient', sex: 'female', ageAtOrder: { years: 30, months: 0, days: 0 } })); } },
    },
  };
  return { ctx: ctx as never, listPendingRows };
}
const pending = (c: unknown, query: Record<string, unknown> = {}) => (handlers as any)['listPendingItems']({ params: {}, query, headers: {}, body: undefined }, c) as Promise<any>;

afterEach(() => { vi.useRealTimers(); });

describe('listPendingItems clock (item 5a)', () => {
  it('ISO string clock -> 200 and ages from the ctx clock (in_process: since received 1800 s; awaiting: since registered 7200 s)', async () => {
    const { ctx } = ctxWith(() => new Date(NOW_MS).toISOString());
    const r = await pending(ctx);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.data.map((d: any) => [d.order_test_id, d]));
    expect(by[u(1)]).toMatchObject({ age_seconds: 1800, age_anchor: 'received', over_target: true });
    expect(by[u(2)]).toMatchObject({ age_seconds: 7200, age_anchor: 'registered' });
  });
  it('Date clock gives the identical answer', async () => {
    const s = await pending(ctxWith(() => new Date(NOW_MS).toISOString()).ctx);
    const d = await pending(ctxWith(() => new Date(NOW_MS)).ctx);
    expect(d.status).toBe(200);
    expect(d.body).toEqual(s.body);
  });
  it('a frozen wall clock far from the ctx clock changes nothing: the ctx clock rules', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'));
    const r = await pending(ctxWith(() => new Date(NOW_MS).toISOString()).ctx);
    expect(r.body.data.find((x: any) => x.order_test_id === u(1)).age_seconds).toBe(1800);
  });
  it('the store still receives `now` as a Date at the same instant', async () => {
    const { ctx, listPendingRows } = ctxWith(() => new Date(NOW_MS).toISOString());
    await pending(ctx, { over_target: 'true' });
    const arg = listPendingRows.mock.calls[0]![2] as { now: unknown };
    expect(arg.now).toBeInstanceOf(Date);
    expect((arg.now as Date).getTime()).toBe(NOW_MS);
  });
  it('the numeric limit the validator injects (50) works with the string clock', async () => {
    expect((await pending(ctxWith(() => new Date(NOW_MS).toISOString()).ctx, { limit: 50 })).status).toBe(200);
  });
  it('a ctx without a clock function still fails closed (common.internal), not a TypeError', async () => {
    const e = await pending(ctxWith(undefined).ctx).then(() => undefined, (x) => x);
    expect(e?.code).toBe('common.internal');
  });
});
