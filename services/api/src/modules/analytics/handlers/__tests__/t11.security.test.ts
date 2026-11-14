// C8 AN-T11 — cross-cutting security checks for getTestsDoneReport / getQualityIndicatorsReport / getDeliveryReport / getInterfacesReport
// (07-SECURITY P1 tenant isolation, P3 authz, P4 centre scope, P5 period limits, REQ-SEC-013/017/081, abuse case 1). Repos are in-memory emulators.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import {
  A1, ADMIN, NO_PERM, OPS11, OWNER_A1, OWNER_MULTI, PARTNER, SENTINEL, WINDOW, call11, db, expectLims, makeCtx11, ok11, seedT11, type Op11,
} from './helpers.t11.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t11.js')).rollupsMockT11);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t11.js')).labelsRepoMockT11);
vi.mock('../../repository/sourceViews.repo.js', async () => (await import('./helpers.t11.js')).sourceViewsMockT11);

beforeEach(() => { seedT11(); vi.clearAllMocks(); });
const each = it.each(OPS11 as readonly Op11[]);

describe('every T11 operation is implemented (not the AN-T01 stub)', () => {
  each('%s answers 200 with a report_code or section body', async (op) => {
    const body = await ok11(op, (await makeCtx11(ADMIN)).ctx, WINDOW);
    expect(body).toMatchObject({ scope: { all_centres: true }, period: { business_date_from: WINDOW.business_date_from } });
  });
});

describe('P3 — authorisation first', () => {
  each('%s: no analytics.dashboard.read (staff without it, partner) → 403 auth.forbidden, no core port / tx / rollup touched', async (op) => {
    for (const who of [NO_PERM, PARTNER]) {
      const { ctx, touched } = await makeCtx11(who);
      await expectLims(call11(op, ctx, WINDOW), 'auth.forbidden', 403);
      expect(touched, who).toEqual([]);
    }
    expect(db.calls).toEqual([]);
  });
});

describe('P5 — period validation happens before any read', () => {
  each('%s: bs_month + dates → 400; 400-day range → 422 analytics.range_too_large; bs_month 2100-01 → 422 common.date_out_of_range', async (op) => {
    await expectLims(call11(op, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, bs_month: '2082-07' }), 'common.validation_failed', 400);
    await expectLims(call11(op, (await makeCtx11(ADMIN)).ctx, { business_date_from: '2025-01-01', business_date_to: '2026-02-05' }), 'analytics.range_too_large', 422);
    await expectLims(call11(op, (await makeCtx11(ADMIN)).ctx, { bs_month: '2100-01' }), 'common.date_out_of_range', 422);
    expect(db.calls).toEqual([]);
  });
});

describe('P1 / REQ-SEC-013 — tenant isolation', () => {
  each('%s: every repo call carries ctx.tenantId; tenant B sentinel values (987654321) never reach the body', async (op) => {
    const { ctx } = await makeCtx11(ADMIN);
    const body = await ok11(op, ctx, WINDOW);
    expect(db.calls.length).toBeGreaterThan(0);
    for (const c of db.calls) expect(c.args.tenantId, c.fn).toBe(ctx.tenantId);
    expect(JSON.stringify(body)).not.toContain(String(SENTINEL));
  });

  each('%s: a client-supplied tenant_id / unknown query parameters are ignored, never forwarded to a repo', async (op) => {
    const { ctx } = await makeCtx11(OWNER_A1);
    await ok11(op, ctx, { ...WINDOW, tenant_id: '00000000-0000-4000-8000-00000000beef', scope: 'all' });
    for (const c of db.calls) {
      expect(c.args.tenantId).toBe(ctx.tenantId);
      expect(c.args.scope).toEqual({ all: false, centreIds: [A1] });
      expect(JSON.stringify(c.args)).not.toContain('beef');
    }
  });
});

describe('P4 / REQ-SEC-017 — a centre-restricted user never gets wider scope', () => {
  each('%s: effective scope of a centre-restricted user is its own centres; tenant_wide_sections_hidden is []', async (op) => {
    const body = await ok11(op, (await makeCtx11(OWNER_MULTI)).ctx, WINDOW);
    expect(body.scope.all_centres).toBe(false);
    expect(body.scope.centre_ids.length).toBe(2);
    expect(body.scope.tenant_wide_sections_hidden).toEqual([]);
    for (const c of db.calls) expect(c.args.scope.all).toBe(false);
  });

  each('%s: interleaved all-centre and A1-only requests never share figures (many users at once)', async (op) => {
    const jobs = Array.from({ length: 16 }, async (_, i) => {
      const who = i % 2 ? OWNER_A1 : ADMIN;
      return { who, text: JSON.stringify((await ok11(op, (await makeCtx11(who)).ctx, WINDOW)).scope) };
    });
    for (const r of await Promise.all(jobs)) {
      expect(JSON.parse(r.text).all_centres, r.who).toBe(r.who === ADMIN);
    }
  });
});

describe('dependency failure', () => {
  each('%s: a failing repo propagates its LimsError (503), never an empty 200', async (op) => {
    db.fail = new LimsError('common.dependency_unavailable');
    await expectLims(call11(op, (await makeCtx11(ADMIN)).ctx, WINDOW), 'common.dependency_unavailable', 503);
  });
});
