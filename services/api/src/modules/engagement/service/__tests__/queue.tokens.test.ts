// C16.T-Q2 — Q3 issueQueueToken, Q4 listQueueTokens, Q5 callNextQueueToken, Q6 recall/serve/complete/skip/cancel, Q7 transferQueueToken
// (06-PLAN row T-Q2; 02-TRD §4.10, §5 Q3-Q7; 03-APP-FLOW §4.3 T-1..T-9; 05-SCHEMA queue_tokens / queue_day_counters; 01-PRD US-EN-21.1-6; 07-SECURITY AB-15, §6.3 tenant probe, §6.4 centre probe).
// done_when: numbering per business date in tenant tz; SKIP LOCKED call-next. tests: 20 parallel issues -> 20 distinct seqs; 2 parallel call-next -> 2 different tokens; every transition; day rollover with fake clock.
// Fails now: the nine operationIds are still the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec does not fix them; same convention as queue.handlers.test.ts / T-Q1):
//   handlers[op](req:{params,query,headers,body}, ctx) -> {status, body, headers?}; ctx = {tenantId, actor, tx, now(): ISO string, ports:{IdentityPort}}. 204 = {status:204} without body.
//   Permission/centre: IdentityPort.assertRole(ctx,{permission:'engagement.queue.operate', centreId?}) BEFORE any query. A row outside the actor's centres is hidden by STAFF_C RLS (fake) -> 404 common.not_found, never 403/409.
//   Business date: computed in the app from ctx.now() in the tenant timezone (Asia/Kathmandu, UTC+05:45; 05-SCHEMA §... P-15 v1) and BOUND as 'YYYY-MM-DD'. IdentityPort.getTenantSettings(ctx,{keys:['timezone']}) answers Asia/Kathmandu.
//   Numbering (TRD §4.10): INSERT INTO engagement.queue_day_counters .. ON CONFLICT DO NOTHING; UPDATE engagement.queue_day_counters SET last_seq = last_seq + 1 .. RETURNING last_seq; INSERT INTO engagement.queue_tokens.
//   Call next (TRD §4.10): SELECT .. FROM engagement.queue_tokens WHERE tenant_id AND queue_id AND business_date AND status='waiting' ORDER BY priority DESC, issued_at, id LIMIT 1 FOR UPDATE SKIP LOCKED.
//   board_version: UPDATE engagement.queue_definitions SET board_version = board_version + 1 (the Q1c `version` must NOT change). queue_enabled is read from engagement.settings.
//   Transitions are conditional UPDATEs binding the If-Match version; If-Match arrives raw '"<n>"' (key 'if-match'): absent 428, malformed 400, stale 409 common.version_conflict.
//   DB = services/api/src/modules/engagement/__tests__/fakeSql.ts (mini SQL interpreter: RLS, NOT NULL/UNIQUE/FK/CHECK, enforce_mutable_columns, row locks + SKIP LOCKED, event-loop yields so parallel requests interleave).
//   Idempotency-Key (Q3, Q7 required) is enforced by the core pipeline and is not re-tested here.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { TENANTS } from '../../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { FakeDb, queueSchemaDefs, type Call, type Row } from '../../__tests__/fakeSql.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const errorsOf = (schema: object, x: unknown): string[] => { const v = ajv.compile({ ...schema, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const tokenErrors = (x: unknown) => errorsOf({ $ref: '#/components/schemas/QueueToken' }, x);
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const okSchema = (op: string) => opOf(op).responses['200'].content['application/json'].schema;

const A: string = TENANTS.A;
const B: string = TENANTS.B;
const C1 = '01950c16-0000-7000-8000-0000000c0001';
const C2 = '01950c16-0000-7000-8000-0000000c0002';
const CB = '01950c16-0000-7000-8000-0000000c00b1';
const ID = (n: number) => `01950c16-0000-7000-8000-00000000${n.toString(16).padStart(4, '0')}`;
const QA = ID(0x1a1), QB = ID(0x1a2), QOFF = ID(0x1a3), QC2 = ID(0x1a4), QTB = ID(0x1b1);
const K1 = ID(0x2a1), K2 = ID(0x2a2), KC2 = ID(0x2a3), KTB = ID(0x2b1);
const TID = (n: number) => ID(0x300 + n);
const UNKNOWN = ID(0x7777);
const OPERATE = 'engagement.queue.operate', MANAGE = 'engagement.queue.manage';

const NOW = '2026-11-05T04:15:00.000Z'; // 10:00 Asia/Kathmandu, business date 2026-11-05
const TODAY = '2026-11-05', YESTERDAY = '2026-11-04', TOMORROW = '2026-11-06';
const T_2359 = '2026-11-05T18:14:00.000Z'; // 23:59 NPT on 2026-11-05 (UTC date also 11-05)
const T_0001 = '2026-11-05T18:16:00.000Z'; // 00:01 NPT on 2026-11-06 (UTC date still 11-05: proves the tenant timezone is used)

const queueRow = (id: string, tenant: string, centre: string, over: Row = {}): Row => ({
  id, tenant_id: tenant, centre_id: centre, code: 'registration', display_name: 'Registration', token_prefix: 'A', sort_order: 10, is_active: true, board_version: 7, version: 3,
  created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...over });
const counterRow = (id: string, tenant: string, centre: string, over: Row = {}): Row => ({
  id, tenant_id: tenant, centre_id: centre, display_name: 'Counter 1', sort_order: 10, is_active: true, version: 1, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...over });
const tok = (n: number, over: Row = {}): Row => ({
  id: TID(n), tenant_id: A, centre_id: C1, queue_id: QA, business_date: TODAY, seq: n, token_label: `A-${String(n).padStart(3, '0')}`, priority: 'normal', status: 'waiting', booking_id: null,
  counter_id: null, issued_at: `2026-11-05T04:${String(n).padStart(2, '0')}:00.000Z`, called_at: null, call_count: 0, serving_started_at: null, completed_at: null,
  transferred_to_token_id: null, transferred_from_token_id: null, version: 5, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...over });

function mk(over: { tokens?: Row[]; dayCounters?: Row[]; settings?: Row[]; queues?: Row[] } = {}, now = NOW) {
  const clock = { iso: now };
  const tables: Record<string, Row[]> = {
    collection_centres: [{ id: C1, tenant_id: A }, { id: C2, tenant_id: A }, { id: CB, tenant_id: B }],
    settings: over.settings ?? [{ id: ID(0x5e1), tenant_id: A, queue_enabled: true, version: 1 }, { id: ID(0x5e2), tenant_id: B, queue_enabled: true, version: 1 }],
    queue_definitions: over.queues ?? [
      queueRow(QA, A, C1), queueRow(QB, A, C1, { code: 'sample_collection', display_name: 'Sample collection', token_prefix: 'B', sort_order: 20 }),
      queueRow(QOFF, A, C1, { code: 'old_queue', display_name: 'Old', token_prefix: 'Z', is_active: false }),
      queueRow(QC2, A, C2, { code: 'sample_collection', display_name: 'Sample collection (C2)', token_prefix: 'C' }), queueRow(QTB, B, CB, { display_name: 'Tenant B queue' }),
    ],
    queue_counters: [counterRow(K1, A, C1), counterRow(K2, A, C1, { display_name: 'Counter 2', sort_order: 20 }), counterRow(KC2, A, C2, { display_name: 'Counter (C2)' }), counterRow(KTB, B, CB)],
    queue_day_counters: over.dayCounters ?? [],
    queue_tokens: over.tokens ?? [],
  };
  return new FakeDb(tables, queueSchemaDefs(clock), clock);
}

const verb = (c: Call) => /^\s*(select|insert|update|delete)\b/i.exec(c.text)?.[1]?.toLowerCase();
const writes = (c: Call[]) => c.filter((x) => ['insert', 'update', 'delete'].includes(verb(x) ?? ''));
const tokenWrites = (c: Call[]) => writes(c).filter((x) => /engagement\.queue_tokens/i.test(x.text));
const anyWrites = (c: Call[]) => writes(c).filter((x) => /engagement\.queue_(tokens|day_counters)/i.test(x.text));

interface Who { grants: readonly string[]; centres: readonly string[]; all?: boolean; refuse?: string }
function identity(w: Who) {
  const calls: Array<{ permission: string; centreId?: string }> = [];
  return {
    calls,
    async assertRole(_c: unknown, r: { permission: string; centreId?: string }) {
      calls.push({ permission: r?.permission, ...(r?.centreId ? { centreId: r.centreId } : {}) });
      if (w.refuse) throw new LimsError(w.refuse);
      if (!w.grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
      if (r.centreId && !w.all && !w.centres.includes(r.centreId)) throw new LimsError('auth.forbidden');
    },
    async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
    async getActor() { return { actor: { type: 'user', id: A }, permissions: [...w.grants], roles: [], centreScope: { all: Boolean(w.all), centreIds: w.centres }, mfa: { enrolled: true, level: 'aal2' } }; },
  };
}
const FRONT_DESK_C1: Who = { grants: [OPERATE], centres: [C1] };
const ALL_CENTRES: Who = { grants: [OPERATE, MANAGE], centres: [], all: true };

const ctxFor = makeCtxFor();
async function run(op: string, o: { params?: object; query?: object; headers?: object; body?: unknown }, who: Who, opts: { db?: FakeDb; session?: string; now?: string } = {}) {
  const tenant = opts.session ?? A;
  const db = opts.db ?? mk();
  if (opts.now) db.clock.iso = opts.now;
  const s = db.session(tenant, { all: Boolean(who.all), centres: who.centres });
  const id = identity(who);
  const ctx: any = { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    ...ctxFor(tenant === B ? 'B' : 'A', { tx: s.tx as never, ports: { IdentityPort: id } as never, now: () => db.clock.iso } as never) };
  const r = { params: {}, query: {}, headers: {}, body: undefined, ...o } as never;
  const before = db.calls.length;
  let out: any, error: any;
  try { out = await (handlers as any)[op](r, ctx); } catch (e) { error = e; } finally { s.release(); }
  return { out, error, db, id, ctx, calls: db.calls.slice(before) };
}
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
const tokens = (db: FakeDb) => db.tables['queue_tokens']!;
const byId = (db: FakeDb, id: string) => tokens(db).find((t) => t.id === id)!;
const queueOf = (db: FakeDb, id: string) => db.tables['queue_definitions']!.find((q) => q.id === id)!;
const iso = (v: unknown) => (v === null || v === undefined ? v : new Date(v as string).toISOString());
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

const issue = (body: unknown, who: Who = FRONT_DESK_C1, opts: { db?: FakeDb; now?: string } = {}) => run('issueQueueToken', { body }, who, opts);
const callNext = (queue: string, counter: string, who: Who = FRONT_DESK_C1, opts: { db?: FakeDb; now?: string } = {}) => run('callNextQueueToken', { params: { queue_id: queue }, body: { counter_id: counter } }, who, opts);

// ================================================================== Q3 issueQueueToken — US-EN-21.1, 21.6
describe('Q3 issueQueueToken (US-EN-21.1, 21.6)', () => {
  it('first token of the day is A-001, the next A-002: 201 QueueToken (waiting, normal, call_count 0), no server columns', async () => {
    const db = mk();
    const a = await issue({ queue_id: QA }, FRONT_DESK_C1, { db });
    expect(a.error).toBeUndefined();
    expect(a.out.status).toBe(201);
    expect(a.out.body).toMatchObject({ queue_id: QA, token_label: 'A-001', status: 'waiting', priority: 'normal', call_count: 0, version: 1 });
    expect(tokenErrors(a.out.body)).toEqual([]);
    expect(iso(a.out.body.issued_at)).toBe(NOW);
    const b = await issue({ queue_id: QA, priority: 'priority' }, FRONT_DESK_C1, { db });
    expect(b.out.body).toMatchObject({ token_label: 'A-002', priority: 'priority', status: 'waiting' });
    expect(JSON.stringify(a.out.body)).not.toMatch(/tenant_id|centre_id|business_date|"seq"|created_by|updated_by|transferred/);
  });
  it('persisted row: seq/label/business date (tenant tz), centre of the queue, issue time = ctx.now(), actor in created_by/updated_by, no counter/call data', async () => {
    const db = mk();
    const { out, ctx } = await issue({ queue_id: QA }, FRONT_DESK_C1, { db });
    const row = byId(db, out.body.id);
    expect(row).toMatchObject({ tenant_id: A, centre_id: C1, queue_id: QA, seq: 1, token_label: 'A-001', priority: 'normal', status: 'waiting', counter_id: null, call_count: 0, booking_id: null, version: 1, created_by: ctx.actor.id, updated_by: ctx.actor.id });
    expect(day(row.business_date)).toBe(TODAY);
    expect(iso(row.issued_at)).toBe(NOW);
    expect(row.called_at).toBeNull();
  });
  it('US-EN-21.6: a booking-linked token stores only booking_id; the row carries no name/phone column and the response only the contract fields', async () => {
    const db = mk();
    const BOOKING = ID(0xb001);
    const { out, error } = await issue({ queue_id: QA, booking_id: BOOKING }, FRONT_DESK_C1, { db });
    expect(error).toBeUndefined();
    expect(out.body.booking_id).toBe(BOOKING);
    expect(tokenErrors(out.body)).toEqual([]);
    const row = byId(db, out.body.id);
    expect(row.booking_id).toBe(BOOKING);
    expect(Object.keys(row).filter((k) => /name|phone|mobile|dob|address|patient|email/i.test(k) && k !== 'created_by')).toEqual([]);
  });
  it('numbering is per queue: queue B starts at B-001 while queue A continues', async () => {
    const db = mk();
    await issue({ queue_id: QA }, FRONT_DESK_C1, { db }); await issue({ queue_id: QA }, FRONT_DESK_C1, { db });
    const b = await issue({ queue_id: QB }, FRONT_DESK_C1, { db });
    expect(b.out.body.token_label).toBe('B-001');
    expect((await issue({ queue_id: QA }, FRONT_DESK_C1, { db })).out.body.token_label).toBe('A-003');
  });
  it('US-EN-21.1: 20 parallel issues on one queue -> 20 distinct seqs and labels (A-001..A-020), no error', async () => {
    const db = mk();
    const rs = await Promise.all(Array.from({ length: 20 }, () => issue({ queue_id: QA }, FRONT_DESK_C1, { db })));
    expect(rs.map((r) => r.error)).toEqual(Array(20).fill(undefined));
    for (const r of rs) expect(r.out.status).toBe(201);
    const labels = rs.map((r) => r.out.body.token_label);
    expect(new Set(labels).size).toBe(20);
    expect([...labels].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `A-${String(i + 1).padStart(3, '0')}`));
    expect(tokens(db).map((t) => t.seq).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(rs.map((r) => r.out.body.id)).size).toBe(20);
  });
  it('day rollover with a fake clock: 23:59 NPT numbers on, 00:01 NPT (UTC date unchanged) restarts at 001 on the next business date; the old day is untouched', async () => {
    const db = mk();
    const l1 = await issue({ queue_id: QA }, FRONT_DESK_C1, { db, now: T_2359 });
    const l2 = await issue({ queue_id: QA }, FRONT_DESK_C1, { db, now: T_2359 });
    expect([l1.out.body.token_label, l2.out.body.token_label]).toEqual(['A-001', 'A-002']);
    const n1 = await issue({ queue_id: QA }, FRONT_DESK_C1, { db, now: T_0001 });
    expect(n1.out.body.token_label).toBe('A-001');
    expect(day(byId(db, n1.out.body.id).business_date)).toBe(TOMORROW);
    expect(day(byId(db, l2.out.body.id).business_date)).toBe(TODAY);
    expect((await issue({ queue_id: QA }, FRONT_DESK_C1, { db, now: T_0001 })).out.body.token_label).toBe('A-002');
  });
  it('1000th token of a day gets a 4-digit label (A-1000), contract pattern ^[A-Z]{1,2}-[0-9]{3,4}$', async () => {
    const db = mk({ dayCounters: [{ tenant_id: A, queue_id: QA, centre_id: C1, business_date: TODAY, last_seq: 999, created_by: A }] });
    const { out, error } = await issue({ queue_id: QA }, FRONT_DESK_C1, { db });
    expect(error).toBeUndefined();
    expect(out.body.token_label).toBe('A-1000');
    expect(tokenErrors(out.body)).toEqual([]);
  });
  it('inactive queue -> 409 engagement.queue_closed, nothing written; queue feature off (settings.queue_enabled=false) -> the same', async () => {
    const off = await issue({ queue_id: QOFF });
    expect(off.error?.code).toBe('engagement.queue_closed'); expect(anyWrites(off.calls)).toEqual([]);
    const db = mk({ settings: [{ id: ID(0x5e1), tenant_id: A, queue_enabled: false, version: 1 }] });
    const feat = await issue({ queue_id: QA }, FRONT_DESK_C1, { db });
    expect(feat.error?.code).toBe('engagement.queue_closed'); expect(anyWrites(feat.calls)).toEqual([]);
  });
  it('body validation -> 400 common.validation_failed with zero writes and no echo of the submitted value', async () => {
    const bad: Record<string, unknown> = {
      'queue_id missing': {}, 'queue_id not a uuid': { queue_id: 'x<script>alert(1)</script>' }, 'priority unknown': { queue_id: QA, priority: 'urgent' },
      'booking_id not a uuid': { queue_id: QA, booking_id: 'nope' }, 'extra tenant_id': { queue_id: QA, tenant_id: B }, 'extra status': { queue_id: QA, status: 'serving' },
      'extra seq': { queue_id: QA, seq: 99 }, 'extra token_label': { queue_id: QA, token_label: 'A-999' }, 'extra patient_name': { queue_id: QA, patient_name: 'Synthetic Person' },
      'array body': [QA], 'null body': null, 'no body': undefined,
    };
    for (const [name, body] of Object.entries(bad)) {
      const r = await issue(body);
      expect(r.error?.code, name).toBe('common.validation_failed');
      expect(anyWrites(r.calls), name).toEqual([]);
      expect(JSON.stringify({ d: r.error?.detail, e: r.error?.errors }), name).not.toMatch(/script|Synthetic|A-999/);
    }
  });
  it('permission floor: no engagement.queue.operate (manage-only) -> auth.forbidden before any DB access; membership refusal passes through', async () => {
    for (const who of [{ grants: [], centres: [C1] }, { grants: [MANAGE], centres: [C1] }] as Who[]) { const r = await issue({ queue_id: QA }, who); expect(r.error?.code).toBe('auth.forbidden'); expect(r.calls).toEqual([]); }
    const locked = await issue({ queue_id: QA }, { ...FRONT_DESK_C1, refuse: 'auth.account_locked' }); expect(locked.error?.code).toBe('auth.account_locked'); expect(locked.calls).toEqual([]);
  });
  it('asserts operate for the queue centre; PROBE Q3 centre: staff of C1 issuing on C2 queue -> not_found/forbidden, no write; tenant B queue id -> 404 (never queue_closed)', async () => {
    const ok = await issue({ queue_id: QA });
    expect(ok.id.calls.some((c) => c.permission === OPERATE && c.centreId === C1)).toBe(true);
    const c2 = await issue({ queue_id: QC2 });
    expect(['auth.forbidden', 'common.not_found']).toContain(c2.error?.code); expect(anyWrites(c2.calls)).toEqual([]);
    const tb = await issue({ queue_id: QTB });
    expect(tb.error?.code).toBe('common.not_found'); expect(anyWrites(tb.calls)).toEqual([]);
    const unk = await issue({ queue_id: UNKNOWN });
    expect(unk.error?.code).toBe('common.not_found');
    const tenantB = await issue({ queue_id: QA }, { grants: [OPERATE], centres: [], all: true }, { session: B });
    expect(tenantB.error?.code).toBe('common.not_found'); expect(anyWrites(tenantB.calls)).toEqual([]);
  });
  it('an existing day counter row (last_seq 1, token A-001) is continued: next label A-002, all labels stay unique', async () => {
    const db = mk({ tokens: [tok(1, { token_label: 'A-001' })], dayCounters: [{ tenant_id: A, queue_id: QA, centre_id: C1, business_date: TODAY, last_seq: 1, created_by: A }] });
    const r = await issue({ queue_id: QA }, FRONT_DESK_C1, { db });
    expect(r.out.body.token_label).toBe('A-002');
    expect(new Set(tokens(db).map((t) => t.token_label)).size).toBe(tokens(db).length);
  });
});

// ================================================================== Q4 listQueueTokens
describe('Q4 listQueueTokens', () => {
  const seeded = () => mk({ tokens: [
    tok(1), tok(2, { status: 'called', counter_id: K1, called_at: NOW, call_count: 1 }), tok(3, { priority: 'priority' }),
    tok(4, { queue_id: QB, token_label: 'B-004', seq: 4 }), tok(5, { business_date: YESTERDAY, seq: 5, token_label: 'A-005', issued_at: '2026-11-04T04:05:00.000Z' }),
    tok(6, { centre_id: C2, queue_id: QC2, token_label: 'C-006', seq: 6 }), tok(7, { tenant_id: B, centre_id: CB, queue_id: QTB, token_label: 'A-007', seq: 7 }),
  ] });
  const list = (query: object, who: Who = FRONT_DESK_C1, opts: { db?: FakeDb; session?: string } = {}) => run('listQueueTokens', { query }, who, { db: seeded(), ...opts });

  it('default = today (tenant tz) of the centre: only C1 tokens of 2026-11-05, oldest first, every item a contract QueueToken, response valid against the 200 schema', async () => {
    const { out, error, id } = await list({ centre_id: C1 });
    expect(error).toBeUndefined(); expect(out.status).toBe(200);
    expect(out.body.data.map((t: any) => t.token_label)).toEqual(['A-001', 'A-002', 'A-003', 'B-004']);
    expect(errorsOf(okSchema('listQueueTokens'), out.body)).toEqual([]);
    expect(id.calls[0]).toMatchObject({ permission: OPERATE, centreId: C1 });
    expect(JSON.stringify(out.body)).not.toMatch(/tenant_id|business_date|created_by|"seq"/);
  });
  it('filters: queue_id, status, explicit business_date', async () => {
    expect((await list({ centre_id: C1, queue_id: QB })).out.body.data.map((t: any) => t.token_label)).toEqual(['B-004']);
    expect((await list({ centre_id: C1, status: 'called' })).out.body.data.map((t: any) => t.token_label)).toEqual(['A-002']);
    expect((await list({ centre_id: C1, business_date: YESTERDAY })).out.body.data.map((t: any) => t.token_label)).toEqual(['A-005']);
  });
  it('day rollover: after local midnight the default day is the new business date (empty list)', async () => {
    const r = await run('listQueueTokens', { query: { centre_id: C1 } }, FRONT_DESK_C1, { db: seeded(), now: T_0001 });
    expect(r.out.body.data).toEqual([]);
  });
  it('the statement is bounded (LIMIT) and read-only', async () => {
    const { calls } = await list({ centre_id: C1 });
    expect(writes(calls)).toEqual([]);
    const sel = calls.filter((c) => /engagement\.queue_tokens/i.test(c.text));
    expect(sel.length).toBeGreaterThan(0);
    for (const s of sel) expect(s.text).toMatch(/\blimit\b/i);
  });
  it('invalid query -> 400 common.validation_failed, no DB: centre missing/not a uuid, unknown status, bad date, queue_id not a uuid', async () => {
    for (const q of [{}, { centre_id: 'nope' }, { centre_id: C1, status: 'bogus' }, { centre_id: C1, business_date: 'not-a-date' }, { centre_id: C1, queue_id: 'nope' }]) {
      const r = await list(q); expect(r.error?.code, JSON.stringify(q)).toBe('common.validation_failed'); expect(r.calls).toEqual([]);
    }
  });
  it('permission floor (operate): none/manage-only -> auth.forbidden, zero DB', async () => {
    for (const who of [{ grants: [], centres: [C1] }, { grants: [MANAGE], centres: [C1] }] as Who[]) { const r = await list({ centre_id: C1 }, who); expect(r.error?.code).toBe('auth.forbidden'); expect(r.calls).toEqual([]); }
  });
  it('PROBE Q4 centre: C1 staff lists C2 -> forbidden or empty, never a C2 token; tenant B session asking for A\'s centre sees nothing of A', async () => {
    const c2 = await list({ centre_id: C2 });
    if (c2.error) expect(['auth.forbidden', 'common.not_found']).toContain(c2.error.code); else expect(c2.out.body.data).toEqual([]);
    const b = await list({ centre_id: C1 }, { grants: [OPERATE], centres: [], all: true }, { session: B });
    if (b.error) expect(['auth.forbidden', 'common.not_found']).toContain(b.error.code); else expect(b.out.body.data).toEqual([]);
    expect(JSON.stringify(b.out?.body ?? {})).not.toContain('A-00');
  });
});

// ================================================================== Q5 callNextQueueToken — US-EN-21.2, AB-15
describe('Q5 callNextQueueToken (US-EN-21.2, AB-15)', () => {
  const waiting = () => [
    tok(1, { issued_at: '2026-11-05T04:00:00.000Z' }), tok(2, { issued_at: '2026-11-05T04:05:00.000Z' }), tok(3, { priority: 'priority', issued_at: '2026-11-05T04:10:00.000Z' }),
    tok(4, { status: 'called', counter_id: K2, called_at: NOW, call_count: 1, issued_at: '2026-11-05T03:00:00.000Z' }),        // not waiting
    tok(5, { business_date: YESTERDAY, issued_at: '2026-11-04T03:00:00.000Z' }),                                              // yesterday
    tok(6, { queue_id: QB, token_label: 'B-006', issued_at: '2026-11-05T01:00:00.000Z' }),                                    // other queue
    tok(7, { status: 'skipped', counter_id: K2, call_count: 3, issued_at: '2026-11-05T02:00:00.000Z' }),                      // skipped is not "waiting"
  ];

  it('priority first, then oldest issue time: priority token, then the two normals in order; each becomes called with counter_id, call_count 1, called_at = now, version +1', async () => {
    const db = mk({ tokens: waiting() });
    const order: string[] = [];
    for (const n of [1, 2, 3]) {
      const r = await callNext(QA, K1, FRONT_DESK_C1, { db });
      expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200);
      expect(tokenErrors(r.out.body)).toEqual([]);
      order.push(r.out.body.token_label);
      expect(r.out.body).toMatchObject({ status: 'called', counter_id: K1, call_count: 1, version: 6 });
      expect(iso(r.out.body.called_at)).toBe(NOW);
      void n;
    }
    expect(order).toEqual(['A-003', 'A-001', 'A-002']);
    expect(byId(db, TID(3))).toMatchObject({ status: 'called', counter_id: K1, call_count: 1, version: 6 });
    for (const n of [4, 5, 6, 7]) expect(byId(db, TID(n)).version).toBe(5); // untouched
    expect(byId(db, TID(5)).status).toBe('waiting'); expect(byId(db, TID(6)).status).toBe('waiting');
  });
  it('the board version of the queue increases by one per call; the queue\'s own `version` (Q1c) does not change', async () => {
    const db = mk({ tokens: waiting() });
    await callNext(QA, K1, FRONT_DESK_C1, { db });
    expect(queueOf(db, QA)).toMatchObject({ board_version: 8, version: 3 });
    await callNext(QA, K2, FRONT_DESK_C1, { db });
    expect(queueOf(db, QA)).toMatchObject({ board_version: 9, version: 3 });
    expect(queueOf(db, QB).board_version).toBe(7);
  });
  it('queue empty -> 204 without body and without any write (board version unchanged)', async () => {
    const db = mk({ tokens: [tok(1, { status: 'completed' })] });
    const r = await callNext(QA, K1, FRONT_DESK_C1, { db });
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(204); expect(r.out.body ?? null).toBeNull();
    expect(writes(r.calls)).toEqual([]); expect(queueOf(db, QA).board_version).toBe(7);
  });
  it('day rollover: at 00:01 NPT yesterday\'s waiting tokens are not called (204); the new day\'s token is', async () => {
    const db = mk({ tokens: [tok(1, { business_date: YESTERDAY })] });
    expect((await callNext(QA, K1, FRONT_DESK_C1, { db, now: T_0001 })).out.status).toBe(204);
    const n = await issue({ queue_id: QA }, FRONT_DESK_C1, { db, now: T_0001 });
    const c = await callNext(QA, K1, FRONT_DESK_C1, { db, now: T_0001 });
    expect(c.out.status).toBe(200); expect(c.out.body.id).toBe(n.out.body.id);
  });
  it('AB-15 / SKIP LOCKED: 2 parallel call-next at two counters -> 2 different tokens, both 200, board +2; the statement is FOR UPDATE SKIP LOCKED ordered priority DESC, issued_at, id LIMIT 1', async () => {
    const db = mk({ tokens: waiting() });
    const [a, b] = await Promise.all([callNext(QA, K1, FRONT_DESK_C1, { db }), callNext(QA, K2, ALL_CENTRES, { db })]);
    expect(a.error).toBeUndefined(); expect(b.error).toBeUndefined();
    expect([a.out.status, b.out.status]).toEqual([200, 200]);
    expect(a.out.body.id).not.toBe(b.out.body.id);
    expect([a.out.body.token_label, b.out.body.token_label].sort()).toEqual(['A-001', 'A-003']); // the two best candidates
    expect(new Set([a.out.body.counter_id, b.out.body.counter_id])).toEqual(new Set([K1, K2]));
    expect(queueOf(db, QA).board_version).toBe(9);
    const sel = db.calls.filter((c) => verb(c) === 'select' && /engagement\.queue_tokens/i.test(c.text) && /status/i.test(c.text));
    expect(sel.length).toBeGreaterThan(0);
    for (const s of sel) { expect(s.text).toMatch(/for\s+update\s+skip\s+locked/i); expect(s.text).toMatch(/order\s+by\s+priority\s+desc\s*,\s*issued_at\s*,\s*id/i); expect(s.text).toMatch(/limit\s+1\b/i); }
  });
  it('3 parallel call-next with 2 waiting tokens -> exactly two 200 (distinct tokens) and one 204; nothing called twice', async () => {
    const db = mk({ tokens: [tok(1), tok(2)] });
    const rs = await Promise.all([callNext(QA, K1, FRONT_DESK_C1, { db }), callNext(QA, K2, FRONT_DESK_C1, { db }), callNext(QA, K1, FRONT_DESK_C1, { db })]);
    expect(rs.map((r) => r.error)).toEqual([undefined, undefined, undefined]);
    expect(rs.map((r) => r.out.status).sort()).toEqual([200, 200, 204]);
    expect(new Set(rs.filter((r) => r.out.status === 200).map((r) => r.out.body.id)).size).toBe(2);
    expect(tokens(db).every((t) => t.status === 'called' && t.call_count === 1 && t.version === 6)).toBe(true);
  });
  it('body: counter_id required uuid, no extra fields -> 400 and no write', async () => {
    for (const body of [{}, { counter_id: 'nope' }, { counter_id: K1, queue_id: QB }, { counter_id: K1, status: 'serving' }, undefined]) {
      const r = await run('callNextQueueToken', { params: { queue_id: QA }, body }, FRONT_DESK_C1, { db: mk({ tokens: waiting() }) });
      expect(r.error?.code, JSON.stringify(body)).toBe('common.validation_failed'); expect(tokenWrites(r.calls)).toEqual([]);
    }
    const r = await run('callNextQueueToken', { params: { queue_id: 'nope' }, body: { counter_id: K1 } }, FRONT_DESK_C1);
    expect(r.error?.code).toBe('common.validation_failed'); expect(r.calls).toEqual([]);
  });
  it('counter must be an active counter of the queue\'s centre in this tenant (other centre / tenant B / unknown / inactive) -> refused, no token touched', async () => {
    for (const counter of [KC2, KTB, UNKNOWN]) {
      const db = mk({ tokens: waiting() });
      const r = await callNext(QA, counter, ALL_CENTRES, { db });
      expect(['common.not_found', 'common.validation_failed'], counter).toContain(r.error?.code);
      expect(tokenWrites(r.calls), counter).toEqual([]);
    }
    const db = mk({ tokens: waiting() }); db.tables['queue_counters']!.find((c) => c.id === K2)!['is_active'] = false;
    const r = await callNext(QA, K2, ALL_CENTRES, { db });
    expect(['common.not_found', 'common.validation_failed']).toContain(r.error?.code); expect(tokenWrites(r.calls)).toEqual([]);
  });
  it('permission floor: none/manage-only -> auth.forbidden, zero DB access', async () => {
    for (const who of [{ grants: [], centres: [C1] }, { grants: [MANAGE], centres: [C1] }] as Who[]) { const r = await callNext(QA, K1, who); expect(r.error?.code).toBe('auth.forbidden'); expect(r.calls).toEqual([]); }
  });
  it('PROBE Q5: C1 staff on C2\'s queue / tenant B queue / unknown queue -> 404 (or forbidden for C2), no token written, no board bump', async () => {
    const mkc2 = () => mk({ tokens: [tok(1, { centre_id: C2, queue_id: QC2, token_label: 'C-001' })] });
    const db = mkc2();
    const c2 = await callNext(QC2, KC2, FRONT_DESK_C1, { db });
    expect(['auth.forbidden', 'common.not_found']).toContain(c2.error?.code); expect(tokenWrites(c2.calls)).toEqual([]); expect(queueOf(db, QC2).board_version).toBe(7);
    expect(byId(db, TID(1)).status).toBe('waiting');
    for (const q of [QTB, UNKNOWN]) { const r = await callNext(q, K1, FRONT_DESK_C1); expect(r.error?.code, q).toBe('common.not_found'); expect(tokenWrites(r.calls)).toEqual([]); }
    const b = await callNext(QA, K1, { grants: [OPERATE], centres: [], all: true }, { session: B });
    expect(b.error?.code).toBe('common.not_found');
  });
});

// ================================================================== Q6 recall / serve / complete / skip / cancel — US-EN-21.3, every transition of 03-APP-FLOW §4.3
const OPS = { recall: 'recallQueueToken', serve: 'startServingQueueToken', complete: 'completeQueueToken', skip: 'skipQueueToken', cancel: 'cancelQueueToken' } as const;
type Act = keyof typeof OPS;
const STATUSES = ['waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled', 'transferred', 'expired'] as const;
// 03-APP-FLOW §4.3 (T-3 T-4 T-5 T-6 T-7 T-8): operation -> {from: to}
const ALLOWED: Record<Act, Record<string, string>> = {
  recall: { called: 'called', skipped: 'called' },
  serve: { called: 'serving' },
  complete: { called: 'completed', serving: 'completed' },
  skip: { called: 'skipped' },
  cancel: { waiting: 'cancelled', called: 'cancelled', skipped: 'cancelled' },
};
const WITH_COUNTER = new Set(['called', 'serving', 'skipped']);
const tokenIn = (status: string, over: Row = {}): Row => tok(1, {
  status, version: 5, ...(WITH_COUNTER.has(status) ? { counter_id: K1, called_at: '2026-11-05T04:05:00.000Z', call_count: status === 'skipped' ? 3 : 1 } : {}),
  ...(status === 'serving' ? { serving_started_at: '2026-11-05T04:07:00.000Z' } : {}), ...(status === 'completed' ? { completed_at: NOW, call_count: 1, counter_id: K1, called_at: NOW } : {}),
  ...(status === 'transferred' ? { transferred_to_token_id: TID(2) } : {}), ...over });
const dbWith = (status: string, over: Row = {}) => mk({ tokens: [tokenIn(status, over), tok(2, { queue_id: QB, token_label: 'B-002', transferred_from_token_id: status === 'transferred' ? TID(1) : null })] });
const act = (a: Act, id: string, o: { headers?: object; body?: unknown } = {}, who: Who = FRONT_DESK_C1, opts: { db?: FakeDb; now?: string; session?: string } = {}) =>
  run(OPS[a], { params: { token_id: id }, headers: ifm(5), ...o }, who, opts);

describe('Q6 transitions (US-EN-21.3; every operation x every status)', () => {
  for (const a of Object.keys(OPS) as Act[]) {
    for (const from of STATUSES) {
      const to = ALLOWED[a][from];
      if (to) {
        it(`${a}: ${from} -> ${to} (200 QueueToken, version 6, one UPDATE)`, async () => {
          const db = dbWith(from);
          const before = { ...byId(db, TID(1)) };
          const r = await act(a, TID(1), {}, FRONT_DESK_C1, { db });
          expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200);
          expect(tokenErrors(r.out.body)).toEqual([]);
          expect(r.out.body).toMatchObject({ id: TID(1), status: to, version: 6, token_label: 'A-001', queue_id: QA });
          const row = byId(db, TID(1));
          expect(row).toMatchObject({ status: to, version: 6, seq: 1, queue_id: QA, token_label: 'A-001', business_date: TODAY });
          expect(tokenWrites(r.calls).every((c) => verb(c) === 'update')).toBe(true);
          if (a === 'recall') { expect(row.call_count).toBe(before['call_count'] + 1); expect(iso(row.called_at)).toBe(NOW); expect(row.counter_id).toBe(K1); }
          if (a === 'serve') expect(iso(row.serving_started_at)).toBe(NOW);
          if (a === 'complete') expect(iso(row.completed_at)).toBe(NOW);
          if (['recall', 'serve', 'complete'].includes(a)) expect(queueOf(db, QA).board_version).toBe(8); // T-3/T-6, T-4, T-7 change what a display shows
          expect(queueOf(db, QA).version).toBe(3);
        });
      } else {
        it(`${a}: ${from} -> 409 engagement.queue_token_invalid_transition, row and board unchanged`, async () => {
          const db = dbWith(from);
          const snapshot = JSON.stringify(tokens(db)); const bv = queueOf(db, QA).board_version;
          const r = await act(a, TID(1), {}, FRONT_DESK_C1, { db });
          expect(r.error?.code).toBe('engagement.queue_token_invalid_transition');
          expect(JSON.stringify(tokens(db))).toBe(snapshot); expect(queueOf(db, QA).board_version).toBe(bv);
        });
      }
    }
  }
  it('recall is allowed while call_count < 9: 8 -> 9 ok, at 9 -> 409 invalid transition (queue_tokens__calls__ck is never hit)', async () => {
    const ok = await act('recall', TID(1), {}, FRONT_DESK_C1, { db: dbWith('called', { call_count: 8 }) });
    expect(ok.error).toBeUndefined(); expect(ok.out.body.call_count).toBe(9);
    const db = dbWith('called', { call_count: 9 });
    const no = await act('recall', TID(1), {}, FRONT_DESK_C1, { db });
    expect(no.error?.code).toBe('engagement.queue_token_invalid_transition'); expect(byId(db, TID(1)).call_count).toBe(9);
  });
  it('T-6: a skipped token can be recalled only on the same business day (skipped yesterday -> 409)', async () => {
    const db = dbWith('skipped', { business_date: YESTERDAY });
    const r = await act('recall', TID(1), {}, FRONT_DESK_C1, { db });
    expect(r.error?.code).toBe('engagement.queue_token_invalid_transition'); expect(byId(db, TID(1)).status).toBe('skipped');
    const same = await act('recall', TID(1), {}, FRONT_DESK_C1, { db: dbWith('skipped') });
    expect(same.out.body.status).toBe('called');
  });
  it('serve may carry counter_id (an active counter of the centre) which becomes the token\'s counter; a foreign/unknown counter is refused with no write', async () => {
    const db = dbWith('called');
    const ok = await act('serve', TID(1), { body: { counter_id: K2 } }, FRONT_DESK_C1, { db });
    expect(ok.error).toBeUndefined(); expect(ok.out.body.counter_id).toBe(K2); expect(byId(db, TID(1)).counter_id).toBe(K2);
    for (const counter of [KC2, KTB, UNKNOWN]) {
      const d = dbWith('called'); const r = await act('serve', TID(1), { body: { counter_id: counter } }, ALL_CENTRES, { db: d });
      expect(['common.not_found', 'common.validation_failed'], counter).toContain(r.error?.code); expect(byId(d, TID(1)).status, counter).toBe('called');
    }
    const bad = await act('serve', TID(1), { body: { counter_id: 'nope' } }); expect(bad.error?.code).toBe('common.validation_failed');
    const extra = await act('serve', TID(1), { body: { status: 'completed' } }); expect(extra.error?.code).toBe('common.validation_failed');
  });
  it('If-Match: absent -> 428, malformed -> 400, stale -> 409 common.version_conflict; none changes the row', async () => {
    for (const [name, headers, code] of [['absent', {}, 'common.precondition_required'], ['malformed', ifm('abc'), 'common.validation_failed'], ['stale', ifm(4), 'common.version_conflict']] as const) {
      const db = dbWith('called'); const snapshot = JSON.stringify(tokens(db));
      const r = await run(OPS.skip, { params: { token_id: TID(1) }, headers }, FRONT_DESK_C1, { db });
      expect(r.error?.code, name).toBe(code); expect(JSON.stringify(tokens(db)), name).toBe(snapshot);
    }
  });
  it('ids: not a uuid -> 400; unknown or tenant B\'s token -> 404 (before the version is compared); C2 token for C1 staff -> 404; no write in any case', async () => {
    const bad = await act('skip', 'nope'); expect(bad.error?.code).toBe('common.validation_failed'); expect(bad.calls).toEqual([]);
    const db = mk({ tokens: [tok(1, { status: 'called', counter_id: K1, call_count: 1 }), tok(8, { tenant_id: B, centre_id: CB, queue_id: QTB, token_label: 'A-008', seq: 8, status: 'called', counter_id: KTB, call_count: 1 }),
      tok(9, { centre_id: C2, queue_id: QC2, token_label: 'C-009', seq: 9, status: 'called', counter_id: KC2, call_count: 1 })] });
    for (const id of [UNKNOWN, TID(8), TID(9)]) {
      const r = await act('skip', id, { headers: ifm(99) }, FRONT_DESK_C1, { db });
      expect(r.error?.code, id).toBe('common.not_found'); expect(tokenWrites(r.calls), id).toEqual([]);
    }
    expect(byId(db, TID(8)).status).toBe('called'); expect(byId(db, TID(9)).status).toBe('called');
    const tb = await act('skip', TID(1), {}, { grants: [OPERATE], centres: [], all: true }, { db, session: B });
    expect(tb.error?.code).toBe('common.not_found'); expect(byId(db, TID(1)).status).toBe('called');
  });
  it('permission floor: none/manage-only -> auth.forbidden, zero DB access, for every operation', async () => {
    for (const a of Object.keys(OPS) as Act[]) for (const who of [{ grants: [], centres: [C1] }, { grants: [MANAGE], centres: [C1] }] as Who[]) {
      const r = await act(a, TID(1), {}, who); expect(r.error?.code, a).toBe('auth.forbidden'); expect(r.calls, a).toEqual([]);
    }
  });
  it('two parallel serves of one token with the same If-Match -> exactly one wins (version 6), the other gets 409; serving_started_at set once', async () => {
    const db = dbWith('called');
    const rs = await Promise.all([act('serve', TID(1), {}, FRONT_DESK_C1, { db }), act('serve', TID(1), {}, ALL_CENTRES, { db })]);
    const ok = rs.filter((r) => !r.error), bad = rs.filter((r) => r.error);
    expect(ok).toHaveLength(1); expect(bad).toHaveLength(1);
    expect(['common.version_conflict', 'engagement.queue_token_invalid_transition']).toContain(bad[0]!.error.code);
    expect(byId(db, TID(1))).toMatchObject({ status: 'serving', version: 6 });
    expect(queueOf(db, QA).board_version).toBe(8);
  });
  it('a full visit in order: issue -> call next -> serve -> complete, then the token is final (every further operation 409)', async () => {
    const db = mk();
    const t = (await issue({ queue_id: QA }, FRONT_DESK_C1, { db })).out.body;
    const c = (await callNext(QA, K1, FRONT_DESK_C1, { db })).out.body; expect(c).toMatchObject({ id: t.id, status: 'called', version: 2 });
    const s = (await run(OPS.serve, { params: { token_id: t.id }, headers: ifm(2) }, FRONT_DESK_C1, { db })).out.body; expect(s).toMatchObject({ status: 'serving', version: 3 });
    const d = (await run(OPS.complete, { params: { token_id: t.id }, headers: ifm(3) }, FRONT_DESK_C1, { db })).out.body; expect(d).toMatchObject({ status: 'completed', version: 4 });
    for (const a of Object.keys(OPS) as Act[]) { const r = await run(OPS[a], { params: { token_id: t.id }, headers: ifm(4) }, FRONT_DESK_C1, { db }); expect(r.error?.code, a).toBe('engagement.queue_token_invalid_transition'); }
    expect(queueOf(db, QA).board_version).toBe(10); // call (8), serve (9), complete (10)
  });
});

// ================================================================== Q7 transferQueueToken — US-EN-21.4, T-9
describe('Q7 transferQueueToken (US-EN-21.4)', () => {
  const xfer = (id: string, to: string, o: { headers?: object; body?: unknown } = {}, who: Who = FRONT_DESK_C1, opts: { db?: FakeDb; now?: string; session?: string } = {}) =>
    run('transferQueueToken', { params: { token_id: id }, headers: ifm(5), body: { to_queue_id: to }, ...o }, who, opts);

  for (const from of STATUSES) {
    if (['waiting', 'called', 'serving'].includes(from)) {
      it(`${from} token -> 200 {from: transferred, to: waiting token in queue B (B-001, transferred_from_token_id set)}`, async () => {
        const db = dbWith(from); db.tables['queue_tokens']!.splice(1, 1); // only the source token
        const r = await xfer(TID(1), QB, {}, FRONT_DESK_C1, { db });
        expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200);
        expect(errorsOf(okSchema('transferQueueToken'), r.out.body)).toEqual([]);
        expect(r.out.body.from).toMatchObject({ id: TID(1), status: 'transferred', queue_id: QA, token_label: 'A-001', version: 6 });
        expect(r.out.body.to).toMatchObject({ queue_id: QB, token_label: 'B-001', status: 'waiting', call_count: 0, version: 1 });
        expect(r.out.body.to.id).not.toBe(TID(1));
        const src = byId(db, TID(1)), dst = byId(db, r.out.body.to.id);
        expect(src).toMatchObject({ status: 'transferred', transferred_to_token_id: dst.id, version: 6 });
        expect(dst).toMatchObject({ tenant_id: A, centre_id: C1, queue_id: QB, status: 'waiting', transferred_from_token_id: TID(1), counter_id: null, seq: 1, token_label: 'B-001' });
        expect(day(dst.business_date)).toBe(TODAY); expect(iso(dst.issued_at)).toBe(NOW);
        expect(queueOf(db, QA).board_version).toBe(8); // T-9 changes what a display shows
        expect(JSON.stringify(r.out.body)).not.toMatch(/transferred_|tenant_id|centre_id/);
      });
    } else {
      it(`${from} token -> 409 engagement.queue_token_invalid_transition, no new token`, async () => {
        const db = dbWith(from); const snapshot = JSON.stringify(tokens(db));
        const r = await xfer(TID(1), QB, {}, FRONT_DESK_C1, { db });
        expect(r.error?.code).toBe('engagement.queue_token_invalid_transition'); expect(JSON.stringify(tokens(db))).toBe(snapshot);
      });
    }
  }
  it('the new token continues the target queue\'s own day sequence (B had 3 today -> B-004) and takes the number inside the same unit of work as the old token\'s update', async () => {
    const db = mk({ tokens: [tok(1)], dayCounters: [{ tenant_id: A, queue_id: QB, centre_id: C1, business_date: TODAY, last_seq: 3, created_by: A }] });
    const r = await xfer(TID(1), QB, {}, FRONT_DESK_C1, { db });
    expect(r.out.body.to.token_label).toBe('B-004');
  });
  it('day rollover: a transfer after local midnight numbers the new token on the new business date (B-001)', async () => {
    const db = mk({ tokens: [tok(1)], dayCounters: [{ tenant_id: A, queue_id: QB, centre_id: C1, business_date: TODAY, last_seq: 3, created_by: A }] });
    const r = await xfer(TID(1), QB, {}, FRONT_DESK_C1, { db, now: T_0001 });
    expect(r.out.body.to.token_label).toBe('B-001'); expect(day(byId(db, r.out.body.to.id).business_date)).toBe(TOMORROW);
  });
  it('target queue inactive / queue feature off -> 409 engagement.queue_closed and the source token stays as it was', async () => {
    const db = mk({ tokens: [tok(1)] }); const r = await xfer(TID(1), QOFF, {}, FRONT_DESK_C1, { db });
    expect(r.error?.code).toBe('engagement.queue_closed'); expect(tokens(db)).toHaveLength(1); expect(byId(db, TID(1))).toMatchObject({ status: 'waiting', version: 5 });
    const off = mk({ tokens: [tok(1)], settings: [{ id: ID(0x5e1), tenant_id: A, queue_enabled: false, version: 1 }] });
    const r2 = await xfer(TID(1), QB, {}, FRONT_DESK_C1, { db: off });
    expect(r2.error?.code).toBe('engagement.queue_closed'); expect(tokens(off)).toHaveLength(1);
  });
  it('target in another centre (C2), in tenant B, unknown, or the same queue -> refused with no write at all (source untouched, nothing issued)', async () => {
    for (const to of [QC2, QTB, UNKNOWN, QA]) {
      const db = mk({ tokens: [tok(1)] }); const r = await xfer(TID(1), to, {}, ALL_CENTRES, { db });
      expect(['common.not_found', 'common.validation_failed', 'engagement.queue_closed', 'engagement.queue_token_invalid_transition'], to).toContain(r.error?.code);
      expect(anyWrites(r.calls), to).toEqual([]); expect(byId(db, TID(1)).status, to).toBe('waiting');
    }
  });
  it('If-Match: absent 428, malformed 400, stale 409 (version_conflict); nothing written', async () => {
    for (const [name, headers, code] of [['absent', {}, 'common.precondition_required'], ['malformed', ifm('x'), 'common.validation_failed'], ['stale', ifm(4), 'common.version_conflict']] as const) {
      const db = mk({ tokens: [tok(1)] }); const r = await run('transferQueueToken', { params: { token_id: TID(1) }, headers, body: { to_queue_id: QB } }, FRONT_DESK_C1, { db });
      expect(r.error?.code, name).toBe(code); expect(anyWrites(r.calls), name).toEqual([]); expect(tokens(db)).toHaveLength(1);
    }
  });
  it('body: to_queue_id required uuid, no extra fields -> 400, no write', async () => {
    for (const body of [{}, { to_queue_id: 'nope' }, { to_queue_id: QB, priority: 'priority' }, { to_queue_id: QB, status: 'waiting' }, undefined]) {
      const db = mk({ tokens: [tok(1)] }); const r = await run('transferQueueToken', { params: { token_id: TID(1) }, headers: ifm(5), body }, FRONT_DESK_C1, { db });
      expect(r.error?.code, JSON.stringify(body)).toBe('common.validation_failed'); expect(anyWrites(r.calls)).toEqual([]);
    }
  });
  it('two parallel transfers of one token (same If-Match) -> one 200, one 409; exactly one new token in queue B', async () => {
    const db = mk({ tokens: [tok(1)] });
    const rs = await Promise.all([xfer(TID(1), QB, {}, FRONT_DESK_C1, { db }), xfer(TID(1), QB, {}, ALL_CENTRES, { db })]);
    expect(rs.filter((r) => !r.error)).toHaveLength(1);
    expect(['common.version_conflict', 'engagement.queue_token_invalid_transition']).toContain(rs.find((r) => r.error)!.error.code);
    expect(tokens(db).filter((t) => t.queue_id === QB)).toHaveLength(1);
  });
  it('permission floor + PROBE Q7: none -> forbidden/zero DB; C1 staff on a C2 token or tenant B token -> 404, nothing written', async () => {
    const f = await xfer(TID(1), QB, {}, { grants: [MANAGE], centres: [C1] }); expect(f.error?.code).toBe('auth.forbidden'); expect(f.calls).toEqual([]);
    const db = mk({ tokens: [tok(1), tok(9, { centre_id: C2, queue_id: QC2, token_label: 'C-009', seq: 9 }), tok(8, { tenant_id: B, centre_id: CB, queue_id: QTB, token_label: 'A-008', seq: 8 })] });
    for (const id of [TID(9), TID(8), UNKNOWN]) { const r = await xfer(id, QB, {}, FRONT_DESK_C1, { db }); expect(r.error?.code, id).toBe('common.not_found'); expect(anyWrites(r.calls), id).toEqual([]); }
    const tb = await xfer(TID(1), QB, {}, { grants: [OPERATE], centres: [], all: true }, { db, session: B });
    expect(tb.error?.code).toBe('common.not_found'); expect(byId(db, TID(1)).status).toBe('waiting');
  });
});
