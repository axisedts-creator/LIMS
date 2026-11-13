// C16.T-Q3 — Q9 getQueueBoard (display actor) + Q8 listQueueDisplays / pairQueueDisplay / revokeQueueDisplay
// (06-PLAN row T-Q3; 02-TRD §4.10, §5 Q8/Q9, §7 device; 05-SCHEMA queue_displays, DISP policy, §4 guard; 01-PRD US-EN-22.1-5; 07-SECURITY REQ-SEC-017 (device), AB-8, §6.3 tenant probe, §6.4 centre probe).
// done_when: ETag/304; device actor limited to Q9; centre name from booking_centres. tests: display token on every other op -> 403; revoked -> 401; board has no patient fields (schema test); 304 path.
// Fails now: getQueueBoard / listQueueDisplays / pairQueueDisplay / revokeQueueDisplay are still the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec does not fix them; same conventions as queue.tokens.test.ts / T-Q1):
//   handlers[op](req:{params,query,headers,body}, ctx) -> {status, body?, headers?}; ctx = {tenantId, actor, tx, now(): ISO string, ports:{IdentityPort}}. Header names are matched case-insensitively; request header keys are lower-case ('if-match', 'if-none-match').
//   Q9: ctx.actor = {type:'device', id: <display id>} (resolver claims sub). Order: actor must be a device, else auth.forbidden (TRD §3 "board handler requires device"); then IdentityPort.assertRole(ctx,{permission:'engagement.queue.board_read'}) BEFORE any query.
//       The display row is read by id = ctx.actor.id from engagement.queue_displays; missing or status<>'active' -> 401 auth.unauthenticated (revoked in the same instant as the resolve; US-EN-22.4). centre = row.centre_id, filter = row.queue_ids.
//       Reads (simple SQL only - the fake interpreter throws `fake-sql: unsupported ...` otherwise): queue_definitions of the centre + queue_ids; queue_tokens (status called|serving, called_at within 30 min of ctx.now(), newest first, capped by engagement.settings.queue_display_history_count);
//       waiting counts per queue (status 'waiting'); queue_counters; booking_centres.display_name of the display's centre. Body = QueueBoard exactly (labels/names/counts; no ids). ETag = '"<max board_version of the display queues>"'; If-None-Match equal -> {status:304} without body and WITHOUT reading tokens/counters/booking_centres.
//   Q8: staff handlers (assertRole manage + centre first). pair: token = randomToken(32) (43 chars), stored token_sha256 = sha256Bytes(token) as bytea (08 R24), paired_by/created_by/updated_by = actor, paired_at = ctx.now(), version 1, status 'active'; 201 {display, display_token}.
//       revoke: If-Match raw '"<n>"' (absent 428, malformed 400, stale 409 common.version_conflict); UPDATE status='revoked', revoked_at=ctx.now(), revoked_by=actor, version+1; unknown / foreign tenant / foreign centre id -> 404 common.not_found and no UPDATE.
//   DB = __tests__/fakeSql.ts + the engagement tables defined below (RLS by tenant + centre scope; the display session's centre scope is its own centre).
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { randomToken, sha256Bytes } from '../../../../../../packages/shared-ts/src/crypto/index.js';
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../packages/fakes/src/harness';
import { createAuthResolverRegistry } from '../../../core/auth/resolvers.js';
import { LimsError } from '../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { manifest } from '../index.js';
import { handlers } from '../handlers/index.js';
import { queueHandlers } from '../handlers/queue.handlers.js';
import { settingsHandlers } from '../handlers/settings.handlers.js';
import { tokenHandlers } from '../handlers/token.handlers.js';
import { FakeDb, queueSchemaDefs, type Call, type Row, type TableDef } from './fakeSql.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const errorsOf = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };

const A: string = TENANTS.A;
const B: string = TENANTS.B;
const C1 = '01950c16-0000-7000-8000-0000000c0001';
const C2 = '01950c16-0000-7000-8000-0000000c0002';
const CB = '01950c16-0000-7000-8000-0000000c00b1';
const ID = (n: number) => `01950c16-0000-7000-8000-00000000${n.toString(16).padStart(4, '0')}`;
const QA = ID(0x1a1), QB = ID(0x1a2), QC2 = ID(0x1a4), QTB = ID(0x1b1);
const K1 = ID(0x2a1), K2 = ID(0x2a2), KC2 = ID(0x2a3), KTB = ID(0x2b1);
const TID = (n: number) => ID(0x300 + n);
const D1 = ID(0xd01), D2 = ID(0xd02), DREV = ID(0xd03), DC2 = ID(0xd04), DTB = ID(0xd0b);
const UNKNOWN = ID(0x7777);
const OPERATE = 'engagement.queue.operate', MANAGE = 'engagement.queue.manage', BOARD = 'engagement.queue.board_read';
const NOW = '2026-11-05T04:15:00.000Z';
const ago = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
const hex = (b: unknown) => Buffer.from(b as Uint8Array).toString('hex');
const tokenHash = (t: string) => sha256Bytes(t);
const D1_TOKEN = randomToken(32), D2_TOKEN = randomToken(32), DREV_TOKEN = randomToken(32);

// ------------------------------------------------------------------ fake DB (engagement queue + display tables)
const displayDefs = (clock: { iso: string }): Record<string, TableDef> => ({
  ...queueSchemaDefs(clock),
  settings: { columns: ['id', 'tenant_id', 'queue_enabled', 'queue_display_history_count', 'version'] },
  booking_centres: { columns: ['id', 'tenant_id', 'centre_id', 'branch_id', 'display_name', 'address_text', 'is_active', 'synced_at', 'created_at', 'created_by', 'updated_at', 'updated_by'] },
  queue_displays: {
    columns: ['id', 'tenant_id', 'centre_id', 'display_name', 'queue_ids', 'token_sha256', 'status', 'paired_at', 'paired_by', 'last_seen_at', 'revoked_at', 'revoked_by', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    notNull: ['id', 'tenant_id', 'centre_id', 'display_name', 'queue_ids', 'token_sha256', 'status', 'paired_at', 'paired_by', 'version', 'created_by', 'updated_by'],
    defaults: { status: 'active', version: 1, is_active: true, created_at: clock.iso, updated_at: clock.iso },
    unique: [['tenant_id', 'id']],
    mutable: ['status', 'revoked_at', 'revoked_by', 'is_active', 'last_seen_at', 'version', 'updated_at', 'updated_by'],
    check: (r) => !['active', 'revoked'].includes(r['status']) ? 'queue_displays__status__ck'
      : (r['status'] === 'revoked') !== (r['revoked_at'] !== null && r['revoked_at'] !== undefined) ? 'queue_displays__revoked__ck'
      : !Array.isArray(r['queue_ids']) || r['queue_ids'].length < 1 || r['queue_ids'].length > 10 ? 'queue_displays__queues__ck'
      : !r['token_sha256'] || Buffer.from(r['token_sha256']).length !== 32 ? 'queue_displays__token__ck'
      : String(r['display_name']).length < 1 || String(r['display_name']).length > 40 ? 'queue_displays__name__ck' : undefined,
  },
});
const queueRow = (id: string, tenant: string, centre: string, over: Row = {}): Row => ({
  id, tenant_id: tenant, centre_id: centre, code: 'registration', display_name: 'Registration', token_prefix: 'A', sort_order: 10, is_active: true, board_version: 7, version: 3,
  created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...over });
const counterRow = (id: string, tenant: string, centre: string, over: Row = {}): Row => ({
  id, tenant_id: tenant, centre_id: centre, display_name: 'Counter 1', sort_order: 10, is_active: true, version: 1, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...over });
const tok = (n: number, over: Row = {}): Row => ({
  id: TID(n), tenant_id: A, centre_id: C1, queue_id: QA, business_date: '2026-11-05', seq: n, token_label: `A-${String(n).padStart(3, '0')}`, priority: 'normal', status: 'waiting', booking_id: null,
  counter_id: null, issued_at: ago(60 + n), called_at: null, call_count: 0, serving_started_at: null, completed_at: null,
  transferred_to_token_id: null, transferred_from_token_id: null, version: 5, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...over });
const called = (n: number, minutesAgo: number, over: Row = {}) => tok(n, { status: 'called', counter_id: K1, called_at: ago(minutesAgo), call_count: 1, ...over });
const dispRow = (id: string, tenant: string, centre: string, queueIds: string[], token: string, over: Row = {}): Row => ({
  id, tenant_id: tenant, centre_id: centre, display_name: 'Reception TV', queue_ids: queueIds, token_sha256: Buffer.from(tokenHash(token)), status: 'active', paired_at: ago(600), paired_by: A,
  last_seen_at: null, revoked_at: null, revoked_by: null, version: 1, is_active: true, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...over });

const BOARD_TOKENS = (): Row[] => [
  called(1, 2), tok(2, { status: 'serving', counter_id: K2, called_at: ago(5), call_count: 1, serving_started_at: ago(4) }),
  called(3, 1, { queue_id: QB, token_label: 'B-003' }),
  called(4, 31),                                                                                   // called 31 min ago: outside the 30 min window
  tok(5), tok(6), tok(7, { queue_id: QB, token_label: 'B-007' }),                                  // waiting: 2 in QA, 1 in QB
  tok(8, { status: 'completed', counter_id: K1, called_at: ago(3), completed_at: ago(1) }), tok(9, { status: 'skipped', counter_id: K1, called_at: ago(3) }),
  tok(10, { status: 'expired' }), tok(11, { status: 'cancelled' }),
  called(12, 1, { centre_id: C2, queue_id: QC2, counter_id: KC2, token_label: 'C-012' }),            // another centre
  called(13, 1, { tenant_id: B, centre_id: CB, queue_id: QTB, counter_id: KTB, token_label: 'A-013' }), // another tenant
  tok(14, { booking_id: ID(0xb00c), status: 'waiting', queue_id: QB, token_label: 'B-014' }),        // booking-linked waiting token: only booking_id on the row
];
function mk(over: { tokens?: Row[]; displays?: Row[]; settings?: Row[]; queues?: Row[] } = {}, now = NOW) {
  const clock = { iso: now };
  const tables: Record<string, Row[]> = {
    collection_centres: [{ id: C1, tenant_id: A }, { id: C2, tenant_id: A }, { id: CB, tenant_id: B }],
    settings: over.settings ?? [{ id: ID(0x5e1), tenant_id: A, queue_enabled: true, queue_display_history_count: 5, version: 1 }, { id: ID(0x5e2), tenant_id: B, queue_enabled: true, queue_display_history_count: 5, version: 1 }],
    booking_centres: [
      { id: ID(0xbc1), tenant_id: A, centre_id: C1, branch_id: ID(0xb1), display_name: 'Synthetic Centre One', address_text: null, is_active: true, synced_at: NOW, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A },
      { id: ID(0xbc2), tenant_id: A, centre_id: C2, branch_id: ID(0xb1), display_name: 'Synthetic Centre Two', address_text: null, is_active: true, synced_at: NOW, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A },
      { id: ID(0xbcb), tenant_id: B, centre_id: CB, branch_id: ID(0xb2), display_name: 'Tenant B Centre', address_text: null, is_active: true, synced_at: NOW, created_at: NOW, created_by: B, updated_at: NOW, updated_by: B },
    ],
    queue_definitions: over.queues ?? [
      queueRow(QA, A, C1, { board_version: 7 }), queueRow(QB, A, C1, { code: 'sample_collection', display_name: 'Sample collection', token_prefix: 'B', sort_order: 20, board_version: 12 }),
      queueRow(QC2, A, C2, { code: 'sample_collection', display_name: 'Sample collection (C2)', token_prefix: 'C', board_version: 99 }), queueRow(QTB, B, CB, { display_name: 'Tenant B queue', board_version: 5 }),
    ],
    queue_counters: [counterRow(K1, A, C1), counterRow(K2, A, C1, { display_name: 'Counter 2', sort_order: 20 }), counterRow(KC2, A, C2, { display_name: 'Counter (C2)' }), counterRow(KTB, B, CB, { display_name: 'Tenant B counter' })],
    queue_day_counters: [],
    queue_tokens: over.tokens ?? BOARD_TOKENS(),
    queue_displays: over.displays ?? [
      dispRow(D1, A, C1, [QA, QB], D1_TOKEN), dispRow(D2, A, C1, [QA], D2_TOKEN, { display_name: 'Lobby' }),
      dispRow(DREV, A, C1, [QA], DREV_TOKEN, { status: 'revoked', revoked_at: ago(10), revoked_by: A, version: 2, display_name: 'Old TV' }),
      dispRow(DC2, A, C2, [QC2], randomToken(32), { display_name: 'C2 TV' }), dispRow(DTB, B, CB, [QTB], randomToken(32), { display_name: 'B TV' }),
    ],
  };
  return new FakeDb(tables, displayDefs(clock), clock);
}

// ------------------------------------------------------------------ harness
const verb = (c: Call) => /^\s*(select|insert|update|delete)\b/i.exec(c.text)?.[1]?.toLowerCase();
const writes = (c: Call[]) => c.filter((x) => ['insert', 'update', 'delete'].includes(verb(x) ?? ''));
const touches = (c: Call[], table: string) => c.filter((x) => new RegExp(`engagement\\.${table}\\b`, 'i').test(x.text));
interface Who { type?: 'user' | 'device' | 'patient'; id?: string; grants: readonly string[]; centres: readonly string[]; all?: boolean }
function identity(w: Who) {
  const calls: Array<{ permission: string; centreId?: string }> = [];
  return {
    calls,
    async assertRole(_c: unknown, r: { permission: string; centreId?: string }) {
      calls.push({ permission: r?.permission, ...(r?.centreId ? { centreId: r.centreId } : {}) });
      if (!w.grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
      if (r.centreId && !w.all && !w.centres.includes(r.centreId)) throw new LimsError('auth.forbidden');
    },
    async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
    async getActor() { return { actor: { type: w.type ?? 'user', id: w.id ?? A }, permissions: [...w.grants], roles: [], centreScope: { all: Boolean(w.all), centreIds: w.centres }, mfa: { enrolled: true, level: 'aal2' } }; },
  };
}
const ADMIN_C1: Who = { grants: [MANAGE], centres: [C1] };
const ADMIN_C2: Who = { grants: [MANAGE], centres: [C2] };
const ADMIN_ALL: Who = { grants: [MANAGE, OPERATE], centres: [], all: true };
const OPERATE_ONLY: Who = { grants: [OPERATE], centres: [C1] };
const displayOf = (id: string, centre = C1): Who => ({ type: 'device', id, grants: [BOARD], centres: [centre] });
const ctxFor = makeCtxFor();
async function run(op: string, o: { params?: object; query?: object; headers?: object; body?: unknown }, who: Who, opts: { db?: FakeDb; session?: string; now?: string } = {}) {
  const tenant = opts.session ?? A;
  const db = opts.db ?? mk();
  if (opts.now) db.clock.iso = opts.now;
  const s = db.session(tenant, { all: Boolean(who.all), centres: who.centres });
  const id = identity(who);
  const ctx: any = { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    ...ctxFor(tenant === B ? 'B' : 'A', { tx: s.tx as never, ports: { IdentityPort: id } as never, now: () => db.clock.iso, actor: { type: who.type ?? 'user', id: who.id ?? (tenant === B ? B : A) } } as never) };
  const r = { params: {}, query: {}, headers: {}, body: undefined, ...o } as never;
  const before = db.calls.length;
  let out: any, error: any;
  try { out = await (handlers as any)[op](r, ctx); } catch (e) { error = e; } finally { s.release(); }
  return { out, error, db, id, ctx, calls: db.calls.slice(before) };
}
const hdr = (out: any, name: string) => Object.entries<string>(out?.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
const board = (displayId: string, h: object = {}, opts: { db?: FakeDb; now?: string; session?: string; centre?: string } = {}) =>
  run('getQueueBoard', { headers: h }, displayOf(displayId, opts.centre), opts);
const pair = (body: unknown, who: Who = ADMIN_C1, opts: { db?: FakeDb } = {}) => run('pairQueueDisplay', { body }, who, opts);
const revoke = (id: string, headers: object, who: Who = ADMIN_C1, opts: { db?: FakeDb; session?: string } = {}) => run('revokeQueueDisplay', { params: { display_id: id }, headers }, who, opts);
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
const row = (db: FakeDb, id: string) => db.tables['queue_displays']!.find((d) => d.id === id)!;
const iso = (v: unknown) => (v === null || v === undefined ? v : new Date(v as string).toISOString());
const code = (e: any) => e?.code ?? e?.message;
const PAIR_BODY = { centre_id: C1, display_name: 'Reception TV', queue_ids: [QA, QB] };
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const byName = <T extends { queue_display_name: string }>(a: T[]) => [...a].sort((x, y) => x.queue_display_name.localeCompare(y.queue_display_name));

// ================================================================== Q9 getQueueBoard — US-EN-22.2, 22.5
describe('Q9 getQueueBoard: content (US-EN-22.5, TRD §4.10)', () => {
  it('200 QueueBoard for the display: centre name from booking_centres, now_calling newest first (called + serving, last 30 min, own queues/centre only), waiting counts per queue', async () => {
    const r = await board(D1);
    expect(r.error).toBeUndefined();
    expect(r.out.status).toBe(200);
    const b = r.out.body;
    expect(errorsOf('QueueBoard', b)).toEqual([]);
    expect(b.centre_display_name).toBe('Synthetic Centre One');
    expect(b.board_version).toBe(12);
    expect(iso(b.generated_at)).toBe(NOW);
    expect(b.now_calling.map((t: any) => t.token_label)).toEqual(['B-003', 'A-001', 'A-002']);
    expect(b.now_calling.map((t: any) => [t.counter_display_name, t.queue_display_name])).toEqual([['Counter 1', 'Sample collection'], ['Counter 1', 'Registration'], ['Counter 2', 'Registration']]);
    expect(b.now_calling.map((t: any) => iso(t.called_at))).toEqual([ago(1), ago(2), ago(5)]);
    expect(byName(b.waiting).map((w: any) => [w.queue_display_name, w.waiting_count])).toEqual([['Registration', 2], ['Sample collection', 2]]);
  });
  it('the display queue_ids filter applies: display D2 (queue A only) sees only queue A tokens/counts and the ETag of queue A', async () => {
    const r = await board(D2);
    expect(r.out.body.now_calling.map((t: any) => t.token_label)).toEqual(['A-001', 'A-002']);
    expect(byName(r.out.body.waiting).map((w: any) => [w.queue_display_name, w.waiting_count])).toEqual([['Registration', 2]]);
    expect(r.out.body.board_version).toBe(7);
    expect(hdr(r.out, 'etag')).toBe('"7"');
  });
  it('a queue with nobody waiting is absent or has waiting_count 0', async () => {
    const r = await board(D1, {}, { db: mk({ tokens: [called(1, 2)] }) });
    const w = r.out.body.waiting as Array<{ queue_display_name: string; waiting_count: number }>;
    expect(w.filter((x) => x.waiting_count !== 0)).toEqual([]);
  });
  it('now_calling is capped at queue_display_history_count (default 5, setting 3), newest first', async () => {
    const seven = () => [1, 2, 3, 4, 5, 6, 7].map((n) => called(n, n));
    const five = await board(D2, {}, { db: mk({ tokens: seven() }) });
    expect(five.out.body.now_calling.map((t: any) => t.token_label)).toEqual(['A-001', 'A-002', 'A-003', 'A-004', 'A-005']);
    const settings = [{ id: ID(0x5e1), tenant_id: A, queue_enabled: true, queue_display_history_count: 3, version: 1 }];
    const three = await board(D2, {}, { db: mk({ tokens: seven(), settings }) });
    expect(three.out.body.now_calling.map((t: any) => t.token_label)).toEqual(['A-001', 'A-002', 'A-003']);
  });
  it('the 30 minute window follows ctx.now(): the same data later shows fewer calls', async () => {
    const r = await board(D2, {}, { now: new Date(Date.parse(NOW) + 4 * 60_000).toISOString() }); // A-001 now called 6 min ago, A-002 9 min ago: still inside
    expect(r.out.body.now_calling.map((t: any) => t.token_label)).toEqual(['A-001', 'A-002']);
    const later = await board(D2, {}, { now: new Date(Date.parse(NOW) + 28 * 60_000).toISOString() }); // A-001 30 min old at +28 -> boundary excluded for A-002 (33 min)
    expect(later.out.body.now_calling.map((t: any) => t.token_label)).not.toContain('A-002');
  });
  it('centre_display_name is the display centre\'s booking_centres.display_name (C2 display -> Centre Two)', async () => {
    const r = await board(DC2, {}, { centre: C2 });
    expect(r.out.body.centre_display_name).toBe('Synthetic Centre Two');
    expect(r.out.body.now_calling.map((t: any) => t.token_label)).toEqual(['C-012']);
    expect(r.out.body.board_version).toBe(99);
  });
  it('reading the board never writes tokens, counters or board_version', async () => {
    const r = await board(D1);
    expect(writes(r.calls).filter((c) => !/engagement\.queue_displays\b/i.test(c.text))).toEqual([]);
  });
});

describe('Q9 getQueueBoard: ETag / 304 (US-EN-22.2, TRD §4.10, R-6)', () => {
  it('200 carries ETag "<max board_version of the display queues>" (not another centre\'s 99) and board_version equals it', async () => {
    const r = await board(D1);
    expect(hdr(r.out, 'etag')).toBe('"12"');
    expect(r.out.body.board_version).toBe(12);
  });
  it('If-None-Match equal to the ETag -> 304 with no body', async () => {
    const r = await board(D1, { 'if-none-match': '"12"' });
    expect(r.error).toBeUndefined();
    expect(r.out.status).toBe(304);
    expect(r.out.body).toBeUndefined();
  });
  it('304 path is cheap: no token / counter / booking_centres read and no write except queue_displays', async () => {
    const r = await board(D1, { 'if-none-match': '"12"' });
    expect(r.out.status).toBe(304);
    expect(touches(r.calls, 'queue_tokens')).toEqual([]);
    expect(touches(r.calls, 'queue_counters')).toEqual([]);
    expect(touches(r.calls, 'booking_centres')).toEqual([]);
    expect(writes(r.calls).filter((c) => !/engagement\.queue_displays\b/i.test(c.text))).toEqual([]);
  });
  it('a stale or different If-None-Match -> 200 with the current ETag', async () => {
    for (const v of ['"11"', '"13"', '"7"']) {
      const r = await board(D1, { 'if-none-match': v });
      expect(r.out.status, v).toBe(200);
      expect(hdr(r.out, 'etag'), v).toBe('"12"');
    }
  });
  it('a call-next elsewhere (board_version 12 -> 13) turns the next conditional poll into 200 "13"; unchanged queues of other centres do not', async () => {
    const db = mk();
    expect((await board(D1, { 'if-none-match': '"12"' }, { db })).out.status).toBe(304);
    db.tables['queue_definitions']!.find((q) => q.id === QC2)!['board_version'] = 150;   // another centre: ETag of D1 unchanged
    expect((await board(D1, { 'if-none-match': '"12"' }, { db })).out.status).toBe(304);
    db.tables['queue_definitions']!.find((q) => q.id === QA)!['board_version'] = 13;
    const r = await board(D1, { 'if-none-match': '"12"' }, { db });
    expect(r.out.status).toBe(200);
    expect(hdr(r.out, 'etag')).toBe('"13"');
    expect(r.out.body.board_version).toBe(13);
  });
});

describe('Q9 getQueueBoard: the board has no patient fields (US-EN-22.5, REQ-SEC-081; schema + runtime)', () => {
  const props = (s: any, path = '$'): Array<{ path: string; keys: string[]; closed: boolean }> => {
    if (!s || typeof s !== 'object') return [];
    const out: Array<{ path: string; keys: string[]; closed: boolean }> = [];
    if (s.properties) {
      out.push({ path, keys: Object.keys(s.properties), closed: s.additionalProperties === false });
      for (const [k, v] of Object.entries<any>(s.properties)) out.push(...props(v, `${path}.${k}`));
    }
    if (s.items) out.push(...props(s.items, `${path}[]`));
    return out;
  };
  it('contract: QueueBoard exposes exactly the TRD §4.10 fields, every object closed (additionalProperties:false), no id/patient/booking property anywhere', () => {
    const all = props(spec.components.schemas.QueueBoard);
    const byPath = Object.fromEntries(all.map((p) => [p.path, p.keys.slice().sort()]));
    expect(byPath['$']).toEqual(['board_version', 'centre_display_name', 'generated_at', 'now_calling', 'waiting']);
    expect(byPath['$.now_calling[]']).toEqual(['called_at', 'counter_display_name', 'queue_display_name', 'token_label']);
    expect(byPath['$.waiting[]']).toEqual(['queue_display_name', 'waiting_count']);
    expect(all.filter((p) => !p.closed)).toEqual([]);
    expect(JSON.stringify(spec.components.schemas.QueueBoard)).not.toMatch(/patient|phone|booking|birth|dob|sex|gender|address|email|specimen|order_|_id"/i);
  });
  it('runtime: the response is only labels/names/counts - no uuid, no booking id, no tenant/centre id, no other keys; tokens linked to a booking leak nothing', async () => {
    const r = await board(D1);
    const s = JSON.stringify(r.out.body);
    expect(s).not.toMatch(UUID_RE);
    expect(s).not.toMatch(/booking|patient|tenant_id|centre_id|queue_id|counter_id|token_id|"id"/i);
    expect(Object.keys(r.out.body).sort()).toEqual(['board_version', 'centre_display_name', 'generated_at', 'now_calling', 'waiting']);
    for (const t of r.out.body.now_calling) expect(Object.keys(t).sort()).toEqual(['called_at', 'counter_display_name', 'queue_display_name', 'token_label']);
    for (const w of r.out.body.waiting) expect(Object.keys(w).sort()).toEqual(['queue_display_name', 'waiting_count']);
    expect(s).not.toContain('Tenant B');
    expect(s).not.toContain('(C2)');
  });
});

describe('Q9 getQueueBoard: only a display device may call it (US-EN-22.3, REQ-SEC-017 device)', () => {
  it('a staff user (even holding every permission) -> 403 auth.forbidden, zero queries', async () => {
    const r = await run('getQueueBoard', {}, { grants: [BOARD, MANAGE, OPERATE], centres: [], all: true });
    expect(code(r.error)).toBe('auth.forbidden');
    expect(r.calls).toEqual([]);
  });
  it('a patient actor -> 403 auth.forbidden, zero queries', async () => {
    const r = await run('getQueueBoard', {}, { type: 'patient', grants: [BOARD], centres: [] });
    expect(code(r.error)).toBe('auth.forbidden');
    expect(r.calls).toEqual([]);
  });
  it('a device without engagement.queue.board_read (other device kind) -> 403, zero queries', async () => {
    const r = await run('getQueueBoard', {}, { type: 'device', id: D1, grants: ['instruments.ingest.submit'], centres: [C1] });
    expect(code(r.error)).toBe('auth.forbidden');
    expect(r.calls).toEqual([]);
  });
  it('the display asks IdentityPort for engagement.queue.board_read', async () => {
    const r = await board(D1);
    expect(r.id.calls.map((c) => c.permission)).toContain(BOARD);
  });
  it('a display whose row is revoked or unknown -> 401 auth.unauthenticated and no board data (US-EN-22.4; resolver already refuses, this is the same-instant race)', async () => {
    for (const id of [DREV, UNKNOWN]) {
      const r = await board(id);
      expect(code(r.error), id).toBe('auth.unauthenticated');
      expect(r.out).toBeUndefined();
      expect(touches(r.calls, 'queue_tokens')).toEqual([]);
    }
  });
  it('tenant isolation: a tenant-B display sees only tenant-B data; a tenant-A display id used in tenant B finds no row (401)', async () => {
    const own = await board(DTB, {}, { session: B, centre: CB });
    expect(own.out.body.centre_display_name).toBe('Tenant B Centre');
    expect(own.out.body.now_calling.map((t: any) => t.token_label)).toEqual(['A-013']);
    expect(JSON.stringify(own.out.body)).not.toContain('Synthetic');
    const cross = await board(D1, {}, { session: B, centre: CB });
    expect(code(cross.error)).toBe('auth.unauthenticated');
  });
  it('centre isolation: a display never lists tokens of another centre even if its queue_ids name that centre\'s queue', async () => {
    const db = mk({ displays: [dispRow(D1, A, C1, [QA, QC2], D1_TOKEN)] });
    const r = await board(D1, {}, { db });
    expect(r.out.body.now_calling.map((t: any) => t.token_label)).not.toContain('C-012');
    expect(r.out.body.board_version).toBe(7);
  });
});

// ================================================================== display token on every other operation -> 403
describe('display token on every other operation -> 403 auth.forbidden (US-EN-22.3, 07 AB-8)', () => {
  const IMPLEMENTED = [...Object.keys(settingsHandlers), ...Object.keys(queueHandlers), ...Object.keys(tokenHandlers), 'pairQueueDisplay', 'listQueueDisplays', 'revokeQueueDisplay'];
  const OTHERS = Object.keys(handlers).filter((op) => op !== 'getQueueBoard');
  const device = displayOf(D1);
  const req = { params: { token_id: TID(1), queue_id: QA, display_id: D1, booking_id: ID(0xb1), reminder_id: ID(0xb2) }, query: { centre_id: C1 }, headers: { 'if-match': '"1"' }, body: {} };

  it('the operation set is the whole engagement contract (every operationId except getQueueBoard)', () => {
    const ids = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p)).map((m: any) => m?.operationId).filter(Boolean).sort();
    expect([...OTHERS, 'getQueueBoard'].sort()).toEqual(ids);
    for (const op of IMPLEMENTED) expect(OTHERS, op).toContain(op);
  });
  it.each(IMPLEMENTED)('%s with a display device -> auth.forbidden and zero queries', async (op) => {
    const r = await run(op, req, device);
    expect(r.out, op).toBeUndefined();
    expect(code(r.error), op).toBe('auth.forbidden');
    expect(r.calls, op).toEqual([]);
  });
  it('every operation still to be built never answers a display device with a 2xx/3xx and runs no query (fails closed; the owning task must make it 403)', async () => {
    for (const op of OTHERS.filter((o) => !IMPLEMENTED.includes(o))) {
      const r = await run(op, req, device);
      expect(r.out, op).toBeUndefined();
      expect(r.error, op).toBeDefined();
      expect(r.calls, op).toEqual([]);
    }
  });
});

// ================================================================== Q8 pairQueueDisplay — US-EN-22.1
describe('Q8 pairQueueDisplay (US-EN-22.1)', () => {
  it('201 {display, display_token}: 43-char base64url token, QueueDisplay without secrets, active, version 1', async () => {
    const db = mk();
    const r = await pair(PAIR_BODY, ADMIN_C1, { db });
    expect(r.error).toBeUndefined();
    expect(r.out.status).toBe(201);
    expect(Object.keys(r.out.body).sort()).toEqual(['display', 'display_token']);
    expect(r.out.body.display_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.out.body.display).toMatchObject({ centre_id: C1, display_name: 'Reception TV', queue_ids: [QA, QB], status: 'active', version: 1 });
    expect(errorsOf('QueueDisplay', r.out.body.display)).toEqual([]);   // last_seen_at / revoked_at omitted, not null
    expect(JSON.stringify(r.out.body.display)).not.toMatch(/token|sha256|tenant_id|paired_by|created_by|updated_by/i);
    expect(r.id.calls.some((c) => c.permission === MANAGE && c.centreId === C1)).toBe(true);
  });
  it('persists only the SHA-256 of the token (32 bytes), centre/tenant/actor/time; the plaintext token is in no column and in no SQL parameter (US-EN-22.1, REQ-SEC secret handling)', async () => {
    const db = mk();
    const r = await pair(PAIR_BODY, ADMIN_C1, { db });
    const token = r.out.body.display_token as string;
    const stored = row(db, r.out.body.display.id);
    expect(Buffer.from(stored['token_sha256'] as Uint8Array).length).toBe(32);
    expect(hex(stored['token_sha256'])).toBe(hex(tokenHash(token)));
    expect(stored).toMatchObject({ tenant_id: A, centre_id: C1, status: 'active', version: 1, queue_ids: [QA, QB], display_name: 'Reception TV', paired_by: r.ctx.actor.id, revoked_at: null });
    expect(iso(stored['paired_at'])).toBe(NOW);
    expect(JSON.stringify(db.tables['queue_displays'])).not.toContain(token);
    expect(JSON.stringify(r.calls)).not.toContain(token);
    expect(writes(r.calls).every((c) => /engagement\.queue_displays\b/i.test(c.text))).toBe(true);
  });
  it('a double submit creates a second pairing with a different token (no idempotency, TRD §5 Q8); both rows exist and each token resolves to its own display hash', async () => {
    const db = mk();
    const a = await pair(PAIR_BODY, ADMIN_C1, { db }), b = await pair(PAIR_BODY, ADMIN_C1, { db });
    expect(a.out.body.display_token).not.toBe(b.out.body.display_token);
    expect(a.out.body.display.id).not.toBe(b.out.body.display.id);
    expect(hex(row(db, a.out.body.display.id)['token_sha256'])).not.toBe(hex(row(db, b.out.body.display.id)['token_sha256']));
  });
  const BAD: Record<string, unknown> = {
    'display_name empty': { ...PAIR_BODY, display_name: '' }, 'display_name 41 chars': { ...PAIR_BODY, display_name: 'x'.repeat(41) }, 'display_name missing': { centre_id: C1, queue_ids: [QA] },
    'queue_ids empty': { ...PAIR_BODY, queue_ids: [] }, 'queue_ids 11': { ...PAIR_BODY, queue_ids: Array.from({ length: 11 }, (_, i) => ID(0x900 + i)) },
    'queue_ids duplicate': { ...PAIR_BODY, queue_ids: [QA, QA] }, 'queue_ids not uuid': { ...PAIR_BODY, queue_ids: ['nope'] }, 'queue_ids missing': { centre_id: C1, display_name: 'TV' },
    'centre_id not uuid': { ...PAIR_BODY, centre_id: 'nope' }, 'centre_id missing': { display_name: 'TV', queue_ids: [QA] },
    'extra tenant_id': { ...PAIR_BODY, tenant_id: B }, 'extra token_sha256': { ...PAIR_BODY, token_sha256: 'AA' }, 'extra status': { ...PAIR_BODY, status: 'revoked' }, 'no body': undefined, 'array body': [],
  };
  it.each(Object.entries(BAD))('400 common.validation_failed and no row: %s', async (_n, body) => {
    const db = mk(); const before = db.tables['queue_displays']!.length;
    const r = await pair(body, ADMIN_ALL, { db });
    expect(code(r.error)).toBe('common.validation_failed');
    expect(db.tables['queue_displays']!.length).toBe(before);
  });
  it('queue ids that are not this centre\'s queues (other tenant, other centre, unknown) are refused with the same not-found/validation outcome, no row, no tenant-B hint (07 §6.3)', async () => {
    const codes: string[] = [];
    for (const q of [QTB, QC2, UNKNOWN]) {
      const db = mk(); const before = db.tables['queue_displays']!.length;
      const r = await pair({ ...PAIR_BODY, queue_ids: [QA, q] }, ADMIN_ALL, { db });
      expect(r.error instanceof LimsError, String(q)).toBe(true);
      expect(['common.not_found', 'common.validation_failed'], String(q)).toContain(code(r.error));
      expect(db.tables['queue_displays']!.length).toBe(before);
      codes.push(code(r.error));
    }
    expect(codes[0]).toBe(codes[2]); // tenant-B id is indistinguishable from an unknown id
  });
  it('needs engagement.queue.manage at that centre: operate-only 403, centre C2 staff pairing at C1 403 (or 404), tenant-B centre not found/forbidden; never a row', async () => {
    for (const [who, body] of [[OPERATE_ONLY, PAIR_BODY], [ADMIN_C2, PAIR_BODY], [ADMIN_ALL, { ...PAIR_BODY, centre_id: CB, queue_ids: [QTB] }]] as const) {
      const db = mk(); const before = db.tables['queue_displays']!.length;
      const r = await pair(body, who, { db });
      expect(r.error instanceof LimsError).toBe(true);
      expect(['auth.forbidden', 'common.not_found']).toContain(code(r.error));
      expect(db.tables['queue_displays']!.length).toBe(before);
    }
    const op = await pair(PAIR_BODY, OPERATE_ONLY);
    expect(code(op.error)).toBe('auth.forbidden');
    expect(touches(op.calls, 'queue_displays')).toEqual([]);
  });
});

// ================================================================== Q8 listQueueDisplays / revokeQueueDisplay — US-EN-22.1, 22.4
describe('Q8 listQueueDisplays', () => {
  it('centre-scoped staff: own-centre displays (active and revoked), schema-valid, no token material; never another centre or tenant', async () => {
    const r = await run('listQueueDisplays', {}, ADMIN_C1);
    expect(r.error).toBeUndefined();
    expect(r.out.status).toBe(200);
    const ids = r.out.body.data.map((d: any) => d.id).sort();
    expect(ids).toEqual([D1, D2, DREV].sort());
    for (const d of r.out.body.data) expect(errorsOf('QueueDisplay', d)).toEqual([]);
    expect(r.out.body.data.find((d: any) => d.id === DREV)).toMatchObject({ status: 'revoked', version: 2 });
    expect(JSON.stringify(r.out.body)).not.toMatch(/token|sha256|tenant_id|paired_by|[A-Za-z0-9_-]{43}/);
  });
  it('all-centres staff also sees C2 displays, never tenant B; ?centre_id narrows; a foreign centre is 403 or empty', async () => {
    const all = await run('listQueueDisplays', {}, ADMIN_ALL);
    expect(all.out.body.data.map((d: any) => d.id).sort()).toEqual([D1, D2, DREV, DC2].sort());
    const one = await run('listQueueDisplays', { query: { centre_id: C2 } }, ADMIN_ALL);
    expect(one.out.body.data.map((d: any) => d.id)).toEqual([DC2]);
    const foreign = await run('listQueueDisplays', { query: { centre_id: C2 } }, ADMIN_C1);
    if (foreign.error) expect(code(foreign.error)).toBe('auth.forbidden'); else expect(foreign.out.body.data).toEqual([]);
  });
  it('operate-only staff -> 403 and zero queries', async () => {
    const r = await run('listQueueDisplays', {}, OPERATE_ONLY);
    expect(code(r.error)).toBe('auth.forbidden');
    expect(r.calls).toEqual([]);
  });
});

describe('Q8 revokeQueueDisplay (US-EN-22.4)', () => {
  it('200 QueueDisplay revoked: status, revoked_at = now, version + 1; row carries revoked_by; token hash untouched; nothing else changes', async () => {
    const db = mk(); const before = { ...row(db, D1) };
    const r = await revoke(D1, ifm(1), ADMIN_C1, { db });
    expect(r.error).toBeUndefined();
    expect(r.out.status).toBe(200);
    expect(r.out.body).toMatchObject({ id: D1, status: 'revoked', version: 2 });
    expect(iso(r.out.body.revoked_at)).toBe(NOW);
    expect(errorsOf('QueueDisplay', r.out.body)).toEqual([]);
    const now = row(db, D1);
    expect(now).toMatchObject({ status: 'revoked', version: 2, revoked_by: r.ctx.actor.id });
    expect(iso(now['revoked_at'])).toBe(NOW);
    expect(hex(now['token_sha256'])).toBe(hex(before['token_sha256']));
    expect({ ...now, status: 0, revoked_at: 0, revoked_by: 0, version: 0, updated_at: 0, updated_by: 0, is_active: 0 }).toEqual({ ...before, status: 0, revoked_at: 0, revoked_by: 0, version: 0, updated_at: 0, updated_by: 0, is_active: 0 });
    expect(r.id.calls.some((c) => c.permission === MANAGE)).toBe(true);
  });
  it('If-Match: absent -> 428 common.precondition_required, malformed -> 400, stale -> 409 common.version_conflict; none writes', async () => {
    for (const [h, c] of [[{}, 'common.precondition_required'], [ifm('abc'), 'common.validation_failed'], [ifm('"0x1"'), 'common.validation_failed'], [ifm(5), 'common.version_conflict']] as const) {
      const db = mk();
      const r = await revoke(D1, h, ADMIN_C1, { db });
      expect(code(r.error), JSON.stringify(h)).toBe(c);
      expect(row(db, D1)['status']).toBe('active');
      expect(writes(r.calls)).toEqual([]);
    }
  });
  it('unknown id, tenant-B id and a C2 display (staff scoped to C1) -> 404 common.not_found, no UPDATE, rows untouched', async () => {
    for (const [id, session] of [[UNKNOWN, A], [DTB, A], [DC2, A]] as const) {
      const db = mk();
      const r = await revoke(id, ifm(1), ADMIN_C1, { db, session });
      expect(code(r.error), id).toBe('common.not_found');
      expect(writes(r.calls), id).toEqual([]);
      expect(db.tables['queue_displays']!.filter((d) => d.status === 'revoked').length).toBe(1); // only the seeded DREV
    }
  });
  it('operate-only -> 403 with no write; a malformed display_id -> 400/404 with no write', async () => {
    const a = await revoke(D1, ifm(1), OPERATE_ONLY);
    expect(code(a.error)).toBe('auth.forbidden');
    expect(writes(a.calls)).toEqual([]);
    const b = await revoke('not-a-uuid', ifm(1));
    expect(['common.validation_failed', 'common.not_found']).toContain(code(b.error));
    expect(writes(b.calls)).toEqual([]);
  });
});

// ================================================================== end to end: pair -> resolve -> board -> revoke -> 401
describe('pair -> resolver -> board -> revoke -> 401 (US-EN-22.1, 22.2, 22.4)', () => {
  const definer = (db: FakeDb) => ({
    async query(text: string, values: unknown[] = []) {
      if (!/app\.engagement_resolve_display/i.test(text)) throw new Error(`unexpected query ${text}`);
      const h = hex(values[0]);
      const d = db.tables['queue_displays']!.find((x) => hex(x['token_sha256']) === h && x['status'] === 'active');
      return d ? { rows: [{ tenant_id: d['tenant_id'], centre_id: d['centre_id'], display_id: d['id'] }], rowCount: 1 } : { rows: [], rowCount: 0 };
    },
  });
  it('the token returned by pair authenticates as that display, reads its board (200 then 304), and stops working the moment staff revoke it', async () => {
    const db = mk();
    const p = await pair({ centre_id: C1, display_name: 'Lobby TV', queue_ids: [QA] }, ADMIN_C1, { db });
    const token = p.out.body.display_token as string;
    const registry = createAuthResolverRegistry([manifest]);
    const claims = await registry.authenticate('queueDisplayToken', token, definer(db));
    expect(claims).toMatchObject({ sub: p.out.body.display.id, tenant_id: A, centre_id: C1, actor_type: 'device', device_kind: 'queue_display' });

    const first = await board(claims.sub, {}, { db, centre: claims['centre_id'] as string });
    expect(first.out.status).toBe(200);
    expect(first.out.body.centre_display_name).toBe('Synthetic Centre One');
    const etag = hdr(first.out, 'etag')!;
    expect((await board(claims.sub, { 'if-none-match': etag }, { db })).out.status).toBe(304);

    const rv = await revoke(p.out.body.display.id, ifm(1), ADMIN_C1, { db });
    expect(rv.out.status).toBe(200);
    await expect(registry.authenticate('queueDisplayToken', token, definer(db))).rejects.toMatchObject({ code: 'auth.unauthenticated' });
    expect(code((await board(claims.sub, {}, { db })).error)).toBe('auth.unauthenticated'); // same-instant race: the handler refuses too
  });
});
