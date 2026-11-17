// C16.T-Q1 — Q1a listQueues, Q1b listQueueDefinitions, Q1c createQueue/updateQueue, Q2a listCounters, Q2b listCounterDefinitions, Q2c createCounter/updateCounter
// (06-PLAN row T-Q1; 02-TRD §4.10, §5 Q1/Q2; 05-SCHEMA queue_definitions/queue_counters + §5.1 STAFF_C; 07-SECURITY §6.4 centre-scope probes, REQ-SEC-017).
// done_when: centre-scoped CRUD with If-Match. tests: integration; centre probe (C1 staff vs C2 queue). No ACs listed for T-Q1 (US-EN-21 starts at T-Q2).
// Fails now: handlers/index.ts maps all eight operationIds to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec does not fix them; same convention as settings.handlers.test.ts, lab/frontdesk probe kits):
//   handlers[op](req:{params,query,headers,body}, ctx) -> {status, body, headers?}; ctx = {tenantId, actor, tx, now, ports:{IdentityPort}}.
//   Permission + centre = ctx.ports.IdentityPort.assertRole(ctx, {permission, centreId?}) BEFORE any tx.query (floors: Q1a/Q2a engagement.queue.operate; the rest engagement.queue.manage).
//   Centre scope: IdentityPort fake refuses assertRole({centreId}) outside the actor's centres with auth.forbidden AND getActor().centreScope is exposed; the DB fake ALSO enforces STAFF_C
//   (SELECT/UPDATE hide rows of other centres, INSERT outside scope -> pg 42501). So a handler may rely on assertRole, on RLS, or both; the observable contract is below.
//   Centre probe (07 §6.4): list at a foreign centre -> auth.forbidden OR 200 {data:[]} (never a foreign row); list without centre_id (Q1b) -> only in-scope rows;
//   object op (PUT) on a foreign-centre or foreign-tenant id -> 404 common.not_found and NO UPDATE; create at a foreign centre -> auth.forbidden OR common.not_found and no row.
//   If-Match arrives raw as '"<version>"' (key 'if-match'); absent -> 428 common.precondition_required before any DB access; stale -> 409 common.version_conflict, row unchanged.
//   Duplicate code in centre (pg 23505 on queue_definitions__tenant_id_centre_code__uq) -> 400 common.validation_failed with errors[].path '/code' (TRD Q1c).
//   Handlers validate bodies/queries themselves (pipeline schema validation is not re-tested): invalid -> 400 common.validation_failed, zero writes.
//   DB fake answers by leading verb + table (`engagement.queue_definitions` / `engagement.queue_counters`); WHERE clauses are emulated from the BOUND VALUES (row id, centre uuid, boolean is_active, version).
//   UPDATE succeeds only when the bound values include the row's current version (so the handler must bind If-Match's version). Deletes do not exist (05-SCHEMA table matrix: S I U) -> any DELETE fails the test.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { TENANTS } from '../../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';

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
const Q1_ID = ID(0x1a1), Q2_ID = ID(0x1a2), QB_ID = ID(0x1b1), K1_ID = ID(0x2a1), K2_ID = ID(0x2a2), KB_ID = ID(0x2b1), NEW_ID = ID(0x9999), UNKNOWN = ID(0x7777);
const OPERATE = 'engagement.queue.operate', MANAGE = 'engagement.queue.manage';
const STALE = 40, CURRENT = 41; // bodies / sort orders below never contain 40 / 41 / 42

const queueRow = (id: string, tenant: string, centre: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: tenant, centre_id: centre, code: 'registration', display_name: 'Registration', token_prefix: 'A', sort_order: 10, board_version: 7, version: CURRENT, is_active: true,
  created_at: new Date(0), created_by: A, updated_at: new Date(0), updated_by: A, ...over });
const counterRow = (id: string, tenant: string, centre: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: tenant, centre_id: centre, display_name: 'Counter 1', sort_order: 10, version: CURRENT, is_active: true, created_at: new Date(0), created_by: A, updated_at: new Date(0), updated_by: A, ...over });
const seed = () => ({
  queue_definitions: [
    queueRow(Q1_ID, A, C1), queueRow(ID(0x1a3), A, C1, { code: 'old_queue', display_name: 'Old', token_prefix: 'Z', sort_order: 20, is_active: false }),
    queueRow(Q2_ID, A, C2, { code: 'sample_collection', display_name: 'Sample collection (C2)', token_prefix: 'C' }), queueRow(QB_ID, B, CB, { display_name: 'Tenant B queue' }),
  ],
  queue_counters: [
    counterRow(K1_ID, A, C1), counterRow(ID(0x2a3), A, C1, { display_name: 'Counter old', sort_order: 20, is_active: false }),
    counterRow(K2_ID, A, C2, { display_name: 'Counter 2 (C2)' }), counterRow(KB_ID, B, CB, { display_name: 'Tenant B counter' }),
  ],
});

type Table = 'queue_definitions' | 'queue_counters';
interface Call { text: string; values: unknown[] }
interface Scope { all: boolean; centres: readonly string[] }
const KNOWN_CENTRES = [C1, C2, CB];
const verb = (c: Call) => /^\s*(select|insert|update|delete)\b/i.exec(c.text)?.[1]?.toLowerCase();
const writes = (c: Call[]) => c.filter((x) => ['insert', 'update', 'delete'].includes(verb(x) ?? ''));

/** Fake Postgres for one request: session tenant + STAFF_C centre predicate (05-SCHEMA §5.1). `body` = the request body the next INSERT/UPDATE carries (binds are matched, not parsed). */
function fakeDb(session: string, scope: Scope, rows = seed()) {
  const calls: Call[] = [];
  const state = { body: {} as Record<string, any> };
  const inScope = (r: any) => r.tenant_id === session && (scope.all || scope.centres.includes(r.centre_id));
  return {
    calls, rows, state,
    tx: {
      async query(text: string, values: unknown[] = []) {
        const c = { text, values }; calls.push(c);
        const v = verb(c);
        const t: Table | undefined = /engagement\.queue_definitions/i.test(text) ? 'queue_definitions' : /engagement\.queue_counters/i.test(text) ? 'queue_counters' : undefined;
        if (!t) {
          if (v === 'select' && /core\.collection_centres/i.test(text)) { // FK target existence read (tenant + centre scope)
            const centre = values.find((x) => KNOWN_CENTRES.includes(x as string)) as string | undefined;
            const ok = centre !== undefined && (centre === CB ? session === B : session === A) && (scope.all || scope.centres.includes(centre));
            return { rows: ok ? [{ id: centre, tenant_id: session }] : [], rowCount: ok ? 1 : 0 };
          }
          return { rows: [], rowCount: 0 }; // session settings, audit, etc.
        }
        const table = rows[t] as any[];
        if (v === 'delete') throw new Error('fake: DELETE is not allowed on queue tables (05-SCHEMA matrix S I U)');
        if (v === 'select') {
          let r = table.filter(inScope);
          const id = r.find((x) => values.includes(x.id));
          if (id) r = [id];
          else if (values.some((x) => typeof x === 'string' && /^01950c16-/.test(x) && !KNOWN_CENTRES.includes(x))) r = []; // looked up by an id that is not visible
          const centre = values.find((x) => KNOWN_CENTRES.includes(x as string));
          if (!id && centre) r = r.filter((x) => x.centre_id === centre);
          const flag = values.find((x) => typeof x === 'boolean');
          if (!id && flag !== undefined) r = r.filter((x) => x.is_active === flag);
          return { rows: r, rowCount: r.length };
        }
        const b = state.body;
        const dup = (centre: string, except?: string) => t === 'queue_definitions' && table.some((x) => x.tenant_id === session && x.centre_id === centre && x.code === b['code'] && x.id !== except);
        if (v === 'insert') {
          const centre = b['centre_id'] as string;
          if (!(scope.all || scope.centres.includes(centre))) throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
          if (dup(centre)) throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'queue_definitions__tenant_id_centre_code__uq' });
          const row = { ...(t === 'queue_definitions' ? queueRow(NEW_ID, session, centre) : counterRow(NEW_ID, session, centre)), ...b, id: NEW_ID, tenant_id: session, version: 1, board_version: 1 };
          table.push(row);
          return { rows: [row], rowCount: 1 };
        }
        // update
        const cur = table.filter(inScope).find((x) => values.includes(x.id));
        if (!cur || !values.includes(cur.version)) return { rows: [], rowCount: 0 };
        const centre = (b['centre_id'] as string | undefined) ?? cur.centre_id;
        if (!(scope.all || scope.centres.includes(centre))) throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
        if (dup(centre, cur.id)) throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'queue_definitions__tenant_id_centre_code__uq' });
        Object.assign(cur, b, { version: cur.version + 1 });
        return { rows: [cur], rowCount: 1 };
      },
    },
  };
}

const PRIVILEGED = new Set<string>(); // queue permissions are not privileged (contracts/permissions.yaml); no aal2 needed
interface Who { grants: readonly string[]; centres: readonly string[]; all?: boolean; refuse?: string }
function identity(w: Who) {
  const calls: Array<{ permission: string; centreId?: string }> = [];
  return {
    calls,
    async assertRole(_c: unknown, r: { permission: string; centreId?: string }) {
      calls.push({ permission: r?.permission, ...(r?.centreId ? { centreId: r.centreId } : {}) });
      if (w.refuse) throw new LimsError(w.refuse);
      if (!w.grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
      if (PRIVILEGED.has(r.permission)) throw new LimsError('auth.mfa_required');
      if (r.centreId && !w.all && !w.centres.includes(r.centreId)) throw new LimsError('auth.forbidden');
    },
    async getActor() { return { actor: { type: 'user', id: A }, permissions: [...w.grants], roles: [], centreScope: { all: Boolean(w.all), centreIds: w.centres }, mfa: { enrolled: true, level: 'aal2' } }; },
  };
}
const FRONT_DESK_C1: Who = { grants: [OPERATE], centres: [C1] };
const MANAGER_C1: Who = { grants: [OPERATE, MANAGE], centres: [C1] };
const MANAGER_ALL: Who = { grants: [OPERATE, MANAGE], centres: [], all: true };

const ctxFor = makeCtxFor();
const run = async (op: string, o: { params?: object; query?: object; headers?: object; body?: unknown }, who: Who, opts: { session?: string; tenantSide?: 'A' | 'B'; db?: ReturnType<typeof fakeDb> } = {}) => {
  const session = opts.session ?? A;
  const db = opts.db ?? fakeDb(session, { all: Boolean(who.all), centres: who.centres });
  if (o.body && typeof o.body === 'object') db.state.body = o.body as Record<string, any>;
  const id = identity(who);
  const ctx = { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    ...ctxFor(opts.tenantSide ?? (session === B ? 'B' : 'A'), { tx: db.tx as never, ports: { IdentityPort: id } as never }) } as never;
  const r = { params: {}, query: {}, headers: {}, body: undefined, ...o } as never;
  let out: any, error: any;
  try { out = await (handlers as any)[op](r, ctx); } catch (e) { error = e; }
  return { out, error, db, id, calls: db.calls };
};
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });

// ------------------------------------------------------------------ per-kind configuration (queues and counters share the same shape of tests)
const QBODY = { centre_id: C1, code: 'sample_collection', display_name: 'Sample collection', token_prefix: 'B', sort_order: 20, is_active: true };
const KBODY = { centre_id: C1, display_name: 'Counter 3', sort_order: 30, is_active: true };
const KINDS = [
  { name: 'queue', table: 'queue_definitions' as Table, schema: 'Queue', listC: 'listQueues', listS: 'listQueueDefinitions', create: 'createQueue', update: 'updateQueue', idParam: 'queue_id',
    own: Q1_ID, foreign: Q2_ID, otherTenant: QB_ID, body: QBODY, bodyForC2: { ...QBODY, centre_id: C2 },
    invalid: { 'token_prefix lower-case': { ...QBODY, token_prefix: 'a' }, 'token_prefix 3 letters': { ...QBODY, token_prefix: 'ABC' }, 'token_prefix digit': { ...QBODY, token_prefix: '1' },
      'code upper-case': { ...QBODY, code: 'Bad Code' }, 'code 33 chars': { ...QBODY, code: 'a'.repeat(33) }, 'display_name empty': { ...QBODY, display_name: '' },
      'display_name 61 chars': { ...QBODY, display_name: 'x'.repeat(61) }, 'sort_order 1000': { ...QBODY, sort_order: 1000 }, 'sort_order negative': { ...QBODY, sort_order: -1 },
      'is_active missing': (({ is_active: _a, ...r }) => r)(QBODY), 'centre_id not a uuid': { ...QBODY, centre_id: 'not-a-uuid' }, 'extra tenant_id': { ...QBODY, tenant_id: B }, 'extra version': { ...QBODY, version: 9 } } as Record<string, unknown> },
  { name: 'counter', table: 'queue_counters' as Table, schema: 'QueueCounter', listC: 'listCounters', listS: 'listCounterDefinitions', create: 'createCounter', update: 'updateCounter', idParam: 'counter_id',
    own: K1_ID, foreign: K2_ID, otherTenant: KB_ID, body: KBODY, bodyForC2: { ...KBODY, centre_id: C2 },
    invalid: { 'display_name empty': { ...KBODY, display_name: '' }, 'display_name 41 chars': { ...KBODY, display_name: 'x'.repeat(41) }, 'sort_order 1000': { ...KBODY, sort_order: 1000 },
      'sort_order negative': { ...KBODY, sort_order: -1 }, 'is_active missing': (({ is_active: _a, ...r }) => r)(KBODY), 'centre_id not a uuid': { ...KBODY, centre_id: 'nope' },
      'extra tenant_id': { ...KBODY, tenant_id: B }, 'extra code': { ...KBODY, code: 'x' } } as Record<string, unknown> },
];

describe('contract: operations exist; floors, idempotency and parameters match 02-TRD §5 Q1/Q2', () => {
  it('x-permission floors', () => {
    for (const op of ['listQueues', 'listCounters']) expect(opOf(op)['x-permission']).toBe(OPERATE);
    for (const op of ['listQueueDefinitions', 'createQueue', 'updateQueue', 'listCounterDefinitions', 'createCounter', 'updateCounter']) expect(opOf(op)['x-permission']).toBe(MANAGE);
  });
  it('permissions.yaml: operate = front_desk, centre_staff; manage = tenant_admin, lab_manager (so a front desk user can never manage queues)', async () => {
    const { readFileSync } = await import('node:fs');
    const perms = readFileSync(join(REPO_ROOT, 'contracts/permissions.yaml'), 'utf8') as string;
    expect(perms).toMatch(/code:\s*engagement\.queue\.operate,\s*privileged:\s*false,\s*roles:\s*\[front_desk,\s*centre_staff\]/);
    expect(perms).toMatch(/code:\s*engagement\.queue\.manage,\s*privileged:\s*false,\s*roles:\s*\[tenant_admin,\s*lab_manager\]/);
  });
  it('create requires Idempotency-Key, update optional, lists none; PUT is by If-Match', () => {
    for (const op of ['createQueue', 'createCounter']) expect(opOf(op)['x-idempotency']).toBe('required');
    for (const op of ['updateQueue', 'updateCounter']) { expect(opOf(op)['x-idempotency']).toBe('optional'); expect(opOf(op)['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required', 'common.not_found'])); }
    for (const op of ['listQueues', 'listQueueDefinitions', 'listCounters', 'listCounterDefinitions']) expect(opOf(op)['x-idempotency']).toBe('none');
  });
  it('console lists need centre_id, setup lists do not (TRD Q1a/Q1b/Q2a/Q2b)', () => {
    const req = (op: string) => Object.fromEntries((opOf(op).parameters as any[]).filter((p) => p.name).map((p) => [p.name, p.required]));
    expect(req('listQueues')['centre_id']).toBe(true); expect(req('listCounters')['centre_id']).toBe(true);
    expect(req('listQueueDefinitions')['centre_id']).toBeFalsy(); expect(req('listCounterDefinitions')['centre_id']).toBeFalsy();
  });
});

for (const K of KINDS) {
  const Rm = K.name === 'queue' ? 'Q' : 'Q2';
  describe(`${K.name}s — lists (${K.listC} console, ${K.listS} setup)`, () => {
    it(`${K.listC}: 200 {data} of in-centre rows only, contract-shaped, no server columns; asserts ${OPERATE} + centre BEFORE any query`, async () => {
      const { out, error, id, calls } = await run(K.listC, { query: { centre_id: C1 } }, FRONT_DESK_C1);
      expect(error).toBeUndefined();
      expect(out.status).toBe(200);
      expect(out.body.data.length).toBe(2); // active + inactive of C1 (no is_active filter)
      for (const r of out.body.data) { expect(r.centre_id).toBe(C1); expect(schemaErrors(K.schema, r)).toEqual([]); }
      expect(JSON.stringify(out.body)).not.toMatch(/tenant_id|board_version|created_by|updated_by|created_at/);
      expect(id.calls[0]).toMatchObject({ permission: OPERATE, centreId: C1 });
      expect(writes(calls)).toEqual([]);
    });
    it(`${K.listC}: is_active filter`, async () => {
      const off = await run(K.listC, { query: { centre_id: C1, is_active: false } }, FRONT_DESK_C1);
      expect(off.out.body.data.map((r: any) => r.is_active)).toEqual([false]);
      const on = await run(K.listC, { query: { centre_id: C1, is_active: true } }, FRONT_DESK_C1);
      expect(on.out.body.data.map((r: any) => r.is_active)).toEqual([true]);
    });
    it(`${K.listC}: centre_id missing or not a uuid -> 400 common.validation_failed, no DB`, async () => {
      for (const q of [{}, { centre_id: 'nope' }]) { const r = await run(K.listC, { query: q }, FRONT_DESK_C1); expect(r.error?.code).toBe('common.validation_failed'); expect(r.calls).toEqual([]); }
    });
    it(`${K.listC}: no permission / manage-only / refused membership -> auth.forbidden or the port's code, zero DB access`, async () => {
      for (const who of [{ grants: [], centres: [C1] }, { grants: [MANAGE], centres: [C1] }] as Who[]) { const r = await run(K.listC, { query: { centre_id: C1 } }, who); expect(r.error?.code).toBe('auth.forbidden'); expect(r.calls).toEqual([]); }
      const locked = await run(K.listC, { query: { centre_id: C1 } }, { ...FRONT_DESK_C1, refuse: 'auth.account_locked' }); expect(locked.error?.code).toBe('auth.account_locked'); expect(locked.calls).toEqual([]);
    });
    it(`PROBE ${Rm}1: staff of C1 lists C2 -> forbidden or empty, never a C2 row (07 §6.4)`, async () => {
      const { out, error } = await run(K.listC, { query: { centre_id: C2 } }, FRONT_DESK_C1);
      if (error) expect(['auth.forbidden', 'common.not_found']).toContain(error.code);
      else { expect(out.status).toBe(200); expect(out.body.data).toEqual([]); }
      expect(JSON.stringify(out?.body ?? {})).not.toContain('C2)');
    });
    it(`PROBE ${Rm}2: tenant B session asked for A's centre sees nothing of A (tenant RLS)`, async () => {
      const { out, error } = await run(K.listC, { query: { centre_id: C1 } }, { grants: [OPERATE], centres: [], all: true }, { session: B });
      if (error) expect(['auth.forbidden', 'common.not_found']).toContain(error.code);
      else expect(out.body.data).toEqual([]);
    });
    it(`${K.listS}: needs ${MANAGE}; without centre_id returns only the actor's centres; with all-centres returns every centre of the tenant and none of tenant B`, async () => {
      const own = await run(K.listS, {}, MANAGER_C1);
      expect(own.error).toBeUndefined(); expect(own.out.status).toBe(200);
      expect([...new Set(own.out.body.data.map((r: any) => r.centre_id))]).toEqual([C1]);
      expect(own.id.calls[0]!.permission).toBe(MANAGE);
      const all = await run(K.listS, {}, MANAGER_ALL);
      expect(new Set(all.out.body.data.map((r: any) => r.centre_id))).toEqual(new Set([C1, C2]));
      expect(JSON.stringify(all.out.body)).not.toContain('Tenant B');
      for (const r of all.out.body.data) expect(schemaErrors(K.schema, r)).toEqual([]);
    });
    it(`${K.listS}: operate-only user (front desk) -> auth.forbidden, zero DB access; centre_id of C2 for a C1 manager -> forbidden or empty`, async () => {
      const fd = await run(K.listS, {}, FRONT_DESK_C1); expect(fd.error?.code).toBe('auth.forbidden'); expect(fd.calls).toEqual([]);
      const { out, error } = await run(K.listS, { query: { centre_id: C2 } }, MANAGER_C1);
      if (error) expect(['auth.forbidden', 'common.not_found']).toContain(error.code); else expect(out.body.data).toEqual([]);
    });
    it(`${K.listS}: is_active filter`, async () => {
      const r = await run(K.listS, { query: { is_active: false } }, MANAGER_ALL);
      expect(r.out.body.data.every((x: any) => x.is_active === false)).toBe(true); expect(r.out.body.data.length).toBe(1);
    });
    it('list SELECTs are capped at 200 rows (contract maxItems: 200), never 500', async () => {
      const c = await run(K.listC, { query: { centre_id: C1 } }, FRONT_DESK_C1);
      const s = await run(K.listS, {}, MANAGER_ALL);
      for (const calls of [c.calls, s.calls]) {
        const sel = calls.filter((x) => verb(x) === 'select' && /engagement\.queue_(definitions|counters)/i.test(x.text));
        expect(sel.length).toBeGreaterThan(0);
        for (const x of sel) { expect(x.text).toMatch(/\bLIMIT\s+200\b/i); expect(x.text).not.toMatch(/\bLIMIT\s+(?!200\b)\d+/i); }
      }
    });
  });

  describe(`${K.name}s — create (${K.create})`, () => {
    it('201 with the contract shape, version 1; INSERT binds the session tenant and every body field, never another tenant', async () => {
      const { out, error, calls, id } = await run(K.create, { body: K.body }, MANAGER_C1);
      expect(error).toBeUndefined();
      expect(out.status).toBe(201);
      expect(schemaErrors(K.schema, out.body)).toEqual([]);
      expect(out.body).toMatchObject({ ...K.body, version: 1 });
      const ins = calls.filter((c) => verb(c) === 'insert');
      expect(ins.length).toBe(1);
      for (const v of Object.values(K.body)) expect(ins[0]!.values).toContain(v);
      expect(ins[0]!.values).toContain(A); expect(ins[0]!.values).not.toContain(B);
      expect(id.calls[0]).toMatchObject({ permission: MANAGE, centreId: C1 });
      expect(JSON.stringify(out.body)).not.toMatch(/tenant_id|board_version|created_by/);
    });
    it('created row is then listed in its centre (round trip)', async () => {
      const db = fakeDb(A, { all: false, centres: [C1] });
      await run(K.create, { body: K.body }, MANAGER_C1, { db });
      const l = await run(K.listC, { query: { centre_id: C1 } }, MANAGER_C1, { db });
      expect(l.out.body.data.map((r: any) => r.id)).toContain(NEW_ID);
    });
    it('operate-only (front desk) cannot create: auth.forbidden, zero DB access', async () => {
      const r = await run(K.create, { body: K.body }, FRONT_DESK_C1); expect(r.error?.code).toBe('auth.forbidden'); expect(r.calls).toEqual([]);
    });
    for (const [label, body] of Object.entries(K.invalid)) {
      it(`invalid body (${label}) -> 400 common.validation_failed, zero writes`, async () => {
        const r = await run(K.create, { body }, MANAGER_C1);
        expect(r.error?.code).toBe('common.validation_failed'); expect(writes(r.calls)).toEqual([]);
      });
    }
    it('missing body -> 400 common.validation_failed', async () => {
      const r = await run(K.create, { body: undefined }, MANAGER_C1); expect(r.error?.code).toBe('common.validation_failed'); expect(writes(r.calls)).toEqual([]);
    });
    it(`PROBE ${Rm}3: manager of C1 creates at C2 -> auth.forbidden or common.not_found, no row stored (07 §6.4, REQ-SEC-017)`, async () => {
      const db = fakeDb(A, { all: false, centres: [C1] });
      const r = await run(K.create, { body: K.bodyForC2 }, MANAGER_C1, { db });
      expect(['auth.forbidden', 'common.validation_failed']).toContain(r.error?.code); // no 404 declared on create (x-error-codes)
      if (r.error?.code === 'common.validation_failed') expect(JSON.stringify(r.error)).toContain('/centre_id');
      expect(db.rows[K.table].some((x: any) => x.id === NEW_ID)).toBe(false);
    });
    it('centre of ANOTHER tenant cannot be targeted (FK / RLS) -> forbidden / not_found / validation, nothing stored', async () => {
      const db = fakeDb(A, { all: true, centres: [] });
      const r = await run(K.create, { body: { ...K.body, centre_id: CB } }, MANAGER_ALL, { db });
      expect(['auth.forbidden', 'common.validation_failed']).toContain(r.error?.code); // no 404 declared on create (x-error-codes)
      expect(db.rows[K.table].some((x: any) => x.id === NEW_ID && x.tenant_id !== A)).toBe(false);
    });
  });

  describe(`${K.name}s — update (${K.update}) with If-Match`, () => {
    const put = (who: Who, o: { id?: string; body?: unknown; headers?: object } = {}, opts = {}) =>
      run(K.update, { params: { [K.idParam]: o.id ?? K.own }, body: o.body ?? K.body, headers: o.headers ?? ifm(CURRENT) }, who, opts);
    const patchBody = { ...K.body, display_name: 'Renamed', sort_order: 50, is_active: false };
    it(`200, version ${CURRENT} -> ${CURRENT + 1}, body reflects the change, UPDATE bound with the If-Match version`, async () => {
      const { out, error, calls, id, db } = await put(MANAGER_C1, { body: patchBody });
      expect(error).toBeUndefined();
      expect(out.status).toBe(200);
      expect(schemaErrors(K.schema, out.body)).toEqual([]);
      expect(out.body).toMatchObject({ id: K.own, display_name: 'Renamed', sort_order: 50, is_active: false, version: CURRENT + 1 });
      const up = calls.filter((c) => verb(c) === 'update');
      expect(up.length).toBe(1); expect(up[0]!.values).toContain(CURRENT); expect(up[0]!.values).toContain(K.own);
      expect(id.calls[0]!.permission).toBe(MANAGE);
      expect((db.rows[K.table] as any[]).find((x) => x.id === K.own)!.version).toBe(CURRENT + 1);
    });
    it('second PUT with the OLD If-Match -> 409 common.version_conflict (lost update prevented)', async () => {
      const db = fakeDb(A, { all: false, centres: [C1] });
      expect((await put(MANAGER_C1, { body: patchBody }, { db })).out.status).toBe(200);
      const again = await put(MANAGER_C1, { body: { ...patchBody, display_name: 'Other' } }, { db });
      expect(again.error?.code).toBe('common.version_conflict');
      expect((db.rows[K.table] as any[]).find((x) => x.id === K.own)!.display_name).toBe('Renamed');
    });
    it('stale If-Match -> 409 common.version_conflict and the row is unchanged', async () => {
      const r = await put(MANAGER_C1, { body: patchBody, headers: ifm(STALE) });
      expect(r.error?.code).toBe('common.version_conflict');
      const row = (r.db.rows[K.table] as any[]).find((x) => x.id === K.own)!;
      expect(row.version).toBe(CURRENT); expect(row.display_name).not.toBe('Renamed');
    });
    it('no If-Match -> 428 common.precondition_required before any DB access', async () => {
      const r = await put(MANAGER_C1, { headers: {} });
      expect(r.error?.code).toBe('common.precondition_required'); expect(r.calls).toEqual([]);
    });
    it('garbage If-Match (not a quoted integer) never succeeds and never writes', async () => {
      for (const h of ['abc', '""', '"0"', '"-1"', '"41.5"', '"41 OR 1=1"']) {
        const r = await put(MANAGER_C1, { body: patchBody, headers: ifm(h) });
        expect(r.error).toBeDefined(); expect(['common.precondition_required', 'common.validation_failed', 'common.version_conflict']).toContain(r.error.code); expect(writes(r.calls).filter((c) => c.values.includes('41 OR 1=1'))).toEqual([]);
      }
    });
    it('operate-only user cannot update: auth.forbidden, zero DB access', async () => {
      const r = await put(FRONT_DESK_C1, { body: patchBody }); expect(r.error?.code).toBe('auth.forbidden'); expect(r.calls).toEqual([]);
    });
    it('unknown id and non-uuid id -> 404 / 400, no UPDATE', async () => {
      const u = await put(MANAGER_C1, { id: UNKNOWN }); expect(u.error?.code).toBe('common.not_found'); expect(writes(u.calls)).toEqual([]);
      const bad = await put(MANAGER_C1, { id: 'not-a-uuid' }); expect(['common.not_found', 'common.validation_failed']).toContain(bad.error?.code); expect(writes(bad.calls)).toEqual([]);
    });
    for (const [label, body] of Object.entries(K.invalid)) {
      it(`invalid body (${label}) -> 400 common.validation_failed, zero writes`, async () => {
        const r = await put(MANAGER_C1, { body }); expect(r.error?.code).toBe('common.validation_failed'); expect(writes(r.calls)).toEqual([]);
      });
    }
    it(`PROBE ${Rm}4: manager of C1 PUTs a C2 ${K.name} (valid id, current version) -> 404 common.not_found, no UPDATE (indistinguishable from unknown)`, async () => {
      const r = await put(MANAGER_C1, { id: K.foreign, body: patchBody });
      expect(r.error?.code).toBe('common.not_found'); expect(writes(r.calls)).toEqual([]);
      expect((r.db.rows[K.table] as any[]).find((x) => x.id === K.foreign)!.version).toBe(CURRENT);
    });
    it(`PROBE ${Rm}5: same PUT with a STALE If-Match on a C2 ${K.name} still 404 (never 409: existence of a foreign-centre row is not revealed)`, async () => {
      const r = await put(MANAGER_C1, { id: K.foreign, body: patchBody, headers: ifm(STALE) }); expect(r.error?.code).toBe('common.not_found');
    });
    it(`PROBE ${Rm}6: tenant A manager PUTs tenant B's ${K.name} -> 404, no UPDATE`, async () => {
      const r = await put(MANAGER_ALL, { id: K.otherTenant, body: patchBody }); expect(r.error?.code).toBe('common.not_found'); expect(writes(r.calls)).toEqual([]);
    });
    it(`PROBE ${Rm}7: manager of C1 moves an own ${K.name} to centre C2 (body centre_id) -> forbidden / not_found / validation, row stays in C1`, async () => {
      const r = await put(MANAGER_C1, { body: K.bodyForC2 });
      expect(['auth.forbidden', 'common.not_found', 'common.validation_failed']).toContain(r.error?.code);
      expect((r.db.rows[K.table] as any[]).find((x) => x.id === K.own)!.centre_id).toBe(C1);
    });
    it('all-centres manager can update a C2 row (scope is a restriction, not a blanket denial)', async () => {
      const r = await put(MANAGER_ALL, { id: K.foreign, body: { ...K.bodyForC2, display_name: 'C2 renamed' } });
      expect(r.error).toBeUndefined(); expect(r.out.body).toMatchObject({ id: K.foreign, centre_id: C2, display_name: 'C2 renamed', version: CURRENT + 1 });
    });
  });
}

describe('queues — duplicate code in a centre (TRD Q1c: 400 common.validation_failed on /code)', () => {
  it('createQueue with an existing code at the same centre', async () => {
    const r = await run('createQueue', { body: { ...QBODY, code: 'registration' } }, MANAGER_C1);
    expect(r.error?.code).toBe('common.validation_failed');
    expect((r.error.errors ?? []).map((e: any) => e.path)).toContain('/code');
    expect(JSON.stringify(r.error)).not.toMatch(/queue_definitions__|duplicate key|23505/); // no SQL internals in the problem
  });
  it('same code in ANOTHER centre is fine (unique per centre)', async () => {
    const r = await run('createQueue', { body: { ...QBODY, code: 'sample_collection', centre_id: C1 } }, MANAGER_ALL);
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201);
  });
  it('updateQueue renaming code onto a sibling code -> same 400 on /code, row unchanged', async () => {
    const r = await run('updateQueue', { params: { queue_id: Q1_ID }, body: { ...QBODY, code: 'old_queue', display_name: 'Registration' }, headers: ifm(CURRENT) }, MANAGER_C1);
    expect(r.error?.code).toBe('common.validation_failed'); expect((r.error.errors ?? []).map((e: any) => e.path)).toContain('/code');
    expect((r.db.rows.queue_definitions as any[]).find((x) => x.id === Q1_ID)!.code).toBe('registration');
  });
  it('updateQueue keeping its own code is not a duplicate', async () => {
    const r = await run('updateQueue', { params: { queue_id: Q1_ID }, body: { ...QBODY, code: 'registration' }, headers: ifm(CURRENT) }, MANAGER_C1);
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200);
  });
});

describe('unexpected database failures never leak (fail closed)', () => {
  it('an unknown pg error on INSERT surfaces as a non-validation error without SQL text', async () => {
    const db = fakeDb(A, { all: false, centres: [C1] });
    const q = db.tx.query;
    let reachedInsert = false;
    db.tx.query = async (text: string, values?: unknown[]) => { if (verb({ text, values: values ?? [] }) === 'insert') { reachedInsert = true; throw Object.assign(new Error('boom: relation secret_table'), { code: '08006' }); } return q(text, values); };
    const r = await run('createCounter', { body: KBODY }, MANAGER_C1, { db });
    expect(reachedInsert).toBe(true); // the handler really reached the INSERT (not the T-01 placeholder)
    expect(r.error).toBeDefined(); expect(['common.validation_failed', 'common.service_unavailable']).not.toContain(r.error.code); expect(JSON.stringify(r.error.errors ?? [])).not.toContain('secret_table');
    expect(r.error.code).toBe('common.internal'); // 02-CONVENTIONS.md:416
  });
});
