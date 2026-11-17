// API-T14 — alert-rule file for C1 (02-TRD §13 "Alert rules for C1"; REQ-SEC-045/133). File: ../alerts/instruments.rules.yml (Prometheus rule-file format).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, '..', 'alerts', 'instruments.rules.yml');
// yaml is a services/api dependency (not hoisted); load it the way the repo loads other api-owned libs.
const { parse } = createRequire(join(here, '../../../../../api/package.json'))('yaml') as { parse(s: string): any };

const WANT: Record<string, { expr: RegExp; for: string; severity: string; route?: string }> = {
  InstrumentsAgentUpdateFailed: { expr: /increase\(lims_instruments_agent_update_failures_total\[15m\]\)\s*>\s*0/, for: '0m', severity: 'page', route: 'oncall-email' },
  InstrumentsAgentConfigRejected: { expr: /increase\(lims_instruments_agent_config_rejections_total\[15m\]\)\s*>\s*0/, for: '0m', severity: 'page', route: 'oncall-email' },
  InstrumentsDeviceAuthFailureSpike: { expr: /sum\(rate\(lims_instruments_device_auth_failures_total\[5m\]\)\)\s*>\s*0\.1/, for: '5m', severity: 'page', route: 'oncall-email' },
  InstrumentsQuarantineRate: { expr: /rate\(lims_instruments_ingest_messages_total\{outcome="quarantined"\}\[1h\]\)\)\s*\/\s*sum\(rate\(lims_instruments_ingest_messages_total\[1h\]\)\)\s*>\s*0\.05/, for: '1h', severity: 'warn', route: 'ops-digest-email' },
  InstrumentsAttachmentQuarantined: { expr: /increase\(lims_instruments_attachment_scans_total\{outcome="quarantined"\}\[15m\]\)\s*>\s*0/, for: '0m', severity: 'page', route: 'oncall-email' },
  InstrumentsIngestSlow: { expr: /histogram_quantile\(0\.95,\s*sum by \(le\)\s*\(rate\(lims_instruments_ingest_batch_duration_seconds_bucket\[15m\]\)\)\)\s*>\s*3/, for: '15m', severity: 'warn', route: 'ops-digest-email' },
};

describe('instruments.rules.yml', () => {
  it('exists and is a Prometheus rule file with at least one group', () => {
    expect(existsSync(file), file).toBe(true);
    const doc = parse(readFileSync(file, 'utf8'));
    expect(Array.isArray(doc?.groups) && doc.groups.length > 0).toBe(true);
    for (const g of doc.groups) { expect(typeof g.name).toBe('string'); expect(Array.isArray(g.rules)).toBe(true); }
  });

  const rules = (): any[] => (existsSync(file) ? parse(readFileSync(file, 'utf8')).groups.flatMap((g: any) => g.rules) : []);

  it.each(Object.entries(WANT))('%s: expr, for, severity and route as TRD §13', (name, want) => {
    const r = rules().find((x) => x.alert === name);
    expect(r, `rule ${name}`).toBeDefined();
    expect(String(r.expr).replace(/\s+/g, ' ')).toMatch(want.expr);
    expect(String(r.for ?? '0m')).toBe(want.for);
    expect(r.labels?.severity).toBe(want.severity);
    expect(JSON.stringify(r.labels) + JSON.stringify(r.annotations ?? {})).toContain(want.route);
  });

  it('exactly these six alerts, none duplicated, none of the C1-owned agent-state alerts repeated', () => {
    const names = rules().map((r) => r.alert);
    expect([...names].sort()).toEqual(Object.keys(WANT).sort());
    for (const c1 of ['BridgeAgentOffline', 'BridgeAgentOfflineLong', 'BridgeAgentBacklog', 'BridgeAgentDegraded', 'BridgeAgentClockOffset', 'BridgeAgentMetricsAbsent']) expect(names).not.toContain(c1);
  });

  it('every metric used by an expression is a metric the TRD §13 table declares', () => {
    const declared = new Set(['lims_instruments_agent_update_failures_total', 'lims_instruments_agent_config_rejections_total', 'lims_instruments_device_auth_failures_total',
      'lims_instruments_ingest_messages_total', 'lims_instruments_attachment_scans_total', 'lims_instruments_ingest_batch_duration_seconds_bucket']);
    for (const r of rules()) for (const m of String(r.expr).match(/lims_[a-z_]+/g) ?? []) expect(declared.has(m), `${r.alert}: ${m}`).toBe(true);
  });

  it('no secrets or tenant data in the file', () => {
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toMatch(/password|secret|token\s*[:=]|@[a-z0-9-]+\.[a-z]{2,}/i);
  });
});
