// T0D-BUILD-3 (LD-447, LD-189 AUTH SENSITIVE, CR DEPLOY-AXIS-012 item 8): identity listAccessReviews + recordAccessReview, built on the EXISTING table
// identity.access_reviews (db/migrations/20261105001300_identity__create_identity_schema.sql; no migration). Synthetic data only.
// What is pinned: contract shape (not edited), handlers wired (no longer 501), x-permission guard FIRST, tenant scope, newest first, reviewer from the
// caller's own membership (never the body), clock from the server, schema limits, audit entry without the notes text, idempotent replay / key reuse
// through the REAL core idempotency hook (core/idempotency.ts) around the REAL handler.
// The fake below is ONE Postgres transaction by SQL CONTENT (same convention as audit-view.helpers.ts): RLS is OFF, so a SELECT without a
// `tenant_id = $n` predicate sees every tenant; the table is append-only (the RLS policies give select + insert only), so any UPDATE/DELETE on it throws.
// Modelled: INSERT INTO identity.access_reviews (cols) VALUES (tokens) [RETURNING ..]; SELECT .. FROM identity.access_reviews WHERE tenant_id = $n
// [ORDER BY reviewed_at DESC [, id DESC]] [LIMIT $n|int]; `col AS alias`. now()/clock_timestamp()/DEFAULT in VALUES = the fake clock. Anything else answers [].
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../core/errors.js';
import { createIdempotency } from '../../../core/idempotency.js';
import { createIdemEnv, serve, tenantClaims, makeReq } from '../../../core/__tests__/idempotency-helpers.js';
import { handlers } from '../handlers/index.js';
import { manifest } from '../index.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const spec: any = parse(readFileSync(join(ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
const SEED_ACTIONS = new Set([...readFileSync(join(ROOT, 'db', 'seeds', '003_audit__g_cs_access_actions.sql'), 'utf8').matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!));
const opMeta = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any }>>;

const idn = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const TENANT_A = idn(0xaaaa);
const TENANT_B = idn(0xbbbb);
const USER_A = idn(0x4001);
const MEM_A = idn(0x3001);     // the caller
const MEM_A2 = idn(0x3002);    // a colleague in tenant A
const MEM_B = idn(0x30b1);     // a member of tenant B
const CLOCK = '2026-11-22T08:30:00.000Z';
const NOTES = 'NOTES-SENTINEL-quarterly-review-7731';
const PLANTED = 'PLANTED-TOKEN-b3c1';
const OLD = '2020-01-01T00:00:00.000Z';

type Row = Record<string, any>;
const review = (n: number, over: Row = {}): Row => ({
  id: idn(0x5000 + n), tenant_id: TENANT_A, reviewed_by_membership_id: MEM_A2, memberships_reviewed: n, notes: null,
  reviewed_at: new Date(Date.UTC(2026, 9, n, 4, 15)), created_at: new Date(Date.UTC(2026, 9, n, 4, 15)), created_by: idn(0x4002), ...over,
});

function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0; let q = false; let cur = '';
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && depth === 0 && ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

function makeEnv(seed: Row[] = [], o: { grants?: string[]; failAudit?: boolean } = {}) {
  const store: Row[] = seed.map((r) => ({ ...r }));
  const stmts: Array<{ text: string; values: readonly unknown[]; verb: string; tenantPredicate: boolean }> = [];
  const accessCalls: Row[] = [];
  const logCalls: unknown[] = [];
  const asserted: Array<{ permission: string; stmtsBefore: number }> = [];
  const grants = new Set(o.grants ?? ['identity.user.read', 'identity.user.manage']);
  let seq = 0xa000;

  const tx = {
    async query(text: string, values: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
      const verb = (/^\s*(select|insert|update|delete|with)/i.exec(text)?.[1] ?? 'other').toLowerCase();
      const stmt = { text, values, verb, tenantPredicate: /\btenant_id\s*=\s*\$\d+/.test(text) };
      stmts.push(stmt);
      const mentions = /identity\.access_reviews/i.test(text);
      if (mentions && (verb === 'update' || verb === 'delete')) throw pgError('42501', 'access_reviews is append-only (RLS select + insert only)');
      if (mentions && verb === 'insert') return insert(text, values);
      if (mentions && (verb === 'select' || verb === 'with')) return select(text, values);
      return { rows: [], rowCount: 0 };
    },
  };
  function token(t: string, values: readonly unknown[]): unknown {
    const p = /^\$(\d+)/.exec(t);
    if (p) return values[Number(p[1]) - 1];
    if (/^(now\(\)|clock_timestamp\(\)|statement_timestamp\(\)|current_timestamp|transaction_timestamp\(\))/i.test(t)) return new Date(CLOCK);
    if (/^default$/i.test(t)) return undefined;
    if (/uuid/i.test(t)) return idn(++seq);
    if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
    if (/^-?\d+$/.test(t)) return Number(t);
    return t;
  }
  function insert(text: string, values: readonly unknown[]) {
    const m = /insert\s+into\s+identity\.access_reviews\s*\(([^)]*)\)\s*values\s*\(([\s\S]*?)\)\s*(returning[\s\S]*)?$/i.exec(text.replace(/;\s*$/, ''));
    if (!m) throw new Error(`unmodelled INSERT into identity.access_reviews (the fake supports INSERT .. (cols) VALUES (..) [RETURNING ..]): ${text.slice(0, 160)}`);
    const cols = m[1]!.split(',').map((c) => c.trim().replace(/"/g, ''));
    const toks = splitTop(m[2]!);
    const row: Row = {};
    cols.forEach((c, i) => { const v = token(toks[i] ?? 'DEFAULT', values); if (v !== undefined) row[c] = v; });
    row['id'] ??= idn(++seq);
    row['reviewed_at'] ??= new Date(CLOCK);
    row['created_at'] ??= new Date(CLOCK);
    for (const c of ['tenant_id', 'reviewed_by_membership_id', 'memberships_reviewed', 'created_by']) if (row[c] === undefined || row[c] === null) throw pgError('23502', `null value in column ${c}`);
    if (row['tenant_id'] !== TENANT_A && row['tenant_id'] !== TENANT_B) throw pgError('23503', 'tenant fk');
    const members = row['tenant_id'] === TENANT_A ? [MEM_A, MEM_A2] : [MEM_B];
    if (!members.includes(row['reviewed_by_membership_id'])) throw pgError('23503', 'access_reviews__reviewer__fk');
    if (!Number.isInteger(row['memberships_reviewed']) || row['memberships_reviewed'] < 0) throw pgError('23514', 'access_reviews__count__ck');
    if (row['notes'] != null && String(row['notes']).length > 2000) throw pgError('23514', 'access_reviews__notes__ck');
    store.push(row);
    return { rows: m[3] ? [alias(m[3], row)] : [], rowCount: 1 };
  }
  function alias(sqlFragment: string, r: Row): Row {
    const out = { ...r };
    for (const a of sqlFragment.matchAll(/(?:\b\w+\.)?(\w+)\s+AS\s+"?(\w+)"?/gi)) if (a[1]! in r) out[a[2]!] = r[a[1]!];
    return out;
  }
  function select(text: string, values: readonly unknown[]) {
    let rows = store.map((r) => ({ ...r }));
    for (const m of text.matchAll(/(?:\b\w+\.)?tenant_id\s*=\s*\$(\d+)/g)) rows = rows.filter((r) => r['tenant_id'] === values[Number(m[1]) - 1]);
    const ord = /order\s+by\s+(?:\w+\.)?reviewed_at\s+(asc|desc)/i.exec(text);
    if (ord) {
      const dir = ord[1]!.toLowerCase() === 'desc' ? -1 : 1;
      rows.sort((a, b) => dir * ((+a['reviewed_at'] - +b['reviewed_at']) || (a['id'] < b['id'] ? -1 : a['id'] > b['id'] ? 1 : 0)));
    }
    const lim = /\blimit\s+(?:\$(\d+)|(\d+))/i.exec(text);
    if (lim) rows = rows.slice(0, lim[1] ? Number(values[Number(lim[1]) - 1]) : Number(lim[2]));
    return { rows: rows.map((r) => alias(text, r)), rowCount: rows.length };
  }
  const audit = {
    async access(entry: Row) {
      if (o.failAudit) throw pgError('XX000', 'access log write failed');
      accessCalls.push({ ...entry });
    },
  };
  const logger = new Proxy({}, { get: () => (...a: unknown[]) => { logCalls.push(a); return logger; } }) as any;
  const ctx = (c: { tenantId?: string; actor?: Row | null; headers?: Row } = {}) => ({
    operationId: 'test', clientIp: '203.0.113.9', log: logger, requestId: idn(0xf1), tenantId: c.tenantId ?? TENANT_A,
    ...(c.actor === null ? {} : { actor: c.actor ?? { type: 'user', id: USER_A, membershipId: MEM_A } }),
    centreScope: { all: true, centreIds: [] }, now: () => new Date(CLOCK), tx, audit,
    ports: {
      IdentityPort: {
        assertRole: async (_c: unknown, r: { permission: string }) => {
          asserted.push({ permission: r.permission, stmtsBefore: stmts.length });
          if (!grants.has(r.permission)) throw new LimsError('auth.forbidden');
        },
      },
    },
  });
  const reviews = () => store.filter((r) => true);
  return { ctx, store, stmts, accessCalls, logCalls, asserted, reviews, writes: () => stmts.filter((s) => s.verb !== 'select' && /access_reviews/i.test(s.text)) };
}
type Env = ReturnType<typeof makeEnv>;

const req = (o: { body?: unknown; query?: Row; params?: Row } = {}) => ({ params: o.params ?? {}, query: o.query ?? {}, headers: {}, body: o.body });
const rejects = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } return undefined; };
const wire = (v: unknown) => JSON.parse(JSON.stringify(v));
const record = (env: Env, body: unknown, c: Parameters<Env['ctx']>[0] = {}) => H['recordAccessReview']!(req({ body }), env.ctx(c));
const list = (env: Env, c: Parameters<Env['ctx']>[0] = {}, q: Row = {}) => H['listAccessReviews']!(req({ query: q }), env.ctx(c));

// ---------------------------------------------------------------------------------------------------------------- contract (read, not edited)
describe('contract: identity.yaml is used as written', () => {
  it('listAccessReviews: GET /v1/identity/access-reviews, identity.user.read, tenant, no idempotency, AccessReviewList (data only, max 200, no paging inputs)', () => {
    const m = opMeta('listAccessReviews');
    expect(m['x-permission']).toBe('identity.user.read');
    expect(m['x-context']).toBe('tenant');
    expect(m['x-idempotency']).toBe('none');
    expect(spec.paths['/v1/identity/access-reviews'].get).toBe(m);
    expect(m.parameters ?? []).toEqual([]);
    const l = spec.components.schemas.AccessReviewList;
    expect(Object.keys(l.properties)).toEqual(['data']);
    expect(l.properties.data.maxItems).toBe(200);
  });
  it('recordAccessReview: POST, identity.user.manage, Idempotency-Key required, 201 AccessReview, error common.idempotency_key_reused', () => {
    const m = opMeta('recordAccessReview');
    expect(spec.paths['/v1/identity/access-reviews'].post).toBe(m);
    expect(m['x-permission']).toBe('identity.user.manage');
    expect(m['x-idempotency']).toBe('required');
    expect(m['x-error-codes']).toContain('common.idempotency_key_reused');
    expect(m.responses['201'].content['application/json'].schema.$ref).toMatch(/AccessReview$/);
    const rq = spec.components.schemas.AccessReviewCreateRequest;
    expect(rq.required).toEqual(['memberships_reviewed']);
    expect(rq.additionalProperties).toBe(false);
    expect(rq.properties.memberships_reviewed).toMatchObject({ type: 'integer', minimum: 0, maximum: 100000 });
    expect(rq.properties.notes).toMatchObject({ type: 'string', maxLength: 2000 });
  });
});

// ---------------------------------------------------------------------------------------------------------------- wiring
describe('wiring: both operations are built (no longer 501 operation_pending)', () => {
  it.each(['listAccessReviews', 'recordAccessReview'])('%s is a handler and is not in manifest.pendingOperations', async (op) => {
    expect(typeof H[op]).toBe('function');
    expect(((manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? [])).not.toContain(op);
  });
  it('a permitted list call answers 200, not 501', async () => {
    const r = await list(makeEnv());
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------- guard (SEC-AUTHZ-4 / LD-189)
describe('x-permission guard comes first', () => {
  it('listAccessReviews asks identity.user.read BEFORE any statement; a caller without it gets auth.forbidden and nothing is read', async () => {
    const env = makeEnv([review(1)], { grants: ['identity.user.manage'] });
    const e = await rejects(list(env));
    expect(e?.code).toBe('auth.forbidden');
    expect(env.asserted[0]).toEqual({ permission: 'identity.user.read', stmtsBefore: 0 });
    expect(env.stmts).toEqual([]);
  });
  it('recordAccessReview asks identity.user.manage BEFORE any statement; a READ-ONLY caller cannot record: auth.forbidden, no insert, no audit', async () => {
    const env = makeEnv([], { grants: ['identity.user.read'] });
    const e = await rejects(record(env, { memberships_reviewed: 3, notes: NOTES }));
    expect(e?.code).toBe('auth.forbidden');
    expect(e?.statusCode).toBe(403);
    expect(env.asserted[0]).toEqual({ permission: 'identity.user.manage', stmtsBefore: 0 });
    expect(env.stmts).toEqual([]);
    expect(env.store).toEqual([]);
    expect(env.accessCalls).toEqual([]);
  });
  it('a read-only caller can still list (read is not manage)', async () => {
    const env = makeEnv([review(1)], { grants: ['identity.user.read'] });
    expect((await list(env)).body.data).toHaveLength(1);
  });
  it('invalid input never beats the guard: a forbidden caller with a bad body gets auth.forbidden, not a validation error', async () => {
    const env = makeEnv([], { grants: [] });
    expect((await rejects(record(env, { memberships_reviewed: -5 })))?.code).toBe('auth.forbidden');
  });
  it.each(['listAccessReviews', 'recordAccessReview'])('%s fails closed without a request context (no ports, tx, tenant or actor): never 2xx, never echoes input', async (op) => {
    const e = await rejects(H[op]!({ params: { x: PLANTED }, query: { q: PLANTED }, headers: { authorization: PLANTED }, body: { notes: PLANTED, memberships_reviewed: 1 } },
      { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e, 'must throw').toBeTruthy();
    expect(['auth.unauthenticated', 'common.internal']).toContain(e.code);
    expect(String(e.message)).not.toContain(PLANTED);
  });
  it.each(['listAccessReviews', 'recordAccessReview'])('%s with a granted guard but no authenticated actor/tx: auth.unauthenticated, nothing written', async (op) => {
    const env = makeEnv();
    const c: any = env.ctx({ actor: null });
    const e = await rejects(H[op]!(req({ body: { memberships_reviewed: 1 } }), c));
    expect(e?.code).toBe('auth.unauthenticated');
    expect(env.writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------- list
describe('listAccessReviews', () => {
  it('empty tenant: 200 with {data: []} exactly (never 404/500, no extra keys)', async () => {
    const r = await list(makeEnv());
    expect(r.status).toBe(200);
    expect(wire(r.body)).toEqual({ data: [] });
  });
  it('newest first (reviewed_at DESC) and each item has exactly the AccessReview fields; null notes are omitted, set notes are kept; ISO UTC strings on the wire', async () => {
    const env = makeEnv([review(1), review(3, { notes: 'q3' }), review(2)]);
    const r = await list(env);
    const body = wire(r.body);
    expect(body.data.map((d: any) => d.memberships_reviewed)).toEqual([3, 2, 1]);
    const allowed = new Set(Object.keys(spec.components.schemas.AccessReview.properties));
    for (const d of body.data) {
      expect(Object.keys(d).every((k) => allowed.has(k)), JSON.stringify(Object.keys(d))).toBe(true);
      for (const k of spec.components.schemas.AccessReview.required) expect(d[k], k).toBeDefined();
      expect(d.reviewed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    }
    expect(body.data[0]).toMatchObject({ access_review_id: idn(0x5003), reviewed_by_membership_id: MEM_A2, notes: 'q3' });
    expect(body.data[1].notes).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/tenant_id|created_by/);
  });
  it('other tenant: only the caller tenant rows are returned; tenant_id in params / query is ignored; the SELECT carries a tenant predicate', async () => {
    const env = makeEnv([review(1), review(2, { tenant_id: TENANT_B, reviewed_by_membership_id: MEM_B, notes: 'TENANT-B-SECRET' })]);
    const r = await H['listAccessReviews']!(req({ params: { tenant_id: TENANT_B }, query: { tenant_id: TENANT_B } }), env.ctx());
    expect(r.body.data.map((d: any) => d.access_review_id)).toEqual([idn(0x5001)]);
    expect(JSON.stringify(r.body)).not.toContain('TENANT-B-SECRET');
    expect(env.stmts.filter((s) => s.verb === 'select' && /access_reviews/i.test(s.text)).every((s) => s.tenantPredicate)).toBe(true);
    const b = await list(env, { tenantId: TENANT_B, actor: { type: 'user', id: idn(0x40b1), membershipId: MEM_B } });
    expect(b.body.data.map((d: any) => d.access_review_id)).toEqual([idn(0x5002)]);
  });
  it('more than 200 reviews: at most 200 (the contract cap), still newest first', async () => {
    const env = makeEnv(Array.from({ length: 205 }, (_, i) => review(1000 + i, { memberships_reviewed: i, reviewed_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000) })));
    const r = await list(env);
    expect(r.body.data).toHaveLength(200);
    expect(r.body.data[0].memberships_reviewed).toBe(204);
    expect(r.body.data[199].memberships_reviewed).toBe(5);
  });
  it('junk query values never produce a 5xx (ignored or a typed 4xx)', async () => {
    let ok: { status: number } | undefined;
    const e = await rejects((async () => { ok = await list(makeEnv([review(1)]), {}, { limit: 'abc', cursor: PLANTED, sort: "'; drop table x;--" }); })());
    if (!e) expect(ok?.status).toBe(200);
    if (e) { expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500); expect(String(e.message)).not.toContain(PLANTED); }
  });
  it('read only: a list issues no write statement and no audit entry beyond reads', async () => {
    const env = makeEnv([review(1)]);
    expect((await list(env)).status).toBe(200);
    expect(env.stmts.length).toBeGreaterThan(0);
    expect(env.writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------- record
describe('recordAccessReview', () => {
  it('201 AccessReview: reviewer = the CALLER membership, tenant = the caller tenant, count and notes stored, reviewed_at = the server clock', async () => {
    const env = makeEnv();
    const r = await record(env, { memberships_reviewed: 12, notes: NOTES });
    expect(r.status).toBe(201);
    const b = wire(r.body);
    expect(b).toMatchObject({ reviewed_by_membership_id: MEM_A, memberships_reviewed: 12, notes: NOTES, reviewed_at: CLOCK });
    expect(b.access_review_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const allowed = new Set(Object.keys(spec.components.schemas.AccessReview.properties));
    expect(Object.keys(b).every((k) => allowed.has(k)), JSON.stringify(Object.keys(b))).toBe(true);
    expect(env.store).toHaveLength(1);
    expect(env.store[0]).toMatchObject({ tenant_id: TENANT_A, reviewed_by_membership_id: MEM_A, memberships_reviewed: 12, notes: NOTES, id: b.access_review_id });
    expect(+new Date(env.store[0]!['reviewed_at'])).toBe(Date.parse(CLOCK));
    expect(env.store[0]!['created_by']).toBe(USER_A);
  });
  it('no notes: the stored note is empty and the answer has no notes key', async () => {
    const env = makeEnv();
    const r = await record(env, { memberships_reviewed: 0 });
    expect(r.status).toBe(201);
    expect(wire(r.body).notes).toBeUndefined();
    expect(env.store[0]!['notes'] ?? null).toBeNull();
    expect(wire(r.body).memberships_reviewed).toBe(0);
  });
  it('body smuggling: reviewer, tenant, id, time and created_by in the body are rejected (validation) or ignored; the row always carries the caller values and the server clock', async () => {
    const env = makeEnv();
    const sm = { memberships_reviewed: 4, reviewed_by_membership_id: MEM_A2, tenant_id: TENANT_B, reviewed_at: OLD, access_review_id: idn(0x9999), id: idn(0x9998), created_by: idn(0x9997) };
    const e = await rejects(record(env, sm));
    if (e) {
      expect(e.code).toBe('common.validation_failed');
      expect(env.store).toEqual([]);
    } else {
      expect(env.store).toHaveLength(1);
      expect(env.store[0]).toMatchObject({ tenant_id: TENANT_A, reviewed_by_membership_id: MEM_A, created_by: USER_A });
      expect(env.store[0]!['id']).not.toBe(idn(0x9999));
      expect(env.store[0]!['id']).not.toBe(idn(0x9998));
      expect(+new Date(env.store[0]!['reviewed_at'])).toBe(Date.parse(CLOCK));
    }
  });
  it('a caller without a membership on the session (no actor.membershipId) gets a typed 4xx, nothing is written', async () => {
    const env = makeEnv();
    const e = await rejects(record(env, { memberships_reviewed: 1 }, { actor: { type: 'user', id: USER_A } }));
    expect(e, 'must reject').toBeTruthy();
    expect(e.statusCode).toBeGreaterThanOrEqual(400);
    expect(e.statusCode).toBeLessThan(500);
    expect(env.store).toEqual([]);
  });
  it('record then list: the new review is first, by the caller, with the count; a second record goes on top', async () => {
    const env = makeEnv([review(1)]);
    await record(env, { memberships_reviewed: 7, notes: 'first' });
    const l1 = await list(env);
    expect(wire(l1.body).data.map((d: any) => d.memberships_reviewed)).toEqual([7, 1]);
    expect(wire(l1.body).data[0]).toMatchObject({ reviewed_by_membership_id: MEM_A, notes: 'first', reviewed_at: CLOCK });
    const b = await record(env, { memberships_reviewed: 8 }, { actor: { type: 'user', id: idn(0x4002), membershipId: MEM_A2 } });
    expect(b.status).toBe(201);
    const l2 = await list(env);
    expect(l2.body.data).toHaveLength(3);
    expect(wire(l2.body).data[0]).toMatchObject({ memberships_reviewed: 8, reviewed_by_membership_id: MEM_A2 });
  });
  it('another tenant never sees the review; the record is stored under the CALLER tenant', async () => {
    const env = makeEnv();
    await record(env, { memberships_reviewed: 5, notes: NOTES });
    const b = await list(env, { tenantId: TENANT_B, actor: { type: 'user', id: idn(0x40b1), membershipId: MEM_B } });
    expect(b.body.data).toEqual([]);
    expect((await list(env)).body.data).toHaveLength(1);
  });

  describe('bad input: validation_failed (4xx), nothing stored, no audit', () => {
    const bad: Array<[string, unknown]> = [
      ['count -1', { memberships_reviewed: -1 }],
      ['count 100001', { memberships_reviewed: 100001 }],
      ['count 1.5', { memberships_reviewed: 1.5 }],
      ['count as text', { memberships_reviewed: '12' }],
      ['count null', { memberships_reviewed: null }],
      ['count missing', { notes: 'x' }],
      ['count true', { memberships_reviewed: true }],
      ['count NaN as text', { memberships_reviewed: 'NaN' }],
      ['count array', { memberships_reviewed: [1] }],
      ['count object', { memberships_reviewed: { n: 1 } }],
      ['notes 2001 chars', { memberships_reviewed: 1, notes: 'n'.repeat(2001) }],
      ['notes a number', { memberships_reviewed: 1, notes: 123 }],
      ['notes an object', { memberships_reviewed: 1, notes: { a: 1 } }],
      ['body missing', undefined],
      ['body null', null],
      ['body a string', 'memberships_reviewed=3'],
      ['body an array', [{ memberships_reviewed: 3 }]],
    ];
    it.each(bad)('%s', async (_n, body) => {
      const env = makeEnv();
      const e = await rejects(record(env, body));
      expect(e, 'must reject').toBeTruthy();
      expect(e.code).toBe('common.validation_failed');
      expect(e.statusCode).toBeGreaterThanOrEqual(400);
      expect(e.statusCode).toBeLessThan(500);
      expect(env.store).toEqual([]);
      expect(env.accessCalls).toEqual([]);
    });
    it('the error never echoes the notes text', async () => {
      const env = makeEnv();
      const e = await rejects(record(env, { memberships_reviewed: -1, notes: NOTES }));
      expect(JSON.stringify(e, Object.getOwnPropertyNames(e))).not.toContain(NOTES);
    });
  });
  describe('limits that are valid', () => {
    it.each([0, 1, 100000])('count %i is accepted', async (n) => {
      expect((await record(makeEnv(), { memberships_reviewed: n })).status).toBe(201);
    });
    it('notes of exactly 2000 characters are accepted and stored whole', async () => {
      const env = makeEnv();
      const notes = 'n'.repeat(2000);
      expect((await record(env, { memberships_reviewed: 1, notes })).status).toBe(201);
      expect(env.store[0]!['notes']).toBe(notes);
    });
  });

  describe('audit (LD-189): an entry is written, never with the notes text', () => {
    it('one access/audit entry for the review: outcome allowed, subject = the new review, action from the seeded access-action list, no notes anywhere', async () => {
      const env = makeEnv();
      const r = await record(env, { memberships_reviewed: 9, notes: NOTES });
      expect(env.accessCalls).toHaveLength(1);
      const a = env.accessCalls[0]!;
      expect(a['outcome']).toBe('allowed');
      expect(SEED_ACTIONS.has(a['action']), `action ${a['action']} must be in db/seeds/003_audit__g_cs_access_actions.sql (P-3); if none fits, write notes/T0D-BUILD-3-left.md and a CR`).toBe(true);
      expect(a['entityId']).toBe(wire(r.body).access_review_id);
      expect(JSON.stringify(a)).not.toContain(NOTES);
      expect(JSON.stringify(env.logCalls)).not.toContain(NOTES);
    });
    it('the notes text is a bound parameter, never part of any SQL text (injection)', async () => {
      const env = makeEnv();
      const evil = `${NOTES}'); DROP TABLE identity.access_reviews;--`;
      expect((await record(env, { memberships_reviewed: 1, notes: evil })).status).toBe(201);
      expect(env.stmts.some((s) => s.text.includes('DROP TABLE') || s.text.includes(NOTES))).toBe(false);
      expect(env.stmts.some((s) => s.values.includes(evil))).toBe(true);
      expect(env.store[0]!['notes']).toBe(evil);
    });
    it('the audit write fails: the handler rejects (never a 2xx without its audit entry)', async () => {
      const env = makeEnv([], { failAudit: true });
      const e = await rejects(record(env, { memberships_reviewed: 2, notes: NOTES }));
      expect(e, 'must reject').toBeTruthy();
      expect(JSON.stringify(e, Object.getOwnPropertyNames(e))).not.toContain(NOTES);
    });
    it('the log lines of a successful record carry no notes text', async () => {
      const env = makeEnv();
      expect((await record(env, { memberships_reviewed: 2, notes: NOTES })).status).toBe(201);
      expect(JSON.stringify(env.logCalls)).not.toContain(NOTES);
    });
  });

  it('append only: record issues exactly one INSERT on identity.access_reviews and no UPDATE or DELETE', async () => {
    const env = makeEnv([review(1)]);
    await record(env, { memberships_reviewed: 2 });
    const w = env.writes();
    expect(w.map((s) => s.verb)).toEqual(['insert']);
  });
});

// ---------------------------------------------------------------------------------------------------------------- idempotency (REAL core hook around the REAL handler)
describe('Idempotency-Key (core/idempotency.ts around recordAccessReview, operation taken from the contract)', () => {
  const m = opMeta('recordAccessReview');
  const operation = { module: 'identity', operationId: 'recordAccessReview', context: m['x-context'], idempotency: m['x-idempotency'] };
  const mk = () => {
    const idemEnv = createIdemEnv({ servers: 4 });
    const idem = createIdempotency({ db: idemEnv.db, now: idemEnv.now } as any) as any;
    const env = makeEnv();
    const go = (key: string | undefined, body: unknown) => serve(idemEnv, idem,
      makeReq({ operation, routeTemplate: '/v1/identity/access-reviews', body, idempotencyKey: key, claims: tenantClaims() }),
      async () => { const r = await record(env, body); return { status: r.status, body: wire(r.body) }; });
    return { env, go };
  };
  it('same key + same body: the first answer is replayed, the handler does not run again, ONE review is stored', async () => {
    const { env, go } = mk();
    const a = await go('key-ar-0001', { memberships_reviewed: 12, notes: 'q' });
    expect(a.status).toBe(201);
    const b = await go('key-ar-0001', { memberships_reviewed: 12, notes: 'q' });
    expect(b.replayed).toBe(true);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(env.store).toHaveLength(1);
  });
  it('same key + a different body: common.idempotency_key_reused (422), nothing new stored', async () => {
    const { env, go } = mk();
    await go('key-ar-0002', { memberships_reviewed: 12, notes: 'q' });
    const c = await go('key-ar-0002', { memberships_reviewed: 13, notes: 'q' });
    expect(c.status).toBe(422);
    expect(c.error?.code).toBe('common.idempotency_key_reused');
    expect(c.ran).toBe(false);
    expect(env.store).toHaveLength(1);
  });
  it('no Idempotency-Key: 400 common.idempotency_key_required, handler not run', async () => {
    const { env, go } = mk();
    const d = await go(undefined, { memberships_reviewed: 1 });
    expect(d.status).toBe(400);
    expect(d.error?.code).toBe('common.idempotency_key_required');
    expect(env.store).toEqual([]);
  });
  it('a new key with the same body is a new review (the key, not the body, identifies the attempt)', async () => {
    const { env, go } = mk();
    await go('key-ar-0003', { memberships_reviewed: 5 });
    await go('key-ar-0004', { memberships_reviewed: 5 });
    expect(env.store).toHaveLength(2);
  });
});
