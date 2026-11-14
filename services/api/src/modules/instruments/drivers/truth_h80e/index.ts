// truth_h80e — Truth-H80E HbA1c analyser, HL7 v2.3 ORU^R01 (08-ADDENDUM-TRUTH-H80E §3, §4, §8; LD-139, 2026-11-13).
// Status stays `generic`: every position marked U in the addendum is unverified until a real capture, so the parser is tolerant
// (result time = first 14-digit stamp among OBX-12..14) and the U fields are options, never hard-coded guesses.
// Host query (QRY/QCK/DSR, §5) is H80-T03; the inline chromatogram payload (CR-C7-015) is H80-T04: this task only emits the attachment record.
// Reasons and warnings are constant strings: never any input content (no PHI). PID content is never read (PHI minimisation).
import { HL7 } from '../hl7v2_generic_oru/index.js';
import { MAX, localTime, malformed } from '../delimited.js';
import type { InstrumentDriver, ParseResult, ParsedRecord } from '../types.js';
import { buildHostQueryReply, extractHostQueryBarcodes } from './hostQuery.js';

const FIELD_REF = '^[A-Z][A-Z0-9]{0,2}\\.[1-9][0-9]{0,2}(?:\\.[1-9][0-9]?)?$';
const STAMP = /^\d{14}$/;
const MARK = 'H80E_MARK:';

const OPTIONS_SCHEMA = {
  type: 'object', additionalProperties: false, required: [],
  properties: {
    detection_mode_field: { type: 'string', pattern: FIELD_REF, default: 'OBR.15' },   // U: metadata only
    type_flag_field: { type: 'string', pattern: FIELD_REF, default: 'MSH.16' },        // U: hint only, the layout classifies
    host_query_detection_mode: { enum: [0, 1, 2], default: 0 },                        // used by H80-T03
    name_script: { type: 'string', enum: ['as_registered', 'latin_if_available'], default: 'as_registered' }, // used by H80-T03
    qc_level_map: { type: 'object', maxProperties: 20, additionalProperties: { type: 'string', minLength: 1, maxLength: 16 }, default: { L: 'low' } },
  },
} as const;

function levelMap(o: unknown): Readonly<Record<string, string>> | undefined {
  if (o === undefined) return { L: 'low' };
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return undefined;
  return Object.values(o).every((v) => typeof v === 'string') ? (o as Record<string, string>) : undefined;
}

function parse(raw: Uint8Array, ctx: { readonly options: Readonly<Record<string, unknown>> }): ParseResult {
  const lines = new TextDecoder('utf-8').decode(raw).split(/\r\n|\r|\n/).filter((s) => s.length > 0);
  const head = lines[0];
  if (head === undefined || !head.startsWith('MSH')) return malformed('missing header record');
  const dl = HL7.delims(head);
  if (!dl) return malformed('invalid delimiter definition');
  const opts = ctx.options ?? {};
  const refOk = (v: unknown) => v === undefined || (typeof v === 'string' && new RegExp(FIELD_REF).test(v));
  const levels = levelMap(opts['qc_level_map']);
  if (!levels || !refOk(opts['detection_mode_field']) || !refOk(opts['type_flag_field'])) return malformed('invalid parser_options');

  // ponytail: the whole message is split once; a 1 MiB chromatogram field costs one split, no per-field copies
  const split = (l: string) => l.split(dl.field);
  const msh = split(head);
  // field n of a segment; '' and the literal "null" (the QC example) are empty
  const fld = (f: readonly string[] | undefined, seg: string, n: number): string | undefined => {
    const v = f?.[HL7.index(seg, n)];
    return v === undefined || v === '' || v === 'null' ? undefined : v;
  };
  const comp1 = (v: string | undefined) => { const c = v?.split(dl.repeat)[0]?.split(dl.component)[0]; return c ? c : undefined; };

  const type = /^[A-Z]{3}/.exec(fld(msh, 'MSH', 9)?.split(dl.component)[0] ?? '')?.[0];
  const messageKind = type === 'ORU' ? 'results' : type === 'QRY' ? 'host_query' : 'other';
  const messageControlId = comp1(fld(msh, 'MSH', 10));
  const messageTimeLocal = localTime(comp1(fld(msh, 'MSH', 7)));
  const base = { ok: true, messageKind, ...(messageControlId !== undefined && { messageControlId }), ...(messageTimeLocal !== undefined && { messageTimeLocal }) } as const;
  if (messageKind === 'host_query') {
    // H80-T03 (§8): QRD-8 component 1 is the tube barcode; empty or > 40 => malformed (never truncated). First QRD only.
    const qrd = lines.slice(1).map(split).find((f) => f[0] === 'QRD');
    const barcode = comp1(fld(qrd, 'QRD', 8));
    if (barcode === undefined) return malformed('host query barcode missing');
    if (barcode.length > MAX.barcode) return malformed('host query barcode too long');
    return { ...base, records: [{ recordSeq: 1, recordClass: 'host_query', sampleBarcode: barcode, instrumentFlags: [], warnings: [] }], warnings: [] };
  }
  if (messageKind !== 'results') return { ...base, records: [], warnings: [] };

  const records: ParsedRecord[] = [];
  const warnings: string[] = [];
  let hasPid = false;              // PID present => patient message; absent => QC layout (MSH-16 is only a hint)
  let obr: string[] | undefined;
  let seq = 0;
  for (const line of lines.slice(1)) {
    const f = split(line);
    if (f[0] === 'PID') { hasPid = true; continue; }
    if (f[0] === 'OBR') { obr = f; continue; }
    if (f[0] !== 'OBX') continue;
    seq++;
    const skip = (why: string) => { warnings.push(`record ${seq} skipped: ${why}`); };

    const qc = !hasPid;
    const batch = qc ? comp1(fld(obr, 'OBR', 3)) : undefined;
    const levelRaw = qc ? comp1(fld(obr, 'OBR', 5)) : undefined;
    const level = levelRaw === undefined ? undefined : Object.hasOwn(levels, levelRaw) ? levels[levelRaw] : levelRaw;
    const barcode = qc ? undefined : comp1(fld(obr, 'OBR', 3));
    const code = comp1(fld(f, 'OBX', 3));
    const attachment = fld(f, 'OBX', 2) === 'ED';
    const value = attachment ? undefined : fld(f, 'OBX', 5);
    const unit = comp1(fld(f, 'OBX', 6));
    const mark = fld(f, 'OBX', 8);
    const flags = mark === undefined ? [] : [MARK + mark];

    if (qc && batch === undefined) { skip('control_id_missing'); continue; }
    if (batch !== undefined && batch.length > MAX.controlId) { skip('control_id_too_long'); continue; }
    if (level !== undefined && level.length > MAX.flagLen) { skip('control_level_too_long'); continue; }
    if (barcode !== undefined && barcode.length > MAX.barcode) { skip('sample_barcode_too_long'); continue; }
    if (code !== undefined && code.length > MAX.code) { skip('instrument_analyte_code_too_long'); continue; }
    if (value !== undefined && value.length > MAX.value) { skip('value_too_long'); continue; }
    if (unit !== undefined && unit.length > MAX.unit) { skip('unit_too_long'); continue; }
    if (flags.some((x) => x.length > MAX.flagLen)) { skip('instrument_flags_too_long'); continue; }

    // U: result time sits in OBX-13 (patient example) or OBX-14 (QC example, standard HL7): first valid 14-digit stamp among 12..14
    const stamps = [12, 13, 14].map((n) => fld(f, 'OBX', n)).filter((v) => v !== undefined && STAMP.test(v)).map(localTime);
    const time = stamps.find((t) => t !== undefined) ?? (qc ? localTime(comp1(fld(obr, 'OBR', 7))) : undefined);

    records.push({
      recordSeq: seq,
      recordClass: qc ? 'qc' : 'patient',
      ...(barcode !== undefined && { sampleBarcode: barcode }),
      ...(batch !== undefined && { controlIdRaw: batch, controlLotRaw: batch }), // §4: OBR-3 is both
      ...(level !== undefined && { controlLevel: level }),
      recordKind: attachment ? 'attachment' : value !== undefined && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? 'quantitative' : 'text',
      ...(code !== undefined && { instrumentAnalyteCode: code }),
      ...(value !== undefined && { valueRaw: value }),
      ...(unit !== undefined && { unitRaw: unit }),
      instrumentFlags: flags,
      ...(time !== undefined && { instrumentResultTimeLocal: time }),
      warnings: [],
    });
  }
  return { ...base, records, warnings };
}

export const truthH80e: InstrumentDriver = Object.freeze<InstrumentDriver>({
  code: 'truth_h80e',
  version: '0.1.0',
  protocol: 'hl7v2',
  status: 'generic', // LD-139: never verified without the commissioning checklist + a reviewed migration
  capabilities: Object.freeze({ resultUpload: true, hostQuery: true, worklistDownload: false, qc: true, attachments: true, calibration: false }),
  manualRef: Object.freeze({ title: 'HL7 Interface User Manual — Fully Automated Glycated Hemoglobin Analyzer', documentId: 'truth-h80e-hl7-interface-user-manual', revision: '1.5' }),
  optionsSchema: OPTIONS_SCHEMA,
  parse,
  extractHostQueryBarcodes,
  buildHostQueryReply,
});
