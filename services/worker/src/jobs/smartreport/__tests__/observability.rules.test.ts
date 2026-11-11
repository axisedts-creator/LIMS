// C14-T17 — alert rule file services/worker/src/jobs/smartreport/ops/smartreport.rules.yml (02-TRD §12 "Alert rules for C1", CR-C14-010, 08 A13 P-14).
// done_when: "rule file lists the six rules". expr + for are compared verbatim (whitespace-folded) with the TRD table, which this test parses (no second copy to drift).
// SEAMS: Prometheus rule-file format (groups -> rules with alert/expr/for). C1 adds team + runbook_url on import, so severity/route labels are checked only when present.
// promtool is optional (as in lab/observability.test.ts): `promtool check rules` runs when PROMTOOL or `promtool` resolves, else that one test is skipped.
// Fails now: the file does not exist.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(import.meta.dirname, '..');                                    // services/worker/src/jobs/smartreport
const FILE = join(DIR, 'ops', 'smartreport.rules.yml');
const TRD = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'spec', 'chunks', 'C14-smart-report', '02-TRD.md');
const { parse } = createRequire(join(DIR, '../../../../api/package.json'))('yaml') as { parse(s: string): any };
const norm = (s: string) => String(s).replace(/\s+/g, ' ').trim();
const forOf = (r: any) => (r.for === undefined || /^0[smh]?$/.test(String(r.for)) ? '0m' : String(r.for));   // `for: 0m` may be written 0s or omitted
const rules = (): any[] => (existsSync(FILE) ? parse(readFileSync(FILE, 'utf8')).groups.flatMap((g: any) => g.rules) : []);

/** TRD §12 "Alert rules for C1" table rows: alert, expr (first backtick span), for, severity, route. */
function trdAlerts(): { alert: string; expr: string; for: string; severity: string; route: string }[] {
  const text = readFileSync(TRD, 'utf8');
  const a = text.indexOf('#### Alert rules for C1'), b = text.indexOf('CI jobs for C0-0A', a);
  expect(a, 'TRD alert heading').toBeGreaterThan(-1); expect(b, 'TRD CI line').toBeGreaterThan(a);
  const out = [];
  for (const line of text.slice(a, b).split('\n')) {
    const m = /^\|\s*`(Smart\w+)`\s*\|\s*`([^`]+)`\s*\|\s*(\d+m)\s*\|\s*(page|warn)\s*\|\s*`([^`]+)`/.exec(line);
    if (m) out.push({ alert: m[1]!, expr: m[2]!, for: m[3]!, severity: m[4]!, route: m[5]! });
  }
  return out;
}
const SIX = ['SmartBuildErrors', 'SmartDraftsStale', 'SmartLlmCallWhileDisabled', 'SmartLlmEndpointNotAllowed', 'SmartLlmFailing', 'SmartConsumerLag'];

describe('smartreport.rules.yml (CR-C14-010, 02-TRD §12)', () => {
  it('the TRD table parse finds the six rules (guards the comparisons against an empty parse)', () => {
    expect(trdAlerts().map((r) => r.alert)).toEqual(SIX);
  });

  it('the file exists at services/worker/src/jobs/smartreport/ops/smartreport.rules.yml and is a Prometheus rule file (groups -> rules with alert + expr)', () => {
    expect(existsSync(FILE), FILE).toBe(true);
    for (const r of rules()) { expect(typeof r.alert, 'alert').toBe('string'); expect(typeof r.expr, `${r.alert} expr`).toBe('string'); }
  });

  it('lists exactly the six rules of 02-TRD §12: no more, no fewer, no duplicates', () => {
    expect(rules().map((r) => r.alert).sort()).toEqual([...SIX].sort());
  });

  it('expr and for are verbatim from the TRD (whitespace-folded); severity and route, when present, match', () => {
    const got = new Map(rules().map((r) => [r.alert, r]));
    for (const want of trdAlerts()) {
      const r = got.get(want.alert);
      expect(r, want.alert).toBeDefined();
      expect(norm(r.expr), `${want.alert} expr`).toBe(norm(want.expr));
      expect(forOf(r), `${want.alert} for`).toBe(forOf({ for: want.for }));
      if (r.labels?.severity !== undefined) expect(r.labels.severity, `${want.alert} severity`).toBe(want.severity);
      if (r.labels?.route !== undefined) expect(r.labels.route, `${want.alert} route`).toBe(want.route);
    }
  });

  it('the two page rules fire immediately (for 0m) and the LLM-while-disabled rule reads the must-stay-0 counter', () => {
    const by = new Map(rules().map((r) => [r.alert, r]));
    for (const n of ['SmartLlmCallWhileDisabled', 'SmartLlmEndpointNotAllowed']) expect(forOf(by.get(n)), n).toBe('0m');
    expect(norm(by.get('SmartLlmCallWhileDisabled')?.expr ?? '')).toContain('lims_smartreport_llm_calls_while_disabled_total');
  });

  it('every metric a rule reads is a TRD §12 smartreport metric (or the C0 queue-depth gauge); group-by is tenant_id only; no PHI-class label; no address or phone number in the file', () => {
    const allowed = /^(lims_smartreport_(builds_total|drafts_oldest_age_seconds|llm_calls_while_disabled_total|llm_endpoint_refused_total|llm_circuit_open)|lims_queue_depth)$/;
    const text = rules().map((r) => String(r.expr)).join('\n');
    const metrics = [...text.matchAll(/\b(lims_[a-z_]+)\b/g)].map((m) => m[1]!);
    expect(metrics.length).toBeGreaterThan(5);
    for (const m of metrics) expect(m, m).toMatch(allowed);
    for (const g of [...text.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim()))) expect(g).toBe('tenant_id');
    expect(text).not.toMatch(/\b(order|patient|summary|registration|barcode|user|actor)_?(id|no|name)?\b\s*(=|!=|=~)/i);
    expect(existsSync(FILE) ? readFileSync(FILE, 'utf8') : '').not.toMatch(/@|\+977|\b9\d{9}\b/);
  });

  const promtool = process.env['PROMTOOL'] ?? 'promtool';
  const have = spawnSync(promtool, ['--version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!have)('promtool check rules passes (08 A13 P-14)', () => {
    const r = spawnSync(promtool, ['check', 'rules', FILE], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toMatch(/SUCCESS: 6 rules found/);
    expect(r.status).toBe(0);
  });
});
