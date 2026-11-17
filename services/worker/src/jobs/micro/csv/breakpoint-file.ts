// Breakpoint CSV file layer (02-TRD §9.1): bytes -> rows/bands + issues, for everything that needs no dictionary. Pure and synchronous: no I/O, no env
// (the job passes LIMS_MICRO_IMPORT_MAX_LINES / _TIMEOUT_MS). Dictionary / standard checks (organism_unknown, category_invalid, …) belong to the job.
// A file-level error (encoding, header, empty, too_many_rows, parse_timeout, quote_unbalanced) is reported alone with rows = [].
// `rows` only carries keys WITHOUT an error issue (safe to INSERT under the 05-SCHEMA CHECKs). Issue messages never echo cell content (S-13).
import { parseCsv } from './parser.js';

export const BREAKPOINT_HEADER = ['organism_scope', 'organism_code', 'antibiotic_code', 'method', 'specimen_site_code', 'qualifier_code', 'category_code', 'lower_value', 'lower_inclusive', 'upper_value', 'upper_inclusive', 'note'] as const;
export const MAX_BANDS_PER_ROW = 6;
const NOTE_MAX = 200;

export interface ParsedBand { band_no: number; line_no: number; category_code: string; lower_value: string | null; lower_inclusive: boolean; upper_value: string | null; upper_inclusive: boolean; note: string | null }
export interface ParsedRow {
  line_no: number; organism_scope: 'organism' | 'group' | 'any'; organism_code: string | null; antibiotic_code: string; method: 'mic' | 'zone_diameter';
  specimen_site_code: string | null; qualifier_code: string | null; bands: ParsedBand[];
}
export interface ParsedIssue { line_no: number | null; severity: 'error' | 'warning'; code: string; field: string | null; message: string }
export interface ParseOptions { maxLines?: number; timeoutMs?: number; now?: () => number }
export interface ParseResult { rows: ParsedRow[]; issues: ParsedIssue[] }

const NUMBER = /^[0-9]{1,8}(\.[0-9]{1,6})?$/;
const QUALIFIER = /^[a-z0-9_]{1,32}$/;
const CATEGORY = /^[A-Za-z^]{1,8}$/;
const SCOPES = new Set(['organism', 'group', 'any']);
const METHODS = new Set(['mic', 'zone_diameter']);

const fileIssue = (code: string, message: string): ParseResult => ({ rows: [], issues: [{ line_no: null, severity: 'error', code, field: null, message }] });

/** Scaled integer (x 1e6) of a validated NUMBER: exact below 2^53, so comparisons are exact. */
function scaled(v: string): number {
  const dot = v.indexOf('.');
  if (dot < 0) return Number(v) * 1_000_000;
  return Number(v.slice(0, dot)) * 1_000_000 + Number(v.slice(dot + 1).padEnd(6, '0'));
}

interface Bound { v: number; inc: boolean }                      // v = ±Infinity for an unbounded side
interface KeyState { row: ParsedRow; hasError: boolean; tooMany: boolean; spans: Array<{ lo: Bound; hi: Bound; line: number }> }

export function parseBreakpointFile(input: Uint8Array, opts: ParseOptions = {}): ParseResult {
  const maxLines = opts.maxLines ?? 20_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const now = opts.now ?? (() => performance.now());
  const started = now();
  const timedOut = (): boolean => now() - started > timeoutMs;

  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); } catch { return fileIssue('file.encoding_invalid', 'The file is not valid UTF-8.'); }
  if (text.includes('\0')) return fileIssue('file.encoding_invalid', 'The file contains a NUL byte.');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const parsed = parseCsv(text);
  if (parsed.unbalancedQuote) return fileIssue('file.quote_unbalanced', 'A quoted field is not closed.');
  if (timedOut()) return fileIssue('file.parse_timeout', 'The file took too long to parse.');
  const records = parsed.records;
  if (records.length === 0) return fileIssue('file.empty', 'The file has no header and no data lines.');
  const head = records[0]!.fields;
  if (head.length !== BREAKPOINT_HEADER.length || head.some((h, i) => h !== BREAKPOINT_HEADER[i])) {
    return { rows: [], issues: [{ line_no: records[0]!.line, severity: 'error', code: 'file.header_mismatch', field: null, message: 'The header does not match the template.' }] };
  }
  const dataCount = records.length - 1;
  if (dataCount === 0) return fileIssue('file.empty', 'The file has no data lines.');
  if (dataCount > maxLines) return fileIssue('file.too_many_rows', `The file has more than ${maxLines} data lines.`);

  const issues: ParsedIssue[] = [];
  const add = (line: number, severity: 'error' | 'warning', code: string, field: string | null, message: string) => { issues.push({ line_no: line, severity, code, field, message }); };
  const keys = new Map<string, KeyState>();
  const order: KeyState[] = [];
  let prevKey: string | null = null;

  for (let n = 1; n <= dataCount; n++) {
    if (n % 1000 === 0 && timedOut()) return fileIssue('file.parse_timeout', 'The file took too long to parse.');
    const rec = records[n]!;
    const f = rec.fields;
    const line = rec.line;
    if (f.length !== BREAKPOINT_HEADER.length) { add(line, 'error', 'row.column_count', null, `Expected ${BREAKPOINT_HEADER.length} columns.`); prevKey = null; continue; }
    const [scope, org, abx, method, site, qual, cat, lo, loInc, hi, hiInc, note] = f as [string, string, string, string, string, string, string, string, string, string, string, string];

    // key columns (first six)
    let keyOk = true;
    if (!SCOPES.has(scope)) { add(line, 'error', 'row.scope_invalid', 'organism_scope', 'organism_scope must be organism, group or any.'); keyOk = false; }
    else if ((scope === 'any') !== (org === '')) { add(line, 'error', 'row.scope_invalid', 'organism_code', scope === 'any' ? 'organism_code must be empty when organism_scope is any.' : 'organism_code is required for this organism_scope.'); keyOk = false; }
    if (abx === '') { add(line, 'error', 'row.antibiotic_unknown', 'antibiotic_code', 'antibiotic_code is required.'); keyOk = false; }
    if (!METHODS.has(method)) { add(line, 'error', 'row.method_invalid', 'method', 'method must be mic or zone_diameter.'); keyOk = false; }
    if (qual !== '' && !QUALIFIER.test(qual)) { add(line, 'error', 'row.qualifier_invalid', 'qualifier_code', 'qualifier_code must match [a-z0-9_]{1,32}.'); keyOk = false; }

    // band columns
    let bandOk = true;
    if (!CATEGORY.test(cat)) { add(line, 'error', 'row.category_invalid', 'category_code', 'category_code is missing or malformed.'); bandOk = false; }
    const num = (v: string, field: string): boolean => {
      if (v === '' || NUMBER.test(v)) return true;
      add(line, 'error', 'row.value_invalid', field, `${field} must be a non-negative decimal (max 8 integer, 6 fraction digits).`); return false;
    };
    const flag = (v: string, field: string): boolean => {
      if (v === '' || v === 'true' || v === 'false') return true;
      add(line, 'error', 'row.value_invalid', field, `${field} must be true, false or empty.`); return false;
    };
    const loOk = num(lo, 'lower_value'), hiOk = num(hi, 'upper_value');
    const loIncOk = flag(loInc, 'lower_inclusive'), hiIncOk = flag(hiInc, 'upper_inclusive');
    if (!(loOk && hiOk && loIncOk && hiIncOk)) bandOk = false;
    if (loOk && hiOk) {
      if (lo === '' && hi === '') { add(line, 'error', 'row.bounds_missing', null, 'At least one of lower_value and upper_value is required.'); bandOk = false; }
      else if (lo !== '' && hi !== '') {
        const a = scaled(lo), b = scaled(hi);
        if (a > b || (a === b && !((loInc !== 'false') && (hiInc !== 'false')))) { add(line, 'error', 'row.bounds_order', null, 'lower_value must not exceed upper_value.'); bandOk = false; }
      }
    }
    const noteLen = note.length > NOTE_MAX ? Array.from(note).length : note.length;
    if (noteLen > NOTE_MAX) { add(line, 'error', 'row.note_too_long', 'note', `note exceeds ${NOTE_MAX} characters.`); bandOk = false; }

    if (!keyOk) { prevKey = null; continue; }               // a line with a bad key cannot be grouped
    const k = [scope, org, abx, method, site, qual].join('\u0001');
    let st = keys.get(k);
    if (!st) {
      st = {
        row: { line_no: line, organism_scope: scope as ParsedRow['organism_scope'], organism_code: org === '' ? null : org, antibiotic_code: abx, method: method as ParsedRow['method'], specimen_site_code: site === '' ? null : site, qualifier_code: qual === '' ? null : qual, bands: [] },
        hasError: false, tooMany: false, spans: [],
      };
      keys.set(k, st); order.push(st);
    } else if (prevKey !== k) {
      add(line, 'warning', 'row.key_split', null, 'The same key appears on non-contiguous lines.');
    }
    prevKey = k;
    if (!bandOk) { st.hasError = true; continue; }
    if (st.row.bands.length >= MAX_BANDS_PER_ROW) {
      if (!st.tooMany) add(line, 'error', 'row.too_many_bands', null, `A key may have at most ${MAX_BANDS_PER_ROW} bands.`);   // once per key
      st.tooMany = true; st.hasError = true;
      continue;
    }
    const band: ParsedBand = {
      band_no: st.row.bands.length + 1, line_no: line, category_code: cat,
      lower_value: lo === '' ? null : lo, lower_inclusive: loInc !== 'false', upper_value: hi === '' ? null : hi, upper_inclusive: hiInc !== 'false', note: note === '' ? null : note,
    };
    st.row.bands.push(band);
    st.spans.push({
      lo: { v: lo === '' ? -Infinity : scaled(lo), inc: band.lower_inclusive }, hi: { v: hi === '' ? Infinity : scaled(hi), inc: band.upper_inclusive }, line,
    });
  }
  if (timedOut()) return fileIssue('file.parse_timeout', 'The file took too long to parse.');

  // per key: overlap (error) and gap (warning) between the bands
  const rows: ParsedRow[] = [];
  for (const st of order) {
    const spans = [...st.spans].sort((a, b) => (a.lo.v - b.lo.v) || (Number(b.lo.inc) - Number(a.lo.inc)) || (a.line - b.line));
    let maxHi: Bound | null = null;
    for (const s of spans) {
      if (maxHi) {
        const overlap = s.lo.v < maxHi.v || (s.lo.v === maxHi.v && s.lo.inc && maxHi.inc);
        const gap = s.lo.v > maxHi.v || (s.lo.v === maxHi.v && !s.lo.inc && !maxHi.inc);
        if (overlap) { add(s.line, 'error', 'row.bands_overlap', null, 'Bands of the same key overlap.'); st.hasError = true; }
        else if (gap) add(s.line, 'warning', 'row.gap_between_bands', null, 'There is a gap between bands of the same key.');
      }
      if (!maxHi || s.hi.v > maxHi.v || (s.hi.v === maxHi.v && s.hi.inc)) maxHi = s.hi;
    }
    if (!st.hasError) rows.push(st.row);
  }
  issues.sort((a, b) => (a.line_no ?? 0) - (b.line_no ?? 0));   // stable: line order, original order within a line
  return { rows, issues };
}
