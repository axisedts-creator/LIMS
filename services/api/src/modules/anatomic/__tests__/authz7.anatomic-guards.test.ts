// SEC-AUTHZ-7 (LD-189 AUTH-SENSITIVE, LD-261; SEC-AUTHZ-1.1 approved design): behaviour matrix of the 3 anatomic operations that the classifier snapshot shows as
// `unguarded` (listAnatomicBlocks, markAnatomicSlidesReady, recordAnatomicMovements; handlers/material.handlers.ts -> service/material.service.ts). Each handler is called
// directly (central stage 8a NOT in play; LIMS_CORE_AUTHZ_MODE stays shadow), so what is proven is the handler's OWN guard:
//   ctx.ports.IdentityPort.assertRole(ctx, { permission })  BEFORE any data is read or written.
// The sibling anatomic operations assert after loading the case (to pass the case's centre). For these three the brief demands that every denial happens before
// any data is read or written: the baseline assert (no centre) is the FIRST call; a centre-scoped assert after the load may stay. Error codes pass through unchanged
// (auth.forbidden | auth.mfa_required | identity.support_session_required). Expected permission = contract x-permission, or the authz-exceptions.json handlerPermission,
// or an operation named in a SEC-AUTHZ-7 change request. Nothing is widened: no contract, registry, role pack or SQL file changes. Synthetic data only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../core/errors.js';
import { handlers } from '../handlers/index.js';

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const spec: any = parse(readFileSync(join(ROOT, 'contracts', 'openapi', 'anatomic.yaml'), 'utf8'));
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

export const GROUP = ['listAnatomicBlocks', 'markAnatomicSlidesReady', 'recordAnatomicMovements'] as const;
const expectedPermission = (op: string): string | undefined => {
  const ex = exceptions.find((e) => e.operationId === op);
  if (ex) return ex.handlerPermission;
  if (new RegExp(`\\b${op}\\b`).test(crText)) return undefined;
  return xPerm[op];
};

const TENANT = '0190a000-0000-7000-8000-00000000aaaa';
const ACTOR = '0190a000-0000-7000-8000-000000004001';
const ID = '0190a000-0000-7000-8000-000000009001';
const anyKey = new Proxy({} as Record<string, string>, { get: (_t, p) => (typeof p === 'string' ? ID : undefined), has: () => true });
const req = { params: anyKey, query: {}, headers: { 'if-match': '"1"', 'idempotency-key': 'k-authz7-an-0001' }, body: {} };

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
    tx: touch('tx'), events: touch('events'), jobs: touch('jobs'), audit: touch('audit'), storage: touch('storage'),
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

describe('SEC-AUTHZ-7 anatomic: the snapshot list is real', () => {
  it('3 operations in anatomic.yaml with a runtime handler (not the 501 stub) and the declared x-permission', () => {
    for (const op of GROUP) expect(typeof (handlers as Record<string, unknown>)[op], op).toBe('function');
    expect(xPerm['listAnatomicBlocks']).toBe('anatomic.case.read');
    expect(xPerm['markAnatomicSlidesReady']).toBe('anatomic.case.work');
    expect(xPerm['recordAnatomicMovements']).toBe('anatomic.case.work');
  });
});

describe('SEC-AUTHZ-7 anatomic: user without the permission is denied before any data is read or written', () => {
  it.each(GROUP)('%s: assertRole denies -> auth.forbidden, repository, events, jobs and audit spies not called', async (op) => {
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
  it('a user holding every anatomic permission EXCEPT the one needed is denied (case.read does not allow a slide or movement write; case.work is not case.read)', async () => {
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

describe('SEC-AUTHZ-7 anatomic: user with exactly the permission reaches the handler', () => {
  it.each(GROUP)('%s: the first guard asks the declared permission; with exactly that grant it is not denied', async (op) => {
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
  it('default role packs keep their anatomic reads and bench writes (nothing narrowed)', async () => {
    for (const [role, grants] of roleGrants) {
      for (const op of GROUP.filter((o) => grants.has(xPerm[o]!))) {
        const r = rig('user', grantOnly(grants));
        expect(code(await run(op, r.ctx)), `${op} must work for ${role}`).not.toBe('auth.forbidden');
      }
    }
    expect(holders('anatomic.case.read').length).toBeGreaterThan(0);
    expect(holders('anatomic.case.work').length).toBeGreaterThan(0);
  });
  it('an exception row for the group is only for an operation whose handler really needs another permission (no role loses access)', () => {
    for (const e of exceptions.filter((x) => (GROUP as readonly string[]).includes(x.operationId))) {
      for (const role of holders(xPerm[e.operationId]!)) expect(roleGrants.get(role)?.has(e.handlerPermission), `${e.operationId}: ${role}`).toBe(true);
    }
  });
});

describe('SEC-AUTHZ-7 anatomic: patient, partner and portal actors are denied on staff operations', () => {
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
