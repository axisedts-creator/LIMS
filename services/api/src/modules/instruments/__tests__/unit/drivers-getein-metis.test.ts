// C7 MET-T02 — server driver getein_metis: parse patient + QC results, calibration as `other` (09-ADDENDUM-GETEIN-METIS §2, §3, §4, §8). Tests first; synthetic data only.
// LD-163 (2026-11-14; the addendum header says LD-162, that number belongs to C17 HC-T17): every value marked U (U1..U15) is a configurable default or a tolerant parse,
// never a hard-coded guess; the driver stays status `generic` (host query inert) until the commissioning checklist is signed and a reviewed migration promotes it.
// D-MET-2: calibration (MSH-16 = 1) is archived as messageKind `other`, no records, so no events. Patient name, date of birth and sex never reach the output.
// Messages are built inline from the addendum layouts (tester-owned, independent of the writer's drivers/getein_metis/testdata, which the generic golden runner
// drivers-golden.test.ts also executes automatically once the directory exists). Expectations use toMatchObject: unlisted fields are free.
// Field counting: HL7 MSH-1 is the '|' itself, so MSH-7 = send time, MSH-9 = type, MSH-10 = control id, MSH-16 = the type flag (0 patient, 1 calibration, 2 QC).
// SEAMS (spec gaps, chosen here, flagged in .orchestra/notes/MET-T02-tests.md):
//   * QC recordKind = quantitative when OBR-20 is numeric (as H80E); the entry's time = OBR-7; an unmapped level passes through raw (as H80E).
//   * A patient result without OBR-2 keeps its record with no sampleBarcode (the pipeline then marks it skipped_no_barcode, 02-TRD §6.4); a barcode > 40 skips the record with a warning.
//   * Host query (QRY^Q02 / QCK / DSR) is MET-T03, not asserted here.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { beforeAll, describe, expect, it } from 'vitest';
import { AJV_OPTIONS } from '../../../../core/openapi.js';
import { getDriver, listDrivers } from '../../drivers/registry.js';
import { scanSyntheticData } from '../ci/synthetic-scan.js';

const DRIVER_DIR = fileURLToPath(new URL('../../drivers/getein_metis/', import.meta.url));
const TESTDATA = join(DRIVER_DIR, 'testdata');
const enc = (s: string) => new TextEncoder().encode(s);
const ctx = (options: Record<string, unknown> = {}) => ({
  receivedAt: '2026-11-14T04:20:00.000Z', capturedAt: '2026-11-14T04:20:00.000Z', instrumentTimezone: 'Asia/Kathmandu',
  qcSampleIdPatterns: [/^QC-/], options,
});
const drv = () => getDriver('getein_metis')!;
const parse = (segments: string[], options: Record<string, unknown> = {}): any => drv().parse(enc(segments.join('\r') + '\r'), ctx(options) as never);
const okParse = (segments: string[], options: Record<string, unknown> = {}): any => {
  const r = parse(segments, options);
  if (!r.ok) throw new Error(`expected ok parse, got ${JSON.stringify(r)}`);
  return r;
};
const allWarnings = (r: any): string[] => [...r.warnings, ...r.records.flatMap((x: any) => x.warnings)];

// ---- addendum §3 (patient) and §4 (QC) layouts, field for field -------------------------------------------------------------------------
const BARCODE = 'MT2600000042';
const MSH = (ctrl: string, t: string, flag: string, charset = 'UTF8') => `MSH|^~\\&|GP|Metis|||${t}||ORU^R01|${ctrl}|P|2.3.1||||${flag}||${charset}|||`;
const MSH_P = MSH('57', '20261114093015', '0');
const PID = 'PID|1|V000123|||Test Patient||19880912000000|F';
const OBR_P = `OBR|1|${BARCODE}|7|^|N|20261114085510|20261114092940|||||||20261114085730|serum`;
// OBX: 1 seq, 2 type, 3 item id, 4 abbreviation, 5 value, 6 unit, 7 range, 8 flags, 9 qualitative, 11 F, 13 raw, 14 test time, 17 retest
const obx = (o: { n: number; type?: string; id?: string; abbr?: string; v?: string; unit?: string; range?: string; flag?: string; qual?: string; raw?: string; time?: string; retest?: string }) =>
  `OBX|${o.n}|${o.type ?? 'NM'}|${o.id ?? ''}|${o.abbr ?? ''}|${o.v ?? ''}|${o.unit ?? ''}|${o.range ?? ''}|${o.flag ?? ''}|${o.qual ?? ''}||F||${o.raw ?? ''}|${o.time ?? ''}|||${o.retest ?? ''}`;
const OBX1 = obx({ n: 1, id: '0', abbr: 'ALT', v: '31.2', unit: 'U/L', range: '0-40', flag: 'N', raw: '31.2', time: '20261114093001', retest: '0' });
const OBX2 = obx({ n: 2, id: '1', abbr: 'AST', v: '44.8', unit: 'U/L', range: '0-40', flag: 'H~A', raw: '44.8', retest: '0' }); // OBX-14 empty -> OBR-7
const OBX3 = obx({ n: 3, type: 'ST', id: '1112', abbr: 'CoV2Ag', v: 'Negative', qual: '-', time: '20261114093010', retest: '1' });
const PATIENT = [MSH_P, PID, OBR_P, OBX1, OBX2, OBX3];
const patientWith = (...rows: string[]) => [MSH_P, PID, OBR_P, ...rows];

const MSH_Q = MSH('58', '20261114101502', '2');
const QC_T = '20261114101455';
// OBR: 2 item no, 3 item name, 7 QC time, 11 count, 12 numbers, 13 control names, 14/15 lot + expiry (either order, U12), 17 levels, 18 target, 19 SD, 20 measured, 21 unit
const obrQ = (o: { item?: string; name?: string; names?: string; a14?: string; a15?: string; levels?: string; target?: string; sd?: string; measured?: string; unit?: string; t?: string } = {}) =>
  `OBR|1|${o.item ?? '7'}|${o.name ?? 'AST'}|^|||${o.t ?? QC_T}||||2|1^2|${o.names ?? 'QCSYN1^QCSYN2'}|${o.a14 ?? 'LOT111^LOT222'}|${o.a15 ?? '20300101^20300101'}||${o.levels ?? 'L^H'}|${o.target ?? '45.0^120.0'}|${o.sd ?? '4.5^9.0'}|${o.measured ?? '44.1^123.4'}|${o.unit ?? 'U/L'}`;
const QC = [MSH_Q, obrQ()];

// ================================================================================================================================
describe('registry entry — addendum §8 property table', () => {
  it('getein_metis is registered once: version 0.1.0, hl7v2, status generic (never verified), manualRef as specified', () => {
    expect(listDrivers().filter((d) => d.code === 'getein_metis')).toHaveLength(1);
    expect(drv()).toBeDefined();
    expect(drv()).toMatchObject({ code: 'getein_metis', version: '0.1.0', protocol: 'hl7v2', status: 'generic' });
    expect(drv().manualRef).toEqual({
      title: 'HL7 Communication Protocol (Applicable to Metis Series Analyzers)',
      documentId: 'getein-metis-hl7-communication-protocol', revision: 'unversioned',
    });
  });

  it('capabilities: upload, host query (inert while generic), qc; NO worklist, NO attachments, NO calibration', () => {
    expect(drv().capabilities).toEqual({ resultUpload: true, hostQuery: true, worklistDownload: false, qc: true, attachments: false, calibration: false });
  });

  it('the registry entry cannot be promoted at runtime (frozen), and the Truth H80E entry is still there unchanged', () => {
    const d = drv() as { status: string };
    try { d.status = 'verified'; } catch { /* strict-mode TypeError on a frozen object is fine */ }
    expect(drv().status).toBe('generic');
    expect(getDriver('truth_h80e')).toMatchObject({ code: 'truth_h80e', version: '0.1.0', status: 'generic' });
  });
});

describe('optionsSchema — addendum §8', () => {
  const s = () => drv().optionsSchema as any;
  const factory = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => (v: unknown) => boolean;
  // AJV_OPTIONS = the project validator (removeAdditional:false, REQ-SEC-080); see .orchestra/notes/H80-T02-ruling.md
  const valid = (v: unknown) => factory({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, strict: false, allErrors: true } })({ schema: s() })(v);

  it('strict object, no required keys, lists exactly the five documented options', () => {
    expect(s().type).toBe('object');
    expect(s().additionalProperties).toBe(false);
    expect(s().required ?? []).toEqual([]);
    expect(Object.keys(s().properties).sort()).toEqual(['dsr_item_details', 'name_script', 'qc_level_map', 'specimen_type_map', 'type_flag_field']);
  });

  it('documented defaults: type_flag_field MSH.16, qc_level_map {L: low, M: mid, H: high}, name_script as_registered, dsr_item_details id_only', () => {
    const p = s().properties;
    expect(p.type_flag_field.default).toBe('MSH.16');
    expect(p.qc_level_map.default).toEqual({ L: 'low', M: 'mid', H: 'high' });
    expect(p.name_script.default).toBe('as_registered');
    expect(p.dsr_item_details.default).toBe('id_only');
  });

  it('accepts {} and each documented value; rejects unknown keys and out-of-set values', () => {
    expect(valid({})).toBe(true);
    expect(valid({ type_flag_field: 'MSH.17', name_script: 'latin_if_available', dsr_item_details: 'full', qc_level_map: { L: 'low', H: 'high' }, specimen_type_map: { 'whole blood': 'blood' } })).toBe(true);
    expect(valid({ bogus: 1 })).toBe(false);
    expect(valid({ name_script: 'klingon' })).toBe(false);
    expect(valid({ dsr_item_details: 'verbose' })).toBe(false);
    expect(valid({ type_flag_field: 'not a field ref' })).toBe(false);
    expect(valid({ qc_level_map: 'L=low' })).toBe(false);
    expect(valid({ specimen_type_map: 'serum' })).toBe(false);
  });
});

// ================================================================================================================================
describe('M1 patient result (§3) — golden-style parse', () => {
  let r: any;
  beforeAll(() => { r = okParse(PATIENT); }); // not at describe level: a missing driver must fail each test, not the whole file at collection

  it('message level: results, control id from MSH-10, send time from MSH-7 as local time', () => {
    expect(r).toMatchObject({ ok: true, messageKind: 'results', messageControlId: '57', messageTimeLocal: '2026-11-14T09:30:15' });
  });

  it('one patient record per OBX, in order, all with the OBR-2 barcode and no control fields', () => {
    expect(r.records).toHaveLength(3);
    expect(r.records.map((x: any) => x.recordSeq)).toEqual([1, 2, 3]);
    for (const x of r.records) expect(x).toMatchObject({ recordClass: 'patient', sampleBarcode: BARCODE });
    expect(r.records.every((x: any) => x.controlIdRaw === undefined && x.controlLotRaw === undefined && x.controlLevel === undefined)).toBe(true);
  });

  it('analyte code = OBX-3 (the item id), value = OBX-5, unit = OBX-6; NM is quantitative, ST is qualitative', () => {
    expect(r.records[0]).toMatchObject({ instrumentAnalyteCode: '0', valueRaw: '31.2', unitRaw: 'U/L', recordKind: 'quantitative' });
    expect(r.records[1]).toMatchObject({ instrumentAnalyteCode: '1', valueRaw: '44.8', unitRaw: 'U/L', recordKind: 'quantitative' });
    expect(r.records[2]).toMatchObject({ instrumentAnalyteCode: '1112', valueRaw: 'Negative', recordKind: 'qualitative' });
  });

  it('result time per row: OBX-14, else OBR-7 (the second row has an empty OBX-14), as local time', () => {
    expect(r.records[0].instrumentResultTimeLocal).toBe('2026-11-14T09:30:01');
    expect(r.records[1].instrumentResultTimeLocal).toBe('2026-11-14T09:29:40');
    expect(r.records[2].instrumentResultTimeLocal).toBe('2026-11-14T09:30:10');
  });

  it('OBX-8 -> METIS_FLAG:<v>, several joined with ~ become several flags; empty OBX-8 -> none; never decides abnormal/critical', () => {
    expect(r.records[0].instrumentFlags).toEqual(['METIS_FLAG:N']);
    expect([...r.records[1].instrumentFlags].sort()).toEqual(['METIS_FLAG:A', 'METIS_FLAG:H']);
    expect(r.records[2].instrumentFlags.filter((f: string) => f.startsWith('METIS_FLAG:'))).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/abnormal|critical/i);
  });

  it('OBX-17 retest flag: 1 -> METIS_RETEST, 0 -> no flag', () => {
    expect(r.records[2].instrumentFlags).toContain('METIS_RETEST');
    expect(r.records[0].instrumentFlags).not.toContain('METIS_RETEST');
    expect(r.records[1].instrumentFlags).not.toContain('METIS_RETEST');
  });

  it('a retest and its original are two separate records (U13: C5 decides which counts)', () => {
    const res = okParse(patientWith(
      obx({ n: 1, id: '0', abbr: 'ALT', v: '31.2', unit: 'U/L', time: '20261114093001', retest: '0' }),
      obx({ n: 2, id: '0', abbr: 'ALT', v: '30.9', unit: 'U/L', time: '20261114093501', retest: '1' })));
    expect(res.records.map((x: any) => [x.valueRaw, x.instrumentFlags.includes('METIS_RETEST')])).toEqual([['31.2', false], ['30.9', true]]);
  });

  it('no warnings on a clean message', () => {
    expect(r.warnings).toEqual([]);
    for (const x of r.records) expect(x.warnings).toEqual([]);
  });

  it('OBR-3 (instrument sample number), OBR-15 (sample type) and the reference range are context only: never a barcode, code or value', () => {
    const out = JSON.stringify(r);
    expect(r.records.every((x: any) => x.sampleBarcode === BARCODE)).toBe(true);
    expect(out).not.toContain('"0-40"');
    expect(out).not.toContain('serum');
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

describe('patient result — PHI minimisation (§3 table; 07-SECURITY): PID-2, PID-5, PID-7, PID-8 and OBR-16 never copied', () => {
  it('name, date of birth, patient id and sex never appear anywhere in the parse result', () => {
    const out = JSON.stringify(okParse([MSH_P, 'PID|1|V000123|||Test Patient||19880912000000|F', OBR_P + '|||Dr Sender', OBX1]));
    for (const phi of ['Test Patient', '19880912', 'V000123', 'Dr Sender']) expect(out).not.toContain(phi);
    expect(out).not.toMatch(/"(sex|gender|dob|dateOfBirth|birth\w*|patient_?(name|id)|name)"/i);
  });
  it('a Devanagari name (U10) parses and is not copied either', () => {
    const out = JSON.stringify(okParse([MSH_P, 'PID|1|V000123|||परीक्षण रोगी||19880912000000|O', OBR_P, OBX1]));
    expect(out).not.toContain('परीक्षण');
    expect(out).toContain(BARCODE);
  });
  it('PID content does not change the result: with and without PID give equal records', () => {
    expect(okParse([MSH_P, PID, OBR_P, OBX1, OBX2]).records).toEqual(okParse([MSH_P, 'PID|1', OBR_P, OBX1, OBX2]).records);
  });
  it('a QC message never copies PID content either, even if a PID is present', () => {
    const out = JSON.stringify(okParse([MSH_Q, PID, obrQ()]));
    for (const phi of ['Test Patient', '19880912', 'V000123']) expect(out).not.toContain(phi);
  });
});

describe('patient result — tolerant handling of every U item (§3)', () => {
  const time = (o: Parameters<typeof obx>[0], obr = OBR_P) => okParse([MSH_P, PID, obr, obx(o)]).records[0].instrumentResultTimeLocal;
  const base = { n: 1, id: '0', abbr: 'ALT', v: '31.2', unit: 'U/L' };

  it('U4 time format: OBX-14 as "YYYY/MM/DD HH:mm:ss" (manual text) equals the 14-digit form', () => {
    expect(time({ ...base, time: '2026/11/14 09:30:01' })).toBe('2026-11-14T09:30:01');
    expect(time({ ...base, time: '20261114093001' })).toBe('2026-11-14T09:30:01');
  });
  it('U4 time format: OBR-7 in the slash form works as the fallback too (and OBR-6 never replaces OBR-7)', () => {
    const obr = `OBR|1|${BARCODE}|7|^|N|2026/11/14 08:55:10|2026/11/14 09:29:40|||||||20261114085730|serum`;
    expect(time(base, obr)).toBe('2026-11-14T09:29:40');
  });
  it('time fallback chain: OBX-14, else OBR-7, else MSH-7 (both empty -> the message time, never invented)', () => {
    const obrNoTime = `OBR|1|${BARCODE}|7|^|N|||||||||||serum`;
    expect(time(base, obrNoTime)).toBe('2026-11-14T09:30:15');
  });
  it('an impossible stamp (month 13) in OBX-14 is never accepted as a time', () => {
    const res = okParse([MSH_P, PID, OBR_P, obx({ ...base, time: '20261314093001' })]);
    expect(res.records).toHaveLength(1);
    expect(JSON.stringify(res)).not.toContain('2026-13');
    expect(['2026-11-14T09:29:40', '2026-11-14T09:30:15']).toContain(res.records[0].instrumentResultTimeLocal);
  });
  it('U5: OBX-3 wins over OBX-4 when both are present and differ — and that is not a warning', () => {
    const res = okParse(patientWith(obx({ ...base, id: '0', abbr: 'SOMETHING_ELSE', time: '20261114093001' })));
    expect(res.records[0].instrumentAnalyteCode).toBe('0');
    expect(allWarnings(res)).toEqual([]);
  });
  it('U5: OBX-3 empty and OBX-4 present -> OBX-4 becomes the code, with a warning', () => {
    const res = okParse(patientWith(obx({ ...base, id: '', abbr: 'ALT', time: '20261114093001' })));
    expect(res.records).toHaveLength(1);
    expect(res.records[0].instrumentAnalyteCode).toBe('ALT');
    expect(allWarnings(res).length).toBeGreaterThan(0);
  });
  it('OBX-5 is kept as received: Error, ">" / "<" prefixed values are never "fixed"', () => {
    const res = okParse(patientWith(
      obx({ ...base, n: 1, v: 'Error' }), obx({ ...base, n: 2, v: '>1500' }), obx({ ...base, n: 3, v: '<0.5' })));
    expect(res.records.map((x: any) => x.valueRaw)).toEqual(['Error', '>1500', '<0.5']);
    expect(res.records.every((x: any) => x.recordKind === 'quantitative')).toBe(true); // OBX-2 NM decides the kind
  });
  it('ST row with an empty OBX-5: valueRaw = OBX-9 (-, +, +-); with OBX-5 present OBX-9 is only context', () => {
    const res = okParse(patientWith(
      obx({ n: 1, type: 'ST', id: '1112', abbr: 'CoV2Ag', qual: '-' }), obx({ n: 2, type: 'ST', id: '1112', abbr: 'CoV2Ag', qual: '+' }),
      obx({ n: 3, type: 'ST', id: '1112', abbr: 'CoV2Ag', qual: '+-' }), obx({ n: 4, type: 'ST', id: '1112', abbr: 'CoV2Ag', v: 'Positive', qual: '+' })));
    expect(res.records.map((x: any) => x.valueRaw)).toEqual(['-', '+', '+-', 'Positive']);
    expect(res.records.every((x: any) => x.recordKind === 'qualitative')).toBe(true);
  });
  it('charset UTF8 (the manual) and UTF-8 parse identically; trailing pipes and CRLF line ends are fine', () => {
    const a = okParse([MSH('57', '20261114093015', '0', 'UTF8'), PID, OBR_P, OBX1]);
    const b = okParse([MSH('57', '20261114093015', '0', 'UTF-8'), PID, OBR_P, OBX1]);
    expect(a).toEqual(b);
    const crlf = drv().parse(enc([MSH_P, PID, OBR_P, OBX1].join('\r\n') + '\r\n'), ctx() as never);
    expect(crlf).toEqual(a);
  });
  it('MSH-3 / MSH-4 (the manual disagrees with its own example on which holds the model) are never used: swapped or blank gives equal records', () => {
    const swapped = MSH_P.replace('|GP|Metis|', '|Metis|GP|');
    const blank = MSH_P.replace('|GP|Metis|', '|||');
    const ref = okParse([MSH_P, PID, OBR_P, OBX1]).records;
    expect(okParse([swapped, PID, OBR_P, OBX1]).records).toEqual(ref);
    expect(okParse([blank, PID, OBR_P, OBX1]).records).toEqual(ref);
  });
  it('no OBR-2 (empty barcode): the record is still produced, with no sampleBarcode (pipeline marks it skipped_no_barcode, 02-TRD §6.4)', () => {
    const res = okParse([MSH_P, PID, `OBR|1||0007|^|N|20261114085510|20261114092940`, OBX1]);
    expect(res.records).toHaveLength(1);
    expect(res.records[0].sampleBarcode).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('"0007"'); // OBR-3 (instrument sample number) is never promoted to a barcode
  });
});

describe('message classifier (§2): MSH-16 first, PID fallback when blank, option type_flag_field', () => {
  const rows = [OBR_P, OBX1];
  it('MSH-16 = 0 -> patient results', () => {
    expect(okParse([MSH('1', '20261114093015', '0'), PID, ...rows]).records[0].recordClass).toBe('patient');
  });
  it('MSH-16 blank + PID present -> patient', () => {
    const r = okParse([MSH('1', '20261114093015', ''), PID, ...rows]);
    expect(r).toMatchObject({ messageKind: 'results' });
    expect(r.records[0]).toMatchObject({ recordClass: 'patient', sampleBarcode: BARCODE });
  });
  it('MSH-16 blank + no PID -> other: archived, no records', () => {
    const r = okParse([MSH('1', '20261114093015', ''), ...rows]);
    expect(r).toMatchObject({ ok: true, messageKind: 'other' });
    expect(r.records).toEqual([]);
  });
  it('MSH-16 = 2 wins over a PID: the message is QC and never a patient result', () => {
    const r = okParse([MSH_Q, PID, obrQ()]);
    expect(r.records.length).toBeGreaterThan(0);
    for (const x of r.records) { expect(x.recordClass).toBe('qc'); expect(x.sampleBarcode).toBeUndefined(); }
  });
  it('MSH-16 = 0 wins over a missing PID: still patient', () => {
    expect(okParse([MSH('1', '20261114093015', '0'), ...rows]).records[0].recordClass).toBe('patient');
  });
  it('type_flag_field option moves the flag: MSH.17 carries the 2 -> QC; without the option the same bytes are "other"', () => {
    const msh17 = 'MSH|^~\\&|GP|Metis|||20261114101502||ORU^R01|58|P|2.3.1|||||2|UTF8|||';
    const withOpt = okParse([msh17, obrQ()], { type_flag_field: 'MSH.17' });
    expect(withOpt.records.length).toBe(2);
    expect(withOpt.records.every((x: any) => x.recordClass === 'qc')).toBe(true);
    expect(okParse([msh17, obrQ()])).toMatchObject({ messageKind: 'other', records: [] });
  });
});

// ================================================================================================================================
describe('D-MET-2 calibration (MSH-16 = 1): archived as other, no records, so no events', () => {
  const MSH_C = MSH('59', '20261114111500', '1');
  const CAL_OBR = 'OBR|1|7|AST|^|||20261114111000||||2|1^2|CALSYN1^CALSYN2|LOT111^LOT222|20300101^20300101||L^H|45.0^120.0|4.5^9.0|44.1^123.4|U/L';
  it('calibration ORU with OBR data: ok, messageKind other, no records of any class', () => {
    const r = okParse([MSH_C, CAL_OBR]);
    expect(r).toMatchObject({ ok: true, messageKind: 'other' });
    expect(r.records).toEqual([]);
  });
  it('calibration with PID and OBX rows still yields nothing (MSH-16 = 1 beats the PID fallback)', () => {
    const r = okParse([MSH_C, PID, OBR_P, OBX1, OBX2]);
    expect(r).toMatchObject({ ok: true, messageKind: 'other' });
    expect(r.records).toEqual([]);
  });
  it('never a "calibrator" record (capability calibration is false)', () => {
    expect(JSON.stringify(okParse([MSH_C, CAL_OBR]))).not.toContain('calibrator');
  });
});

// ================================================================================================================================
describe('M3 QC result (§4)', () => {
  let r: any;
  beforeAll(() => { r = okParse(QC); });

  it('classified from MSH-16 = 2: results message, never a patient result, no barcode, control id from MSH-10', () => {
    expect(r).toMatchObject({ ok: true, messageKind: 'results', messageControlId: '58', messageTimeLocal: '2026-11-14T10:15:02' });
    for (const x of r.records) { expect(x.recordClass).toBe('qc'); expect(x.sampleBarcode).toBeUndefined(); }
  });

  it('one QC record per control entry (the ^ list in OBR-13), in order', () => {
    expect(r.records).toHaveLength(2);
    expect(r.records.map((x: any) => x.recordSeq)).toEqual([1, 2]);
    expect(r.records.map((x: any) => x.controlIdRaw)).toEqual(['QCSYN1', 'QCSYN2']);
  });

  it('analyte code = OBR-2, value = the entry of OBR-20, unit = OBR-21, time = OBR-7, quantitative for a numeric value', () => {
    expect(r.records[0]).toMatchObject({ instrumentAnalyteCode: '7', valueRaw: '44.1', unitRaw: 'U/L', instrumentResultTimeLocal: '2026-11-14T10:14:55', recordKind: 'quantitative' });
    expect(r.records[1]).toMatchObject({ instrumentAnalyteCode: '7', valueRaw: '123.4', unitRaw: 'U/L', instrumentResultTimeLocal: '2026-11-14T10:14:55', recordKind: 'quantitative' });
  });

  it('U12 lot vs expiry told apart by content: the example order (lot in OBR-14) and the manual-table order (expiry in OBR-14) give the same lots', () => {
    const exampleOrder = okParse([MSH_Q, obrQ({ a14: 'LOT111^LOT222', a15: '20300101^20300101' })]);
    const tableOrder = okParse([MSH_Q, obrQ({ a14: '20300101^20300101', a15: 'LOT111^LOT222' })]);
    expect(exampleOrder.records.map((x: any) => x.controlLotRaw)).toEqual(['LOT111', 'LOT222']);
    expect(tableOrder.records.map((x: any) => x.controlLotRaw)).toEqual(['LOT111', 'LOT222']);
    expect(tableOrder.records).toEqual(exampleOrder.records);
  });
  it('U12 expiry forms: 8 or 14 digits starting with 19 or 20 are an expiry; any other value is the lot', () => {
    const lots = (a14: string, a15: string) => okParse([MSH_Q, obrQ({ names: 'QCSYN1', levels: 'L', target: '45.0', sd: '4.5', measured: '44.1', a14, a15 })]).records[0].controlLotRaw;
    expect(lots('LOT111', '20300101')).toBe('LOT111');
    expect(lots('20300101000000', 'LOT111')).toBe('LOT111');
    expect(lots('19991231', 'LOT111')).toBe('LOT111');
    expect(lots('30123456', '20300101')).toBe('30123456'); // 8 digits but starts with 30: a lot, not an expiry
  });

  it('the expiry date is never reported as the lot or anywhere else in the output', () => {
    const out = JSON.stringify(r);
    expect(out).not.toContain('20300101');
    expect(out).not.toContain('45.0');
    expect(out).not.toContain('120.0');
  });

  it('level L/M/H maps through the default qc_level_map to low/mid/high; the option is configurable; an unmapped value passes through raw (<= 16)', () => {
    const three = okParse([MSH_Q, obrQ({ names: 'C1^C2^C3', a14: 'LOT1^LOT2^LOT3', a15: '20300101^20300101^20300101', levels: 'L^M^H', target: '1^2^3', sd: '1^2^3', measured: '1.1^2.2^3.3' })]);
    expect(three.records.map((x: any) => x.controlLevel)).toEqual(['low', 'mid', 'high']);
    expect(three.records).toHaveLength(3);
    const custom = okParse([MSH_Q, obrQ()], { qc_level_map: { L: 'level1', H: 'level3' } });
    expect(custom.records.map((x: any) => x.controlLevel)).toEqual(['level1', 'level3']);
    const numeric = okParse([MSH_Q, obrQ({ levels: '5^30' })]);
    expect(numeric.records.map((x: any) => x.controlLevel)).toEqual(['5', '30']);
  });

  it('a single control entry (no ^ anywhere) is one record', () => {
    const one = okParse([MSH_Q, obrQ({ names: 'QCSYN1', a14: 'LOT111', a15: '20300101', levels: 'M', target: '80.0', sd: '8.0', measured: '79.5' })]);
    expect(one.records).toHaveLength(1);
    expect(one.records[0]).toMatchObject({ recordClass: 'qc', controlIdRaw: 'QCSYN1', controlLotRaw: 'LOT111', controlLevel: 'mid', valueRaw: '79.5' });
  });

  it('abnormal QC value Error or -1 is stored as received with the flag METIS_QC_ERROR; a normal entry has no such flag', () => {
    const res = okParse([MSH_Q, obrQ({ measured: '44.1^Error' })]);
    expect(res.records[0].instrumentFlags).not.toContain('METIS_QC_ERROR');
    expect(res.records[1].valueRaw).toBe('Error');
    expect(res.records[1].instrumentFlags).toContain('METIS_QC_ERROR');
    const neg = okParse([MSH_Q, obrQ({ measured: '-1^123.4' })]);
    expect(neg.records[0].valueRaw).toBe('-1');
    expect(neg.records[0].instrumentFlags).toContain('METIS_QC_ERROR');
    expect(neg.records[1].instrumentFlags).not.toContain('METIS_QC_ERROR');
  });

  it('no warnings on a clean QC message', () => {
    expect(allWarnings(r)).toEqual([]);
  });

  it('a control name over 64 chars skips that entry with a constant warning (never truncated, never echoing the input)', () => {
    const long = 'Q'.repeat(65);
    const res = okParse([MSH_Q, obrQ({ names: long, a14: 'LOT111', a15: '20300101', levels: 'L', target: '45.0', sd: '4.5', measured: '44.1' })]);
    expect(res.records).toHaveLength(0);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(res)).not.toContain(long);
  });
});

describe('QC lists of different length => instruments.message_malformed (no guessing which entry is which)', () => {
  const malformed = (r: any) => {
    expect(r).toMatchObject({ ok: false, errorCode: 'instruments.message_malformed' });
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
    return r;
  };
  it.each([
    ['OBR-13 control names', { names: 'QCSYN1' }],
    ['OBR-17 levels', { levels: 'L' }],
    ['OBR-18 targets', { target: '45.0' }],
    ['OBR-19 standard deviations', { sd: '4.5' }],
    ['OBR-20 measured values', { measured: '44.1' }],
  ])('%s shorter than the others', (_n, o) => {
    malformed(parse([MSH_Q, obrQ(o)]));
  });
  it('one list longer than the others is malformed too', () => {
    malformed(parse([MSH_Q, obrQ({ measured: '44.1^123.4^99.9' })]));
  });
  it('the whole message is rejected, not just the odd entry: no records come back', () => {
    const r = parse([MSH_Q, obrQ({ levels: 'L' })]);
    expect(r.ok).toBe(false);
    expect(r.records).toBeUndefined();
  });
  it('the reason carries no input content', () => {
    const r = malformed(parse([MSH_Q, obrQ({ names: 'QCSYN1', measured: '44.1^123.4' })]));
    for (const s of ['QCSYN1', '44.1', '123.4', 'LOT111']) expect(r.reason).not.toContain(s);
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
    const r = malformed(parse([PID, OBR_P, OBX1]));
    for (const phi of ['Test Patient', 'V000123', BARCODE, '19880912']) expect(r.reason).not.toContain(phi);
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
    malformed(parse(['MSH|ab|GP|Metis|||20261114093015||ORU^R01|57|P|2.3.1', PID, OBR_P]));
    malformed(parse(['MSH|']));
  });
  it('invalid parser_options never make parse throw (malformed result or defaults are both acceptable, a throw is not)', () => {
    expect(() => drv().parse(enc(PATIENT.join('\r')), ctx({ type_flag_field: 'bogus!', qc_level_map: 7 }) as never)).not.toThrow();
  });
  it('unknown MSH-9 (e.g. ADT^A01) => ok:true, messageKind "other", no records (archived, no events)', () => {
    const r = okParse(['MSH|^~\\&|GP|Metis|||20261114093015||ADT^A01|9|P|2.3.1', PID]);
    expect(r).toMatchObject({ ok: true, messageKind: 'other' });
    expect(r.records).toEqual([]);
  });
  it('an ORU with no OBX rows is ok with no records (nothing to emit), not malformed', () => {
    const r = okParse([MSH_P, PID, OBR_P]);
    expect(r).toMatchObject({ ok: true, messageKind: 'results' });
    expect(r.records).toEqual([]);
  });
  it('fuzz: 300 deterministic pseudo-random byte strings and truncations of valid patient/QC messages never throw and never yield a non-conforming shape', () => {
    let seed = 0x9e3779b9;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const valids = [enc(PATIENT.join('\r') + '\r'), enc(QC.join('\r') + '\r')];
    for (let i = 0; i < 300; i++) {
      const valid = valids[i % 2 === 0 ? 0 : 1]!;
      const bytes = i % 3 === 0 ? Uint8Array.from({ length: Math.floor(rnd() * 400) }, () => Math.floor(rnd() * 256)) : valid.slice(0, Math.floor(rnd() * valid.length));
      let r: any;
      expect(() => { r = drv().parse(bytes, ctx() as never); }).not.toThrow();
      expect(typeof r.ok).toBe('boolean');
      if (r.ok) { expect(Array.isArray(r.records)).toBe(true); expect(['results', 'host_query', 'other']).toContain(r.messageKind); }
      else expect(r.errorCode).toBe('instruments.message_malformed');
    }
  });
  it('bounds (03-IC §3.14): barcode > 40 chars skips the record with a warning (never truncated, never echoed)', () => {
    const long = 'M'.repeat(41);
    const res = okParse([MSH_P, PID, `OBR|1|${long}|7|^|N`, OBX1]);
    expect(res.records).toHaveLength(0);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(res)).not.toContain(long);
  });
  it('bounds: analyte code > 64 chars and value > 200 chars each skip only their own row, with a warning', () => {
    const res = okParse(patientWith(
      obx({ n: 1, id: 'X'.repeat(65), v: '1' }), obx({ n: 2, id: '0', v: '9'.repeat(201) }), obx({ n: 3, id: '1', abbr: 'AST', v: '44.8', unit: 'U/L' })));
    expect(res.records.map((x: any) => x.instrumentAnalyteCode)).toEqual(['1']);
    expect(allWarnings(res).length).toBeGreaterThan(0);
  });
});

// ================================================================================================================================
describe('writer-owned golden files in drivers/getein_metis/testdata (addendum §8)', () => {
  const need = ['oru-patient', 'oru-patient-qualitative', 'oru-patient-empty-obx-time', 'oru-qc', 'oru-qc-lists-differ', 'oru-calibration', 'malformed-no-msh'];
  const files = existsSync(TESTDATA) ? readdirSync(TESTDATA) : [];
  const text = (n: string, ext: string) => readFileSync(join(TESTDATA, `${n}.${ext}`), 'utf8');
  const json = (n: string, kind: 'expected' | 'context') => JSON.parse(text(n, `${kind}.json`));
  const segs = (n: string) => text(n, 'raw').split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  const seg = (n: string, name: string) => segs(n).filter((l) => l.startsWith(name + '|')).map((l) => l.split('|'));

  it.each(need)('%s has .raw + .context.json + .expected.json', (n) => {
    for (const ext of ['raw', 'context.json', 'expected.json']) expect(files, `${n}.${ext}`).toContain(`${n}.${ext}`);
  });
  it('SOURCE.md exists and declares the data synthetic, and says no text was copied from the manual', () => {
    expect(files).toContain('SOURCE.md');
    expect(text('SOURCE', 'md')).toMatch(/synthetic/i);
  });
  it('oru-patient: patient records for a synthetic MT26xxxxxxxx barcode with METIS_FLAG flags and result times', () => {
    const e = json('oru-patient', 'expected');
    expect(e).toMatchObject({ ok: true, messageKind: 'results' });
    expect(e.records.length).toBeGreaterThanOrEqual(2);
    for (const x of e.records) { expect(x.recordClass).toBe('patient'); expect(x.sampleBarcode).toMatch(/^MT26\d{8}$/); }
    expect(e.records.some((x: any) => x.instrumentFlags.some((f: string) => f.startsWith('METIS_FLAG:')))).toBe(true);
    expect(e.records.every((x: any) => typeof x.instrumentResultTimeLocal === 'string')).toBe(true);
  });
  it('oru-patient-qualitative: a qualitative record whose value came from OBX-9 (-, + or +-)', () => {
    const e = json('oru-patient-qualitative', 'expected');
    expect(e.ok).toBe(true);
    expect(e.records.some((x: any) => x.recordKind === 'qualitative' && /^(\+-|\+|-)$/.test(x.valueRaw))).toBe(true);
  });
  it('oru-patient-empty-obx-time: the raw really has an empty OBX-14, and every record still has a time', () => {
    expect(seg('oru-patient-empty-obx-time', 'OBX').some((f) => (f[14] ?? '') === '')).toBe(true);
    const e = json('oru-patient-empty-obx-time', 'expected');
    expect(e.ok).toBe(true);
    expect(e.records.length).toBeGreaterThanOrEqual(1);
    expect(e.records.every((x: any) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(x.instrumentResultTimeLocal))).toBe(true);
  });
  it('oru-qc: MSH-16 = 2, at least two qc records with control id, lot and level, and no barcode', () => {
    expect(seg('oru-qc', 'MSH')[0]![15]).toBe('2'); // split index = MSH field number - 1 (MSH-1 is the '|' itself)
    const e = json('oru-qc', 'expected');
    expect(e.ok).toBe(true);
    expect(e.records.length).toBeGreaterThanOrEqual(2);
    for (const x of e.records) {
      expect(x.recordClass).toBe('qc');
      expect(x.controlIdRaw).toBeTruthy();
      expect(x.controlLotRaw).toBeTruthy();
      expect(x.controlLevel).toBeTruthy();
      expect(x.sampleBarcode).toBeUndefined();
    }
  });
  it('oru-qc-lists-differ: the raw lists really differ in length, and the expected result is instruments.message_malformed', () => {
    const o = seg('oru-qc-lists-differ', 'OBR')[0]!;
    const lens = new Set([13, 17, 18, 19, 20].map((n) => (o[n] ?? '').split('^').length));
    expect(lens.size).toBeGreaterThan(1);
    expect(json('oru-qc-lists-differ', 'expected')).toMatchObject({ ok: false, errorCode: 'instruments.message_malformed' });
  });
  it('oru-calibration: MSH-16 = 1 in the raw; expected is ok, messageKind other, no records', () => {
    expect(seg('oru-calibration', 'MSH')[0]![15]).toBe('1'); // MSH-16
    expect(json('oru-calibration', 'expected')).toMatchObject({ ok: true, messageKind: 'other', records: [] });
  });
  it('malformed-no-msh: no MSH in the raw; expected ok:false instruments.message_malformed', () => {
    expect(seg('malformed-no-msh', 'MSH')).toEqual([]);
    expect(json('malformed-no-msh', 'expected')).toMatchObject({ ok: false, errorCode: 'instruments.message_malformed' });
  });
  it('context files carry the five golden-runner keys and the instrument timezone Asia/Kathmandu', () => {
    for (const n of need) {
      const c = json(n, 'context');
      for (const k of ['receivedAt', 'capturedAt', 'instrumentTimezone', 'qcSampleIdPatterns', 'options']) expect(c, `${n}.context.json`).toHaveProperty(k);
      expect(c.instrumentTimezone).toBe('Asia/Kathmandu');
    }
  });
  it('PHI never reaches an expected file: PID-2 and PID-7 values of every raw are absent from its expected.json', () => {
    for (const n of need) {
      expect(files, `${n}.raw`).toContain(`${n}.raw`); // no vacuous pass while the writer's files are missing
      const out = text(n, 'expected.json');
      for (const pid of seg(n, 'PID')) for (const v of [pid[2], pid[7]]) if (v && v.length >= 6) expect(out, `${n}: PID value leaked`).not.toContain(v);
    }
  });
  it('AC-21.4: the whole testdata dir passes the synthetic-scan (so PID-5 stays empty there; PHI-ignore is proven by the inline cases above)', () => {
    expect(existsSync(TESTDATA)).toBe(true);
    expect(scanSyntheticData([TESTDATA])).toEqual({ ok: true, violations: [] });
  });
  it('no real-looking identifiers: every patient OBR-2 barcode in the goldens matches the synthetic MT26nnnnnnnn pattern', () => {
    let seen = 0;
    for (const f of files.filter((x) => x.endsWith('.raw'))) {
      const n = f.slice(0, -4);
      if (seg(n, 'PID').length === 0) continue;
      for (const o of seg(n, 'OBR')) { seen++; expect(o[2]).toMatch(/^MT26\d{8}$/); }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
