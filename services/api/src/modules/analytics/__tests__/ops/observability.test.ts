// AN-T22 (C8) - alert rule file + metric registry (02-TRD §13 "Metrics", "Alert rules for C1"; CR-C8-015; 07-SECURITY §6).
// done_when: "metrics exported; rule file holds exactly the five rules of TRD §13".
// SEAMS: (1) the nine lims_analytics_* metrics are registered in services/api/src/core/observability/metrics.ts DEFS (createMetrics / REQUIRED_METRICS),
//   the one registry every service exposes on /metrics ("metrics in services/tasks" has no such directory in this repo).
// (2) services/worker/src/jobs/analytics/ops/analytics.rules.yml carries expr + for verbatim from the TRD table; severity/team/runbook_url are added by C1
//   (infra/monitoring/rules/imported/analytics.rules.yml header), so a `labels.severity` in the C8 file is only checked when present.
// NOTE for the implementer: core/observability/__tests__/metrics.test.ts pins REQUIRED_METRICS to an EXPECTED map; it must gain the nine names below.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { createMetrics, REQUIRED_METRICS } from '../../../../core/observability/metrics.js';

const RULES = join(REPO_ROOT, 'services', 'worker', 'src', 'jobs', 'analytics', 'ops', 'analytics.rules.yml');
const IMPORTED = join(REPO_ROOT, 'infra', 'monitoring', 'rules', 'imported', 'analytics.rules.yml');
const TRD = join(REPO_ROOT, 'spec', 'chunks', 'C8-analytics-mis', '02-TRD.md');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

interface Rule { alert: string; expr: string; for?: string; labels?: Record<string, string> }
const rulesOf = (file: string): Rule[] => (parse(readFileSync(file, 'utf8')) as { groups: { rules: Rule[] }[] }).groups.flatMap((g) => g.rules);

/** TRD §13 "Alert rules for C1" table: alert, expr (first backtick span), for, severity (first word). */
function trdAlerts(): { alert: string; expr: string; for: string; severity: string }[] {
  const text = readFileSync(TRD, 'utf8');
  const a = text.indexOf('#### Alert rules for C1'), b = text.indexOf('#### CI jobs for C0-0A', a);
  expect(a, 'TRD alert heading').toBeGreaterThan(-1); expect(b, 'TRD CI heading').toBeGreaterThan(a);
  const out = [];
  for (const line of text.slice(a, b).split('\n')) {
    const m = /^\|\s*`(Analytics\w+)`[^|]*\|\s*`([^`]+)`[^|]*\|\s*(\d+m)\s*\|\s*(page|warn)\b/.exec(line);
    if (m) out.push({ alert: m[1]!, expr: m[2]!, for: m[3]!, severity: m[4]! });
  }
  return out;
}

describe('analytics.rules.yml (CR-C8-015)', () => {
  it('the TRD table parse finds the five rules (guards the comparisons against an empty parse)', () => {
    expect(trdAlerts().map((r) => r.alert)).toEqual(['AnalyticsFamilyStale', 'AnalyticsRefreshFailing', 'AnalyticsReconciliationMismatch', 'AnalyticsExportSpike', 'AnalyticsConsumerDeadLetter']);
  });

  it('the file exists in the C8 path and holds exactly the five rules of TRD §13, no more, no fewer, no duplicates', () => {
    const names = rulesOf(RULES).map((r) => r.alert);
    expect(names.sort()).toEqual(trdAlerts().map((r) => r.alert).sort());
  });

  it('expr and for are verbatim from the TRD (whitespace-folded); severity, when present, matches', () => {
    const got = new Map(rulesOf(RULES).map((r) => [r.alert, r]));
    for (const want of trdAlerts()) {
      const r = got.get(want.alert);
      expect(r, want.alert).toBeDefined();
      expect(norm(r!.expr), `${want.alert} expr`).toBe(norm(want.expr));
      expect(r!.for, `${want.alert} for`).toBe(want.for);
      if (r!.labels?.['severity'] !== undefined) expect(r!.labels['severity'], `${want.alert} severity`).toBe(want.severity);
    }
  });

  it('no rule filters or groups by a person-level label (membership / user / referrer id; metrics never carry them)', () => {
    for (const r of rulesOf(RULES)) expect(r.expr, r.alert).not.toMatch(/\b(membership|user|referrer|doctor|patient)_?id\b/i);
  });

  it('is in step with the copy C1 imported (alert-import-drift: same alerts, same expr, same for)', () => {
    const fold = (rs: Rule[]) => rs.map((r) => [r.alert, norm(r.expr), r.for]).sort();
    expect(fold(rulesOf(RULES))).toEqual(fold(rulesOf(IMPORTED)));
  });
});

const ANALYTICS = {
  lims_analytics_refresh_duration_seconds: ['histogram', ['family']],
  lims_analytics_refresh_failures_total: ['counter', ['family']],
  lims_analytics_family_stale: ['gauge', ['tenant_id', 'family']],
  lims_analytics_dirty_partitions: ['gauge', ['family']],
  lims_analytics_reconciliation_mismatch_total: ['counter', ['rule', 'family']],
  lims_analytics_exports_total: ['counter', ['tenant_id', 'format', 'outcome']],
  lims_analytics_export_rows: ['histogram', ['report_code']],
  lims_analytics_export_downloads_total: ['counter', ['tenant_id']],
  lims_analytics_schedule_sends_total: ['counter', ['outcome']],
} as const;
const T = '01a1a98a-ac40-7000-8000-00000000a001';
const TB = '01a1a98a-ac40-7000-8000-00000000b001';
const L: Record<string, string> = { tenant_id: T, family: 'income', rule: 'R3', format: 'csv', outcome: 'ok', report_code: 'income_summary' };
const pick = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, L[n]!]));

describe('analytics metrics registry (TRD §13 Metrics)', () => {
  it('all nine lims_analytics_* metrics are registered in REQUIRED_METRICS, and nothing else with that prefix', () => {
    expect(REQUIRED_METRICS.filter((n) => n.startsWith('lims_analytics_')).sort()).toEqual(Object.keys(ANALYTICS).sort());
  });

  it.each(Object.entries(ANALYTICS))('%s is exposed with the TRD type and its exact label set', async (name, [kind, labels]) => {
    const m = createMetrics(); const n = name as never; const lb = pick(labels);
    if (kind === 'counter') m.inc(n, lb); else if (kind === 'gauge') m.set(n, 1, lb); else m.observe(n, 3, lb);
    const text = await m.render();
    expect(text).toContain(`# TYPE ${name} ${kind}`);
    for (const l of labels) expect(text).toMatch(new RegExp(`^${name}\\w*\\{[^}]*\\b${l}="${L[l]}"`, 'm'));
  });

  it.each(Object.entries(ANALYTICS))('%s rejects an id/PHI label outside its set (no membership / referrer / export id labels)', (name, [kind, labels]) => {
    const m = createMetrics(); const n = name as never;
    for (const bad of ['membership_id', 'referrer_id', 'export_id', 'patient_name']) {
      const lb = { ...pick(labels), [bad]: 'x' };
      expect(() => (kind === 'counter' ? m.inc(n, lb) : kind === 'gauge' ? m.set(n, 1, lb) : m.observe(n, 1, lb)), `${name}+${bad}`).toThrow();
    }
  });

  it('the family_stale gauge takes 0 and 1 (alert expr compares == 1) and keeps tenants apart', async () => {
    const m = createMetrics();
    m.set('lims_analytics_family_stale' as never, 1, { tenant_id: T, family: 'income' });
    m.set('lims_analytics_family_stale' as never, 0, { tenant_id: TB, family: 'income' });
    const text = await m.render();
    expect(text).toMatch(new RegExp(`lims_analytics_family_stale\\{[^}]*tenant_id="${T}"[^}]*\\} 1\\b`));
    expect(text).toMatch(new RegExp(`lims_analytics_family_stale\\{[^}]*tenant_id="${TB}"[^}]*\\} 0\\b`));
  });
});
