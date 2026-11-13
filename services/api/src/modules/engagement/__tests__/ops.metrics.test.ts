// C16.T-OPS1 — metrics (02-TRD §13 "Metric" table; plan row T-OPS1 "metric names per TRD §13"; 02-CV §9.2 no ids/PHI in labels).
// SEAMS (spec fixes names/types/labels, not TypeScript shapes; precedent = lab/smartreport observability tests, LD-88/LD-120):
//  (1) services/api/src/modules/engagement/metrics.ts exports `ENGAGEMENT_METRICS: Record<name, [kind, labelNames]>` (the 13 TRD rows) and `engagementMetrics`, a best-effort emitter
//      over the optional sink `ctx.metrics?.inc?.(name, labels, by)` / `?.set?.(name, value, labels)` / `?.observe?.(name, value, labels)`; a missing sink or a throwing sink never throws.
//  (2) the 13 lims_engagement_* metrics are registered in services/api/src/core/observability/metrics.ts DEFS (createMetrics / REQUIRED_METRICS), the one registry /metrics exposes.
//      NOTE for the writer: DEFS and core/observability/__tests__/metrics.test.ts (EXPECTED map) are C0 paths -> lead decision / CR first (LD-88, LD-120 precedent). Only the two tests
//      in "core registry" depend on that; everything else runs on metrics.ts alone.
//  (3) emitter methods (ctx first): otpRequest(outcome) otpVerification(outcome) linkEvent(method, outcome) projectionLag(eventType, seconds) projectionDrift(table) booking(kind, outcome)
//      slotConflict() queueToken(event) queueWait(seconds) displaysStale(count) paymentRequest(gateway, outcome) reminder(kind, outcome) reportDownload(outcome).
// Fails now: services/api/src/modules/engagement/metrics.ts does not exist; no lims_engagement_* metric is registered.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../core/module.js';
import { createMetrics, REQUIRED_METRICS } from '../../../core/observability/metrics.js';

type Kind = 'counter' | 'gauge' | 'histogram';
const TRD = join(REPO_ROOT, 'spec', 'chunks', 'C16-patient-engagement', '02-TRD.md');
const FILE = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'engagement', 'metrics.ts');
/** 02-TRD §13 metric table, verbatim names/types/labels. */
const EN: Record<string, readonly [Kind, readonly string[]]> = {
  lims_engagement_otp_requests_total: ['counter', ['outcome']],
  lims_engagement_otp_verifications_total: ['counter', ['outcome']],
  lims_engagement_link_events_total: ['counter', ['method', 'outcome']],
  lims_engagement_projection_lag_seconds: ['histogram', ['event_type']],
  lims_engagement_projection_drift_total: ['counter', ['table']],
  lims_engagement_bookings_total: ['counter', ['kind', 'outcome']],
  lims_engagement_slot_conflicts_total: ['counter', []],
  lims_engagement_queue_tokens_total: ['counter', ['event']],
  lims_engagement_queue_wait_seconds: ['histogram', []],
  lims_engagement_displays_stale: ['gauge', []],
  lims_engagement_payment_requests_total: ['counter', ['gateway', 'outcome']],
  lims_engagement_reminders_total: ['counter', ['kind', 'outcome']],
  lims_engagement_report_downloads_total: ['counter', ['outcome']],
};
const L: Record<string, string> = {
  outcome: 'queued', method: 'link_code', event_type: 'reporting.report.released.v1', table: 'patient_orders', kind: 'centre_visit', event: 'issued', gateway: 'esewa',
};
const pick = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, L[n]!]));
const emit = (m: ReturnType<typeof createMetrics>, name: string, kind: Kind, lb: Record<string, string>) => {
  const n = name as never;
  if (kind === 'counter') m.inc(n, lb); else if (kind === 'gauge') m.set(n, 1, lb); else m.observe(n, 3, lb);
};
const mod = async (): Promise<any> => import(/* @vite-ignore */ '../metrics.js');

describe('TRD §13 metric table (guards this file against TRD drift)', () => {
  it('lists exactly the 13 lims_engagement_* metrics pinned here, with the pinned type and labels', () => {
    const text = readFileSync(TRD, 'utf8');
    const a = text.indexOf('## 13. Observability'), b = text.indexOf('Alerts (rules shipped to C1', a);
    const rows = [...text.slice(a, b).matchAll(/^\|\s*`(lims_engagement_\w+)`\s*\|\s*(counter|gauge|histogram)\s*\|\s*([^|]*)\|/gm)];
    expect(rows.map((r) => r[1]!).sort()).toEqual(Object.keys(EN).sort());
    for (const r of rows) {
      expect(r[2], r[1]).toBe(EN[r[1]!]![0]);
      const labels = [...r[3]!.matchAll(/`(\w+)`/g)].map((x) => x[1]!);
      expect(labels, `${r[1]} labels`).toEqual([...EN[r[1]!]![1]]);
    }
  });
});

describe('metrics.ts (services/api/src/modules/engagement/metrics.ts)', () => {
  it('exists and exports ENGAGEMENT_METRICS equal to the TRD table', async () => {
    expect(existsSync(FILE), FILE).toBe(true);
    const { ENGAGEMENT_METRICS } = await mod();
    expect(Object.keys(ENGAGEMENT_METRICS).sort()).toEqual(Object.keys(EN).sort());
    for (const [name, [kind, labels]] of Object.entries(EN)) {
      expect(ENGAGEMENT_METRICS[name][0], `${name} type`).toBe(kind);
      expect([...ENGAGEMENT_METRICS[name][1]], `${name} labels`).toEqual([...labels]);
    }
  });

  it('no label is an id, phone, name, code or token (02-CV §9.2; TRD §13 denylist keys)', async () => {
    const { ENGAGEMENT_METRICS } = await mod();
    for (const [name, [, labels]] of Object.entries<any>(ENGAGEMENT_METRICS)) {
      for (const l of labels as string[]) expect(l, name).not.toMatch(/(^|_)(id|phone|name|code|token|account|patient|tenant|user)(_|$)/i);
    }
  });
});

describe('emitter: each method hits its TRD metric with exactly the TRD labels', () => {
  const CALLS: [string, (e: any, ctx: any) => void, string, Record<string, string | number>, number | undefined][] = [
    ['otpRequest', (e, c) => e.otpRequest(c, 'rate_limited'), 'lims_engagement_otp_requests_total', { outcome: 'rate_limited' }, undefined],
    ['otpVerification', (e, c) => e.otpVerification(c, 'exhausted'), 'lims_engagement_otp_verifications_total', { outcome: 'exhausted' }, undefined],
    ['linkEvent', (e, c) => e.linkEvent(c, 'report_link', 'suspended'), 'lims_engagement_link_events_total', { method: 'report_link', outcome: 'suspended' }, undefined],
    ['projectionLag', (e, c) => e.projectionLag(c, 'catalog.changed.v1', 12.5), 'lims_engagement_projection_lag_seconds', { event_type: 'catalog.changed.v1' }, 12.5],
    ['projectionDrift', (e, c) => e.projectionDrift(c, 'patient_reports'), 'lims_engagement_projection_drift_total', { table: 'patient_reports' }, undefined],
    ['booking', (e, c) => e.booking(c, 'home_collection', 'slot_unavailable'), 'lims_engagement_bookings_total', { kind: 'home_collection', outcome: 'slot_unavailable' }, undefined],
    ['slotConflict', (e, c) => e.slotConflict(c), 'lims_engagement_slot_conflicts_total', {}, undefined],
    ['queueToken', (e, c) => e.queueToken(c, 'transferred'), 'lims_engagement_queue_tokens_total', { event: 'transferred' }, undefined],
    ['queueWait', (e, c) => e.queueWait(c, 240), 'lims_engagement_queue_wait_seconds', {}, 240],
    ['displaysStale', (e, c) => e.displaysStale(c, 2), 'lims_engagement_displays_stale', {}, 2],
    ['paymentRequest', (e, c) => e.paymentRequest(c, 'khalti', 'failed'), 'lims_engagement_payment_requests_total', { gateway: 'khalti', outcome: 'failed' }, undefined],
    ['reminder', (e, c) => e.reminder(c, 'follow_up', 'suppressed_no_consent'), 'lims_engagement_reminders_total', { kind: 'follow_up', outcome: 'suppressed_no_consent' }, undefined],
    ['reportDownload', (e, c) => e.reportDownload(c, 'ok'), 'lims_engagement_report_downloads_total', { outcome: 'ok' }, undefined],
  ];

  it.each(CALLS)('%s', async (_n, call, name, labels, value) => {
    const { engagementMetrics } = await mod();
    const seen: any[] = [];
    const sink = {
      inc: (n: string, l?: any, by?: number) => seen.push(['inc', n, l ?? {}, by]),
      set: (n: string, v: number, l?: any) => seen.push(['set', n, l ?? {}, v]),
      observe: (n: string, v: number, l?: any) => seen.push(['observe', n, l ?? {}, v]),
    };
    call(engagementMetrics, { metrics: sink });
    expect(seen).toHaveLength(1);
    const [op, n, l, v] = seen[0];
    expect(n).toBe(name);
    expect(op).toBe({ counter: 'inc', gauge: 'set', histogram: 'observe' }[EN[name]![0]]);
    expect(l).toEqual(labels);
    if (value !== undefined) expect(v).toBe(value);
  });

  it('is best effort: no ctx, no sink, a partial sink, or a sink that throws never breaks the caller (a metric must not fail a patient request)', async () => {
    const { engagementMetrics } = await mod();
    const boom = () => { throw new Error('rejected label'); };
    for (const ctx of [undefined, {}, { metrics: {} }, { metrics: { inc: boom, set: boom, observe: boom } }]) {
      for (const [, call] of CALLS) expect(() => call(engagementMetrics, ctx), JSON.stringify(Object.keys(ctx ?? {}))).not.toThrow();
    }
  });
});

describe('core registry (lead decision / CR first: see SEAM 2)', () => {
  it('all 13 lims_engagement_* metrics are registered in REQUIRED_METRICS, and nothing else with that prefix', () => {
    expect(REQUIRED_METRICS.filter((n) => n.startsWith('lims_engagement_')).sort()).toEqual(Object.keys(EN).sort());
  });

  it.each(Object.entries(EN))('%s is exposed with the TRD type and its exact label set', async (name, [kind, labels]) => {
    const m = createMetrics();
    emit(m, name, kind, pick(labels));
    const text = await m.render();
    expect(text).toContain(`# TYPE ${name} ${kind}`);
    for (const l of labels) expect(text).toMatch(new RegExp(`^${name}\\w*\\{[^}]*\\b${l}="${L[l]}"`, 'm'));
  });

  it('a label outside the TRD set is rejected (typo / PHI guard)', () => {
    const m = createMetrics();
    expect(() => m.inc('lims_engagement_otp_requests_total' as never, { outcome: 'queued' })).not.toThrow();   // registered, so the throws below are about the label, not the name
    expect(() => m.inc('lims_engagement_slot_conflicts_total' as never)).not.toThrow();
    expect(() => m.inc('lims_engagement_otp_requests_total' as never, { outcome: 'queued', phone: '+9779800000000' })).toThrow();
    expect(() => m.inc('lims_engagement_slot_conflicts_total' as never, { tenant_id: 'x' })).toThrow();
  });
});
