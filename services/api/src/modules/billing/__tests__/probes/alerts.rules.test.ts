// BL-T22 done_when: "alert rules per TRD §15 listed for one CR to C1". 02-TRD §15 "Alert rules for C1" (08 A13 P-14) has 9 rules; rule files live in
// services/worker/src/jobs/billing/alerts/*.yaml and services/worker/src/jobs/frontdesk/alerts/*.yaml (Prometheus rule-file shape, like cbms.rules.yaml / instruments.rules.yml).
// Metric rules carry the metric in `expr`; the "DB rule over ..." rows carry their table/action/threshold in `expr` or `annotations` (writer's choice of encoding) — matched by tokens.
// Fails now: frontdesk/alerts does not exist and only the two CBMS rules are on disk; .orchestra/cr/BL-T22.md (the one CR to C1) is absent.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';

const dirs = ['services/worker/src/jobs/billing/alerts', 'services/worker/src/jobs/frontdesk/alerts'];
const files = dirs.flatMap((d) => (existsSync(join(REPO_ROOT, d)) ? readdirSync(join(REPO_ROOT, d)).filter((f) => /\.ya?ml$/.test(f)).map((f) => `${d}/${f}`) : []));
const rules: Array<{ file: string; rule: any; text: string }> = files.flatMap((file) =>
  (parse(readFileSync(join(REPO_ROOT, file), 'utf8'))?.groups ?? []).flatMap((g: any) => (g.rules ?? []).map((rule: any) => ({ file, rule, text: JSON.stringify(rule) }))));

// [name, file dir, tokens that must all appear in the rule, severity, route tokens]
const REQUIRED: Array<[string, string, string[], string, string[]]> = [
  ['billing integrity', 'billing', ['lims_billing_integrity_violations_total', '[1d]', '> 0'], 'page', ['on-call', 'oncall']],
  ['counter busy', 'billing', ['lims_billing_counter_busy_total', '[5m]', '> 5'], 'warn', ['on-call', 'oncall']],
  ['numbering pattern invalid', 'billing', ['lims_billing_numbering_pattern_invalid_total', '[15m]', '> 0'], 'warn', ['on-call', 'oncall']],
  ['CBMS pending > 1 h', 'billing', ['stale_1h'], 'page', ['on-call', 'oncall']],
  ['CBMS attempts >= 10', 'billing', ['attempts_10_plus'], 'warn', ['on-call', 'oncall', 'ops-digest']],
  ['TRF quarantine burst', 'frontdesk', ['lims_frontdesk_trf_scans_total', 'quarantined', '[1h]', '> 3'], 'warn', ['on-call', 'oncall']],
  ['exports per user', 'billing', ['data.export', 'create', '10'], 'warn', ['security']],
  ['patient-search volume per user', 'frontdesk', ['patient.search', '300'], 'warn', ['security']],
  ['refunds per tenant', 'billing', ['refund_recorded', 'refund_alert_per_day'], 'warn', ['finance']],
];

describe('rule files', () => {
  it('both alert directories hold at least one .yaml rule file', () => {
    for (const d of dirs) expect(files.some((f) => f.startsWith(d)), d).toBe(true);
  });
  it('every rule has alert, expr, labels.severity (page|warn), labels.route and annotations.summary; for = 0m where TRD says 0m', () => {
    expect(rules.length).toBeGreaterThanOrEqual(9);
    for (const { file, rule } of rules) {
      const at = `${file}:${rule.alert}`;
      expect(rule.alert, at).toMatch(/^[A-Z][A-Za-z0-9]+$/);
      expect(String(rule.expr ?? '').length, `${at} expr`).toBeGreaterThan(5);
      expect(['page', 'warn'], at).toContain(rule.labels?.severity);
      expect(String(rule.labels?.route ?? ''), `${at} route`).not.toBe('');
      expect(String(rule.annotations?.summary ?? ''), `${at} summary`).not.toBe('');
    }
  });
  it('alert names are unique across both files', () => {
    const names = rules.map((r) => r.rule.alert);
    expect(new Set(names).size).toBe(names.length);
  });
  it('no PHI-carrying or unbounded labels (patient, name, phone, user) in any expr/by-clause (02-CV §9.4 cardinality)', () => {
    for (const { rule } of rules.filter((r) => /lims_/.test(String(r.rule.expr)))) expect(String(rule.expr), rule.alert).not.toMatch(/by\s*\([^)]*(patient|name|phone|user|actor)/i);
  });
});

describe('TRD §15 rule table', () => {
  for (const [name, dir, tokens, severity, route] of REQUIRED) {
    it(`${name}: present with severity ${severity}`, () => {
      const hit = rules.find((r) => tokens.every((t) => r.text.includes(t)));
      expect(hit, `no rule contains ${tokens.join(' + ')}`).toBeDefined();
      expect(hit!.rule.labels.severity).toBe(severity);
      expect(route.some((t) => String(hit!.rule.labels.route).toLowerCase().includes(t)), `route ${hit!.rule.labels.route}`).toBe(true);
      expect(hit!.file, 'file location').toContain(`/${dir}/alerts/`);
    });
  }
});

describe('hand-off: one CR to C1 lists every rule', () => {
  // LD-95 / LD-75(a): the orchestra renames a non-blocking CR to BL-T22.nonblocking.md (or BL-T22.resolved-*.md) before verify,
  // so accept whichever of the three names exists.
  const crDir = join(REPO_ROOT, '.orchestra/cr');
  const crName = existsSync(crDir)
    ? readdirSync(crDir).find((f) => f === 'BL-T22.md' || f === 'BL-T22.nonblocking.md' || /^BL-T22\.resolved-.*\.md$/.test(f))
    : undefined;
  it('one CR (.orchestra/cr/BL-T22.md | .nonblocking.md | .resolved-*.md) exists, addresses C1, and names every alert and both rule file locations', () => {
    expect(crName, 'no .orchestra/cr/BL-T22.md, BL-T22.nonblocking.md or BL-T22.resolved-*.md').toBeDefined();
    const t = readFileSync(join(crDir, crName!), 'utf8');
    expect(t).toMatch(/\bC1\b/);
    for (const d of dirs) expect(t, d).toContain(d);
    for (const { rule } of rules) expect(t, rule.alert).toContain(rule.alert);
  });
});
