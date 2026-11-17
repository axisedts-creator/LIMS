// C5 T-24 — LabPort impl shape and "actor guard first", no database (03-IC §4.5, 08 §4.14; 02-TRD §6.1; 07-SECURITY REQ-SEC-072, S-17, S-20; 08 R3).
// ASSUMED seams: ../LabPort.impl.ts exports `labPort` (ten LabPortV1 methods, each (ctx, input)); ../../index.ts manifest.ports.LabPort === labPort;
// service/module-result.service.ts and service/qc.service.ts exist (task files). A non-staff actor (patient / portal / partner) is refused with auth.forbidden before the impl
// touches ctx.tx (the tx below throws on any use).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { labPort } from '../LabPort.impl.js';

const METHODS = ['getOrderResults', 'getPendingTestsForBarcode', 'ingestInstrumentResult', 'holdResultsSince', 'submitModuleResult', 'getOrderItemProcessingState',
  'listPendingForInstrument', 'lookupSpecimens', 'getAnalyteHistory'] as const;
const U = (n: number) => `01900000-0000-7000-8000-${(0xc000 + n).toString(16).padStart(12, '0')}`;
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const deadTx = new Proxy({}, { get() { throw new Error('ctx.tx touched before the actor guard'); } });
const ctxOf = (type: string) => ({
  tenantId: U(1), actor: { type, id: U(2) }, requestId: U(3), tx: deadTx, now: () => '2026-11-05T04:15:00.000Z',
  ports: { IdentityPort: { async assertRole() { throw new LimsError('auth.forbidden'); }, async getTenantSettings() { throw new Error('ports touched before the actor guard'); } },
    CatalogPort: new Proxy({}, { get() { throw new Error('CatalogPort touched before the actor guard'); } }) },
});
const INPUTS: Record<string, unknown> = {
  getOrderResults: { orderId: U(21), scope: 'all_visible' },
  getPendingTestsForBarcode: { instrumentId: U(6), barcode: 'SYN0001' },
  ingestInstrumentResult: { instrumentMessageId: U(120), instrumentId: U(6), agentId: U(121), centreId: U(4), protocol: 'astm', sampleBarcode: 'SYN0001', recordKind: 'quantitative',
    instrumentAnalyteCode: 'X', mappingStatus: 'unmapped', valueNumeric: '1.0', receivedAt: '2026-11-05T04:15:00.000Z' },
  holdResultsSince: { instrumentId: U(6), analyteIds: [U(11)], since: '2026-11-01T00:00:00.000Z', qcRunId: U(130), reasonCode: 'qc_failure' },
  submitModuleResult: { orderItemId: U(31), kind: 'narrative', reportPhase: 'final', payloadRef: { module: 'micro', entityId: U(81), versionNo: 1 }, submittedAt: '2026-11-05T04:15:00.000Z', idempotencyKey: `micro:${U(81)}:1` },
  getOrderItemProcessingState: { orderId: U(21) },
  listPendingForInstrument: { instrumentId: U(6) },
  lookupSpecimens: { barcode: 'SYN0001' },
  getAnalyteHistory: { patientId: U(1), analyteIds: [U(11)], before: '2026-11-05T04:15:00.000Z', limitPerAnalyte: 5 },
};

describe('T-24 LabPort shape', () => {
  it('labPort has the LabPortV1 methods as functions', () => {
    for (const m of METHODS) expect(typeof (labPort as any)[m], m).toBe('function');
  });
  it('the lab manifest registers it as ports.LabPort (01 §5.1)', () => {
    expect((manifest as any).ports?.LabPort).toBe(labPort);
  });
  it('task files exist: service/module-result.service.ts, service/qc.service.ts', () => {
    for (const f of ['../../service/module-result.service.ts', '../../service/qc.service.ts']) expect(existsSync(here(`./${f}`)), f).toBe(true);
  });
  it('the impl opens no transaction of its own, imports no pg, logs nothing, makes no network call', () => {
    const src = readFileSync(here('../LabPort.impl.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]pg['"]/);
    expect(src).not.toMatch(/['"`]\s*(BEGIN|COMMIT|ROLLBACK)\s*['"`]/i);
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/\bfetch\(|node:https?/);
  });
});

describe('T-24 actor guard first (REQ-SEC-072, 08 R3)', () => {
  for (const type of ['patient', 'portal', 'partner']) {
    for (const m of METHODS) {
      it(`${type} actor -> ${m} is auth.forbidden before ctx.tx or any port is used`, async () => {
        let err: any;
        try { await (labPort as any)[m](ctxOf(type), INPUTS[m]); } catch (e) { err = e; }
        expect(err?.code, `${type}/${m}: ${err?.message}`).toBe('auth.forbidden');
      });
    }
  }
});
