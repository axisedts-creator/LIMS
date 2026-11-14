// C6-T23 self-check of the test harness (delivery.helpers.ts): the DDL rules it enforces for the delivery tables must fire, or the T23 tests would pass on buggy SQL.
// Not a test of any implementation; these cases pass today.
import { describe, expect, it } from 'vitest';
import { D, ACC, deliveryWorld, dRow, linkRow, makeTransport, sentRow, TENANT_A, TENANT_B, SYSTEM_ACTOR, NOW, LAB, I, rejection } from './delivery.helpers.js';

const INS = `INSERT INTO reporting.deliveries (id, tenant_id, centre_id, channel, purpose, template_code, recipient_kind, recipient_id, params, idempotency_key, status, fallback_of_delivery_id, created_by, updated_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $13)`;
const args = (id: string, key: string, over: Partial<Record<number, unknown>> = {}) => {
  const v: unknown[] = [id, TENANT_A, I.centre, 'sms', 'report_ready', 'reporting.report_ready', 'patient', I.patient, '{"lab_name":"Synthetic Lab"}', key, 'queued', null, SYSTEM_ACTOR];
  for (const [i, x] of Object.entries(over)) v[Number(i)] = x; return v;
};

describe('harness: deliveries', () => {
  it('defaults are filled, JSON text is parsed, a duplicate idempotency key is 23505 (or skipped with ON CONFLICT DO NOTHING)', async () => {
    const w = deliveryWorld(); await w.tx.query(INS, args(D(1), 'k1'));
    expect(w.delivery(D(1))).toMatchObject({ attempt_no: 1, version: 1, language: 'en', params: { lab_name: 'Synthetic Lab' }, status: 'queued' });
    expect((await rejection(w.tx.query(INS, args(D(2), 'k1')))).code).toBe('23505');
    const r = await w.tx.query(`${INS} ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`, args(D(3), 'k1'));
    expect(r.rows).toEqual([]); expect(w.deliveries().map((d) => d['id'])).toEqual([D(1)]);
  });
  it('CHECKs: bad channel / purpose / print-without-NULL-template / unknown template are rejected', async () => {
    const w = deliveryWorld();
    for (const [i, x] of [[3, 'fax'], [4, 'marketing'], [5, 'no.such_template']] as const) expect((await rejection(w.tx.query(INS, args(D(9), `k${i}`, { [i]: x })))).code).toMatch(/23514|23503/);
    expect((await rejection(w.tx.query(INS, args(D(9), 'kp', { 3: 'print' })))).code).toBe('23514');
  });
  it('one fallback per delivery (partial unique index) and the FK to an existing delivery', async () => {
    const w = deliveryWorld({ deliveries: [dRow(1)] });
    await w.tx.query(INS, args(D(2), 'f1', { 11: D(1) }));
    expect((await rejection(w.tx.query(INS, args(D(3), 'f2', { 11: D(1) })))).code).toBe('23505');
    expect((await rejection(w.tx.query(INS, args(D(4), 'f3', { 11: D(77) })))).code).toBe('23503');
    const again = await w.tx.query(`${INS} ON CONFLICT DO NOTHING RETURNING id`, args(D(5), 'f4', { 11: D(1) })); expect(again.rows).toEqual([]);
  });
  it('immutable columns, scrub-only params, status machine', async () => {
    const w = deliveryWorld({ deliveries: [dRow(1, { params: { lab_name: 'L', url: 'https://x/r/AAAAAAAAAAAAAAAAAAAAAA', otp_code: '123456' } }), sentRow(2, 5)] });
    expect((await rejection(w.tx.query(`UPDATE reporting.deliveries SET channel = $3 WHERE tenant_id = $1 AND id = $2`, [TENANT_A, D(1), 'sms']))).code).toBe('P0001');
    expect((await rejection(w.tx.query(`UPDATE reporting.deliveries SET params = $3::jsonb WHERE tenant_id = $1 AND id = $2`, [TENANT_A, D(1), '{"lab_name":"X"}']))).code).toBe('P0001');
    await w.tx.query(`UPDATE reporting.deliveries SET params = params - 'url' - 'otp_code', version = version + 1 WHERE tenant_id = $1 AND id = $2`, [TENANT_A, D(1)]);
    expect(w.delivery(D(1))).toMatchObject({ params: { lab_name: 'L' }, version: 2 });
    expect((await rejection(w.tx.query(`UPDATE reporting.deliveries SET status = $3 WHERE tenant_id = $1 AND id = $2`, [TENANT_A, D(2), 'queued']))).code).toBe('P0001');
    await w.tx.query(`UPDATE reporting.deliveries SET status = $3, delivered_at = $4 WHERE tenant_id = $1 AND id = $2`, [TENANT_A, D(2), 'delivered', NOW]);
    expect(w.delivery(D(2))['status']).toBe('delivered');
  });
});

describe('harness: attempts, links, runner', () => {
  const ATT = `INSERT INTO reporting.delivery_attempts (id, tenant_id, delivery_id, attempt_no, started_at, outcome, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`;
  it('delivery_attempts: append-only, unique attempt_no, outcome set, FK', async () => {
    const w = deliveryWorld({ deliveries: [dRow(1)] });
    await w.tx.query(ATT, [D(100), TENANT_A, D(1), 1, NOW, 'retryable_error', SYSTEM_ACTOR]);
    expect((await rejection(w.tx.query(ATT, [D(101), TENANT_A, D(1), 1, NOW, 'accepted', SYSTEM_ACTOR]))).code).toBe('23505');
    expect((await rejection(w.tx.query(ATT, [D(102), TENANT_A, D(1), 2, NOW, 'sent', SYSTEM_ACTOR]))).code).toBe('23514');
    expect((await rejection(w.tx.query(ATT, [D(103), TENANT_A, D(9), 1, NOW, 'accepted', SYSTEM_ACTOR]))).code).toBe('23503');
    expect((await rejection(w.tx.query(`UPDATE reporting.delivery_attempts SET outcome = $3 WHERE tenant_id = $1 AND id = $2`, [TENANT_A, D(100), 'accepted']))).code).toBe('42501');
  });
  it('portal_links: token hash 32 bytes + globally unique, ttl <= 90 days, dues only for patient sms/whatsapp', async () => {
    const w = deliveryWorld({ links: [linkRow(1)] });
    const INSL = `INSERT INTO reporting.portal_links (id, tenant_id, centre_id, report_id, bound_version_no, channel, recipient_kind, patient_display_snapshot, token_sha256, expires_at, purpose, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`;
    const ok = (id: string, tok: Buffer, o: Record<number, unknown> = {}) => { const v: unknown[] = [id, TENANT_A, I.centre, LAB, 1, 'sms', 'patient', 'T. P.', tok, '2026-12-01T00:00:00.000Z', 'report', SYSTEM_ACTOR]; for (const [i, x] of Object.entries(o)) v[Number(i)] = x; return v; };
    await w.tx.query(INSL, ok(D(1), Buffer.alloc(32, 1)));
    expect((await rejection(w.tx.query(INSL, ok(D(2), Buffer.alloc(32, 1))))).code).toBe('23505');
    expect((await rejection(w.tx.query(INSL, ok(D(3), Buffer.alloc(31, 2))))).code).toBe('23514');
    expect((await rejection(w.tx.query(INSL, ok(D(4), Buffer.alloc(32, 3), { 9: '2027-03-01T00:00:00.000Z' })))).code).toBe('23514');
    expect((await rejection(w.tx.query(INSL, ok(D(5), Buffer.alloc(32, 4), { 10: 'dues', 6: 'referrer' })))).code).toBe('23514');
  });
  it('run(): a throw rolls the writes back unless ctx.commitOnError() was called first; events / jobs follow', async () => {
    const w = deliveryWorld({ deliveries: [dRow(1)] });
    const mark = async (_p: unknown, c: any) => { await c.tx.query(`UPDATE reporting.deliveries SET version = version + 1 WHERE tenant_id = $1 AND id = $2`, [TENANT_A, D(1)]); await c.events.publish(c, 'x', { aggregate: {}, idempotencyKey: 'k', payload: {} }); throw new Error('boom'); };
    expect(((await w.run(mark, {})) as Error).message).toBe('boom'); expect(w.delivery(D(1))['version']).toBe(1); expect(w.published).toHaveLength(0);
    const keep = async (p: unknown, c: any) => { c.commitOnError(); await mark(p, c); };
    expect(((await w.run(keep, {})) as Error).message).toBe('boom'); expect(w.delivery(D(1))['version']).toBe(2);
  });
  it('makeTransport records calls and throws the scripted error', async () => {
    const t = makeTransport('recording', (n) => (n === 1 ? new Error('x') : 'ok'));
    await expect(t.send({ to: 'a' }, {})).rejects.toThrow('x'); expect((await t.send({ to: 'b' }, {})).providerMessageId).toBe('recording-msg-2'); expect(t.calls).toBe(2);
    void ACC; void TENANT_B;
  });
});
