// C7 API-T07 — driver registry, capabilities, Mindray sketches, sketch guard (02-TRD §6.1/§6.3; 05-SCHEMA §2.18 seed; AC-21.3, AC-04.2).
// done_when: "registry vs g_drivers check; sketch guard". Synthetic data only.
// Interface expected from the writer (SEAM = name not fixed by the spec, chosen here; the writer must match it):
//   ../../drivers/registry.ts
//     getDriver(code: string): InstrumentDriver | undefined     (TRD §6.1 names getDriver; unknown code -> undefined OR a throw, both accepted)
//     listDrivers(): readonly InstrumentDriver[]                (SEAM) every implemented driver, one entry per code
//     assertDriverSelectable(driver: { status: DriverStatus }, opts: { allowSketchDrivers: boolean; nodeEnv?: string;
//                            purpose: 'create' | 'commissioning' | 'live' }): void                         (SEAM)
//         throws an Error with .code === 'instruments.driver_not_available' when the driver may not be used for that purpose:
//           generic        : create/commissioning ok, live -> throw   (AC-04.2: only `verified` goes live)
//           verified       : always ok
//           sketch_blocked : create/commissioning ok ONLY if allowSketchDrivers && nodeEnv !== 'production'; live -> ALWAYS throw (AC-21.3)
//   Each InstrumentDriver is exactly the TRD §6.1 interface; capabilities/status/protocol/version must equal the 05-SCHEMA seed rows.
import { describe, expect, it } from 'vitest';
import { loadInstrumentsConfig } from '../../config.js';
import { assertDriverSelectable, getDriver, listDrivers } from '../../drivers/registry.js';

type Caps = { resultUpload: boolean; hostQuery: boolean; worklistDownload: boolean; qc: boolean; attachments: boolean; calibration: boolean };
// 05-SCHEMA §2.18 seed: code, protocol, status, version, caps (hq, wl, qc, att, cal)
const SEED: Array<[string, string, string, string, Caps]> = [
  ['astm_generic_e1394', 'astm', 'generic', '0.1.0', { resultUpload: true, hostQuery: false, worklistDownload: false, qc: true, attachments: false, calibration: false }],
  ['hl7v2_generic_oru', 'hl7v2', 'generic', '0.1.0', { resultUpload: true, hostQuery: false, worklistDownload: false, qc: true, attachments: false, calibration: false }],
  ['file_drop_generic', 'file_drop', 'generic', '0.1.0', { resultUpload: true, hostQuery: false, worklistDownload: false, qc: false, attachments: true, calibration: false }],
  ['mindray_bc5380_sketch', 'hl7v2', 'sketch_blocked', '0.0.1', { resultUpload: true, hostQuery: true, worklistDownload: false, qc: false, attachments: false, calibration: false }],
  ['mindray_bs200_sketch', 'hl7v2', 'sketch_blocked', '0.0.1', { resultUpload: true, hostQuery: true, worklistDownload: false, qc: false, attachments: false, calibration: false }],
  // H80-T02 (LD-139, 08-ADDENDUM-TRUTH-H80E §8): generic, never verified; hostQuery inert while status <> verified
  ['truth_h80e', 'hl7v2', 'generic', '0.1.0', { resultUpload: true, hostQuery: true, worklistDownload: false, qc: true, attachments: true, calibration: false }],
  // MET-T02 (LD-163, 09-ADDENDUM-GETEIN-METIS §8): generic, never verified; hostQuery inert while status <> verified; no attachments, no calibration
  ['getein_metis', 'hl7v2', 'generic', '0.1.0', { resultUpload: true, hostQuery: true, worklistDownload: false, qc: true, attachments: false, calibration: false }],
];
const enc = (s: string) => new TextEncoder().encode(s);
const NOT_AVAILABLE = 'instruments.driver_not_available';

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return (e as { code?: string }).code ?? `no-code:${(e as Error).message}`; }
  return undefined;
}

describe('registry contents match the g_drivers seed (05-SCHEMA §2.18)', () => {
  it('exactly the seven seeded codes (five + truth_h80e H80-T02 + getein_metis MET-T02), each once', () => {
    const codes = listDrivers().map((d) => d.code).sort();
    expect(codes).toEqual(SEED.map((s) => s[0]).sort());
  });

  it.each(SEED)('%s: protocol/status/version/capabilities equal the seed row', (code, protocol, status, version, caps) => {
    const d = getDriver(code)!;
    expect(d).toBeDefined();
    expect(d.code).toBe(code);
    expect(d.protocol).toBe(protocol);
    expect(d.status).toBe(status);
    expect(d.version).toBe(version);
    expect(d.capabilities).toEqual(caps);
    expect(typeof d.parse).toBe('function');
    expect(d.optionsSchema).toBeTypeOf('object');
  });

  it('getDriver returns the same instance as listDrivers and nothing for an unknown code', () => {
    for (const d of listDrivers()) expect(getDriver(d.code)).toBe(d);
    let r: unknown = 'unset';
    try { r = getDriver('no_such_driver'); } catch { r = undefined; }
    expect(r).toBeUndefined();
  });

  it('no driver is verified, none may declare calibration (CHECK cap_calibration=false OR status=verified; B2)', () => {
    for (const d of listDrivers()) {
      expect(d.status).not.toBe('verified');
      expect(d.capabilities.calibration).toBe(false);
      expect(d.capabilities.worklistDownload).toBe(false);
      expect(d.capabilities.resultUpload).toBe(true);
      // CHECK status<>'verified' OR manual_document_id: no manual -> never verified. Only truth_h80e (08 §0) and getein_metis (09 §0) have a manual on file.
      if (d.code === 'truth_h80e') expect(d.manualRef).toMatchObject({ documentId: 'truth-h80e-hl7-interface-user-manual', revision: '1.5' });
      else if (d.code === 'getein_metis') expect(d.manualRef).toMatchObject({ documentId: 'getein-metis-hl7-communication-protocol', revision: 'unversioned' });
      else expect(d.manualRef).toBeUndefined();
    }
  });

  it('version is semver (bumped on any behaviour change)', () => {
    for (const d of listDrivers()) expect(d.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
  });
});

describe('Mindray sketches (TRD §6.3): illustrative, blocked, reuse generic HL7 parsing', () => {
  const MINDRAY = ['mindray_bc5380_sketch', 'mindray_bs200_sketch'];
  const oru = enc([
    'MSH|^~\\&|SIM|LAB|LIS|CTR|20261107101500||ORU^R01|MSG00009|P|2.3.1',
    'OBR|1||E2600000042|GLU^Glucose|||20261107101000',
    'OBX|1|NM|GLU^Glucose||5.4|mmol/L|3.9-6.1|N|||F|||20261107101200',
  ].join('\r') + '\r');
  const ctx = { receivedAt: '2026-11-07T04:20:00.000Z', capturedAt: '2026-11-07T04:20:00.000Z', instrumentTimezone: 'Asia/Kathmandu', qcSampleIdPatterns: [/^QC-/], options: {} };

  it.each(MINDRAY)('%s parse equals hl7v2_generic_oru parse on the same ORU^R01', (code) => {
    const generic = getDriver('hl7v2_generic_oru')!.parse(oru, ctx as never);
    const sketch = getDriver(code)!.parse(oru, ctx as never);
    expect(generic.ok).toBe(true);
    expect(sketch).toEqual(generic);
  });

  it.each(MINDRAY)('%s buildHostQueryReply throws instruments.driver_not_available (placeholder, never answers)', (code) => {
    const d = getDriver(code)!;
    expect(typeof d.buildHostQueryReply).toBe('function');
    const parsed = d.parse(oru, ctx as never);
    if (!parsed.ok) throw new Error('fixture must parse');
    const answers = [{ barcode: 'E2600000042', status: 'found' as const, tests: [] }];
    expect(codeOf(() => d.buildHostQueryReply!({ query: parsed, answers, ctx: ctx as never }))).toBe(NOT_AVAILABLE);
  });

  it('every sketch is sketch_blocked and never selectable for a live instrument whatever the flags', () => {
    for (const code of MINDRAY) {
      const d = getDriver(code)!;
      for (const nodeEnv of ['production', 'development', 'test', undefined]) {
        for (const allowSketchDrivers of [true, false]) {
          expect(codeOf(() => assertDriverSelectable(d, { allowSketchDrivers, nodeEnv, purpose: 'live' }))).toBe(NOT_AVAILABLE);
        }
      }
    }
  });
});

describe('sketch guard — AC-21.3 / AC-04.2 (assertDriverSelectable)', () => {
  const sketch = { status: 'sketch_blocked' as const };
  const generic = { status: 'generic' as const };
  const verified = { status: 'verified' as const };

  it.each(['create', 'commissioning'] as const)('sketch + %s: allowed only when allowSketchDrivers && NODE_ENV != production', (purpose) => {
    expect(codeOf(() => assertDriverSelectable(sketch, { allowSketchDrivers: true, nodeEnv: 'development', purpose }))).toBeUndefined();
    expect(codeOf(() => assertDriverSelectable(sketch, { allowSketchDrivers: true, nodeEnv: 'test', purpose }))).toBeUndefined();
    expect(codeOf(() => assertDriverSelectable(sketch, { allowSketchDrivers: true, nodeEnv: undefined, purpose }))).toBeUndefined();
    // flag off -> blocked anywhere
    expect(codeOf(() => assertDriverSelectable(sketch, { allowSketchDrivers: false, nodeEnv: 'development', purpose }))).toBe(NOT_AVAILABLE);
    // production -> blocked even if the flag was (mis)set: defence in depth
    expect(codeOf(() => assertDriverSelectable(sketch, { allowSketchDrivers: true, nodeEnv: 'production', purpose }))).toBe(NOT_AVAILABLE);
    expect(codeOf(() => assertDriverSelectable(sketch, { allowSketchDrivers: false, nodeEnv: 'production', purpose }))).toBe(NOT_AVAILABLE);
  });

  it('generic: usable for create/commissioning (shadow), never live (AC-04.2)', () => {
    for (const purpose of ['create', 'commissioning'] as const) {
      expect(codeOf(() => assertDriverSelectable(generic, { allowSketchDrivers: false, nodeEnv: 'production', purpose }))).toBeUndefined();
    }
    expect(codeOf(() => assertDriverSelectable(generic, { allowSketchDrivers: false, nodeEnv: 'production', purpose: 'live' }))).toBe(NOT_AVAILABLE);
    expect(codeOf(() => assertDriverSelectable(generic, { allowSketchDrivers: true, nodeEnv: 'development', purpose: 'live' }))).toBe(NOT_AVAILABLE);
  });

  it('verified: always selectable (the only status that may go live)', () => {
    for (const purpose of ['create', 'commissioning', 'live'] as const) {
      expect(codeOf(() => assertDriverSelectable(verified, { allowSketchDrivers: false, nodeEnv: 'production', purpose }))).toBeUndefined();
    }
  });

  it('unknown status or purpose fails closed', () => {
    expect(codeOf(() => assertDriverSelectable({ status: 'bogus' as never }, { allowSketchDrivers: true, nodeEnv: 'development', purpose: 'create' }))).toBe(NOT_AVAILABLE);
    expect(codeOf(() => assertDriverSelectable(sketch, { allowSketchDrivers: true, nodeEnv: 'development', purpose: 'bogus' as never }))).toBe(NOT_AVAILABLE);
  });

  it('only the literal NODE_ENV "production" blocks; any other value (e.g. "staging") counts as non-production', () => {
    // Spec text is `NODE_ENV ≠ production`. (Staging is covered by the boot config via LIMS_CORE_ENV, below.)
    expect(codeOf(() => assertDriverSelectable(sketch, { allowSketchDrivers: true, nodeEnv: 'staging', purpose: 'create' }))).toBeUndefined();
  });
});

describe('boot config backs the guard (config.ts, AC-21.3)', () => {
  const base = { NODE_ENV: 'development' };
  it('sketch drivers default on outside production, off in production', () => {
    expect(loadInstrumentsConfig({ ...base }).allowSketchDrivers).toBe(true);
    expect(loadInstrumentsConfig({ NODE_ENV: 'production', LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE: 'k', LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID: 'i', LIMS_INSTRUMENTS_RELEASES_DIR: 'r' }).allowSketchDrivers).toBe(false);
  });
  it('boot fails when the flag is true in production', () => {
    expect(() => loadInstrumentsConfig({ NODE_ENV: 'production', LIMS_INSTRUMENTS_ALLOW_SKETCH_DRIVERS: 'true', LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE: 'k', LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID: 'i', LIMS_INSTRUMENTS_RELEASES_DIR: 'r' })).toThrow(/ALLOW_SKETCH_DRIVERS/);
  });
});
