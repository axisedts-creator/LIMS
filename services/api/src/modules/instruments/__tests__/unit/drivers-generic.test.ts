// C7 API-T07 — generic drivers: astm_generic_e1394, hl7v2_generic_oru, file_drop_generic (02-TRD §6.1/§6.2; AC-21.2 inputs). Synthetic data only.
// Spec-derived goldens built inline (CR-separated records; tester-owned, independent of the writer's drivers/<d>/testdata).
// Expectations use toMatchObject (listed fields exact, unlisted fields free): the spec does not pin optional-field presence.
// Raw format (TRD §15.2): ASTM = assembled frame texts, records split by CR, delimiters from H (field, repeat, component, escape);
//   HL7 = message between MLLP blocks, segments split by CR, delimiters from MSH-1/MSH-2. Time 'YYYYMMDDHHMMSS' -> 'YYYY-MM-DDTHH:MM:SS' (local, no zone).
// Field numbers: ASTM X.n = n-th '|' field with the record type as field 1 (O.3 specimen id, R.3 test id, R.4 value, R.5 unit, R.7 flags,
//   R.9 status, R.13 result time, H.14 time). HL7 MSH-n counts MSH-1 = the separator itself.
// SEAM (spec gap, flagged in notes/API-T07-tests.md): file_drop_generic gets the agent metadata through ctx.options as
//   { barcode?: string; attachment_instrument_code: string } because DriverContext has no other channel.
import { describe, expect, it } from 'vitest';
import { getDriver } from '../../drivers/registry.js';

const enc = (s: string) => new TextEncoder().encode(s);
const ctx = (options: Record<string, unknown> = {}, qc: RegExp[] = [/^QC-/]) => ({
  receivedAt: '2026-11-07T04:20:00.000Z', capturedAt: '2026-11-07T04:20:00.000Z', instrumentTimezone: 'Asia/Kathmandu', qcSampleIdPatterns: qc, options,
});
// join fields (array index i = field i+1) into a record; message = records joined by CR
const rec = (fd: string, fields: string[]) => fields.join(fd);
const msg = (records: string[]) => enc(records.join('\r') + '\r');

const T = '20261107101200';
const H = (fd = '|', delims = '\\^&') => rec(fd, ['H', delims, '', '', 'SIM-ANALYSER^0.1', '', '', '', '', '', '', 'P', '1', '20261107101500']);
const O = (spec: string, alt = '', test = '^^^GLU', fd = '|') => rec(fd, ['O', '1', spec, alt, test]);
const R = (seq: number, test: string, value: string, unit = 'mmol/L', flags = 'N', status = 'F', time = T, fd = '|') =>
  rec(fd, ['R', String(seq), test, value, unit, '', flags, '', status, '', '', '', time]);
const L = 'L|1|N';

const astm = () => getDriver('astm_generic_e1394')!;
const hl7 = () => getDriver('hl7v2_generic_oru')!;
const fileDrop = () => getDriver('file_drop_generic')!;

function ok(res: any) {
  if (!res.ok) throw new Error(`expected ok parse, got ${JSON.stringify(res)}`);
  return res;
}

describe('astm_generic_e1394 — defaults (TRD §6.2 table)', () => {
  it('maps a two-result message: sample O.3, code R.3 comp 4, value R.4, unit R.5, flags R.7 split on repeat, time R.13', () => {
    const res = ok(astm().parse(msg([H(), 'P|1', O('E2600000042'), R(1, '^^^GLU', '5.4'), R(2, '^^^NA', '141', 'mmol/L', 'H\\A'), L]), ctx()));
    expect(res).toMatchObject({ ok: true, messageKind: 'results' });
    expect(res.records).toHaveLength(2);
    expect(res.records[0]).toMatchObject({
      recordSeq: 1, recordClass: 'patient', sampleBarcode: 'E2600000042', recordKind: 'quantitative', instrumentAnalyteCode: 'GLU',
      valueRaw: '5.4', unitRaw: 'mmol/L', instrumentFlags: ['N'], instrumentResultTimeLocal: '2026-11-07T10:12:00',
    });
    expect(res.records[1]).toMatchObject({ recordSeq: 2, instrumentAnalyteCode: 'NA', valueRaw: '141', instrumentFlags: ['H', 'A'] });
  });

  it('non-numeric value -> record_kind text', () => {
    const res = ok(astm().parse(msg([H(), O('E2600000042', '', '^^^HBSAG'), R(1, '^^^HBSAG', 'Negative', ''), L]), ctx()));
    expect(res.records[0]).toMatchObject({ valueRaw: 'Negative', recordKind: 'text', instrumentAnalyteCode: 'HBSAG' });
  });

  it('sample id falls back to O.4 when O.3 is empty; only the first component is used', () => {
    const a = ok(astm().parse(msg([H(), O('', 'E2600000043'), R(1, '^^^GLU', '5.1'), L]), ctx()));
    expect(a.records[0].sampleBarcode).toBe('E2600000043');
    const b = ok(astm().parse(msg([H(), O('E2600000042^LAB1'), R(1, '^^^GLU', '5.1'), L]), ctx()));
    expect(b.records[0].sampleBarcode).toBe('E2600000042');
  });

  it('result time falls back to H.14 when R.13 is empty', () => {
    const res = ok(astm().parse(msg([H(), O('E2600000042'), R(1, '^^^GLU', '5.4', 'mmol/L', 'N', 'F', ''), L]), ctx()));
    expect(res.records[0].instrumentResultTimeLocal).toBe('2026-11-07T10:15:00');
  });

  it('delimiters come from the H record (field ";", repeat "/", component "!")', () => {
    const fd = ';';
    const res = ok(astm().parse(msg([
      H(fd, '/!&'), O('E2600000042', '', '!!!GLU', fd), R(1, '!!!GLU', '5.4', 'mmol/L', 'H/A', 'F', T, fd), 'L;1;N',
    ]), ctx()));
    expect(res.records[0]).toMatchObject({ sampleBarcode: 'E2600000042', instrumentAnalyteCode: 'GLU', valueRaw: '5.4', instrumentFlags: ['H', 'A'] });
  });

  it('is_rerun only when the status value is in rerun_values', () => {
    const opts = { result_status_field: 'R.9', rerun_values: ['R'] };
    const re = ok(astm().parse(msg([H(), O('E2600000042'), R(1, '^^^GLU', '5.4', 'mmol/L', 'N', 'R'), L]), ctx(opts)));
    expect(re.records[0].isRerun).toBe(true);
    const fin = ok(astm().parse(msg([H(), O('E2600000042'), R(1, '^^^GLU', '5.4', 'mmol/L', 'N', 'F'), L]), ctx(opts)));
    expect(fin.records[0].isRerun).toBeFalsy();
    const dflt = ok(astm().parse(msg([H(), O('E2600000042'), R(1, '^^^GLU', '5.4', 'mmol/L', 'N', 'R'), L]), ctx()));
    expect(dflt.records[0].isRerun).toBeFalsy(); // rerun_values default []
  });

  it('host query is off: hostQuery=false (04 N14)', () => {
    expect(astm().capabilities.hostQuery).toBe(false);
  });
});

describe('astm_generic_e1394 — QC and control_id_field (AC-11.1a input; review #20)', () => {
  const qcMsg = (spec: string, alt: string) => msg([H(), O(spec, alt), R(1, '^^^GLU', '5.0'), L]);

  it('qc_sample_id_patterns classify the record; control id defaults to the matched sample id', () => {
    const res = ok(astm().parse(qcMsg('QC-L1-0007', ''), ctx()));
    expect(res.records[0]).toMatchObject({ recordClass: 'qc', controlIdRaw: 'QC-L1-0007' });
  });

  it('control_id_field "O.4" -> control_id_raw is the first component of that field', () => {
    const res = ok(astm().parse(qcMsg('QC-L1-0007', 'CTRL-A1^LOT9'), ctx({ control_id_field: 'O.4' })));
    expect(res.records[0]).toMatchObject({ recordClass: 'qc', controlIdRaw: 'CTRL-A1' });
  });

  it('control_id_field present but empty in the message -> falls back to the matched sample id', () => {
    const res = ok(astm().parse(qcMsg('QC-L1-0007', ''), ctx({ control_id_field: 'O.4' })));
    expect(res.records[0]).toMatchObject({ recordClass: 'qc', controlIdRaw: 'QC-L1-0007' });
  });

  it('a patient barcode that does not match any pattern stays a patient record', () => {
    const res = ok(astm().parse(qcMsg('E2600000042', 'CTRL-A1'), ctx({ control_id_field: 'O.4' })));
    expect(res.records[0].recordClass).toBe('patient');
    expect(res.records[0].controlIdRaw).toBeUndefined();
  });

  it('qc_marker field-based classification works in addition to patterns', () => {
    const marker = { field: 'O.12', values: ['Q'] };
    const m = enc([H(), rec('|', ['O', '1', 'E2600000099', '', '^^^GLU', '', '', '', '', '', '', 'Q']), R(1, '^^^GLU', '5.0'), L].join('\r') + '\r');
    const res = ok(astm().parse(m, ctx({ qc_marker: marker })));
    expect(res.records[0].recordClass).toBe('qc');
  });

  it('optionsSchema is strict and lists every documented option, incl. control_id_field; {} stays valid (defaults)', () => {
    const s = astm().optionsSchema as any;
    expect(s.type).toBe('object');
    expect(s.additionalProperties).toBe(false);
    for (const k of ['sample_id_field', 'test_code_field', 'value_field', 'unit_field', 'flags_field', 'result_status_field', 'rerun_values',
      'result_time_field', 'qc_marker', 'control_id_field', 'record_kind_default']) expect(Object.keys(s.properties)).toContain(k);
    expect(s.required ?? []).toEqual([]);
  });
});

describe('hl7v2_generic_oru — defaults (TRD §6.2)', () => {
  const MSH = (id = 'MSG00001', fd = '|', enc4 = '^~\\&') =>
    rec(fd, ['MSH', enc4, 'SIM', 'LAB', 'LIS', 'CTR', '20261107101500', '', 'ORU^R01', id, 'P', '2.3.1']);
  const OBR = (placer: string, filler: string, time = '20261107101000', fd = '|', comp = '^') =>
    rec(fd, ['OBR', '1', placer, filler, `GLU${comp}Glucose`, '', '', time]);
  const OBX = (seq: number, code: string, value: string, unit: string, flags: string, time: string, fd = '|', comp = '^', type = 'NM') =>
    rec(fd, ['OBX', String(seq), type, `${code}${comp}${code}name`, '', value, unit, '3.9-6.1', flags, '', '', 'F', '', '', time]);

  it('maps header + OBR + OBX: control id MSH-10, message time MSH-7, sample OBR.3, code OBX.3 c1, unit OBX.6, flags OBX.8, time OBX.14', () => {
    const res = ok(hl7().parse(msg([MSH(), OBR('', 'E2600000042'), OBX(1, 'GLU', '5.4', 'mmol/L^x', 'N~A', '20261107101200'), OBX(2, 'HBSAG', 'Negative', '', 'N', '', '|', '^', 'ST')]), ctx()));
    expect(res).toMatchObject({ ok: true, messageKind: 'results', messageControlId: 'MSG00001', messageTimeLocal: '2026-11-07T10:15:00' });
    expect(res.records).toHaveLength(2);
    expect(res.records[0]).toMatchObject({
      recordSeq: 1, recordClass: 'patient', sampleBarcode: 'E2600000042', recordKind: 'quantitative', instrumentAnalyteCode: 'GLU',
      valueRaw: '5.4', unitRaw: 'mmol/L', instrumentFlags: ['N', 'A'], instrumentResultTimeLocal: '2026-11-07T10:12:00',
    });
    // OBX.14 empty -> OBR.7
    expect(res.records[1]).toMatchObject({ recordSeq: 2, instrumentAnalyteCode: 'HBSAG', valueRaw: 'Negative', recordKind: 'text', instrumentResultTimeLocal: '2026-11-07T10:10:00' });
  });

  it('result time fallback chain OBX.14 -> OBR.7 -> MSH.7', () => {
    const res = ok(hl7().parse(msg([MSH(), OBR('', 'E2600000042', ''), OBX(1, 'GLU', '5.4', 'mmol/L', 'N', '')]), ctx()));
    expect(res.records[0].instrumentResultTimeLocal).toBe('2026-11-07T10:15:00');
  });

  it('sample id: OBR.3 wins over OBR.2; OBR.2 if OBR.3 empty; SPM.2 if both empty', () => {
    const both = ok(hl7().parse(msg([MSH(), OBR('PLACER-1', 'E2600000042'), OBX(1, 'GLU', '5.4', 'mmol/L', 'N', T)]), ctx()));
    expect(both.records[0].sampleBarcode).toBe('E2600000042');
    const placer = ok(hl7().parse(msg([MSH(), OBR('E2600000043', ''), OBX(1, 'GLU', '5.4', 'mmol/L', 'N', T)]), ctx()));
    expect(placer.records[0].sampleBarcode).toBe('E2600000043');
    const spm = ok(hl7().parse(msg([MSH(), OBR('', ''), 'SPM|1|E2600000044', OBX(1, 'GLU', '5.4', 'mmol/L', 'N', T)]), ctx()));
    expect(spm.records[0].sampleBarcode).toBe('E2600000044');
  });

  it('two OBR groups: each OBX takes the sample id of its own OBR', () => {
    const res = ok(hl7().parse(msg([MSH(), OBR('', 'E2600000042'), OBX(1, 'GLU', '5.4', 'mmol/L', 'N', T), OBR('', 'E2600000043'), OBX(2, 'GLU', '6.1', 'mmol/L', 'N', T)]), ctx()));
    expect(res.records.map((r: any) => r.sampleBarcode)).toEqual(['E2600000042', 'E2600000043']);
  });

  it('delimiters come from MSH-1/MSH-2 (field "#", component "@", repeat "*")', () => {
    const res = ok(hl7().parse(msg([
      MSH('MSG00002', '#', '@*\\&'), OBR('', 'E2600000042', '20261107101000', '#', '@'), OBX(1, 'GLU', '5.4', 'mmol/L', 'N*A', T, '#', '@'),
    ]), ctx()));
    expect(res.messageControlId).toBe('MSG00002');
    expect(res.records[0]).toMatchObject({ sampleBarcode: 'E2600000042', instrumentAnalyteCode: 'GLU', valueRaw: '5.4', instrumentFlags: ['N', 'A'] });
  });

  it('QC: pattern on the sample id classifies; control id defaults to the sample id', () => {
    const res = ok(hl7().parse(msg([MSH(), OBR('', 'QC-L2-0001'), OBX(1, 'GLU', '5.0', 'mmol/L', 'N', T)]), ctx()));
    expect(res.records[0]).toMatchObject({ recordClass: 'qc', controlIdRaw: 'QC-L2-0001' });
  });

  it('no host query, no calibration; strict options schema incl. control_id_field', () => {
    expect(hl7().capabilities.hostQuery).toBe(false);
    expect(hl7().capabilities.calibration).toBe(false);
    const s = hl7().optionsSchema as any;
    expect(s.type).toBe('object');
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties)).toContain('control_id_field');
    expect(s.required ?? []).toEqual([]);
  });
});

describe('file_drop_generic — exactly one attachment record (TRD §6.2)', () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff, 0xfe]);
  it('one record: barcode from metadata, analyte code from attachment_instrument_code, kind attachment', () => {
    const res = ok(fileDrop().parse(pdf, ctx({ barcode: 'E2600000042', attachment_instrument_code: 'HISTO-IMG' })));
    expect(res.ok).toBe(true);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]).toMatchObject({ recordSeq: 1, recordKind: 'attachment', sampleBarcode: 'E2600000042', instrumentAnalyteCode: 'HISTO-IMG' });
  });
  it('file bytes are never decoded into the result (no content echo)', () => {
    const body = enc('%PDF-1.4 ZZSECRETNAME^ALICE');
    const out = JSON.stringify(fileDrop().parse(body, ctx({ barcode: 'E2600000042', attachment_instrument_code: 'IMG' })));
    expect(out).not.toContain('ZZSECRETNAME');
  });
  it('capabilities: attachments only; options schema is an object schema', () => {
    expect(fileDrop().capabilities).toMatchObject({ attachments: true, qc: false, hostQuery: false, calibration: false });
    expect((fileDrop().optionsSchema as any).type).toBe('object');
  });
});

describe('malformed input and hardening (all parsing drivers)', () => {
  const PARSERS = ['astm_generic_e1394', 'hl7v2_generic_oru', 'mindray_bc5380_sketch', 'mindray_bs200_sketch'];
  const SECRET = 'ZZSECRETNAME';

  const malformed: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array(0)],
    ['plain text', enc('hello world')],
    ['binary noise', new Uint8Array([0, 255, 1, 254, 2, 253, 13, 13, 124, 124])],
    ['only a CR', enc('\r')],
  ];
  it.each(PARSERS.flatMap((d) => malformed.map(([n, raw]) => [d, n, raw] as const)))('%s: %s -> ok:false message_malformed', (code, _n, raw) => {
    const res = getDriver(code)!.parse(raw, ctx() as never);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ errorCode: 'instruments.message_malformed' });
    expect(typeof (res as any).reason).toBe('string');
  });

  it('ASTM without an H record is malformed (delimiters unknown); HL7 without MSH is malformed', () => {
    expect(astm().parse(msg([O('E2600000042'), R(1, '^^^GLU', '5.4'), L]), ctx() as never).ok).toBe(false);
    expect(hl7().parse(msg(['PID|1||P0001', 'OBX|1|NM|GLU^Glucose||5.4']), ctx() as never).ok).toBe(false);
  });

  it('reason carries no input content (no PHI) and a valid message never echoes patient names', () => {
    const bad = astm().parse(enc(`P|1||||${SECRET}^ALICE\rR|1|^^^GLU|5.4\r`), ctx() as never);
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain(SECRET);
    const good = astm().parse(msg([H(), `P|1||||${SECRET}^ALICE`, O('E2600000042'), R(1, '^^^GLU', '5.4'), L]), ctx() as never);
    expect(good.ok).toBe(true);
    expect(JSON.stringify(good)).not.toContain(SECRET);
    const hl = hl7().parse(msg(['MSH|^~\\&|SIM|LAB|LIS|CTR|20261107101500||ORU^R01|M1|P|2.3.1', `PID|1||P0001||${SECRET}^ALICE`, 'OBR|1||E2600000042|GLU^Glucose', 'OBX|1|NM|GLU^Glucose||5.4|mmol/L|||||F']), ctx() as never);
    expect(JSON.stringify(hl)).not.toContain(SECRET);
  });

  it('pure and deterministic: same input twice -> deep-equal result; input bytes untouched', () => {
    const raw = msg([H(), O('E2600000042'), R(1, '^^^GLU', '5.4'), L]);
    const copy = raw.slice();
    const a = astm().parse(raw, ctx() as never);
    const b = astm().parse(raw, ctx() as never);
    expect(a).toEqual(b);
    expect(raw).toEqual(copy);
  });

  it('fuzz: 300 random buffers per parser never throw and always return {ok:boolean}', () => {
    let seed = 0x2545f491;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const alphabet = enc('H|\\^&~MSOBXPRL0123456789.-QC \r\n');
    for (const code of PARSERS) {
      for (let i = 0; i < 300; i++) {
        const len = next() % 400;
        const buf = new Uint8Array(len);
        for (let j = 0; j < len; j++) buf[j] = next() % 4 === 0 ? next() & 0xff : alphabet[next() % alphabet.length]!;
        let res: any;
        expect(() => { res = getDriver(code)!.parse(buf, ctx() as never); }).not.toThrow();
        expect(typeof res.ok).toBe('boolean');
        if (res.ok) for (const r of res.records) expect(r.recordClass).not.toBe('calibrator'); // generics never emit calibration (B2)
      }
    }
  });

  it('emitted fields respect the 03-IC bounds and are never silently truncated (barcode<=40, code<=64, flags<=20 x16)', () => {
    const longBarcode = 'E' + '9'.repeat(60);
    const longCode = 'X'.repeat(80);
    const flags = Array.from({ length: 30 }, (_, i) => `F${i}`).join('\\');
    const res = astm().parse(msg([H(), O(longBarcode), R(1, `^^^${longCode}`, '5.4', 'mmol/L', flags), L]), ctx() as never);
    if (res.ok) {
      for (const r of res.records) {
        if (r.sampleBarcode !== undefined) { expect(r.sampleBarcode.length).toBeLessThanOrEqual(40); expect(longBarcode.startsWith(r.sampleBarcode) && r.sampleBarcode !== longBarcode).toBe(false); }
        if (r.instrumentAnalyteCode !== undefined) { expect(r.instrumentAnalyteCode.length).toBeLessThanOrEqual(64); expect(longCode.startsWith(r.instrumentAnalyteCode) && r.instrumentAnalyteCode !== longCode).toBe(false); }
        expect(r.instrumentFlags.length).toBeLessThanOrEqual(20);
        for (const f of r.instrumentFlags) expect(f.length).toBeLessThanOrEqual(16);
      }
    }
  });

  it('pathological 1 MiB inputs finish quickly (no ReDoS / quadratic scan) and do not throw', () => {
    const MiB = 1024 * 1024;
    const cases: Array<[string, Uint8Array]> = [
      ['astm', enc(H() + '\rR|1|' + '^'.repeat(MiB / 2) + '\r')],
      ['astm', enc(H() + '\r' + 'R|1|^^^GLU|5.4\r'.repeat(Math.floor(MiB / 16)))],
      ['hl7v2_generic_oru', enc('MSH|^~\\&|' + '|'.repeat(MiB / 2) + '\r')],
      ['hl7v2_generic_oru', enc('MSH|^~\\&|SIM||||2026||ORU^R01|M1|P|2.3.1\r' + 'OBX|1|NM|GLU||5.4\r'.repeat(Math.floor(MiB / 20)))],
    ];
    for (const [kind, raw] of cases) {
      const d = kind === 'astm' ? astm() : hl7();
      const t0 = performance.now();
      expect(() => d.parse(raw, ctx() as never)).not.toThrow();
      expect(performance.now() - t0).toBeLessThan(5000);
    }
  });
});
