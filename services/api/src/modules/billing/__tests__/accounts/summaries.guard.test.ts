// T0D-BUILD-1 (LD-447, LD-358; contract listAccountSummaries GET /v1/billing/account-summaries, billing.account.read) NO DATABASE part:
// contract pins, the handler is real (not the stub), the operation id left manifest.pendingOperations, and the SEC-AUTHZ-6 guard order
// (x-permission asked FIRST, before any read; fails closed without an IdentityPort; staff only; no adjacent permission is enough).
// Fails now: no handler is registered and the id is still in pendingOperations. Synthetic data only. The DB behaviour is in summaries.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../../handlers/index.js';

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..', '..');
const api: any = parse(readFileSync(join(ROOT, 'contracts', 'openapi', 'billing.yaml'), 'utf8'));
const perms: any = parse(readFileSync(join(ROOT, 'contracts', 'permissions.yaml'), 'utf8'));
const OP = 'listAccountSummaries';
const op: any = (Object.values<any>(api.paths).flatMap((i) => Object.values<any>(i)) as any[]).find((o) => o?.operationId === OP);
const PERM = 'billing.account.read';

const TENANT = '0190a000-0000-7000-8000-00000000aaaa';
const ACTOR = '0190a000-0000-7000-8000-000000004001';
const ID = '0190a000-0000-7000-8000-000000009001';
const req = { params: {}, query: {}, headers: {}, body: undefined };

function rig(actorType: string, assertRole: (ctx: any, r: { permission: string }) => Promise<unknown>, withPort = true) {
  const log: string[] = [];
  const asserted: string[] = [];
  const assert = vi.fn(async (ctx: any, r: { permission: string }) => { log.push('assert'); asserted.push(r?.permission); return assertRole(ctx, r); });
  const touch = (name: string) => new Proxy({}, {
    get: (_t, p) => { if (typeof p === 'symbol' || p === 'then') return undefined; log.push('data'); return vi.fn(async () => { log.push(name); return { rows: [], rowCount: 0 }; }); },
  });
  const ctx: any = {
    tenantId: TENANT, actor: { type: actorType, id: ACTOR, membershipId: ID }, sessionId: ID, requestId: ID, now: () => new Date('2026-11-22T00:00:00Z').toISOString(),
    tx: touch('tx'), events: touch('events'), jobs: touch('jobs'), audit: touch('audit'),
    ports: withPort ? { IdentityPort: { assertRole: assert } } : {},
  };
  return { ctx, log, assert, asserted };
}
const run = async (ctx: any) => { try { await (handlers as Record<string, any>)[OP](req, ctx); return undefined; } catch (e) { return e as any; } };
const noData = (r: ReturnType<typeof rig>) => expect(r.log.filter((x) => x !== 'assert'), 'no data read or written before / without the guard').toEqual([]);

describe('T0D-BUILD-1 contract (LD-358) as the handler must follow it', () => {
  it('GET /v1/billing/account-summaries, billing.account.read, tenant context, no idempotency, the five filters and the typed errors', () => {
    expect(op, 'listAccountSummaries missing from billing.yaml').toBeDefined();
    expect(op).toMatchObject({ 'x-permission': PERM, 'x-context': 'tenant', 'x-idempotency': 'none' });
    expect(Object.keys(api.paths['/v1/billing/account-summaries'])).toEqual(['get']);
    expect((op.parameters as any[]).map((p) => p.name).sort()).toEqual(['blocked_only', 'cursor', 'limit', 'outstanding_only', 'party_kind', 'q']);
    expect(op['x-error-codes']).toEqual(expect.arrayContaining(['auth.forbidden', 'auth.unauthenticated', 'common.validation_failed', 'common.invalid_cursor']));
    expect((perms.permissions as any[]).find((p) => p.code === PERM)?.roles).toEqual(expect.arrayContaining(['finance', 'tenant_admin']));
  });
  it('contracts/openapi/billing.yaml is not edited by this task: the row schema keeps its 7 required fields and no centre_id', () => {
    const row = api.components.schemas.AccountSummaryRow;
    expect(row.required).toEqual(['party_kind', 'party_id', 'party_name', 'credit_limit_paisa', 'outstanding_paisa', 'outstanding_side', 'is_blocked']);
    expect(Object.keys(row.properties)).not.toContain('centre_id');
  });
});

describe('T0D-BUILD-1 the operation is wired (done_when 1)', () => {
  it('billing/index.ts: listAccountSummaries left the pendingOperations line (CR DEPLOY-AXIS-012 item 8)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf8');
    const block = /pendingOperations:\s*\[([\s\S]*?)\]/.exec(src)?.[1] ?? '';
    expect(block.replace(/\/\/.*$/gm, ''), 'pendingOperations must not name listAccountSummaries any more').not.toMatch(/listAccountSummaries/);
    expect(src).toMatch(/pendingOperations/);               // the line itself stays (other tasks use it)
  });
  it('the handler is registered, is not the 503 stub, and fails closed with auth.unauthenticated when the request context is missing', async () => {
    const h = (handlers as Record<string, any>)[OP];
    expect(typeof h, `${OP} handler`).toBe('function');
    const err: any = await h({ params: {}, query: {}, headers: {}, body: undefined }, {}).then(() => undefined, (e: any) => e);
    expect(err?.code, String(err?.message)).toBe('auth.unauthenticated');
  });
});

describe('T0D-BUILD-1 security: x-permission first (SEC-AUTHZ-6), before any read', () => {
  it('assertRole denies -> auth.forbidden, billing.account.read asked first, repository / events / audit not touched', async () => {
    const r = rig('user', async () => { throw new LimsError('auth.forbidden'); });
    const err = await run(r.ctx);
    expect(err, 'must reject').toBeInstanceOf(LimsError);
    expect(err.code).toBe('auth.forbidden');
    expect(r.asserted[0]).toBe(PERM);
    expect(r.log[0], 'guard before any data access').toBe('assert');
    noData(r);
  });
  it('auth.mfa_required and identity.support_session_required pass through unchanged (no new code)', async () => {
    for (const code of ['auth.mfa_required', 'identity.support_session_required']) {
      const r = rig('user', async () => { throw new LimsError(code); });
      expect((await run(r.ctx))?.code).toBe(code);
      noData(r);
    }
  });
  it('a user holding every other billing permission but not billing.account.read is denied (no adjacent permission is enough)', async () => {
    const others = new Set(['billing.account.manage', 'billing.account_entry.create', 'billing.account_entry.reverse', 'billing.invoice.read', 'billing.credit.read', 'billing.data.export', 'billing.invoice.reprint']);
    const r = rig('user', async (_c, p) => { if (!others.has(p.permission)) throw new LimsError('auth.forbidden'); });
    const err = await run(r.ctx);
    expect(err?.code).toBe('auth.forbidden');
    noData(r);
  });
  it('a dependency failure of the identity port fails closed and reads nothing; a missing port is a LimsError and reads nothing', async () => {
    const down = rig('user', async () => { throw new Error('identity store unavailable'); });
    expect(await run(down.ctx), 'must reject when assertRole fails').toBeDefined();
    noData(down);
    const none = rig('user', async () => undefined, false);
    expect(await run(none.ctx)).toBeInstanceOf(LimsError);
    noData(none);
  });
  it.each(['patient', 'partner', 'portal'])('a %s actor is denied on this staff list, no data read', async (kind) => {
    const r = rig(kind, async (ctx) => { if (ctx?.actor?.type !== 'user') throw new LimsError('auth.forbidden'); });
    const err = await run(r.ctx);
    expect(['auth.forbidden', 'auth.unauthenticated']).toContain(err?.code);
    expect(r.assert).toHaveBeenCalled();
    noData(r);
  });
  it('with exactly billing.account.read the guard does not deny, and it asks only that permission', async () => {
    const r = rig('user', async (_c, p) => { if (p.permission !== PERM) throw new LimsError('auth.forbidden'); });
    const err = await run(r.ctx);
    expect(r.assert).toHaveBeenCalled();
    expect(new Set(r.asserted)).toEqual(new Set([PERM]));
    expect(err?.code, 'must not be denied by its own guard').not.toBe('auth.forbidden');
  });
});
