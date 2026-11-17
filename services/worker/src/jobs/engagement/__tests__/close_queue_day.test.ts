// C16.T-Q2 — cron `engagement.close_queue_day` (02-TRD §8.2: daily 23:50 Asia/Kathmandu, per_tenant, "waiting/called/serving tokens of the business day -> expired";
// 03-APP-FLOW §4.3 T-10; 01-PRD US-EN-21.5; 05-SCHEMA queue_tokens + enforce_mutable_columns; 08 A13 P-6 per_tenant; REQ-SEC-024 tenant guard).
// Fails now: the manifest has no `engagement.close_queue_day` task and `crontab: []`; ../cron.js does not exist.
// SEAMS (spec silent): cron.ts exports `crontab` (frozen) and index.ts uses it as manifest.crontab; the task is manifest.tasks['engagement.close_queue_day'], payload {tenant_id};
//   crontab schedule fields are UTC (core/manifest.ts "5 UTC fields") so 23:50 NPT (UTC+05:45) = `5 18 * * *`; the business day is the Asia/Kathmandu date of ctx.now() (05-SCHEMA P-15: v1 timezone is only Asia/Kathmandu);
//   statements go through ctx.tx (also ctx.db.tx), always bind tenant_id, never DELETE/INSERT; expired rows get updated_by = ctx.actor.id. DB = the API-side fake (fakeSql.ts): unsupported SQL surfaces as `fake-sql: ...`.
//   Open in the spec (NOT asserted): `skipped` tokens (T-10 lists them, TRD §8.2 does not), tokens of earlier unclosed days, board_version bump on expiry.
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { FakeDb, queueSchemaDefs, type Row } from '../../../../../api/src/modules/engagement/__tests__/fakeSql.js';

const ID = 'engagement.close_queue_day';
const TA = '01a1a98a-ac40-7000-8000-00000000a001', TB = '01a1a98a-ac40-7000-8000-00000000b001';
const C1 = '01950c16-0000-7000-8000-0000000c0001', CB = '01950c16-0000-7000-8000-0000000c00b1';
const QA = '01950c16-0000-7000-8000-0000000001a1', QTB = '01950c16-0000-7000-8000-0000000001b1';
const SYSTEM = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const T_2350 = '2026-11-05T18:05:00.000Z'; // 23:50 NPT on 2026-11-05
const T_2350_NEXT = '2026-11-06T18:05:00.000Z'; // 23:50 NPT on 2026-11-06
const manifest = async (): Promise<any> => (await import('../index.js')).manifest;

const tok = (n: number, status: string, over: Row = {}): Row => ({
  id: `01950c16-0000-7000-8000-00000000${(0x300 + n).toString(16).padStart(4, '0')}`, tenant_id: TA, centre_id: C1, queue_id: QA, business_date: '2026-11-05', seq: n,
  token_label: `A-${String(n).padStart(3, '0')}`, priority: 'normal', status, booking_id: null, counter_id: null, issued_at: '2026-11-05T04:00:00.000Z', called_at: null, call_count: 0,
  serving_started_at: null, completed_at: null, transferred_to_token_id: null, transferred_from_token_id: null, version: 3, created_at: '2026-11-05T04:00:00.000Z', created_by: SYSTEM,
  updated_at: '2026-11-05T04:00:00.000Z', updated_by: SYSTEM, ...over });

function setup(nowIso: string, tenantId?: string | null) {
  const clock = { iso: nowIso };
  const tokens: Row[] = [
    tok(1, 'waiting'), tok(2, 'called', { call_count: 1 }), tok(3, 'serving', { call_count: 1 }),                       // open -> expired
    tok(4, 'completed', { call_count: 1 }), tok(5, 'cancelled'), tok(6, 'expired'),                                         // terminal: untouched
    tok(7, 'waiting', { business_date: '2026-11-06', seq: 1, token_label: 'A-001' }),                                      // the next business day: untouched
    tok(8, 'waiting', { tenant_id: TB, centre_id: CB, queue_id: QTB, seq: 8 }), tok(9, 'called', { tenant_id: TB, centre_id: CB, queue_id: QTB, seq: 9, call_count: 1 }), // other tenant
  ];
  tokens.push(tok(10, 'transferred', { transferred_to_token_id: tokens[0]!['id'] }));
  const db = new FakeDb({
    queue_definitions: [{ id: QA, tenant_id: TA, centre_id: C1, token_prefix: 'A', is_active: true, board_version: 7, version: 3 }, { id: QTB, tenant_id: TB, centre_id: CB, token_prefix: 'A', is_active: true, board_version: 7, version: 3 }],
    queue_counters: [], queue_day_counters: [], collection_centres: [{ id: C1, tenant_id: TA }, { id: CB, tenant_id: TB }], settings: [], queue_tokens: tokens,
  }, queueSchemaDefs(clock), clock);
  const s = db.session(TA, { all: true, centres: [] }, SYSTEM);
  const ctx: any = {
    tenantId: tenantId === null ? undefined : (tenantId ?? TA), tx: s.tx, actor: { type: 'system', id: SYSTEM }, requestId: 'r', attempt: 1, maxAttempts: 3, jobId: '1',
    now: () => clock.iso, isNewer: () => true, events: {}, core: {}, storage: {}, files: {}, audit: {},
    log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, metrics: { inc() {}, set() {}, observe() {} },
  };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  return { db, ctx, tokens, clock };
}
const run = async (nowIso: string, payload: Record<string, unknown> = { tenant_id: TA }) => {
  const s = setup(nowIso);
  await (await manifest()).tasks[ID](payload, s.ctx);
  return s;
};

describe('manifest + crontab (02-TRD §8.2)', () => {
  it('registers engagement.close_queue_day as a function and the manifest still validates', async () => {
    const m = await manifest();
    expect(typeof m.tasks?.[ID]).toBe('function');
    expect(() => validateManifests([m])).not.toThrow();
  });
  it('one cron row: 23:50 Asia/Kathmandu = `5 18 * * *` (UTC), per_tenant; cron.ts exports the frozen crontab the manifest uses', async () => {
    const m = await manifest();
    const rows = ((m.crontab ?? []) as any[]).filter((x) => x.identifier === ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ schedule: '5 18 * * *', tenantScope: 'per_tenant' });
    const cron: any = await import('../cron.js');
    expect(cron.crontab).toBe(m.crontab); expect(Object.isFrozen(cron.crontab)).toBe(true);
  });
});

describe('US-EN-21.5 end of the business day', () => {
  it('waiting, called and serving tokens of the business day become expired; completed/cancelled/expired/transferred stay as they were', async () => {
    const { tokens } = await run(T_2350);
    const st = (id: string) => tokens.find((t) => t['id'] === id)!['status'];
    const idOf = (n: number) => `01950c16-0000-7000-8000-00000000${(0x300 + n).toString(16).padStart(4, '0')}`;
    expect([1, 2, 3].map((n) => st(idOf(n)))).toEqual(['expired', 'expired', 'expired']);
    expect([4, 5, 6, 10].map((n) => st(idOf(n)))).toEqual(['completed', 'cancelled', 'expired', 'transferred']);
  });
  it('an expired token keeps seq/label/date/counter data, gets version+1 and updated_by = the system actor; untouched rows keep their version', async () => {
    const { tokens } = await run(T_2350);
    const t2 = tokens.find((t) => t['id'].endsWith('0302'))!;
    expect(t2).toMatchObject({ status: 'expired', seq: 2, token_label: 'A-002', business_date: '2026-11-05', call_count: 1, queue_id: QA, version: 4, updated_by: SYSTEM });
    expect(tokens.find((t) => t['id'].endsWith('0304'))!['version']).toBe(3);
  });
  it('day rollover with a fake clock: the day comes from ctx.now() in the tenant timezone, so the next night (23:50 NPT on 2026-11-06) closes business date 2026-11-06; on 11-05 that token was left waiting', async () => {
    const first = await run(T_2350);
    expect(first.tokens.find((t) => t['id'].endsWith('0307'))!['status']).toBe('waiting');
    const next = await run(T_2350_NEXT);
    expect(next.tokens.find((t) => t['id'].endsWith('0307'))!['status']).toBe('expired');
  });
  it('closing never touches the day counters (numbering restarts at 001 next day by business_date, see queue.tokens.test.ts day rollover)', async () => {
    const { db } = await run(T_2350);
    expect(db.calls.filter((c) => /queue_day_counters/i.test(c.text))).toEqual([]);
  });
  it('idempotent: a second run changes nothing and does not throw (retry safe)', async () => {
    const { db, ctx, tokens } = await run(T_2350);
    const snapshot = JSON.stringify(tokens);
    await (await manifest()).tasks[ID]({ tenant_id: TA }, ctx);
    expect(JSON.stringify(tokens)).toBe(snapshot);
    void db;
  });
  it('other tenants are never touched (tenant B waiting/called tokens stay)', async () => {
    const { tokens } = await run(T_2350);
    expect(tokens.filter((t) => t['tenant_id'] === TB).map((t) => t['status'])).toEqual(['waiting', 'called']);
  });
});

describe('tenant guard (REQ-SEC-024): the job acts only on the tenant it was enqueued for', () => {
  for (const [name, payload, tenantId] of [
    ['payload without tenant_id', {}, TA],
    ['payload tenant_id of another tenant', { tenant_id: TB }, TA],
    ['payload tenant_id but ctx without tenant', { tenant_id: TA }, null],
    ['payload tenant_id that is not a uuid', { tenant_id: "x' OR '1'='1" }, TA],
  ] as const) {
    it(`${name}: no statement runs and the task resolves`, async () => {
      const s = setup(T_2350, tenantId);
      await expect((await manifest()).tasks[ID](payload, s.ctx)).resolves.toBeUndefined();
      expect(s.db.calls).toHaveLength(0);
      expect(s.tokens.filter((t) => t['status'] === 'expired')).toHaveLength(1); // only the seeded one
    });
  }
  it('matching tenant: every statement names tenant_id and binds it; an UPDATE of engagement.queue_tokens sets status expired for waiting/called/serving; nothing destructive', async () => {
    const { db } = await run(T_2350);
    expect(db.calls.length).toBeGreaterThan(0);
    for (const c of db.calls) { expect(c.text).toMatch(/tenant_id/); expect(c.text).not.toMatch(/\b(DELETE|INSERT|TRUNCATE|DROP)\b/i); expect(c.values).toContain(TA); }
    const upd = db.calls.filter((c) => /UPDATE\s+engagement\.queue_tokens/i.test(c.text));
    expect(upd.length).toBeGreaterThan(0);
    const blob = upd.map((c) => `${c.text}\n${JSON.stringify(c.values)}`).join('\n');
    for (const w of ['expired', 'waiting', 'called', 'serving']) expect(blob, w).toContain(w);
  });
});
