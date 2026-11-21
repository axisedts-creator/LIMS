// SEC-AUTHZ-6 (LD-189 AUTH-SENSITIVE, LD-261): behaviour matrix of the four audit export operations (createAuditExport, listAuditExports, getAuditExport,
// downloadAuditExport; contracts/openapi/identity.yaml, x-permission audit.log.export, privileged). The "audit export permission difference" of the
// brief is audit-export.service.ts asking audit.log.read (P-10: it WIDENS the rows an export holder sees from own rows to every requester of the
// tenant; it is never a gate). Resolution pinned here: the handler asks exactly audit.log.export FIRST (T0B-ADMINFIX-1 guard in _audit-export.bind.ts,
// kept), the service call happens only after it, and the audit.log.read check stays a scope decision, so no exception row and no contract change is needed.
// Handlers are called directly (stage 8a not in play, shadow mode). Synthetic data only. Passes today for the handler; it pins the guard against regression.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';

const svc = vi.hoisted(() => ({ createAuditExport: vi.fn(), listAuditExports: vi.fn(), getAuditExport: vi.fn(), downloadAuditExport: vi.fn() }));
vi.mock('../service/audit-export.service.js', () => ({ createAuditExportService: () => svc }));

import { handlers } from '../handlers/index.js';

const OPS = ['createAuditExport', 'listAuditExports', 'getAuditExport', 'downloadAuditExport'] as const;
const TENANT = '0190a000-0000-7000-8000-00000000aaaa';
const ACTOR = '0190a000-0000-7000-8000-000000004001';
const ID = '0190a000-0000-7000-8000-000000009001';
const req = { params: { export_id: ID }, query: {}, headers: { 'idempotency-key': 'k-authz6-0001' }, body: { source: 'audit', from: '2026-11-01', to: '2026-11-02' } };

function rig(actorType: string, assertRole: (ctx: any, r: { permission: string }) => Promise<unknown>, withPort = true) {
  const asserted: string[] = [];
  const order: string[] = [];
  const assert = vi.fn(async (ctx: any, r: { permission: string }) => { order.push('assert'); asserted.push(r?.permission); return assertRole(ctx, r); });
  for (const f of Object.values(svc)) f.mockImplementation(async () => { order.push('service'); return { status: 200, body: {} }; });
  const ctx: any = {
    operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, tenantId: TENANT, requestId: ID, tx: { name: 'tx' },
    actor: { type: actorType, id: ACTOR, membershipId: ID }, audit: { access: async () => {} }, ports: withPort ? { IdentityPort: { assertRole: assert } } : {},
  };
  return { ctx, asserted, order, assert };
}
const run = async (op: string, ctx: any) => { try { await (handlers as Record<string, any>)[op](req, ctx); return undefined; } catch (e) { return e as any; } };
const denyAll = (code = 'auth.forbidden') => async () => { throw new LimsError(code); };
const grantOnly = (granted: Set<string>) => async (_c: any, r: { permission: string }) => { if (!granted.has(r.permission)) throw new LimsError('auth.forbidden'); };
const serviceCalls = () => Object.values(svc).reduce((n, f) => n + f.mock.calls.length, 0);

beforeEach(() => { for (const f of Object.values(svc)) f.mockReset(); });

describe('SEC-AUTHZ-6 audit export: user without audit.log.export is denied before the service (and its repository) runs', () => {
  it.each(OPS)('%s: assertRole denies -> auth.forbidden, service not called', async (op) => {
    const r = rig('user', denyAll());
    const err = await run(op, r.ctx);
    expect(err).toBeInstanceOf(LimsError);
    expect(err.code).toBe('auth.forbidden');
    expect(r.asserted[0]).toBe('audit.log.export');
    expect(serviceCalls()).toBe(0);
  });
  it.each(['auth.mfa_required', 'identity.support_session_required'])('%s passes through unchanged for every export operation (no new error code)', async (code) => {
    for (const op of OPS) {
      const r = rig('user', denyAll(code));
      const err = await run(op, r.ctx);
      expect(err?.code, op).toBe(code);
      expect(serviceCalls()).toBe(0);
    }
  });
  it('a user holding audit.log.read (and every other permission) but not audit.log.export is denied: read does not open exports', async () => {
    for (const op of OPS) {
      const r = rig('user', grantOnly(new Set(['audit.log.read', 'billing.data.export', 'identity.user.manage'])));
      const err = await run(op, r.ctx);
      expect(err?.code, op).toBe('auth.forbidden');
      expect(serviceCalls()).toBe(0);
    }
  });
  it('a failing IdentityPort fails closed; a context without the port fails closed (LimsError); the service is never reached', async () => {
    for (const op of OPS) {
      const down = rig('user', async () => { throw new Error('identity store unavailable'); });
      expect(await run(op, down.ctx), op).toBeDefined();
      const none = rig('user', denyAll(), false);
      expect(await run(op, none.ctx), op).toBeInstanceOf(LimsError);
      expect(serviceCalls()).toBe(0);
    }
  });
});

describe('SEC-AUTHZ-6 audit export: user with exactly audit.log.export reaches the service (the audit.log.read difference is a scope decision, not a gate)', () => {
  it.each(OPS)('%s: asks audit.log.export first and only that; with exactly that grant the service runs after the guard', async (op) => {
    const r = rig('user', grantOnly(new Set(['audit.log.export'])));
    const err = await run(op, r.ctx);
    expect(err, op).toBeUndefined();
    expect(r.asserted).toEqual(['audit.log.export']);
    expect(r.order).toEqual(['assert', 'service']);
  });
});

describe('SEC-AUTHZ-6 audit export: patient, partner and portal actors are denied', () => {
  const staffOnly = async (ctx: any) => { if (ctx?.actor?.type !== 'user') throw new LimsError('auth.forbidden'); };
  for (const kind of ['patient', 'partner', 'portal']) {
    it.each(OPS)(`${kind} actor: %s rejected, service not called`, async (op) => {
      const r = rig(kind, staffOnly);
      const err = await run(op, r.ctx);
      expect(err).toBeInstanceOf(LimsError);
      expect(['auth.forbidden', 'auth.unauthenticated']).toContain(err.code);
      expect(serviceCalls()).toBe(0);
    });
  }
});
