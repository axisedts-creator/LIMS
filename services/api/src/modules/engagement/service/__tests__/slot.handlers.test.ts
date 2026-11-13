// C16.T-B2 — S6 getSlotAvailability, S7 listSlotTemplates, S8 createSlotTemplate, S9 updateSlotTemplate, S10 deactivateSlotTemplate, S11 listSlotBlackouts / createSlotBlackout / deactivateSlotBlackout.
// (06-PLAN row T-B2; 02-TRD §4.8 slot generation + §5 S6-S11 + §8.1 sync_booking_centres; 05-SCHEMA slot_templates / slot_blackouts / slot_occupancy / bookings; 01-PRD US-EN-16.1-4;
//  07-SECURITY §6.4 centre-scope probes, REQ-SEC-017, REQ-SEC-080; 08 A19 D-119.)
// done_when: overlap rule; overbooked flag; affected counts; template save enqueues the centre sync. tests: integration; timezone fixture (Asia/Kathmandu UTC+05:45).
// Fails now: handlers/index.ts maps all eight operationIds to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec does not fix them; same convention as queue.handlers.test.ts):
//   handlers[op](req:{params,query,headers,body}, ctx) -> {status, body}; ctx = {tenantId, actor, tx, now:()=>ISO, ports:{IdentityPort}}. Tenant and actor come from ctx only.
//   IdentityPort.assertRole(ctx,{permission, centreId?}) BEFORE any tx.query (S6 engagement.booking.read; S7-S11 engagement.slot.manage; permissions.yaml: slot.manage = tenant_admin, lab_manager).
//   Timezone = IdentityPort.getTenantSettings(ctx,{keys:['timezone']}) (fallback Asia/Kathmandu). Template times are stored as LOCAL wall-clock 'HH:MM' (never converted to UTC); DTO times are 'HH:MM'.
//   DB = the in-house SQL interpreter fakeSql.ts (FakeDb). Statements must stay inside its subset or the test fails loudly with `fake-sql: unsupported ...`:
//     SELECT .. FROM t [WHERE a AND b ..] [ORDER BY ..] [LIMIT n] [FOR UPDATE], SELECT count(*), INSERT .. VALUES, UPDATE .. SET .. WHERE .. [RETURNING], `col = ANY($n)`, `col IN (..)`, `col <> $n`,
//     `col IS [NOT] NULL`, comparison against bound values / now(). No OR, no JOIN, no sub-select (several simple statements + JS is fine). It models tenant + centre RLS (STAFF_C), NOT NULL, UNIQUE, FK, CHECK.
//   Ids are supplied by the service (the schema has no DEFAULT on id). Rows use pg shapes: time columns as 'HH:MM:SS', date columns as 'YYYY-MM-DD', weekdays as number[], timestamptz as ISO strings.
//   Overlap rule (TRD §4.8, 05-SCHEMA comment): same tenant + centre + booking_kind, both ACTIVE, shared weekday, time ranges overlap (edges exclusive: 07-11 and 11-15 do not), effective date ranges
//     overlap (inclusive, effective_to NULL = open) -> 400 common.validation_failed with errors[].path '/start_local'. A template never overlaps itself on update.
//   Enqueue (08 A19 D-119, TRD §8.1): after a successful S8/S9/S10 write, in the same tx, `SELECT app.enqueue_job($1, $2::jsonb, $3, ..)` with $1 'engagement.sync_booking_centres', $2 JSON {tenant_id}, $3 job key
//     'bcentres:<tenant_id>' (any numeric max-attempts argument must be 5, TRD §8.1). Never on a rejected / conflicting / not-found save, never on S11 (TRD names S8/S9/S10 only).
//   overbooked (S6 flag, S9 affected.overbooked_slots): slot_occupancy.booked > the template's CURRENT capacity, future slots only (slot_start > ctx.now()). remaining = max(0, capacity - booked). No booking is ever written.
//   affected.future_bookings (S10): confirmed bookings with slot_start > now that sit on slot_occupancy rows of that template (bookings.slot_occupancy_id). S11: confirmed bookings of the centre with
//     slot_start > now overlapping [starts_at, ends_at) (slot_start < ends_at AND slot_end > starts_at), of the blackout's kind (NULL = all kinds). Bookings stay confirmed; nothing is cancelled.
//   If-Match arrives raw as '"<version>"' (key 'if-match'): absent -> 428 common.precondition_required before any DB access; stale -> 409 common.version_conflict, nothing changed; foreign centre / other tenant -> 404.
//   NOT covered (no seam without the real DB): two concurrent overlapping CREATEs (the check-then-insert needs a lock; real-Postgres test), RLS policy text, the S6 blackout exclusion for staff (spec silent).
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { TENANTS } from '../../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { FakeDb, type Call, type Row, type TableDef } from '../../__tests__/fakeSql.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`);
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const A: string = TENANTS.A;
const B: string = TENANTS.B;
const C1 = '01950c16-0000-7000-8000-0000000c0001';
const C2 = '01950c16-0000-7000-8000-0000000c0002';
const CB = '01950c16-0000-7000-8000-0000000c00b1'; // tenant B's centre
const ID = (n: number) => `01950c16-0000-7000-8000-00000000${n.toString(16).padStart(4, '0')}`;
const T1 = ID(0x101), T2 = ID(0x102), T3 = ID(0x103), T_OFF = ID(0x104), T5 = ID(0x105), TB = ID(0x1b1), UNKNOWN = ID(0x777);
const BL1 = ID(0x201), BLB = ID(0x2b1), BL_C2 = ID(0x202);
const NOW = '2026-11-10T04:15:00.000Z'; // Tue 10:00 NPT (UTC+05:45)
const MON = '2026-11-16';                // Monday; 07:00 NPT = 01:15Z
const MANAGE = 'engagement.slot.manage', READ = 'engagement.booking.read';
const SYNC = 'engagement.sync_booking_centres';

// ---------------------------------------------------------------- fixtures
const tpl = (id: string, tenant: string, centre: string, o: Row = {}): Row => ({
  id, tenant_id: tenant, centre_id: centre, booking_kind: 'centre_visit', weekdays: [1, 2, 3, 4, 5], start_local: '07:00:00', end_local: '11:00:00', slot_minutes: 15, capacity: 3,
  effective_from: '2026-01-01', effective_to: null, version: 5, is_active: true, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...o });
const occ = (id: string, centre: string, template: string, start: string, booked: number, o: Row = {}): Row => ({
  id, tenant_id: A, centre_id: centre, booking_kind: 'centre_visit', slot_start: start, slot_end: new Date(Date.parse(start) + 15 * 60_000).toISOString(), template_id: template, capacity: 3, booked,
  version: 2, is_active: true, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...o });
const bk = (n: number, centre: string, occId: string, start: string, o: Row = {}): Row => ({
  id: ID(0x400 + n), tenant_id: A, centre_id: centre, booking_kind: 'centre_visit', slot_occupancy_id: occId, slot_start: start, slot_end: new Date(Date.parse(start) + 15 * 60_000).toISOString(),
  status: 'confirmed', version: 1, created_by: A, updated_by: A, ...o });
const bo = (id: string, tenant: string, centre: string, o: Row = {}): Row => ({
  id, tenant_id: tenant, centre_id: centre, booking_kind: 'centre_visit', starts_at: '2026-12-24T00:00:00.000Z', ends_at: '2026-12-25T00:00:00.000Z', reason_code: 'holiday', note: 'Synthetic closure',
  version: 3, is_active: true, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...o });

const S = (h: string) => `${MON}T${h}:00.000Z`;
const O_A = ID(0x301), O_B = ID(0x302), O_C = ID(0x303), O_D = ID(0x304), O_PAST = ID(0x305), O_H = ID(0x306), O_C2 = ID(0x307);
const seed = (): Record<string, Row[]> => ({
  collection_centres: [{ id: C1, tenant_id: A }, { id: C2, tenant_id: A }, { id: CB, tenant_id: B }],
  slot_templates: [
    tpl(T1, A, C1),                                                                                                                                            // Mon-Fri 07-11, 15 min, cap 3, open-ended
    tpl(T2, A, C1, { booking_kind: 'home_collection', slot_minutes: 30, capacity: 2, version: 1 }),                                                             // other kind, same time
    tpl(T3, A, C2, { version: 2 }),                                                                                                                            // other centre
    tpl(T_OFF, A, C1, { start_local: '14:00:00', end_local: '16:00:00', is_active: false, version: 4 }),                                                       // inactive
    tpl(T5, A, C1, { start_local: '11:00:00', end_local: '13:00:00', slot_minutes: 30, capacity: 2, version: 2 }),                                              // adjacent to T1
    tpl(TB, B, CB, { version: 7 }),                                                                                                                            // tenant B
  ],
  slot_blackouts: [bo(BL1, A, C1), bo(BL_C2, A, C2, { version: 1 }), bo(BLB, B, CB, { version: 1 }), bo(ID(0x203), A, C1, { is_active: false, version: 4 })],
  slot_occupancy: [
    occ(O_A, C1, T1, S('01:15'), 3), occ(O_B, C1, T1, S('01:30'), 2), occ(O_C, C1, T1, S('01:45'), 1), occ(O_D, C1, T1, S('02:00'), 1),
    occ(O_PAST, C1, T1, '2026-11-09T01:15:00.000Z', 3),                                                                                                         // past Monday: never counted
    occ(O_H, C1, T2, S('01:15'), 1, { booking_kind: 'home_collection', slot_end: S('01:45'), capacity: 2 }), occ(O_C2, C2, T3, S('01:30'), 1),
  ],
  bookings: [
    bk(1, C1, O_A, S('01:15')), bk(2, C1, O_A, S('01:15')), bk(10, C1, O_A, S('01:15')), bk(3, C1, O_A, S('01:15'), { status: 'cancelled' }),
    bk(4, C1, O_B, S('01:30')), bk(11, C1, O_B, S('01:30')), bk(5, C1, O_C, S('01:45')), bk(9, C1, O_D, S('02:00')),
    bk(6, C1, O_PAST, '2026-11-09T01:15:00.000Z'),
    bk(8, C1, O_H, S('01:15'), { booking_kind: 'home_collection', slot_end: S('01:45') }), bk(7, C2, O_C2, S('01:30')),
  ],
});

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]/;
const defs = (clock: { iso: string }): Record<string, TableDef> => ({
  collection_centres: { columns: ['id', 'tenant_id'] },
  slot_templates: {
    columns: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'weekdays', 'start_local', 'end_local', 'slot_minutes', 'capacity', 'effective_from', 'effective_to', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    notNull: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'weekdays', 'start_local', 'end_local', 'slot_minutes', 'capacity', 'effective_from', 'created_by', 'updated_by'],
    defaults: { version: 1, is_active: true, created_at: clock.iso, updated_at: clock.iso }, unique: [['tenant_id', 'id']],
    fk: [{ cols: ['tenant_id', 'centre_id'], ref: 'collection_centres', refCols: ['tenant_id', 'id'] }],
    check: (r) => !['centre_visit', 'home_collection'].includes(r['booking_kind']) ? 'slot_templates__kind__ck'
      : !(Array.isArray(r['weekdays']) && r['weekdays'].length >= 1 && r['weekdays'].length <= 7 && r['weekdays'].every((d: number) => Number.isInteger(d) && d >= 1 && d <= 7)) ? 'slot_templates__weekdays__ck'
      : !(TIME.test(r['start_local']) && TIME.test(r['end_local']) && r['end_local'] > r['start_local']) ? 'slot_templates__times__ck'
      : !(r['slot_minutes'] >= 5 && r['slot_minutes'] <= 240 && r['slot_minutes'] % 5 === 0) ? 'slot_templates__minutes__ck'
      : !(r['capacity'] >= 1 && r['capacity'] <= 100) ? 'slot_templates__capacity__ck'
      : r['effective_to'] != null && r['effective_to'] < r['effective_from'] ? 'slot_templates__dates__ck' : undefined,
  },
  slot_blackouts: {
    columns: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'starts_at', 'ends_at', 'reason_code', 'note', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    notNull: ['id', 'tenant_id', 'centre_id', 'starts_at', 'ends_at', 'reason_code', 'created_by', 'updated_by'], defaults: { version: 1, is_active: true, created_at: clock.iso, updated_at: clock.iso },
    fk: [{ cols: ['tenant_id', 'centre_id'], ref: 'collection_centres', refCols: ['tenant_id', 'id'] }],
    check: (r) => r['booking_kind'] != null && !['centre_visit', 'home_collection'].includes(r['booking_kind']) ? 'slot_blackouts__kind__ck'
      : !(new Date(r['ends_at']) > new Date(r['starts_at']) && +new Date(r['ends_at']) <= +new Date(r['starts_at']) + 31 * 86_400_000) ? 'slot_blackouts__range__ck'
      : !['holiday', 'maintenance', 'other'].includes(r['reason_code']) ? 'slot_blackouts__reason__ck'
      : r['note'] != null && String(r['note']).length > 200 ? 'slot_blackouts__note__ck' : undefined,
  },
  slot_occupancy: { columns: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'slot_start', 'slot_end', 'template_id', 'capacity', 'booked', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'] },
  bookings: { columns: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'slot_occupancy_id', 'slot_start', 'slot_end', 'status', 'version', 'created_by', 'updated_by'] },
});

// ---------------------------------------------------------------- harness
const verb = (c: Call) => /^\s*(select|insert|update|delete)\b/i.exec(c.text)?.[1]?.toLowerCase();
const isEnqueue = (c: Call) => /app\.enqueue_job/i.test(c.text);
const dml = (calls: Call[]) => calls.filter((c) => ['insert', 'update', 'delete'].includes(verb(c) ?? ''));
const enqueues = (calls: Call[]) => calls.filter(isEnqueue);
const touches = (calls: Call[], table: string) => dml(calls).filter((c) => new RegExp(`engagement\\.${table}\\b`, 'i').test(c.text));

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
const FRONT_DESK_C1: Who = { grants: [READ], centres: [C1] };
const MANAGER_C1: Who = { grants: [READ, MANAGE], centres: [C1] };
const MANAGER_ALL: Who = { grants: [READ, MANAGE], centres: [], all: true };

const ctxFor = makeCtxFor();
const ACTOR: string = (ctxFor('A', {}) as any).actor.id; // the staff user of every request below (ctx.actor.id)
const newDb = (session = A, who: Who = MANAGER_ALL, rows = seed()) => {
  const clock = { iso: NOW }; const db = new FakeDb(rows, defs(clock), clock);
  return { db, s: db.session(session, { all: Boolean(who.all), centres: who.centres }, A) };
};
type World = ReturnType<typeof newDb>;
const run = async (op: string, o: { params?: object; query?: object; headers?: object; body?: unknown }, who: Who, opts: { session?: string; world?: World; noTx?: boolean } = {}) => {
  const session = opts.session ?? A;
  const w = opts.world ?? newDb(session, who);
  const id = identity(who);
  const ctx = { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    ...ctxFor(session === B ? 'B' : 'A', { tx: w.s.tx as never, now: () => NOW, ports: { IdentityPort: id } as never }) } as never;
  if (opts.noTx) (ctx as any).tx = undefined;
  const r = { params: {}, query: {}, headers: {}, body: undefined, ...o } as never;
  let out: any, error: any;
  try { out = await (handlers as any)[op](r, ctx); } catch (e) { error = e; }
  return { out, error, db: w.db, calls: w.db.calls, id, rows: w.db.tables };
};
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
const snapshot = (db: FakeDb) => JSON.stringify(db.tables);
const paths = (e: any): string[] => (e?.errors ?? []).map((x: any) => x.path);
const expectInvalid = (e: any) => { expect(e?.code).toBe('common.validation_failed'); };

const BODY = { centre_id: C1, booking_kind: 'centre_visit', weekdays: [1, 2, 3, 4, 5], start_local: '14:00', end_local: '18:00', slot_minutes: 30, capacity: 4, effective_from: '2026-01-01' };
const T1_BODY = { centre_id: C1, booking_kind: 'centre_visit', weekdays: [1, 2, 3, 4, 5], start_local: '07:00', end_local: '11:00', slot_minutes: 15, capacity: 3, effective_from: '2026-01-01' };
const BL_BODY = { centre_id: C1, booking_kind: 'centre_visit', starts_at: S('01:30'), ends_at: S('02:00'), reason_code: 'maintenance', note: 'Synthetic: analyser service' };

// ---------------------------------------------------------------- contract
describe('contract: floors, idempotency, shapes match 02-TRD §5 S6-S11', () => {
  it('x-permission floors: S6 booking.read, S7-S11 slot.manage', () => {
    expect(opOf('getSlotAvailability')['x-permission']).toBe(READ);
    for (const op of ['listSlotTemplates', 'createSlotTemplate', 'updateSlotTemplate', 'deactivateSlotTemplate', 'listSlotBlackouts', 'createSlotBlackout', 'deactivateSlotBlackout']) expect(opOf(op)['x-permission']).toBe(MANAGE);
  });
  it('permissions.yaml: slot.manage = tenant_admin, lab_manager only (front desk can read availability, never edit templates)', async () => {
    const { readFileSync } = await import('node:fs');
    const perms = readFileSync(join(REPO_ROOT, 'contracts/permissions.yaml'), 'utf8') as string;
    expect(perms).toMatch(/code:\s*engagement\.slot\.manage,\s*privileged:\s*false,\s*roles:\s*\[tenant_admin,\s*lab_manager\]/);
  });
  it('creates require an Idempotency-Key (P-8), updates/deactivates optional, lists none', () => {
    for (const op of ['createSlotTemplate', 'createSlotBlackout']) expect(opOf(op)['x-idempotency']).toBe('required');
    for (const op of ['updateSlotTemplate', 'deactivateSlotTemplate', 'deactivateSlotBlackout']) { expect(opOf(op)['x-idempotency']).toBe('optional'); expect(opOf(op)['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required', 'common.not_found'])); }
    for (const op of ['getSlotAvailability', 'listSlotTemplates', 'listSlotBlackouts']) expect(opOf(op)['x-idempotency']).toBe('none');
  });
});

// ---------------------------------------------------------------- US-EN-16.1 validation
describe('US-EN-16.1 template validation -> 400 common.validation_failed, zero writes, no enqueue', () => {
  const invalid: Record<string, unknown> = {
    'end_local = start_local': { ...BODY, end_local: '14:00' },
    'end_local < start_local': { ...BODY, start_local: '18:00', end_local: '14:00' },
    'slot_minutes 4': { ...BODY, slot_minutes: 4 }, 'slot_minutes 241': { ...BODY, slot_minutes: 241 }, 'slot_minutes 0': { ...BODY, slot_minutes: 0 },
    'slot_minutes not a multiple of 5': { ...BODY, slot_minutes: 7 }, 'slot_minutes a string': { ...BODY, slot_minutes: '30' }, 'slot_minutes fractional': { ...BODY, slot_minutes: 12.5 },
    'capacity 0': { ...BODY, capacity: 0 }, 'capacity 101': { ...BODY, capacity: 101 }, 'capacity negative': { ...BODY, capacity: -1 }, 'capacity fractional': { ...BODY, capacity: 2.5 },
    'weekdays empty': { ...BODY, weekdays: [] }, 'weekday 0': { ...BODY, weekdays: [0] }, 'weekday 8': { ...BODY, weekdays: [8] }, 'weekdays duplicate': { ...BODY, weekdays: [1, 1] },
    'weekdays not an array': { ...BODY, weekdays: 1 }, 'weekday a string': { ...BODY, weekdays: ['1'] },
    'start_local 7:00': { ...BODY, start_local: '7:00' }, 'start_local 24:00': { ...BODY, start_local: '24:00' }, 'start_local 07:60': { ...BODY, start_local: '07:60' }, 'end_local with seconds': { ...BODY, end_local: '18:00:00' },
    'booking_kind unknown': { ...BODY, booking_kind: 'x' }, 'booking_kind missing': (({ booking_kind: _k, ...r }) => r)(BODY),
    'effective_to before effective_from': { ...BODY, effective_to: '2025-12-31' }, 'effective_from not a date': { ...BODY, effective_from: '2026-13-01' }, 'effective_from missing': (({ effective_from: _f, ...r }) => r)(BODY),
    'centre_id not a uuid': { ...BODY, centre_id: 'nope' }, 'centre_id missing': (({ centre_id: _c, ...r }) => r)(BODY),
    'extra tenant_id (mass assignment)': { ...BODY, tenant_id: B }, 'extra version': { ...BODY, version: 9 }, 'extra id': { ...BODY, id: UNKNOWN }, 'extra is_active': { ...BODY, is_active: false },
    'body is an array': [BODY], 'body missing': undefined,
  };
  for (const [name, body] of Object.entries(invalid)) {
    it(`create: ${name}`, async () => {
      const r = await run('createSlotTemplate', { body }, MANAGER_ALL);
      expectInvalid(r.error); expect(dml(r.calls)).toEqual([]); expect(enqueues(r.calls)).toEqual([]);
    });
  }
  it('update: the same invalid bodies are refused with the stored row unchanged and no enqueue', async () => {
    for (const body of Object.values(invalid)) {
      const w = newDb(); const before = snapshot(w.db);
      const r = await run('updateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5), body }, MANAGER_ALL, { world: w });
      expectInvalid(r.error); expect(snapshot(w.db)).toBe(before); expect(enqueues(r.calls)).toEqual([]);
    }
  });
  it('error details never echo submitted values (REQ-SEC-080)', async () => {
    const canary = 'CANARY-7f3a-do-not-echo';
    for (const body of [{ ...BODY, booking_kind: canary }, { ...BODY, start_local: canary }, { ...BODY, weekdays: [canary] }]) {
      const r = await run('createSlotTemplate', { body }, MANAGER_ALL);
      expectInvalid(r.error); expect(JSON.stringify({ m: r.error.message, d: r.error.detail, e: r.error.errors })).not.toContain(canary);
    }
  });
  it('boundaries are valid: slot_minutes 5 and 240, capacity 1 and 100 -> 201', async () => {
    for (const over of [{ slot_minutes: 5 }, { slot_minutes: 240 }, { capacity: 1 }, { capacity: 100 }]) {
      const r = await run('createSlotTemplate', { body: { ...BODY, ...over } }, MANAGER_ALL);
      expect(r.error, JSON.stringify(over)).toBeUndefined(); expect(r.out.status).toBe(201);
    }
  });
  it('valid create: 201 + SlotTemplate shape; tenant/actor from ctx; local wall-clock stored as given (no UTC conversion); effective_to omitted when NULL', async () => {
    const r = await run('createSlotTemplate', { body: { ...BODY, effective_to: '2026-12-31' } }, MANAGER_ALL);
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201);
    expect(schemaErrors('SlotTemplate', r.out.body)).toEqual([]);
    expect(r.out.body).toMatchObject({ centre_id: C1, booking_kind: 'centre_visit', weekdays: [1, 2, 3, 4, 5], start_local: '14:00', end_local: '18:00', slot_minutes: 30, capacity: 4, effective_from: '2026-01-01', effective_to: '2026-12-31', is_active: true, version: 1 });
    const row = (r.rows['slot_templates'] as Row[]).find((x) => x['id'] === r.out.body.id)!;
    expect(row).toMatchObject({ tenant_id: A, created_by: ACTOR, updated_by: ACTOR, version: 1, is_active: true });
    expect(String(row['start_local'])).toMatch(/^14:00/); expect(String(row['end_local'])).toMatch(/^18:00/); // 08:15Z / 12:15Z would mean a UTC conversion
    expect(JSON.stringify(r.out.body)).not.toMatch(/tenant_id|created_by|updated_by|created_at/);
    const open = await run('createSlotTemplate', { body: BODY }, MANAGER_ALL); expect(schemaErrors('SlotTemplate', open.out.body)).toEqual([]); expect(open.out.body.effective_to ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------- US-EN-16.2 overlap
describe('US-EN-16.2 overlapping active templates of the same centre and kind -> 400 at /start_local', () => {
  const overlapping: Record<string, object> = {
    'same weekdays, 10:00-12:00 (overlaps T1 and T5)': { start_local: '10:00', end_local: '12:00' },
    'starts before, ends inside: 06:00-07:15': { start_local: '06:00', end_local: '07:15' },
    'fully inside: 08:00-09:00': { start_local: '08:00', end_local: '09:00' },
    'contains T1: 06:00-12:00': { start_local: '06:00', end_local: '12:00' },
    'identical: 07:00-11:00': { start_local: '07:00', end_local: '11:00' },
    'one shared weekday only (Friday): [5,6,7] 08:00-09:00': { weekdays: [5, 6, 7], start_local: '08:00', end_local: '09:00' },
  };
  for (const [name, over] of Object.entries(overlapping)) {
    it(`create: ${name}`, async () => {
      const r = await run('createSlotTemplate', { body: { ...BODY, ...over } }, MANAGER_ALL);
      expectInvalid(r.error); expect(paths(r.error)).toContain('/start_local');
      expect(dml(r.calls)).toEqual([]); expect(enqueues(r.calls)).toEqual([]);
    });
  }
  const fine: Record<string, object> = {
    'adjacent after T5 (13:00-14:00; edges exclusive)': { start_local: '13:00', end_local: '14:00' },
    'adjacent before T1 (03:00-07:00)': { start_local: '03:00', end_local: '07:00' },
    'same time, disjoint weekdays [6,7]': { weekdays: [6, 7], start_local: '07:00', end_local: '11:00' },
    'other booking kind (home_collection) at 14:00-16:00; T2 (07-11) does not conflict': { booking_kind: 'home_collection', start_local: '14:00', end_local: '16:00' },
    'overlaps only the INACTIVE template (14:00-15:00)': { start_local: '14:00', end_local: '15:00' },
  };
  for (const [name, over] of Object.entries(fine)) {
    it(`create: ${name} -> 201`, async () => {
      const r = await run('createSlotTemplate', { body: { ...BODY, ...over } }, MANAGER_ALL);
      expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201);
    });
  }
  it('same time at another centre (C2 already has T3 at 07-11 for the same kind) is its own scope: C1 body at 14:00 is fine, a C2 body at 07-11 overlaps T3', async () => {
    const bad = await run('createSlotTemplate', { body: { ...BODY, centre_id: C2, start_local: '07:00', end_local: '11:00' } }, MANAGER_ALL); expectInvalid(bad.error);
    const ok = await run('createSlotTemplate', { body: { ...BODY, centre_id: C2, start_local: '12:00', end_local: '13:00' } }, MANAGER_ALL); expect(ok.out.status).toBe(201);
  });
  it('tenant B has an identical template at its own centre: it never blocks tenant A and tenant A never blocks tenant B', async () => {
    const b = await run('createSlotTemplate', { body: { ...T1_BODY, centre_id: CB, start_local: '08:00', end_local: '09:00' } }, { grants: [MANAGE], centres: [], all: true }, { session: B });
    expectInvalid(b.error); // overlaps TB (B's own 07-11)
    const a = await run('createSlotTemplate', { body: { ...BODY } }, MANAGER_ALL); expect(a.out.status).toBe(201);
  });
  const dated = () => { const w = newDb(); (w.db.tables['slot_templates'] as Row[]).push(tpl(ID(0x110), A, C1, { weekdays: [6, 7], start_local: '12:00:00', end_local: '14:00:00', effective_from: '2026-01-01', effective_to: '2026-12-31', version: 1 })); return w; };
  const weekend = { weekdays: [6, 7], start_local: '12:00', end_local: '14:00' };
  for (const [name, over, ok] of [
    ['effective range starts the day after the other ends (2027-01-01)', { effective_from: '2027-01-01' }, true],
    ['effective range ends the day before the other starts (2025-12-31)', { effective_from: '2025-01-01', effective_to: '2025-12-31' }, true],
    ['effective_from on the other\'s last day (2026-12-31; end is inclusive)', { effective_from: '2026-12-31' }, false],
    ['range inside the other (2026-06-01..2026-06-30)', { effective_from: '2026-06-01', effective_to: '2026-06-30' }, false],
    ['open-ended range starting earlier (effective_to NULL)', { effective_from: '2025-06-01' }, false],
  ] as const) {
    it(`date ranges: ${name} -> ${ok ? '201' : '400 /start_local'}`, async () => {
      const r = await run('createSlotTemplate', { body: { ...BODY, ...weekend, ...over } }, MANAGER_ALL, { world: dated() });
      if (ok) { expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201); } else { expectInvalid(r.error); expect(paths(r.error)).toContain('/start_local'); }
    });
  }
  it('update: saving T1 again with other capacity is fine (a template never overlaps itself); moving T5 into T1 is refused at /start_local; moving it to 13:00 is fine', async () => {
    const self = await run('updateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5), body: { ...T1_BODY, capacity: 2 } }, MANAGER_ALL);
    expect(self.error).toBeUndefined(); expect(self.out.status).toBe(200);
    const w = newDb(); const before = snapshot(w.db);
    const bad = await run('updateSlotTemplate', { params: { template_id: T5 }, headers: ifm(2), body: { ...T1_BODY, start_local: '10:00', end_local: '13:00', slot_minutes: 30, capacity: 2 } }, MANAGER_ALL, { world: w });
    expectInvalid(bad.error); expect(paths(bad.error)).toContain('/start_local'); expect(snapshot(w.db)).toBe(before); expect(enqueues(bad.calls)).toEqual([]);
    const ok = await run('updateSlotTemplate', { params: { template_id: T5 }, headers: ifm(2), body: { ...T1_BODY, start_local: '13:00', end_local: '14:00', slot_minutes: 30, capacity: 2 } }, MANAGER_ALL);
    expect(ok.out.status).toBe(200);
  });
});

// ---------------------------------------------------------------- update / deactivate mechanics
describe('S9 updateSlotTemplate / S10 deactivateSlotTemplate: If-Match, 404 scope, response shapes', () => {
  it('S9 200: SlotTemplateUpdated shape, version+1, updated_by actor, tenant and centre unchanged', async () => {
    const r = await run('updateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5), body: { ...T1_BODY, slot_minutes: 30 } }, MANAGER_ALL);
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200);
    expect(schemaErrors('SlotTemplateUpdated', r.out.body)).toEqual([]);
    expect(r.out.body).toMatchObject({ id: T1, slot_minutes: 30, version: 6, centre_id: C1 });
    expect(r.out.body.affected).toEqual({ overbooked_slots: 0 });
    expect((r.rows['slot_templates'] as Row[]).find((x) => x['id'] === T1)).toMatchObject({ tenant_id: A, version: 6, updated_by: ACTOR, centre_id: C1 });
  });
  it('S9/S10 If-Match: absent -> 428 with zero DB access; stale -> 409 and nothing changed (no enqueue); malformed -> 400', async () => {
    for (const [op, body] of [['updateSlotTemplate', T1_BODY], ['deactivateSlotTemplate', undefined]] as const) {
      const none = await run(op, { params: { template_id: T1 }, body }, MANAGER_ALL); expect(none.error?.code).toBe('common.precondition_required'); expect(none.calls).toEqual([]);
      const w = newDb(); const before = snapshot(w.db);
      const stale = await run(op, { params: { template_id: T1 }, headers: ifm(4), body }, MANAGER_ALL, { world: w });
      expect(stale.error?.code).toBe('common.version_conflict'); expect(snapshot(w.db)).toBe(before); expect(enqueues(stale.calls)).toEqual([]);
      for (const bad of ['5', 'abc', '"0"', '"-1"']) { const r = await run(op, { params: { template_id: T1 }, headers: ifm(bad), body }, MANAGER_ALL); expectInvalid(r.error); }
    }
  });
  it('S9: the body cannot move a template to another centre (a row never changes centre)', async () => {
    const w = newDb(); const before = snapshot(w.db);
    const r = await run('updateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5), body: { ...T1_BODY, centre_id: C2 } }, MANAGER_ALL, { world: w });
    expect(['common.validation_failed', 'auth.forbidden', 'common.not_found']).toContain(r.error?.code); expect(snapshot(w.db)).toBe(before);
  });
  it('S9/S10: unknown id and malformed id -> 404 / 400, nothing written', async () => {
    const nf = await run('updateSlotTemplate', { params: { template_id: UNKNOWN }, headers: ifm(5), body: T1_BODY }, MANAGER_ALL); expect(nf.error?.code).toBe('common.not_found'); expect(dml(nf.calls)).toEqual([]);
    const nf2 = await run('deactivateSlotTemplate', { params: { template_id: UNKNOWN }, headers: ifm(5) }, MANAGER_ALL); expect(nf2.error?.code).toBe('common.not_found');
    const bad = await run('deactivateSlotTemplate', { params: { template_id: 'nope' }, headers: ifm(5) }, MANAGER_ALL); expectInvalid(bad.error);
  });
  it('S10 200: SlotTemplateDeactivated shape, is_active=false, version+1, row kept (no DELETE), its slots disappear from S6', async () => {
    const w = newDb();
    const r = await run('deactivateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5) }, MANAGER_ALL, { world: w });
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200);
    expect(schemaErrors('SlotTemplateDeactivated', r.out.body)).toEqual([]);
    expect(r.out.body).toMatchObject({ id: T1, is_active: false, version: 6 });
    expect((w.db.tables['slot_templates'] as Row[]).find((x) => x['id'] === T1)).toMatchObject({ is_active: false, version: 6, updated_by: ACTOR });
    expect(r.calls.some((c) => verb(c) === 'delete')).toBe(false);
    const s6 = await run('getSlotAvailability', { query: { centre_id: C1, booking_kind: 'centre_visit', date_from: MON, date_to: MON } }, MANAGER_ALL, { world: w });
    expect(s6.out.body.data.filter((x: any) => x.slot_start < S('05:15'))).toEqual([]); // no 07:00-11:00 NPT slots left (T5 starts 11:00 NPT = 05:15Z and stays)
  });
  it('S10 affected.future_bookings = confirmed FUTURE bookings on that template\'s slots (cancelled, past, other templates, other centres excluded); bookings stay confirmed', async () => {
    const w = newDb(); const bookingsBefore = JSON.stringify(w.db.tables['bookings']); const occBefore = JSON.stringify(w.db.tables['slot_occupancy']);
    const r = await run('deactivateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5) }, MANAGER_ALL, { world: w });
    expect(r.out.body.affected).toEqual({ future_bookings: 7 }); // O_A 3 + O_B 2 + O_C 1 + O_D 1
    expect(JSON.stringify(w.db.tables['bookings'])).toBe(bookingsBefore); expect(JSON.stringify(w.db.tables['slot_occupancy'])).toBe(occBefore);
    expect(touches(r.calls, 'bookings')).toEqual([]); expect(touches(r.calls, 'slot_occupancy')).toEqual([]);
    const t2 = await run('deactivateSlotTemplate', { params: { template_id: T2 }, headers: ifm(1) }, MANAGER_ALL); expect(t2.out.body.affected).toEqual({ future_bookings: 1 });
    const t5 = await run('deactivateSlotTemplate', { params: { template_id: T5 }, headers: ifm(2) }, MANAGER_ALL); expect(t5.out.body.affected).toEqual({ future_bookings: 0 });
  });
});

// ---------------------------------------------------------------- US-EN-16.3 capacity reduction
describe('US-EN-16.3 capacity reduction below booked counts: save succeeds, slots flagged overbooked, nobody is cancelled', () => {
  const put = (capacity: number, w?: World) => run('updateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5), body: { ...T1_BODY, capacity } }, MANAGER_ALL, w ? { world: w } : {});
  it('capacity 3 -> 2: 200, affected.overbooked_slots = 1 (only the 3-booked future slot; the past Monday with 3 is not counted)', async () => {
    const r = await put(2); expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200); expect(r.out.body).toMatchObject({ capacity: 2, version: 6 }); expect(r.out.body.affected).toEqual({ overbooked_slots: 1 });
  });
  it('capacity 3 -> 1: 2 overbooked slots (booked 3 and 2); 3 -> 3 and 3 -> 4: none', async () => {
    expect((await put(1)).out.body.affected).toEqual({ overbooked_slots: 2 });
    expect((await put(3)).out.body.affected).toEqual({ overbooked_slots: 0 });
    expect((await put(4)).out.body.affected).toEqual({ overbooked_slots: 0 });
  });
  it('no booking is touched: no write to engagement.bookings, every booking row identical, statuses still confirmed/cancelled as seeded', async () => {
    const w = newDb(); const before = JSON.stringify(w.db.tables['bookings']);
    const r = await put(1, w);
    expect(touches(r.calls, 'bookings')).toEqual([]); expect(JSON.stringify(w.db.tables['bookings'])).toBe(before);
    expect((w.db.tables['bookings'] as Row[]).filter((b) => b['status'] === 'confirmed').length).toBe(10);
  });
  it('review T-B2 #1: S9 capacity change reaches slot_occupancy.capacity of the template\'s FUTURE rows (reserve path uses it); past row, other template and other centre rows unchanged; booked untouched', async () => {
    const w = newDb(); const occ = () => w.db.tables['slot_occupancy'] as Row[]; const cap = (id: string) => occ().find((x) => x['id'] === id)!['capacity'];
    const bookedBefore = occ().map((x) => x['booked']);
    await put(2, w);
    for (const id of [O_A, O_B, O_C, O_D]) expect(cap(id), id).toBe(2);
    expect(cap(O_PAST)).toBe(3); expect(cap(O_H)).toBe(2); expect(cap(O_C2)).toBe(3);
    expect(occ().map((x) => x['booked'])).toEqual(bookedBefore);
  });
  it('S6 shows the flag with the CURRENT capacity: before, the full slot is booked=3 of 3 (not overbooked); after 3 -> 2 it is capacity 2, booked 3, overbooked true, remaining 0; the 2-booked slot is full but not overbooked', async () => {
    const w = newDb(); const q = { query: { centre_id: C1, booking_kind: 'centre_visit', date_from: MON, date_to: MON } };
    const slot = (res: any, h: string) => res.out.body.data.find((x: any) => x.slot_start === S(h));
    const before = await run('getSlotAvailability', q, MANAGER_ALL, { world: w });
    expect(slot(before, '01:15')).toMatchObject({ capacity: 3, booked: 3, remaining: 0, overbooked: false });
    await put(2, w);
    const after = await run('getSlotAvailability', q, MANAGER_ALL, { world: w });
    expect(slot(after, '01:15')).toMatchObject({ capacity: 2, booked: 3, remaining: 0, overbooked: true });
    expect(slot(after, '01:30')).toMatchObject({ capacity: 2, booked: 2, remaining: 0, overbooked: false });
    expect(slot(after, '01:45')).toMatchObject({ capacity: 2, booked: 1, remaining: 1, overbooked: false });
    expect(slot(after, '03:00')).toMatchObject({ capacity: 2, booked: 0, remaining: 2, overbooked: false }); // no occupancy row: template capacity
  });
});

// ---------------------------------------------------------------- S6
describe('S6 getSlotAvailability (staff): Asia/Kathmandu timezone fixture', () => {
  const q = (o: object = {}) => ({ query: { centre_id: C1, booking_kind: 'centre_visit', date_from: MON, date_to: MON, ...o } });
  it('Mon 07:00-11:00 NPT in 15-minute slots = 16 slots (+4 of the adjacent T5), UTC 01:15Z .. 05:00Z (last slot ends 05:15Z = 11:00 NPT), ascending, StaffSlot-shaped', async () => {
    const r = await run('getSlotAvailability', q(), FRONT_DESK_C1);
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200);
    const d = r.out.body.data;
    expect(d).toHaveLength(20); // T1: 16 slots of 15 min; T5 (11:00-13:00 NPT, 30 min): 4 more, merged in start order
    expect(d[0]).toMatchObject({ slot_start: '2026-11-16T01:15:00.000Z', slot_end: '2026-11-16T01:30:00.000Z', centre_id: C1, booking_kind: 'centre_visit' });
    expect(d[15]).toMatchObject({ slot_start: '2026-11-16T05:00:00.000Z', slot_end: '2026-11-16T05:15:00.000Z' });
    expect(d[16]).toMatchObject({ slot_start: '2026-11-16T05:15:00.000Z', slot_end: '2026-11-16T05:45:00.000Z', capacity: 2 });
    expect(d.map((x: any) => x.slot_start)).toEqual([...d.map((x: any) => x.slot_start)].sort());
    for (const s of d) expect(schemaErrors('StaffSlot', s)).toEqual([]);
    expect(r.id.calls[0]).toMatchObject({ permission: READ, centreId: C1 });
  });
  it('a slot with no occupancy row shows the template capacity and booked 0; weekend dates give nothing (Mon-Fri template)', async () => {
    const d = (await run('getSlotAvailability', q({ date_from: '2026-11-14', date_to: '2026-11-16' }), FRONT_DESK_C1)).out.body.data;
    expect(d).toHaveLength(20); expect(d.find((x: any) => x.slot_start === S('03:00'))).toMatchObject({ capacity: 3, booked: 0, remaining: 3, overbooked: false });
    expect((await run('getSlotAvailability', q({ date_from: '2026-11-14', date_to: '2026-11-15' }), FRONT_DESK_C1)).out.body.data).toEqual([]);
  });
  it('the day is the LOCAL day: a 00:00-01:00 NPT template on Monday starts at 2026-11-15T18:15Z (Sunday in UTC)', async () => {
    const w = newDb(); (w.db.tables['slot_templates'] as Row[]).push(tpl(ID(0x120), A, C1, { start_local: '00:00:00', end_local: '01:00:00', slot_minutes: 30, version: 1 }));
    const d = (await run('getSlotAvailability', q(), FRONT_DESK_C1, { world: w })).out.body.data.map((x: any) => x.slot_start);
    expect(d.slice(0, 2)).toEqual(['2026-11-15T18:15:00.000Z', '2026-11-15T18:45:00.000Z']);
    expect(d).toHaveLength(22);
  });
  it('kind filter: home_collection 07-11 in 30-minute slots = 8 slots of capacity 2; inactive templates and other centres/tenants contribute nothing (no 14:00-16:00 slots)', async () => {
    const hc = (await run('getSlotAvailability', q({ booking_kind: 'home_collection' }), FRONT_DESK_C1)).out.body.data;
    expect(hc).toHaveLength(8); expect(hc.every((x: any) => x.capacity === 2 && x.booking_kind === 'home_collection')).toBe(true);
    expect(hc.find((x: any) => x.slot_start === S('01:15'))).toMatchObject({ booked: 1, remaining: 1 });
    const cv = (await run('getSlotAvailability', q(), FRONT_DESK_C1)).out.body.data;
    expect(cv.some((x: any) => x.slot_start >= S('08:15') && x.slot_start < S('10:15'))).toBe(false); // T_OFF 14:00-16:00 NPT would be 08:15Z-10:15Z
    expect(cv.every((x: any) => x.centre_id === C1)).toBe(true);
  });
  it('validation: missing/invalid centre_id, booking_kind, dates; date_to before date_from; range over 14 days -> 400, no DB', async () => {
    for (const bad of [{ centre_id: undefined }, { centre_id: 'x' }, { booking_kind: undefined }, { booking_kind: 'x' }, { date_from: undefined }, { date_from: '2026-13-01' }, { date_to: 'tomorrow' }, { date_from: '2026-11-17', date_to: '2026-11-16' }, { date_from: '2026-11-01', date_to: '2026-12-01' }]) {
      const r = await run('getSlotAvailability', q(bad), FRONT_DESK_C1); expectInvalid(r.error); expect(r.calls).toEqual([]);
    }
  });
  it('a 14-day range is allowed and capped at maxItems 2000', async () => {
    const r = await run('getSlotAvailability', q({ date_from: MON, date_to: '2026-11-29' }), FRONT_DESK_C1);
    expect(r.error).toBeUndefined(); expect(r.out.body.data.length).toBeLessThanOrEqual(2000); expect(r.out.body.data.length).toBe(20 * 10);
  });
});

// ---------------------------------------------------------------- US-EN-16.4 blackouts
describe('US-EN-16.4 blackout over existing bookings: response lists the affected count, bookings stay confirmed', () => {
  const post = (body: object, who: Who = MANAGER_ALL, w?: World) => run('createSlotBlackout', { body }, who, w ? { world: w } : {});
  it('centre_visit blackout [01:30Z, 02:00Z): slots 01:30 and 01:45 -> 3 confirmed bookings; the slot ending exactly at starts_at and the slot starting exactly at ends_at are NOT affected', async () => {
    const w = newDb(); const before = JSON.stringify(w.db.tables['bookings']);
    const r = await post(BL_BODY, MANAGER_ALL, w);
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201);
    expect(schemaErrors('SlotBlackoutResult', r.out.body)).toEqual([]);
    expect(r.out.body).toMatchObject({ centre_id: C1, booking_kind: 'centre_visit', starts_at: S('01:30'), ends_at: S('02:00'), reason_code: 'maintenance', is_active: true, version: 1 });
    expect(r.out.body.affected).toEqual({ future_bookings: 3 }); // O_B 2 + O_C 1
    expect(JSON.stringify(w.db.tables['bookings'])).toBe(before); expect(touches(r.calls, 'bookings')).toEqual([]); expect(touches(r.calls, 'slot_occupancy')).toEqual([]);
    expect((w.db.tables['bookings'] as Row[]).filter((b) => b['status'] === 'cancelled').length).toBe(1);
  });
  it('partial overlap counts (starts 01:20Z, ends 01:40Z touches the 01:15 and 01:30 slots = 5); kind omitted (all kinds) adds the home_collection booking; another centre\'s bookings never count', async () => {
    expect((await post({ ...BL_BODY, starts_at: S('01:20'), ends_at: S('01:40') })).out.body.affected).toEqual({ future_bookings: 5 });
    const all = (({ booking_kind: _k, ...r }) => r)(BL_BODY); const r = await post(all); expect(r.error).toBeUndefined();
    expect(r.out.body.affected).toEqual({ future_bookings: 4 }); expect(schemaErrors('SlotBlackoutResult', r.out.body)).toEqual([]);
    expect((await post({ ...BL_BODY, centre_id: C2 })).out.body.affected).toEqual({ future_bookings: 1 });
  });
  it('past bookings and cancelled bookings are never "affected" (blackout over the past Monday = 0)', async () => {
    const r = await post({ ...BL_BODY, starts_at: '2026-11-09T00:00:00.000Z', ends_at: '2026-11-09T06:00:00.000Z' }); expect(r.error).toBeUndefined(); expect(r.out.body.affected).toEqual({ future_bookings: 0 });
  });
  it('row stored with tenant/actor from ctx, kind NULL when omitted; the blackout does not enqueue a centre sync (TRD: S8/S9/S10 only)', async () => {
    const w = newDb(); const r = await post((({ booking_kind: _k, ...x }) => x)(BL_BODY), MANAGER_ALL, w);
    const row = (w.db.tables['slot_blackouts'] as Row[]).find((x) => x['id'] === r.out.body.id)!;
    expect(row).toMatchObject({ tenant_id: A, created_by: ACTOR, version: 1, is_active: true }); expect(row['booking_kind'] ?? null).toBeNull();
    expect(enqueues(r.calls)).toEqual([]);
  });
  const bad: Record<string, object> = {
    'ends_at = starts_at': { ends_at: S('01:30') }, 'ends_at before starts_at': { starts_at: S('02:00'), ends_at: S('01:30') },
    'range 31 days + 1 ms': { starts_at: '2026-12-01T00:00:00.000Z', ends_at: '2027-01-01T00:00:00.001Z' },
    'reason_code unknown': { reason_code: 'weather' }, 'reason_code missing': { reason_code: undefined }, 'booking_kind unknown': { booking_kind: 'x' },
    'note 201 chars': { note: 'x'.repeat(201) }, 'note not a string': { note: 5 }, 'starts_at not UTC ISO': { starts_at: '2026-11-16 01:30' }, 'starts_at with offset': { starts_at: '2026-11-16T07:15:00+05:45' },
    'ends_at missing': { ends_at: undefined }, 'centre_id not a uuid': { centre_id: 'x' }, 'extra tenant_id': { tenant_id: B }, 'extra version': { version: 4 }, 'extra is_active': { is_active: false },
  };
  for (const [name, over] of Object.entries(bad)) {
    it(`create: ${name} -> 400`, async () => {
      const r = await post({ ...BL_BODY, ...over }); expectInvalid(r.error); expect(dml(r.calls)).toEqual([]);
    });
  }
  it('boundaries are valid: exactly 31 days, note of 200 chars -> 201', async () => {
    expect((await post({ ...BL_BODY, starts_at: '2026-12-01T00:00:00.000Z', ends_at: '2027-01-01T00:00:00.000Z' })).out.status).toBe(201);
    expect((await post({ ...BL_BODY, note: 'x'.repeat(200) })).out.status).toBe(201);
  });
  it('a note with SQL text is data: stored via bind values, never in statement text', async () => {
    const nasty = "x'); DROP TABLE engagement.slot_blackouts;--";
    const r = await post({ ...BL_BODY, note: nasty }); expect(r.out.status).toBe(201);
    expect(r.calls.some((c) => c.text.includes('DROP TABLE'))).toBe(false); expect(r.calls.some((c) => c.values.includes(nasty))).toBe(true);
  });
  it('S11 list: in-scope rows, is_active and centre filters, BlackOut-shaped, no server columns, capped at 200', async () => {
    const all = await run('listSlotBlackouts', {}, MANAGER_ALL);
    expect(all.error).toBeUndefined(); expect(all.out.status).toBe(200);
    expect(new Set(all.out.body.data.map((x: any) => x.centre_id))).toEqual(new Set([C1, C2])); expect(all.out.body.data.length).toBe(3);
    for (const x of all.out.body.data) expect(schemaErrors('SlotBlackout', x)).toEqual([]);
    expect(JSON.stringify(all.out.body)).not.toMatch(/tenant_id|created_by|updated_by|created_at/);
    expect((await run('listSlotBlackouts', { query: { centre_id: C1, is_active: false } }, MANAGER_ALL)).out.body.data.map((x: any) => x.is_active)).toEqual([false]);
    expect((await run('listSlotBlackouts', { query: { is_active: true } }, MANAGER_ALL)).out.body.data.every((x: any) => x.is_active)).toBe(true);
    const w = newDb(); for (let i = 0; i < 205; i++) (w.db.tables['slot_blackouts'] as Row[]).push(bo(ID(0x1000 + i), A, C1));
    expect((await run('listSlotBlackouts', {}, MANAGER_ALL, { world: w })).out.body.data.length).toBeLessThanOrEqual(200);
  });
  it('S11 deactivate: 200 SlotBlackoutResult, is_active=false, version+1, row kept; If-Match absent -> 428 (no DB), stale -> 409 unchanged; unknown -> 404', async () => {
    const w = newDb();
    const ok = await run('deactivateSlotBlackout', { params: { blackout_id: BL1 }, headers: ifm(3) }, MANAGER_ALL, { world: w });
    expect(ok.error).toBeUndefined(); expect(ok.out.status).toBe(200); expect(schemaErrors('SlotBlackoutResult', ok.out.body)).toEqual([]);
    expect(ok.out.body).toMatchObject({ id: BL1, is_active: false, version: 4 }); expect((w.db.tables['slot_blackouts'] as Row[]).find((x) => x['id'] === BL1)).toMatchObject({ is_active: false, version: 4, updated_by: ACTOR });
    expect(ok.calls.some((c) => verb(c) === 'delete')).toBe(false);
    const none = await run('deactivateSlotBlackout', { params: { blackout_id: BL1 } }, MANAGER_ALL); expect(none.error?.code).toBe('common.precondition_required'); expect(none.calls).toEqual([]);
    const w2 = newDb(); const before = snapshot(w2.db);
    const stale = await run('deactivateSlotBlackout', { params: { blackout_id: BL1 }, headers: ifm(2) }, MANAGER_ALL, { world: w2 }); expect(stale.error?.code).toBe('common.version_conflict'); expect(snapshot(w2.db)).toBe(before);
    expect((await run('deactivateSlotBlackout', { params: { blackout_id: UNKNOWN }, headers: ifm(3) }, MANAGER_ALL)).error?.code).toBe('common.not_found');
  });
});

// ---------------------------------------------------------------- S7 list
describe('S7 listSlotTemplates', () => {
  it('manager of all centres: every template of tenant A (none of tenant B), SlotTemplate-shaped with HH:MM times, no server columns; filters; capped at 200', async () => {
    const r = await run('listSlotTemplates', {}, MANAGER_ALL);
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200);
    expect(r.out.body.data.map((x: any) => x.id).sort()).toEqual([T1, T2, T3, T_OFF, T5].sort());
    for (const x of r.out.body.data) { expect(schemaErrors('SlotTemplate', x)).toEqual([]); expect(x.start_local).toMatch(/^\d\d:\d\d$/); }
    expect(r.out.body.data.find((x: any) => x.id === T1)).toMatchObject({ start_local: '07:00', end_local: '11:00', weekdays: [1, 2, 3, 4, 5], version: 5 });
    expect(JSON.stringify(r.out.body)).not.toMatch(/tenant_id|created_by|updated_by|created_at/);
    expect((await run('listSlotTemplates', { query: { centre_id: C2 } }, MANAGER_ALL)).out.body.data.map((x: any) => x.id)).toEqual([T3]);
    expect((await run('listSlotTemplates', { query: { is_active: false } }, MANAGER_ALL)).out.body.data.map((x: any) => x.id)).toEqual([T_OFF]);
    expect((await run('listSlotTemplates', { query: { centre_id: 'x' } }, MANAGER_ALL)).error?.code).toBe('common.validation_failed');
    const w = newDb(); for (let i = 0; i < 205; i++) (w.db.tables['slot_templates'] as Row[]).push(tpl(ID(0x2000 + i), A, C1, { is_active: false }));
    expect((await run('listSlotTemplates', {}, MANAGER_ALL, { world: w })).out.body.data.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------- enqueue
describe('template save enqueues the centre sync (08 A19 D-119): S8, S9, S10 — same transaction, job key bcentres:<tenant_id>', () => {
  const check = (calls: Call[]) => {
    const e = enqueues(calls);
    expect(e).toHaveLength(1);
    expect(e[0]!.values[0]).toBe(SYNC); expect(JSON.parse(String(e[0]!.values[1]))).toEqual({ tenant_id: A }); expect(e[0]!.values[2]).toBe(`bcentres:${A}`);
    for (const v of e[0]!.values.slice(3)) if (typeof v === 'number') expect(v).toBe(5);
    expect(calls.indexOf(dml(calls).at(-1)!)).toBeLessThan(calls.indexOf(e[0]!)); // after the write, in the same tx (the fake tx is the only tx)
  };
  it('S8 create', async () => check((await run('createSlotTemplate', { body: BODY }, MANAGER_ALL)).calls));
  it('S9 update', async () => check((await run('updateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5), body: { ...T1_BODY, capacity: 2 } }, MANAGER_ALL)).calls));
  it('S10 deactivate', async () => check((await run('deactivateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5) }, MANAGER_ALL)).calls));
  it('the payload carries the tenant only (no centre, template or patient data) and the key is per tenant, so repeated saves collapse in the queue', async () => {
    const w = newDb(); await run('createSlotTemplate', { body: BODY }, MANAGER_ALL, { world: w }); await run('deactivateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5) }, MANAGER_ALL, { world: w });
    const e = enqueues(w.db.calls); expect(e).toHaveLength(2); expect(e[0]!.values[2]).toBe(e[1]!.values[2]);
    for (const c of e) expect(String(c.values[1])).not.toMatch(new RegExp(`${C1}|${T1}`));
  });
  it('tenant B\'s save enqueues for tenant B only', async () => {
    const r = await run('updateSlotTemplate', { params: { template_id: TB }, headers: ifm(7), body: { ...T1_BODY, centre_id: CB, capacity: 2 } }, { grants: [MANAGE], centres: [], all: true }, { session: B });
    expect(r.error).toBeUndefined(); const e = enqueues(r.calls); expect(e).toHaveLength(1); expect(JSON.parse(String(e[0]!.values[1]))).toEqual({ tenant_id: B }); expect(e[0]!.values[2]).toBe(`bcentres:${B}`);
  });
  it('no enqueue when the save is rejected: forbidden, 404, 409, 400, overlap', async () => {
    const cases: Array<[string, object, Who]> = [
      ['createSlotTemplate', { body: { ...BODY, centre_id: C2 } }, MANAGER_C1], ['updateSlotTemplate', { params: { template_id: T3 }, headers: ifm(2), body: T1_BODY }, MANAGER_C1],
      ['deactivateSlotTemplate', { params: { template_id: T1 }, headers: ifm(1) }, MANAGER_ALL], ['createSlotTemplate', { body: { ...BODY, capacity: 0 } }, MANAGER_ALL], ['createSlotTemplate', { body: { ...BODY, start_local: '07:00', end_local: '08:00' } }, MANAGER_ALL],
      ['deactivateSlotTemplate', { params: { template_id: UNKNOWN }, headers: ifm(1) }, MANAGER_ALL],
    ];
    for (const [op, req, who] of cases) { const r = await run(op, req, who); expect(r.error, op).toBeDefined(); expect(enqueues(r.calls), op).toEqual([]); expect(dml(r.calls), op).toEqual([]); }
  });
});

// ---------------------------------------------------------------- concurrency
describe('race: two writers with the same If-Match -> exactly one wins, the other gets 409 (no lost update)', () => {
  it('two parallel PUTs of T1 at version 5: one 200 (version 6), one 409; final row = the winner; one enqueue', async () => {
    const w = newDb(); const mk = (capacity: number) => run('updateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5), body: { ...T1_BODY, capacity } }, MANAGER_ALL, { world: w });
    const [a, b] = await Promise.all([mk(2), mk(4)]);
    const ok = [a, b].filter((x) => !x.error), bad = [a, b].filter((x) => x.error);
    expect(ok).toHaveLength(1); expect(bad).toHaveLength(1); expect(bad[0]!.error.code).toBe('common.version_conflict');
    const row = (w.db.tables['slot_templates'] as Row[]).find((x) => x['id'] === T1)!; expect(row['version']).toBe(6); expect(row['capacity']).toBe(ok[0]!.out.body.capacity);
    expect(enqueues(w.db.calls)).toHaveLength(1);
  });
  it('two parallel deactivates of T1 at version 5: one 200, one 409', async () => {
    const w = newDb(); const mk = () => run('deactivateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5) }, MANAGER_ALL, { world: w });
    const res = await Promise.all([mk(), mk()]);
    expect(res.filter((x) => !x.error)).toHaveLength(1); expect(res.find((x) => x.error)!.error.code).toBe('common.version_conflict');
  });
});

// ---------------------------------------------------------------- security / centre scope
describe('PROBES (07 §6.4, REQ-SEC-017): staff of C1 vs C2 and tenant B', () => {
  it('S7: C1 manager without centre_id sees only C1 templates; with centre_id of C2 -> forbidden or empty; tenant B ids never appear', async () => {
    const own = await run('listSlotTemplates', {}, MANAGER_C1); expect(new Set(own.out.body.data.map((x: any) => x.centre_id))).toEqual(new Set([C1])); expect(own.out.body.data.map((x: any) => x.id)).not.toContain(TB);
    const foreign = await run('listSlotTemplates', { query: { centre_id: C2 } }, MANAGER_C1);
    if (foreign.error) expect(['auth.forbidden', 'common.not_found']).toContain(foreign.error.code); else expect(foreign.out.body.data).toEqual([]);
  });
  it('S11 list: same as S7', async () => {
    const own = await run('listSlotBlackouts', {}, MANAGER_C1); expect(new Set(own.out.body.data.map((x: any) => x.centre_id))).toEqual(new Set([C1]));
    const foreign = await run('listSlotBlackouts', { query: { centre_id: C2 } }, MANAGER_C1);
    if (foreign.error) expect(['auth.forbidden', 'common.not_found']).toContain(foreign.error.code); else expect(foreign.out.body.data).toEqual([]);
  });
  it('S6: staff of C1 asks for C2 -> auth.forbidden, zero DB access', async () => {
    const r = await run('getSlotAvailability', { query: { centre_id: C2, booking_kind: 'centre_visit', date_from: MON, date_to: MON } }, FRONT_DESK_C1);
    expect(r.error?.code).toBe('auth.forbidden'); expect(r.calls).toEqual([]);
  });
  it('S8/S11-create at C2 (and at tenant B\'s centre) by a C1 manager: refused, no row, no enqueue', async () => {
    for (const [op, body] of [['createSlotTemplate', BODY], ['createSlotBlackout', BL_BODY]] as const) for (const centre of [C2, CB]) {
      const w = newDb(A, MANAGER_C1); const before = snapshot(w.db);
      const r = await run(op, { body: { ...body, centre_id: centre } }, MANAGER_C1, { world: w });
      expect(['auth.forbidden', 'common.not_found', 'common.validation_failed'], `${op} ${centre}`).toContain(r.error?.code); expect(snapshot(w.db)).toBe(before); expect(enqueues(r.calls)).toEqual([]);
    }
  });
  it('S9/S10/S11-deactivate on a C2 object or another tenant\'s object: 404 common.not_found, never 409/403, no UPDATE, no enqueue', async () => {
    const cases: Array<[string, object]> = [
      ['updateSlotTemplate', { params: { template_id: T3 }, headers: ifm(2), body: T1_BODY }], ['updateSlotTemplate', { params: { template_id: TB }, headers: ifm(7), body: T1_BODY }],
      ['deactivateSlotTemplate', { params: { template_id: T3 }, headers: ifm(2) }], ['deactivateSlotTemplate', { params: { template_id: TB }, headers: ifm(7) }],
      ['deactivateSlotBlackout', { params: { blackout_id: BL_C2 }, headers: ifm(1) }], ['deactivateSlotBlackout', { params: { blackout_id: BLB }, headers: ifm(1) }],
    ];
    for (const [op, req] of cases) {
      const w = newDb(A, MANAGER_C1); const before = snapshot(w.db);
      const r = await run(op, req, MANAGER_C1, { world: w });
      expect(r.error?.code, op).toBe('common.not_found'); expect(dml(r.calls), op).toEqual([]); expect(snapshot(w.db)).toBe(before); expect(enqueues(r.calls)).toEqual([]);
    }
  });
  it('front desk (booking.read only) can read S6 but S7-S11 -> auth.forbidden before any DB access', async () => {
    const ok = await run('getSlotAvailability', { query: { centre_id: C1, booking_kind: 'centre_visit', date_from: MON, date_to: MON } }, FRONT_DESK_C1); expect(ok.error).toBeUndefined();
    const ops: Array<[string, object]> = [['listSlotTemplates', {}], ['createSlotTemplate', { body: BODY }], ['updateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5), body: T1_BODY }], ['deactivateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5) }],
      ['listSlotBlackouts', {}], ['createSlotBlackout', { body: BL_BODY }], ['deactivateSlotBlackout', { params: { blackout_id: BL1 }, headers: ifm(3) }]];
    for (const [op, req] of ops) { const r = await run(op, req, FRONT_DESK_C1); expect(r.error?.code, op).toBe('auth.forbidden'); expect(r.calls, op).toEqual([]); }
  });
  it('no permission at all / refused membership / no request context: refused with zero DB access', async () => {
    const q = { query: { centre_id: C1, booking_kind: 'centre_visit', date_from: MON, date_to: MON } };
    expect((await run('getSlotAvailability', q, { grants: [], centres: [C1] })).error?.code).toBe('auth.forbidden');
    const locked = await run('listSlotTemplates', {}, { ...MANAGER_C1, refuse: 'auth.account_locked' }); expect(locked.error?.code).toBe('auth.account_locked'); expect(locked.calls).toEqual([]);
    const anon = await run('listSlotTemplates', {}, MANAGER_C1, { noTx: true }); expect(anon.error?.code).toBe('auth.unauthenticated');
  });
  it('tenant B session cannot see or change tenant A\'s slot data (tenant RLS): list is empty of A, A\'s ids are 404', async () => {
    const tb: Who = { grants: [READ, MANAGE], centres: [], all: true };
    const l = await run('listSlotTemplates', {}, tb, { session: B }); expect(l.out.body.data.map((x: any) => x.id)).toEqual([TB]);
    const u = await run('updateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5), body: T1_BODY }, tb, { session: B }); expect(u.error?.code).toBe('common.not_found');
    const d = await run('deactivateSlotBlackout', { params: { blackout_id: BL1 }, headers: ifm(3) }, tb, { session: B }); expect(d.error?.code).toBe('common.not_found');
  });
  it('every statement binds the tenant id, none is a DELETE, and user input never appears in statement text', async () => {
    const w = newDb(); const mark = "zz'; --";
    await run('createSlotTemplate', { body: BODY }, MANAGER_ALL, { world: w }); await run('createSlotBlackout', { body: { ...BL_BODY, note: mark } }, MANAGER_ALL, { world: w });
    await run('updateSlotTemplate', { params: { template_id: T1 }, headers: ifm(5), body: { ...T1_BODY, capacity: 1 } }, MANAGER_ALL, { world: w });
    await run('getSlotAvailability', { query: { centre_id: C1, booking_kind: 'centre_visit', date_from: MON, date_to: MON } }, MANAGER_ALL, { world: w });
    for (const c of w.db.calls.filter((x) => !isEnqueue(x))) {
      expect(verb(c)).not.toBe('delete');
      if (/engagement\.(slot_templates|slot_blackouts|slot_occupancy|bookings)/i.test(c.text)) { expect(c.text, c.text).toMatch(/tenant_id/); expect(c.values, c.text).toContain(A); }
      expect(c.text).not.toContain(mark);
    }
  });
});
