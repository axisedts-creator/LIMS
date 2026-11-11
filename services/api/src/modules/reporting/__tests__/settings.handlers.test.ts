// C6-T03 — the S1-S7 + R17 handlers are wired (no longer the T01 501 stubs) and fail closed without an authenticated request context.
// Spec: 02-TRD §6.5 (S1-S7), R17; contracts/openapi/reporting.yaml operationIds below. The full HTTP contract (schema, auth, If-Match 428, Idempotency-Key on S4)
// is enforced by the core pipeline from the same OpenAPI file; business behaviour is in settings.service.test.ts.
// The 501 stubs of every OTHER operation stay covered by manifest.test.ts (which now excludes exactly these eight ids).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec, operationIds } from '../../../core/module.js';
import { IMPLEMENTED } from './implemented-ops.js';

export const T03_OPS = [
  'getReportingSettings', 'updateReportingSettings', 'listCentreContacts', 'createCentreContact', 'updateCentreContact',
  'replaceStaffAssignments', 'upsertReferrerPreference', 'listReportingCodes',
] as const;
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
const noop = () => undefined;
const ctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info: noop, warn: noop, error: noop } });
let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t03-h-')), 'otp.key');   // same dev boot env as manifest.test.ts (C6-T01 config validation)
  writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev';
  delete process.env.NODE_ENV;
  delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS;
  process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});

describe('C6-T03 handlers', () => {
  it('all eight operationIds exist in the contract', () => {
    const ops = operationIds(spec);
    for (const op of T03_OPS) expect(ops).toContain(op);
  });
  it.each(T03_OPS)('%s has a real handler (not the 501 stub)', async (op) => {
    expect(typeof manifest.handlers[op]).toBe('function');
    const planted = 'PLANTED-TOKEN-5c1e';
    let out: any; let threw: unknown;
    try { out = await manifest.handlers[op]({ params: { centre_contact_id: planted, referrer_id: planted, set_name: planted }, query: {}, headers: {}, body: { label: planted } }, ctx(op)); } catch (e) { threw = e; }
    if (threw === undefined) {
      expect(out.status).not.toBe(501);
      expect(out.status).toBeGreaterThanOrEqual(400);            // no request context (no actor / tx): fails closed, never 2xx
    }
    expect(JSON.stringify(out ?? {})).not.toContain(planted);   // and never reflects input
    if (threw !== undefined) expect(String((threw as Error)?.message ?? threw)).not.toContain(planted);
  });
  it('the other reporting operations are still 501 stubs (T03 ops and every already-implemented op excluded)', async () => {
    const others = operationIds(spec).filter((o: string) => !(T03_OPS as readonly string[]).includes(o) && !IMPLEMENTED.has(o));
    expect(others.length).toBeGreaterThanOrEqual(1);   // 3 remain stubs after T16 (ruling C6-T16-ruling.md); >=1 keeps the loop non-vacuous; when the last stub is implemented, replace with expect(others).toEqual([])
    for (const op of others.slice(0, 5)) expect((await manifest.handlers[op]({ params: {}, query: {}, headers: {}, body: undefined }, ctx(op))).status).toBe(501);
  });
  it('permissions in the contract: S1-S7 require reporting.settings.manage, R17 reporting.report.read (spec 02-TRD §6.5)', () => {
    const perm = (op: string) => {
      for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === op) return m['x-permission'];
    };
    for (const op of T03_OPS.filter((o) => o !== 'listReportingCodes')) expect(perm(op)).toBe('reporting.settings.manage');
    expect(perm('listReportingCodes')).toBe('reporting.report.read');
  });
});
