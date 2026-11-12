// C10 T-05 — config handlers M23–M28, M39, M40 WITHOUT a database: contract pins on micro.yaml + permission/fail-closed behaviour of the handlers
// (06-IMPLEMENTATION-PLAN row T-05; 02-TRD §5.4; 07-SECURITY S-23, S-24, T-E1, T-E2; 08 A17 D-64).
// The DB behaviour (lazy settings row, shadowing, versioning, code_duplicate, SNOMED) is in config.handlers.integration.test.ts.
// SEAMS (same as lab T-29): handlers/<operationId>.ts (or one config.handlers.ts spread into REAL in handlers/index.ts) over service/config.service.ts;
//   permission = ctx.ports.IdentityPort.assertRole(ctx, { permission: <the operation's x-permission> }) as the FIRST step; a rejection (auth.forbidden) passes through.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError, LimsError } from '../../../../core/errors.js';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { handlers } from '../index.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'micro.yaml'));
const OPS = {
  listMicroCodedSet: { perm: 'micro.culture.read', idem: 'none' },
  upsertMicroCode: { perm: 'micro.config.manage', idem: 'optional' },
  listPlatingProtocols: { perm: 'micro.culture.read', idem: 'none' },
  createPlatingProtocol: { perm: 'micro.config.manage', idem: 'required' },
  versionPlatingProtocol: { perm: 'micro.config.manage', idem: 'required' },
  deactivatePlatingProtocol: { perm: 'micro.config.manage', idem: 'optional' },
  getMicroSettings: { perm: 'micro.culture.read', idem: 'none' },
  updateMicroSettings: { perm: 'micro.config.manage', idem: 'optional' },
} as const;
type Op = keyof typeof OPS;
const ids = Object.keys(OPS) as Op[];

const specOps = (): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const item of Object.values<any>(spec.paths)) for (const op of Object.values<any>(item)) if (op?.operationId) out[op.operationId] = op;
  return out;
};

describe('C10-T05 contract pins (micro.yaml)', () => {
  it.each(ids)('%s: single x-permission and idempotency class of TRD §5.4 (D-64: GETs = micro.culture.read only)', (id) => {
    const op = specOps()[id];
    expect(op, id).toBeDefined();
    expect(op['x-permission']).toBe(OPS[id].perm);
    expect(op['x-idempotency']).toBe(OPS[id].idem);
    expect(Object.keys(op).filter((k) => k === 'x-permissions')).toEqual([]);
  });

  it('M26/M27 declare micro.code_duplicate; M24/M27/M28/M40 require If-Match (M24 only when the row exists)', () => {
    const o = specOps();
    expect(o['createPlatingProtocol']['x-error-codes']).toContain('micro.code_duplicate');
    expect(o['versionPlatingProtocol']['x-error-codes']).toContain('micro.code_duplicate');
    for (const id of ['upsertMicroCode', 'versionPlatingProtocol', 'deactivatePlatingProtocol', 'updateMicroSettings']) {
      expect(o[id]['x-error-codes'], id).toContain('common.precondition_required');
      expect(o[id]['x-error-codes'], id).toContain('common.version_conflict');
    }
  });
});

// ------------------------------------------------------------------ driving a handler with a fake ctx (no database)
function ctxFor(operationId: string, grants: readonly string[]) {
  const queries: unknown[] = [];
  const roleCalls: { permission: string }[] = [];
  const tx = { query: async (...a: unknown[]) => { queries.push(a); return { rows: [], rowCount: 0 }; } };
  const ctx: any = {
    operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    tenantId: '01a1a98a-ac40-7000-8000-00000000a001', tx, requestId: '0190c607-0000-7000-8000-000000009001', now: () => new Date('2026-06-15T05:00:30.000Z'),
    actor: { type: 'user', id: '01a1b34e-1000-7eee-9d29-d7ca59a102b5', membershipId: '01a1a98a-ac40-7000-8000-00000000a500' },
    ports: { IdentityPort: {
      async assertRole(_c: unknown, x: { permission: string }) { roleCalls.push(x); if (!grants.includes(x?.permission)) throw new LimsError('auth.forbidden'); },
      async getActor() { return { actor: { type: 'user', id: 'x' }, permissions: [...grants], centreScope: { all: true, centreIds: [] }, isLocked: false }; },
    } },
    events: { publish: async () => ({ eventId: 'e', duplicate: false }) },
    audit: { access: async () => undefined },
  };
  return { ctx, queries, roleCalls };
}
const P = '01950c10-0000-7000-8000-000000000001';
const REQ: Record<Op, any> = {
  listMicroCodedSet: { params: { set_name: 'organisms' }, query: {}, headers: {}, body: undefined },
  upsertMicroCode: { params: { set_name: 'organisms', code: 'zt05_x' }, query: {}, headers: {}, body: { display: 'Synthetic', sort_order: 1, is_active: true } },
  listPlatingProtocols: { params: {}, query: {}, headers: {}, body: undefined },
  createPlatingProtocol: { params: {}, query: {}, headers: { 'idempotency-key': 'k1' }, body: { code: 'zt05_p', display: 'Synthetic', read_schedule_hours: [24, 48], final_no_growth_hours: 48, requires_gram_stain: false, media: [{ media_code: 'zt05_m' }], applies_to: [] } },
  versionPlatingProtocol: { params: { protocol_id: P }, query: {}, headers: { 'idempotency-key': 'k1', 'if-match': '"1"' }, body: { display: 'Synthetic', read_schedule_hours: [24, 48], final_no_growth_hours: 48, requires_gram_stain: false, media: [{ media_code: 'zt05_m' }], applies_to: [] } },
  deactivatePlatingProtocol: { params: { protocol_id: P }, query: {}, headers: { 'if-match': '"1"' }, body: {} },
  getMicroSettings: { params: {}, query: {}, headers: {}, body: undefined },
  updateMicroSettings: { params: {}, query: {}, headers: { 'if-match': '"1"' }, body: { zone_suggestion_enabled: true, mic_suggestion_enabled: false, default_final_no_growth_hours: 48, early_final_requires_reason: true, recent_window_days: 7 } },
};
const run = (id: Op, grants: readonly string[], req: any = REQ[id]) => {
  const c = ctxFor(id, grants);
  const p = (handlers as unknown as Record<string, (r: unknown, x: unknown) => Promise<unknown>>)[id]!(req, c.ctx);
  return { ...c, p };
};
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };

describe('C10-T05 permission is checked first, with the operation\'s x-permission (S-23, D-64)', () => {
  it.each(ids)('%s: no grant -> 403 auth.forbidden, assertRole asked for exactly its x-permission, no SQL, never the T-01 stub', async (id) => {
    const { p, roleCalls, queries } = run(id, []);
    const e = await failure(p);
    expect(isLimsError(e, 'auth.forbidden'), `${e?.code ?? e}`).toBe(true);
    expect(e.statusCode).toBe(403);
    expect(roleCalls.map((r) => r.permission)).toEqual([OPS[id].perm]);
    expect(queries).toEqual([]);
  });

  it.each(['listMicroCodedSet', 'listPlatingProtocols', 'getMicroSettings'] as Op[])('%s: micro.config.manage alone does not read (D-64: the read permission is the only one asked)', async (id) => {
    const { p, roleCalls } = run(id, ['micro.config.manage']);
    const e = await failure(p);
    expect(isLimsError(e, 'auth.forbidden')).toBe(true);
    expect(roleCalls.map((r) => r.permission)).toEqual(['micro.culture.read']);
  });

  it.each(['upsertMicroCode', 'createPlatingProtocol', 'versionPlatingProtocol', 'deactivatePlatingProtocol', 'updateMicroSettings'] as Op[])(
    '%s: micro.culture.read / micro.culture.work do not write (T-E1)', async (id) => {
      const { p } = run(id, ['micro.culture.read', 'micro.culture.work']);
      expect(isLimsError(await failure(p), 'auth.forbidden')).toBe(true);
    });
});

describe('C10-T05 review: no invented defaults for the NOT NULL set extras on insert (05-SCHEMA §8)', () => {
  it.each([
    ['growth_codes', { display: 'x', sort_order: 1, is_active: true }, '/indicates_growth'],
    ['culture_outcomes', { display: 'x', sort_order: 1, is_active: true, requires_isolate: false }, '/result_flag'],
    ['culture_outcomes', { display: 'x', sort_order: 1, is_active: true, result_flag: 'N' }, '/requires_isolate'],
  ])('M24 %s, no existing tenant row, missing extra -> 400 common.validation_failed %s / common.field_required, nothing inserted', async (set, body, path) => {
    const req = { ...REQ.upsertMicroCode, params: { set_name: set, code: 'zt05_x' }, body };
    const { p, queries } = run('upsertMicroCode', ['micro.config.manage'], req);
    const e = await failure(p);
    expect(isLimsError(e, 'common.validation_failed'), `${e?.code ?? e}`).toBe(true);
    expect(e.statusCode).toBe(400);
    expect(e.errors?.[0]).toMatchObject({ path, code: 'common.field_required' });
    expect(JSON.stringify(queries)).not.toMatch(/insert/i);
  });
});

describe('C10-T05 S-24 / T-E2: ast_interpretations is not writable', () => {
  it('PUT /coded-sets/ast_interpretations/codes/S with micro.config.manage -> 403 auth.forbidden, nothing queried for writing', async () => {
    const req = { ...REQ.upsertMicroCode, params: { set_name: 'ast_interpretations', code: 'S' }, body: { display: 'Susceptible', sort_order: 1, is_active: true } };
    const { p, queries } = run('upsertMicroCode', ['micro.config.manage'], req);
    const e = await failure(p);
    expect(isLimsError(e, 'auth.forbidden'), `${e?.code ?? e}`).toBe(true);
    expect(e.statusCode).toBe(403);
    expect(JSON.stringify(queries)).not.toMatch(/insert|update/i);
  });
});
