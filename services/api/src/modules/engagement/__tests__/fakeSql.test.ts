// Self-test of the T-Q2 test fake (fakeSql.ts): proves the fake itself behaves like Postgres where T-Q2's tests rely on it (passes now; it is not an implementation test).
import { describe, expect, it } from 'vitest';
import { FakeDb, queueSchemaDefs, type Row } from './fakeSql.js';

const A = 'tenant-a', C1 = 'c1', C2 = 'c2';
const clock = { iso: '2026-11-05T04:15:00.000Z' };
const tok = (n: number, over: Row = {}): Row => ({ id: `t${n}`, tenant_id: A, centre_id: C1, queue_id: 'q1', business_date: '2026-11-05', seq: n, token_label: `A-00${n}`, priority: 'normal', status: 'waiting',
  booking_id: null, counter_id: null, issued_at: `2026-11-05T04:0${n}:00.000Z`, called_at: null, call_count: 0, serving_started_at: null, completed_at: null, transferred_to_token_id: null,
  transferred_from_token_id: null, version: 1, created_at: clock.iso, created_by: 'u', updated_at: clock.iso, updated_by: 'u', ...over });
const db0 = (tokens: Row[] = [tok(1), tok(2), tok(3, { priority: 'priority' })]) => new FakeDb({
  queue_definitions: [{ id: 'q1', tenant_id: A, centre_id: C1, board_version: 7 }, { id: 'q2', tenant_id: A, centre_id: C1, board_version: 1 }], queue_counters: [], queue_day_counters: [],
  collection_centres: [{ id: C1, tenant_id: A }], settings: [], queue_tokens: tokens }, queueSchemaDefs(clock), clock);
const all = { all: true, centres: [] as string[] };
const CALL_NEXT = `SELECT id, version FROM engagement.queue_tokens WHERE tenant_id = $1 AND queue_id = $2 AND business_date = $3 AND status = 'waiting'
  ORDER BY priority DESC, issued_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;

describe('fakeSql', () => {
  it('SELECT .. ORDER BY priority DESC, issued_at LIMIT 1 FOR UPDATE SKIP LOCKED: two sessions get two different rows; the first row is the priority token', async () => {
    const db = db0(); const s1 = db.session(A, all), s2 = db.session(A, all);
    const [r1, r2] = await Promise.all([s1.tx.query(CALL_NEXT, [A, 'q1', '2026-11-05']), s2.tx.query(CALL_NEXT, [A, 'q1', '2026-11-05'])]);
    expect([r1.rows[0].id, r2.rows[0].id].sort()).toEqual(['t1', 't3']);
    const s3 = db.session(A, all); expect((await s3.tx.query(CALL_NEXT, [A, 'q1', '2026-11-05'])).rows[0].id).toBe('t2');
    const s4 = db.session(A, all); expect((await s4.tx.query(CALL_NEXT, [A, 'q1', '2026-11-05'])).rows).toHaveLength(0); // all three locked by others
  });
  it('plain FOR UPDATE waits for the lock holder and re-checks the predicate after the wait', async () => {
    const db = db0([tok(1)]); const s1 = db.session(A, all), s2 = db.session(A, all);
    const q = `SELECT id FROM engagement.queue_tokens WHERE tenant_id = $1 AND status = 'waiting' FOR UPDATE`;
    await s1.tx.query(q, [A]);
    const second = s2.tx.query(q, [A]);
    await s1.tx.query(`UPDATE engagement.queue_tokens SET status = 'called', version = version + 1 WHERE tenant_id = $1 AND id = $2`, [A, 't1']);
    s1.release();
    expect((await second).rows).toHaveLength(0); // status changed while waiting
  });
  it('UPDATE: binds, col + 1, now(), RETURNING, version predicate; trigger refuses immutable columns; transfer check', async () => {
    const db = db0(); const s = db.session(A, all);
    const u = await s.tx.query(`UPDATE engagement.queue_tokens SET status = 'called', counter_id = $4, call_count = call_count + 1, called_at = now(), version = version + 1, updated_by = $5 WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`, [A, 't1', 1, null, 'u2']);
    expect(u.rows[0]).toMatchObject({ status: 'called', call_count: 1, version: 2, called_at: clock.iso, updated_by: 'u2' });
    const stale = await s.tx.query(`UPDATE engagement.queue_tokens SET status = 'called' WHERE tenant_id = $1 AND id = $2 AND version = $3`, [A, 't1', 1]);
    expect(stale.rowCount).toBe(0);
    await expect(s.tx.query(`UPDATE engagement.queue_tokens SET seq = 9 WHERE tenant_id = $1 AND id = $2`, [A, 't2'])).rejects.toMatchObject({ code: 'P0001' });
    await expect(s.tx.query(`UPDATE engagement.queue_tokens SET status = 'transferred' WHERE tenant_id = $1 AND id = $2`, [A, 't2'])).rejects.toMatchObject({ code: '23514' });
    await expect(s.tx.query(`UPDATE engagement.queue_tokens SET call_count = $3 WHERE tenant_id = $1 AND id = $2`, [A, 't2', 10])).rejects.toMatchObject({ code: '23514' });
  });
  it('UPDATE .. WHERE status IN (..) AND business_date = $2 touches exactly the matching rows of the session tenant', async () => {
    const db = db0([tok(1), tok(2, { status: 'serving' }), tok(3, { status: 'completed' }), tok(4, { business_date: '2026-11-06' }), tok(5, { tenant_id: 'tenant-b' })]); const s = db.session(A, all);
    const r = await s.tx.query(`UPDATE engagement.queue_tokens SET status = 'expired', version = version + 1 WHERE tenant_id = $1 AND business_date = $2 AND status IN ('waiting','called','serving')`, [A, '2026-11-05']);
    expect(r.rowCount).toBe(2);
    expect(db.tables['queue_tokens']!.map((t) => t['status'])).toEqual(['expired', 'expired', 'completed', 'waiting', 'waiting']);
  });
  it('INSERT: ON CONFLICT DO NOTHING, unique 23505, unknown column 42703, RLS 42501, FK 23503, NOT NULL 23502; day counter UPDATE .. last_seq + 1 RETURNING', async () => {
    const db = db0([]); const s = db.session(A, { all: false, centres: [C1] });
    const ins = `INSERT INTO engagement.queue_day_counters (tenant_id, queue_id, centre_id, business_date, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, queue_id, business_date) DO NOTHING`;
    expect((await s.tx.query(ins, [A, 'q1', C1, '2026-11-05', 'u'])).rowCount).toBe(1);
    expect((await s.tx.query(ins, [A, 'q1', C1, '2026-11-05', 'u'])).rowCount).toBe(0);
    const seq = await s.tx.query(`UPDATE engagement.queue_day_counters SET last_seq = last_seq + 1, updated_at = now() WHERE tenant_id = $1 AND queue_id = $2 AND business_date = $3 RETURNING last_seq`, [A, 'q1', '2026-11-05']);
    expect(seq.rows[0].last_seq).toBe(1);
    const tokIns = (cols: string, vals: unknown[]) => s.tx.query(`INSERT INTO engagement.queue_tokens (${cols}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, vals);
    const base = { id: 'n1', tenant_id: A, centre_id: C1, queue_id: 'q1', business_date: '2026-11-05', seq: 1, token_label: 'A-001', issued_at: clock.iso, created_by: 'u', updated_by: 'u' };
    const ok = await tokIns(Object.keys(base).join(', '), Object.values(base));
    expect(ok.rows[0]).toMatchObject({ status: 'waiting', priority: 'normal', call_count: 0, version: 1 });
    await expect(tokIns(Object.keys({ ...base, id: 'n2' }).join(', '), Object.values({ ...base, id: 'n2' }))).rejects.toMatchObject({ code: '23505' });
    await expect(tokIns('patient_name', ['Synthetic'])).rejects.toMatchObject({ code: '42703' });
    const o = { ...base, id: 'n3', seq: 3, token_label: 'A-003' };
    await expect(tokIns(Object.keys({ ...o, centre_id: C2 }).join(', '), Object.values({ ...o, centre_id: C2 }))).rejects.toMatchObject({ code: '42501' });
    await expect(tokIns(Object.keys({ ...o, queue_id: 'nope' }).join(', '), Object.values({ ...o, queue_id: 'nope' }))).rejects.toMatchObject({ code: '23503' });
    await expect(tokIns(Object.keys({ ...o, token_label: 'bad' }).join(', '), Object.values({ ...o, token_label: 'bad' }))).rejects.toMatchObject({ code: '23514' });
    const { issued_at: _i, ...noIssued } = o;
    await expect(tokIns(Object.keys(noIssued).join(', '), Object.values(noIssued))).rejects.toMatchObject({ code: '23502' });
  });
  it('RLS hides other tenants and other centres; DELETE and unsupported SQL are loud', async () => {
    const db = db0([tok(1), tok(2, { centre_id: C2 }), tok(3, { tenant_id: 'tenant-b' })]); const s = db.session(A, { all: false, centres: [C1] });
    expect((await s.tx.query(`SELECT * FROM engagement.queue_tokens WHERE queue_id = $1`, ['q1'])).rows.map((r) => r.id)).toEqual(['t1']);
    expect((await s.tx.query(`SELECT count(*) FROM engagement.queue_tokens WHERE tenant_id = $1`, [A])).rows[0].count).toBe(1);
    await expect(s.tx.query(`DELETE FROM engagement.queue_tokens WHERE id = $1`, ['t1'])).rejects.toThrow(/DELETE is not allowed/);
    await expect(s.tx.query(`UPDATE engagement.queue_tokens SET status = CASE WHEN true THEN 'x' END WHERE id = $1`, ['t1'])).rejects.toThrow(/fake-sql: unsupported/);
  });
});

describe('fakeSql ON CONFLICT DO UPDATE (T-B2 upsert support)', () => {
  it('inserts a new row, updates the existing one from excluded.*, keeps untouched columns, RETURNING works, plain duplicate still 23505', async () => {
    const defs = { booking_centres: { columns: ['id', 'tenant_id', 'centre_id', 'display_name', 'created_by', 'synced_at'], unique: [['tenant_id', 'centre_id']] } };
    const db = new FakeDb({ booking_centres: [] }, defs, clock); const s = db.session(A, all);
    const up = `INSERT INTO engagement.booking_centres (id, tenant_id, centre_id, display_name, created_by, synced_at) VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (tenant_id, centre_id) DO UPDATE SET display_name = EXCLUDED.display_name, synced_at = EXCLUDED.synced_at RETURNING *`;
    await s.tx.query(up, ['r1', A, C1, 'Old', 'u1']);
    clock.iso = '2026-11-06T04:15:00.000Z';
    const r = await s.tx.query(up, ['r2', A, C1, 'New', 'u2']);
    expect(db.tables['booking_centres']).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ id: 'r1', display_name: 'New', created_by: 'u1', synced_at: '2026-11-06T04:15:00.000Z' });
    await expect(s.tx.query(`INSERT INTO engagement.booking_centres (id, tenant_id, centre_id) VALUES ($1, $2, $3)`, ['r3', A, C1])).rejects.toMatchObject({ code: '23505' });
  });
});
