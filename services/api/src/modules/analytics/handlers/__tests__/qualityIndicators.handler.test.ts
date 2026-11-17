// C8 AN-T11 — getQualityIndicatorsReport (GET /v1/analytics/reports/quality-indicators). PRD US-12.1–3, M70–M73, M75–M78 (critical values centre-scoped,
// CR-C8-004); 02-TRD §5 #13 / §5.1 QualityIndicatorsReport / §6.8; 07-SECURITY P1, P4. Repos are in-memory emulators (./helpers.t11.ts).
// per_100_received_bp = ratioBp(rejections, specimens_received) (250 for 1/40 in the contract example); 0 when nothing was received.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ratioBp } from '../../domain/metrics.js';
import {
  A1, A2, ADMIN, NO_PERM, OWNER_A1, OWNER_MULTI, D1, D2, CENTRE_NAME, SENTINEL, WINDOW, call11, contractErrors11, db, expectLims, makeCtx11, ok11, seedT11, t11,
} from './helpers.t11.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t11.js')).rollupsMockT11);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t11.js')).labelsRepoMockT11);
vi.mock('../../repository/sourceViews.repo.js', async () => (await import('./helpers.t11.js')).sourceViewsMockT11);

const OP = 'getQualityIndicatorsReport' as const;
const rej = (r: any) => ({ rejections: r.rejections, recollections_ordered: r.recollections_ordered, specimens_received: r.specimens_received, per_100_received_bp: r.per_100_received_bp });
const byKey = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.key, r]));
const cv = (r: any) => ({ detected: r.detected, notified: r.notified, notified_bp: r.notified_bp });

beforeEach(() => { seedT11(); vi.clearAllMocks(); });

describe('US-12.1 — rejections by reason / centre / specimen type; rate per 100 received', () => {
  it('totals: 7 rejections, 4 recollections, 100 specimens received → per_100_received_bp 700 (= ratioBp(7,100)); D0/D3 and tenant B excluded', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW);
    expect(body.report_code).toBe('quality_indicators');
    expect(body.rejections.totals).toEqual({ rejections: 7, recollections_ordered: 4, specimens_received: 100, per_100_received_bp: 700 });
    expect(ratioBp(7, 100)).toBe(700);
    expect(JSON.stringify(body)).not.toContain(String(SENTINEL));
  });

  it('group_by reason (default): one row per reason code with its code as key; every row carries the period denominator; unspecified reason stays visible', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW);
    const r = byKey(body.rejections.rows);
    expect(Object.keys(r).sort()).toEqual(['clotted', 'haemolysed', 'unspecified']);
    expect(rej(r.haemolysed)).toEqual({ rejections: 5, recollections_ordered: 3, specimens_received: 100, per_100_received_bp: 500 });
    expect(rej(r.clotted)).toEqual({ rejections: 1, recollections_ordered: 1, specimens_received: 100, per_100_received_bp: 100 });
    expect(rej(r.unspecified)).toEqual({ rejections: 1, recollections_ordered: 0, specimens_received: 100, per_100_received_bp: 100 });
    for (const row of body.rejections.rows) expect(row.label.length, row.key).toBeGreaterThan(0); // codes shown as-is when no label exists
  });

  it('group_by centre: numerator and denominator are both the centre\'s own (A1 6/80 = 750 bp, A2 1/20 = 500 bp); labels from core centres', async () => {
    const r = byKey((await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by: 'centre' })).rejections.rows);
    expect(rej(r[A1])).toEqual({ rejections: 6, recollections_ordered: 3, specimens_received: 80, per_100_received_bp: 750 });
    expect(rej(r[A2])).toEqual({ rejections: 1, recollections_ordered: 1, specimens_received: 20, per_100_received_bp: 500 });
    expect(r[A1].label).toContain(CENTRE_NAME(A1));
  });

  it('group_by specimen_type: serum 3/60 = 500 bp, edta 4/40 = 1000 bp', async () => {
    const r = byKey((await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by: 'specimen_type' })).rejections.rows);
    expect(rej(r.serum)).toEqual({ rejections: 3, recollections_ordered: 2, specimens_received: 60, per_100_received_bp: 500 });
    expect(rej(r.edta)).toEqual({ rejections: 4, recollections_ordered: 2, specimens_received: 40, per_100_received_bp: 1000 });
  });

  it('group_by day / ad_month: each period uses its own event dates for both sides', async () => {
    const day = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by: 'day' });
    expect(day.rejections.rows.map((r: any) => r.key)).toEqual([D1, D2]);
    expect(rej(day.rejections.rows[0])).toEqual({ rejections: 3, recollections_ordered: 2, specimens_received: 60, per_100_received_bp: 500 });
    expect(rej(day.rejections.rows[1])).toEqual({ rejections: 4, recollections_ordered: 2, specimens_received: 40, per_100_received_bp: 1000 });
    const mon = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by: 'ad_month' });
    expect(mon.rejections.rows.map((r: any) => r.key)).toEqual(['2026-11']);
    expect(rej(mon.rejections.rows[0])).toEqual(day.rejections.totals);
    const bs = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by: 'bs_month' });
    expect(bs.rejections.rows).toHaveLength(1);
    expect(bs.rejections.rows[0].key).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });

  it('no specimens received → the rate is 0 (not NaN / Infinity) and the body is contract-valid', async () => {
    t11.specimens.length = 0;
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW);
    expect(body.rejections.totals).toMatchObject({ rejections: 7, specimens_received: 0, per_100_received_bp: 0 });
    for (const r of body.rejections.rows) expect(r.per_100_received_bp).toBe(0);
    expect(contractErrors11(OP, body)).toEqual([]);
  });

  it('rate above 100 % is capped by the Bp range (0..1,000,000), never overflows the contract', async () => {
    t11.specimens.length = 0;
    t11.specimens.push({ tenantId: t11.rejections[0]!.tenantId, date: D1, centreId: A1, specimenType: 'serum', priority: 'routine', received: 1 });
    t11.rejections.push({ tenantId: t11.rejections[0]!.tenantId, date: D1, centreId: A1, specimenType: 'serum', reason: 'x', rejections: 5_000_000, recollections: 0 });
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW);
    expect(contractErrors11(OP, body)).toEqual([]);
  });
});

describe('US-12.2 — critical values per day (M75–M78)', () => {
  it('all-centre user: per-day detected/notified/% notified (bp) and max; totals Σ detected, Σ notified, max of max; NULL-centre row included', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW);
    const rows = body.critical_values.rows;
    expect(rows.map((r: any) => r.business_date)).toEqual([D1, D2]);
    expect(cv(rows[0])).toEqual({ detected: 5, notified: 4, notified_bp: 8000 });
    expect(rows[0].max_notify_seconds).toBe(900);
    expect(cv(rows[1])).toEqual({ detected: 6, notified: 5, notified_bp: 8333 });
    expect(rows[1].max_notify_seconds).toBe(200);
    expect(cv(body.critical_values.totals)).toEqual({ detected: 11, notified: 9, notified_bp: 8182 });
    expect(body.critical_values.totals.max_notify_seconds).toBe(900);
    expect(body.critical_values.totals.median_notify_seconds).toBeUndefined(); // medians are not additive (US-12.2)
  });

  it('a day with detections but none notified: notified_bp 0 and the median / max keys are omitted (never null)', async () => {
    const body = await ok11(OP, (await makeCtx11(OWNER_A1)).ctx, { business_date_from: D2, business_date_to: '2026-11-07' });
    const [row] = body.critical_values.rows;
    expect(cv(row)).toEqual({ detected: 1, notified: 0, notified_bp: 0 });
    expect('median_notify_seconds' in row).toBe(false);
    expect('max_notify_seconds' in row).toBe(false);
    expect('max_notify_seconds' in body.critical_values.totals).toBe(false);
    expect(contractErrors11(OP, body)).toEqual([]);
  });

  it('a day backed by one source row keeps that row\'s stored median', async () => {
    const body = await ok11(OP, (await makeCtx11(OWNER_A1)).ctx, { business_date_from: D1, business_date_to: D2 });
    expect(body.critical_values.rows[0]).toMatchObject({ detected: 3, notified: 2, notified_bp: 6667, median_notify_seconds: 600, max_notify_seconds: 900 });
  });

  it('no critical values in the window → rows [] and zero totals (notified_bp 0)', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { business_date_from: '2030-01-01', business_date_to: '2030-01-08' });
    expect(body.critical_values.rows).toEqual([]);
    expect(cv(body.critical_values.totals)).toEqual({ detected: 0, notified: 0, notified_bp: 0 });
    expect(contractErrors11(OP, body)).toEqual([]);
  });
});

describe('US-12.3 / CR-C8-004 / 07 P4 — centre scoping', () => {
  it('A1-only user: rejections and critical values are A1-only; NULL-centre critical row and A2 are absent; tenant_wide_sections_hidden is []', async () => {
    const body = await ok11(OP, (await makeCtx11(OWNER_A1)).ctx, WINDOW);
    expect(body.rejections.totals).toEqual({ rejections: 6, recollections_ordered: 3, specimens_received: 80, per_100_received_bp: 750 });
    expect(cv(body.critical_values.totals)).toEqual({ detected: 4, notified: 2, notified_bp: 5000 });
    expect(body.critical_values.totals.max_notify_seconds).toBe(900);
    expect(body.scope).toEqual({ all_centres: false, centre_ids: [A1], tenant_wide_sections_hidden: [] });
    expect(contractErrors11(OP, body)).toEqual([]);
  });

  it('two-centre user sees A1 + A2 only', async () => {
    const body = await ok11(OP, (await makeCtx11(OWNER_MULTI)).ctx, WINDOW);
    expect(body.rejections.totals).toMatchObject({ rejections: 7, specimens_received: 100 });
    expect(cv(body.critical_values.totals)).toEqual({ detected: 6, notified: 4, notified_bp: 6667 });
  });

  it('centre_id filter inside scope narrows; outside scope (A2 for an A1-only user) → 404 common.not_found and nothing read', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, centre_id: [A2] });
    expect(body.rejections.totals).toMatchObject({ rejections: 1, specimens_received: 20 });
    expect(body.scope.centre_ids).toEqual([A2]);
    db.calls.length = 0;
    await expectLims(call11(OP, (await makeCtx11(OWNER_A1)).ctx, { ...WINDOW, centre_id: [A2] }), 'common.not_found', 404);
    expect(db.calls).toEqual([]);
  });

  it('every repo call carries the ctx tenant and the effective scope', async () => {
    const { ctx } = await makeCtx11(OWNER_A1);
    await ok11(OP, ctx, WINDOW);
    expect(db.calls.length).toBeGreaterThan(0);
    for (const c of db.calls) { expect(c.args.tenantId).toBe(ctx.tenantId); expect(c.args.scope).toEqual({ all: false, centreIds: [A1] }); }
  });
});

describe('contract + errors', () => {
  it.each(['reason', 'centre', 'specimen_type', 'day', 'ad_month', 'bs_month'])('group_by=%s validates against the 200 schema', async (group_by) => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by });
    expect(contractErrors11(OP, body)).toEqual([]);
    expect(body.rejections.rows.length).toBeGreaterThan(0);
  });

  it.each(['department', 'channel', '', 'reason; DROP TABLE x'])('group_by %j → 400 common.validation_failed before any query', async (group_by) => {
    await expectLims(call11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by }), 'common.validation_failed', 400);
    expect(db.calls).toEqual([]);
  });

  it('no analytics.dashboard.read → 403 before any read', async () => {
    const { ctx, touched } = await makeCtx11(NO_PERM);
    await expectLims(call11(OP, ctx, WINDOW), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(db.calls).toEqual([]);
  });
});
