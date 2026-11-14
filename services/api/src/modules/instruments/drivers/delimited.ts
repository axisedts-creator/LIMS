// Shared engine for delimiter-based protocols (ASTM E1394 records, HL7 v2 segments) — 02-TRD §6.2. Pure.
// Field refs are '<SEG>.<field>' or '<SEG>.<field>.<component>'; component 0 = whole field (first repeat not taken).
// Reasons and warnings are constant strings: never any input content (no PHI).
import type { DriverContext, ParseResult, ParsedRecord, RecordKind } from './types.js';

export interface Ref { readonly seg: string; readonly field: number; readonly comp: number }
export interface Delims { readonly field: string; readonly repeat: string; readonly component: string }
type Seg = { readonly type: string; readonly fields: readonly string[] };

export interface Profile {
  readonly header: string;                                     // 'H' | 'MSH'
  readonly emit: string;                                       // segment type that carries one result: 'R' | 'OBX'
  readonly resets: Readonly<Record<string, readonly string[]>>; // on segment X, forget the last seen segments listed
  readonly delims: (header: string) => Delims | undefined;     // from the header segment text
  readonly index: (seg: string, n: number) => number;          // SEG.n -> index into the split array
  readonly kind: (get: (r: Ref) => string | undefined, hasEmit: boolean, hasQuery: boolean) => 'results' | 'host_query' | 'other';
  readonly defaults: {
    readonly sample: readonly Ref[]; readonly testCode: Ref; readonly value: Ref; readonly unit: Ref; readonly flags: Ref;
    readonly status: Ref; readonly time: readonly Ref[]; readonly controlId?: Ref; readonly messageTime?: Ref; readonly messageControlId?: Ref;
  };
  readonly querySeg?: string;
}

// 03-IC §3.14 / §3.15 bounds. Over-long values are never truncated: the record is skipped with a warning.
export const MAX = { barcode: 40, code: 64, flagCount: 20, flagLen: 16, value: 200, unit: 32, controlId: 64 } as const;
const RECORD_KINDS = ['quantitative', 'qualitative', 'ordinal', 'text'] as const;
const NUMERIC = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const SEG_TYPE = /^[A-Z][A-Z0-9]{0,2}$/;
const REF_RE =/^([A-Z][A-Z0-9]{0,2})\.([1-9][0-9]{0,2})(?:\.([1-9][0-9]?))?$/;

export const isDelim = (c: string | undefined): c is string => c !== undefined && c.length === 1 && !/[A-Za-z0-9\s]/.test(c);

export const malformed = (reason: string): ParseResult => ({ ok: false, errorCode: 'instruments.message_malformed', reason });

function parseRef(v: unknown, defaultComp: number): Ref | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return null;
  const m = REF_RE.exec(v);
  if (!m) return null;
  return { seg: m[1]!, field: Number(m[2]), comp: m[3] ? Number(m[3]) : defaultComp };
}

const fieldSchema = { type: 'string', pattern: REF_RE.source } as const;
export const OPTIONS_SCHEMA = {
  type: 'object', additionalProperties: false, required: [],
  properties: {
    sample_id_field: fieldSchema, test_code_field: fieldSchema, value_field: fieldSchema, unit_field: fieldSchema,
    flags_field: fieldSchema, result_status_field: fieldSchema,
    rerun_values: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 16 } },
    result_time_field: fieldSchema,
    qc_marker: { type: 'object', additionalProperties: false, required: ['field', 'values'], properties: {
      field: { anyOf: [fieldSchema, { type: 'null' }] }, values: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 40 } } } },
    control_id_field: fieldSchema,
    record_kind_default: { type: 'string', enum: RECORD_KINDS },
  },
} as const;

interface Opts {
  sample: readonly Ref[]; testCode: Ref; value: Ref; unit: Ref; flags: Ref; status: Ref; time: readonly Ref[];
  rerun: readonly string[]; qcField?: Ref | undefined; qcValues: readonly string[]; controlId?: Ref | undefined; kind?: RecordKind | undefined;
}

// ctx.options is validated upstream; re-checked here so a bad value can never make parse throw.
function readOpts(o: Readonly<Record<string, unknown>>, d: Profile['defaults']): Opts | undefined {
  const one = (k: string, def: Ref) => { const r = parseRef(o[k], def.comp); return r === null ? null : r ?? def; };
  const sample = parseRef(o.sample_id_field, 1);
  const time = parseRef(o.result_time_field, 1);
  const control = parseRef(o.control_id_field, 1);
  const testCode = one('test_code_field', d.testCode), value = one('value_field', d.value), unit = one('unit_field', d.unit);
  const flags = one('flags_field', d.flags), status = one('result_status_field', d.status);
  const strs = (v: unknown) => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
  const rerun = strs(o.rerun_values);
  const marker = o.qc_marker as { field?: unknown; values?: unknown } | undefined;
  const qcField = marker === undefined ? undefined : parseRef(marker?.field, 1);
  const qcValues = marker === undefined ? [] : strs(marker?.values);
  const kind = o.record_kind_default;
  if (sample === null || time === null || control === null || testCode === null || value === null || unit === null || flags === null
    || status === null || rerun === null || qcField === null || qcValues === null
    || (marker !== undefined && (typeof marker !== 'object' || marker === null))
    || (kind !== undefined && !(RECORD_KINDS as readonly unknown[]).includes(kind))) return undefined;
  return {
    sample: sample ? [sample] : d.sample, time: time ? [time] : d.time, controlId: control ?? d.controlId,
    testCode, value, unit, flags, status, rerun, qcField, qcValues, kind: kind as RecordKind | undefined,
  };
}

/** 'YYYYMMDDHHMM[SS]...' -> 'YYYY-MM-DDTHH:MM:SS' (local, no zone); undefined when not a plausible timestamp. */
export function localTime(v: string | undefined): string | undefined {
  const m = v ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/.exec(v) : null;
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s = '00'] = m;
  if (+mo! < 1 || +mo! > 12 || +d! < 1 || +d! > 31 || +h! > 23 || +mi! > 59 || +s > 59) return undefined;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

function splitSegments(raw: Uint8Array): string[] {
  return new TextDecoder('utf-8').decode(raw).split(/\r\n|\r|\n/).filter((s) => s.length > 0);
}

export function parseDelimited(p: Profile, raw: Uint8Array, ctx: DriverContext): ParseResult {
  const lines = splitSegments(raw);
  const head = lines[0];
  if (head === undefined || !head.startsWith(p.header)) return malformed('missing header record');
  const dl = p.delims(head);
  if (!dl) return malformed('invalid delimiter definition');
  const opts = readOpts(ctx.options ?? {}, p.defaults);
  if (!opts) return malformed('invalid parser_options');

  const segs: Seg[] = [{ type: p.header, fields: head.split(dl.field) }];
  for (const line of lines.slice(1)) {
    const fields = line.split(dl.field);
    if (SEG_TYPE.test(fields[0]!)) segs.push({ type: fields[0]!, fields });
  }

  const last = new Map<string, Seg>();
  const get = (r: Ref): string | undefined => {
    const f = last.get(r.seg)?.fields[p.index(r.seg, r.field)];
    if (!f) return undefined;
    const v = r.comp === 0 ? f : f.split(dl.repeat)[0]!.split(dl.component)[r.comp - 1];
    return v ? v : undefined;
  };
  const first = (refs: readonly Ref[]) => { for (const r of refs) { const v = get(r); if (v !== undefined) return v; } return undefined; };

  last.set(p.header, segs[0]!);
  const messageTimeLocal = p.defaults.messageTime ? localTime(get(p.defaults.messageTime)) : undefined;
  const messageControlId = p.defaults.messageControlId ? get(p.defaults.messageControlId) : undefined;
  const messageKind = p.kind(get, segs.some((s) => s.type === p.emit), !!p.querySeg && segs.some((s) => s.type === p.querySeg));

  const records: ParsedRecord[] = [];
  const warnings: string[] = [];
  let seq = 0;
  for (const s of segs.slice(1)) {
    for (const r of p.resets[s.type] ?? []) last.delete(r);
    last.set(s.type, s);
    if (s.type !== p.emit || messageKind !== 'results') continue;
    seq++;
    const rec = buildRecord(seq, get, first, opts, dl, ctx);
    if (typeof rec === 'string') warnings.push(`record ${seq} skipped: ${rec}`);
    else records.push(rec);
  }
  return {
    ok: true, messageKind,
    ...(messageControlId !== undefined && { messageControlId }),
    ...(messageTimeLocal !== undefined && { messageTimeLocal }),
    records, warnings,
  };
}

function buildRecord(
  seq: number, get: (r: Ref) => string | undefined, first: (r: readonly Ref[]) => string | undefined,
  o: Opts, dl: Delims, ctx: DriverContext,
): ParsedRecord | string {
  const sampleId = first(o.sample);
  const qcByPattern = sampleId !== undefined && ctx.qcSampleIdPatterns.some((re) => sampleId.search(re) !== -1);
  const marker = o.qcField ? get(o.qcField) : undefined;
  const isQc = qcByPattern || (marker !== undefined && o.qcValues.includes(marker));
  const controlIdRaw = isQc ? (o.controlId ? get(o.controlId) : undefined) ?? sampleId : undefined;
  const code = get(o.testCode);
  const valueRaw = get(o.value);
  const unitRaw = get(o.unit);
  const flags = (get(o.flags) ?? '').split(dl.repeat).filter((f) => f.length > 0);
  const status = get(o.status);

  if (!isQc && sampleId !== undefined && sampleId.length > MAX.barcode) return 'sample_barcode_too_long';
  if (controlIdRaw !== undefined && controlIdRaw.length > MAX.controlId) return 'control_id_too_long';
  if (code !== undefined && code.length > MAX.code) return 'instrument_analyte_code_too_long';
  if (valueRaw !== undefined && valueRaw.length > MAX.value) return 'value_too_long';
  if (unitRaw !== undefined && unitRaw.length > MAX.unit) return 'unit_too_long';
  if (flags.length > MAX.flagCount || flags.some((f) => f.length > MAX.flagLen)) return 'instrument_flags_too_long';

  const time = o.time.map((r) => localTime(get(r))).find((t) => t !== undefined);
  return {
    recordSeq: seq,
    recordClass: isQc ? 'qc' : 'patient',
    ...(!isQc && sampleId !== undefined && { sampleBarcode: sampleId }),
    ...(controlIdRaw !== undefined && { controlIdRaw }),
    recordKind: o.kind ?? (valueRaw !== undefined && NUMERIC.test(valueRaw) ? 'quantitative' : 'text'),
    ...(code !== undefined && { instrumentAnalyteCode: code }),
    ...(valueRaw !== undefined && { valueRaw }),
    ...(unitRaw !== undefined && { unitRaw }),
    instrumentFlags: flags,
    ...(time !== undefined && { instrumentResultTimeLocal: time }),
    isRerun: status !== undefined && o.rerun.includes(status),
    warnings: [],
  };
}
