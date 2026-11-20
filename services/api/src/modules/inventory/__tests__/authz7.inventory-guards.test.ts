// SEC-AUTHZ-7 (LD-189 AUTH-SENSITIVE, LD-261; SEC-AUTHZ-1.1 approved design): behaviour matrix of the 4 inventory operations that the classifier snapshot shows as
// `unguarded` (getInventorySettings, updateInventorySettings, listInventoryCodedSet, putInventoryTenantCode; handlers/settings.handlers.ts). Each handler is called
// directly (central stage 8a NOT in play; LIMS_CORE_AUTHZ_MODE stays shadow), so what is proven is the handler's OWN guard:
//   ctx.ports.IdentityPort.assertRole(ctx, { permission })  BEFORE any data is read or written. Same pinned interface as SEC-AUTHZ-5 / 6 and the guarded inventory
//   handlers (items.ts `gate`): first call, exactly the contract x-permission (or the authz-exceptions.json handlerPermission, or an op named in a SEC-AUTHZ-7 CR),
//   LimsError auth.forbidden | auth.mfa_required | identity.support_session_required passed through unchanged (no new error code).
// The two alert operations stay stubs (class stub, SEC-AUTHZ-1.1: unaffected until they get a handler): they refuse and read nothing.
// Nothing is widened: no contract, permission registry, role pack or SQL file changes. Synthetic data only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../core/errors.js';
import { handlers } from '../handlers/index.js';

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const spec: any = parse(readFileSync(join(ROOT, 'contracts', 'openapi', 'inventory.yaml'), 'utf8'));
const xPerm: Record<string, string> = {};
for (const item of Object.values<any>(spec.paths)) {
  for (const op of Object.values<any>(item)) if (op && typeof op === 'object' && op.operationId && op['x-permission']) xPerm[op.operationId] = op['x-permission'];
}
const packs: any = parse(readFileSync(join(ROOT, 'contracts', 'permissions.yaml'), 'utf8'));
const roleGrants = new Map<string, Set<string>>();
for (const p of packs.permissions as Array<{ code: string; roles?: string[] }>) for (const r of p.roles ?? []) (roleGrants.get(r) ?? roleGrants.set(r, new Set()).get(r)!).add(p.code);
const holders = (perm: string): string[] => (packs.permissions as Array<{ code: string; roles?: string[] }>).find((p) => p.code === perm)?.roles ?? [];
const exceptionsPath = join(ROOT, 'services', 'api', 'src', 'core', 'pipeline', 'authz-exceptions.json');
const exceptions: Array<{ operationId: string; handlerPermission: string }> = existsSync(exceptionsPath) ? JSON.parse(readFileSync(exceptionsPath, 'utf8')) : [];
const crDir = join(ROOT, '.orchestra', 'cr');
const crText = existsSync(crDir) ? readdirSync(crDir).filter((f) => /^SEC-AUTHZ-7.*\.md$/.test(f)).map((f) => readFileSync(join(crDir, f), 'utf8')).join('\n') : '';

export const GROUP = ['getInventorySettings', 'updateInventorySettings', 'listInventoryCodedSet', 'putInventoryTenantCode'] as const;
const STUBS = ['listInventoryAlerts', 'acknowledgeInventoryAlert'] as const;
const expectedPermission = (op: string): string | undefined => {
  const ex = exceptions.find((e) => e.operationId === op);
  if (ex) return ex.handlerPermission;
  if (new RegExp(`\\b${op}\\b`).test(crText)) return undefined;
  return xPerm[op];
};

const TENANT = '0190a000-0000-7000-8000-00000000aaaa';
const ACTOR = '0190a000-0000-7000-8000-000000004001';
const ID = '0190a000-0000-7000-8000-000000009001';
const req = { params: { set_name: 'adjustment_reason', code: 'X1' }, query: {}, headers: { 'if-match': '"1"', 'idempotency-key': 'k-authz7-inv-0001' }, body: {} };

function rig(actorType: string, assertRole: (ctx: any, r: { permission: string }) => Promise<unknown>, withPort = true) {
  const log: string[] = [];
  const query = vi.fn(async () => { log.push('data'); return { rows: [], rowCount: 0 }; });
  const asserted: string[] = [];
  const assert = vi.fn(async (ctx: any, r: { permission: string }) => { log.push('assert'); asserted.push(r?.permission); return assertRole(ctx, r); });
  const touch = (name: string) => new Proxy({}, {
    get: (_t, p) => { if (typeof p === 'symbol' || p === 'then') return undefined; log.push('data'); return p === 'query' ? query : vi.fn(async () => { log.push(name); return { rows: [], rowCount: 0 }; }); },
  });
  const ctx: any = {
    tenantId: TENANT, actor: { type: actorType, id: ACTOR, membershipId: ID }, sessionId: ID, requestId: ID, operationId: 'x', now: () => new Date('2026-11-19T00:00:00Z').toISOString(),
    tx: touch('tx'), events: touch('events'), jobs: touch('jobs'), audit: touch('audit'),
    ports: withPort ? { IdentityPort: { assertRole: assert } } : {},
  };
  return { ctx, log, query, assert, asserted };
}
const run = async (op: string, ctx: any) => {
  try { await (handlers as Record<string, any>)[op](req, ctx); return undefined; } catch (e) { return e as any; }
};
const denyAll = (code = 'auth.forbidden') => async () => { throw new LimsError(code); };
const grantOnly = (granted: Set<string>) => async (_c: any, r: { permission: string }) => { if (!granted.has(r.permission)) throw new LimsError('auth.forbidden'); };
const noData = (r: ReturnType<typeof rig>, op: string) => expect(r.log.filter((x) => x !== 'assert'), `${op}: no data read or written before/without the guard`).toEqual([]);
const code = (e: any) => e?.code;

describe('SEC-AUTHZ-7 inventory: the snapshot list is real', () => {
  it('4 operations in inventory.yaml with a runtime handler and an inventory.* x-permission; the 2 alert operations are stubs', () => {
    expect(GROUP.length).toBe(4);
    for (const op of GROUP) { expect(typeof (handlers as Record<string, unknown>)[op], op).toBe('function'); expect(xPerm[op], op).toMatch(/^inventory\./); }
    expect(xPerm['getInventorySettings']).toBe('inventory.item.read');
    expect(xPerm['updateInventorySettings']).toBe('inventory.master.manage');
    expect(xPerm['listInventoryCodedSet']).toBe('inventory.item.read');
    expect(xPerm['putInventoryTenantCode']).toBe('inventory.master.manage');
    for (const op of STUBS) expect(typeof (handlers as Record<string, unknown>)[op], op).toBe('function');
  });
});

describe('SEC-AUTHZ-7 inventory: user without the permission is denied before any data is read or written', () => {
  it.each(GROUP)('%s: assertRole denies -> auth.forbidden, repository, events and audit spies not called', async (op) => {
    const r = rig('user', denyAll());
    const err = await run(op, r.ctx);
    expect(err, `${op} must reject`).toBeInstanceOf(LimsError);
    expect(code(err)).toBe('auth.forbidden');
    expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
    expect(r.log[0], 'guard before any data access').toBe('assert');
    noData(r, op);
  });
  it.each(['auth.mfa_required', 'identity.support_session_required'])('passes %s through unchanged (no new error code)', async (c) => {
    for (const op of GROUP) {
      const r = rig('user', denyAll(c));
      expect(code(await run(op, r.ctx)), op).toBe(c);
      noData(r, op);
    }
  });
  it('a failing IdentityPort fails closed; a context without IdentityPort fails closed with a LimsError; nothing is read', async () => {
    for (const op of GROUP) {
      const down = rig('user', async () => { throw new Error('identity store unavailable'); });
      expect(await run(op, down.ctx), op).toBeDefined();
      noData(down, op);
      const none = rig('user', denyAll(), false);
      expect(await run(op, none.ctx), op).toBeInstanceOf(LimsError);
      noData(none, op);
    }
  });
  it('a user holding every inventory permission EXCEPT the one needed is denied (item.read does not allow a write, master.manage is not item.read)', async () => {
    const all = new Set(Object.values(xPerm));
    for (const op of GROUP) {
      const want = expectedPermission(op);
      if (!want) continue;
      const r = rig('user', grantOnly(new Set([...all].filter((p) => p !== want))));
      expect(code(await run(op, r.ctx)), `${op} must be denied without ${want}`).toBe('auth.forbidden');
      noData(r, op);
    }
  });
});

describe('SEC-AUTHZ-7 inventory: user with exactly the permission reaches the handler', () => {
  it.each(GROUP)('%s: the first guard asks the declared permission and nothing else; with exactly that grant it is not denied', async (op) => {
    const want = expectedPermission(op);
    const r = rig('user', want ? grantOnly(new Set([want])) : async () => undefined);
    const err = await run(op, r.ctx);
    expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
    expect(r.log[0]).toBe('assert');
    if (want) {
      expect(r.asserted[0]).toBe(want);
      expect(new Set(r.asserted), `${op} asks exactly ${want}`).toEqual(new Set([want]));
      expect(code(err), `${op} must not be denied by its own guard`).not.toBe('auth.forbidden');
    }
  });
  it('default role packs keep their settings reads and master writes (nothing narrowed)', async () => {
    for (const [role, grants] of roleGrants) {
      for (const op of GROUP.filter((o) => grants.has(xPerm[o]!))) {
        const r = rig('user', grantOnly(grants));
        expect(code(await run(op, r.ctx)), `${op} must work for ${role}`).not.toBe('auth.forbidden');
      }
    }
    expect(holders('inventory.item.read').length).toBeGreaterThan(0);
  });
  it('an exception row for the group is only for an operation whose handler really needs another permission (no role loses access)', () => {
    for (const e of exceptions.filter((x) => (GROUP as readonly string[]).includes(x.operationId))) {
      for (const role of holders(xPerm[e.operationId]!)) expect(roleGrants.get(role)?.has(e.handlerPermission), `${e.operationId}: ${role}`).toBe(true);
    }
  });
});

describe('SEC-AUTHZ-7 inventory: patient, partner and portal actors are denied on staff operations', () => {
  const staffOnly = async (ctx: any) => { if (ctx?.actor?.type !== 'user') throw new LimsError('auth.forbidden'); };
  for (const kind of ['patient', 'partner', 'portal']) {
    it.each(GROUP)(`${kind} actor: %s rejected, no data read`, async (op) => {
      const r = rig(kind, staffOnly);
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject a ${kind} actor`).toBeInstanceOf(LimsError);
      expect(['auth.forbidden', 'auth.unauthenticated']).toContain(code(err));
      expect(r.assert).toHaveBeenCalled();
      noData(r, op);
    });
  }
});

describe('SEC-AUTHZ-7 inventory: the alert stubs stay refusals (never a 2xx, never a read)', () => {
  it.each(STUBS)('%s refuses and reads nothing', async (op) => {
    const r = rig('user', async () => undefined);
    const err = await run(op, r.ctx);
    expect(err, op).toBeDefined();
    noData(r, op);
  });
});
