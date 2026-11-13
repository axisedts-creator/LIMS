// PG-T20 (C15) — DoD §3.7 / §3.8; 02-TRD §11 (metric list, "Alert rules for C1" table), §12 row "Observability (08 A22.4)"; 04-UI-UX §5 (runbooks RB-1..RB-9).
//   1. metric presence: every TRD §11 metric (10 listed + the 2 backing gauges of 08 A22.4) is registered in the core metrics registry (createMetrics) with the TRD type and label set.
//      The registry is closed (unknown name/label throws), so an unregistered payments metric would crash ctx.metrics.set / inc in production.
//   2. services/worker/src/jobs/payments/ops/payments.rules.yml holds exactly the 9 alerts of the TRD table (name, expr, for, severity); every metric in an expr is registered.
//   3. docs/manual/payments/** has a page for every operator screen (04-UI-UX §2) and the runbooks RB-1..RB-9 (§5), and names every alert.
// The sweep-sets-the-gauges half of the 08 A22.4 row is services/worker/src/jobs/payments/__tests__/integration/sweep_gauges.test.ts.
// Run: pnpm --dir services/api exec vitest run src/modules/payments/__tests__/unit/observability.test.ts
// Fails now: payments metrics are not registered; payments.rules.yml and docs/manual/payments/ do not exist.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createMetrics, REQUIRED_METRICS } from '../../../../core/observability/metrics.js';

const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const RULES = join(ROOT, 'services/worker/src/jobs/payments/ops/payments.rules.yml');
const MANUAL = join(ROOT, 'docs/manual/payments');

type Kind = 'counter' | 'gauge' | 'histogram';
// TRD §11, verbatim names / labels.
const METRICS: Record<string, [Kind, string[]]> = {
  lims_payments_intents_created_total: ['counter', ['gateway']],
  lims_payments_intents_transitions_total: ['counter', ['gateway', 'to_status']],
  lims_payments_intents_held_total: ['counter', ['gateway', 'reason']],
  lims_payments_gateway_requests_total: ['counter', ['gateway', 'operation', 'outcome']],
  lims_payments_gateway_request_duration_seconds: ['histogram', ['gateway', 'operation']],
  lims_payments_callbacks_total: ['counter', ['gateway', 'kind', 'outcome']],
  lims_payments_open_intents_past_deadline: ['gauge', ['gateway']],
  lims_payments_reconciliation_findings_total: ['counter', ['kind', 'severity']],
  lims_payments_reconciliation_last_success_timestamp_seconds: ['gauge', ['tenant_id']],
  lims_payments_refunds_total: ['counter', ['gateway', 'mode', 'status']],
  lims_payments_held_for_review_oldest_age_seconds: ['gauge', ['tenant_id', 'kind']],   // 08 A22.4
  lims_payments_reconciliation_stalled_runs: ['gauge', ['tenant_id']],                    // 08 A22.4
};
const record = (m: any, kind: Kind, name: string, labels: Record<string, string>) => (kind === 'counter' ? m.inc(name, labels) : kind === 'gauge' ? m.set(name, 1, labels) : m.observe(name, 1, labels));

describe('TRD §11 metric presence', () => {
  it('REQUIRED_METRICS contains all 12 payments metrics and no other lims_payments_* name', () => {
    const have = REQUIRED_METRICS.filter((n) => n.startsWith('lims_payments_')).sort();
    expect(have).toEqual(Object.keys(METRICS).sort());
  });

  for (const [name, [kind, labels]] of Object.entries(METRICS)) {
    it(`${name}: ${kind} with exactly the labels ${labels.join(',')}`, async () => {
      const m = createMetrics();
      const lv = Object.fromEntries(labels.map((l) => [l, `v_${l}`]));
      record(m, kind, name, lv);
      const text = await m.render();
      expect(text).toContain(`# TYPE ${name} ${kind}`);
      const sample = text.split('\n').find((l) => l.startsWith(`${name}${kind === 'histogram' ? '_bucket' : ''}{`));
      expect(sample, `no sample line for ${name}`).toBeDefined();
      const got = [...sample!.matchAll(/(\w+)="/g)].map((x) => x[1]!).filter((l) => l !== 'le').sort();
      expect(got).toEqual([...labels].sort());
      // closed label set: an undeclared label (e.g. an intent id) is refused
      expect(() => record(m, kind, name, { ...lv, intent_id: 'x' })).toThrow();
    });
  }

  it('the two 08 A22.4 gauges accept the sweep\'s kind values and a 0 reading', async () => {
    const m = createMetrics();
    for (const kind of ['intent', 'refund']) m.set('lims_payments_held_for_review_oldest_age_seconds' as any, 0, { tenant_id: 't', kind });
    m.set('lims_payments_reconciliation_stalled_runs' as any, 0, { tenant_id: 't' });
    const text = await m.render();
    expect(text).toMatch(/lims_payments_held_for_review_oldest_age_seconds\{[^}]*kind="refund"[^}]*\} 0/);
    expect(text).toMatch(/lims_payments_reconciliation_stalled_runs\{tenant_id="t"\} 0/);
  });
});

// TRD §11 "Alert rules for C1" (the markdown backslash-pipe is the regex alternation). `for` 0m = absent or zero.
const A = (name: string, expr: string, forD: string, severity: 'page' | 'warn') => ({ name, expr, forD, severity });
const ALERTS = [
  A('PaymentsAmountMismatch', 'sum(increase(lims_payments_intents_held_total{reason="amount_mismatch"}[15m])) > 0 or sum(increase(lims_payments_reconciliation_findings_total{kind="amount_mismatch"}[15m])) > 0', '0m', 'page'),
  A('PaymentsCriticalFinding', 'sum by (kind) (increase(lims_payments_reconciliation_findings_total{kind=~"ledger_entry_missing|late_payment_found|gateway_refund_unrecorded|status_divergence"}[15m])) > 0 or sum(increase(lims_payments_intents_held_total{reason="late_payment_found"}[15m])) > 0', '0m', 'page'),
  A('PaymentsReconciliationMissing', 'time() - max by (tenant_id) (lims_payments_reconciliation_last_success_timestamp_seconds) > 93600', '0m', 'page'),
  A('PaymentsReconciliationStalled', 'max by (tenant_id) (lims_payments_reconciliation_stalled_runs) > 0', '0m', 'warn'),
  A('PaymentsHeldForReviewStale', 'max by (tenant_id, kind) (lims_payments_held_for_review_oldest_age_seconds) > 86400', '0m', 'warn'),
  A('PaymentsCallbackSignatureInvalid', 'sum by (gateway) (increase(lims_payments_callbacks_total{outcome="payments.signature_invalid"}[15m])) > 0', '0m', 'warn'),
  A('PaymentsGatewayErrorRatio', 'sum by (gateway) (rate(lims_payments_gateway_requests_total{outcome=~"service_unavailable|timeout|network_error|http_error|invalid_response|auth_error"}[10m])) / sum by (gateway) (rate(lims_payments_gateway_requests_total[10m])) > 0.2', '10m', 'warn'),
  A('PaymentsCredentialRejected', 'sum by (gateway) (increase(lims_payments_gateway_requests_total{outcome="auth_error"}[15m])) > 0', '0m', 'warn'),
  A('PaymentsOpenIntentsPastDeadline', 'max by (gateway) (lims_payments_open_intents_past_deadline) > 0', '30m', 'warn'),
];
const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();
const ZERO = ['0m', '0s', '0'];
const loadRules = () => {
  const doc: any = parse(readFileSync(RULES, 'utf8'));
  const rules = (doc.groups as any[]).flatMap((g) => g.rules as any[]);
  return { doc, rules };
};

describe('payments.rules.yml = TRD §11 "Alert rules for C1" (CR-C15-008 item 6; promtool is C1\'s check once wired)', () => {
  it('exists and is a Prometheus rule file (groups[].name + rules[])', () => {
    expect(existsSync(RULES)).toBe(true);
    const { doc } = loadRules();
    expect(Array.isArray(doc.groups) && doc.groups.length > 0).toBe(true);
    for (const g of doc.groups) { expect(typeof g.name).toBe('string'); expect(Array.isArray(g.rules)).toBe(true); }
  });

  it('contains exactly the 9 alerts of the table: no extra, none missing, no duplicates, no recording rules', () => {
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

  it('every lims_payments_* name used in an expr is a registered metric (an alert cannot reference a gauge nobody sets)', () => {
    const used = new Set<string>(loadRules().rules.flatMap((r: any) => String(r.expr).match(/lims_payments_[a-z_]+/g) ?? []));
    expect(used.size).toBeGreaterThan(0);
    for (const n of used) expect(Object.keys(METRICS), n).toContain(n);
  });

  it('page alerts are exactly the three that page; no secrets or credentialed URLs in the file', () => {
    const { rules } = loadRules();
    expect(rules.filter((r: any) => r.labels?.severity === 'page').map((r: any) => r.alert).sort()).toEqual(['PaymentsAmountMismatch', 'PaymentsCriticalFinding', 'PaymentsReconciliationMissing']);
    expect(readFileSync(RULES, 'utf8')).not.toMatch(/secret|password|token=|apikey|api_key|https?:\/\/[^\s/]*:[^\s/]*@/i);
  });
});

// 04-UI-UX §2 screens + §5 runbooks.
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)])) : []);
const pages = () => files(MANUAL).filter((f) => /\.mdx?$/i.test(f));
const all = () => pages().map((f) => readFileSync(f, 'utf8')).join('\n');
const heading = (text: string, rb: string) => new RegExp(`^#{1,6}\\s+.*\\b${rb}\\b`, 'm').test(text);

describe('docs/manual/payments (DoD §3.8: user-manual pages for every screen; runbooks RB-1..RB-9)', () => {
  it('the manual directory exists with at least one markdown page', () => { expect(pages().length).toBeGreaterThan(0); });

  it('every operator screen of 04-UI-UX §2 is documented (route named in a page)', () => {
    const text = all();
    for (const route of ['/payments/review', '/payments/intents/', '/payments/refunds', '/payments/reconciliation', '/payments/static-qr', '/payments/settings']) expect(text, route).toContain(route);
  });

  it('runbooks RB-1 to RB-9 each have their own heading', () => {
    const text = all();
    for (let i = 1; i <= 9; i++) expect(heading(text, `RB-${i}`), `RB-${i} heading missing`).toBe(true);
  });

  it('runbook content carries the spec\'s key steps (04-UI-UX §5)', () => {
    const t = all();
    expect(t).toMatch(/RB-1[\s\S]*?UAT/);                                     // RB-1 enable: UAT payment before production
    expect(t).toMatch(/gateway_txn_ref/);                                     // RB-2 held payment
    expect(t).toMatch(/RB-3[\s\S]*?do not settle/i);                          // RB-3 amount mismatch
    expect(t).toMatch(/gateway_unreachable/);                                 // RB-4 reconciliation
    expect(t).toMatch(/RB-5[\s\S]*?approve/i);                                // RB-5 two-person refund
    expect(t).toMatch(/REQ-SEC-058/);                                         // RB-6 rotation
    expect(t).toMatch(/CR-C15-008/);                                          // RB-7 KEK rotation
    expect(t).toMatch(/RB-8[\s\S]*?worksheet/i);                              // RB-8 static-QR
    expect(t).toMatch(/RB-9[\s\S]*?UNVERIFIED/);                              // RB-9 go-live
  });

  it('every alert of payments.rules.yml is named in the manual (operators can look an alert up)', () => {
    const t = all();
    for (const a of ALERTS) expect(t, a.name).toContain(a.name);
  });

  it('manual contains no key material (synthetic only)', () => {
    expect(all()).not.toMatch(/-----BEGIN|[A-Za-z0-9+/]{40,}={0,2}\s*$/m);
  });
});
