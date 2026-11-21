// SEC-AUTHZ-6 (LD-189 AUTH-SENSITIVE, LD-261; SEC-AUTHZ-1.1 approved design): behaviour matrix of the 13 payments operations that the classifier snapshot shows
// as `unguarded`: reconciliation (5), static QR reconciliation (3), merchant accounts and payment settings (5). Their logic lives in the services
// (reconciliation.service.ts, staticqr.service.ts, merchant.service.ts; the manifest handlers are still 503 placeholders), so the service function is the
// unit under test. Central stage 8a is NOT in play (LIMS_CORE_AUTHZ_MODE stays shadow). Pinned interface (same as the payments intent handlers and the
// catalog guards): the FIRST statement of each service function is
//   ctx.ports.IdentityPort.assertRole(ctx, { permission })
// before input validation, actor-type checks, tx, events or jobs. It throws auth.forbidden | auth.mfa_required | identity.support_session_required and
// the service lets that through unchanged (no new error code). A context without IdentityPort.assertRole fails closed with a LimsError, nothing read.
// Expected permission = the contract x-permission, unless the operation is in authz-exceptions.json (then its handlerPermission) or named in a SEC-AUTHZ-6
// change request. Payment provider callbacks (scheme-callback-token: launchEsewaPayment, esewaSuccessCallback, esewaFailureCallback, khaltiReturnCallback)
// and the public result page are NOT guarded here (checked below: they do not ask IdentityPort). Intent and refund operations that are already
// guarded-exact (listPaymentIntents, approvePaymentRefund, ...) keep their rules and tests. No contract, permission registry, role pack or SQL file changes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../core/errors.js';
import { createMerchantService } from '../service/merchant.service.js';
import { createReconciliationService } from '../service/reconciliation.service.js';
import { createStaticQrService } from '../service/staticqr.service.js';
import { handlers } from '../handlers/index.js';

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const spec: any = parse(readFileSync(join(ROOT, 'contracts', 'openapi', 'payments.yaml'), 'utf8'));
const xPerm: Record<string, string> = {};
const schemes: Record<string, string[]> = {};
for (const item of Object.values<any>(spec.paths)) {
  for (const op of Object.values<any>(item)) {
    if (op && typeof op === 'object' && op.operationId) {
      if (op['x-permission']) xPerm[op.operationId] = op['x-permission'];
      schemes[op.operationId] = (op.security ?? []).flatMap((s: any) => Object.keys(s));
    }
  }
}
const packs: any = parse(readFileSync(join(ROOT, 'contracts', 'permissions.yaml'), 'utf8'));
const roleGrants = new Map<string, Set<string>>();
for (const p of packs.permissions as Array<{ code: string; roles?: string[] }>) for (const r of p.roles ?? []) (roleGrants.get(r) ?? roleGrants.set(r, new Set()).get(r)!).add(p.code);
const holders = (perm: string): string[] => (packs.permissions as Array<{ code: string; roles?: string[] }>).find((p) => p.code === perm)?.roles ?? [];

const exceptionsPath = join(ROOT, 'services', 'api', 'src', 'core', 'pipeline', 'authz-exceptions.json');
const exceptions: Array<{ operationId: string; handlerPermission: string }> = existsSync(exceptionsPath) ? JSON.parse(readFileSync(exceptionsPath, 'utf8')) : [];
const crDir = join(ROOT, '.orchestra', 'cr');
const crText = existsSync(crDir) ? readdirSync(crDir).filter((f) => /^SEC-AUTHZ-6.*\.md$/.test(f)).map((f) => readFileSync(join(crDir, f), 'utf8')).join('\n') : '';
const expectedPermission = (op: string): string | undefined => {
  const ex = exceptions.find((e) => e.operationId === op);
  if (ex) return ex.handlerPermission;
  if (new RegExp(`\\b${op}\\b`).test(crText)) return undefined;
  return xPerm[op];
};

const TENANT = '0190a000-0000-7000-8000-00000000aaaa';
const ACTOR = '0190a000-0000-7000-8000-000000004001';
const ID = '0190a000-0000-7000-8000-000000009001';

// the three services built with inert deps: a denied call must not reach any of them.
const deps: any = { config: {}, kek: {}, adapters: { esewa: {}, khalti: {} }, events: { publish: vi.fn(async () => undefined) }, jobs: { enqueue: vi.fn(async () => undefined) }, newId: () => ID };
const recon = createReconciliationService(deps);
const qr = createStaticQrService({ newId: () => ID });
const merchant = createMerchantService({ config: {} as any, kek: {} as any });
const CALLS: Record<string, (ctx: any) => Promise<unknown>> = {
  listReconciliationRuns: (c) => recon.listReconciliationRuns(c, {}),
  startReconciliationRun: (c) => recon.startReconciliationRun(c, {}),
  getReconciliationRun: (c) => recon.getReconciliationRun(c, { run_id: ID }),
  listReconciliationFindings: (c) => recon.listReconciliationFindings(c, {}),
  resolveReconciliationFinding: (c) => recon.resolveReconciliationFinding(c, { finding_id: ID, body: {} }),
  listStaticQrReconciliations: (c) => qr.listStaticQrReconciliations(c, {}),
  createStaticQrReconciliation: (c) => qr.createStaticQrReconciliation(c, {}),
  previewStaticQrReconciliation: (c) => qr.previewStaticQrReconciliation(c, {}),
  listMerchantAccounts: (c) => merchant.listMerchantAccounts(c),
  putMerchantAccount: (c) => merchant.putMerchantAccount(c, { gateway: 'esewa', environment: 'uat', expectedVersion: 1, body: {} }),
  testMerchantAccount: (c) => merchant.testMerchantAccount(c, { gateway: 'esewa', environment: 'uat' }),
  getPaymentSettings: (c) => merchant.getPaymentSettings(c),
  updatePaymentSettings: (c) => merchant.updatePaymentSettings(c, { expectedVersion: 1, body: {} }),
};
export const GROUP = Object.keys(CALLS);

function rig(actorType: string, assertRole: (ctx: any, r: { permission: string }) => Promise<unknown>, withPort = true) {
  const log: string[] = [];
  const query = vi.fn(async () => { log.push('data'); return { rows: [], rowCount: 0 }; });
  const asserted: string[] = [];
  const assert = vi.fn(async (ctx: any, r: { permission: string }) => { log.push('assert'); asserted.push(r?.permission); return assertRole(ctx, r); });
  const touch = (name: string) => new Proxy({}, {
    get: (_t, p) => { if (typeof p === 'symbol' || p === 'then') return undefined; log.push('data'); return p === 'query' ? query : vi.fn(async () => { log.push(name); return { rows: [], rowCount: 0 }; }); },
  });
  deps.events.publish.mockClear(); deps.jobs.enqueue.mockClear();
  const ctx: any = {
    tenantId: TENANT, actor: { type: actorType, id: ACTOR, membershipId: ID }, sessionId: ID, requestId: ID, now: () => '2026-11-19T00:00:00.000Z',
    tx: touch('tx'), audit: touch('audit'),
    ports: withPort ? { IdentityPort: { assertRole: assert }, BillingPort: touch('billing'), FrontdeskPort: touch('frontdesk') } : {},
  };
  return { ctx, log, query, assert, asserted };
}
const run = async (op: string, ctx: any) => { try { await CALLS[op]!(ctx); return undefined; } catch (e) { return e as any; } };
const denyAll = (code = 'auth.forbidden') => async () => { throw new LimsError(code); };
const grantOnly = (granted: Set<string>) => async (_c: any, r: { permission: string }) => { if (!granted.has(r.permission)) throw new LimsError('auth.forbidden'); };
const noData = (r: ReturnType<typeof rig>, op: string) => {
  expect(r.log.filter((x) => x !== 'assert'), `${op}: no data read or written before/without the guard`).toEqual([]);
  expect(deps.events.publish, `${op}: no event`).not.toHaveBeenCalled();
  expect(deps.jobs.enqueue, `${op}: no job`).not.toHaveBeenCalled();
};

describe('SEC-AUTHZ-6 payments: the snapshot list is real', () => {
  it('has 13 distinct operations, each in payments.yaml with a payments.* x-permission', () => {
    expect(GROUP.length).toBe(13);
    for (const op of GROUP) expect(xPerm[op], op).toMatch(/^payments\./);
  });
});

describe('SEC-AUTHZ-6 payments: user without the permission is denied before any data is read or written', () => {
  it.each(GROUP)('%s: assertRole denies -> auth.forbidden, tx, events and jobs not touched', async (op) => {
    const r = rig('user', denyAll());
    const err = await run(op, r.ctx);
    expect(err, `${op} must reject`).toBeInstanceOf(LimsError);
    expect(err.code).toBe('auth.forbidden');
    expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
    expect(r.log[0], 'guard before any data access').toBe('assert');
    noData(r, op);
  });

  it.each(['auth.mfa_required', 'identity.support_session_required'])('merchant, settings and reconciliation operations pass %s through unchanged (no new error code)', async (code) => {
    for (const op of ['putMerchantAccount', 'updatePaymentSettings', 'startReconciliationRun', 'resolveReconciliationFinding', 'listMerchantAccounts']) {
      const r = rig('user', denyAll(code));
      const err = await run(op, r.ctx);
      expect(err?.code, op).toBe(code);
      noData(r, op);
    }
  });

  it('a failing IdentityPort (dependency down) fails closed: rejects and reads nothing', async () => {
    for (const op of GROUP) {
      const r = rig('user', async () => { throw new Error('identity store unavailable'); });
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject when assertRole fails`).toBeDefined();
      noData(r, op);
    }
  });

  it('no IdentityPort in the context fails closed: rejects with a LimsError and reads nothing', async () => {
    for (const op of GROUP) {
      const r = rig('user', denyAll(), false);
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject without a port`).toBeInstanceOf(LimsError);
      noData(r, op);
    }
  });

  it('a user holding every payments permission EXCEPT the one needed is denied (merchant_config.read does not open manage; reconciliation.read does not resolve)', async () => {
    const all = new Set([...Object.values(xPerm), ...exceptions.map((e) => e.handlerPermission), 'payments.refund.approve', 'payments.refund.request', 'payments.intent.create']);
    for (const op of GROUP) {
      const want = expectedPermission(op);
      if (!want) continue;
      const r = rig('user', grantOnly(new Set([...all].filter((p) => p !== want))));
      const err = await run(op, r.ctx);
      expect(err?.code, `${op} must be denied without ${want}`).toBe('auth.forbidden');
      noData(r, op);
    }
  });
});

describe('SEC-AUTHZ-6 payments: user with exactly the permission is not denied by the guard', () => {
  it.each(GROUP)('%s: the first guard asks the declared permission; with exactly that grant the guard does not deny', async (op) => {
    const want = expectedPermission(op);
    const r = rig('user', want ? grantOnly(new Set([want])) : async () => undefined);
    const err = await run(op, r.ctx);
    expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
    expect(r.log[0], 'guard before any data access').toBe('assert');
    if (want) {
      expect(r.asserted[0], `${op} asks ${want} first`).toBe(want);
      expect(new Set(r.asserted), `${op} asks exactly ${want}`).toEqual(new Set([want]));
    }
    expect(err?.code, `${op} must not be denied by its own guard`).not.toBe('auth.forbidden');
  });
});

describe('SEC-AUTHZ-6 payments: default role packs keep their access (nothing is widened, nothing is narrowed)', () => {
  it('only roles that hold the x-permission in contracts/permissions.yaml pass the guard: tenant_admin and finance keep reconciliation and merchant config', async () => {
    for (const role of ['tenant_admin', 'finance']) {
      const grants = roleGrants.get(role) ?? new Set<string>();
      for (const op of GROUP.filter((o) => grants.has(xPerm[o]!) && !exceptions.some((e) => e.operationId === o))) {
        const r = rig('user', grantOnly(grants));
        const err = await run(op, r.ctx);
        expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
        expect(err?.code, `${op} must work for ${role} (holds ${xPerm[op]})`).not.toBe('auth.forbidden');
      }
    }
    expect(holders('payments.merchant_config.manage').length).toBeGreaterThan(0);
  });
  it('front_desk (no payments.merchant_config.* and no payments.reconciliation.read) is denied every merchant and settings operation', async () => {
    const grants = roleGrants.get('front_desk') ?? new Set<string>();
    for (const op of ['listMerchantAccounts', 'putMerchantAccount', 'testMerchantAccount', 'getPaymentSettings', 'updatePaymentSettings']) {
      if (grants.has(xPerm[op]!)) continue;
      const r = rig('user', grantOnly(grants));
      const err = await run(op, r.ctx);
      expect(err?.code, op).toBe('auth.forbidden');
      noData(r, op);
    }
  });
  it('an exception row is only for an operation whose service really needs another permission: every role holding the x-permission also holds the handler permission', () => {
    for (const e of exceptions.filter((x) => GROUP.includes(x.operationId))) {
      for (const role of holders(xPerm[e.operationId]!)) expect(roleGrants.get(role)?.has(e.handlerPermission), `${e.operationId}: ${role}`).toBe(true);
    }
  });
});

describe('SEC-AUTHZ-6 payments: patient, partner and portal actors are denied on staff operations', () => {
  const staffOnly = async (ctx: any) => { if (ctx?.actor?.type !== 'user') throw new LimsError('auth.forbidden'); };
  for (const kind of ['patient', 'partner', 'portal']) {
    it.each(GROUP)(`${kind} actor: %s rejected, no data read`, async (op) => {
      const r = rig(kind, staffOnly);
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject a ${kind} actor`).toBeInstanceOf(LimsError);
      expect(['auth.forbidden', 'auth.unauthenticated']).toContain(err.code);
      expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
      noData(r, op);
    });
  }
});

describe('SEC-AUTHZ-6 payments: provider callbacks and the result page are untouched (scheme-callback-token / public)', () => {
  const CALLBACKS = ['launchEsewaPayment', 'esewaSuccessCallback', 'esewaFailureCallback', 'khaltiReturnCallback'];
  it('the contract declares no x-permission on them (they are authenticated by a callback or path token, not a staff session)', () => {
    for (const op of CALLBACKS) {
      expect(xPerm[op], `${op}: no x-permission is added`).toBeUndefined();
      expect(schemes[op], op).not.toContain('bearerJwt');
    }
    expect(xPerm['getPaymentResultPage']).toBeUndefined();
  });
  it('their manifest handlers never ask IdentityPort (no staff guard is added to a callback)', async () => {
    for (const op of [...CALLBACKS, 'getPaymentResultPage']) {
      const asserted = vi.fn(async () => { throw new LimsError('auth.forbidden'); });
      const ctx: any = { tenantId: TENANT, actor: { type: 'system', id: ACTOR }, ports: { IdentityPort: { assertRole: asserted } }, tx: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } };
      try { await (handlers as Record<string, any>)[op]({ params: {}, query: {}, headers: {}, body: {} }, ctx); } catch { /* the placeholder or the callback may refuse: only the port matters */ }
      expect(asserted, `${op} must not call assertRole`).not.toHaveBeenCalled();
    }
  });
});
