// C9 T-19 — repository/tat.repo.ts SQL pins (02-TRD §9.3, §10.3 purge predicate; 05-SCHEMA §5-§7; 08 A17 D-59, P-18(c), P-21; REQ-SEC-022/024; 02-CV §5.13). No database; real-PG behaviour (RLS, the partial indexes, the
// triggers, grants) -> db/tests once the quality DDL lands, NOT covered here. The fake TatRepo in tat.helpers.ts implements these contracts: the predicates that decide the purge, the once-per-restart event key, the
// version guard of the ack and the "no version churn" touch are pinned HERE against the real statements. Fails now: "Cannot find module ../repository/tat.repo.js".
import { describe, expect, it } from 'vitest';
import { createTatRepo } from '../repository/tat.repo.js';
import { CEN, OIT, ORD, TAT, TENANT_A, TST, T, MEMB, idN, item } from './tat.helpers.js';

const SENTINEL = "x'; DROP TABLE quality.tat_items;--";
const ACTOR = idN(0xa1);
function tx(rows: any[] = [{ ...item(1), n: 1, id: TAT(1), order_id: ORD(1), registered_at: T('08:00:00'), ordered_at: T('08:00:00') }]) {
  const q: Array<{ text: string; values: unknown[] }> = [];
  return { q, tx: { async query(text: string, values: unknown[] = []) { q.push({ text, values }); return { rows, rowCount: rows.length }; } } as any };
}
const sql = (t: ReturnType<typeof tx>) => t.q.map((x) => x.text).join('\n;\n');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const repo = createTatRepo();
const ROW = (({ id: _i, version: _v, ...r }) => r)(item(1));
const calls: Array<[string, (r: typeof repo, t: any) => Promise<unknown>]> = [
  ['listPending', (r, t) => r.listPending(t, TENANT_A, { orderId: ORD(1) })],
  ['listTotalStarts', (r, t) => r.listTotalStarts(t, TENANT_A, [ORD(1), ORD(2)])],
  ['listEarliestOrdered', (r, t) => r.listEarliestOrdered(t, TENANT_A, [ORD(1), ORD(2)])],
  ['findItems', (r, t) => r.findItems(t, TENANT_A, [{ order_item_id: OIT(1), test_id: TST(1) }])],
  ['listOpenItems', (r, t) => r.listOpenItems(t, TENANT_A, { orderId: ORD(1) })],
  ['listItemsByOrder', (r, t) => r.listItemsByOrder(t, TENANT_A, ORD(1))],
  ['insertItems', (r, t) => r.insertItems(t, TENANT_A, ACTOR, [ROW])],
  ['updateItems', (r, t) => r.updateItems(t, TENANT_A, ACTOR, [{ id: TAT(1), set: { state: 'stopped', stopped_at: T('11:30:00'), stop_source: 'verified_event', expires_at: T('11:30:00', '2027-12-10') } }])],
  ['touchSeen', (r, t) => r.touchSeen(t, TENANT_A, [TAT(1), TAT(2)], T('11:13:00'))],
  ['insertAlertEvents', (r, t) => r.insertAlertEvents(t, TENANT_A, ACTOR, [{ tat_item_id: TAT(1), centre_id: CEN(1), level: 'warning', raised_at: T('11:12:00'), elapsed_seconds: 11_520, restart_no: 0 }])],
  ['deleteExpired', (r, t) => r.deleteExpired(t, TENANT_A, T('02:40:00'))],
  ['listAlerts', (r, t) => r.listAlerts(t, TENANT_A, { levels: ['warning'], acknowledged: false, segment: 'total', departmentId: idN(0x9601), centreId: CEN(1), priority: 'urgent', sort: '-alert_level_rank', now: T('11:30:00') }, { limit: 50 })],
  ['getItem', (r, t) => r.getItem(t, TENANT_A, TAT(1))],
  ['listLevelEvents', (r, t) => r.listLevelEvents(t, TENANT_A, TAT(1))],
  ['listAcks', (r, t) => r.listAcks(t, TENANT_A, TAT(1))],
  ['ack', (r, t) => r.ack(t, TENANT_A, { id: TAT(1), expectedVersion: 3, level: 'warning', note: 'n', at: T('11:20:00'), membershipId: MEMB(1), actorId: ACTOR })],
  ['listMembershipLabels', (r, t) => r.listMembershipLabels(t, TENANT_A, [MEMB(1)])],
];

describe('every statement: tenant predicate, bind parameters (REQ-SEC-024, REQ-SEC-022)', () => {
  it.each(calls)('%s', async (_n, call) => {
    const t = tx(); await call(repo, t.tx); expect(t.q.length).toBeGreaterThan(0);
    for (const s of t.q) { expect(s.text, 'tenant predicate').toMatch(/tenant_id\s*=\s*\$\d+/i); expect(s.values).toContain(TENANT_A); expect(s.text).not.toContain(TENANT_A); expect(flat(s.text)).not.toMatch(/;\s*\S/); }
  });
  it('every method is ONE statement (batched with unnest / ANY), so a sweep costs a bounded number of statements', async () => {
    for (const [n, call] of calls) { if (n === 'ack') continue; const t = tx(); await call(repo, t.tx); expect(t.q, n).toHaveLength(1); }
  });
  it('hostile ids / levels / notes are bound, never in SQL text', async () => {
    const t = tx(); await repo.listPending(t.tx, TENANT_A, { orderId: SENTINEL }); await repo.listTotalStarts(t.tx, TENANT_A, [SENTINEL]); await repo.findItems(t.tx, TENANT_A, [{ order_item_id: SENTINEL, test_id: SENTINEL }]);
    await repo.getItem(t.tx, TENANT_A, SENTINEL); await repo.ack(t.tx, TENANT_A, { id: SENTINEL, expectedVersion: 1, level: 'warning', note: SENTINEL, at: T('11:20:00'), membershipId: SENTINEL, actorId: ACTOR });
    await repo.listAlerts(t.tx, TENANT_A, { centreId: SENTINEL, sort: 'started_at', now: T('11:30:00') }, { limit: 5 });
    expect(sql(t)).not.toContain('DROP TABLE'); expect(t.q.some((s) => s.values.flat().includes(SENTINEL))).toBe(true);
  });
  it('a malformed sort / level never becomes SQL: the order-by is chosen from a fixed list', async () => {
    const t = tx(); await repo.listAlerts(t.tx, TENANT_A, { sort: "started_at; DROP TABLE quality.tat_items" as never, now: T('11:30:00') }, { limit: 5 }).catch(() => undefined); expect(sql(t)).not.toContain('DROP TABLE');
  });
});

describe('cross-schema reads: only the published views (02-CV §5.13; 08 P-21)', () => {
  it('listPending reads lab.v_pub_pending_items WHERE tat_target_seconds IS NOT NULL (+ order filter); never a base table', async () => {
    const t = tx(); await repo.listPending(t.tx, TENANT_A, {}); const s = flat(sql(t)); expect(s).toMatch(/\blab\.v_pub_pending_items\b/); expect(s).toMatch(/tat_target_seconds IS NOT NULL/i);
    expect(s).not.toMatch(/\b(lab\.(specimens|results|orders)|frontdesk\.|reporting\.reports)\b/i); const w = tx(); await repo.listPending(w.tx, TENANT_A, { orderId: ORD(1) }); expect(w.q[0]!.values).toContain(ORD(1)); expect(flat(w.q[0]!.text)).toMatch(/order_id\s*=\s*\$\d+/i);
  });
  it('listTotalStarts reads reporting.v_pub_order_report_tat.registered_at (D-59), listEarliestOrdered reads lab.v_pub_specimen_timeline min(ordered_at) grouped by order', async () => {
    const a = tx(); await repo.listTotalStarts(a.tx, TENANT_A, [ORD(1)]); expect(flat(sql(a))).toMatch(/\breporting\.v_pub_order_report_tat\b/); expect(flat(sql(a))).toMatch(/\bregistered_at\b/); expect(flat(sql(a))).toMatch(/order_id\s*=\s*ANY\(\$\d+/i);
    const b = tx(); await repo.listEarliestOrdered(b.tx, TENANT_A, [ORD(1)]); expect(flat(sql(b))).toMatch(/\blab\.v_pub_specimen_timeline\b/); expect(flat(sql(b))).toMatch(/\bmin\(\s*ordered_at\s*\)/i); expect(flat(sql(b))).toMatch(/GROUP BY\s+order_id/i);
  });
});

describe('writes', () => {
  it('insertItems: INSERT INTO quality.tat_items ... ON CONFLICT (tenant_id, order_item_id, test_id) DO NOTHING RETURNING (a concurrent creator wins); ids generated in SQL (app.uuidv7()); created_by / updated_by = the actor', async () => {
    const t = tx(); await repo.insertItems(t.tx, TENANT_A, ACTOR, [ROW]); const s = flat(sql(t));
    expect(s).toMatch(/^INSERT INTO quality\.tat_items\b/i); expect(s).toMatch(/ON CONFLICT \(tenant_id, order_item_id, test_id\) DO NOTHING/i); expect(s).toMatch(/RETURNING/i); expect(s).toMatch(/app\.uuidv7\(\)/i);
    expect(t.q[0]!.values).toContain(ACTOR); expect(s).not.toMatch(/\b(DELETE|TRUNCATE|DROP)\b/i); expect(s).toMatch(/\bcreated_by\b/); expect(s).toMatch(/\bupdated_by\b/);
  });
  it('insertItems with no rows issues no statement and returns []', async () => { const t = tx(); expect(await repo.insertItems(t.tx, TENANT_A, ACTOR, [])).toEqual([]); expect(t.q).toEqual([]); });
  it('updateItems: ONE UPDATE of quality.tat_items for all patches, version = version + 1, updated_by = actor, tenant + id predicate; only the named columns are set (no tenant_id / id / created_by)', async () => {
    const t = tx(); await repo.updateItems(t.tx, TENANT_A, ACTOR, [{ id: TAT(1), set: { state: 'stopped', stopped_at: T('11:30:00') } }, { id: TAT(2), set: { state: 'cancelled' } }]); const s = flat(sql(t));
    expect(t.q).toHaveLength(1); expect(s).toMatch(/^UPDATE quality\.tat_items\b/i); expect(s).toMatch(/\bversion\s*=\s*(\w+\.)?version\s*\+\s*1\b/i); expect(s).toMatch(/\bupdated_by\b/); expect(s).toMatch(/\bid\b/); expect(s).not.toMatch(/\bSET\b(?:(?!\bWHERE\b)[\s\S])*\b(tenant_id|created_by)\s*=/i);
  });
  it('updateItems rejects a column outside the allowlist (tenant_id, id, created_by, version, a hostile name) before any statement', async () => {
    for (const col of ['tenant_id', 'id', 'created_by', 'version', "state; DROP TABLE quality.tat_items", 'order_id']) { const t = tx(); const e = await repo.updateItems(t.tx, TENANT_A, ACTOR, [{ id: TAT(1), set: { [col]: 'x' } }]).then(() => undefined, (x) => x); expect(e, col).toBeInstanceOf(Error); expect(t.q, col).toEqual([]); }
  });
  it('touchSeen: ONE UPDATE of last_seen_sweep_at only — it must NOT touch version (a minute tick must not invalidate a user\'s If-Match)', async () => {
    const t = tx(); await repo.touchSeen(t.tx, TENANT_A, [TAT(1), TAT(2)], T('11:13:00')); const s = flat(sql(t)); expect(s).toMatch(/^UPDATE quality\.tat_items\b/i); expect(s).toMatch(/\blast_seen_sweep_at\b/); expect(s).not.toMatch(/\bversion\b/i); expect(s).not.toMatch(/\bupdated_(at|by)\b/i);
    expect(s).toMatch(/\bid\s*=\s*ANY\(\$\d+/i);
  });
  it('insertAlertEvents: INSERT INTO quality.tat_alert_events ... ON CONFLICT (tenant_id, tat_item_id, restart_no, level) DO NOTHING; append-only (no UPDATE / DELETE)', async () => {
    const t = tx(); await repo.insertAlertEvents(t.tx, TENANT_A, ACTOR, [{ tat_item_id: TAT(1), centre_id: CEN(1), level: 'warning', raised_at: T('11:12:00'), elapsed_seconds: 11_520, restart_no: 0 }]); const s = flat(sql(t));
    expect(s).toMatch(/^INSERT INTO quality\.tat_alert_events\b/i); expect(s).toMatch(/ON CONFLICT \(tenant_id, tat_item_id, restart_no, level\) DO NOTHING/i); expect(s).not.toMatch(/\b(UPDATE|DELETE)\b/i);
  });
  it('ack: the item UPDATE is guarded by version = expected and the ack row is inserted in the SAME statement-set only when that update hit a row (a lost race inserts no ack)', async () => {
    const t = tx(); await repo.ack(t.tx, TENANT_A, { id: TAT(1), expectedVersion: 3, level: 'warning', note: 'n', at: T('11:20:00'), membershipId: MEMB(1), actorId: ACTOR }); const s = flat(sql(t));
    expect(s).toMatch(/\bUPDATE quality\.tat_items\b/i); expect(s).toMatch(/\bversion\s*=\s*\$\d+/i); expect(s).toMatch(/\bINSERT INTO quality\.tat_alert_acks\b/i); expect(s).toMatch(/\backnowledged_level\b/); expect(s).toMatch(/\backnowledged_by\b/); expect(s).toMatch(/\backnowledged_at\b/);
    expect(t.q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, TAT(1), 3, 'warning', 'n', MEMB(1), ACTOR])); expect(s).toMatch(/RETURNING/i);
    if (t.q.length === 1) expect(s.indexOf('UPDATE quality.tat_items')).toBeLessThan(s.indexOf('INSERT INTO quality.tat_alert_acks'));   // one CTE statement: the insert selects FROM the update's RETURNING
  });
  it('ack returns undefined when no row came back (stale version or invisible centre)', async () => { const t = tx([]); expect(await repo.ack(t.tx, TENANT_A, { id: TAT(1), expectedVersion: 9, level: 'warning', note: null, at: T('11:20:00'), membershipId: MEMB(1), actorId: ACTOR })).toBeUndefined(); });
});

describe('deleteExpired: the purge predicate (08 A17 P-18(c); TRD §10.3)', () => {
  it('DELETE FROM quality.tat_items with tenant, expires_at < now, and NOT EXISTS on BOTH tat_alert_events and tat_alert_acks (same tenant, same item); nothing else is deleted', async () => {
    const t = tx([{ n: 3 }]); const n = await repo.deleteExpired(t.tx, TENANT_A, T('02:40:00')); const s = flat(sql(t));
    expect(t.q).toHaveLength(1); expect(s).toMatch(/^DELETE FROM quality\.tat_items\b/i); expect(s).toMatch(/tenant_id\s*=\s*\$\d+/i); expect(s).toMatch(/expires_at\s*<\s*\$\d+/i);
    for (const child of ['tat_alert_events', 'tat_alert_acks']) expect(s, child).toMatch(new RegExp(`NOT EXISTS\\s*\\(\\s*SELECT 1 FROM quality\\.${child}\\b[^)]*tenant_id\\s*=\\s*\\w+\\.tenant_id[^)]*tat_item_id\\s*=\\s*\\w+\\.id`, 'i'));
    expect(t.q[0]!.values).toContain(T('02:40:00')); expect(s).not.toContain(T('02:40:00')); expect(s).not.toMatch(/\bnow\(\)/i); expect([...s.matchAll(/\bDELETE FROM\s+([a-z_.]+)/gi)].map((m) => m[1])).toEqual(['quality.tat_items']); expect(n).toBeGreaterThanOrEqual(0);
  });
  it('a row with expires_at IS NULL is never matched (the comparison is strict, no COALESCE to the past)', async () => {
    const t = tx([{ n: 0 }]); await repo.deleteExpired(t.tx, TENANT_A, T('02:40:00')); expect(flat(sql(t))).not.toMatch(/COALESCE\(\s*(\w+\.)?expires_at/i);
  });
});

describe('reads: open alert list (AC-14.6, 14.7)', () => {
  it('listAlerts selects running clocks at warning or above only, bound filters, stable keyset paging with a tie-break on id, limit + 1 for next_cursor', async () => {
    const t = tx(); await repo.listAlerts(t.tx, TENANT_A, { levels: ['breached'], segment: 'within_lab', sort: '-pct_of_target', now: T('11:30:00') }, { limit: 50 }); const s = flat(sql(t));
    expect(s).toMatch(/\bFROM quality\.tat_items\b/i); expect(s).toMatch(/\bstate\s*=\s*'running'/i); expect(s).toMatch(/alert_level/); expect(s).toMatch(/ORDER BY[^;]*\bid\b/i); expect(s).toMatch(/LIMIT\s+\$\d+/i); expect(t.q[0]!.values).toContain(51);
    expect(s).not.toMatch(/\blab\.|\breporting\./i);
  });
  it('the acknowledged filter compares the acknowledged level rank with the CURRENT alert level rank (an ack at warning does not cover breached)', async () => {
    const t = tx(); await repo.listAlerts(t.tx, TENANT_A, { acknowledged: true, sort: '-alert_level_rank', now: T('11:30:00') }, { limit: 10 }); const s = flat(sql(t));
    expect(s).toMatch(/acknowledged_level/); expect(s).toMatch(/CASE/i); expect(s).toMatch(/>=/);
  });
  it('a malformed cursor is rejected before any statement', async () => {
    const t = tx(); const e = await repo.listAlerts(t.tx, TENANT_A, { sort: 'started_at', now: T('11:30:00') }, { cursor: '%%%not-a-cursor', limit: 10 }).then(() => undefined, (x) => x); expect(e).toBeInstanceOf(Error); expect(t.q).toEqual([]);
  });
});
void idN;
