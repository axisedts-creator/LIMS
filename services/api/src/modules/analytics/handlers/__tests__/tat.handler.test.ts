// C8 AN-T12 — getTatReport (GET /v1/analytics/reports/tat). PRD US-11.1–6, M60–M64; 02-TRD §5 #10 / §5.1 TatReport / §6.6 / §9.2; 07-SECURITY P1, P4.
// The tat.repo is an in-memory emulator of analytics.tat_facts (./helpers.t12.ts) fed by CRAFTED TIMELINES; handler + service + mapper + labels.service are real.
// Every expected number below is hand-computed (percentile_cont = linear interpolation at position p*(n-1); the mapper rounds half-up to whole seconds).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, B1, BR1, BR2, BRB, BRANCH_NAME, CENTRE_NAME, ADMIN, D1, D2, D3, OR, OWNER_A1, OWNER_ALL, OWNER_MULTI, SEGMENTS, SP, WINDOW12 as WINDOW, contractErrors12,
  call12, db, expectLims, makeCtx12, npt, ok12, seedT12, t12, type Segment,
} from './helpers.t12.js';

vi.mock('../../repository/tat.repo.js', async () => (await import('./helpers.t12.js')).tatMockT12);
vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t12.js')).rollupsMockT11);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t12.js')).labelsRepoMockT11);
vi.mock('../../repository/sourceViews.repo.js', async () => (await import('./helpers.t12.js')).sourceViewsMockT11);

beforeEach(() => { seedT12(); vi.clearAllMocks(); });

// ---- expected rows -------------------------------------------------------------------------------------------------------------------
type St = { n: number; median_seconds?: number; p90_seconds?: number; max_seconds?: number; anomalies: number };
const st = (n: number, median: number, p90: number, max: number, anomalies: number): St => ({ n, median_seconds: median, p90_seconds: p90, max_seconds: max, anomalies });
const none = (anomalies = 0): St => ({ n: 0, anomalies });
const [PRE, TRN, LAB, TF, TT] = SEGMENTS;
const pick = (r: any): St => {
  const o: any = { n: r.n, anomalies: r.anomalies };
  for (const k of ['median_seconds', 'p90_seconds', 'max_seconds']) if (r[k] !== undefined) o[k] = r[k];
  return o;
};
/** group_by none -> { segment: stats } (one row per requested segment). */
const bySeg = (body: any): Record<string, St> => Object.fromEntries(body.rows.map((r: any) => [r.segment, pick(r)]));
/** grouped rows of one segment -> { key: stats }. */
const byKey = (body: any, segment: Segment): Record<string, St> => Object.fromEntries(body.rows.filter((r: any) => r.segment === segment).map((r: any) => [r.key, pick(r)]));
const rowsOf = (body: any, segment: Segment) => body.rows.filter((r: any) => r.segment === segment);
const want = (m: Record<Segment, St>) => m;

// Window [D1, D3), tenant A, hand-computed from seedT12(). Durations (s) per segment:
//   pre_analytical  all [300 600 1200 1800 2400 3600 4000] (+1 anomaly)   transport all [1000 2000 4000] (+1)   within_lab all [1200 1801 3000 7200] (+1)
//   total_first     all [600 1800 3600 5000 7200] (+1)                   total_final all [7200 9000 86400] (o7 is not all-final, o3 has no final)
const ALL = want({ [PRE]: st(7, 1800, 3760, 4000, 1), [TRN]: st(3, 2000, 3600, 4000, 1), [LAB]: st(4, 2401, 5940, 7200, 1), [TF]: st(5, 3600, 6320, 7200, 1), [TT]: st(3, 9000, 70920, 86400, 0) } as Record<Segment, St>);
const A1_ONLY = want({ [PRE]: st(5, 1200, 2160, 2400, 1), [TRN]: st(2, 2500, 3700, 4000, 1), [LAB]: st(3, 1801, 6120, 7200, 1), [TF]: st(3, 1800, 3240, 3600, 1), [TT]: st(2, 46800, 78480, 86400, 0) } as Record<Segment, St>);
const MULTI = want({ [PRE]: st(6, 1500, 3000, 3600, 1), [TRN]: st(3, 2000, 3600, 4000, 1), [LAB]: st(4, 2401, 5940, 7200, 1), [TF]: st(4, 2700, 6120, 7200, 1), [TT]: st(2, 46800, 78480, 86400, 0) } as Record<Segment, St>);

describe('US-11.1 — n, median, p90, max per segment M60–M64, each labelled with its start and stop points', () => {
  it('group_by none (default): exactly one row per segment in canonical order, with exact percentiles over the crafted timelines', async () => {
    const body = await ok12((await makeCtx12(ADMIN)).ctx, WINDOW);
    expect(body.report_code).toBe('tat');
    expect(body.rows.map((r: any) => r.segment)).toEqual([...SEGMENTS]);
    expect(bySeg(body)).toEqual(ALL);
    expect(contractErrors12(body)).toEqual([]);
  });

  it('segment_definitions: one entry per segment with start / stop label keys analytics.tat.<segment>.start / .stop (TRD §6.6)', async () => {
    const body = await ok12((await makeCtx12(ADMIN)).ctx, WINDOW);
    expect(body.segment_definitions).toEqual(SEGMENTS.map((segment) => ({ segment, start_label_key: `analytics.tat.${segment}.start`, stop_label_key: `analytics.tat.${segment}.stop` })));
  });

  it('segment filter: only the requested segments come back (rows and definitions), always in canonical order', async () => {
    const one = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: [LAB] });
    expect(one.rows.map((r: any) => r.segment)).toEqual([LAB]);
    expect(pick(one.rows[0])).toEqual(ALL[LAB]);
    expect(one.segment_definitions.map((d: any) => d.segment)).toEqual([LAB]);
    const two = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: [TT, PRE] });
    expect(two.rows.map((r: any) => r.segment)).toEqual([PRE, TT]);
    expect(db.calls.at(-1)!.args.segments).toEqual(expect.arrayContaining([PRE, TT]));
    expect(db.calls.at(-1)!.args.segments).toHaveLength(2);
  });

  it('all five segments are requested from the repo by default, tenant and [from, to) exactly as asked', async () => {
    const { ctx } = await makeCtx12(ADMIN);
    await ok12(ctx, WINDOW);
    const a = db.calls[0]!.args;
    expect([...a.segments].sort()).toEqual([...SEGMENTS].sort());
    expect([a.from, a.to, a.tenantId, a.groupBy]).toEqual([D1, D3, ctx.tenantId, 'none']);
  });

  it('percentiles are rounded half-up to whole seconds: 0.5→1, 1.5→2, 2.5→3 (never banker\'s, floor or toFixed); all stats are safe integers', async () => {
    t12.specimens.length = 0;
    t12.specimens.push(SP(A1, BR1, 'serum', 'routine', D1, '10:00:00', { pre: 2 }), SP(A1, BR1, 'serum', 'routine', D1, '10:10:00', { pre: 3 }),
      SP(A1, BR1, 'serum', 'routine', D1, '10:20:00', { lab: 0 }), SP(A1, BR1, 'serum', 'routine', D1, '10:30:00', { lab: 1 }));
    const r = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, WINDOW));
    expect(r[PRE]).toEqual(st(2, 3, 3, 3, 0));   // median 2.5 -> 3, p90 2.9 -> 3
    expect(r[LAB]).toEqual(st(2, 1, 1, 1, 0));   // median 0.5 -> 1 (a duration of 0 s is a valid sample, not an anomaly), p90 0.9 -> 1
    for (const s of Object.values(r)) for (const k of ['median_seconds', 'p90_seconds', 'max_seconds'] as const) if (s[k] !== undefined) expect(Number.isSafeInteger(s[k]), k).toBe(true);
  });

  it('a single sample: median = p90 = max = that sample; an empty segment has n 0 and NO median / p90 / max keys', async () => {
    t12.specimens.length = 0; t12.orders.length = 0;
    t12.specimens.push(SP(A1, BR1, 'serum', 'routine', D1, '10:00:00', { pre: 777 }));
    const body = await ok12((await makeCtx12(ADMIN)).ctx, WINDOW);
    const r = bySeg(body);
    expect(r[PRE]).toEqual(st(1, 777, 777, 777, 0));
    for (const s of [TRN, LAB, TF, TT] as Segment[]) { expect(r[s]).toEqual(none()); }
    for (const row of body.rows.filter((x: any) => x.segment !== PRE)) for (const k of ['median_seconds', 'p90_seconds', 'max_seconds']) expect(row, k).not.toHaveProperty(k);
    expect(contractErrors12(body)).toEqual([]);
  });

  it('a window with no data: group_by none -> five zero rows; any other group_by -> rows []; both contract-valid', async () => {
    const win = { business_date_from: '2030-01-01', business_date_to: '2030-01-08' };
    const flat = await ok12((await makeCtx12(ADMIN)).ctx, win);
    expect(bySeg(flat)).toEqual(Object.fromEntries(SEGMENTS.map((s) => [s, none()])));
    expect(contractErrors12(flat)).toEqual([]);
    const grouped = await ok12((await makeCtx12(ADMIN)).ctx, { ...win, group_by: 'day' });
    expect(grouped.rows).toEqual([]);
    expect(contractErrors12(grouped)).toEqual([]);
  });
});

describe('US-11.2 — a missing endpoint is excluded from that segment; a negative duration is excluded and counted in anomalies', () => {
  it('negative durations (received before collected, scanned out after scan-in, verified before received, released before registration) are NOT in n / median / p90 / max, only in anomalies', async () => {
    const r = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, WINDOW));
    expect([r[PRE]!.anomalies, r[TRN]!.anomalies, r[LAB]!.anomalies, r[TF]!.anomalies, r[TT]!.anomalies]).toEqual([1, 1, 1, 1, 0]);
    expect(r[PRE]).toMatchObject({ n: 7, max_seconds: 4000 });   // 7 valid samples, the -120 s one is absent
    expect(r[TRN]).toMatchObject({ n: 3, max_seconds: 4000 });
    expect(r[LAB]).toMatchObject({ n: 4, max_seconds: 7200 });
    expect(r[TF]).toMatchObject({ n: 5, median_seconds: 3600 });
  });

  it('a group holding only anomalies still shows: n 0, anomalies k, and no stats keys', async () => {
    t12.specimens.length = 0; t12.orders.length = 0;
    t12.specimens.push(SP(A1, BR1, 'serum', 'routine', D1, '10:00:00', { pre: -120 }), SP(A1, BR1, 'serum', 'routine', D1, '10:05:00', { pre: -1 }));
    const body = await ok12((await makeCtx12(ADMIN)).ctx, WINDOW);
    const row = body.rows.find((r: any) => r.segment === PRE);
    expect(row).toMatchObject({ n: 0, anomalies: 2 });
    for (const k of ['median_seconds', 'p90_seconds', 'max_seconds']) expect(row).not.toHaveProperty(k);
    expect(contractErrors12(body)).toEqual([]);
  });

  it('a missing endpoint makes no sample at all: neither n nor anomalies move (collected only, never received, not yet verified, no scan-out)', async () => {
    t12.specimens.length = 0; t12.orders.length = 0;
    t12.specimens.push(
      SP(A1, BR1, 'serum', 'routine', D1, '10:00:00', { pre: 100 }),                       // no transport endpoint, no verification
      SP(A1, BR1, 'serum', 'routine', D1, '10:10:00', { pre: 5000, transport: 5000, lab: 5000 }, { notReceived: true }), // never received: no stop event for any segment
    );
    t12.orders.push(OR(A1, D1, '08:00:00'));                                              // registered, nothing released
    const r = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, WINDOW));
    expect(r[PRE]).toEqual(st(1, 100, 100, 100, 0));
    for (const s of [TRN, LAB, TF, TT] as Segment[]) expect(r[s], s).toEqual(none());
  });
});

describe('US-11.3 — rejected specimens and aliquots are out of every specimen segment; M64 counts an order only when every report family is final', () => {
  it('rejected (rejected_at present) and aliquot (parent_specimen_id present) specimens contribute NOTHING: no sample, no anomaly — even with absurd or negative durations', async () => {
    t12.specimens.length = 0; t12.orders.length = 0;
    t12.specimens.push(
      SP(A1, BR1, 'serum', 'routine', D1, '10:00:00', { pre: -500, transport: -500, lab: -500 }, { rejected: true }),
      SP(A1, BR1, 'serum', 'routine', D1, '10:10:00', { pre: 99_999, transport: -99, lab: 99_999 }, { parent: true }),
      SP(A1, BR1, 'serum', 'routine', D1, '10:20:00', { pre: 1, transport: 1, lab: 1 }, { rejected: true, parent: true }),
    );
    expect(bySeg(await ok12((await makeCtx12(ADMIN)).ctx, WINDOW))).toEqual(Object.fromEntries(SEGMENTS.map((s) => [s, none()])));
  });

  it('standard world: the rejected (s9) and aliquot (s10) specimens leave pre_analytical n at 7, transport at 3, within_lab at 4', async () => {
    const r = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, WINDOW));
    expect([r[PRE]!.n, r[TRN]!.n, r[LAB]!.n]).toEqual([7, 3, 4]);
  });

  it('final-report segment: an order with a final timestamp but not every family final counts for the first-release segment only', async () => {
    t12.specimens.length = 0; t12.orders.length = 0;
    t12.orders.push(OR(A1, D1, '11:00:00', { first: 600, final: 3000 }, { allFinal: false }));
    const r = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, WINDOW));
    expect(r[TF]).toEqual(st(1, 600, 600, 600, 0));
    expect(r[TT]).toEqual(none());
  });

  it('final-report segment: the sample sits on the day the LAST family became final (registered D1, final D2 -> D2)', async () => {
    const body = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: [TT], group_by: 'day' });
    expect(byKey(body, TT)).toEqual({ [D1]: st(1, 7200, 7200, 7200, 0), [D2]: st(2, 47700, 78660, 86400, 0) });
    const d1only = await ok12((await makeCtx12(ADMIN)).ctx, { business_date_from: D1, business_date_to: D2, segment: [TT] });
    expect(bySeg(d1only)[TT]).toEqual(st(1, 7200, 7200, 7200, 0));   // o2 (registered D1) is not in the D1-only report: it completes on D2
  });
});

describe('US-11.4 — a sample is anchored on the business date of its stop event', () => {
  const lateWorld = () => {
    t12.specimens.length = 0; t12.orders.length = 0;
    t12.specimens.push(SP(A1, BR1, 'serum', 'routine', D1, '23:50:00', { pre: 600, lab: 1200 })); // received D1 23:50 NPT, first verified D2 00:10 NPT
  };
  it('received on D1 but verified after midnight (Asia/Kathmandu): pre_analytical lands on D1, within_lab lands on D2', async () => {
    lateWorld();
    const d1 = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, { business_date_from: D1, business_date_to: D2 }));
    expect([d1[PRE]!.n, d1[LAB]!.n]).toEqual([1, 0]);
    const d2 = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, { business_date_from: D2, business_date_to: D3 }));
    expect([d2[PRE]!.n, d2[LAB]!.n]).toEqual([0, 1]);
    const both = byKey(await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: [LAB], group_by: 'day' }), LAB);
    expect(both).toEqual({ [D2]: st(1, 1200, 1200, 1200, 0) });
  });

  it('the Nepal-time midnight edge: 23:59:59 NPT belongs to its own day, 00:00:00 NPT to the next (they share one UTC date)', async () => {
    t12.specimens.length = 0; t12.orders.length = 0;
    t12.specimens.push(SP(A1, BR1, 'serum', 'routine', D2, '23:59:59', { pre: 10 }), SP(A1, BR1, 'serum', 'routine', D3, '00:00:00', { pre: 20 }));
    expect(npt(D2, '23:59:59').slice(0, 10)).toBe(npt(D3, '00:00:00').slice(0, 10)); // same UTC date: a UTC-date implementation would merge them
    const body = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: [PRE], group_by: 'day' });
    expect(byKey(body, PRE)).toEqual({ [D2]: st(1, 10, 10, 10, 0) });
  });

  it('the window is [business_date_from, business_date_to): D1 in, D3 out; rows before and after the window and tenant B never count', async () => {
    const a = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, WINDOW));
    expect(a[PRE]!.max_seconds).toBe(4000);           // 77 777 (D0) and 66 666 (D3) are out
    expect(JSON.stringify(a)).not.toMatch(/77777|66666|987654321/);
  });
});

describe('US-11.5 — filters: centre, processing branch, priority, specimen type; exact percentiles over the filtered samples', () => {
  it('priority urgent: only urgent specimens; order-level segments (NULL priority) drop out entirely', async () => {
    const r = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, priority: 'urgent' }));
    expect(r).toEqual({ [PRE]: st(1, 300, 300, 300, 0), [TRN]: st(1, 4000, 4000, 4000, 0), [LAB]: st(1, 7200, 7200, 7200, 0), [TF]: none(), [TT]: none() });
    expect(db.calls.at(-1)!.args.priority).toBe('urgent');
  });

  it('priority routine: all routine specimens (anomalies included in their counts); order-level segments drop out too', async () => {
    const r = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, priority: 'routine' }));
    expect(r).toEqual({ [PRE]: st(6, 2100, 3800, 4000, 1), [TRN]: st(2, 1500, 1900, 2000, 1), [LAB]: st(3, 1801, 2760, 3000, 1), [TF]: none(), [TT]: none() });
  });

  it('specimen_type_code: only those types (serum is absent for [edta]); order-level segments drop out', async () => {
    const r = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, specimen_type_code: ['edta'] }));
    expect(r).toEqual({ [PRE]: st(2, 1050, 1650, 1800, 0), [TRN]: st(1, 4000, 4000, 4000, 0), [LAB]: st(1, 7200, 7200, 7200, 0), [TF]: none(), [TT]: none() });
    const both = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, specimen_type_code: ['edta', 'serum'] }));
    expect(both[PRE]).toEqual(ALL[PRE]);
  });

  it('processing_branch_id: only specimens processed at that branch (BR2 = s3 + s4); order-level segments (NULL branch) drop out', async () => {
    const r = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, processing_branch_id: [BR2] }));
    expect(r).toEqual({ [PRE]: st(2, 1950, 3270, 3600, 0), [TRN]: st(2, 3000, 3800, 4000, 0), [LAB]: st(2, 5100, 6780, 7200, 0), [TF]: none(), [TT]: none() });
  });

  it('filters combine with AND (priority routine + specimen type edta = s5 only)', async () => {
    const r = bySeg(await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, priority: 'routine', specimen_type_code: ['edta'] }));
    expect(r).toEqual({ [PRE]: st(1, 1800, 1800, 1800, 0), [TRN]: none(), [LAB]: none(), [TF]: none(), [TT]: none() });
  });

  it('centre_id filter narrows to those centres (ADMIN + [A1] = the A1-only figures); branch_id [BR1] = its centres A1 + A2', async () => {
    expect(bySeg(await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, centre_id: [A1] }))).toEqual(A1_ONLY);
    expect(db.calls.at(-1)!.args.scope).toEqual({ all: false, centreIds: [A1] });
    expect(bySeg(await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, branch_id: [BR1] }))).toEqual(MULTI);
  });

  it('filter values reach the repo as bound lists (duplicates may be collapsed), nothing else', async () => {
    const { ctx } = await makeCtx12(ADMIN);
    await ok12(ctx, { ...WINDOW, priority: 'routine', specimen_type_code: ['serum', 'serum', 'edta'], processing_branch_id: [BR1, BR1] });
    const a = db.calls[0]!.args;
    expect([...new Set(a.specimenTypeCodes)].sort()).toEqual(['edta', 'serum']);
    expect([...new Set(a.processingBranchIds)]).toEqual([BR1]);
    expect(a.priority).toBe('routine');
  });
});

describe('US-11.5 — group_by', () => {
  it('centre: one row per centre (label = centre name) plus the NULL-centre group for an all-centre user', async () => {
    const body = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: [PRE], group_by: 'centre' });
    const rows = byKey(body, PRE);
    expect(rows[A1]).toEqual(st(5, 1200, 2160, 2400, 1));
    expect(rows[A2]).toEqual(st(1, 3600, 3600, 3600, 0));
    const others = Object.entries(rows).filter(([k]) => k !== A1 && k !== A2);
    expect(others).toHaveLength(1);                                   // the s16 NULL-centre sample
    expect(others[0]![1]).toEqual(st(1, 4000, 4000, 4000, 0));
    expect(body.rows.find((r: any) => r.key === A1).label).toContain(CENTRE_NAME(A1));
    expect(contractErrors12(body)).toEqual([]);
  });

  it('processing_branch: BR1 / BR2 with core branch names', async () => {
    const body = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: [PRE], group_by: 'processing_branch' });
    expect(byKey(body, PRE)).toEqual({ [BR1]: st(5, 1800, 3360, 4000, 1), [BR2]: st(2, 1950, 3270, 3600, 0) });
    expect(body.rows.find((r: any) => r.key === BR1).label).toContain(BRANCH_NAME(BR1));
    expect(contractErrors12(body)).toEqual([]);
  });

  it('priority: routine / urgent', async () => {
    const body = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: [PRE], group_by: 'priority' });
    expect(byKey(body, PRE)).toEqual({ routine: st(6, 2100, 3800, 4000, 1), urgent: st(1, 300, 300, 300, 0) });
    expect(contractErrors12(body)).toEqual([]);
  });

  it('specimen_type: codes as keys and labels', async () => {
    const body = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: [PRE], group_by: 'specimen_type' });
    expect(byKey(body, PRE)).toEqual({ serum: st(5, 2400, 3840, 4000, 1), edta: st(2, 1050, 1650, 1800, 0) });
    for (const r of body.rows) expect(r.label).toContain(r.key);
    expect(contractErrors12(body)).toEqual([]);
  });

  it('day: key = business date of the stop event, ascending; percentiles are per day, never merged from other days', async () => {
    const body = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: [PRE], group_by: 'day' });
    expect(body.rows.map((r: any) => r.key)).toEqual([D1, D2]);
    expect(byKey(body, PRE)).toEqual({ [D1]: st(3, 1200, 3120, 3600, 1), [D2]: st(4, 2100, 3520, 4000, 0) });
    expect(contractErrors12(body)).toEqual([]);
  });

  it('ad_month: key YYYY-MM; bs_month: key YYYY-MM of the B.S. month — one month here, equal to the ungrouped figures (a median is never an average of day medians)', async () => {
    const ad = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: [PRE], group_by: 'ad_month' });
    expect(ad.rows).toHaveLength(1);
    expect(ad.rows[0].key).toBe('2026-11');
    expect(pick(ad.rows[0])).toEqual(ALL[PRE]);
    const bs = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, segment: [PRE], group_by: 'bs_month' });
    expect(bs.rows).toHaveLength(1);
    expect(bs.rows[0].key).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(pick(bs.rows[0])).toEqual(ALL[PRE]);
    expect(contractErrors12(bs)).toEqual([]);
  });

  it('every group_by value validates against the 200 schema with all five segments requested', async () => {
    for (const group_by of ['none', 'centre', 'processing_branch', 'priority', 'specimen_type', 'day', 'ad_month', 'bs_month']) {
      const body = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, group_by });
      expect(contractErrors12(body), group_by).toEqual([]);
      expect(body.rows.length, group_by).toBeGreaterThan(0);
    }
  });
});

describe('US-11.6 / response shape — no "% within target"; only allow-listed aggregate fields', () => {
  it('no target / percent / within-target field anywhere in the body', async () => {
    const body = await ok12((await makeCtx12(ADMIN)).ctx, WINDOW);
    expect(JSON.stringify(body)).not.toMatch(/target|within_target|percent|_pct|_bp/i);
  });

  it('rows carry only segment, key, label, n, median_seconds, p90_seconds, max_seconds, anomalies', async () => {
    for (const group_by of ['none', 'day', 'centre']) {
      const body = await ok12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, group_by });
      for (const r of body.rows) for (const k of Object.keys(r)) expect(['segment', 'key', 'label', 'n', 'median_seconds', 'p90_seconds', 'max_seconds', 'anomalies'], k).toContain(k);
    }
  });

  it('freshness is an array (contents arrive with the refresh wiring) and generated_at is the request time', async () => {
    const { ctx } = await makeCtx12(ADMIN);
    const body = await ok12(ctx, WINDOW);
    expect(Array.isArray(body.freshness)).toBe(true);
    expect(body.generated_at).toBe('2026-11-06T06:00:00.000Z');
  });
});

describe('US-15 / 07 P4 — centre scoping on TAT facts', () => {
  it('A1-only user: only A1 samples (A2, NULL-centre and tenant B absent); scope echo; contract-valid', async () => {
    const body = await ok12((await makeCtx12(OWNER_A1)).ctx, WINDOW);
    expect(bySeg(body)).toEqual(A1_ONLY);
    expect(body.scope).toEqual({ all_centres: false, centre_ids: [A1], tenant_wide_sections_hidden: [] });
    expect(contractErrors12(body)).toEqual([]);
  });

  it('two-centre user sees exactly A1 + A2; all-centre users also get NULL-centre samples', async () => {
    expect(bySeg(await ok12((await makeCtx12(OWNER_MULTI)).ctx, WINDOW))).toEqual(MULTI);
    for (const who of [ADMIN, OWNER_ALL]) {
      const body = await ok12((await makeCtx12(who)).ctx, WINDOW);
      expect(bySeg(body), who).toEqual(ALL);
      expect(body.scope).toEqual({ all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] });
    }
  });

  it('NULL-centre facts alone: visible to all-centre users, a centre-restricted user gets zeros (never widened)', async () => {
    t12.specimens = t12.specimens.filter((s) => s.centreId === null);
    t12.orders = t12.orders.filter((o) => o.centreId === null);
    expect(bySeg(await ok12((await makeCtx12(ADMIN)).ctx, WINDOW))).toMatchObject({ [PRE]: st(1, 4000, 4000, 4000, 0), [TF]: st(1, 5000, 5000, 5000, 0), [TT]: st(1, 9000, 9000, 9000, 0) });
    expect(bySeg(await ok12((await makeCtx12(OWNER_A1)).ctx, WINDOW))).toEqual(Object.fromEntries(SEGMENTS.map((s) => [s, none()])));
  });

  it('scope handed to the repo is the effective scope with the ctx tenant on every call', async () => {
    const { ctx } = await makeCtx12(OWNER_A1);
    await ok12(ctx, WINDOW);
    expect(db.calls.length).toBeGreaterThan(0);
    for (const c of db.calls) { expect(c.args.tenantId).toBe(ctx.tenantId); expect(c.args.scope).toEqual({ all: false, centreIds: [A1] }); }
  });

  it('centre_id outside the caller\'s scope, of tenant B, or unknown → 404 common.not_found (no existence oracle), nothing read', async () => {
    await expectLims(call12((await makeCtx12(OWNER_A1)).ctx, { ...WINDOW, centre_id: [A2] }), 'common.not_found', 404);
    await expectLims(call12((await makeCtx12(OWNER_A1)).ctx, { ...WINDOW, centre_id: [A1, A2] }), 'common.not_found', 404);
    await expectLims(call12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, centre_id: [B1] }), 'common.not_found', 404);
    expect(db.calls).toEqual([]);
  });

  it('many users at once: interleaved requests keep their own figures', async () => {
    const jobs = Array.from({ length: 24 }, async (_, i) => {
      const who = [ADMIN, OWNER_A1, OWNER_MULTI][i % 3]!;
      return { who, rows: bySeg(await ok12((await makeCtx12(who)).ctx, WINDOW)) };
    });
    const exp: Record<string, unknown> = { [ADMIN]: ALL, [OWNER_A1]: A1_ONLY, [OWNER_MULTI]: MULTI };
    for (const r of await Promise.all(jobs)) expect(r.rows, r.who).toEqual(exp[r.who]);
  });
});

describe('errors — validation before any read, unknown ids, dependency failure', () => {
  it.each([
    ['segment', ['bogus']], ['segment', [PRE, 'x']], ['priority', 'high'],['group_by', 'branch'], ['group_by', 'department'], ['group_by', ''],
    ['group_by', 'day; DROP TABLE analytics.tat_facts'], ['specimen_type_code', Array.from({ length: 21 }, (_, i) => `t${i}`)],
    ['processing_branch_id', Array.from({ length: 21 }, () => BR1)],
  ])('%s = %j → 400 common.validation_failed, no repo call', async (name, value) => {
    await expectLims(call12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, [name]: value }), 'common.validation_failed', 400);
    expect(db.calls).toEqual([]);
  });

  it('processing_branch_id of tenant B or unknown → 404 common.not_found, nothing read', async () => {
    const { idFor } = await import('../../../../../../../packages/fakes/src/base');
    for (const ids of [[BRB], [idFor(2, 0xfeed)], [BR1, BRB]]) await expectLims(call12((await makeCtx12(ADMIN)).ctx, { ...WINDOW, processing_branch_id: ids }), 'common.not_found', 404);
    expect(db.calls).toEqual([]);
  });

  it('a dependency failure is propagated, never an empty 200', async () => {
    db.fail = new (await import('../../../../core/errors.js')).LimsError('common.dependency_unavailable');
    await expectLims(call12((await makeCtx12(ADMIN)).ctx, WINDOW), 'common.dependency_unavailable', 503);
  });

  it('the default period (no dates) is accepted and reaches the repo as a [from, to) pair of business dates', async () => {
    const { ctx } = await makeCtx12(ADMIN);
    await ok12(ctx, {});
    const a = db.calls[0]!.args;
    expect(a.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(a.to > a.from).toBe(true);
  });
});
