// C9 T-25 — S-08 (07-SECURITY §5; REQ-SEC-062; AB-03; AC-12.3): an aal1 session on EVERY quality.autoverify.manage operation (#37, #39, #40, #41, #43, #44, #45) -> 403 auth.mfa_required,
// and a membership revoked after the token was issued -> the privileged call fails. No database.
// The REAL handlers (manifest) run through the REAL IdentityPort (createIdentityPort over a scripted core.memberships repo): the aal2 / privileged decision is the production code's, read from
// contracts/permissions.yaml (privileged: true) via contracts/ports/generated/permissions.ts, not a test double. Authorisation must precede any DB access: the tx sees zero statements.
// Fails now if: an operation bound to quality.autoverify.manage is missing from the list, the permission is not privileged, a handler touches the tx / writes an access-log row before the port
// has said yes, or the port's aal check lets a non-'aal2' claim value through.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PRIVILEGED } from '../../../../../../../contracts/ports/generated/permissions.js';
import { MANAGE_OPS, OPS, QUALITY_GRANTS, fire, loadManifest, makeHarness, opById, requestFor, seen } from './kit.js';

const MANAGE = 'quality.autoverify.manage';
let handlers: Record<string, (...a: any[]) => Promise<any>>;
beforeAll(async () => { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); handlers = (await loadManifest()).handlers; });
const call = async (op: string, who: Parameters<typeof makeHarness>[0]) => {
  const h = makeHarness(who, op);
  const out = await fire(handlers[op]!, requestFor(opById(op)), h.ctx);
  return { ...out, h };
};
const PATHOLOGIST = { permissions: [MANAGE, 'quality.autoverify.read'] };

describe('S-08 contract: the seven privileged operations are exactly the ones bound to quality.autoverify.manage', () => {
  it('quality.yaml binds quality.autoverify.manage to exactly #37 #39 #40 #41 #43 #44 #45 (no more, no fewer)', () => {
    expect(OPS.filter((o) => o.permission === MANAGE).map((o) => o.id).sort()).toEqual([...MANAGE_OPS].sort());
    expect(MANAGE_OPS.length).toBe(7);
  });
  it('permissions.yaml marks quality.autoverify.manage privileged: true and the port reads it (REQ-SEC-062); no other quality permission is privileged', () => {
    expect((PRIVILEGED as ReadonlySet<string>).has(MANAGE)).toBe(true);
    expect(QUALITY_GRANTS.filter((p) => p.privileged).map((p) => p.code)).toEqual([MANAGE]);
  });
  it('only pathologist and lab_manager hold it by default; technologists do not (07-SECURITY §3, E column)', () => {
    expect(QUALITY_GRANTS.find((p) => p.code === MANAGE)!.roles.sort()).toEqual(['lab_manager', 'pathologist']);
  });
});

describe.each(MANAGE_OPS)('S-08 %s', (op) => {
  it('aal1 session of a pathologist -> 403 auth.mfa_required; zero DB statements, zero access-log rows, no reply', async () => {
    const r = await call(op, { ...PATHOLOGIST, aal: 'aal1' });
    expect(r.reply, `answered ${r.reply?.status}`).toBeUndefined();
    expect(r.error?.code, String(r.error?.message)).toBe('auth.mfa_required');
    expect(r.error?.statusCode).toBe(403);
    expect(r.h.queries).toEqual([]);
    expect(r.h.audits).toEqual([]);
  });

  it.each([['missing', undefined], ['AAL2 (wrong case)', 'AAL2'], ['number 2', 2], ['array', ['aal2']], ['empty string', ''], ['aal0', 'aal0'], ['true', true]])(
    'an aal claim that is not exactly the string "aal2" (%s) is treated as aal1 -> auth.mfa_required', async (_n, aal) => {
      const r = await call(op, { ...PATHOLOGIST, aal });
      expect(r.error?.code, `${JSON.stringify(aal)} -> ${r.error?.code ?? r.reply?.status}`).toBe('auth.mfa_required');
      expect(r.h.queries).toEqual([]);
    });

  it('the answer is the generic problem: it does not echo the version id or the body', async () => {
    const h = makeHarness({ ...PATHOLOGIST, aal: 'aal1' }, op);
    const req = requestFor(opById(op), { body: { confirmation_text: 'PLANTED-9f3a', definition: { note: 'PLANTED-9f3a' } } });
    const out = await fire(handlers[op]!, req, h.ctx);
    expect(out.error?.code).toBe('auth.mfa_required');
    expect(seen(out.error)).not.toContain('PLANTED-9f3a');
    for (const v of Object.values(req.params)) expect(seen(out.error)).not.toContain(String(v));
  });

  it('control: aal2 with the same membership gets past authorisation (not mfa_required, not forbidden) — the probe is not a blanket 403', async () => {
    const r = await call(op, { ...PATHOLOGIST, aal: 'aal2' });
    expect(r.error?.code).not.toBe('auth.mfa_required');
    expect(r.error?.code).not.toBe('auth.forbidden');
    expect(r.error?.code).not.toBe('auth.unauthenticated');
  });

  it('membership deactivated after the token was issued (aal2 token still valid) -> privileged call fails with auth.forbidden, nothing touched', async () => {
    const r = await call(op, { ...PATHOLOGIST, aal: 'aal2', status: 'deactivated' });
    expect(r.reply).toBeUndefined();
    expect(r.error?.code).toBe('auth.forbidden');
    expect(r.h.queries).toEqual([]);
    expect(r.h.audits).toEqual([]);
  });

  it('membership row gone / not this actor\'s (aal2 token) -> auth.unauthenticated, nothing touched', async () => {
    const r = await call(op, { ...PATHOLOGIST, aal: 'aal2', noMembership: true });
    expect(r.error?.code).toBe('auth.unauthenticated');
    expect(r.h.queries).toEqual([]);
  });

  it('membership locked after the token was issued -> auth.account_locked', async () => {
    const r = await call(op, { ...PATHOLOGIST, aal: 'aal2', lockedAt: '2026-11-14T09:00:00.000Z' });
    expect(r.error?.code).toBe('auth.account_locked');
    expect(r.h.queries).toEqual([]);
  });

  it('membership of ANOTHER tenant under tenant A claims -> auth.unauthenticated (token/membership tenant mismatch), nothing touched', async () => {
    const h = makeHarness({ ...PATHOLOGIST, aal: 'aal2', tenant: '01a1a98a-ac40-7000-8000-00000000b001' }, op);
    h.ctx.tenantId = '01a1a98a-ac40-7000-8000-00000000a001';
    const out = await fire(handlers[op]!, requestFor(opById(op)), h.ctx);
    expect(out.error?.code).toBe('auth.unauthenticated');
    expect(h.queries).toEqual([]);
  });

  it('a holder of only quality.autoverify.read (aal1 and aal2) -> auth.forbidden, never a path to the write', async () => {
    for (const aal of ['aal1', 'aal2']) {
      const r = await call(op, { permissions: ['quality.autoverify.read'], aal });
      expect(r.error?.code, aal).toBe('auth.forbidden');
      expect(r.h.queries).toEqual([]);
    }
  });
});

describe('S-08 the other autoverify operations are not over-restricted (read ops need no aal2)', () => {
  it.each(['getAutoverifyRuleSet', 'getAutoverifyVersion', 'getAutoverifySimulationReport', 'listAutoverifyDecisions', 'getAutoverifyDecision'])(
    '%s: aal1 reader is not told auth.mfa_required', async (op) => {
      const r = await call(op, { permissions: ['quality.autoverify.read'], aal: 'aal1' });
      expect(r.error?.code).not.toBe('auth.mfa_required');
      expect(r.error?.code).not.toBe('auth.forbidden');
    });
});
