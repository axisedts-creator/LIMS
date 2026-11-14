// AN-T21 — contract-level probes derived from contracts/openapi/analytics.yaml (07-SECURITY §5: P1 generator input, X1, X2, X3, P13 static half).
// No handler is run here: these fail when the CONTRACT (the thing the core validates every request against) loosens.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { REPORT_REGISTRY } from '../../domain/reportRegistry.js';
import { OPS, bodyErrors, op, openObjects, requestSchema, responseSchema, declaredPaths } from './spec.js';

const ANALYTICS_SRC = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'analytics');
const WORKER_SRC = join(REPO_ROOT, 'services', 'worker', 'src', 'jobs', 'analytics');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' ? [] : sources(p);
    return /\.(ts|sql|yaml|yml|json)$/.test(n) && !/\.(test|spec)\./.test(n) ? [p] : [];
  });
}

describe('P1 generator input: the spec is the source of truth (30 operations, every one authenticated + permissioned)', () => {
  it('analytics.yaml has exactly 30 operations; each has one analytics.* permission', () => {
    expect(OPS.length).toBe(30);
    expect(OPS.filter((o) => !/^analytics\.[a-z_]+\.[a-z_]+$/.test(o.permission ?? ''))).toEqual([]);
  });

  it('no operation takes a tenant / tenant_id / account parameter or body field: tenant comes from the verified JWT only (REQ-SEC-013, P1)', () => {
    const bad: string[] = [];
    for (const o of OPS) {
      for (const q of [...o.query, ...o.pathParams]) if (/tenant|account|org/i.test(String(q))) bad.push(`${o.id}: param ${q}`);
      const body = requestSchema(o);
      if (body) for (const p of declaredPaths(body)) if (/(^|\.)(tenant|tenant_id|account_id)$/i.test(p)) bad.push(`${o.id}: body ${p}`);
    }
    expect(bad).toEqual([]);
  });

});

describe('X2 request bodies are closed (REQ-SEC-080: unknown field -> 400)', () => {
  const withBody = OPS.filter((o) => o.hasBody);
  it('there are request bodies to check (#17 #19 #20 #25 #27 #28)', () => {
    expect(withBody.map((o) => o.id).sort()).toEqual(['createAnalyticsExport', 'createReportSchedule', 'deactivateReportSchedule', 'requestAnalyticsRefresh', 'searchAnalyticsReferrers', 'updateReportSchedule']);
  });
  it.each(withBody.map((o) => [o.id, o] as const))('%s: every object in the request schema has additionalProperties:false', (_id, o) => {
    expect(openObjects(requestSchema(o))).toEqual([]);
  });
  it.each(withBody.map((o) => [o.id, o] as const))('%s: an extra root field is rejected by the core validator options (no strip, no coerce)', (_id, o) => {
    const errs = bodyErrors(requestSchema(o), { __unexpected_field__: 'x' });
    expect(errs.some((e) => e.endsWith('additionalProperties'))).toBe(true);
  });
});

describe('X3 response DTOs are closed: a mapper that adds a field fails the contract (no row serialisation, REQ-SEC-081)', () => {
  it.each(OPS.map((o) => [o.id, o] as const))('%s: 200 response schema has no open object', (_id, o) => {
    const schema = responseSchema(o);
    if (!schema) return; // 200 without a JSON body (download streams the file)
    expect(openObjects(schema)).toEqual([]);
  });
});

describe('X1 privilege separation is declared per operation (finance / lab manager / schedule manager cannot reach what they must not)', () => {
  it('collections: #4 and #30 need analytics.collections.read; no other report needs it', () => {
    expect(OPS.filter((o) => o.permission === 'analytics.collections.read').map((o) => o.id).sort()).toEqual(['getCollectionsFilterOptions', 'getCollectionsReport']);
  });
  it('referral: only #8 needs analytics.referral_report.read; exports need analytics.data.export (4 ops); schedules need analytics.schedule.manage (5 ops)', () => {
    expect(OPS.filter((o) => o.permission === 'analytics.referral_report.read').map((o) => o.id)).toEqual(['getReferralIncentiveReport']);
    expect(OPS.filter((o) => o.permission === 'analytics.data.export')).toHaveLength(4);
    expect(OPS.filter((o) => o.permission === 'analytics.schedule.manage')).toHaveLength(5);
  });
  it('every other operation needs analytics.dashboard.read (so a collections-only finance user gets 403 on #16 and every non-collections report)', () => {
    const special = new Set(['analytics.collections.read', 'analytics.referral_report.read', 'analytics.data.export', 'analytics.schedule.manage']);
    expect(OPS.filter((o) => !special.has(o.permission)).every((o) => o.permission === 'analytics.dashboard.read')).toBe(true);
  });
  it('the 4xx set of every operation declares 401 + 403 (no anonymous path) and never a 2xx without bearer security', () => {
    const bad = OPS.filter((o) => !(o.raw.responses?.['401'] || o.raw.responses?.default) || !(o.raw.responses?.['403'] || o.raw.responses?.default)).map((o) => o.id);
    expect(bad).toEqual([]);
  });
});

describe('P13 net_billed_paisa never leaves the flag-gated referral report (08 A17 D-44, B13)', () => {
  it('in the contract, no response or request schema except #8 getReferralIncentiveReport mentions net_billed_paisa', () => {
    const carriers = OPS.filter((o) => JSON.stringify([responseSchema(o), requestSchema(o), o.raw.parameters]).includes('net_billed_paisa')).map((o) => o.id);
    expect(carriers).toEqual(['getReferralIncentiveReport']);
  });
  it('getTopReferrersReport `sort` does not offer net_billed_paisa (so ?sort=-net_billed_paisa is a 400 at the validator)', () => {
    const sort = deRefParam('getTopReferrersReport', 'sort');
    expect(JSON.stringify(sort)).not.toMatch(/billed|net_/);
  });
  it('export registry: top_referrers and dashboard columns carry no per-referrer money; the referral report column is flag-gated', () => {
    expect(REPORT_REGISTRY['top_referrers']!.exportColumns).not.toContain('net_billed_paisa');
    expect(REPORT_REGISTRY['dashboard']!.exportColumns).not.toContain('net_billed_paisa');
    const owners = Object.entries(REPORT_REGISTRY).filter(([, d]) => d.exportColumns.includes('net_billed_paisa')).map(([c, d]) => [c, (d as any).flag]);
    expect(owners).toEqual([['referral_incentive', 'referralIncentiveReportEnabled']]);
  });
  it('in C8 source (non-test), net_billed_paisa appears only in the referral / billing-rollup files', () => {
    const allowed = new Set([
      'domain/reportRegistry.ts', 'export/reportTable.ts', 'mappers/reports.dto.ts', 'repository/refresh.repo.ts', 'repository/rollups.repo.ts', 'service/referral.service.ts',
    ]);
    const hits = sources(ANALYTICS_SRC).filter((f) => readFileSync(f, 'utf8').includes('net_billed_paisa')).map((f) => relative(ANALYTICS_SRC, f).replaceAll('\\', '/'));
    expect(hits.filter((h) => !allowed.has(h))).toEqual([]);
    const workerHits = sources(WORKER_SRC).filter((f) => readFileSync(f, 'utf8').includes('net_billed_paisa')).map((f) => relative(WORKER_SRC, f).replaceAll('\\', '/'));
    expect(workerHits.filter((h) => h !== 'tasks/self_check.ts')).toEqual([]); // dispatcher / export builder / dashboard never name it
  });
});

function deRefParam(opId: string, name: string): unknown {
  const o = op(opId);
  return (o.raw.parameters ?? []).find((p: any) => p.name === name)?.schema;
}
