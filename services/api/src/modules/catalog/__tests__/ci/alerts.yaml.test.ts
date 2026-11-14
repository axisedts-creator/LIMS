// T-36 (C3) — CR-C3-009: `services/api/src/modules/catalog/ops/alerts.yaml`, the chunk-owned alert rule file C1 imports (C1 02-TRD §11.3 intake row "C3";
// 08 A13 P-14). Expected rules are copied verbatim from C3 02-TRD §13 "Alert rules for C1" (expr / for / severity / route; the values are [CONV] there).
// File format (C1 imports "Prometheus rule files": `infra/ci/import-rules.sh` adds only team / runbook_url / receiver): groups[].rules[] with `alert`, `expr`, `for`,
// `labels.severity`, `labels.route`, `annotations.summary` (C1 lint rejects rules without a summary; no PHI in it). Thresholds and `for` stay verbatim.
// Metrics used must be in the §13 metric table (no invented names, no tenant label — cardinality). Red today: the file does not exist.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';

const FILE = join(REPO_ROOT, 'services/api/src/modules/catalog/ops/alerts.yaml');
const EXPECTED: ReadonlyArray<{ alert: string; expr: string; for: string; severity: string; route: string }> = [
  { alert: 'CatalogImportQuarantined', expr: 'increase(lims_catalog_imports_total{outcome="quarantined"}[5m]) > 0', for: '0m', severity: 'page', route: 'security' },
  { alert: 'CatalogNoPriceSpike', expr: 'sum(rate(lims_catalog_port_calls_total{method="priceFor",outcome="no_price"}[15m])) / sum(rate(lims_catalog_port_calls_total{method="priceFor"}[15m])) > 0.05', for: '15m', severity: 'ticket', route: 'ops' },
  { alert: 'CatalogNoRangeSpike', expr: 'sum(rate(lims_catalog_port_calls_total{method="referenceRangeFor",outcome="no_reference_range"}[15m])) / sum(rate(lims_catalog_port_calls_total{method="referenceRangeFor"}[15m])) > 0.05', for: '15m', severity: 'ticket', route: 'ops' },
  { alert: 'CatalogPortLatency', expr: 'histogram_quantile(0.95, sum by (le) (rate(lims_catalog_port_duration_seconds_bucket[5m]))) > 0.05', for: '10m', severity: 'ticket', route: 'ops' },
  { alert: 'CatalogImportStuck', expr: 'sum(lims_catalog_import_tasks_inflight) > 0', for: '15m', severity: 'ticket', route: 'ops' },
  { alert: 'CatalogContactReadsSpike', expr: 'sum(increase(lims_catalog_contact_reads_total{purpose="notification"}[1h])) > 10 * quantile_over_time(0.5, sum(increase(lims_catalog_contact_reads_total{purpose="notification"}[1h]))[7d:1h])', for: '0m', severity: 'ticket', route: 'security' },
];
// §13 metric table (the _bucket suffix belongs to the histogram)
const METRICS = [
  'lims_catalog_port_calls_total', 'lims_catalog_port_duration_seconds', 'lims_catalog_cache_lookups_total', 'lims_catalog_revision_bumps_total', 'lims_catalog_imports_total',
  'lims_catalog_import_duration_seconds', 'lims_catalog_exports_total', 'lims_catalog_range_unit_mismatch_total', 'lims_catalog_contact_reads_total', 'lims_catalog_import_tasks_inflight',
];
const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();
const load = () => parse(readFileSync(FILE, 'utf8')) as any;
const rules = (): any[] => (load()?.groups ?? []).flatMap((g: any) => g?.rules ?? []);

describe('CR-C3-009: services/api/src/modules/catalog/ops/alerts.yaml', () => {
  it('exists and is a Prometheus rule file (groups[].rules[])', () => {
    expect(existsSync(FILE)).toBe(true);
    const doc = load();
    expect(Array.isArray(doc?.groups)).toBe(true);
    expect(doc.groups.length).toBeGreaterThan(0);
    for (const g of doc.groups) { expect(typeof g.name).toBe('string'); expect(Array.isArray(g.rules)).toBe(true); }
  });

  it('holds exactly the six rules of 02-TRD §13, each alert name once', () => {
    const names = rules().map((r) => r.alert);
    expect([...names].sort()).toEqual(EXPECTED.map((e) => e.alert).sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(EXPECTED)('$alert: expr, for, severity and route are verbatim from the TRD table', (e) => {
    const r = rules().find((x) => x.alert === e.alert);
    expect(r, e.alert).toBeDefined();
    expect(norm(r.expr)).toBe(norm(e.expr));
    expect(String(r.for ?? '0m')).toBe(e.for);
    expect(r.labels?.severity).toBe(e.severity);
    expect(r.labels?.route).toBe(e.route);
  });

  it('every rule has annotations.summary (C1 lint) with no template that interpolates label values that could carry personal data', () => {
    for (const r of rules()) {
      expect(typeof r.annotations?.summary, r.alert).toBe('string');
      expect(r.annotations.summary.trim().length, r.alert).toBeGreaterThan(0);
      expect(r.annotations.summary, r.alert).not.toMatch(/\$labels\.(name|phone|email|doctor|party|pan)/i);
    }
  });

  it('only §13 metrics are used (no invented names) and no rule needs a tenant label', () => {
    for (const r of rules()) {
      const used = [...String(r.expr).matchAll(/\blims_[a-z0-9_]+/g)].map((m) => m[0].replace(/_bucket$/, ''));
      expect(used.length, r.alert).toBeGreaterThan(0);
      for (const m of used) expect(METRICS, `${r.alert}: ${m}`).toContain(m);
      expect(String(r.expr), r.alert).not.toMatch(/tenant/i);
    }
  });

  it('the file never mentions the forbidden word (AC-11.5) and holds no secrets / URLs', () => {
    const text = readFileSync(FILE, 'utf8');
    expect(text).not.toMatch(/commission/i);
    expect(text).not.toMatch(/https?:\/\/|password|secret|token/i);
  });
});
