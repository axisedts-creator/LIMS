// PG-T01 manifest + permissions + phase-stub replacement (02-TRD §3.1 index.ts/permissions.ts rows, §5.4, §8.3 systemPermissions, §9.3 boot;
// 06-PLAN PG-T01 done_when; 08 A17 P-20; REQ-ARCH-076). ASSUMED seam (writer: dispute via .orchestra/notes if wrong):
//   ../../index.ts exports `manifest: ModuleManifest` and calls loadPaymentsConfig() at import (boot fails by throwing from import).
//   ../../permissions.ts exports PAYMENTS_PERMISSIONS (readonly tuple of the 7 codes of TRD §5.4, naming like BILLING_PERMISSIONS).
//   Handlers not built yet are placeholders that exist for every payments.yaml operationId (checkHandlers is exact).
// LD-26 (training tenant, "C15 accepts only sandbox gateway credentials") is NOT tested here: no C2 port method exposes `trainingMode` yet
//   (CR-C2-T16, CR-C6-023 pending); it belongs to the merchant-account task, not the skeleton.
// Fails now: ../../index.js and ../../permissions.js do not exist.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHASE_STUBS, assertPhaseStubsCurrent, findStalePhaseStubs } from '../../../../core/ports/phase-stubs.js';
import { checkHandlers, eventProducers, loadSpec, operationIds, REPO_ROOT, validateManifest } from '../../../../core/module.js';
import { manifest } from '../../index.js';
import { PAYMENTS_PERMISSIONS } from '../../permissions.js';

const PAYMENTS_DIR = join(import.meta.dirname, '..', '..');
const spec = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'payments.yaml'));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

const yamlPaymentCodes = (): string[] =>
  [...readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8').matchAll(/code:\s*(payments\.[a-z_.]+)/g)].map((m) => m[1]!);

describe('manifest (index.ts)', () => {
  it('is the payments ModuleManifest and passes the core autoloader validation (ports, produces, resolver)', () => {
    expect(manifest.name).toBe('payments');
    expect(manifest.openapi).toBe('contracts/openapi/payments.yaml');
    expect(() => validateManifest('payments', manifest, REPO_ROOT)).not.toThrow();
  });

  it('produces exactly payments.intent.settled.v1 (EVENT_PRODUCERS)', () => {
    expect([...manifest.produces]).toEqual(['payments.intent.settled.v1']);
    expect([...(eventProducers().payments ?? [])]).toEqual(['payments.intent.settled.v1']);
  });

  it('has a handler for every payments.yaml operationId and no extra handler', () => {
    expect(operationIds(spec).length).toBeGreaterThan(0);
    expect(() => checkHandlers('payments', spec, manifest.handlers)).not.toThrow();
    expect(Object.keys(manifest.handlers).sort()).toEqual([...operationIds(spec)].sort());
  });

  it('declares exactly one port, PaymentProviderPort, with the five methods of the contract', () => {
    expect(Object.keys(manifest.ports ?? {})).toEqual(['PaymentProviderPort']);
    const port: any = (manifest.ports as any).PaymentProviderPort;
    for (const m of ['createIntent', 'verify', 'refund', 'getIntent', 'cancelIntent']) expect(typeof port[m], m).toBe('function');
  });

  it('declares the paymentCallback auth resolver (CR-C15-004) and no other resolver; no claimsResolver', () => {
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual(['paymentCallback']);
    expect(typeof (manifest.authResolvers as any).paymentCallback).toBe('function');
    expect(manifest.claimsResolver).toBeUndefined();
  });

  it('systemPermissions (CR-C15-005): never payments.intent.resolve; every entry is a real payments.* permission code', () => {
    const sp = [...(manifest.systemPermissions ?? [])];
    expect(Array.isArray(manifest.systemPermissions)).toBe(true);
    expect(sp).not.toContain('payments.intent.resolve');
    for (const c of sp) expect(yamlPaymentCodes(), c).toContain(c);
  });
});

describe('permissions.ts (TRD §5.4)', () => {
  it('is exactly the seven payments.* codes of contracts/permissions.yaml, verbatim', () => {
    expect([...PAYMENTS_PERMISSIONS].sort()).toEqual([
      'payments.intent.create', 'payments.intent.resolve', 'payments.merchant_config.manage', 'payments.merchant_config.read',
      'payments.reconciliation.read', 'payments.refund.approve', 'payments.refund.request',
    ]);
    expect([...PAYMENTS_PERMISSIONS].sort()).toEqual([...yamlPaymentCodes()].sort());
  });
  it('has no duplicates', () => { expect(new Set(PAYMENTS_PERMISSIONS).size).toBe(PAYMENTS_PERMISSIONS.length); });
});

describe('phase-stub replacement (08 A17 P-20): the PR that creates modules/payments removes PaymentProviderPort from phase-stubs.ts', () => {
  it('PHASE_STUBS no longer lists PaymentProviderPort and still lists the other three', () => {
    expect(PHASE_STUBS).not.toContain('PaymentProviderPort');
    expect([...PHASE_STUBS].sort()).toEqual(['EngagementPort', 'QualityPort', 'SmartReportPort']);
  });
  it('AC-0D-6.3 gate: payments/index.ts exists, so the port WOULD be stale if still listed; with the committed list it is not reported', () => {
    expect(findStalePhaseStubs({ phaseStubs: ['PaymentProviderPort'] })).toEqual([{ port: 'PaymentProviderPort', owner: 'payments' }]);
    expect(() => assertPhaseStubsCurrent({ phaseStubs: ['PaymentProviderPort'] })).toThrow(/PaymentProviderPort/);
    expect(findStalePhaseStubs().map((s) => s.port)).not.toContain('PaymentProviderPort');
  });
});

describe('boot fails per TRD §9.3 (module import is the boot step)', () => {
  it('import throws when the KEK file is missing', async () => {
    vi.resetModules();
    vi.stubEnv('LIMS_PAYMENTS_KEK_FILE', join(PAYMENTS_DIR, 'definitely-missing-kek.json'));
    await expect(import('../../index.js')).rejects.toThrow(/LIMS_PAYMENTS_KEK_FILE/);
  });
  it('import throws when PUBLIC_BASE_URL is not https', async () => {
    vi.resetModules();
    vi.stubEnv('LIMS_PAYMENTS_PUBLIC_BASE_URL', 'http://api.lims.test');
    await expect(import('../../index.js')).rejects.toThrow(/LIMS_PAYMENTS_PUBLIC_BASE_URL/);
  });
  it('import throws when a production gateway URL is configured for GATEWAY_ENV=uat (AC-PG-15.1)', async () => {
    vi.resetModules();
    vi.stubEnv('LIMS_PAYMENTS_KHALTI_BASE_URL', 'https://khalti.com/api/v2/');
    await expect(import('../../index.js')).rejects.toThrow(/LIMS_PAYMENTS_KHALTI_BASE_URL/);
  });
  it('import succeeds with the test-env defaults (control)', async () => {
    vi.resetModules();
    await expect(import('../../index.js')).resolves.toHaveProperty('manifest');
  });
});

describe('static rules', () => {
  it('index.ts never imports another module folder (REQ-ARCH-076) and never reads a secret into a log call', () => {
    const src = readFileSync(join(PAYMENTS_DIR, 'index.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"]\.\.\/(?!\.\.\/core\/)[a-z]+\//);
    expect(src).not.toMatch(/log\w*\.[a-z]+\([^)]*(kek|secret)/i);
  });
});
