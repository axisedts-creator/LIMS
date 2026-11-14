// C6-T33 — alert rules file services/worker/src/jobs/reporting/alerts/reporting.rules.yaml (02-TRD §12 "Alert rules for C1", 08 A13 P-14; imported verbatim by C1,
// infra/monitoring/rules/imported/reporting.rules.yml says "expr/for verbatim; C1 adds only severity, team, runbook_url").
// ASSUMED (spec silent): Prometheus rule-file format (groups -> rules with alert/expr/for), same as jobs/billing/alerts/cbms.rules.yaml; alert names are free but unique;
// severity/route labels are C1's to add, so they are not asserted here. Expressions are compared after collapsing whitespace.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(import.meta.dirname, '..');
const file = join(DIR, 'alerts', 'reporting.rules.yaml');
const { parse } = createRequire(join(DIR, '../../../../api/package.json'))('yaml') as { parse(s: string): any };
const rules = (): any[] => (existsSync(file) ? parse(readFileSync(file, 'utf8')).groups.flatMap((g: any) => g.rules) : []);
const norm = (s: string) => String(s).replace(/\s+/g, ' ').trim();

// 02-TRD §12 table, expr + for verbatim. T33 rows have their expr fixed by the task (gauge names are fixed by the TRD).
const TRD: Array<[string, string, string]> = [
  ['render failure rate', 'sum(increase(lims_reporting_render_failures_total[15m])) / clamp_min(sum(increase(lims_reporting_versions_total[15m])), 1) > 0.05', '15m'],
  ['version stuck rendering', 'lims_reporting_versions_rendering_oldest_seconds > 900', '5m'],
  ['held versions > 7 days', 'lims_reporting_held_oldest_seconds > 604800', '1h'],
  ['delivery failure rate', 'sum by (channel) (increase(lims_reporting_deliveries_total{status="failed"}[1h])) / clamp_min(sum by (channel) (increase(lims_reporting_deliveries_total[1h])), 1) > 0.2', '1h'],
  ['transport circuit open', 'lims_reporting_transport_circuit_open == 1', '1m'],
  ['otp verify brute force', 'sum by (tenant_id) (increase(lims_reporting_otp_verify_failures_total[1h])) > 50', '0m'],
  ['qr enumeration', 'sum(increase(lims_reporting_qr_verify_total{outcome="not_found"}[1h])) > 500', '0m'],
  ['renderer blocked request', 'increase(lims_renderer_blocked_requests_total[5m]) > 0', '0m'],
  ['sandbox rejection spike', 'sum(increase(lims_reporting_sandbox_rejections_total[1h])) > 20', '0m'],
  ['renderer / sandbox down', 'lims_ops_container_health{service=~"renderer|pdf-sandbox"} == 0', '2m'],
];
// `for: 0m` may also be written as 0s or omitted.
const forOf = (r: any) => (r.for === undefined || /^0[smh]?$/.test(String(r.for)) ? '0m' : String(r.for));

describe('reporting.rules.yaml (02-TRD §12, 08 A13 P-14)', () => {
  it('exists, is a Prometheus rule file, alert names are unique, every rule has alert + expr', () => {
    expect(existsSync(file), file).toBe(true);
    const r = rules(); expect(r).toHaveLength(10);
    for (const x of r) { expect(typeof x.alert).toBe('string'); expect(typeof x.expr).toBe('string'); }
    expect(new Set(r.map((x) => x.alert)).size).toBe(r.length);
  });
  it.each(TRD)('has the rule "%s" with the TRD expr and for', (_name, expr, forDur) => {
    const hit = rules().filter((r) => norm(r.expr) === norm(expr));
    expect(hit, `no rule with expr ${expr}`).toHaveLength(1);
    expect(forOf(hit[0])).toBe(forDur);
  });
  it('no rule outside the 10 TRD rows (a new alert needs a TRD row first)', () => {
    const known = new Set(TRD.map(([, e]) => norm(e)));
    expect(rules().filter((r) => !known.has(norm(r.expr))).map((r) => r.alert)).toEqual([]);
  });
  it('every metric a rule reads is a TRD §12 metric (or the C1 container-health metric); no PHI-class label is used', () => {
    const allowed = /^(lims_reporting_(versions_total|render_failures_total|deliveries_total|transport_circuit_open|versions_rendering_oldest_seconds|held_oldest_seconds|otp_verify_failures_total|qr_verify_total|sandbox_rejections_total)|lims_renderer_blocked_requests_total|lims_ops_container_health)$/;
    const text = rules().map((r) => String(r.expr)).join('\n');
    const metrics = [...text.matchAll(/\b(lims_[a-z_]+)\b/g)].map((m) => m[1]!);
    expect(metrics.length).toBeGreaterThan(5);
    for (const m of metrics) expect(m, m).toMatch(allowed);
    const labels = [...text.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim()));
    for (const l of labels) expect(['tenant_id', 'channel']).toContain(l);   // 02-TRD §12: only these group-bys
    expect(readFileSync(file, 'utf8')).not.toMatch(/@|\+977|\b9\d{9}\b/);   // no e-mail address / phone number in a rules file (07-SEC)
  });
});
