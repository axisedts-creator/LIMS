// C7 H80-T02 — server driver truth_h80e: parse patient + QC results (08-ADDENDUM-TRUTH-H80E §3, §4, §8). Tests first; synthetic data only.
// LD-139 (2026-11-13): positions marked U in the addendum are unverified -> tolerant parsing + configurable defaults, never a hard-coded guess;
// driver stays status `generic` (host query inert) until the commissioning checklist is signed and a reviewed migration promotes it.
// Messages are built inline from the addendum layouts (tester-owned, independent of the writer's drivers/truth_h80e/testdata, which the generic
// golden runner drivers-golden.test.ts also executes automatically once the directory exists). Expectations use toMatchObject: unlisted fields are free.
// Field counting: HL7 MSH-n has MSH-1 = the '|' itself (so MSH-7 is the time, MSH-9 type, MSH-10 control id, MSH-16 the type flag).
// SEAMS (spec gaps, chosen here, flagged in notes/H80-T02-tests.md):
//   * QC controlLevel = qc_level_map[OBR-5] (default {"L":"low"}); a letter that is not in the map passes through raw.
//   * Host-query parsing/building is H80-T03, inline chromatogram payload (ParsedRecord.inlineAttachment) is H80-T04: not asserted here.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { beforeAll, describe, expect, it } from 'vitest';
import { AJV_OPTIONS } from '../../../../core/openapi.js';
import { getDriver, listDrivers } from '../../drivers/registry.js';
import { scanSyntheticData } from '../ci/synthetic-scan.js';

const DRIVER_DIR = fileURLToPath(new URL('../../drivers/truth_h80e/', import.meta.url));
const TESTDATA = join(DRIVER_DIR, 'testdata');
const enc = (s: string) => new TextEncoder().encode(s);
const ctx = (options: Record<string, unknown> = {}) => ({
  receivedAt: '2026-11-05T12:00:00.000Z', capturedAt: '2026-11-05T12:00:00.000Z', instrumentTimezone: 'Asia/Kathmandu',
  qcSampleIdPatterns: [/^QC-/], options,
});
const drv = () => getDriver('truth_h80e')!;
const parse = (segments: string[], options: Record<string, unknown> = {}): any => drv().parse(enc(segments.join('\r') + '\r'), ctx(options) as never);
const okParse = (segments: string[], options: Record<string, unknown> = {}): any => {
  const r = parse(segments, options);
  if (!r.ok) throw new Error(`expected ok parse, got ${JSON.stringify(r)}`);
  return r;
};

// ---- addendum §3 (patient) and §4 (QC) layouts, field for field -------------------------------------------------------------------------
const T = '20261105173723';
const MSH_P = `MSH|^~\\&|Truth|Truth-H80E|||${T}||ORU^R01|1|P|2.3||||0||UTF-8||||`;
const PID = 'PID|1||2600000123||Test Patient|General Practice Department|19880912|1||||';
const OBR_P = 'OBR|1|0001|E2600000042||||||||||||1||||';
const obxP = (n: number, code: string, value: string, unit: string, t = T) => `OBX|${n}|NM|${code}||${value}|${unit}||0|||||${t}||||`;
const PATIENT = [
  MSH_P, PID, OBR_P,
  obxP(1, 'HbA1c_NGSP', '5.63', '%'), obxP(2, 'HbA1c_IFCC', '37.82', 'mmol/mol'), obxP(3, 'HbF', '0.92', '%'), obxP(4, 'HbA1', '6.93', '%'),
  obxP(5, 'eAG', '5.82', 'mmol/L'), obxP(6, 'A1ab', '1.05', '%'), obxP(7, 'HbLA1C+', '3.25', '%'), obxP(8, 'HbA0', '85.35', '%'),
  obxP(9, 'A1A', '0.35', '%'), obxP(10, 'A1B', '0.7', '%'),
];
const JPEG_B64 = '/9j/4AAQSkZJRgABAQ' + 'A'.repeat(4000); // synthetic: starts like a JPEG, never decoded by the driver
const OBX_ED = `OBX|11|ED|Chromatogram||${JPEG_B64}||||||||${T}||||`;

const TQ = '20261105190559';
const MSH_Q = `MSH|^~\\&|Truth|Truth-H80E|||${TQ}||ORU^R01|1|P|2.3||||1||UTF-8|||`;
const OBR_Q = 'OBR|1|2|A0926|NGSP|L|20270926000000|20261105111537||4.4|0.3||5.2403173|0.013031356||0.0024867496||||';
const obxQ = (n: number, code: string, value: string, unit: string, t = '20261105111537') => `OBX|${n}|NM|${code}||${value}|${unit}||null||||||${t}||||`;
const QC = [
  MSH_Q, OBR_Q,
  obxQ(1, 'HbA1c_NGSP', '5.24', '%'), obxQ(2, 'HbA1c_IFCC', '33.70', 'mmol/mol'), obxQ(3, 'HbF', '0.18', '%'), obxQ(4, 'HbA1', '7.15', '%'),
  obxQ(5, 'HbA1c_NGSP', '5.26', '%', '20261105111637'),
];

// ================================================================================================================================
describe('registry entry — addendum §8 property table', () => {
  it('truth_h80e is registered once: version 0.1.0, hl7v2, status generic (never verified), manualRef as specified', () => {
    expect(listDrivers().filter((d) => d.code === 'truth_h80e')).toHaveLength(1);
    expect(drv()).toBeDefined();
    expect(drv()).toMatchObject({ code: 'truth_h80e', version: '0.1.0', protocol: 'hl7v2', status: 'generic' });
    expect(drv().manualRef).toEqual({
      title: 'HL7 Interface User Manual — Fully Automated Glycated Hemoglobin Analyzer',
      documentId: 'truth-h80e-hl7-interface-user-manual', revision: '1.5',
    });
  });

  it('capabilities: upload, host query (inert while generic), qc, attachments; NO worklist, NO calibration', () => {
    expect(drv().capabilities).toEqual({ resultUpload: true, hostQuery: true, worklistDownload: false, qc: true, attachments: true, calibration: false });
  });

  it('the registry is frozen against mutation of this entry (a driver cannot be promoted at runtime)', () => {
    const d = drv() as { status: string };
    try { d.status = 'verified'; } catch { /* strict-mode TypeError on frozen object is fine */ }
    expect(drv().status).toBe('generic');
  });
});

describe('optionsSchema — addendum §8', () => {
  const s = () => drv().optionsSchema as any;
  const factory = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => (v: unknown) => boolean;
  const valid = (v: unknown) => factory({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, strict: false, allErrors: true } })({ schema: s() })(v);

  it('strict object, no required keys, lists exactly the five documented options', () => {
    expect(s().type).toBe('object');
    expect(s().additionalProperties).toBe(false);
    expect(s().required ?? []).toEqual([]);
    expect(Object.keys(s().properties).sort()).toEqual(['detection_mode_field', 'host_query_detection_mode', 'name_script', 'qc_level_map', 'type_flag_field']);
  });

  it('documented defaults: detection_mode_field OBR.15, type_flag_field MSH.16, host_query_detection_mode 0, name_script as_registered, qc_level_map {L: low}', () => {
    const p = s().properties;
    expect(p.detection_mode_field.default).toBe('OBR.15');
    expect(p.type_flag_field.default).toBe('MSH.16');
    expect(String(p.host_query_detection_mode.default)).toBe('0');
    expect(p.name_script.default).toBe('as_registered');
    expect(p.qc_level_map.default).toEqual({ L: 'low' });
  });

  it('accepts {} and each documented value; rejects unknown keys and out-of-set values', () => {
    expect(valid({})).toBe(true);
    expect(valid({ detection_mode_field: 'OBR.16', type_flag_field: 'MSH.17', name_script: 'latin_if_available', qc_level_map: { L: 'low', H: 'high' } })).toBe(true);
    expect(valid({ host_query_detection_mode: 1 }) || valid({ host_query_detection_mode: '1' })).toBe(true);
    expect(valid({ bogus: 1 })).toBe(false);
    expect(valid({ name_script: 'klingon' })).toBe(false);
    expect(valid({ detection_mode_field: 'not a field ref' })).toBe(false);
    expect(valid({ host_query_detection_mode: 3 }) || valid({ host_query_detection_mode: '3' })).toBe(false);
    expect(valid({ qc_level_map: 'L=low' })).toBe(false);
  });
});

// ================================================================================================================================
describe('M1 patient result (§3) — golden-style parse', () => {
  let r: any;
  beforeAll(() => { r = okParse(PATIENT); }); // not at describe level: a missing driver must fail each test, not the whole file at collection

  it('message level: results, control id from MSH-10, send time from MSH-7 as local time', () => {
    expect(r).toMatchObject({ ok: true, messageKind: 'results', messageControlId: '1', messageTimeLocal: '2026-11-05T17:37:23' });
  });

  it('one record per OBX, in order, all patient class with the OBR-3 barcode', () => {
    expect(r.records).toHaveLength(10);
    expect(r.records.map((x: any) => x.recordSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const x of r.records) expect(x).toMatchObject({ recordClass: 'patient', sampleBarcode: 'E2600000042', recordKind: 'quantitative' });
    expect(r.records.every((x: any) => x.controlIdRaw === undefined && x.controlLotRaw === undefined)).toBe(true);
  });

  it('analyte code = OBX-3, value = OBX-5, unit = OBX-6, result time = OBX-13 (patient layout), as local time', () => {
    expect(r.records[0]).toMatchObject({ instrumentAnalyteCode: 'HbA1c_NGSP', valueRaw: '5.63', unitRaw: '%', instrumentResultTimeLocal: '2026-11-05T17:37:23' });
    expect(r.records[1]).toMatchObject({ instrumentAnalyteCode: 'HbA1c_IFCC', valueRaw: '37.82', unitRaw: 'mmol/mol' });
    expect(r.records[4]).toMatchObject({ instrumentAnalyteCode: 'eAG', valueRaw: '5.82', unitRaw: 'mmol/L' });
    expect(r.records[6]).toMatchObject({ instrumentAnalyteCode: 'HbLA1C+', valueRaw: '3.25' });
    expect(r.records[9]).toMatchObject({ instrumentAnalyteCode: 'A1B', valueRaw: '0.7' });
  });

  it('OBX-8 is stored as flag H80E_MARK:<v> and never decides abnormal (a normal 5.63 % carries mark 0)', () => {
    expect(r.records[0].instrumentFlags).toEqual(['H80E_MARK:0']);
    expect(JSON.stringify(r)).not.toMatch(/abnormal|critical|"H"|"L"/i);
  });

  it('no warnings on a clean message', () => {
    expect(r.warnings).toEqual([]);
    for (const x of r.records) expect(x.warnings).toEqual([]);
  });

  it('PHI minimisation: PID name/department/DOB/MRN never appear anywhere in the result (§3 table)', () => {
    const out = JSON.stringify(r);
    for (const phi of ['Test Patient', 'General Practice', '19880912', '2600000123']) expect(out).not.toContain(phi);
  });

  it('MSH-16 is only a hint: PID present => patient even when MSH-16 says 1', () => {
    const res = okParse(['MSH|^~\\&|Truth|Truth-H80E|||' + T + '||ORU^R01|1|P|2.3||||1||UTF-8||||', PID, OBR_P, obxP(1, 'HbA1c_NGSP', '5.63', '%')]);
    expect(res.records[0]).toMatchObject({ recordClass: 'patient', sampleBarcode: 'E2600000042' });
  });

  it('literal "null" in OBX-8 is treated as empty (no mark flag)', () => {
    const res = okParse([MSH_P, PID, OBR_P, `OBX|1|NM|HbA1c_NGSP||5.63|%||null|||||${T}||||`]);
    expect(res.records[0].instrumentFlags).toEqual([]);
  });

  it('OBR-2 (instrument sample number) is never used as the barcode; OBR-3 is', () => {
    expect(r.records.every((x: any) => x.sampleBarcode !== '0001')).toBe(true);
    expect(JSON.stringify(r)).not.toContain('"0001"');
  });

  it('is deterministic and pure (same bytes twice => equal; input bytes untouched)', () => {
    const bytes = enc(PATIENT.join('\r') + '\r');
    const copy = bytes.slice();
    const a = drv().parse(bytes, ctx() as never);
    const b = drv().parse(bytes, ctx() as never);
    expect(a).toEqual(b);
    expect(bytes).toEqual(copy);
  });
});

describe('tolerant result-time position — first 14-digit value among OBX-12, OBX-13, OBX-14 (U item, §3)', () => {
  const withObx = (obx: string) => okParse([MSH_P, PID, OBR_P, obx]).records[0].instrumentResultTimeLocal;
  const A = '20261105101010', B = '20261105202020';
  it('time in OBX-12 only', () => expect(withObx(`OBX|1|NM|HbA1c_NGSP||5.63|%||0||||${A}||||`)).toBe('2026-11-05T10:10:10'));
  it('time in OBX-13 only (patient example)', () => expect(withObx(`OBX|1|NM|HbA1c_NGSP||5.63|%||0|||||${A}||||`)).toBe('2026-11-05T10:10:10'));
  it('time in OBX-14 only (QC example / standard HL7)', () => expect(withObx(`OBX|1|NM|HbA1c_NGSP||5.63|%||0||||||${A}||||`)).toBe('2026-11-05T10:10:10'));
  it('several candidates: the earliest position wins (12 before 13 before 14)', () => {
    expect(withObx(`OBX|1|NM|HbA1c_NGSP||5.63|%||0||||${A}|${B}|${B}|||`)).toBe('2026-11-05T10:10:10');
    expect(withObx(`OBX|1|NM|HbA1c_NGSP||5.63|%||0|||||${A}|${B}|||`)).toBe('2026-11-05T10:10:10');
  });
  it('a non-14-digit value in an earlier position is skipped, not taken', () => {
    expect(withObx(`OBX|1|NM|HbA1c_NGSP||5.63|%||0||||12345|${A}||||`)).toBe('2026-11-05T10:10:10');
    expect(withObx(`OBX|1|NM|HbA1c_NGSP||5.63|%||0||||final|ABCDEFGHIJKLMN|${A}|||`)).toBe('2026-11-05T10:10:10');
  });
  // The addendum gives no patient-time fallback; a fallback to the message time MSH-7 is allowed, any other invented time is not.
  it('no usable time anywhere: the record is still produced; its time is absent or the MSH-7 message time, never invented', () => {
    const res = okParse([MSH_P, PID, OBR_P, 'OBX|1|NM|HbA1c_NGSP||5.63|%||0|||||||||']);
    expect(res.records).toHaveLength(1);
    expect(res.records[0].valueRaw).toBe('5.63');
    expect([undefined, '2026-11-05T17:37:23']).toContain(res.records[0].instrumentResultTimeLocal);
  });
  it('an impossible 14-digit stamp (month 13) is never accepted as a time', () => {
    const res = okParse([MSH_P, PID, OBR_P, 'OBX|1|NM|HbA1c_NGSP||5.63|%||0|||||20261305173723||||']);
    expect(res.records).toHaveLength(1);
    expect(JSON.stringify(res)).not.toContain('2026-13');
    expect([undefined, '2026-11-05T17:37:23']).toContain(res.records[0].instrumentResultTimeLocal);
  });
});

describe('detection_mode_field option — OBR.15 default, metadata only, never a warning (U item, §3)', () => {
  it('OBR-15 = 1 / 2 produce no warnings and do not change the parsed values', () => {
    for (const mode of ['1', '2']) {
      const obr = ['OBR', '1', '0001', 'E2600000042', ...Array<string>(11).fill(''), mode, '', '', ''].join('|'); // mode lands in OBR-15
      const res = okParse([MSH_P, PID, obr, obxP(1, 'HbA1c_NGSP', '5.63', '%')]);
      expect(res.warnings).toEqual([]);
      expect(res.records[0]).toMatchObject({ sampleBarcode: 'E2600000042', valueRaw: '5.63', warnings: [] });
    }
  });
  it('the field is configurable: pointing it elsewhere still parses the same results', () => {
    const base = okParse(PATIENT);
    const moved = okParse(PATIENT, { detection_mode_field: 'OBR.16' });
    expect(moved.records).toEqual(base.records);
    expect(moved.warnings).toEqual([]);
  });
});

describe('M1 chromatogram (§3): ED record becomes exactly one attachment record', () => {
  let r: any;
  beforeAll(() => { r = okParse([MSH_P, PID, OBR_P, obxP(1, 'HbA1c_NGSP', '5.63', '%'), OBX_ED.replace('OBX|11', 'OBX|2')]); });
  it('numeric result stays quantitative; the ED row is one attachment record with the analyte code Chromatogram and the barcode', () => {
    expect(r.records).toHaveLength(2);
    const att = r.records.filter((x: any) => x.recordKind === 'attachment');
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ recordClass: 'patient', sampleBarcode: 'E2600000042', instrumentAnalyteCode: 'Chromatogram', recordKind: 'attachment' });
    expect(r.records[0]).toMatchObject({ recordKind: 'quantitative', valueRaw: '5.63' });
  });
  it('the base64 picture is never echoed into valueRaw (03-IC value_raw <= 200) nor into warnings', () => {
    const att = r.records.find((x: any) => x.recordKind === 'attachment');
    expect(att.valueRaw === undefined || att.valueRaw.length <= 200).toBe(true);
    expect(JSON.stringify(r.warnings)).not.toContain('/9j/');
    expect(att.warnings.join('|')).not.toContain('/9j/');
  });
  it('a 1 MiB-sized picture field does not crash or slow the parse to a crawl', () => {
    const big = `OBX|2|ED|Chromatogram||/9j/${'A'.repeat(1_000_000)}||||||||${T}||||`;
    const t0 = Date.now();
    const res = parse([MSH_P, PID, OBR_P, obxP(1, 'HbA1c_NGSP', '5.63', '%'), big]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.ok).toBe(true);
  });
});

// ================================================================================================================================
describe('M3 QC result (§4)', () => {
  let r: any;
  beforeAll(() => { r = okParse(QC); });

  it('classified as QC from the layout (no PID), never as a patient result; no barcode', () => {
    expect(r).toMatchObject({ ok: true, messageKind: 'results', messageControlId: '1', messageTimeLocal: '2026-11-05T19:05:59' });
    expect(r.records).toHaveLength(5);
    for (const x of r.records) {
      expect(x.recordClass).toBe('qc');
      expect(x.sampleBarcode).toBeUndefined();
    }
  });

  it('OBR-3 batch number is BOTH controlIdRaw and controlLotRaw (03-IC §3.15: 1..64)', () => {
    for (const x of r.records) expect(x).toMatchObject({ controlIdRaw: 'A0926', controlLotRaw: 'A0926' });
  });

  it('level L maps through the default qc_level_map to "low"', () => {
    for (const x of r.records) expect(x.controlLevel).toBe('low');
  });

  it('one QC record per OBX with code/value/unit; literal null OBX-8 => no flag', () => {
    expect(r.records.map((x: any) => [x.instrumentAnalyteCode, x.valueRaw, x.unitRaw])).toEqual([
      ['HbA1c_NGSP', '5.24', '%'], ['HbA1c_IFCC', '33.70', 'mmol/mol'], ['HbF', '0.18', '%'], ['HbA1', '7.15', '%'], ['HbA1c_NGSP', '5.26', '%'],
    ]);
    for (const x of r.records) { expect(x.recordKind).toBe('quantitative'); expect(x.instrumentFlags).toEqual([]); }
  });

  it('result time from OBX-14 (QC layout); rows of one run share a time; a later row keeps its own', () => {
    expect(r.records.slice(0, 4).every((x: any) => x.instrumentResultTimeLocal === '2026-11-05T11:15:37')).toBe(true);
    expect(r.records[4].instrumentResultTimeLocal).toBe('2026-11-05T11:16:37');
  });

  it('no OBX time at all => falls back to OBR-7 (QC time)', () => {
    const res = okParse([MSH_Q, OBR_Q, 'OBX|1|NM|HbA1c_NGSP||5.24|%||null|||||||||']);
    expect(res.records[0].instrumentResultTimeLocal).toBe('2026-11-05T11:15:37');
  });

  it('qc_level_map is configurable; an unmapped letter passes through raw (<= 16)', () => {
    expect(okParse(QC, { qc_level_map: { L: 'level1' } }).records[0].controlLevel).toBe('level1');
    const other = okParse([MSH_Q, OBR_Q.replace('|NGSP|L|', '|NGSP|H|'), obxQ(1, 'HbA1c_NGSP', '5.24', '%')]);
    expect(other.records[0].controlLevel).toBe('H');
  });

  it('MSH-16 is only a hint: QC layout with MSH-16 = 0 or empty is still QC', () => {
    for (const msh of [MSH_Q.replace('||1||UTF-8|||', '||0||UTF-8|||'), MSH_Q.replace('||1||UTF-8|||', '|||||UTF-8|||')]) {
      const res = okParse([msh, OBR_Q, obxQ(1, 'HbA1c_NGSP', '5.24', '%')]);
      expect(res.records[0]).toMatchObject({ recordClass: 'qc', controlIdRaw: 'A0926' });
    }
  });

  it('OBR context fields (reference value, deviation, SD, CV, expiry, project no.) are not leaked as results', () => {
    const out = JSON.stringify(r);
    for (const ctxVal of ['5.2403173', '0.013031356', '0.0024867496', '20270926000000']) expect(out).not.toContain(ctxVal);
  });

  it('a QC batch number over 64 chars skips that record with a constant warning (never truncated, never echoing the input)', () => {
    const long = 'Q'.repeat(65);
    const res = okParse([MSH_Q, OBR_Q.replace('A0926', long), obxQ(1, 'HbA1c_NGSP', '5.24', '%')]);
    expect(res.records).toHaveLength(0);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(res)).not.toContain(long);
  });
});

// ================================================================================================================================
describe('malformed and unknown messages => instruments.message_malformed / other (§8 parse row)', () => {
  const malformed = (r: any) => {
    expect(r).toMatchObject({ ok: false, errorCode: 'instruments.message_malformed' });
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
    return r;
  };

  it('no MSH (PID first) => malformed, reason carries no input content (no PHI)', () => {
    const r = malformed(parse([PID, OBR_P, obxP(1, 'HbA1c_NGSP', '5.63', '%')]));
    for (const phi of ['Test Patient', '2600000123', 'E2600000042', '19880912']) expect(r.reason).not.toContain(phi);
  });
  it('empty input, whitespace only, and a bare newline => malformed', () => {
    malformed(drv().parse(new Uint8Array(0), ctx() as never));
    malformed(drv().parse(enc('   \r\n  '), ctx() as never));
    malformed(drv().parse(enc('\r'), ctx() as never));
  });
  it('MLLP framing bytes or binary garbage in front of nothing parseable => malformed, never a throw', () => {
    malformed(drv().parse(new Uint8Array([0x0b, 0x1c, 0x0d, 0x00, 0xff, 0xfe]), ctx() as never));
  });
  it('MSH with a broken encoding-characters field => malformed', () => {
    malformed(parse(['MSH|ab|Truth|Truth-H80E|||' + T + '||ORU^R01|1|P|2.3', PID, OBR_P]));
    malformed(parse(['MSH|']));
  });
  it('invalid parser_options never make parse throw (malformed result or defaults are both acceptable, a throw is not)', () => {
    expect(() => drv().parse(enc(PATIENT.join('\r')), ctx({ detection_mode_field: 'bogus!', qc_level_map: 7 }) as never)).not.toThrow();
  });
  it('unknown MSH-9 (e.g. ADT^A01) => ok:true, messageKind "other", no records (archived, no events)', () => {
    const r = okParse(['MSH|^~\\&|Truth|Truth-H80E|||' + T + '||ADT^A01|9|P|2.3', PID]);
    expect(r).toMatchObject({ ok: true, messageKind: 'other' });
    expect(r.records).toEqual([]);
  });
  it('a calibration-style message is not interpreted as results (no calibration capability): kind other, no records', () => {
    const r = okParse(['MSH|^~\\&|Truth|Truth-H80E|||' + T + '||CAL^R01|9|P|2.3', 'OBX|1|NM|HbA1c_NGSP||5.63|%||0|||||' + T + '||||']);
    expect(r).toMatchObject({ ok: true, messageKind: 'other' });
    expect(r.records).toEqual([]);
  });
  it('fuzz: 300 deterministic pseudo-random byte strings and truncations of a valid message never throw and never yield a non-conforming shape', () => {
    let seed = 0x9e3779b9;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const valid = enc(PATIENT.join('\r') + '\r');
    for (let i = 0; i < 300; i++) {
      const bytes = i % 2 === 0 ? valid.slice(0, Math.floor(rnd() * valid.length)) : Uint8Array.from({ length: Math.floor(rnd() * 400) }, () => Math.floor(rnd() * 256));
      let r: any;
      expect(() => { r = drv().parse(bytes, ctx() as never); }).not.toThrow();
      expect(typeof r.ok).toBe('boolean');
      if (r.ok) { expect(Array.isArray(r.records)).toBe(true); expect(['results', 'host_query', 'other']).toContain(r.messageKind); }
      else expect(r.errorCode).toBe('instruments.message_malformed');
    }
  });
  it('bounds (03-IC §3.14): barcode > 40 chars skips the record with a warning (never truncated)', () => {
    const res = okParse([MSH_P, PID, 'OBR|1|0001|' + 'E'.repeat(41) + '||||||||||||1||||', obxP(1, 'HbA1c_NGSP', '5.63', '%')]);
    expect(res.records).toHaveLength(0);
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});

// ================================================================================================================================
describe('writer-owned golden files in drivers/truth_h80e/testdata (addendum §8: oru-patient, oru-qc, oru-chromatogram, malformed-no-msh)', () => {
  const need = ['oru-patient', 'oru-qc', 'oru-chromatogram', 'malformed-no-msh'];
  const files = existsSync(TESTDATA) ? readdirSync(TESTDATA) : [];
  const json = (n: string, kind: 'expected' | 'context') => JSON.parse(readFileSync(join(TESTDATA, `${n}.${kind}.json`), 'utf8'));

  it.each(need)('%s has .raw + .context.json + .expected.json', (n) => {
    for (const ext of ['raw', 'context.json', 'expected.json']) expect(files, `${n}.${ext}`).toContain(`${n}.${ext}`);
  });
  it('SOURCE.md exists and declares the data synthetic', () => {
    expect(files).toContain('SOURCE.md');
    expect(readFileSync(join(TESTDATA, 'SOURCE.md'), 'utf8')).toMatch(/synthetic/i);
  });
  it('oru-patient: patient records for barcode E2600000042 with H80E_MARK flags and result times', () => {
    const e = json('oru-patient', 'expected');
    expect(e).toMatchObject({ ok: true, messageKind: 'results' });
    expect(e.records.length).toBeGreaterThanOrEqual(2);
    for (const x of e.records) expect(x).toMatchObject({ recordClass: 'patient', sampleBarcode: 'E2600000042' });
    expect(e.records[0].instrumentFlags).toEqual(['H80E_MARK:0']);
    expect(typeof e.records[0].instrumentResultTimeLocal).toBe('string');
  });
  it('oru-qc: qc records whose controlIdRaw = controlLotRaw and no barcode', () => {
    const e = json('oru-qc', 'expected');
    expect(e.ok).toBe(true);
    expect(e.records.length).toBeGreaterThanOrEqual(2);
    for (const x of e.records) {
      expect(x.recordClass).toBe('qc');
      expect(x.controlIdRaw).toBeTruthy();
      expect(x.controlLotRaw).toBe(x.controlIdRaw);
      expect(x.sampleBarcode).toBeUndefined();
    }
  });
  it('oru-chromatogram: exactly one attachment record', () => {
    const e = json('oru-chromatogram', 'expected');
    expect(e.ok).toBe(true);
    expect(e.records.filter((x: any) => x.recordKind === 'attachment')).toHaveLength(1);
  });
  it('malformed-no-msh: ok:false instruments.message_malformed', () => {
    expect(json('malformed-no-msh', 'expected')).toMatchObject({ ok: false, errorCode: 'instruments.message_malformed' });
  });
  it('context files carry the five golden-runner keys and the instrument timezone Asia/Kathmandu for the result goldens', () => {
    for (const n of need) {
      const c = json(n, 'context');
      for (const k of ['receivedAt', 'capturedAt', 'instrumentTimezone', 'qcSampleIdPatterns', 'options']) expect(c, `${n}.context.json`).toHaveProperty(k);
    }
    expect(json('oru-patient', 'context').instrumentTimezone).toBe('Asia/Kathmandu');
  });
  it('AC-21.4: the whole testdata dir passes the synthetic-scan (so PID-5 stays empty there; PHI-ignore is proven by the inline cases above)', () => {
    expect(existsSync(TESTDATA)).toBe(true);
    expect(scanSyntheticData([TESTDATA])).toEqual({ ok: true, violations: [] });
  });
  it('no real-looking identifiers: every barcode in the goldens matches the synthetic E26000000nn pattern', () => {
    for (const f of files.filter((x) => x.endsWith('.raw'))) {
      const txt = readFileSync(join(TESTDATA, f), 'utf8');
      for (const m of txt.matchAll(/OBR\|[^|]*\|[^|]*\|([^|]*)\|/g)) {
        const bc = m[1]!;
        if (bc.startsWith('E')) expect(bc).toMatch(/^E26\d{8}$/);
      }
    }
  });
});
