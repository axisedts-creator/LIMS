// C16.T-OPS1 — alert rule file services/worker/src/jobs/engagement/alerts/engagement.rules.yml (02-TRD §13 "Alerts (rules shipped to C1, REQ-SEC-133)"; 08 A13 P-14: C1 wires it by CR).
// done_when: "alert rules delivered to C1"; tests: "alert rule lint (C1 format)".
// SEAMS: Prometheus rule-file format (groups -> rules with alert/expr/for), as the other C1-bound files (payments/lab/smartreport). Unlike C5/C14 the C16 TRD table gives CONDITIONS, not
//  PromQL, so expr is checked structurally (metric + outcome labels + threshold), not verbatim. The 8th TRD row ("Dead letters of engagement.*", no alert name) is pinned by its expr:
//  one rule over lims_core_dead_letters_total restricted to task=~"engagement\..*". `for` is 15m unless the condition states otherwise [CONV]: only EngagementDisplayStale (10m) is pinned.
//  `EngagementLinkIssueVolume` is an access-log query job (not a Prometheus metric): only its presence, severity and a parseable expr are checked.
//  severity: TRD says high|medium|low; C1 receivers use page|warn (payments rules), C1 adds team + runbook_url on import -> label checked only when present, and either spelling is accepted
//  (high=page, medium=warn, low=warn|info).
// promtool is optional (PROMTOOL or `promtool` on PATH), as in lab/observability.test.ts; the structural tests always run.
// Fails now: the file does not exist.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(import.meta.dirname, '..');                                   // services/worker/src/jobs/engagement
const FILE = join(DIR, 'alerts', 'engagement.rules.yml');
const TRD = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'spec', 'chunks', 'C16-patient-engagement', '02-TRD.md');
const { parse } = createRequire(join(DIR, '../../../../api/package.json'))('yaml') as { parse(s: string): any };
const rules = (): any[] => (existsSync(FILE) ? parse(readFileSync(FILE, 'utf8')).groups.flatMap((g: any) => g.rules) : []);
const loop = (): any[] => { const r = rules(); expect(r.length, 'rule file exists and has rules (a loop over nothing would pass vacuously)').toBeGreaterThan(0); return r; };
const byName = (n: string) => rules().find((r) => r.alert === n);
const expr = (n: string): string => String(byName(n)?.expr ?? '').replace(/\s+/g, ' ');

const NAMED: [string, 'high' | 'medium' | 'low'][] = [
  ['EngagementOtpVerifyFailureSpike', 'high'], ['EngagementOtpDailyCapReached', 'high'], ['EngagementLinkRedeemFailures', 'high'], ['EngagementLinkIssueVolume', 'medium'],
  ['EngagementProjectionLag', 'medium'], ['EngagementDisplayStale', 'low'], ['EngagementPaymentFailures', 'medium'],
];
const OK_SEV: Record<string, string[]> = { high: ['high', 'page'], medium: ['medium', 'warn'], low: ['low', 'warn', 'info'] };
const DEAD = (r: any) => /lims_core_dead_letters_total/.test(String(r.expr));

describe('TRD §13 alert table (guards this file against TRD drift)', () => {
  it('lists the seven named alerts + the dead-letter row, with the pinned severities', () => {
    const text = readFileSync(TRD, 'utf8');
    const a = text.indexOf('Alerts (rules shipped to C1'), b = text.indexOf('## 14. Test strategy', a);
    expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a);
    const rows = [...text.slice(a, b).matchAll(/^\|\s*(`Engagement\w+`|Dead letters of `engagement\.\*`)\s*\|[^|]*\|\s*(high|medium|low)\b/gm)];
    expect(rows).toHaveLength(8);
    for (const [n, sev] of NAMED) expect(rows.find((r) => r[1] === `\`${n}\``)?.[2], n).toBe(sev);
    expect(rows.find((r) => r[1]!.startsWith('Dead'))?.[2]).toBe('medium');
  });
});

describe('engagement.rules.yml (C1 format)', () => {
  it('exists at services/worker/src/jobs/engagement/alerts/engagement.rules.yml and is a Prometheus rule file: groups -> rules with alert + expr', () => {
    expect(existsSync(FILE), FILE).toBe(true);
    expect(rules().length).toBeGreaterThan(0);
    for (const r of rules()) { expect(typeof r.alert, 'alert').toBe('string'); expect(typeof r.expr, `${r.alert} expr`).toBe('string'); expect(r.expr.trim(), `${r.alert} expr`).not.toBe(''); }
  });

  it('holds exactly the seven named TRD alerts + one dead-letter rule: no more, no fewer, no duplicates', () => {
    const names = rules().filter((r) => !DEAD(r)).map((r) => r.alert).sort();
    expect(names).toEqual(NAMED.map(([n]) => n).sort());
    expect(rules().filter(DEAD)).toHaveLength(1);
    expect(new Set(rules().map((r) => r.alert)).size).toBe(rules().length);
  });

  it('every alert name carries the Engagement prefix (C1 namespaces rules by module)', () => {
    for (const r of loop()) expect(r.alert, r.alert).toMatch(/^Engagement[A-Z]\w+$/);
  });

  it('severity, when present, matches the TRD severity (high|page, medium|warn, low)', () => {
    for (const [n, sev] of NAMED) { const s = byName(n)?.labels?.severity; expect(byName(n), n).toBeDefined(); if (s !== undefined) expect(OK_SEV[sev], n).toContain(s); }
    const d = rules().find(DEAD); if (d?.labels?.severity !== undefined) expect(OK_SEV['medium']).toContain(d.labels.severity);
  });

  it('`for` is a valid Prometheus duration on every rule; EngagementDisplayStale uses 10m (TRD: "for 10 min"), the others default to 15m unless they state a window', () => {
    for (const r of rules()) if (r.for !== undefined) expect(String(r.for), r.alert).toMatch(/^\d+(ms|s|m|h)$/);
    expect(String(byName('EngagementDisplayStale')?.for)).toBe('10m');
    expect(String(byName('EngagementProjectionLag')?.for)).toBe('15m');
  });

  it('every rule has a summary annotation (C1 routes to the tenant-ops channel and shows it)', () => {
    for (const r of loop()) expect(typeof r.annotations?.summary, r.alert).toBe('string');
  });

  it('every lims_ metric used is a TRD §13 lims_engagement_* metric or the C0 dead-letter counter', () => {
    for (const r of loop()) {
      for (const m of String(r.expr).match(/\blims_[a-z0-9_]+/g) ?? []) {
        expect(m.replace(/_(bucket|sum|count)$/, ''), `${r.alert} ${m}`).toMatch(/^(lims_engagement_(otp_requests_total|otp_verifications_total|link_events_total|projection_lag_seconds|projection_drift_total|bookings_total|slot_conflicts_total|queue_tokens_total|queue_wait_seconds|displays_stale|payment_requests_total|reminders_total|report_downloads_total)|lims_core_dead_letters_total)$/);
      }
    }
  });

  it('no rule filters or groups by a person-level label (phone, account, patient, code, token, name)', () => {
    for (const r of loop()) expect(String(r.expr), r.alert).not.toMatch(/\b(phone|account|patient|code|token|name|user|actor)(_id|_e164|_hmac)?\b\s*(=|!=|=~|,|\))/i);
  });

  it('EngagementOtpVerifyFailureSpike: (invalid+exhausted) / all verifications > 0.5 with a >= 50 attempts guard over 15m', () => {
    const e = expr('EngagementOtpVerifyFailureSpike');
    expect(e).toContain('lims_engagement_otp_verifications_total');
    expect(e).toMatch(/invalid/); expect(e).toMatch(/exhausted/);
    expect(e).toMatch(/\[15m\]/); expect(e).toMatch(/0\.5\b/); expect(e).toMatch(/>=?\s*50\b/);
  });

  it('EngagementOtpDailyCapReached: any cap_reached outcome of lims_engagement_otp_requests_total', () => {
    const e = expr('EngagementOtpDailyCapReached');
    expect(e).toContain('lims_engagement_otp_requests_total'); expect(e).toMatch(/outcome\s*=\s*"cap_reached"/); expect(e).toMatch(/>\s*0\b/);
  });

  it('EngagementLinkRedeemFailures: > 20 invalid redemptions in 1h from lims_engagement_link_events_total', () => {
    const e = expr('EngagementLinkRedeemFailures');
    expect(e).toContain('lims_engagement_link_events_total'); expect(e).toMatch(/outcome\s*=\s*"invalid"/); expect(e).toMatch(/\[1h\]/); expect(e).toMatch(/>\s*20\b/);
  });

  it('EngagementProjectionLag: p95 of lims_engagement_projection_lag_seconds > 300 s (5 min)', () => {
    const e = expr('EngagementProjectionLag');
    expect(e).toContain('lims_engagement_projection_lag_seconds_bucket'); expect(e).toMatch(/histogram_quantile\(\s*0\.95/); expect(e).toMatch(/>\s*300\b/);
  });

  it('EngagementDisplayStale: lims_engagement_displays_stale > 0', () => {
    const e = expr('EngagementDisplayStale');
    expect(e).toContain('lims_engagement_displays_stale'); expect(e).toMatch(/>\s*0\b/);
  });

  it('EngagementPaymentFailures: failed share of lims_engagement_payment_requests_total > 0.2 over 1h with >= 10 requests', () => {
    const e = expr('EngagementPaymentFailures');
    expect(e).toContain('lims_engagement_payment_requests_total'); expect(e).toMatch(/failed/); expect(e).toMatch(/\[1h\]/); expect(e).toMatch(/0\.2\b/); expect(e).toMatch(/>=?\s*10\b/);
  });

  it('EngagementLinkIssueVolume is present with a non-empty expr (access-log query job, TRD: one membership > 50 codes per business day)', () => {
    expect(byName('EngagementLinkIssueVolume')).toBeDefined();
    expect(expr('EngagementLinkIssueVolume')).toMatch(/\b50\b/);
  });

  it('dead-letter rule: any lims_core_dead_letters_total increase for tasks matching engagement.* (02-CV §7.5), and only for them', () => {
    const e = String(rules().find(DEAD)?.expr ?? '');
    expect(e).toMatch(/task\s*=~\s*"engagement\\{1,2}\.[^"]*"/); expect(e).toMatch(/increase\(|>\s*0\b/); expect(e).toMatch(/>\s*0\b/);
  });

  const promtool = process.env['PROMTOOL'] ?? 'promtool';
  const have = spawnSync(promtool, ['--version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!have)('promtool check rules passes (08 A13 P-14)', () => {
    const r = spawnSync(promtool, ['check', 'rules', FILE], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toMatch(/SUCCESS: 8 rules found/);
    expect(r.status).toBe(0);
  });
});
