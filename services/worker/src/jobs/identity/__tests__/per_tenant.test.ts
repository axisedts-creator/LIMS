// C2-T27 per_tenant daily tasks (02-TRD §10: identity.apply_pending_numbering 00:10, identity.access_review_due 06:40; 08 A13 P-6, A23.1; AC-C3.3 pending numbering).
// Both run as the identity system actor under THAT tenant's claims (ctx.tenantId = payload.tenant_id; the core guarantees it, the task re-checks). Injected clock = ctx.now().
// ASSUMED seams (spec silent) — tasks/<id>.ts export <CONST>, `<camel>: TaskHandler` (default wiring) and `create<Pascal>({ repo })`:
//   apply_pending_numbering -> APPLY_PENDING_NUMBERING / applyPendingNumbering / createApplyPendingNumbering; repo:
//     loadPending(tx, tenantId) -> { version, pending_invoice_no_pattern, pending_credit_note_no_pattern, pending_effective_fy_bs } | undefined   (the tenant_settings row)
//     apply(tx, tenantId, change, actorId) -> void   change = ONLY the keys that had a pending value: { invoice_no_pattern?, credit_note_no_pattern? }; the repo moves them into
//       the live columns, clears the three pending_* columns and bumps version (`tenant_settings__update__tenant`).
//   access_review_due -> ACCESS_REVIEW_DUE / accessReviewDue / createAccessReviewDue; repo:
//     lastReview(tx, tenantId) -> { id, reviewed_at(ISO) } | undefined   (newest identity.access_reviews row)
//     hasLiveNotice(tx, tenantId, nowIso) -> boolean   (an admin_notices row kind 'access_review_due' with expires_at > now)
//     insertNotice(tx, { tenantId, kind, subjectType, subjectId, expiresAt(ISO), actorId }) -> void
// SPEC GAP (CR note in .orchestra/notes/C2.T27-tests.md): a tenant with NO access review has no subject_id for the notice (admin_notices__subject__ck needs one for kind access_review_due):
//   only the invariant "a notice is never inserted with a null subject_id" is asserted for that case.
import { bsToAd, fiscalYearBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { describe, expect, it, vi } from 'vitest';
import { setup, systemActorOf } from '../../../core/__tests__/helpers.js';
import { manifest } from '../index.js';
import { ACCESS_REVIEW_DUE, accessReviewDue, createAccessReviewDue } from '../tasks/access_review_due.js';
import { APPLY_PENDING_NUMBERING, applyPendingNumbering, createApplyPendingNumbering } from '../tasks/apply_pending_numbering.js';
import { ACTOR, NPT_OFFSET_MS, OTHER, TENANT, ctx27, err, idN, makeTx } from './t27.helpers.js';

// B.S. 2084/85 starts on Shrawan 1 2084; the cron runs at 00:10 Asia/Kathmandu. FY_START_UTC = the instant 00:00 NPT of that day.
const FY_START_AD = bsToAd({ year: 2084, month: 4, day: 1 }) as IsoDate;
const FY_START_UTC = Date.parse(`${FY_START_AD}T00:00:00.000Z`) - NPT_OFFSET_MS;
const iso = (ms: number) => new Date(ms).toISOString();
const CRON_TIME = iso(FY_START_UTC + 10 * 60_000);

describe('sanity of the fixture dates', () => {
  it('2084/85 begins at FY_START_AD and the preceding instant is still FY 2083/84', () => {
    expect(fiscalYearBs(FY_START_AD).long).toBe('2084/85'); expect(fiscalYearBs(new Date(FY_START_UTC - 1000).toISOString().slice(0, 10) as IsoDate).long).toMatch(/^208[34]\//);
  });
});

describe('task ids', () => { it('are the TRD §10 names', () => { expect([APPLY_PENDING_NUMBERING, ACCESS_REVIEW_DUE]).toEqual(['identity.apply_pending_numbering', 'identity.access_review_due']); }); });

// ------------------------------------------------------------------------------------------------------------------------------- apply_pending_numbering
const pending = (o: Record<string, unknown> = {}) => ({ version: 7, pending_invoice_no_pattern: 'INV-{fyl}-{seq:6}', pending_credit_note_no_pattern: 'CNX-{fyl}-{seq:6}', pending_effective_fy_bs: '2084/85', ...o });
function settingsRepo(initial?: Record<string, unknown>) {
  let row = initial ? { ...initial } : undefined; const applied: Array<{ tenantId: string; change: unknown; actorId: string }> = [];
  const repo = {
    loadPending: vi.fn(async () => (row ? { ...row } : undefined)),
    apply: vi.fn(async (_tx: unknown, tenantId: string, change: Record<string, unknown>, actorId: string) => {
      applied.push({ tenantId, change, actorId }); row = { ...row!, pending_invoice_no_pattern: null, pending_credit_note_no_pattern: null, pending_effective_fy_bs: null, version: Number(row!['version']) + 1 };
    }),
  };
  return { repo, applied };
}
const applyRun = async (initial: Record<string, unknown> | undefined, now: string, o: { payload?: Record<string, unknown>; tenantId?: string | undefined } = {}) => {
  const r = settingsRepo(initial); const c = ctx27({ tenantId: 'tenantId' in o ? o.tenantId : TENANT, now, tx: makeTx().tx });
  const e = await err(createApplyPendingNumbering({ repo: r.repo } as any)(o.payload ?? { tenant_id: TENANT }, c.ctx)); return { ...r, e, ctx: c.ctx };
};

describe('identity.apply_pending_numbering (per_tenant, AC-C3.3)', () => {
  it('applies both pending patterns once the effective B.S. fiscal year has started, as the system actor of that tenant', async () => {
    const r = await applyRun(pending(), CRON_TIME); expect(r.e).toBeUndefined();
    expect(r.applied).toEqual([{ tenantId: TENANT, change: { invoice_no_pattern: 'INV-{fyl}-{seq:6}', credit_note_no_pattern: 'CNX-{fyl}-{seq:6}' }, actorId: ACTOR }]);
  });
  it('is Asia/Kathmandu-aware: 23:59:59 NPT on the eve (UTC date = the eve) does not apply, 00:00:00 NPT (still the eve in UTC) does', async () => {
    expect((await applyRun(pending(), iso(FY_START_UTC - 1000))).applied).toHaveLength(0);
    expect((await applyRun(pending(), iso(FY_START_UTC))).applied).toHaveLength(1);
  });
  it('a pending change whose fiscal year has not started stays pending (still in FY 2083/84)', async () => {
    expect((await applyRun(pending(), '2026-11-11T04:00:00.000Z')).applied).toHaveLength(0);
  });
  it('a pending change whose effective year is already past (cron was down for a year) is applied as well', async () => {
    expect((await applyRun(pending(), iso(FY_START_UTC + 400 * 86_400_000))).applied).toHaveLength(1);
  });
  it('passes only the keys that were pending (invoice only / credit note only), never null/undefined for the other', async () => {
    expect((await applyRun(pending({ pending_credit_note_no_pattern: null }), CRON_TIME)).applied[0]!.change).toEqual({ invoice_no_pattern: 'INV-{fyl}-{seq:6}' });
    expect((await applyRun(pending({ pending_invoice_no_pattern: null }), CRON_TIME)).applied[0]!.change).toEqual({ credit_note_no_pattern: 'CNX-{fyl}-{seq:6}' });
  });
  it('nothing pending (all pending_* NULL) or no settings row -> no write, no error', async () => {
    const none = pending({ pending_invoice_no_pattern: null, pending_credit_note_no_pattern: null, pending_effective_fy_bs: null });
    expect(await applyRun(none, CRON_TIME)).toMatchObject({ e: undefined, applied: [] }); expect(await applyRun(undefined, CRON_TIME)).toMatchObject({ e: undefined, applied: [] });
  });
  it('is idempotent: a second run (or the next day) finds nothing pending and writes nothing', async () => {
    const r = settingsRepo(pending()); const task = createApplyPendingNumbering({ repo: r.repo } as any); const c = ctx27({ tenantId: TENANT, now: CRON_TIME, tx: makeTx().tx });
    await task({ tenant_id: TENANT }, c.ctx); await task({ tenant_id: TENANT }, c.ctx); expect(r.applied).toHaveLength(1);
  });
  it('uses ctx.now(), not the machine clock: the same row is untouched at an early injected time and applied at a late one', async () => {
    expect((await applyRun(pending(), iso(FY_START_UTC - 86_400_000))).applied).toHaveLength(0); expect((await applyRun(pending(), iso(FY_START_UTC + 86_400_000))).applied).toHaveLength(1);
  });
  it('a repo failure propagates (retry), nothing is swallowed', async () => {
    const repo = { loadPending: async () => pending(), apply: async () => { throw new Error('db down'); } };
    expect(await err(createApplyPendingNumbering({ repo } as any)({ tenant_id: TENANT }, ctx27({ tenantId: TENANT, now: CRON_TIME, tx: makeTx().tx }).ctx))).toBeDefined();
  });
  it.each([
    ['payload tenant differs from the job tenant', { tenant_id: OTHER }, TENANT], ['payload without tenant_id', {}, TENANT], ['payload with extra keys', { tenant_id: TENANT, x: 1 }, TENANT],
    ['a platform job (ctx.tenantId undefined)', { tenant_id: TENANT }, undefined],
  ] as const)('rejects %s and writes nothing (cross-tenant guard)', async (_n, payload, tenantId) => {
    const r = await applyRun(pending(), CRON_TIME, { payload: payload as any, tenantId }); expect(r.e).toBeDefined(); expect(r.applied).toHaveLength(0); expect(r.repo.loadPending).not.toHaveBeenCalledWith(expect.anything(), OTHER);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- access_review_due
const NOW = '2026-11-11T01:10:00.000Z';
const DAY = 86_400_000;
const REVIEW = idN(0xc1);
function reviewRepo(o: { last?: { id: string; reviewed_at: string } | undefined; live?: boolean } = {}) {
  const inserted: any[] = []; let live = o.live ?? false;
  const repo = {
    lastReview: vi.fn(async () => o.last), hasLiveNotice: vi.fn(async () => live),
    insertNotice: vi.fn(async (_tx: unknown, n: unknown) => { inserted.push(n); live = true; }),
  };
  return { repo, inserted };
}
const reviewRun = async (o: Parameters<typeof reviewRepo>[0], now = NOW, run: { payload?: Record<string, unknown>; tenantId?: string | undefined } = {}) => {
  const r = reviewRepo(o); const c = ctx27({ tenantId: 'tenantId' in run ? run.tenantId : TENANT, now, tx: makeTx().tx });
  const e = await err(createAccessReviewDue({ repo: r.repo } as any)(run.payload ?? { tenant_id: TENANT }, c.ctx)); return { ...r, e };
};
const ago = (days: number, extraMs = 0) => ({ id: REVIEW, reviewed_at: iso(Date.parse(NOW) - days * DAY - extraMs) });

describe('identity.access_review_due (per_tenant)', () => {
  it('last review > 90 days old and no live notice -> inserts ONE notice (kind access_review_due, subject access_review = that review), expiring in the future, actor = system actor', async () => {
    const r = await reviewRun({ last: ago(91) }); expect(r.e).toBeUndefined(); expect(r.inserted).toHaveLength(1);
    expect(r.inserted[0]).toMatchObject({ tenantId: TENANT, kind: 'access_review_due', subjectType: 'access_review', subjectId: REVIEW, actorId: ACTOR });
    expect(Date.parse(r.inserted[0].expiresAt)).toBeGreaterThan(Date.parse(NOW));
  });
  it('boundary: exactly 90 days is not due, 90 days + 1 minute is', async () => {
    expect((await reviewRun({ last: ago(90) })).inserted).toHaveLength(0); expect((await reviewRun({ last: ago(90, 60_000) })).inserted).toHaveLength(1);
  });
  it('a recent review (30 days) -> nothing', async () => { expect((await reviewRun({ last: ago(30) })).inserted).toHaveLength(0); });
  it('an unexpired access_review_due notice already exists -> no second notice', async () => {
    const r = await reviewRun({ last: ago(200), live: true }); expect(r.e).toBeUndefined(); expect(r.inserted).toHaveLength(0);
  });
  it('an expired notice does not block: hasLiveNotice is asked with the injected now', async () => {
    const r = await reviewRun({ last: ago(200), live: false }); expect(r.inserted).toHaveLength(1); expect(r.repo.hasLiveNotice).toHaveBeenCalledWith(expect.anything(), TENANT, NOW);
  });
  it('is idempotent: running twice inserts one notice', async () => {
    const r = reviewRepo({ last: ago(200) }); const task = createAccessReviewDue({ repo: r.repo } as any); const c = ctx27({ tenantId: TENANT, now: NOW, tx: makeTx().tx });
    await task({ tenant_id: TENANT }, c.ctx); await task({ tenant_id: TENANT }, c.ctx); expect(r.inserted).toHaveLength(1);
  });
  it('a tenant without any access review never gets a notice with a NULL subject_id (admin_notices__subject__ck)', async () => {
    const r = await reviewRun({ last: undefined }); expect(r.e).toBeUndefined(); for (const n of r.inserted) expect(n.subjectId).toMatch(/^[0-9a-f-]{36}$/i);
  });
  it('a repo failure propagates (retry)', async () => {
    const repo = { lastReview: async () => ago(200), hasLiveNotice: async () => false, insertNotice: async () => { throw new Error('db down'); } };
    expect(await err(createAccessReviewDue({ repo } as any)({ tenant_id: TENANT }, ctx27({ tenantId: TENANT, now: NOW, tx: makeTx().tx }).ctx))).toBeDefined();
  });
  it.each([
    ['payload tenant differs from the job tenant', { tenant_id: OTHER }, TENANT], ['payload without tenant_id', {}, TENANT], ['payload with extra keys', { tenant_id: TENANT, x: 1 }, TENANT],
    ['a platform job (ctx.tenantId undefined)', { tenant_id: TENANT }, undefined],
  ] as const)('rejects %s and inserts nothing (cross-tenant guard)', async (_n, payload, tenantId) => {
    const r = await reviewRun({ last: ago(200) }, NOW, { payload: payload as any, tenantId }); expect(r.e).toBeDefined(); expect(r.inserted).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- through the real core
describe.each([APPLY_PENDING_NUMBERING, ACCESS_REVIEW_DUE])('%s through the worker core (default wiring)', (id) => {
  it('runs in ONE transaction with the identity system actor under the payload tenant claims and completes on an empty tenant', async () => {
    const s = await setup([manifest]); await s.run(id, { tenant_id: TENANT }, { attempts: 1 });
    const tx = s.world.txLog.at(-1)!; expect(tx.claims0).toEqual({ sub: systemActorOf('identity'), tenant_id: TENANT, actor_type: 'system' }); expect(tx.operation).toBe(id); expect(tx.outcome).toBe('commit');
  });
  it('a job without tenant_id is refused by the core before any statement runs', async () => {
    const s = await setup([manifest]); expect(await err(s.run(id, {}, { attempts: 1 }))).toBeDefined(); expect(s.world.txLog.flatMap((t) => t.stmts).filter((x) => /identity\./.test(x.text))).toHaveLength(0);
  });
});
describe('apply_pending_numbering default wiring', () => {
  it('writes nothing for a tenant whose settings row has no pending numbering (fake DB returns no row)', async () => {
    const s = await setup([manifest]); await s.run(APPLY_PENDING_NUMBERING, { tenant_id: TENANT }, { attempts: 1 }); expect(s.world.writes).toHaveLength(0);
  });
  it('exports a TaskHandler for each task', () => { expect(typeof applyPendingNumbering).toBe('function'); expect(typeof accessReviewDue).toBe('function'); });
});
