// C8 AN-T11 — getDeliveryReport (GET /v1/analytics/reports/delivery). PRD US-13.1–3, M80, M85–M87 (CR-C8-005: deliveries centre-scoped, NULL centre =
// non-report delivery visible to all-centre users only; 08 A17 D-48); 02-TRD §5 #14 / §5.1 DeliveryReport / §6.8; 07-SECURITY P1, P4.
// failure_share_bp = ratioBp(failed, sent + failed + suppressed) per group (US-13.1); 0 when the denominator is 0.
// released (M85) counts every published version incl. addenda; amended (M86) counts report_kind 'amended' only; overrides (M87) release_basis 'override'.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ratioBp } from '../../domain/metrics.js';
import {
  A1, A2, ADMIN, NO_PERM, OWNER_A1, OWNER_ALL, OWNER_MULTI, D1, D2, SENTINEL, WINDOW, call11, contractErrors11, db, expectLims, makeCtx11, ok11, seedT11, t11,
} from './helpers.t11.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t11.js')).rollupsMockT11);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t11.js')).labelsRepoMockT11);
vi.mock('../../repository/sourceViews.repo.js', async () => (await import('./helpers.t11.js')).sourceViewsMockT11);

const OP = 'getDeliveryReport' as const;
const DK = ['queued', 'sent', 'delivered', 'read', 'failed', 'suppressed', 'failure_share_bp'];
const RK = ['released', 'final', 'partial', 'preliminary', 'amended', 'overrides'];
const d = (a: number[]) => Object.fromEntries(DK.map((k, i) => [k, a[i]]));   // [queued, sent, delivered, read, failed, suppressed, failure_share_bp]
const rl = (a: number[]) => Object.fromEntries(RK.map((k, i) => [k, a[i]]));  // [released, final, partial, preliminary, amended, overrides]
const pick = (o: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const byKey = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.key, r]));

beforeEach(() => { seedT11(); vi.clearAllMocks(); });

describe('US-13.1 — deliveries by channel × status, cohort = creation date', () => {
  it('group_by channel (default), all centres: per-channel counts; failure share = failed ÷ (sent + failed + suppressed)', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW);
    expect(body.report_code).toBe('delivery');
    const r = byKey(body.deliveries.rows);
    expect(Object.keys(r).sort()).toEqual(['email', 'sms', 'whatsapp']);
    expect(pick(r.whatsapp, DK)).toEqual(d([3, 9, 7, 3, 1, 0, 1000]));
    expect(pick(r.sms, DK)).toEqual(d([0, 3, 3, 0, 2, 1, 3333]));
    expect(pick(r.email, DK)).toEqual(d([0, 6, 6, 0, 3, 2, 2727]));
    expect(pick(body.deliveries.totals, DK)).toEqual(d([3, 18, 16, 3, 6, 3, 2222]));
    expect(Object.keys(body.deliveries.totals).sort()).toEqual([...DK].sort());
    expect(ratioBp(6, 27)).toBe(2222);
    expect(JSON.stringify(body)).not.toContain(String(SENTINEL));
  });

  it('group_by day: each creation day is its own cohort (D1 3/12 = 2500 bp, D2 3/15 = 2000 bp); keys are dates', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by: 'day' });
    expect(body.deliveries.rows.map((r: any) => r.key)).toEqual([D1, D2]);
    expect(pick(body.deliveries.rows[0], DK)).toEqual(d([1, 8, 7, 2, 3, 1, 2500]));
    expect(pick(body.deliveries.rows[1], DK)).toEqual(d([2, 10, 9, 1, 3, 2, 2000]));
  });

  it('group_by ad_month / bs_month: one row each, equal to the totals; keys YYYY-MM', async () => {
    const ad = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by: 'ad_month' });
    expect(ad.deliveries.rows.map((r: any) => r.key)).toEqual(['2026-11']);
    expect(pick(ad.deliveries.rows[0], DK)).toEqual(pick(ad.deliveries.totals, DK));
    const bs = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by: 'bs_month' });
    expect(bs.deliveries.rows).toHaveLength(1);
    expect(bs.deliveries.rows[0].key).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(pick(bs.deliveries.rows[0], DK)).toEqual(pick(bs.deliveries.totals, DK));
  });

  it('no delivery with sent + failed + suppressed = 0 → failure_share_bp 0 (no NaN), contract-valid', async () => {
    t11.deliveries.length = 0;
    t11.deliveries.push({ tenantId: t11.releases[0]!.tenantId, date: D1, channel: 'sms', purpose: 'report', recipientKind: 'patient', centreId: A1, queued: 4, sent: 0, delivered: 0, read: 0, failed: 0, suppressed: 0 });
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW);
    expect(pick(body.deliveries.totals, DK)).toEqual(d([4, 0, 0, 0, 0, 0, 0]));
    expect(contractErrors11(OP, body)).toEqual([]);
  });

  it('empty window → rows [] and zero totals for both sections', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { business_date_from: '2030-01-01', business_date_to: '2030-01-08' });
    expect(body.deliveries.rows).toEqual([]);
    expect(pick(body.deliveries.totals, DK)).toEqual(d([0, 0, 0, 0, 0, 0, 0]));
    expect(body.releases.rows).toEqual([]);
    expect(pick(body.releases.totals, RK)).toEqual(rl([0, 0, 0, 0, 0, 0]));
    expect(contractErrors11(OP, body)).toEqual([]);
  });
});

describe('US-13.2 — reports released by kind and basis', () => {
  it('totals: released counts all versions (21), final 13, partial 2, preliminary 1, amended 1 (addendum is NOT amended), overrides 3', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, WINDOW);
    expect(pick(body.releases.totals, RK)).toEqual(rl([21, 13, 2, 1, 1, 3]));
    expect(Object.keys(body.releases.totals).sort()).toEqual([...RK].sort());
    for (const k of RK) expect(body.releases.totals[k], k).toBe(body.releases.rows.reduce((s: number, r: any) => s + r[k], 0));
  });

  it('group_by day: releases are split by release day (override releases visible per day)', async () => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by: 'day' });
    expect(body.releases.rows.map((r: any) => r.key)).toEqual([D1, D2]);
    expect(pick(body.releases.rows[0], RK)).toEqual(rl([15, 13, 2, 0, 0, 3]));
    expect(pick(body.releases.rows[1], RK)).toEqual(rl([6, 0, 0, 1, 1, 0]));
  });
});

describe('US-13.3 / CR-C8-005 / 07 P4 — centre scoping; NULL-centre deliveries are all-centre only', () => {
  it('A1-only user: only A1 deliveries and releases; the NULL-centre e-mail OTP delivery and A2 sms are absent; tenant_wide_sections_hidden []', async () => {
    const body = await ok11(OP, (await makeCtx11(OWNER_A1)).ctx, WINDOW);
    expect(body.deliveries.rows.map((r: any) => r.key)).toEqual(['whatsapp']);
    expect(pick(body.deliveries.totals, DK)).toEqual(d([3, 9, 7, 3, 1, 0, 1000]));
    expect(pick(body.releases.totals, RK)).toEqual(rl([18, 10, 2, 1, 1, 0]));
    expect(body.scope).toEqual({ all_centres: false, centre_ids: [A1], tenant_wide_sections_hidden: [] });
    expect(JSON.stringify(body)).not.toContain('email');
    expect(contractErrors11(OP, body)).toEqual([]);
  });

  it('two-centre user: A1 + A2 (whatsapp, sms) but still no NULL-centre delivery', async () => {
    const body = await ok11(OP, (await makeCtx11(OWNER_MULTI)).ctx, WINDOW);
    expect(body.deliveries.rows.map((r: any) => r.key).sort()).toEqual(['sms', 'whatsapp']);
    expect(pick(body.deliveries.totals, DK)).toEqual(d([3, 12, 10, 3, 3, 1, 1875]));
  });

  it('NULL-centre deliveries: counted for all-centre users (ADMIN, OWNER_ALL), never for a centre-restricted user even with an explicit centre filter', async () => {
    for (const who of [ADMIN, OWNER_ALL]) {
      const body = await ok11(OP, (await makeCtx11(who)).ctx, WINDOW);
      expect(byKey(body.deliveries.rows).email, who).toBeDefined();
    }
    const filtered = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, centre_id: [A1, A2] });
    expect(byKey(filtered.deliveries.rows).email).toBeUndefined(); // an explicit centre list never matches NULL
    const only = t11.deliveries.filter((f) => f.centreId === null);
    t11.deliveries.length = 0; t11.deliveries.push(...only);
    const restricted = await ok11(OP, (await makeCtx11(OWNER_A1)).ctx, WINDOW);
    expect(restricted.deliveries.rows).toEqual([]);
    expect(pick(restricted.deliveries.totals, DK)).toEqual(d([0, 0, 0, 0, 0, 0, 0]));
  });

  it('centre_id outside the caller scope → 404 common.not_found, nothing read', async () => {
    await expectLims(call11(OP, (await makeCtx11(OWNER_A1)).ctx, { ...WINDOW, centre_id: [A2] }), 'common.not_found', 404);
    expect(db.calls).toEqual([]);
  });

  it('every repo call carries the ctx tenant and the effective scope', async () => {
    const { ctx } = await makeCtx11(OWNER_A1);
    await ok11(OP, ctx, WINDOW);
    expect(db.calls.map((c) => c.fn).sort()).toEqual(['deliveryRows', 'releaseRows']);
    for (const c of db.calls) { expect(c.args.tenantId).toBe(ctx.tenantId); expect(c.args.scope).toEqual({ all: false, centreIds: [A1] }); }
  });
});

describe('contract + errors', () => {
  it.each(['channel', 'day', 'ad_month', 'bs_month'])('group_by=%s validates against the 200 schema', async (group_by) => {
    const body = await ok11(OP, (await makeCtx11(ADMIN)).ctx, { ...WINDOW, group_by });
    expect(contractErrors11(OP, body)).toEqual([]);
    expect(body.deliveries.rows.length).toBeGreaterThan(0);
  });

  it.each(['reason', 'centre', '', 'channel; DROP TABLE x'])('group_by %j → 400 common.validation_failed before any query', async (group_by) => {
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
