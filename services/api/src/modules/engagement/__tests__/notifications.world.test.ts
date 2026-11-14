// C16.T-P5: self-test of the notifications test world (so a handler test failure is never the world's fault). Passes before implementation.
import { describe, expect, it } from 'vitest';
import { ACC1, ACC2, ACC_B, LINK1, NID, TB, makeWorld, selectNotifications, seedNotifications } from './notifications.world.js';

const NOW = '2026-11-05T04:15:00.000Z';
const ids = (rows: any[]) => rows.map((r) => r.id);
const q = (text: string, values: unknown[] = []) => selectNotifications(seedNotifications().filter((r) => r.account_id === ACC1), text, values, NOW);

describe('selectNotifications evaluator', () => {
  it('ORDER BY created_at DESC, id and LIMIT $n / literal', () => {
    expect(ids(q('SELECT * FROM engagement.notifications WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT $2', ['t', 2]))).toEqual([]); // tenant bind is not A's uuid
    const tenant = seedNotifications()[0]!['tenant_id'];
    expect(ids(q('SELECT * FROM engagement.notifications WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT $2', [tenant, 2]))).toEqual([NID(1), NID(2)]);
    expect(ids(q('select id from engagement.notifications order by created_at desc limit 3'))).toEqual([NID(1), NID(2), NID(3)]);
  });
  it('IS NULL / IS NOT NULL / AND / OR / = ANY($n)::uuid[] / now()', () => {
    expect(ids(q('SELECT * FROM engagement.notifications WHERE read_at IS NULL ORDER BY created_at DESC'))).toEqual([NID(1), NID(3), NID(4), NID(5)]);
    expect(ids(q('SELECT * FROM engagement.notifications WHERE read_at IS NOT NULL'))).toEqual([NID(2)]);
    expect(ids(q('SELECT * FROM engagement.notifications WHERE id = ANY($1::uuid[]) ORDER BY id', [[NID(3), NID(1), NID(99)]]))).toEqual([NID(1), NID(3)]);
    expect(ids(q('SELECT * FROM engagement.notifications WHERE kind = $1 OR kind = $2 ORDER BY id', ['report_ready', 'profile_paused']))).toEqual([NID(1), NID(4)]);
    expect(ids(q('SELECT * FROM engagement.notifications WHERE expires_at > now()'))).toHaveLength(5);
  });
  it('keyset forms: row-value and OR/AND expansion, created_at DESC', () => {
    const after = ['2026-11-04T09:00:00.000Z', NID(2)];
    expect(ids(q('SELECT * FROM engagement.notifications WHERE (created_at, id) < ($1::timestamptz, $2::uuid) ORDER BY created_at DESC, id', after))).toEqual([NID(3), NID(4), NID(5)]);
    expect(ids(q('SELECT * FROM engagement.notifications WHERE created_at < $1 OR (created_at = $1 AND id > $2) ORDER BY created_at DESC, id', after))).toEqual([NID(3), NID(4), NID(5)]);
  });
  it('an unsupported statement shape is loud', () => {
    expect(() => q('SELECT * FROM engagement.notifications n JOIN engagement.accounts a ON a.id = n.account_id')).toThrow(/notifications-world: unsupported/);
  });
});

describe('world RLS + trigger', () => {
  it('a patient session sees and updates only its account; read_at is the only mutable column', async () => {
    const w = makeWorld();
    const s = w.session('patient');
    const mine: any = await s.tx.query('SELECT * FROM engagement.notifications ORDER BY id', []);
    expect(ids(mine.rows)).toEqual([NID(1), NID(2), NID(3), NID(4), NID(5)]);
    const r: any = await s.tx.query('UPDATE engagement.notifications SET read_at = $1 WHERE id = ANY($2::uuid[]) RETURNING id', [NOW, [NID(1), NID(6), NID(7)]]);
    expect(ids(r.rows)).toEqual([NID(1)]);
    expect(w.row(NID(6))!['read_at']).toBeNull();
    await expect(s.tx.query('UPDATE engagement.notifications SET kind = $1 WHERE id = $2', ['sample_recollection', NID(1)])).rejects.toThrow();
    const links: any = await s.tx.query('SELECT * FROM engagement.account_patient_links WHERE patient_id = ANY($1::uuid[])', [[w.tables['account_patient_links']![0]!['patient_id']]]);
    expect(ids(links.rows)).toEqual([LINK1]);
  });
  it('tenant B / account 2 sessions see only their own rows', async () => {
    const w = makeWorld();
    expect(ids(((await w.session('patient', {}, TB, ACC_B).tx.query('SELECT * FROM engagement.notifications', [])) as any).rows)).toEqual([NID(7)]);
    expect(ids(((await w.session('patient', {}, undefined, ACC2).tx.query('SELECT * FROM engagement.notifications', [])) as any).rows)).toEqual([NID(6)]);
  });
});
