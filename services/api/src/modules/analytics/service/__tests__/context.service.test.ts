// AN-T03 service/context.service.ts (02-TRD §4 resolvePeriod / resolveScope; PRD US-15.2, US-02.3–5; 07-SECURITY REQ-SEC-013/017, P1, P3, P5).
// Interface expected from the writer (TRD §4 fixes the names/signatures; seams the spec leaves open are marked SEAM):
//   resolvePeriod(q: PeriodQuery, today: IsoDate, maxDays: number): Period          — pure, same contract as domain/period.ts
//   resolveScope(ctx, requested: { centreIds?: readonly string[]; branchIds?: readonly string[] }): Promise<Scope>
//   ctx (HandlerContext subset): { tenantId, actor, tx, now, ports: { IdentityPort }, core: { branches(ctx), centres(ctx, {branchId}) } }
//     — steps 1–3 of TRD §4: getActor memoised PER REQUEST (per ctx object, never across requests); centre ids must be in
//       centreScope unless all (else 404 common.not_found, id never echoed); branch ids must exist in ctx.core.branches(ctx) (else 404);
//       a branch becomes its centres (ctx.core.centres(ctx,{branchId})) ∩ caller scope; result { all, centreIds } with
//       all = actor.all && no filter.
//   SEAM (07 P1, REQ-SEC-013): a centre id that does not exist in the caller's tenant is 404 even for an all-centre actor
//       (tenant A credentials + tenant B centre id → 404); the writer may check with ctx.core.centres(ctx) or ctx.core.centre(ctx,{centreId}).
//   SEAM: >20 centre ids or >20 branch ids → 400 common.validation_failed, decided before any lookup (TRD: "≤ 20").
//   SEAM: an existing branch whose centres are all outside the caller scope is NOT 404 (branches are tenant-level, listed by ctx.core);
//       it resolves to the empty restricted scope { all:false, centreIds:[] } — never widened (07 P5).
//   Not covered: loadFlags() (named in the TRD file tree, no contract in §4 or in the AN-T03 brief).
import { describe, expect, it } from 'vitest';
import { createFakeIdentityPort, type MembershipRow } from '../../../../../../../packages/fakes/src/IdentityPort.fake';
import { TENANTS, actorIdFor, idFor } from '../../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { LimsError, isLimsError } from '../../../../core/errors.js';
import { GOLDEN, addDays, bsKey, diffDays, golden } from '../../domain/__tests__/helpers.js';
import { resolvePeriod, resolveScope } from '../context.service.js';

// ---------------------------------------------------------------- fixtures (synthetic ids only)
const SEED = 1;
const A1 = idFor(SEED, 0xc1);            // tenant A centre of the fake's `centre` persona
const B1 = idFor(SEED, 0xc2);            // tenant B centre
const A2 = idFor(SEED, 0xc3);
const A3 = idFor(SEED, 0xc4);
const BR1 = idFor(SEED, 0xbb01);         // tenant A branch: centres A1, A2
const BR2 = idFor(SEED, 0xbb02);         // tenant A branch: centre A3
const BRB = idFor(SEED, 0xbb03);         // tenant B branch: centre B1
const NOPE = idFor(SEED, 0xdead01);      // exists nowhere
const NOPE_BR = idFor(SEED, 0xdead02);

const member = (persona: string, n: number, o: Partial<MembershipRow>): MembershipRow => ({
  id: idFor(SEED, 0x900 + n), tenantId: TENANTS.A, actorId: actorIdFor('A', 'user', persona), actorType: 'user',
  displayName: `Test User A-${persona}`, roles: ['lab_technologist'], centreScope: { all: false, centreIds: [] }, branchIds: [],
  mfaLevel: 'aal2', isLocked: false, status: 'active', email: null, version: 1, ...o,
});
const MULTI = member('multi', 1, { centreScope: { all: false, centreIds: [A1, A2] } });

const TENANT_OF: Record<string, string> = { [BR1]: 'A', [BR2]: 'A', [BRB]: 'B', [A1]: 'A', [A2]: 'A', [A3]: 'A', [B1]: 'B' };
const BRANCH_OF: Record<string, string> = { [A1]: BR1, [A2]: BR1, [A3]: BR2, [B1]: BRB };

/** ctx.core stand-in with the CoreRepo shapes (BranchRow / CentreRow ids), tenant-filtered like the real repo; records calls. */
function makeCore() {
  const calls: string[] = [];
  let failWith: string | undefined;
  const tenant = (ctx: any) => (ctx.tenantId === TENANTS.A ? 'A' : 'B');
  const guard = (name: string) => { calls.push(name); if (failWith) throw new LimsError(failWith); };
  const branchRow = (id: string) => ({ id, branchCode: id.slice(-4), name: `Branch ${id.slice(-4)}`, isProcessingLab: false, isActive: true });
  const centreRow = (id: string) => ({ id, branchId: BRANCH_OF[id]!, centreCode: id.slice(-4), name: `Centre ${id.slice(-4)}`, centreKind: 'own', isActive: true });
  const core = {
    async branches(ctx: any) { guard('branches'); return [BR1, BR2, BRB].filter((b) => TENANT_OF[b] === tenant(ctx)).map(branchRow); },
    async branch(ctx: any, i: { branchId: string }) {
      guard('branch');
      if (TENANT_OF[i.branchId] !== tenant(ctx) || !i.branchId || ![BR1, BR2, BRB].includes(i.branchId)) throw new LimsError('common.not_found');
      return branchRow(i.branchId);
    },
    async centres(ctx: any, i: { branchId?: string } = {}) {
      guard('centres');
      return [A1, A2, A3, B1].filter((c) => TENANT_OF[c] === tenant(ctx) && (i.branchId === undefined || BRANCH_OF[c] === i.branchId)).map(centreRow);
    },
    async centre(ctx: any, i: { centreId: string }) {
      guard('centre');
      if (![A1, A2, A3, B1].includes(i.centreId) || TENANT_OF[i.centreId] !== tenant(ctx)) throw new LimsError('common.not_found');
      return centreRow(i.centreId);
    },
  };
  return { core, calls, failNext: (code: string) => { failWith = code; } };
}

function world() {
  const identity = createFakeIdentityPort({ seed: SEED, fixtures: { memberships: [MULTI] } }) as any;
  const c = makeCore();
  const ctxFor = makeCtxFor();
  /** A fresh ctx = a fresh request (own tx, own memo). */
  const ctx = (actorKey: string): any => ({ ...ctxFor(actorKey), ports: { IdentityPort: identity }, core: c.core });
  return { identity, core: c, ctx };
}

const ADMIN = 'A:user:admin';     // all-centre
const AAL1 = 'A:user:aal1';       // all-centre, aal1
const A1_ONLY = 'A:user:centre';  // restricted to {A1}
const MULTI_KEY = 'A:user:multi'; // restricted to {A1, A2}
const LOCKED = 'A:user:locked';
const PARTNER = 'A:partner:default';

// ---------------------------------------------------------------- helpers
const ids = (s: { centreIds: readonly string[] }) => [...s.centreIds].sort();
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected the call to reject, it resolved');
}
async function expectLimsAsync(p: Promise<unknown>, code: string, status: number): Promise<LimsError> {
  const e = await rejection(p);
  if (!isLimsError(e, code)) throw new Error(`expected LimsError ${code}, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  expect(e.statusCode, code).toBe(status);
  return e;
}
const shape = (e: LimsError) => ({ code: e.code, status: e.statusCode, message: e.message, detail: e.detail, errors: e.errors });

// ================================================================ resolveScope
describe('US-15.1 / REQ-SEC-017 effective scope by actor', () => {
  it('all-centre actor, no filter → { all:true, centreIds:[] } (exactly these two keys)', async () => {
    const w = world();
    expect(await resolveScope(w.ctx(ADMIN), {})).toEqual({ all: true, centreIds: [] });
  });

  it('A1-only actor, no filter → { all:false, centreIds:[A1] }', async () => {
    const w = world();
    expect(await resolveScope(w.ctx(A1_ONLY), {})).toEqual({ all: false, centreIds: [A1] });
  });

  it('actor with centres {A1,A2}, no filter → exactly {A1,A2}', async () => {
    const w = world();
    const s = await resolveScope(w.ctx(MULTI_KEY), {});
    expect(s.all).toBe(false);
    expect(ids(s)).toEqual([A1, A2].sort());
  });

  it('non-staff partner membership (centreScope {all:false, []}) sees nothing and never widens: no filter → { all:false, centreIds:[] }', async () => {
    const w = world();
    expect(await resolveScope(w.ctx(PARTNER), {})).toEqual({ all: false, centreIds: [] });
    await expectLimsAsync(resolveScope(w.ctx(PARTNER), { centreIds: [A1] }), 'common.not_found', 404);
  });
});

describe('US-15.2 centre_id filter is intersected with the caller scope; a centre outside it is 404 common.not_found', () => {
  it('all-centre actor narrows to the requested centres → { all:false } (a filter ends "all")', async () => {
    const w = world();
    const s = await resolveScope(w.ctx(ADMIN), { centreIds: [A1, A3] });
    expect(s.all).toBe(false);
    expect(ids(s)).toEqual([A1, A3].sort());
  });

  it('duplicates in the request are collapsed', async () => {
    const w = world();
    const s = await resolveScope(w.ctx(ADMIN), { centreIds: [A3, A1, A3, A1] });
    expect(ids(s)).toEqual([A1, A3].sort());
  });

  it('A1-only: own centre ok; A2 → 404; mixed [A1, A2] → 404 as a whole (no partial answer)', async () => {
    const w = world();
    expect(await resolveScope(w.ctx(A1_ONLY), { centreIds: [A1] })).toEqual({ all: false, centreIds: [A1] });
    await expectLimsAsync(resolveScope(w.ctx(A1_ONLY), { centreIds: [A2] }), 'common.not_found', 404);
    await expectLimsAsync(resolveScope(w.ctx(A1_ONLY), { centreIds: [A1, A2] }), 'common.not_found', 404);
  });

  it('actor with {A1,A2}: A2 ok, A3 (same tenant, outside scope) → 404', async () => {
    const w = world();
    expect(ids(await resolveScope(w.ctx(MULTI_KEY), { centreIds: [A2] }))).toEqual([A2]);
    await expectLimsAsync(resolveScope(w.ctx(MULTI_KEY), { centreIds: [A3] }), 'common.not_found', 404);
  });

  it('no existence oracle: a real foreign-scope centre, a centre of another tenant and a non-existent id give the identical error, and the id is never echoed', async () => {
    const w = world();
    const probes = [A2, B1, NOPE];
    const errs = [];
    for (const id of probes) errs.push(await expectLimsAsync(resolveScope(w.ctx(A1_ONLY), { centreIds: [id] }), 'common.not_found', 404));
    expect(shape(errs[1]!)).toEqual(shape(errs[0]!));
    expect(shape(errs[2]!)).toEqual(shape(errs[0]!));
    for (const [e, id] of errs.map((x, i) => [x, probes[i]!] as const)) {
      expect(JSON.stringify({ m: e.message, d: e.detail, e: e.errors, s: e.stack?.split('\n')[0] }), id).not.toContain(id);
    }
  });

  it('07 P1: an all-centre actor of tenant A asking for a tenant-B centre or a non-existent centre → 404 (tenant ids are never trusted)', async () => {
    const w = world();
    await expectLimsAsync(resolveScope(w.ctx(ADMIN), { centreIds: [B1] }), 'common.not_found', 404);
    await expectLimsAsync(resolveScope(w.ctx(ADMIN), { centreIds: [A1, B1] }), 'common.not_found', 404);
    await expectLimsAsync(resolveScope(w.ctx(ADMIN), { centreIds: [NOPE] }), 'common.not_found', 404);
  });

  it('07 P1 mirrored: a tenant-B centre-restricted actor sees B1 only; tenant A centres → 404', async () => {
    const w = world();
    expect(await resolveScope(w.ctx('B:user:centre'), {})).toEqual({ all: false, centreIds: [B1] });
    expect(await resolveScope(w.ctx('B:user:centre'), { centreIds: [B1] })).toEqual({ all: false, centreIds: [B1] });
    await expectLimsAsync(resolveScope(w.ctx('B:user:centre'), { centreIds: [A1] }), 'common.not_found', 404);
  });

  it('hostile id strings (injection, prototype keys, empty, huge) never resolve and never surface a non-LimsError', async () => {
    const w = world();
    const hostile = ["' OR 1=1--", '__proto__', 'constructor', '', ' ', 'not-a-uuid', '%00', '../../etc/passwd', 'x'.repeat(10_000)];
    for (const actor of [ADMIN, A1_ONLY]) {
      for (const id of hostile) {
        const e = await rejection(resolveScope(w.ctx(actor), { centreIds: [id] }));
        expect(e instanceof LimsError, `${actor} ${id.slice(0, 20)}`).toBe(true);
        expect([400, 404]).toContain((e as LimsError).statusCode);
      }
    }
  });
});

describe('request limits (TRD §4: ≤ 20 centre_id, ≤ 20 branch_id) — rejected before any lookup', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => idFor(SEED, 0xf000 + i));

  it('21 centre ids → 400 common.validation_failed (not 404, not a 21-way core lookup)', async () => {
    const w = world();
    await expectLimsAsync(resolveScope(w.ctx(ADMIN), { centreIds: many(21) }), 'common.validation_failed', 400);
    expect(w.core.calls).toEqual([]);
  });

  it('21 branch ids → 400 common.validation_failed', async () => {
    const w = world();
    await expectLimsAsync(resolveScope(w.ctx(ADMIN), { branchIds: many(21) }), 'common.validation_failed', 400);
    expect(w.core.calls).toEqual([]);
  });

  it('exactly 20 is within the limit (answered by the existence check, 404 here because the ids do not exist)', async () => {
    const w = world();
    await expectLimsAsync(resolveScope(w.ctx(ADMIN), { centreIds: many(20) }), 'common.not_found', 404);
  });
});

describe('US-15.2 / 07 P5 branch_id → the branch\'s centres ∩ caller scope', () => {
  it('all-centre actor: branch BR1 → centres {A1,A2}; two branches → union', async () => {
    const w = world();
    const one = await resolveScope(w.ctx(ADMIN), { branchIds: [BR1] });
    expect(one.all).toBe(false);
    expect(ids(one)).toEqual([A1, A2].sort());
    expect(ids(await resolveScope(w.ctx(ADMIN), { branchIds: [BR1, BR2] }))).toEqual([A1, A2, A3].sort());
  });

  it('A1-only actor: branch BR1 (contains A2) does NOT widen the scope → {A1}', async () => {
    const w = world();
    expect(await resolveScope(w.ctx(A1_ONLY), { branchIds: [BR1] })).toEqual({ all: false, centreIds: [A1] });
  });

  it('A1-only actor: an existing branch with none of their centres → empty restricted scope (sees nothing), never all, never widened', async () => {
    const w = world();
    expect(await resolveScope(w.ctx(A1_ONLY), { branchIds: [BR2] })).toEqual({ all: false, centreIds: [] });
  });

  it('unknown branch and a branch of another tenant → 404 common.not_found, id not echoed, same error shape', async () => {
    const w = world();
    const a = await expectLimsAsync(resolveScope(w.ctx(ADMIN), { branchIds: [NOPE_BR] }), 'common.not_found', 404);
    const b = await expectLimsAsync(resolveScope(w.ctx(ADMIN), { branchIds: [BRB] }), 'common.not_found', 404);
    const c = await expectLimsAsync(resolveScope(w.ctx(A1_ONLY), { branchIds: [BRB] }), 'common.not_found', 404);
    expect(shape(b)).toEqual(shape(a));
    expect(shape(c)).toEqual(shape(a));
    expect(JSON.stringify({ m: b.message, d: b.detail, e: b.errors })).not.toContain(BRB);
  });

  it('a valid branch plus an unknown one → 404 as a whole', async () => {
    const w = world();
    await expectLimsAsync(resolveScope(w.ctx(ADMIN), { branchIds: [BR1, NOPE_BR] }), 'common.not_found', 404);
  });

  it('centre_id and branch_id together are intersected', async () => {
    const w = world();
    expect(await resolveScope(w.ctx(ADMIN), { centreIds: [A2], branchIds: [BR1] })).toEqual({ all: false, centreIds: [A2] });
    expect(await resolveScope(w.ctx(ADMIN), { centreIds: [A3], branchIds: [BR1] })).toEqual({ all: false, centreIds: [] });
    expect(await resolveScope(w.ctx(A1_ONLY), { centreIds: [A1], branchIds: [BR1] })).toEqual({ all: false, centreIds: [A1] });
    expect(await resolveScope(w.ctx(A1_ONLY), { centreIds: [A1], branchIds: [BR2] })).toEqual({ all: false, centreIds: [] });
  });

  it('a foreign centre combined with a valid branch is still 404 (the branch does not launder it)', async () => {
    const w = world();
    await expectLimsAsync(resolveScope(w.ctx(A1_ONLY), { centreIds: [A2], branchIds: [BR1] }), 'common.not_found', 404);
  });

  it('a tenant-B restricted actor: tenant A branch → 404', async () => {
    const w = world();
    await expectLimsAsync(resolveScope(w.ctx('B:user:centre'), { branchIds: [BR1] }), 'common.not_found', 404);
    expect(await resolveScope(w.ctx('B:user:centre'), { branchIds: [BRB] })).toEqual({ all: false, centreIds: [B1] });
  });
});

describe('fake actors: locked, aal1, unknown (IdentityPort fake personas)', () => {
  it('locked actor → auth.account_locked 403 propagates; no scope is produced and ctx.core is not read', async () => {
    const w = world();
    await expectLimsAsync(resolveScope(w.ctx(LOCKED), {}), 'auth.account_locked', 403);
    await expectLimsAsync(resolveScope(w.ctx(LOCKED), { centreIds: [A1], branchIds: [BR1] }), 'auth.account_locked', 403);
    expect(w.core.calls).toEqual([]);
  });

  it('aal1 actor: the scope service does not decide MFA (assertRole does) — the all-centre scope resolves exactly as at aal2, filters included', async () => {
    const w = world();
    expect(await resolveScope(w.ctx(AAL1), {})).toEqual({ all: true, centreIds: [] });
    expect(await resolveScope(w.ctx(AAL1), { centreIds: [A1] })).toEqual({ all: false, centreIds: [A1] });
    await expectLimsAsync(resolveScope(w.ctx(AAL1), { centreIds: [B1] }), 'common.not_found', 404);
  });

  it('actor without a membership → auth.unauthenticated 401, not an empty or all-centre scope', async () => {
    const w = world();
    await expectLimsAsync(resolveScope(w.ctx('A:user:ghost'), {}), 'auth.unauthenticated', 401);
  });

  it('IdentityPort failure fails closed: the error propagates, no scope', async () => {
    const w = world();
    w.identity.failNext('getActor', 'common.dependency_unavailable');
    const e = await rejection(resolveScope(w.ctx(ADMIN), {}));
    expect(isLimsError(e, 'common.dependency_unavailable')).toBe(true);
  });

  it('ctx.core failure fails closed on the branch path: the error propagates, no partial scope', async () => {
    const w = world();
    w.core.failNext('common.dependency_unavailable');
    const e = await rejection(resolveScope(w.ctx(A1_ONLY), { branchIds: [BR1] }));
    expect(isLimsError(e, 'common.dependency_unavailable')).toBe(true);
  });
});

describe('getActor is memoised per request — never across requests (TRD §4 step 1)', () => {
  it('one getActor call for several resolveScope calls on the same ctx', async () => {
    const w = world();
    const ctx = w.ctx(A1_ONLY);
    await resolveScope(ctx, {});
    await resolveScope(ctx, { centreIds: [A1] });
    await resolveScope(ctx, { branchIds: [BR1] });
    expect(w.identity.calls('getActor').length).toBe(1);
  });

  it('concurrent calls on one ctx agree with each other', async () => {
    const w = world();
    const ctx = w.ctx(MULTI_KEY);
    const [a, b, c] = await Promise.all([resolveScope(ctx, {}), resolveScope(ctx, { centreIds: [A2] }), resolveScope(ctx, {})]);
    expect(ids(a)).toEqual([A1, A2].sort());
    expect(ids(b)).toEqual([A2]);
    expect(ids(c)).toEqual(ids(a));
  });

  it('a new request re-reads the actor: a membership narrowed between requests is seen immediately (US-15.5)', async () => {
    const w = world();
    const first = w.ctx(MULTI_KEY);
    expect(ids(await resolveScope(first, {}))).toEqual([A1, A2].sort());
    w.identity.__seed({ memberships: [{ ...MULTI, centreScope: { all: false, centreIds: [A1] } }] });
    expect(ids(await resolveScope(w.ctx(MULTI_KEY), {}))).toEqual([A1]);
    await expectLimsAsync(resolveScope(w.ctx(MULTI_KEY), { centreIds: [A2] }), 'common.not_found', 404);
    expect(ids(await resolveScope(first, {}))).toEqual([A1, A2].sort()); // the old request keeps its own snapshot
  });

  it('two actors in one tenant never share a memo or cache (interleaved requests)', async () => {
    const w = world();
    const admin = w.ctx(ADMIN);
    const scoped = w.ctx(A1_ONLY);
    const [s1, s2, s3, s4] = [await resolveScope(admin, {}), await resolveScope(scoped, {}), await resolveScope(admin, {}), await resolveScope(scoped, {})];
    expect([s1, s3]).toEqual([{ all: true, centreIds: [] }, { all: true, centreIds: [] }]);
    expect([s2, s4]).toEqual([{ all: false, centreIds: [A1] }, { all: false, centreIds: [A1] }]);
  });
});

describe('the returned Scope is the caller\'s own copy', () => {
  it('mutating a returned scope does not change the next request\'s scope', async () => {
    const w = world();
    const s = await resolveScope(w.ctx(A1_ONLY), {});
    try { (s.centreIds as string[]).push(B1, A2); } catch { /* frozen is fine */ }
    try { (s as { all: boolean }).all = true; } catch { /* frozen is fine */ }
    expect(await resolveScope(w.ctx(A1_ONLY), {})).toEqual({ all: false, centreIds: [A1] });
  });

  it('mutating the returned scope of a filtered call does not leak into the memoised actor of the same request', async () => {
    const w = world();
    const ctx = w.ctx(MULTI_KEY);
    const s = await resolveScope(ctx, {});
    try { (s.centreIds as string[]).length = 0; } catch { /* frozen is fine */ }
    expect(ids(await resolveScope(ctx, {}))).toEqual([A1, A2].sort());
  });
});

describe('invariants over actors × centre filters × branch filters (BOLA matrix, 07 P3/P5)', () => {
  const ACTORS: { key: string; centres: readonly string[] | 'all' }[] = [
    { key: ADMIN, centres: 'all' }, { key: AAL1, centres: 'all' }, { key: A1_ONLY, centres: [A1] }, { key: MULTI_KEY, centres: [A1, A2] }, { key: PARTNER, centres: [] },
  ];
  const CENTRE_FILTERS: (string[] | undefined)[] = [undefined, [A1], [A2], [A3], [A1, A2], [B1], ['bogus']];
  const BRANCH_FILTERS: (string[] | undefined)[] = [undefined, [BR1], [BR2], [BR1, BR2], [BRB], ['bogus']];
  const BRANCH_CENTRES: Record<string, string[]> = { [BR1]: [A1, A2], [BR2]: [A3] };

  it('never returns more than the caller may see, never "all" with a filter, and rejects every foreign/unknown id with 404', async () => {
    const w = world();
    const bad: string[] = [];
    for (const actor of ACTORS) {
      for (const cf of CENTRE_FILTERS) {
        for (const bf of BRANCH_FILTERS) {
          const label = `${actor.key} centre=${JSON.stringify(cf)} branch=${JSON.stringify(bf)}`;
          const req = { ...(cf ? { centreIds: cf } : {}), ...(bf ? { branchIds: bf } : {}) };
          const mustReject = (cf ?? []).some((c) => c === B1 || c === 'bogus' || (actor.centres !== 'all' && !actor.centres.includes(c)))
            || (bf ?? []).some((b) => b === BRB || b === 'bogus');
          let out: Awaited<ReturnType<typeof resolveScope>> | undefined;
          let err: unknown;
          try { out = await resolveScope(w.ctx(actor.key), req); } catch (e) { err = e; }
          if (mustReject) {
            if (out || !isLimsError(err, 'common.not_found')) bad.push(`${label}: expected 404, got ${out ? JSON.stringify(out) : String(err)}`);
            continue;
          }
          if (!out) { bad.push(`${label}: unexpected rejection ${String(err)}`); continue; }
          if (Object.keys(out).sort().join() !== 'all,centreIds') bad.push(`${label}: keys ${Object.keys(out)}`);
          if (out.all && (actor.centres !== 'all' || cf || bf || out.centreIds.length)) bad.push(`${label}: all=true wrongly (${JSON.stringify(out)})`);
          if (!out.all) {
            if (actor.centres !== 'all') for (const c of out.centreIds) if (!actor.centres.includes(c)) bad.push(`${label}: widened beyond the actor with ${c}`);
            if (cf) for (const c of out.centreIds) if (!cf.includes(c)) bad.push(`${label}: ${c} not requested`);
            if (bf) { const allowed = bf.flatMap((b) => BRANCH_CENTRES[b] ?? []); for (const c of out.centreIds) if (!allowed.includes(c)) bad.push(`${label}: ${c} not in the branch filter`); }
            if (new Set(out.centreIds).size !== out.centreIds.length) bad.push(`${label}: duplicates`);
          } else if (actor.centres === 'all' && (cf || bf)) bad.push(`${label}: filter ignored`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

// ================================================================ resolvePeriod (re-exposed by the context service; US-02.3–5 + error mapping)
const TODAY = '2026-11-06' as never;
const MAX = 366;
const VALIDATION = ['common.validation_failed', 400] as const;
const OUT_OF_RANGE = ['common.date_out_of_range', 422] as const;
const TOO_LARGE = ['analytics.range_too_large', 422] as const;
const lims = (fn: () => unknown, [code, status]: readonly [string, number]) => {
  let thrown: unknown;
  try { fn(); } catch (e) { thrown = e; }
  if (!isLimsError(thrown, code)) throw new Error(`expected LimsError ${code}, got ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : 'no throw'}`);
  expect(thrown.statusCode, code).toBe(status);
  return thrown;
};

describe('resolvePeriod via the context service — happy paths match the golden table (US-02.7)', () => {
  it('no selector → [today, today+1), one day', () => {
    const p = resolvePeriod({}, TODAY, MAX);
    expect([p.from, p.to, p.days]).toEqual(['2026-11-06', '2026-11-07', 1]);
  });

  it('bs_month → golden first day .. next month\'s first day (exclusive)', () => {
    const g = golden(2082, 5);
    const p = resolvePeriod({ bs_month: bsKey(2082, 5) }, TODAY, MAX);
    expect([p.from, p.to, p.days, p.bsMonth]).toEqual([g.ad_first_day, golden(2082, 6).ad_first_day, g.days, bsKey(2082, 5)]);
  });

  it('fiscal_year_bs 2082/83 → Shrawan 1 2082 .. Shrawan 1 2083 (exclusive)', () => {
    const from = golden(2082, 4).ad_first_day;
    const to = golden(2083, 4).ad_first_day;
    const p = resolvePeriod({ fiscal_year_bs: '2082/83' }, TODAY, MAX);
    expect([p.from, p.to, p.days]).toEqual([from, to, diffDays(from, to)]);
  });

  it('explicit dates pass through', () => {
    const p = resolvePeriod({ business_date_from: '2026-10-01', business_date_to: '2026-10-08' }, TODAY, MAX);
    expect([p.from, p.to, p.days]).toEqual(['2026-10-01', '2026-10-08', 7]);
  });
});

describe('US-02.3 more than one selector (or half a date range) → 400 common.validation_failed, errors[].path names the offending params', () => {
  const D = { business_date_from: '2026-10-01', business_date_to: '2026-10-08' };
  const cases: [string, object, string[]][] = [
    ['dates + bs_month', { ...D, bs_month: bsKey(2082, 5) }, ['business_date_from', 'business_date_to', 'bs_month']],
    ['dates + fiscal_year_bs', { ...D, fiscal_year_bs: '2082/83' }, ['business_date_from', 'business_date_to', 'fiscal_year_bs']],
    ['bs_month + fiscal_year_bs', { bs_month: bsKey(2082, 5), fiscal_year_bs: '2082/83' }, ['bs_month', 'fiscal_year_bs']],
    ['all three', { ...D, bs_month: bsKey(2082, 5), fiscal_year_bs: '2082/83' }, ['business_date_from', 'business_date_to', 'bs_month', 'fiscal_year_bs']],
    ['one date bound with bs_month', { business_date_from: '2026-10-01', bs_month: bsKey(2082, 5) }, ['business_date_from', 'bs_month']],
  ];
  it.each(cases)('%s', (_n, q, paths) => {
    const e = lims(() => resolvePeriod(q as never, TODAY, MAX), VALIDATION);
    const got = (e.errors ?? []).map((x) => x.path);
    for (const p of paths) expect(got, p).toContain(p);
  });

  it('only business_date_from, or only business_date_to → 400 with a date param as path', () => {
    for (const q of [{ business_date_from: '2026-10-01' }, { business_date_to: '2026-10-08' }]) {
      const e = lims(() => resolvePeriod(q as never, TODAY, MAX), VALIDATION);
      expect((e.errors ?? []).length).toBeGreaterThan(0);
      for (const x of e.errors ?? []) expect(['business_date_from', 'business_date_to']).toContain(x.path);
    }
  });

  it('from >= to (equal or reversed) → 400', () => {
    lims(() => resolvePeriod({ business_date_from: '2026-10-08', business_date_to: '2026-10-08' }, TODAY, MAX), VALIDATION);
    lims(() => resolvePeriod({ business_date_from: '2026-10-08', business_date_to: '2026-10-01' }, TODAY, MAX), VALIDATION);
  });
});

describe('US-02.4 range longer than maxDays (injected; 366 by default) → 422 analytics.range_too_large', () => {
  const FROM = '2026-01-01';
  it('366 days is allowed, 367 is not', () => {
    expect(resolvePeriod({ business_date_from: FROM, business_date_to: addDays(FROM, 366) }, TODAY, MAX).days).toBe(366);
    lims(() => resolvePeriod({ business_date_from: FROM, business_date_to: addDays(FROM, 367) }, TODAY, MAX), TOO_LARGE);
  });

  it('maxDays is the injected value, not a constant: 31 ok / 32 too large at maxDays=31', () => {
    expect(resolvePeriod({ business_date_from: FROM, business_date_to: addDays(FROM, 31) }, TODAY, 31).days).toBe(31);
    lims(() => resolvePeriod({ business_date_from: FROM, business_date_to: addDays(FROM, 32) }, TODAY, 31), TOO_LARGE);
  });

  it('applies to bs_month and fiscal_year_bs too (a B.S. selector cannot bypass the cap)', () => {
    const month = golden(2082, 5).days;
    expect(resolvePeriod({ bs_month: bsKey(2082, 5) }, TODAY, month).days).toBe(month);
    lims(() => resolvePeriod({ bs_month: bsKey(2082, 5) }, TODAY, month - 1), TOO_LARGE);
    lims(() => resolvePeriod({ fiscal_year_bs: '2082/83' }, TODAY, 100), TOO_LARGE);
  });

  it('a huge span is rejected without iterating (fast)', () => {
    const t0 = Date.now();
    lims(() => resolvePeriod({ business_date_from: '0001-01-01', business_date_to: '9999-12-31' }, TODAY, MAX), TOO_LARGE);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('US-02.5 B.S. outside 1975–2099 → 422 common.date_out_of_range; malformed → 400; nothing else escapes', () => {
  it('bs_month before 1975 and after 2099', () => {
    lims(() => resolvePeriod({ bs_month: '1974-12' }, TODAY, MAX), OUT_OF_RANGE);
    lims(() => resolvePeriod({ bs_month: '2100-01' }, TODAY, MAX), OUT_OF_RANGE);
  });

  it('fiscal_year_bs before 1975 and after the last in-table year', () => {
    lims(() => resolvePeriod({ fiscal_year_bs: '1974/75' }, TODAY, MAX), OUT_OF_RANGE);
    lims(() => resolvePeriod({ fiscal_year_bs: '2100/01' }, TODAY, MAX), OUT_OF_RANGE);
  });

  it('last golden month 2099-12 resolves (in range), first supported month 1975-01 resolves', () => {
    const last = GOLDEN.at(-1)!;
    expect(`${last.bs_year}-${String(last.bs_month).padStart(2, '0')}`).toBe('2099-12');
    expect(resolvePeriod({ bs_month: '2099-12' }, TODAY, MAX).days).toBe(last.days);
    expect(resolvePeriod({ bs_month: '1975-01' }, TODAY, MAX).days).toBeGreaterThanOrEqual(29);
  });

  it('error mapping: malformed or hostile selector values are 400/422 LimsErrors — never a raw BsDateError / TypeError (would be a 500)', () => {
    const bad: object[] = [
      { bs_month: '2082-13' }, { bs_month: '2082-00' }, { bs_month: '82-01' }, { bs_month: '2082-1' }, { bs_month: ' 2082-01' },
      { bs_month: '2082-01\n' }, { bs_month: '2082-01; DROP TABLE x' }, { bs_month: 208201 }, { bs_month: ['2082-01'] }, { bs_month: null }, { bs_month: {} },
      { fiscal_year_bs: '2082/84' }, { fiscal_year_bs: '2082-83' }, { fiscal_year_bs: '082/83' }, { fiscal_year_bs: 2082 }, { fiscal_year_bs: null },
      { business_date_from: '2026-02-30', business_date_to: '2026-03-01' }, { business_date_from: '2026-13-01', business_date_to: '2026-14-01' },
      { business_date_from: 'yesterday', business_date_to: 'today' }, { business_date_from: 20261001, business_date_to: 20261008 },
      { business_date_from: null, business_date_to: null }, { business_date_from: '2026-10-01T00:00:00Z', business_date_to: '2026-10-08' },
    ];
    const escaped: string[] = [];
    for (const q of bad) {
      try { resolvePeriod(q as never, TODAY, MAX); escaped.push(`${JSON.stringify(q)}: resolved`); } catch (e) {
        if (!(e instanceof LimsError)) escaped.push(`${JSON.stringify(q)}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
        else if (![400, 422].includes(e.statusCode)) escaped.push(`${JSON.stringify(q)}: ${e.code} → ${e.statusCode}`);
      }
    }
    expect(escaped).toEqual([]);
  });

  it('an unusable "today" is a 400, not a silent default', () => {
    lims(() => resolvePeriod({}, 'not-a-date' as never, MAX), VALIDATION);
  });
});
