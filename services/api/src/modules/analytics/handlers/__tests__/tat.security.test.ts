// C8 AN-T12 — cross-cutting security checks for getTatReport (07-SECURITY P1 tenant isolation / no person data, P3 authz, P4 centre scope, P5 period limits,
// injection through filters, REQ-SEC-013/017/081, abuse case 1). The tat.repo is an in-memory emulator (./helpers.t12.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import {
  A1, ADMIN, BR1, NO_PERM, OWNER_A1, OWNER_MULTI, PARTNER, SENTINEL, WINDOW12 as WINDOW, call12, contractErrors12, db, expectLims, makeCtx12, ok12, seedT12, t12, tatMockT12,
} from './helpers.t12.js';

vi.mock('../../repository/tat.repo.js', async () => (await import('./helpers.t12.js')).tatMockT12);
vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t12.js')).rollupsMockT11);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t12.js')).labelsRepoMockT11);
vi.mock('../../repository/sourceViews.repo.js', async () => (await import('./helpers.t12.js')).sourceViewsMockT11);

beforeEach(() => { seedT12(); vi.clearAllMocks(); });

describe('getTatReport is implemented (not the AN-T01 stub)', () => {
  it('answers 200 with report_code tat, the period and the scope echo', async () => {
    const body = await ok12((await makeCtx12(ADMIN)).ctx, WINDOW);
    expect(body).toMatchObject({ report_code: 'tat', scope: { all_centres: true }, period: { business_date_from: WINDOW.business_date_from } });
  });
});

describe('P3 — authorisation first (analytics.dashboard.read)', () => {
  it.each([NO_PERM, PARTNER])('%s: 403 auth.forbidden, no core port / tx / repo touched', async (who) => {
    const { ctx, touched } = await makeCtx12(who);
    await expectLims(call12(ctx, WINDOW), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it('a caller without the permission gets 403 even for an invalid or hostile query (validation never answers before authorisation)', async () => {
    for (const q of [{ group_by: 'nope' }, { priority: 'x' }, { segment: ['bogus'] }, { processing_branch_id: ['00000000-0000-4000-8000-000000000000'] }, { centre_id: [A1] }]) {
      const { ctx, touched } = await makeCtx12(NO_PERM);
      await expectLims(call12(ctx, { ...WINDOW, ...q }), 'auth.forbidden', 403);
      expect(touched).toEqual([]);
    }
    expect(db.calls).toEqual([]);
  });
});

describe('P5 — period validation happens before any read', () => {
  it('bs_month + dates → 400; 400-day range → 422 analytics.range_too_large; bs_month 2100-01 → 422 common.date_out_of_range', async () => {
    await expectLims(call12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, bs_month: '2082-07' }), 'common.validation_failed', 400);
    await expectLims(call12((await makeCtx12(ADMIN)).ctx, { business_date_from: '2025-01-01', business_date_to: '2026-02-05' }), 'analytics.range_too_large', 422);
    await expectLims(call12((await makeCtx12(ADMIN)).ctx, { bs_month: '2100-01' }), 'common.date_out_of_range', 422);
    expect(db.calls).toEqual([]);
  });

  it('a single from without a to (both bounds or none) → 400, nothing read', async () => {
    await expectLims(call12((await makeCtx12(ADMIN)).ctx, { business_date_from: WINDOW.business_date_from }), 'common.validation_failed', 400);
    expect(db.calls).toEqual([]);
  });

  it('segment list longer than the five segments (duplicates used to inflate the query) → 400', async () => {
    await expectLims(call12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: Array.from({ length: 6 }, () => 'within_lab') }), 'common.validation_failed', 400);
    expect(db.calls).toEqual([]);
  });
});

describe('P1 / REQ-SEC-013 — tenant isolation', () => {
  it('every repo call carries ctx.tenantId; tenant B sentinel durations (987654321) never reach the body, for every group_by', async () => {
    for (const group_by of ['none', 'centre', 'processing_branch', 'priority', 'specimen_type', 'day', 'ad_month', 'bs_month']) {
      const { ctx } = await makeCtx12(ADMIN);
      const body = await ok12(ctx, { ...WINDOW, group_by });
      for (const c of db.calls) expect(c.args.tenantId, group_by).toBe(ctx.tenantId);
      expect(JSON.stringify(body), group_by).not.toContain(String(SENTINEL));
    }
    expect(db.calls.length).toBeGreaterThan(0);
  });

  it('a client-supplied tenant_id / scope / unknown query parameter is ignored and never forwarded to the repo', async () => {
    const { ctx } = await makeCtx12(OWNER_A1);
    await ok12(ctx, { ...WINDOW, tenant_id: '00000000-0000-4000-8000-00000000beef', scope: 'all', all_centres: true, is_anomaly: true });
    for (const c of db.calls) {
      expect(c.args.tenantId).toBe(ctx.tenantId);
      expect(c.args.scope).toEqual({ all: false, centreIds: [A1] });
      expect(JSON.stringify(c.args)).not.toMatch(/beef|is_anomaly/);
    }
  });
});

describe('P1 — the TAT report carries aggregates only (no person-linked identifier)', () => {
  it('no specimen id, order id, patient field or timestamp of an individual sample appears in any response', async () => {
    const ids = [...t12.specimens.map((s) => s.id), ...t12.orders.map((o) => o.id)];
    for (const group_by of ['none', 'day', 'centre', 'processing_branch', 'priority', 'specimen_type']) {
      const text = JSON.stringify(await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, group_by }));
      for (const id of ids) expect(text, group_by).not.toContain(id);
      expect(text, group_by).not.toMatch(/subject|specimen_id|order_id|patient|barcode|registration|started_at|stopped_at|collected_at|received_at/i);
    }
  });

  it('the body is exactly the contract allow-list (additionalProperties:false at every level)', async () => {
    const body = await ok12((await makeCtx12(ADMIN)).ctx, WINDOW);
    expect(contractErrors12(body)).toEqual([]);
    expect(contractErrors12({ ...body, rows: [{ ...body.rows[0], subject_id: 'x' }] })).not.toEqual([]); // the schema would catch a leaked column
  });
});

describe('injection — filters are data, never SQL', () => {
  it('group_by outside the closed list → 400 before any repo call', async () => {
    for (const group_by of ['subject_id', 'centre_id, tenant_id', "day'; DROP TABLE analytics.tat_facts; --", '1', '__proto__']) {
      await expectLims(call12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, group_by }), 'common.validation_failed', 400);
    }
    expect(db.calls).toEqual([]);
  });

  it('a hostile specimen_type_code is either refused (400) or travels to the repo only as an element of the bound list, and matches nothing', async () => {
    const evil = "serum') OR 1=1; DROP TABLE analytics.tat_facts; --";
    const { ctx } = await makeCtx12(ADMIN);
    let body: any;
    try { body = await ok12(ctx, { ...WINDOW, specimen_type_code: [evil] }); } catch (e) {
      expect(e).toBeInstanceOf(LimsError);
      expect((e as LimsError).code).toBe('common.validation_failed');
      expect(db.calls).toEqual([]);
      return;
    }
    expect(db.calls[0]!.args.specimenTypeCodes).toEqual([evil]);
    expect(body.rows.every((r: any) => r.n === 0 && r.anomalies === 0)).toBe(true);
    expect(tatMockT12.tatRows).toHaveBeenCalledTimes(1);
  });
});

describe('P4 / REQ-SEC-017 — a centre-restricted user never gets wider scope', () => {
  it('effective scope of a two-centre user is exactly its own centres; tenant_wide_sections_hidden is []', async () => {
    const body = await ok12((await makeCtx12(OWNER_MULTI)).ctx, WINDOW);
    expect(body.scope.all_centres).toBe(false);
    expect(body.scope.centre_ids).toHaveLength(2);
    expect(body.scope.tenant_wide_sections_hidden).toEqual([]);
    for (const c of db.calls) expect(c.args.scope.all).toBe(false);
  });

  it('filters can only narrow: A1-only user with branch_id / processing_branch_id / specimen filters never sees another centre or the NULL-centre samples', async () => {
    const { ctx } = await makeCtx12(OWNER_A1);
    const body = await ok12(ctx, { ...WINDOW, group_by: 'centre', segment: ['pre_analytical'], processing_branch_id: [BR1] });
    expect(body.rows.map((r: any) => r.key)).toEqual([A1]);
    for (const c of db.calls) expect(c.args.scope).toEqual({ all: false, centreIds: [A1] });
  });

  it('interleaved all-centre and A1-only requests never share figures (many users at once)', async () => {
    const jobs = Array.from({ length: 16 }, async (_, i) => {
      const who = i % 2 ? OWNER_A1 : ADMIN;
      return { who, body: await ok12((await makeCtx12(who)).ctx, WINDOW) };
    });
    for (const r of await Promise.all(jobs)) {
      expect(r.body.scope.all_centres, r.who).toBe(r.who === ADMIN);
      expect(r.body.rows.find((x: any) => x.segment === 'pre_analytical').n, r.who).toBe(r.who === ADMIN ? 7 : 5);
    }
  });
});

describe('dependency failure', () => {
  it('a failing repo propagates its LimsError (503), never an empty 200', async () => {
    db.fail = new LimsError('common.dependency_unavailable');
    await expectLims(call12((await makeCtx12(ADMIN)).ctx, WINDOW), 'common.dependency_unavailable', 503);
  });
});
