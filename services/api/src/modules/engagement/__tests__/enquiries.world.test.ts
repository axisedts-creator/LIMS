// Self-test of the T-N1 test world (enquiries.world.ts): proves the fake models what enquiry.handlers.test.ts relies on (RLS, keyset select, count, row locks, append-only). Passes before the implementation.
import { describe, expect, it } from 'vitest';
import { ACC1, ACC2, EQ, MEMBERSHIP, MS, NOW, PAT1, PAT2, TB, makeWorld } from './enquiries.world.js';

const q = (w: ReturnType<typeof makeWorld>, who: 'patient' | 'staff', text: string, values: unknown[] = [], tenant?: string, account?: string) => w.session(who, {}, tenant, account).ctx.tx.query(text, values);
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code ?? e.message; } return 'RESOLVED'; };

describe('enquiries world', () => {
  it('SELECT: tenant + PAT_ACC isolation, IN, keyset (row value), ORDER/LIMIT and count(*)', async () => {
    const w = makeWorld();
    expect((await q(w, 'staff', 'SELECT * FROM engagement.enquiries WHERE tenant_id = $1', [w.tables['enquiries']![0]!['tenant_id']])).rows.map((r: any) => r.id).sort()).toEqual([EQ(1), EQ(2), EQ(3), EQ(4)]);
    expect((await q(w, 'patient', 'SELECT * FROM engagement.enquiries e WHERE e.account_id = $1 ORDER BY e.last_message_at DESC, e.id DESC', [ACC1])).rows.map((r: any) => r.id)).toEqual([EQ(1), EQ(2), EQ(3)]);
    expect((await q(w, 'patient', 'SELECT * FROM engagement.enquiries WHERE account_id = $1', [ACC2])).rows).toEqual([]); // PAT_ACC: naming another account's id finds nothing
    expect((await q(w, 'patient', 'SELECT * FROM engagement.enquiries WHERE id = $1', [EQ(4)])).rows).toEqual([]);
    expect((await q(w, 'staff', "SELECT id FROM engagement.enquiries WHERE status IN ('open','answered') AND (last_message_at, id) < ($1::timestamptz, $2::uuid) ORDER BY last_message_at DESC, id DESC LIMIT 2", ['2026-11-04T11:00:00.000Z', EQ(9)])).rows.map((r: any) => r.id)).toEqual([EQ(4), EQ(1)]); // E4 ties on last_message_at and has the smaller id
    expect((await q(w, 'patient', "SELECT count(*)::int AS n FROM engagement.enquiries WHERE account_id = $1 AND status = 'open'", [ACC1])).rows[0]).toMatchObject({ n: 1, count: 1 });
    expect((await q(w, 'staff', 'SELECT * FROM engagement.enquiries WHERE id = $1', [EQ(5)])).rows).toEqual([]); // tenant B row invisible to tenant A
    expect((await q(w, 'staff', 'SELECT * FROM engagement.enquiries', [], TB)).rows.map((r: any) => r.id)).toEqual([EQ(5)]);
  });

  it('unsupported SQL is loud, never a silent pass', async () => {
    const w = makeWorld();
    expect(await fails(q(w, 'staff', 'SELECT e.id FROM engagement.enquiries e JOIN engagement.accounts a ON a.id = e.account_id'))).toMatch(/unsupported/);
    expect(await fails(q(w, 'staff', 'SELECT pg_try_advisory_xact_lock(1)'))).toMatch(/unsupported/);
  });

  it('INSERT RLS: a patient creates only its own enquiry about an active link; only staff write staff messages; patients cannot insert notifications', async () => {
    const w = makeWorld();
    const ins = (acc: string, patient: string | null) => q(w, 'patient', 'INSERT INTO engagement.enquiries (id, tenant_id, account_id, patient_id, category_code, subject, last_message_at, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *',
      [EQ(40), w.tables['enquiries']![0]!['tenant_id'], acc, patient, 'report', 's', NOW, MEMBERSHIP[ACC1]]);
    expect(await fails(ins(ACC2, null))).toBe('42501');
    expect(await fails(ins(ACC1, PAT2))).toBe('42501'); // another account's patient
    expect((await ins(ACC1, PAT1)).rowCount).toBe(1);
    const msg = (who: 'patient' | 'staff', kind: string) => q(w, who, 'INSERT INTO engagement.enquiry_messages (id, tenant_id, enquiry_id, account_id, author_kind, author_id, body, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [MS(40 + Math.floor(Math.random() * 50)), w.tables['enquiries']![0]!['tenant_id'], EQ(1), ACC1, kind, ACC1, 'b', MEMBERSHIP[ACC1]]);
    expect(await fails(msg('patient', 'staff'))).toBe('42501');
    expect(await fails(msg('staff', 'patient'))).toBe('42501');
    expect((await msg('patient', 'patient')).rowCount).toBe(1);
    expect(await fails(q(w, 'patient', 'INSERT INTO engagement.notifications (id, tenant_id, account_id, kind, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [EQ(41), w.tables['enquiries']![0]!['tenant_id'], ACC1, 'enquiry_reply', MEMBERSHIP[ACC1], NOW]))).toBe('42501');
  });

  it('UPDATE: PAT_ACC cannot touch another account\'s row; messages are append-only; version + 1 works', async () => {
    const w = makeWorld();
    expect((await q(w, 'patient', 'UPDATE engagement.enquiries SET version = version + 1 WHERE id = $1', [EQ(4)])).rowCount).toBe(0);
    expect((await q(w, 'patient', 'UPDATE engagement.enquiries SET version = version + 1 WHERE id = $1 AND version = $2', [EQ(1), 3])).rowCount).toBe(1);
    expect(w.enquiry(EQ(1))!['version']).toBe(4);
    expect(await fails(q(w, 'staff', 'UPDATE engagement.enquiry_messages SET body = $1 WHERE id = $2', ['x', MS(1)]))).toBe('P0001');
    expect(await fails(q(w, 'staff', "UPDATE engagement.enquiries SET status = 'closed' WHERE id = $1", [EQ(1)]))).toBe('23514'); // closed without closed_at
  });

  it('FOR UPDATE serialises two requests until the first releases; pg_advisory_xact_lock serialises on its argument', async () => {
    const w = makeWorld();
    const order: string[] = [];
    const a = w.session('staff'), b = w.session('staff');
    await a.ctx.tx.query('SELECT * FROM engagement.enquiries WHERE id = $1 FOR UPDATE', [EQ(1)]);
    const pb = b.ctx.tx.query('SELECT * FROM engagement.enquiries WHERE id = $1 FOR UPDATE', [EQ(1)]).then(() => order.push('b'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    a.release();
    await pb;
    expect(order).toEqual(['b']);
    b.release();
    const c = w.session('patient'), d = w.session('patient'), e = w.session('patient');
    await c.ctx.tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['acc']);
    const pd = d.ctx.tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['acc']).then(() => order.push('d'));
    await e.ctx.tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['other']); // another key: not blocked
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['b']);
    c.release(); await pd;
    expect(order).toEqual(['b', 'd']);
  });

  it('every other port is recorded, never real; log / audit / metrics sinks capture arguments', async () => {
    const w = makeWorld();
    const s = w.session('staff');
    await s.ctx.ports.SmsPort.send({ to: 'x', text: 'hello' });
    s.ctx.log.info('line', { a: 1 });
    expect(w.portCalls).toEqual([{ port: 'SmsPort', method: 'send', args: [{ to: 'x', text: 'hello' }] }]);
    expect(w.logs).toEqual([['line', { a: 1 }]]);
  });
});
