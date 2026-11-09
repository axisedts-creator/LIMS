// C6-T01 — API module scaffold: manifest, permissions, 501 stubs in dev (06-PLAN row C6-T01; 02-TRD §3.2, §6.3).
// Expected exports: ../index.ts `manifest` (the autoloader's contract); ../permissions.ts `REPORTING_PERMISSIONS` (readonly string[]).
// Stubs: every operationId in contracts/openapi/reporting.yaml has a handler that answers { status: 501 } in dev and echoes nothing from the request.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec, operationIds, validateManifest } from '../../../core/module.js';
import { IMPLEMENTED } from './implemented-ops.js';

const spec = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
const ops = operationIds(spec);

let manifest: any;
let perms: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t01-m-')), 'otp.key');
  writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev';
  delete process.env.NODE_ENV;
  delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS;
  process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
  perms = await import('../permissions.js');
});

// 03-INTERFACE-CATALOG §11 reporting rows (incl. CR-C6-003 additions), verbatim.
const IC_REPORTING_PERMISSIONS = [
  'reporting.report.read', 'reporting.report.release', 'reporting.report.bulk_release', 'reporting.report.print',
  'reporting.delivery.read', 'reporting.delivery.resend', 'reporting.template.manage', 'reporting.outsourced.attach',
  'reporting.portal.view', 'reporting.portal.download', 'reporting.report.render', 'reporting.report.regenerate',
  'reporting.report.bulk_download', 'reporting.token.revoke', 'reporting.narrative.write', 'reporting.narrative.sign',
  'reporting.message_template.manage', 'reporting.channel.manage', 'reporting.settings.manage', 'reporting.portal.challenge',
];

describe('manifest passes the core boot checks', () => {
  it('validateManifest: name, openapi, produces == EVENT_PRODUCERS, ports owned, handlers == operationIds', () => {
    expect(() => validateManifest('reporting', manifest, REPO_ROOT)).not.toThrow();
  });
  it('produces exactly the two reporting events', () => {
    expect([...manifest.produces].sort()).toEqual(['reporting.delivery.status_changed.v1', 'reporting.report.released.v1']);
  });
  it('systemPermissions = the five of 02-TRD §9 (no more)', () => {
    expect([...manifest.systemPermissions].sort()).toEqual(
      ['identity.signatory.read', 'reporting.delivery.resend', 'reporting.portal.view', 'reporting.report.read', 'reporting.report.release']);
  });
  it('declares the portalSession resolver (CR-C6-001) and no other', () => {
    expect(Object.keys(manifest.authResolvers ?? {}).sort()).toEqual(['portalSession']);
  });
  it('declares no claimsResolver', () => expect(manifest.claimsResolver).toBeUndefined());
});

describe('permissions.ts', () => {
  it('REPORTING_PERMISSIONS equals the 03-IC §11 list, no extras, no duplicates', () => {
    expect([...perms.REPORTING_PERMISSIONS].sort()).toEqual([...IC_REPORTING_PERMISSIONS].sort());
    expect(new Set(perms.REPORTING_PERMISSIONS).size).toBe(perms.REPORTING_PERMISSIONS.length);
  });
  it('every code is reporting.<a>.<b> lower snake', () => {
    for (const p of perms.REPORTING_PERMISSIONS) expect(p).toMatch(/^reporting\.[a-z_]+\.[a-z_]+$/);
  });
  it('the list is frozen (cannot be widened at run time)', () => expect(Object.isFrozen(perms.REPORTING_PERMISSIONS)).toBe(true));
});

describe('501 stubs in dev', () => {
  const noop = () => undefined;
  const ctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info: noop, warn: noop, error: noop } });

  it('the spec has operations (guards against an empty parametrisation)', () => expect(ops.length).toBeGreaterThan(50));
  it('handler keys == spec operationIds', () => expect(Object.keys(manifest.handlers).sort()).toEqual([...ops].sort()));
  // The set of already-implemented operations (they leave the 501 list) lives in implemented-ops.ts, shared with settings.handlers.test.ts.
  // Each later task must add its operationIds there. Nothing else is weakened: all other operations still must answer 501.
  const stubOps = ops.filter((o: string) => !IMPLEMENTED.has(o));
  it('only already-implemented operations are excluded from the 501 list', () => expect(ops.length - stubOps.length).toBe(IMPLEMENTED.size));
  it.each(stubOps)('%s answers 501', async (op) => {
    const r = await manifest.handlers[op]({ params: {}, query: {}, headers: {}, body: undefined }, ctx(op));
    expect(r.status).toBe(501);
  });
  it('a 501 never echoes request input (no PHI / token reflection)', async () => {
    const planted = 'PLANTED-TOKEN-9f3a';
    for (const op of stubOps) {
      const r = await manifest.handlers[op]({ params: { id: planted }, query: { q: planted }, headers: { authorization: planted }, body: { name: planted } }, ctx(op));
      expect(JSON.stringify(r)).not.toContain(planted);
    }
  });
});
