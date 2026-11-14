// C13 T23 — Observability (06-IMPLEMENTATION-PLAN row T23). Part 1/4: metric REGISTRATION + alert rules file. Tests: unit.
// done_when: "metrics in 02-TRD §13 emitted; alert rules delivered to C1 (PRD §6)". Spec: 02-TRD §13 (metric table + alert table), 07-SECURITY REQ-SEC-045/133, 01-PRD AC US-07 #7 (alert-worthy metric).
// LD-140 (UI only) does not apply: backend task.
// Red today: lims_partners_* are not in core/observability/metrics.ts DEFS (createMetrics().inc throws "unknown counter"), and partners/ops/alerts.yaml does not exist.
// SEAM (not fixed by the spec): the alert file location. Precedent = catalog (`services/api/src/modules/catalog/ops/alerts.yaml`, C1 imports "Prometheus rule files"): here `services/api/src/modules/partners/ops/alerts.yaml`.
// SEAM: the TRD gives thresholds, not PromQL. Rules are located by the metric / label / window / threshold tokens the TRD table names, so any equivalent expression passes.
// SPEC GAP (not asserted, see notes): "any line `converting` > 30 min" and "any user > 80 % of daily cap" have no metric in the §13 table (no per-user label allowed); the implementer may add rules/metrics via a CR.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../core/module.js';
import { createMetrics, REQUIRED_METRICS } from '../../../core/observability/metrics.js';

type Kind = 'counter' | 'gauge' | 'histogram';
/** 02-TRD §13 "Metrics" table, verbatim names and labels. */
const TABLE: Record<string, [Kind, string[]]> = {
  lims_partners_manifests_total: ['counter', ['transition']],
  lims_partners_line_conversions_total: ['counter', ['outcome', 'failure_code']],
  lims_partners_conversion_duration_seconds: ['histogram', []],
  lims_partners_events_consumed_total: ['counter', ['event_type', 'outcome']],
  lims_partners_projection_lag_seconds: ['gauge', ['projection']],
  lims_partners_report_downloads_total: ['counter', ['outcome']],
  lims_partners_access_slips_total: ['counter', ['outcome']],
  lims_partners_access_slip_issue_seconds: ['histogram', []],
  lims_partners_pickups_total: ['counter', ['transition']],
  lims_partners_partner_inactive_rejections_total: ['counter', []],
};
const labelsFor = (names: string[]) => Object.fromEntries(names.map((n) => [n, 'x']));
const use = (m: ReturnType<typeof createMetrics>, name: string, kind: Kind, labels: Record<string, string>) => {
  if (kind === 'counter') m.inc(name as never, labels);
  else if (kind === 'gauge') m.set(name as never, 1, labels);
  else m.observe(name as never, 0.5, labels);
};

describe('T23 registry: every §13 metric is registered in core createMetrics() with the TRD labels', () => {
  it('REQUIRED_METRICS lists all ten lims_partners_* names', () => {
    for (const name of Object.keys(TABLE)) expect(REQUIRED_METRICS as readonly string[], name).toContain(name);
  });

  it.each(Object.entries(TABLE))('%s: right type, accepts exactly its labels', async (name, [kind, labels]) => {
    const m = createMetrics();
    expect(() => use(m, name, kind, labelsFor(labels))).not.toThrow();
    expect(await m.render()).toContain(`# TYPE ${name} ${kind}`);
  });

  it.each(Object.entries(TABLE))('%s: a label outside the TRD set (tenant_id, partner_id, user_id, any id) is refused — no id / PHI labels, bounded cardinality', (name, [kind, labels]) => {
    expect(() => use(createMetrics(), name, kind, labelsFor(labels)), `${name} must be registered first`).not.toThrow(); // else the refusals below pass for the wrong reason
    for (const extra of ['tenant_id', 'partner_id', 'user_id', 'manifest_id']) {
      expect(() => use(createMetrics(), name, kind, { ...labelsFor(labels), [extra]: 'x' }), `${name}+${extra}`).toThrow();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------ alerts
const FILE = join(REPO_ROOT, 'services/api/src/modules/partners/ops/alerts.yaml');
const load = () => parse(readFileSync(FILE, 'utf8')) as any;
const rules = (): any[] => (load()?.groups ?? []).flatMap((g: any) => g?.rules ?? []);
const expr = (r: any) => String(r.expr).replace(/\s+/g, ' ');
const find = (...tokens: Array<string | RegExp>) => rules().filter((r) => tokens.every((t) => (typeof t === 'string' ? expr(r).includes(t) : t.test(expr(r)))));
const ALLOWED_METRICS = [...Object.keys(TABLE), 'lims_core_dead_letters_total'];

describe('T23 alerts: services/api/src/modules/partners/ops/alerts.yaml (registered with C1; REQ-SEC-133; 02-TRD §13 alert table)', () => {
  it('exists and is a Prometheus rule file (groups[].rules[] with alert, expr, labels.severity, labels.route, annotations.summary)', () => {
    expect(existsSync(FILE)).toBe(true);
    const doc = load();
    expect(Array.isArray(doc?.groups)).toBe(true);
    expect(doc.groups.length).toBeGreaterThan(0);
    for (const g of doc.groups) { expect(typeof g.name).toBe('string'); expect(Array.isArray(g.rules)).toBe(true); }
    const names = rules().map((r) => r.alert);
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(new Set(names).size).toBe(names.length);
    for (const r of rules()) {
      expect(typeof r.alert, 'alert').toBe('string'); expect(r.alert, r.alert).toMatch(/^Partners[A-Za-z0-9]+$/);
      expect(typeof r.expr, r.alert).toBe('string');
      expect(['page', 'ticket'], r.alert).toContain(r.labels?.severity);
      expect(['ops', 'security'], r.alert).toContain(r.labels?.route);
      expect(typeof r.annotations?.summary, r.alert).toBe('string');
      expect(r.annotations.summary.trim().length, r.alert).toBeGreaterThan(0);
    }
  });

  it('Conversion failures: failed_infra > 5 in 15 min (line_conversions_total)', () => {
    expect(find('lims_partners_line_conversions_total', 'failed_infra', '[15m]', /> ?5\b/)).toHaveLength(1);
  });

  it('Consumer mismatch: events_consumed_total{outcome="mismatch"} > 0, routed to security (possible wrong partner attribution)', () => {
    const r = find('lims_partners_events_consumed_total', 'outcome="mismatch"', /> ?0\b/);
    expect(r).toHaveLength(1);
    expect(r[0].labels.route).toBe('security');
  });

  it('Download denied spike: report_downloads_total denied > 20 in 10 min, routed to security (id-guessing)', () => {
    const r = find('lims_partners_report_downloads_total', 'outcome="denied"', '[10m]', /> ?20\b/);
    expect(r).toHaveLength(1);
    expect(r[0].labels.route).toBe('security');
  });

  it('Projection stale: statements lag > 3 h (10800 s) and price list lag > 26 h (93600 s) on projection_lag_seconds', () => {
    expect(find('lims_partners_projection_lag_seconds', 'projection="statements"', /> ?10800\b/)).toHaveLength(1);
    expect(find('lims_partners_projection_lag_seconds', 'projection="price_list"', /> ?93600\b/)).toHaveLength(1);
  });

  it('Dead letters: increase of lims_core_dead_letters_total for partners.* and evt.partners.* tasks', () => {
    const r = find('lims_core_dead_letters_total', 'increase(', 'partners', 'evt.partners');
    expect(r).toHaveLength(1);
  });

  it('metrics used by a rule are §13 names (or the core dead-letter counter) whenever the rule uses a partners metric; no invented lims_partners_* names', () => {
    for (const r of rules()) {
      const used = [...expr(r).matchAll(/\blims_[a-z0-9_]+/g)].map((m) => m[0].replace(/_bucket$/, ''));
      for (const m of used.filter((u) => u.startsWith('lims_partners_'))) expect(ALLOWED_METRICS, `${r.alert}: ${m}`).toContain(m);
    }
  });

  it('no secrets / URLs / personal data in the file, no label interpolation of identifiers in summaries', () => {
    const text = readFileSync(FILE, 'utf8');
    expect(text).not.toMatch(/https?:\/\/|password|secret|token|@[a-z0-9-]+\.[a-z]{2,}/i);
    for (const r of rules()) expect(r.annotations.summary, r.alert).not.toMatch(/\$labels\.(tenant|user|partner|manifest|patient|name|phone|email)/i);
  });
});
