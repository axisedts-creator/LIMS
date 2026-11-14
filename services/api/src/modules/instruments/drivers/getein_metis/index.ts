// getein_metis — Getein Metis series analyser, HL7 v2.3.1 ORU^R01 (09-ADDENDUM-GETEIN-METIS §2, §3, §4, §8; LD-163, 2026-11-14; the addendum header says LD-162, LD-163 is the binding number).
// Status stays `generic` (never verified here: that needs the commissioning checklist and a reviewed migration). Every position marked U (U4, U5, U12 ...) is parsed tolerantly
// or is an option, never a hard-coded guess. D-MET-2: calibration (MSH-16 = 1) is archived as messageKind `other`: no records, so no events.
// Host query (QRY/QCK/DSR, §5; D-MET-1) lives in ./hostQuery.ts (MET-T03).
// Reasons and warnings are constant strings: never any input content (no PHI). PID content is never read (PHI minimisation: PID-2/5/7/8 and OBR-16 are ignored).
import { HL7 } from '../hl7v2_generic_oru/index.js';
import { MAX, localTime, malformed } from '../delimited.js';
import { buildHostQueryReply, extractHostQueryBarcodes, parseQuery } from './hostQuery.js';
import type { InstrumentDriver, ParseResult, ParsedRecord, RecordKind } from '../types.js';

const FIELD_REF = '^[A-Z][A-Z0-9]{0,2}\\.[1-9][0-9]{0,2}(?:\\.[1-9][0-9]?)?$';
const FIELD_REF_RE = /^([A-Z][A-Z0-9]{0,2})\.([1-9][0-9]{0,2})(?:\.([1-9][0-9]?))?$/;
const FLAG = 'METIS_FLAG:';
const RETEST = 'METIS_RETEST';
const QC_ERROR = 'METIS_QC_ERROR';
const NUMERIC = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const SLASH_TIME = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const EXPIRY = /^(?:19|20)\d{6}(?:\d{6})?$/; // U12: 8 or 14 digits starting with 19 or 20 = expiry; anything else = lot
const DEFAULT_LEVELS: Readonly<Record<string, string>> = { L: 'low', M: 'mid', H: 'high' }; // 03-IC §3.15 level vocabulary

const OPTIONS_SCHEMA = {
  type: 'object', additionalProperties: false, required: [],
  properties: {
    type_flag_field: { type: 'string', pattern: FIELD_REF, default: 'MSH.16' },                                // U: message class flag (0 patient, 1 calibration, 2 QC)
    qc_level_map: { type: 'object', maxProperties: 30, additionalProperties: { type: 'string', minLength: 1, maxLength: 16 }, default: DEFAULT_LEVELS },
    name_script: { type: 'string', enum: ['as_registered', 'latin_if_available'], default: 'as_registered' },    // used by MET-T03 (U10)
    specimen_type_map: { type: 'object', maxProperties: 30, additionalProperties: { type: 'string', minLength: 1, maxLength: 40 } }, // used by MET-T03
    dsr_item_details: { type: 'string', enum: ['id_only', 'full'], default: 'id_only' },                         // used by MET-T03
  },
} as const;

function levelMap(o: unknown): Readonly<Record<string, string>> | undefined {
  if (o === undefined) return DEFAULT_LEVELS;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return undefined;
  return Object.values(o).every((v) => typeof v === 'string') ? (o as Record<string, string>) : undefined;
}

/** U4: both '20261114093001' and '2026/11/14 09:30:01' are accepted; anything impossible is no time at all (never invented). */
function stamp(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const m = SLASH_TIME.exec(v);
  return localTime(m ? `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6] ?? '00'}` : v);
}

function parse(raw: Uint8Array, ctx: { readonly options: Readonly<Record<string, unknown>> }): ParseResult {
  const lines = new TextDecoder('utf-8').decode(raw).split(/\r\n|\r|\n/).filter((s) => s.length > 0);
  const head = lines[0];
  if (head === undefined || !head.startsWith('MSH')) return malformed('missing header record');
  const dl = HL7.delims(head);
  if (!dl) return malformed('invalid delimiter definition');
  const opts = ctx.options ?? {};
  const flagRef = opts['type_flag_field'] === undefined ? 'MSH.16' : opts['type_flag_field'];
  const flagM = typeof flagRef === 'string' ? FIELD_REF_RE.exec(flagRef) : null;
  const levels = levelMap(opts['qc_level_map']);
  if (!levels || !flagM) return malformed('invalid parser_options');

  const segs = lines.map((l) => l.split(dl.field));
  const msh = segs[0]!;
  // field n of a segment (MSH-1 is the separator itself); '' is empty; values are trimmed
  const fld = (f: readonly string[] | undefined, seg: string, n: number): string | undefined => {
    const v = f?.[HL7.index(seg, n)]?.trim();
    return v === undefined || v === '' ? undefined : v;
  };
  const comp1 = (v: string | undefined) => { const c = v?.split(dl.repeat)[0]?.split(dl.component)[0]?.trim(); return c ? c : undefined; };

  const type = /^[A-Z]{3}/.exec(fld(msh, 'MSH', 9)?.split(dl.component)[0] ?? '')?.[0];
  const messageControlId = comp1(fld(msh, 'MSH', 10));
  const mshTime = comp1(fld(msh, 'MSH', 7));
  const messageTimeLocal = localTime(mshTime);
  const hasPid = segs.some((s, i) => i > 0 && s[0] === 'PID'); // presence only: the content is never read

  // §2 classifier: the flag first (0 patient, 1 calibration, 2 QC); blank => PID present = patient, otherwise other; anything else = other
  const flagSeg = flagM[1]!;
  const flagVal = comp1(fld(flagSeg === 'MSH' ? msh : segs.find((s, i) => i > 0 && s[0] === flagSeg), flagSeg, Number(flagM[2])));
  const cls: 'patient' | 'qc' | 'other' = flagVal === '0' ? 'patient' : flagVal === '2' ? 'qc' : flagVal === undefined ? (hasPid ? 'patient' : 'other') : 'other';
  const messageKind = type === 'ORU' && cls !== 'other' ? 'results' : 'other'; // calibration (flag 1) lands here: archived, no events (D-MET-2)
  const base = { ok: true, messageKind, ...(messageControlId !== undefined && { messageControlId }), ...(messageTimeLocal !== undefined && { messageTimeLocal }) } as const;
  if (type === 'QRY') return parseQuery(lines, base); // §5: host query (MET-T03)
  if (messageKind !== 'results') return { ...base, records: [], warnings: [] };

  const records: ParsedRecord[] = [];
  const warnings: string[] = [];
  let seq = 0;
  const skip = (n: number, why: string) => { warnings.push(`record ${n} skipped: ${why}`); };

  if (cls === 'patient') {
    let obr: string[] | undefined;
    for (const f of segs.slice(1)) {
      if (f[0] === 'OBR') { obr = f; continue; }
      if (f[0] !== 'OBX') continue;
      seq++;
      // OBR-2 is the sample barcode. Empty: the record is kept without one and the pipeline marks it skipped_no_barcode (02-TRD §6.4); OBR-3 is never promoted.
      const barcode = comp1(fld(obr, 'OBR', 2));
      const obxType = fld(f, 'OBX', 2);
      const kind: RecordKind = obxType === 'NM' ? 'quantitative' : obxType === 'ST' ? 'qualitative' : 'text';
      let code = comp1(fld(f, 'OBX', 3));                    // U5: OBX-3 is the item id and wins over OBX-4
      let warned = false;
      if (code === undefined) { code = comp1(fld(f, 'OBX', 4)); warned = code !== undefined; }
      const value = fld(f, 'OBX', 5) ?? (obxType === 'ST' ? fld(f, 'OBX', 9) : undefined); // ST with empty OBX-5: OBX-9 (-, +, +-)
      const unit = comp1(fld(f, 'OBX', 6));
      const flags = (fld(f, 'OBX', 8) ?? '').split(dl.repeat).map((x) => x.trim()).filter((x) => x.length > 0).map((x) => FLAG + x);
      if (fld(f, 'OBX', 17) === '1') flags.push(RETEST);

      if (barcode !== undefined && barcode.length > MAX.barcode) { skip(seq, 'sample_barcode_too_long'); continue; }
      if (code !== undefined && code.length > MAX.code) { skip(seq, 'instrument_analyte_code_too_long'); continue; }
      if (value !== undefined && value.length > MAX.value) { skip(seq, 'value_too_long'); continue; }
      if (unit !== undefined && unit.length > MAX.unit) { skip(seq, 'unit_too_long'); continue; }
      if (flags.length > MAX.flagCount || flags.some((x) => x.length > MAX.flagLen)) { skip(seq, 'instrument_flags_too_long'); continue; }

      // per row: OBX-14, else OBR-7, else MSH-7; an impossible stamp falls through to the next source
      const time = stamp(fld(f, 'OBX', 14)) ?? stamp(fld(obr, 'OBR', 7)) ?? messageTimeLocal;
      records.push({
        recordSeq: seq,
        recordClass: 'patient',
        ...(barcode !== undefined && { sampleBarcode: barcode }),
        recordKind: kind,
        ...(code !== undefined && { instrumentAnalyteCode: code }),
        ...(value !== undefined && { valueRaw: value }),
        ...(unit !== undefined && { unitRaw: unit }),
        instrumentFlags: flags,
        ...(time !== undefined && { instrumentResultTimeLocal: time }),
        warnings: warned ? ['obx3_empty_obx4_used'] : [],
      });
    }
    return { ...base, records, warnings };
  }

  // QC (§4): one OBR carries ^-lists, one entry per control level; one record per entry
  for (const f of segs.slice(1)) {
    if (f[0] !== 'OBR') continue;
    const list = (n: number) => (fld(f, 'OBR', n) ?? '').split(dl.component).map((x) => x.trim());
    const names = list(13), lvls = list(17), targets = list(18), sds = list(19), measured = list(20);
    if (new Set([names, lvls, targets, sds, measured].map((l) => l.length)).size > 1) return malformed('qc_lists_differ'); // no guessing which entry is which
    const l14 = list(14), l15 = list(15);
    const code = comp1(fld(f, 'OBR', 2));
    const unit = fld(f, 'OBR', 21);
    const time = stamp(fld(f, 'OBR', 7)) ?? messageTimeLocal;
    for (let i = 0; i < names.length; i++) {
      seq++;
      const controlId = names[i] || undefined;
      const lvlRaw = lvls[i] || undefined;
      const level = lvlRaw === undefined ? undefined : Object.hasOwn(levels, lvlRaw) ? levels[lvlRaw] : lvlRaw;
      // U12: expiry and lot told apart by content, whichever of OBR-14 / OBR-15 holds which
      const cand = [l14[i], l15[i]].filter((x): x is string => x !== undefined && x !== '');
      const lots = cand.filter((x) => !EXPIRY.test(x));
      const lot = lots[0];
      const value = measured[i] || undefined;
      const errored = value !== undefined && (/^error$/i.test(value) || /^-1(?:\.0+)?$/.test(value));
      const flags = errored ? [QC_ERROR] : [];

      if (controlId === undefined) { skip(seq, 'control_id_missing'); continue; }
      if (controlId.length > MAX.controlId) { skip(seq, 'control_id_too_long'); continue; }
      if (lot !== undefined && lot.length > MAX.controlId) { skip(seq, 'control_lot_too_long'); continue; }
      if (level !== undefined && level.length > MAX.flagLen) { skip(seq, 'control_level_too_long'); continue; }
      if (code !== undefined && code.length > MAX.code) { skip(seq, 'instrument_analyte_code_too_long'); continue; }
      if (value !== undefined && value.length > MAX.value) { skip(seq, 'value_too_long'); continue; }
      if (unit !== undefined && unit.length > MAX.unit) { skip(seq, 'unit_too_long'); continue; }

      records.push({
        recordSeq: seq,
        recordClass: 'qc',
        controlIdRaw: controlId,
        ...(lot !== undefined && { controlLotRaw: lot }),
        ...(level !== undefined && { controlLevel: level }),
        recordKind: value !== undefined && NUMERIC.test(value) ? 'quantitative' : 'text',
        ...(code !== undefined && { instrumentAnalyteCode: code }),
        ...(value !== undefined && { valueRaw: value }),
        ...(unit !== undefined && { unitRaw: unit }),
        instrumentFlags: flags,
        ...(time !== undefined && { instrumentResultTimeLocal: time }),
        warnings: lots.length > 1 ? ['qc_lot_ambiguous'] : [],
      });
    }
  }
  return { ...base, records, warnings };
}

export const geteinMetis: InstrumentDriver = Object.freeze<InstrumentDriver>({
  code: 'getein_metis',
  version: '0.1.0',
  protocol: 'hl7v2',
  status: 'generic', // LD-163: never verified without the commissioning checklist + a reviewed migration
  // hostQuery is inert while status != verified; the QRY/QCK/DSR functions arrive with MET-T03
  capabilities: Object.freeze({ resultUpload: true, hostQuery: true, worklistDownload: false, qc: true, attachments: false, calibration: false }),
  manualRef: Object.freeze({ title: 'HL7 Communication Protocol (Applicable to Metis Series Analyzers)', documentId: 'getein-metis-hl7-communication-protocol', revision: 'unversioned' }),
  optionsSchema: OPTIONS_SCHEMA,
  parse,
  extractHostQueryBarcodes,
  buildHostQueryReply,
});
