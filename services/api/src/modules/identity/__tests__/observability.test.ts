// C2-T28 observability (02-TRD §13 metrics + backing gauges + "Alert rules for C1"; 08 A13 P-14; CR-C2-019; DoD §3.7).
//   1. metric registry: all 14 listed lims_identity_* metrics + the 4 backing gauges are registered in the core registry with the TRD type + label set
//      (the registry is closed: an unregistered name throws at ctx.metrics.inc/set, so a service emitting it would crash in production).
//   2. "metrics in service files": every one of those names is emitted by a non-test file under modules/identity or worker jobs/identity.
//   3. services/worker/src/jobs/identity/ops/identity.rules.yml holds exactly the 10 alerts of the TRD table (name, expr, for, severity); every lims_ metric in an expr is registered.
// ASSUMED (spec silent): Prometheus rule-file format (groups[].rules[] with alert/expr/for/labels.severity), as payments.rules.yml; `route` is C1's, not asserted. Exprs compared after collapsing whitespace.
// Run: pnpm --dir services/api exec vitest run src/modules/identity/__tests__/observability.test.ts
// Fails now: no lims_identity_* metric is registered; identity.rules.yml does not exist.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createMetrics, REQUIRED_METRICS } from '../../../core/observability/metrics.js';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const RULES = join(ROOT, 'services/worker/src/jobs/identity/ops/identity.rules.yml');

type Kind = 'counter' | 'gauge' | 'histogram';
// 02-TRD §13 table + "Backing gauges" paragraph, verbatim names / labels. `_total`/`_duration_seconds` of gotrue = two metrics, labels op+outcome.
const METRICS: Record<string, [Kind, string[]]> = {
  lims_identity_logins_total: ['counter', ['outcome', 'kind']],
  lims_identity_login_ip_throttles_active: ['gauge', []],
  lims_identity_mfa_verifications_total: ['counter', ['outcome', 'flow']],
  lims_identity_session_resolves_total: ['counter', ['outcome']],
  lims_identity_claims_resolve_duration_seconds: ['histogram', []],
  lims_identity_authz_decisions_total: ['counter', ['outcome', 'privileged']],
  lims_identity_active_sessions: ['gauge', ['kind']],
  lims_identity_gotrue_requests_total: ['counter', ['op', 'outcome']],
  lims_identity_gotrue_request_duration_seconds: ['histogram', ['op', 'outcome']],
  lims_identity_audit_exports_total: ['counter', ['tenant_id', 'source']],
  lims_identity_support_sessions_active: ['gauge', []],
  lims_identity_support_sessions_opened_total: ['counter', ['scope']],
  lims_identity_breached_list_loaded: ['gauge', []],
  lims_identity_settings_cache_total: ['counter', ['result']],
  // backing gauges for the alert rules
  lims_identity_login_failures_by_tenant_5m: ['gauge', ['tenant_id']],
  lims_identity_stuffing_distinct_accounts_15m: ['gauge', []],
  lims_identity_stuffing_distinct_ips_15m: ['gauge', []],
  lims_identity_audit_exports_tenant_day: ['gauge', ['tenant_id']],
};
const record = (m: any, kind: Kind, name: string, labels: Record<string, string>) => (kind === 'counter' ? m.inc(name, labels) : kind === 'gauge' ? m.set(name, 1, labels) : m.observe(name, 1, labels));

describe('TRD §13 metric presence', () => {
  it('REQUIRED_METRICS contains the 18 identity metrics and no other lims_identity_* name', () => {
    expect(REQUIRED_METRICS.filter((n) => n.startsWith('lims_identity_')).sort()).toEqual(Object.keys(METRICS).sort());
  });

  for (const [name, [kind, labels]] of Object.entries(METRICS)) {
    it(`${name}: ${kind}, labels [${labels.join(',')}]`, async () => {
      const m = createMetrics();
      const lv = Object.fromEntries(labels.map((l) => [l, `v_${l}`]));
      record(m, kind, name, lv);
      const text = await m.render();
      expect(text).toContain(`# TYPE ${name} ${kind}`);
      const sample = text.split('\n').find((l) => l.startsWith(`${name}${kind === 'histogram' ? '_bucket' : ''}`) && !l.startsWith('#'));
      expect(sample, `no sample line for ${name}`).toBeDefined();
      const got = [...sample!.matchAll(/(\w+)="/g)].map((x) => x[1]!).filter((l) => l !== 'le').sort();
      expect(got).toEqual([...labels].sort());
      // closed label set: an id / PHI label (user_id, email, ip) is refused
      expect(() => record(m, kind, name, { ...lv, user_id: 'x' })).toThrow();
    });
  }
});

// "metrics in service files": a metric nobody emits is a dead alert input.
const NON_TEST = (p: string) => !/(__tests__|\.test\.|\.spec\.|\.helpers\.|\.fake\.|\.d\.ts$)/.test(p);
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)])) : []);
const sources = () => [...walk(join(ROOT, 'services/api/src/modules/identity')), ...walk(join(ROOT, 'services/worker/src/jobs/identity'))].filter((p) => /\.(ts|mjs)$/.test(p) && NON_TEST(p.replace(/\\/g, '/')));

describe('metrics are emitted by service code (DoD §3.7)', () => {
  it.each(Object.keys(METRICS))('%s is named in a non-test identity source file', (name) => {
    const hit = sources().filter((f) => readFileSync(f, 'utf8').includes(name));
    expect(hit.length, `${name} not emitted anywhere under modules/identity or worker jobs/identity`).toBeGreaterThan(0);
  });

  it('no emission site puts an id / e-mail / IP in a label (labels are the TRD sets only)', () => {
    const bad: string[] = [];
    for (const f of sources()) {
      const t = readFileSync(f, 'utf8');
      for (const m of t.matchAll(/metrics\??\.(?:inc|set|observe)\??\.?\(\s*'(lims_identity_[a-z_0-9]+)'([\s\S]*?)\)\s*;/g)) {
        const labels = (m[2]!.match(/\b(user_id|membership_id|session_id|email|ip|client_ip|actor_id|request_id)\b/g) ?? []);
        if (labels.length) bad.push(`${f}: ${m[1]} ${labels.join(',')}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

// TRD §13 "Alert rules for C1" (expr / for / severity verbatim; the `\\.` in the dead-letter regex is the PromQL string escape).
const A = (name: string, expr: string, forD: string, severity: 'page' | 'warn' | 'info') => ({ name, expr, forD, severity });
const ALERTS = [
  A('IdentityLoginFailureSpike', 'sum(increase(lims_identity_logins_total{outcome="failed"}[5m])) > 50 or max by (tenant_id) (lims_identity_login_failures_by_tenant_5m) > 20', '0m', 'warn'),
  A('IdentityCredentialStuffing', 'lims_identity_stuffing_distinct_accounts_15m >= 30 and lims_identity_stuffing_distinct_ips_15m >= 10', '0m', 'page'),
  A('IdentityLoginIpThrottleEngaged', 'increase(lims_identity_logins_total{outcome="ip_throttled"}[5m]) > 0 or lims_identity_login_ip_throttles_active > 0', '0m', 'page'),
  A('IdentityPlatformIpDenied', 'increase(lims_identity_logins_total{outcome="ip_denied"}[5m]) > 0', '0m', 'page'),
  A('IdentitySupportSessionOpened', 'increase(lims_identity_support_sessions_opened_total[5m]) > 0', '0m', 'info'),
  A('IdentityAuditExportsHigh', 'max by (tenant_id) (lims_identity_audit_exports_tenant_day) > 3', '0m', 'warn'),
  A('IdentityGoTrueUnavailable', 'sum(rate(lims_identity_gotrue_requests_total{outcome="error"}[5m])) / sum(rate(lims_identity_gotrue_requests_total[5m])) > 0.2', '5m', 'page'),
  A('IdentityRefreshFailures', 'increase(lims_identity_session_resolves_total{outcome="refresh_failed"}[10m]) > 10', '0m', 'warn'),
  A('IdentityBreachedListMissing', 'lims_identity_breached_list_loaded{env="production"} == 0', '10m', 'page'),
  A('IdentityDeadLetter', 'increase(lims_core_dead_letters_total{task=~"identity\\\\..*"}[5m]) > 0', '0m', 'page'),
];
const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();
const ZERO = ['0m', '0s', '0'];
const loadRules = () => {
  const doc: any = parse(readFileSync(RULES, 'utf8'));
  return { doc, rules: (doc.groups as any[]).flatMap((g) => g.rules as any[]) };
};

describe('identity.rules.yml = TRD §13 "Alert rules for C1" (CR-C2-019; promtool is C1\'s check once wired)', () => {
  it('exists and is a Prometheus rule file (groups[].name + rules[])', () => {
    expect(existsSync(RULES), RULES).toBe(true);
    const { doc } = loadRules();
    expect(Array.isArray(doc.groups) && doc.groups.length > 0).toBe(true);
    for (const g of doc.groups) { expect(typeof g.name).toBe('string'); expect(Array.isArray(g.rules)).toBe(true); }
  });

  it('contains exactly the 10 alerts of the table: none missing, none extra, no duplicates, no recording rules', () => {
    const { rules } = loadRules();
    expect(rules.every((r: any) => typeof r.alert === 'string' && !('record' in r))).toBe(true);
    expect(rules.map((r: any) => r.alert).sort()).toEqual(ALERTS.map((a) => a.name).sort());
  });

  for (const a of ALERTS) {
    it(`${a.name}: expr, for ${a.forD}, severity ${a.severity} match the table`, () => {
      const r = loadRules().rules.find((x: any) => x.alert === a.name);
      expect(r, `${a.name} missing`).toBeDefined();
      expect(norm(r.expr)).toBe(norm(a.expr));
      const forV = r.for === undefined ? '0m' : String(r.for);
      if (ZERO.includes(a.forD)) expect(ZERO).toContain(forV); else expect(forV).toBe(a.forD);
      expect(r.labels?.severity).toBe(a.severity);
    });
  }

  it('every lims_identity_* name in an expr is a registered metric (an alert cannot read a gauge nobody sets); lims_core_dead_letters_total is core\'s', () => {
    const used = new Set<string>(loadRules().rules.flatMap((r: any) => String(r.expr).match(/lims_[a-z_0-9]+/g) ?? []));
    expect(used.size).toBeGreaterThan(5);
    for (const n of used) expect(n.startsWith('lims_identity_') ? Object.keys(METRICS) : (REQUIRED_METRICS as readonly string[]), n).toContain(n);
  });

  it('no PHI / secret / credentialed URL / address in the file; no per-user group-by', () => {
    const t = readFileSync(RULES, 'utf8');
    expect(t).not.toMatch(/@|\+977|\b9\d{9}\b|secret|password|token=|apikey|api_key|https?:\/\/[^\s/]*:[^\s/]*@/i);
    const labels = [...t.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim()));
    for (const l of labels) expect(['tenant_id']).toContain(l);
  });
});
